import * as THREE from 'three';
import * as CANNON from 'cannon-es';
import { DiscordSDK } from '@discord/embedded-app-sdk';
import './style.css';

const host=document.querySelector('#scene');
const button=document.querySelector('#roll-button');
const resultEl=document.querySelector('#result-number');
const subtitle=document.querySelector('#result-subtitle');
const status=document.querySelector('#status-pill');
const burst=document.querySelector('#burst');
const connectionCard=document.querySelector('#connection-card');
const connectionStage=document.querySelector('#connection-stage');
const connectionDetail=document.querySelector('#connection-detail');
const retryButton=document.querySelector('#retry-button');
const inputProof=document.querySelector('#input-proof');
const resultLabel=document.querySelector('#result-label');
const rollHint=document.querySelector('#roll-hint');
const adminButton=document.querySelector('#admin-button');
const adminPanel=document.querySelector('#admin-panel');
const adminExit=document.querySelector('#admin-exit');
const adminModal=document.querySelector('#admin-modal');
const adminForm=document.querySelector('#admin-form');
const adminPassword=document.querySelector('#admin-password');
const adminCancel=document.querySelector('#admin-cancel');
const adminError=document.querySelector('#admin-error');
const adminSelectedDie=document.querySelector('#admin-selected-die');
const dieGrid=document.querySelector('#die-grid');

const CLIENT_ID=import.meta.env.VITE_DISCORD_CLIENT_ID || "";
const isDiscordActivity=window.location.hostname.endsWith(".discordsays.com");
let discordSdk=null;
let discordAuth=null;
let pendingRoll=null;
let rollSubmitted=false;
let activitySetupStarted=false;
let activitySetupComplete=false;
let activityError=null;
let lastInputAt=0;
let inputSequence=0;
let modeRollResults=[];
let adminTestMode=false;
let adminToken=sessionStorage.getItem("mixerDiceAdminToken") || "";
let selectedAdminDie="d20";



function showInputProof(label, extra=""){
  inputSequence += 1;
  const stamp=new Date().toLocaleTimeString();
  inputProof.textContent=
    `INPUT #${inputSequence}: ${label}${extra?` • ${extra}`:""} • ${stamp}`;
  console.log("[Mixer Dice Input]",label,extra);
}

function showRollBlocked(reason){
  showInputProof("BLOCKED",reason);
  status.textContent="BLOCKED";
  subtitle.textContent=`Roll blocked: ${reason}`;
}

function currentRollMode(){
  const value=String(pendingRoll?.rollMode || "normal").toLowerCase();
  return ["normal","advantage","disadvantage"].includes(value)?value:"normal";
}

function modeLabel(mode=currentRollMode()){
  if(mode==="advantage") return "ADVANTAGE";
  if(mode==="disadvantage") return "DISADVANTAGE";
  return "NORMAL";
}

function modeEmoji(mode=currentRollMode()){
  if(mode==="advantage") return "🟢";
  if(mode==="disadvantage") return "🔴";
  return "⚪";
}

function chooseKeptResult(mode,rolls){
  if(mode==="advantage") return Math.max(...rolls);
  if(mode==="disadvantage") return Math.min(...rolls);
  return rolls[0];
}

function setConnection(stage, detail, {
  statusText=stage,
  retry=false,
  buttonText=null,
  enableRoll=false
}={}){
  if(adminTestMode) return;
  connectionStage.textContent=stage;
  connectionDetail.textContent=detail;
  status.textContent=statusText;

  retryButton.hidden=!retry;

  if(buttonText){
    button.innerHTML=`<span>🎲</span> ${buttonText}`;
  }

  button.disabled=!enableRoll;
}

function adminSides(die=selectedAdminDie){
  const n=Number(String(die).replace("d",""));
  return Number.isInteger(n) && [4,6,8,10,12,20,100].includes(n) ? n : 20;
}

function randomAdminResult(die=selectedAdminDie){
  const sides=adminSides(die);
  if(die==="d20") return {result:top().number, detail:"physical top-face result"};
  if(die==="d100"){
    const result=Math.floor(Math.random()*100)+1;
    const normalized=result===100?0:result;
    const tens=Math.floor(normalized/10)*10;
    const ones=normalized%10;
    return {result,detail:`percentile ${String(tens).padStart(2,"0")} + ${ones}`};
  }
  return {result:Math.floor(Math.random()*sides)+1,detail:`local ${die.toUpperCase()} test result`};
}

function updateAdminDieUI(){
  const upper=selectedAdminDie.toUpperCase();
  adminSelectedDie.textContent=upper;
  resultLabel.textContent=`${upper} RESULT`;
  button.innerHTML=`<span>🎲</span> TEST LOCAL ${upper}`;
  button.disabled=false;
  rollHint.textContent=selectedAdminDie==="d20"
    ? "D20 uses the existing physical top-face reader. Other dice use the same physics throw as a local test harness."
    : "Admin test roll only — no pending DM roll is required and nothing is submitted to the campaign.";
  dieGrid?.querySelectorAll("button[data-die]").forEach((el)=>{
    el.classList.toggle("selected",el.dataset.die===selectedAdminDie);
  });
}

function enterAdminMode(){
  adminTestMode=true;
  pendingRoll=null;
  activitySetupComplete=false;
  rollSubmitted=false;
  modeRollResults=[];
  connectionCard.hidden=true;
  adminPanel.hidden=false;
  adminButton.textContent="🧪 TEST MODE";
  adminButton.classList.add("active");
  status.textContent="ADMIN";
  resultEl.textContent="—";
  subtitle.textContent="Admin Test Mode unlocked. Choose a die and roll as often as you want.";
  updateAdminDieUI();
}

async function exitAdminMode(){
  adminTestMode=false;
  adminPanel.hidden=true;
  adminButton.textContent="🔒 ADMIN";
  adminButton.classList.remove("active");
  resultLabel.textContent="D20 RESULT";
  rollHint.textContent="The final upward face is the actual roll.";
  resultEl.textContent="—";
  if(isDiscordActivity){
    connectionCard.hidden=false;
    button.disabled=true;
    button.innerHTML="<span>🎲</span> CONNECTING...";
    await setupDiscordActivity({force:true});
  }else{
    connectionCard.hidden=true;
    button.disabled=false;
    button.innerHTML="<span>🎲</span> ROLL D20";
    status.textContent="READY";
    subtitle.textContent="Roll the die to begin.";
  }
}

async function adminApi(path,options={}){
  const headers=new Headers(options.headers||{});
  if(adminToken) headers.set("Authorization",`Bearer ${adminToken}`);
  return fetch(path,{...options,headers});
}

async function tryRestoreAdminSession(){
  if(!adminToken) return false;
  try{
    const res=await adminApi("/api/admin/session");
    const json=await res.json();
    if(json.authenticated){ enterAdminMode(); return true; }
  }catch{}
  adminToken="";
  sessionStorage.removeItem("mixerDiceAdminToken");
  return false;
}

function readableError(error, fallback="UNKNOWN_ERROR"){
  if(!error) return fallback;
  if(typeof error==="string") return error;
  return error.message || fallback;
}

function describeBridgeError(code){
  const messages={
    NO_CHARACTER:"Discord authenticated, but the bot could not find your character.",
    NO_PARTY:"Discord authenticated, but the bot could not find your active party.",
    NO_PENDING_ROLL:"The bot says you do not currently have a pending roll.",
    PENDING_ROLL_CHANGED:"That pending roll was replaced or already resolved. Close the Activity and use the newest 3D Dice button.",
    WRONG_CHANNEL:"The pending roll exists, but Discord launched the Activity in a different channel.",
    BAD_USER_TOKEN:"The Dice Activity could not verify your Discord user.",
    UNAUTHORIZED:"The Dice service could not authenticate with the Dungeon Master bridge. Check DICE_BRIDGE_SECRET on both Railway services.",
    MISSING_FIELDS:"The Activity did not receive all required Discord context.",
    MISSING_CONTEXT:"Discord did not provide a guild/channel context to the Activity.",
    BOT_HTTP_404:"The Dice service reached the bot URL, but the expected dice endpoint was not found.",
    BOT_HTTP_502:"The Dice service could not reach the Dungeon Master bot.",
    SERVER_ERROR:"The bridge hit an internal server error.",
    BOT_API_URL_MISSING:"The Dice Railway service does not have BOT_API_URL configured.",
    BOT_API_URL_INVALID:"BOT_API_URL is not a valid Railway URL.",
    BOT_UNREACHABLE:"The Dice Railway service cannot reach the Dungeon Master Railway service.",
    BOT_TIMEOUT:"The Dungeon Master Railway service did not respond in time.",
    BOT_NON_JSON_404:"The bot URL responded, but /dice/pending was not found. BOT_API_URL may point to the wrong Railway service.",
    BOT_NON_JSON_502:"Railway returned a gateway error while contacting the Dungeon Master service.",
    TOKEN_EXCHANGE_FAILED:"Discord rejected the OAuth token exchange. Check the Activity Client ID and Client Secret.",
    TOKEN_EXCHANGE_ERROR:"The Dice server could not complete Discord OAuth.",
    UNSUPPORTED_DIE:"The current pending roll is not supported by this d20 Activity yet."
  };
  return messages[code] || `Bridge error: ${code}`;
}

async function activityFetch(path, options={}){
  const headers=new Headers(options.headers || {});
  if(discordAuth?.access_token){
    headers.set("Authorization",`Bearer ${discordAuth.access_token}`);
  }
  return fetch(path,{...options,headers});
}

function prettyCheck(name){
  return String(name || "").replace(/([a-z])([A-Z])/g,"$1 $2");
}

async function setupDiscordActivity({force=false}={}){
  if(adminTestMode) return;
  if(activitySetupStarted && !force) return;

  activitySetupStarted=true;
  activitySetupComplete=false;
  activityError=null;
  pendingRoll=null;
  rollSubmitted=false;
  modeRollResults=[];

  if(!isDiscordActivity){
    console.log("[Mixer Dice] Standalone browser demo mode.");
    connectionCard.hidden=true;
    button.disabled=false;
    return;
  }

  setConnection(
    "1/5 • ACTIVITY STARTING",
    "Loading Discord's Embedded App SDK…",
    {
      statusText:"CONNECTING",
      buttonText:"PLEASE WAIT",
      enableRoll:false
    }
  );

  try{
    if(!CLIENT_ID){
      throw new Error("MISSING_VITE_DISCORD_CLIENT_ID");
    }

    discordSdk=new DiscordSDK(CLIENT_ID);

    setConnection(
      "2/5 • WAITING FOR DISCORD",
      "Waiting for Discord to provide the Activity context…",
      {
        statusText:"CONNECTING",
        buttonText:"PLEASE WAIT",
        enableRoll:false
      }
    );

    await discordSdk.ready();

    const guildId=discordSdk.guildId || "";
    const channelId=discordSdk.channelId || "";

    if(!guildId || !channelId){
      throw new Error(
        `MISSING_CONTEXT guild=${guildId || "NONE"} channel=${channelId || "NONE"}`
      );
    }

    setConnection(
      "3/5 • AUTHENTICATING",
      `Discord context received. Channel ${channelId}. Verifying your Discord account…`,
      {
        statusText:"AUTH",
        buttonText:"PLEASE WAIT",
        enableRoll:false
      }
    );

    const {code}=await discordSdk.commands.authorize({
      client_id:CLIENT_ID,
      response_type:"code",
      state:"",
      prompt:"none",
      scope:["identify"]
    });

    if(!code){
      throw new Error("DISCORD_AUTHORIZE_NO_CODE");
    }

    const tokenRes=await fetch("/api/token",{
      method:"POST",
      headers:{"Content-Type":"application/json"},
      body:JSON.stringify({code})
    });

    const tokenJson=await tokenRes.json().catch(()=>({}));

    if(!tokenRes.ok || !tokenJson.access_token){
      throw new Error(tokenJson.error || `TOKEN_HTTP_${tokenRes.status}`);
    }

    discordAuth=await discordSdk.commands.authenticate({
      access_token:tokenJson.access_token
    });

    if(!discordAuth?.user?.id){
      throw new Error("DISCORD_AUTHENTICATE_FAILED");
    }

    setConnection(
      "4/5 • CHECKING WITH DM",
      `Authenticated as ${discordAuth.user.username || discordAuth.user.id}. Looking for your pending roll…`,
      {
        statusText:"CHECKING",
        buttonText:"PLEASE WAIT",
        enableRoll:false
      }
    );

    const pendingRes=await activityFetch("/api/pending-roll",{
      method:"POST",
      headers:{"Content-Type":"application/json"},
      body:JSON.stringify({
        guildId,
        channelId
      })
    });

    const pendingJson=await pendingRes.json().catch(()=>({
      ok:false,
      error:`INVALID_JSON_HTTP_${pendingRes.status}`
    }));

    if(!pendingRes.ok || !pendingJson.ok){
      const code=pendingJson.error || `HTTP_${pendingRes.status}`;
      activityError=code;

      setConnection(
        "CONNECTION FAILED",
        `${describeBridgeError(code)} [${code}]`,
        {
          statusText:"ERROR",
          retry:true,
          buttonText:"TEST LOCAL D20",
          enableRoll:true
        }
      );

      resultEl.textContent="—";
      subtitle.textContent=`Bridge diagnostic: ${code}`;
      return;
    }

    if(!pendingJson.pending?.id){
      throw new Error("PENDING_RESPONSE_MISSING_ID");
    }

    pendingRoll=pendingJson.pending;
    activitySetupComplete=true;

    const modifier=Number(pendingRoll.modifier || 0);
    const modifierText=`${pendingRoll.ability} ${modifier>=0?"+":""}${modifier}`;
    const mode=currentRollMode();
    const needsTwo=mode!=="normal";

    setConnection(
      "5/5 • READY TO ROLL",
      `${pendingRoll.characterName} • ${prettyCheck(pendingRoll.checkName)} • ${modifierText} • ${modeEmoji(mode)} ${modeLabel(mode)}`,
      {
        statusText:modeLabel(mode),
        retry:false,
        buttonText:needsTwo?"ROLL D20 — FIRST ROLL":`ROLL ${String(pendingRoll.dice || "1d20").toUpperCase()}`,
        enableRoll:true
      }
    );

    resultEl.textContent="—";
    subtitle.textContent=
      needsTwo
        ? `${modeEmoji(mode)} ${modeLabel(mode)} • Roll the d20 twice. ${mode==="advantage"?"Highest":"Lowest"} result will count.`
        : `${pendingRoll.characterName} • ${prettyCheck(pendingRoll.checkName)} • ${modifierText}`;

    console.log("[Mixer Dice] Pending roll verified:",{
      pendingId:pendingRoll.id,
      guildId,
      activityChannelId:channelId,
      campaignChannelId:pendingRoll.campaignChannelId,
      userId:discordAuth.user.id,
      checkName:pendingRoll.checkName,
      dice:pendingRoll.dice
    });

    if(
      pendingRoll.campaignChannelId &&
      pendingRoll.campaignChannelId !== channelId
    ){
      connectionDetail.textContent +=
        " • Voice/Activity channel detected; result will return to the campaign text channel.";
    }
  }catch(err){
    const code=readableError(err);
    activityError=code;
    console.error("[Mixer Dice] Activity setup failure:",err);

    setConnection(
      "ACTIVITY ERROR",
      `${describeBridgeError(code)} [${code}]`,
      {
        statusText:"ERROR",
        retry:true,
        buttonText:"TEST LOCAL D20",
        enableRoll:true
      }
    );

    resultEl.textContent="—";
    subtitle.textContent=`Setup diagnostic: ${code}`;
  }finally{
    activitySetupStarted=false;
  }
}

async function submitActivityRoll(result,rolls=[result]){
  if(!isDiscordActivity || !pendingRoll || rollSubmitted) return;

  rollSubmitted=true;
  button.disabled=true;
  status.textContent="SENDING";
  subtitle.textContent="Sending the physical roll to the Dungeon Master...";

  try{
    const res=await activityFetch("/api/roll-result",{
      method:"POST",
      headers:{"Content-Type":"application/json"},
      body:JSON.stringify({
        guildId:discordSdk.guildId,
        channelId:discordSdk.channelId,
        campaignChannelId:pendingRoll.campaignChannelId || "",
        pendingId:pendingRoll.id,
        die:"d20",
        result,
        rolls
      })
    });

    const json=await res.json();

    if(!res.ok || !json.ok){
      rollSubmitted=false;
      button.disabled=false;
      const code=json.error || `HTTP_${res.status}`;
      activityError=code;
      setConnection(
        "ROLL REJECTED",
        `${describeBridgeError(code)} [${code}]`,
        {
          statusText:"ERROR",
          retry:true,
          buttonText:"TEST LOCAL D20",
          enableRoll:true
        }
      );
      subtitle.textContent=`Roll was not accepted: ${code}`;
      return;
    }

    setConnection(
      "ROLL SENT TO DM",
      `${json.characterName} • ${prettyCheck(json.checkName)} • ${modeEmoji(json.rollMode)} ${modeLabel(json.rollMode)} • Total ${json.total} • ${json.outcome}`,
      {
        statusText:"SENT",
        retry:false,
        buttonText:"ROLL SENT TO DM",
        enableRoll:false
      }
    );
    subtitle.textContent=
      `${json.characterName} • ${prettyCheck(json.checkName)} • `+
      `${modeEmoji(json.rollMode)} ${modeLabel(json.rollMode)} • `+
      `Rolls ${(json.rolls || [json.naturalRoll]).join(" / ")} • Kept ${json.naturalRoll} • `+
      `Total ${json.total} • ${json.outcome}`;
  }catch(err){
    console.error("[Mixer Dice] Submit error:",err);
    rollSubmitted=false;
    button.disabled=false;
    button.innerHTML="<span>🎲</span> ROLL AGAIN";
    status.textContent="ERROR";
    subtitle.textContent="The physical roll worked, but Discord submission failed. You may roll again.";
  }
}


const scene=new THREE.Scene();
scene.background=new THREE.Color(0x090b11);
scene.fog=new THREE.FogExp2(0x090b11,.025);
const camera=new THREE.PerspectiveCamera(42,1,.1,100);
camera.position.set(0,8.6,12.5); camera.lookAt(0,.7,0);
const renderer=new THREE.WebGLRenderer({antialias:true,powerPreference:'high-performance'});
renderer.setPixelRatio(Math.min(devicePixelRatio,2)); renderer.shadowMap.enabled=true; renderer.outputColorSpace=THREE.SRGBColorSpace; renderer.toneMapping=THREE.ACESFilmicToneMapping; host.appendChild(renderer.domElement);
scene.add(new THREE.HemisphereLight(0x718ab5,0x16100d,1.1));
const key=new THREE.DirectionalLight(0xd9e7ff,3); key.position.set(-4,10,5); key.castShadow=true; key.shadow.mapSize.set(2048,2048); scene.add(key);
const blue=new THREE.PointLight(0x416fcb,34,18,2); blue.position.set(5,4,-4); scene.add(blue);
const warm=new THREE.PointLight(0x8c4c2c,15,15,2); warm.position.set(-5,2,4); scene.add(warm);

const world=new CANNON.World({gravity:new CANNON.Vec3(0,-18,0)}); world.allowSleep=true; world.solver.iterations=18;
const diceMat=new CANNON.Material('dice'), trayMat=new CANNON.Material('tray');
world.addContactMaterial(new CANNON.ContactMaterial(diceMat,trayMat,{friction:.34,restitution:.36,contactEquationStiffness:1e8,contactEquationRelaxation:3}));
const W=12,D=8.2,WH=1,WT=.45;
function staticBox(x,y,z,sx,sy,sz,color=0x241b17){const m=new THREE.Mesh(new THREE.BoxGeometry(sx,sy,sz),new THREE.MeshStandardMaterial({color,roughness:.9}));m.position.set(x,y,z);m.receiveShadow=true;m.castShadow=true;scene.add(m);const b=new CANNON.Body({type:CANNON.Body.STATIC,material:trayMat,shape:new CANNON.Box(new CANNON.Vec3(sx/2,sy/2,sz/2))});b.position.set(x,y,z);world.addBody(b)}
staticBox(0,-.3,0,W,.6,D,0x151a20); staticBox(0,WH/2,-(D/2+WT/2),W+WT*2,WH,WT); staticBox(0,WH/2,D/2+WT/2,W+WT*2,WH,WT); staticBox(-(W/2+WT/2),WH/2,0,WT,WH,D); staticBox(W/2+WT/2,WH/2,0,WT,WH,D);
const felt=new THREE.Mesh(new THREE.PlaneGeometry(W-.65,D-.65),new THREE.MeshStandardMaterial({color:0x101c20,roughness:1})); felt.rotation.x=-Math.PI/2; felt.position.y=.012; felt.receiveShadow=true; scene.add(felt);
const grid=new THREE.GridHelper(10,20,0x243a48,0x17242d);grid.position.y=.02;grid.material.transparent=true;grid.material.opacity=.26;scene.add(grid);

const P=(1+Math.sqrt(5))/2,R=1.42;
const rawV=[[-1,P,0],[1,P,0],[-1,-P,0],[1,-P,0],[0,-1,P],[0,1,P],[0,-1,-P],[0,1,-P],[P,0,-1],[P,0,1],[-P,0,-1],[-P,0,1]];
const rawF=[[0,11,5],[0,5,1],[0,1,7],[0,7,10],[0,10,11],[1,5,9],[5,11,4],[11,10,2],[10,7,6],[7,1,8],[3,9,4],[3,4,2],[3,2,6],[3,6,8],[3,8,9],[4,9,5],[2,4,11],[6,2,10],[8,6,7],[9,8,1]];
const verts=rawV.map(v=>{const t=new THREE.Vector3(...v).normalize().multiplyScalar(R);return[t.x,t.y,t.z]});
const faces=rawF.map(f=>{const [a,b,c]=f.map(i=>new THREE.Vector3(...verts[i]));const n=new THREE.Vector3().subVectors(b,a).cross(new THREE.Vector3().subVectors(c,a)).normalize();const center=a.clone().add(b).add(c).multiplyScalar(1/3);return n.dot(center)<0?[f[0],f[2],f[1]]:[...f]});
const normals=faces.map(f=>{const [a,b,c]=f.map(i=>new THREE.Vector3(...verts[i]));return new THREE.Vector3().subVectors(b,a).cross(new THREE.Vector3().subVectors(c,a)).normalize()});
function numbering(){const nums=new Array(20);const open=new Set([...Array(20).keys()]);const pairs=[[20,1],[19,2],[18,3],[17,4],[16,5],[15,6],[14,7],[13,8],[12,9],[11,10]];for(const [hi,lo] of pairs){const first=[...open][0];open.delete(first);let opp,best=Infinity;for(const c of open){const d=normals[first].dot(normals[c]);if(d<best){best=d;opp=c}}open.delete(opp);nums[first]=hi;nums[opp]=lo}return nums} const numbers=numbering();

function numberTexture(n){
  const c=document.createElement('canvas');
  c.width=c.height=512;
  const x=c.getContext('2d');
  x.clearRect(0,0,512,512);

  x.textAlign='center';
  x.textBaseline='middle';

  // v0.3.2: much larger, high-contrast numbers.
  const fontSize=n>=10?190:222;
  x.font=`700 ${fontSize}px Georgia`;

  // Deep engraved shadow.
  x.shadowColor='rgba(0,0,0,.98)';
  x.shadowBlur=20;
  x.shadowOffsetY=8;
  x.fillStyle='#070b13';
  x.fillText(String(n),256,258);

  // Bright silver fill.
  x.shadowBlur=8;
  x.shadowOffsetY=1;
  x.fillStyle='#f3f7ff';
  x.fillText(String(n),256,250);

  // Fine metallic highlight.
  x.shadowBlur=0;
  x.lineWidth=4;
  x.strokeStyle='rgba(170,205,255,.82)';
  x.strokeText(String(n),256,250);

  // Standard 6/9 orientation marker.
  if(n===6||n===9){
    x.fillStyle='#eef5ff';
    x.fillRect(207,367,98,9);
  }

  const t=new THREE.CanvasTexture(c);
  t.colorSpace=THREE.SRGBColorSpace;
  t.anisotropy=renderer.capabilities.getMaxAnisotropy();
  return t;
}

// Solid sapphire core
const solidPos=[];
for(const f of faces){
  for(const vi of f) solidPos.push(...verts[vi]);
}

const solidGeo=new THREE.BufferGeometry();
solidGeo.setAttribute('position',new THREE.Float32BufferAttribute(solidPos,3));
solidGeo.computeVertexNormals();

const solidMat=new THREE.MeshPhysicalMaterial({
  color:0x17467f,
  roughness:.25,
  metalness:.14,
  clearcoat:1,
  clearcoatRoughness:.14,
  transmission:.05,
  thickness:.5,
  ior:1.45,
  reflectivity:.6,
  flatShading:true,
  emissive:0x0a2b58,
  emissiveIntensity:.42
});

const solid=new THREE.Mesh(solidGeo,solidMat);
solid.castShadow=true;
solid.receiveShadow=true;

// Inner magical crystal
const inner=new THREE.Mesh(
  new THREE.IcosahedronGeometry(R*.88,0),
  new THREE.MeshPhysicalMaterial({
    color:0x1d4e8f,
    transparent:true,
    opacity:.28,
    roughness:.08,
    metalness:.08,
    transmission:.28,
    thickness:.8,
    emissive:0x0b2d66,
    emissiveIntensity:.55,
    depthWrite:false
  })
);

// v0.3.2: front-facing number planes.
// The previous triangular UV decals could be viewed from their back side,
// which made some digits look mirrored. These planes have a defined outward
// normal and render FRONT SIDE ONLY, so every number reads normally.
const decals=new THREE.Group();

function faceNumberQuaternion(normal){
  const n=normal.clone().normalize();

  // Pick a stable "up" reference, projected onto this triangular face.
  // Local Y of each number points as closely as possible toward die-local +Y.
  let reference=new THREE.Vector3(0,1,0);
  if(Math.abs(n.dot(reference))>.92){
    reference=new THREE.Vector3(0,0,1);
  }

  const up=reference.clone()
    .addScaledVector(n,-reference.dot(n))
    .normalize();

  const right=new THREE.Vector3()
    .crossVectors(up,n)
    .normalize();

  // Rebuild up to guarantee an orthonormal right/up/normal basis.
  up.crossVectors(n,right).normalize();

  const basis=new THREE.Matrix4().makeBasis(right,up,n);
  return new THREE.Quaternion().setFromRotationMatrix(basis);
}

for(let fi=0;fi<20;fi++){
  const f=faces[fi];
  const fv=f.map(i=>new THREE.Vector3(...verts[i]));
  const center=fv[0].clone().add(fv[1]).add(fv[2]).multiplyScalar(1/3);
  const normal=normals[fi];

  const g=new THREE.PlaneGeometry(1.18,1.18);
  const m=new THREE.MeshBasicMaterial({
    map:numberTexture(numbers[fi]),
    transparent:true,
    depthWrite:false,
    depthTest:true,
    polygonOffset:true,
    polygonOffsetFactor:-2,
    polygonOffsetUnits:-2,
    side:THREE.FrontSide
  });

  const decal=new THREE.Mesh(g,m);
  decal.position.copy(center).addScaledVector(normal,.018);
  decal.quaternion.copy(faceNumberQuaternion(normal));

  decals.add(decal);
}

// Polished edge highlights
const edges=new THREE.LineSegments(
  new THREE.EdgesGeometry(solidGeo,12),
  new THREE.LineBasicMaterial({
    color:0xa8c7f2,
    transparent:true,
    opacity:.5
  })
);

// Tiny internal magical specks
const sparkCount=42;
const sparkArr=new Float32Array(sparkCount*3);
for(let i=0;i<sparkCount;i++){
  const v=new THREE.Vector3(
    Math.random()*2-1,
    Math.random()*2-1,
    Math.random()*2-1
  ).normalize().multiplyScalar(.18+Math.random()*R*.58);

  sparkArr[i*3]=v.x;
  sparkArr[i*3+1]=v.y;
  sparkArr[i*3+2]=v.z;
}
const sparkGeo=new THREE.BufferGeometry();
sparkGeo.setAttribute('position',new THREE.BufferAttribute(sparkArr,3));
const sparks=new THREE.Points(
  sparkGeo,
  new THREE.PointsMaterial({
    color:0xa7c8ff,
    size:.032,
    transparent:true,
    opacity:.7,
    depthWrite:false
  })
);

const mesh=new THREE.Group();
mesh.add(solid,inner,decals,edges,sparks);
mesh.userData.sparks=sparks;
scene.add(mesh);

const halo=new THREE.Mesh(
  new THREE.CircleGeometry(1.95,64),
  new THREE.MeshBasicMaterial({color:0x2b66b5,transparent:true,opacity:.10,depthWrite:false})
);
halo.rotation.x=-Math.PI/2;
halo.position.y=.035;
scene.add(halo);



// v0.3: tall invisible safety walls. These exist only in Cannon physics,
// so players never see them, but even a violent d20 throw stays in the tray.
function invisibleWall(x,y,z,sx,sy,sz){
  const b=new CANNON.Body({
    type:CANNON.Body.STATIC,
    material:trayMat,
    shape:new CANNON.Box(new CANNON.Vec3(sx/2,sy/2,sz/2))
  });
  b.position.set(x,y,z);
  world.addBody(b);
}
const SAFE_H=7, SAFE_T=.35, SAFE_Y=SAFE_H/2;
invisibleWall(0,SAFE_Y,-(D/2-.08),W,SAFE_H,SAFE_T);
invisibleWall(0,SAFE_Y, (D/2-.08),W,SAFE_H,SAFE_T);
invisibleWall(-(W/2-.08),SAFE_Y,0,SAFE_T,SAFE_H,D);
invisibleWall( (W/2-.08),SAFE_Y,0,SAFE_T,SAFE_H,D);

const shape=new CANNON.ConvexPolyhedron({vertices:verts.map(v=>new CANNON.Vec3(...v)),faces:faces.map(f=>[...f])});
const body=new CANNON.Body({mass:1.15,material:diceMat,shape,linearDamping:.13,angularDamping:.11,allowSleep:true,sleepSpeedLimit:.13,sleepTimeLimit:.8});world.addBody(body);
const UP=new THREE.Vector3(0,1,0);let rolling=false,settle=0,start=0,focusResult=false;const defaultCam=new THREE.Vector3(0,8.6,12.5);const focusCam=new THREE.Vector3(0,8.5,5.5);const lookTarget=new THREE.Vector3(0,.7,0);
function top(){const q=new THREE.Quaternion(body.quaternion.x,body.quaternion.y,body.quaternion.z,body.quaternion.w);let idx=0,best=-Infinity;normals.forEach((n,i)=>{const d=n.clone().applyQuaternion(q).dot(UP);if(d>best){best=d;idx=i}});return{number:numbers[idx],faceIndex:idx,confidence:best}}
function flash(cls){burst.className='';void burst.offsetWidth;burst.className=cls;setTimeout(()=>burst.className='',1000)}
function finish(){
  if(!rolling)return;
  const physical=top();
  rolling=false;
  focusResult=true;

  if(adminTestMode){
    const tested=randomAdminResult(selectedAdminDie);
    resultEl.textContent=tested.result;
    button.disabled=false;
    button.innerHTML=`<span>🎲</span> TEST LOCAL ${selectedAdminDie.toUpperCase()} AGAIN`;
    status.textContent="ADMIN RESULT";
    subtitle.textContent=`${selectedAdminDie.toUpperCase()} • ${tested.detail} • campaign submission OFF`;
    showInputProof("ADMIN TEST FINISHED",`${selectedAdminDie}=${tested.result}`);
    if(selectedAdminDie==="d20" && tested.result===20) flash('nat20');
    if(selectedAdminDie==="d20" && tested.result===1) flash('nat1');
    window.dispatchEvent(new CustomEvent('mixer-dice-test-result',{
      detail:{die:selectedAdminDie,result:tested.result,localOnly:true,physicalD20Face:physical.number}
    }));
    return;
  }

  const r=physical;
  resultEl.textContent=r.number;
  button.disabled=true;
  button.innerHTML='<span>🎲</span> READING RESULT...';
  if(r.number===20){subtitle.textContent='NATURAL 20!';status.textContent='NAT 20';flash('nat20')}
  else if(r.number===1){subtitle.textContent='NATURAL 1!';status.textContent='NAT 1';flash('nat1')}
  else{subtitle.textContent=`Physics result • confidence ${(r.confidence*100).toFixed(1)}%`;status.textContent='RESULT'}
  console.log('[Mixer Dice]',r);
  showInputProof("PHYSICS FINISHED",`result=${r.number}`);
  window.dispatchEvent(new CustomEvent('mixer-dice-result',{
    detail:{die:'d20',result:r.number,faceIndex:r.faceIndex,confidence:r.confidence}
  }));

  if(isDiscordActivity && pendingRoll && activitySetupComplete){
    const mode=currentRollMode();
    if(mode!=="normal"){
      modeRollResults.push(r.number);
      if(modeRollResults.length===1){
        const first=modeRollResults[0];
        status.textContent="ROLL 1 OF 2";
        resultEl.textContent=first;
        subtitle.textContent=`${modeEmoji(mode)} ${modeLabel(mode)} • First roll: ${first}. Roll one more time.`;
        connectionStage.textContent=`${modeLabel(mode)} • FIRST ROLL COMPLETE`;
        connectionDetail.textContent=`First physical d20: ${first}. ${mode==="advantage"?"The higher":"The lower"} result will count.`;
        button.disabled=false;
        button.innerHTML='<span>🎲</span> ROLL SECOND D20';
        return;
      }
      const rolls=modeRollResults.slice(0,2);
      const kept=chooseKeptResult(mode,rolls);
      resultEl.textContent=kept;
      subtitle.textContent=`${modeEmoji(mode)} ${modeLabel(mode)} • Rolls ${rolls[0]} & ${rolls[1]} • Kept ${kept}`;
      status.textContent="RESULT";
      submitActivityRoll(kept,rolls);
      return;
    }
    modeRollResults=[r.number];
    submitActivityRoll(r.number,[r.number]);
  }else{
    button.disabled=false;
    button.innerHTML='<span>🎲</span> ROLL AGAIN';
    if(isDiscordActivity){
      connectionStage.textContent="LOCAL ROLL WORKED";
      connectionDetail.textContent="The physical d20 rolled successfully. Discord did not have a verified pending roll to receive it.";
    }
  }
}
const rnd=(a,b)=>a+Math.random()*(b-a);
function roll(source="unknown"){
  showInputProof("ROLL REQUEST",source);

  if(rolling){
    showRollBlocked("die is already rolling");
    return false;
  }

  // v0.5: local physics is intentionally independent from Discord.
  rolling=true;
  focusResult=false;
  settle=0;
  start=performance.now();

  resultEl.textContent='…';
  const launchDie=adminTestMode?selectedAdminDie.toUpperCase():'D20';
  subtitle.textContent=`INPUT RECEIVED — ${launchDie} test throw is launching.`;
  status.textContent='ROLLING';
  button.disabled=true;
  button.innerHTML='<span>🎲</span> ROLLING...';

  const left=Math.random()>.5;

  body.position.set(
    left?-3.8:3.8,
    rnd(4.5,6.3),
    rnd(-1.8,1.8)
  );

  body.velocity.set(
    left?rnd(5.8,8.8):rnd(-8.8,-5.8),
    rnd(.3,2.2),
    rnd(-4.8,4.8)
  );

  body.angularVelocity.set(
    rnd(-18,18),
    rnd(-22,22),
    rnd(-18,18)
  );

  body.quaternion.setFromEuler(
    Math.random()*6.28,
    Math.random()*6.28,
    Math.random()*6.28,
    'XYZ'
  );

  body.wakeUp();

  showInputProof(
    "PHYSICS STARTED",
    `v=${body.velocity.length().toFixed(2)} w=${body.angularVelocity.length().toFixed(2)}`
  );

  return true;
}

function requestPhysicalRoll(event,source){
  if(event){
    try{event.preventDefault();}catch{}
    try{event.stopPropagation();}catch{}
  }

  const now=performance.now();
  if(now-lastInputAt<250) return;
  lastInputAt=now;

  showInputProof("EVENT RECEIVED",source);

  if(button.disabled && !rolling){
    showRollBlocked("button DOM state is disabled");
    return;
  }

  roll(source);
}

window.__mixerDiceInput=(event,source="inline")=>{
  requestPhysicalRoll(event,source);
};

button.addEventListener(
  'pointerdown',
  (event)=>requestPhysicalRoll(event,'button-pointerdown'),
  {capture:true,passive:false}
);

button.addEventListener(
  'mousedown',
  (event)=>requestPhysicalRoll(event,'button-mousedown'),
  {capture:true,passive:false}
);

button.addEventListener(
  'click',
  (event)=>requestPhysicalRoll(event,'button-click'),
  {capture:true,passive:false}
);

button.addEventListener(
  'touchstart',
  (event)=>requestPhysicalRoll(event,'button-touchstart'),
  {capture:true,passive:false}
);

document.querySelector('.controls')?.addEventListener(
  'pointerdown',
  (event)=>{
    if(event.target===button || button.contains(event.target)){
      showInputProof("CONTROLS CAPTURE","pointerdown");
    }
  },
  {capture:true}
);

window.addEventListener(
  'keydown',
  (event)=>{
    if(!['Space','Enter','KeyR'].includes(event.code)) return;

    if(
      document.activeElement &&
      ['INPUT','TEXTAREA','SELECT'].includes(document.activeElement.tagName)
    ) return;

    event.preventDefault();
    showInputProof("KEYBOARD",event.code);

    if(button.disabled && !rolling){
      showRollBlocked("button DOM state is disabled");
      return;
    }

    roll(`keyboard-${event.code}`);
  },
  {capture:true}
);

adminButton.addEventListener("click",async()=>{
  if(adminTestMode){
    await exitAdminMode();
    return;
  }
  adminError.textContent="";
  adminPassword.value="";
  adminModal.hidden=false;
  setTimeout(()=>adminPassword.focus(),0);
});

adminCancel.addEventListener("click",()=>{
  adminModal.hidden=true;
  adminPassword.value="";
  adminError.textContent="";
});

adminModal.addEventListener("pointerdown",(event)=>{
  if(event.target===adminModal) adminModal.hidden=true;
});

adminForm.addEventListener("submit",async(event)=>{
  event.preventDefault();
  adminError.textContent="Checking password…";
  try{
    const res=await fetch("/api/admin/login",{
      method:"POST",
      headers:{"Content-Type":"application/json"},
      body:JSON.stringify({password:adminPassword.value})
    });
    const json=await res.json().catch(()=>({}));
    if(!res.ok || !json.ok){
      const code=json.error||`HTTP_${res.status}`;
      adminError.textContent=code==="BAD_ADMIN_PASSWORD"?"Incorrect password.":code==="ADMIN_LOCKED"?"Too many attempts. Try again in one minute.":code==="ADMIN_NOT_CONFIGURED"?"Admin password is not configured in Railway.":`Admin login failed: ${code}`;
      return;
    }
    adminToken=json.token;
    sessionStorage.setItem("mixerDiceAdminToken",adminToken);
    adminModal.hidden=true;
    adminPassword.value="";
    adminError.textContent="";
    enterAdminMode();
  }catch(err){
    adminError.textContent=`Admin login failed: ${err.message}`;
  }
});

adminExit.addEventListener("click",async()=>{
  try{ await adminApi("/api/admin/logout",{method:"POST"}); }catch{}
  adminToken="";
  sessionStorage.removeItem("mixerDiceAdminToken");
  await exitAdminMode();
});

dieGrid.addEventListener("click",(event)=>{
  const target=event.target.closest("button[data-die]");
  if(!target || !adminTestMode) return;
  selectedAdminDie=target.dataset.die;
  resultEl.textContent="—";
  subtitle.textContent=`${selectedAdminDie.toUpperCase()} selected. Ready for a local test roll.`;
  updateAdminDieUI();
});

retryButton.addEventListener("click",async(event)=>{
  event.preventDefault();
  event.stopPropagation();

  showInputProof("RETRY CONNECTION");

  retryButton.hidden=true;
  discordAuth=null;
  discordSdk=null;
  pendingRoll=null;
  activitySetupComplete=false;
  rollSubmitted=false;

  await setupDiscordActivity({force:true});
});

const clock=new THREE.Clock();let acc=0;const step=1/120;
function resize(){renderer.setSize(host.clientWidth,host.clientHeight,false);camera.aspect=host.clientWidth/Math.max(1,host.clientHeight);camera.updateProjectionMatrix()}new ResizeObserver(resize).observe(host);resize();
function loop(){requestAnimationFrame(loop);const dt=Math.min(clock.getDelta(),.05);acc+=dt;let n=0;while(acc>=step&&n<8){world.step(step);acc-=step;n++}mesh.position.set(body.position.x,body.position.y,body.position.z);mesh.quaternion.set(body.quaternion.x,body.quaternion.y,body.quaternion.z,body.quaternion.w);if(rolling){const elapsed=performance.now()-start;if(body.velocity.length()<.16&&body.angularVelocity.length()<.18&&elapsed>800)settle+=dt;else settle=0;if(settle>.72){const r=top();if(r.confidence>.91||elapsed>9000)finish()}if(elapsed>12000)finish()}
if(mesh.userData.sparks){mesh.userData.sparks.rotation.y+=dt*.35;mesh.userData.sparks.rotation.x+=dt*.12;}halo.position.x=body.position.x;halo.position.z=body.position.z;halo.material.opacity=.09+Math.sin(performance.now()*.0025)*.02;
const desired=focusResult?focusCam:defaultCam;
camera.position.lerp(desired,1-Math.pow(.001,dt));
const target=focusResult?new THREE.Vector3(body.position.x,Math.max(.8,body.position.y+.15),body.position.z):new THREE.Vector3(0,.7,0);
lookTarget.lerp(target,1-Math.pow(.0025,dt));
camera.lookAt(lookTarget);
renderer.render(scene,camera)}
body.position.set(0,2.6,0);body.quaternion.setFromEuler(.3,.8,.15);loop();
console.log('[Mixer Dice] v0.5.4 admin test mode ready');

// Lock the control before the first browser paint in Discord Activity mode.
if(isDiscordActivity){
  button.disabled=true;
  button.innerHTML="<span>🎲</span> CONNECTING...";
  status.textContent="CONNECTING";
  subtitle.textContent="Verifying Discord and checking for a pending roll...";
}else{
  connectionCard.hidden=true;
}

tryRestoreAdminSession().then((restored)=>{
  if(!restored) setupDiscordActivity();
});
