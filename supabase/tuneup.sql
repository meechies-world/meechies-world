-- Meechie's World database tune-up (security + speed). Safe to run more than once.
-- Paste into Supabase > SQL Editor > Run.

-- 1. Lock the search path on five functions (security warning fix)
alter function public.merge_doc(text, jsonb) set search_path = public;
alter function public.set_doc(text, text, jsonb) set search_path = public;
alter function public.path_allowed(text, text) set search_path = public;
alter function public.docs_insert_ok(text, text, jsonb) set search_path = public;
alter function public.only_me_changed(jsonb, jsonb) set search_path = public;

-- 2. Internal trigger functions should not be callable from the web
revoke execute on function public.docs_guard() from public, anon, authenticated;
revoke execute on function public.docs_pro_guard() from public, anon, authenticated;
revoke execute on function public.rls_auto_enable() from public, anon, authenticated;

-- 3. Same rules, checked once per query instead of once per row (speed fix)
alter policy "update signed in" on public.docs using ((select auth.uid()) is not null) with check (octet_length((data)::text) < 400000);
alter policy "delete own" on public.docs using (((owner = (select auth.uid())) and coll <> 'members') or (select public.is_admin())); -- members can't delete their own member profile (keeps the under-18 block)
alter policy "insert own" on public.docs with check ((owner = (select auth.uid())) and public.path_allowed(path, coll) and public.docs_insert_ok(path, coll, data) and (octet_length((data)::text) < 400000));
alter policy "dm mark read" on public.dms using (recipient = (select auth.uid())) with check (recipient = (select auth.uid()));
alter policy "dm read own" on public.dms using (((select auth.uid()) = sender) or ((select auth.uid()) = recipient));
alter policy "dm send" on public.dms with check ((sender = (select auth.uid())) and (recipient <> (select auth.uid())));
