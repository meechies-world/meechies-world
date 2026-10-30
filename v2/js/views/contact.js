/* ============================================================================
   v2 CONTACT VIEW (Phase 5) — the live Contact view: the Ask Meechie
   AI card (the app-core chat: POST /api/ai with the running history,
   Bearer from the shared session, same busy/error copy), the pay box
   and Support card (hidden until payment links exist, as live), and
   the contact cards from the live section markup.
   ============================================================================ */

import { MARKUP } from "./contact-markup.js";
import { esc as E } from "../platform.js";
import { toast } from "../commerce.js";

export function render(root, ctx) {
  root.innerHTML = MARKUP;
  const log = root.querySelector("#ai-log"), form = root.querySelector("#ai-form"), q = root.querySelector("#ai-q");
  if (!log || !form || !q) return;
  const hist = [];
  let busy = false;
  const draw = () => {
    log.innerHTML = hist.length ? hist.map((m) => `<div class="msg ${m.role === "user" ? "mine" : ""}">${E(m.content)}</div>`).join("") : '<div class="msg">Hi, I\'m Meechie\'s AI. What can I help you with today?</div>';
    log.scrollTop = log.scrollHeight;
  };
  draw();
  form.addEventListener("submit", async (e) => {
    e.preventDefault(); if (busy) return;
    const text = q.value.trim(); if (!text) return;
    const s = ctx.session.get();
    if (!s) { toast("Join free to chat with Meechie, our AI assistant."); return; }
    q.value = ""; hist.push({ role: "user", content: text });
    const ans = { role: "assistant", content: "Thinking..." }; hist.push(ans); draw(); busy = true;
    try {
      const r = await fetch("/api/ai", { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer " + (s.access_token || "") }, body: JSON.stringify({ messages: hist.slice(0, -1).slice(-16) }) });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || !j.reply) throw Object.assign(new Error(j.error || "fail"), { code: j.error });
      ans.content = j.reply + (j.sources && j.sources.length ? "\n\nSources: " + j.sources.map((x, i) => "[" + (i + 1) + "] " + x.title + " — " + x.url).join("\n") : "");
    } catch (err) {
      ans.content = err.code === "busy" ? "I'm getting a lot of questions right now. Try again in a minute, or DM @meechiesworldinc on TikTok." : "I can't answer right now. DM @meechiesworldinc on TikTok or email meechiesworldinc@aol.com.";
    }
    busy = false; draw();
  });
}
export function destroy() {}
