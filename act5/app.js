// ============ Config ============
const CONFIG = {
  DEMO: true,
  TICK_MS: 1000,
  WINDOW_POINTS: 180,              // ~3 minutes @ 1s
  SOUND_UNIT: "dB",
  SOUND_MIN: 0,
  SOUND_MAX: 100,
  RAIN_THRESHOLD: 0.30,            // 0..1 => "Raining"
  ENDPOINTS: {
    sound: "/api/sound",           // { now:number, ts:number }
    rain:  "/api/rain",            // { intensity:number(0..1), ts:number }
    env:   "/api/env"              // { temp:number, hum:number, ts:number }
  }
};

// ============ Helpers ============
function peakOf(arr){
  let m = -Infinity;
  for (let i=0;i<arr.length;i++){
    const v = Number(arr[i]);
    if (Number.isFinite(v) && v > m) m = v;
  }
  return (m === -Infinity) ? null : m;
}


const $ = (q) => document.querySelector(q);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const fmtTime = (ts) => new Date(ts).toLocaleTimeString();
const kTempPeak = $("#kTempPeak");
const kHumPeak  = $("#kHumPeak");


function peakMarkers(dataset){
  if (!dataset?.data?.length) return { pointRadius:[], pointStyle:[] };
  let idx = 0;
  for (let i=1;i<dataset.data.length;i++) if (dataset.data[i] > dataset.data[idx]) idx = i;
  return {
    pointRadius: dataset.data.map((_,i)=> i===idx ? 5 : 2),
    pointStyle:  dataset.data.map((_,i)=> i===idx ? "triangle" : "circle")
  };
}

// Toasts
const toasts = $("#toasts");
function toast(msg, type=""){ const el=document.createElement("div"); el.className=`toast ${type}`; el.textContent=msg; toasts.appendChild(el); setTimeout(()=>el.remove(),3200); }

// ============ Demo generator ============
const demo = {
  phase: 0, sound: 36, rain: 0.0, temp: 30, hum: 70,
  step(){
    this.phase += 0.25;
    this.sound = clamp(this.sound + (Math.random()*6-3) + 4*Math.sin(this.phase/3), CONFIG.SOUND_MIN, CONFIG.SOUND_MAX);
    const drift=(Math.random()*0.12-0.06), shower = Math.random()<0.06 ? Math.random()*0.8 : 0;
    this.rain = clamp(this.rain + drift + shower, 0, 1);
    if (this.rain>0.15 && Math.random()<0.5) this.rain -= 0.08;
    this.rain = clamp(this.rain, 0, 1);
    this.temp = clamp(this.temp + (Math.random()*0.6-0.3), 20, 42);
    this.hum  = clamp(this.hum  + (Math.random()*1.8-0.9), 20, 95);
    return { ts: Date.now(), sound: this.sound, rain: this.rain, temp: this.temp, hum: this.hum };
  }
};

// ============ Chart defaults ============
Chart.defaults.responsive = true;
Chart.defaults.maintainAspectRatio = false;

// ============ Charts ============

// Sound gauge
const soundGauge = new Chart($("#soundGauge"), {
  type: "doughnut",
  data: { labels:["Level","Remaining"], datasets:[{ data:[0, CONFIG.SOUND_MAX], borderWidth:0 }] },
  options: {
    cutout:"72%", rotation:-90, circumference:180,
    responsive:true, maintainAspectRatio:false,
    animation:false,
    plugins:{ legend:{display:false}, tooltip:{enabled:false} }
  }
});

// Sound history — create with empty arrays
const soundLine = new Chart($("#soundLine"), {
  type: "line",
  data: {
    labels: [],
    datasets: [{
      label: `Sound (${CONFIG.SOUND_UNIT})`,
      data: [],
      borderColor: "#6ea8fe",
      backgroundColor: "transparent",
      tension: 0,
      pointRadius: 0,
      borderWidth: 2,
      spanGaps: false,   // we keep it contiguous; no NaNs
      hidden: false
    }]
  },
  options: {
    responsive: true,
    maintainAspectRatio: false,
    animation: false,
    // NOTE: remove parsing/normalized to keep defaults simple and robust
    scales: {
      x: { ticks: { autoSkip: true, maxTicksLimit: 8 }, grid: { color: "#202838" } },
      y: {
        min: CONFIG.SOUND_MIN,
        max: CONFIG.SOUND_MAX,
        ticks: { stepSize: 10 },
        grace: 0,
        grid: { color: "#202838" }
      }
    },
    plugins: { legend: { display: true }, tooltip: { enabled: true } }
  }
});

// Rain intensity
const rainLine = new Chart($("#rainLine"), {
  type: "line",
  data: {
    labels: [],
    datasets: [{ label:"Rain Intensity (0–1)", data: [], tension:.25, pointRadius:0, borderWidth:2 }]
  },
  options: {
    animation:false,
    scales:{
      x:{ ticks:{autoSkip:true,maxTicksLimit:7}, grid:{color:"#202838"} },
      y:{ min:0, max:1, grid:{color:"#202838"} }
    },
    plugins:{ legend:{display:true} }
  }
});

// Environment (Temp + Hum)
const envLine = new Chart($("#envLine"), {
  type: "line",
  data: {
    labels: [],
    datasets: [
      { label:"Temperature (°C)", data: [], tension:.25, pointRadius:2, borderWidth:2 },
      { label:"Humidity (%)",     data: [], tension:.25, pointRadius:2, borderWidth:2 }
    ]
  },
  options: {
    animation:false,
    scales:{
      x:{ ticks:{autoSkip:true,maxTicksLimit:8}, grid:{color:"#202838"} },
      y:{ beginAtZero:false, grid:{color:"#202838"} }
    },
    plugins:{ legend:{display:true} }
  }
});

// ============ UI refs ============
const lastUpdate = $("#lastUpdate");
const runDot = $("#runDot");
const btnToggle = $("#btnToggle");
const demoToggle = $("#demoToggle");
const rateSel = $("#rate");
const thSound = $("#thSound");
const thRain = $("#thRain");
const rainThreshRead = $("#rainThreshRead");

const kSound = $("#kSound"), kSoundUnit = $("#kSoundUnit");
const kRain = $("#kRain"), kTemp = $("#kTemp"), kHum = $("#kHum");
const kSoundState = $("#kSoundState");
const soundNowEl = $("#soundNow"), soundUnitEl = $("#soundUnit"), soundUnitLabel = $("#soundUnitLabel");
const rainBadge = $("#rainBadge");
const rainStatusIcon = $("#rainStatusIcon"), rainStatusText = $("#rainStatusText");

kSoundUnit.textContent = " " + CONFIG.SOUND_UNIT;
soundUnitEl.textContent = " " + CONFIG.SOUND_UNIT;
soundUnitLabel.textContent = CONFIG.SOUND_UNIT;
rainThreshRead.textContent = CONFIG.RAIN_THRESHOLD.toFixed(2);

// ============ Data I/O ============
async function fetchJson(url){
  const r = await fetch(url);
  if(!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}
async function getTick(){
  if (CONFIG.DEMO) return demo.step();
  const [s,r,e] = await Promise.all([
    fetchJson(CONFIG.ENDPOINTS.sound), // {now, ts}
    fetchJson(CONFIG.ENDPOINTS.rain),  // {intensity, ts}
    fetchJson(CONFIG.ENDPOINTS.env)    // {temp, hum, ts}
  ]);
  return { ts:s.ts || Date.now(), sound:s.now, rain:r.intensity, temp:e.temp, hum:e.hum };
}

// ============ Updaters ============

// Update gauge
function updateGauge(v){
  const val = clamp(Number(v), CONFIG.SOUND_MIN, CONFIG.SOUND_MAX);
  soundGauge.data.datasets[0].data[0] = val;
  soundGauge.data.datasets[0].data[1] = CONFIG.SOUND_MAX - val;
  soundGauge.update("none");
  soundNowEl.textContent = Math.round(val);
}

// DIRECT chart updaters (write into chart.data, not external arrays)
function updateLineDirect(chart, label, value){
  const v = Number(value);
  if (!Number.isFinite(v)) return;
  const labels = chart.data.labels;
  const data   = chart.data.datasets[0].data;

  if (labels.length >= CONFIG.WINDOW_POINTS) { labels.shift(); data.shift(); }
  labels.push(label);
  data.push(v);

  chart.update("none");
}

function updateEnvDirect(label, t, h){
  const T = Number(t), H = Number(h);
  if (!Number.isFinite(T) || !Number.isFinite(H)) return;

  const labels = envLine.data.labels;
  const td = envLine.data.datasets[0].data; // temp
  const hd = envLine.data.datasets[1].data; // hum

  if (labels.length >= CONFIG.WINDOW_POINTS) { labels.shift(); td.shift(); hd.shift(); }
  labels.push(label); td.push(T); hd.push(H);

  // Peak markers on the chart
  const tP = peakMarkers(envLine.data.datasets[0]);
  const hP = peakMarkers(envLine.data.datasets[1]);
  envLine.data.datasets[0].pointRadius = tP.pointRadius;
  envLine.data.datasets[0].pointStyle  = tP.pointStyle;
  envLine.data.datasets[1].pointRadius = hP.pointRadius;
  envLine.data.datasets[1].pointStyle  = hP.pointStyle;

  envLine.update("none");

  // Peak readouts in KPI cards
  const tp = peakOf(td);
  const hp = peakOf(hd);
  if (tp != null) kTempPeak.textContent = tp.toFixed(1);
  if (hp != null) kHumPeak.textContent  = Math.round(hp);
}


function updateRainUI(intensity){
  const raining = Number(intensity) >= CONFIG.RAIN_THRESHOLD;
  rainBadge.textContent = raining ? "Raining" : "Clear";
  rainBadge.classList.toggle("bad", raining);
  rainBadge.classList.toggle("good", !raining);
  rainStatusIcon.textContent = raining ? "☔" : "🌤️";
  rainStatusText.textContent = raining ? "Raining" : "Clear";
}

function updateSoundKPI(v){
  kSound.textContent = Math.round(Number(v));
  const over = Number(v) >= Number(thSound.value);
  kSoundState.textContent = over ? "High" : "Normal";
  kSoundState.classList.toggle("bad", over);
  kSoundState.classList.toggle("good", !over);
}

function updateKPIs(t){
  kRain.textContent = Number(t.rain).toFixed(2);
  kTemp.textContent = Number(t.temp).toFixed(1);
  kHum.textContent  = Number(t.hum).toFixed(0);
}

// ============ Loop ============
let timer = null;
async function tick(){
  try{
    const x = await getTick();
    const lab = fmtTime(x.ts);

    // Sound
    updateGauge(x.sound);
    updateLineDirect(soundLine, lab, x.sound);

    // Rain
    updateRainUI(x.rain);
    updateLineDirect(rainLine, lab, x.rain);

    // Env
    updateEnvDirect(lab, x.temp, x.hum);

    // KPIs + timestamp
    updateSoundKPI(x.sound);
    updateKPIs(x);
    lastUpdate.textContent = lab;

    // Alerts
    if (Number(x.sound) >= Number(thSound.value)) toast(`Sound high: ${Math.round(x.sound)} ${CONFIG.SOUND_UNIT}`, "bad");
    if (Number(x.rain)  >= Number(thRain.value))  toast(`Rain threshold met: ${Number(x.rain).toFixed(2)}`, "bad");
  }catch(err){
    console.error(err);
    toast(String(err), "bad");
  }
}

function setRun(on){
  runDot.style.background = on ? "#22c55e" : "#64748b";
  runDot.style.boxShadow = `0 0 10px ${on ? "#22c55e" : "#64748b"}`;
}
function setPlayState(running){ btnToggle.textContent = running ? "⏸ Pause" : "▶ Play"; }
function start(){ if (timer) return; timer = setInterval(tick, CONFIG.TICK_MS); setRun(true); setPlayState(true); }
function stop(){ if (!timer) return; clearInterval(timer); timer=null; setRun(false); setPlayState(false); }

// ============ Events ============
btnToggle.addEventListener("click", ()=> timer ? stop() : start());

demoToggle.addEventListener("change", e=>{
  CONFIG.DEMO = e.target.checked;

  // Hard reset all series by clearing chart-internal arrays
  soundLine.data.labels.length = 0;
  soundLine.data.datasets[0].data.length = 0;

  rainLine.data.labels.length = 0;
  rainLine.data.datasets[0].data.length = 0;

  envLine.data.labels.length = 0;
  envLine.data.datasets[0].data.length = 0;
  envLine.data.datasets[1].data.length = 0;

  soundLine.update("none"); rainLine.update("none"); envLine.update("none");
  toast(CONFIG.DEMO ? "Demo mode enabled" : "Demo mode disabled", "good");
});

rateSel.addEventListener("change", e=>{
  CONFIG.TICK_MS = Number(e.target.value);
  if (timer){ stop(); start(); }
});

thRain.addEventListener("change", e=>{
  CONFIG.RAIN_THRESHOLD = Number(e.target.value);
  $("#rainThreshRead").textContent = CONFIG.RAIN_THRESHOLD.toFixed(2);
  toast(`Rain threshold: ${CONFIG.RAIN_THRESHOLD.toFixed(2)}`, "good");
});

// ============ Init ============
setRun(false); setPlayState(false);
$("#soundUnitLabel").textContent = CONFIG.SOUND_UNIT;
$("#soundUnit").textContent = " " + CONFIG.SOUND_UNIT;
$("#kSoundUnit").textContent = " " + CONFIG.SOUND_UNIT;
