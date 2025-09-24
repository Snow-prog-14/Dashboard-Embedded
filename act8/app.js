// app.js — playback (Web Speech), WAV download (meSpeak), and voice recognition (ASR)

(function(){
  // ===== Helpers & element lookups =====
  function $(q){ return document.querySelector(q); }
  function option(value,label){ const o=document.createElement('option'); o.value=value; o.textContent=label; return o; }
  function escapeHtml(s){ return s.replace(/[&<>"']/g, m=>({"&":"&amp;","<":"&lt;"," >":"&gt;","\"":"&quot;","'":"&#39;"}[m])); }

  const synth = window.speechSynthesis;
  const supportsTTS = !!window.speechSynthesis && 'SpeechSynthesisUtterance' in window;

  const els = {
    apiDot: $('#apiDot'), apiLabel: $('#apiLabel'),
    text: $('#text'), charHint: $('#charHint'),
    lang: $('#lang'), voice: $('#voice'),
    rate: $('#rate'), pitch: $('#pitch'), volume: $('#volume'),
    rateVal: $('#rateVal'), pitchVal: $('#pitchVal'), volVal: $('#volVal'),
    speakBtn: $('#speakBtn'), pauseBtn: $('#pauseBtn'), resumeBtn: $('#resumeBtn'), stopBtn: $('#stopBtn'),
    refreshBtn: $('#refreshBtn'), sampleBtn: $('#sampleBtn'), clearBtn: $('#clearBtn'),
    stateVal: $('#stateVal'), langVal: $('#langVal'), voiceVal: $('#voiceVal'), queueVal: $('#queueVal'),
    history: $('#history'),
    downloadBtn: $('#downloadBtn'),

    // Optional (only if you added them to HTML)
    micBtn: $('#micBtn'),
    asrStatus: $('#asrStatus')
  };

  if(!supportsTTS){
    if (els.apiDot) els.apiDot.style.background = '#ef4444';
    if (els.apiLabel) els.apiLabel.textContent = 'Web Speech API not supported on this browser.';
    document.querySelectorAll('button,select,input,textarea').forEach(x=>x.disabled=true);
    return;
  } else {
    if (els.apiDot) els.apiDot.style.background = '#22c55e';
    if (els.apiLabel) els.apiLabel.textContent = 'SpeechSynthesis available';
  }

  // ===== State & persistence =====
  let voices = [];
  let langList = [];
  const store = {
    set(k,v){ try{ localStorage.setItem('tts_'+k, JSON.stringify(v)); }catch(e){} },
    get(k,d){ try{ const v = localStorage.getItem('tts_'+k); return v?JSON.parse(v):d; }catch(e){ return d; } }
  };

  // ===== UI helpers =====
  function langName(tag){
    try{
      const dn = new Intl.DisplayNames([navigator.language||'en'], {type:'language'});
      const base = tag.split('-')[0];
      return (dn.of(tag) || dn.of(base) || tag) + ` (${tag})`;
    }catch{ return tag }
  }
  function updateCharHint(){
    if (!els.charHint || !els.text) return;
    const n = els.text.value.length;
    els.charHint.textContent = `${n} character${n===1?'':'s'}`;
  }
  function reflectSliderLabels(){
    if (els.rateVal)  els.rateVal.textContent  = `${parseFloat(els.rate.value).toFixed(1)}×`;
    if (els.pitchVal) els.pitchVal.textContent = `${parseFloat(els.pitch.value).toFixed(1)}`;
    if (els.volVal)   els.volVal.textContent   = `${Math.round(parseFloat(els.volume.value)*100)}%`;
  }
  function captureSettings(){
    return {
      lang: els.lang.value,
      voiceURI: els.voice.value,
      rate: parseFloat(els.rate.value),
      pitch: parseFloat(els.pitch.value),
      volume: parseFloat(els.volume.value)
    };
  }
  function restoreSettings(){
    const s = store.get('settings', null);
    if(!s) return;
    els.rate.value   = s.rate ?? 1;
    els.pitch.value  = s.pitch ?? 1;
    els.volume.value = s.volume ?? 1;
    els.lang.value   = s.lang || '';
    els.voice.value  = s.voiceURI || '';
    reflectSliderLabels();
  }

  // ===== Voices UI =====
  function refreshVoices(){
    voices = synth.getVoices().slice().sort((a,b)=>(a.lang||'').localeCompare(b.lang||'') || a.name.localeCompare(b.name));
    const set = new Set(voices.map(v=>v.lang));
    // Ensure Filipino tags appear in Language dropdown even if OS has no system voice:
    set.add('fil-PH'); set.add('tl-PH');
    langList = Array.from(set).sort((a,b)=>a.localeCompare(b));

    if (els.lang){
      els.lang.innerHTML = '';
      els.lang.appendChild(option('', 'All languages'));
      langList.forEach(t => els.lang.appendChild(option(t, langName(t))));
      const saved = store.get('settings',{}).lang;
      els.lang.value = (saved && langList.includes(saved)) ? saved : '';
    }
    populateVoices();
  }
  function populateVoices(){
    const selLang = els.lang.value;
    const list = selLang? voices.filter(v => v.lang === selLang || v.lang.startsWith(selLang+'-')) : voices;
    if (els.voice){
      els.voice.innerHTML = '';
      list.forEach(v => {
        const label = `${v.name} — ${v.lang}${v.default? ' · default':''}${v.localService? ' · local':''}`;
        els.voice.appendChild(option(v.voiceURI, label));
      });
      if(!list.length){ els.voice.appendChild(option('', 'No voices available')); }
    }
    reflectSelections();
  }
  function reflectSelections(){
    if (els.langVal)  els.langVal.textContent  = els.lang.value || 'All';
    if (els.voiceVal){
      const opt = els.voice.selectedOptions ? els.voice.selectedOptions[0] : null;
      els.voiceVal.textContent = opt ? opt.textContent.split(' — ')[0] : '—';
    }
    if (els.queueVal) els.queueVal.textContent = synth.pending + synth.speaking;
  }

  // ===== History =====
  function logHistory(item){
    if (!els.history) return;
    const div = document.createElement('div');
    div.style.borderTop = '1px solid var(--border)';
    div.style.padding = '8px 0';
    div.innerHTML = `<div style="display:flex;justify-content:space-between;gap:8px"><strong>${item.status}</strong><span class="hint">${new Date().toLocaleTimeString()}</span></div>
                     <div class="hint">lang: ${item.lang}, voice: ${item.voiceName||''}</div>
                     <div>${escapeHtml(item.text).slice(0,240)}${item.text.length>240?'…':''}</div>`;
    els.history.prepend(div);
  }

  // ===== Playback (Web Speech) =====
  function speak(){
    const text = (els.text.value||'').trim();
    if(!text){ els.text.focus(); return; }
    const s = captureSettings();
    store.set('settings', s);

    synth.cancel();
    const utt = new SpeechSynthesisUtterance(text);
    const voice = voices.find(v => v.voiceURI === s.voiceURI);
    if(voice) utt.voice = voice;
    if(s.lang) utt.lang = s.lang;
    utt.rate = s.rate; utt.pitch = s.pitch; utt.volume = s.volume;

    utt.onstart = ()=>{ if (els.stateVal) els.stateVal.textContent = 'speaking'; reflectSelections(); logHistory({status:'▶ speaking', lang: utt.lang||voice?.lang||'auto', voiceName: voice?voice.name:'(browser default)', text}); };
    utt.onend   = ()=>{ if (els.stateVal) els.stateVal.textContent = 'idle'; reflectSelections(); logHistory({status:'■ finished', lang: utt.lang||voice?.lang||'auto', voiceName: voice?voice.name:'(browser default)', text}); };
    utt.onerror = (e)=>{ if (els.stateVal) els.stateVal.textContent = 'error'; logHistory({status:'⚠ error', lang: utt.lang||voice?.lang||'auto', voiceName: voice?voice.name:'(browser default)', text}); console.error('TTS error', e); };
    utt.onpause = ()=>{ if (els.stateVal) els.stateVal.textContent = 'paused'; reflectSelections(); };
    utt.onresume= ()=>{ if (els.stateVal) els.stateVal.textContent = 'speaking'; reflectSelections(); };

    synth.speak(utt);
    reflectSelections();
  }

  // ===== Sample text per language =====
  function sampleFor(tag){
    const base = (tag||'en').split('-')[0];
    const samples = {
      en: "Hello! This is your multilingual text-to-speech minibot.",
      fil: "Kamusta! Ito ang iyong multilingual text-to-speech minibot.",
      tl:  "Kamusta! Ito ang iyong multilingual text-to-speech minibot.",
      es: "¡Hola! Este es tu minibot de texto a voz multilingüe.",
      fr: "Bonjour ! Voici votre mini-bot de synthèse vocale multilingue.",
      de: "Hallo! Das ist dein mehrsprachiger Text-zu-Sprache-Minibot.",
      ja: "こんにちは。これは多言語のテキスト読み上げミニボットです。",
      zh: "你好！这是你的多语言文本转语音小助手。",
      ar: "مرحبًا! هذا هو روبوت تحويل النص إلى كلام متعدد اللغات.",
      hi: "नमस्ते! यह आपका बहुभाषी टेक्स्ट-टू-स्पीच मिनीबॉट है।"
    };
    return samples[base] || samples.en;
  }

  // ===== meSpeak (WAV download) =====
  let MESPEAK_READY = false;
  const ME_VOICE_CACHE = new Set();
  // Map languages to meSpeak voice ids; Tagalog/Filipino mapped to English fallback (no high-quality meSpeak TL voice bundled)
  const ME_VOICE_MAP = {
    en:'en/en-us', es:'es', fr:'fr', de:'de', it:'it', pt:'pt', nl:'nl',
    sv:'sv', pl:'pl', ru:'ru', tr:'tr', ja:'ja', zh:'zh',
    tl:'en/en-us', fil:'en/en-us'
  };

  function loadMeSpeak(){
    if (typeof meSpeak === 'undefined') return;
    meSpeak.loadConfig('https://cdn.jsdelivr.net/npm/mespeak/mespeak_config.json');
    meSpeak.onready = () => { MESPEAK_READY = true; };
  }
  function waitReady(){ return new Promise(r => { const t=()=>MESPEAK_READY?r():setTimeout(t,100); t(); }); }
  async function ensureMeSpeakVoice(tag){
    if (typeof meSpeak === 'undefined') return false;
    await waitReady();
    const base = (tag||navigator.language||'en').split('-')[0].toLowerCase();
    const id = ME_VOICE_MAP[base] || 'en/en-us';
    if (ME_VOICE_CACHE.has(id)) return true;
    const url = `https://cdn.jsdelivr.net/npm/mespeak/voices/${id}.json`;
    return new Promise(res=>{
      meSpeak.loadVoice(url, ok=>{
        if (ok){ ME_VOICE_CACHE.add(id); return res(true); }
        if (id!=='en/en-us'){
          meSpeak.loadVoice('https://cdn.jsdelivr.net/npm/mespeak/voices/en/en-us.json', ok2=>{
            if (ok2) ME_VOICE_CACHE.add('en/en-us');
            res(!!ok2);
          });
        } else { res(false); }
      });
    });
  }
  function meOpts(rate,pitch,volume){
    const speed = Math.round(80 + (rate - 0.5) * (300-80) / (2-0.5));
    const pit   = Math.round(20 + pitch * (80-20) / 2);
    const amp   = Math.round(volume * 200);
    return { speed: speed, pitch: pit, amplitude: amp };
  }
  function dataURLtoBlob(dataURL){
    const bstr = atob(dataURL.split(',')[1]);
    const u8 = new Uint8Array(bstr.length);
    for (let i=0;i<bstr.length;i++) u8[i] = bstr.charCodeAt(i);
    return new Blob([u8], {type:'audio/wav'});
  }
  function triggerDownloadBlob(blob, name){
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    a.click();
  }
  function fileName(tag){
    const base = (tag || navigator.language || 'en').split('-')[0];
    const ts = new Date().toISOString().replace(/[:.]/g,'-');
    return `tts-${base}-${ts}.wav`;
  }
  async function handleDownload(){
    const text = (els.text.value||'').trim();
    if (!text){ els.text.focus(); return; }

    const lang   = els.lang.value;
    const rate   = parseFloat(els.rate.value);
    const pitch  = parseFloat(els.pitch.value);
    const volume = parseFloat(els.volume.value);

    try{
      const ok = await ensureMeSpeakVoice(lang);
      if (!ok){ alert('Voice file could not be loaded (network or blocked).'); return; }

      const dataUrl = meSpeak.speak(text, Object.assign(meOpts(rate,pitch,volume), { rawdata:'data-url' }));
      if (!dataUrl){ alert('Engine not ready yet. Try again.'); return; }

      triggerDownloadBlob(dataURLtoBlob(dataUrl), fileName(lang));
      alert('Download started.');
    }catch(err){
      console.error(err);
      alert('WAV generation failed. See console for details.');
    }
  }

  // ===== Voice Recognition (ASR) =====
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition || null;
  let rec = null;
  let recognizing = false;

  function asrSupported() {
    // Mic requires secure context (HTTPS) or localhost in modern browsers
    return !!SR && (window.isSecureContext || location.hostname === 'localhost');
  }
  function currentLangTag() {
    return els.lang.value || navigator.language || 'en-US';
  }
  function appendToText(t) {
    const ta = els.text;
    const needsSpace = ta.value && !ta.value.endsWith(' ');
    ta.value = ta.value + (needsSpace ? ' ' : '') + t;
    ta.dispatchEvent(new Event('input'));
  }
  function initRecognizer() {
    if (!SR) return null;
    const r = new SR();
    r.lang = currentLangTag();
    r.interimResults = true;
    r.continuous = false;
    r.maxAlternatives = 1;

    r.onstart = () => {
      recognizing = true;
      if (els.asrStatus) els.asrStatus.textContent = `Voice input: listening (${r.lang})…`;
      if (els.micBtn) els.micBtn.classList.add('warn');
    };
    r.onresult = (ev) => {
      let interim = '';
      let finalTxt = '';
      for (let i = ev.resultIndex; i < ev.results.length; i++) {
        const res = ev.results[i];
        const txt = res[0].transcript.trim();
        if (res.isFinal) finalTxt += (finalTxt ? ' ' : '') + txt;
        else interim += (interim ? ' ' : '') + txt;
      }
      if (interim && els.asrStatus) els.asrStatus.textContent = `Listening… ${interim}`;
      if (finalTxt) appendToText(finalTxt);
    };
    r.onerror = (e) => {
      if (els.asrStatus) els.asrStatus.textContent = `Voice input error: ${e.error || 'unknown'}`;
      console.warn('ASR error', e);
    };
    r.onend = () => {
      recognizing = false;
      if (els.micBtn) els.micBtn.classList.remove('warn');
      if (els.asrStatus) els.asrStatus.textContent = 'Voice input: idle';
    };
    return r;
    }
  function toggleASR() {
    if (!asrSupported()) {
      alert('Voice input needs a supported browser (Chrome/Edge) and HTTPS or localhost.');
      return;
    }
    if (!rec) rec = initRecognizer();
    if (rec) rec.lang = currentLangTag();

    if (!recognizing) {
      try { rec.start(); }
      catch (e) { setTimeout(()=>{ try{ rec.start(); }catch(_){} }, 250); }
    } else {
      try { rec.stop(); } catch(_) {}
    }
  }

  // ===== Wire events =====
  if (els.speakBtn)  els.speakBtn.addEventListener('click', speak);
  if (els.pauseBtn)  els.pauseBtn.addEventListener('click', ()=> synth.pause());
  if (els.resumeBtn) els.resumeBtn.addEventListener('click', ()=> synth.resume());
  if (els.stopBtn)   els.stopBtn.addEventListener('click', ()=> { synth.cancel(); if (els.stateVal) els.stateVal.textContent='idle'; reflectSelections(); });
  if (els.refreshBtn)els.refreshBtn.addEventListener('click', refreshVoices);
  if (els.sampleBtn) els.sampleBtn.addEventListener('click', ()=>{ els.text.value = sampleFor(els.lang.value || navigator.language || 'en'); updateCharHint(); els.text.focus(); });
  if (els.clearBtn)  els.clearBtn.addEventListener('click', ()=>{ els.text.value=''; updateCharHint(); els.text.focus(); });
  if (els.downloadBtn) els.downloadBtn.addEventListener('click', handleDownload);

  if (els.micBtn)    els.micBtn.addEventListener('click', toggleASR);

  if (els.text) els.text.addEventListener('input', updateCharHint);
  if (els.lang) els.lang.addEventListener('change', ()=>{ store.set('settings', {...store.get('settings',{}), lang: els.lang.value}); populateVoices(); if (rec) rec.lang = currentLangTag(); });
  if (els.voice) els.voice.addEventListener('change', ()=>{ reflectSelections(); store.set('settings', {...store.get('settings',{}), voiceURI: els.voice.value}); });
  ['rate','pitch','volume'].forEach(k=>{
    if (els[k]) els[k].addEventListener('input', ()=>{ reflectSliderLabels(); store.set('settings', {...store.get('settings',{}), [k]: parseFloat(els[k].value)}); });
  });

  refreshVoices();
  if (typeof speechSynthesis !== 'undefined' && speechSynthesis.onvoiceschanged !== undefined){
    speechSynthesis.onvoiceschanged = ()=> refreshVoices();
  }
  restoreSettings();
  updateCharHint();
  reflectSelections();

  window.addEventListener('keydown', (e)=>{
    if(e.ctrlKey && e.key.toLowerCase()==='enter'){ e.preventDefault(); speak(); }
    if(e.key==='Escape'){ synth.cancel(); if (els.stateVal) els.stateVal.textContent='idle'; }
  });

  // Init meSpeak (for downloads)
  loadMeSpeak();
  // Optional warmup: ensureMeSpeakVoice('en'); // preloads English so first download is faster
})();
