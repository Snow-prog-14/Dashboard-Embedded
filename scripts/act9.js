// ---------- Elements ----------
const $ = s => document.querySelector(s);
const video = $('#cam');
const overlay = $('#overlay');
const ctx = overlay.getContext('2d');

const conf = $('#conf');
const confVal = $('#confVal');
const btnStart = $('#btnStart');
const btnStop = $('#btnStop');
const statusEl = $('#status');

const legend = $('#legend');
const detSummary = $('#detSummary');
const detListOk = $('#detListOk');
const detListForeign = $('#detListForeign');
const btnVerify = $('#btnVerify');
const verifyStatus = $('#verifyStatus');

// Sidebar (allowed)
const allowedBody = $('#allowedBody');
const allowedInput = $('#allowedInput');
const btnAddAllowed = $('#btnAddAllowed');
const btnClearAllowed = $('#btnClearAllowed');
const btnImportFromCurrent = $('#btnImportFromCurrent');
const allowedCount = $('#allowedCount');
const partialMatch = $('#partialMatch');

// ---------- State ----------
const State = {
  running: false,
  model: null,
  conf: parseFloat(localStorage.getItem('conf') || '0.50'),
  allowed: new Set((localStorage.getItem('allowed') || 'person, cell phone, keyboard').split(',').map(s=>s.trim().toLowerCase()).filter(Boolean)),
  partial: localStorage.getItem('allowed_partial') === '1',
  frameW: 640, frameH: 480,
  lastObjects: [],
  latestForeign: [],
  tracks: new Map(), nextId: 1, maxAge: 10, maxDist: 80,
};

// ---------- UI init ----------
conf.value = String(State.conf);
confVal.textContent = State.conf.toFixed(2);
partialMatch.checked = State.partial;
renderAllowedTable();

// events
conf.oninput = () => {
  State.conf = parseFloat(conf.value) || 0;
  confVal.textContent = State.conf.toFixed(2);
  localStorage.setItem('conf', String(State.conf));
};

btnAddAllowed.onclick = () => {
  const labels = (allowedInput.value || '').split(',').map(s=>s.trim().toLowerCase()).filter(Boolean);
  if (!labels.length) return;
  labels.forEach(l => State.allowed.add(l));
  allowedInput.value = '';
  persistAllowed();
  renderAllowedTable();
};
btnClearAllowed.onclick = () => { State.allowed.clear(); persistAllowed(); renderAllowedTable(); };
btnImportFromCurrent.onclick = () => {
  // add all labels currently visible
  const labels = new Set(State.lastObjects.map(o => (o.label||'').toLowerCase()));
  for (const l of labels) State.allowed.add(l);
  persistAllowed();
  renderAllowedTable();
};
partialMatch.onchange = () => {
  State.partial = partialMatch.checked;
  localStorage.setItem('allowed_partial', State.partial ? '1':'0');
};

// ---------- Webcam ----------
async function openCamera() {
  const stream = await navigator.mediaDevices.getUserMedia({
    video: { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: 'user' },
    audio: false
  });
  video.srcObject = stream;
  await video.play();

  const updateSize = () => {
    const r = video.getBoundingClientRect();
    overlay.width = r.width;
    overlay.height = r.height;
  };
  new ResizeObserver(updateSize).observe(video);
  updateSize();
}

// ---------- Model ----------
async function loadModel() {
  statusEl.textContent = 'loading model…';
  State.model = await cocoSsd.load();  // lite_mobilenet_v2
  statusEl.textContent = 'model loaded';
}

// ---------- Tracking ----------
function updateTracks(objs) {
  const centers = objs.map(o => { const [x,y,w,h]=o.box; return {cx:x+w/2, cy:y+h/2}; });
  for (const t of State.tracks.values()) t.age += 1;

  const used = new Set();
  for (const [id,t] of Array.from(State.tracks.entries())) {
    let best=-1, bestD=1e9;
    centers.forEach((c,i)=>{ if(used.has(i)) return; const d=Math.hypot(c.cx-t.cx,c.cy-t.cy); if(d<bestD){bestD=d;best=i;} });
    if (best!==-1 && bestD<=State.maxDist) { t.cx=centers[best].cx; t.cy=centers[best].cy; t.age=0; objs[best].id=parseInt(id,10); used.add(best); }
  }
  centers.forEach((c,i)=>{ if(used.has(i)) return; const id=State.nextId++; State.tracks.set(String(id),{cx:c.cx,cy:c.cy,age:0}); objs[i].id=id; });
  for (const [id,t] of Array.from(State.tracks.entries())) if(t.age>State.maxAge) State.tracks.delete(id);
}

// ---------- Drawing ----------
function sx(x){ return x*(overlay.width/State.frameW); }
function sy(y){ return y*(overlay.height/State.frameH); }
function draw() {
  ctx.clearRect(0,0,overlay.width,overlay.height);
  ctx.lineWidth=2;
  for (const o of State.lastObjects) {
    const [x,y,w,h]=o.box; const X=sx(x),Y=sy(y),W=sx(w),H=sy(h);
    ctx.strokeStyle='#22c55e'; ctx.strokeRect(X,Y,W,H);
    const parts=[]; if(o.id!=null) parts.push(`#${o.id}`); parts.push(o.label); if(typeof o.score==='number') parts.push(`${(o.score*100).toFixed(0)}%`);
    const tag=parts.join(' · ');
    ctx.font='13px Inter, system-ui, Segoe UI, Roboto, Arial';
    const tw=ctx.measureText(tag).width+8, th=20;
    ctx.fillStyle='rgba(34,197,94,.15)'; ctx.fillRect(X,Math.max(0,Y-th-2),tw,th);
    ctx.fillStyle='#bbf7d0'; ctx.fillText(tag,X+4,Math.max(12,Y-6));
  }
}

// ---------- Lists / legend ----------
function isAllowedLabel(label){
  const L=(label||'').toLowerCase();
  if (State.partial){
    for (const a of State.allowed){ if (L.includes(a)) return true; }
    return false;
  }
  return State.allowed.has(L);
}

function renderSide(objs){
  const byClass=new Map(); objs.forEach(o=>byClass.set(o.label,(byClass.get(o.label)||0)+1));
  const lines=['Object Count:']; for(const [k,v] of byClass.entries()) lines.push(`${k}: <code>${v}</code>`); legend.innerHTML=lines.join('<br>');

  const ok=[], foreign=[]; for(const o of objs){ (isAllowedLabel(o.label)?ok:foreign).push(o); }
  State.latestForeign = foreign;

  detSummary.textContent=`Detected: ${objs.length} object${objs.length!==1?'s':''}`;
  detListOk.innerHTML = ok.map(o=>`<li><span>${escapeHtml(o.label)}</span><span class="badge">Detected</span></li>`).join('');
  detListForeign.innerHTML = foreign.map(o=>`<li><span>${escapeHtml(o.label)}</span><span class="badge foreign">Foreign</span></li>`).join('');
}

// ---------- Verify (mock or real) ----------
const VERIFIER_URL = null; // put a real endpoint here later if you want
btnVerify.onclick = async () => {
  const target = State.latestForeign[0];
  if (!target){ verifyStatus.textContent='no foreign objects'; return; }
  verifyStatus.textContent = `verifying ${target.label}…`;
  try{
    if (VERIFIER_URL){
      const url = new URL(VERIFIER_URL); url.searchParams.set('label', target.label);
      const r = await fetch(url, {method:'POST'}); const j = await r.json();
      verifyStatus.textContent = j.ok ? 'verified ok' : 'verification failed';
    }else{
      // frontend-only mock
      const ok = hash(target.label) % 3 !== 0;
      await new Promise(r=>setTimeout(r,600));
      verifyStatus.textContent = ok ? 'verified ok' : 'verification failed';
    }
  }catch(e){ verifyStatus.textContent='verify error'; console.error(e); }
};
function hash(s){ let h=0; for(let i=0;i<s.length;i++){ h=(h*131 + s.charCodeAt(i))|0; } return Math.abs(h); }

// ---------- Detection loop ----------
async function loop(){
  if(!State.running || !State.model) return;
  State.frameW = video.videoWidth || State.frameW;
  State.frameH = video.videoHeight || State.frameH;

  const preds = await State.model.detect(video);
  const objs = preds
    .filter(p => (typeof p.score!=='number') || p.score >= State.conf)
    .map(p => ({ id:null, label:p.class, score:p.score||0, box:[p.bbox[0],p.bbox[1],p.bbox[2],p.bbox[3]] }));

  updateTracks(objs);
  State.lastObjects = objs;

  draw();
  renderSide(objs);

  requestAnimationFrame(loop);
}

// ---------- Start/Stop ----------
btnStart.onclick = async () => {
  if(State.running) return;
  try{
    statusEl.textContent='starting camera…';
    await openCamera();
    if(!State.model) await loadModel();
    State.running = true; statusEl.textContent='running';
    loop();
  }catch(e){ statusEl.textContent='error: '+(e?.message||e); console.error(e); }
};
btnStop.onclick = () => {
  if(!State.running) return; State.running=false; statusEl.textContent='stopped';
  const stream=video.srcObject; if(stream){ stream.getTracks().forEach(t=>t.stop()); video.srcObject=null; }
  ctx.clearRect(0,0,overlay.width,overlay.height); detSummary.textContent='Detected: 0 objects'; detListOk.innerHTML=''; detListForeign.innerHTML=''; legend.textContent='';
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
          <button class="btn" data-act="up" data-label="${escapeHtml(label)}">↑</button>
          <button class="btn" data-act="down" data-label="${escapeHtml(label)}">↓</button>
          <button class="btn danger" data-act="del" data-label="${escapeHtml(label)}">Delete</button>
        </div>
      </td>
    </tr>
  `).join('');
  allowedBody.innerHTML = rows || `<tr><td colspan="2" class="muted">No allowed labels yet.</td></tr>`;
  allowedCount.textContent = `${State.allowed.size} item${State.allowed.size!==1?'s':''}`;

  // simple “reorder” by rebuilding the Set in clicked order
  allowedBody.querySelectorAll('button').forEach(btn => {
    btn.onclick = () => {
      const lab = btn.getAttribute('data-label');
      const arr = Array.from(State.allowed);
      const idx = arr.indexOf(lab);
      if (btn.dataset.act === 'del') { State.allowed.delete(lab); }
      if (btn.dataset.act === 'up' && idx>0) { [arr[idx-1],arr[idx]]=[arr[idx],arr[idx-1]]; State.allowed=new Set(arr); }
      if (btn.dataset.act === 'down' && idx<arr.length-1) { [arr[idx+1],arr[idx]]=[arr[idx],arr[idx+1]]; State.allowed=new Set(arr); }
      persistAllowed(); renderAllowedTable();
    };
  });
}