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
  js/views/placeholder.js  brand-styled "under construction" for the
                        views that land in later phases
  harness/check.mjs     syntax + byte-budget + inventory checks + the
                        Phase 2 engine fixtures (42 assertions)
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
- [ ] **Phase 3 — the Book + social core** (feed, friends, messages,
      chat, clips)
- [ ] **Phase 4 — the booth** (the DJ station, Watch control side,
      battles, Go Live Studio) on the typed state layer
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
