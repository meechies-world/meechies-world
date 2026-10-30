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

| Asset | Budget | Measured (Phase 1b) |
|---|---|---|
| Core JS (`js/core.js`), transfer (gzip) | **< 60 KB** | **8.6 KB** |
| Shell total first load (HTML + shell CSS + core JS), gzip | report-only | 27.9 KB |
| Home view lazy payload (its CSS + JS), gzip | report-only | 13.0 KB |

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
  js/views/home.js      the home view (parity module)
  js/views/placeholder.js  brand-styled "under construction" for the
                        views that land in later phases
  harness/check.mjs     syntax + byte-budget + inventory checks
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
- [ ] **Phase 2 — viewer surfaces first:** Radio stage, MW TV, mini,
      Watch render, arrival pop-out — the one shared player engine on the
      shared `radio/dj` state (read path first)
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
