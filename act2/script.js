/* =========================
   CONFIG
   ========================= */
const CONFIG = {
  sensors: [
    { name: 'A', url: 'http://192.168.1.48:5000/api/ultra', colorVar: '--accentA' },
    { name: 'B', url: '', colorVar: '--accentB' }
  ],
  dht: { url: 'http://192.168.1.48:5000/api/dht', intervalMs: 5000 },
  intervalMs: 2000,      // poll cadence for ultrasonics (overall tick)
  windowPoints: 60,      // ~2 minutes at 2s
  timeoutMs: 3500,       // request timeout
  buzzerThresholdCm: 12  // 🔔 ON when >= 12cm (change logic in updateBuzzer if needed)
};

/* Which series are visible on the chart */
const visible = { a:true, b:true, t:false, h:false };

/* Colors resolved from CSS variables (set in start()) */
const COLORS = { a:'#3ea6ff', b:'#a78bfa', t:'#ff6b9e', h:'#3db6ff' };

/* =========================
   STATE & DOM
   ========================= */
const state = [
  { sent:0, ok:0, err:0, data:[] }, // A distance
  { sent:0, ok:0, err:0, data:[] }  // B distance
];
const dhtState = { t:[], h:[] };    // arrays of {ts, value}

const elOverall = document.getElementById('overall');
const elDistA   = document.getElementById('distA');
const elDistB   = document.getElementById('distB');
const elUpdA    = document.getElementById('updA');
const elUpdB    = document.getElementById('updB');
const elStatA   = document.getElementById('statA');
const elStatB   = document.getElementById('statB');
const elWindow  = document.getElementById('window');
const canvas    = document.getElementById('chart');
const ctx       = canvas.getContext('2d');
const buzzerEl  = document.getElementById('buzzer');
const buzzValEl = document.getElementById('buzzVal');
const elTemp    = document.getElementById('temp');
const elHum     = document.getElementById('hum');
const elUpdDht  = document.getElementById('updDht');
const togglesEl = document.getElementById('toggles');

/* =========================
   HELPERS
   ========================= */
function getCSS(varName){ return getComputedStyle(document.documentElement).getPropertyValue(varName).trim(); }
const nowTs = () => Math.floor(Date.now()/1000);
const fmtTs = (t) => new Date(t*1000).toLocaleString();
function setBadge(node, kind, text){ node.className = 'badge ' + (kind==='ok'?'ok':kind==='bad'?'bad':'warn'); node.textContent = text; }
function fetchWithTimeout(url, ms){
  const ctrl = new AbortController(); const id = setTimeout(()=>ctrl.abort(), ms);
  return fetch(url, {signal: ctrl.signal}).finally(()=>clearTimeout(id));
}
function addPointArr(arr, ts, value, maxLen){
  arr.push({ts, value});
  if (arr.length > maxLen) arr.shift();
}
function addPoint(i, ts, value){ addPointArr(state[i].data, ts, value, CONFIG.windowPoints); }
function addDhtPoint(key, ts, value){ addPointArr(dhtState[key], ts, value, CONFIG.windowPoints); }
const map = (v,a,b,c,d)=> ((v-a)/(b-a))*(d-c)+c;
const lerp = (a,b,t)=> a + (b-a)*t;

function updateMiniStats(){
  elStatA.textContent = `A: req ${state[0].sent} • ok ${state[0].ok} • err ${state[0].err}`;
  elStatB.textContent = `B: req ${state[1].sent} • ok ${state[1].ok} • err ${state[1].err}`;
  const allTs = [
    ...state[0].data.map(p=>p.ts),
    ...state[1].data.map(p=>p.ts),
    ...dhtState.t.map(p=>p.ts),
    ...dhtState.h.map(p=>p.ts),
  ];
  if (allTs.length >= 2){
    const min = Math.min(...allTs), max = Math.max(...allTs);
    const span = Math.max(0, max-min); const m = Math.floor(span/60), s = span%60;
    elWindow.textContent = `window: ${m}m ${s}s`;
  } else elWindow.textContent = 'window: —';
}
function updateLastValues(i, ts, val){
  if (i===0){
    elDistA.textContent = (typeof val==='number') ? val.toFixed(2) : '--.--';
    elUpdA.textContent  = 'A updated: ' + fmtTs(ts);
  } else {
    elDistB.textContent = (typeof val==='number') ? val.toFixed(2) : '--.--';
    elUpdB.textContent  = 'B updated: ' + fmtTs(ts);
  }
}
function latestNumberArr(arr){
  for (let k=arr.length-1; k>=0; k--){
    const v = arr[k].value;
    if (typeof v === 'number' && Number.isFinite(v)) return v;
  }
  return null;
}
function latestNumber(i){ return latestNumberArr(state[i].data); }

/* =========================
   DATA POLLING (one sensor at a time)
   ========================= */
async function pollSensor(i){
  const sensor = CONFIG.sensors[i];
  if (!sensor.url) return;
  state[i].sent++; updateMiniStats();
  try{
    const res = await fetchWithTimeout(sensor.url, CONFIG.timeoutMs);
    if(!res.ok) throw new Error('HTTP '+res.status);
    const data = await res.json();
    const t = Number.isFinite(data.ts) ? data.ts : nowTs();
    const v = (typeof data.distance_cm==='number') ? data.distance_cm : null;
    addPoint(i, t, v);
    state[i].ok++; updateMiniStats();
    updateLastValues(i, t, v);
  }catch(e){
    const t = nowTs();
    addPoint(i, t, null);
    state[i].err++; updateMiniStats();
    updateLastValues(i, t, null);
  }
}

/* Sequential loop: A -> delay -> B each tick */
const STAGGER_MS = 150;              // try 120–200ms if needed
function sleep(ms){ return new Promise(r=>setTimeout(r, ms)); }

let loopHandle = null;
let looping = false;

async function pollLoop(){
  if (looping) return;        // avoid re-entry if a tick runs long
  looping = true;
  try{
    setBadge(elOverall, 'warn', 'connecting…');

    await pollSensor(0);              // A first
    await sleep(STAGGER_MS);          // short gap between pings
    await pollSensor(1);              // then B

    const anyOK = state.some(s => s.ok > 0);
    const allErr = state.every(s => s.sent>0 && s.ok===0);
    if (anyOK) setBadge(elOverall, 'ok', 'connected');
    else if (allErr) setBadge(elOverall, 'bad', 'offline');

    // 🔔 update buzzer based on latest distance values
    updateBuzzer(latestNumber(0), latestNumber(1));

    renderChart();
  } finally {
    looping = false;
    loopHandle = setTimeout(pollLoop, CONFIG.intervalMs); // schedule next tick
  }
}

async function pollDHT(){
  try{
    const res = await fetchWithTimeout(CONFIG.dht.url, CONFIG.timeoutMs);
    let j = null;
    try { j = await res.json(); } catch(e){}

    const tNow = nowTs();

    if (res.ok && j && j.ok) {
      const ts = Number.isFinite(j.ts) ? j.ts : tNow;
      if (typeof j.temperature_c === 'number') {
        addDhtPoint('t', ts, j.temperature_c);
        if (elTemp) elTemp.textContent = `${j.temperature_c.toFixed(1)} °C`;
      } else addDhtPoint('t', ts, null);

      if (typeof j.humidity_percent === 'number') {
        addDhtPoint('h', ts, j.humidity_percent);
        if (elHum) elHum.textContent = `${j.humidity_percent.toFixed(0)} %`;
      } else addDhtPoint('h', ts, null);

      if (elUpdDht) elUpdDht.textContent = `DHT updated: ${fmtTs(ts)}`;
    } else {
      // request failed or j.ok === false
      const msg = j?.error || `HTTP ${res.status}`;
      if (elUpdDht) elUpdDht.textContent = `DHT error: ${msg}`;
      addDhtPoint('t', tNow, null);
      addDhtPoint('h', tNow, null);
      // (Optional) console for deeper debugging:
      console.warn('DHT read failed:', msg);
    }

    updateMiniStats();
    renderChart();

  } catch(e){
    const tNow = nowTs();
    if (elUpdDht) elUpdDht.textContent = `DHT error: ${e}`;
    addDhtPoint('t', tNow, null);
    addDhtPoint('h', tNow, null);
    updateMiniStats();
    renderChart();
  }
}


/* =========================
   CHART
   ========================= */
function renderChart(){
  const W = canvas.width, H = canvas.height;
  ctx.clearRect(0,0,W,H);
  const M = {l:60,r:20,t:20,b:36};
  const PW = W - M.l - M.r, PH = H - M.t - M.b;

  const points = mergeTimeline();

  // ranges from ONLY visible series
  const xs = points.map(p=>p.ts);
  const tMin = xs.length ? xs[0] : nowTs()-1;
  const tMax = xs.length ? xs[xs.length-1] : nowTs();

  const valArrays = [];
  if (visible.a) valArrays.push(points.map(p=>p.a).filter(n=>typeof n==='number'));
  if (visible.b) valArrays.push(points.map(p=>p.b).filter(n=>typeof n==='number'));
  if (visible.t) valArrays.push(points.map(p=>p.t).filter(n=>typeof n==='number'));
  if (visible.h) valArrays.push(points.map(p=>p.h).filter(n=>typeof n==='number'));

  const allY = valArrays.flat();
  const yMinRaw = allY.length ? Math.min(...allY) : 0;
  const yMaxRaw = allY.length ? Math.max(...allY) : 100;
  const pad = Math.max(1, (yMaxRaw - yMinRaw) * 0.15);
  const yMin = Math.max(0, yMinRaw - pad);
  const yMax = yMaxRaw + pad || 1;

  drawAxesAndGrid(M,PW,PH,tMin,tMax,yMin,yMax);

  if (visible.a) plotSeries(points, 'a', COLORS.a, M,PW,PH,tMin,tMax,yMin,yMax);
  if (visible.b) plotSeries(points, 'b', COLORS.b, M,PW,PH,tMin,tMax,yMin,yMax);
  if (visible.t) plotSeries(points, 't', COLORS.t, M,PW,PH,tMin,tMax,yMin,yMax);
  if (visible.h) plotSeries(points, 'h', COLORS.h, M,PW,PH,tMin,tMax,yMin,yMax);
}

function mergeTimeline(){
  const mapA = new Map(state[0].data.map(p=>[p.ts, p.value]));
  const mapB = new Map(state[1].data.map(p=>[p.ts, p.value]));
  const mapT = new Map(dhtState.t.map(p=>[p.ts, p.value]));
  const mapH = new Map(dhtState.h.map(p=>[p.ts, p.value]));

  // Only include timestamps from series that are visible
  const tsSet = new Set([]);
  if (visible.a) for (const k of mapA.keys()) tsSet.add(k);
  if (visible.b) for (const k of mapB.keys()) tsSet.add(k);
  if (visible.t) for (const k of mapT.keys()) tsSet.add(k);
  if (visible.h) for (const k of mapH.keys()) tsSet.add(k);

  const arr = [...tsSet].sort((a,b)=>a-b).map(ts=>({
    ts,
    a: mapA.has(ts) ? mapA.get(ts) : null,
    b: mapB.has(ts) ? mapB.get(ts) : null,
    t: mapT.has(ts) ? mapT.get(ts) : null,
    h: mapH.has(ts) ? mapH.get(ts) : null
  })).filter(p =>
      (visible.a && typeof p.a === 'number') ||
      (visible.b && typeof p.b === 'number') ||
      (visible.t && typeof p.t === 'number') ||
      (visible.h && typeof p.h === 'number')
  );

  if (arr.length > CONFIG.windowPoints) return arr.slice(-CONFIG.windowPoints);
  return arr;
}

function drawAxesAndGrid(M,PW,PH,tMin,tMax,yMin,yMax){
  // axes
  ctx.strokeStyle = '#2a2a2a'; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(M.l, M.t+PH); ctx.lineTo(M.l+PW, M.t+PH); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(M.l, M.t);    ctx.lineTo(M.l,    M.t+PH); ctx.stroke();

  // labels
  ctx.fillStyle = '#a9a9a9';
  ctx.font = '12px system-ui, -apple-system, Segoe UI, Roboto, Arial';
  ctx.fillText('value', 8, M.t + 12);
  ctx.fillText('time →', M.l + PW - 48, M.t + PH + 36);

  // grid
  ctx.setLineDash([3,4]);
  ctx.strokeStyle = '#222';
  for(let i=0;i<=5;i++){
    const v = lerp(yMin,yMax,i/5);
    const y = M.t + map(v, yMax, yMin, 0, PH);
    ctx.beginPath(); ctx.moveTo(M.l, y); ctx.lineTo(M.l+PW, y); ctx.stroke();
  }
  for(let i=0;i<=5;i++){
    const t = lerp(tMin,tMax,i/5);
    const x = M.l + map(t, tMin, tMax, 0, PW);
    ctx.beginPath(); ctx.moveTo(x, M.t); ctx.lineTo(x, M.t+PH); ctx.stroke();
  }
  ctx.setLineDash([]);

  // x tick labels
  ctx.fillStyle = '#a9a9a9';
  for(let i=0;i<=5;i++){
    const t = Math.round(lerp(tMin,tMax,i/5));
    const x = M.l + map(t, tMin, tMax, 0, PW);
    const label = new Date(t*1000).toLocaleTimeString();
    const w = ctx.measureText(label).width;
    ctx.fillText(label, x - w/2, M.t + PH + 20);
  }
  // y tick labels
  for(let i=0;i<=5;i++){
    const v = lerp(yMin,yMax,i/5);
    const y = M.t + map(v, yMax, yMin, 0, PH);
    ctx.fillText(v.toFixed(0), 16, y+4);
  }
}

function plotSeries(points, key, color, M,PW,PH,tMin,tMax,yMin,yMax){
  ctx.lineWidth = 2; ctx.strokeStyle = color;
  ctx.beginPath();
  let started = false;
  for (const p of points){
    const val = p[key];
    if (typeof val !== 'number') continue; // keep path continuous across nulls
    const x = M.l + map(p.ts, tMin, tMax, 0, PW);
    const y = M.t + map(val, yMax, yMin, 0, PH);
    if (!started){ ctx.moveTo(x,y); started = true; }
    else { ctx.lineTo(x,y); }
  }
  if (started) ctx.stroke();

  // last point dot
  for (let i=points.length-1;i>=0;i--){
    const v = points[i][key];
    if (typeof v === 'number'){
      const x = M.l + map(points[i].ts, tMin, tMax, 0, PW);
      const y = M.t + map(v, yMax, yMin, 0, PH);
      ctx.beginPath(); ctx.arc(x,y,4,0,Math.PI*2); ctx.fillStyle = color; ctx.fill();
      break;
    }
  }
}

/* =========================
   BUZZER (visual)
   ========================= */
function updateBuzzer(distA, distB){
  const isNum = v => typeof v === 'number' && Number.isFinite(v);
  const aOK = isNum(distA), bOK = isNum(distB);

  // value to display next to icon (prefer A)
  const showVal = aOK ? distA : (bOK ? distB : null);
  buzzValEl.textContent = isNum(showVal) ? showVal.toFixed(2) + ' cm' : '--.-- cm';

  // 🔔 ON when either >= threshold (change to < for "too close")
  const ring =
    (aOK && distA >= CONFIG.buzzerThresholdCm) ||
    (bOK && distB >= CONFIG.buzzerThresholdCm);

  buzzerEl.classList.toggle('buzzer-on',  ring);
  buzzerEl.classList.toggle('buzzer-off', !ring);
}

/* =========================
   TOGGLES
   ========================= */
function wireToggles(){
  // Resolve colors now (CSS vars -> JS)
  COLORS.a = getCSS('--accentA') || COLORS.a;
  COLORS.b = getCSS('--accentB') || COLORS.b;
  COLORS.t = getCSS('--accentT') || COLORS.t;
  COLORS.h = getCSS('--accentH') || COLORS.h;

  if (!togglesEl) return;
  togglesEl.querySelectorAll('.toggle').forEach(btn=>{
    btn.addEventListener('click', ()=>{
      const key = btn.dataset.series; // 'a' | 'b' | 't' | 'h'
      visible[key] = !visible[key];
      btn.classList.toggle('active', visible[key]);
      renderChart();
    });
  });
}

/* =========================
   LIFECYCLE
   ========================= */
let dhtTimer = null;

function start(){
  setBadge(elOverall,'warn','connecting…');
  wireToggles();

  // Kick off loops
  pollLoop(); // sequential A -> delay -> B
  pollDHT();  // immediate
  dhtTimer = setInterval(pollDHT, CONFIG.dht.intervalMs);
}

function stop(){
  if (dhtTimer) clearInterval(dhtTimer);
  if (loopHandle) { clearTimeout(loopHandle); loopHandle = null; }
}

window.addEventListener('load', start);
window.addEventListener('beforeunload', stop);
