-- Members only: only signed-in accounts can read the site's data (posts, members, radio list, chat, etc.).
-- People who aren't signed in, scrapers and AI bots get nothing back from the database.
-- Run once in Supabase -> SQL Editor -> New query -> paste -> Run.

-- site data
drop policy if exists "read all" on public.docs;
drop policy if exists "read members only" on public.docs;
create policy "read members only" on public.docs for select to authenticated using (true);

-- the owner list (the site checks it after you sign in)
drop policy if exists "admins readable" on public.admins;
drop policy if exists "admins readable by members" on public.admins;
create policy "admins readable by members" on public.admins for select to authenticated using (true);
