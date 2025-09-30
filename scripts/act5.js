// ============ Config ============
const CONFIG = {
  DEMO: false,
  TICK_MS: 1000,
  WINDOW_POINTS: 180,

  // Sound render range (for gauge + y-axis)
  SOUND_MIN: 0,
  SOUND_MAX: 120,
  SOUND_UNIT: "dB",

  // Rain
  RAIN_THRESHOLD: 0.30,
  RAIN_BINARY: true,         // 1 = dry, 0 = raining (digital raindrop sensors)

  // Environment gates (defaults; UI can change them live)
  HUM_MIN: 78,               // %
  TEMP_MAX: 35,              // °C
  USE_RAIN_BG: true,

  ENDPOINTS: {
    sound: "http://192.168.1.48:5000/api/sound",
    rain:  "http://192.168.1.48:5000/api/rain",
    env:   "http://192.168.1.48:5000/api/dht"
  }
};

const $  = (q) => document.querySelector(q);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const fmtTime = (ts) => new Date(ts).toLocaleTimeString();

// Ensure the rain overlay exists even if omitted in HTML
(function ensureRainFx(){
  let el = document.getElementById("rainFx");
  if (!el) {
    el = document.createElement("div");
    el.id = "rainFx";
    el.setAttribute("aria-hidden","true");
    document.body.appendChild(el);
  }
})();

// --- Canvas-based raindrop animation ---------------------------------------
class RainFX {
  constructor(container){
    this.container = container;
    this.canvas = document.createElement("canvas");
    this.ctx = this.canvas.getContext("2d");
    this.container.appendChild(this.canvas);

    this.active = false;
    this.raf = null;
    this.drops = [];
    this.splashes = [];
    this.last = performance.now();

    this.resize = this.resize.bind(this);
    window.addEventListener("resize", this.resize, { passive:true });
    this.resize();

    this.populate();
  }

  resize(){
    const dpr = Math.max(1, window.devicePixelRatio || 1);
    const { clientWidth:w, clientHeight:h } = this.container;
    this.canvas.width  = Math.floor(w * dpr);
    this.canvas.height = Math.floor(h * dpr);
    this.canvas.style.width  = w + "px";
    this.canvas.style.height = h + "px";
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  populate(){
    const w = this.canvas.width, h = this.canvas.height;
    const n = Math.floor(Math.min(220, (w*h)/(1400*900) * 220)); // scale with screen
    this.drops.length = 0;
    for(let i=0;i<n;i++){
      this.drops.push(this.makeDrop(true));
    }
  }

  makeDrop(randomY=false){
    const w = this.canvas.width / (window.devicePixelRatio || 1);
    const h = this.canvas.height / (window.devicePixelRatio || 1);
    const x = Math.random()*w;
    const y = randomY ? Math.random()*h : -10 - Math.random()*h*0.3;
    const len = 8 + Math.random()*14;
    const speed = 350 + Math.random()*550;  // px/s
    const thick = Math.random()<0.85 ? 1 : 1.5;
    return {x,y,len,speed,thick};
  }

  addSplash(x, y){
    // 3–4 quick outward ripples
    const n = 3 + (Math.random()*2|0);
    for(let i=0;i<n;i++){
      this.splashes.push({
        x, y,
        r: 0,
        rv: 40 + Math.random()*60, // px/s
        alpha: 0.6,
        av: 1.6 + Math.random()*1.0 // fade/s
      });
    }
  }

  start(){
    if (this.raf) return;
    this.active = true;
    this.last = performance.now();
    const loop = (now) => {
      this.raf = requestAnimationFrame(loop);
      const dt = Math.min(0.05, (now - this.last) / 1000); // clamp 50ms
      this.last = now;
      this.step(dt);
      this.draw();
    };
    this.raf = requestAnimationFrame(loop);
  }

  stop(){
    this.active = false;
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = null;
    this.clear();
  }

  setActive(on){
    if (on) this.start(); else this.stop();
  }

  step(dt){
    const w = this.canvas.width / (window.devicePixelRatio || 1);
    const h = this.canvas.height / (window.devicePixelRatio || 1);

    // move drops
    for (let i=0;i<this.drops.length;i++){
      const d = this.drops[i];
      d.y += d.speed * dt;
      d.x += dt * 50; // slight diagonal drift
      if (d.y > h - 2){
        this.addSplash(d.x, h-2);
        this.drops[i] = this.makeDrop(false);
      } else if (d.x > w + 20){
        d.x -= w + 40; // wrap
      }
    }

    // update splashes
    this.splashes = this.splashes.filter(s=>{
      s.r += s.rv * dt;
      s.alpha -= s.av * dt;
      return s.alpha > 0;
    });
  }

  draw(){
    const ctx = this.ctx;
    const w = this.canvas.width / (window.devicePixelRatio || 1);
    const h = this.canvas.height / (window.devicePixelRatio || 1);
    ctx.clearRect(0,0,w,h);

    // drops
    ctx.strokeStyle = "rgba(180,200,255,0.55)";
    for (const d of this.drops){
      ctx.lineWidth = d.thick;
      ctx.beginPath();
      ctx.moveTo(d.x, d.y);
      ctx.lineTo(d.x - d.len*0.25, d.y - d.len);
      ctx.stroke();
    }

    // splashes
    ctx.strokeStyle = "rgba(200,220,255,0.35)";
    for (const s of this.splashes){
      ctx.lineWidth = 1;
      ctx.globalAlpha = Math.max(0, s.alpha);
      ctx.beginPath();
      ctx.arc(s.x, s.y, s.r, 0, Math.PI*2);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }

  clear(){
    const ctx = this.ctx;
    const w = this.canvas.width / (window.devicePixelRatio || 1);
    const h = this.canvas.height / (window.devicePixelRatio || 1);
    ctx.clearRect(0,0,w,h);
    this.splashes.length = 0;
  }
}

// create the instance
const rainFX = new RainFX(document.getElementById("rainFx"));


// ------- Toasts -------
const toasts = $("#toasts");
function toast(msg, type=""){ const el=document.createElement("div"); el.className=`toast ${type}`; el.textContent=msg; toasts.appendChild(el); setTimeout(()=>el.remove(),3200); }

// ------- Charts -------
Chart.defaults.responsive = true;
Chart.defaults.maintainAspectRatio = false;

const soundGauge = new Chart($("#soundGauge"), {
  type: "doughnut",
  data: { labels: ["Now","Rest"], datasets: [{ data:[0, CONFIG.SOUND_MAX], backgroundColor:["#6ea8fe","rgba(255,255,255,.08)"], borderWidth:0, cutout:"70%" }] },
  options: { animation:false, plugins:{ legend:{display:false}, tooltip:{enabled:false} } }
});

const soundLine = new Chart($("#soundLine"), {
  type: "line",
  data: {
    labels: [],
    datasets: [{
      label:`Sound (${CONFIG.SOUND_UNIT})`,
      data: [],
      borderColor: "#6ea8fe",                // explicit color so it’s visible
      backgroundColor: "rgba(110,168,254,.10)",
      fill: false,
      tension: 0.15,
      pointRadius: 0,
      borderWidth: 2,
      spanGaps: false
    }]
  },
  options: {
    animation:false,
    scales: {
      x: { ticks: { autoSkip: true, maxTicksLimit: 8 }, grid: { color: "#202838" } },
      y: { min: CONFIG.SOUND_MIN, max: CONFIG.SOUND_MAX, ticks: { stepSize: 10 }, grid: { color: "#202838" } }
    },
    plugins: { legend: { display: true } }
  }
});

const rainLine = new Chart($("#rainLine"), {
  type: "line",
  data: { labels: [], datasets: [{ label: CONFIG.RAIN_BINARY ? "Rain (1=dry, 0=rain)" : "Rain Intensity (0–1)", data: [], tension:.25, pointRadius:0, borderWidth:2 }] },
  options: { animation:false, scales:{ x:{ ticks:{autoSkip:true,maxTicksLimit:7}, grid:{color:"#202838"} }, y:{ min:0, max:1, grid:{color:"#202838"} } } }
});

const envLine = new Chart($("#envLine"), {
  type: "line",
  data: { labels: [], datasets: [
    { label:"Temperature (°C)", data: [], tension:.25, pointRadius:2, borderWidth:2 },
    { label:"Humidity (%)",     data: [], tension:.25, pointRadius:2, borderWidth:2 }
  ]},
  options: { animation:false, scales:{ x:{ ticks:{autoSkip:true,maxTicksLimit:8}, grid:{color:"#202838"} }, y:{ grid:{color:"#202838"} } } }
});

// ------- Elements -------
const lastUpdate = $("#lastUpdate");
const runDot      = $("#runDot");
const btnToggle   = $("#btnToggle");
const demoToggle  = $("#demoToggle");
const btnRainDemo = $("#btnRainDemo");
const rateSel     = $("#rate");
const thSound     = $("#thSound");
const thRain      = $("#thRain");
const thHum       = $("#thHum");
const thTemp      = $("#thTemp");
const reads = {
  rainThreshRead: $("#rainThreshRead"),
  humGateRead:    $("#humGateRead"),
  tempGateRead:   $("#tempGateRead")
};

const kSound=$("#kSound"), kSoundUnit=$("#kSoundUnit"), kSoundState=$("#kSoundState");
const kRain=$("#kRain"), kTemp=$("#kTemp"), kHum=$("#kHum");
const soundNowEl=$("#soundNow"), soundUnitEl=$("#soundUnit"), soundUnitLabel=$("#soundUnitLabel");
const rainBadge=$("#rainBadge"), rainStatusIcon=$("#rainStatusIcon"), rainStatusText=$("#rainStatusText");
const kTempPeak=$("#kTempPeak"), kHumPeak=$("#kHumPeak");

kSoundUnit.textContent = " " + CONFIG.SOUND_UNIT;
soundUnitEl.textContent = " " + CONFIG.SOUND_UNIT;
soundUnitLabel.textContent = CONFIG.SOUND_UNIT;
reads.rainThreshRead.textContent = CONFIG.RAIN_THRESHOLD.toFixed(2);
reads.humGateRead.textContent    = CONFIG.HUM_MIN.toFixed(0);
reads.tempGateRead.textContent   = CONFIG.TEMP_MAX.toFixed(0);

// ------- Helpers -------
function pushPoint(chart, label, value){
  const v = Number(value);
  if (!Number.isFinite(v)) return;
  const labels = chart.data.labels;
  const data   = chart.data.datasets[0].data;
  if (labels.length >= CONFIG.WINDOW_POINTS) { labels.shift(); data.shift(); }
  labels.push(label);
  data.push(v);
  chart.update("none");
}
function pushEnvPoint(label, t, h){
  if (!Number.isFinite(t) || !Number.isFinite(h)) return;
  const labels = envLine.data.labels;
  const tData  = envLine.data.datasets[0].data;
  const hData  = envLine.data.datasets[1].data;
  if (labels.length >= CONFIG.WINDOW_POINTS) { labels.shift(); tData.shift(); hData.shift(); }
  labels.push(label); tData.push(t); hData.push(h);
  envLine.update("none");
  const tPeak = Math.max(...tData), hPeak = Math.max(...hData);
  if (Number.isFinite(tPeak)) kTempPeak.textContent = tPeak.toFixed(1);
  if (Number.isFinite(hPeak)) kHumPeak.textContent  = Math.round(hPeak);
}
function updateGauge(v){
  const val = clamp(Number(v), CONFIG.SOUND_MIN, CONFIG.SOUND_MAX);
  soundGauge.data.datasets[0].data[0] = val;
  soundGauge.data.datasets[0].data[1] = CONFIG.SOUND_MAX - val;
  soundGauge.update("none");
  soundNowEl.textContent = Math.round(val);
}

// -------- Robust parsing (fix for empty sound history) --------
let warnedSound = false;
function parseSound(obj){
  // Accept common keys; strings or numbers; normalize ranges.
  const raw = obj == null ? NaN : Number(
    obj.db ?? obj.dB ?? obj.decibel ??
    obj.sound ?? obj.value ?? obj.level ?? obj.now
  );
  if (!Number.isFinite(raw)) return NaN;
  if (raw >= 0 && raw <= 1.0001)  return raw * CONFIG.SOUND_MAX;           // 0..1 → dB-range
  if (raw > 1 && raw <= 1023)     return (raw / 1023) * CONFIG.SOUND_MAX;  // ADC → dB-range
  return raw; // already dB-like
}
function parseRain(obj){
  const v = Number(obj?.intensity ?? obj?.value ?? obj?.level ?? obj?.rain ?? NaN);
  if (!Number.isFinite(v)) return NaN;
  if (v > 1.001 && v <= 1023) return v / 1023; // normalize ADC
  return v;
}
function parseEnv(obj){
  const t = Number(obj?.temp ?? obj?.temperature ?? NaN);
  const h = Number(obj?.hum  ?? obj?.humidity    ?? NaN);
  return { t, h };
}

// ------- Data I/O -------
async function fetchJson(url){
  const r = await fetch(url, {cache:"no-store"});
  if(!r.ok) throw new Error(`HTTP ${r.status} on ${url}`);
  return r.json();
}
const demo = {
  phase:0, sound: 36, rain:1, temp:30, hum:70,
  step(){
    this.phase += 0.25;
    this.sound = clamp(this.sound + (Math.random()*6-3) + 4*Math.sin(this.phase/3), 20, 95);
    this.rain  = CONFIG.RAIN_BINARY
      ? (Math.random()<0.04 ? (this.rain===1?0:1) : this.rain)
      : clamp(this.rain + (Math.random()*0.12-0.06) + (Math.random()<0.06?Math.random()*0.8:0), 0, 1);
    this.temp  = clamp(this.temp + (Math.random()*0.6-0.3), 20, 42);
    this.hum   = clamp(this.hum  + (Math.random()*1.8-0.9), 20, 95);
    return { ts: Date.now(), sound:this.sound, rain:this.rain, temp:this.temp, hum:this.hum };
  }
};

async function getTick(){
  if (CONFIG.DEMO) return demo.step();
  const [s, r, e] = await Promise.all([
    fetchJson(CONFIG.ENDPOINTS.sound).catch(()=>({})),
    fetchJson(CONFIG.ENDPOINTS.rain ).catch(()=>({})),
    fetchJson(CONFIG.ENDPOINTS.env  ).catch(()=>({}))
  ]);
  const snd = parseSound(s);
  if (!Number.isFinite(snd) && !warnedSound) { console.warn("Sound endpoint payload not numeric; got:", s); warnedSound = true; }
  const rain = parseRain(r);
  const {t:temp, h:hum} = parseEnv(e);
  return { ts: Date.now(), sound: snd, rain, temp, hum };
}

// ------- UI updates -------
function updateSoundKPI(v){
  kSound.textContent = Math.round(Number(v));
  const over = Number(v) >= Number(thSound.value);
  kSoundState.textContent = over ? "High" : "Normal";
  kSoundState.classList.toggle("bad", over);
  kSoundState.classList.toggle("good", !over);
}
function updateKPIs(x){
  const r = Number(x.rain);
  kRain.textContent = CONFIG.RAIN_BINARY ? (r === 0 ? "0 (rain)" : "1 (dry)") : r.toFixed(2);
  if (Number.isFinite(x.temp)) kTemp.textContent = x.temp.toFixed(1);
  if (Number.isFinite(x.hum))  kHum.textContent  = Math.round(x.hum);
}

// Automatic animation on sensor detection; gated status by env thresholds
function updateRainUI(intensity, temp, hum){
  const v = Number(intensity);
  const core = CONFIG.RAIN_BINARY ? (v === 0) : (v >= CONFIG.RAIN_THRESHOLD);
  const envOK =
    (Number.isFinite(hum) && hum >= CONFIG.HUM_MIN) &&
    (!Number.isFinite(temp) || temp <= CONFIG.TEMP_MAX);
  const validated = core && envOK;

  if (CONFIG.USE_RAIN_BG) document.body.classList.toggle("raining", !!core);
// start/stop raindrop animation with sensor detection
rainFX.setActive(!!core);

  if (validated){
    rainBadge.textContent = "Raining";
    rainBadge.classList.add("bad");  rainBadge.classList.remove("good");
    rainStatusIcon.textContent = "☔";
    rainStatusText.textContent = "Raining";
  } else if (core){
    rainBadge.textContent = "Rain detected (gates not met)";
    rainBadge.classList.remove("bad");  rainBadge.classList.add("good");
    rainStatusIcon.textContent = "🌦️";
    rainStatusText.textContent = "Detecting rain";
  } else {
    rainBadge.textContent = "Clear";
    rainBadge.classList.remove("bad");  rainBadge.classList.add("good");
    rainStatusIcon.textContent = "🌤️";
    rainStatusText.textContent = "Clear";
  }
}

// ------- Loop -------
function setRun(on){
  runDot.style.background = on ? "#22c55e" : "#64748b";
  runDot.style.boxShadow = `0 0 10px ${on ? "#22c55e" : "#64748b"}`;
}
function setPlayState(running){ btnToggle.textContent = running ? "⏸ Pause" : "▶ Play"; }

let timer=null;
async function tick(){
  try{
    const x = await getTick();
    const lab = fmtTime(x.ts);

    // Sound
    updateGauge(x.sound);
    pushPoint(soundLine, lab, x.sound);   // <-- history will draw reliably
    updateSoundKPI(x.sound);

    // Rain
    updateRainUI(x.rain, x.temp, x.hum);
    pushPoint(rainLine, lab, x.rain);

    // Env
    pushEnvPoint(lab, x.temp, x.hum);

    // KPIs + time
    updateKPIs(x);
    lastUpdate.textContent = lab;

    if (Number(x.sound) >= Number(thSound.value)) toast(`Sound high: ${Math.round(x.sound)} ${CONFIG.SOUND_UNIT}`, "bad");
  }catch(err){
    console.error(err);
    toast(String(err), "bad");
  }
}

function start(){ if (timer) return; timer = setInterval(tick, CONFIG.TICK_MS); setRun(true); setPlayState(true); }
function stop(){ if (!timer) return; clearInterval(timer); timer=null; setRun(false); setPlayState(false); }

btnToggle.addEventListener("click", ()=> timer ? stop() : start());
document.addEventListener("visibilitychange", ()=> { if (document.hidden) stop(); });

// Demo toggle & rate
demoToggle.addEventListener("change", e=>{
  CONFIG.DEMO = e.target.checked;
  for (const c of [soundLine, rainLine, envLine]){
    c.data.labels.length = 0;
    c.data.datasets.forEach(d=>d.data.length=0);
    c.update("none");
  }
  toast(CONFIG.DEMO ? "Demo mode enabled" : "Demo mode disabled", "good");
});
rateSel.addEventListener("change", e=>{
  CONFIG.TICK_MS = Number(e.target.value);
  if (timer){ stop(); start(); }
});

// Threshold controls
thRain.addEventListener("change", e=>{
  CONFIG.RAIN_THRESHOLD = Number(e.target.value);
  reads.rainThreshRead.textContent = CONFIG.RAIN_THRESHOLD.toFixed(2);
});
thHum.addEventListener("change", e=>{
  CONFIG.HUM_MIN = Number(e.target.value);
  reads.humGateRead.textContent = CONFIG.HUM_MIN.toFixed(0);
});
thTemp.addEventListener("change", e=>{
  CONFIG.TEMP_MAX = Number(e.target.value);
  reads.tempGateRead.textContent = CONFIG.TEMP_MAX.toFixed(0);
});

// --- Rain demo: forces rain + valid env for N ms (default 20s) ---
async function simulateRainBurst(ms = 20000){
  CONFIG.DEMO = true;
  const demoChk = document.querySelector("#demoToggle");
  if (demoChk) demoChk.checked = true;
  if (!timer) start();

  demo.hum  = Math.max(CONFIG.HUM_MIN + 2, 85);
  demo.temp = Math.min(CONFIG.TEMP_MAX - 1, 30);
  demo.rain = CONFIG.RAIN_BINARY ? 0 : Math.max(CONFIG.RAIN_THRESHOLD + 0.2, 0.7);
  demo.sound = Math.max(demo.sound || 0, 80);

  if (CONFIG.USE_RAIN_BG) document.body.classList.add("raining");

  setTimeout(() => {
    demo.rain = CONFIG.RAIN_BINARY ? 1 : 0;
    demo.hum  = Math.max(60, CONFIG.HUM_MIN - 10);
    demo.temp = Math.min(36, CONFIG.TEMP_MAX + 1);
    if (CONFIG.USE_RAIN_BG) document.body.classList.remove("raining");
  }, ms);
}
btnRainDemo?.addEventListener("click", () => simulateRainBurst());

// Init UI state
(function init(){ setRun(false); setPlayState(false); })();
