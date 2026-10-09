-- Recording studio: allow audio in the member media bucket, and only the owner can grant "pro" (paid plugins).
update storage.buckets set allowed_mime_types = array['video/mp4','video/quicktime','video/webm','video/3gpp','video/x-matroska','video/x-m4v','audio/wav','audio/x-wav','audio/mpeg','audio/webm','audio/mp4','audio/ogg']
where id = 'media';

create or replace function public.docs_pro_guard() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if public.is_admin() then return new; end if;
  if tg_op = 'INSERT' then
    if coalesce(new.data->'pro','false'::jsonb) <> 'false'::jsonb then raise exception 'Only Meechie can unlock plugins.'; end if;
  elsif coalesce(new.data->'pro','false'::jsonb) <> coalesce(old.data->'pro','false'::jsonb) then
    raise exception 'Only Meechie can unlock plugins.';
  end if;
  return new;
end $$;
drop trigger if exists docs_pro_guard on public.docs;
create trigger docs_pro_guard before insert or update on public.docs for each row execute function public.docs_pro_guard();

-- Friends, dating, studio: each member keeps one personal doc per feature.
update storage.buckets set allowed_mime_types = array['video/mp4','video/quicktime','video/webm','video/3gpp','video/x-matroska','video/x-m4v','audio/wav','audio/x-wav','audio/mpeg','audio/webm','audio/mp4','audio/ogg','image/jpeg','image/png','image/webp']
where id = 'media';

create or replace function public.path_allowed(p_path text, p_coll text) returns boolean
language sql stable as $$
  select auth.uid() is not null
     and case
       when p_coll in ('tracks', 'radio', 'site') then public.is_admin()
       when p_coll in ('members', 'scores', 'live', 'friends', 'dating', 'datelikes') then p_path = p_coll || '/' || auth.uid()::text or public.is_admin()
       else true
     end
$$;
