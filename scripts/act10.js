(() => {
  const $ = (s, e = document) => e.querySelector(s);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const toast = (m, ms = 2200) => { const t = $("#toast"); t.textContent = m; t.classList.add("show"); setTimeout(() => t.classList.remove("show"), ms); };
  const setPrompt = (m) => { const el = $("#promptBar"); if (el) el.textContent = m; };

  const DB_KEY = "efs-db-v1";
  const store = {
    load() { try { return JSON.parse(localStorage.getItem(DB_KEY)) || { admin: null, faces: [] }; } catch { return { admin: null, faces: [] }; } },
    save(d) { localStorage.setItem(DB_KEY, JSON.stringify(d)); }
  };
  let DB = store.load();

  const vid = $("#cam");
  const can = $("#overlay");
  const ctx = can.getContext("2d");
  const camDot = $("#camDot");
  const camText = $("#camText");
  const modelDot = $("#modelDot");
  const modelText = $("#modelText");
  const roleText = $("#roleText");
  const countdown = $("#countdown");

  let camStream = null, loopOn = false, modelsLoaded = false, readyLock = false;

  function resizeCanvasToDisplaySize() {
    const r = vid.getBoundingClientRect();
    const w = Math.round(r.width || innerWidth);
    const h = Math.round(r.height || innerHeight);
    if (can.width !== w || can.height !== h) { can.width = w; can.height = h; }
  }
  vid.addEventListener("loadedmetadata", resizeCanvasToDisplaySize);
  addEventListener("resize", resizeCanvasToDisplaySize);

  async function startCamera() {
    if (camStream) return;
    try {
      setPrompt("Requesting camera…");
      camStream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: "user", width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 30, max: 60 } },
        audio: false
      });
      vid.srcObject = camStream;
      await vid.play();
      resizeCanvasToDisplaySize();
      camDot.classList.add("status-running");
      camText.textContent = "Camera: ON";
      setPrompt("Camera ready.");
    } catch (e) {
      console.error(e);
      toast("Camera error: " + e.message, 4000);
      setPrompt("Camera error.");
    }
  }

  const MODEL_URL = "../resources/models/";
  async function loadModels() {
    if (modelsLoaded) return;
    try {
      setPrompt("Loading models…");
      await Promise.all([
        faceapi.nets.tinyFaceDetector.loadFromUri(MODEL_URL),
        faceapi.nets.faceLandmark68Net.loadFromUri(MODEL_URL),
        faceapi.nets.faceRecognitionNet.loadFromUri(MODEL_URL)
      ]);
      try { await faceapi.nets.ssdMobilenetv1.loadFromUri(MODEL_URL); } catch {}
      modelsLoaded = true;
      modelDot.classList.add("status-running");
      modelText.textContent = "Models: Loaded";
      setPrompt("Models loaded.");
      toast("Models ready.");
    } catch (e) {
      console.error("Model load failed", e);
      toast("Model load failed. See console.", 4000);
      setPrompt("Model load failed — check /resources/models.");
    }
  }

  async function ensureReady() {
    if (readyLock) return;
    readyLock = true;
    await startCamera();
    await loadModels();
    if (!vid.videoWidth) setPrompt("Camera not ready — click Start and allow permission.");
    readyLock = false;
  }

  function l2(a, b) { let s = 0; for (let i = 0; i < a.length; i++) { const d = a[i] - b[i]; s += d * d; } return Math.sqrt(s); }

  function nearestWithMargin(desc) {
    if (!DB.faces.length) return { best: null, second: null };
    let best = { name: null, role: null, dist: Infinity };
    let second = { name: null, role: null, dist: Infinity };
    for (const f of DB.faces) {
      for (const d of f.descriptors) {
        const dist = l2(d, desc);
        if (dist < best.dist) { second = best; best = { name: f.name, role: f.role, dist }; }
        else if (dist < second.dist) { second = { name: f.name, role: f.role, dist }; }
      }
    }
    return { best, second };
  }

  const TH_NORMAL = 0.52;
  const TH_SINGLE = 0.44;
  const MARGIN = 0.05;
  const VOTE_WINDOW = 8;
  const VOTE_NEED = 5;

  function classifyOpenSet(descriptor) {
    const { best, second } = nearestWithMargin(descriptor);
    if (!best) return null;
    const onlyOne = DB.faces.length === 1;
    const th = onlyOne ? TH_SINGLE : TH_NORMAL;
    if (best.dist >= th) return null;
    if (second && (second.dist - best.dist) < MARGIN) return null;
    return { name: best.name, role: best.role, dist: best.dist };
  }

  const votes = [];
  function pushVote(label) { votes.push({ label }); if (votes.length > VOTE_WINDOW) votes.shift(); }
  function currentDecision() {
    if (!votes.length) return null;
    const counts = new Map();
    for (const v of votes) { const key = v.label || "Unknown"; counts.set(key, (counts.get(key) || 0) + 1); }
    let bestKey = null, bestCount = 0;
    for (const [k, c] of counts.entries()) if (c > bestCount) { bestKey = k; bestCount = c; }
    if (bestKey !== "Unknown" && bestCount >= VOTE_NEED) return bestKey;
    return null;
  }

  const tinyOpts = new faceapi.TinyFaceDetectorOptions({ inputSize: 640, scoreThreshold: 0.3 });
  const ssdOpts = new faceapi.SsdMobilenetv1Options({ minConfidence: 0.25 });

  async function detectAll() {
    let dets = await faceapi.detectAllFaces(vid, tinyOpts).withFaceLandmarks().withFaceDescriptors();
    if (!dets || dets.length === 0) { try { dets = await faceapi.detectAllFaces(vid, ssdOpts).withFaceLandmarks().withFaceDescriptors(); } catch {} }
    return dets;
  }
  async function detectOnce() {
    let dets = await faceapi.detectAllFaces(vid, tinyOpts).withFaceLandmarks().withFaceDescriptors();
    if (!dets || dets.length === 0) { try { dets = await faceapi.detectAllFaces(vid, ssdOpts).withFaceLandmarks().withFaceDescriptors(); } catch {} }
    return dets;
  }

  async function loop() {
    if (loopOn || !modelsLoaded || !vid.videoWidth) return;
    loopOn = true;
    while (loopOn) {
      const dets = await detectAll();
      const sized = faceapi.resizeResults(dets, { width: can.width, height: can.height });
      render(sized);
      await sleep(60);
    }
  }

  function render(results) {
    const w = can.width, h = can.height;
    ctx.clearRect(0, 0, w, h);

    let target = null, maxA = 0;
    for (const r of results) {
      const b = r.detection.box; const A = b.width * b.height;
      if (A > maxA) { maxA = A; target = r; }
    }

    if (target) {
      const b = target.detection.box;
      ctx.strokeStyle = "#60a5fa"; ctx.lineWidth = 3; ctx.strokeRect(b.x, b.y, b.width, b.height);

      const cls = classifyOpenSet(Array.from(target.descriptor));
      let uiRole = "—";
      let liveLabel = null;
      if (cls) { liveLabel = `${cls.name} (${cls.role || "—"})`; uiRole = cls.role || "—"; }
      pushVote(liveLabel ? liveLabel : null);
      const decided = currentDecision();
      const label = decided || "Unknown";

      const pad = 6, ty = Math.max(0, b.y - 28);
      ctx.font = "700 16px Inter, system-ui, sans-serif";
      const tw = ctx.measureText(label).width;
      ctx.fillStyle = "rgba(15,23,34,.85)";
      ctx.fillRect(b.x, ty, tw + pad * 2, 24);

      ctx.save();
      ctx.setTransform(-1, 0, 0, 1, can.width, 0);
      const drawX = can.width - b.x - (tw + pad * 2);
      ctx.fillStyle = "#e7edf3";
      ctx.fillText(label, drawX + pad, ty + 16);
      ctx.restore();

      roleText.textContent = decided ? (decided.match(/\((.*?)\)$/)?.[1] || "—") : "—";
    } else {
      roleText.textContent = "—";
    }
  }

  const meanPt = (pts) => pts.reduce((a, p) => ({ x: a.x + p.x, y: a.y + p.y }), { x: 0, y: 0 });
  const norm = (m, n) => ({ x: m.x / n, y: m.y / n });
  function yawNorm(r) {
    const lm = r.landmarks, nose = lm.getNose(), LE = lm.getLeftEye(), RE = lm.getRightEye();
    const nc = norm(meanPt(nose), nose.length), lec = norm(meanPt(LE), LE.length), rec = norm(meanPt(RE), RE.length);
    const eyes = { x: (lec.x + rec.x) / 2, y: (lec.y + rec.y) / 2 };
    const bw = r.detection.box.width || 1;
    return (nc.x - eyes.x) / bw;
  }
  function boxFrac(r) { const b = r.detection.box; return (b.width * b.height) / (can.width * can.height); }

  function meetsPose(r, stage) {
    const yaw = yawNorm(r);
    const MIN = 0.10, MAX = 0.30;
    switch (stage) {
      case "front": return Math.abs(yaw) < 0.06;
      case "left":  return yaw > MIN && yaw < MAX;
      case "right": return yaw < -MIN && yaw > -MAX;
      default: return true;
    }
  }

  async function waitForFace(ms = 8000) {
    const t0 = performance.now();
    while (performance.now() - t0 < ms) {
      const dets = await detectOnce();
      if (dets && dets.length) return dets;
      await sleep(200);
    }
    return null;
  }

  async function captureStage(stage, need = 3) {
    const bag = []; let tries = 0;
    while (bag.length < need && tries < 120) {
      const dets = await detectOnce();
      if (dets && dets.length) {
        let best = dets[0], A = 0;
        for (const r of dets) { const b = r.detection.box; const a = b.width * b.height; if (a > A) { A = a; best = r; } }
        if (meetsPose(best, stage)) { bag.push(Array.from(best.descriptor)); await sleep(160); }
      }
      tries++; await sleep(120);
    }
    return bag;
  }

  function meanVec(V) {
    if (!V.length) return [];
    const out = new Array(V[0].length).fill(0);
    for (const v of V) for (let i = 0; i < v.length; i++) out[i] += v[i];
    for (let i = 0; i < out.length; i++) out[i] /= V.length;
    return out;
  }

  async function guidedSequence() {
    setPrompt("Now looking for a face, please face the camera.");
    const presence = await waitForFace(8000);
    if (!presence) { toast("No face detected. Check lighting and center your face."); return []; }
    const seq = [["front", 3], ["left", 3], ["right", 3]];
    const all = [];
    for (const [st, n] of seq) {
      setPrompt(`Hold still — ${st}`);
      const part = await captureStage(st, n);
      all.push(...part);
    }
    setPrompt(`Capture complete: ${all.length} samples.`);
    toast(`Captured ${all.length} samples.`);
    return all;
  }

  const hasAdmin = () => DB.admin && DB.admin.pin && DB.admin.name;

  function adminDescriptors() {
    const arr = [];
    if (!DB.admin) return arr;
    for (const f of DB.faces) if (f.name === DB.admin.name && f.role === "Admin") for (const d of f.descriptors) arr.push(d);
    return arr;
  }

  async function verifyAdminByFace(timeoutSec = 10) {
    if (!hasAdmin()) return false;
    const adminVecs = adminDescriptors();
    if (!adminVecs.length) return false;

    countdown.hidden = false;
    let remaining = timeoutSec;
    countdown.textContent = remaining;
    const tick = setInterval(() => {
      remaining -= 1;
      countdown.textContent = remaining;
      if (remaining <= 3) countdown.setAttribute("countdown-warning", "");
      else countdown.removeAttribute("countdown-warning");
    }, 1000);

    const TH_VERIFY = 0.50;
    const NEED_CONSEC = 3;
    let consecutive = 0;
    const t0 = performance.now();
    let ok = false;

    while (performance.now() - t0 < timeoutSec * 1000) {
      const dets = await detectOnce();
      if (dets && dets.length) {
        let best = dets[0], A = 0;
        for (const r of dets) { const b = r.detection.box; const a = b.width * b.height; if (a > A) { A = a; best = r; } }
        const d = Array.from(best.descriptor);
        let minToAdmin = Infinity;
        for (const av of adminVecs) { const dist = l2(av, d); if (dist < minToAdmin) minToAdmin = dist; }
        if (minToAdmin < TH_VERIFY) { consecutive += 1; if (consecutive >= NEED_CONSEC) { ok = true; break; } }
        else { consecutive = 0; }
      }
      await sleep(120);
    }

    clearInterval(tick);
    countdown.hidden = true;
    countdown.removeAttribute("countdown-warning");
    return ok;
  }

  $("#btnStart").addEventListener("click", async () => { await ensureReady(); await loop(); });
  $("#btnLoad").addEventListener("click", loadModels);
  $("#btnReset").addEventListener("click", () => {
    if (confirm("Clear all enrollments?")) {
      DB = { admin: null, faces: [] };
      store.save(DB);
      toast("Cleared. Reload.");
      setPrompt("Ready.");
      roleText.textContent = "—";
    }
  });

  $("#btnEnroll").addEventListener("click", () => {
    if (!hasAdmin()) {
      $("#mdlAdmin").showModal();
    } else {
      $("#enName").value = "";
      const roleSel = $("#enRole");
      if (roleSel.tagName.toLowerCase() === "select") roleSel.value = "Student";
      else roleSel.value = "Student";
      const pinRow = $("#enPinRow");
      if (pinRow) { $("#enPin").value = ""; pinRow.hidden = true; }
      $("#mdlEnroll").showModal();
    }
  });

  const roleInput = $("#enRole");
  if (roleInput && roleInput.tagName.toLowerCase() === "select") {
    roleInput.addEventListener("change", () => {
      const role = $("#enRole").value;
      const pinRow = $("#enPinRow");
      if (pinRow) pinRow.hidden = role !== "Admin";
    });
  }

  $("#adminCreateGo").addEventListener("click", async () => {
    const name = $("#adminName").value.trim();
    const p1 = $("#adminPin").value.trim();
    const p2 = $("#adminPin2").value.trim();
    if (!name || p1.length < 4 || p1 !== p2) { toast("Fill name, PIN (≥4), and confirm correctly."); return; }

    $("#mdlAdmin").close();
    await ensureReady();
    await loop();

    const samples = await guidedSequence();
    if (samples.length < 9) { toast("Not enough quality samples. Try again."); return; }
    const centroid = meanVec(samples);

    DB.admin = { name, pin: p1 };
    DB.faces.push({ name, role: "Admin", descriptors: [centroid] });
    store.save(DB);
    setPrompt(`Admin ${name} enrolled successfully.`);
    toast(`Admin ${name} enrolled.`);
  });

  $("#enGo").addEventListener("click", async () => {
    const name = $("#enName").value.trim();
    let role = ($("#enRole").value || "Student").trim();
    const pinRow = $("#enPinRow");
    const pin = $("#enPin") ? $("#enPin").value.trim() : "";
    if (!name) { toast("Enter name."); return; }
    if (role === "Admin" && (!pinRow || !pin || pin.length < 4)) { toast("Set a valid PIN for Admin (≥4)."); return; }

    $("#mdlEnroll").close();
    await ensureReady();
    await loop();

    const samples = await guidedSequence();
    if (samples.length < 9) { toast("Not enough quality samples. Try again."); return; }
    const centroid = meanVec(samples);

    setPrompt("Admin verification: look into the camera.");
    const ok = await verifyAdminByFace(10);
    if (!ok) { toast("Admin verification failed or timed out."); setPrompt("Verification failed."); return; }

    if (role === "Admin") {
      DB.faces.push({ name, role: "Admin", descriptors: [centroid] });
    } else {
      DB.faces.push({ name, role: "Student", descriptors: [centroid] });
    }
    store.save(DB);
    setPrompt(`Enrolled: ${name} (${role}).`);
    toast(`Enrolled: ${name} (${role})`);
  });

  document.querySelectorAll("dialog [data-close]").forEach((b) =>
    b.addEventListener("click", (e) => e.target.closest("dialog").close())
  );

  (async () => { try { await startCamera(); await loadModels(); await loop(); } catch {} })();
})();
