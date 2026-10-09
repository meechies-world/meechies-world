-- Meechie's World database setup
-- Paste this whole file into Supabase: SQL Editor -> New query -> Run.

-- 1. Documents: every post, ad, member profile, chat message, design, score, etc.
create table if not exists public.docs (
  path       text primary key,                 -- e.g. posts/abc123
  coll       text not null,                    -- e.g. posts
  owner      uuid default auth.uid(),
  data       jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists docs_coll_idx on public.docs (coll);
alter table public.docs replica identity full;

-- 2. Admins (Meechie). Add yourself after you sign up (step 5 at the bottom).
create table if not exists public.admins (user_id uuid primary key);
alter table public.admins enable row level security;
drop policy if exists "admins readable" on public.admins;
create policy "admins readable" on public.admins for select using (true);

create or replace function public.is_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.admins where user_id = auth.uid());
$$;

-- 3. Rules: anyone can read; signed-in members can write their own things;
--    some collections and fixed paths are locked down.
create or replace function public.path_allowed(p_path text, p_coll text) returns boolean
language sql stable as $$
  select auth.uid() is not null
     and case
       when p_coll in ('tracks', 'radio', 'site') then public.is_admin()
       when p_coll in ('members', 'scores', 'live') then p_path = p_coll || '/' || auth.uid()::text or public.is_admin()
       else true
     end
$$;

alter table public.docs enable row level security;
drop policy if exists "read all" on public.docs;
drop policy if exists "insert own" on public.docs;
drop policy if exists "update signed in" on public.docs;
drop policy if exists "delete own" on public.docs;
create policy "read all"         on public.docs for select using (true);
create policy "insert own"       on public.docs for insert with check (owner = auth.uid() and public.path_allowed(path, coll) and octet_length(data::text) < 400000);
create policy "update signed in" on public.docs for update using (auth.uid() is not null) with check (octet_length(data::text) < 400000);
create policy "delete own"       on public.docs for delete using (owner = auth.uid() or public.is_admin());

-- Members may only change likes/votes/counters on other people's things.
create or replace function public.docs_guard() returns trigger
language plpgsql security definer set search_path = public as $$
declare open_keys text[] := array['likes','votes','replyCount','giftsReceived'];
begin
  new.owner := old.owner; new.coll := old.coll; new.path := old.path; new.created_at := old.created_at; new.updated_at := now();
  if old.owner = auth.uid() or public.is_admin() then return new; end if;
  if (new.data - open_keys) is distinct from (old.data - open_keys) then
    raise exception 'You can only like, vote on, or react to other people''s posts.';
  end if;
  return new;
end $$;
drop trigger if exists docs_guard on public.docs;
create trigger docs_guard before update on public.docs for each row execute function public.docs_guard();

-- Merge fields into a document (like Firestore update).
create or replace function public.merge_doc(p_path text, p_patch jsonb) returns void
language plpgsql security invoker as $$
begin
  update public.docs set data = data || p_patch where path = p_path;
  if not found then raise exception 'That item no longer exists.'; end if;
end $$;

-- Create or replace a document (like Firestore set).
create or replace function public.set_doc(p_path text, p_coll text, p_data jsonb) returns void
language plpgsql security invoker as $$
begin
  update public.docs set data = p_data where path = p_path;
  if not found then
    insert into public.docs (path, coll, owner, data) values (p_path, p_coll, auth.uid(), p_data);
  end if;
end $$;

-- 4. Live updates
do $$ begin
  alter publication supabase_realtime add table public.docs;
exception when duplicate_object then null; end $$;

-- 5. Storage bucket for radio tracks (only admins upload, everyone can listen)
insert into storage.buckets (id, name, public) values ('assets', 'assets', true)
on conflict (id) do nothing;
drop policy if exists "assets admin upload" on storage.objects;
drop policy if exists "assets admin delete" on storage.objects;
create policy "assets admin upload" on storage.objects for insert to authenticated with check (bucket_id = 'assets' and public.is_admin());
create policy "assets admin delete" on storage.objects for delete to authenticated using (bucket_id = 'assets' and public.is_admin());

-- ===================================================================
-- AFTER you create your own account on the website, run this ONE line
-- (change the email if you signed up with a different one) to make
-- yourself the admin:
--
--   insert into public.admins (user_id)
--   select id from auth.users where email = 'meechiesworldinc@aol.com';
-- ===================================================================
