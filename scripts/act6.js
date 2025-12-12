// act6.js - full script (copy and paste to replace your current file)

// Chart.js defaults: fill parent size
Chart.defaults.responsive = true;
Chart.defaults.maintainAspectRatio = false;

/* ========= Config ========= */
const POLL_MS = 1000;                 // GPS demo/API poll (1 s for obvious movement)
const DEFAULT_API_URL = 'http://192.168.1.48:5000/api/gps';
const USE_HAVERSINE = true;

// Accel (API polling)
const ACC_API_MS = 40;                // ~25 Hz polling for API
const DEFAULT_ACC_API = 'http://192.168.1.48:5000/api/acc';

// Demo GPS (fallback) config - bigger, faster steps so it is obvious
const DEMO_STEP_M   = 5.0;            // meters per tick
const DEMO_HEADING_JITTER = 10;       // degrees random walk

// Movement speech thresholds (edge-triggered via accelerometer)
const MOVE_EDGE_G          = 1.00;    // nominal threshold for |a|
const MOVE_HYSTERESIS_G    = 0.05;    // +/- band to avoid chatter
const SPEAK_EDGE_COOLDOWN  = 8000;    // ms between movement/stopped announcements

// Auto-speak by distance (GPS; real data)
const SPEAK_DIST_M             = 15;    // speak when moved >= 15 m (real GPS/API)
const SPEAK_DISTANCE_COOLDOWN  = 6000;  // min gap for real GPS/API

// Demo accelerometer pattern: 5s move, 5s rest
const ACC_DEMO_RATE_HZ   = 25;        // demo sampling rate
const ACC_DEMO_PHASE_MS  = 5000;      // each phase duration

// Sliding windows (seconds)
const GPS_WINDOW_S = 600;   // 10 minutes
const ACC_WINDOW_S = 30;    // 30 seconds

// Monotonic clock (seconds since page load)
const T0 = performance.now();
const nowSec = () => (performance.now() - T0) / 1000;

/* ========= Elements ========= */
const $ = s => document.querySelector(s);

// Topbar controls
const btnCenter = $('#btnCenter');
const btnTheme  = $('#btnTheme');
const selSrc    = $('#dataSource'); // user confirmed this exists
const inpApi    = $('#apiUrl');     // optional
const chkPath   = $('#chkPath');
const toast     = $('#toast');
const autoSpeak = $('#autoSpeak');

// KPI fields
const elLat = $('#lat'), elLng = $('#lng'), elAcc = $('#acc'), elTs = $('#ts'), elPts = $('#pts'), elSpd = $('#spd');

// Accel controls + labels - HTML may not include accSource or accApiUrl, code handles that
const accSource = $('#accSource');
const accApiUrl = $('#accApiUrl');
const elAx = $('#ax'), elAy = $('#ay'), elAz = $('#az'), elAmag = $('#amag'), elAccTs = $('#accTs'), elAccPts = $('#accPts');

/* ========= State ========= */
let map, marker, pathLine;
let gpsAccChart, accRawChart, accMagChart;

let path = [];         // GPS fixes
let lastFix = null;

let watchId = null;    // geolocation watcher
let pollTimer = null;  // GPS API timer
let demoTimer = null;  // GPS demo timer
let autoCentered = false;

let accTimer = null;   // accel demo/API timer
let accCount = 0;

// Voice state
let isSpeaking = false;
let preferredVoice = null;
let ttsUnlocked = false;

// Accel auto-speak helpers
let wasMoving = false;      // edge detector
let lastEdgeSpeakTs = 0;    // cooldown for accel edges

// Distance-based auto-speak helpers
let distAnchor = { lat: null, lng: null }; // last spoken GPS coords
let lastDistSpeakTs = 0;                   // cooldown for distance speech

// Track if the GPS DEMO is running (to speak every step)
let isDemoRunning = false;

/* ========= Init ========= */
init();

function init(){
  // Theme preference
  if (localStorage.getItem('theme') === 'light') document.documentElement.classList.add('light');

  // Inputs: some elements may not exist in minimal markup, guard them
  if (inpApi) {
    inpApi.value = localStorage.getItem('gps_api_url') || DEFAULT_API_URL;
    inpApi.addEventListener('change', () => {
      localStorage.setItem('gps_api_url', inpApi.value.trim());
      restartTracking(); // apply new URL immediately if in API mode
    });
  }

  if (accApiUrl) {
    accApiUrl.value = localStorage.getItem('acc_api_url') || DEFAULT_ACC_API;
    accApiUrl.addEventListener('change', () => {
      localStorage.setItem('acc_api_url', accApiUrl.value.trim());
      restartACC(); // update polling target immediately
    });
  }

  // Persist Auto toggle (default ON)
  const savedAuto = localStorage.getItem('auto_speak_on_move');
  if (autoSpeak) {
    autoSpeak.checked = savedAuto ? savedAuto === '1' : true;
    autoSpeak.addEventListener('change', () =>
      localStorage.setItem('auto_speak_on_move', autoSpeak.checked ? '1' : '0')
    );
  }

  // Set up speech voice picking and unlock on first interaction
  setupSpeech();

  // Map
  map = L.map('map', { zoomControl: true }).setView([14.5995, 120.9842], 13);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '&copy; OpenStreetMap'
  }).addTo(map);
  marker = L.circleMarker([14.5995,120.9842], { radius: 7 }).addTo(map);
  pathLine = L.polyline([], { weight: 4, opacity: 0.9 }).addTo(map);

  // Charts
  gpsAccChart = new Chart($('#gpsAccChart'), {
    type: 'line',
    data: { datasets: [{ label: 'Accuracy (m)', data: [], fill: true, tension: 0.25, pointRadius: 0, borderWidth: 2 }] },
    options: {
      parsing: false, normalized: true, animation: false,
      scales: {
        x: { type: 'linear', min: 0, max: GPS_WINDOW_S, ticks: { callback: v => `${Math.floor(v)}s` } },
        y: { beginAtZero: true }
      },
      plugins: { legend: { display: false } }
    }
  });

  accRawChart = new Chart($('#accRaw'), {
    type: 'line',
    data: { datasets: [
      { label: 'ax (g)', data: [], tension: 0.1, pointRadius: 0, borderWidth: 1.6 },
      { label: 'ay (g)', data: [], tension: 0.1, pointRadius: 0, borderWidth: 1.6 },
      { label: 'az (g)', data: [], tension: 0.1, pointRadius: 0, borderWidth: 1.6 }
    ]},
    options: {
      parsing: false, normalized: true, animation: false,
      scales: {
        x: { type: 'linear', min: 0, max: ACC_WINDOW_S, ticks: { callback: v => `${Math.floor(v)}s` } },
        y: { beginAtZero: true }
      },
      plugins: { legend: { display: true }, decimation: { enabled: true, algorithm: 'lttb', samples: 300 } }
    }
  });

  accMagChart = new Chart($('#accMag'), {
    type: 'line',
    data: { datasets: [{ label: '|a| (g)', data: [], tension: 0.15, pointRadius: 0, borderWidth: 2 }] },
    options: {
      parsing: false, normalized: true, animation: false,
      scales: {
        x: { type: 'linear', min: 0, max: ACC_WINDOW_S, ticks: { callback: v => `${Math.floor(v)}s` } },
        y: { beginAtZero: true }
      },
      plugins: { legend: { display: false }, decimation: { enabled: true, algorithm: 'lttb', samples: 300 } }
    }
  });

  // UI actions
  if (btnCenter) btnCenter.addEventListener('click', () => centerOnLast(17));
  if (btnTheme) btnTheme.addEventListener('click', toggleTheme);
  if (selSrc) selSrc.addEventListener('change', () => { restartTracking(); info('GPS source changed.'); });
  if (chkPath) chkPath.addEventListener('change', () => pathLine.setStyle({ opacity: chkPath.checked ? 0.9 : 0 }));

  // Chart layout nudges
  setupChartResizer();
  kickResize();
  requestAnimationFrame(kickResize);
  setTimeout(kickResize, 120);
  window.addEventListener('load', kickResize);
  window.addEventListener('resize', kickResize);
  map.whenReady(() => { map.invalidateSize(); kickResize(); });
  map.on('resize', kickResize);

  // ACC source optional - if present, changing it will restart
  if (accSource) accSource.addEventListener('change', restartACC);

  // Auto-start
  startACC();
  startTracking();

  // Stop timers cleanly when tab is hidden/unloaded
  window.addEventListener('pagehide', cleanupTimers);
  window.addEventListener('beforeunload', cleanupTimers);
}

/* ========= Speech setup ========= */
function setupSpeech(){
  // pick a usable voice when available
  function pickPreferredVoice(){
    try {
      const voices = window.speechSynthesis.getVoices();
      if (!voices || !voices.length) { preferredVoice = null; return; }
      preferredVoice = voices.find(v => v.lang && v.lang.toLowerCase().startsWith('en')) || voices[0];
      console.log('Preferred TTS voice:', preferredVoice.name, preferredVoice.lang);
    } catch(e) {
      preferredVoice = null;
      console.warn('pickPreferredVoice failed', e);
    }
  }

  if ('speechSynthesis' in window) {
    if (typeof window.speechSynthesis.onvoiceschanged !== 'undefined') {
      window.speechSynthesis.onvoiceschanged = pickPreferredVoice;
    }
    pickPreferredVoice();
  } else {
    console.warn('SpeechSynthesis not available in this browser');
  }

  // Create a one-time unlock on first user interaction so automatic speech will play later
  function doUnlock(){
    if (ttsUnlocked) return;
    ttsUnlocked = true;
    try {
      const u = makeUtterance('Voice enabled');
      window.speechSynthesis.speak(u);
      console.log('TTS unlocked by user gesture');
    } catch(e) {
      console.warn('Unlock TTS failed', e);
    }
    document.removeEventListener('pointerdown', doUnlock);
    document.removeEventListener('keydown', doUnlock);
  }
  document.addEventListener('pointerdown', doUnlock, { once: true });
  document.addEventListener('keydown', doUnlock, { once: true });

  // Add a small Test Speech button so user can click and confirm audio works
  addTestSpeechButton();
}

function addTestSpeechButton(){
  try {
    const actions = document.querySelector('.actions');
    if (!actions) return;
    const btn = document.createElement('button');
    btn.id = 'testSpeech';
    btn.className = 'btn';
    btn.textContent = 'Test Speech';
    btn.title = 'Click to test text-to-speech';
    btn.addEventListener('click', () => {
      try {
        const u = makeUtterance('Test voice active.');
        window.speechSynthesis.speak(u);
        console.log('Test speech uttered');
      } catch (e) {
        console.warn('Test speech failed', e);
        showToast('Test speech failed');
      }
    });
    actions.appendChild(btn);
  } catch (e) {
    console.warn('Could not insert Test Speech button', e);
  }
}

function makeUtterance(text){
  const u = new SpeechSynthesisUtterance(text);
  if (preferredVoice) {
    try { u.voice = preferredVoice; u.lang = preferredVoice.lang || 'en-US'; } catch(e){ /* ignore */ }
  } else {
    u.lang = 'en-US';
  }
  u.volume = 1;
  u.rate = 1;
  u.pitch = 1;
  u.onstart = () => { isSpeaking = true; console.log('TTS start', text.slice(0,40)); };
  u.onend = () => { isSpeaking = false; console.log('TTS end'); };
  u.onerror = (ev) => { isSpeaking = false; console.warn('TTS error', ev); showToast('Speech error'); };
  return u;
}

/* ========= Cleanup ========= */
function cleanupTimers(){
  if (watchId !== null) { navigator.geolocation.clearWatch(watchId); watchId = null; }
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  if (demoTimer) { clearInterval(demoTimer); demoTimer = null; }
  if (accTimer)  { clearInterval(accTimer); accTimer = null; }
  try { window.speechSynthesis.cancel(); } catch(e){ /* ignore */ }
}

/* ========= Helper ========= */
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

/* ========= GPS tracking (automatic) ========= */
function restartTracking(){ stopTracking(); startTracking(); }

function startTracking(){
  // reset state
  path = []; lastFix = null; autoCentered = false;
  clearGpsAcc(); updateStats();
  stopDemo(); // ensure no previous demo is running
  distAnchor = { lat: null, lng: null };
  lastDistSpeakTs = 0;

  if (!selSrc) return;

  if (selSrc.value === 'geolocation') {
    // Try once - if permission denied/unavailable, fall back to demo immediately
    navigator.geolocation.getCurrentPosition(
      pos => {
        map.setView([pos.coords.latitude, pos.coords.longitude], 16);
        marker.setLatLng([pos.coords.latitude, pos.coords.longitude]);
        watchId = navigator.geolocation.watchPosition(onGeo, onGeoErr, {
          enableHighAccuracy: true, timeout: 15000, maximumAge: 1000
        });
        info('Geolocation started.');
      },
      () => {
        info('No geolocation permission - starting demo GPS.');
        seedFromBrowserLocation().then((seed) => startDemo(seed));
      },
      { enableHighAccuracy: true, timeout: 3000, maximumAge: 1000 }
    );
  } else {
    const url = (inpApi && inpApi.value) ? inpApi.value.trim() : DEFAULT_API_URL;
    pollTimer = setInterval(fetchFromApi, POLL_MS);
    // call once now
    fetchFromApi(url);
    info('Polling GPS API…');
  }
}

function stopTracking(){
  if (watchId !== null) { navigator.geolocation.clearWatch(watchId); watchId = null; }
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  stopDemo();
}

function onGeo(pos){
  if (!pos || !pos.coords) return;
  const { latitude, longitude, accuracy, speed } = pos.coords;
  const time = pos.timestamp || Date.now();
  ingestFix({ lat: latitude, lng: longitude, accuracy, time, speedMS: speed });
}

function onGeoErr(err){
  const msg = {
    1: 'Permission denied.',
    2: 'Position unavailable.',
    3: 'Timed out.'
  }[err && err.code] || (err && (err.message || String(err))) || 'Unknown error';
  error(`Geolocation error: ${msg}`);
  if (err && (err.code === 1 || err.code === 2)) {
    info('Switching to demo seeded by your current location…');
    seedFromBrowserLocation().then((seed) => startDemo(seed));
  }
}

async function fetchFromApi(providedUrl){
  try{
    const url = (providedUrl || (inpApi && inpApi.value) || DEFAULT_API_URL).trim();
    if (!url) return;
    const res = await fetch(url, { cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const j = await res.json(); // { lat, lng, accuracy?, timestamp? }
    const time = j.timestamp ? toEpochMs(j.timestamp) : Date.now();
    ingestFix({ lat: Number(j.lat), lng: Number(j.lng), accuracy: j.accuracy ?? null, time });
  }catch(e){
    error(`API error: ${e && e.message ? e.message : String(e)}`);
  }
}

function ingestFix(fix){
  if (!fix) return;
  if (!Number.isFinite(fix.lat) || !Number.isFinite(fix.lng)) return;

  // Add to path
  path.push(fix);
  if (path.length > 100000) path.shift();

  // Map visuals
  try {
    marker.setLatLng([fix.lat, fix.lng]);
    if (chkPath && chkPath.checked) pathLine.addLatLng([fix.lat, fix.lng]);
    if (!autoCentered) { centerOnLast(17); autoCentered = true; }
  } catch(e){
    console.warn('Map update failed', e);
  }

  // Speed calc (for KPI only)
  const kmh = deriveSpeedKmh(fix, lastFix);

  // Chart
  if (fix.accuracy != null) pushGpsAccuracy(Number(fix.accuracy));

  // KPI
  lastFix = fix;
  updateStats(kmh);

  // Auto-speak by distance/cooldown (special handling for DEMO)
  maybeSpeakByDistance(fix);
}

function deriveSpeedKmh(now, prev){
  if (!now) return null;
  if (Number.isFinite(now.speedMS) && now.speedMS !== null) return Math.max(0, now.speedMS) * 3.6;
  if (!prev) return null;
  const dt = (now.time - prev.time) / 1000; if (dt <= 0) return null;
  const meters = distanceMeters(prev.lat, prev.lng, now.lat, now.lng);
  let kmh = (meters / dt) * 3.6;
  if (meters < 2) kmh = 0; // ignore jitter
  return kmh;
}

function centerOnLast(zoom=17){
  const latest = path[path.length - 1];
  if (!latest) return;
  map.setView([latest.lat, latest.lng], zoom, { animate: true });
}

function updateStats(kmh=null){
  const latest = path[path.length - 1] || {};
  if (elLat) elLat.textContent = latest.lat?.toFixed?.(6) ?? '—';
  if (elLng) elLng.textContent = latest.lng?.toFixed?.(6) ?? '—';
  if (elAcc) elAcc.textContent = latest.accuracy != null ? `${Number(latest.accuracy).toFixed(0)} m` : '—';
  if (elTs) elTs.textContent  = latest.time ? new Date(latest.time).toLocaleString() : '—';
  if (elPts) elPts.textContent = path.length;
  if (elSpd) elSpd.textContent = kmh != null ? `${kmh.toFixed(1)} km/h` : '—';

  if (elAcc) {
    if (latest.accuracy == null) elAcc.classList.remove('good');
    else Number(latest.accuracy) <= 10 ? elAcc.classList.add('good') : elAcc.classList.remove('good');
  }
}

/* ========= Voice helpers (use makeUtterance) ========= */
function speakFix(fix, kmh){
  if (!fix) return;
  const lat = fix.lat.toFixed(5);
  const lng = fix.lng.toFixed(5);
  const acc = fix.accuracy != null ? `, accuracy ${Number(fix.accuracy).toFixed(0)} meters` : '';
  const speedPart = (kmh != null) ? `, speed ${kmh.toFixed(1)} kilometers per hour` : '';
  const text = `Location latitude ${lat}, longitude ${lng}${acc}${speedPart}.`;

  try {
    const u = makeUtterance(text);
    window.speechSynthesis.speak(u);
  } catch(e) {
    console.warn('Speech failed', e);
  }
}

function speakMovementState(state){
  const latest = path[path.length - 1];
  if (!latest) return;

  const lat = latest.lat.toFixed(5);
  const lng = latest.lng.toFixed(5);
  const acc = latest.accuracy != null ? `, accuracy ${Number(latest.accuracy).toFixed(0)} meters` : '';

  const text = state === 'moving'
    ? `Tracking moving. Location latitude ${lat}, longitude ${lng}${acc}.`
    : `Tracking stopped at latitude ${lat}, longitude ${lng}${acc}.`;

  try {
    const u = makeUtterance(text);
    window.speechSynthesis.speak(u);
  } catch(e) {
    console.warn('Speech failed', e);
  }
}

/* ========= Auto-speak by GPS distance ========= */
function maybeSpeakByDistance(fix){
  if (!autoSpeak || !autoSpeak.checked) return;
  if (window.speechSynthesis.speaking || isSpeaking) return;
  if (!fix) return;

  const now = Date.now();

  // DEMO mode: announce almost every step (tiny threshold, no cooldown)
  const demoDistThreshold = DEMO_STEP_M * 0.3; // ~1.5 m with 5 m steps
  const isDemo = isDemoRunning;

  // First anchor - speak once immediately
  if (distAnchor.lat == null || distAnchor.lng == null) {
    distAnchor = { lat: fix.lat, lng: fix.lng };
    lastDistSpeakTs = now;
    speakFix(fix, deriveSpeedKmh(fix, path.length >= 2 ? path[path.length - 2] : null));
    return;
  }

  const cooldown = isDemo ? 0 : SPEAK_DISTANCE_COOLDOWN;
  const thresh   = isDemo ? demoDistThreshold : SPEAK_DIST_M;

  if (now - lastDistSpeakTs < cooldown) return;

  const moved = distanceMeters(distAnchor.lat, distAnchor.lng, fix.lat, fix.lng);
  if (moved >= thresh) {
    speakFix(fix, deriveSpeedKmh(fix, path.length >= 2 ? path[path.length - 2] : null));
    distAnchor = { lat: fix.lat, lng: fix.lng };
    lastDistSpeakTs = now;
  }
}

/* ========= Chart helpers (sliding windows) ========= */
// GPS Accuracy
function pushGpsAccuracy(meters){
  const t = nowSec();
  const ds = gpsAccChart.data.datasets[0].data;
  ds.push({ x: t, y: meters });

  const minX = t - GPS_WINDOW_S;
  while (ds.length && ds[0].x < minX) ds.shift();

  gpsAccChart.options.scales.x.min = Math.max(0, minX);
  gpsAccChart.options.scales.x.max = Math.max(GPS_WINDOW_S, t);
  gpsAccChart.update();
}
function clearGpsAcc(){
  gpsAccChart.data.datasets[0].data = [];
  gpsAccChart.options.scales.x.min = 0;
  gpsAccChart.options.scales.x.max = GPS_WINDOW_S;
  gpsAccChart.update();
}

// Accel X/Y/Z
function pushAccRaw(ts, ax, ay, az){
  const t = nowSec();
  const D = accRawChart.data.datasets;
  D[0].data.push({ x: t, y: ax });
  D[1].data.push({ x: t, y: ay });
  D[2].data.push({ x: t, y: az });

  const minX = t - ACC_WINDOW_S;
  for (const ds of D) { while (ds.data.length && ds.data[0].x < minX) ds.data.shift(); }

  accRawChart.options.scales.x.min = Math.max(0, minX);
  accRawChart.options.scales.x.max = Math.max(ACC_WINDOW_S, t);
  accRawChart.update();
}

// Accel |a|
function pushAccMag(ts, mag){
  const t = nowSec();
  const D = accMagChart.data.datasets[0].data;
  D.push({ x: t, y: mag });

  const minX = t - ACC_WINDOW_S;
  while (D.length && D[0].x < minX) D.shift();

  accMagChart.options.scales.x.min = Math.max(0, minX);
  accMagChart.options.scales.x.max = Math.max(ACC_WINDOW_S, t);
  accMagChart.update();
}

function clearAccCharts(){
  accRawChart.data.datasets.forEach(ds => ds.data = []);
  accMagChart.data.datasets[0].data = [];
  accRawChart.options.scales.x.min = 0;
  accRawChart.options.scales.x.max = ACC_WINDOW_S;
  accMagChart.options.scales.x.min = 0;
  accMagChart.options.scales.x.max = ACC_WINDOW_S;
  accRawChart.update();
  accMagChart.update();
}

/* ========= GPS demo (fallback) ========= */
let demoState = { lat: 14.5995, lng: 120.9842, heading: 45, accuracy: 8 };

function startDemo(seed){
  stopDemo();
  if (seed && Number.isFinite(seed.lat) && Number.isFinite(seed.lng)) {
    demoState.lat = seed.lat;
    demoState.lng = seed.lng;
  }
  isDemoRunning = true;
  demoTimer = setInterval(() => {
    // simple random walk
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
  info('Demo GPS running (auto).');
}

function stopDemo(){
  if (demoTimer) { clearInterval(demoTimer); demoTimer = null; }
  isDemoRunning = false;
}

/* ========= Accelerometer (AUTOMATIC) ========= */
function restartACC(){ stopACC(); startACC(); }

function startACC(){
  clearAccCharts(); accCount = 0; updateAccStats();

  const src = (accSource && accSource.value) ? accSource.value : 'demo';
  if (src === 'demo'){
    // Deterministic pattern: 5s REST (~0.94 g), 5s MOVE (~1.15-1.25 g), repeat
    const t0 = Date.now();
    let lastPhase = -1; // 0 = REST, 1 = MOVE

    accTimer = setInterval(() => {
      const t = Date.now();
      const phase = Math.floor((t - t0) / ACC_DEMO_PHASE_MS) % 2;

      if (phase !== lastPhase) {
        info(phase ? 'Demo: MOVING (5s)' : 'Demo: REST (5s)');
        lastPhase = phase;
      }

      let ax, ay, az;

      if (phase === 0) {
        // REST: stay below 0.95 g so falling edge triggers
        ax = (Math.random() - 0.5) * 0.005;
        ay = (Math.random() - 0.5) * 0.005;
        az = 0.94 + (Math.random() - 0.5) * 0.01;
      } else {
        // MOVE: above 1.05 g so rising edge triggers
        const amp = 0.35;
        ax = Math.sin(t / 120) * amp + (Math.random() - 0.5) * 0.02;
        ay = Math.cos(t / 150) * amp + (Math.random() - 0.5) * 0.02;
        az = 1.05 + (Math.random() - 0.5) * 0.02;
      }

      handleAccSample({ ax, ay, az, time: t });
    }, 1000 / ACC_DEMO_RATE_HZ);

  } else {
    const url = (accApiUrl && accApiUrl.value) ? accApiUrl.value.trim() : DEFAULT_ACC_API;
    if (!url){
      info('ACC API URL empty - using Demo until a URL is provided.');
      if (accSource) accSource.value = 'demo';
      return startACC();
    }
    accTimer = setInterval(async ()=>{
      try{
        const res = await fetch(url, { cache:'no-store' });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const j = await res.json(); // { ax, ay, az, timestamp? }
        const t = j.timestamp ? toEpochMs(j.timestamp) : Date.now();
        handleAccSample({ ax: Number(j.ax), ay: Number(j.ay), az: Number(j.az), time: t });
      }catch(e){ console.warn('ACC API error:', e && e.message ? e.message : String(e)); }
    }, ACC_API_MS);
  }
}

function stopACC(){
  if (accTimer){ clearInterval(accTimer); accTimer = null; }
}

function handleAccSample(s){
  if (!s) return;
  if (![s.ax, s.ay, s.az].every(Number.isFinite)) return;

  const ts = s.time;
  const mag = Math.hypot(s.ax, s.ay, s.az);

  // Charts
  pushAccRaw(ts, s.ax, s.ay, s.az);
  pushAccMag(ts, mag);

  // Stats
  accCount++;
  updateAccStats(s.ax, s.ay, s.az, mag, ts);

  // Edge-triggered movement speech (accel)
  if (!autoSpeak || !autoSpeak.checked) return; // respect toggle

  const now = Date.now();
  const canSpeakEdge = (now - lastEdgeSpeakTs) >= SPEAK_EDGE_COOLDOWN &&
                       !window.speechSynthesis.speaking && !isSpeaking;

  // Hysteresis around MOVE_EDGE_G
  const rising  = !wasMoving && mag >= (MOVE_EDGE_G + MOVE_HYSTERESIS_G);
  const falling =  wasMoving && mag <= (MOVE_EDGE_G - MOVE_HYSTERESIS_G);

  if (rising) {
    wasMoving = true;
    if (canSpeakEdge) {
      speakMovementState('moving');
      lastEdgeSpeakTs = now;
    }
  } else if (falling) {
    wasMoving = false;
    if (canSpeakEdge) {
      speakMovementState('stopped');
      lastEdgeSpeakTs = now;
    }
  }
}

function updateAccStats(ax=null,ay=null,az=null,mag=null,ts=null){
  if (ax!=null && elAx) elAx.textContent = ax.toFixed(3);
  if (ay!=null && elAy) elAy.textContent = ay.toFixed(3);
  if (az!=null && elAz) elAz.textContent = az.toFixed(3);
  if (mag!=null && elAmag) elAmag.textContent = mag.toFixed(3);
  if (ts!=null && elAccTs) elAccTs.textContent = new Date(ts).toLocaleTimeString();
  if (elAccPts) elAccPts.textContent = accCount;
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
    const dy = (lon2-lon1) * 111_320 * Math.cos(((lat1+lat2)/2) * Math.PI/180);
    return Math.hypot(dx, dy);
  }
  const R = 6371e3, toRad = x => x*Math.PI/180;
  const dLat = toRad(lat2 - lat1), dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat/2)**2 + Math.cos(toRad(lat1))*Math.cos(toRad(lat2))*Math.sin(dLon/2)**2;
  return 2 * R * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

function toEpochMs(t){
  if (typeof t === 'number') return t;
  const d = new Date(t);
  const v = d.getTime();
  return Number.isFinite(v) ? v : Date.now();
}

/* ========= Theme + Toast ========= */
function toggleTheme(){
  document.documentElement.classList.toggle('light');
  localStorage.setItem('theme', document.documentElement.classList.contains('light') ? 'light' : 'dark');
  kickResize(); // fonts/layout change -> resize charts
}

let toastTimer = null;
function showToast(text){
  if (!toast) return;
  toast.textContent = text;
  toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove('show'), 2200);
}
function info(t){ showToast(t); }
function error(t){ showToast(t); console.warn(t); }
