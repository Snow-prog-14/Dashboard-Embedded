// ====== Minimal frontend app (no frameworks) ======
const $  = s => document.querySelector(s);
const $$ = s => Array.from(document.querySelectorAll(s));

// ---- Elements ----
const els = {
  apiDot: $('#apiDot'), apiText: $('#apiText'), apiPill: $('#apiPill'),
  micDot: $('#micDot'), recDot: $('#recDot'),
  micCanvas: $('#micCanvas'),
  log: $('#log'), txtCmd: $('#txtCmd'), btnSend: $('#btnSend'),
  btnStart: $('#btnStart'), btnStop: $('#btnStop'),
  lang: $('#lang'), apiBase: $('#apiBase'), btnSaveApi: $('#btnSaveApi'),
  btnSim: $('#btnSim'),
  tempC: $('#tempC'), hum: $('#hum'), dhtTs: $('#dhtTs'),
  rgbPicker: $('#rgbPicker')
};

// ---- Config & state ----
const state = {
  apiBase: localStorage.getItem('apiBase') || 'http://raspi.local:5000',
  simulate: false,
  lastStatus: null,
  // speech
  rec: null, recActive: false, recShouldRun: false,
  // audio viz
  audio: { ctx: null, analyser: null, raf: 0 },
};
els.apiBase.value = state.apiBase;

// ---- UI helpers ----
function setApiHealth(ok){
  els.apiDot.className = 'dot ' + (ok ? 'ok' : 'err');
  els.apiText.textContent = 'API: ' + (ok ? 'online' : 'offline');
}
function setMicActive(on){ els.micDot.className = 'dot ' + (on ? 'ok' : 'err'); }
function setRecActive(on){ els.recDot.className = 'dot ' + (on ? 'ok' : 'err'); }

function appendLog(message, type){
  // infer type if not provided
  if (!type) {
    const m = message.toLowerCase();
    if (m.startsWith('heard:'))   type = 'heard';
    else if (m.startsWith('sent:'))    type = 'sent';
    else if (m.startsWith('typed:'))   type = 'typed';
    else if (m.startsWith('failed:'))  type = 'error';
    else type = 'info';
  }

  const row = document.createElement('div');
  row.className = `entry ${type}`;
  const t = new Date().toLocaleTimeString();
  const label = type === 'heard' ? 'Heard'
              : type === 'sent'  ? 'Sent'
              : type === 'typed' ? 'Typed'
              : type === 'error' ? 'Error'
              : 'Info';

  row.innerHTML = `
    <span class="time">${t}</span>
    <span class="tag">${label}</span>
    <span class="txt">${message.replace(/^\\w+:\\s*/,'')}</span>
  `;
  els.log.appendChild(row);
  els.log.scrollTop = els.log.scrollHeight;
}


// highlight helper for Red/Green/Blue button groups
function updateLedControls(name, value){
  const box = document.querySelector(`#led-${name}`);
  if (!box) return;
  box.querySelectorAll('button[data-act]').forEach(b => b.classList.remove('is-active'));
  const act = (value === 'on' || value === 'off' || value === 'blink') ? value : null;
  if (act){
    const btn = box.querySelector(`button[data-act="${act}"]`);
    if (btn) btn.classList.add('is-active');
  }
}

function renderStatus(data){
  if (!data) return;
  const { leds, dht } = data;

  // Single-color LEDs
  $$('[data-k]').forEach(el => {
    const k = el.getAttribute('data-k');
    const v = leds?.[k] ?? 'off';
    el.textContent = `Status: ${v}`;
    updateLedControls(k, v);
  });

  // DHT readout
  if (dht) {
    els.tempC.textContent = (dht.temp_c ?? '--').toFixed ? dht.temp_c.toFixed(1) : dht.temp_c;
    els.hum.textContent   = (dht.hum ?? '--').toFixed ? dht.hum.toFixed(0) : dht.hum;
    els.dhtTs.textContent = dht.ts ? new Date(dht.ts).toLocaleTimeString() : '—';
  }
}

// ====== Networking helpers ======
async function apiGET(path){
  if (state.simulate) return simGET(path);
  const url = state.apiBase.replace(/\/$/, '') + path;
  const r = await fetch(url, { cache: 'no-store' });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return r.json();
}
async function apiPOST(path, body){
  if (state.simulate) return simPOST(path, body);
  const url = state.apiBase.replace(/\/$/, '') + path;
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return r.json();
}

// ====== Simulation layer (no backend) ======
const sim = { led: { red:'off', green:'off', blue:'off', rgb:'off' }, temp: 27.5, hum: 62, ts: Date.now() };

function simGET(path){
  if (path === '/api/status') {
    return Promise.resolve({
      leds: { ...sim.led },
      dht: { temp_c: sim.temp + Math.sin(Date.now()/50000), hum: sim.hum + Math.sin(Date.now()/40000), ts: Date.now() }
    });
  }
  if (path === '/api/dht') {
    return Promise.resolve({ temp_c: sim.temp, hum: sim.hum, ts: Date.now() });
  }
  return Promise.reject(new Error('simGET: unknown ' + path));
}

function simPOST(path, body){
  if (path === '/api/leds') {
    const { action, target, value } = body;
    if (action === 'color' && target === 'rgb')      sim.led.rgb = value || 'on';
    else if (action === 'blink')                     sim.led[target] = 'blink';
    else if (action === 'on')                        sim.led[target] = 'on';
    else if (action === 'off')                       sim.led[target] = 'off';
    return Promise.resolve({ ok: true, leds: { ...sim.led } });
  }
  return Promise.reject(new Error('simPOST: unknown ' + path));
}

// ====== Poll status ======
async function pollStatus(){
  try {
    const s = await apiGET('/api/status');
    setApiHealth(true);
    state.lastStatus = s;
    renderStatus(s);
  } catch (e) {
    setApiHealth(false);
    if (!state.simulate) appendLog('API offline — switch to Simulation if needed.');
  } finally {
    setTimeout(pollStatus, 2000);
  }
}

// ====== Command sending ======
async function sendLedCommand(cmd){
  try {
    const res = await apiPOST('/api/leds', cmd);
    appendLog('Sent: ' + JSON.stringify(cmd));

    // instant highlight for single-color LEDs
    if (cmd.target !== 'rgb' && (cmd.action === 'on' || cmd.action === 'off' || cmd.action === 'blink')) {
      updateLedControls(cmd.target, cmd.action);
    }

    if (res?.leds) renderStatus({ leds: res.leds, dht: state.lastStatus?.dht });
  } catch (e) {
    appendLog('Failed: ' + e.message);
  }
}

// ====== Speech recognition ======
function supportsSpeech(){
  return 'webkitSpeechRecognition' in window || 'SpeechRecognition' in window;
}

function startRecognition(){
  if (!supportsSpeech()) { appendLog('SpeechRecognition not supported in this browser.'); return; }
  // guard against double instances & prepare flags
  stopRecognition(true);

  const Rec = window.SpeechRecognition || window.webkitSpeechRecognition;
  const rec = new Rec();
  state.rec = rec;
  state.recShouldRun = true;
  state.recActive = true; setRecActive(true);

  rec.lang = els.lang.value;
  rec.continuous = true; rec.interimResults = true; rec.maxAlternatives = 1;

  rec.onresult = (ev)=>{
    let finalTxt = '';
    for (let i = ev.resultIndex; i < ev.results.length; i++) {
      const t = ev.results[i][0].transcript.trim();
      if (ev.results[i].isFinal) finalTxt += ' ' + t;
    }
    if (finalTxt) {
      finalTxt = finalTxt.trim();
      appendLog('Heard: ' + finalTxt);
      const actions = parseCommand(finalTxt.toLowerCase(), rec.lang);
      if (actions.length === 0) { appendLog('No intent recognized.'); return; }
      for (const a of actions) sendLedCommand(a);
    }
  };
  rec.onerror = (e)=> appendLog('Recognizer error: ' + e.error);
  rec.onend   = ()=> {
    if (state.recShouldRun) { try { rec.start(); } catch {} }
    else { state.recActive = false; setRecActive(false); }
  };

  try { rec.start(); } catch (e) { appendLog('Recognizer start error: ' + e.message); }
}

function stopRecognition(silent=false){
  state.recShouldRun = false;
  if (state.rec){
    try {
      state.rec.onresult = null;
      state.rec.onerror  = null;
      state.rec.onend    = null;
      state.rec.stop();
    } catch {}
    state.rec = null;
  }
  state.recActive = false;
  if (!silent) setRecActive(false);
}

// ====== Command parser (EN + Tagalog basics) ======
function parseCommand(text, lang){
  const cmds   = [];
  const onP    = /(turn\s*on|switch\s*on|buksan|buksan\s*ang)/;
  const offP   = /(turn\s*off|switch\s*off|patayin|patayin\s*ang|ihinto)/;
  const blinkP = /(blink|blinking|flash|kislap|pakikislap|pa\s*kislap)/;

  const redP   = /(red|pula)/;
  const greenP = /(green|berde)/;
  const blueP  = /(blue|asul)/;
  const rgbP   = /(rgb|color|kulay)/;

  const hex     = text.match(/#([0-9a-fA-F]{6})/);
  const rgbTrip = text.match(/(\d{1,3})\s+(\d{1,3})\s+(\d{1,3})/);

  function push(target, action, value){ cmds.push({ target, action, ...(value ? { value } : {}) }); }

  if (onP.test(text)) {
    if (redP.test(text))   push('red','on');
    if (greenP.test(text)) push('green','on');
    if (blueP.test(text))  push('blue','on');
    if (rgbP.test(text))   push('rgb','on');
  }
  if (offP.test(text)) {
    if (redP.test(text))   push('red','off');
    if (greenP.test(text)) push('green','off');
    if (blueP.test(text))  push('blue','off');
    if (rgbP.test(text))   push('rgb','off');
  }
  if (blinkP.test(text)) {
    if (redP.test(text))   push('red','blink');
    if (greenP.test(text)) push('green','blink');
    if (blueP.test(text))  push('blue','blink');
    if (rgbP.test(text))   push('rgb','blink');
  }

  // Color set
  if (hex) {
    push('rgb','color','#' + hex[1].toLowerCase());
  } else if (rgbP.test(text) && rgbTrip) {
    const [, r, g, b] = rgbTrip;
    const toHex = n => ('0' + (+n).toString(16)).slice(-2);
    push('rgb','color','#' + toHex(r) + toHex(g) + toHex(b));
  }

  // DHT intents
  if (/temperature|temp|lamig|gaano\s*ka\s*init/.test(text)) {
    apiGET('/api/dht')
      .then(d => renderStatus({ leds: state.lastStatus?.leds || {}, dht: d }))
      .catch(()=>{});
  }

  return cmds;
}

// ====== Mic level visualization ======
async function initMic(){
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const src = ctx.createMediaStreamSource(stream);
    const analyser = ctx.createAnalyser(); analyser.fftSize = 2048;
    src.connect(analyser);
    state.audio.ctx = ctx; state.audio.analyser = analyser; setMicActive(true);
    drawMic();
  } catch (e) {
    setMicActive(false); appendLog('Mic error: ' + e.message);
  }
}

function drawMic(){
  const a = state.audio.analyser; if (!a) return;
  const canvas = els.micCanvas; const c = canvas.getContext('2d');
  const w = canvas.width  = canvas.clientWidth;
  const h = canvas.height = canvas.clientHeight;
  const data = new Uint8Array(a.frequencyBinCount);

  a.getByteTimeDomainData(data);
  c.clearRect(0,0,w,h);
  c.beginPath(); c.lineWidth = 2; c.moveTo(0, h/2);
  for (let x = 0; x < w; x++) {
    const i = Math.floor(x / w * data.length);
    const v = (data[i] - 128) / 128;
    const y = h/2 + v * (h * 0.45);
    c.lineTo(x, y);
  }
  c.stroke();

  // simple RMS level bar
  let rms = 0; for (let i=0;i<data.length;i++){ const v=(data[i]-128)/128; rms += v*v; }
  rms = Math.sqrt(rms / data.length);
  c.fillStyle = 'rgba(96,165,250,0.3)';
  c.fillRect(0, h-8, Math.min(w, rms*w*2), 8);

  state.audio.raf = requestAnimationFrame(drawMic);
}

// ====== Wire UI ======
els.btnSaveApi.addEventListener('click', ()=>{
  state.apiBase = els.apiBase.value.trim();
  localStorage.setItem('apiBase', state.apiBase);
  appendLog('Set API base: ' + state.apiBase);
  pollStatus();
});

els.btnSim.addEventListener('click', ()=>{
  state.simulate = !state.simulate;
  els.btnSim.textContent = 'Simulation: ' + (state.simulate ? 'On' : 'Off');
  appendLog('Simulation is ' + (state.simulate ? 'ON' : 'OFF'));
});

els.btnStart.addEventListener('click', startRecognition);
els.btnStop .addEventListener('click', ()=> stopRecognition(false));

els.btnSend.addEventListener('click', ()=>{
  const t = els.txtCmd.value.trim();
  if (!t) return;
  appendLog('Typed: ' + t);
  const actions = parseCommand(t.toLowerCase(), els.lang.value);
  if (actions.length === 0) { appendLog('No intent recognized.'); return; }
  for (const a of actions) sendLedCommand(a);
});

// LED buttons
$$('.led .btn, .card [data-target="rgb"]').forEach(btn=>{
  btn.addEventListener('click', ()=>{
    const action = btn.getAttribute('data-act');
    const target = btn.getAttribute('data-target');
    const body = { action, target };
    if (action === 'color' && target === 'rgb') body.value = els.rgbPicker.value;
    sendLedCommand(body);
  });
});

// ====== Boot ======
(function boot(){
  setApiHealth(false); setMicActive(false); setRecActive(false);
  initMic();
  pollStatus();
  appendLog('Ready. Choose a language and press Start Listening.');
})();
