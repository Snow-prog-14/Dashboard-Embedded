// ====== act7.js — hardcoded IP + toggle listening + RGB named colors ======
const API_BASE = 'http://192.168.1.48:5000';

const $  = s => document.querySelector(s);
const $$ = s => Array.from(document.querySelectorAll(s));

// ---- Elements (use whatever exists in your HTML) ----
const els = {
  apiDot: $('#apiDot'), apiText: $('#apiText'),
  micDot: $('#micDot'), recDot: $('#recDot'),
  micCanvas: $('#micCanvas'),
  log: $('#log'), txtCmd: $('#txtCmd'), btnSend: $('#btnSend'),
  btnListen: $('#btnStart'),  // reuse your existing Start button as a toggle
  lang: $('#lang'),
  btnSim: $('#btnSim'),
  tempC: $('#tempC'), hum: $('#hum'), dhtTs: $('#dhtTs'),
  rgbPicker: $('#rgbPicker')
};

// ---- State ----
const state = {
  simulate: false,
  lastStatus: null,
  lastHeardId: 0,
  lastActionId: 0,
  listening: false,
  startHeardId: 0,
  voice: { level: 0, raf: 0 }
};

// ---------- Named color table (RGB) ----------
const COLOR_MAP = {
  white:'#ffffff', warmwhite:'#fff4e5', 'warm white':'#fff4e5',
  coolwhite:'#f2ffff', 'cool white':'#f2ffff',
  red:'#ff0000', green:'#00ff00', blue:'#0000ff',
  yellow:'#ffff00', orange:'#ffa500', amber:'#ffbf00', gold:'#ffd700',
  pink:'#ff69b4', 'hot pink':'#ff69b4', hotpink:'#ff69b4', magenta:'#ff00ff',
  purple:'#800080', violet:'#8a2be2', indigo:'#4b0082',
  cyan:'#00ffff', teal:'#008080', aqua:'#00ffff', turquoise:'#40e0d0',
  lime:'#00ff00', mint:'#98ff98',
  lavender:'#e6e6fa', sky:'#87ceeb', skyblue:'#87ceeb', 'sky blue':'#87ceeb',
  peach:'#ffcba4'
};
const COLOR_KEYS = Object.keys(COLOR_MAP).sort((a,b)=>b.length-a.length); // longest first

// ---- UI helpers ----
function setApiHealth(ok){
  if (els.apiDot)  els.apiDot.className  = 'dot ' + (ok ? 'ok' : 'err');
  if (els.apiText) els.apiText.textContent = 'API: ' + (ok ? 'online' : 'offline');
}
function setMicActive(on){ if (els.micDot) els.micDot.className = 'dot ' + (on ? 'ok' : 'err'); }
function setRecActive(on){ if (els.recDot) els.recDot.className = 'dot ' + (on ? 'ok' : 'err'); }

function setListenButton(){
  if (!els.btnListen) return;
  if (state.listening) {
    els.btnListen.textContent = 'Done Speaking';
    els.btnListen.classList.add('is-active');
  } else {
    els.btnListen.textContent = 'Start Listening';
    els.btnListen.classList.remove('is-active');
  }
}

function appendLog(message, type){
  if (!type) {
    const m = String(message).toLowerCase();
    if (m.startsWith('heard:'))      type = 'heard';
    else if (m.startsWith('sent:'))  type = 'sent';
    else if (m.startsWith('typed:')) type = 'typed';
    else if (m.startsWith('command:')) type = 'info';
    else if (m.startsWith('failed:'))type = 'error';
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
    <span class="txt">${String(message).replace(/^\w+:\s*/,'')}</span>
  `;
  if (els.log) { els.log.appendChild(row); els.log.scrollTop = els.log.scrollHeight; }
  else { console.log('[act7]', message); }
}

function updateLedControls(name, value){
  const box = document.querySelector(`#led-${name}`);
  if (!box) return;
  box.querySelectorAll('button[data-act]').forEach(b => b.classList.remove('is-active'));
  if (['on','off','blink'].includes(value)){
    const btn = box.querySelector(`button[data-act="${value}"]`);
    if (btn) btn.classList.add('is-active');
  }
}

function renderStatus(data){
  if (!data) return;
  const { leds, dht } = data;
  $$('[data-k]').forEach(el => {
    const k = el.getAttribute('data-k');
    const v = leds?.[k] ?? 'off';
    el.textContent = `Status: ${v}`;
    updateLedControls(k, v);
  });
  if (dht) {
    if (els.tempC) els.tempC.textContent = (dht.temp_c ?? '--').toFixed ? dht.temp_c.toFixed(1) : dht.temp_c;
    if (els.hum)   els.hum.textContent   = (dht.hum ?? '--').toFixed ? dht.hum.toFixed(0) : dht.hum;
    if (els.dhtTs) els.dhtTs.textContent = dht.ts ? new Date(dht.ts).toLocaleTimeString() : '—';
  }
}

// ---- Server mic level drawing ----
function drawServerMic(){
  if (!els.micCanvas) return;
  const c = els.micCanvas.getContext('2d'); if (!c) return;
  const w = els.micCanvas.width  = els.micCanvas.clientWidth  || 240;
  const h = els.micCanvas.height = els.micCanvas.clientHeight || 48;
  c.clearRect(0,0,w,h);
  c.strokeStyle = 'rgba(0,0,0,0.4)';
  c.strokeRect(0,0,w,h);
  const v = Math.max(0, Math.min(1, Number(state.voice.level || 0)));
  c.fillStyle = 'rgba(96,165,250,0.35)';
  c.fillRect(0, 0, Math.floor(v*w), h);
  state.voice.raf = requestAnimationFrame(drawServerMic);
}

// ====== Networking ======
async function apiGET(path){
  if (state.simulate) return simGET(path);
  const url = API_BASE.replace(/\/$/, '') + path;
  const r = await fetch(url, { cache: 'no-store' });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return r.json();
}
async function apiPOST(path, body){
  if (state.simulate) return simPOST(path, body);
  const url = API_BASE.replace(/\/$/, '') + path;
  const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return r.json();
}

// ====== Simulation (optional) ======
const sim = { led: { red:'off', green:'off', blue:'off', rgb:'off' }, temp: 27.5, hum: 62, ts: Date.now() };
function simGET(path){
  if (path === '/api/status') return Promise.resolve({ leds: { ...sim.led }, dht: { temp_c: sim.temp, hum: sim.hum, ts: Date.now() } });
  if (path === '/api/dht')    return Promise.resolve({ temp_c: sim.temp, hum: sim.hum, ts: Date.now() });
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

// ====== Pollers ======
async function pollStatus(){
  try {
    const s = await apiGET('/api/status');
    setApiHealth(true);
    state.lastStatus = s;
    renderStatus(s);
  } catch (e) {
    setApiHealth(false);
    appendLog('API offline.');
  }

  try {
    const vs = await apiGET('/api/voice/status');
    const running = !!vs.running;
    setMicActive(running);
    setRecActive(running);
    if (typeof vs.level === 'number') state.voice.level = vs.level;

    if (Array.isArray(vs.transcript)) {
      for (const item of vs.transcript) {
        if (item && typeof item.id === 'number' && item.id > state.lastHeardId && item.text && item.text.trim()) {
          appendLog('Heard: ' + item.text.trim(), 'heard');
          state.lastHeardId = Math.max(state.lastHeardId, item.id);
        }
      }
    }
    if (Array.isArray(vs.actions)) {
      for (const a of vs.actions) {
        if (a && typeof a.id === 'number' && a.id > state.lastActionId && a.cmd) {
          appendLog('Sent: ' + JSON.stringify(a.cmd), 'sent');
          state.lastActionId = Math.max(state.lastActionId, a.id);
        }
      }
    }
    if (vs.error && !window.__voiceErrShown) { appendLog('Voice error: ' + vs.error); window.__voiceErrShown = true; }
  } catch {
    // ignore
  }

  setTimeout(pollStatus, 1000);
}

// ====== LED command ======
async function sendLedCommand(cmd){
  try {
    const res = await apiPOST('/api/leds', cmd);
    appendLog('Sent: ' + JSON.stringify(cmd), 'sent');
    if (cmd.target !== 'rgb' && (cmd.action === 'on' || cmd.action === 'off' || cmd.action === 'blink')) {
      updateLedControls(cmd.target, cmd.action);
    }
    if (res?.leds) renderStatus({ leds: res.leds, dht: state.lastStatus?.dht });
  } catch (e) {
    appendLog('Failed: ' + e.message);
  }
}

// ====== Helpers for parsing ======
function hexFromRGBTriplet(text){
  const m = text.match(/(\d{1,3})\s+(\d{1,3})\s+(\d{1,3})/);
  if (!m) return null;
  const toHex = n => ('0' + Math.max(0, Math.min(255, +n)).toString(16)).slice(-2);
  return '#' + toHex(m[1]) + toHex(m[2]) + toHex(m[3]);
}
function findNamedColor(text){
  const t = ' ' + text + ' ';
  for (const key of COLOR_KEYS){
    const re = new RegExp(`(^|\\W)${key.replace(/\s+/g,'\\s+')}($|\\W)`, 'i');
    if (re.test(t)) return { name: key, hex: COLOR_MAP[key] };
  }
  return null;
}
function normalizeLedWords(s){
  return s
    .toLowerCase()
    .replace(/\bl[\W_]*e[\W_]*d(s)?\b/g, 'led') // "l e d" / "l-e-d" → "led"
    .replace(/\bread led\b/g, 'red led');       // mishear
}

// ====== Command parser (LED vs RGB separated) ======
function parseCommand(input){
  let text = normalizeLedWords(input || '');

  // action words
  const onP    = /(turn\s*on|switch\s*on|buksan|buksan\s*ang)/;
  const offP   = /(turn\s*off|switch\s*off|patayin|patayin\s*ang|ihinto)/;
  const blinkP = /(blink|blinking|flash|kislap|pakikislap|pa\s*kislap)/;

  // targets
  const hasRGB   = /\brgb\b|\bcolor\b/.test(text);
  const hasLED   = /\bled(s)?\b/.test(text);

  // single LED color words
  const redP   = /\bred\b|pula/;
  const greenP = /\bgreen\b|berde|\bgren\b|\bgrin\b/;
  const blueP  = /\bblue\b|asul|\bblew\b/;

  // explicit hex or numeric triplet
  const hexMatch  = text.match(/#([0-9a-fA-F]{6})/);
  const rgbTrip   = hexFromRGBTriplet(text);
  const named     = findNamedColor(text);

  const cmds = [];
  const push = (target, action, value) => cmds.push(Object.assign({ target, action }, value ? { value } : {}));

  // 1) RGB color by explicit hex / triplet / named color when RGB is mentioned OR when no "led" is mentioned
  if (hexMatch) {
    push('rgb', 'color', '#' + hexMatch[1].toLowerCase());
  } else if (rgbTrip) {
    push('rgb', 'color', rgbTrip);
  } else if (named) {
    // If "led" explicitly mentioned AND the named color is one of primary colors, handle LED by action words.
    const primary = /^(red|green|blue)$/i.test(named.name);
    if (hasRGB || (!hasLED && !onP.test(text) && !offP.test(text) && !blinkP.test(text))) {
      // clear color command for RGB when "rgb" mentioned or no LED target present
      push('rgb', 'color', named.hex);
    } else if (!hasRGB && primary && (onP.test(text) || offP.test(text) || blinkP.test(text))) {
      // treat as single LED control if explicitly talking about LED or using action with a primary color
      if (onP.test(text))   push(named.name.replace(' ', ''), 'on');
      if (offP.test(text))  push(named.name.replace(' ', ''), 'off');
      if (blinkP.test(text))push(named.name.replace(' ', ''), 'blink');
    } else if (!hasRGB && !hasLED) {
      // bare color name -> assume RGB color
      push('rgb', 'color', named.hex);
    }
  }

  // 2) RGB on/off/blink
  if (hasRGB) {
    if (onP.test(text))   push('rgb', 'on');
    if (offP.test(text))  push('rgb', 'off');
    if (blinkP.test(text))push('rgb', 'blink');
  }

  // 3) Single LED on/off/blink (explicit LED or color+action without RGB)
  if ((hasLED || !hasRGB) && (onP.test(text) || offP.test(text) || blinkP.test(text))) {
    const wantOn = onP.test(text), wantOff = offP.test(text), wantBlink = blinkP.test(text);
    if (redP.test(text))   { if (wantOn) push('red','on'); if (wantOff) push('red','off'); if (wantBlink) push('red','blink'); }
    if (greenP.test(text)) { if (wantOn) push('green','on'); if (wantOff) push('green','off'); if (wantBlink) push('green','blink'); }
    if (blueP.test(text))  { if (wantOn) push('blue','on'); if (wantOff) push('blue','off'); if (wantBlink) push('blue','blink'); }
  }

  // 4) DHT intents
  if (/temperature|temp|lamig|gaano\s*ka\s*init/.test(text)){
    apiGET('/api/dht')
      .then(d => renderStatus({ leds: state.lastStatus?.leds || {}, dht: { temp_c: d.temperature_c, hum: d.humidity_percent, ts: (d.ts ? d.ts*1000 : Date.now()) } }))
      .catch(()=>{});
  }

  return cmds;
}

// ====== Toggle Listening logic ======
async function startListening(){
  const lang = (els.lang && els.lang.value) ? els.lang.value : 'en';
  state.startHeardId = state.lastHeardId;           // snapshot before start
  await apiPOST('/api/voice/start', { lang });
  state.listening = true;
  setListenButton();
  setRecActive(true); setMicActive(true);
  appendLog('Server mic listening…');
}

async function stopListeningAndFinalize(){
  await apiPOST('/api/voice/stop', {});
  state.listening = false;
  setListenButton();
  setRecActive(false); setMicActive(false);
  appendLog('Server mic stopped.');

  // Fetch transcript since we started; choose the last non-empty text
  let cmdText = '';
  try {
    const r = await apiGET('/api/voice/transcript?since=' + (state.startHeardId || 0));
    if (Array.isArray(r.items) && r.items.length > 0) {
      for (let i = r.items.length - 1; i >= 0; i--) {
        const t = (r.items[i].text || '').trim();
        if (t) { cmdText = t; break; }
      }
    }
  } catch (e) {
    appendLog('Failed: transcript fetch: ' + e.message);
  }

  if (!cmdText) {
    appendLog('Command: (none heard)');
    return;
  }

  appendLog('Command: ' + cmdText, 'info');
  if (els.txtCmd) { els.txtCmd.value = cmdText; els.txtCmd.focus(); }

  // Parse and auto-send if valid
  const actions = parseCommand(cmdText);
  if (actions.length === 0) {
    appendLog('No intent recognized.');
  } else {
    actions.forEach(sendLedCommand);
  }
}

// ====== Wire UI ======
function wireUI(){
  if (els.btnSim) els.btnSim.addEventListener('click', ()=>{
    state.simulate = !state.simulate;
    els.btnSim.textContent = 'Simulation: ' + (state.simulate ? 'On' : 'Off');
    appendLog('Simulation is ' + (state.simulate ? 'ON' : 'OFF'));
  });

  if (els.btnListen) {
    setListenButton();
    els.btnListen.addEventListener('click', async ()=>{
      try {
        if (!state.listening) await startListening();
        else await stopListeningAndFinalize();
      } catch (e) {
        appendLog('Failed: ' + e.message);
        state.listening = false;
        setListenButton();
      }
    });
  }

  if (els.btnSend) els.btnSend.addEventListener('click', ()=>{
    const t = (els.txtCmd?.value || '').trim();
    if (!t){ if (els.txtCmd){ els.txtCmd.value=''; els.txtCmd.focus(); } return; }
    appendLog('Typed: ' + t, 'typed');
    const actions = parseCommand(t);
    if (actions.length === 0) appendLog('No intent recognized.');
    else actions.forEach(sendLedCommand);
    if (els.txtCmd){ els.txtCmd.value=''; els.txtCmd.focus(); }
  });

  if (els.txtCmd) els.txtCmd.addEventListener('keydown', e=>{
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); els.btnSend?.click(); }
  });

  $$('.led .btn, .card [data-target="rgb"]').forEach(btn=>{
    btn.addEventListener('click', ()=>{
      const action = btn.getAttribute('data-act');
      const target = btn.getAttribute('data-target');
      const body = { action, target };
      if (action === 'color' && target === 'rgb') body.value = els.rgbPicker?.value;
      sendLedCommand(body);
    });
  });
}

// ====== Boot ======
(function boot(){
  appendLog('Using API: ' + API_BASE);
  setApiHealth(false); setMicActive(false); setRecActive(false);
  wireUI();
  drawServerMic();
  pollStatus();
})();
