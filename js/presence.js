(function(){"use strict";
/* PRESENCE RECEIVER (2026-11-08, Malik: event-driven presence — the site does not keep checking who is online; a sign-in speaks for itself, once): when a member finishes signing in, their own client writes ONE small presence doc (see PRESENCE ANNOUNCE in js/cf-client.js). This module watches the docs changes feed the site already polls and shows a single small toast — the member is online — on every other client. It runs no polling of its own: it rides the one existing changes flow, dedupes by the sign-in session key, ignores anything older than two minutes, never toasts you about yourself, and fails silent throughout. Guests receive too — they just never announce, because they never sign in. */
const seenGet=()=>{try{return JSON.parse(localStorage.getItem("mw-pres-seen")||"{}")}catch(_){return{}}};
const seenPut=m=>{try{localStorage.setItem("mw-pres-seen",JSON.stringify(m))}catch(_){}};
let box=null;
function showToast(name){
  try{if(typeof window.toast==="function"){window.toast("\u{1F7E2} "+name+" is online");return}}catch(_){}
  try{
    box=box||document.getElementById("pres-toasts");
    if(!box){box=document.createElement("div");box.id="pres-toasts";box.style.cssText="position:fixed;left:50%;transform:translateX(-50%);bottom:calc(var(--tabbar,0px) + 18px + env(safe-area-inset-bottom,0px));z-index:10015;display:grid;gap:8px;justify-items:center;pointer-events:none";document.body.appendChild(box)}
    while(box.children.length>=2)box.firstChild.remove();
    const el=document.createElement("div");
    el.style.cssText="background:#0b0a08f2;color:#f0cf78;border:1px solid #c9a44a;border-radius:999px;padding:9px 16px;font:700 14px var(--body,system-ui);box-shadow:0 6px 20px rgba(0,0,0,.5)";
    el.textContent="\u{1F7E2} "+name+" is online";
    box.appendChild(el);
    setTimeout(()=>{try{el.remove()}catch(_){}},6e3);
  }catch(_){}
}
function start(){
  const CF=window.MW_CF;if(!CF)return;
  let cli;try{cli=CF.createClient()}catch(_){return}
  const meId=()=>{try{const s=CF.session();return s&&s.user&&s.user.id||""}catch(_){return""}};
  try{
    cli.channel("presence-feed").on("postgres_changes",{table:"docs"},async row=>{
      try{
        const n=row&&row.new;
        if(!n||n.coll!=="presence"||!n.path)return;
        const r=await cli.from("docs").select("data").eq("path",n.path).limit(1);
        const rows=r&&r.data;const doc=Array.isArray(rows)?rows[0]:null;
        if(!doc)return;
        let d=doc.data;
        if(typeof d==="string"){try{d=JSON.parse(d)}catch(_){return}}
        if((!d||typeof d!=="object")&&doc.sess)d=doc;
        if(!d||typeof d!=="object"||!d.sess)return;
        if(d.authorId&&d.authorId===meId())return;
        if(!d.at||Date.now()-+d.at>12e4)return;
        const seen=seenGet();
        if(seen[d.sess])return;
        seen[d.sess]=Date.now();
        const ks=Object.keys(seen);
        if(ks.length>60)ks.sort((a,b)=>seen[a]-seen[b]).slice(0,ks.length-60).forEach(k=>delete seen[k]);
        seenPut(seen);
        const nm=String(d.name||"A member").replace(/[<>&]/g,"").slice(0,40)||"A member";
        showToast(nm);
      }catch(_){}
    }).subscribe();
  }catch(_){}
}
if(window.MW_CF)start();
})();
