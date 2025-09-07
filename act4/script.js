// ---------- Global chart styles ----------
Chart.defaults.plugins.title.font = { family:'Verdana', size:18, weight:'bold' };
Chart.defaults.plugins.title.color = '#ffffff';

Chart.defaults.plugins.tooltip.backgroundColor = 'rgba(0,0,0,0.92)';
Chart.defaults.plugins.tooltip.borderColor = '#444';
Chart.defaults.plugins.tooltip.borderWidth = 1;
Chart.defaults.plugins.tooltip.cornerRadius = 8;
Chart.defaults.plugins.tooltip.padding = 10;
Chart.defaults.plugins.tooltip.displayColors = false;
Chart.defaults.plugins.tooltip.titleColor = '#fff';
Chart.defaults.plugins.tooltip.bodyColor  = '#fff';
Chart.defaults.plugins.tooltip.titleFont = { size:14, weight:'bold' };
Chart.defaults.plugins.tooltip.bodyFont  = { size:13 };

// Theme defaults from CSS vars
(() => {
  const root = getComputedStyle(document.documentElement);
  Chart.defaults.color = (root.getPropertyValue('--axis')||'#7a7a7a').trim();
  Chart.defaults.borderColor = (root.getPropertyValue('--grid')||'#202020').trim();
  Chart.defaults.animation.duration = 250;
})();

// ---------- Config ----------
const GAS_URL = 'http://192.168.43.185:5000/api/gas';
const VIB_URL = 'http://192.168.43.185:5000/api/vibrate';

const STORAGE_KEY = 'gv_records';
const MAX_DAYS_KEEP = 7;       // keep logs for 7 days
const WINDOW_MS = 60 * 1000;   // show last 60s in charts
const TICK_MS   = 2000;        // poll cadence (ms)
document.getElementById('updSec').textContent = (TICK_MS/1000) + 's';

// ---------- Helpers ----------
const fmt = new Intl.DateTimeFormat(undefined, { dateStyle:'medium', timeStyle:'medium' });
const css = getComputedStyle(document.documentElement);
const cPink = css.getPropertyValue('--pink').trim() || '#ff6b8b';
const cBlue = css.getPropertyValue('--blue').trim() || '#4ea1ff';

function fmtStamp(ms){ return fmt.format(ms); }
function setTimeWindow(chart, nowMs){ chart.options.scales.x.min = nowMs - WINDOW_MS; chart.options.scales.x.max = nowMs; }
function trimToWindow(dataset){
  const cut = Date.now() - WINDOW_MS;
  while (dataset.length && dataset[0].x < cut) dataset.shift();
}

function avgWindow(dataset){
  if (!dataset.length) return null;
  let s = 0;
  for (const p of dataset) s += (+p.y||0);
  return s / dataset.length;
}
function vibStatsWindow(dataset){
  if (!dataset.length) return { pctOn:0, trend:'no data' };
  let on = 0;
  for (const p of dataset) if ((+p.y||0) > 0.5) on++;
  const pct = on / dataset.length * 100;
  let trend = 'intermittent';
  if (pct >= 60) trend = 'ON most of the time';
  else if (pct <= 10) trend = 'OFF most of the time';
  return { pctOn:pct, trend };
}

// storage
function loadRecords(){ try { return JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]'); } catch { return []; } }
function saveRecords(rows){
  localStorage.setItem(STORAGE_KEY, JSON.stringify(rows));
  document.getElementById('recCount').textContent = String(rows.length);
}
function appendRecord(row){
  const rows = loadRecords();
  rows.push(row);
  const cutoff = Date.now() - MAX_DAYS_KEEP*24*60*60*1000;
  const pruned = rows.filter(r => (typeof r.ts === 'number' ? r.ts : Date.parse(r.ts)) >= cutoff);
  saveRecords(pruned);
}
function exportCSV(){
  const rows = loadRecords();
  const header = ['timestamp','gas_ppm','vibration_digital','status'];
  const lines = [header.join(',')].concat(rows.map(r => {
    const ts = typeof r.ts === 'number' ? new Date(r.ts).toISOString() : r.ts;
    return [ts, r.gas_ppm, r.vibration_digital, (r.status||'')].join(',');
  }));
  const blob = new Blob([lines.join('\n')], {type:'text/csv'});
  const url = URL.createObjectURL(blob);
  const a = Object.assign(document.createElement('a'), { href:url, download:'gv_records.csv' });
  document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url);
}
function clearLogs(){ localStorage.removeItem(STORAGE_KEY); saveRecords([]); }

document.getElementById('btnCSV').addEventListener('click', exportCSV);
document.getElementById('btnClear').addEventListener('click', clearLogs);
saveRecords(loadRecords()); // counter on load

// ---------- X axis config ----------
const commonTimeScale = {
  type: 'time',
  time: { unit: 'second', stepSize: 10, displayFormats: { second: 'HH:mm:ss' } },
  ticks: { maxRotation: 0, maxTicksLimit: 7, autoSkipPadding: 12, color: '#d8d8d8', font: { size: 12 } }
};

// ---------- Charts ----------
const gasChart = new Chart(document.getElementById('gasChart'), {
  type: 'line',
  data: { datasets: [{
    label: 'Gas (ppm)',
    data: [],
    borderColor: cPink,
    backgroundColor: cPink + '33',
    pointRadius: 0,
    fill: true,
    tension: 0.25
  }]},
  options: {
    maintainAspectRatio: false,
    plugins: {
      title: { display: true, text: 'MQ-2 Gas (ppm)' },
      legend: { display: false },
      tooltip: {
        callbacks: {
          title(items){ return fmt.format(items[0].parsed.x); },
          label(ctx){ return `Gas: ${ctx.parsed.y.toFixed(0)} ppm`; }
        }
      }
    },
    interaction: { mode: 'nearest', intersect: false },
    scales: {
      x: commonTimeScale,
      y: { beginAtZero: true, title: { display: true, text: 'ppm' }, ticks: { color:'#d8d8d8', font:{ size:12 } } }
    }
  }
});

const vibChart = new Chart(document.getElementById('vibChart'), {
  type: 'line',
  data: { datasets: [{
    label: 'Vibration (digital)',
    data: [],
    borderColor: cBlue,
    backgroundColor: cBlue + '33',
    pointRadius: 0,
    stepped: 'middle',
    fill: true
  }]},
  options: {
    maintainAspectRatio: false,
    plugins: {
      title: { display: true, text: 'SW-420 Vibration (digital)' },
      legend: { display: false },
      tooltip: {
        callbacks: {
          title(items){ return fmt.format(items[0].parsed.x); },
          label(ctx){ return `Trigger: ${ctx.parsed.y ? 'ON' : 'OFF'}`; }
        }
      }
    },
    interaction: { mode: 'nearest', intersect: false },
    scales: {
      x: commonTimeScale,
      y: { min:0, max:1.05, ticks:{ stepSize:1, color:'#d8d8d8', font:{ size:12 } }, title:{ display:true, text:'Trigger' } }
    }
  }
});

// ---------- API fetch ----------
async function fetchJSON(url){
  const r = await fetch(url, { cache:'no-store' });
  if (!r.ok) throw new Error(url + ' → HTTP ' + r.status);
  return r.json();
}

// Normalize various possible response shapes from your Flask APIs
function parseGas(json){
  // accepts: {ppm} or {gas} or {gas_ppm} or {value}
  const ppm = Number(json.ppm ?? json.gas_ppm ?? json.gas ?? json.value ?? 0);
  const ts  = json.ts || json.timestamp || Date.now();
  return { ppm, ts: typeof ts === 'number' ? ts : Date.parse(ts) || Date.now() };
}
function parseVib(json){
  // accepts: {value:0/1}, {trigger:bool}, {vibration:0/1}, etc.
  let raw = json.value ?? json.vibration ?? json.vib ?? json.trigger ?? json.digital ?? 0;
  if (typeof raw === 'boolean') raw = raw ? 1 : 0;
  const digital = Number(raw) ? 1 : 0;
  const ts = json.ts || json.timestamp || Date.now();
  return { digital, ts: typeof ts === 'number' ? ts : Date.parse(ts) || Date.now() };
}

async function fetchLatest(){
  // Fetch both endpoints in parallel
  const [gJ, vJ] = await Promise.all([ fetchJSON(GAS_URL), fetchJSON(VIB_URL) ]);
  const g = parseGas(gJ);
  const v = parseVib(vJ);
  // Pick a common timestamp (prefer server time if provided)
  const now = Math.max(g.ts || 0, v.ts || 0) || Date.now();
  return { now, gasPPM: g.ppm, vibDigital: v.digital };
}

// ---------- Live loop ----------
async function tick(){
  try{
    const { now, gasPPM, vibDigital } = await fetchLatest();

    // push to charts
    gasChart.data.datasets[0].data.push({ x: now, y: gasPPM });
    vibChart.data.datasets[0].data.push({ x: now, y: vibDigital });

    // keep only last 60s in charts
    trimToWindow(gasChart.data.datasets[0].data);
    trimToWindow(vibChart.data.datasets[0].data);
    setTimeWindow(gasChart, now);
    setTimeWindow(vibChart, now);

    gasChart.update('none');
    vibChart.update('none');

    // latest panel
    document.getElementById('lastTs').textContent  = fmtStamp(now);
    document.getElementById('lastGas').textContent = Math.round(gasPPM);
    document.getElementById('lastVib').textContent = vibDigital;

    // status
    let status='OK', cls='ok';
    if (gasPPM > 800) { status='GAS ALERT'; cls='alert'; }
    else if (gasPPM > 400) { status='GAS WARN'; cls='warn'; }
    if (vibDigital > 0) { status += (status==='OK'?'':' • ') + 'VIBRATION'; cls = (cls==='alert'?'alert':'warn'); }
    const el = document.getElementById('lastStatus'); el.textContent = status; el.className = cls;

    // record
    appendRecord({ ts: now, gas_ppm: Math.round(gasPPM), vibration_digital: vibDigital, status });

    // last-minute summaries
    const gasAvg = avgWindow(gasChart.data.datasets[0].data);
    document.getElementById('gasAvgMin').textContent = gasAvg !== null ? Math.round(gasAvg) : '—';
    const { pctOn, trend } = vibStatsWindow(vibChart.data.datasets[0].data);
    document.getElementById('vibPctOn').textContent = pctOn.toFixed(0);
    document.getElementById('vibTrend').textContent = trend;

  }catch(err){
    console.warn('tick() fetch failed:', err);
    // (keeps last values on transient failures)
  }
}

// start loop
tick();
setInterval(tick, TICK_MS);
