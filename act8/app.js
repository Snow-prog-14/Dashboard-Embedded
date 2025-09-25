(function(){
  // ===== API endpoints =====
  const BASE        = "http://192.168.1.48:5000";
  const LANG_API    = `${BASE}/api/langs`;
  const SAY_PLAY    = `${BASE}/api/say_play`;
  const PAUSE_API   = `${BASE}/api/pause`;
  const RESUME_API  = `${BASE}/api/resume`;
  const STOP_API    = `${BASE}/api/say_stop`;
  const STATUS_API  = `${BASE}/api/status`;
  const PLAY_FILE   = `${BASE}/api/play_file`;
  const HIST_API    = `${BASE}/api/history`;
  const DL_API      = `${BASE}/api/download`;
  const DEL_API     = `${BASE}/api/delete`;
  const REC_START   = `${BASE}/api/record_start`;
  const REC_STOP    = `${BASE}/api/record_stop`;

  // ===== Helpers =====
  function $(q){ return document.querySelector(q); }
  function option(v,l){ const o=document.createElement('option'); o.value=v; o.textContent=l; return o; }
  const clamp=(x,a,b)=>Math.max(a,Math.min(b,x));
  const fmt = s => { s=Math.max(0,Math.floor(s)); const m=Math.floor(s/60), ss=s%60; return `${m}:${ss<10?'0':''}${ss}`; };

  // ===== Elements =====
  const els = {
    apiDot: $('#apiDot'), apiLabel: $('#apiLabel'),
    text: $('#text'), charHint: $('#charHint'),
    voice: $('#voice'),
    rate: $('#rate'), pitch: $('#pitch'), volume: $('#volume'),
    rateVal: $('#rateVal'), pitchVal: $('#pitchVal'), volVal: $('#volVal'),
    playToggle: $('#playToggle'), pauseToggle: $('#pauseToggle'), recordToggle: $('#recordToggle'),
    refreshBtn: $('#refreshBtn'), clearBtn: $('#clearBtn'),
    stateVal: $('#stateVal'), langVal: $('#langVal'), voiceVal: $('#voiceVal'), queueVal: $('#queueVal'),
    history: $('#history'),
  };

  // ===== State =====
  let gttsList = [];
  let pollTimer = null;
  let playingRow = null;
  let paused = false;

  const store = {
    set(k,v){ try{ localStorage.setItem('tts_'+k, JSON.stringify(v)); }catch(e){} },
    get(k,d){ try{ const v = localStorage.getItem('tts_'+k); return v?JSON.parse(v):d; }catch(e){ return d; } }
  };

  // ===== API: langs & history =====
  async function fetchLangs(){
    try{
      const r = await fetch(LANG_API, {cache:'no-store'});
      const j = await r.json();
      gttsList = Array.isArray(j) ? j : (Array.isArray(j.languages) ? j.languages : []);
      els.apiLabel && (els.apiLabel.textContent = `Pi TTS — ${gttsList.length} langs`);
    }catch(e){
      gttsList=[]; els.apiDot&&(els.apiDot.style.background='#ef4444'); els.apiLabel&&(els.apiLabel.textContent='gTTS fetch failed');
    }
  }

  async function fetchHistory(){
    try{
      const r = await fetch(HIST_API, {cache:'no-store'});
      renderHistory(await r.json());
    }catch(e){ renderHistory([]); }
  }

  function populateVoice(){
    if(!els.voice) return;
    const saved = store.get('settings',{}).lang;
    els.voice.innerHTML = '';
    if (!gttsList.length){ els.voice.appendChild(option('', '(no entries)')); return; }
    gttsList.forEach(({code,name})=> els.voice.appendChild(option(code, `${name} (${code})`)));
    els.voice.value = saved && [...els.voice.options].some(o=>o.value===saved) ? saved : 'auto';
    reflectSelections();
  }

  // ===== UI helpers =====
  function reflectSelections(){
    els.langVal  && (els.langVal.textContent  = els.voice.value || '—');
    els.voiceVal && (els.voiceVal.textContent = 'gTTS');
    els.queueVal && (els.queueVal.textContent = '0');
  }
  function setState(s){ els.stateVal && (els.stateVal.textContent = s); }
  function togglePlayLabel(on){ els.playToggle && (els.playToggle.textContent = on ? 'stop' : 'play'); }
  function updateCharHint(){ const n=(els.text.value||'').length; els.charHint.textContent=`${n} character${n===1?'':'s'}`; }
  function reflectSliderLabels(){
    els.rateVal&&(els.rateVal.textContent=`${parseFloat(els.rate.value).toFixed(1)}×`);
    els.pitchVal&&(els.pitchVal.textContent=`${parseFloat(els.pitch.value).toFixed(1)}`);
    els.volVal&&(els.volVal.textContent=`${Math.round(parseFloat(els.volume.value)*100)}%`);
  }
  function togglePauseLabel(){ els.pauseToggle && (els.pauseToggle.textContent = paused ? 'resume' : 'pause'); }

  // ===== History UI =====
  function makeHistoryRow(item){
    const {file, duration} = item;
    const row = document.createElement('div'); row.className='hist-item';

    const playBtn = document.createElement('button'); playBtn.className='hist-btn'; playBtn.textContent='play';

    const body = document.createElement('div'); body.className='hist-body';
    const ttl  = document.createElement('div'); ttl.className='hist-title'; ttl.textContent=file;

    const progWrap = document.createElement('div');
    progWrap.style.display='flex'; progWrap.style.alignItems='center'; progWrap.style.gap='8px'; progWrap.style.marginTop='6px';
    const cur = document.createElement('span'); cur.style.fontSize='12px'; cur.style.color='#cbd5e1'; cur.textContent='0:00';
    const rng = document.createElement('input'); rng.type='range'; rng.min='0'; rng.max=String(Math.max(1, Math.round(duration||0))); rng.step='1'; rng.value='0'; rng.style.flex='1';
    const tot = document.createElement('span'); tot.style.fontSize='12px'; tot.style.color='#cbd5e1'; tot.textContent=fmt(duration||0);
    progWrap.appendChild(cur); progWrap.appendChild(rng); progWrap.appendChild(tot);

    body.appendChild(ttl); body.appendChild(progWrap);

    const act = document.createElement('div'); act.className='hist-actions';
    const dl  = document.createElement('button'); dl.className='hist-btn'; dl.textContent='download';
    const del = document.createElement('button'); del.className='hist-x'; del.textContent='×';
    act.appendChild(dl); act.appendChild(del);

    row.appendChild(playBtn); row.appendChild(body); row.appendChild(act);

    // progress animation (front-end only)
    let timer=null; let startMs=0; let durS=Number(duration)||0;
    function reset(){ clearInterval(timer); timer=null; rng.value='0'; cur.textContent='0:00'; }
    function tick(){ const t=(performance.now()-startMs)/1000; rng.value=String(clamp(Math.floor(t),0,Math.max(1,Math.round(durS)))); cur.textContent=fmt(t); }

    async function playThis(){
      const rate=parseFloat(els.rate.value), pitch=parseFloat(els.pitch.value), vol=parseFloat(els.volume.value);
      const r = await fetch(`${PLAY_FILE}?file=${encodeURIComponent(file)}&rate=${rate}&pitch=${pitch}&volume=${vol}`);
      const j = await r.json();
      durS = Number(j.duration)||durS; rng.max=String(Math.max(1,Math.round(durS))); tot.textContent=fmt(durS);

      if (playingRow && playingRow!==row){ playingRow._reset&&playingRow._reset(); playingRow.classList.remove('playing'); }
      playingRow=row; row.classList.add('playing');
      setState('speaking'); togglePlayLabel(true); paused=false; togglePauseLabel();
      startMs=performance.now(); reset(); timer=setInterval(tick, 500); startStatusPoll();
    }

    playBtn.addEventListener('click', playThis);
    dl.addEventListener('click', ()=>{ const a=document.createElement('a'); a.href=`${DL_API}?file=${encodeURIComponent(file)}`; a.download=file; a.click(); });
    del.addEventListener('click', async ()=>{
      if (playingRow===row) await stopPlay();
      const r=await fetch(`${DEL_API}?file=${encodeURIComponent(file)}`, {method:'DELETE'});
      if (r.ok) row.remove();
    });

    row._reset = reset;
    return row;
  }

  function renderHistory(list){
    els.history.innerHTML=''; list.forEach(it=> els.history.appendChild(makeHistoryRow(it)));
  }
  function pushHistoryFile(file, duration){ const row=makeHistoryRow({file, duration}); els.history.prepend(row); return row; }

  // ===== Poll status =====
  function startStatusPoll(){ stopStatusPoll(); pollTimer=setInterval(checkStatus, 700); }
  function stopStatusPoll(){ if (pollTimer){ clearInterval(pollTimer); pollTimer=null; } }
  async function checkStatus(){
    try{
      const r = await fetch(STATUS_API, {cache:'no-store'}); const j = await r.json();
      paused = !!j.paused; togglePauseLabel();
      if (!j.playing){ onPlaybackEnded(); }
    }catch(_){ onPlaybackEnded(); }
  }
  function onPlaybackEnded(){
    stopStatusPoll(); setState('idle'); togglePlayLabel(false); paused=false; togglePauseLabel();
    if (playingRow && playingRow._reset){ playingRow._reset(); playingRow.classList.remove('playing'); }
    playingRow=null;
  }

  // ===== Play / Pause / Resume / Stop from textarea =====
  async function startPlayFromText(){
    const text=(els.text.value||'').trim(); if(!text){ els.text?.focus(); return; }
    const lang=els.voice.value||'auto', rate=parseFloat(els.rate.value), pitch=parseFloat(els.pitch.value), vol=parseFloat(els.volume.value);
    const r = await fetch(`${SAY_PLAY}?text=${encodeURIComponent(text)}&lang=${encodeURIComponent(lang)}&rate=${rate}&pitch=${pitch}&volume=${vol}`);
    const j = await r.json();
    if (!j.ok) { onPlaybackEnded(); return; }
    const row = pushHistoryFile(j.file, Number(j.duration)||0);
    if (playingRow && playingRow!==row){ playingRow._reset&&playingRow._reset(); playingRow.classList.remove('playing'); }
    playingRow=row; row.classList.add('playing');
    setState('speaking'); togglePlayLabel(true); paused=false; togglePauseLabel(); startStatusPoll();
  }
  async function pausePlay(){ await fetch(PAUSE_API); paused=true; togglePauseLabel(); }
  async function resumePlay(){ await fetch(RESUME_API); paused=false; togglePauseLabel(); }
  async function stopPlay(){ await fetch(STOP_API); onPlaybackEnded(); }
  function togglePlay(){ if (els.playToggle.textContent==='play') startPlayFromText(); else stopPlay(); }
  function togglePause(){ if (!playingRow) return; paused ? resumePlay() : pausePlay(); }

  // ===== Record (toggle) — mic on Pi, transcript to page =====
  let recording = false;
  async function toggleRecord(){
    if (!recording){
      const lang=els.voice.value||'auto';
      const r=await fetch(`${REC_START}?lang=${encodeURIComponent(lang)}`);
      const j=await r.json(); if(!j.ok){ console.warn(j); return; }
      recording=true; els.recordToggle.textContent='stop recording'; setState('recording');
    }else{
      const r=await fetch(REC_STOP); const j=await r.json();
      recording=false; els.recordToggle.textContent='record'; setState('idle');
      if (j.ok){
        if (j.text){ els.text.value = (els.text.value ? (els.text.value + "\n") : "") + j.text; updateCharHint(); }
        if (els.voice.value==='auto' && j.lang){ els.voice.value=j.lang; reflectSelections(); }
      }
    }
  }

  // ===== Events =====
  els.playToggle && els.playToggle.addEventListener('click', togglePlay);
  els.pauseToggle && els.pauseToggle.addEventListener('click', togglePause);
  els.recordToggle && els.recordToggle.addEventListener('click', toggleRecord);

  els.refreshBtn && els.refreshBtn.addEventListener('click', async ()=>{
    els.refreshBtn.disabled=true; els.refreshBtn.textContent='Refreshing…';
    try{ await fetchLangs(); populateVoice(); await fetchHistory(); }
    finally{ els.refreshBtn.disabled=false; els.refreshBtn.textContent='refresh'; }
  });

  els.clearBtn && els.clearBtn.addEventListener('click', ()=>{ els.text.value=''; updateCharHint(); els.text.focus(); });
  els.text && els.text.addEventListener('input', updateCharHint);
  els.voice && els.voice.addEventListener('change', ()=>{ store.set('settings', {...store.get('settings',{}), lang: els.voice.value}); reflectSelections(); });
  ['rate','pitch','volume'].forEach(k=> els[k] && els[k].addEventListener('input', ()=>{ reflectSliderLabels(); store.set('settings', {...store.get('settings',{}), [k]: parseFloat(els[k].value)}); }));

  // ===== Init =====
  (async ()=>{
    els.apiDot && (els.apiDot.style.background = '#22c55e');
    els.apiLabel && (els.apiLabel.textContent = 'Pi TTS ready');
    await fetchLangs(); populateVoice(); await fetchHistory();
    const s = store.get('settings', null);
    if (s){ els.rate.value=s.rate??1; els.pitch.value=s.pitch??1; els.volume.value=s.volume??1; if (s.lang && [...els.voice.options].some(o=>o.value===s.lang)) els.voice.value=s.lang; }
    reflectSliderLabels(); updateCharHint(); reflectSelections();
  })();

  window.addEventListener('keydown', (e)=>{
    if(e.ctrlKey && e.key.toLowerCase()==='enter'){ e.preventDefault(); togglePlay(); }
    if(e.key==='Escape'){ stopPlay(); }
  });
})();
