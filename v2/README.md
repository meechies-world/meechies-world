# Meechie's World — the v2 rebuild

The clean rebuild of Meechie's World, built **beside** the live site (never
instead of it) under the Parity Standard — **Law 0** of the MAP
(`~/workspace/website/site-map/MAP.md`): the rebuild must **look the same**
and **do what the current site is supposed to do**. A difference in look is
a defect unless the owner approves it; a difference in behavior is allowed
only as an explained restoration of intent.

- **Live site:** untouched. Everything in this directory is additive; no
  file outside `v2/` changes on the rebuild branch.
- **Test address:** the `rebuild` branch's Cloudflare Pages preview —
  `https://rebuild.meechies-world.pages.dev/v2/` (per-branch previews:
  `https://<branch>.meechies-world.pages.dev/v2/`).
- **Data:** the rebuild reads the **same live backend** (`/api/cf/*`,
  `/api/station`, the shared `radio/dj` station document) and the **same
  session** (`localStorage["mw-cf-session"]`, Bearer). No forked data, no
  new backend, no second source of truth — ever (MAP §4.4).
- **Cutover** (MAP §5 Gate T): only after a literal side-by-side "test the
  2" passes and the owner gives his explicit go. A cutover is not a PR.

## Architecture rules (MAP §4, as build rules)

1. **Fast core shell, per-view code split (§4.1).** The shell — boot,
   router, session, app modes, entry greeting, guest wall, global chrome,
   design system — is the only always-loaded code. Views are modules,
   loaded by the router **only when first entered**. No view may pay for
   another view's code (the audit found the DJ booth was ~half of all JS
   and parsed on every page; that structure is what this fixes).
2. **View module contract (§4.2).** A view module exports `render(root,
   ctx)` and optional `destroy()`. `ctx` = `{ session, gateway, presence,
   view }` is the only door a view gets: no view touches `localStorage`
   session keys, raw `fetch` to the cf API, or station state directly.
   A view's CSS ships in its own file and loads with the view.
3. **One shared player engine (§4.3).** Radio stage, MW TV, mini, Watch
   render, and arrival pop-out are ONE engine with surfaces, built once
   (Phase 2). Station state writes go through one typed layer over the
   `radio/dj` document — the six legacy writer families never reappear.
4. **The cf gateway is the one data door (§4.4).** All record access goes
   through the `/api/cf` gateway (core's `Gateway.rest/readDoc`); feature
   endpoints stay thin wrappers. Clients never invent a second session
   shape: `mw-cf-session` + `Authorization: Bearer <token>`, identical to
   the live site, is the whole contract.
5. **First-load performance (§4.5).** Size is a feature. Fonts load with
   `fonts.gstatic.com` preconnected. Media is poster-first and
   viewport-lazy. JS is cache-stamped by content epoch like today.
6. **App modes (§2.3/§4.6).** The 14 `?app=` modes, their ids, and each
   mode's default tab set do not change. In app mode visitors browse the
   whole site — no guest wall — and radio/ai modes hold a wake lock.

## Boot budget

| Asset | Budget | Measured |
|---|---|---|
| Core JS (`js/core.js`), transfer (gzip) | **< 60 KB** | **8.5 KB** (Phase 2; 8.6 KB at Phase 1b) |
| Shell total first load (HTML + shell CSS + core JS), gzip | report-only | 27.8 KB (27.9 KB at Phase 1b) |
| Home view lazy payload (its CSS + JS), gzip | report-only | 13.0 KB |
| Phase 2 viewer payload (engine + feed + mini + 3 views + 4 CSS), gzip | report-only | 46.7 KB — **lazy: loads only when a viewer view is first entered; Home never pays for it** (the harness asserts Home and the shell never import it) |

For scale, the live site's first load is ≈ 2.1–2.5 MB: a 180 KB HTML file,
45 JS files (~478 KB transfer, the booth included on every view), ~100 KB
CSS. Run `node v2/harness/check.mjs` from the repo root to re-measure and
re-check syntax any time.

## Preview

- After this lands on the `rebuild` branch: open
  `https://rebuild.meechies-world.pages.dev/v2/`.
- Locally: serve the repo root with any static server and open
  `/v2/`. API calls (`/api/cf/*`, `/api/station`, `/api/store`) only answer
  on the real Pages deployment, so live-data fills (station bar, presence
  chip, shop strip) light up on the preview address, not on localhost.
- Presence note: the shell pings `/api/station` like any visitor, with a
  shell-scoped `cid` (`v2…`), so test-address visits appear in presence as
  themselves — same as the live site's own behavior for any guest.

## Layout

```
v2/
  index.html            the shell document (chrome markup is the live
                        site's own, verbatim; views mount into #view-root)
  css/shell.css         live rules for exactly the shell's selectors,
                        verbatim, in live load order + the live inline
                        blocks (accents, gate, app-mode, appnav chrome)
  css/home.css          the home view's rules (live files + the live
                        #home2-styles / #mw-refresh-styles home rules,
                        scope renamed #v-home -> .view-home)
  js/core.js            boot, app modes, session, gateway, presence,
                        registry + hash router, chrome, greeting, wall
  js/station.js         the station feed: ONE subscription to the shared
                        radio/dj doc (changes-feed poll + safety re-read),
                        the broadcast clock offset, and every pure
                        state helper (vmix targets, stage gains, clocks)
  js/engine.js          THE player engine (MAP §4.3): screens, slots,
                        blends, the NO-SKIP cushion + stall masking +
                        heal ladder, warm pre-buffering, quality caps,
                        the share watcher (RealtimeKit/HLS), one
                        sounding screen, the 700ms surface cadence
  js/mini.js            the MASTER mini: pure gate math (miniStep /
                        miniPost) + the box controller (drag, resize,
                        camera overlay)
  css/engine.css        the shared screen system (.vstage family,
                        transitions, FX, the mini, the ON AIR lamp) —
                        injected by the engine on first screen creation
  css/radio.css         the radio view's rules (on-air card, station card)
  css/mwtv.css          MW TV's rules (fullscreen shell, chrome hidden)
  css/watch.css         Watch the Setup's rules (spectator booth geometry,
                        upsell modals)
  js/views/home.js      the home view (parity module)
  js/views/radio.js     the Radio view: on-air card + station card +
                        the station stage (an engine surface)
  js/views/mwtv.js      MW TV: the fullscreen TV channel (engine surface)
  js/views/watch.js     Watch the Setup: the booth rendered read-only
                        from state (engine surface + the upsell)
  js/social.js          the social data layer (Phase 3): the live
                        platform ops over the shell gateway (docs store
                        reads/writes, the dms table, uploads with the
                        convert-first video rule), a changes-feed bus
                        with rooms, the member directory, the follows /
                        friends stores — plus every pure rule exported
                        bare for the harness (feed ranking, the count
                        rules, the DM tag protocol, story grouping,
                        the clip filter)
  js/views/community.js Meechie's Book: the Facebook-look feed (posts,
                        reactions, replies, composer, stories, PYMK,
                        filter bar, notifications, FB chrome + rails)
  js/views/friends.js   Friends: mutual-friends tabs, find-by-email,
                        friends' posts (live js/friends.js port)
  js/views/messages.js  Messages: DM list + threads, groups, reactions,
                        quotes, vanish, walkie-talkie voice (live
                        js/messages.js port)
  js/views/chat.js      Chat: the four rooms over chat/<ch>/msgs with
                        lobby-room presence
  js/views/clips.js     Clips: the snap feed over video posts + posting
  css/book.css          the Book's live rules: css/app.css extraction +
                        the fb-feed / fb-feed-plus / stories /
                        book-plus injected blocks, verbatim
  css/friends.css       the friends.js injected block + the .chip rule
  css/messages.css      the messages.js injected block (minus the
                        site-wide #mx-fab rules) + a thread addendum
  css/chat.css          the chat rules from css/app.css
  css/clips.css         the clips.js injected block, verbatim
  js/views/placeholder.js  brand-styled "under construction" for the
                        views that land in later phases
  harness/check.mjs     syntax + byte-budget + inventory checks + the
                        Phase 2 engine fixtures (42 assertions) + the
                        Phase 3 social fixtures
```

## Phase checklist (MAP §5)

- [x] **Phase 0 — THE MAP** (delivered; corrections C1–C8 applied)
- [x] **Phase 1a — verification pass** (`PHASE1-VERIFY.md`)
- [x] **Phase 1b — core shell + home** ← this PR
  - [x] Shell boot under the 60 KB JS transfer budget (8.6 KB measured)
  - [x] Hash router with per-view lazy loading (`import()` on first entry)
  - [x] Session against the live auth/API — same key, same Bearer pattern
  - [x] App-mode aware frame (14 modes, slim app bar, wake lock)
  - [x] Entry greeting (once per visit, never on MW TV) + 5-minute guest
        wall (defers on MW TV) — core-owned per MAP §4.1
  - [x] Header, phone bottom bar + More sheet, announce bars, footer
  - [x] Home view with visual parity; all other views placeholder modules
  - [x] Harness: syntax check + byte report; zero files outside `v2/`
- [x] **Phase 2 — viewer surfaces first:** Radio stage, MW TV, mini,
      Watch render, arrival pop-out — the one shared player engine on the
      shared `radio/dj` state (read path first) ← this PR
  - [x] One player engine (`js/engine.js`) — every viewer surface is a
        consumer; no surface carries its own player code
  - [x] NO-SKIP from the first commit: the live #404 HLS cushion values,
        the #408 mask/heal behavior (a masked player is COVERED by the
        poster/slate, never a black iframe; flap-tolerant mask lift;
        honest chips), warm muted pre-buffering, quality caps
        (480 stage/mini, 720 Watch/MW TV)
  - [x] The mini with the #410 lessons built in: renders even while
        hidden, durable play proof, bounded 20s proof gate, 18s clean-
        change grace, bounded 15s buffer step-aside
  - [x] The share leg as the takeover source (RealtimeKit stage-join +
        HLS fallback + polling watcher), viewer pause viewer-only,
        pop-out rules (after the greeting, once per meeting, never
        when hidden)
  - [x] Watch the Setup renders the booth layout from state, read-only;
        control attempts open the upsell with the MAP Law 12 prices
  - [x] Harness fixtures: cushion values, sync-lock thresholds, mask
        cover + flap lift, blend follow, every mini gate
- [x] **Phase 3 — the Book + social core** (feed, friends, messages,
      chat, clips) ← this PR
  - [x] One shared social data layer (`js/social.js`) — every social
        view reads/writes the SAME live backend the site runs today
        (docs store, the `dms` table, KV uploads), so a post made in
        v2 is visible on the live site and vice versa; zero new
        backend, zero forked data
  - [x] The Book with the owner's rules intact: like counts under 25
        hidden, comment counts under 3 hidden (Law 11), feed rank
        (announce > sponsored > following), trending, reactions,
        stories (24h), PYMK, saved/hidden/search filters — all ports
        of the live code paths
  - [x] Friends (mutual lists, requests, find-by-email fingerprints,
        friends' posts), Messages (the ⟦tag⟧ body protocol, groups,
        reactions, quotes, vanish, hold-to-talk walkie), Chat (four
        rooms + lobby presence), Clips (snap feed + convert-first
        posting)
  - [x] Harness: social payload byte report + isolation asserts
        (Home and the viewer views never import the social layer) +
        fixtures for feed ordering, the count rules at 24/25 and 2/3,
        cleanRow, the DM protocol + thread grouping, story grouping,
        the clip filter, socUrl
- [x] **Phase 4 — the booth** (the DJ station, Watch control side,
      battles, Go Live Studio) on the typed state layer
  - [x] Typed write layer (js/djstate.js): the live save discipline
        (corpse guard, 250 ms debounce, SANDBOX sessionStorage-only,
        mirror pad-hit-only writes), mwLeadLock claim/renew/take with
        the row-version base, guest-DJ relay, brain capture batching
  - [x] Audio half (js/djdecks.js): the master polish chain + sends
        under the broadcast caps, file decks with the CORS swap, the
        YouTube shim (honest seeking, muted-rescue loan), fader law
        levels; this closes Phase 2 gap 1 (v2 listeners hear file
        decks through the same chain rules)
  - [x] The booth view (js/views/dj.js) at layout-as-data parity
        (LAYOUT export: top zone, A B | X | C D, the shipped
        below-decks panel order), transport + gentle load, queue
        stocking/draws, autoNext with stocked rotation + preload fast
        path + 4-attempt roll, fader settle/follow guard, the stall
        watchdog, the dead-air rescue, voice drops, per-deck pads,
        BRAIN panel + AI-DJ C2 (S.aiDj toggle + robot stock readout),
        Door, REPORTS, guest-DJ grants, Battles, MIDI, SANDBOX
  - [x] Share publishing (js/djshare.js): switch-first publish order,
        the 2 s proof supervisor, Hide Share, source swap while
        hidden, tables-pause for screen shares, sanctioned endings
  - [x] Harness: booth payload byte report + isolation asserts (no
        other view imports the booth layer) + fixtures for layout
        order, lead-lock rules, FX caps, queue draw, stock records,
        automation windows, drop cadence, the watchdog ladder, the
        dead-air gate, booth mergeState defaults
- [ ] **Phase 5 — commerce & the rest** (shop, coin/games, jobs, ads,
      services, legal, apps)
- [ ] **Phase 6 — Gate T "test the 2"** + cutover (owner's explicit go)

## Home parity notes (vs live `#v-home` at main `1be5b8fe`)

Same sections, same order, same copy, same assets, same classes:

lux hero → live-station bar → "Everything in one world" jump grid →
"right now" strip → featured video → crest hero → ticker → lux wall →
stats → launchpad paths → Originals card → TikTok card → divisions
bento → support card → roadmap.

Live-data fills wired: station bar + NOW ON AIR (shared `radio/dj` doc),
ONLINE NOW (`/api/station`), FRESH IN THE SHOP (`/api/store`).

Deliberate gaps in this phase (all noted, none silent):

- The **support pay card** renders hidden, exactly as on the live site
  today (the live card is gated on the pay box being configured). One
  brief description of home mentioned a "books strip" and a "Pay" box —
  on the live site those live in **Services**, not Home; Home is
  reproduced as it actually is (Law 0).
- The **Originals row** and **TikTok grid** render their live pre-JS
  states (empty row / "Loading Meechie's TikToks…"); their data modules
  are later phases.
- The **gate** (guest wall) is the live dialog verbatim; its sign-in
  actions hand the visitor to the main site in this phase — the session
  is shared, so they come back signed in everywhere. The native auth UI
  rebuild is a later core increment.
- The **announce bars** render hidden; painting them from their docs is a
  later core increment.
- No global **player bar** yet — it arrives with the Phase 2 player
  engine. (On the live site it is hidden until music plays.)
- Brand assets (posters, lux strip, crest) load from the site's existing
  absolute paths — the WebP diet variants from the speed audit are a
  live-site build, not duplicated here.

## Phase 2 parity notes (vs live viewer surfaces at main `1be5b8fe`)

Evidence basis: **code-level comparison** against the live sources at
`1be5b8fe` (dj.js / obs.js / index.html / css/app.css) plus the harness
fixtures. A live page-load side-by-side ("test the 2") is Gate T work
(Phase 6) and is not claimed here.

**LOOK — no differences in scope.** The station stage, MW TV, Watch and
mini markup, classes, copy and posters (radio poster on the stage and
Watch, TV poster on MW TV — Law 9) are ported from the live code.
Flagged, phase-shaped only:

- The Radio view is **shorter** than live: the Library/player, requests
  card, apps/poll/offline cards, the LIVE DJ SET banner strip, the four
  mode buttons (Blackout/Bubble/Capture/Hide) and the request /
  Pick-a-Song forms are later phases (several are write paths or booth
  surfaces). Nothing is redesigned; the on-air card keeps its live
  two-column row, its second column awaiting the requests card.
- MW TV's chrome-hiding rules point at the v2 shell's own chrome; the
  visual result is the live one — the TV screen and nothing else.
- The Watch plans modal carries one extra sentence in its trial note
  slot when a signed-in member has no trial yet (see BEHAVIOR gaps).

**BEHAVIOR — intent carried in from the start (not rediscovered):**

- NO-SKIP is engine law from the first commit (Law 3): the exact live
  HLS cushion config, stall masking that COVERS the masked slot with
  the poster/slate, the flap-tolerant 800ms-accumulated mask lift, the
  split heal counters, warm muted pre-buffering (Law: parity with
  PRs #404/#408).
- The mini embodies the #410 lessons structurally: its render is
  decoupled from its visibility, play proof is stamped durably, the
  proof gate is bounded, the buffer step-aside is bounded.
- One sounding screen, share takeover, viewer-pause-is-local (Laws
  1–2); Watch renders layout from state with zero control hooks and
  the verbatim upsell (Law 12); slates never assert station state
  before the first snapshot lands.

**BEHAVIOR — flagged gaps (each deliberate, each with an owner):**

1. **Listener audio for file decks is not in Phase 2.** v2 viewers hear
   the video mix's sound and the share's sound. The station's
   audio-only tracks (the WebAudio deck chain, voice drops) have no v2
   listener playback yet — that is the station module's audio half,
   next station phase.
2. **View sections unmount on navigation**, so the station stage
   screen stops when the visitor leaves Radio (the mini persists once
   armed). Live keeps hidden sections mounted. A persistent-stage /
   global-player-bar decision is owed before Gate T.
3. **The mini and the share pop-out arm on first entry to a viewer
   view** (Radio / MW TV / Watch), not at page boot — the direct
   consequence of the engine being lazy (MAP §4.5). After arming, the
   mini persists across the whole tab session, as on live.
4. **Presence `listening` is local-only in v2**: the shell's ping does
   not yet send the `l=1` flag, so `/api/station` listening counts do
   not include v2 listeners until a core increment teaches Presence
   the flag.
5. **Watch trial START is deferred** (read-path scope): an existing
   trial paints correctly ("✅ Trial on" + the live note); starting
   one from v2 shows an honest note in the modal instead of writing
   the member doc. The free-basic button routes to the DJ view, whose
   Playground is a later phase.
6. **The Live view (OBS) surface is deferred**: OBS playback rides the
   same HLS cushion, and the engine ships the shared
   `attachHls`/`detachHls` primitive the Live page will consume — but
   the Live PAGE (rooms, chat, gifts) is MAP Phase 4, so the view
   stays a placeholder rather than growing a second player.
7. **Feed latency**: the feed polls the public changes feed every
   2.5s (a `radio/dj` change row triggers an immediate full re-read)
   with a 30s safety re-read, vs live's snapshot listener. Near-push
   in practice; noted so Gate T can measure it.
8. **mixVol is fixed at 1** (no global player bar yet — see the Phase
   1b gap above); ducking follows `S.duck` only.
9. **Every seat in v2 is a viewer seat this phase** — there is no
   booth in v2 until the booth phase, so the owner browsing v2 gets
   the viewer surfaces. His live booth is untouched.

## Phase 3 parity notes (vs live social surfaces at main `1be5b8fe`)

**Evidence basis, stated honestly**: code-level comparison against the
live sources (js/app-core.js, fb-feed.js, fb-feed-plus.js, stories.js,
book-plus.js, friends.js, messages.js, clips.js, social.js,
profile-setup.js, email-find.js, platform.js, cf-client.js) plus the
harness fixtures in section 5. A page-load side-by-side is Gate T's
job (Phase 6), not claimed here. Byte evidence: the shell's first
load is unchanged (27.7 KB gzip total); the whole social payload is
199.9 KB raw / 60.7 KB gzip and loads only on the first social view
(Book entry: 33.7 KB gzip; Messages 25.2; Friends 16.2; Clips 15.1;
Chat 14.1 — the shared layer is paid once per session).

**LOOK differences** (defects unless owner-approved — each one is a
consequence of the shell's shape, flagged for Gate T):

1. **The Facebook chrome lives inside the Book view in v2.** On the
   live site #fb-top / #fb-tabs / #fb-left / #fb-right are body-level
   furniture the owner's rule puts on EVERY view. The v2 shell lets a
   view own only its own section (core.js changes are registry-lines
   only by program rule), so in v2 the chrome renders with the Book
   and leaves with it. Same markup, same styles, same behavior —
   different lifetime. Promoting it to shell furniture is a small
   core increment whenever the owner wants it.
2. **The Book's contacts rail reads the shell presence feed**
   (/api/station's named users + counts) instead of the live rail's
   friend list, and the fb-top radio button navigates to the Radio
   view (live toggles play inline — the engine is not loaded on the
   Book). The fb-top message/radio count badges and the floating
   Messenger fab + chat heads are site-wide chrome from the same
   live surfaces; they arrive with the shell-chrome work, not this
   phase.
3. **Messages thread furniture uses the live values under module
   class names** (.dm-thead for the live .dm-head, .mx-row/.mx-msg
   bubbles carrying the live .mx-bub colors) — the injected live
   stylesheet keys its bubbles to a column wrapper the module does
   not reproduce. Side-by-side at Gate T will judge it.

**BEHAVIOR differences** (each an intent-restoration or a named gap):

1. **INTENT-RESTORATION — DM photo/voice bubbles render today's
   uploads.** The live bubble reader only matches the retired
   Supabase storage URL inside `🎙️ Voice message ⟦…⟧` /
   `📷 Photo ⟦…⟧` bodies, so a photo or voice note sent from the
   CURRENT live site (which uploads to this site's own /m/media/)
   displays as raw bracket text there. v2's reader accepts both
   forms; the send format is byte-identical, so data interops both
   ways and the live site is untouched.
2. **Profile pages are not in this phase.** Avatar/name clicks
   (data-profile on live) are inert in v2, the fb-top profile button
   takes live's own fallback (Friends), and the Book's Edit profile
   covers the app-core fields (name, bio, photo, store links) — the
   full profile surface (profile pages, the profile-setup designer
   with socials/phone/colors) is its own later module. The daily
   coin check-in card (#daily-card) likewise waits for the coin
   phase; the 🎁 Gift button is present and says so on tap.
3. **Messages "Active now" comes from the shell presence feed**
   (35-second /api/station window) instead of live's lobby-room
   peers; typing indicators ride the same changes-feed room
   protocol as live (1:1 only, as live). Chat presence uses the
   room protocol exactly as live.
4. **Smaller faithful-by-construction notes**: the `#post-<id>`
   deep link the ⋯ menu copies points at the live site (the v2
   router does not claim that hash yet; Clips' 💬 button hands the
   post to the Book through sessionStorage instead); story replies
   and reactions are DMs, exactly as live; group ids are minted in
   live's `g…` shape; local prefs (mw_saved_posts, mw_hidden_posts,
   mw_story_seen, mw_fb_seen, mw_mx_prefs) share the live keys, so
   they carry over on the same device.

## Phase 4 parity notes (vs live booth at main `ebc7da70`)

Evidence basis: full code-level comparison against live dj.js @
ebc7da70 (8,227 lines, read in full during this phase's research) +
the harness fixtures pinning the pure logic to the live constants.
**Gate T is the live side-by-side and has NOT been run for the
booth** — nothing here claims it. The booth drives the SAME shared
radio/dj doc through the same /api/cf write path the live booth's
facade uses, with the same _lead claim payload, so a v2 booth and a
live booth coexist on one station under the one-leader rule.

**LOOK differences** (defects unless owner-approved):

1. **None in the booth's own furniture.** The booth stylesheet is
   the live booth's injected stylesheet extracted mechanically
   (css/dj.css — including PR #413's mini cure and the Law 22
   touch-action:pan-y owner rules), and the markup reproduces the
   live structure/id set: banner → station card → top bar → setups →
   master screen → edit panel → browser band (moved above the decks
   at build, as live) → A B | X cluster | C D → below-decks grid in
   the shipped panel order. The X cluster is rendered in the top
   zone and moved into .dj-decks before deck C, exactly live's move.
2. **Pair crossfaders have no visible slider** (same as the shipped
   live xfbar, whose visible controls are the VOL knobs + X pad):
   in v2 they are dragged horizontally on the pairwave canvases.
   Gate T should confirm whether the live booth exposes another
   pair-fader surface this build did not reproduce.
3. **The station card inside the DJ view is compact** (poster +
   slate, no engine screen of its own) so it cannot fight the
   booth's master screen for the engine's one stage slot; the full
   member stage lives on the Radio view, as Phase 2 shipped it. On
   the live site the card and the booth share one view; Gate T
   judges whether the split is acceptable.

**BEHAVIOR differences** (each an intent-restoration or a named gap):

1. **INTENT-RESTORATION — Law 22 by construction, fixture-pinned.**
   The v2 booth installs no wheel handlers and no scroll listeners
   anywhere in the booth layer (fit runs on resize only; the one
   audio-wake pointerdown listener is passive). Every booth drag —
   X pad, pairwave faders, the platter — runs through one pure
   gesture classifier (`classifyDrag`, exported from the view):
   vertical-dominant movement is a page scroll and is released to
   the page (the surfaces are `touch-action:pan-y`, so the browser
   itself takes the scroll over), a control engages only on a
   deliberate horizontal-dominant drag of itself, and the platter
   scratches only as that deliberate disc drag — never as a scroll
   side-effect. One marked deviation from the pure CSS extraction:
   a Law 22 patch block at the end of css/dj.css gives booth range
   inputs `touch-action:pan-y` (the extracted sheet leaves sliders
   at `touch-action:none`, so a scroll starting on a slider would
   have grabbed it). The harness pins all of it: classifier cases
   (scroll / wait / engage / stays-engaged), static asserts that no
   scroll or wheel listener exists in the booth sources, the
   passive wake listener, and the pan-y rules for platter, X pad,
   waveform and sliders. (The live-side Law 22 fix is its own PR
   on main.)
2. **NAMED GAP — Go Live Studio crop pipeline.** The publisher
   ships the full switch-first order, proof supervisor, Hide Share,
   source swap, tables-pause and sanctioned endings, but publishes
   the RAW screen track: the live canvas-crop frame (vsCropStart)
   and the studio crop panel are not ported yet. The separate
   golive.js OBS/RTMPS surface stays with Phase 5, as Phase 2
   deferred the Live surface there.
3. **NAMED GAP — Dailymotion/Vimeo deck tokens.** vparseTok still
   parses dm:/vm: tokens and state carries them, but only YouTube
   gets a deck shim in v2; a dm:/vm: load reports it would not load
   instead of mounting a player. (Dailymotion is OFF in the live
   booth's own state today.)
4. **NAMED GAP — library source.** The booth's fallback library bag
   is the Free Shelf + the keeper's S.pool until the shell's tracks
   feed is wired as a module (Phase 5); live's TRACKS() reads a
   shell global. Pool picks resolve through the Archive exactly as
   live (iaSearch/iaFile ported verbatim).
5. **NAMED GAP — smaller pieces.** SETUPS preset values other than
   Loud & Clear (whose keep-mix rule is honored: presets never touch
   crossfaders or deck volumes) are reasonable values, not extracted
   constants; the horn STAMP lands on automated transitions when
   S.hornOn === true but the local stab synth is not ported (horns
   are OFF by the owner's 2026-10-29 law, so the silent default
   matches his station today); voice-drop text plays through
   /api/ai TTS with a speechSynthesis fallback; Camera Pro is the
   compact looks/banner subset; the battle panel starts/ends and
   ticks the server advance, while the per-turn performance push is
   the battle surface's own later pass; session video records via
   display capture to a download (live's post-as-Latest-Show upload
   is not ported); the swap bar keeps his deck order and says so
   instead of moving decks.
6. **SANDBOX parity.** ?playdj=1 renders the full booth, persists
   only to sessionStorage (mw-playdj), guest-relays when a slot is
   live, and never writes radio/dj or the brain — the same walls as
   live, enforced inside djstate.save/brainEmit rather than by
   checks scattered through the view.
