/* ============================================================================
   v2 VIRTUAL WORLD VIEW (Phase 5) — the live app-core Virtual World
   + Rooms block, ported: the avatar builder (OPTS, cleanLook,
   avatarSVG — exported, the Creators Wardrobe renders with the
   same functions), the four rooms with their SVG scenes, tap-to-
   walk, poses, say bubbles + room log, presence over the changes-
   feed room (the platform room, shaped like the live lobby), and
   the World3D enhancement layer (js/world3d.js) mounted over the
   scene exactly as live mounts it. The AI selfie matcher rides the
   live code's own local fallback (localMatch) — the hosted sample
   classifier has no v2 door; the photo face works either way.
   ============================================================================ */

import { MARKUP } from "./world-markup.js";
import { firestore, esc } from "../platform.js";
import { toast } from "../commerce.js";
import { World3D } from "../world3d.js";


const OPTS={
  skin:{label:"Skin",vals:["#f6d3b3","#e0ac83","#c68a5e","#a26a43","#7a4a2b","#4f2f1c"]},
  hair:{label:"Hair",vals:["fade","locs","braids","waves","long","bun","bald"]},
  hairColor:{label:"Hair color",vals:["#111111","#4a2c17","#8a5a2b","#d4a843","#b0263a","#e8e2d5"]},
  outfit:{label:"Outfit",vals:["suit","hoodie","dress","track"]},
  outfitColor:{label:"Outfit color",vals:["#111111","#d4a843","#f3ecdc","#7a1f2b","#1f3d7a","#2f6b45"]},
  extra:{label:"Extras",vals:["none","shades","goldchain","crown","cap"]},
  trim:{label:"Trim color",vals:["#d4a843","#f3ecdc","#111111","#b0263a","#3de0ff","#7b5cff"]},
  print:{label:"Chest print",vals:["none","emblem","compass","text"]},
  printColor:{label:"Print color",vals:["#d4a843","#f3ecdc","#111111","#b0263a","#3de0ff"]}
};
export const lookState = { current: {skin:"#a26a43",hair:"fade",hairColor:"#111111",outfit:"suit",outfitColor:"#111111",extra:"shades",trim:"#d4a843",print:"none",printColor:"#d4a843",printText:"MW",photo:false} };
export const faceState = { current: "" };
try{ const s=JSON.parse(localStorage.getItem("mw-look")||"null"); if(s) lookState.current={...lookState.current,...s}; }catch(e){}
export const getLook = () => lookState.current;
let _clipN=0;
const LOOK_DEF={skin:"#a26a43",hair:"fade",hairColor:"#111111",outfit:"suit",outfitColor:"#111111",extra:"none",trim:"#d4a843",print:"none",printColor:"#d4a843"};
export function cleanLook(L){ const o={...(L||{})}; for(const k in LOOK_DEF){ const v=o[k]; if(OPTS[k]&&!OPTS[k].vals.includes(v)) o[k]=(k in OPTS && /^#[0-9a-f]{6}$/i.test(v||"") && OPTS[k].vals[0].startsWith("#"))? v : LOOK_DEF[k]; } o.printText=String(o.printText||"").slice(0,10); o.photo=!!o.photo; return o; }
export const cleanFace = f => /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(f||"") ? f : "";
export function avatarSVG(L,pose,face){
  L=cleanLook(L); face=cleanFace(face);
  pose=["stand","wave","dance","sit"].includes(pose)?pose:"stand";
  const s=L.skin, hc=L.hairColor, oc=L.outfitColor, trim=L.trim||"#d4a843", sh="#000";
  const dark=c=>`${c}`;
  let hairBack="", hairFront="";
  if(L.hair==="fade"){ hairFront=`<path d="M36 38q-1-20 14-21q15 1 14 21q-3-9-14-10q-11 1-14 10z" fill="${hc}"/><path d="M37 37q2-6 6-8" stroke="#fff" stroke-opacity=".12" stroke-width="1.2" fill="none"/>`; }
  if(L.hair==="waves"){ hairFront=`<path d="M35 39q-1-22 15-23q16 1 15 23q-4-11-15-12q-11 1-15 12z" fill="${hc}"/><path d="M39 27q4-3 8 0t8 0t8 0M38 32q4-3 8 0t8 0t8 0" stroke="#fff" stroke-opacity=".14" fill="none"/>`; }
  if(L.hair==="locs"){ hairBack=[36,40,44,56,60,64].map((x,i)=>`<rect x="${x-1.8}" y="30" width="3.6" height="${30+(i%3)*6}" rx="1.8" fill="${hc}"/><path d="M${x} 34v${24+(i%3)*6}" stroke="#fff" stroke-opacity=".1" stroke-dasharray="2 2"/>`).join(""); hairFront=`<path d="M34 40q-1-24 16-24q17 0 16 24q-5-10-16-11q-11 1-16 11z" fill="${hc}"/>`; }
  if(L.hair==="braids"){ hairFront=`<path d="M34 40q-1-24 16-24q17 0 16 24q-5-10-16-11q-11 1-16 11z" fill="${hc}"/><path d="M42 18v12M50 16v13M58 18v12" stroke="#fff" stroke-opacity=".15"/>`; hairBack=`<path d="M35 40v30M65 40v30" stroke="${hc}" stroke-width="5" stroke-linecap="round" stroke-dasharray="3.5 1.4"/>`; }
  if(L.hair==="long"){ hairBack=`<path d="M33 42q0-28 17-28q17 0 17 28v34q-4 4-7-2v-30h-20v30q-3 6-7 2z" fill="${hc}"/>`; hairFront=`<path d="M35 40q2-22 15-22q13 0 15 22q-6-12-15-13q-9 1-15 13z" fill="${hc}"/><path d="M40 24q5-5 12-4" stroke="#fff" stroke-opacity=".15" stroke-width="1.4" fill="none"/>`; }
  if(L.hair==="bun"){ hairFront=`<circle cx="50" cy="15" r="7.5" fill="${hc}"/><path d="M35 39q-1-21 15-21q16 0 15 21q-4-10-15-11q-11 1-15 11z" fill="${hc}"/>`; }
  // torso
  let body="";
  const shade=`<path d="M50 66 L72 70 L76 120 L50 120z" fill="${sh}" opacity=".18"/>`;
  if(L.outfit==="suit") body=`<path d="M29 72q21-10 42 0l5 48h-52z" fill="${oc}"/>${shade}<path d="M44 66l6 22 6-22z" fill="#f6f1e4"/><path d="M50 71l-2.6 3.6 2.6 16 2.6-16z" fill="${trim}"/><path d="M44 66l-7 24 9-6zM56 66l7 24-9-6z" fill="${oc}" stroke="${trim}" stroke-width=".9"/><circle cx="50" cy="98" r="1.2" fill="${trim}"/><circle cx="50" cy="106" r="1.2" fill="${trim}"/><path d="M38 84h6" stroke="${trim}" stroke-width="1.2"/>`;
  if(L.outfit==="hoodie") body=`<path d="M27 74q23-14 46 0l4 46h-54z" fill="${oc}"/>${shade}<path d="M39 68q11 12 22 0" fill="none" stroke="${sh}" stroke-opacity=".3" stroke-width="3"/><path d="M38 98h24v10h-24z" fill="${sh}" opacity=".15" rx="3"/><path d="M46 72v14M54 72v14" stroke="${trim}" stroke-width="1.4"/><circle cx="46" cy="87" r="1.2" fill="${trim}"/><circle cx="54" cy="87" r="1.2" fill="${trim}"/>`;
  if(L.outfit==="dress") body=`<path d="M38 68q12-6 24 0l2 18q15 18 15 36h-58q0-18 15-36z" fill="${oc}"/><path d="M50 70 L64 86 Q79 104 79 122 H50z" fill="${sh}" opacity=".16"/><path d="M36 86h28" stroke="${trim}" stroke-width="2"/><path d="M44 66q6 6 12 0" stroke="${trim}" stroke-width="1" fill="none"/>`;
  if(L.outfit==="track") body=`<path d="M29 72q21-10 42 0l5 48h-52z" fill="${oc}"/>${shade}<path d="M32 76l-4 44M68 76l4 44" stroke="#f6f1e4" stroke-width="2.4"/><path d="M50 68v52" stroke="${sh}" stroke-opacity=".35" stroke-width="1.4"/><path d="M42 67q8 5 16 0" stroke="#f6f1e4" stroke-width="2" fill="none"/>`;
  // legs by pose
  const pant = L.outfit==="dress" ? s : (L.outfit==="suit"? oc : "#1b1b1f");
  let legs;
  if(pose==="sit") legs = L.outfit==="dress"
    ? `<rect x="38" y="118" width="8" height="12" rx="3" fill="${s}"/><rect x="54" y="118" width="8" height="12" rx="3" fill="${s}"/><rect x="34" y="128" width="14" height="5" rx="2.4" fill="#0b0a08"/><rect x="52" y="128" width="14" height="5" rx="2.4" fill="#0b0a08"/>`
    : `<rect x="34" y="114" width="14" height="10" rx="4" fill="${pant}"/><rect x="52" y="114" width="14" height="10" rx="4" fill="${pant}"/><rect x="36" y="122" width="10" height="10" fill="${pant}"/><rect x="54" y="122" width="10" height="10" fill="${pant}"/><rect x="33" y="130" width="15" height="5" rx="2.4" fill="#0b0a08"/><rect x="52" y="130" width="15" height="5" rx="2.4" fill="#0b0a08"/>`;
  else legs = (L.outfit==="dress"
    ? `<rect x="40" y="120" width="6.5" height="22" rx="2" fill="${s}"/><rect x="53.5" y="120" width="6.5" height="22" rx="2" fill="${s}"/>`
    : `<rect x="37.5" y="118" width="11" height="26" rx="2" fill="${pant}"/><rect x="51.5" y="118" width="11" height="26" rx="2" fill="${pant}"/><path d="M51.5 118h11v26h-11z" fill="${sh}" opacity=".15"/>`)
    + `<path d="M35 142h14v3a2 2 0 0 1-2 2h-12a2 2 0 0 1-2-2v-1q0-2 2-2z" fill="#0b0a08"/><path d="M51 142h14q2 0 2 2v1a2 2 0 0 1-2 2h-12a2 2 0 0 1-2-2z" fill="#0b0a08"/><path d="M37 143h8M53 143h8" stroke="#fff" stroke-opacity=".2"/>`;
  // arms
  const sleeve = L.outfit==="dress" ? s : oc;
  const armL = pose==="dance"
    ? `<g transform="rotate(130 30 74)"><rect x="25" y="72" width="9" height="32" rx="4.5" fill="${sleeve}"/><circle cx="29.5" cy="106" r="4.6" fill="${s}"/></g>`
    : `<g transform="rotate(${pose==="sit"?14:9} 30 74)"><rect x="25" y="72" width="9" height="34" rx="4.5" fill="${sleeve}"/><circle cx="29.5" cy="108" r="4.6" fill="${s}"/></g>`;
  const armR = (pose==="wave"||pose==="dance")
    ? `<g transform="rotate(-150 70 74)"><rect x="66" y="72" width="9" height="32" rx="4.5" fill="${sleeve}"/><rect x="66" y="72" width="9" height="32" rx="4.5" fill="${sh}" opacity=".15"/><circle cx="70.5" cy="106" r="4.6" fill="${s}"/></g>`
    : `<g transform="rotate(-${pose==="sit"?14:9} 70 74)"><rect x="66" y="72" width="9" height="34" rx="4.5" fill="${sleeve}"/><rect x="66" y="72" width="9" height="34" rx="4.5" fill="${sh}" opacity=".15"/><circle cx="70.5" cy="108" r="4.6" fill="${s}"/></g>`;
  // head
  const head = `<rect x="45" y="55" width="10" height="13" rx="3" fill="${s}"/><path d="M45 62h10v4h-10z" fill="${sh}" opacity=".18"/>
    <ellipse cx="35.6" cy="43" rx="2.6" ry="3.6" fill="${s}"/><ellipse cx="64.4" cy="43" rx="2.6" ry="3.6" fill="${s}"/>
    <ellipse cx="50" cy="41" rx="14.5" ry="16.5" fill="${s}"/><path d="M50 25 a14.5 16.5 0 0 1 0 33 a10 16.5 0 0 0 0 -33z" fill="${sh}" opacity=".1"/>
    <path d="M44 51q6 4 12 0" stroke="#5a2b1a" stroke-width="1.5" fill="none" stroke-linecap="round"/><path d="M50 41v5l-1.6 1" stroke="${sh}" stroke-opacity=".25" fill="none" stroke-linecap="round"/>`;
  const eyes = L.extra==="shades" ? "" : `<path d="M40 35.5q3-1.6 6 0M54 35.5q3-1.6 6 0" stroke="${hc==="#e8e2d5"?"#555":hc}" stroke-width="1.3" fill="none" stroke-linecap="round"/><ellipse cx="43.5" cy="40" rx="2" ry="2.3" fill="#fff"/><ellipse cx="56.5" cy="40" rx="2" ry="2.3" fill="#fff"/><circle cx="43.8" cy="40.3" r="1.3" fill="#1a0f08"/><circle cx="56.8" cy="40.3" r="1.3" fill="#1a0f08"/>`;
  let extra="";
  if(L.extra==="shades") extra=`<path d="M37.5 37h11l-1 6q-4.5 2-9 0z" fill="#0b0b0b"/><path d="M51.5 37h11l-1 6q-4.5 2-9 0z" fill="#0b0b0b"/><path d="M48.5 38.5h3" stroke="#0b0b0b" stroke-width="1.2"/><path d="M39 38.5l3 3" stroke="#fff" stroke-opacity=".35"/><path d="M53 38.5l3 3" stroke="#fff" stroke-opacity=".35"/>`;
  if(L.extra==="goldchain") extra=`<path d="M41 66q9 14 18 0" fill="none" stroke="${trim}" stroke-width="2.2" stroke-dasharray="2 .8"/><path d="M50 77l3.5 4-3.5 4-3.5-4z" fill="${trim}" stroke="#8c6d26" stroke-width=".6"/>`;
  if(L.extra==="crown") extra=`<path d="M37 24l4 7 9-11 9 11 4-7v11h-26z" fill="${trim}" stroke="#8c6d26" stroke-width=".8"/><circle cx="50" cy="28" r="1.6" fill="#b0263a"/><circle cx="42" cy="31" r="1.1" fill="#1f3d7a"/><circle cx="58" cy="31" r="1.1" fill="#1f3d7a"/>`;
  if(L.extra==="cap"){ const c=oc==="#111111"?"#d4a843":"#111"; extra=`<path d="M34 36q0-19 16-19q16 0 16 19z" fill="${c}"/><path d="M60 33q10 0 14 3q-6 1-14 0z" fill="${c}"/><path d="M50 17v19" stroke="#000" stroke-opacity=".2"/>`; }
  const pc=L.printColor||trim; let print="";
  const py=L.outfit==="dress"?84:96;
  if(L.print==="emblem") print=`<path d="M50 ${py-7}l7 11h-14z" fill="none" stroke="${pc}" stroke-width="1.3"/><circle cx="50" cy="${py}" r="1.6" fill="${pc}"/><path d="M44 ${py+6}q6-2 12 0" stroke="${pc}" stroke-width="1" fill="none"/>`;
  if(L.print==="compass") print=`<path d="M50 ${py-7}l-6 12M50 ${py-7}l6 12" stroke="${pc}" stroke-width="1.3" stroke-linecap="round"/><path d="M43 ${py+1}l7 6 7-6" fill="none" stroke="${pc}" stroke-width="1.3"/><circle cx="50" cy="${py-7}" r="1.2" fill="${pc}"/>`;
  if(L.print==="text"){ const t=String(L.printText||"MW").slice(0,10); const fs=Math.max(4.5,Math.min(9,40/Math.max(1,t.length))); print=`<text x="50" y="${py+fs/3}" text-anchor="middle" font-family="Cinzel,Georgia,serif" font-weight="700" font-size="${fs}" fill="${pc}">${esc(t)}</text>`; }
  let faceLayer="";
  if(face){ const id="fc"+(++_clipN); faceLayer=`<clipPath id="${id}"><ellipse cx="50" cy="41" rx="14.5" ry="16.5"/></clipPath><image href="${face}" x="35" y="24" width="30" height="34" preserveAspectRatio="xMidYMid slice" clip-path="url(#${id})"/><ellipse cx="50" cy="41" rx="14.5" ry="16.5" fill="none" stroke="${trim}" stroke-width=".8"/>`; }
  const top = face ? faceLayer+(["crown","cap"].includes(L.extra)?extra:"") : eyes+hairFront+extra;
  const chain = face && L.extra==="goldchain" ? extra : "";
  return `<svg viewBox="0 0 100 150" xmlns="http://www.w3.org/2000/svg">${face?"":hairBack}${legs}${armL}${body}${print}${armR}${head}${top}${chain}</svg>`;
}

/* ---------------- the view ---------------- */
let cleanup = [];
export function render(root, ctx) {
  root.innerHTML = MARKUP;
  const fdb = firestore(ctx);
  const me = fdb.base.me();
  let myDoc = null;
  const membersMap = {};
  const $ = (s) => root.querySelector(s);
  const $$ = (s) => [...root.querySelectorAll(s)];
  const needMember = () => { if (!me) { toast("Join free first — sign in, then pick a handle."); return false; } if (!myDoc) { toast("Join free first. Pick a handle in Meechie's Book."); location.hash = "#community"; return false; } return true; };
  const look = lookState.current;
  /* the live lobby shape over the platform room: join(name) gives
     presence(patch) (merged into the full tracked state) + onPeers */
  const lobbyShim = {
    join(name) {
      const room = fdb.base.room(name);
      let state = {};
      return {
        presence(patch) { state = { ...state, ...patch }; try { room.track({ uid: me, ...state }); } catch (_) {} return Promise.resolve(); },
        onPeers(cb) { room.onPresence(() => { cb({ peers: room.peers(me).map((p) => ({ peer: p.peer, sameTab: p.isMe, kind: "", by: p.by, presence: p.presence })) }); }); },
        leave() { room.leave(); },
      };
    },
  };
  fdb.base.listDocs("members", { limit: 200 }).then((rows) => { rows.forEach((m) => { membersMap[m.id] = m; }); myDoc = membersMap[me] || null; if (myDoc) { if (myDoc.look) Object.assign(lookState.current, myDoc.look); if (myDoc.face) faceState.current = myDoc.face; drawBuilder(); } drawPeople(); }).catch(() => {});
function drawBuilder(){
  $("#av-stage").innerHTML=avatarSVG(look,"stand",look.photo&&faceState.current?faceState.current:"");
  const pt=$("#av-printtext"); if(pt){ pt.hidden=look.print!=="text"; if(document.activeElement!==pt) pt.value=look.printText||""; }
  $("#av-photo-toggle")&&($("#av-photo-toggle").hidden=!myFace, $("#av-photo-toggle").textContent=look.photo?"Use cartoon face":"Use my photo face");
  $("#av-opts").innerHTML=Object.entries(OPTS).map(([k,o])=>`<div class="opt"><b>${o.label}</b><div class="swatches">${o.vals.map(v=>v.startsWith("#")?`<button type="button" data-k="${k}" data-v="${v}" aria-label="${o.label} ${v}" aria-pressed="${look[k]===v}" style="background:${v}"></button>`:`<button type="button" data-k="${k}" data-v="${v}" aria-pressed="${look[k]===v}">${v==="goldchain"?"gold chain":v}</button>`).join("")}</div></div>`).join("");
}
$("#av-opts").addEventListener("click",e=>{const b=e.target.closest("[data-k]"); if(!b) return; look[b.dataset.k]=b.dataset.v; drawBuilder(); try{localStorage.setItem("mw-look",JSON.stringify(look));}catch(e){} setMine({look:{...look}}); });
$("#av-save").addEventListener("click",()=>{ if(!needMember()) return; fdb.doc("members/"+me).update({look}).then(()=>toast("Look saved")).catch(err=>toast(err.message||err.code)); });
$("#av-printtext").addEventListener("input",e=>{ look.printText=e.target.value; drawBuilder(); try{localStorage.setItem("mw-look",JSON.stringify(look));}catch(_){} setMine({look:{...look}}); });
$("#av-photo-toggle").addEventListener("click",()=>{ look.photo=!look.photo; drawBuilder(); setMine({look:{...look}}); });
function faceCrop(file){ return new Promise((res,rej)=>{ const img=new Image(), u=URL.createObjectURL(file);
  img.onload=()=>{ const side=Math.min(img.width,img.height)*.78, sx=(img.width-side)/2, sy=Math.max(0,(img.height-side)/2-side*.08);
    const c=document.createElement("canvas"); c.width=c.height=112; c.getContext("2d").drawImage(img,sx,sy,side,side,0,0,112,112); URL.revokeObjectURL(u);
    res({face:c.toDataURL("image/jpeg",.78), blob:null, canvas:c}); };
  img.onerror=()=>rej(new Error("That file isn't a photo we can read.")); img.src=u; }); }
function localMatch(cv){
  const ctx=cv.getContext("2d"), W=cv.width;
  const avg=(x,y,w,h)=>{ const d=ctx.getImageData(x,y,w,h).data; let r=0,g=0,b=0,n=0; for(let i=0;i<d.length;i+=4){ r+=d[i]; g+=d[i+1]; b+=d[i+2]; n++; } return [r/n,g/n,b/n]; };
  const hex=h=>[1,3,5].map(i=>parseInt(h.slice(i,i+2),16));
  const near=(rgb,vals)=>vals.reduce((best,v)=>{ const c=hex(v), d=(c[0]-rgb[0])**2+(c[1]-rgb[1])**2+(c[2]-rgb[2])**2; return d<best[0]?[d,v]:best; },[1e12,vals[0]])[1];
  const s=W/112; const skin=avg(Math.round(38*s),Math.round(58*s),Math.round(36*s),Math.round(20*s)); const hair=avg(Math.round(34*s),Math.round(2*s),Math.round(44*s),Math.round(14*s));
  return {skin:near(skin,OPTS.skin.vals), hairColor:near(hair,OPTS.hairColor.vals)};
}
$("#ai-selfie").addEventListener("change",async e=>{
  const f=e.target.files[0]; e.target.value=""; if(!f) return;
  const st=$("#ai-me-status"); st.textContent="Reading your photo...";
  try{
    const {face,canvas}=await faceCrop(f); faceState.current=face; look.photo=true; drawBuilder(); setMine({look:{...look}});
    if(myDoc) fdb.doc("members/"+me).update({face: faceState.current}).catch(()=>{});
    const smp=null; const lim=smp ? await smp.limits().catch(()=>null) : null;
    if(smp && lim?.images){
      st.textContent="AI is matching your look...";
      const blob=await new Promise(r=>canvas.toBlob(r,"image/jpeg",.85));
      const r=await smp.json(`The image is a close-up selfie a person uploaded to build their own cartoon avatar. Pick the closest match from each list. Return JSON only: {"skin": one of ${JSON.stringify(OPTS.skin.vals)}, "hair": one of ${JSON.stringify(OPTS.hair.vals)}, "hairColor": one of ${JSON.stringify(OPTS.hairColor.vals)}}. If unsure, choose the nearest option.`,{images:[blob],modelTier:"quick"});
      ["skin","hair","hairColor"].forEach(k=>{ if(OPTS[k].vals.includes(r?.[k])) look[k]=r[k]; });
      drawBuilder(); setMine({look:{...look}}); try{localStorage.setItem("mw-look",JSON.stringify(look));}catch(_){}
      st.textContent="Done. Your avatar now matches you. Tap Save my look to keep it.";
    } else {
      const m=localMatch(canvas); look.skin=m.skin; look.hairColor=m.hairColor;
      drawBuilder(); setMine({look:{...look}}); try{localStorage.setItem("mw-look",JSON.stringify(look));}catch(_){}
      st.textContent="Done. Your face is on your avatar and your skin tone and hair color are matched. Pick your hairstyle below, then tap Save my look.";
    }
  }catch(err){ st.textContent = err.code==="not_granted" ? "Your face is on your avatar. AI matching needs permission, so pick your skin tone and hair below." : (err.message||"Couldn't read that photo. Try another."); }
});
$("#av-share").addEventListener("click",async()=>{ if(!needMember()) return;
  const fit={outfit:look.outfit,outfitColor:look.outfitColor,trim:look.trim,print:look.print,printColor:look.printColor,printText:look.printText,extra:look.extra};
  try{ await fdb.collection("wardrobe").add({authorId:me,fit,likes:[],createdAt:Date.now()}); toast("Outfit shared to the Wardrobe"); }catch(err){ toast(err.message||err.code); } });
drawBuilder();

/* ---------- Rooms ---------- */
const ROOMS={lounge:{name:"GOLD LOUNGE"},studio:{name:"STUDIO B"},rooftop:{name:"ROOFTOP"},club:{name:"CLUB CONSCIENTIA"}};
const G="#d4a843",GH="#f0cf78",GL="#8c6d26";
const FY=54, VPY=26;               // floor line and vanishing point (viewBox 160x90)
function persp(fill, line, opts={}){
  const k=(FY-VPY)/(90-VPY); let o=`<rect x="0" y="${FY}" width="160" height="${90-FY}" fill="${fill}"/>`;
  if(opts.check){ // perspective checkerboard
    const rows=7, cols=16; const ys=[...Array(rows+1)].map((_,j)=>FY+(90-FY)*Math.pow(j/rows,1.6));
    for(let j=0;j<rows;j++) for(let i=-6;i<cols+6;i++){ if((i+j)%2) continue;
      const bx0=i*10, bx1=bx0+10, f=y=>(y-VPY)/(90-VPY), X=(bx,y)=>80+(bx-80)*f(y);
      o+=`<path d="M${X(bx0,ys[j])} ${ys[j]}L${X(bx1,ys[j])} ${ys[j]}L${X(bx1,ys[j+1])} ${ys[j+1]}L${X(bx0,ys[j+1])} ${ys[j+1]}z" fill="${opts.check}"/>`; }
  }
  for(let i=-14;i<=30;i++){ const bx=i*(opts.step||8), tx=80+(bx-80)*k; o+=`<path d="M${tx} ${FY}L${bx} 90" stroke="${line}" stroke-width="${opts.w||.35}"/>`; }
  if(opts.cross!==false) for(let j=1;j<=8;j++){ const y=FY+(90-FY)*Math.pow(j/8,1.7); o+=`<path d="M0 ${y}H160" stroke="${line}" stroke-width="${(opts.w||.35)*.8}" opacity=".7"/>`; }
  o+=`<rect x="0" y="${FY}" width="160" height="${90-FY}" fill="url(#floorFade)"/>`;
  return o;
}
const DEFS=`<defs>
  <linearGradient id="floorFade" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#000" stop-opacity=".55"/><stop offset=".35" stop-color="#000" stop-opacity=".1"/><stop offset="1" stop-color="#000" stop-opacity=".25"/></linearGradient>
  <radialGradient id="glow"><stop offset="0" stop-color="${GH}" stop-opacity=".55"/><stop offset="1" stop-color="${GH}" stop-opacity="0"/></radialGradient>
  <radialGradient id="glowR"><stop offset="0" stop-color="#ff5a6a" stop-opacity=".5"/><stop offset="1" stop-color="#ff5a6a" stop-opacity="0"/></radialGradient>
  <linearGradient id="goldV" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${GH}"/><stop offset="1" stop-color="${GL}"/></linearGradient>
  <linearGradient id="nightSky" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#060818"/><stop offset=".55" stop-color="#2a1c48"/><stop offset="1" stop-color="#c77a42"/></linearGradient>
  <linearGradient id="beamG" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fff" stop-opacity=".55"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></linearGradient>
</defs>`;
const pillar=(x,label)=>`<rect x="${x-4}" y="8" width="8" height="${FY-10}" fill="#1a140a"/><rect x="${x-4}" y="8" width="8" height="${FY-10}" fill="url(#goldV)" opacity=".18"/>${[...Array(4)].map((_,i)=>`<path d="M${x-2.6+i*1.75} 12v${FY-18}" stroke="${GL}" stroke-width=".35"/>`).join("")}<rect x="${x-5.5}" y="6" width="11" height="3" fill="${G}"/><circle cx="${x}" cy="4" r="3.2" fill="${G}" stroke="${GL}" stroke-width=".4"/><rect x="${x-5.5}" y="${FY-3}" width="11" height="3" fill="${G}"/><text x="${x}" y="${FY-5}" text-anchor="middle" font-size="2.4" font-family="serif" font-weight="700" fill="${GH}">${label}</text>`;
const SCENES={
 lounge:`${DEFS}<rect width="160" height="${FY}" fill="#20160a"/>
  ${[...Array(9)].map((_,i)=>`<rect x="${4+i*17.6}" y="34" width="14" height="${FY-37}" fill="none" stroke="${GL}" stroke-width=".4" opacity=".7"/>`).join("")}
  <rect x="0" y="32" width="160" height=".8" fill="${G}" opacity=".7"/><rect x="0" y="${FY-1.4}" width="160" height="1.4" fill="${GL}"/>
  ${pillar(12,"B")}${pillar(148,"J")}
  ${[38,122].map(x=>`<rect x="${x-10}" y="9" width="20" height="18" fill="#0f0b05" stroke="${G}" stroke-width=".9"/><rect x="${x-8}" y="11" width="16" height="14" fill="none" stroke="${GL}" stroke-width=".4"/><path d="M${x} 13.5l5.5 9.5h-11z" fill="none" stroke="${G}" stroke-width=".6"/><circle cx="${x}" cy="19.5" r="1.2" fill="${GH}"/>`).join("")}
  <ellipse cx="80" cy="16" rx="26" ry="14" fill="url(#glow)" class="flick"/>
  <path d="M80 0v5" stroke="${GL}" stroke-width=".5"/><path d="M68 5h24l-3 4h-18z" fill="${G}"/><path d="M71 9h18l-2 3h-14z" fill="${GL}"/>${[70,74,78,82,86,90].map((x,i)=>`<path d="M${x} 9v${3+(i%2)*2}" stroke="${GH}" stroke-width=".3"/><circle cx="${x}" cy="${12.6+(i%2)*2}" r=".9" fill="${GH}" class="tw" style="animation-delay:${i*.3}s"/>`).join("")}
  ${persp("#2a1c0c","#3d2a12",{step:7})}
  <ellipse cx="80" cy="72" rx="34" ry="9" fill="#3a0f16" stroke="${G}" stroke-width=".7"/><ellipse cx="80" cy="72" rx="29" ry="7" fill="none" stroke="${GL}" stroke-width=".4"/>
  <g transform="translate(80 72) scale(1 .3)"><path d="M0 -14 L-12 8 M0 -14 L12 8" stroke="${G}" stroke-width="2.2" stroke-linecap="round"/><path d="M-13 -3 L0 12 L13 -3" fill="none" stroke="${G}" stroke-width="2.2"/></g>
  <path d="M10 64h38l3 9h-44z" fill="#4a1420"/><path d="M12 58h34q3 0 3 3v4h-40v-4q0-3 3-3z" fill="#5a1a28"/><path d="M12 58h34" stroke="${G}" stroke-width=".5"/><rect x="9" y="73" width="1.6" height="3" fill="${G}"/><rect x="48" y="73" width="1.6" height="3" fill="${G}"/>
  <path d="M112 ${FY}h40l6 18h-52z" fill="#1a1208"/><path d="M106 ${FY+18}h52v2.5h-52z" fill="${G}"/><path d="M112 ${FY}h40" stroke="${GH}" stroke-width=".6"/>
  ${[118,123,128,134,139,144].map((x,i)=>`<rect x="${x}" y="${FY-8+(i%2)}" width="2.2" height="${8-(i%2)}" rx=".7" fill="${["#2f6b45","#7a1f2b",G][i%3]}"/><circle cx="${x+1.1}" cy="${FY-9+(i%2)}" r=".9" fill="${["#2f6b45","#7a1f2b",G][i%3]}"/>`).join("")}`,
 studio:`${DEFS}<rect width="160" height="${FY}" fill="#121722"/>
  ${[...Array(10)].map((_,i)=>[...Array(3)].map((_,r)=>`<path d="M${2+i*16} ${4+r*11}h14l-1.5 9h-11z" fill="#1b2232" stroke="#2a3348" stroke-width=".4"/>`).join("")).join("")}
  <rect x="52" y="10" width="56" height="22" rx="1.5" fill="#0a0d14" stroke="#3a4560" stroke-width=".8"/><rect x="54" y="12" width="52" height="18" fill="#132036"/><rect x="54" y="12" width="52" height="18" fill="url(#glow)" opacity=".35"/><path d="M60 26h40" stroke="#2a3a58"/>${[...Array(14)].map((_,i)=>`<rect x="${61+i*2.7}" y="${22-(i%5)}" width="1.2" height="${4+(i%5)}" fill="${i%4?"#3e5b8c":G}" class="led" style="animation-delay:${i*.11}s"/>`).join("")}
  <rect x="66" y="35" width="28" height="7" rx="1.5" fill="#2a0c0c" stroke="#ff4d57" stroke-width=".7" class="pulse"/><ellipse cx="80" cy="38.5" rx="20" ry="7" fill="url(#glowR)" class="pulse"/><text x="80" y="40.4" text-anchor="middle" font-size="4.3" font-family="sans-serif" font-weight="800" letter-spacing=".5" fill="#ff7b82">ON AIR</text>
  ${persp("#161b26","#222a3a",{step:8,cross:true})}
  ${[10,138].map(x=>`<rect x="${x}" y="30" width="13" height="30" rx="1.5" fill="#0b0d12" stroke="#2c3446" stroke-width=".6"/><circle cx="${x+6.5}" cy="38" r="3.8" fill="#151a24" stroke="${GL}" stroke-width=".5"/><circle cx="${x+6.5}" cy="38" r="1.2" fill="#0b0d12"/><circle cx="${x+6.5}" cy="51" r="5" fill="#151a24" stroke="${GL}" stroke-width=".5"/><circle cx="${x+6.5}" cy="51" r="1.8" fill="#0b0d12"/>`).join("")}
  <path d="M100 66l10-6h40l4 10h-54z" fill="#1d2330" stroke="#323c52" stroke-width=".5"/><path d="M100 70h54v6h-54z" fill="#121620"/>${[...Array(16)].map((_,i)=>`<rect x="${112+i*2.3}" y="${62.5-(i%3)*.4+(i>7?1:0)}" width=".9" height="2.6" fill="${i%5?"#58627a":G}"/>`).join("")}
  <path d="M46 78V46" stroke="#5a5a5a" stroke-width=".9"/><path d="M41 78h10M46 78l-4 3M46 78l4 3" stroke="#5a5a5a" stroke-width=".8"/><rect x="43.8" y="40" width="4.4" height="8" rx="2.2" fill="#2a2a2a" stroke="${G}" stroke-width=".5"/><path d="M44.5 42h3M44.5 44h3" stroke="#555" stroke-width=".4"/>`,
 rooftop:`${DEFS}<rect width="160" height="${FY}" fill="url(#nightSky)"/>
  ${[...Array(70)].map((_,i)=>`<circle cx="${(i*37.3)%160}" cy="${(i*13.7)%30}" r="${i%7?.25:.5}" fill="#fff" class="${i%3?"":"tw"}" style="animation-delay:${(i%9)*.3}s" opacity="${.35+(i%4)/6}"/>`).join("")}
  <circle cx="130" cy="13" r="14" fill="url(#glow)"/><circle cx="130" cy="13" r="5.5" fill="#f7ebcb"/><circle cx="128" cy="12" r="1.1" fill="#e2d2a8"/><circle cx="132" cy="15" r=".8" fill="#e2d2a8"/>
  <path d="M0 ${FY}V40h7v-7h9v13h5V30h4v-5h3v29h8V36h11v18h5V24h10v30h7V40h6v-9h9v23h5V33h8v21h7V28h5v-6h4v32h9V42h8v12z" fill="#0a0812"/>
  <path d="M30 ${FY}V18h8v36zM98 ${FY}V14h4l1-6 1 6h4v40z" fill="#07060d"/>
  ${[...Array(90)].map((_,i)=>{const x=(i*23.1)%156+2,y=22+(i*7.3)%30;return `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="1" height="1.2" fill="${GH}" opacity="${(i%3)?.6:.12}"/>`}).join("")}
  <circle cx="102" cy="8" r=".8" fill="#ff4d57" class="pulse"/>
  ${persp("#2a2016","#3c2e1f",{step:6,cross:false})}
  <path d="M0 ${FY-6}Q40 ${FY+2} 80 ${FY-6}T160 ${FY-6}" fill="none" stroke="#555" stroke-width=".3"/>${[...Array(17)].map((_,i)=>`<circle cx="${i*10}" cy="${(FY-6)+Math.sin(i/2.55*Math.PI/1.25)*0+((i%8)<4?(i%8):(8-(i%8)))*1.6}" r="1" fill="${GH}" class="tw" style="animation-delay:${i*.2}s"/>`).join("")}
  <path d="M0 ${FY}h160" stroke="${G}" stroke-width=".8"/>${[...Array(33)].map((_,i)=>`<path d="M${i*5} ${FY}v-6" stroke="${GL}" stroke-width=".45"/>`).join("")}<path d="M0 ${FY-6}h160" stroke="${G}" stroke-width=".7"/>
  <path d="M10 70h30l2 4h-34z" fill="#4a3420"/><path d="M8 74h34v1.6h-34z" fill="${G}"/><path d="M12 70v-6h26v6" fill="#3a2818" stroke="${GL}" stroke-width=".4"/><rect x="10" y="75" width="1.4" height="5" fill="${GL}"/><rect x="39" y="75" width="1.4" height="5" fill="${GL}"/>
  <path d="M120 70h30l2 4h-34z" fill="#4a3420"/><path d="M118 74h34v1.6h-34z" fill="${G}"/><path d="M122 70v-6h26v6" fill="#3a2818" stroke="${GL}" stroke-width=".4"/><rect x="120" y="75" width="1.4" height="5" fill="${GL}"/><rect x="149" y="75" width="1.4" height="5" fill="${GL}"/>
  <ellipse cx="80" cy="80" rx="9" ry="2.6" fill="#1a1208" stroke="${G}" stroke-width=".6"/><ellipse cx="80" cy="77.5" rx="5" ry="4" fill="url(#glow)" class="flick"/><path d="M77 79q3-7 3-9q1 4 3 9z" fill="#f0a040" class="flick"/>
  <rect x="64" y="64" width="6" height="7" fill="#3a2a1a"/><circle cx="67" cy="61" r="5" fill="#2f5a36"/><rect x="92" y="64" width="6" height="7" fill="#3a2a1a"/><circle cx="95" cy="61" r="5" fill="#2f5a36"/>`,
 club:`${DEFS}<rect width="160" height="${FY}" fill="#0c0910"/>
  ${pillar(10,"B")}${pillar(150,"J")}
  ${[[34,"#ff3d7f"],[80,"#f0cf78"],[126,"#7b5cff"]].map(([x,c],i)=>`<path d="M${x-1.5} 0 L${x-16} 70 L${x+16} 70 L${x+1.5} 0z" fill="${c}" opacity=".16" class="beam" style="animation-delay:${-i*2}s"/>`).join("")}
  <path d="M80 0v7" stroke="#777" stroke-width=".4"/><circle cx="80" cy="12" r="5.5" fill="#bdbdbd"/><g class="spin">${[...Array(16)].map((_,i)=>`<rect x="${75.6+(i%4)*2.3}" y="${7.4+Math.floor(i/4)*2.3}" width="1.9" height="1.9" fill="${i%3?"#fff":"#9a9a9a"}" opacity=".9"/>`).join("")}</g><circle cx="80" cy="12" r="12" fill="url(#glow)" class="flick"/>
  ${[...Array(30)].map((_,i)=>`<circle cx="${(i*41.7)%160}" cy="${(i*17.3)%48}" r=".6" fill="${[GH,"#ff6b9a","#8ad","#fff"][i%4]}" class="tw" style="animation-delay:${(i%7)*.25}s"/>`).join("")}
  <rect x="54" y="${FY-18}" width="52" height="18" rx="1.5" fill="#100d08" stroke="${G}" stroke-width=".8"/>
  <rect x="56" y="${FY-15}" width="48" height="10" fill="#0a0806"/><text x="80" y="${FY-8}" text-anchor="middle" font-size="4.4" font-family="serif" font-weight="700" letter-spacing=".8" fill="${GH}">CONSCIENTIA</text>
  <circle cx="64" cy="${FY-21}" r="3.6" fill="#1a1a1a" stroke="#555" stroke-width=".4"/><circle cx="64" cy="${FY-21}" r="1" fill="${G}"/><circle cx="96" cy="${FY-21}" r="3.6" fill="#1a1a1a" stroke="#555" stroke-width=".4"/><circle cx="96" cy="${FY-21}" r="1" fill="${G}"/><rect x="72" y="${FY-23}" width="16" height="4" rx=".8" fill="#222"/>
  ${persp("#0d0b0a","#2a2210",{check:"#1e1810",step:10,cross:false,w:.3})}
  ${[...Array(10)].map((_,i)=>{const x=40+i*8;return `<ellipse cx="${x}" cy="${70+(i%3)*5}" rx="3.6" ry="1.1" fill="${["#ff3d7f","#f0cf78","#7b5cff","#3de0ff"][i%4]}" opacity=".5" class="led" style="animation-delay:${i*.17}s"/>`}).join("")}
  ${[18,134].map(x=>`<rect x="${x}" y="${FY-14}" width="10" height="24" fill="#0a0a0a" stroke="#333" stroke-width=".4"/><circle cx="${x+5}" cy="${FY-8}" r="3" fill="#161616" stroke="${GL}" stroke-width=".4"/><circle cx="${x+5}" cy="${FY+3}" r="3.6" fill="#161616" stroke="${GL}" stroke-width=".4"/>`).join("")}`
};
let w3d=false;
function mount3D(){
  if(w3d || !World3D || !World3D.supported()) return; w3d="loading";
  const sc=$("#scene");
  World3D.mount(sc,{
    onWalk:(x,y)=>setMine({x:clampX(x),y:clampY(y),pose:mine.pose==="sit"?"stand":mine.pose}),
    onPose:p=>{ setMine({pose:p,poseAt:Date.now()}); if(p==="wave") setTimeout(drawPeople,4100); },
    onSay:t=>{ t=String(t||"").trim().slice(0,120); if(!t) return; setMine({say:t,sayAt:Date.now()}); setTimeout(drawPeople,8100); }
  }).then(()=>{ w3d=true; sc.classList.add("is3d"); $("#emotes").hidden=true; $("#say-form").hidden=true; World3D.setRoom(roomName); drawPeople(); })
    .catch(err=>{ console.warn("3D world unavailable, using 2D",err); w3d="off"; });
}
mount3D();
let wroom=null, roomName="lounge", peersNow=[], heard={}, logLines=[];
let mine={look:{...look},x:.5,y:.82,pose:"stand",uid:null,say:"",sayAt:0};
function setMine(patch){ Object.assign(mine,patch); if(wroom) wroom.presence(patch).catch(()=>{}); drawPeople(); }
function paintRoom(){ $("#room-label").textContent=ROOMS[roomName].name; if(w3d===true) World3D.setRoom(roomName);
  $("#props").innerHTML=`<svg viewBox="0 0 160 90" preserveAspectRatio="xMidYMid slice" style="width:100%;height:100%;display:block">${SCENES[roomName]}</svg>`; }
const clampX=x=>Math.min(.95,Math.max(.05,+x||.5)), clampY=y=>Math.min(.97,Math.max(.64,+y||.85));
const toons=new Map();
function nameFor(p){ const P=p.presence||{}; return p.isMe?"You":(membersMap[p.by||P.uid]?.handle||"Guest"); }
function drawPeople(){
  const scene=$("#scene");
  const people = wroom && peersNow.length ? peersNow.filter(p=>p.kind!=="agent" && p.presence?.look) : [{peer:"local",isMe:true,presence:mine}];
  const seen=new Set();
  people.forEach(p=>{
    const P=p.isMe&&!wroom?mine:(p.sameTab?{...p.presence,...mine}:p.presence), key=p.peer; seen.add(key);
    let t=toons.get(key);
    if(!t){ t=document.createElement("div"); t.className="toon"+(p.isMe?" me":""); t.innerHTML=`<div class="shadow"></div><div class="bod"></div><span class="tag"></span>`; scene.appendChild(t); toons.set(key,t); t._x=clampX(P.x); }
    const x=clampX(P.x), y=clampY(P.y), s=.55+(y-.6)/.37*.6;
    if(Math.abs(x-(t._lx??x))>.003 || Math.abs(y-(t._ly??y))>.003){ t.classList.toggle("left", x<(t._lx??x)); t.classList.add("walking"); clearTimeout(t._wt); t._wt=setTimeout(()=>t.classList.remove("walking"),1200); }
    t._lx=x; t._ly=y;
    t.style.left=(x*100)+"%"; t.style.top=(y*100)+"%"; t.style.setProperty("--s",s.toFixed(3)); t.style.zIndex=Math.round(y*1000);
    const pose=(P.pose==="wave" && Date.now()-(P.poseAt||0)>4000)?"stand":(P.pose||"stand");
    t.classList.toggle("dance",pose==="dance");
    const uid=p.by||P.uid, L2={...look,...(P.look||{})}; const face = L2.photo ? (p.isMe? faceState.current : (membersMap[uid]?.face||"")) : "";
    const sig=JSON.stringify([P.look,pose,face.length]); if(t._sig!==sig){ t._sig=sig; t.querySelector(".bod").innerHTML=avatarSVG(L2,pose==="dance"?"dance":pose,face); }
    t.querySelector(".tag").textContent=nameFor(p);
    const said=P.say && Date.now()-(P.sayAt||0)<8000; let b=t.querySelector(".bubble");
    if(said){ if(!b||b._at!==P.sayAt){ b?.remove(); b=document.createElement("div"); b.className="bubble"; b._at=P.sayAt; b.textContent=P.say; t.prepend(b);} } else b?.remove();
    if(P.say && P.sayAt && heard[key]!==P.sayAt){ heard[key]=P.sayAt; logLines.push({n:nameFor(p),t:String(P.say).slice(0,160)}); logLines=logLines.slice(-30); renderLog(); }
  });
  for(const [k,t] of toons) if(!seen.has(k)){ t.remove(); toons.delete(k); }
  $("#room-count").textContent=people.length+" here";
  if(w3d===true) World3D.update(people.map(p=>{ const P=p.isMe&&!wroom?mine:(p.sameTab?{...p.presence,...mine}:p.presence)||{}; const uid=p.by||P.uid, L2=cleanLook({...look,...(P.look||{})});
    return {key:p.peer,isMe:!!p.isMe,name:nameFor(p),look:L2,x:clampX(P.x),y:clampY(P.y),pose:P.pose||"stand",poseAt:P.poseAt||0,say:P.say?String(P.say).slice(0,120):"",sayAt:P.sayAt||0,faceUrl:L2.photo?cleanFace(p.isMe?faceState.current:(membersMap[uid]?.face||"")):""}; }));
}
function renderLog(){ const el=$("#roomlog"); if(!logLines.length) return; el.innerHTML=logLines.map(l=>`<div><b>${esc(l.n)}</b>${esc(l.t)}</div>`).join(""); el.scrollTop=el.scrollHeight; }
async function enterWorld(){
  mine.uid=me; const lobby=lobbyShim;
  if(!lobby){ $("#world-status").textContent="You're exploring solo. Sign in to meet other people in the rooms."; drawPeople(); return; }
  switchRoom(lobby, roomName);
  $("#rooms").addEventListener("click",e=>{const b=e.target.closest("[data-room]"); if(!b) return; $$("#rooms .chip").forEach(x=>x.setAttribute("aria-pressed",x===b)); switchRoom(lobby,b.dataset.room);});
}
function switchRoom(lobby,name){
  wroom?.leave?.(); peersNow=[]; for(const t of toons.values()) t.remove(); toons.clear(); roomName=name; paintRoom();
  logLines=[]; $("#roomlog").innerHTML=`<span class="sys">You entered ${esc(ROOMS[name].name.toLowerCase().replace(/\b\w/g,c=>c.toUpperCase()))}. Tap the floor to walk.</span>`;
  wroom=lobby.join("world-"+name);
  wroom.presence({look:mine.look,x:mine.x,y:mine.y,pose:mine.pose,uid:me}).catch(()=>{});
  wroom.onPeers(ch=>{ peersNow=[...ch.peers]; const n=peersNow.filter(p=>p.kind!=="agent").length; $("#world-status").textContent=n+(n===1?" person":" people")+" in this room right now.";
    drawPeople(); });
}
// standalone room switching before sign-in
$("#rooms").addEventListener("click",e=>{ if(wroom) return; const b=e.target.closest("[data-room]"); if(!b) return; $$("#rooms .chip").forEach(x=>x.setAttribute("aria-pressed",x===b)); roomName=b.dataset.room; paintRoom(); drawPeople(); });
$("#scene").addEventListener("click",e=>{ if(w3d && w3d!=="off") return; const r=e.currentTarget.getBoundingClientRect(); const x=(e.clientX-r.left)/r.width, y=(e.clientY-r.top)/r.height;
  const rp=document.createElement("div"); rp.className="ripple"; rp.style.left=(x*100)+"%"; rp.style.top=(clampY(y)*100)+"%"; e.currentTarget.appendChild(rp); setTimeout(()=>rp.remove(),750);
  setMine({x:clampX(x),y:clampY(y),pose:mine.pose==="sit"?"stand":mine.pose}); });
$("#emotes").addEventListener("click",e=>{ const b=e.target.closest("[data-pose]"); if(!b) return; setMine({pose:b.dataset.pose,poseAt:Date.now()}); if(b.dataset.pose==="wave") setTimeout(drawPeople,4100); });
$("#say-form").addEventListener("submit",e=>{ e.preventDefault(); const t=$("#say-text").value.trim(); if(!t) return; $("#say-text").value=""; setMine({say:t,sayAt:Date.now()}); setTimeout(drawPeople,8100); });
const drawIv=setInterval(drawPeople,2000); cleanup.push(()=>clearInterval(drawIv));
paintRoom(); drawPeople();


  enterWorld();
  cleanup.push(() => { try { World3D.destroy(); } catch (_) {} try { fdb.base.stop(); } catch (_) {} });
}
export function destroy() { cleanup.forEach((f) => { try { f(); } catch (_) {} }); cleanup = []; }
