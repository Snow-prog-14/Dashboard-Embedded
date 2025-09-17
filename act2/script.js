
/* =========================
   CONFIG
   ========================= */
const CONFIG = {
  sensors: [
    { name: 'A', url: 'http://192.168.43.185:5000/api/ultra', colorVar: '--accentA' },
    { name: 'B', url: 'http://192.168.43.185:5000/api/sonic',  colorVar: '--accentB' }
  ],
  dht: { url: 'http://192.168.43.185:5000/api/dht', intervalMs: 5000 },
  intervalMs: 2000,      // poll cadence for ultrasonics
  windowPoints: 60,      // soft cap per series
  timeoutMs: 3500,       // request timeout
  buzzerThresholdCm: 12  // 🔔 ON when >= 12cm
};

// strict last-60s display window
const WINDOW_SEC = 60;

/* toggles */
const visible = { a:true, b:true, t:true, h:true };

/* colors (resolved from CSS at start) */
const COLORS = { a:'#3ea6ff', b:'#a78bfa', t:'#ff6b9e', h:'#3db6ff' };

/* =========================
   STATE & DOM
   ========================= */
const state = [
  { sent:0, ok:0, err:0, data:[] }, // A
  { sent:0, ok:0, err:0, data:[] }  // B
];
const dhtState = { t:[], h:[] };    // arrays {ts,value}

const elOverall = document.getElementById('overall');
const elDistA   = document.getElementById('distA');
const elDistB   = document.getElementById('distB');
const elUpdA    = document.getElementById('updA');
const elUpdB    = document.getElementById('updB');
const elStatA   = document.getElementById('statA');
const elStatB   = document.getElementById('statB');
const buzzerEl  = document.getElementById('buzzer');
const buzzValEl = document.getElementById('buzzVal');
const elTemp    = document.getElementById('temp');
const elHum     = document.getElementById('hum');
const elUpdDht  = document.getElementById('updDht');
const togglesEl = document.getElementById('toggles');

const stripCanvas = document.getElementById('strip');
const sctx        = stripCanvas.getContext('2d');
const dhtCanvas   = document.getElementById('dhtChart');
const dctx        = dhtCanvas.getContext('2d');

// Deterministic tiny jitter so dots don't sit exactly on top of each other
function jitterFor(n, amp = 3) {
  const f = Math.sin(n * 12.9898) * 43758.5453;
  return ((f - Math.floor(f)) - 0.5) * 2 * amp; // [-amp, +amp]
}

/* =========================
   HELPERS
   ========================= */
function getCSS(varName){ return getComputedStyle(document.documentElement).getPropertyValue(varName).trim(); }
const nowTs = () => Math.floor(Date.now()/1000);
const fmtTs = (t) => new Date(t*1000).toLocaleString();
function setBadge(node, kind, text){ node.className = 'badge ' + (kind==='ok'?'ok':kind==='bad'?'bad':'warn'); node.textContent = text; }
function sleep(ms){ return new Promise(r=>setTimeout(r, ms)); }

function fetchWithTimeout(url, ms){
  const ctrl = new AbortController(); const id = setTimeout(()=>ctrl.abort(), ms);
  return fetch(url, {signal: ctrl.signal}).finally(()=>clearTimeout(id));
}

function addPointArr(arr, ts, value, maxLen){
  arr.push({ts, value});
  const cutoff = nowTs() - WINDOW_SEC;       // hard trim by time
  while (arr.length && arr[0].ts < cutoff) arr.shift();
  if (arr.length > maxLen) arr.shift();      // soft cap
}
function addPoint(i, ts, value){ addPointArr(state[i].data, ts, value, CONFIG.windowPoints); }
function addDhtPoint(key, ts, value){ addPointArr(dhtState[key], ts, value, CONFIG.windowPoints); }

const map = (v,a,b,c,d)=> ((v-a)/(b-a))*(d-c)+c;
const lerp = (a,b,t)=> a + (b-a)*t;

function updateMiniStats(){
  elStatA.textContent = `A: req ${state[0].sent} • ok ${state[0].ok} • err ${state[0].err}`;
  elStatB.textContent = `B: req ${state[1].sent} • ok ${state[1].ok} • err ${state[1].err}`;
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
   DATA POLLING
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

/* A -> short gap -> B each tick */
const STAGGER_MS = 150;
let loopHandle = null;
let looping = false;

async function pollLoop(){
  if (looping) return;
  looping = true;
  try{
    setBadge(elOverall, 'warn', 'connecting…');

    await pollSensor(0);
    await sleep(STAGGER_MS);
    await pollSensor(1);

    const anyOK = state.some(s => s.ok > 0);
    const allErr = state.every(s => s.sent>0 && s.ok===0);
    if (anyOK) setBadge(elOverall, 'ok', 'connected');
    else if (allErr) setBadge(elOverall, 'bad', 'offline');

    updateBuzzer(latestNumber(0), latestNumber(1));

    renderStripChart();  // distance A+B
  } finally {
    looping = false;
    loopHandle = setTimeout(pollLoop, CONFIG.intervalMs);
  }
}

async function pollDHT(){
  try{
    const res = await fetchWithTimeout(CONFIG.dht.url, CONFIG.timeoutMs);
    let j = null;
    try { j = await res.json(); } catch(e){}

    const tNow = nowTs();
    if (res.ok && j && (typeof j.temperature_c === 'number' || typeof j.humidity_percent === 'number' || j.ok)) {
      const ts = Number.isFinite(j.ts) ? j.ts : tNow;
      if (typeof j.temperature_c === 'number') {
        addDhtPoint('t', ts, j.temperature_c);
        elTemp.textContent = `${j.temperature_c.toFixed(1)} °C`;
      } else addDhtPoint('t', ts, null);

      if (typeof j.humidity_percent === 'number') {
        addDhtPoint('h', ts, j.humidity_percent);
        elHum.textContent = `${j.humidity_percent.toFixed(0)} %`;
      } else addDhtPoint('h', ts, null);

      elUpdDht.textContent = `DHT updated: ${fmtTs(ts)}`;
    } else {
      const msg = j?.error || `HTTP ${res.status}`;
      elUpdDht.textContent = `DHT error: ${msg}`;
      addDhtPoint('t', tNow, null);
      addDhtPoint('h', tNow, null);
    }
    renderDHTChart(); // update second graph
  } catch(e){
    elUpdDht.textContent = `DHT error: ${e}`;
  }
}

/* =========================
   DRAW HELPERS (axes + lines)
   ========================= */
function drawAxesAndGrid(ctx, M,PW,PH,tMin,tMax,yMin,yMax, xLabel='time →', yLabel='value'){
  ctx.strokeStyle = '#2a2a2a'; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(M.l, M.t+PH); ctx.lineTo(M.l+PW, M.t+PH); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(M.l, M.t);    ctx.lineTo(M.l,    M.t+PH); ctx.stroke();

  ctx.fillStyle = '#a9a9a9';
  ctx.font = '12px system-ui,-apple-system,Segoe UI,Roboto,Arial';
  ctx.fillText(yLabel, 8, M.t + 12);
  ctx.fillText(xLabel, M.l + PW - 48, M.t + PH + 36);

  ctx.setLineDash([3,4]); ctx.strokeStyle = '#222';
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

  // x ticks
  ctx.fillStyle = '#a9a9a9';
  for(let i=0;i<=5;i++){
    const t = Math.round(lerp(tMin,tMax,i/5));
    const x = M.l + map(t, tMin, tMax, 0, PW);
    const label = new Date(t*1000).toLocaleTimeString();
    const w = ctx.measureText(label).width;
    ctx.fillText(label, x - w/2, M.t + PH + 20);
  }
  // y ticks
  for(let i=0;i<=5;i++){
    const v = lerp(yMin,yMax,i/5);
    const y = M.t + map(v, yMax, yMin, 0, PH);
    ctx.fillText(v.toFixed(0), 16, y+4);
  }
}

function plotJoinedSeries(ctx, points, key, color, M,PW,PH,tMin,tMax,yMin,yMax){
  ctx.lineWidth = 2; ctx.strokeStyle = color;
  ctx.beginPath();
  let started = false;
  for (const p of points){
    const val = p[key];
    if (typeof val !== 'number') continue;
    const x = M.l + map(p.ts, tMin, tMax, 0, PW);
    const y = M.t + map(val, yMax, yMin, 0, PH);
    if (!started){ ctx.moveTo(x,y); started = true; }
    else { ctx.lineTo(x,y); }
  }
  if (started) ctx.stroke();

  // last dot
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
   STRIP CHART (A+B)
   ========================= */
   function renderStripChart(){
    const W = stripCanvas.width, H = stripCanvas.height;
    sctx.clearRect(0,0,W,H);
    const M = {l:60,r:20,t:20,b:36};
    const PW = W - M.l - M.r, PH = H - M.t - M.b;
  
    const now = nowTs();
    const tMin = now - WINDOW_SEC;
    const tMax = now;
  
    // maps & union timestamps (only last 60s)
    const mapA = new Map(state[0].data.filter(p=>p.ts>=tMin).map(p=>[p.ts,p.value]));
    const mapB = new Map(state[1].data.filter(p=>p.ts>=tMin).map(p=>[p.ts,p.value]));
    const tsSet = new Set([]);
    if (visible.a) for (const k of mapA.keys()) tsSet.add(k);
    if (visible.b) for (const k of mapB.keys()) tsSet.add(k);
  
    const points = [...tsSet].sort((a,b)=>a-b).map(ts=>({
      ts,
      a: mapA.has(ts) ? mapA.get(ts) : null,
      b: mapB.has(ts) ? mapB.get(ts) : null
    })).filter(p =>
      (visible.a && typeof p.a === 'number') ||
      (visible.b && typeof p.b === 'number')
    );
  
    // y-range from visible A/B
    const vals = [];
    if (visible.a) vals.push(...points.map(p=>p.a).filter(n=>typeof n==='number'));
    if (visible.b) vals.push(...points.map(p=>p.b).filter(n=>typeof n==='number'));
    const fallbackMax = (CONFIG.buzzerThresholdCm*2) || 100;
    const yMinRaw = vals.length ? Math.min(...vals) : 0;
    const yMaxRaw = vals.length ? Math.max(...vals) : fallbackMax;
    const pad = Math.max(1, (yMaxRaw - yMinRaw) * 0.15);
    const yMin = Math.max(0, yMinRaw - pad);
    const yMax = yMaxRaw + pad || 1;
  
    // axes/grid
    drawAxesAndGrid(sctx, M, PW, PH, tMin, tMax, yMin, yMax, 'time →', 'cm');
  
    // dots (no lines)
    if (visible.a) plotDotsSeries(sctx, points, 'a', COLORS.a, M, PW, PH, tMin, tMax, yMin, yMax);
    if (visible.b) plotDotsSeries(sctx, points, 'b', COLORS.b, M, PW, PH, tMin, tMax, yMin, yMax);
  
    // dashed threshold
    sctx.save();
    sctx.setLineDash([6,6]);
    sctx.strokeStyle = '#e67e22';
    const yTh = M.t + ((yMax - CONFIG.buzzerThresholdCm) / (yMax - yMin)) * PH;
    sctx.beginPath(); sctx.moveTo(M.l, yTh); sctx.lineTo(M.l+PW, yTh); sctx.stroke();
    sctx.restore();
  }
  

  drawAxesAndGrid(sctx, M,PW,PH,tMin,tMax,yMin,yMax,'time →','cm');

  if (visible.a) plotJoinedSeries(sctx, points, 'a', COLORS.a, M,PW,PH,tMin,tMax,yMin,yMax);
  if (visible.b) plotJoinedSeries(sctx, points, 'b', COLORS.b, M,PW,PH,tMin,tMax,yMin,yMax);

  // dashed threshold
  sctx.save();
  sctx.setLineDash([6,6]);
  sctx.strokeStyle = '#e67e22';
  const yTh = M.t + map(CONFIG.buzzerThresholdCm, yMax, yMin, 0, PH);
  sctx.beginPath(); sctx.moveTo(M.l, yTh); sctx.lineTo(M.l+PW, yTh); sctx.stroke();
  sctx.restore();
}

/* =========================
   DHT LINE CHART (Temp + Humidity, dual Y)
   ========================= */
function renderDHTChart(){
  const W = dhtCanvas.width, H = dhtCanvas.height;
  dctx.clearRect(0,0,W,H);
  const M = {l:60,r:48,t:20,b:36};   // extra right margin for humidity axis
  const PW = W - M.l - M.r, PH = H - M.t - M.b;

  const now = nowTs();
  const tMin = now - WINDOW_SEC;
  const tMax = now;

  const ptsT = dhtState.t.filter(p=>p.ts>=tMin);
  const ptsH = dhtState.h.filter(p=>p.ts>=tMin);

  // Unified timeline (for x)
  const tsSet = new Set([]);
  if (visible.t) ptsT.forEach(p=>tsSet.add(p.ts));
  if (visible.h) ptsH.forEach(p=>tsSet.add(p.ts));
  const points = [...tsSet].sort((a,b)=>a-b).map(ts=>({
    ts,
    t: (visible.t ? (ptsT.find(p=>p.ts===ts)?.value ?? null) : null),
    h: (visible.h ? (ptsH.find(p=>p.ts===ts)?.value ?? null) : null),
  })).filter(p =>
    (visible.t && typeof p.t === 'number') ||
    (visible.h && typeof p.h === 'number')
  );

  // Left axis: Temperature auto-range
  const tVals = visible.t ? points.map(p=>p.t).filter(n=>typeof n==='number') : [];
  const tMinRaw = tVals.length ? Math.min(...tVals) : 0;
  const tMaxRaw = tVals.length ? Math.max(...tVals) : 50;
  const tPad = Math.max(0.5, (tMaxRaw - tMinRaw) * 0.2);
  const y1Min = Math.max(0, tMinRaw - tPad);
  const y1Max = tMaxRaw + tPad || 1;

  // Right axis: Humidity fixed [0..100]
  const y2Min = 0, y2Max = 100;

  // Grid + left axis labels
  drawAxesAndGrid(dctx, M,PW,PH,tMin,tMax,y1Min,y1Max,'time →','°C / %');

  // Right axis ticks (0..100)
  dctx.fillStyle = '#a9a9a9';
  dctx.font = '12px system-ui,-apple-system,Segoe UI,Roboto,Arial';
  for(let i=0;i<=5;i++){
    const hv = lerp(y2Min,y2Max,i/5);
    const y = M.t + map(hv, y1Max, y1Min, 0, PH); // project humidity onto left-scale grid for alignment
    const txt = String(Math.round(hv));
    const w = dctx.measureText(txt).width;
    dctx.fillText(txt, M.l + PW + 8, y+4);
  }
  // Draw right axis line
  dctx.strokeStyle = '#2a2a2a';
  dctx.beginPath(); dctx.moveTo(M.l+PW, M.t); dctx.lineTo(M.l+PW, M.t+PH); dctx.stroke();

  // Plot Temperature (left axis)
  if (visible.t){
    const pts = points.map(p=>({ts:p.ts, v:p.t}));
    plotLineWithScale(dctx, pts, COLORS.t, M,PW,PH,tMin,tMax,y1Min,y1Max);
  }

  // Plot Humidity (right axis mapping)
  if (visible.h){
    dctx.lineWidth = 2; dctx.strokeStyle = COLORS.h;
    dctx.beginPath();
    let started = false;
    for (const p of points){
      const v = p.h;
      if (typeof v !== 'number') continue;
      const x = M.l + map(p.ts, tMin, tMax, 0, PW);
      const y = M.t + map(v, y2Max, y2Min, 0, PH); // map using humidity scale
      if (!started){ dctx.moveTo(x,y); started = true; }
      else dctx.lineTo(x,y);
    }
    if (started) dctx.stroke();

    // last dot
    for (let i=points.length-1;i>=0;i--){
      const v = points[i].h;
      if (typeof v === 'number'){
        const x = M.l + map(points[i].ts, tMin, tMax, 0, PW);
        const y = M.t + map(v, y2Max, y2Min, 0, PH);
        dctx.beginPath(); dctx.arc(x,y,4,0,Math.PI*2); dctx.fillStyle = COLORS.h; dctx.fill();
        break;
      }
    }
  }
}
function plotLineWithScale(ctx, pts, color, M,PW,PH,tMin,tMax,yMin,yMax){
  ctx.lineWidth = 2; ctx.strokeStyle = color;
  ctx.beginPath();
  let started = false;
  for (const p of pts){
    if (typeof p.v !== 'number') continue;
    const x = M.l + map(p.ts, tMin, tMax, 0, PW);
    const y = M.t + map(p.v, yMax, yMin, 0, PH);
    if (!started){ ctx.moveTo(x,y); started = true; }
    else ctx.lineTo(x,y);
  }
  if (started) ctx.stroke();
  for (let i=pts.length-1;i>=0;i--){
    const v = pts[i].v;
    if (typeof v === 'number'){
      const x = M.l + map(pts[i].ts, tMin, tMax, 0, PW);
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
  const showVal = aOK ? distA : (bOK ? distB : null);
  buzzValEl.textContent = isNum(showVal) ? showVal.toFixed(2) + ' cm' : '--.-- cm';

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
  // resolve colors from CSS
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
      renderStripChart();
      renderDHTChart();
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

  pollLoop(); // A then B (staggered)
  pollDHT();  // DHT now + interval
  dhtTimer = setInterval(pollDHT, CONFIG.dht.intervalMs);
}

function stop(){
  if (dhtTimer) clearInterval(dhtTimer);
  if (loopHandle) { clearTimeout(loopHandle); loopHandle = null; }
}

window.addEventListener('load', start);
window.addEventListener('beforeunload', stop);

function plotDotsSeries(ctx, points, key, color, M, PW, PH, tMin, tMax, yMin, yMax) {
  ctx.save();
  ctx.fillStyle = color;
  ctx.globalAlpha = 0.9;
  const R = 3; // dot radius
  for (const p of points) {
    const v = p[key];
    if (typeof v !== 'number') continue;

    // put samples into 1s "columns" to get the vertical strip look
    const bucket = Math.floor(p.ts);
    const x = M.l + ((bucket - tMin) / (tMax - tMin)) * PW + jitterFor(bucket, 3);
    const y = M.t + ((yMax - v) / (yMax - yMin)) * PH;

    ctx.beginPath();
    ctx.arc(x, y, R, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}
