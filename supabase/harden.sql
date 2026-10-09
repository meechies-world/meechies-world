-- Security hardening (Oct 2026).
-- 1) New docs must have a clean path (letters, numbers, _ and - only) so ids can't carry HTML.
-- 2) Members can't post as someone else (authorId / from must be themselves).
-- 3) Only the owner can set announce / host / sponsored / featured.
-- 4) On other people's posts, members can only add/remove THEIR OWN like or vote,
--    and counters (replyCount, giftsReceived) can only change by one.

create or replace function public.docs_insert_ok(p_path text, p_coll text, p_data jsonb) returns boolean
language sql stable as $$
  select p_coll ~ '^[A-Za-z0-9_/-]{1,200}$'
     and p_path ~ ('^' || p_coll || '/[A-Za-z0-9_-]{1,64}$')
     and (public.is_admin() or (
           coalesce(p_data->>'authorId', auth.uid()::text) = auth.uid()::text
       and coalesce(p_data->>'from', auth.uid()::text) = auth.uid()::text
       and coalesce(p_data->'announce', 'false'::jsonb) = 'false'::jsonb
       and coalesce(p_data->'host', 'false'::jsonb) = 'false'::jsonb
       and coalesce(p_data->'sponsored', 'false'::jsonb) = 'false'::jsonb
       and coalesce(p_data->'featured', 'false'::jsonb) = 'false'::jsonb))
$$;

drop policy if exists "insert own" on public.docs;
create policy "insert own" on public.docs for insert
  with check (owner = auth.uid() and public.path_allowed(path, coll)
              and public.docs_insert_ok(path, coll, data) and octet_length(data::text) < 400000);

create or replace function public.only_me_changed(a jsonb, b jsonb) returns boolean
language sql stable as $$
  -- true when the two id lists differ only by the caller's own id
  select not exists (
    select x from (
      (select jsonb_array_elements_text(coalesce(a,'[]'::jsonb)) x
       except select jsonb_array_elements_text(coalesce(b,'[]'::jsonb)))
      union
      (select jsonb_array_elements_text(coalesce(b,'[]'::jsonb))
       except select jsonb_array_elements_text(coalesce(a,'[]'::jsonb)))
    ) d where x <> auth.uid()::text)
$$;

create or replace function public.docs_guard() returns trigger
language plpgsql security definer set search_path = public as $$
declare open_keys text[] := array['likes','votes','replyCount','giftsReceived'];
begin
  new.owner := old.owner; new.coll := old.coll; new.path := old.path; new.created_at := old.created_at; new.updated_at := now();
  if public.is_admin() then return new; end if;
  -- nobody but the owner can switch on owner-only flags or change who wrote it
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
