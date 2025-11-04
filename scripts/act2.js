const CONFIG = {
  sensors: [
    { name: 'A', url: 'http://192.168.1.48:5000/api/ultra', colorVar: '--accentA' },
    { name: 'B', url: 'http://192.168.1.48:5000/api/sonic',  colorVar: '--accentB' }
  ],
  dht: { url: 'http://192.168.43.185:5000/api/dht/read', intervalMs: 5000 },
  intervalMs: 2000,
  windowPoints: 60,
  timeoutMs: 3500,
  buzzerThresholdCm: 12
};
const WINDOW_SEC = 60;

const visible = { a:true, b:true, t:true, h:true };
const COLORS = { a:'#7b83ff', b:'#ff8b8b', t:'#ff6b9e', h:'#3db6ff' };

const BUZZ = {
  url: (() => {
    const first = CONFIG.sensors.find(s => s.url);
    return first ? first.url.replace(/\/api\/.*/, '') + '/api/buzzer/beep' : '';
  })(),
  ms: 350,
  cooldownMs: 2000
};
let lastBuzzTs = 0;

async function buzz(ms = BUZZ.ms){
  if (!BUZZ.url) return;
  try {
    await fetch(BUZZ.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ms })
    });
  } catch (e) {}
}
function maybeBuzz(shouldRing){
  const now = Date.now();
  if (shouldRing && (now - lastBuzzTs > BUZZ.cooldownMs)) {
    lastBuzzTs = now;
    buzz();
  }
}

const state = [
  { sent:0, ok:0, err:0, data:[] },
  { sent:0, ok:0, err:0, data:[] }
];
const dhtState = { t:[], h:[] };

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
const elPeakTemp= document.getElementById('peakTemp');
const elPeakHum = document.getElementById('peakHum');

const stripCanvas = document.getElementById('strip');
const sctx        = stripCanvas.getContext('2d');
const dhtCanvas   = document.getElementById('dhtChart');
const dctx        = dhtCanvas.getContext('2d');

function getCSS(varName){ return getComputedStyle(document.documentElement).getPropertyValue(varName).trim(); }
const nowTs = () => Math.floor(Date.now()/1000);
const fmtTs = (t) => new Date(t*1000).toLocaleString();
function setBadge(node, kind, text){ node.className = 'badge ' + (kind==='ok'?'ok':kind==='bad'?'bad':'warn'); node.textContent = text; }
function sleep(ms){ return new Promise(r=>setTimeout(r, ms)); }
function fetchWithTimeout(url, ms){ const c=new AbortController(); const id=setTimeout(()=>c.abort(), ms); return fetch(url,{signal:c.signal}).finally(()=>clearTimeout(id)); }
function addPointArr(arr, ts, value, maxLen){
  arr.push({ts, value});
  const cutoff = nowTs() - WINDOW_SEC;
  while (arr.length && arr[0].ts < cutoff) arr.shift();
  if (arr.length > maxLen) arr.shift();
}
function addPoint(i, ts, v){ addPointArr(state[i].data, ts, v, CONFIG.windowPoints); }
function addDhtPoint(k, ts, v){ addPointArr(dhtState[k], ts, v, CONFIG.windowPoints); }
const map = (v,a,b,c,d)=> ((v-a)/(b-a))*(d-c)+c;
const lerp = (a,b,t)=> a + (b-a)*t;
function latestNumberArr(arr){ for (let k=arr.length-1;k>=0;k--){ const v=arr[k].value; if (typeof v==='number'&&Number.isFinite(v)) return v; } return null; }
function latestNumber(i){ return latestNumberArr(state[i].data); }
function updateMiniStats(){
  elStatA.textContent = `A: req ${state[0].sent} • ok ${state[0].ok} • err ${state[0].err}`;
  elStatB.textContent = `B: req ${state[1].sent} • ok ${state[1].ok} • err ${state[1].err}`;
}

function peakOf(arr){
  const cutoff = nowTs() - WINDOW_SEC;
  let best = null;
  for (const p of arr){
    if (p.ts >= cutoff && typeof p.value === 'number'){
      if (!best || p.value > best.value) best = p;
    }
  }
  return best;
}
function updateDHTPeaks(){
  const pt = peakOf(dhtState.t);
  const ph = peakOf(dhtState.h);
  if (elPeakTemp) elPeakTemp.textContent = pt ? `${pt.value.toFixed(1)} °C` : '--.- °C';
  if (elPeakHum)  elPeakHum.textContent  = ph ? `${Math.round(ph.value)} %` : '-- %';
  return {pt, ph};
}

function jitterFor(seed, amp=10){
  const f = Math.sin(seed*12.9898)*43758.5453;
  return ((f - Math.floor(f)) - 0.5) * 2 * amp;
}

async function pollSensor(i){
  const sensor = CONFIG.sensors[i]; if (!sensor.url) return;
  state[i].sent++; updateMiniStats();
  try{
    const res = await fetchWithTimeout(sensor.url, CONFIG.timeoutMs);
    if(!res.ok) throw new Error('HTTP '+res.status);
    const j = await res.json();
    const ts = Number.isFinite(j.ts) ? j.ts : nowTs();
    const v = (typeof j.distance_cm==='number') ? j.distance_cm : null;
    addPoint(i, ts, v);
    state[i].ok++; updateMiniStats(); updateLastValues(i, ts, v);
  }catch(e){
    const ts = nowTs(); addPoint(i, ts, null);
    state[i].err++; updateMiniStats(); updateLastValues(i, ts, null);
  }
}
function updateLastValues(i, ts, val){
  if (i===0){ elDistA.textContent = (typeof val==='number') ? val.toFixed(2) : '--.--'; elUpdA.textContent = 'A updated: ' + fmtTs(ts); }
  else { elDistB.textContent = (typeof val==='number') ? val.toFixed(2) : '--.--'; elUpdB.textContent = 'B updated: ' + fmtTs(ts); }
}
const STAGGER_MS = 150;
let loopHandle = null, looping = false;
async function pollLoop(){
  if (looping) return; looping = true;
  try{
    setBadge(elOverall,'warn','connecting…');
    await pollSensor(0); await sleep(STAGGER_MS); await pollSensor(1);
    const anyOK = state.some(s=>s.ok>0);
    const allErr = state.every(s=>s.sent>0 && s.ok===0);
    if (anyOK) setBadge(elOverall,'ok','connected');
    else if (allErr) setBadge(elOverall,'bad','offline');
    updateBuzzer(latestNumber(0), latestNumber(1));
    renderDistanceStrip();
  } finally {
    looping=false;
    loopHandle = setTimeout(pollLoop, CONFIG.intervalMs);
  }
}

async function pollDHT(){
  try{
    const res = await fetchWithTimeout(CONFIG.dht.url, CONFIG.timeoutMs);
    let j=null; try{ j=await res.json(); }catch{}
    const tNow = nowTs();
    if (res.ok && j && (typeof j.temperature_c==='number' || typeof j.humidity_percent==='number' || j.ok)){
      const ts = Number.isFinite(j.ts) ? j.ts : tNow;
      if (typeof j.temperature_c==='number'){ addDhtPoint('t', ts, j.temperature_c); elTemp.textContent = `${j.temperature_c.toFixed(1)} °C`; }
      else addDhtPoint('t', tNow, null);
      if (typeof j.humidity_percent==='number'){ addDhtPoint('h', ts, j.humidity_percent); elHum.textContent = `${j.humidity_percent.toFixed(0)} %`; }
      else addDhtPoint('h', tNow, null);
      elUpdDht.textContent = `DHT updated: ${fmtTs(ts)}`;
    } else {
      const msg = j?.error || `HTTP ${res.status}`;
      elUpdDht.textContent = `DHT error: ${msg}`;
      addDhtPoint('t', tNow, null); addDhtPoint('h', tNow, null);
    }
    updateDHTPeaks();
    renderDHTChart();
  }catch(e){
    elUpdDht.textContent = `DHT error: ${e}`;
  }
}

function drawYGrid(ctx, M,PW,PH, yMin,yMax, yLabel){
  ctx.strokeStyle='#2a2a2a'; ctx.lineWidth=1;
  ctx.beginPath(); ctx.moveTo(M.l, M.t); ctx.lineTo(M.l, M.t+PH); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(M.l, M.t+PH); ctx.lineTo(M.l+PW, M.t+PH); ctx.stroke();
  ctx.setLineDash([3,4]); ctx.strokeStyle='#222';
  for(let i=0;i<=5;i++){
    const v = lerp(yMin,yMax,i/5);
    const y = M.t + map(v, yMax, yMin, 0, PH);
    ctx.beginPath(); ctx.moveTo(M.l, y); ctx.lineTo(M.l+PW, y); ctx.stroke();
  }
  ctx.setLineDash([]);
  ctx.fillStyle = '#a9a9a9'; ctx.font = '12px system-ui,-apple-system,Segoe UI,Roboto,Arial';
  for(let i=0;i<=5;i++){
    const v = lerp(yMin,yMax,i/5);
    const y = M.t + map(v, yMax, yMin, 0, PH);
    ctx.fillText(v.toFixed(0), 16, y+4);
  }
  if (yLabel){ ctx.fillText(yLabel, 8, M.t + 12); }
}

function plotLineWithScale(ctx, pts, color, M,PW,PH,tMin,tMax,yMin,yMax){
  ctx.lineWidth=2; ctx.strokeStyle=color;
  ctx.beginPath(); let started=false;
  for (const p of pts){
    if (typeof p.v !== 'number') continue;
    const x = M.l + map(p.ts, tMin, tMax, 0, PW);
    const y = M.t + map(p.v, yMax, yMin, 0, PH);
    if (!started){ ctx.moveTo(x,y); started=true; } else ctx.lineTo(x,y);
  }
  if (started) ctx.stroke();
  for (let i=pts.length-1;i>=0;i--){
    const v=pts[i].v; if (typeof v!=='number') continue;
    const x = M.l + map(pts[i].ts, tMin, tMax, 0, PW);
    const y = M.t + map(v, yMax, yMin, 0, PH);
    ctx.beginPath(); ctx.arc(x,y,4,0,Math.PI*2); ctx.fillStyle=color; ctx.fill(); break;
  }
}

function drawPeakDot(ctx, x, y, color){
  ctx.save();
  ctx.lineWidth = 2;
  ctx.fillStyle = color;
  ctx.strokeStyle = '#ffffff';
  ctx.beginPath(); ctx.arc(x,y,5,0,Math.PI*2); ctx.fill(); ctx.stroke();
  ctx.restore();
}

function renderDistanceStrip(){
  const W = stripCanvas.width, H = stripCanvas.height;
  sctx.clearRect(0,0,W,H);
  const M = {l:60,r:20,t:20,b:56};
  const PW = W - M.l - M.r, PH = H - M.t - M.b;
  const now = nowTs(), cutoff = now - WINDOW_SEC;
  const arrA = state[0].data.filter(p=>p.ts>=cutoff && typeof p.value==='number');
  const arrB = state[1].data.filter(p=>p.ts>=cutoff && typeof p.value==='number');
  const allVals = [];
  if (visible.a) allVals.push(...arrA.map(p=>p.value));
  if (visible.b) allVals.push(...arrB.map(p=>p.value));
  const fallbackMax = (CONFIG.buzzerThresholdCm*2) || 100;
  const yMinRaw = allVals.length ? Math.min(...allVals) : 0;
  const yMaxRaw = allVals.length ? Math.max(...allVals) : fallbackMax;
  const pad = Math.max(1,(yMaxRaw-yMinRaw)*0.2);
  const yMin = Math.max(0, yMinRaw - pad);
  const yMax = yMaxRaw + pad || 1;
  drawYGrid(sctx, M,PW,PH, yMin,yMax, 'cm');
  const xA = M.l + PW * 0.33;
  const xB = M.l + PW * 0.67;
  const jitterAmp = Math.max(6, PW*0.04);
  if (visible.a){
    sctx.save(); sctx.fillStyle = COLORS.a; sctx.globalAlpha = 0.9;
    for (const p of arrA){
      const x = xA + jitterFor(p.ts+17, jitterAmp);
      const y = M.t + map(p.value, yMax, yMin, 0, PH);
      sctx.beginPath(); sctx.arc(x,y,3,0,Math.PI*2); sctx.fill();
    }
    sctx.restore();
  }
  if (visible.b){
    sctx.save(); sctx.fillStyle = COLORS.b; sctx.globalAlpha = 0.9;
    for (const p of arrB){
      const x = xB + jitterFor(p.ts+29, jitterAmp);
      const y = M.t + map(p.value, yMax, yMin, 0, PH);
      sctx.beginPath(); sctx.arc(x,y,3,0,Math.PI*2); sctx.fill();
    }
    sctx.restore();
  }
  sctx.save();
  sctx.setLineDash([6,6]); sctx.strokeStyle = '#e67e22';
  const yTh = M.t + map(CONFIG.buzzerThresholdCm, yMax, yMin, 0, PH);
  sctx.beginPath(); sctx.moveTo(M.l, yTh); sctx.lineTo(M.l+PW, yTh); sctx.stroke();
  sctx.restore();
  sctx.fillStyle = '#a9a9a9'; sctx.font = '12px system-ui,-apple-system,Segoe UI,Roboto,Arial';
  sctx.textAlign = 'center';
  sctx.fillText('Sensor A', xA, M.t + PH + 24);
  sctx.fillText('Sensor B', xB, M.t + PH + 24);
  sctx.fillText('Sensors',  M.l + PW/2, M.t + PH + 40);
}

function renderDHTChart(){
  const W = dhtCanvas.width, H = dhtCanvas.height;
  dctx.clearRect(0,0,W,H);
  const M = {l:60,r:48,t:20,b:42};
  const PW = W - M.l - M.r, PH = H - M.t - M.b;
  const now = nowTs(), tMin = now - WINDOW_SEC, tMax = now;
  const ptsT = dhtState.t.filter(p=>p.ts>=tMin);
  const ptsH = dhtState.h.filter(p=>p.ts>=tMin);
  const tVals = ptsT.map(p=>p.value).filter(n=>typeof n==='number');
  const tMinRaw = tVals.length ? Math.min(...tVals) : 0;
  const tMaxRaw = tVals.length ? Math.max(...tVals) : 50;
  const tPad = Math.max(0.5,(tMaxRaw-tMinRaw)*0.2);
  const y1Min = Math.max(0,tMinRaw - tPad);
  const y1Max = tMaxRaw + tPad || 1;
  drawYGrid(dctx, M,PW,PH, y1Min,y1Max, '°C / %');
  dctx.setLineDash([3,4]); dctx.strokeStyle='#222';
  for(let i=0;i<=5;i++){
    const tx = M.l + map(lerp(tMin,tMax,i/5), tMin, tMax, 0, PW);
    dctx.beginPath(); dctx.moveTo(tx, M.t); dctx.lineTo(tx, M.t+PH); dctx.stroke();
  }
  dctx.setLineDash([]);
  dctx.fillStyle='#a9a9a9'; dctx.font='12px system-ui,-apple-system,Segoe UI,Roboto,Arial';
  dctx.textAlign='center';
  for(let i=0;i<=5;i++){
    const tt = Math.round(lerp(tMin,tMax,i/5));
    const x  = M.l + map(tt, tMin, tMax, 0, PW);
    dctx.fillText(new Date(tt*1000).toLocaleTimeString(), x, M.t+PH+20);
  }
  dctx.fillText('time →', M.l + PW - 36, M.t + PH + 36);
  const y2Min = 0, y2Max = 100;
  dctx.fillStyle='#a9a9a9'; dctx.textAlign='left';
  for(let i=0;i<=5;i++){
    const hv = lerp(y2Min,y2Max,i/5);
    const y = M.t + map(hv, y2Max, y2Min, 0, PH);
    dctx.fillText(String(Math.round(hv)), M.l+PW+8, y+4);
  }
  dctx.strokeStyle='#2a2a2a'; dctx.beginPath(); dctx.moveTo(M.l+PW, M.t); dctx.lineTo(M.l+PW, M.t+PH); dctx.stroke();
  if (visible.t){
    const pts = ptsT.map(p=>({ts:p.ts, v:p.value}));
    plotLineWithScale(dctx, pts, COLORS.t, M,PW,PH,tMin,tMax,y1Min,y1Max);
  }
  if (visible.h){
    dctx.lineWidth=2; dctx.strokeStyle=COLORS.h; dctx.beginPath(); let started=false;
    for (const p of ptsH){
      if (typeof p.value!=='number') continue;
      const x = M.l + map(p.ts, tMin, tMax, 0, PW);
      const y = M.t + map(p.value, y2Max, y2Min, 0, PH);
      if (!started){ dctx.moveTo(x,y); started=true; } else dctx.lineTo(x,y);
    }
    if (started) dctx.stroke();
  }
  const pt = peakOf(dhtState.t.filter(p=>p.ts>=tMin));
  if (visible.t && pt && typeof pt.value==='number'){
    const x = M.l + map(pt.ts, tMin, tMax, 0, PW);
    const y = M.t + map(pt.value, y1Max, y1Min, 0, PH);
    drawPeakDot(dctx, x, y, COLORS.t);
  }
  const ph = peakOf(dhtState.h.filter(p=>p.ts>=tMin));
  if (visible.h && ph && typeof ph.value==='number'){
    const x = M.l + map(ph.ts, tMin, tMax, 0, PW);
    const y = M.t + map(ph.value, y2Max, y2Min, 0, PH);
    drawPeakDot(dctx, x, y, COLORS.h);
  }
}

function updateBuzzer(distA, distB){
  const isNum = v => typeof v==='number' && Number.isFinite(v);
  const aOK=isNum(distA), bOK=isNum(distB);
  const showVal = aOK ? distA : (bOK ? distB : null);
  buzzValEl.textContent = isNum(showVal) ? showVal.toFixed(2)+' cm' : '--.-- cm';
  const ring = (aOK && distA >= CONFIG.buzzerThresholdCm) || (bOK && distB >= CONFIG.buzzerThresholdCm);
  buzzerEl.classList.toggle('buzzer-on',  ring);
  buzzerEl.classList.toggle('buzzer-off', !ring);
  maybeBuzz(ring);
}

function wireToggles(){
  COLORS.a = getCSS('--accentA') || COLORS.a;
  COLORS.b = getCSS('--accentB') || COLORS.b;
  COLORS.t = getCSS('--accentT') || COLORS.t;
  COLORS.h = getCSS('--accentH') || COLORS.h;
  if (!togglesEl) return;
  togglesEl.querySelectorAll('.toggle').forEach(btn=>{
    btn.addEventListener('click', ()=>{
      const key = btn.dataset.series;
      visible[key] = !visible[key];
      btn.classList.toggle('active', visible[key]);
      renderDistanceStrip();
      updateDHTPeaks();
      renderDHTChart();
    });
  });
}

let dhtTimer = null;
async function start(){
  setBadge(elOverall,'warn','connecting…');
  wireToggles();
  pollLoop();
  pollDHT();
  dhtTimer = setInterval(pollDHT, CONFIG.dht.intervalMs);
}
function stop(){
  if (dhtTimer) clearInterval(dhtTimer);
  if (loopHandle) { clearTimeout(loopHandle); loopHandle = null; }
}

window.addEventListener('load', start);
window.addEventListener('beforeunload', stop);
