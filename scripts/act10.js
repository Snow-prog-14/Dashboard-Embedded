/* Face + Object page JS (updated for new index.py / vision.py APIs)
   - Stream:           GET  /api/cam           (overlay controlled server-side)
   - Status:           GET  /api/vision/status
   - Mode switches:    POST /api/vision/mode   {detect_faces, detect_objects, overlay}
   - Allow labels:     POST /api/vision/allow  {allow: [...]}
   - Labels list:      GET  /api/vision/labels
   - Enroll (faces):   /api/face/enroll_*
   - Release camera:   POST /api/vision/release
*/
(function () {
  const $ = s => document.querySelector(s);

  const elImg      = $('#camFeed');
  const btnRefresh = $('#btnRefresh');
  const btnToggle  = $('#btnToggle');
  const btnEnroll  = $('#btnEnroll');
  const statFps    = $('#statFps');
  const statFaces  = $('#statFaces');
  const statObjs   = $('#statObjs');
  const tagsBox    = $('#tags');
  const objInput   = $('#objInput');
  const btnAdd     = $('#btnAdd');
  const objMsg     = $('#objMsg');

  const HOST = '192.168.1.48';
  const BASE = `${location.protocol}//${HOST || location.hostname}:5000`;
  window.BASE = BASE;

  let allow = [];
  let detectOn = false;   // means: faces+objects+overlay enabled (for this page)
  let overlayOn = false;

  const norm = s => (s || '').toLowerCase().replace(/[^a-z0-9]+/g, '');

  function setImg(src) {
    elImg.onload = () => {};
    elImg.onerror = () => {};
    elImg.src = src;
  }

  // --- Stream helpers
  let refreshBusy = false;
  function streamUrl() {
    // overlay is controlled by /api/vision/mode; we add a cache buster
    return `${BASE}/api/cam?_ts=${Date.now()}`;
  }
  function refreshStream() {
    if (refreshBusy) return;
    refreshBusy = true;
    const url = streamUrl();
    elImg.onload = () => { refreshBusy = false; };
    elImg.onerror = () => { refreshBusy = false; };
    elImg.src = url;
  }
  function stopStream() {
    // tear down MJPEG connection
    elImg.src = '';
  }

  // --- Allowed labels UI
  function renderTags() {
    tagsBox.innerHTML = '';
    for (const lbl of allow) {
      const chip = document.createElement('span');
      chip.className = 'tag';
      chip.innerHTML = `${lbl} <span class="x" title="remove">×</span>`;
      chip.querySelector('.x').onclick = () => {
        const n = norm(lbl);
        allow = allow.filter(x => norm(x) !== n);
        syncAllow();
      };
      tagsBox.appendChild(chip);
    }
  }
  async function syncAllow() {
    try {
      await fetch(`${BASE}/api/vision/allow`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ allow })
      });
    } catch {}
    renderTags();
    refreshStream();
  }

  async function addObject() {
    const raw = (objInput.value || '').trim();
    if (!raw) return;
    const want = norm(raw);
    let allowedInModel = true;
    try {
      const r = await fetch(`${BASE}/api/vision/labels`, { cache: 'no-store' });
      const j = await r.json();
      const set = new Set((j.labels || []).map(norm));
      if (set.size && !set.has(want)) allowedInModel = false;
    } catch {}
    if (!allowedInModel) {
      objMsg.textContent = `"${raw}" not in model labels — not added.`;
      return;
    }
    objMsg.textContent = '';
    if (!allow.some(x => norm(x) === want)) {
      allow.push(raw);
      syncAllow();
    }
    objInput.value = '';
  }

  // --- Status poll
  async function pollStatus() {
    try {
      const r = await fetch(`${BASE}/api/vision/status`, { cache: 'no-store' });
      const j = await r.json();

      const fps = Number(j.fps || 0);
      statFps.textContent = (fps > 0 && Number.isFinite(fps)) ? fps.toFixed(1) : '0.0';
      statFaces.textContent = String(j.faces ?? 0);
      statObjs.textContent = String(j.objects ?? 0);

      overlayOn = !!j.overlay;
      // For this page, "detection on" means both detectors + overlay are enabled
      detectOn = !!(j.detect_faces && j.detect_objects && j.overlay);
      btnToggle.textContent = `detection: ${detectOn ? 'on' : 'off'}`;

      if (Array.isArray(j.allow)) {
        const incoming = j.allow.map(String);
        if (JSON.stringify(incoming) !== JSON.stringify(allow)) {
          allow = incoming;
          renderTags();
        }
      } else if (j.vision && Array.isArray(j.vision.allow)) {
        // backward compat
        const incoming = j.vision.allow.map(String);
        if (JSON.stringify(incoming) !== JSON.stringify(allow)) {
          allow = incoming;
          renderTags();
        }
      }
    } catch {
      statFps.textContent = '0.0';
      statFaces.textContent = '0';
      statObjs.textContent = '0';
    }
  }
  setInterval(pollStatus, 1000);

  // --- Toggle detection (faces + objects + overlay)
  async function toggleDetection() {
    const want = !detectOn;
    btnToggle.disabled = true;
    try {
      await fetch(`${BASE}/api/vision/mode`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          detect_faces: want,        // for this combined page we toggle BOTH
          detect_objects: want,
          overlay: want
        })
      });
      const s = await (await fetch(`${BASE}/api/vision/status`, { cache: 'no-store' })).json();
      detectOn = !!(s.detect_faces && s.detect_objects && s.overlay);
      btnToggle.textContent = `detection: ${detectOn ? 'on' : 'off'}`;
      refreshStream();
    } finally {
      btnToggle.disabled = false;
    }
  }

  // --- Wire up controls
  btnRefresh.onclick = refreshStream;
  btnToggle.onclick = toggleDetection;
  btnAdd.onclick = addObject;

  // --- Start feed on load, with detection OFF (faces/objects disabled, overlay disabled)
  (async function init() {
    try {
      await fetch(`${BASE}/api/vision/mode`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ detect_faces: false, detect_objects: false, overlay: false })
      });
    } catch {}
    refreshStream();
    pollStatus();
  })();

  // --- Cleanup on tab close: stop stream and free camera on Pi
  async function cleanupOnUnload() {
    try {
      stopStream();
      fetch(`${BASE}/api/vision/mode`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ detect_faces: false, detect_objects: false, overlay: false }),
        keepalive: true
      });
      fetch(`${BASE}/api/vision/release`, { method: 'POST', keepalive: true });
    } catch {}
  }
  window.addEventListener('pagehide', cleanupOnUnload, { capture: true });
  window.addEventListener('beforeunload', cleanupOnUnload);
  window.addEventListener('unload', cleanupOnUnload);
})();

/* ====== Face Enrollment HUD (unchanged, works with existing /api/face/enroll_* routes) ====== */
(function () {
  const BASE = window.BASE || `${location.protocol}//${(window.HOST || location.hostname)}:5000`;
  const elImg = document.querySelector('#camFeed');
  const btnEnroll = document.querySelector('#btnEnroll');

  function ensureWrap() {
    if (!elImg) return null;
    let wrap = document.getElementById('camWrap');
    if (!wrap) {
      wrap = document.createElement('div');
      wrap.id = 'camWrap';
      wrap.style.position = 'relative';
      wrap.style.display = 'inline-block';
      elImg.parentNode.insertBefore(wrap, elImg);
      wrap.appendChild(elImg);
    }
    return wrap;
  }

  function pill(t, tone) {
    const c = tone === 'ok' ? '#00d091'
      : tone === 'warn' ? '#ffb020'
      : tone === 'bad' ? '#ff5c5c'
      : 'rgba(255,255,255,.75)';
    return `<span style="display:inline-flex;align-items:center;padding:6px 10px;border-radius:999px;background:${c};color:#0a0f14;font-weight:600;font-size:12px;">${t}</span>`;
  }

  function mountHUD() {
    const wrap = ensureWrap();
    if (!wrap) return null;
    let hud = document.getElementById('camEnrollHud');
    if (hud) return hud;

    hud = document.createElement('div');
    hud.id = 'camEnrollHud';
    hud.style.position = 'absolute';
    hud.style.inset = '0';
    hud.style.pointerEvents = 'none';
    wrap.appendChild(hud);

    const pills = document.createElement('div');
    pills.id = 'hudPills';
    pills.style.position = 'absolute';
    pills.style.left = '12px';
    pills.style.top = '12px';
    pills.style.display = 'flex';
    pills.style.gap = '8px';
    hud.appendChild(pills);

    const guide = document.createElement('div');
    guide.id = 'hudGuide';
    guide.style.position = 'absolute';
    guide.style.left = '50%';
    guide.style.top = '50%';
    guide.style.width = '40%';
    guide.style.height = '60%';
    guide.style.transform = 'translate(-50%,-50%)';
    guide.style.border = '3px solid rgba(255,255,255,.85)';
    guide.style.borderRadius = '50% / 60%';
    guide.style.boxShadow = '0 0 0 9999px rgba(0,0,0,.08) inset';
    hud.appendChild(guide);

    const prog = document.createElement('div');
    prog.id = 'hudProg';
    prog.style.position = 'absolute';
    prog.style.left = '12px';
    prog.style.right = '56px';
    prog.style.bottom = '16px';
    prog.style.height = '10px';
    prog.style.background = 'rgba(0,0,0,.35)';
    prog.style.borderRadius = '999px';
    prog.style.overflow = 'hidden';
    hud.appendChild(prog);

    const bar = document.createElement('div');
    bar.id = 'hudProgBar';
    bar.style.height = '100%';
    bar.style.width = '0%';
    bar.style.background = '#00d091';
    prog.appendChild(bar);

    const txt = document.createElement('div');
    txt.id = 'hudProgText';
    txt.style.position = 'absolute';
    txt.style.left = '12px';
    txt.style.bottom = '34px';
    txt.style.color = '#e7f0f7';
    txt.style.font = '600 12px system-ui,Segoe UI,Roboto,Ubuntu,Arial,sans-serif';
    hud.appendChild(txt);

    const x = document.createElement('button');
    x.id = 'hudCancel';
    x.textContent = '×';
    x.type = 'button';
    x.style.position = 'absolute';
    x.style.top = '12px';
    x.style.right = '12px';
    x.style.width = '32px';
    x.style.height = '32px';
    x.style.border = '0';
    x.style.borderRadius = '8px';
    x.style.background = 'rgba(0,0,0,.55)';
    x.style.color = '#fff';
    x.style.cursor = 'pointer';
    x.style.pointerEvents = 'auto';
    x.addEventListener('click', () => Enroll.stop());
    hud.appendChild(x);

    return hud;
  }

  function unmountHUD() {
    const hud = document.getElementById('camEnrollHud');
    if (hud && hud.parentNode) hud.parentNode.removeChild(hud);
  }

  function updateHUD(st) {
    const pills = document.getElementById('hudPills');
    const bar = document.getElementById('hudProgBar');
    const txt = document.getElementById('hudProgText');
    const arr = [];
    if (st.lighting === 'low') arr.push(pill('low lighting', 'bad'));
    if (st.distance === 'closer') arr.push(pill('move closer', 'warn'));
    if (st.distance === 'farther') arr.push(pill('move farther', 'warn'));
    if (st.pose && st.pose !== 'front') arr.push(pill('face the camera', 'warn'));
    if (!st.center_ok) arr.push(pill('center your face', 'warn'));
    if (st.ready) arr.push(pill('hold still', 'ok'));
    if (pills) pills.innerHTML = arr.join('');
    const pct = Math.round((st.samples || 0) * 100 / Math.max(1, (st.target || 10)));
    if (bar) bar.style.width = `${Math.max(0, Math.min(100, pct))}%`;
    if (txt) txt.textContent = `capturing: ${st.samples || 0} / ${st.target || 10}`;
  }

  const Enroll = {
    running: false, timer: null, session: null, target: 10, samples: 0,
    async start() {
      if (this.running) return;
      mountHUD();
      this.running = true;
      try {
        const r = await fetch(`${BASE}/api/face/enroll_start`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ target: 10 })
        });
        const j = await r.json();
        this.session = j.session; this.target = j.target || 10; this.samples = 0;
        this.loop();
      } catch (e) {
        this.stop();
      }
    },
    async loop() {
      if (!this.running) return;
      try {
        const r = await fetch(`${BASE}/api/face/enroll_check`, { cache: 'no-store' });
        const st = await r.json();
        this.samples = st.samples || 0; this.target = st.target || this.target;
        updateHUD(st);
        if (st.ready) {
          const c = await fetch(`${BASE}/api/face/enroll_capture`, { method: 'POST' });
          const cj = await c.json();
          this.samples = cj.samples || this.samples;
          updateHUD({ samples: this.samples, target: this.target, ready: true, lighting: st.lighting, distance: st.distance, center_ok: st.center_ok, pose: st.pose });
          if (cj.done) {
            const name = (prompt('Enter name for this face label:') || '').trim();
            if (name) {
              await fetch(`${BASE}/api/face/enroll_commit`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name })
              });
            }
            this.stop();
            return;
          }
        }
      } catch (e) {}
      this.timer = setTimeout(() => this.loop(), 200);
    },
    stop() {
      this.running = false;
      if (this.timer) { clearTimeout(this.timer); this.timer = null; }
      unmountHUD();
    }
  };

  if (btnEnroll) {
    btnEnroll.onclick = null;
    btnEnroll.addEventListener('click', (e) => { e.preventDefault(); Enroll.start(); });
  }
  window.Enroll = Enroll;
})();
