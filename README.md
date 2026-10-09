# Meechie's World

The official site and community platform of **Meechie's World Inc** — services, community feed,
radio, Virtual World, Gold Rush Arena, Creators hub, ad board, and promotion.

Static site (no build step) + **Supabase** (accounts, database, live rooms, file storage),
hosted free on **Cloudflare Pages**.

## Files
| File | What it is |
|---|---|
| `index.html` | The whole website |
| `js/platform.js` | Connects the site to Supabase (sign-in, database, live rooms, uploads) |
| `js/config.js` | **Your Supabase URL and anon key go here** |
| `supabase/schema.sql` | Database setup — paste into Supabase once |

## Launch steps
1. **Supabase** → New project (free). Save the database password somewhere safe.
2. Supabase → **SQL Editor** → New query → paste all of `supabase/schema.sql` → **Run**.
3. Supabase → **Authentication → Sign In / Providers → Email**: turn **off** "Confirm email"
   (the free email sender only allows a few emails per hour). You can turn it back on later
   with your own email service.
4. Supabase → **Project Settings → API**: copy the **Project URL** and the **anon public** key
   into `js/config.js`.
5. **Cloudflare** → Workers & Pages → Create → Pages → **Connect to Git** → pick
   `meechies-world` → Framework preset **None**, build command empty, output directory `/`
   → **Save and Deploy**. Your site is live at `meechies-world.pages.dev`.
6. Open the site, click **Join free**, and create your account with `meechiesworldinc@aol.com`.
7. Back in Supabase SQL Editor, run the admin line at the bottom of `schema.sql`.
   Reload the site — you now have the owner controls (radio uploads, announcements,
   promote/pin, delete anything).
8. Optional: Cloudflare → your Pages project → **Custom domains** → add `meechiesworld.com`.

## Not on yet
- AI assistant and AI look-alike matching (needs an AI API key and a small server function).
- Face verification, passkey login, end-to-end encrypted DMs, paid coins, in-site video live.
