/* Show Studio — Meechie AI's producer's desk for MY EMPIRE (owner only).
 * Malik's order (2026-11-03): "make my website AI capable of building my
 * TV show like you do." The honest shape of that: the site AI runs the
 * DESK — the show bible, script writing, the production board, handoffs
 * and the 8 PM scheduling hook. Filming itself (video generation with
 * Malik's locked character, lip-sync takes, assembly) stays with Amani's
 * pipeline; a script Malik approves here is handed off through the
 * show/handoffs doc, which Amani reads. This file never films anything
 * and never pretends to: every state on the board is a real state.
 *
 * Data (D1 docs, coll "show" — admin-write only, see lib/cf.js):
 *   show/bible     the bible essentials the desk works under
 *   show/board     per-episode pipeline states
 *   show/script-*  one doc per episode script (versioned, owner-editable)
 *   show/handoffs  the queue Amani's filming pipeline reads
 *   show/schedule  log of scheduling actions taken from this desk
 * Scheduling writes tv/premiere + tv/rerun in the keeper's own shape
 * (functions/api/station.js tvSeedPremiere/tvSeedRerun): probe-gated,
 * so a slot whose episode file is not on the site yet stays dark.
 * Nothing here touches the radio, and MW TV is touched only through
 * those two existing slot docs, only on Malik's approval taps. */
(function () {
  "use strict";
  if (window.__MW_SHOWSTUDIO) return;
  window.__MW_SHOWSTUDIO = true;

  const $ = (s, r) => (r || document).querySelector(s);
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const nowIso = () => new Date().toISOString();
  const STAGES = [["script", "Script"], ["shotlist", "Shot list"], ["filming", "Filming with Amani"], ["assembly", "Assembly"], ["approval", "Malik's approval"], ["scheduled", "Scheduled · 8 PM"]];
  const CLOCK = [
    ["A", "Cold Open — The Chair", "00:00–01:15", 16],
    ["T", "Main Titles", "01:15–01:45", 0],
    ["B", "The Shop", "01:45–04:45", 44],
    ["C", "The Booth", "04:45–07:15", 34],
    ["D", "The Hustle", "07:15–09:45", 34],
    ["E", "The Music", "09:45–12:00", 22],
    ["F", "The Build", "12:00–13:15", 18],
    ["G", "Family Table", "13:15–14:30", 24],
    ["H", "Closing Word + Hook", "14:30–15:00", 8]
  ];

  /* ---------------- seeds (from SHOW.md + the Ep1 production record) ---------------- */
  const BIBLE_SEED = {
    title: "MY EMPIRE — Show Bible",
    tagline: "His life is the show. The shop, the station, the family, the music — edited like television, because it is.",
    format: { minutes: 15, episodesPerSeason: 13, seasons: 5, aspect: "16:9 (MW TV master)", rule: "Every episode ends at 15:00, on the hook. No exceptions. Segments never swap order. ~90 shots per episode at ~10s a clip, produced segment by segment." },
    clock: CLOCK.map(([k, n, s]) => ({ key: k, name: n, span: s })),
    seasons: [
      ["Season 1", "ONE CHAIR", "One chair, one man, no help. The chair gets a line out the door."],
      ["Season 2", "SECOND CHAIR", "Jay's chair is earned; the booth adds a second show; Nadia's sales start landing real clients."],
      ["Season 3", "AIRWAVES", "The station is the story: MW TV launches, the live show becomes an event, a rival voice appears."],
      ["Season 4", "FRANCHISE", "A second shop is offered — franchising the chair without selling the soul of it."],
      ["Season 5", "GLOBAL, NOT LOCAL", "The brand leaves the county: a tour, a deal on the table, and the decision that defines the empire."]
    ],
    cast: [
      ["MALIK “MEECHIE” — THE DON", "Lead. Barber, DJ, founder. Persona LOCKED: braids, thin glasses, goatee, braces, warm light-brown skin, heavy chains with the crown-M pendant, black/gold. Wardrobe is a per-scene choice; the face never changes."],
      ["DAD", "His father. Real family."],
      ["MOM", "His mother. Real family."],
      ["GMA", "His grandmother. Real family."],
      ["NADIA McKENZI", "Working partner — sales. A real person in a working relationship with Malik."],
      ["JAY", "The apprentice barber (created for the show). Earns the second chair across Season 1."],
      ["MR. EARL", "The elder client (created for the show). Has sat in the chair for decades; says the thing everybody else is thinking."],
      ["THE CLIENT OF THE WEEK", "Rotating guest in the chair. Never repeats a face within a season."],
      ["SKYE", "Recurring (created for the show)."],
      ["REMY", "Recurring (created for the show)."]
    ],
    laws: [
      "MORE TALKING: 200 dialogue lines per episode is the standard — dialogue, script, action, drama and comedy like a real show.",
      "A song plays ONCE where it is placed — never loops, never restarts. Score comes only from Malik's own 48-song catalog; excerpts under scenes, and Segment E is the one performance home (the performance audio is Malik's real recording).",
      "SURPRISE JOKES: unexpected, out-of-nowhere humor — the “in your walls” beat is the model. Land them where nobody sees them coming.",
      "WORD LAW: a delivered line banks when the actor says the scripted line naturally in street OR proper form. Captions always read the script words exactly — so the script is written exactly as it must appear.",
      "SAME-MAN LAW: the lead is the same man in every frame. Any face-drifting take is rejected and re-rolled; only Malik grades likeness.",
      "LIP-SYNC is a first-class gate, the same rank as the same-man law.",
      "PACING LAW: no gaps, no dead air, no filler. “Slow and boring” is a reject verdict.",
      "Captions on every spoken line.",
      "Faith is shown as practice — prayer, gratitude, discipline — never a sermon.",
      "Storylines invent situations, never facts about real people's lives.",
      "NOTHING posts, airs, or enters the MW TV lineup without Malik's review of the finished cut. The 8 PM slot stays dark until he approves."
    ],
    seededFrom: "SHOW.md — the MY EMPIRE show bible (2026-11-03)",
    updatedAt: nowIso()
  };
  const EP1_SEGMENTS = [
    ["A", "The First Chair", 16], ["T", "Main Titles", 0], ["B", "A Haircut Is a Promise", 48],
    ["C", "Somebody's Whole Night", 34], ["D", "My Name Sits On My Work", 34], ["E", "Reading the Receipt", 22],
    ["F", "Priced Once", 16], ["G", "You Eat Today?", 22], ["H", "Closing Word + Hook", 8]
  ];
  const BOARD_SEED = {
    episodes: [{
      id: "S1E1", title: "They Been Waiting", season: 1, ep: 1, scriptId: "s1e1",
      stage: "filming", premiere: "held", mediaUrl: "/media/my-empire-ep1.mp4", dur: 905,
      notes: "REBUILD under the new law (200 lines · a song plays once, never loops · lip-sync is a first-class gate). Script v3.1 locked. Filming with Amani: Raven complete; Segment E dialogue 12/12 banked; the Segment E performance take is still open — waiting on Malik's “one / two” call — then B/D/F pickups, A, G+H and Jay. Premiere HELD: nothing airs until Malik approves the finished episode, and the 8 PM slot stays dark until then.",
      updatedAt: nowIso()
    }],
    updatedAt: nowIso()
  };
  const SCRIPT_S1E1_SEED = {
    id: "s1e1", code: "S1E1", title: "They Been Waiting", season: 1, ep: 1,
    premise: "Series premiere: one day that shows the whole empire — the shop, the station, the family — and ends on the hook: they been waiting.",
    song: "“they been waiting” — titles bed + the Segment E performance excerpt (plays once, where placed)",
    status: "locked",
    outline: "Locked script v3.1 (200 lines exactly). The full text lives in Amani's production files and the rebuild is filming from it — this desk entry is the record, not the shooting copy. Line counts: A 16 · Titles 0 · B 48 · C 34 · D 34 · E 22 · F 16 · G 22 · H 8.",
    segments: CLOCK.map(([k, n, s]) => {
      const e = EP1_SEGMENTS.find((x) => x[0] === k);
      return { key: k, name: e ? e[1] : n, span: s, text: "", note: "Locked in script v3.1 — " + (e ? e[2] : 0) + " lines. Filming from Amani's production copy." };
    }),
    shots: null, versions: [], createdAt: nowIso(), updatedAt: nowIso()
  };
  const HANDOFFS_SEED = { queue: [], updatedAt: nowIso() };
  const SCHEDULE_SEED = { actions: [], updatedAt: nowIso() };

  /* ---------------- state + data layer ---------------- */
  let admin = false, booted = false, rendering = false;
  const D = { bible: null, board: null, scripts: {}, handoffs: null, schedule: null, prem: null, rerun: null, fileOk: {} };
  let openScript = null;
  const armed = {}; // two-tap confirmations, by key

  function tok() {
    try { const s = window.MW_CF && MW_CF.session(); if (s && s.access_token) return s.access_token; } catch (_) {}
    try { const s = window.MW && MW.session && MW.session(); if (s && s.access_token) return s.access_token; } catch (_) {}
    return "";
  }
  async function api(path, body) {
    const r = await fetch(path, { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer " + tok() }, body: JSON.stringify(body), cache: "no-store" });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || j.error) throw new Error((j.error && (j.error.message || j.error.code)) || ("HTTP " + r.status));
    return j;
  }
  const parseData = (v) => { if (v && typeof v === "object") return v; try { return JSON.parse(v || "{}"); } catch (_) { return {}; } };
  async function selectDocs(filters) {
    const j = await api("/api/cf/rest", { table: "docs", op: "select", select: "path,data,updated_at", filters });
    return (j.data || []).map((row) => ({ path: row.path, data: parseData(row.data), updated_at: row.updated_at }));
  }
  async function setDoc(path, coll, data) {
    await api("/api/cf/rpc", { name: "set_doc", args: { p_path: path, p_coll: coll, p_data: data } });
  }
  async function loadAll() {
    const rows = await selectDocs([["coll", "eq", "show"]]);
    const byPath = {}; rows.forEach((r) => { byPath[r.path] = r.data; });
    D.bible = byPath["show/bible"] || null;
    D.board = byPath["show/board"] || null;
    D.handoffs = byPath["show/handoffs"] || null;
    D.schedule = byPath["show/schedule"] || null;
    D.scripts = {};
    rows.forEach((r) => { if (r.path.startsWith("show/script-")) D.scripts[r.data.id || r.path.slice(12)] = r.data; });
    const prem = await selectDocs([["path", "eq", "tv/premiere"]]).catch(() => []);
    if (prem.length) D.prem = prem[0].data;
    const rerun = await selectDocs([["path", "eq", "tv/rerun"]]).catch(() => []);
    if (rerun.length) D.rerun = rerun[0].data;
  }
  async function ensureSeeds() {
    if (!D.bible) { await setDoc("show/bible", "show", BIBLE_SEED); D.bible = BIBLE_SEED; }
    if (!D.board) { await setDoc("show/board", "show", BOARD_SEED); D.board = BOARD_SEED; }
    if (!D.handoffs) { await setDoc("show/handoffs", "show", HANDOFFS_SEED); D.handoffs = HANDOFFS_SEED; }
    if (!D.schedule) { await setDoc("show/schedule", "show", SCHEDULE_SEED); D.schedule = SCHEDULE_SEED; }
    if (!D.scripts.s1e1) { await setDoc("show/script-s1e1", "show", SCRIPT_S1E1_SEED); D.scripts.s1e1 = SCRIPT_S1E1_SEED; }
  }
  async function saveBoard() { D.board.updatedAt = nowIso(); await setDoc("show/board", "show", D.board); }
  async function saveScript(sc) { sc.updatedAt = nowIso(); await setDoc("show/script-" + sc.id, "show", sc); D.scripts[sc.id] = sc; }
  async function saveHandoffs() { D.handoffs.updatedAt = nowIso(); await setDoc("show/handoffs", "show", D.handoffs); }
  async function saveSchedule() { D.schedule.updatedAt = nowIso(); await setDoc("show/schedule", "show", D.schedule); }
  const epOf = (id) => (D.board && D.board.episodes || []).find((e) => e.id === id);

  /* ---------------- the script-writing AI (site AI, free tier) ---------------- */
  const CONSTITUTION = [
    "You are the script desk for MY EMPIRE, Malik 'Meechie' Goodall's TV show on MW TV. Follow the show bible exactly.",
    "FORMAT: 15-minute episodes, segments in this fixed order, never swapped: A Cold Open — The Chair (00:00-01:15), Main Titles (01:15-01:45), B The Shop (01:45-04:45), C The Booth (04:45-07:15), D The Hustle (07:15-09:45), E The Music (09:45-12:00), F The Build (12:00-13:15), G Family Table (13:15-14:30), H Closing Word + Hook (14:30-15:00).",
    "200 dialogue lines per episode is the standard. Dialogue carries the show: talking, action, drama and comedy like a real show. No gaps, no filler, nothing slow.",
    "CAST: MALIK (the Don — barber, DJ, founder; prays five times a day; 'global, not local'), DAD, MOM, GMA, NADIA (his working partner, sales), JAY (apprentice barber), MR. EARL (elder client), the CLIENT OF THE WEEK (guest in the chair), SKYE, REMY.",
    "LAWS: land unexpected surprise jokes (the model: a beat nobody sees coming). A song plays ONCE where it is placed — never loops, never restarts; score only from Malik's own songs. Faith is shown as practice, never a sermon. Invent situations, never facts about real people's lives. Every episode ends on a cliffhanger hook.",
    "Write dialogue exactly as it must be captioned: NAME: line. Actions and camera beats go in [square brackets]. Keep lines short and speakable."
  ].join("\n");
  const AI_MODELS = ["@cf/meta/llama-3.3-70b-instruct-fp8-fast", "@cf/mistralai/mistral-small-3.1-24b-instruct", "@cf/zai-org/glm-4.7-flash"];
  async function aiWrite(userText, sysText) {
    const msgs = [{ role: "system", content: sysText || CONSTITUTION }, { role: "user", content: userText }];
    let lastErr = null;
    for (const model of AI_MODELS) {
      try {
        const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 90000);
        const r = await fetch("/api/ai", { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer " + tok() }, body: JSON.stringify({ model, messages: msgs }), signal: ctl.signal, cache: "no-store" });
        clearTimeout(t);
        const j = await r.json().catch(() => ({}));
        if (r.ok && j.reply && String(j.reply).trim()) return String(j.reply).trim();
        lastErr = new Error(j.error || ("HTTP " + r.status));
      } catch (e) { lastErr = e; }
    }
    // last resort: Meechie AI's own brain (no model picked)
    const r = await fetch("/api/ai", { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer " + tok() }, body: JSON.stringify({ messages: [{ role: "user", content: (sysText || CONSTITUTION) + "\n\n" + userText }] }), cache: "no-store" });
    const j = await r.json().catch(() => ({}));
    if (r.ok && j.reply && String(j.reply).trim()) return String(j.reply).trim();
    throw lastErr || new Error(j.error || "The AI didn't answer. Try again.");
  }

  /* ---------------- rendering ---------------- */
  function root() { return $("#ss-root"); }
  function status(msg, bad) {
    const s = $("#ss-status"); if (!s) return;
    s.textContent = msg || ""; s.style.color = bad ? "#ff9b8a" : "#8fd6a8";
  }
  function stageChip(stage) {
    const ix = STAGES.findIndex((x) => x[0] === stage);
    return STAGES.map(([k, label], i) => '<span class="ss-step' + (i < ix ? " done" : i === ix ? " on" : "") + '">' + esc(label) + "</span>").join('<span class="ss-arrow">→</span>');
  }
  function render() {
    const r = root(); if (!r) return;
    if (!admin) {
      r.innerHTML = '<div class="card"><h3>🔒 Owner only</h3><p class="muted">The Show Studio is Meechie\'s producer\'s desk. Sign in as the owner to open it.</p></div>';
      return;
    }
    if (!D.bible || !D.board) { r.innerHTML = '<p class="muted">Opening the studio…</p>'; return; }
    r.innerHTML =
      '<p class="muted" id="ss-status" role="status"></p>'
      + renderBoard() + renderScripts() + renderEditor() + renderHandoffs() + renderSched() + renderBible();
    wireEditorText();
  }
  function renderBible() {
    const b = D.bible;
    const clock = (b.clock || []).map((c) => "<tr><td><b>" + esc(c.key) + "</b></td><td>" + esc(c.name) + "</td><td>" + esc(c.span) + "</td></tr>").join("");
    const cast = (b.cast || []).map((c) => "<li><b>" + esc(c[0]) + "</b> — " + esc(c[1]) + "</li>").join("");
    const laws = (b.laws || []).map((l) => "<li>" + esc(l) + "</li>").join("");
    const seasons = (b.seasons || []).map((s) => "<li><b>" + esc(s[0]) + " — " + esc(s[1]) + ":</b> " + esc(s[2]) + "</li>").join("");
    return '<div class="card ss-card"><h3>📖 The Show Bible — the desk\'s constitution</h3>'
      + '<p><i>' + esc(b.tagline) + '</i></p>'
      + '<p class="muted">' + esc(b.format.minutes) + '-minute episodes · ' + esc(b.format.episodesPerSeason) + ' per season · ' + esc(b.format.seasons) + ' seasons · ' + esc(b.format.aspect) + '<br>' + esc(b.format.rule) + '</p>'
      + '<table class="ss-table"><tr><th>Seg</th><th>Segment</th><th>Clock</th></tr>' + clock + '</table>'
      + '<h4>The five seasons</h4><ul class="ss-list">' + seasons + '</ul>'
      + '<h4>Cast</h4><ul class="ss-list">' + cast + '</ul>'
      + '<h4>Standing laws — every script the desk writes is held to these</h4><ul class="ss-list">' + laws + '</ul>'
      + '<p class="muted">Seeded from ' + esc(b.seededFrom || "SHOW.md") + '.</p></div>';
  }
  function renderBoard() {
    const eps = (D.board && D.board.episodes) || [];
    const cards = eps.map((e) => {
      const ix = STAGES.findIndex((x) => x[0] === e.stage);
      const prev = ix > 0 ? STAGES[ix - 1][0] : null, next = ix < STAGES.length - 1 ? STAGES[ix + 1][0] : null;
      return '<div class="ss-ep">'
        + '<div class="ss-ep-head"><b>' + esc(e.id) + ' — “' + esc(e.title) + '”</b>'
        + (e.premiere === "held" ? '<span class="ss-held">⛔ PREMIERE HELD</span>' : '<span class="ss-ok">✓ APPROVED BY MALIK</span>') + '</div>'
        + '<div class="ss-steps">' + stageChip(e.stage) + '</div>'
        + '<p class="muted">' + esc(e.notes || "") + '</p>'
        + '<div class="ss-row">'
        + (e.stage === "scheduled" ? '<span class="muted">Scheduled — to pull it back, use “Restore the keeper default slots” in the scheduling panel below.</span>' : "")
        + (prev && e.stage !== "scheduled" ? '<button type="button" class="btn sm ghost" data-ss="stage" data-ep="' + esc(e.id) + '" data-to="' + prev + '">← Back a stage</button>' : "")
        + (next && e.stage !== "approval" && e.stage !== "scheduled" ? '<button type="button" class="btn sm" data-ss="stage" data-ep="' + esc(e.id) + '" data-to="' + next + '">Move to ' + esc(STAGES[ix + 1][1]) + ' →</button>' : "")
        + (e.stage === "approval" ? '<span class="muted">Use the approval tap below — scheduling is the last stage.</span>' : "")
        + '<label class="ss-lab">Premiere: <select data-ss-prem="' + esc(e.id) + '"><option value="held"' + (e.premiere === "held" ? " selected" : "") + '>HELD — do not air</option><option value="approved"' + (e.premiere === "approved" ? " selected" : "") + '>APPROVED by Malik</option></select></label>'
        + '</div></div>';
    }).join("");
    return '<div class="card ss-card"><h3>🗂️ Production Board</h3>'
      + '<p class="muted">Where every episode really is. The desk never moves an episode on its own — stages move on your taps, and filming states come from Amani\'s pipeline, not from this page.</p>'
      + (cards || '<p class="muted">No episodes yet.</p>') + '</div>';
  }

  function scriptStatusLabel(sc) {
    return { draft: "✏️ Draft", approved: "✓ Approved by Malik", "handed-off": "🎬 With Amani (handed off)", locked: "🔒 Locked — in production" }[sc.status] || sc.status;
  }
  function renderScripts() {
    const list = Object.values(D.scripts).sort((a, b) => (a.season - b.season) || (a.ep - b.ep));
    const rows = list.map((sc) => '<div class="ss-ep"><div class="ss-ep-head"><b>' + esc(sc.code) + ' — “' + esc(sc.title) + '”</b><span class="muted">' + esc(scriptStatusLabel(sc)) + '</span></div>'
      + '<p class="muted">' + esc(sc.premise || "") + '</p>'
      + '<button type="button" class="btn sm" data-ss="open-script" data-id="' + esc(sc.id) + '">' + (openScript === sc.id ? "Close" : "Open the script desk") + '</button></div>').join("");
    return '<div class="card ss-card"><h3>✍️ Script Desk</h3>'
      + '<p class="muted">Meechie AI writes in the bible\'s format — scenes, dialogue per character, the song placed once, the cliffhanger. You edit, you approve. Nothing films until you tap <b>Film this</b>.</p>'
      + rows
      + '<div class="ss-new"><h4>Start a new episode script</h4>'
      + '<div class="ss-grid">'
      + '<label>Season <input type="number" id="ss-ns" min="1" max="5" value="1"></label>'
      + '<label>Episode <input type="number" id="ss-ne" min="1" max="13" value="2"></label>'
      + '<label class="ss-wide">Title <input type="text" id="ss-nt" maxlength="80" placeholder="Episode title"></label>'
      + '<label class="ss-wide">Premise — what happens this episode <textarea id="ss-np" rows="2" maxlength="600" placeholder="One or two lines: the day, the problem, the hook…"></textarea></label>'
      + '<label class="ss-wide">Song (from your catalog — plays once, where placed) <input type="text" id="ss-ng" maxlength="120" placeholder="e.g. Grind Mode"></label>'
      + '</div><button type="button" class="btn" data-ss="new-script">Create the script</button></div></div>';
  }
  function renderEditor() {
    if (!openScript || !D.scripts[openScript]) return "";
    const sc = D.scripts[openScript];
    const segs = (sc.segments || []).map((sg) => {
      const target = (CLOCK.find((c) => c[0] === sg.key) || [])[3] || 0;
      const lines = sg.text ? sg.text.split("\n").filter((l) => /^[A-Z][A-Z .']{1,30}:/.test(l.trim())).length : 0;
      return '<div class="ss-seg"><div class="ss-ep-head"><b>Segment ' + esc(sg.key) + ' — ' + esc(sg.name) + '</b><span class="muted">' + esc(sg.span) + (target ? ' · target ~' + target + ' dialogue lines' : ' · titles — directions only') + (sg.text ? ' · ' + lines + ' lines written' : '') + (sg.cut ? ' · ⚠ may be cut off — check the end' : '') + '</span></div>'
        + (sg.note ? '<p class="muted">' + esc(sg.note) + '</p>' : "")
        + '<textarea class="ss-text" data-seg="' + esc(sg.key) + '" rows="7" placeholder="Segment ' + esc(sg.key) + ' script — NAME: dialogue lines, [actions in brackets]…">' + esc(sg.text || "") + '</textarea>'
        + '<div class="ss-row"><button type="button" class="btn sm" data-ss="gen-seg" data-id="' + esc(sc.id) + '" data-seg="' + esc(sg.key) + '">✨ Write segment ' + esc(sg.key) + ' with Meechie AI</button></div></div>';
    }).join("");
    const shots = sc.shots && sc.shots.length
      ? '<p class="muted">Draft shot list: ' + sc.shots.length + ' shots (~10s each). Amani\'s pipeline confirms the final shot list before filming.</p>'
        + '<div class="ss-shots">' + sc.shots.slice(0, 120).map((s) => '<div><b>' + s.n + '.</b> <span class="muted">[' + esc(s.seg) + ']</span> ' + esc(s.beat) + '</div>').join("") + (sc.shots.length > 120 ? '<p class="muted">…and ' + (sc.shots.length - 120) + ' more.</p>' : "") + '</div>'
      : '<p class="muted">No shot list yet — build one from the script when the segments are written.</p>';
    return '<div class="card ss-card"><h3>📜 ' + esc(sc.code) + ' — “' + esc(sc.title) + '”</h3>'
      + '<p class="muted">' + esc(scriptStatusLabel(sc)) + ' · Version ' + ((sc.versions || []).length + 1) + ' (working copy)</p>'
      + '<label class="ss-lab ss-wide">Premise <textarea id="ss-e-premise" rows="2" maxlength="600">' + esc(sc.premise || "") + '</textarea></label>'
      + '<label class="ss-lab ss-wide">Song placement <input type="text" id="ss-e-song" maxlength="120" value="' + esc(sc.song || "") + '"></label>'
      + '<label class="ss-lab ss-wide">Outline <textarea id="ss-e-outline" rows="4" maxlength="6000" placeholder="The segment-by-segment outline…">' + esc(sc.outline || "") + '</textarea></label>'
      + '<div class="ss-row"><button type="button" class="btn" data-ss="gen-outline" data-id="' + esc(sc.id) + '">✨ Write the outline with Meechie AI</button>'
      + '<button type="button" class="btn ghost" data-ss="save-script" data-id="' + esc(sc.id) + '">Save</button>'
      + '<button type="button" class="btn ghost" data-ss="snapshot" data-id="' + esc(sc.id) + '">Snapshot as a version</button></div>'
      + segs
      + '<h4>🎥 Shot list</h4>' + shots
      + '<div class="ss-row"><button type="button" class="btn ghost" data-ss="shots" data-id="' + esc(sc.id) + '">Build the draft shot list</button>'
      + (sc.status === "draft" ? '<button type="button" class="btn" data-ss="approve-script" data-id="' + esc(sc.id) + '">✓ Approve this script</button>' : "")
      + (sc.status === "approved" ? '<button type="button" class="btn" data-ss="film" data-id="' + esc(sc.id) + '">🎬 Film this — hand it to Amani</button>' : "")
      + (sc.status === "handed-off" ? '<span class="muted">Handed to Amani — see the handoff queue below. Filming happens in Amani\'s pipeline; this desk never films.</span>' : "")
      + '</div></div>';
  }
  function renderHandoffs() {
    const q = (D.handoffs && D.handoffs.queue) || [];
    const rows = q.length ? q.map((h) => '<div class="ss-ep"><div class="ss-ep-head"><b>' + esc(h.code) + ' — “' + esc(h.title) + '”</b><span class="muted">' + esc(h.status) + '</span></div>'
      + '<p class="muted">Handed off ' + esc(new Date(h.at).toLocaleString()) + ' · ' + esc(h.shots || 0) + ' shots in the draft list. Amani films it in her pipeline (locked character, lip-sync takes, assembly) — the board moves when there is real filming to report.</p></div>').join("")
      : '<p class="muted">Nothing waiting. Approve a script above and tap <b>Film this</b> — it lands here for Amani\'s pipeline.</p>';
    return '<div class="card ss-card"><h3>🎬 Handoffs to Amani</h3>' + rows + '</div>';
  }
  function slotState(doc, ep) {
    if (!doc || !Array.isArray(doc.items) || !doc.items.length) return "keeper default (armed, probe-gated)";
    const it = doc.items.find((x) => x.url === ep.mediaUrl);
    return it ? "carrying " + (it.title || it.url) : "keeper default items";
  }
  function renderSched() {
    const eps = ((D.board && D.board.episodes) || []).filter((e) => e.mediaUrl);
    const rows = eps.map((e) => {
      const ok = D.fileOk[e.mediaUrl];
      const okTxt = ok === true ? "✓ the episode file is on the site" : ok === false ? "✗ the episode file is NOT on the site yet — the slot stays dark until it lands (that is the probe gate working, not a fault)" : "checking the file…";
      const can = e.premiere === "approved";
      return '<div class="ss-ep"><div class="ss-ep-head"><b>' + esc(e.id) + ' — “' + esc(e.title) + '”</b><span class="muted">' + esc(e.mediaUrl) + '</span></div>'
        + '<p class="muted">Premiere slot (8 PM): ' + esc(slotState(D.prem, e)) + '<br>Rerun slot (10 PM): ' + esc(slotState(D.rerun, e)) + '<br>' + okTxt + '</p>'
        + (can
          ? '<div class="ss-row"><button type="button" class="btn" data-ss="schedule" data-ep="' + esc(e.id) + '">' + (armed["sched-" + e.id] ? "Tap again to confirm — schedule 8 PM + 10 PM" : "📺 Schedule to 8 PM + 10 PM rerun") + '</button>'
            + '<button type="button" class="btn ghost" data-ss="unschedule" data-ep="' + esc(e.id) + '">Restore the keeper default slots</button></div>'
          : '<p class="muted">Scheduling is locked until you set this episode\'s Premiere to <b>APPROVED by Malik</b> on the board above — nothing airs without your approval.</p>')
        + '</div>';
    }).join("");
    const log = ((D.schedule && D.schedule.actions) || []).slice(-5).reverse().map((a) => '<li>' + esc(new Date(a.at).toLocaleString()) + ' — ' + esc(a.text) + '</li>').join("");
    return '<div class="card ss-card"><h3>📺 MW TV Scheduling — the 8 PM home</h3>'
      + '<p class="muted">An approved, finished episode slots into MY EMPIRE\'s daily 8 PM home with its 10 PM rerun, through the same tv/premiere and tv/rerun docs the station keeper already runs. The keeper probes the file: until the real episode file is on the site, the slot stays dark — never dead air, never a fake airing.</p>'
      + rows + (log ? '<h4>Desk log</h4><ul class="ss-list">' + log + '</ul>' : "") + '</div>';
  }

  /* ---------------- actions ---------------- */
  function readEditor(sc) {
    const p = $("#ss-e-premise"), s = $("#ss-e-song"), o = $("#ss-e-outline");
    if (p) sc.premise = p.value; if (s) sc.song = s.value; if (o) sc.outline = o.value;
    document.querySelectorAll("#ss-root textarea[data-seg]").forEach((t) => {
      const sg = (sc.segments || []).find((x) => x.key === t.dataset.seg); if (sg) sg.text = t.value;
    });
  }
  function wireEditorText() { /* textareas are read back on save/generate — nothing live-bound */ }
  async function busy(btn, fn) {
    if (!btn || btn.disabled) return;
    const old = btn.textContent; btn.disabled = true; btn.textContent = "Working…";
    try { await fn(); } catch (e) { status("⚠️ " + (e.message || e), true); }
    finally { if (btn.isConnected) { btn.disabled = false; btn.textContent = old; } }
  }
  function buildShots(sc) {
    const shots = []; let n = 0;
    (sc.segments || []).forEach((sg) => {
      const lines = String(sg.text || "").split("\n").map((x) => x.trim()).filter(Boolean);
      lines.forEach((l) => { n += 1; shots.push({ n, seg: sg.key, beat: l.slice(0, 140) }); });
    });
    return shots;
  }
  const R = (evidence, at) => ({ basis: "own", evidence, clearedBy: "owner", at, simulcast: true });
  function slotDocs(ep, at) {
    const ev = "Owner-approved finished episode of Malik's own show, scheduled from the Show Studio desk on Malik's approval (" + new Date(at).toLocaleString() + "). He is the creator and rights holder.";
    const mk = (title) => ({ id: "me-episode", kind: "show", src: "file", url: ep.mediaUrl, title, show: "MY EMPIRE", dur: ep.dur || 900, rights: R(ev, at) });
    const teaser = { id: "me-teaser", kind: "show", src: "file", url: "/media/my-empire-teaser.mp4", title: "First Look — Official Teaser", show: "MY EMPIRE", dur: 210, rights: R("Malik own show teaser, cut from his own episode footage at his request (2026-11-02).", at) };
    return {
      prem: { on: true, startMinET: 1200, progV: 1, items: [mk("MY EMPIRE " + ep.id + " — “" + ep.title + "” (8 PM)"), teaser], updatedAt: at, by: "show-studio" },
      rerun: { on: true, startMinET: 1320, progV: 1, items: [mk("MY EMPIRE " + ep.id + " — “" + ep.title + "” (10 PM Rerun)"), teaser], updatedAt: at, by: "show-studio" }
    };
  }
  function keeperDefaultSlots(at) {
    const Rr = (evidence) => ({ basis: "own", evidence, clearedBy: "owner", at, simulcast: true });
    const items = (t1) => [
      { id: "me-episode", kind: "show", src: "file", url: "/media/my-empire-ep1.mp4", title: t1, show: "MY EMPIRE", dur: 900, rights: Rr("Malik own show: his life, his music, his businesses; he is the creator and rights holder. Episode file lands on his own site media.") },
      { id: "me-teaser", kind: "show", src: "file", url: "/media/my-empire-teaser.mp4", title: "First Look — Official Teaser", show: "MY EMPIRE", dur: 210, rights: Rr("Malik own show teaser, cut from his own episode footage at his request (2026-11-02).") }
    ];
    return {
      prem: { on: true, startMinET: 1200, progV: 1, items: items("Episode 1 — Premiere Night"), updatedAt: at, by: "show-studio-restore" },
      rerun: { on: true, startMinET: 1320, progV: 1, items: items("Episode 1 — 10 PM Rerun"), updatedAt: at, by: "show-studio-restore" }
    };
  }
  async function checkFile(url) {
    try {
      const r = await fetch(url, { method: "HEAD", cache: "no-store" });
      D.fileOk[url] = r.ok;
    } catch (_) {
      try { const c = new AbortController(); const p = fetch(url, { headers: { Range: "bytes=0-0" }, cache: "no-store", signal: c.signal }); const r = await p; D.fileOk[url] = r.ok || r.status === 206; c.abort(); }
      catch (__) { D.fileOk[url] = false; }
    }
  }

  document.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-ss]"); if (!btn || !root()) return;
    const act = btn.dataset.ss;
    if (act === "stage") busy(btn, async () => {
      const ep = epOf(btn.dataset.ep); if (!ep) return;
      ep.stage = btn.dataset.to; ep.updatedAt = nowIso();
      await saveBoard(); render(); status("Board saved: " + ep.id + " is at “" + btn.dataset.to + "”.");
    });
    if (act === "open-script") { openScript = openScript === btn.dataset.id ? null : btn.dataset.id; render(); }
    if (act === "new-script") busy(btn, async () => {
      const season = Math.max(1, Math.min(5, +($("#ss-ns") || {}).value || 1));
      const epn = Math.max(1, Math.min(13, +($("#ss-ne") || {}).value || 1));
      const title = (($("#ss-nt") || {}).value || "").trim() || "Untitled Episode";
      const id = "s" + season + "e" + epn;
      if (D.scripts[id]) { openScript = id; render(); status("That episode already has a script — opened it."); return; }
      const sc = {
        id, code: "S" + season + "E" + epn, title, season, ep: epn,
        premise: (($("#ss-np") || {}).value || "").trim(), song: (($("#ss-ng") || {}).value || "").trim(),
        status: "draft", outline: "",
        segments: CLOCK.map(([k, n, s]) => ({ key: k, name: n, span: s, text: "" })),
        shots: null, versions: [], createdAt: nowIso(), updatedAt: nowIso()
      };
      await saveScript(sc);
      if (!epOf(sc.code)) { D.board.episodes.push({ id: sc.code, title, season, ep: epn, scriptId: id, stage: "script", premiere: "held", mediaUrl: "/media/my-empire-ep" + epn + ".mp4", dur: 900, notes: "New episode, born on the Script Desk. Premiere HELD until Malik approves the finished episode.", updatedAt: nowIso() }); await saveBoard(); }
      openScript = id; render(); status("Script created: " + sc.code + " — “" + title + "”. Write the outline next.");
    });
    if (act === "save-script") busy(btn, async () => {
      const sc = D.scripts[btn.dataset.id]; if (!sc) return;
      readEditor(sc); await saveScript(sc); render(); status("Saved ✓ " + sc.code + " working copy.");
    });
    if (act === "snapshot") busy(btn, async () => {
      const sc = D.scripts[btn.dataset.id]; if (!sc) return;
      readEditor(sc);
      sc.versions = [...(sc.versions || []), { v: (sc.versions || []).length + 1, at: nowIso(), outline: sc.outline, segments: JSON.parse(JSON.stringify(sc.segments || [])) }].slice(-5);
      await saveScript(sc); render(); status("Snapshot saved — " + sc.code + " now has " + sc.versions.length + " saved version(s) under the working copy.");
    });
    if (act === "gen-outline") busy(btn, async () => {
      const sc = D.scripts[btn.dataset.id]; if (!sc) return;
      readEditor(sc);
      status("Meechie AI is writing the outline for " + sc.code + "…");
      const txt = await aiWrite("Write the segment-by-segment outline for MY EMPIRE " + sc.code + " — “" + sc.title + "”.\nPremise: " + (sc.premise || "(not set — invent one that fits the season arc)") + "\nSong placement (plays once): " + (sc.song || "pick a fitting one of Malik's songs and name it") + "\nGive one short block per segment (A, Titles, B, C, D, E, F, G, H): what happens, who is in it, the joke or the turn, and end with the cliffhanger hook in H. Plain text, no markdown tables.");
      sc.outline = txt; await saveScript(sc); render(); status("Outline written ✓ Review it, then write the segments.");
    });
    if (act === "gen-seg") busy(btn, async () => {
      const sc = D.scripts[btn.dataset.id]; if (!sc) return;
      readEditor(sc);
      const sg = (sc.segments || []).find((x) => x.key === btn.dataset.seg); if (!sg) return;
      const target = (CLOCK.find((c) => c[0] === sg.key) || [])[3] || 0;
      status("Meechie AI is writing segment " + sg.key + " of " + sc.code + "…");
      const txt = await aiWrite("Write SEGMENT " + sg.key + " (" + sg.name + ", " + sg.span + ") of MY EMPIRE " + sc.code + " — “" + sc.title + "”.\nEpisode premise: " + (sc.premise || "") + "\nEpisode outline:\n" + (sc.outline || "(no outline — write this segment so it fits the bible's segment job)") + "\nSong for this episode (plays ONCE, in Segment E unless the outline says otherwise): " + (sc.song || "none set") + "\nWrite the full segment script now: " + (target ? "about " + target + " dialogue lines, " : "stage directions only, no dialogue, ") + "dialogue as NAME: line, actions in [brackets]. Keep lines short and speakable. End with the line [END OF SEGMENT " + sg.key + "]. Output ONLY the segment script.");
      sg.text = txt.replace(/\n?\[END OF SEGMENT [A-Z]\]\s*$/i, "");
      sg.cut = !/\[END OF SEGMENT [A-Z]\]/i.test(txt);
      await saveScript(sc); render();
      status(sg.cut ? "Segment " + sg.key + " written — it may have been cut off at the AI's length limit. Read the end; tap write again to redo it." : "Segment " + sg.key + " written ✓ Read it over — the words on the page are the words that get captioned.");
    });
    if (act === "shots") busy(btn, async () => {
      const sc = D.scripts[btn.dataset.id]; if (!sc) return;
      readEditor(sc);
      sc.shots = buildShots(sc);
      if (!sc.shots.length) { status("Write some segment text first — the shot list is built from the script.", true); return; }
      await saveScript(sc);
      const ep = epOf(sc.code); if (ep && ep.stage === "script") { ep.stage = "shotlist"; ep.updatedAt = nowIso(); await saveBoard(); }
      render(); status("Draft shot list built: " + sc.shots.length + " shots. Amani's pipeline confirms the final list before filming.");
    });
    if (act === "approve-script") busy(btn, async () => {
      const sc = D.scripts[btn.dataset.id]; if (!sc) return;
      readEditor(sc); sc.status = "approved"; await saveScript(sc); render();
      status(sc.code + " approved ✓ Now you can hand it to Amani with Film this.");
    });
    if (act === "film") busy(btn, async () => {
      const sc = D.scripts[btn.dataset.id]; if (!sc) return;
      if (!armed["film-" + sc.id]) { armed["film-" + sc.id] = 1; btn.textContent = "Tap again to hand " + sc.code + " to Amani"; return; }
      delete armed["film-" + sc.id];
      readEditor(sc);
      if (!sc.shots || !sc.shots.length) sc.shots = buildShots(sc);
      D.handoffs.queue.push({ id: "h" + Date.now().toString(36), scriptId: sc.id, code: sc.code, title: sc.title, at: nowIso(), shots: (sc.shots || []).length, status: "waiting for Amani" });
      await saveHandoffs();
      sc.status = "handed-off"; await saveScript(sc);
      const ep = epOf(sc.code);
      if (ep && (ep.stage === "script" || ep.stage === "shotlist")) { ep.stage = "filming"; ep.notes = (ep.notes ? ep.notes + " " : "") + "Handed to Amani from the Show Studio — filming in her pipeline."; ep.updatedAt = nowIso(); await saveBoard(); }
      render(); status(sc.code + " is in Amani's hands 🎬 It's in the handoff queue below — filming happens in her pipeline, and the board will tell the truth about where it is.");
    });
    if (act === "schedule") busy(btn, async () => {
      const ep = epOf(btn.dataset.ep); if (!ep || ep.premiere !== "approved") return;
      if (!armed["sched-" + ep.id]) { armed["sched-" + ep.id] = 1; render(); return; }
      delete armed["sched-" + ep.id];
      const at = Date.now(); const docs = slotDocs(ep, at);
      await setDoc("tv/premiere", "tv", docs.prem); await setDoc("tv/rerun", "tv", docs.rerun);
      D.schedule.actions.push({ at: nowIso(), text: "Scheduled " + ep.id + " (“" + ep.title + "”) to the 8 PM premiere + 10 PM rerun slots." });
      await saveSchedule();
      ep.stage = "scheduled"; ep.updatedAt = nowIso(); await saveBoard();
      await loadAll(); render();
      status(ep.id + " scheduled ✓ It airs at 8 PM + 10 PM once the episode file is on the site — until then the keeper keeps the slot dark.");
    });
    if (act === "unschedule") busy(btn, async () => {
      const ep = epOf(btn.dataset.ep); if (!ep) return;
      const docs = keeperDefaultSlots(Date.now());
      await setDoc("tv/premiere", "tv", docs.prem); await setDoc("tv/rerun", "tv", docs.rerun);
      D.schedule.actions.push({ at: nowIso(), text: "Restored the keeper default premiere/rerun slots (desk schedule for " + ep.id + " removed)." });
      await saveSchedule();
      if (ep.stage === "scheduled") { ep.stage = "approval"; ep.updatedAt = nowIso(); await saveBoard(); }
      await loadAll(); render(); status("Keeper default slots restored.");
    });
  });
  document.addEventListener("change", (e) => {
    const sel = e.target.closest("[data-ss-prem]"); if (!sel || !root()) return;
    const ep = epOf(sel.dataset.ssPrem); if (!ep) return;
    ep.premiere = sel.value === "approved" ? "approved" : "held"; ep.updatedAt = nowIso();
    saveBoard().then(() => { render(); status(ep.id + " premiere is now " + (ep.premiere === "approved" ? "APPROVED — scheduling unlocked below." : "HELD — it will not air.")); })
      .catch((err) => status("⚠️ " + (err.message || err), true));
  });

  /* ---------------- boot ---------------- */
  async function open() {
    if (!admin) { render(); return; }
    if (rendering) return; rendering = true;
    try {
      await loadAll();
      await ensureSeeds();
      render();
      // truthful file checks for the scheduling panel (probe-gated slots)
      const eps = (D.board.episodes || []).filter((x) => x.mediaUrl && D.fileOk[x.mediaUrl] === undefined);
      for (const ep of eps) { await checkFile(ep.mediaUrl); }
      if (eps.length) render();
    } catch (e) { status("⚠️ " + (e.message || e), true); }
    finally { rendering = false; }
  }
  /* Admin confirmation (fixed 2026-11-03): the desk used to read
   * window.MW_CF_ADMIN exactly once, after cf-client's page-load
   * `checked` promise. That flag is written ONLY by the one
   * refreshSession call cf-client makes when it first evaluates — so
   * a single transient auth/session failure at load, or a sign-in
   * that landed after cf-client evaluated (the sign-in paths never
   * set the flag), left the desk dark for the whole page session
   * while the rest of the site still saw the owner fine (owner.js
   * confirms admin through the admins table, via platform.js). The
   * desk now confirms the same way the site does, and keeps
   * confirming: the flag, a fresh refreshSession, then the admins
   * table itself — retried on a short schedule, on every auth
   * change, and whenever the MW TV / studio views are entered. The
   * button stays hidden until a server-backed check says admin;
   * the server-side owner-only write rails stay the real fence. */
  let confirming = false, adminTries = 0, lastConfirmAt = 0;
  async function confirmAdmin() {
    if (admin || confirming) return admin;
    confirming = true; lastConfirmAt = Date.now();
    try {
      if (window.MW_CF_ADMIN) admin = true;
      if (!admin) {
        try { const cf = window.MW_CF && MW_CF.createClient(); if (cf && cf.auth && cf.auth.refreshSession) await cf.auth.refreshSession(); } catch (_) {}
        if (window.MW_CF_ADMIN) admin = true;
      }
      if (!admin) {
        try {
          const cf = window.MW_CF && MW_CF.createClient();
          const s = window.MW_CF && MW_CF.session();
          const uid = s && s.user && s.user.id;
          if (cf && uid) {
            const r = await cf.from("admins").select("user_id").eq("user_id", uid).maybeSingle();
            if (r && r.data) admin = true;
          }
        } catch (_) {}
      }
    } catch (_) {}
    confirming = false;
    if (admin) { reveal(); if (isStudioOpen()) open(); }
    return admin;
  }
  function confirmAdminSoon() { if (!admin && Date.now() - lastConfirmAt > 2500) confirmAdmin(); }
  function retryAdmin() {
    if (admin || adminTries >= 6) return;
    const wait = [1200, 3000, 6000, 12000, 20000, 30000][adminTries];
    adminTries++;
    setTimeout(() => { confirmAdmin().then(retryAdmin); }, wait);
  }
  async function init() {
    try { if (window.MW_CF && MW_CF.checked) await MW_CF.checked; } catch (_) {}
    await confirmAdmin();
    // the session may land after this module: re-confirm on auth changes
    try {
      const cf = window.MW_CF && MW_CF.createClient();
      if (cf && cf.auth && cf.auth.onAuthStateChange) cf.auth.onAuthStateChange((evt) => {
        if (evt === "SIGNED_OUT") { admin = false; const b = $("#tw-studio-btn"); if (b) b.hidden = true; return; }
        confirmAdmin();
      });
    } catch (_) {}
    retryAdmin();
    reveal();
    if (isStudioOpen()) open();
  }
  function isStudioOpen() { const s = $("#v-showstudio"); return !!(s && !s.hidden); }
  function reveal() {
    if (!admin) return;
    const b = $("#tw-studio-btn"); if (b) b.hidden = false;
  }
  // the view can open after this module loads (lazy) or before (hash entry):
  // open the desk on each ENTRY into the view (fresh data), never mid-edit.
  let wasOpen = false;
  const mo = new MutationObserver(() => {
    const openNow = isStudioOpen();
    if (openNow && !wasOpen) {
      if (admin) { booted = true; open(); }
      else { render(); confirmAdminSoon(); } /* entered cold: show the lock card, take a fresh admin look */
    }
    if (!admin && document.body && (document.body.dataset.view === "mwtv" || document.body.dataset.view === "showstudio")) confirmAdminSoon();
    wasOpen = openNow;
  });
  if (document.body) mo.observe(document.body, { attributes: true, subtree: true, attributeFilter: ["hidden", "data-view"] });
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init); else init();
})();
