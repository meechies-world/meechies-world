/* ============================================================================
   v2 VIEW — CHAT (#chat). MAP §4.4: "CHAT (app-core): rooms 'lounge',
   'music', 'business', 'walkie'; messages in chat/<ch>/msgs (createdAt
   desc, limit 80, reversed for display); text, photo (compressed →
   upload), voice note (≤ ~190,000 bytes, 'about 15 seconds')."

   The live chat, ported: same channels, same collection, same presence
   count through the changes-feed lobby room (the live client counts
   lobby peers whose presence names this channel).
   ============================================================================ */
import { createSocial, esc, ago, say, compress, readFile } from "../social.js";

const $ = (s, r) => (r || document).querySelector(s);
const $$ = (s, r) => [...(r || document).querySelectorAll(s)];
const CHANNELS = [["lounge", "💬 Lounge"], ["music", "🎵 Music"], ["business", "💼 Business"], ["walkie", "📻 Walkie-talkie"]];

let cur = null;
export function destroy() { if (cur) { cur.teardown(); cur = null; } }

export async function render(root, ctx) {
  const S = createSocial(ctx);
  const me = S.me();
  const state = { ch: "lounge", msgs: [], room: null };

  root.innerHTML = `
  <div class="section-head"><div><p class="kicker">Talk to everybody</p><h2>Chat</h2></div>
  <p class="muted">Open rooms for the whole neighborhood. Be kind — the rules from Meechie's Book apply here too.</p></div>
  <div class="chat">
    <div class="channels" role="group" aria-label="Channels">
      <p class="label">CHANNELS</p>
      ${CHANNELS.map(([k, n]) => `<button type="button" data-ch="${k}" aria-pressed="${k === "lounge"}">${n}</button>`).join("")}
    </div>
    <div class="chat-main">
      <div class="chat-top"><b data-ch-name># lounge</b><span class="muted" data-online></span></div>
      <div class="msgs" data-msgs><p class="muted">Loading…</p></div>
      <form class="chat-input" data-form>
        <label class="btn ghost sm file-btn">📷<input type="file" accept="image/*" hidden data-photo></label>
        <label class="btn ghost sm file-btn">🎙️<input type="file" accept="audio/*" capture hidden data-voice></label>
        <input data-text maxlength="500" placeholder="Message #lounge" aria-label="Message">
        <button class="btn" type="submit">Send</button>
      </form>
    </div>
  </div>
  <p class="muted" style="margin-top:10px;font-size:13px">Voice clips up to about 15 seconds. Live hold-to-talk audio and end-to-end encryption are part of the launch build.</p>`;

  await S.loadMembers();
  const msgsEl = $("[data-msgs]", root), onlineEl = $("[data-online]", root);

  function drawMsgs() {
    msgsEl.innerHTML = state.msgs.length ? state.msgs.map((m) => `<div class="msg${m.authorId === me ? " mine" : ""}"><small>${esc(S.handleOf(m.authorId))} · ${ago(m.createdAt)}</small>${m.text ? `<span>${esc(m.text)}</span>` : ""}${m.photo ? `<img src="${esc(m.photo)}" alt="Photo" style="max-width:240px;border-radius:10px">` : ""}${m.audio ? `<audio controls src="${m.audio}" preload="metadata"></audio>` : ""}</div>`).join("") : `<p class="muted">No messages yet. Say hello.</p>`;
    msgsEl.scrollTop = msgsEl.scrollHeight;
  }
  async function loadMsgs() {
    const rows = await S.docs("chat/" + state.ch + "/msgs", { field: "createdAt", limit: 80 });
    state.msgs = rows.slice().reverse();
    drawMsgs();
  }

  /* presence: the lobby room, the live way — count peers in this channel */
  const room = S.bus.room("room:lobby");
  state.room = room;
  const updOnline = () => {
    if (!me) { onlineEl.textContent = ""; return; }
    const n = room.peers(me).filter((p) => p.presence && p.presence.channel === state.ch).length;
    onlineEl.textContent = "● " + Math.max(n, 1) + " in this chat";
  };
  room.onPresence(updOnline);
  if (me) room.track({ uid: me, p: { channel: state.ch } });

  let unwatch = null;
  function watchChannel() {
    if (unwatch) unwatch();
    unwatch = S.bus.watch(["chat/" + state.ch + "/msgs"], () => loadMsgs());
  }

  root.addEventListener("click", (e) => {
    const b = e.target.closest("[data-ch]"); if (!b) return;
    state.ch = b.dataset.ch;
    $$("[data-ch]", root).forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
    $("[data-ch-name]", root).textContent = "# " + state.ch;
    $("[data-text]", root).placeholder = "Message #" + state.ch;
    if (me) room.track({ uid: me, p: { channel: state.ch } });
    updOnline(); watchChannel(); loadMsgs();
  });

  $("[data-form]", root).addEventListener("submit", async (e) => {
    e.preventDefault();
    if (!S.needMember()) return;
    const inp = $("[data-text]", root), text = inp.value.trim(); if (!text) return;
    try { await S.addDoc("chat/" + state.ch + "/msgs", { authorId: me, text, createdAt: Date.now() }); inp.value = ""; loadMsgs(); }
    catch (err) { say(err.message); }
  });
  $("[data-photo]", root).addEventListener("change", async (e) => {
    const f = e.target.files[0]; if (!f) return;
    if (!S.needMember()) return;
    try {
      const d = await compress(f, 1280); const blob = await (await fetch(d)).blob();
      const up = await S.uploadMedia(blob, { type: "image/jpeg", ext: "jpg" });
      await S.addDoc("chat/" + state.ch + "/msgs", { authorId: me, text: $("[data-text]", root).value.trim(), photo: up.url, createdAt: Date.now() });
      $("[data-text]", root).value = ""; loadMsgs();
    } catch (err) { say(err.message); }
    e.target.value = "";
  });
  $("[data-voice]", root).addEventListener("change", async (e) => {
    const f = e.target.files[0]; if (!f) return;
    if (!S.needMember()) return;
    if (f.size > 190000) { say("That clip is too long — keep it under about 15 seconds."); e.target.value = ""; return; }
    try { const d = await readFile(f); await S.addDoc("chat/" + state.ch + "/msgs", { authorId: me, audio: d, createdAt: Date.now() }); loadMsgs(); }
    catch (err) { say(err.message); }
    e.target.value = "";
  });

  watchChannel();
  await loadMsgs();
  updOnline();

  cur = { teardown() { if (unwatch) unwatch(); S.destroy(); } };
}
