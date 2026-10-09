-- Member video uploads for the Community feed and Ads.
-- Public bucket "media"; each signed-in member can upload only into their own folder (<user id>/...),
-- videos only, up to 50 MB each. Members delete their own files; the owner can delete any.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('media', 'media', true, 52428800, array['video/mp4','video/quicktime','video/webm','video/3gpp','video/x-matroska','video/x-m4v'])
on conflict (id) do update set public = true, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "media member upload" on storage.objects;
drop policy if exists "media member delete" on storage.objects;
create policy "media member upload" on storage.objects for insert to authenticated
  with check (bucket_id = 'media' and (storage.foldername(name))[1] = auth.uid()::text);
create policy "media member delete" on storage.objects for delete to authenticated
  using (bucket_id = 'media' and ((storage.foldername(name))[1] = auth.uid()::text or public.is_admin()));
