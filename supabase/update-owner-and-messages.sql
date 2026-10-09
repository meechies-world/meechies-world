-- Run once in Supabase SQL Editor.
-- 1) Make meechiesworldinc@aol.com the owner
insert into public.admins (user_id)
select id from auth.users where email = 'meechiesworldinc@aol.com'
on conflict do nothing;

-- 2) Only the owner can change the site content (text, colors, pages)
create or replace function public.path_allowed(p_path text, p_coll text) returns boolean
language sql stable as $$
  select auth.uid() is not null
     and case
       when p_coll in ('tracks', 'radio', 'site') then public.is_admin()
       when p_coll in ('members', 'scores', 'live') then p_path = p_coll || '/' || auth.uid()::text or public.is_admin()
       else true
     end
$$;

-- 3) Private messages: only the sender and the recipient can ever read a message
create table if not exists public.dms (
  id         bigint generated always as identity primary key,
  sender     uuid not null default auth.uid(),
  recipient  uuid not null,
  body       text not null check (char_length(body) between 1 and 2000),
  created_at timestamptz not null default now(),
  read_at    timestamptz
);
create index if not exists dms_sender_idx    on public.dms (sender, created_at desc);
create index if not exists dms_recipient_idx on public.dms (recipient, created_at desc);
alter table public.dms replica identity full;
alter table public.dms enable row level security;
drop policy if exists "dm read own"  on public.dms;
drop policy if exists "dm send"      on public.dms;
drop policy if exists "dm mark read" on public.dms;
create policy "dm read own"  on public.dms for select to authenticated using (auth.uid() in (sender, recipient));
create policy "dm send"      on public.dms for insert to authenticated with check (sender = auth.uid() and recipient <> auth.uid());
create policy "dm mark read" on public.dms for update to authenticated using (recipient = auth.uid()) with check (recipient = auth.uid());
revoke update on public.dms from anon, authenticated;
grant update (read_at) on public.dms to authenticated;
do $$ begin
  alter publication supabase_realtime add table public.dms;
exception when duplicate_object then null; end $$;
