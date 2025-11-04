const BASE="http://192.168.1.48:5000";
const STREAM_URL=`${BASE}/api/pir/cam`;
const SNAPSHOT_URL=`${BASE}/api/cam.jpg`;
const HEALTH_URL=`${BASE}/api/health`;

const elStream=document.getElementById("bgStream");
const elSnapshot=document.getElementById("bgSnapshot");
const elStatus=document.getElementById("status");

const elForm=document.getElementById("loginForm");
const elUser=document.getElementById("username");
const elPwd=document.getElementById("password");
const elChkShow=document.getElementById("chkShow");

const btnPrimary=document.getElementById("btnSignin");
const btnToggle=document.getElementById("btnCreate");

const hTitle=document.getElementById("loginTitle");
const pDesc=document.getElementById("loginDesc");

let pollingTimer=null;
let healthTimer=null;

function setStatus(t){if(elStatus)elStatus.textContent=t;}

function startSnapshotPolling(ms=500){
  stopSnapshotPolling();
  pollingTimer=setInterval(()=>{
    const url=`${SNAPSHOT_URL}?ts=${Date.now()}`;
    const img=new Image();
    img.onload=()=>{elSnapshot.style.backgroundImage=`url('${url}')`;};
    img.src=url;
  },ms);
}
function stopSnapshotPolling(){
  if(pollingTimer){clearInterval(pollingTimer);pollingTimer=null;}
}

function startStream(){
  startSnapshotPolling(500);
  setStatus("connecting…");
  elStream.addEventListener("load",()=>{
    setStatus("streaming (MJPEG)");
    stopSnapshotPolling();
  });
  elStream.addEventListener("error",()=>{
    setStatus("stream failed — using snapshot fallback");
    elStream.style.display="none";
    if(!pollingTimer)startSnapshotPolling(500);
  });
  elStream.src=STREAM_URL;
}

async function pollHealth(){
  try{
    const r=await fetch(`${HEALTH_URL}?ts=${Date.now()}`,{cache:"no-store"});
    if(!r.ok)return;
    const j=await r.json();
    if(elStream.style.display==="none"){
      setStatus(`snapshot mode (${j.backend||"unknown"}), last frame age: ${j.last_frame_age_s??"?"}s`);
    }
  }catch{}
}

let isSignup=false;
function applyMode(){
  if(isSignup){
    hTitle.textContent="Create your account";
    pDesc.textContent="Fill in the fields to register.";
    btnPrimary.textContent="Create Account";
    btnToggle.textContent="Already have an Account";
    elForm.setAttribute("aria-label","Create account form");
    setStatus("signup mode");
  }else{
    hTitle.textContent="Sign in";
    pDesc.textContent="Please enter your credentials to continue.";
    btnPrimary.textContent="Sign In";
    btnToggle.textContent="Create an Account";
    elForm.setAttribute("aria-label","Sign in form");
    setStatus("login mode");
  }
}

btnToggle?.addEventListener("click",()=>{
  isSignup=!isSignup;
  applyMode();
  if(elPwd)elPwd.value="";
  elUser?.focus();
});

elChkShow?.addEventListener("change",()=>{
  if(!elPwd)return;
  elPwd.type=elChkShow.checked?"text":"password";
});

elForm?.addEventListener("submit",(e)=>{
  e.preventDefault();
  const data=new FormData(elForm);
  const username=(data.get("username")||"").toString().trim();
  const password=(data.get("password")||"").toString();
  if(isSignup){
    setStatus(`(demo) would create account for "${username}"`);
  }else{
    setStatus(`(demo) would sign in as "${username}"`);
  }
});

(function init(){
  applyMode();
  startStream();
  healthTimer=setInterval(pollHealth,3000);
})();

window.addEventListener("beforeunload",()=>{
  stopSnapshotPolling();
  if(healthTimer)clearInterval(healthTimer);
});
