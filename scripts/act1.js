document.addEventListener('DOMContentLoaded', () => {
  // ===== Settings =====
  const UPDATE_MS = 5000;
  const API_URL = 'http://192.168.1.48:5000/api/dht/read';
  const BUZZ_URL = `http://192.168.1.48:5000/api/buzzer/beep`;
  const STORAGE_KEY = 'sensor_readings';
  const MAX_DAYS_KEEP = 7;

  const TEMP_THRESHOLD_C = 38;
  const BUZZ_COOLDOWN_MS = 5000; // don't buzz more often than this when hot
  let lastBuzzTs = 0;

  // ===== Helpers =====
  const $ = s => document.querySelector(s);
  const elTemp = $('#temp'), elHum = $('#hum'), elUpdated = $('#updated');
  const elUpdSec = $('#updSec'), elRecCount = $('#recCount');
  const elMins = $('#mins'), btnClear = $('#btnClear');
  const tbodyLogs = document.getElementById('logBody');

  if (elUpdSec) elUpdSec.textContent = (UPDATE_MS/1000) + 's';

  const nowISO = () => new Date().toISOString();
  const minutesAgoISO = (min) => new Date(Date.now() - min*60*1000).toISOString();

  function loadAll() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return [];
      const arr = JSON.parse(raw);
      return Array.isArray(arr) ? arr : [];
    } catch { return []; }
  }
  function saveAll(arr) {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(arr));
    if (elRecCount) elRecCount.textContent = String(arr.length);
  }
  function trimOld(arr) {
    const cutoff = Date.now() - MAX_DAYS_KEEP*24*60*60*1000;
    return arr.filter(r => new Date(r.ts).getTime() >= cutoff);
  }
  function formatLocal(tsISO) {
    const d = new Date(tsISO);
    const pad = n => String(n).padStart(2,'0');
    return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  }

  function renderLogs(minutes) {
    if (!tbodyLogs) return;
    const all = loadAll();
    const since = new Date(minutesAgoISO(minutes)).getTime();

    const rows = all
      .filter(r => new Date(r.ts).getTime() >= since)
      .sort((a,b) => new Date(b.ts) - new Date(a.ts));

    if (rows.length === 0) {
      tbodyLogs.innerHTML = `<tr><td colspan="3" class="muted">No logs in the last ${minutes} minutes.</td></tr>`;
      return;
    }

    const MAX_ROWS = 500;
    let html = '';
    for (let i=0; i<rows.length && i<MAX_ROWS; i++) {
      const r = rows[i];
      html += `<tr>
        <td>${formatLocal(r.ts)}</td>
        <td>${Number(r.temp).toFixed(1)}</td>
        <td>${Math.round(Number(r.humidity))}</td>
      </tr>`;
    }
    tbodyLogs.innerHTML = html;
  }

  // ===== Chart setup =====
  const canvas = document.getElementById('histChart');
  const hasChart = typeof Chart !== 'undefined' && canvas && canvas.getContext;
  const labels = [], tempData = [], humData = [];
  let chart = null;

  if (hasChart) {
    const ctx = canvas.getContext('2d');
    chart = new Chart(ctx, {
      type: 'line',
      data: {
        labels,
        datasets: [
          { label:'Temp (°C)', data:tempData, borderColor:'rgb(255,99,132)', backgroundColor:'rgba(255,99,132,0.2)', yAxisID:'yTemp', tension:0.2, pointRadius:0 },
          { label:'Humidity (%)', data:humData, borderColor:'rgb(54,162,235)', backgroundColor:'rgba(54,162,235,0.2)', yAxisID:'yHum', tension:0.2, pointRadius:0 }
        ]
      },
      options: {
        animation:false, responsive:true, maintainAspectRatio:false,
        plugins:{ legend:{ position:'bottom' } },
        interaction:{ mode:'nearest', intersect:false },
        scales:{
          x:{ ticks:{ autoSkip:true, maxTicksLimit:8 } },
          yTemp:{ type:'linear', position:'left', title:{ display:true, text:'°C' } },
          yHum:{ type:'linear', position:'right', grid:{ drawOnChartArea:false }, title:{ display:true, text:'%' }, min:0, max:100 }
        }
      }
    });
  }

  function pushPoint(tsISO, temp, hum) {
    if (!chart) return;
    labels.push(new Date(tsISO).toLocaleTimeString());
    tempData.push(Number(temp));
    humData.push(Number(hum));
    if (labels.length > 300) { labels.shift(); tempData.shift(); humData.shift(); }
    chart.update('none');
  }

  function setCards(temp, hum, tsISO){
    if (elTemp) elTemp.textContent = Number.isFinite(temp) ? Number(temp).toFixed(1) : '--';
    if (elHum) elHum.textContent = Number.isFinite(hum) ? Math.round(Number(hum)) : '--';
    if (elUpdated) elUpdated.textContent = tsISO ? new Date(tsISO).toLocaleTimeString() : new Date().toLocaleTimeString();
  }

  // ===== NEW: buzzer trigger =====
  async function buzz(ms=300) {
    try {
      await fetch(BUZZ_URL, {
        method: 'POST',
        headers: { 'Content-Type':'application/json' },
        body: JSON.stringify({ ms })
      });
    } catch (e) {
      console.error('Buzz failed:', e);
    }
  }

  // ===== Fetch from Pi =====
  async function fetchLatest() {
    const res = await fetch(API_URL, { cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const d = await res.json();

    const temp = Number(d.temperature_c ?? d.temp);
    const humidity = Number(d.humidity_percent ?? d.humidity);
    const tsISO = (typeof d.ts === 'number')
      ? new Date(d.ts * 1000).toISOString()
      : nowISO();

    return { temp, humidity, ts: tsISO };
  }

  // ===== Seed from history =====
  function seedFromHistory(minutes){
    const all = loadAll();
    if (elRecCount) elRecCount.textContent = String(all.length);

    const since = new Date(minutesAgoISO(minutes)).getTime();
    if (chart) { labels.length = 0; tempData.length = 0; humData.length = 0; }

    all.forEach(row => {
      const t = new Date(row.ts).getTime();
      if (t >= since) pushPoint(row.ts, row.temp, row.humidity);
    });

    if (all.length) {
      const r = all[all.length-1];
      setCards(r.temp, r.humidity, r.ts);
    }
  }

  // ===== Store + UI update =====
  function addReading(r) {
    const all = trimOld([...loadAll(), r]);
    saveAll(all);
    setCards(r.temp, r.humidity, r.ts);
    pushPoint(r.ts, r.temp, r.humidity);

    const minutes = Math.max(5, Number(elMins?.value) || 120);
    renderLogs(minutes);
  }

  // ===== Boot + Loop =====
  function startLoop() {
    const minutes = Math.max(5, Number(elMins?.value) || 120);
    seedFromHistory(minutes);
    renderLogs(minutes);

    const tick = async () => {
      try {
        const r = await fetchLatest();
        if (Number.isFinite(r.temp) && Number.isFinite(r.humidity)) {
          addReading(r);

          // HOT: trigger buzzer with cooldown
          const now = Date.now();
          if (r.temp > TEMP_THRESHOLD_C && now - lastBuzzTs > BUZZ_COOLDOWN_MS) {
            lastBuzzTs = now;
            buzz(400); // adjust ms if you want longer/shorter beep
          }
        } else {
          setCards(r.temp, r.humidity, r.ts);
        }
      } catch (e) {
        console.error('Fetch failed:', e);
      }
    };

    tick();
    setInterval(tick, UPDATE_MS);
  }

  // ===== Buttons / inputs =====
  if (btnClear) {
    btnClear.addEventListener('click', () => {
      localStorage.removeItem(STORAGE_KEY);
      if (chart) { labels.length = 0; tempData.length = 0; humData.length = 0; chart.update('none'); }
      if (elRecCount) elRecCount.textContent = '0';
      setCards('--','--', null);
      renderLogs(Math.max(5, Number(elMins?.value) || 120));
    });
  }

  if (elMins) {
    elMins.addEventListener('change', () => {
      const minutes = Math.max(5, Number(elMins.value) || 120);
      seedFromHistory(minutes);
      renderLogs(minutes);
    });
  }

  startLoop();
});
