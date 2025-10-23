// ====== CONFIG: set your Raspberry Pi base URL ======
const RASPI_BASE = localStorage.getItem('raspi_base') || 'http://192.168.1.48:5000';

// ---------- Elements ----------
const $ = s => document.querySelector(s);
const overlay = $('#overlay');
const ctx = overlay.getContext('2d');

const conf = $('#conf');
const confVal = $('#confVal');
const btnStart = $('#btnStart');
const btnStop = $('#btnStop');
const btnRefresh = $('#btnRefresh');
const statusEl = $('#status');

const legend = $('#legend');
const detSummary = $('#detSummary');
const detListOk = $('#detListOk');
const detListForeign = $('#detListForeign');

// Sidebar (allowed)
const allowedBody = $('#allowedBody');
const allowedInput = $('#allowedInput');
const btnAddAllowed = $('#btnAddAllowed');
const btnClearAllowed = $('#btnClearAllowed');
const allowedCount = $('#allowedCount');

let camImg = null;

// ---------- State ----------
const State = {
  running: false,               // detection on/off
  conf: parseFloat(localStorage.getItem('conf') || '0.50'),
  allowed: new Set(
    (localStorage.getItem('allowed') || 'person, cell phone, keyboard')
      .split(',')
      .map(s => s.trim().toLowerCase())
      .filter(Boolean)
  ),
  lastObjects: [],
  pollTimer: null,
  overlayOn: false,             // draw boxes or not
};

// ---------- UI init ----------
conf.value = String(State.conf);
confVal.textContent = State.conf.toFixed(2);
renderAllowedTable();

conf.oninput = () => {
  State.conf = parseFloat(conf.value) || 0;
  confVal.textContent = State.conf.toFixed(2);
  localStorage.setItem('conf', String(State.conf));
};

btnAddAllowed.onclick = () => {
  const labels = (allowedInput.value || '')
    .split(',')
    .map(s => s.trim().toLowerCase())
    .filter(Boolean);
  if (!labels.length) return;
  labels.forEach(l => State.allowed.add(l));
  allowedInput.value = '';
  persistAllowed();
  renderAllowedTable();
};

btnClearAllowed.onclick = () => {
  State.allowed.clear();
  persistAllowed();
  renderAllowedTable();
};

// ---------- Backend control helpers ----------
async function setModeObjectsOnly(enable) {
  // objects only; faces OFF
  try {
    await fetch(`${RASPI_BASE}/api/vision/mode`, {
      method: 'POST',
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify({
        detect_faces: false,
        detect_objects: !!enable
      })
    });
  } catch (_) {}
}

async function setOverlayEnabled(enable) {
  try {
    await fetch(`${RASPI_BASE}/api/vision/overlay`, {
      method: 'POST',
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ enabled: !!enable })
    });
  } catch (_) {}
}

// ---------- Stream handling (Pi MJPEG) ----------
function ensureCamImg() {
  if (camImg) return camImg;
  camImg = document.createElement('img');
  camImg.id = 'cam_mjpg';
  camImg.alt = 'Camera';
  camImg.style.display = 'block';
  camImg.style.width = '100%';
  camImg.style.height = 'auto';
  camImg.style.opacity = '0.98';

  const wrap = document.querySelector('.stream-wrap');
  const video = document.getElementById('cam');
  if (video && video.parentNode === wrap) {
    wrap.insertBefore(camImg, video);
    video.style.display = 'none';
  } else {
    wrap.prepend(camImg);
  }

  const updateSize = () => {
    const r = camImg.getBoundingClientRect();
    overlay.width = r.width;
    overlay.height = r.height;
    ctx.clearRect(0, 0, overlay.width, overlay.height);
  };
  new ResizeObserver(updateSize).observe(camImg);
  updateSize();
  return camImg;
}

function streamUrl({ overlayOn }) {
  // overlay parameter is just a hint; backend obeys /api/vision/overlay
  const o = overlayOn ? 1 : 0;
  return `${RASPI_BASE}/api/cam?overlay=${o}&kind=obj&_ts=${Date.now()}`;
}

async function startStream(forceReload = false) {
  const img = ensureCamImg();
  const url = streamUrl({ overlayOn: State.overlayOn });
  if (forceReload || img.src !== url) img.src = url;
  img.onerror = () => { statusEl.textContent = 'feed error'; };
}

btnRefresh.onclick = async () => {
  await startStream(true);
  statusEl.textContent = 'feed refreshed';
};

// ---------- Poll detections from the Pi (objects ONLY) ----------
async function fetchDetections() {
  try {
    const r = await fetch(`${RASPI_BASE}/api/vision/detections`, { cache: 'no-store' });
    if (!r.ok) return;
    const j = await r.json();
    const objs = Array.isArray(j?.objects) ? j.objects : [];

    // Confidence filter if scores present
    const filtered = objs.filter(o => (typeof o.score !== 'number') || o.score >= State.conf);

    State.lastObjects = filtered.map(o => ({
      label: o.label ?? String(o),
      score: typeof o.score === 'number' ? o.score : 1,
      box: Array.isArray(o.box) ? o.box : null
    }));
    renderSide(State.lastObjects);
  } catch (_) { /* ignore transient errors */ }
}

function startPolling() {
  if (State.pollTimer) return;
  State.pollTimer = setInterval(fetchDetections, 250); // ~4 Hz
  fetchDetections();
}

function stopPolling() {
  if (State.pollTimer) {
    clearInterval(State.pollTimer);
    State.pollTimer = null;
  }
  State.lastObjects = [];
  detSummary.textContent = 'Detected: 0 objects';
  detListOk.innerHTML = '';
  detListForeign.innerHTML = '';
  legend.textContent = '';
}

// ---------- Lists / legend ----------
function isAllowedLabel(label){
  return State.allowed.has((label || '').toLowerCase());
}

function renderSide(objs){
  // Total objects detected (sum across classes)
  const total = objs.length;

  // Per-class counts (kept as a breakdown)
  const byClass = new Map();
  objs.forEach(o => byClass.set(o.label, (byClass.get(o.label) || 0) + 1));

  // Legend: show total first, then per-class lines
  const lines = [`Objects Detected: <code>${total}</code>`];
  for (const [k, v] of byClass.entries()) lines.push(`${k}: <code>${v}</code>`);
  legend.innerHTML = lines.join('<br>');

  // Allowed vs Foreign lists (only show currently detected objects)
  const ok = [], foreign = [];
  for (const o of objs){ (isAllowedLabel(o.label) ? ok : foreign).push(o); }

  detSummary.textContent = `Detected: ${total} object${total !== 1 ? 's' : ''}`;
  detListOk.innerHTML = ok.map(o => `<li><span>${escapeHtml(o.label)}</span><span class="badge">Detected</span></li>`).join('');
  detListForeign.innerHTML = foreign.map(o => `<li><span>${escapeHtml(o.label)}</span><span class="badge foreign">Foreign</span></li>`).join('');
}


// ---------- Start/Stop (detection + overlay) ----------
btnStart.onclick = async () => {
  if (State.running) return;
  State.running = true;

  await setModeObjectsOnly(true);   // objects ON, faces OFF
  await setOverlayEnabled(true);    // draw boxes
  State.overlayOn = true;
  await startStream(true);

  startPolling();
  statusEl.textContent = 'detecting (objects)';
};

btnStop.onclick = async () => {
  if (!State.running) return;
  State.running = false;

  stopPolling();
  await setModeObjectsOnly(false);  // detectors OFF
  await setOverlayEnabled(false);   // no boxes
  State.overlayOn = false;
  await startStream(true);

  statusEl.textContent = 'idle';
};

// ---------- Helpers ----------
function escapeHtml(s){ return String(s).replace(/[&<>\"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;"}[c])); }
function persistAllowed(){
  localStorage.setItem('allowed', Array.from(State.allowed).join(','));
}
function renderAllowedTable(){
  const rows = Array.from(State.allowed).sort().map(label => `
    <tr>
      <td>${escapeHtml(label)}</td>
      <td>
        <div class="row-actions">
          <button class="btn danger" data-act="del" data-label="${escapeHtml(label)}">Delete</button>
        </div>
      </td>
    </tr>
  `).join('');
  allowedBody.innerHTML = rows || `<tr><td colspan="2" class="muted">No allowed labels yet.</td></tr>`;
  allowedCount.textContent = `${State.allowed.size} item${State.allowed.size!==1?'s':''}`;

  allowedBody.querySelectorAll('button[data-act="del"]').forEach(btn => {
    btn.onclick = () => {
      const lab = btn.getAttribute('data-label');
      State.allowed.delete(lab);
      persistAllowed();
      renderAllowedTable();
    };
  });
}

// ---------- Start the camera feed on page load (NO overlay, NO detection) ----------
document.addEventListener('DOMContentLoaded', async () => {
  State.overlayOn = false;
  await setModeObjectsOnly(false);   // detectors off at idle
  await setOverlayEnabled(false);    // boxes off at idle
  await startStream(true);           // feed running
  statusEl.textContent = 'feed ready (idle)';
});
