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
  setActiveDice(selectedAdminDie);
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
  setActiveDice("d20");
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

// v0.6.4 containment cage: tall PHYSICS-ONLY walls sit directly above the
// visible tray rim. They are intentionally not rendered, so dice can bounce
// high without ever escaping the box or appearing to hit an extra wall.
function invisiblePhysicsBox(x,y,z,sx,sy,sz){
  const body=new CANNON.Body({
    type:CANNON.Body.STATIC,
    material:trayMat,
    shape:new CANNON.Box(new CANNON.Vec3(sx/2,sy/2,sz/2))
  });
  body.position.set(x,y,z);
  world.addBody(body);
  return body;
}
const SAFETY_WALL_HEIGHT=10;
const SAFETY_WALL_Y=SAFETY_WALL_HEIGHT/2;
const SAFETY_THICKNESS=.72;
invisiblePhysicsBox(0,SAFETY_WALL_Y,-(D/2+WT/2),W+WT*2,SAFETY_WALL_HEIGHT,SAFETY_THICKNESS);
invisiblePhysicsBox(0,SAFETY_WALL_Y, D/2+WT/2,W+WT*2,SAFETY_WALL_HEIGHT,SAFETY_THICKNESS);
invisiblePhysicsBox(-(W/2+WT/2),SAFETY_WALL_Y,0,SAFETY_THICKNESS,SAFETY_WALL_HEIGHT,D+WT*2);
invisiblePhysicsBox( W/2+WT/2,SAFETY_WALL_Y,0,SAFETY_THICKNESS,SAFETY_WALL_HEIGHT,D+WT*2);

const felt=new THREE.Mesh(new THREE.PlaneGeometry(W-.65,D-.65),new THREE.MeshStandardMaterial({color:0x101c20,roughness:1})); felt.rotation.x=-Math.PI/2; felt.position.y=.012; felt.receiveShadow=true; scene.add(felt);
const grid=new THREE.GridHelper(10,20,0x243a48,0x17242d);grid.position.y=.02;grid.material.transparent=true;grid.material.opacity=.26;scene.add(grid);

// v0.6.1: restore the magical halo used by the animation loop.
// v0.6.0 referenced `halo` every frame but never created it, which stopped
// rendering before the first frame and left the dice tray empty.
const halo=new THREE.Mesh(
  new THREE.CircleGeometry(1.95,64),
  new THREE.MeshBasicMaterial({color:0x2b66b5,transparent:true,opacity:.10,depthWrite:false})
);
halo.rotation.x=-Math.PI/2;
halo.position.y=.035;
scene.add(halo);

const R=1.42;
const UP=new THREE.Vector3(0,1,0);
let rolling=false,settle=0,start=0,focusResult=false;
const defaultCam=new THREE.Vector3(0,8.6,12.5);
const focusCam=new THREE.Vector3(0,8.5,5.5);
const lookTarget=new THREE.Vector3(0,.7,0);
let activeDice=[];
let activeDieType="d20";

function orientFaces(vertices,faces){
  return faces.map(face=>{
    if(face.length<3) return face.slice();
    const a=new THREE.Vector3(...vertices[face[0]]);
    const b=new THREE.Vector3(...vertices[face[1]]);
    const c=new THREE.Vector3(...vertices[face[2]]);
    const normal=new THREE.Vector3().subVectors(b,a).cross(new THREE.Vector3().subVectors(c,a));
    const center=face.reduce((acc,i)=>acc.add(new THREE.Vector3(...vertices[i])),new THREE.Vector3()).multiplyScalar(1/face.length);
    return normal.dot(center)<0 ? [face[0],...face.slice(1).reverse()] : face.slice();
  });
}

function scaleVertices(vertices,radius=R){
  const max=Math.max(...vertices.map(v=>Math.hypot(...v)));
  return vertices.map(v=>v.map(n=>n/max*radius));
}

function faceNormals(vertices,faces){
  return faces.map(face=>{
    const a=new THREE.Vector3(...vertices[face[0]]),b=new THREE.Vector3(...vertices[face[1]]),c=new THREE.Vector3(...vertices[face[2]]);
    return new THREE.Vector3().subVectors(b,a).cross(new THREE.Vector3().subVectors(c,a)).normalize();
  });
}

function dualPolyhedron(primalVertices,primalFaces,radius=R){
  const pv=primalVertices.map(v=>new THREE.Vector3(...v));
  const pf=orientFaces(primalVertices,primalFaces);
  const dualVerts=pf.map(face=>{
    const center=face.reduce((a,i)=>a.add(pv[i]),new THREE.Vector3()).multiplyScalar(1/face.length);
    return center.normalize().toArray();
  });
  const dualFaces=pv.map((vertex,vi)=>{
    const incident=[];
    pf.forEach((face,fi)=>{ if(face.includes(vi)) incident.push(fi); });
    const axis=vertex.clone().normalize();
    let ref=new THREE.Vector3(0,1,0);
    if(Math.abs(axis.dot(ref))>.9) ref.set(1,0,0);
    const u=ref.clone().addScaledVector(axis,-ref.dot(axis)).normalize();
    const v=new THREE.Vector3().crossVectors(axis,u).normalize();
    incident.sort((a,b)=>{
      const pa=new THREE.Vector3(...dualVerts[a]).normalize();
      const pb=new THREE.Vector3(...dualVerts[b]).normalize();
      const aa=Math.atan2(pa.dot(v),pa.dot(u));
      const ab=Math.atan2(pb.dot(v),pb.dot(u));
      return aa-ab;
    });
    return incident;
  });
  const scaled=scaleVertices(dualVerts,radius);
  return {vertices:scaled,faces:orientFaces(scaled,dualFaces)};
}

function makeD20(){
  const P=(1+Math.sqrt(5))/2;
  const rawV=[[-1,P,0],[1,P,0],[-1,-P,0],[1,-P,0],[0,-1,P],[0,1,P],[0,-1,-P],[0,1,-P],[P,0,-1],[P,0,1],[-P,0,-1],[-P,0,1]];
  const rawF=[[0,11,5],[0,5,1],[0,1,7],[0,7,10],[0,10,11],[1,5,9],[5,11,4],[11,10,2],[10,7,6],[7,1,8],[3,9,4],[3,4,2],[3,2,6],[3,6,8],[3,8,9],[4,9,5],[2,4,11],[6,2,10],[8,6,7],[9,8,1]];
  const vertices=scaleVertices(rawV,R),faces=orientFaces(vertices,rawF),normals=faceNormals(vertices,faces);
  const nums=new Array(20),open=new Set([...Array(20).keys()]);
  for(const [hi,lo] of [[20,1],[19,2],[18,3],[17,4],[16,5],[15,6],[14,7],[13,8],[12,9],[11,10]]){
    const first=[...open][0];open.delete(first);let opp,best=Infinity;
    for(const c of open){const d=normals[first].dot(normals[c]);if(d<best){best=d;opp=c}}
    open.delete(opp);nums[first]=hi;nums[opp]=lo;
  }
  return {vertices,faces,values:nums,labelSize:1.18};
}

function makeD4(){
  const vertices=scaleVertices([[1,1,1],[-1,-1,1],[-1,1,-1],[1,-1,-1]],R);
  const faces=orientFaces(vertices,[[0,2,1],[0,1,3],[0,3,2],[1,2,3]]);
  return {vertices,faces,values:[1,2,3,4],labelSize:1.05};
}

function makeD6(){
  const vertices=scaleVertices([[-1,-1,-1],[1,-1,-1],[1,1,-1],[-1,1,-1],[-1,-1,1],[1,-1,1],[1,1,1],[-1,1,1]],R*1.02);
  const faces=orientFaces(vertices,[[0,3,2,1],[4,5,6,7],[0,4,7,3],[1,2,6,5],[3,7,6,2],[0,1,5,4]]);
  return {vertices,faces,values:[1,6,2,5,3,4],labelSize:1.18};
}

function makeD8(){
  const vertices=scaleVertices([[1,0,0],[-1,0,0],[0,1,0],[0,-1,0],[0,0,1],[0,0,-1]],R);
  const faces=orientFaces(vertices,[[2,0,4],[2,4,1],[2,1,5],[2,5,0],[3,4,0],[3,1,4],[3,5,1],[3,0,5]]);
  return {vertices,faces,values:[1,2,3,4,5,6,7,8],labelSize:.92};
}

function makeD10(){
  // Classic RPG d10: a pentagonal trapezohedron with 10 true kite faces.
  // Two staggered pentagonal rings sit close to the waist, with pointed
  // north/south poles. Each result corresponds to one complete kite face.
  const waistY=.16;
  const poleY=waistY*(5+2*Math.sqrt(5)); // ~= 9.472 * waistY; keeps each kite planar
  const ringRadius=1;
  const raw=[];

  // Upper pentagon.
  for(let i=0;i<5;i++){
    const a=2*Math.PI*i/5;
    raw.push([ringRadius*Math.cos(a),waistY,ringRadius*Math.sin(a)]);
  }
  // Lower pentagon, rotated 36 degrees.
  for(let i=0;i<5;i++){
    const a=2*Math.PI*i/5+Math.PI/5;
    raw.push([ringRadius*Math.cos(a),-waistY,ringRadius*Math.sin(a)]);
  }

  const TOP=10,BOTTOM=11;
  raw.push([0,poleY,0],[0,-poleY,0]);

  const rawFaces=[];
  for(let i=0;i<5;i++){
    const next=(i+1)%5;
    rawFaces.push([TOP,i,5+i,next]);
    rawFaces.push([BOTTOM,5+i,next,5+next]);
  }

  // Slightly wider than the mathematical solid so it reads clearly as the
  // familiar tabletop d10 while preserving the true kite-face topology.
  const vertices=scaleVertices(raw,R*1.03).map(([x,y,z])=>[x*1.05,y,z*1.05]);
  const faces=orientFaces(vertices,rawFaces);
  return {vertices,faces,values:[0,1,2,3,4,5,6,7,8,9],labelSize:.70};
}

function makeD12(){
  const ico=makeD20();
  const dual=dualPolyhedron(ico.vertices,ico.faces,R);
  return {...dual,values:[1,2,3,4,5,6,7,8,9,10,11,12],labelSize:.78};
}

function polyFor(type){
  if(type==="d4") return makeD4();
  if(type==="d6") return makeD6();
  if(type==="d8") return makeD8();
  if(type==="d10"||type==="d100") return makeD10();
  if(type==="d12") return makeD12();
  return makeD20();
}

function numberTexture(n){
  const c=document.createElement('canvas');c.width=c.height=512;const x=c.getContext('2d');x.clearRect(0,0,512,512);
  x.textAlign='center';x.textBaseline='middle';const text=String(n);const fontSize=text.length>=2?180:225;x.font=`700 ${fontSize}px Georgia`;
  x.shadowColor='rgba(0,0,0,.98)';x.shadowBlur=20;x.shadowOffsetY=8;x.fillStyle='#070b13';x.fillText(text,256,258);
  x.shadowBlur=8;x.shadowOffsetY=1;x.fillStyle='#f3f7ff';x.fillText(text,256,250);
  x.shadowBlur=0;x.lineWidth=4;x.strokeStyle='rgba(170,205,255,.82)';x.strokeText(text,256,250);
  if(n===6||n===9){x.fillStyle='#eef5ff';x.fillRect(207,367,98,9)}
  const t=new THREE.CanvasTexture(c);t.colorSpace=THREE.SRGBColorSpace;t.anisotropy=renderer.capabilities.getMaxAnisotropy();return t;
}

function faceQuaternion(normal){
  const n=normal.clone().normalize();let reference=new THREE.Vector3(0,1,0);if(Math.abs(n.dot(reference))>.92)reference=new THREE.Vector3(0,0,1);
  const up=reference.clone().addScaledVector(n,-reference.dot(n)).normalize();const right=new THREE.Vector3().crossVectors(up,n).normalize();up.crossVectors(n,right).normalize();
  return new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(right,up,n));
}

function buildRenderGeometry(vertices,faces){
  const pos=[];
  for(const face of faces){for(let i=1;i<face.length-1;i++) pos.push(...vertices[face[0]],...vertices[face[i]],...vertices[face[i+1]]);}
  const geo=new THREE.BufferGeometry();geo.setAttribute('position',new THREE.Float32BufferAttribute(pos,3));geo.computeVertexNormals();return geo;
}

function createPhysicalDie(type,valuesOverride=null,scale=.98){
  const spec=polyFor(type);const vertices=spec.vertices.map(v=>v.map(n=>n*scale));const faces=spec.faces.map(f=>f.slice());const normals=faceNormals(vertices,faces);
  const values=valuesOverride||spec.values;
  const solidGeo=buildRenderGeometry(vertices,faces);
  const solid=new THREE.Mesh(solidGeo,new THREE.MeshPhysicalMaterial({color:0x17467f,roughness:.25,metalness:.14,clearcoat:1,clearcoatRoughness:.14,transmission:.05,thickness:.5,ior:1.45,reflectivity:.6,flatShading:true,emissive:0x0a2b58,emissiveIntensity:.42}));
  solid.castShadow=true;solid.receiveShadow=true;
  const decals=new THREE.Group();
  faces.forEach((face,fi)=>{
    const center=face.reduce((a,i)=>a.add(new THREE.Vector3(...vertices[i])),new THREE.Vector3()).multiplyScalar(1/face.length);const normal=normals[fi];
    const g=new THREE.PlaneGeometry(spec.labelSize*scale,spec.labelSize*scale);
    const m=new THREE.MeshBasicMaterial({map:numberTexture(values[fi]),transparent:true,depthWrite:false,depthTest:true,polygonOffset:true,polygonOffsetFactor:-2,polygonOffsetUnits:-2,side:THREE.FrontSide});
    const decal=new THREE.Mesh(g,m);decal.position.copy(center).addScaledVector(normal,.018);decal.quaternion.copy(faceQuaternion(normal));decals.add(decal);
  });
  const edges=new THREE.LineSegments(new THREE.EdgesGeometry(solidGeo,12),new THREE.LineBasicMaterial({color:0xa8c7f2,transparent:true,opacity:.5}));
  const group=new THREE.Group();group.add(solid,decals,edges);scene.add(group);
  const shape=new CANNON.ConvexPolyhedron({vertices:vertices.map(v=>new CANNON.Vec3(...v)),faces});
  const body=new CANNON.Body({mass:1.15,material:diceMat,shape,linearDamping:.13,angularDamping:.11,allowSleep:true,sleepSpeedLimit:.13,sleepTimeLimit:.8});world.addBody(body);
  return {type,mesh:group,body,normals,values};
}

function disposeDie(inst){
  world.removeBody(inst.body);scene.remove(inst.mesh);
  inst.mesh.traverse(o=>{if(o.geometry)o.geometry.dispose?.();if(o.material){const mats=Array.isArray(o.material)?o.material:[o.material];mats.forEach(m=>{m.map?.dispose?.();m.dispose?.();});}});
}

function setActiveDice(type="d20"){
  if(rolling) return;
  if(activeDieType===type && activeDice.length) return;
  activeDice.forEach(disposeDie);activeDice=[];activeDieType=type;
  if(type==="d100"){
    // Percentile pair: the tens die is visibly labeled 10-100, while 100
    // represents the traditional 00 face for percentile math.
    activeDice.push(createPhysicalDie("d10",[10,20,30,40,50,60,70,80,90,100],.86));
    activeDice.push(createPhysicalDie("d10",[0,1,2,3,4,5,6,7,8,9],.86));
    activeDice[0].mesh.position.x=-1.2;activeDice[1].mesh.position.x=1.2;
    activeDice[0].body.position.set(-1.2,2.6,0);activeDice[1].body.position.set(1.2,2.6,0);
  }else{
    activeDice.push(createPhysicalDie(type));activeDice[0].body.position.set(0,2.6,0);
  }
  activeDice.forEach((d,i)=>d.body.quaternion.setFromEuler(.25+i*.2,.75+i*.35,.15));
}

function readDie(inst){
  const q=new THREE.Quaternion(inst.body.quaternion.x,inst.body.quaternion.y,inst.body.quaternion.z,inst.body.quaternion.w);let idx=0,best=-Infinity;
  inst.normals.forEach((n,i)=>{const d=n.clone().applyQuaternion(q).dot(UP);if(d>best){best=d;idx=i}});
  return {number:inst.values[idx],faceIndex:idx,confidence:best};
}
function top(){return readDie(activeDice[0]);}
function flash(cls){burst.className='';void burst.offsetWidth;burst.className=cls;setTimeout(()=>burst.className='',1000)}
function finish(){
  if(!rolling)return;rolling=false;focusResult=true;
  if(adminTestMode){
    if(selectedAdminDie==="d100"){
      const tens=readDie(activeDice[0]),ones=readDie(activeDice[1]);
      const tensBase=tens.number===100?0:tens.number;
      const result=(tens.number===100&&ones.number===0)?100:tensBase+ones.number;
      resultEl.textContent=result;button.disabled=false;button.innerHTML='<span>🎲</span> TEST LOCAL D100 AGAIN';status.textContent="ADMIN RESULT";
      const tensDisplay=tens.number===100?"100 (00)":String(tens.number);
      subtitle.textContent=`D100 • percentile ${tensDisplay} + ${ones.number} • campaign submission OFF`;
      showInputProof("ADMIN TEST FINISHED",`d100=${result}`);
      window.dispatchEvent(new CustomEvent('mixer-dice-test-result',{detail:{die:'d100',result,tens:tens.number,ones:ones.number,localOnly:true}}));return;
    }
    const r=readDie(activeDice[0]);resultEl.textContent=r.number;button.disabled=false;button.innerHTML=`<span>🎲</span> TEST LOCAL ${selectedAdminDie.toUpperCase()} AGAIN`;status.textContent="ADMIN RESULT";
    subtitle.textContent=`${selectedAdminDie.toUpperCase()} • physical top-face result • confidence ${(r.confidence*100).toFixed(1)}% • campaign submission OFF`;
    showInputProof("ADMIN TEST FINISHED",`${selectedAdminDie}=${r.number}`);if(selectedAdminDie==="d20"&&r.number===20)flash('nat20');if(selectedAdminDie==="d20"&&r.number===1)flash('nat1');
    window.dispatchEvent(new CustomEvent('mixer-dice-test-result',{detail:{die:selectedAdminDie,result:r.number,faceIndex:r.faceIndex,confidence:r.confidence,localOnly:true}}));return;
  }
  const r=readDie(activeDice[0]);resultEl.textContent=r.number;button.disabled=true;button.innerHTML='<span>🎲</span> READING RESULT...';
  if(r.number===20){subtitle.textContent='NATURAL 20!';status.textContent='NAT 20';flash('nat20')}else if(r.number===1){subtitle.textContent='NATURAL 1!';status.textContent='NAT 1';flash('nat1')}else{subtitle.textContent=`Physics result • confidence ${(r.confidence*100).toFixed(1)}%`;status.textContent='RESULT'}
  showInputProof("PHYSICS FINISHED",`result=${r.number}`);window.dispatchEvent(new CustomEvent('mixer-dice-result',{detail:{die:'d20',result:r.number,faceIndex:r.faceIndex,confidence:r.confidence}}));
  if(isDiscordActivity&&pendingRoll&&activitySetupComplete){const mode=currentRollMode();if(mode!=="normal"){modeRollResults.push(r.number);if(modeRollResults.length===1){const first=modeRollResults[0];status.textContent="ROLL 1 OF 2";resultEl.textContent=first;subtitle.textContent=`${modeEmoji(mode)} ${modeLabel(mode)} • First roll: ${first}. Roll one more time.`;connectionStage.textContent=`${modeLabel(mode)} • FIRST ROLL COMPLETE`;connectionDetail.textContent=`First physical d20: ${first}. ${mode==="advantage"?"The higher":"The lower"} result will count.`;button.disabled=false;button.innerHTML='<span>🎲</span> ROLL SECOND D20';return}const rolls=modeRollResults.slice(0,2),kept=chooseKeptResult(mode,rolls);resultEl.textContent=kept;subtitle.textContent=`${modeEmoji(mode)} ${modeLabel(mode)} • Rolls ${rolls[0]} & ${rolls[1]} • Kept ${kept}`;status.textContent="RESULT";submitActivityRoll(kept,rolls);return}modeRollResults=[r.number];submitActivityRoll(r.number,[r.number])}else{button.disabled=false;button.innerHTML='<span>🎲</span> ROLL AGAIN';if(isDiscordActivity){connectionStage.textContent="LOCAL ROLL WORKED";connectionDetail.textContent="The physical d20 rolled successfully. Discord did not have a verified pending roll to receive it."}}
}
const rnd=(a,b)=>a+Math.random()*(b-a);
function roll(source="unknown"){
  showInputProof("ROLL REQUEST",source);if(rolling){showRollBlocked("die is already rolling");return false}rolling=true;focusResult=false;settle=0;start=performance.now();resultEl.textContent='…';const launchDie=adminTestMode?selectedAdminDie.toUpperCase():'D20';subtitle.textContent=`INPUT RECEIVED — ${launchDie} physical throw is launching.`;status.textContent='ROLLING';button.disabled=true;button.innerHTML='<span>🎲</span> ROLLING...';
  activeDice.forEach((d,i)=>{const left=(i===0?Math.random()>.5:Math.random()<=.5);const spread=activeDice.length>1?(i===0?-1.1:1.1):0;d.body.position.set((left?-3.6:3.6)+spread,rnd(4.7,6.5),rnd(-1.7,1.7));d.body.velocity.set(left?rnd(5.8,8.4):rnd(-8.4,-5.8),rnd(.4,2.4),rnd(-4.6,4.6));d.body.angularVelocity.set(rnd(-18,18),rnd(-22,22),rnd(-18,18));d.body.quaternion.setFromEuler(Math.random()*6.28,Math.random()*6.28,Math.random()*6.28,'XYZ');d.body.wakeUp();});
  showInputProof("PHYSICS STARTED",`${activeDice.length} die/dice • ${activeDieType}`);return true;
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
function loop(){requestAnimationFrame(loop);const dt=Math.min(clock.getDelta(),.05);acc+=dt;let n=0;while(acc>=step&&n<8){world.step(step);acc-=step;n++}
  activeDice.forEach(d=>{d.mesh.position.set(d.body.position.x,d.body.position.y,d.body.position.z);d.mesh.quaternion.set(d.body.quaternion.x,d.body.quaternion.y,d.body.quaternion.z,d.body.quaternion.w)});
  if(rolling){const elapsed=performance.now()-start;const settled=activeDice.every(d=>d.body.velocity.length()<.18&&d.body.angularVelocity.length()<.2);if(settled&&elapsed>900)settle+=dt;else settle=0;if(settle>.78||elapsed>12000)finish()}
  const avg=activeDice.length?activeDice.reduce((a,d)=>a.add(new THREE.Vector3(d.body.position.x,d.body.position.y,d.body.position.z)),new THREE.Vector3()).multiplyScalar(1/activeDice.length):new THREE.Vector3();halo.position.x=avg.x;halo.position.z=avg.z;halo.material.opacity=.09+Math.sin(performance.now()*.0025)*.02;
  const desired=focusResult?focusCam:defaultCam;camera.position.lerp(desired,1-Math.pow(.001,dt));const target=focusResult?new THREE.Vector3(avg.x,Math.max(.8,avg.y+.15),avg.z):new THREE.Vector3(0,.7,0);lookTarget.lerp(target,1-Math.pow(.0025,dt));camera.lookAt(lookTarget);renderer.render(scene,camera)}
setActiveDice("d20");loop();
console.log('[Mixer Dice] v0.6.1 dice render hotfix ready');

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
