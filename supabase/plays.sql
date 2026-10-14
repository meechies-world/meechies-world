-- Real play counts for songs and videos (Oct 2026). Run once in Supabase → SQL Editor.
-- Each signed-in member counts at most once per song per day, so the numbers can't be pumped up.
create table if not exists public.plays (id text primary key, n bigint not null default 0, updated_at timestamptz not null default now());
create table if not exists public.plays_seen (uid uuid not null, id text not null, day date not null default current_date, primary key (uid, id, day));
alter table public.plays enable row level security;
alter table public.plays_seen enable row level security;
drop policy if exists "anyone reads play counts" on public.plays;
create policy "anyone reads play counts" on public.plays for select using (true);
-- no insert/update policies: counts only change through bump_play below

create or replace function public.bump_play(p_id text) returns void
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null or p_id !~ '^[A-Za-z0-9:_-]{1,80}$' then return; end if;
  insert into public.plays_seen (uid, id) values (auth.uid(), p_id) on conflict do nothing;
  if found then
    insert into public.plays (id, n) values (p_id, 1)
      on conflict (id) do update set n = public.plays.n + 1, updated_at = now();
  end if;
end $$;
revoke all on function public.bump_play(text) from public;
grant execute on function public.bump_play(text) to authenticated;
