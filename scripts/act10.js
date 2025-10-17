(function(){
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
  const ovl        = $('#enrollOverlay');
  const btnCancel  = $('#btnCancel');

  // Adjust to your Pi:
  const HOST = '192.168.1.48';
  const BASE = `${location.protocol}//${HOST || location.hostname}:5000`;

  let allow = [];
  let detectOn = false;

  const norm = s => (s||'').toLowerCase().replace(/[^a-z0-9]+/g,'');

  function setImg(src){
    elImg.onload = ()=>{};
    elImg.onerror= ()=>{};
    elImg.src = src;
  }
  let refreshBusy = false;
  function refreshStream(){
    if (refreshBusy) return;
    refreshBusy = true;
    const url = `${BASE}/api/cam?v=${Date.now()}`;
    elImg.onload  = ()=>{ refreshBusy = false; };
    elImg.onerror = ()=>{ refreshBusy = false; };
    elImg.src = url;
  }

  function renderTags(){
    tagsBox.innerHTML = '';
    for (const lbl of allow){
      const chip = document.createElement('span');
      chip.className = 'tag';
      chip.innerHTML = `${lbl} <span class="x" title="remove">×</span>`;
      chip.querySelector('.x').onclick = ()=>{
        const n = norm(lbl);
        allow = allow.filter(x => norm(x) !== n);
        syncAllow();
      };
      tagsBox.appendChild(chip);
    }
  }
  async function syncAllow(){
    try{
      await fetch(`${BASE}/api/vision/allow`, {
        method:'POST', headers:{'Content-Type':'application/json'},
        body: JSON.stringify({allow})
      });
    }catch{}
    renderTags();
    refreshStream();
  }

  async function pollStatus(){
    try{
      const r = await fetch(`${BASE}/api/vision/status`, {cache:'no-store'});
      const j = await r.json();

      const fps = Number(j.fps || 0);
      statFps.textContent   = (fps>0 && Number.isFinite(fps)) ? fps.toFixed(1) : '0.0';
      statFaces.textContent = String(j.faces ?? 0);
      statObjs.textContent  = String(j.objects ?? 0);

      // keep local truth in sync
      detectOn = !!(j.vision && j.vision.enabled);
      btnToggle.textContent = `detection: ${detectOn ? 'on' : 'off'}`;

      if (j.vision && Array.isArray(j.vision.allow)) {
        const incoming = j.vision.allow.map(String);
        if (JSON.stringify(incoming) !== JSON.stringify(allow)) {
          allow = incoming;
          renderTags();
        }
      }
    }catch{
      statFps.textContent='0.0'; statFaces.textContent='0'; statObjs.textContent='0';
    }
  }
  setInterval(pollStatus, 1000);

  async function toggleDetection(){
    const want = !detectOn;
    btnToggle.disabled = true;
    try{
      await fetch(`${BASE}/api/vision/overlay`, {
        method:'POST', headers:{'Content-Type':'application/json'},
        body: JSON.stringify({enabled: want})
      });
      const s = await (await fetch(`${BASE}/api/vision/status`, {cache:'no-store'})).json();
      detectOn = !!(s.vision && s.vision.enabled);
      btnToggle.textContent = `detection: ${detectOn ? 'on' : 'off'}`;
      refreshStream();
    }finally{
      btnToggle.disabled = false;
    }
  }

  async function addObject(){
    const raw = (objInput.value || '').trim();
    if (!raw) return;
    const want = norm(raw);
    let allowed = true;
    try{
      const r = await fetch(`${BASE}/api/vision/labels`, {cache:'no-store'});
      const j = await r.json();
      const set = new Set((j.labels || []).map(norm));
      if (set.size && !set.has(want)) allowed = false; // enforce only if we have labels list
    }catch{}
    if (!allowed){
      objMsg.textContent = `"${raw}" not in model labels — not added.`;
      return;
    }
    objMsg.textContent = '';
    if (!allow.some(x => norm(x) === want)){
      allow.push(raw);
      syncAllow();
    }
    objInput.value='';
  }

  // simple overlay UI
  function openEnroll(){ ovl.classList.remove('hidden'); }
  function closeEnroll(){ ovl.classList.add('hidden'); }

  // wire
  btnRefresh.onclick = refreshStream;
  btnToggle.onclick  = toggleDetection;
  btnAdd.onclick     = addObject;
  btnEnroll.onclick  = openEnroll;
  btnCancel.onclick  = closeEnroll;

  // boot
  refreshStream();
  pollStatus();
})();
