(function () {
  const $ = s => document.querySelector(s);

  const elImg = $('#camFeed');
  const elDot = $('#statusDot');
  const elTxt = $('#statusText');
  const elFps = $('#statFps');
  const btnDet = $('#btnDetect');

  function apiBase() {
    const host = location.hostname || 'raspi.local';
    const proto = location.protocol || 'http:';
    return `${proto}//${host}:5000`;
  }

  function setStatus(state){
    elTxt.textContent = state;
    elDot.classList.remove('online','offline','loading');
    if (state === 'online') elDot.classList.add('online');
    else if (state === 'connecting') elDot.classList.add('loading');
    else elDot.classList.add('offline');
  }

  let pollTimer = null;
  async function pollStatus(){
    const base = apiBase();
    try{
      const r = await fetch(base + '/api/face/status', {cache:'no-store'});
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
    const base = apiBase();
    setStatus('connecting');
    elImg.src = base + '/api/face?ts=' + Date.now();
    elImg.onload  = () => setStatus('online');
    elImg.onerror = () => setStatus('offline');
    startPolling();
  }

  async function toggleDetection(){
    const base = apiBase();
    const isOn = btnDet.classList.contains('on');
    const want = !isOn;
    try{
      await fetch(base + '/api/face/overlay', {
        method:'POST', headers:{'Content-Type':'application/json'},
        body: JSON.stringify({enabled: want})
      });
      btnDet.textContent = 'Detection: ' + (want ? 'On' : 'Off');
      btnDet.classList.toggle('on', want);
    }catch{
      alert('Failed to toggle detection');
    }
  }

  if (btnDet) btnDet.onclick = toggleDetection;

  startStream();
})();
