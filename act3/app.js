// =======================
// Motion + Temperature Monitor — Adaptive (fast), fixed-window charts
// =======================

// -------- Endpoints (edit here; not shown in UI) --------
const ENDPOINTS = {
  PIR_URL:    "",                         // e.g. "http://raspi:5000/api/pir"
  DHT_URL:    "",                         // e.g. "http://raspi:5002/api/dht"
  NOTIFY_URL: ""                          // e.g. "http://localhost:5001/notify"
};

// -------- Config --------
const DEFAULTS = {
  POLL_MS: 1000,
  LIVE_WINDOW_MIN: 5,
  THRESHOLD: 0.10,      // UI slider is a MIN floor
  MAX_CAPTURES: 30,
  WEBCAM_WIDTH: 320,
  WEBCAM_HEIGHT: 240
};

// Fast + robust detector
const SAMPLE_MS = 120;       // ~8 Hz
const DHT_POLL_MS = 5000;
const EMAIL_COOLDOWN_MS = 120000;

// Motion detector tuning
const DOWNSCALE_W = 160, DOWNSCALE_H = 120;
const PIXEL_DELTA = 20;      // luma change to count as "changed" pixel (0..255)
const BASE_ALPHA  = 0.02;    // EMA for mean
const VAR_ALPHA   = 0.02;    // EMA for variance
const K_SIGMA     = 3.0;     // dynamic threshold = μ + K·σ
const TRIGGER_CONSEC = 1;    // fire immediately when above threshold
const RESET_CONSEC   = 1;

// -------- DOM --------
const elStatus = document.getElementById('status');
const elEventCount = document.getElementById('eventCount');
const elCapCount = document.getElementById('capCount');
const elFps = document.getElementById('fps');
const elLastUpd = document.getElementById('lastUpd');

const btnStart = document.getElementById('btnStart');
const btnStop = document.getElementById('btnStop');
const enableCam = document.getElementById('enableWebcam');
const enablePIR = document.getElementById('enablePIR');

const elThresh = document.getElementById('thresh');
const elThreshV = document.getElementById('threshVal');
const elPollMs = document.getElementById('pollMs');
const elWinMin = document.getElementById('winMin');
const elMaxCaps = document.getElementById('maxCaps');

const btnClearCaps = document.getElementById('btnClearCaps');
const btnClearChart = document.getElementById('btnClearChart');

const video = document.getElementById('video');
const work = document.getElementById('work');
const ctxWork = work.getContext('2d', { willReadFrequently: true });

const caps = document.getElementById('caps');
const logEl = document.getElementById('log');
const snapshotEl = document.getElementById('snapshot');

const lightbox = document.getElementById('lightbox');
const lightImg = document.getElementById('lightImg');

const motionEl = document.getElementById('motionChart');
const tempEl = document.getElementById('tempChart');

const themeToggle = document.getElementById('themeToggle');

// -------- State --------
let CFG = { ...DEFAULTS };
let running = false;
let pirTimer = null, tempTimer = null;
let lastFrameSmall = null;
let events = 0, captures = 0;
let lastEventActive = false;
let fpsCounter = { frames: 0, last: performance.now() };
let lastSampleTs = 0;

// Adaptive baseline
let mu = 0, varEMA = 0, sigma = 0.02, currentDynThresh = DEFAULTS.THRESHOLD;
let aboveCount = 0, belowCount = 0;
let lastPirVal = 0;

// -------- Utils --------
const now = () => Date.now();
const fmtTime = ts => new Date(ts).toLocaleTimeString();
const setStatus = s => (elStatus.textContent = s);
const setBadge = (el, v) => (el.textContent = v);
function addLog(msg) {
  const li = document.createElement('li');
  li.innerHTML = msg;
  logEl.prepend(li);
  while (logEl.children.length > 100) logEl.removeChild(logEl.lastChild);
}
const webcamReady = () => video && video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA;

// Theme toggle
if (themeToggle){
  themeToggle.addEventListener('click', () => {
    const isLight = document.documentElement.classList.toggle('light');
    localStorage.setItem('theme', isLight ? 'light' : 'dark');
    applyChartTheme();
  });
  if (localStorage.getItem('theme') === 'light'){
    document.documentElement.classList.add('light');
  }
}

// Chart helpers
function cssVar(name, fallback='#888'){
  return (getComputedStyle(document.documentElement).getPropertyValue(name) || '').trim() || fallback;
}
function transparent(hexOrRgb, alpha){
  if (hexOrRgb.startsWith('rgb')) return hexOrRgb.replace('rgb','rgba').replace(')',`, ${alpha})`);
  const h = hexOrRgb.replace('#','');
  const v = parseInt(h.length===3 ? h.split('').map(c=>c+c).join('') : h, 16);
  const r=(v>>16)&255, g=(v>>8)&255, b=v&255;
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}
function applyChartTheme(){
  const grid = cssVar('--grid', '#232832');
  const txt  = cssVar('--muted', '#9aa3ad');
  Chart.defaults.font = { family: 'Inter, system-ui, -apple-system, Segoe UI, Roboto, Arial', size: 12, weight: '500' };
  Chart.defaults.color = txt;
  Chart.defaults.borderColor = grid;
  [motionChart, tempChart].forEach(ch => ch && ch.update('none'));
}
Chart.defaults.animation = false;

// ---- Ring buffer cap ----
const maxSamples = () => Math.ceil((CFG.LIVE_WINDOW_MIN * 60 * 1000) / SAMPLE_MS) + 4;
function cap(ds){
  const n = maxSamples();
  const extra = ds.data.length - n;
  if (extra > 0) ds.data.splice(0, extra);
}

// -------- Charts (fixed window, linear x) --------
const motionChart = new Chart(motionEl, {
  type: 'line',
  data: {
    datasets: [
      { label:'PIR', data:[], parsing:false, spanGaps:true,
        borderColor: cssVar('--accent'), backgroundColor: transparent(cssVar('--accent'), .20),
        yAxisID:'yPIR', stepped:true, pointRadius:0, borderWidth:2 },
      { label:'Motion Intensity', data:[], parsing:false, spanGaps:true,
        borderColor: cssVar('--accent-2'), backgroundColor: transparent(cssVar('--accent-2'), .18),
        yAxisID:'yINT', tension:0.25, pointRadius:0, borderWidth:2, fill:true },
      { label:'Threshold', data:[], parsing:false, spanGaps:true,
        borderColor: cssVar('--warn'), borderDash:[6,4], yAxisID:'yINT',
        pointRadius:0, borderWidth:1 },
      { label:'Events', data:[], parsing:false, showLine:false,
        borderColor: cssVar('--warn'), backgroundColor: cssVar('--warn'),
        yAxisID:'yINT', pointRadius:3, pointStyle:'triangle' }
    ]
  },
  options: {
    responsive: false,
    maintainAspectRatio: false,
    interaction:{ mode:'nearest', intersect:false },
    plugins: { legend:{ labels:{ usePointStyle:true } } },
    scales: {
      x: { type:'linear', min: undefined, max: undefined,
           ticks:{ maxTicksLimit: 10, callback:v=>new Date(v).toLocaleTimeString() } },
      yPIR: { position:'left', min:-0.05, max:1.05, grid:{ drawOnChartArea:false }, title:{ display:true, text:'PIR' } },
      yINT: { position:'right', min:0, max:1.0, title:{ display:true, text:'Intensity' } }
    }
  }
});

const tempChart = new Chart(tempEl, {
  type: 'line',
  data: {
    datasets: [
      { label:'Temperature (°C)', data:[], parsing:false, spanGaps:true,
        borderColor: cssVar('--accent-2'), backgroundColor: transparent(cssVar('--accent-2'), .18),
        yAxisID:'yTEMP', tension:0.25, pointRadius:0, borderWidth:2, fill:true }
    ]
  },
  options: {
    responsive:false, maintainAspectRatio:false,
    interaction:{ mode:'nearest', intersect:false },
    plugins:{ legend:{ labels:{ usePointStyle:true } } },
    scales:{
      x:{ type:'linear', min:undefined, max:undefined,
          ticks:{ maxTicksLimit:10, callback:v=>new Date(v).toLocaleTimeString() } },
      yTEMP:{ position:'left', min:15, max:40, title:{ display:true, text:'°C' } }
    }
  }
});
applyChartTheme();

// --- Motion helpers ---
function pushPIR(ts, v){
  const ds = motionChart.data.datasets[0];
  ds.data.push({ x: ts, y: v }); cap(ds);
}
function pushIntensityAndClamp(ts, intensity, thr){
  const dsInt = motionChart.data.datasets[1];
  dsInt.data.push({ x: ts, y: intensity }); cap(dsInt);
  cap(motionChart.data.datasets[3]);

  const win = CFG.LIVE_WINDOW_MIN * 60 * 1000;
  motionChart.options.scales.x.min = ts - win;
  motionChart.options.scales.x.max = ts;

  const th = motionChart.data.datasets[2];
  th.data = [{ x: ts - win, y: thr }, { x: ts, y: thr }];

  motionChart.update('none');
}
function markEvent(ts, v){
  motionChart.data.datasets[3].data.push({ x: ts, y: Math.max(v, CFG.THRESHOLD) });
  events++; setBadge(elEventCount, events);
}

// --- Temperature helpers ---
function pushTempAndClamp(ts, tempC){
  const ds = tempChart.data.datasets[0];
  ds.data.push({ x: ts, y: tempC }); cap(ds);
  const win = CFG.LIVE_WINDOW_MIN * 60 * 1000;
  tempChart.options.scales.x.min = ts - win;
  tempChart.options.scales.x.max = ts;
  tempChart.update('none');
}

// -------- Email notify --------
let lastNotifyTs = 0;
function getSnapshotDataURL(){
  if (!stream || !enableCam.checked || !webcamReady()) return null;
  const c = document.createElement('canvas');
  c.width = video.videoWidth || 640; c.height = video.videoHeight || 480;
  c.getContext('2d').drawImage(video, 0, 0, c.width, c.height);
  return c.toDataURL('image/jpeg', 0.75); // slightly lower for speed
}
async function maybeNotify(ts, intensity, pirVal){
  if (!ENDPOINTS.NOTIFY_URL) return;
  if (ts - lastNotifyTs < EMAIL_COOLDOWN_MS) return;
  const imageData = getSnapshotDataURL();
  if (!imageData){ addLog("<b>Email:</b> no snapshot available"); return; }
  try{
    const r = await fetch(ENDPOINTS.NOTIFY_URL, {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ ts, imageData, intensity, pir: pirVal })
    });
    const j = await r.json().catch(()=>({}));
    if (r.ok && j.ok){
      lastNotifyTs = ts;
      addLog(`<b>Email sent</b> @ ${fmtTime(ts)} (cooldown 2m)`);
    }else{
      addLog(`<b>Email failed</b> — HTTP ${r.status}${j.error?": "+j.error:""}`);
    }
  }catch(err){ addLog(`<b>Email error:</b> ${err.message}`); }
}

// -------- Webcam pipeline --------
let stream = null;
async function startWebcam(){
  if (!enableCam.checked) return;
  try{
    stream = await navigator.mediaDevices.getUserMedia({ video:{ width:CFG.WEBCAM_WIDTH, height:CFG.WEBCAM_HEIGHT }, audio:false });
    video.srcObject = stream; setStatus('Webcam ON');
  }catch(err){ setStatus('Webcam blocked/unavailable'); addLog(`<b>Webcam error:</b> ${err.message}`); }
}
function stopWebcam(){
  if (stream){ stream.getTracks().forEach(t => t.stop()); stream = null; video.srcObject = null; }
}

// Robust intensity = fraction of changed pixels (downscaled)
function computeIntensity(){
  if (!stream || !webcamReady()) return 0;
  work.width = DOWNSCALE_W; work.height = DOWNSCALE_H;
  ctxWork.drawImage(video, 0, 0, DOWNSCALE_W, DOWNSCALE_H);
  const curr = ctxWork.getImageData(0, 0, DOWNSCALE_W, DOWNSCALE_H);
  if (!lastFrameSmall){ lastFrameSmall = curr; return 0; }

  const a = curr.data, b = lastFrameSmall.data;
  let changed = 0, total = 0;
  for (let i = 0; i < a.length; i += 4){
    const y1 = (a[i]*0.299 + a[i+1]*0.587 + a[i+2]*0.114);
    const y0 = (b[i]*0.299 + b[i+1]*0.587 + b[i+2]*0.114);
    if (Math.abs(y1 - y0) >= PIXEL_DELTA) changed++;
    total++;
  }
  lastFrameSmall = curr;
  return changed / total; // 0..1
}

// -------- PIR / DHT polling --------
async function pollPIR(){
  let value = 0, ts = now();
  if (enablePIR.checked && ENDPOINTS.PIR_URL){
    try{
      const r = await fetch(ENDPOINTS.PIR_URL, { cache:'no-store' });
      const j = await r.json();
      value = Number(j.value) ? 1 : 0;
      ts = j.ts || ts; elLastUpd.textContent = fmtTime(ts);
    }catch(err){ addLog(`<b>PIR fetch failed:</b> ${err.message} — simulating 0`); }
  }else{
    if (Math.random() < 0.10) value = 1; // simulated occasional motion
  }

  // Push to chart
  pushPIR(ts, value);

  // Rising edge: capture immediately, skip debounce
  if (value === 1 && lastPirVal === 0){
    markEvent(ts, 1.0);
    addCapture(ts);
    maybeNotify(ts, 1.0, 1);
    lastEventActive = true;
    aboveCount = TRIGGER_CONSEC;  // keep loop state consistent
  }
  lastPirVal = value;
}

async function pollTemp(){
  let ts = now(), tempC = null;
  if (ENDPOINTS.DHT_URL){
    try{
      const r = await fetch(ENDPOINTS.DHT_URL, { cache:'no-store' });
      const j = await r.json();
      ts = j.ts || ts; tempC = typeof j.temp_c === 'number' ? j.temp_c : null;
    }catch(e){ addLog('<b>DHT:</b> fetch failed; simulating temp'); }
  }
  if (tempC == null){
    const t = Date.now()/1000; tempC = 27 + 2*Math.sin(t/30) + (Math.random()-0.5)*0.3;
  }
  pushTempAndClamp(ts, tempC);
}

// -------- Main loop (adaptive threshold + hysteresis) --------
let rafId = null;
function loop(){
  if (!running){ rafId = null; return; }

  // FPS meter
  fpsCounter.frames++;
  const t = performance.now();
  if (t - fpsCounter.last >= 1000){
    setBadge(elFps, fpsCounter.frames); fpsCounter.frames = 0; fpsCounter.last = t;
  }

  const ts = now();
  const intensity = enableCam.checked ? computeIntensity() : 0;

  if (ts - lastSampleTs >= SAMPLE_MS){
    // Update adaptive baseline
    const prevMu = mu;
    mu = (1 - BASE_ALPHA) * mu + BASE_ALPHA * intensity;
    const dev = intensity - prevMu;
    varEMA = (1 - VAR_ALPHA) * varEMA + VAR_ALPHA * (dev * dev);
    sigma = Math.max(0.01, Math.sqrt(varEMA));
    currentDynThresh = mu + K_SIGMA * sigma;

    const effThresh = Math.max(CFG.THRESHOLD, currentDynThresh);

    // Latest PIR val
    const pirDS = motionChart.data.datasets[0].data;
    const pirVal = pirDS.length ? pirDS[pirDS.length - 1].y : 0;

    // Hysteresis
    const above = (intensity >= effThresh) || (pirVal === 1);
    if (above){ aboveCount++; belowCount = 0; } else { belowCount++; aboveCount = 0; }
    const active = (aboveCount >= TRIGGER_CONSEC) ? true
                   : (belowCount >= RESET_CONSEC) ? false
                   : lastEventActive;

    if (active && !lastEventActive){
      markEvent(ts, intensity);
      addCapture(ts);
      maybeNotify(ts, intensity, pirVal);
    }
    lastEventActive = active;

    pushIntensityAndClamp(ts, intensity, effThresh);
    lastSampleTs = ts;
  }

  rafId = requestAnimationFrame(loop);
}

// -------- Captures --------
function addCapture(ts){
  if (!stream || !enableCam.checked || !webcamReady()) return;
  const c = document.createElement('canvas');
  c.width = video.videoWidth || 640; c.height = video.videoHeight || 480;
  c.getContext('2d').drawImage(video, 0, 0, c.width, c.height);
  const url = c.toDataURL('image/jpeg', 0.75);

  const img = document.createElement('img');
  img.src = url; img.alt = `capture ${new Date(ts).toLocaleString()}`;
  img.title = new Date(ts).toLocaleString();
  img.addEventListener('click', () => { lightImg.src = url; lightbox.classList.remove('hidden'); });
  caps.prepend(img);
  if (snapshotEl) snapshotEl.src = url;

  while (caps.children.length > CFG.MAX_CAPTURES) caps.removeChild(caps.lastChild);

  captures++; setBadge(elCapCount, captures);
  addLog(`<b>Capture</b> @ ${fmtTime(ts)}`);
}

// -------- Lightbox --------
lightbox.addEventListener('click', () => { lightbox.classList.add('hidden'); lightImg.src = ''; });

// -------- Controls --------
btnStart.addEventListener('click', async () => {
  CFG.THRESHOLD       = parseFloat(elThresh.value);
  CFG.POLL_MS         = Math.max(250, parseInt(elPollMs.value || DEFAULTS.POLL_MS, 10));
  CFG.LIVE_WINDOW_MIN = Math.max(1, parseInt(elWinMin.value || DEFAULTS.LIVE_WINDOW_MIN, 10));
  CFG.MAX_CAPTURES    = Math.max(1, parseInt(elMaxCaps.value || DEFAULTS.MAX_CAPTURES, 10));
  elThreshV.textContent = CFG.THRESHOLD.toFixed(2);

  // reset adaptive stats when starting
  mu = 0; varEMA = 0; sigma = 0.02; currentDynThresh = CFG.THRESHOLD;
  aboveCount = belowCount = 0; lastEventActive = false; lastPirVal = 0;

  if (enableCam.checked) await startWebcam();

  if (pirTimer) clearInterval(pirTimer);
  pirTimer = setInterval(pollPIR, CFG.POLL_MS);

  if (tempTimer) clearInterval(tempTimer);
  tempTimer = setInterval(pollTemp, DHT_POLL_MS);
  pollTemp(); // seed immediately

  // seed motion window
  const t0 = now();
  lastSampleTs = t0 - SAMPLE_MS;
  pushIntensityAndClamp(t0, 0, CFG.THRESHOLD);

  running = true;
  setStatus('Monitoring…');
  btnStart.disabled = true; btnStop.disabled = false;
  loop();
});

btnStop.addEventListener('click', () => {
  running = false;
  if (rafId) cancelAnimationFrame(rafId);
  if (pirTimer) clearInterval(pirTimer);
  if (tempTimer) clearInterval(tempTimer);
  pirTimer = null; tempTimer = null;
  stopWebcam();
  setStatus('Stopped');
  btnStart.disabled = false; btnStop.disabled = true;
});

elThresh.addEventListener('input', () => { elThreshV.textContent = Number(elThresh.value).toFixed(2); });

btnClearCaps.addEventListener('click', () => { caps.innerHTML = ''; captures = 0; setBadge(elCapCount, captures); });
btnClearChart.addEventListener('click', () => {
  for (const ds of motionChart.data.datasets) ds.data.length = 0;
  for (const ds of tempChart.data.datasets) ds.data.length = 0;
  motionChart.update(); tempChart.update();
  events = 0; setBadge(elEventCount, events);
});

// Init
function initUI(){
  elThresh.value = DEFAULTS.THRESHOLD;
  elThreshV.textContent = DEFAULTS.THRESHOLD.toFixed(2);
  elPollMs.value = DEFAULTS.POLL_MS;
  elWinMin.value = DEFAULTS.LIVE_WINDOW_MIN;
  elMaxCaps.value = DEFAULTS.MAX_CAPTURES;
  setStatus('Idle'); setBadge(elEventCount, 0); setBadge(elCapCount, 0); setBadge(elFps, 0);
  elLastUpd.textContent = '—';
}
initUI();
