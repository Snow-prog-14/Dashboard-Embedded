// ------- Chart.js defaults: fill parent size -------
Chart.defaults.responsive = true;
Chart.defaults.maintainAspectRatio = false;

/* ========= Config ========= */
const POLL_MS = 2000;                 // GPS API polling
const DEFAULT_API_URL = 'http://192.168.1.48:5000/api/gps';
const USE_HAVERSINE = true;

// Accel
const ACC_API_MS = 40;                // ~25 Hz polling
const DEFAULT_ACC_API = 'http://192.168.1.48:5000/api/acc';
const ACC_DEMO_HZ = 50;               // 50 Hz simulated

// Buzzer (Pi API)
const BUZZ_URL = 'http://192.168.1.48:5000/api/buzzer/beep';
const BUZZ_COOLDOWN_MS = 2000;        // avoid hammering the buzzer
let _lastBuzzTs = 0;

/* ========= Elements ========= */
const $ = s => document.querySelector(s);

// Topbar controls
const btnStart  = $('#btnStart');
const btnStop   = $('#btnStop');
const btnSpeak  = $('#btnSpeak');
const btnCenter = $('#btnCenter');
const btnTheme  = $('#btnTheme');
const selSrc    = $('#dataSource');
const inpApi    = $('#apiUrl');
const chkPath   = $('#chkPath');
const toast     = $('#toast');

// KPI fields
const elLat = $('#lat'), elLng = $('#lng'), elAcc = $('#acc'), elTs = $('#ts'), elPts = $('#pts'), elSpd = $('#spd');

// Accel controls + labels
const accSource = $('#accSource');
const accApiUrl = $('#accApiUrl');
const accStart  = $('#accStart');
const accStop   = $('#accStop');
const elAx = $('#ax'), elAy = $('#ay'), elAz = $('#az'), elAmag = $('#amag'), elAccTs = $('#accTs'), elAccPts = $('#accPts');

/* ========= State ========= */
let map, marker, pathLine;
let gpsAccChart, accRawChart, accMagChart; // (speed chart removed)

let path = [];         // GPS fixes
let lastFix = null;

let watchId = null;    // geolocation watcher
let pollTimer = null;  // GPS API timer
let demoTimer = null;  // GPS demo timer
let autoCentered = false;

let accTimer = null;   // accel demo/API timer
let accCount = 0;

// Speak toggle
let isSpeaking = false;

// Accel threshold edge tracking
let _accOver = false;           // were we over 1.0g last sample?

/* ========= Init ========= */
init();

function init(){
  // Theme preference
  if (localStorage.getItem('theme') === 'light') document.documentElement.classList.add('light');

  // Inputs
  inpApi.value = localStorage.getItem('gps_api_url') || DEFAULT_API_URL;
  inpApi.addEventListener('change', () => localStorage.setItem('gps_api_url', inpApi.value.trim()));
  accApiUrl.value = localStorage.getItem('acc_api_url') || DEFAULT_ACC_API;
  accApiUrl.addEventListener('change', () => localStorage.setItem('acc_api_url', accApiUrl.value.trim()));

  // Map
  map = L.map('map', { zoomControl: true }).setView([14.5995, 120.9842], 13);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { attribution: '&copy; OpenStreetMap' }).addTo(map);
  marker = L.circleMarker([14.5995,120.9842], { radius: 7 }).addTo(map);
  pathLine = L.polyline([], { weight: 4, opacity: 0.9 }).addTo(map);

  // Charts
  gpsAccChart = new Chart($('#gpsAccChart'), {
    type: 'line',
    data: { labels: [], datasets: [{ label: 'Accuracy (m)', data: [], fill: true, tension: 0.25, pointRadius: 0, borderWidth: 2 }]},
    options: { animation: false, scales: { x: { ticks: { maxRotation: 0, autoSkip: true }}, y: { beginAtZero: true }}, plugins: { legend: { display: false } } }
  });

  accRawChart = new Chart($('#accRaw'), {
    type: 'line',
    data: { labels: [], datasets: [
      { label: 'ax (g)', data: [], tension: 0.1, pointRadius: 0, borderWidth: 1.6 },
      { label: 'ay (g)', data: [], tension: 0.1, pointRadius: 0, borderWidth: 1.6 },
      { label: 'az (g)', data: [], tension: 0.1, pointRadius: 0, borderWidth: 1.6 }
    ]},
    options: { animation: false, scales: { x:{ ticks:{ maxRotation:0, autoSkip:true } }, y:{ beginAtZero:true } },
      plugins:{ legend:{ display:true }, decimation:{ enabled:true, algorithm:'lttb', samples:300 } }
    }
  });

  accMagChart = new Chart($('#accMag'), {
    type: 'line',
    data: { labels: [], datasets: [{ label: '|a| (g)', data: [], tension: 0.15, pointRadius: 0, borderWidth: 2 }]},
    options: { animation: false, scales: { x:{ ticks:{ maxRotation:0, autoSkip:true } }, y:{ beginAtZero:true } },
      plugins:{ legend:{ display:false }, decimation:{ enabled:true, algorithm:'lttb', samples:300 } }
    }
  });

  // Ensure charts fill their cards even after layout shifts
  setupChartResizer();
  kickResize();
  requestAnimationFrame(kickResize);
  setTimeout(kickResize, 120);
  window.addEventListener('load', kickResize);
  window.addEventListener('resize', kickResize);

  // Buttons
  btnStart.addEventListener('click', startTracking);
  btnStop.addEventListener('click', stopTracking);
  btnSpeak.addEventListener('click', toggleSpeak);
  btnCenter.addEventListener('click', () => centerOnLast(17));
  btnTheme.addEventListener('click', toggleTheme);
  selSrc.addEventListener('change', () => { stopTracking(); info('Source changed.'); });
  chkPath.addEventListener('change', () => pathLine.setStyle({ opacity: chkPath.checked ? 0.9 : 0 }));

  // Accel buttons
  accStart.addEventListener('click', startACC);
  accStop.addEventListener('click', stopACC);

  // Keyboard quick toggle
  window.addEventListener('keydown', (e) => { if (e.key.toLowerCase() === 's') btnStart.disabled ? stopTracking() : startTracking(); });

  // Nudge charts after the map settles
  map.whenReady(() => { map.invalidateSize(); kickResize(); });
  map.on('resize', kickResize);
}

/* ========= Helper: seed from current browser location ========= */
function seedFromBrowserLocation() {
  return new Promise((resolve) => {
    if (!('geolocation' in navigator)) return resolve(null);
    navigator.geolocation.getCurrentPosition(
      (pos) => resolve({ lat: pos.coords.latitude, lng: pos.coords.longitude }),
      () => resolve(null),
      { enableHighAccuracy: true, timeout: 8000, maximumAge: 1000 }
    );
  });
}

/* ========= GPS tracking ========= */
function startTracking(){
  btnStart.disabled = true; btnStop.disabled = false;
  path = []; lastFix = null; autoCentered = false;
  clearGpsAcc(); updateStats();
  stopDemo(); // ensure no demo is running

  if (selSrc.value === 'geolocation') {
    // Try to center/seed at current laptop location immediately
    seedFromBrowserLocation().then((seed) => {
      if (seed) {
        marker.setLatLng([seed.lat, seed.lng]);
        map.setView([seed.lat, seed.lng], 16);
      }
    });

    if (!('geolocation' in navigator)) {
      error('Geolocation not supported. Starting demo from your last known position if available.');
      seedFromBrowserLocation().then((seed) => startDemo(seed));
      return;
    }

    watchId = navigator.geolocation.watchPosition(onGeo, onGeoErr, {
      enableHighAccuracy: true,
      timeout: 15000,
      maximumAge: 1000
    });
    info('Geolocation started. If it fails, we will auto-switch to demo from your current location.');
  } else {
    pollTimer = setInterval(fetchFromApi, POLL_MS);
    fetchFromApi();
    info('Polling API…');
  }
}

function stopTracking(){
  btnStart.disabled = false; btnStop.disabled = true;
  if (watchId !== null) { navigator.geolocation.clearWatch(watchId); watchId = null; }
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  stopDemo();
  info('Tracking stopped.');
}

function onGeo(pos){
  const { latitude, longitude, accuracy, speed } = pos.coords;
  const time = pos.timestamp || Date.now();
  ingestFix({ lat: latitude, lng: longitude, accuracy, time, speedMS: speed });
}

function onGeoErr(err){
  const msg = {
    1: 'Permission denied. Enable location in the browser/site settings.',
    2: 'Position unavailable. Move closer to Wi-Fi or try again.',
    3: 'Timed out. Retrying…'
  }[err.code] || (err.message || String(err));
  error(`Geolocation error: ${msg}`);

  if (err.code === 1 || err.code === 2) {
    info('Switching to demo seeded by your current location…');
    seedFromBrowserLocation().then((seed) => startDemo(seed));
  }
}

async function fetchFromApi(){
  try{
    const url = (inpApi.value || '').trim();
    if (!url) return;
    const res = await fetch(url, { cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const j = await res.json(); // { lat, lng, accuracy?, timestamp? }
    const time = j.timestamp ? toEpochMs(j.timestamp) : Date.now();
    ingestFix({ lat: Number(j.lat), lng: Number(j.lng), accuracy: j.accuracy ?? null, time });
  }catch(e){
    error(`API error: ${e.message}`);
  }
}

function ingestFix(fix){
  if (!Number.isFinite(fix.lat) || !Number.isFinite(fix.lng)) return;

  // Add to path
  path.push(fix);
  if (path.length > 100000) path.shift();

  // Map visuals
  marker.setLatLng([fix.lat, fix.lng]);
  if (chkPath.checked) pathLine.addLatLng([fix.lat, fix.lng]);
  if (!autoCentered) { centerOnLast(17); autoCentered = true; }

  // Speed calc (for KPI only)
  const kmh = deriveSpeedKmh(fix, lastFix);

  // Chart
  if (fix.accuracy != null)
    pushGpsAccuracy(new Date(fix.time).toLocaleTimeString(), Number(fix.accuracy));

  // KPI
  lastFix = fix;
  updateStats(kmh);
}

function deriveSpeedKmh(now, prev){
  if (Number.isFinite(now.speedMS) && now.speedMS !== null) return Math.max(0, now.speedMS) * 3.6;
  if (!prev) return null;
  const dt = (now.time - prev.time) / 1000; if (dt <= 0) return null;
  const meters = distanceMeters(prev.lat, prev.lng, now.lat, now.lng);
  let kmh = (meters / dt) * 3.6;
  if (meters < 2) kmh = 0;
  return kmh;
}

function centerOnLast(zoom=17){
  const latest = path[path.length - 1];
  if (!latest) return;
  map.setView([latest.lat, latest.lng], zoom, { animate: true });
}

function updateStats(kmh=null){
  const latest = path[path.length - 1] || {};
  elLat.textContent = latest.lat?.toFixed?.(6) ?? '—';
  elLng.textContent = latest.lng?.toFixed?.(6) ?? '—';
  elAcc.textContent = latest.accuracy != null ? `${Number(latest.accuracy).toFixed(0)} m` : '—';
  elTs.textContent  = latest.time ? new Date(latest.time).toLocaleString() : '—';
  elPts.textContent = path.length;
  elSpd.textContent = kmh != null ? `${kmh.toFixed(1)} km/h` : '—';

  if (latest.accuracy == null) elAcc.classList.remove('good');
  else Number(latest.accuracy) <= 10 ? elAcc.classList.add('good') : elAcc.classList.remove('good');
}

/* ========= GPS chart helpers ========= */
function pushGpsAccuracy(label, meters){
  gpsAccChart.data.labels.push(label);
  gpsAccChart.data.datasets[0].data.push(meters);
  if (gpsAccChart.data.labels.length > 240) { gpsAccChart.data.labels.shift(); gpsAccChart.data.datasets[0].data.shift(); }
  gpsAccChart.update();
}
function clearGpsAcc(){ gpsAccChart.data.labels = []; gpsAccChart.data.datasets[0].data = []; gpsAccChart.update(); }

/* ========= GPS demo (fallback) ========= */
let demoState = { lat: 14.5995, lng: 120.9842, heading: 45, accuracy: 8 };

function startDemo(seed){
  stopDemo();
  if (seed && Number.isFinite(seed.lat) && Number.isFinite(seed.lng)) {
    demoState.lat = seed.lat;
    demoState.lng = seed.lng;
  }
  demoTimer = setInterval(() => {
    const rad = (demoState.heading * Math.PI) / 180;
    const dLat = (DEMO_STEP_M * Math.cos(rad)) / 111_111;
    const dLng = (DEMO_STEP_M * Math.sin(rad)) / (111_111 * Math.cos((demoState.lat * Math.PI) / 180));
    demoState.lat += dLat;
    demoState.lng += dLng;
    demoState.heading += (Math.random() - 0.5) * DEMO_HEADING_JITTER;
    demoState.accuracy = 6 + Math.random() * 8;

    ingestFix({
      lat: demoState.lat,
      lng: demoState.lng,
      accuracy: demoState.accuracy,
      time: Date.now(),
      speedMS: DEMO_STEP_M / (POLL_MS / 1000)
    });
  }, POLL_MS);
  info('Demo GPS running (seeded from your current location when available).');
}

function stopDemo(){
  if (demoTimer) { clearInterval(demoTimer); demoTimer = null; }
}

/* ========= Accelerometer ========= */
function startACC(){
  accStart.disabled = true; accStop.disabled = false;
  clearAccCharts(); accCount = 0; updateAccStats();

  const src = accSource.value;
  if (src === 'demo'){
    // Simulated: mostly 1g on Z, occasional shakes
    accTimer = setInterval(() => {
      const t = Date.now();
      const shake = Math.random() < 0.05 ? (Math.random()*1.5) : 0;
      const ax = (Math.random()-0.5)*0.05 + (shake ? Math.sin(t/80)*shake : 0);
      const ay = (Math.random()-0.5)*0.05 + (shake ? Math.cos(t/100)*shake : 0);
      const az = 1 + (Math.random()-0.5)*0.05;
      handleAccSample({ ax, ay, az, time: t });
    }, 1000 / ACC_DEMO_HZ);

  } else {
    const url = (accApiUrl.value || '').trim();
    if (!url){ alert('Enter Accel API URL.'); stopACC(); return; }
    accTimer = setInterval(async ()=>{
      try{
        const res = await fetch(url, { cache:'no-store' });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const j = await res.json(); // { ax, ay, az, timestamp? }
        const t = j.timestamp ? toEpochMs(j.timestamp) : Date.now();
        handleAccSample({ ax: Number(j.ax), ay: Number(j.ay), az: Number(j.az), time: t });
      }catch(e){ console.warn('ACC API error:', e.message); }
    }, ACC_API_MS);
  }
}

function stopACC(){
  accStart.disabled = false; accStop.disabled = true;
  if (accTimer){ clearInterval(accTimer); accTimer = null; }
}

async function buzz(ms = 400){
  const now = Date.now();
  if (!BUZZ_URL || (now - _lastBuzzTs) < BUZZ_COOLDOWN_MS) return;
  _lastBuzzTs = now;
  try{
    await fetch(BUZZ_URL, {
      method:'POST',
      headers:{ 'Content-Type':'application/json' },
      body: JSON.stringify({ ms })
    });
  }catch{
    try{ await fetch(BUZZ_URL); }catch{}
  }
}

function handleAccSample(s){
  if (![s.ax, s.ay, s.az].every(Number.isFinite)) return;

  const ts = s.time;
  const mag = Math.hypot(s.ax, s.ay, s.az);

  // Charts
  pushAccRaw(ts, s.ax, s.ay, s.az);
  pushAccMag(ts, mag);

  // ---- BUZZ when |a| crosses above 1.0g (edge detect) ----
  const over = mag > 1.0;
  if (over && !_accOver) { buzz(400); }
  _accOver = over;

  // Stats
  accCount++;
  updateAccStats(s.ax, s.ay, s.az, mag, ts);
}

function updateAccStats(ax=null,ay=null,az=null,mag=null,ts=null){
  if (ax!=null) elAx.textContent = ax.toFixed(3);
  if (ay!=null) elAy.textContent = ay.toFixed(3);
  if (az!=null) elAz.textContent = az.toFixed(3);
  if (mag!=null) elAmag.textContent = mag.toFixed(3);
  if (ts!=null) elAccTs.textContent = new Date(ts).toLocaleTimeString();
  elAccPts.textContent = accCount;
}

function pushAccRaw(ts, ax, ay, az){
  const L = accRawChart.data.labels;
  const D = accRawChart.data.datasets;
  L.push(new Date(ts).toLocaleTimeString());
  D[0].data.push(ax); D[1].data.push(ay); D[2].data.push(az);
  if (L.length > 2000){ L.shift(); D.forEach(ds => ds.data.shift()); }
  accRawChart.update();
}

function pushAccMag(ts, mag){
  const L = accMagChart.data.labels;
  const D = accMagChart.data.datasets[0].data;
  L.push(new Date(ts).toLocaleTimeString());
  D.push(mag);
  if (L.length > 2000){ L.shift(); D.shift(); }
  accMagChart.update();
}

function clearAccCharts(){
  accRawChart.data.labels = []; accRawChart.data.datasets.forEach(ds => ds.data = []);
  accMagChart.data.labels = []; accMagChart.data.datasets[0].data = [];
  accRawChart.update(); accMagChart.update();
}

/* ========= Chart sizing helpers ========= */
function sizeChartToParent(chart){
  if (!chart) return;
  const box = chart.canvas.parentNode.getBoundingClientRect();
  chart.canvas.style.width  = box.width + 'px';
  chart.canvas.style.height = Math.max(120, box.height) + 'px';
  chart.resize();
}
function kickResize(){ [gpsAccChart, accRawChart, accMagChart].forEach(sizeChartToParent); }

function setupChartResizer(){
  const ro = new ResizeObserver(() => kickResize());
  document.querySelectorAll('.canvas-wrap').forEach(el => ro.observe(el));
  const grid = document.querySelector('.grid');
  if (grid) ro.observe(grid);
}

/* ========= Utilities ========= */
function distanceMeters(lat1, lon1, lat2, lon2){
  if (!USE_HAVERSINE){
    const dx = (lat2-lat1) * 111_320;
    const dy = (lon2-lon1) * 111_320 * Math.cos((lat1+lat2)/2 * Math.PI/180);
    return Math.hypot(dx, dy);
  }
  const R = 6371e3, toRad = x => x*Math.PI/180;
  const dLat = toRad(lat2-lat1), dLon = toRad(lon2-lon1);
  const a = Math.sin(dLat/2)**2 + Math.cos(toRad(lat1))*Math.cos(toRad(lat2))*Math.sin(dLon/2)**2;
  return 2 * R * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

function toEpochMs(t){
  if (typeof t === 'number') return t;
  const d = new Date(t);
  const v = d.getTime();
  return Number.isFinite(v) ? v : Date.now();
}

/* ========= Voice toggle ========= */
function toggleSpeak(){
  if (window.speechSynthesis.speaking || window.speechSynthesis.pending || isSpeaking) {
    window.speechSynthesis.cancel(); isSpeaking = false; updateSpeakUI(false); return;
  }
  const latest = path[path.length - 1];
  if (!latest) { info('No fix to speak yet.'); return; }
  const u = new SpeechSynthesisUtterance(`Your location is latitude ${latest.lat.toFixed(5)}, longitude ${latest.lng.toFixed(5)}.`);
  u.onend = () => { isSpeaking = false; updateSpeakUI(false); };
  u.onerror = () => { isSpeaking = false; updateSpeakUI(false); };
  isSpeaking = true; updateSpeakUI(true); window.speechSynthesis.speak(u);
}
function updateSpeakUI(active){
  btnSpeak.textContent = active ? '⏹ Stop' : '🔊 Speak';
  btnSpeak.setAttribute('aria-pressed', active ? 'true' : 'false');
}

/* ========= Theme + Toast ========= */
function toggleTheme(){
  document.documentElement.classList.toggle('light');
  localStorage.setItem('theme', document.documentElement.classList.contains('light') ? 'light' : 'dark');
  kickResize(); // fonts/layout change → resize charts
}

let toastTimer = null;
function showToast(text){
  toast.textContent = text;
  toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove('show'), 2200);
}
function info(t){ showToast(t); }
function error(t){ showToast(t); console.warn(t); }