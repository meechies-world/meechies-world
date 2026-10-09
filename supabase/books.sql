-- Books: only the owner can publish books and their pages.
create or replace function public.path_allowed(p_path text, p_coll text) returns boolean
language sql stable as $$
  select auth.uid() is not null
     and case
       when p_coll in ('tracks', 'radio', 'site', 'books', 'bookpages') then public.is_admin()
       when p_coll in ('members', 'scores', 'live', 'friends', 'dating', 'datelikes') then p_path = p_coll || '/' || auth.uid()::text or public.is_admin()
       else true
     end
$$;
