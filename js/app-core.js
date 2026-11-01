
const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const safeUrl = u => /^https?:\/\/[^\s"'<>]+$/i.test(String(u||"").trim()) ? String(u).trim() : "#";
const safeImg = u => /^https:\/\/[^\s"'()<>\\]+$/i.test(String(u||"")) ? String(u) : "";
const initial = s => (String(s||"?").trim()[0]||"?").toUpperCase();
function toast(t){const el=$("#toast");el.textContent=t;el.hidden=false;clearTimeout(toast.t);toast.t=setTimeout(()=>el.hidden=true,2600)}
function ago(ms){if(!ms)return"just now";const s=(Date.now()-ms)/1000;if(s<60)return"just now";if(s<3600)return Math.floor(s/60)+"m ago";if(s<86400)return Math.floor(s/3600)+"h ago";return new Date(ms).toLocaleDateString()}

/* ---------- Tabs ---------- */
const VIEWS=["live","predict","jobs","connect","fans","home","services","shop","community","radio","tv","mwtv","watch","dj","clips","studio","books","friends","dating","videos","preach","markets","coin","legal","world","games","creators","exclusives","chat","messages","ads","promote","contact"];
const ALIAS={liveradio:["radio","world-radio"],livetv:["videos","live-tv"]};
/* ---------- Lazy feature scripts ----------
   Standalone feature files load once, the first time their view opens (any entry
   path: tab tap, deep-link hash, in-page button), in their original tag order.
   Everything with homepage or cross-page duties stays eager. */
const LAZY_SRC={
  live:["js/golive.js?v=1793185302","js/obs.js?v=1793335031"],
  predict:["js/predict.js?v=1793185302"],
  jobs:["js/jobs.js?v=1793185302"],
  connect:["js/connect.js?v=1793185302"],
  fans:["js/fans.js?v=1793185302"],
  home:["js/home.js?v=1793549576"],
  tv:["js/movies.js?v=1793275800"],
  clips:["js/clips.js?v=1793185302"],
  studio:["js/autotune.js?v=1793185302","js/beatmaker.js?v=1793185302","js/beatlab.js?v=1793185302"],
  books:["js/books.js?v=1793274500"],
  dating:["js/dating.js?v=1793185302"],
  preach:["js/preach.js?v=1793185302"],
  markets:["js/markets.js?v=1793185302"],
  coin:["js/coin.js?v=1793185302"],
  legal:["js/legal.js?v=1793185302"],
  world:["js/world3d.js?v=1793185302"],
  games:["js/games.js?v=1793194200"],
  creators:["js/studio.js?v=1793185302"],
};
const lazyAt={}, lazyBusy={};
function lazyKick(v){
  const list=LAZY_SRC[v]; if(!list) return;
  if(lazyBusy[v]||(lazyAt[v]||0)>=list.length) return;
  lazyBusy[v]=true;
  const step=()=>{
    const i=lazyAt[v]||0;
    if(i>=list.length){ lazyBusy[v]=false; if(v==="world"){ try{ mount3D(); }catch(_){} } return; }
    const s=document.createElement("script"); s.src=list[i];
    s.onload=()=>{ lazyAt[v]=i+1; step(); };
    s.onerror=()=>{ lazyBusy[v]=false; }; /* a later visit retries from this file */
    document.head.appendChild(s);
  };
  step();
}
/* ---------- Idle prefetch of lazy view modules (device-max B5, round-2) ----------
   The lazy modules are skeleton-cached only AFTER their first fetch, so the
   first tap into a view still waits on the network. During idle time on a
   connection that can afford it, fetch (never execute) each module once so
   the worker lands it in the skeleton generation; the tap then opens
   instantly. Freshness is unchanged: the fetch goes through the worker
   under the same per-file stamps lazyKick uses. */
let mwPrefetchDone = false;
function mwPrefetchLazy(){
  if(mwPrefetchDone) return; mwPrefetchDone = true;
  try{ const c = navigator.connection; if(c && (c.saveData || /2g/.test(c.effectiveType || ""))) return; }catch(_){}
  const order = ["tv","clips","games","live","books","fans","studio","world","legal","dating","jobs","connect","predict","markets","preach","creators"];
  const urls = [];
  order.forEach(v => { (LAZY_SRC[v] || []).forEach(u => { if(!urls.includes(u)) urls.push(u); }); });
  Object.keys(LAZY_SRC).forEach(v => { (LAZY_SRC[v] || []).forEach(u => { if(!urls.includes(u)) urls.push(u); }); });
  let i = 0;
  const step = () => {
    if(i >= urls.length) return;
    const u = urls[i++];
    try{ fetch(u).catch(() => {}); }catch(_){}
    if("requestIdleCallback" in window) requestIdleCallback(step, { timeout: 1500 }); else setTimeout(step, 300);
  };
  step();
}
window.addEventListener("load", () => { if("requestIdleCallback" in window) requestIdleCallback(mwPrefetchLazy, { timeout: 4000 }); else setTimeout(mwPrefetchLazy, 2500); });

function go(v){ if(/access_token|error_description|refresh_token/.test(location.hash)) return;
  if(ALIAS[v]){ const [view,el]=ALIAS[v]; go(view); history.replaceState(null,"","#"+v); $$("nav.tabs a").forEach(a=>{ if(a.dataset.go===v) a.setAttribute("aria-current","page"); else a.removeAttribute("aria-current"); });
    let n=0; const t=setInterval(()=>{ const e=document.getElementById(el); if(e||++n>30){ clearInterval(t); e&&e.scrollIntoView({behavior:"smooth",block:"start"}); } },100); return; }
  if(!VIEWS.includes(v)) v="home";
  lazyKick(v);
  const prevView=VIEWS.find(x=>!$("#v-"+x).hidden);
  if(prevView && prevView!==v){ // stop videos that would keep playing on a hidden page
    $$("#v-"+prevView+" .htt.playing").forEach(x=>{ x.classList.remove("playing"); x.querySelector("iframe")?.remove(); });
    $$("#v-"+prevView+" .htt-grid").forEach(g=>g._auto=false);
    if(prevView==="videos"){ const f=$("#yt-frame"); if(f && f.querySelector("iframe")){ f.innerHTML='<div class="yt-empty"><span>Tap a video or channel to play.</span></div>'; $$("#v-videos .tv-ch.on").forEach(b=>b.classList.remove("on")); } }
    $$("#v-"+prevView+" video").forEach(x=>{ try{ x.pause(); }catch(_){} });
    if(prevView==="preach") window.MW_PREACH?.stop();
    window.MW_videoSound?.end(); // the video on the page you left stopped: bring the radio back
  }
  VIEWS.forEach(x=>$("#v-"+x).hidden = x!==v);
  document.body.dataset.view=v; document.body.classList.add("themed");
  $$("nav.tabs a").forEach(a=>{ if(a.dataset.go===v) a.setAttribute("aria-current","page"); else a.removeAttribute("aria-current"); });
  if(location.hash.slice(1)!==v) history.replaceState(null,"","#"+v);
  window.scrollTo({top:0});
}
document.addEventListener("click",e=>{const a=e.target.closest("[data-go]"); if(a){e.preventDefault();go(a.dataset.go);}});
go(location.hash.slice(1));

/* ---------- Copy ---------- */
$$("[data-copy]").forEach(b=>b.addEventListener("click",()=>{
  const v=b.dataset.copy;
  navigator.clipboard?.writeText(v).then(()=>toast("Copied "+v)).catch(()=>{const r=document.createRange();r.selectNodeContents(b.previousElementSibling.querySelector("span"));getSelection().removeAllRanges();getSelection().addRange(r);toast("Selected. Press copy.")});
}));

/* ---------- Image compression (keeps photos small enough to store) ---------- */
function compress(file,max=1080){
  return new Promise((res,rej)=>{
    const img=new Image(); const url=URL.createObjectURL(file);
    img.onload=()=>{ let q=.8, w=img.width, h=img.height; const s=Math.min(1,max/Math.max(w,h)); w=Math.round(w*s); h=Math.round(h*s);
      const c=document.createElement("canvas"); c.width=w; c.height=h; c.getContext("2d").drawImage(img,0,0,w,h); URL.revokeObjectURL(url);
      let d=c.toDataURL("image/jpeg",q); while(d.length>200000 && q>.35){q-=.1; d=c.toDataURL("image/jpeg",q);}
      if(d.length>200000){ c.width=Math.round(w*.6); c.height=Math.round(h*.6); c.getContext("2d").drawImage(img,0,0,c.width,c.height); d=c.toDataURL("image/jpeg",.6);}
      res(d);};
    img.onerror=()=>rej(new Error("That file isn't an image we can read."));
    img.src=url;
  });
}
function readFile(f){return new Promise((res,rej)=>{const r=new FileReader();r.onload=()=>res(r.result);r.onerror=rej;r.readAsDataURL(f);});}

/* ---------- Live platform ---------- */
let db=null, user=null, me=null, isOwner=false, members={}, profileMe=null;
const handleOf = id => members[id]?.handle || "Member";
const avatarOf = id => { const m=members[id]||{}, ph=safeImg(m.photo), pp=/^\d{1,3}% \d{1,3}%$/.test(m.photoPos||"")?m.photoPos:""; return `<span class="avatar" data-uid="${esc(id)}">${esc(initial(m.handle))}${ph ? `<img class="avimg" src="${esc(ph)}" alt="" loading="lazy"${pp ? ` style="object-position:${pp}"` : ""}>` : ""}</span>`; };
document.addEventListener("error", (e) => { const t = e.target; if (t && t.classList && t.classList.contains("avimg")) t.remove(); }, true); // a dead photo link falls back to the member's initial instead of an empty circle

async function boot(){
  window.__MW_BOOTED=true; try{ sessionStorage.removeItem("mw-heal-tries"); }catch(_){ }
  [db,user] = await Promise.all([claude.use("db"), claude.use("user")]);
  isOwner = user?.isOwner?.() ?? false;
  if(!db || !user){ $("#signed-out").hidden=false; return; }
  me = await user.id();
  if(!me) $("#signed-out").hidden=false;
  paintAuthBar();
  { const meta=window.MW?.session?.()?.user?.user_metadata||{}; const nm=(meta.full_name||meta.name||"").trim(); if(nm && !$("#j-handle").value) $("#j-handle").value=nm.slice(0,30); }
  let myDoc=null; window._membersRedraw=()=>{ if(window._lastMembersSnap && (!!myDoc)!==(!!profileMe)) window._membersSnap(window._lastMembersSnap); };
  if(me) db.doc("members/"+me).onSnapshot(d=>{ myDoc=d.exists?d.data():null; if(myDoc){ members[me]=myDoc; } window._membersRedraw&&window._membersRedraw(); }, ()=>{});
  db.collection("members").orderBy("joinedAt","desc").limit(500).onSnapshot(window._membersSnap=snap=>{
    window._lastMembersSnap=snap; members={}; snap.docs.forEach(d=>members[d.id]=d.data()); if(myDoc) members[me]=myDoc;
    profileMe = members[me] || null;
    if(me && !profileMe && !window._autoJoined){ let nm=""; try{ nm=localStorage.getItem("mw_join_name")||""; }catch(_){} if(nm){ window._autoJoined=true; db.collection("members").doc(me).set({handle:nm, bio:"", joinedAt:Date.now()}).then(()=>{ try{ localStorage.removeItem("mw_join_name"); }catch(_){} toast("Welcome to Meechie's World, "+nm); }).catch(()=>{ window._autoJoined=false; }); } }
    $("#join-card").hidden = !me || !!profileMe; $("#composer").hidden = !profileMe; $("#me-card").hidden = !profileMe;
    if(profileMe){ $("#me-handle").textContent=profileMe.handle; $("#me-av").textContent=profileMe.photo?"":initial(profileMe.handle); $("#me-av").style.background=safeImg(profileMe.photo)?`url("${safeImg(profileMe.photo)}") center/cover`:""; { const meta=window.MW?.session?.()?.user?.user_metadata||{}; const ph=meta.avatar_url||meta.picture; if(ph && !profileMe.photo && /^https:\/\//.test(ph)) db.doc("members/"+me).update({photo:ph}).catch(()=>{}); } $("#me-gifts").textContent=(profileMe.giftsReceived||0)+" gifts received"; if(!window._lookLoaded){ window._lookLoaded=true; if(profileMe.look) look={...look,...profileMe.look}; if(profileMe.face) myFace=profileMe.face; drawBuilder(); setMine({look:{...look}}); } }
    renderShops(); renderLive(); renderGifts();
    const list=snap.docs.slice(0,8);
    $("#members").innerHTML = list.length ? list.map(d=>`<div>${avatarOf(d.id)}<span><b>${esc(d.data().handle)}</b><br><small class="muted">${esc(d.data().bio||"Member")}</small></span>${d.id!==me?`<button class="act dm-btn" type="button" data-dm="${d.id}">Message</button>`:""}</div>`).join("") : '<p class="muted" style="margin:0;font-size:14px">Members show up here when they join.</p>';
    renderFeed(); renderAds(); renderMsgs();
  }, err=>console.warn(err));
  subFeed(); subAds(); subChannel("lounge"); joinRoom(); subLive(); subGifts(); subGreets(); enterWorld();
  subRadio(); subCreators(); subGames(); window._subEq && window._subEq();
  if(isOwner){ $("#announce-opt").hidden=false; assets=await claude.use("assets"); $("#uploader").hidden=!assets; }
}
$$("dialog [data-close]").forEach(b=>b.addEventListener("click",()=>b.closest("dialog").close()));

/* Announcements: Meechie's posts marked "send to everybody" become a banner on every page */
function renderAnnouncement(){
  const a=posts.find(p=>p.announce); const bar=$("#announce");
  let dismissed=""; try{dismissed=localStorage.getItem("mw-dismissed")||"";}catch(e){}
  if(!a || dismissed===a.id){ bar.hidden=true; return; }
  $("#announce-text").textContent=(a.text||"New photo from Meechie").slice(0,160); bar.hidden=false; bar.dataset.id=a.id;
}
$("#announce-x").addEventListener("click",()=>{ try{localStorage.setItem("mw-dismissed",$("#announce").dataset.id);}catch(e){} $("#announce").hidden=true; });

/* Go Live */
let lives=[];
function subLive(){ db.collection("live").limit(100).onSnapshot(s=>{ lives=s.docs.map(d=>({id:d.id,...d.data()})).filter(l=>Date.now()-(l.startedAt||0)<6*3600e3); renderLive(); }, e=>console.warn(e)); }
function renderLive(){
  const fresh=lives.filter(l=>!l.onsite || Date.now()-(l.beat||l.startedAt||0)<90e3);
  const strip=$("#live-strip"); strip.hidden=!fresh.length;
  const sorted=[...fresh].sort((a,b)=>(b.host?1:0)-(a.host?1:0));
  const lnk=l=>l.onsite?`href="#live" data-go="live"`:`href="${esc(safeUrl(l.url))}" target="_blank" rel="noopener"`;
  strip.innerHTML=sorted.map(l=>`<a class="live-card ${l.host?"host":""}" ${lnk(l)}><span><span class="live-dot"></span><b>${esc(handleOf(l.id))}</b> ${l.host?'<span class="badge">Host</span>':''}</span><small>${esc(l.title)}</small><span style="font-size:13px;color:var(--gold-hi);font-weight:700">Watch live →</span></a>`).join("");
  const host=sorted.find(l=>l.host); $("#host-live").hidden=!host;
  if(host){ const L=$("#host-live-link"); $("#host-live-title").textContent=host.title; if(host.onsite){ L.href="#live"; L.dataset.go="live"; L.removeAttribute("target"); } else { L.href=safeUrl(host.url); delete L.dataset.go; L.target="_blank"; } }
  $("#end-live").hidden=!fresh.some(l=>l.id===me && !l.onsite);
}
setInterval(()=>{ try{ renderLive(); }catch(_){} },30000);
$("#go-live").addEventListener("click",()=>{ if(needMember()) $("#live-dialog").showModal(); });
$("#live-form").addEventListener("submit",async e=>{ e.preventDefault();
  try{ await db.doc("live/"+me).set({title:$("#lv-title").value.trim(),url:$("#lv-url").value.trim(),host:isOwner,startedAt:Date.now()}); $("#live-dialog").close(); toast(isOwner?"You're live. Everybody sees the banner.":"You're live. Members can tap in."); }
  catch(err){ toast(err.message||err.code); }
});
$("#end-live").addEventListener("click",async()=>{ await db.doc("live/"+me).delete().catch(()=>{}); $("#live-dialog").close(); toast("Live ended"); });

/* Gifts (free virtual gifts between members) */
const GIFTS=[["rose","🌹","Rose"],["mic","🎤","Mic"],["gold","🪙","Gold Coin"],["crown","👑","Crown"],["fire","🔥","Fire"],["diamond","💎","Diamond"]];
let giftTo=null, giftKind="rose", giftLog=[];
$("#gift-grid").innerHTML=GIFTS.map(([k,e,n])=>`<button class="gift" type="button" data-gift="${k}" aria-pressed="${k==="rose"}"><span>${e}</span>${n}</button>`).join("");
$("#gift-grid").addEventListener("click",e=>{const b=e.target.closest("[data-gift]"); if(!b) return; giftKind=b.dataset.gift; $$("#gift-grid .gift").forEach(x=>x.setAttribute("aria-pressed",x===b));});
function openGift(uid){ if(!needMember()) return; if(uid===me){toast("Send gifts to other members.");return;} giftTo=uid; $("#gift-to").textContent=handleOf(uid); $("#gift-dialog").showModal(); }
$("#gift-form").addEventListener("submit",async e=>{ e.preventDefault();
  const to=giftTo, kind=giftKind, note=$("#gift-note").value.trim();
  try{
    // paid gifts (coins): js/coins.js handles buying, the 60/40 split and cash-outs
    // every gift is paid for with coins (no free gifts)
    if(!(window.MW_COINS && MW_COINS.paid)){ toast("Gifts are bought with coins. The coin shop opens very soon!"); return; }
    const how=await MW_COINS.send(to,kind,note); if(how!=="paid") return;
    db.doc("members/"+to).update({giftsReceived:(members[to]?.giftsReceived||0)+1}).catch(()=>{});
    $("#gift-note").value=""; $("#gift-dialog").close(); toast("Gift sent to "+handleOf(to));
    document.dispatchEvent(new CustomEvent("mw-gift-sent",{detail:{to,kind}})); }
  catch(err){ toast(err.message||err.code); }
});
function subGifts(){ db.collection("gifts").orderBy("createdAt","desc").limit(300).onSnapshot(s=>{giftLog=s.docs.map(d=>d.data()); renderGifts();}, e=>console.warn(e)); }
/* ---------- host greetings (owner, 2026-10-29): greeted at the door ----------
 * When Meechie taps Greet in his booth, a doc lands on the greets shelf
 * addressed to one visitor (member uid, or a guest arrival id). Every
 * client watches that one small shelf on the change feed the site already
 * runs — no polling of its own — and shows the line once, as a personal
 * banner from the host. Member greets match by uid exactly and are marked
 * seen for good. Guest greets are claimed by arrival time: a guest only
 * sees one written within 3 minutes of their own arrival this session,
 * and at most one per session — the keeper keeps no guest identities, so
 * this window is what aims the greeting at the person who just walked in.
 * Anything older than 10 minutes is ignored, greeted or not. */
function subGreets(){
  if(window._greetsOn) return; window._greetsOn=true;
  const css=document.createElement("style"); css.textContent="#mw-greet{position:fixed;left:50%;transform:translateX(-50%);bottom:calc(var(--tabbar,0px) + 76px + env(safe-area-inset-bottom,0px));z-index:9996;max-width:min(92vw,520px);background:linear-gradient(180deg,#1d1e21,#101012);border:1px solid var(--gold,#f0cf78);color:#ffe9b0;border-radius:14px;padding:12px 14px;box-shadow:0 12px 32px rgba(0,0,0,.6);font:600 14.5px var(--body);display:flex;gap:10px;align-items:center}#mw-greet button{flex:0 0 auto}"; document.head.appendChild(css);
  let myArr=0; try{ myArr=+sessionStorage.getItem("mw-greet-arr")||0; if(!myArr){ myArr=Date.now(); sessionStorage.setItem("mw-greet-arr",String(myArr)); } }catch(_){ myArr=Date.now(); }
  const mSeen=()=>{ try{ return +localStorage.getItem("mw-greet-seen-m")||0; }catch(_){ return 0; } };
  const gSeen=()=>{ try{ return JSON.parse(sessionStorage.getItem("mw-greet-gseen")||"{\"ids\":[],\"done\":0}"); }catch(_){ return {ids:[],done:0}; } };
  const showGreet=(g)=>{
    if(document.getElementById("mw-greet")) return false;
    const el=document.createElement("div"); el.id="mw-greet"; el.setAttribute("role","status");
    const sp=document.createElement("span"); sp.textContent="🔴 Meechie, your host: "+String(g.text||"Welcome in!"); el.appendChild(sp);
    const b=document.createElement("button"); b.type="button"; b.className="btn sm"; b.textContent="🎧 Thanks!"; b.addEventListener("click",()=>el.remove()); el.appendChild(b);
    document.body.appendChild(el); setTimeout(()=>{ try{ el.remove(); }catch(_){} }, 20000);
    return true;
  };
  db.collection("greets").orderBy("at","desc").limit(20).onSnapshot(s=>{
    const now=Date.now();
    for(const d of s.docs){ const g=d.data()||{}; if(g.from!=="host"||!g.at||now-g.at>600000) continue;
      if(me){ if(d.id!==me) continue; if(mSeen()>=g.at) continue; if(showGreet(g)){ try{ localStorage.setItem("mw-greet-seen-m",String(g.at)); }catch(_){} } }
      else { if(g.to!=="guest") continue; const gs=gSeen(); if(gs.done||gs.ids.includes(d.id)) continue; if(g.at<myArr||g.at-myArr>180000) continue; if(showGreet(g)){ gs.ids.push(d.id); gs.done=g.at; try{ sessionStorage.setItem("mw-greet-gseen",JSON.stringify(gs)); }catch(_){} } }
    }
  }, ()=>{});
}
function renderGifts(){ if(!giftLog.length) return;
  $("#gift-feed").innerHTML=giftLog.slice(0,12).map(g=>{const G=GIFTS.find(x=>x[0]===g.kind)||GIFTS[0]; return `<div><span style="font-size:18px">${G[1]}</span> <b>${esc(handleOf(g.from))}</b> → <b>${esc(handleOf(g.to))}</b>${g.note?` <span class="muted">“${esc(g.note)}”</span>`:""}</div>`;}).join(""); }

/* Profile + store links */
$("#edit-profile").addEventListener("click",()=>{ if(!needMember()) return; const p=profileMe;
  $("#pf-handle").value=p.handle||""; $("#pf-bio").value=p.bio||""; $("#pf-printify").value=p.printify||""; $("#pf-shopify").value=p.shopify||""; $("#pf-other").value=p.store||""; $("#profile-dialog").showModal(); });
$("#profile-form").addEventListener("submit",async e=>{ e.preventDefault();
  const clean=v=>{v=v.trim(); return /^https:\/\//i.test(v)?v:"";};
  try{ await db.doc("members/"+me).update({handle:$("#pf-handle").value.trim(),bio:$("#pf-bio").value.trim(),printify:clean($("#pf-printify").value),shopify:clean($("#pf-shopify").value),store:clean($("#pf-other").value)});
    $("#profile-dialog").close(); toast("Profile saved"); }
  catch(err){ toast(err.message||err.code); }
});
const shopLinks=m=>[["Printify",m.printify],["Shopify",m.shopify],["Store",m.store]].filter(x=>x[1]);
function renderShops(){
  const list=Object.entries(members).filter(([,m])=>shopLinks(m).length);
  if(!list.length) return;
  $("#shops").innerHTML=list.map(([id,m])=>`<div class="shop"><span class="avatar">${esc(initial(m.handle))}</span><div><b>${esc(m.handle)}</b><br><small class="muted">${esc(m.bio||"")}</small><div class="links">${shopLinks(m).map(([n,u])=>`<a class="shop-link" href="${esc(safeUrl(u))}" target="_blank" rel="noopener">${n}</a>`).join("")}</div></div></div>`).join("");
}

/* ---------- Virtual world ---------- */
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
let look={skin:"#a26a43",hair:"fade",hairColor:"#111111",outfit:"suit",outfitColor:"#111111",extra:"shades",trim:"#d4a843",print:"none",printColor:"#d4a843",printText:"MW",photo:false};
let myFace="";
try{ const s=JSON.parse(localStorage.getItem("mw-look")||"null"); if(s) look={...look,...s}; }catch(e){}
let _clipN=0;
const LOOK_DEF={skin:"#a26a43",hair:"fade",hairColor:"#111111",outfit:"suit",outfitColor:"#111111",extra:"none",trim:"#d4a843",print:"none",printColor:"#d4a843"};
function cleanLook(L){ const o={...(L||{})}; for(const k in LOOK_DEF){ const v=o[k]; if(OPTS[k]&&!OPTS[k].vals.includes(v)) o[k]=(k in OPTS && /^#[0-9a-f]{6}$/i.test(v||"") && OPTS[k].vals[0].startsWith("#"))? v : LOOK_DEF[k]; } o.printText=String(o.printText||"").slice(0,10); o.photo=!!o.photo; return o; }
const cleanFace = f => /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(f||"") ? f : "";
function avatarSVG(L,pose,face){
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
function drawBuilder(){
  $("#av-stage").innerHTML=avatarSVG(look,"stand",look.photo&&myFace?myFace:"");
  const pt=$("#av-printtext"); if(pt){ pt.hidden=look.print!=="text"; if(document.activeElement!==pt) pt.value=look.printText||""; }
  $("#av-photo-toggle")&&($("#av-photo-toggle").hidden=!myFace, $("#av-photo-toggle").textContent=look.photo?"Use cartoon face":"Use my photo face");
  $("#av-opts").innerHTML=Object.entries(OPTS).map(([k,o])=>`<div class="opt"><b>${o.label}</b><div class="swatches">${o.vals.map(v=>v.startsWith("#")?`<button type="button" data-k="${k}" data-v="${v}" aria-label="${o.label} ${v}" aria-pressed="${look[k]===v}" style="background:${v}"></button>`:`<button type="button" data-k="${k}" data-v="${v}" aria-pressed="${look[k]===v}">${v==="goldchain"?"gold chain":v}</button>`).join("")}</div></div>`).join("");
}
$("#av-opts").addEventListener("click",e=>{const b=e.target.closest("[data-k]"); if(!b) return; look[b.dataset.k]=b.dataset.v; drawBuilder(); try{localStorage.setItem("mw-look",JSON.stringify(look));}catch(e){} setMine({look:{...look}}); });
$("#av-save").addEventListener("click",()=>{ if(!needMember()) return; db.doc("members/"+me).update({look}).then(()=>toast("Look saved")).catch(err=>toast(err.message||err.code)); });
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
    const {face,canvas}=await faceCrop(f); myFace=face; look.photo=true; drawBuilder(); setMine({look:{...look}});
    if(db && profileMe) db.doc("members/"+me).update({face}).catch(()=>{});
    const smp=await claude.use("sample"); const lim=smp ? await smp.limits().catch(()=>null) : null;
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
  try{ await db.collection("wardrobe").add({authorId:me,fit,likes:[],createdAt:Date.now()}); toast("Outfit shared to the Wardrobe"); }catch(err){ toast(err.message||err.code); } });
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
  if(w3d || !window.World3D || !World3D.supported()) return; w3d="loading";
  const sc=$("#scene");
  World3D.mount(sc,{
    onWalk:(x,y)=>setMine({x:clampX(x),y:clampY(y),pose:mine.pose==="sit"?"stand":mine.pose}),
    onPose:p=>{ setMine({pose:p,poseAt:Date.now()}); if(p==="wave") setTimeout(drawPeople,4100); },
    onSay:t=>{ t=String(t||"").trim().slice(0,120); if(!t) return; setMine({say:t,sayAt:Date.now()}); setTimeout(drawPeople,8100); }
  }).then(()=>{ w3d=true; sc.classList.add("is3d"); $("#emotes").hidden=true; $("#say-form").hidden=true; World3D.setRoom(roomName); drawPeople(); })
    .catch(err=>{ console.warn("3D world unavailable, using 2D",err); w3d="off"; });
}
new MutationObserver(()=>{ if(!$("#v-world").hidden) mount3D(); }).observe($("#v-world"),{attributes:true,attributeFilter:["hidden"]});
setTimeout(()=>{ if(!$("#v-world").hidden) mount3D(); },0);
addEventListener("load",()=>{ if(!$("#v-world").hidden) mount3D(); });
let wroom=null, roomName="lounge", peersNow=[], heard={}, logLines=[];
let mine={look:{...look},x:.5,y:.82,pose:"stand",uid:null,say:"",sayAt:0};
function setMine(patch){ Object.assign(mine,patch); if(wroom) wroom.presence(patch).catch(()=>{}); drawPeople(); }
function paintRoom(){ $("#room-label").textContent=ROOMS[roomName].name; if(w3d===true) World3D.setRoom(roomName);
  $("#props").innerHTML=`<svg viewBox="0 0 160 90" preserveAspectRatio="xMidYMid slice" style="width:100%;height:100%;display:block">${SCENES[roomName]}</svg>`; }
const clampX=x=>Math.min(.95,Math.max(.05,+x||.5)), clampY=y=>Math.min(.97,Math.max(.64,+y||.85));
const toons=new Map();
function nameFor(p){ const P=p.presence||{}; return p.isMe?"You":(members[p.by||P.uid]?.handle||"Guest"); }
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
    const uid=p.by||P.uid, L2={...look,...(P.look||{})}; const face = L2.photo ? (p.isMe? myFace : (members[uid]?.face||"")) : "";
    const sig=JSON.stringify([P.look,pose,face.length]); if(t._sig!==sig){ t._sig=sig; t.querySelector(".bod").innerHTML=avatarSVG(L2,pose==="dance"?"dance":pose,face); }
    t.querySelector(".tag").textContent=nameFor(p);
    const said=P.say && Date.now()-(P.sayAt||0)<8000; let b=t.querySelector(".bubble");
    if(said){ if(!b||b._at!==P.sayAt){ b?.remove(); b=document.createElement("div"); b.className="bubble"; b._at=P.sayAt; b.textContent=P.say; t.prepend(b);} } else b?.remove();
    if(P.say && P.sayAt && heard[key]!==P.sayAt){ heard[key]=P.sayAt; logLines.push({n:nameFor(p),t:String(P.say).slice(0,160)}); logLines=logLines.slice(-30); renderLog(); }
  });
  for(const [k,t] of toons) if(!seen.has(k)){ t.remove(); toons.delete(k); }
  $("#room-count").textContent=people.length+" here";
  if(w3d===true) World3D.update(people.map(p=>{ const P=p.isMe&&!wroom?mine:(p.sameTab?{...p.presence,...mine}:p.presence)||{}; const uid=p.by||P.uid, L2=cleanLook({...look,...(P.look||{})});
    return {key:p.peer,isMe:!!p.isMe,name:nameFor(p),look:L2,x:clampX(P.x),y:clampY(P.y),pose:P.pose||"stand",poseAt:P.poseAt||0,say:P.say?String(P.say).slice(0,120):"",sayAt:P.sayAt||0,faceUrl:L2.photo?cleanFace(p.isMe?myFace:(members[uid]?.face||"")):""}; }));
}
function renderLog(){ const el=$("#roomlog"); if(!logLines.length) return; el.innerHTML=logLines.map(l=>`<div><b>${esc(l.n)}</b>${esc(l.t)}</div>`).join(""); el.scrollTop=el.scrollHeight; }
async function enterWorld(){
  mine.uid=me; const lobby=await claude.use("room");
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
setInterval(drawPeople,2000);
paintRoom(); drawPeople();


/* ---------- Radio + music player ---------- */
const DEFAULT_EPOCH=Date.UTC(2026,0,1);
let tracks=[], radioEpoch=DEFAULT_EPOCH, assets=null, mode=null, curIdx=-1;
window.MW_TRACKS=()=>tracks;
const media=$("#audio");
media.crossOrigin="anonymous"; // our songs allow this, and it lets the booster below work
/* Volume booster: plays the radio and library about twice as loud, with a limiter so it doesn't crackle.
   (Skipped on iPhone/iPad, where it would stop the music when the screen locks.) */
const IOS=/iP(hone|ad|od)/.test(navigator.userAgent)||(navigator.platform==="MacIntel"&&navigator.maxTouchPoints>1);
const TOUCH=matchMedia("(pointer:coarse)").matches||/Android|Mobile/i.test(navigator.userAgent); // phones pause the booster when the screen locks, so phones play straight
let boostCtx=null, boostGain=null, eqNodes=[];
/* Equalizer: 5 bands between the song and the booster. Saved per listener. */
const EQ_BANDS=[{f:60,type:"lowshelf",n:"Bass"},{f:250,type:"peaking",n:"Low mid"},{f:1000,type:"peaking",n:"Mid"},{f:3500,type:"peaking",n:"Presence"},{f:10000,type:"highshelf",n:"Air"}];
const EQ_PRESETS={ "Flat":[0,0,0,0,0], "Studio":[2,-1,0,1.5,2], "Hip-Hop":[5,1,-1,1.5,2], "Vocals":[-1,-1,2,3,1.5], "Bass Boost":[8,3,0,0,0] };
/* Listeners hear Meechie's station EQ (saved in site/eq) until they change their own. */
let eqStation=EQ_PRESETS.Studio.slice(), eqPersonal=false;
let eqGains=(()=>{ try{ const s=JSON.parse(localStorage.getItem("mw_eq")||"null"); if(Array.isArray(s)&&s.length===5){ eqPersonal=true; return s.map(Number); } }catch(_){} return EQ_PRESETS.Studio.slice(); })();
let eqOn=(()=>{ try{ return localStorage.getItem("mw_eq_on")!=="0"; }catch(_){ return true; } })();
function applyEq(){ eqNodes.forEach((n,i)=>{ n.gain.value = eqOn ? eqGains[i] : 0; }); }
function setupBoost(force){ if(boostCtx) return true; if((IOS||TOUCH) && !force) return false;
  try{ const C=window.AudioContext||window.webkitAudioContext; try{ boostCtx=new C({latencyHint:"playback"}); }catch(_){ boostCtx=new C(); }
    const src=boostCtx.createMediaElementSource(media); boostGain=boostCtx.createGain(); boostGain.gain.value=(IOS||TOUCH)?1:+(window.MW_SITE?.boost||2); /* booster is desktop-only; phones get the EQ alone */
    const lim=boostCtx.createDynamicsCompressor(); lim.threshold.value=-4; lim.knee.value=4; lim.ratio.value=20; lim.attack.value=0.002; lim.release.value=0.15;
    eqNodes=EQ_BANDS.map(b=>{ const f=boostCtx.createBiquadFilter(); f.type=b.type; f.frequency.value=b.f; if(b.type==="peaking") f.Q.value=1; return f; });
    let node=src; eqNodes.forEach(f=>{ node.connect(f); node=f; }); node.connect(boostGain); boostGain.connect(lim); lim.connect(boostCtx.destination);
    applyEq(); return true;
  }catch(_){ boostCtx=null; eqNodes=[]; return false; } }
const wakeBoost=()=>{ setupBoost(); if(boostCtx && boostCtx.state!=="running") boostCtx.resume().catch(()=>{}); };
document.addEventListener("pointerdown",wakeBoost,{capture:true}); document.addEventListener("keydown",wakeBoost,{capture:true});
media.addEventListener("play",()=>{ if(boostCtx && boostCtx.state!=="running") boostCtx.resume().catch(()=>{}); });
const fmt=s=>{s=Math.max(0,Math.floor(s||0));return Math.floor(s/60)+":"+String(s%60).padStart(2,"0");};
const trackUrl=t=>(window.MW?.assetUrl? MW.assetUrl(t.assetId) : "/_blob/"+t.assetId);
const ICON_PLAY='<path d="M7 4v16l13-8z"/>', ICON_PAUSE='<path d="M6 5h4v14H6zM14 5h4v14h-4z"/>';
/* Crossfade: on the station schedule, each song hands over XF seconds before it ends, so the next song
   starts while the last one fades out. Everyone's player uses the same schedule, so the station stays in sync. */
const XF=4;
const slot=t=>{ const d=t.duration||0; return d>XF*3 ? d-XF : d; };
function airNow(){
  const total=tracks.reduce((a,t)=>a+slot(t),0); if(!total) return null;
  let t=((Date.now()-radioEpoch)/1000)%total; if(t<0) t+=total;
  for(let i=0;i<tracks.length;i++){ const d=slot(tracks[i]); if(t<d) return {i,offset:t,left:d-t}; t-=d; }
  return {i:0,offset:0,left:slot(tracks[0])};
}
function setCover(el,t){ if(safeImg(t?.cover)){ el.style.backgroundImage=`url("${t.cover}")`; el.innerHTML=""; } }
function paintAir(){
  const djA = window.MW_AIRNOW && window.MW_AIRNOW();
  if (djA) {
    $("#onair-flag").textContent = "● ON AIR"; $("#onair-flag").classList.toggle("off", false);
    $("#air-title").textContent = djA.title; $("#air-artist").textContent = djA.sub;
    if (djA.cover) setCover($("#air-cover"), { cover: djA.cover }); else $("#air-cover").style.backgroundImage = "";
    $("#onair").classList.toggle("playing", typeof mode !== "undefined" && mode === "dj" && typeof media !== "undefined" && !media.paused);
    return;
  }
  const a=airNow(), t=a&&tracks[a.i];
  $("#onair-flag").textContent = t ? "● ON AIR" : "● OFF AIR"; $("#onair-flag").classList.toggle("off",!t);
  if(t){ $("#air-title").textContent=t.title; $("#air-artist").textContent=t.artist+" · "+fmt(a.left)+" left"; setCover($("#air-cover"),t); }
  $("#onair").classList.toggle("playing", mode==="radio" && !media.paused);
}
setInterval(paintAir,1000);
function renderTracks(){
  $("#lib-count").textContent=tracks.length+(tracks.length===1?" track":" tracks");
  if(!tracks.length){ $("#tracks").innerHTML='<div class="empty" style="border:0;border-radius:0">No tracks yet. New music from Meechie\'s World shows up here.</div>'; paintAir(); return; }
  $("#tracks").innerHTML=tracks.map((t,i)=>`<div class="track ${mode==="library"&&curIdx===i?"current":""}">
    <button class="ibtn" type="button" data-play="${i}" aria-label="Play ${esc(t.title)}"><svg viewBox="0 0 24 24" fill="currentColor">${mode==="library"&&curIdx===i&&!media.paused?ICON_PAUSE:ICON_PLAY}</svg></button>
    <div class="cv" style="${safeImg(t.cover)?`background-image:url('${esc(safeImg(t.cover))}')`:""}"></div>
    <div class="t"><b>${esc(t.title)}</b><small>${esc(t.artist)}</small></div>
    <span class="d">${fmt(t.duration)}</span>
    <span class="ops"><button class="act" data-off="${i}">⬇ Save</button>${isOwner?`<button class="act" data-onair="${i}">Play on air</button><button class="act" data-tdel="${t.id}">Delete</button>`:""}</span></div>`).join("");
  paintAir();
}
function showBar(t,sub){ lockScreen(t,sub); $("#player-bar").hidden=false; document.body.classList.add("has-player"); $("#pb-title").textContent=t.title; $("#pb-sub").textContent=sub; const c=$("#pb-cover"); c.style.backgroundImage=""; c.innerHTML=$("#air-cover").innerHTML||c.innerHTML; setCover(c,t); }
// Start playing right away (play() in the same moment the last song ends), then jump to the right spot.
// Waiting for the file to load first fails when the phone screen is off, because phones hold back loading for hidden pages.
function load(t,offset,autoplay){ return new Promise(res=>{ let done=false; const fin=()=>{ if(!done){ done=true; res(); } };
  media.onloadedmetadata=media.onerror=null; media.preload="auto"; media.src=trackUrl(t);
  media.onloadedmetadata=()=>{ if(offset) try{media.currentTime=Math.min(offset,(media.duration||offset)-0.5);}catch(e){} fin(); };
  media.onerror=()=>{ if(!document.hidden) toast("This track couldn't load."); fin(); };
  if(autoplay) media.play().catch(()=>{}); else media.load(); setTimeout(fin,4000); }); }
let playTok=0;
async function tuneIn(afterEnd){ const tok=++playTok;
  if (window.MW_DJ_LIVE && window.MW_DJ_LIVE()) { window.MW_DJ.start(); return; }
  let a=airNow(); if(a && afterEnd===true && a.i===curIdx) a={i:(curIdx+1)%tracks.length,offset:0}; // song file shorter than listed: move on instead of replaying
  if(!a && tracks.length) a={i:0,offset:0}; // station clock not ready but the music is here: start the playlist — never a dead button
  if(!a){ toast("The station starts when the first track is added."); return; }
  // After a song ends: pick up exactly where the crossfade left the next song, or near its start if there was no crossfade
  const handoff=afterEnd===true ? xfOffset(a.i) : null;
  const off=afterEnd===true ? (handoff!=null ? handoff : Math.max(0,a.offset-XF)) : a.offset;
  mode="radio"; curIdx=a.i; await load(tracks[a.i], off, true); if(tok!==playTok) return;
  media.play().catch(()=>{ if(!document.hidden) toast("Tap play to start the audio."); }); showBar(tracks[a.i],"Meechie's World Radio · LIVE");
  room?.presence({radio:true}); renderTracks(); updIcons();
}
async function playLib(i,off){
  if(mode==="library" && curIdx===i){ media.paused?media.play():media.pause(); return; }
  const tok=++playTok; mode="library"; curIdx=(i+tracks.length)%tracks.length; const t=tracks[curIdx];
  await load(t,off||0,true); if(tok!==playTok) return; media.play().catch(()=>{}); showBar(t,t.artist); room?.presence({radio:null}); renderTracks();
}
function updIcons(){ const el=(mode==="live"&&window.MW_LIVE)?MW_LIVE:media; $("#pb-icon").innerHTML = el.paused?ICON_PLAY:ICON_PAUSE; $("#pb-play").setAttribute("aria-label",el.paused?"Play":"Pause");
  $("#tune-in").textContent = mode==="radio"&&!media.paused ? "❚❚ Pause radio" : "▶ Tune in"; renderTracks(); }
media.addEventListener("play",updIcons); media.addEventListener("pause",updIcons);
media.addEventListener("play",()=>{ if(window.MW_LIVE && !MW_LIVE.paused) MW_LIVE.pause(); });
/* Lock screen / notification controls, so the music keeps going when the phone locks */
function lockScreen(t,sub){ if(!("mediaSession" in navigator)||!t) return;
  try{ const art=/^https:\/\//.test(t.cover||"")?[{src:t.cover,sizes:"512x512"}]:[{src:location.origin+"/img/icon-512.png",sizes:"512x512",type:"image/png"}];
    navigator.mediaSession.metadata=new MediaMetadata({title:t.title||"Meechie's World Radio",artist:t.artist||"Meechie",album:sub||"Meechie's World Radio",artwork:art}); }catch(_){} }
if("mediaSession" in navigator){ const ms=navigator.mediaSession, H=(a,f)=>{ try{ ms.setActionHandler(a,f); }catch(_){} };
  H("play",()=>{ if(mode==="live"&&window.MW_LIVE){ MW_LIVE.play().catch(()=>{}); return; } if(mode==="dj"){ window.MW_DJ?.start(); return; } if(mode==="radio"&&media.paused) tuneIn(); else media.play().catch(()=>{}); });
  H("pause",()=>{ if(mode==="live"&&window.MW_LIVE){ MW_LIVE.pause(); return; } if(mode==="dj"){ window.MW_DJ?.stop(); return; } media.pause(); });
  H("nexttrack",()=>{ if(mode==="library") playLib(curIdx+1); else if(mode==="intro") tuneIn(); });
  H("previoustrack",()=>{ if(mode==="library"){ if(media.currentTime>3) media.currentTime=0; else playLib(curIdx-1); } });
  media.addEventListener("play",()=>{ try{ ms.playbackState="playing"; }catch(_){} }); media.addEventListener("pause",()=>{ try{ ms.playbackState="paused"; }catch(_){} }); }
media.addEventListener("ended",()=>{ if(mode==="intro"){ tuneIn(); return; } if(mode==="radio") tuneIn(true); else if(mode==="library"){ const n=(curIdx+1)%tracks.length; playLib(n, xfOffset(n)||0); } });
media.addEventListener("timeupdate",()=>{ const d=isFinite(media.duration)&&media.duration?media.duration:(tracks[curIdx]?.duration||0); $("#pb-fill").style.width=(mode==="live"?100:(d?media.currentTime/d*100:0))+"%"; $("#pb-time").textContent=mode==="live"?"● LIVE":fmt(media.currentTime)+" / "+fmt(d); });
$("#tune-in").addEventListener("click",()=>{ if(window.MW_DJ_LIVE && window.MW_DJ_LIVE()){ window.MW_DJ.toggle(); return; } if(mode==="radio"&&!media.paused){ media.pause(); room?.presence({radio:null}); } else tuneIn(); });
$("#pb-play").addEventListener("click",()=>{ if(mode==="live"&&window.MW_LIVE){ MW_LIVE.paused?MW_LIVE.play().catch(()=>{}):MW_LIVE.pause(); return; } if(mode==="dj"){ document.getElementById("dj-listen")?.click(); return; } if(mode==="radio"&&media.paused){ tuneIn(); return; } media.paused?media.play():media.pause(); });
$("#pb-next").addEventListener("click",()=>{ if(mode==="live"||mode==="dj") return; if(mode==="intro"){ tuneIn(); return; } if(mode==="radio"){toast("The radio is live for everyone. Pick a track in the Library to skip around.");return;} playLib(curIdx+1); });
$("#pb-prev").addEventListener("click",()=>{ if(mode==="live"||mode==="dj") return; if(mode==="radio"){toast("The radio is live for everyone.");return;} if(media.currentTime>3) media.currentTime=0; else playLib(curIdx-1); });
$("#pb-bubble")?.addEventListener("click",()=>{ if(window.MW_DJ && MW_DJ.bubble) MW_DJ.bubble(); });
$("#pb-progress").addEventListener("click",e=>{ if(mode!=="library"||!media.duration) return; const r=e.currentTarget.getBoundingClientRect(); media.currentTime=(e.clientX-r.left)/r.width*media.duration; });
/* ---------- Volume + crossfade between songs ----------
   About 20 seconds before a song ends, the next song loads in a second player. For the last XF seconds the
   next song plays and gets louder while the current one fades out, so there's no silent gap. When the current
   song ends, the main player takes over the next song from the exact same spot.
   Real volume = your slider × the fade × the "duck" (music dips while a voice message plays).
   Skipped on iPhones (websites can't change volume there) and while the page is in the background
   (phones slow down timers then); in those cases the next song just starts right away. */
let userVol=+$("#pb-vol").value||1, fadeVol=1, duckVol=1;
const xfPlayer=new Audio(); xfPlayer.crossOrigin="anonymous"; xfPlayer.preload="auto"; xfPlayer.setAttribute("playsinline","");
let xfIdx=-1, xfActive=false, xfNode=null;
function applyVol(){ try{ media.volume=Math.max(0,Math.min(1,userVol*fadeVol*duckVol)); }catch(_){} }
window.MW_duck=(v)=>{ duckVol=v; applyVol(); };
$("#pb-vol").addEventListener("input",e=>{ userVol=+e.target.value; applyVol(); });
const xfMode=()=>mode==="radio"||mode==="library"||mode==="intro";
function xfStop(){ xfActive=false; xfIdx=-1; try{ xfPlayer.pause(); xfPlayer.removeAttribute("src"); xfPlayer.load(); }catch(_){} if(fadeVol!==1){ fadeVol=1; applyVol(); } }
/* Where the next song is right now, if the crossfade player is already playing it */
function xfOffset(i){ return (xfActive && xfIdx===i && !xfPlayer.paused) ? xfPlayer.currentTime+0.12 : null; }
function xfRoute(){ // send the crossfade player through the same equalizer and booster as the main player
  if(xfNode || !boostCtx) return;
  try{ xfNode=boostCtx.createMediaElementSource(xfPlayer); xfNode.connect(eqNodes[0]||boostGain); }catch(_){ xfNode=null; }
}
// main player picked up the next song: retire the crossfade player
media.addEventListener("playing",()=>{ if(xfActive && xfIdx===curIdx) setTimeout(xfStop,150); else if(xfActive || xfIdx>=0) xfStop(); fadeVol=1; applyVol(); });
media.addEventListener("pause",()=>{ if(!media.ended) xfStop(); });
document.addEventListener("visibilitychange",()=>{ if(document.hidden && !xfActive){ fadeVol=1; applyVol(); } });
setInterval(()=>{
  if(!xfMode()||media.paused||tracks.length<2){ if(xfIdx>=0&&!xfActive) xfStop(); return; }
  const d=isFinite(media.duration)&&media.duration?media.duration:(tracks[curIdx]?.duration||0), left=d-media.currentTime;
  if(d<=XF*3 || IOS) return;
  if(xfActive && left>XF+0.5){ xfStop(); return; } // went back or seeked during a crossfade: cancel it
  const intro=mode==="intro", air=intro?airNow():null;
  const next=intro ? (air?air.i:0) : (curIdx+1)%tracks.length; // after the welcome song: whatever the station is playing
  if(!xfActive && left<20 && xfIdx!==next && !document.hidden){ xfIdx=next; xfPlayer.src=trackUrl(tracks[next]); xfPlayer.volume=0; xfPlayer.load(); }
  if(!xfActive && left<XF && left>0.3 && xfIdx===next && !document.hidden && xfPlayer.readyState>=2){
    xfRoute(); xfActive=true; try{ xfPlayer.currentTime=intro ? Math.max(0,air.offset) : Math.max(0,XF-left); }catch(_){} xfPlayer.volume=0; xfPlayer.play().catch(()=>xfStop());
  }
  if(xfActive){
    const k=Math.max(0,Math.min(1,left/XF));           // 1 → 0 across the crossfade
    fadeVol=Math.pow(k,1.5); applyVol();                 // current song fades out
    try{ xfPlayer.volume=Math.max(0,Math.min(1,userVol*duckVol*(1-Math.pow(k,1.5)))); }catch(_){} // next song fades in
  }
},60);
/* ---------- Equalizer panel ---------- */
(function(){
  const panel=$("#eq-panel"), btn=$("#pb-eq"), bands=$("#eq-bands"), presets=$("#eq-presets"), onBox=$("#eq-on"), note=$("#eq-note"), enable=$("#eq-enable");
  const same=(a,b)=>a.every((v,i)=>Math.abs(v-b[i])<0.01);
  let ownerTimer=0;
  const save=()=>{
    eqPersonal=true;
    try{ localStorage.setItem("mw_eq",JSON.stringify(eqGains)); localStorage.setItem("mw_eq_on",eqOn?"1":"0"); }catch(_){}
    // the owner's settings become the station default for every listener who hasn't changed theirs
    if(typeof isOwner!=="undefined" && isOwner){ clearTimeout(ownerTimer); ownerTimer=setTimeout(()=>{
      eqStation=eqGains.slice(); db.doc("site/eq").set({gains:eqStation,updatedAt:Date.now()}).then(()=>{ const s=$("#eq-own"); if(s) s.textContent="Saved as the station sound ✓"; }).catch(e=>toast("Couldn't save the station EQ: "+(e.message||e.code)));
    },700); }
  };
  const phone=IOS||TOUCH;
  function paint(){
    const live=!!boostCtx, owner=typeof isOwner!=="undefined" && isOwner;
    enable.hidden=live; note.hidden=!(phone&&live);
    onBox.checked=eqOn; onBox.disabled=!live;
    const all={ "Station":eqStation, ...EQ_PRESETS };
    const cur=same(eqGains,eqStation) ? "Station" : Object.keys(EQ_PRESETS).find(k=>same(EQ_PRESETS[k],eqGains));
    presets.innerHTML=Object.keys(all).filter(k=>!(owner&&k==="Station")).map(k=>`<button type="button" class="eq-chip${k===cur?" on":""}" data-preset="${k}"${live?"":" disabled"}>${k==="Station"?"Meechie's mix":k}</button>`).join("")
      + (owner ? `<small class="eq-own" id="eq-own">You're the owner: listeners hear your settings until they change their own.</small>` : "");
    bands.innerHTML=EQ_BANDS.map((b,i)=>`<label class="eq-band"><span class="eq-db">${eqGains[i]>0?"+":""}${(+eqGains[i]).toFixed(1)}</span><input type="range" min="-12" max="12" step="0.5" value="${eqGains[i]}" data-band="${i}" aria-label="${b.n} ${b.f<1000?b.f+" hertz":b.f/1000+" kilohertz"}"${live?"":" disabled"}><span>${b.n}</span><small>${b.f<1000?b.f:b.f/1000+"k"}Hz</small></label>`).join("");
  }
  function show(open){ panel.hidden=!open; btn.setAttribute("aria-expanded",String(open)); if(open){ if(!phone) wakeBoost(); paint(); } }
  btn.addEventListener("click",()=>show(panel.hidden));
  $("#eq-x").addEventListener("click",()=>show(false));
  enable.addEventListener("click",()=>{ if(setupBoost(true)){ if(boostCtx.state!=="running") boostCtx.resume().catch(()=>{}); eqOn=true; applyEq(); save(); toast("Equalizer on"); } else toast("This browser can't run the equalizer."); paint(); });
  onBox.addEventListener("change",()=>{ eqOn=onBox.checked; applyEq(); save();
    // phones: the music stays routed through the equalizer until the page reloads, so reload to get lock-screen playback back
    if(!eqOn && phone && boostCtx){ toast("Equalizer off. Reloading so music keeps playing when your screen locks…"); setTimeout(()=>location.reload(),900); } });
  presets.addEventListener("click",e=>{ const b=e.target.closest("[data-preset]"); if(!b) return;
    if(b.dataset.preset==="Station"){ // back to Meechie's mix: forget this listener's own setting
      eqGains=eqStation.slice(); eqOn=true; eqPersonal=false; applyEq(); try{ localStorage.removeItem("mw_eq"); localStorage.setItem("mw_eq_on","1"); }catch(_){} paint(); return; }
    eqGains=EQ_PRESETS[b.dataset.preset].slice(); eqOn=true; applyEq(); save(); paint(); });
  // load the station EQ; listeners who haven't changed theirs follow it, even when Meechie updates it later
  window._subEq=()=>{ try{ db.doc("site/eq").onSnapshot(s=>{ const g=s.exists && s.data().gains; if(!Array.isArray(g)||g.length!==5) return;
    eqStation=g.map(Number); if(!eqPersonal){ eqGains=eqStation.slice(); applyEq(); } if(!panel.hidden) paint(); }, ()=>{}); }catch(_){} };
  bands.addEventListener("input",e=>{ const i=e.target.dataset.band; if(i==null) return; eqGains[+i]=+e.target.value; eqOn=true; onBox.checked=true; applyEq(); save();
    const lab=e.target.parentElement.querySelector(".eq-db"); lab.textContent=(eqGains[i]>0?"+":"")+(+eqGains[i]).toFixed(1); presets.querySelectorAll(".eq-chip").forEach(c=>c.classList.remove("on")); });
  document.addEventListener("keydown",e=>{ if(e.key==="Escape"&&!panel.hidden) show(false); });
})();
$("#tracks").addEventListener("click",async e=>{ const b=e.target.closest("button"); if(!b) return;
  if(b.dataset.play) playLib(+b.dataset.play);
  if(b.dataset.onair){ const i=+b.dataset.onair, before=tracks.slice(0,i).reduce((a,t)=>a+slot(t),0);
    await setEpoch(Date.now()-before*1000); toast(tracks[i].title+" is on air now"); if(mode==="radio") tuneIn(); }
  if(b.dataset.tdel){ if(!b.dataset.confirm){ b.dataset.confirm="1"; b.textContent="Tap again"; return; }
    const t=tracks.find(x=>x.id===b.dataset.tdel); await db.doc("tracks/"+t.id).delete().catch(err=>toast(err.message||err.code)); assets?.delete(t.assetId).catch(()=>{}); toast("Track deleted"); }
});

/* ---------- Radio starts when the site opens ---------- */
let autoTried=false;
function radioSnoozed(){ try{ return sessionStorage.getItem("mw_radio_off")==="1"; }catch(_){ return false; } }
function snoozeRadio(){ try{ sessionStorage.setItem("mw_radio_off","1"); }catch(_){} hideRadioNote(); }
function hideRadioNote(){ const n=document.getElementById("radio-note"); if(n) n.remove(); }
function showRadioNote(){
  if(document.getElementById("radio-note")) return;
  const n=document.createElement("div"); n.id="radio-note";
  n.innerHTML='<span>🔊 <b>Meechie\'s World Radio</b> is live. Tap anywhere to listen.</span><button type="button" aria-label="No thanks">✕</button>';
  n.querySelector("button").addEventListener("click",e=>{ e.stopPropagation(); snoozeRadio(); });
  document.body.appendChild(n);
}
async function autoRadio(){
  if(window.MW_show) return; // owner: music only starts when people pick it (the videos play first)
  if(autoTried || !tracks.length || radioSnoozed() || (window.MW_SITE && window.MW_SITE.autoplay===false)) return;
  { const en=document.getElementById("enter"); if(en && !en.hidden && !en.classList.contains("out")) return; } // wait for the Enter button
  if(document.documentElement.classList.contains("gated")) return; // not signed in yet
  if(window._welcomeOn) return; // Meechie's welcome video is playing
  if(mode && !media.paused) return;
  autoTried=true;
  const a=airNow(); if(!a) return;
  const tok=++playTok; mode="radio"; curIdx=a.i; await load(tracks[a.i], airNow().offset); if(tok!==playTok) return; // a song picked meanwhile wins
  try{ await media.play(); showBar(tracks[a.i],"Meechie's World Radio · LIVE"); room?.presence({radio:true}); renderTracks(); updIcons(); }
  catch(_){
    showRadioNote();
    const go=e=>{
      if(window.MW_BLACKOUT) return; // blackout is up (dj.js sets the flag): a touch on the locked screen must not restart or skip anything
      if(e.target.closest && e.target.closest("#radio-note button,#player-bar,#tune-in,#mw-bar,#ai-panel,input,textarea,select,#dj-root,#world-radio,#v-videos,.htt-grid,#v-clips,#tracks,iframe,video,a[href],.lv-card,#scene")) return;
      document.removeEventListener("pointerdown",go,true); document.removeEventListener("keydown",go,true); hideRadioNote();
      if(radioSnoozed() || (mode && mode!=="radio") || (mode==="radio" && !media.paused)) return;
      const n=airNow(); if(!n) return;
      if(n.i===curIdx){ try{ media.currentTime=n.offset; }catch(_){} media.play().then(()=>{ showBar(tracks[n.i],"Meechie's World Radio · LIVE"); room?.presence({radio:true}); renderTracks(); updIcons(); }).catch(()=>{}); }
      else tuneIn();
    };
    document.addEventListener("pointerdown",go,true); document.addEventListener("keydown",go,true);
  }
}
/* Videos play with their own sound. While one does, the radio (or the welcome song) steps aside,
   and it comes back on its own when the video stops or you scroll away.
   Sound starts by itself after your first tap on the site, except on iPhones, which need a tap on each video. */
window.MW_canSound=()=>!IOS && (!navigator.userActivation || navigator.userActivation.hasBeenActive);
{ let back=null, t=0, vidPause=false;
  window.MW_videoSound={
    start(){ clearTimeout(t); if(back===null) back=(!media.paused && (mode==="radio"||mode==="intro"||mode==="library")) ? mode : false;
      if(!media.paused){ vidPause=true; media.pause(); } },
    end(){ clearTimeout(t); t=setTimeout(()=>{ const m=back; back=null; if(!m || !media.paused || mode!==m) return;
      if(m==="radio") tuneIn(); else media.play().catch(()=>{}); },1500); },
    holding:()=>back!==null
  };
  // the "pause" event arrives a moment after media.pause(), so the flag is used up here, not reset right after pause()
  media.addEventListener("pause",()=>{ if(vidPause){ vidPause=false; return; } // a video stepped the radio aside
    if(back!==null && !media.ended) back=false; // you paused it yourself: don't bring it back after the video
    if(mode==="radio" && document.visibilityState==="visible" && !media.ended) { try{ sessionStorage.setItem("mw_radio_off","1"); }catch(_){} } });
}
/* ---------- Featured Artists: official embedded players (free, no licensing needed from us) ----------
   Add a row for each artist you're featuring. Only SoundCloud, Spotify and YouTube links are embedded.
   Example: { artist: "Artist name", title: "Song title", url: "https://soundcloud.com/artist/track" } */
const FEATURED=[
  // { artist:"", title:"", url:"" },
];
function embedFor(u){
  try{
    const x=new URL(u), h=x.hostname.replace(/^www\./,"");
    if(h==="soundcloud.com"||h==="m.soundcloud.com") return "https://w.soundcloud.com/player/?url="+encodeURIComponent("https://soundcloud.com"+x.pathname)+"&visual=false&color=%23d4a843";
    if(h==="open.spotify.com"){ const m=x.pathname.match(/^\/(track|album|playlist)\/([A-Za-z0-9]+)/); return m?`https://open.spotify.com/embed/${m[1]}/${m[2]}`:null; }
    if(h==="youtube.com"||h==="m.youtube.com"){ const id=x.searchParams.get("v"); return id&&/^[\w-]{6,20}$/.test(id)?"https://www.youtube.com/embed/"+id:null; }
    if(h==="youtu.be"){ const id=x.pathname.slice(1); return /^[\w-]{6,20}$/.test(id)?"https://www.youtube.com/embed/"+id:null; }
  }catch(_){} return null;
}
function renderFeatured(){
  const wrap=document.getElementById("featured-wrap"), box=document.getElementById("featured");
  if(!wrap||!box) return;
  const items=FEATURED.map(f=>({...f,src:embedFor(f.url||"")})).filter(f=>f.src);
  if(!items.length){ wrap.hidden=true; box.innerHTML=""; return; }
  wrap.hidden=false;
  box.innerHTML=items.map(f=>`<div class="feat"><small class="muted">${esc(f.artist||"")}${f.title?" · "+esc(f.title):""}</small><iframe src="${f.src}" title="${esc((f.artist||"")+" "+(f.title||""))}" loading="lazy" allow="autoplay; encrypted-media; clipboard-write" style="width:100%;border:0;border-radius:8px;height:${f.src.includes("spotify")?"152":"166"}px"></iframe></div>`).join("");
}
renderFeatured();

/* Welcome song: when someone taps Enter, "they been waiting" plays first, from the start.
   When it ends (with a crossfade on computers and Android), the live radio comes on right where the station is. */
const INTRO_ID="rn336809020rx8ad"; // "they been waiting" plays first when people enter
const introIdx=()=>{ let i=tracks.findIndex(t=>t.id===INTRO_ID); if(i<0) i=tracks.findIndex(t=>/^they been waiting$/i.test((t.title||"").trim())); return i; };
async function playIntro(){
  const i=introIdx(); if(i<0) return false;
  const tok=++playTok; mode="intro"; curIdx=i; autoTried=true;
  await load(tracks[i],0,true); if(tok!==playTok) return true;
  media.play().catch(()=>{ if(!document.hidden) toast("Tap play to start the audio."); });
  showBar(tracks[i],"Welcome to Meechie's World · the live radio comes on next"); room?.presence({radio:null}); renderTracks(); updIcons();
  return true;
}

/* Enter screen: the tap counts as permission, so the radio can start with sound right away */
(function(){
  const en=document.getElementById("enter"); if(!en) return;
  const btn=document.getElementById("en-go"), mute=document.getElementById("en-mute");
  function close(){ try{ sessionStorage.setItem("mw_entered","1"); }catch(_){}
    document.documentElement.style.overflow=""; en.classList.add("out"); setTimeout(()=>{ en.hidden=true; },520); }
  btn.addEventListener("click",()=>{
    close();
    try{ sessionStorage.removeItem("mw_radio_off"); }catch(_){}
    hideRadioNote();
    if(window.MW_SITE && window.MW_SITE.autoplay===false) return;
    // owner: the welcome video, then Meechie's videos keep playing; music only when people pick it
    if(window.MW_show){ autoTried=true; const sh=()=>MW_show.start();
      if(window.MW_welcome && !document.documentElement.classList.contains("gated")){ try{ if(!media.paused) media.pause(); }catch(_){} window._welcomeOn=true; MW_welcome(()=>{ window._welcomeOn=false; sh(); }); } else sh();
      return; }
    if(!tracks.length){ window._introPending=true; if(window.MW_welcome && !document.documentElement.classList.contains("gated")){ window._welcomeOn=true; MW_welcome(()=>{ window._welcomeOn=false; if(tracks.length && window._introPending){ window._introPending=false; playIntro().then(ok=>{ if(!ok && !autoTried) autoRadio(); }); } }); } return; } // the welcome song starts as soon as the songs arrive
    const startAudio=()=>setTimeout(async()=>{ if(mode && !media.paused && mode!=="radio") return;
      if(await playIntro()) return;                 // the welcome song first, then the live radio
      if(mode==="radio" && !media.paused) return;
      if(!autoTried) autoRadio(); else tuneIn(); },250);
    // Meechie's welcome video plays first (full screen, with sound), then the welcome song
    if(window.MW_welcome && !document.documentElement.classList.contains("gated")){ try{ if(!media.paused) media.pause(); }catch(_){}
      // iPhone only lets the player make sound later if it was started during this tap: start it silently now, the welcome song plays after the video
      if(IOS && media.paused && mode!=="radio"){ const ii=introIdx(); if(ii>=0){ try{ media.src=trackUrl(tracks[ii]); media.muted=true; const un=()=>{ media.muted=false; }; const p=media.play(); if(p&&p.then) p.then(()=>{ if(window._welcomeOn) media.pause(); un(); },un); else { media.pause(); un(); } }catch(_){ media.muted=false; } } }
      window._welcomeOn=true; MW_welcome(()=>{ window._welcomeOn=false; startAudio(); }); }
    else startAudio();
  });
  mute.addEventListener("click",()=>{ snoozeRadio(); if(mode==="radio" && !media.paused) media.pause(); close(); });
  setTimeout(()=>{ if(!en.hidden) btn.focus({preventScroll:true}); },50);
})();
async function setEpoch(ms){ try{ await db.doc("radio/state").set({epoch:ms}); }catch(err){ toast(err.message||err.code); } }
$("#restart-station").addEventListener("click",async()=>{ await setEpoch(Date.now()); toast("Station restarted from track 1"); if(mode==="radio") tuneIn(); });
function subRadio(){
  db.collection("tracks").orderBy("addedAt","asc").limit(500).onSnapshot(s=>{ tracks=s.docs.map(d=>({id:d.id,...d.data()})); renderTracks(); if(window._introPending && !window._welcomeOn){ window._introPending=false; playIntro().then(ok=>{ if(!ok && !autoTried) autoRadio(); }); } else if(!autoTried) setTimeout(autoRadio,400); }, e=>console.warn(e));
  db.doc("radio/state").onSnapshot(d=>{ radioEpoch=d.exists?(d.data().epoch||DEFAULT_EPOCH):DEFAULT_EPOCH; paintAir(); }, e=>console.warn(e));
  db.collection("requests").orderBy("createdAt","desc").limit(25).onSnapshot(s=>{
    const rows = s.docs.map(d=>d.data()).filter(r=>String(r.text||"").trim()); $("#req-list").innerHTML = !rows.length ? '<p class="muted" style="margin:0;font-size:14px">Request a song or send a shoutout to the station.</p>' : rows.map(r=>`<div><b>${esc(handleOf(r.authorId))}</b>${esc(r.text)} <small class="muted">${ago(r.createdAt)}</small></div>`).join("");
  }, e=>console.warn(e));
}
$("#req-form").addEventListener("submit",e=>{ e.preventDefault(); if(!needMember()) return; const t=$("#req-text").value.trim(); if(!t) return; $("#req-text").value="";
  db.collection("requests").add({authorId:me,text:t,createdAt:Date.now()}).then(()=>toast("Sent to the station")).catch(err=>toast(err.message||err.code)); });
function mediaDuration(file){ return new Promise(res=>{
  const isVid=/^video\//.test(file.type)||/\.(mp4|mov|webm)$/i.test(file.name);
  const v=document.createElement(isVid?"video":"audio"); v.preload="metadata"; v.muted=true; const u=URL.createObjectURL(file); let done=false;
  const finish=d=>{ if(done) return; done=true; URL.revokeObjectURL(u); const est=/\.wav$/i.test(file.name)? file.size/176400 : file.size*8/192000; res(isFinite(d)&&d>0? d : est); };
  v.onloadedmetadata=()=>finish(v.duration); v.onerror=()=>finish(0); setTimeout(()=>finish(0),6000); v.src=u; try{ v.load(); }catch(_){} }); }
$("#up-audio").addEventListener("change",async e=>{
  const files=[...e.target.files]; e.target.value="";
  const st=$("#up-status"); if(!files.length){ st.textContent="No file was picked. On iPhone, the song must be saved in the Files app (Apple Music songs can't be uploaded)."; return; }
  if(!assets){ st.textContent="Only the owner can upload. Sign in with your owner account."; return; }
  const artist=$("#up-artist").value.trim()||"Meechie"; let done=0, failed=false;
  for(const f of files){
    const ext=(f.name.split(".").pop()||"").toLowerCase();
    if(f.size>50*1024*1024){ st.textContent=f.name+" is over 50 MB. Export it smaller (MP3 at 192 kbps works great)."; continue; }
    $("#up-status").textContent="Uploading "+f.name+"...";
    try{
      const duration=await mediaDuration(f);
      const TYPES={mp3:"audio/mpeg",wav:"audio/wav",m4a:"audio/mp4",aac:"audio/aac",ogg:"audio/ogg",oga:"audio/ogg",flac:"audio/flac",webm:"video/webm",mp4:"video/mp4",mov:"video/mp4"};
      const type = f.type || TYPES[ext] || "audio/mpeg";
      const up=await assets.upload(f,{type});
      await db.collection("tracks").add({title:f.name.replace(/\.[^.]+$/,"").replace(/[_-]+/g," "),artist,assetId:up.id,duration:Math.round(duration),cover:"",addedAt:Date.now()});
      done++;
    }catch(err){ const m=f.name+" didn't upload: "+(err.code==="unsupported_type"?"that file type isn't supported. Use MP3, WAV, M4A, MP4 or WebM.":(err.message||err.code||"unknown error")); toast(m); st.textContent=m; failed=true; }
  }
  if(failed && !done) return;
  $("#up-status").textContent= done ? `Added ${done} track${done>1?"s":""}. They're in the Library and on the radio rotation.` : "Upload MP3, WAV, M4A, AAC, OGG, MP4 or WebM files up to 50 MB each. Music videos play too. Only you see this.";
});

/* ---------- Gold Rush Arena ---------- */
const AW=960, AH=560, PR=16, SPEED=3.2, BSPEED=11, BLIFE=55, CYCLE=120000;
const WALLS=[[150,110,120,26],[690,110,120,26],[150,424,120,26],[690,424,120,26],[440,250,80,60],[300,230,26,100],[634,230,26,100],[60,260,60,40],[840,260,60,40]];
const gc=$("#g-canvas"), gx=gc.getContext("2d");
let GM={on:false, me:null, bullets:[], remote:new Map(), seenShots:new Set(), seenDeaths:{}, bots:[], keys:{}, aim:{x:AW/2,y:AH/2}, moveT:null, arena:null, myPeer:null, kills:0, total:0, last:0, fireCd:0, feed:[]};
function freeSpot(){ for(let i=0;i<60;i++){ const x=60+Math.random()*(AW-120), y=60+Math.random()*(AH-120); if(!hitWall(x,y,PR+6)) return {x,y}; } return {x:AW/2,y:80}; }
function hitWall(x,y,r){ return WALLS.some(([wx,wy,ww,wh])=>x+r>wx&&x-r<wx+ww&&y+r>wy&&y-r<wy+wh); }
function storm(){ const t=(Date.now()%CYCLE)/CYCLE; return {x:AW/2,y:AH/2,r:Math.max(150,560-t*1.2*410)}; }
function newMe(){ const p=freeSpot(); return {x:p.x,y:p.y,a:0,hp:100,dead:false,deaths:(GM.me?.deaths||0),killedBy:null,shots:[],look:{c:look.outfitColor,s:look.skin,t:look.trim||"#d4a843"},n:profileMe?.handle||"You",uid:me}; }
function spawnBots(){ GM.bots=[0,1,2].map(i=>{ const p=freeSpot(); return {id:"bot"+i,x:p.x,y:p.y,a:0,hp:100,dead:false,deaths:0,cd:0,tx:p.x,ty:p.y,n:["Ms. Baddie","Melody","Gold Bot"][i],look:{c:["#7a1f2b","#1f3d7a","#2f6b45"][i],s:["#c68a5e","#7a4a2b","#e0ac83"][i],t:"#d4a843"},respawn:0}; }); }
async function startGame(){
  $("#g-start").hidden=true; GM.on=true; GM.me=newMe(); GM.kills=0; GM.total=GM.total||0; updHud();
  const lobby=db?await claude.use("room"):null;
  if(lobby){ GM.arena=lobby.join("arena"); GM.arena.onPeers(ch=>{ const mine=ch.peers.find(p=>p.sameTab); if(mine) GM.myPeer=mine.peer; GM.peers=ch.peers; syncRemote(); }); }
  spawnBots(); GM.last=performance.now(); requestAnimationFrame(loop);
}
function syncRemote(){
  const live=new Set();
  (GM.peers||[]).forEach(p=>{ if(p.sameTab||p.kind==="agent") return; const g=p.presence?.g; if(!g) return; live.add(p.peer);
    let r=GM.remote.get(p.peer); if(!r){ r={rx:g.x,ry:g.y}; GM.remote.set(p.peer,r); } Object.assign(r,g,{peer:p.peer});
    (g.shots||[]).forEach(s=>{ const k=p.peer+":"+s.i; if(GM.seenShots.has(k)) return; GM.seenShots.add(k); if(Date.now()-s.t<1500) GM.bullets.push({x:s.x,y:s.y,dx:Math.cos(s.a)*BSPEED,dy:Math.sin(s.a)*BSPEED,life:BLIFE,from:p.peer,mine:false}); });
    const d=g.deaths||0; if(GM.seenDeaths[p.peer]===undefined) GM.seenDeaths[p.peer]=d;
    else if(d>GM.seenDeaths[p.peer]){ GM.seenDeaths[p.peer]=d; const killer=g.killedBy; if(killer && killer===GM.myPeer) creditKill(g.n||"a player"); else addFeed((killer&&GM.remote.get(killer)?.n)||"The storm", g.n||"a player"); }
  });
  for(const k of GM.remote.keys()) if(!live.has(k)) GM.remote.delete(k);
  $("#g-players").textContent = GM.remote.size ? (GM.remote.size+1)+" players live" : "Practice mode · bots";
}
function addFeed(a,b){ GM.feed.unshift(`<div><b>${esc(a)}</b> eliminated <b>${esc(b)}</b></div>`); GM.feed=GM.feed.slice(0,12); $("#g-feed").innerHTML=GM.feed.join(""); }
function creditKill(victim,isBot){ GM.kills++; GM.total++; addFeed(GM.me.n,victim); updHud(); toast("Eliminated "+victim);
  if(db && profileMe && !isBot) db.doc("scores/"+me).set({elims:GM.total,name:profileMe.handle,updatedAt:Date.now()}).catch(()=>{}); }
function updHud(){ $("#g-k").textContent=GM.kills; $("#g-hp").textContent=Math.max(0,Math.round(GM.me?.hp??100)); }
function shoot(){ const m=GM.me; if(!m||m.dead||GM.fireCd>0) return; GM.fireCd=12;
  const s={i:Math.random().toString(36).slice(2,8),x:m.x+Math.cos(m.a)*(PR+4),y:m.y+Math.sin(m.a)*(PR+4),a:m.a,t:Date.now()};
  GM.bullets.push({x:s.x,y:s.y,dx:Math.cos(s.a)*BSPEED,dy:Math.sin(s.a)*BSPEED,life:BLIFE,from:"me",mine:true}); m.shots=[...m.shots,s].slice(-6); }
function damageMe(n,by){ const m=GM.me; if(m.dead) return; m.hp-=n; if(m.hp<=0){ m.hp=0; m.dead=true; m.deaths++; m.killedBy=by; let t=3; $("#g-dead").hidden=false; $("#g-rs").textContent=t;
  const iv=setInterval(()=>{ t--; $("#g-rs").textContent=t; if(t<=0){ clearInterval(iv); const d=m.deaths; GM.me=newMe(); GM.me.deaths=d; $("#g-dead").hidden=true; updHud(); } },1000);
  if(by && String(by).startsWith("bot")) addFeed(GM.bots.find(b=>b.id===by)?.n||"Bot",m.n); if(!by) addFeed("The storm",m.n); } updHud(); }
function botAI(b,dt){
  if(b.dead){ if(Date.now()>b.respawn){ const p=freeSpot(); Object.assign(b,{x:p.x,y:p.y,hp:100,dead:false}); } return; }
  const tgt=GM.me&&!GM.me.dead?GM.me:null; const st=storm();
  if(Math.hypot(b.tx-b.x,b.ty-b.y)<10||Math.random()<.01){ const ang=Math.random()*Math.PI*2, rr=Math.random()*st.r*.7; b.tx=st.x+Math.cos(ang)*rr; b.ty=st.y+Math.sin(ang)*rr; }
  const dx=b.tx-b.x, dy=b.ty-b.y, d=Math.hypot(dx,dy)||1; const nx=b.x+dx/d*SPEED*.7, ny=b.y+dy/d*SPEED*.7;
  if(!hitWall(nx,ny,PR)){ b.x=nx; b.y=ny; } else { b.tx=b.x+(Math.random()-.5)*300; b.ty=b.y+(Math.random()-.5)*300; }
  if(tgt){ const ad=Math.hypot(tgt.x-b.x,tgt.y-b.y); b.a=Math.atan2(tgt.y-b.y,tgt.x-b.x)+(Math.random()-.5)*.25; b.cd-=1; if(ad<420&&b.cd<=0){ b.cd=40+Math.random()*40; GM.bullets.push({x:b.x+Math.cos(b.a)*20,y:b.y+Math.sin(b.a)*20,dx:Math.cos(b.a)*BSPEED*.8,dy:Math.sin(b.a)*BSPEED*.8,life:BLIFE,from:b.id,mine:false}); } }
  if(Math.hypot(b.x-st.x,b.y-st.y)>st.r) b.hp-=.08; if(b.hp<=0){ b.dead=true; b.respawn=Date.now()+3000; }
}
function loop(now){
  if(!GM.on) return; const dt=Math.min(3,(now-GM.last)/16.67); GM.last=now;
  const m=GM.me, st=storm();
  if(!$("#v-games").hidden){
    if(!m.dead){
      let vx=(GM.keys.d||GM.keys.arrowright?1:0)-(GM.keys.a||GM.keys.arrowleft?1:0), vy=(GM.keys.s||GM.keys.arrowdown?1:0)-(GM.keys.w||GM.keys.arrowup?1:0);
      if(GM.moveT){ const dx=GM.moveT.x-m.x, dy=GM.moveT.y-m.y, d=Math.hypot(dx,dy); if(d>8){ vx=dx/d; vy=dy/d; } }
      const l=Math.hypot(vx,vy)||1; const nx=m.x+vx/l*SPEED*dt, ny=m.y+vy/l*SPEED*dt;
      if(!hitWall(nx,m.y,PR)) m.x=Math.min(AW-PR,Math.max(PR,nx)); if(!hitWall(m.x,ny,PR)) m.y=Math.min(AH-PR,Math.max(PR,ny));
      m.a=Math.atan2(GM.aim.y-m.y,GM.aim.x-m.x);
      if(GM.keys[" "]||GM.mouseDown) shoot();
      if(Math.hypot(m.x-st.x,m.y-st.y)>st.r) damageMe(.09*dt,null);
    }
    GM.fireCd-=dt;
    const solo=GM.remote.size===0; if(solo) GM.bots.forEach(b=>botAI(b,dt));
    // bullets
    GM.bullets=GM.bullets.filter(b=>{ b.x+=b.dx*dt; b.y+=b.dy*dt; b.life-=dt; if(b.life<=0||hitWall(b.x,b.y,2)||b.x<0||b.y<0||b.x>AW||b.y>AH) return false;
      if(!b.mine && !m.dead && Math.hypot(b.x-m.x,b.y-m.y)<PR){ damageMe(20,b.from); return false; }
      if(b.mine){ if(solo) for(const bot of GM.bots){ if(!bot.dead && Math.hypot(b.x-bot.x,b.y-bot.y)<PR){ bot.hp-=20; if(bot.hp<=0){ bot.dead=true; bot.respawn=Date.now()+3000; creditKill(bot.n,true); } return false; } }
        for(const r of GM.remote.values()) if(!r.dead && Math.hypot(b.x-r.rx,b.y-r.ry)<PR) return false; }
      return true; });
    for(const r of GM.remote.values()){ r.rx+=(r.x-r.rx)*.35; r.ry+=(r.y-r.ry)*.35; }
    if(GM.arena){ GM.arena.presence({g:{x:Math.round(m.x),y:Math.round(m.y),a:+m.a.toFixed(2),hp:Math.round(m.hp),dead:m.dead,deaths:m.deaths,killedBy:m.killedBy,shots:m.shots,n:m.n,look:m.look}}).catch(()=>{}); }
    drawArena(st);
  }
  requestAnimationFrame(loop);
}
function drawPlayer(p,x,y,isMe){
  if(p.dead) return;
  gx.save(); gx.translate(x,y);
  gx.fillStyle="rgba(0,0,0,.4)"; gx.beginPath(); gx.ellipse(3,5,PR,PR*.8,0,0,7); gx.fill();
  gx.rotate(p.a||0); gx.fillStyle="#222"; gx.fillRect(PR-4,-3,16,6); gx.fillStyle=p.look?.t||"#d4a843"; gx.fillRect(PR+8,-3,4,6);
  gx.fillStyle=p.look?.c||"#111"; gx.beginPath(); gx.arc(0,0,PR,0,7); gx.fill(); gx.lineWidth=2.5; gx.strokeStyle=isMe?"#f0cf78":(p.look?.t||"#8c6d26"); gx.stroke();
  gx.fillStyle=p.look?.s||"#a26a43"; gx.beginPath(); gx.arc(3,0,8,0,7); gx.fill();
  gx.restore();
  gx.font="700 12px Hanken Grotesk, system-ui, sans-serif"; gx.textAlign="center"; gx.fillStyle=isMe?"#f0cf78":"#fff"; gx.fillText(isMe?"You":(p.n||"Player"),x,y-PR-14);
  gx.fillStyle="rgba(0,0,0,.6)"; gx.fillRect(x-18,y-PR-9,36,5); gx.fillStyle=p.hp>50?"#6fbf8b":p.hp>25?"#e5b44d":"#e5484d"; gx.fillRect(x-18,y-PR-9,36*Math.max(0,p.hp)/100,5);
}
function drawArena(st){
  // floor: masonic checker
  for(let y=0;y<AH;y+=40) for(let x=0;x<AW;x+=40){ gx.fillStyle=((x+y)/40)%2?"#14110b":"#1d1810"; gx.fillRect(x,y,40,40); }
  gx.strokeStyle="rgba(212,168,67,.25)"; gx.lineWidth=2; gx.strokeRect(20,20,AW-40,AH-40);
  // center emblem
  gx.save(); gx.globalAlpha=.18; gx.strokeStyle="#d4a843"; gx.lineWidth=3; gx.beginPath(); gx.moveTo(480,190); gx.lineTo(560,330); gx.lineTo(400,330); gx.closePath(); gx.stroke(); gx.restore();
  // walls
  WALLS.forEach(([x,y,w,h])=>{ gx.fillStyle="#0a0806"; gx.fillRect(x+4,y+6,w,h); const gr=gx.createLinearGradient(x,y,x,y+h); gr.addColorStop(0,"#3a2d14"); gr.addColorStop(1,"#241b0c"); gx.fillStyle=gr; gx.fillRect(x,y,w,h); gx.strokeStyle="#8c6d26"; gx.lineWidth=1.5; gx.strokeRect(x+.5,y+.5,w-1,h-1); });
  // storm
  gx.save(); gx.fillStyle="rgba(90,30,140,.38)"; gx.beginPath(); gx.rect(0,0,AW,AH); gx.arc(st.x,st.y,st.r,0,Math.PI*2,true); gx.fill("evenodd"); gx.strokeStyle="#f0cf78"; gx.lineWidth=3; gx.setLineDash([12,8]); gx.beginPath(); gx.arc(st.x,st.y,st.r,0,7); gx.stroke(); gx.restore();
  // bullets
  GM.bullets.forEach(b=>{ gx.strokeStyle=b.mine?"#fff3c9":"#ff8a8d"; gx.lineWidth=3; gx.beginPath(); gx.moveTo(b.x,b.y); gx.lineTo(b.x-b.dx*1.4,b.y-b.dy*1.4); gx.stroke(); });
  if(GM.remote.size===0) GM.bots.forEach(b=>drawPlayer(b,b.x,b.y,false));
  for(const r of GM.remote.values()) drawPlayer(r,r.rx,r.ry,false);
  drawPlayer(GM.me,GM.me.x,GM.me.y,true);
  const left=Math.ceil((CYCLE-(Date.now()%CYCLE))/1000); gx.font="700 14px Cinzel, Georgia, serif"; gx.fillStyle="#f0cf78"; gx.textAlign="left"; gx.fillText("STORM RESETS IN "+left+"s",28,46);
}
function toArena(e){ const r=gc.getBoundingClientRect(); return {x:(e.clientX-r.left)/r.width*AW,y:(e.clientY-r.top)/r.height*AH}; }
gc.addEventListener("mousemove",e=>{ GM.aim=toArena(e); });
gc.addEventListener("mousedown",e=>{ if(e.pointerType==="touch") return; GM.aim=toArena(e); GM.mouseDown=true; shoot(); });
window.addEventListener("mouseup",()=>GM.mouseDown=false);
gc.addEventListener("touchstart",e=>{ e.preventDefault(); GM.moveT=toArena(e.touches[0]); },{passive:false});
gc.addEventListener("touchmove",e=>{ e.preventDefault(); GM.moveT=toArena(e.touches[0]); },{passive:false});
gc.addEventListener("touchend",()=>{ GM.moveT=null; });
$("#g-fire").addEventListener("click",()=>{ const m=GM.me; if(!m) return; const targets=[...(GM.remote.size?[...GM.remote.values()].map(r=>({x:r.rx,y:r.ry,dead:r.dead})):GM.bots)].filter(t=>!t.dead);
  let best=null,bd=1e9; targets.forEach(t=>{ const d=Math.hypot(t.x-m.x,t.y-m.y); if(d<bd){bd=d;best=t;} }); if(best) GM.aim={x:best.x,y:best.y}; m.a=Math.atan2(GM.aim.y-m.y,GM.aim.x-m.x); shoot(); });
window.addEventListener("keydown",e=>{ if($("#v-games").hidden||!GM.on) return; if(e.target.matches("input,textarea,select")) return; const k=e.key.toLowerCase(); if(["w","a","s","d"," ","arrowup","arrowdown","arrowleft","arrowright"].includes(k)){ GM.keys[k]=true; e.preventDefault(); } });
window.addEventListener("keyup",e=>{ GM.keys[e.key.toLowerCase()]=false; });
$("#g-play").addEventListener("click",startGame);
(function idle(){ try{ GM.me=newMe(); spawnBots(); drawArena(storm()); }catch(_){ } })();
function subGames(){
  db.collection("scores").orderBy("elims","desc").limit(10).onSnapshot(s=>{ if(s.empty) return; $("#g-leaders").innerHTML=s.docs.map(d=>{ const v=d.data(); if(d.id===me) GM.total=Math.max(GM.total,(+v.elims)||0); return `<li>${esc(handleOf(d.id)!=="Member"?handleOf(d.id):(v.name||"Member"))} · <b>${(+v.elims)||0}</b></li>`; }).join(""); }, e=>console.warn(e));
  db.collection("squads").orderBy("createdAt","desc").limit(60).onSnapshot(s=>{ if(s.empty) return; $("#squads").innerHTML=s.docs.map(d=>{ const q=d.data();
    return `<div class="squad"><small>${esc(handleOf(q.authorId))} · ${ago(q.createdAt)}</small><span class="epic">${esc(q.epic)}</span><span class="badge">${esc(q.platform)}</span><b>${esc(q.mode)}</b>${q.note?`<small>${esc(q.note)}</small>`:""}<div class="fit-acts"><button class="btn sm ghost" type="button" data-epic="${esc(q.epic)}">Copy Epic name</button>${(q.authorId===me||isOwner)?`<button class="act" type="button" data-sqdel="${d.id}">Delete</button>`:""}</div></div>`; }).join(""); }, e=>console.warn(e));
}
$("#squads").addEventListener("click",e=>{ const b=e.target.closest("button"); if(!b) return;
  if(b.dataset.epic) navigator.clipboard?.writeText(b.dataset.epic).then(()=>toast("Copied "+b.dataset.epic+". Add them in Fortnite.")).catch(()=>toast(b.dataset.epic));
  if(b.dataset.sqdel){ if(!b.dataset.confirm){ b.dataset.confirm="1"; b.textContent="Tap again"; return; } db.doc("squads/"+b.dataset.sqdel).delete().catch(err=>toast(err.message||err.code)); } });
$("#sq-form").addEventListener("submit",async e=>{ e.preventDefault(); if(!needMember()) return;
  try{ await db.collection("squads").add({authorId:me,epic:$("#sq-epic").value.trim(),platform:$("#sq-plat").value,mode:$("#sq-mode").value,note:$("#sq-note").value.trim(),createdAt:Date.now()}); $("#sq-form").reset(); toast("Posted to the Squad Finder"); }
  catch(err){ toast(err.message||err.code); } });

/* ---------- Creators ---------- */

let wardrobe=[], designs=[], dSort="top", dsImg=null;
function subCreators(){
  db.collection("wardrobe").orderBy("createdAt","desc").limit(60).onSnapshot(s=>{ wardrobe=s.docs.map(d=>({id:d.id,...d.data()})); renderWardrobe(); }, e=>console.warn(e));
  db.collection("designs").orderBy("createdAt","desc").limit(120).onSnapshot(s=>{ designs=s.docs.map(d=>({id:d.id,...d.data()})); renderDesigns(); }, e=>console.warn(e));
}
function renderWardrobe(){
  if(!wardrobe.length) return;
  $("#wardrobe").innerHTML=wardrobe.map(w=>{ const liked=(w.likes||[]).includes(me);
    return `<div class="fit"><div class="fit-stage">${avatarSVG({...look,...w.fit,photo:false},"stand","")}</div><b>${esc(handleOf(w.authorId))}'s fit</b>
    <div class="fit-acts"><button class="btn sm" type="button" data-try="${w.id}">Try on</button><button class="act ${liked?"on":""}" type="button" data-wlike="${w.id}">♥ ${((w.likes||[]).length<(window.MW_SHOW_MIN||25)&&!isOwner)?"":(w.likes||[]).length||""}</button>${(w.authorId===me||isOwner)?`<button class="act" type="button" data-wdel="${w.id}">Delete</button>`:""}</div></div>`; }).join("");
}
$("#wardrobe").addEventListener("click",e=>{ const b=e.target.closest("button"); if(!b) return;
  if(b.dataset.try){ const w=wardrobe.find(x=>x.id===b.dataset.try); Object.assign(look,w.fit); drawBuilder(); setMine({look:{...look}}); try{localStorage.setItem("mw-look",JSON.stringify(look));}catch(_){} toast("You're wearing it. Head to the Virtual World."); }
  if(b.dataset.wlike){ if(!needMember()) return; const w=wardrobe.find(x=>x.id===b.dataset.wlike); const st=new Set(w.likes||[]); st.has(me)?st.delete(me):st.add(me); db.doc("wardrobe/"+w.id).update({likes:[...st]}).catch(err=>toast(err.message||err.code)); }
  if(b.dataset.wdel){ if(!b.dataset.confirm){ b.dataset.confirm="1"; b.textContent="Tap again"; return; } db.doc("wardrobe/"+b.dataset.wdel).delete().catch(err=>toast(err.message||err.code)); }
});
/* design canvas */
function garmentPath(ctx,kind){
  ctx.beginPath();
  if(kind==="hoodie"){ ctx.moveTo(150,70); ctx.quadraticCurveTo(240,10,330,70); ctx.lineTo(430,120); ctx.lineTo(470,330); ctx.lineTo(405,345); ctx.lineTo(380,200); ctx.lineTo(385,520); ctx.lineTo(95,520); ctx.lineTo(100,200); ctx.lineTo(75,345); ctx.lineTo(10,330); ctx.lineTo(50,120); ctx.closePath(); }
  else { ctx.moveTo(165,40); ctx.quadraticCurveTo(240,85,315,40); ctx.lineTo(440,90); ctx.lineTo(475,200); ctx.lineTo(395,225); ctx.lineTo(385,510); ctx.lineTo(95,510); ctx.lineTo(85,225); ctx.lineTo(5,200); ctx.lineTo(40,90); ctx.closePath(); }
}
function drawSymbol(ctx,kind,cx,cy,size,ink){
  ctx.save(); ctx.strokeStyle=ink; ctx.fillStyle=ink; ctx.lineWidth=Math.max(2,size/22); ctx.lineJoin="round"; ctx.lineCap="round";
  if(kind==="emblem"){ const h=size*.9; ctx.beginPath(); ctx.moveTo(cx,cy-h/2); ctx.lineTo(cx+h*.58,cy+h/2); ctx.lineTo(cx-h*.58,cy+h/2); ctx.closePath(); ctx.stroke();
    ctx.beginPath(); ctx.ellipse(cx,cy+h*.12,h*.24,h*.12,0,0,Math.PI*2); ctx.stroke(); ctx.beginPath(); ctx.arc(cx,cy+h*.12,h*.07,0,Math.PI*2); ctx.fill();
    for(let i=-2;i<=2;i++){ const a=-Math.PI/2+i*.35; ctx.beginPath(); ctx.moveTo(cx+Math.cos(a)*h*.62,cy-h*.1+Math.sin(a)*h*.62); ctx.lineTo(cx+Math.cos(a)*h*.8,cy-h*.1+Math.sin(a)*h*.8); ctx.stroke(); } }
  if(kind==="compass"){ const h=size; ctx.beginPath(); ctx.arc(cx,cy-h*.42,h*.06,0,Math.PI*2); ctx.stroke(); ctx.beginPath(); ctx.moveTo(cx-h*.03,cy-h*.37); ctx.lineTo(cx-h*.3,cy+h*.4); ctx.moveTo(cx+h*.03,cy-h*.37); ctx.lineTo(cx+h*.3,cy+h*.4); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(cx-h*.42,cy+h*.12); ctx.lineTo(cx,cy+h*.48); ctx.lineTo(cx+h*.42,cy+h*.12); ctx.stroke(); }
  ctx.restore();
}
function renderDesigns(){
  if(!designs.length) return;
  const list=[...designs].sort((a,b)=> (b.selected?1:0)-(a.selected?1:0) || (dSort==="top" ? (b.votes||[]).length-(a.votes||[]).length : b.createdAt-a.createdAt));
  $("#designs").innerHTML=list.map(d=>{ const v=(d.votes||[]).includes(me);
    return `<article class="design ${d.selected?"picked":""}"><img src="${esc(d.img)}" data-front="${esc(d.img)}" ${d.img2?`data-back="${esc(d.img2)}"`:""} alt="${esc(d.title)}">${d.selected?'<span class="badge pick">Selected for the store</span>':""}
    <div class="dz"><b>${esc(d.title)}</b><small class="muted">by ${esc(handleOf(d.authorId))}</small>${d.note?`<small class="muted">${esc(d.note)}</small>`:""}
    <div class="fit-acts">${d.img2?`<button class="act" type="button" data-flip="${d.id}">Flip</button>`:""}${/^data:image\/(png|jpe?g|webp);base64,[A-Za-z0-9+/=]+$/.test(d.art||"")&&(d.authorId===me||isOwner)?`<a class="act" download="${esc(d.title)}" href="${esc(d.art)}">Art file</a>`:""}<button class="btn sm ${v?"":"ghost"}" type="button" data-vote="${d.id}">🔥 ${(d.votes||[]).length}</button>${isOwner?`<button class="act" type="button" data-pick="${d.id}">${d.selected?"Unselect":"Select for store"}</button>`:""}${(d.authorId===me||isOwner)?`<button class="act" type="button" data-ddel="${d.id}">Delete</button>`:""}</div></div></article>`; }).join("");
}
$("#dg-sort").addEventListener("click",e=>{ const b=e.target.closest("[data-sort]"); if(!b) return; dSort=b.dataset.sort; $$("#dg-sort .chip").forEach(x=>x.setAttribute("aria-pressed",x===b)); renderDesigns(); });
$("#designs").addEventListener("click",e=>{ const b=e.target.closest("button"); if(!b) return;
  if(b.dataset.flip){ const im=b.closest(".design").querySelector("img"); const back=im.dataset.back; im.src = im.src===back ? im.dataset.front : back; return; }
  if(b.dataset.vote){ if(!needMember()) return; const d=designs.find(x=>x.id===b.dataset.vote); const st=new Set(d.votes||[]); st.has(me)?st.delete(me):st.add(me); db.doc("designs/"+d.id).update({votes:[...st]}).catch(err=>toast(err.message||err.code)); }
  if(b.dataset.pick){ const d=designs.find(x=>x.id===b.dataset.pick); db.doc("designs/"+d.id).update({selected:!d.selected}).then(()=>toast(d.selected?"Unselected":"Selected for the store")).catch(err=>toast(err.message||err.code)); }
  if(b.dataset.ddel){ if(!b.dataset.confirm){ b.dataset.confirm="1"; b.textContent="Tap again"; return; } db.doc("designs/"+b.dataset.ddel).delete().catch(err=>toast(err.message||err.code)); }
});
$("#team-form").addEventListener("submit",e=>{ e.preventDefault();
  const msg=`Meechie's World team application\nName: ${$("#tm-name").value.trim()}\nRole: ${$("#tm-role").value}\nReach me: ${$("#tm-contact").value.trim()}\nWork: ${$("#tm-link").value.trim()||"none"}\nMy idea: ${$("#tm-idea").value.trim()}`;
  $("#team-msg").textContent=msg; $("#team-ready").hidden=false;
  navigator.clipboard?.writeText(msg).then(()=>toast("Copied. Paste it in a DM to us.")).catch(()=>{ const r=document.createRange(); r.selectNodeContents($("#team-msg")); getSelection().removeAllRanges(); getSelection().addRange(r); toast("Selected. Copy it and DM us."); });
  $("#team-ready").scrollIntoView({behavior:"smooth",block:"center"});
});

/* ---------- AI assistant ---------- */

let aiHist=[], aiBusy=false;
function aiDraw(){ $("#ai-log").innerHTML = aiHist.length ? aiHist.map(m=>`<div class="msg ${m.role==="user"?"mine":""}">${esc(m.content)}</div>`).join("") : '<div class="msg">Hi, I\'m Meechie\'s AI. What can I help you with today?</div>'; const l=$("#ai-log"); l.scrollTop=l.scrollHeight; }
aiDraw();
$("#ai-form").addEventListener("submit",async e=>{
  e.preventDefault(); if(aiBusy) return; const q=$("#ai-q").value.trim(); if(!q) return;
  if(!me){ openAuth("signup"); toast("Join free to chat with Meechie, our AI assistant."); return; }
  $("#ai-q").value=""; aiHist.push({role:"user",content:q}); const ans={role:"assistant",content:"Thinking..."}; aiHist.push(ans); aiDraw(); aiBusy=true;
  try{
    const tok=window.MW?.session?.()?.access_token;
    const r=await fetch("/api/ai",{method:"POST",headers:{"content-type":"application/json",authorization:"Bearer "+tok},body:JSON.stringify({messages:aiHist.slice(0,-1).slice(-16)})});
    const j=await r.json().catch(()=>({}));
    if(!r.ok||!j.reply) throw Object.assign(new Error(j.error||"fail"),{code:j.error});
    ans.content=j.reply+(j.sources&&j.sources.length?"\n\nSources: "+j.sources.map((x,i)=>"["+(i+1)+"] "+x.title+" — "+x.url).join("\n"):"");
  }catch(err){ ans.content = err.code==="busy" ? "I'm getting a lot of questions right now. Try again in a minute, or DM @meechiesworldinc on TikTok." : "I can't answer right now. DM @meechiesworldinc on TikTok or email meechiesworldinc@aol.com."; }
  aiBusy=false; aiDraw();
});
function needMember(){ if(!db){toast("The site is still being set up.");return false;} if(!me){openAuth("signup");return false;} if(!profileMe){go("community");toast("Join free first. Pick a handle.");return false;} return true; }

/* Join */
$("#join-form").addEventListener("submit",async e=>{
  e.preventDefault(); if(!db) return;
  const handle=$("#j-handle").value.trim(); if(!handle) return;
  try{ const meta=window.MW?.session?.()?.user?.user_metadata||{}; const ph=meta.avatar_url||meta.picture; await db.collection("members").doc(me).set({handle, bio:$("#j-bio").value.trim(), joinedAt:Date.now(), ...(ph&&/^https:\/\//.test(ph)?{photo:ph}:{})}); toast("Welcome to Meechie's World, "+handle); }
  catch(err){ toast("Couldn't join: "+(err.message||err.code)); }
});

/* Feed */
let posts=[], openReplies=new Set(), replyCache={}, replySubs={};
function subFeed(){ db.collection("posts").orderBy("createdAt","desc").limit(100).onSnapshot(s=>{posts=s.docs.map(d=>({id:d.id,...d.data()}));renderFeed();renderAnnouncement();document.dispatchEvent(new Event("mw-posts"));}, e=>console.warn(e)); }
let pendingPhoto=null, pendingVideo=null;
function pickVideo(f,info,wrap){ if(!f) return null; if(f.size>MW.VIDEO_MAX){ toast("Big video: it will be shrunk to 720p before posting."); } $(info).textContent=f.name+" · "+(f.size/1048576).toFixed(1)+" MB"; $(wrap).hidden=false; return f; }
$("#p-video").addEventListener("change",e=>{ const f=e.target.files[0]; e.target.value=""; pendingVideo=pickVideo(f,"#p-vinfo","#p-vwrap"); if(pendingVideo){ const v=$("#p-vprev"); try{ URL.revokeObjectURL(v.src); }catch(_){} v.src=URL.createObjectURL(pendingVideo); $("#p-vbar").style.width="0"; } });
$("#p-vclear").addEventListener("click",()=>{ pendingVideo=null; const v=$("#p-vprev"); try{ URL.revokeObjectURL(v.src); }catch(_){} v.removeAttribute("src"); $("#p-vwrap").hidden=true; });
$("#p-photo").addEventListener("change",async e=>{const f=e.target.files[0]; if(!f) return; try{pendingPhoto=await compress(f); $("#p-preview").src=pendingPhoto; $("#p-preview").hidden=false;}catch(err){toast(err.message);} });
$("#p-post").addEventListener("click",async()=>{
  if(!needMember()) return;
  const text=$("#p-text").value.trim(); if(!text && !pendingPhoto && !pendingVideo){toast("Write something or add a photo or video.");return;}
  const b=$("#p-post"); b.disabled=true;
  const announce = isOwner && $("#p-announce").checked;
  let vid=null;
  try{
    if(pendingVideo){ b.textContent="Uploading 0%"; vid=await MW.uploadVideo(pendingVideo,f=>{ const n=Math.round(f*100); b.textContent="Uploading "+n+"%"; $("#p-vbar").style.width=n+"%"; }); b.textContent="Posting..."; }
    await db.collection("posts").add({authorId:me,text,photo:pendingPhoto||"",...(vid?{video:vid.url,videoPath:vid.path}:{}),likes:[],replyCount:0,sponsored:announce,announce,createdAt:Date.now()});
    $("#p-text").value=""; $("#p-announce").checked=false; try{localStorage.removeItem("mw-dismissed");}catch(e){} pendingPhoto=null; $("#p-preview").hidden=true; $("#p-photo").value=""; $("#p-vclear").click(); toast("Posted"); }
  catch(err){ if(vid) MW.deleteVideo(vid.path); toast("Couldn't post: "+(err.message||err.code)); }
  b.disabled=false; b.textContent="Post";
});
const postEls=new Map();
function renderFeed(){
  const feed=$("#feed");
  const F=window.MW_FOLLOWING||new Set();
  const rank=p=>(p.announce?4:0)+(p.sponsored?2:0)+(F.has(p.authorId)?1:0); // announcements, promoted, then people you follow, then everyone
  const list=[...posts].sort((a,b)=>rank(b)-rank(a)||(b.createdAt||0)-(a.createdAt||0));
  $("#feed-empty").hidden = list.length>0;
  const keep=new Set(list.map(p=>p.id));
  for(const [id,el] of postEls) if(!keep.has(id)){ el.remove(); postEls.delete(id); }
  let prev=null;
  // 🔥 Trending: the 3 posts from the last 7 days with the most real likes and comments
  const wk=Date.now()-7*864e5, sc=p=>(p.likes||[]).length+2*(+p.replyCount||0);
  const trend=new Set(posts.filter(p=>(p.createdAt||0)>wk&&sc(p)>=3).sort((a,b)=>sc(b)-sc(a)).slice(0,3).map(p=>p.id));
  list.forEach(p=>{
    const liked=(p.likes||[]).includes(me);
    const lc=(p.likes||[]).length, showLc=lc&&(lc>=(window.MW_SHOW_MIN||25)||isOwner); // small counts stay hidden until they're worth showing
    const shop=shopLinks(members[p.authorId]||{})[0];
    let el=postEls.get(p.id);
    if(!el){ el=document.createElement("article"); el.innerHTML='<div class="post-body"></div><div class="post-actions"></div><div class="replies" hidden></div>'; el.querySelector(".replies").dataset.rbox=p.id; postEls.set(p.id,el); }
    el.className="post"+(p.announce?" announcement":p.sponsored?" sponsored":"");
    // Only rebuild the top part (text, photo, video) when it really changed, so a playing video keeps playing.
    const bodySig=JSON.stringify([p.text,p.photo,p.video,p.tt,p.announce,p.sponsored,handleOf(p.authorId),(members[p.authorId]||{}).photo,shop&&shop[1],me,F.has(p.authorId)]);
    if(el._sig!==bodySig){ el._sig=bodySig; el.querySelector(".post-body").innerHTML=`<div class="post-head">${avatarOf(p.authorId)}<div class="who"><b>${esc(handleOf(p.authorId))}</b><small>${ago(p.createdAt)} · 🌐</small></div>${p.authorId&&p.authorId!==me&&!p.announce?`<button class="btn sm fl-btn ${F.has(p.authorId)?"on":""}" type="button" data-follow="${esc(p.authorId)}" style="margin-left:auto">${F.has(p.authorId)?"Following":"＋ Follow"}</button><button class="act" type="button" data-dm="${esc(p.authorId)}">Message</button>`:""}${p.announce?'<span class="badge" style="margin-left:auto">From Meechie · Everyone</span>':p.sponsored?'<span class="badge" style="margin-left:auto">Promoted</span>':''}${shop&&!p.sponsored?`<a class="shop-link" href="${esc(safeUrl(shop[1]))}" target="_blank" rel="noopener">Shop</a>`:""}</div>
      ${p.text?`<p class="post-text${!p.photo&&!p.video&&!/^\d{8,25}$/.test(p.tt||"")&&!p.audio&&p.text.length<=120?" big":""}">${esc(p.text)}</p>`:""}
      ${/^data:image\//.test(p.photo||"")||/^https:\/\//.test(p.photo||"")?`<img class="photo" src="${esc(p.photo)}" alt="Photo from ${esc(handleOf(p.authorId))}" loading="lazy">`:""}
      ${/^https:\/\//.test(p.video||"")?`<video class="vid" src="${esc(p.video)}#t=0.1" controls playsinline preload="metadata"></video>`:""}${/^\d{8,25}$/.test(p.tt||"")?`<div class="ttwrap"><iframe class="ttvid" src="https://www.tiktok.com/player/v1/${esc(p.tt)}?rel=0&description=1&music_info=1" title="TikTok video" loading="lazy" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share; fullscreen" allowfullscreen referrerpolicy="strict-origin-when-cross-origin"></iframe></div>`:""}
      ${/^https:\/\//.test(p.audio||"")?`<audio class="aud" src="${esc(p.audio)}" controls preload="none" style="width:100%;margin-top:8px"></audio>`:""}`; }
    const ws=el.querySelector(".who small"); if(ws) ws.textContent=ago(p.createdAt)+" · 🌐";
    el.querySelector(".post-actions").innerHTML=`
        ${trend.has(p.id)?`<span class="trend-badge">🔥 Trending</span>`:""}
        <button class="act ${liked?"on":""}" data-like="${esc(p.id)}">👍 ${showLc?lc:""} Like</button>
        <button class="act" data-replies="${esc(p.id)}">💬 ${(+p.replyCount)>=3||isOwner?(+p.replyCount):""} Comment</button>
        <button class="act" data-share="${esc(p.id)}">↗ Share</button>
        ${p.authorId!==me?`<button class="act" data-giftto="${esc(p.authorId)}">🎁 Gift</button>`:""}
        ${isOwner?`<button class="act" data-sponsor="${esc(p.id)}">${p.sponsored?"Unpin":"Pin as promoted"}</button>`:""}
        ${(p.authorId===me||isOwner)?`<button class="act" data-del="${esc(p.id)}">Delete</button>`:""}`;
    const rb=el.querySelector(".replies"), open=openReplies.has(p.id); if(rb.hidden===open){ rb.hidden=!open; if(open) drawReplies(p.id); }
    const want=prev?prev.nextSibling:feed.querySelector(".post"); if(el!==want) (prev? prev.after(el) : (feed.querySelector(".post")? feed.querySelector(".post").before(el) : feed.appendChild(el)));
    prev=el;
  });
}
$("#feed").addEventListener("click",async e=>{
  const t=e.target.closest("button"); if(!t) return;
  if(t.dataset.like){ if(!needMember())return; const p=posts.find(x=>x.id===t.dataset.like); const s=new Set(p.likes||[]); s.has(me)?s.delete(me):s.add(me);
    db.doc("posts/"+p.id).update({likes:[...s]}).catch(err=>toast(err.message||err.code)); }
  if(t.dataset.share){ window.MW_share && MW_share((posts.find(x=>x.id===t.dataset.share)||{}).text||"", "#community"); return; }
  if(t.dataset.giftto){ openGift(t.dataset.giftto); return; }
  if(t.dataset.replies){ const id=t.dataset.replies; if(openReplies.has(id)) openReplies.delete(id); else { openReplies.add(id); subReplies(id);} renderFeed(); }
  if(t.dataset.sponsor){ const p=posts.find(x=>x.id===t.dataset.sponsor); db.doc("posts/"+p.id).update({sponsored:!p.sponsored}).catch(err=>toast(err.message||err.code)); }
  if(t.dataset.del){ if(t.dataset.confirm){ const pd=posts.find(x=>x.id===t.dataset.del)||{}, vp=pd.videoPath, ap=pd.audioPath; db.doc("posts/"+t.dataset.del).delete().then(()=>{ if(vp) MW.deleteVideo(vp); if(ap) MW.deleteVideo(ap); toast("Deleted"); }).catch(err=>toast(err.message||err.code)); } else { t.dataset.confirm="1"; t.textContent="Tap again to delete"; } }
});
function subReplies(id){ if(replySubs[id]) return; replySubs[id]=db.collection("posts/"+id+"/replies").orderBy("createdAt","asc").limit(200).onSnapshot(s=>{replyCache[id]=s.docs.map(d=>d.data()); drawReplies(id);}, e=>console.warn(e)); }
function drawReplies(id){
  const box=document.querySelector(`[data-rbox="${id}"]`); if(!box) return;
  // only the list is redrawn, so someone else's new comment doesn't close your keyboard mid-typing
  let list=box.querySelector(".r-list");
  if(!list){ box.innerHTML=`<div class="r-list"></div><form class="reply-form" data-rform="${id}">${me?avatarOf(me):'<span class="avatar">👤</span>'}<label class="r-pic" title="Add a picture" aria-label="Add a picture">📷<input type="file" accept="image/*" hidden></label><input type="text" id="r-${id}" maxlength="500" placeholder="Write a comment"><button class="btn sm" type="submit">Reply</button></form><div class="r-prev" hidden></div>`; list=box.querySelector(".r-list"); }
  list.innerHTML=(replyCache[id]||[]).map(r=>`<div class="reply">${avatarOf(r.authorId)}<div class="r-main"><div class="r-bub"><b>${esc(handleOf(r.authorId))}</b><span>${esc(r.text||"")}</span>${/^https:\/\//.test(r.photo||"")?`<img class="r-img" src="${esc(r.photo)}" alt="" loading="lazy">`:""}</div><small class="r-time">${ago(r.createdAt)}</small></div></div>`).join("");
}
$("#feed").addEventListener("submit",async e=>{
  const f=e.target.closest("[data-rform]"); if(!f) return; e.preventDefault(); if(!needMember()) return;
  const id=f.dataset.rform, inp=f.querySelector('input[type="text"]'), text=inp.value.trim(), photo=f._photo||""; if(!text&&!photo) return; inp.value=""; f._photo=""; const pv=f.nextElementSibling; if(pv&&pv.classList.contains("r-prev")){ pv.hidden=true; pv.innerHTML=""; }
  try{ const r={authorId:me,text,createdAt:Date.now()}; if(photo) r.photo=photo; await db.collection("posts/"+id+"/replies").add(r);
    const p=posts.find(x=>x.id===id); db.doc("posts/"+id).update({replyCount:(p?.replyCount||0)+1}).catch(()=>{}); }
  catch(err){ toast(err.message||err.code); }
});

/* pictures in comments: tap 📷, pick a photo, it uploads, then Reply */
$("#feed").addEventListener("change",async e=>{
  const inp=e.target; if(!inp.matches('.r-pic input[type="file"]')) return; const f=inp.closest("[data-rform]"), file=inp.files&&inp.files[0]; inp.value=""; if(!f||!file) return; if(!needMember()) return;
  const pv=f.nextElementSibling; pv.hidden=false; pv.innerHTML='<span class="muted">Adding your picture…</span>';
  try{ const small=await compress(file,1280); const blob=await (await fetch(small)).blob(); const up=await MW.uploadMedia(blob,{type:"image/jpeg",ext:"jpg"}); if(!up||!/^https:\/\//.test(up.url)) throw new Error("upload failed");
    f._photo=up.url; pv.innerHTML=`<img src="${esc(up.url)}" alt=""><button type="button" class="act" data-rpx>✕ Remove</button>`; f.querySelector('input[type="text"]').focus(); }
  catch(err){ pv.innerHTML=""; pv.hidden=true; toast("Couldn't add the picture: "+(err.message||err)); }
});
$("#feed").addEventListener("click",e=>{ const x=e.target.closest("[data-rpx]"); if(!x) return; const pv=x.closest(".r-prev"), f=pv.previousElementSibling; if(f) f._photo=""; pv.hidden=true; pv.innerHTML=""; });

/* Chat + walkie */
let channel="lounge", chUnsub=null, msgs=[], room=null;
function subChannel(ch){ chUnsub?.(); channel=ch; msgs=[]; renderMsgs();
  $("#ch-name").textContent = ch==="walkie" ? "📻 walkie-talkie" : "# "+ch;
  chUnsub=db.collection("chat/"+ch+"/msgs").orderBy("createdAt","desc").limit(80).onSnapshot(s=>{msgs=s.docs.map(d=>d.data()).reverse(); renderMsgs();}, e=>console.warn(e));
  room?.presence({channel:ch}); updOnline();
}
function updOnline(){ /* people counts have ONE source: the keeper ping in dj.js (paintOnline) paints the header chip, booth, station card and #listeners from the same answer, so no two surfaces can disagree. The room-peers number below only ever described this chat channel, so it is labelled as exactly that and feeds nothing site-wide. */
  const n=(room?.peers?.()||[]).filter(p=>p.kind!=="agent" && p.presence?.channel===channel).length; $("#online").textContent="● "+Math.max(n, db?1:0)+" in this chat"; }
function renderMsgs(){
  const box=$("#msgs"); if(!box) return;
  if(!msgs.length){ box.innerHTML='<div class="empty" style="border:0">No messages yet. Say hello.</div>'; return; }
  box.innerHTML=msgs.map(m=>`<div class="msg ${m.authorId===me?"mine":""}"><small>${esc(handleOf(m.authorId))} · ${ago(m.createdAt)}</small>${m.text?esc(m.text):""}${/^https:\/\//.test(m.photo||"")?`<img src="${esc(m.photo)}" alt="" loading="lazy" style="display:block;max-width:240px;max-height:300px;border-radius:12px;margin-top:4px;object-fit:cover">`:""}${m.audio?`<audio controls preload="none" src="${esc(m.audio)}"></audio>`:""}</div>`).join("");
  box.scrollTop=box.scrollHeight;
}
$("#channels").addEventListener("click",e=>{const b=e.target.closest("[data-ch]"); if(!b||!db) return; $$("#channels [data-ch]").forEach(x=>x.setAttribute("aria-pressed",x===b)); subChannel(b.dataset.ch);});
$("#chat-form").addEventListener("submit",async e=>{
  e.preventDefault(); if(!needMember()) return;
  const t=$("#chat-text").value.trim(); if(!t) return; $("#chat-text").value="";
  db.collection("chat/"+channel+"/msgs").add({authorId:me,text:t,createdAt:Date.now()}).catch(err=>toast(err.message||err.code));
});
$("#chat-pic").addEventListener("change",async e=>{
  const f=e.target.files[0]; e.target.value=""; if(!f||!needMember()) return; toast("Sending your picture…");
  try{ const small=await compress(f,1280); const up=await MW.uploadMedia(await (await fetch(small)).blob(),{type:"image/jpeg",ext:"jpg"}); if(!up||!/^https:\/\//.test(up.url)) throw new Error("upload failed");
    await db.collection("chat/"+channel+"/msgs").add({authorId:me,text:$("#chat-text").value.trim(),photo:up.url,createdAt:Date.now()}); $("#chat-text").value=""; }
  catch(err){ toast("Couldn't send the picture: "+(err.message||err)); }
});
$("#voice").addEventListener("change",async e=>{
  const f=e.target.files[0]; e.target.value=""; if(!f||!needMember()) return;
  if(f.size>190000){ toast("Clip too long. Keep it under about 15 seconds."); return; }
  try{ const audio=await readFile(f); await db.collection("chat/"+channel+"/msgs").add({authorId:me,audio,createdAt:Date.now()}); toast("Voice clip sent"); }
  catch(err){ toast(err.message||err.code); }
});
async function joinRoom(){
  room=await claude.use("room"); if(!room) return;
  room.presence({channel});
  room.onPeers(()=>updOnline());
}

/* Ads */
let ads=[], adCat="all", pendingAdPhoto="", pendingAdVideo=null;
function subAds(){ db.collection("ads").orderBy("createdAt","desc").limit(200).onSnapshot(s=>{ads=s.docs.map(d=>({id:d.id,...d.data()}));renderAds();}, e=>console.warn(e)); }
function renderAds(){
  const list=ads.filter(a=>adCat==="all"||a.cat===adCat).sort((a,b)=>(b.sponsored?1:0)-(a.sponsored?1:0));
  $("#ads-empty").hidden=list.length>0;
  $("#ads").innerHTML=list.map(a=>`<article class="ad ${a.sponsored?"sponsored":""}">${/^https:\/\//.test(a.video||"")?`<video src="${esc(a.video)}#t=0.1" controls playsinline preload="metadata"${a.photo?` poster="${esc(a.photo)}"`:""}></video>`:a.photo?`<img src="${esc(a.photo)}" alt="">`:""}
    <div class="body"><span class="cat">${esc(a.cat)}${a.sponsored?' · <span class="badge">Promoted</span>':''}</span><h3>${esc(a.title)}</h3><p>${esc(a.desc)}</p></div>
    <div class="foot"><span class="muted">${esc(a.contact)}</span><span style="display:flex;gap:4px">${isOwner?`<button class="act" data-asp="${a.id}">${a.sponsored?"Unpromote":"Promote"}</button>`:""}${(a.authorId===me||isOwner)?`<button class="act" data-adel="${a.id}">Delete</button>`:""}</span></div></article>`).join("");
}
$("#ad-filters").addEventListener("click",e=>{const c=e.target.closest("[data-cat]"); if(!c) return; adCat=c.dataset.cat; $$("#ad-filters .chip").forEach(x=>x.setAttribute("aria-pressed",x===c)); renderAds();});
$("#ads").addEventListener("click",e=>{const t=e.target.closest("button"); if(!t) return;
  if(t.dataset.asp){const a=ads.find(x=>x.id===t.dataset.asp); db.doc("ads/"+a.id).update({sponsored:!a.sponsored}).catch(err=>toast(err.message||err.code));}
  if(t.dataset.adel){ if(t.dataset.confirm){ const vp=(ads.find(x=>x.id===t.dataset.adel)||{}).videoPath; db.doc("ads/"+t.dataset.adel).delete().then(()=>{ if(vp) MW.deleteVideo(vp); }); } else {t.dataset.confirm="1"; t.textContent="Tap again";} }
});
$("#new-ad").addEventListener("click",()=>{ if(needMember()) $("#ad-dialog").showModal(); });
$("#ad-cancel").addEventListener("click",()=>$("#ad-dialog").close());
$("#a-photo").addEventListener("change",async e=>{const f=e.target.files[0]; if(f){ try{pendingAdPhoto=await compress(f,900);}catch(err){toast(err.message);} }});
$("#a-video").addEventListener("change",e=>{ pendingAdVideo=pickVideo(e.target.files[0],"#a-vinfo","#a-vwrap"); if(!pendingAdVideo) e.target.value=""; $("#a-vbar").style.width="0"; });
$("#ad-form").addEventListener("submit",async e=>{
  e.preventDefault();
  const b=$("#ad-form button[type=submit]"); if(b.disabled) return; b.disabled=true; let vid=null;
  try{
    if(pendingAdVideo){ b.textContent="Uploading 0%"; vid=await MW.uploadVideo(pendingAdVideo,f=>{ const n=Math.round(f*100); b.textContent="Uploading "+n+"%"; $("#a-vbar").style.width=n+"%"; }); b.textContent="Posting..."; }
    await db.collection("ads").add({authorId:me,title:$("#a-title").value.trim(),cat:$("#a-cat").value,desc:$("#a-desc").value.trim(),contact:$("#a-contact").value.trim(),photo:pendingAdPhoto,...(vid?{video:vid.url,videoPath:vid.path}:{}),sponsored:false,createdAt:Date.now()});
    $("#ad-form").reset(); pendingAdPhoto=""; pendingAdVideo=null; $("#a-vwrap").hidden=true; $("#ad-dialog").close(); toast("Your ad is live"); }
  catch(err){ if(vid) MW.deleteVideo(vid.path); toast("Couldn't post ad: "+(err.message||err.code)); }
  b.disabled=false; b.textContent="Post ad";
});

/* Campaigns */
$$("[data-tier]").forEach(b=>b.addEventListener("click",()=>{ $("#c-tier").value=b.dataset.tier; $("#c-biz").focus(); }));
$("#camp-form").addEventListener("submit",async e=>{
  e.preventDefault();
  const msg=`Campaign request: ${$("#c-tier").value}\nBusiness: ${$("#c-biz").value.trim()}\nReach me: ${$("#c-contact").value.trim()}\nLink: ${$("#c-link").value.trim()||"none"}\nPromote: ${$("#c-goal").value.trim()}`;
  $("#inbox").textContent=msg; $("#owner-inbox").hidden=false;
  navigator.clipboard?.writeText(msg).then(()=>toast("Copied. Paste it in a DM to us.")).catch(()=>{const r=document.createRange();r.selectNodeContents($("#inbox"));getSelection().removeAllRanges();getSelection().addRange(r);toast("Selected. Copy it and DM us.");});
});
function subInbox(){}


/* ---------- Accounts ---------- */
let authMode="signup";
function openAuth(mode){ authMode=mode||"signup"; paintAuth(); $("#auth-msg").textContent=""; $("#auth-dialog").showModal(); }
function paintAuth(){ const up=authMode==="signup"; $("#auth-title").textContent=up?"Join Meechie's World":"Welcome back"; $("#auth-sub").textContent=up?"Free forever. Post, chat, play, and design.":"Sign in to your account."; $("#auth-go").textContent=up?"Create my account":"Sign in"; $("#auth-switch").textContent=up?"I already have an account":"I need an account"; $("#auth-pass").autocomplete=up?"new-password":"current-password"; }
document.addEventListener("click",e=>{ const b=e.target.closest("[data-auth]"); if(!b) return; e.preventDefault(); if(b.dataset.auth==="signout"){ window.MW?.signOut?.(); return; } openAuth(b.dataset.auth); });
{ let ownerDev=false; try{ ownerDev=localStorage.getItem("mw_owner_device")==="1"; }catch(_){} if(window.MW_CONFIG?.FACEBOOK_LOGIN && (window.MW_CONFIG?.FACEBOOK_PUBLIC || ownerDev)) $("#auth-social").hidden=false; }
$("#auth-fb").addEventListener("click",async()=>{ if(!window.MW?.ready) return; $("#auth-msg").textContent="Opening Facebook...";
  const r=await MW.sb.auth.signInWithOAuth({provider:"facebook",options:{redirectTo:location.origin+"/",scopes:"email public_profile"}});
  if(r.error) $("#auth-msg").textContent=r.error.message; });
$("#auth-switch").addEventListener("click",()=>{ authMode=authMode==="signup"?"signin":"signup"; paintAuth(); });
/* ---------- Members-only gate ---------- */
(function(){
  const g=$("#gate"); if(!g) return;
  let up=true;
  const paint=()=>{ $("#gt-name-f").hidden=!up; $("#gt-name").required=up; $("#gt-pass").autocomplete=up?"new-password":"current-password";
    $("#gt-title").textContent=up?"Members only":"Welcome back"; $("#gt-sub").textContent=up?"Create your free account to enter Meechie's World.":"Sign in to enter Meechie's World.";
    $("#gt-go").textContent=up?"Create my account & enter":"Sign in & enter"; $("#gt-switch").textContent=up?"I already have an account":"I'm new here"; $("#gt-msg").textContent=""; };
  paint();
  $("#gt-switch").addEventListener("click",()=>{ up=!up; paint(); });
  if(!$("#auth-social").hidden && (window.MW_CONFIG||{}).BACKEND!=="cf") $("#gt-fb").hidden=false; // Facebook sign-in isn't on the new free system yet
  if((window.MW_CONFIG||{}).BACKEND==="cf"){ const af=$("#auth-fb"); if(af) af.hidden=true; }
  $("#gt-fb").addEventListener("click",()=>$("#auth-fb").click());
  $("#gt-forgot").addEventListener("click",async()=>{ const em=$("#gt-email").value.trim(); if(!em){ $("#gt-msg").textContent="Type your email first, then tap Forgot password."; return; }
    const r=await MW.reset?.(em); $("#gt-msg").textContent=r&&r.error?r.error.message:"Check your email for a link to set a new password."; });
  $("#gt-form").addEventListener("submit",async e=>{ e.preventDefault(); if(!window.MW?.ready){ $("#gt-msg").textContent="The site is still starting up. Try again in a moment."; return; }
    const name=$("#gt-name").value.trim().replace(/\s+/g," "), em=$("#gt-email").value.trim(), pw=$("#gt-pass").value;
    if(up && name.length<2){ $("#gt-msg").textContent="Type your name (at least 2 letters)."; return; }
    if(pw.length<8){ $("#gt-msg").textContent="Your password needs at least 8 characters."; return; }
    $("#gt-go").disabled=true; $("#gt-msg").textContent="One moment...";
    if(up){ try{ localStorage.setItem("mw_join_name",name.slice(0,30)); }catch(_){} }
    const r= up ? await MW.signUp(em,pw,name) : await MW.signIn(em,pw);
    $("#gt-go").disabled=false;
    if(r.error){ $("#gt-msg").textContent=r.error.message; const st=r.error.status||0; if(st>=500||st===402||st===429||/fetch|network|quota|restricted|unavailable/i.test(r.error.message||"")){ window.MW_guestMode&&MW_guestMode("sign-in error "+st); } return; }
    if(up && !r.data.session){ up=false; paint(); $("#gt-msg").textContent="Almost there: check your email and tap the link to confirm, then sign in here."; return; }
    $("#gt-msg").textContent="You're in. Loading..."; // the page reloads into the site
  });
  // Open browsing (owner's call, Oct 2026): an expired or missing sign-in no longer
  // brings the gate back — the visitor just keeps browsing as a guest.
})();

function showRecovery(){ try{sessionStorage.setItem("mw_recovery","1");}catch(_){} const d=$("#pw-dialog"); if(!d.open) d.showModal(); }
window.MW && (MW.onRecovery=showRecovery);
try{ if(window.MW?.recovery || sessionStorage.getItem("mw_recovery")==="1") setTimeout(showRecovery,300); }catch(_){}
$("#pw-form").addEventListener("submit",async e=>{ e.preventDefault(); const pw=$("#pw-new").value; if(pw.length<8){ $("#pw-msg").textContent="Use at least 8 characters."; return; }
  const r=await MW.setPassword(pw); if(r.error){ $("#pw-msg").textContent=r.error.message; return; }
  try{sessionStorage.removeItem("mw_recovery");}catch(_){} $("#pw-dialog").close(); toast("Password saved. You're signed in."); });
$("#auth-forgot").addEventListener("click",async()=>{ const em=$("#auth-email").value.trim(); if(!em){ $("#auth-msg").textContent="Type your email first."; return; } const r=await MW.reset(em); $("#auth-msg").textContent=r.error?r.error.message:"Check your email for a reset link."; });
$("#auth-form").addEventListener("submit",async e=>{ e.preventDefault(); if(!window.MW?.ready){ $("#auth-msg").textContent="The site is still being set up."; return; }
  const em=$("#auth-email").value.trim(), pw=$("#auth-pass").value; $("#auth-go").disabled=true; $("#auth-msg").textContent="One moment...";
  const r= authMode==="signup" ? await MW.signUp(em,pw) : await MW.signIn(em,pw);
  $("#auth-go").disabled=false;
  if(r.error){ $("#auth-msg").textContent=r.error.message; return; }
  if(authMode==="signup" && !r.data.session){ $("#auth-msg").textContent="Check your email to confirm your account, then sign in."; return; }
  $("#auth-msg").textContent="You're in. Loading...";
});
function paintAuthBar(){ $("#authbar").innerHTML = me ? `<button class="btn ghost sm" type="button" data-auth="signout">Sign out</button>` : `<button class="btn sm" type="button" data-auth="signup">Join free</button>`; }
window.addEventListener("hashchange",()=>go(location.hash.slice(1)));
(function(){ const q=new URLSearchParams(location.search), h=new URLSearchParams(location.hash.replace(/^#/,""));
  const err=q.get("error_description")||h.get("error_description");
  if(err){ setTimeout(()=>toast("Login didn't finish: "+err.replace(/\+/g," ")),500); history.replaceState(null,"",location.pathname+"#home"); go("home"); } })();

/* ---------- Shop catalog: ONE device-held copy (device-max B2, 2026-11-01) ----------
   The shop page and the house ads read the same /api/store + /api/shopify
   union; each used to fetch it fresh, so a visit paid ~110 KB two or three
   times. Now the first surface fetches once, the union is held on the device
   (localStorage "mw-catalog-v1") and every surface paints from that copy.
   A copy younger than 15 minutes is used as-is, with no network at all. An
   older copy paints instantly AND revalidates in the background; the stored
   copy is swapped only when a payload's own `updated` stamp moved, and
   surfaces already open repaint on the "mw-catalog" event. Display only:
   price + stock are re-verified live at checkout, exactly as before. */
const MW_CATALOG_KEY = "mw-catalog-v1", MW_CATALOG_TTL = 15 * 60 * 1000;
let mwCatalogMem = null, mwCatalogFlight = null;
function mwCatalogRead(){ if(mwCatalogMem) return mwCatalogMem;
  try{ const j = JSON.parse(localStorage.getItem(MW_CATALOG_KEY) || "null");
    if(j && Array.isArray(j.store) && Array.isArray(j.shopify)){ mwCatalogMem = j; return j; } }catch(_){}
  return null; }
function mwCatalogSave(c){ mwCatalogMem = c;
  try{ localStorage.setItem(MW_CATALOG_KEY, JSON.stringify(c)); }catch(_){} }
async function mwCatalogFetch(){ const rs = await Promise.allSettled([
    fetch("/api/store").then(r => r.json()), fetch("/api/shopify").then(r => r.json())]);
  const s = rs[0].status === "fulfilled" ? rs[0].value : null, h = rs[1].status === "fulfilled" ? rs[1].value : null;
  const prev = mwCatalogRead();
  const c = { at: Date.now(),
    store: s && Array.isArray(s.products) ? s.products : (prev ? prev.store : []),
    shopify: h && Array.isArray(h.products) ? h.products : (prev ? prev.shopify : []),
    sUp: s && s.updated ? s.updated : (prev ? prev.sUp : 0),
    hUp: h && h.updated ? h.updated : (prev ? prev.hUp : 0) };
  const changed = !prev || prev.sUp !== c.sUp || prev.hUp !== c.hUp;
  mwCatalogSave(c);
  if(changed) try{ window.dispatchEvent(new Event("mw-catalog")); }catch(_){}
  return c; }
function MW_shopCatalog(){ const c = mwCatalogRead();
  if(c && Date.now() - c.at < MW_CATALOG_TTL) return Promise.resolve(c);
  if(!mwCatalogFlight) mwCatalogFlight = mwCatalogFetch().finally(() => { mwCatalogFlight = null; });
  return c ? Promise.resolve(c) : mwCatalogFlight; }
window.MW_shopCatalog = MW_shopCatalog;

/* ---------- Shop (Printify) ---------- */
let shopLoaded = false;
function paintShop(c){ if(!c) return;
  const ps = c.store || [];
  if(ps.length) $("#shop-grid").innerHTML = ps.map(p => `<div class="prod"><a class="prod-a" href="${esc(p.url)}" target="_blank" rel="noopener"><img src="${esc(p.img)}" alt="${esc(p.title)}" loading="lazy"><b>${esc(p.title)}</b>${p.price ? `<span class="pr">${esc(p.price)}</span>` : ""}<span class="buy">Shop now →</span></a><button type="button" class="prod-share" data-pshare data-title="${esc(p.title)}" data-price="${esc(p.price || "")}" data-url="${esc(p.url)}">↗ Share this</button></div>`).join("");
  else $("#shop-grid").innerHTML = '<div class="empty">Our latest drop is in the store. Tap the button below to shop.</div>';
  paintShopify(c);
}
/* ---------- Store (Shopify): books, fashion and more. New Shopify products appear here automatically. ---------- */
function paintShopify(c){ if(!c) return;
  const ps = (c.shopify || []).filter(p => /^https:\/\//.test(p.url));
  if(ps.length){ ps.sort((a, b) => (b.digital ? 1 : 0) - (a.digital ? 1 : 0)); // eBooks first
    window.MW_SHOPIFY = ps;
    $("#shopify-grid").innerHTML = ps.map(p => `<div class="prod"><a class="prod-a" href="${esc(p.digital && p.buy ? p.buy : p.url)}" target="_blank" rel="noopener">${p.img ? `<img src="${esc(p.img)}" alt="${esc(p.title)}" loading="lazy">` : `<div class="prod-ph">${esc(p.title)}</div>`}<b>${esc(p.title)}</b>${p.price ? `<span class="pr">${esc(p.price)}</span>` : ""}<span class="buy">${p.digital ? "Buy &amp; download →" : "Shop now →"}</span></a><button type="button" class="prod-share" data-pshare data-title="${esc(p.title)}" data-price="${esc(p.price || "")}" data-url="${esc(p.url)}">↗ Share this</button></div>`).join("");
    window.MW_shopGifts?.decorate();
  } else $("#shopify-grid").innerHTML = '<div class="empty">Tap the button below to see everything in the store.</div>';
}
async function loadShop(){ if(shopLoaded) return; shopLoaded = true; paintShop(await MW_shopCatalog()); }
async function loadShopify(){ paintShop(await MW_shopCatalog()); }
window.addEventListener("mw-catalog", () => { if(shopLoaded) paintShop(mwCatalogRead()); });
try{ new MutationObserver(()=>{ if(!$("#v-shop").hidden) loadShop(); }).observe($("#v-shop"),{attributes:true,attributeFilter:["hidden"]}); }catch(_){ }
try{ if(!$("#v-shop").hidden) loadShop(); }catch(_){ }
window.addEventListener("load",()=>{ try{ if(!$("#v-shop").hidden) loadShop(); }catch(_){ } });

/* Pause our radio when someone starts the ReverbNation player */
window.addEventListener("blur",()=>{ setTimeout(()=>{ const a=document.activeElement; if(a && a.tagName==="IFRAME" && /reverbnation/.test(a.src) && !media.paused){ media.pause(); } },0); });

$("#rn-sync").addEventListener("click",async e=>{ const b=e.currentTarget, st=$("#up-status"); b.disabled=true; st.textContent="Copying your songs from ReverbNation... this can take a minute.";
  try{ let added=0, failed=[], total=0, rounds=0, j;
    do{ const r=await fetch("/api/rn-sync",{method:"POST",headers:{authorization:"Bearer "+(window.MW?.session?.()?.access_token||"")}}); j=await r.json().catch(()=>({}));
      if(!r.ok) throw new Error(j.error==="owner_only"?"Only the owner can sync.":(j.error||"Sync failed"));
      added+=j.added.length; failed=failed.concat(j.failed); total=j.total; rounds++;
      st.textContent=`Copying from ReverbNation... ${total-j.remaining-failed.length} of ${total} songs on your radio`;
    } while(j.remaining>0 && j.added.length>0 && rounds<10);
    st.textContent=`Done. ${added?`Added ${added} new song${added>1?"s":""}. `:"No new songs. "}${total-failed.length} of ${total} ReverbNation songs are on your radio.`+(failed.length?` Couldn't copy: ${failed.join("; ")}`:"");
    if(added) toast("Your ReverbNation songs are on the radio");
  }catch(err){ st.textContent=err.message; }
  b.disabled=false; });
boot();

/* ---------- Background auto-refresh (owner directive, 2026-10-30:
   "Make it so the page refreshes in the background automatically") ----------
   Open tabs pick up new builds by themselves — nobody closes and reopens a
   tab by hand again. This checker polls /version.json about once a minute
   (and on every return to the tab) and compares the live build to
   MW_SHELL_BUILD, the build this shell shipped with. A newer build becomes
   a PENDING update, applied by location.reload() at the first SAFE moment:

     SOUND GATE (top of the ladder, NO-SKIP LAW): a tab that is SOUNDING —
     this device audibly playing the station/music — is NEVER reloaded.
     The update holds until playback stops; if it never stops this session,
     the skeleton activates the new build on the next natural visit anyway
     (builds are backend-compatible; an update is never worth a skip).
       sounding = MW_DJ.listening()  (dj.js's tuned-in flag — the exact
                  value its keeper ping reports as l=1: the station mix
                  sounding through a screen, YouTube decks included)
               || the shell player element (#audio, `media`) playing
               || the crossfade deck (xfPlayer) mid-blend.
     Then, once silent:
       - tab hidden -> fire (invisible; they return on the new build);
       - booth / sandbox / kids tabs are hidden-only while visible;
       - a modal / dialog / checkout / sign-in surface open -> defer;
       - ~10 minutes without interaction -> fire;
       - the next station song change -> fire (nothing sounding to clip).

   Loop safety: one auto-refresh per target build per session
   (mw-bgref-<build>); firing also stamps mw-guard-<build> so dj.js's
   stale-tab guardian treats the build as handled, and a session whose
   boot-heal reload already fired (mw-heal-tries) never stacks another.
   The soft nag stays where it already lives — dj.js's guardian note —
   as the fallback for a tab that never backgrounds and never idles. */
const MW_SHELL_BUILD = 1793549991;
(() => {
  const POLL_MS = 60000, EVAL_MS = 15000, IDLE_MS = 10 * 60e3;
  let target = 0, targetSong = null, lastAct = Date.now();

  const ssGet = (k) => { try { return sessionStorage.getItem(k); } catch (_) { return null; } };
  const ssSet = (k, v) => { try { sessionStorage.setItem(k, v); } catch (_) {} };

  const sounding = () => {
    try { if (window.MW_DJ && typeof MW_DJ.listening === "function" && MW_DJ.listening()) return true; } catch (_) {}
    try { if (typeof media !== "undefined" && media && !media.paused && !media.ended && media.readyState >= 2) return true; } catch (_) {}
    try { if (typeof xfPlayer !== "undefined" && xfActive && xfPlayer && !xfPlayer.paused && !xfPlayer.ended) return true; } catch (_) {}
    try { for (const v of document.querySelectorAll("video")) if (!v.paused && !v.ended && !v.muted) return true; } catch (_) {}
    return false;
  };
  /* SOUND GATE between songs (2026-11-01): on a locked phone the shell
   * radio is briefly ended/loading while tuneIn() fetches the next song.
   * That gap is not silence — hold any reload for 10 minutes after this
   * tab last made sound, so a locked phone never reloads (and dies)
   * between songs. dj.js's guardian reads the same gate. */
  let soundAt = 0;
  const recentSound = () => { if (sounding()) { soundAt = Date.now(); return true; } return !!soundAt && Date.now() - soundAt < 10 * 60e3; };
  window.MW_recentSound = recentSound;
  try { media.addEventListener("playing", () => { soundAt = Date.now(); }); } catch (_) {}

  /* hidden-only classes: the booth console on screen in this tab, a
   * SANDBOX / Playground session (?playdj=1 / ?popdj=1), the kids app */
  const pinned = () => {
    try {
      if (/[?&](playdj|popdj)=1/.test(location.search)) return true;
      const de = document.documentElement;
      if (de.classList.contains("playdj") || de.classList.contains("popdj")) return true;
      if (document.body && document.body.classList.contains("dj-on")) return true;
      if (/^\/kids-app(\/|$)/.test(location.pathname)) return true;
    } catch (_) {}
    return false;
  };

  const modalOpen = () => {
    try {
      if (document.querySelector("dialog[open]")) return true;
      const ae = document.activeElement;
      if (ae && ae.matches && ae.matches("input,textarea,[contenteditable],[contenteditable=true]") && (ae.value || ae.textContent || "").trim()) return true;
      const vis = (el) => !!el && el.getClientRects().length > 0;
      if (vis(document.getElementById("gate"))) return true;
      for (const el of document.querySelectorAll('[role="dialog"]')) if (vis(el)) return true;
    } catch (_) {}
    return false;
  };

  const songId = () => {
    try { const a = window.MW_AIRNOW && MW_AIRNOW(); if (a && a.title) return "dj:" + a.title; } catch (_) {}
    try { const a = airNow(); if (a && tracks[a.i]) return "air:" + (tracks[a.i].id || tracks[a.i].title || a.i); } catch (_) {}
    return null;
  };

  /* The decision — pure, harness-tested. Facts in, verdict out:
   * "fire" reloads now; "hold" never fires for this target this session;
   * "wait" keeps the update pending for a later safe moment. */
  const decide = (s) => {
    if (!s.target) return "wait";
    if (s.fired || s.guardFired || s.healSpent) return "hold";
    if (s.sounding) return "hold";
    if (s.hidden) return "fire";
    if (s.pinned) return "wait";
    if (s.modal) return "wait";
    if (s.idleMs >= IDLE_MS) return "fire";
    if (s.songChanged) return "fire";
    return "wait";
  };

  const state = () => {
    const sid = target ? songId() : null;
    return {
      target,
      hidden: !!document.hidden,
      sounding: recentSound(),
      pinned: pinned(),
      modal: modalOpen(),
      idleMs: Date.now() - lastAct,
      songChanged: !!(target && targetSong !== null && sid !== null && sid !== targetSong),
      fired: target ? ssGet("mw-bgref-" + target) === "1" : false,
      guardFired: target ? ssGet("mw-guard-" + target) === "1" : false,
      healSpent: (parseInt(ssGet("mw-heal-tries") || "0", 10) || 0) >= 1,
    };
  };

  const fire = () => {
    if (!target) return;
    ssSet("mw-bgref-" + target, "1");
    ssSet("mw-guard-" + target, "1");
    location.reload();
  };

  const evaluate = () => { if (target && decide(state()) === "fire") fire(); };

  const check = async () => {
    try {
      const j = await fetch("/version.json?t=" + Date.now(), { cache: "no-store" }).then((r) => r.json());
      const b = +((j && (j.build || j.dj)) || 0);
      if (b > MW_SHELL_BUILD && !target) { target = b; targetSong = songId(); }
    } catch (_) {}
    evaluate();
  };

  ["pointerdown", "keydown", "scroll", "touchstart"].forEach((ev) =>
    addEventListener(ev, () => { lastAct = Date.now(); }, { passive: true, capture: true }));
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) evaluate();
    else { lastAct = Date.now(); check(); }
  });
  try { media.addEventListener("pause", evaluate); media.addEventListener("ended", evaluate); } catch (_) {}
  setTimeout(check, 20000);
  setInterval(check, POLL_MS);
  setInterval(evaluate, EVAL_MS);
})();
