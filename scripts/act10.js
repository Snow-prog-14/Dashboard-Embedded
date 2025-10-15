(function () {
  const $ = s => document.querySelector(s);

  let elImg = $('#camFeed');
  const elDot = $('#statusDot');
  const elTxt = $('#statusText');
  const elFps = $('#statFps');
  const btnDet = $('#btnDetect');
  const btnRef = $('#btnRefresh');
  const btnEnroll = $('#btnEnroll');

  const BASE = 'http://192.168.1.48:5000';
  const STREAM = '/api/face';
  const STATUS = '/api/face/status';
  const OVERLAY = '/api/face/overlay';

  function setStatus(state){
    elTxt.textContent = state;
    elDot.classList.remove('online','offline','loading');
    if (state === 'online') elDot.classList.add('online');
    else if (state === 'connecting') elDot.classList.add('loading');
    else elDot.classList.add('offline');
  }

  let pollTimer = null;
  async function pollStatus(){
    try{
      const r = await fetch(BASE + STATUS, {cache:'no-store'});
      if (!r.ok) throw 0;
      const s = await r.json();
      setStatus('online');
      if (typeof s.fps === 'number') elFps.textContent = s.fps.toFixed(1);
      if (btnDet){
        btnDet.textContent = 'Detection: ' + (s.overlay ? 'On' : 'Off');
        btnDet.classList.toggle('on', !!s.overlay);
      }
    }catch{
      setStatus('offline');
      elFps.textContent = '0.0';
      if (btnDet){
        btnDet.textContent = 'Detection: Off';
        btnDet.classList.remove('on');
      }
    }
  }
  function startPolling(){
    if (pollTimer) return;
    pollTimer = setInterval(pollStatus, 1000);
    pollStatus();
  }

  function startStream(){
    setStatus('connecting');
    elImg.onload  = () => setStatus('online');
    elImg.onerror = () => setStatus('offline');
    elImg.src = BASE + STREAM + '?ts=' + Date.now();
    startPolling();
  }

  async function refreshStream(){
    if (btnRef) btnRef.disabled = true;
    setStatus('connecting');
    const parent = elImg.parentNode;
    const fresh = elImg.cloneNode(false);
    fresh.id = 'camFeed';
    parent.replaceChild(fresh, elImg);
    elImg = fresh;
    elImg.onload  = () => setStatus('online');
    elImg.onerror = () => setStatus('offline');
    elImg.src = BASE + STREAM + '?ts=' + Date.now();
    if (btnRef) btnRef.disabled = false;
  }

  async function toggleDetection(){
    const want = !btnDet.classList.contains('on');
    try{
      await fetch(BASE + OVERLAY, {
        method:'POST',
        headers:{'Content-Type':'application/json'},
        body: JSON.stringify({enabled: want})
      });
      btnDet.textContent = 'Detection: ' + (want ? 'On' : 'Off');
      btnDet.classList.toggle('on', want);
    }catch{}
  }

  btnDet && (btnDet.onclick = toggleDetection);
  btnRef && (btnRef.onclick = refreshStream);
  window.addEventListener('keydown', e => { if (e.key.toLowerCase() === 'r') refreshStream(); });

  startStream();

(function enrollOverlay(){
  const BASE = 'http://192.168.1.48:5000';
  const overlay = document.getElementById('enrollOverlay');
  const eoLight  = document.getElementById('eoLight');
  const eoCenter = document.getElementById('eoCenter');
  const eoDist   = document.getElementById('eoDist');
  const eoBar    = document.getElementById('eoBar');
  const btnEnroll= document.getElementById('btnEnroll');
  const btnScan  = document.getElementById('eoScan');
  const btnCancel= document.getElementById('eoCancel');

  let timer = null, capturing = false;

  function show(on){ overlay.classList.toggle('hidden', !on); }
  function cls(el, ok){ el.classList.remove('ok','warn'); el.classList.add(ok ? 'ok':'warn'); }

  async function start(){
    const r = await fetch(BASE + '/api/face/enroll/start', {method:'POST'});
    const j = await r.json();
    if (!j.ok) return;
    eoBar.style.width = '0%';
    capturing = false;
    show(true);
    poll();
    timer = setInterval(poll, 500);
  }

  async function poll(){
    const r = await fetch(BASE + '/api/face/enroll/check', {cache:'no-store'});
    const s = await r.json();

    const Ltxt = s.lighting === 'ok' ? 'Ok' : (s.lighting === 'low' ? 'Too Low' : 'Too Bright');
    eoLight.textContent  = 'Lighting: ' + Ltxt; cls(eoLight, s.lighting === 'ok');

    const Ctxt = s.center_ok ? 'Good' : 'Center Face';
    eoCenter.textContent = 'Look Straight: ' + Ctxt; cls(eoCenter, s.center_ok);

    const Dtxt = s.distance === 'ok' ? 'Good' : (s.distance === 'closer' ? 'Move Closer' : 'Move Further');
    eoDist.textContent   = 'Face Position: ' + Dtxt; cls(eoDist, s.distance === 'ok');

    if (s.ready && !capturing) {
      capturing = true;
      autoLoop();
    }
  }

  async function autoLoop(){
    while (capturing){
      const rr = await fetch(BASE + '/api/face/enroll/capture', {method:'POST'});
      const jj = await rr.json();
      if (jj.ok){
        eoBar.style.width = Math.min(100, Math.round((jj.samples / (jj.target||10)) * 100)) + '%';
        if (jj.done) {
          capturing = false;
          const name = prompt('Enter name or username');
          if (name){
            const rc = await fetch(BASE + '/api/face/enroll/commit', {
              method:'POST', headers:{'Content-Type':'application/json'},
              body: JSON.stringify({name})
            });
            const jc = await rc.json();
            alert(jc.ok ? 'Enrolled!' : ('Failed: ' + (jc.error||'')));
          }
          clearInterval(timer); timer=null; show(false);
          break;
        }
      }
      await new Promise(r => setTimeout(r, 250));
    }
  }

  async function manualSnap(){
    if (capturing) return;
    capturing = true;
    await autoLoop();
  }

  function cancel(){
    capturing = false;
    clearInterval(timer); timer=null;
    show(false);
  }

  btnEnroll && (btnEnroll.onclick = start);
  btnScan   && (btnScan.onclick   = manualSnap);
  btnCancel && (btnCancel.onclick = cancel);
})();

})();
