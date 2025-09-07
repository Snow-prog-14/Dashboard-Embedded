// ===== Theme defaults =====
(function () {
  const root = getComputedStyle(document.documentElement);
  const axis = (root.getPropertyValue('--axis') || '#7a7a7a').trim();
  const grid = (root.getPropertyValue('--grid') || '#202020').trim();
  Chart.defaults.color = axis;
  Chart.defaults.borderColor = grid;
})();

// ===== Config & Settings =====
const DEFAULTS = {
  UPDATE_MS: 5000,
  SOURCE: 'api',                // 'api' | 'sim'
  BASE_URL: 'http://raspi.local:5000',
  LATEST_PATH: '/api/latest',   // returns {ts, gas_ppm, vib_rms, vib_peak, status}
  HISTORY_PATH: '/api/history', // accepts ?minutes=, returns [{ts,gas_ppm,vib_rms,vib_peak,status}, ...]
  LIVE_WINDOW_MIN: 15,
  HIST_WINDOW_MIN: 120
};
const Settings = loadSettings();

// ===== Helpers =====
const $ = s => document.querySelector(s);
function safeText(id, text) { const el = document.getElementById(id); if (el) el.textContent = text; }
function apiUrl(path, params = {}) {
  const url = new URL((Settings.BASE_URL || '').replace(/\/+$/,'') + path);
  Object.entries(params).forEach(([k,v]) => url.searchParams.set(k, v));
  return url.toString();
}

// ===== API fetchers with fallback =====
async function fetchLatest() {
  if (Settings.SOURCE !== 'api') return simulateReading();
  try {
    const r = await fetch(apiUrl(Settings.LATEST_PATH), { cache: 'no-store' });
    if (!r.ok) throw new Error('HTTP '+r.status);
    const j = await r.json();
    // normalize keys (backend might use slightly different names)
    const ts = j.ts || j.timestamp || new Date().toISOString();
    const gas = +(j.gas_ppm ?? j.gas ?? 0);
    const vib = +(j.vib_rms ?? j.vibration_rms ?? 0);
    const peak = +(j.vib_peak ?? j.vibration_peak ?? (vib * 3.5));
    const status = j.status || classifyStatus(gas, vib);
    return { ts, gas, vib, peak, status, _from: 'api' };
  } catch (e) {
    console.warn('API latest failed → using simulator', e);
    return simulateReading(); // fallback
  }
}

async function fetchHistory(minutes) {
  if (Settings.SOURCE !== 'api') return seedHistory(minutes, 60); // 1/min dummy
  try {
    const r = await fetch(apiUrl(Settings.HISTORY_PATH, { minutes: String(minutes) }), { cache: 'no-store' });
    if (!r.ok) throw new Error('HTTP '+r.status);
    const arr = await r.json();
    // normalize
    return arr.map(row => ({
      ts: row.ts || row.timestamp,
      gas: +(row.gas_ppm ?? row.gas ?? 0),
      vib: +(row.vib_rms ?? row.vibration_rms ?? 0),
      peak: +(row.vib_peak ?? row.vibration_peak ?? 0),
      status: row.status || classifyStatus(+(row.gas_ppm ?? row.gas ?? 0), +(row.vib_rms ?? row.vibration_rms ?? 0)),
    }));
  } catch (e) {
    console.warn('API history failed → using simulator seed', e);
    return seedHistory(minutes, Math.max(10, Math.floor(minutes/12))); // ~12 pts
  }
}

// ===== Chart factory (dual-axis on time scale) =====
function makeDualAxisChart(ctx) {
  return new Chart(ctx, {
    type: 'line',
    data: { datasets: [
      { label:'Gas (ppm)',     borderColor:'#ff6b8b', backgroundColor:'#ff6b8b33', data:[], yAxisID:'y',  tension:0.15, pointRadius:0 },
      { label:'Vibration RMS', borderColor:'#4ea1ff', backgroundColor:'#4ea1ff33', data:[], yAxisID:'y1', tension:0.15, pointRadius:0 },
    ]},
    options: {
      animation:false, responsive:true, interaction:{mode:'index', intersect:false},
      parsing:false,
      scales:{
        x:{
          type:'time',
          time:{ unit:'second', stepSize:10, displayFormats:{ second:'HH:mm:ss', minute:'HH:mm' } },
          bounds:'data',
          ticks:{ source:'auto', maxRotation:0, autoSkip:true, maxTicksLimit:12 },
          distribution:'linear'
        },
        y:{  position:'left',  title:{display:true,text:'ppm'} },
        y1:{ position:'right', title:{display:true,text:'RMS'}, grid:{drawOnChartArea:false} },
      },
      plugins:{ legend:{ labels:{ usePointStyle:true, boxHeight:10, boxWidth:18, padding:18 } } }
    }
  });
}

function configureTimeAxis(chart, windowMin) {
  const x = chart.options.scales.x;
  if (windowMin <= 20) { x.time.unit='second'; x.time.stepSize=10; x.ticks.maxTicksLimit=12; }
  else { x.time.unit='minute'; x.time.stepSize=Math.max(1, Math.ceil(windowMin/10)); x.ticks.maxTicksLimit=10; }
  chart.update(0);
}

// align window to last sample; ensure labels appear
function pushPointWindow(chart, windowMin, tsISO, gas, vib) {
  const xDate = new Date(tsISO);
  chart.data.datasets[0].data.push({ x:xDate, y:gas });
  chart.data.datasets[1].data.push({ x:xDate, y:vib });

  const lastX = xDate;
  const minX  = new Date(lastX.getTime() - windowMin * 60 * 1000);
  for (const ds of chart.data.datasets) ds.data = ds.data.filter(p => p.x >= minX);

  chart.options.scales.x.min = minX;
  chart.options.scales.x.max = lastX;
  chart.update('none');
}

function setSeries(chart, rows, windowMin) {
  chart.data.datasets[0].data = rows.map(r => ({ x:new Date(r.ts), y:r.gas }));
  chart.data.datasets[1].data = rows.map(r => ({ x:new Date(r.ts), y:r.vib }));
  if (rows.length) {
    const lastX = new Date(rows[rows.length-1].ts);
    chart.options.scales.x.min = new Date(lastX.getTime() - windowMin*60*1000);
    chart.options.scales.x.max = lastX;
  }
  chart.update(0);
}

// ===== Dummy / Simulator =====
function classifyStatus(gas, vib) {
  const GAS_WARN=400, GAS_ALERT=800, VIB_WARN=0.06, VIB_ALERT=0.12;
  if (gas>GAS_ALERT || vib>VIB_ALERT) return 'ALERT';
  if (gas>GAS_WARN  || vib>VIB_WARN)  return 'WARN';
  return 'OK';
}
function simulateReading() {
  const ts = new Date().toISOString();
  let gas = 220 + Math.random()*100; if (Math.random()<0.05) gas += 400*Math.random(); gas = +gas.toFixed(2);
  let vib = 0.025 + Math.random()*0.02; if (Math.random()<0.03) vib += 0.05*Math.random(); vib = +vib.toFixed(4);
  return { ts, gas, vib, peak:+(vib*3.5).toFixed(4), status: classifyStatus(gas, vib), _from:'sim' };
}
function seedHistory(minutes, stepSec=60) {
  const now = Date.now(), rows=[];
  for (let t = minutes*60; t>=0; t-=stepSec) {
    const ts = new Date(now - t*1000).toISOString();
    const gas = +(220 + 25*Math.sin(t/12) + (Math.random()*18-9) + (Math.random()<0.03? 300*Math.random():0)).toFixed(2);
    const vib = +(0.025 + 0.01*Math.sin(t/18) + Math.random()*0.008 + (Math.random()<0.02? 0.04*Math.random():0)).toFixed(4);
    rows.push({ ts, gas, vib, peak:+(vib*3.5).toFixed(4), status: classifyStatus(gas, vib) });
  }
  return rows;
}

// ===== Storage =====
function loadSettings() {
  try { return { ...DEFAULTS, ...(JSON.parse(localStorage.getItem('gv_pi_settings')||'{}')) }; }
  catch { return { ...DEFAULTS }; }
}
function saveSettings() {
