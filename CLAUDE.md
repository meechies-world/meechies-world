# Instructions for any AI (Claude, ChatGPT/Codex, Gemini, Copilot, Cursor…) working on this site

This is the website and app for **Meechie's World Inc** (owner: Daryl "Meechie" Goodall). It's live at https://meechiesworldinc.com.

## How the site works
- Plain HTML, CSS and JavaScript. There's no build step: `index.html` plus files in `js/`, with pages and functions in `functions/`.
- Hosting is **Cloudflare Pages** (free). Every merge to `main` deploys automatically in about a minute.
- Accounts, posts and messages live in **Supabase**, project `yjouaysczttqbytksejq`, on the free plan. Settings are in `js/config.js`.
- Media is served through the Cloudflare cache relay at `/m/<bucket>/<path>` (`functions/m/[[path]].js`, `js/media-cdn.js`). Keep using it so Supabase stays inside its free data limit.
- The `docs` table is readable by everyone. **Never put private member data in `members/<uid>`.** Private fields (a private phone, for example) go in auth `user_metadata`. Direct messages go in the `dms` table, which only the sender and recipient can read.
- `js/outage.js` keeps the site open in guest mode when Supabase is down. Don't remove it.
- When you change a script, bump its `?v=` number in `index.html` so phones load the new copy.
- `version.json` "build" and `<meta name="mw-build">` in `index.html` must always be the same number. Change both together or neither (a mismatch made the site reload itself every few seconds, Oct 27 2026).

## How to make a change
1. Make a branch, edit, and test on a phone-sized screen (390px wide).
2. Open a pull request, then merge it to `main`. Cloudflare deploys it.
3. Keep changes small, one feature per pull request.

## The owner's rules (always follow these)
- **Stay free.** Don't add anything that costs money without asking him first.
- Don't interrupt the live site. Don't delete member data without his OK.
- Never commit passwords, API keys, tax IDs, SSN or EIN. Secrets go in Cloudflare/Supabase settings, and he enters them himself.
- No LV-letter or other brand-copy designs. Don't change his book cover. No fake engagement numbers.
- The site's AI coder (Edit site → 🛠 AI coder) is on at the owner's request (Oct 2026). It only opens pull requests with a preview; the owner merges them.
- Ask before sending any email to members.
- Paid gifts: gifts are only sent with coins bought through Stripe (`functions/api/coins/`). STRIPE_SECRET_KEY and STRIPE_WEBHOOK_SECRET are Cloudflare secrets the owner entered himself (Oct 2026); the Stripe webhook "meechies-world-coins" points at /api/coins/webhook. Never allow free gifts. Owner keeps 60%, the member gets 40%.
- Meechie's Fans (18+) payments go through CCBill only, never Stripe.
- Phones first: nothing may cover the screen or stack on top of something else. Floating buttons are draggable (`js/float-layout.js`), and pop-ups wait their turn (`MW_screenClear`).

## Where things are
- Feed, Facebook-style: `js/fb-feed.js` plus the feed code in `index.html`
- Messenger, chat heads and pop-ups: `js/messages.js`
- Profiles: `js/profile-setup.js` and `js/profile-page.js`
- Friends and find-by-email: `js/friends.js` and `js/email-find.js`
- Welcome videos and choice card (Text/Call Meechie): `js/welcome-show.js`
- Phone notifications: `js/push.js` and `functions/api/push.js`
- Bottom tabs on phones: `js/appnav.js`
- Section apps (one home-screen app per section, `/<id>-app/` + `/apps/`): edit `tools/apps.json`, run `python3 tools/make-apps.py`. App mode lives in the first script in `index.html`; the "get this app" card is `js/app-offer.js`.
