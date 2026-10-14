-- Lockdown (Oct 14 2026). Run once in Supabase -> SQL Editor -> New query -> paste -> Run.
-- Safe to run more than once.
--  1) Members can't give themselves the "ID verified" badge. Only the server (after Stripe confirms) or Meechie can.
--  2) Once a member said they're under 18, they can't undo it themselves.
--  3) Only Meechie can mark a clothing design "Selected for the store".
--  4) Reports (dating "report this profile") can only be read by Meechie and the person who sent it.
--  5) The latest list of which collections members may create (same as follows.sql), so re-running an old file can't undo it.
--  6) The phone-alert channel name is private to Meechie (so nobody can send fake alerts to his phone).
--  7) Fair-use limits for the AI, the phone line and visitor alerts (Meechie is never limited).

-- 1-3: keep protected fields as they were unless Meechie or the server changes them.
-- (Fields are silently kept, not refused, so normal profile saves never fail.)
create or replace function public.docs_verify_guard() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if public.is_admin() or coalesce(auth.jwt()->>'role', '') = 'service_role' then return new; end if;
  if new.coll = 'members' then
    if tg_op = 'INSERT' then
      new.data := new.data - array['idVerified', 'idVerifiedAt'];
    else
      new.data := (new.data - array['idVerified', 'idVerifiedAt']) || jsonb_strip_nulls(jsonb_build_object(
        'idVerified', old.data->'idVerified', 'idVerifiedAt', old.data->'idVerifiedAt'));
      if coalesce(old.data->'under18', 'false'::jsonb) = 'true'::jsonb then
        new.data := new.data || '{"under18": true, "ageVerified": false}'::jsonb;
      end if;
    end if;
  elsif new.coll = 'designs' then
    if tg_op = 'INSERT' then
      new.data := new.data - 'selected';
    else
      new.data := (new.data - 'selected') || jsonb_strip_nulls(jsonb_build_object('selected', old.data->'selected'));
    end if;
  end if;
  return new;
end $$;
drop trigger if exists docs_verify_guard on public.docs;
create trigger docs_verify_guard before insert or update on public.docs
  for each row execute function public.docs_verify_guard();

-- The server's verification write uses the service key: let it past the like/vote guard (same as harden.sql otherwise).
create or replace function public.docs_guard() returns trigger
language plpgsql security definer set search_path = public as $$
declare open_keys text[] := array['likes','votes','replyCount','giftsReceived'];
begin
  new.owner := old.owner; new.coll := old.coll; new.path := old.path; new.created_at := old.created_at; new.updated_at := now();
  if public.is_admin() or coalesce(auth.jwt()->>'role', '') = 'service_role' then return new; end if;
  if (coalesce(new.data->'announce','false'::jsonb) <> coalesce(old.data->'announce','false'::jsonb)
      or coalesce(new.data->'host','false'::jsonb) <> coalesce(old.data->'host','false'::jsonb)
      or coalesce(new.data->'sponsored','false'::jsonb) <> coalesce(old.data->'sponsored','false'::jsonb)
      or coalesce(new.data->'featured','false'::jsonb) <> coalesce(old.data->'featured','false'::jsonb)
      or (new.data->>'authorId') is distinct from (old.data->>'authorId')
      or (new.data->>'from') is distinct from (old.data->>'from')) then
    raise exception 'Only Meechie can change that.';
  end if;
  if old.owner = auth.uid() then return new; end if;
  if (new.data - open_keys) is distinct from (old.data - open_keys) then
    raise exception 'You can only like, vote on, or react to other people''s posts.';
  end if;
  if not public.only_me_changed(old.data->'likes', new.data->'likes')
     or not public.only_me_changed(old.data->'votes', new.data->'votes') then
    raise exception 'You can only add or remove your own like or vote.';
  end if;
  if abs(coalesce((new.data->>'replyCount')::numeric,0) - coalesce((old.data->>'replyCount')::numeric,0)) > 1
     or coalesce((new.data->>'giftsReceived')::numeric,0) not in (coalesce((old.data->>'giftsReceived')::numeric,0), coalesce((old.data->>'giftsReceived')::numeric,0)+1) then
    raise exception 'Counters can only change by one.';
  end if;
  return new;
end $$;

-- 4: reports are private
drop policy if exists "read members only" on public.docs;
create policy "read members only" on public.docs for select to authenticated
  using (coll <> 'reports' or owner = auth.uid() or public.is_admin());

-- 5: latest collection rules (books + follows together)
create or replace function public.path_allowed(p_path text, p_coll text) returns boolean
language sql stable as $$
  select auth.uid() is not null
     and case
       when p_coll in ('tracks', 'radio', 'site', 'books', 'bookpages') then public.is_admin()
       when p_coll in ('members', 'scores', 'live', 'friends', 'dating', 'datelikes', 'follows') then p_path = p_coll || '/' || auth.uid()::text or public.is_admin()
       else true
     end
$$;

-- 6) The phone-alert channel (site/alerts) can only be read by Meechie. Alerts are sent by the site's server.
drop policy if exists "read members only" on public.docs;
create policy "read members only" on public.docs for select to authenticated
  using ((coll <> 'reports' or owner = auth.uid() or public.is_admin())
     and (path <> 'site/alerts' or public.is_admin()));

-- 7) Fair-use limits (AI, phone line, visitor alerts). Meechie is never limited.
create table if not exists public.usage (k text not null, at timestamptz not null default now());
create index if not exists usage_k_at on public.usage (k, at);
alter table public.usage enable row level security; -- no policies: only the function below touches it

create or replace function public.take(p_key text, p_window int, p_max int) returns boolean
language plpgsql security definer set search_path = public as $$
declare v_k text; n int;
begin
  if p_window < 1 or p_window > 86400 or p_max < 1 or p_max > 1000 or p_key !~ '^[A-Za-z0-9:._+-]{1,120}$' then return false; end if;
  if coalesce(auth.jwt()->>'role', '') = 'service_role' then
    v_k := 'srv:' || p_key;
  elsif auth.uid() is null then
    return false;
  elsif public.is_admin() then
    return true;
  elsif p_key not in ('ai', 'ai-day', 'verify', 'verify-day', 'legal', 'legal-day', 'legal-claude', 'legal-claude-day') then
    return false;
  else
    v_k := auth.uid()::text || ':' || p_key;
  end if;
  perform pg_advisory_xact_lock(hashtext(v_k));
  select count(*) into n from public.usage u where u.k = v_k and u.at > now() - make_interval(secs => p_window);
  if n >= p_max then return false; end if;
  insert into public.usage (k) values (v_k);
  if random() < 0.01 then delete from public.usage where at < now() - interval '2 days'; end if;
  return true;
end $$;
revoke all on function public.take(text, int, int) from public, anon;
grant execute on function public.take(text, int, int) to authenticated, service_role;
