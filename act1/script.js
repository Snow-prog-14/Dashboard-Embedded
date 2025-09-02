 document.addEventListener('DOMContentLoaded', () => {
    // ===== Settings =====
    const UPDATE_MS = 5000;               // live update cadence
    const API_URL = '/api/readings';  
    const STORAGE_KEY = 'sensor_readings';// where we keep records in localStorage
    const MAX_DAYS_KEEP = 7;              // auto-trim older than N days

    // ===== Helpers =====
    const $ = s => document.querySelector(s);
    const elTemp = $('#temp'), elHum = $('#hum'), elUpdated = $('#updated');
    const elUpdSec = $('#updSec'), elRecCount = $('#recCount');
    const elMins = $('#mins'), btnClear = $('#btnClear');

    elUpdSec.textContent = (UPDATE_MS/1000) + 's';

    function nowISO() { return new Date().toISOString(); }
    function minutesAgoISO(min){ return new Date(Date.now() - min*60*1000).toISOString(); }

    function renderLogs(minutes) {
  const tbody = document.getElementById('logBody');
  if (!tbody) return;

  const all = loadAll();
  const since = new Date(minutesAgoISO(minutes)).getTime();

  // Filter by time window, newest first
  const rows = all
    .filter(r => new Date(r.ts).getTime() >= since)
    .sort((a, b) => new Date(b.ts) - new Date(a.ts));

  const MAX_ROWS = 500; // keep UI snappy
  if (rows.length === 0) {
    tbody.innerHTML = `<tr><td colspan="3" class="muted">No logs in the last ${minutes} minutes.</td></tr>`;
    return;
  }

  let html = '';
  for (let i = 0; i < rows.length && i < MAX_ROWS; i++) {
    const r = rows[i];
    html += `<tr>
      <td>${formatLocal(r.ts)}</td>
      <td>${Number(r.temp).toFixed(1)}</td>
      <td>${Math.round(Number(r.humidity))}</td>
    </tr>`;
  }
  tbody.innerHTML = html;
}


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
      elRecCount.textContent = arr.length.toString();
    }

    function trimOld(arr) {
      const cutoff = Date.now() - MAX_DAYS_KEEP*24*60*60*1000;
      return arr.filter(r => new Date(r.ts).getTime() >= cutoff);
    }

   // pretty local timestamp for CSV
  function formatLocal(tsISO) {
    const d = new Date(tsISO);
    const pad = (n) => String(n).padStart(2, '0');
    const yyyy = d.getFullYear();
    const mm = pad(d.getMonth() + 1);
    const dd = pad(d.getDate());
    const HH = pad(d.getHours());
    const MM = pad(d.getMinutes());
    const SS = pad(d.getSeconds());
    return `${yyyy}-${mm}-${dd} ${HH}:${MM}:${SS}`; // local time, no "Z"
  }

  

  function toCSV(rows) {
    const header = ['time', 'temp_c', 'humidity_%'];
    const lines = [header].concat(
      rows.map(r => [
        formatLocal(r.ts),
        Number(r.temp).toFixed(1),
        Math.round(Number(r.humidity))
      ])
    );
    return lines.map(line => line.join(',')).join('\n');
  }

  function refreshCSVLink(){

    const minutes = Math.max(5, Number(elMins?.value) || 120);
    const all = loadAll();
    const since = new Date(minutesAgoISO(minutes)).getTime();
    const rows = all.filter(r => new Date(r.ts).getTime() >= since);

    const csvText = toCSV(rows);
    const blob = new Blob([csvText], { type: 'application/octet-stream' });
    const url = URL.createObjectURL(blob);

    const now = new Date();
    const pad = n => String(n).padStart(2, '0');
    const fname = `history_${now.getFullYear()}${pad(now.getMonth()+1)}${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}.csv`;

  }

    // ===== Chart setup =====
    const ctx = document.getElementById('histChart').getContext('2d');
    const labels = [], tempData = [], humData = [];
    const chart = new Chart(ctx, {
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

    // ===== Real API fetchers =====
  async function fetchLatest() {
    const res = await fetch(API_URL, { cache: 'no-store' });
    if (!res.ok) throw new Error(`latest HTTP ${res.status}`);
    const data = await res.json();
    // normalize fields; adjust if your API uses different names
    const temp = Number(data.temp);
    const humidity = Number(data.humidity);
    const ts = data.ts ? new Date(data.ts).toISOString() : nowISO();
    return { temp, humidity, ts };
  }

  async function fetchHistory(minutes) {
    const res = await fetch(HISTORY_URL(minutes), { cache: 'no-store' });
    if (!res.ok) throw new Error(`history HTTP ${res.status}`);
    // expected shape: { labels:[iso...], temp:[...], humidity:[...] }
    return await res.json();
  }

    function pushPoint(tsISO, temp, hum) {
      labels.push(new Date(tsISO).toLocaleTimeString());
      tempData.push(Number(temp));
      humData.push(Number(hum));
      chart.update('none');
    }

    // ===== Seed chart from history =====
    function seedFromHistory(minutes){
      const all = loadAll();
      elRecCount.textContent = all.length.toString();
      const since = new Date(minutesAgoISO(minutes)).getTime();
      labels.length = 0; tempData.length = 0; humData.length = 0;
      all.forEach(row => {
        const t = new Date(row.ts).getTime();
        if (t >= since) pushPoint(row.ts, row.temp, row.humidity);
      });
      if (all.length) {
        const r = all[all.length-1];
        setCards(r.temp, r.humidity, r.ts);
      }
    }

    // ===== UI Cards =====
    function setCards(temp, hum, tsISO){
      elTemp.textContent = Number(temp).toFixed(1);
      elHum.textContent = Math.round(Number(hum));
      elUpdated.textContent = tsISO ? new Date(tsISO).toLocaleTimeString() : new Date().toLocaleTimeString();
    }

    // ===== CSV / Clear buttons =====
   function formatLocal(tsISO) {
    const d = new Date(tsISO);
    const pad = (n) => String(n).padStart(2, '0');
    const yyyy = d.getFullYear();
    const mm = pad(d.getMonth() + 1);
    const dd = pad(d.getDate());
    const HH = pad(d.getHours());
    const MM = pad(d.getMinutes());
    const SS = pad(d.getSeconds());
    return `${yyyy}-${mm}-${dd} ${HH}:${MM}:${SS}`; // local time, no "Z"
    }

    btnClear.addEventListener('click', () => {
      localStorage.removeItem(STORAGE_KEY);
      labels.length = 0; tempData.length = 0; humData.length = 0;
      chart.update('none');
      elRecCount.textContent = '0';
      setCards('--','--', null);
      refreshCSVLink();
    });

    elMins.addEventListener('change', () => {
      const minutes = Math.max(5, Number(elMins.value) || 120);
      seedFromHistory(minutes);
      refreshCSVLink();
    });


  });