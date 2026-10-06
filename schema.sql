-- Stillness: database setup.
-- Paste this whole file into Supabase > SQL Editor > New query, then press Run.

create table if not exists public.entries (
  user_id    uuid        not null default auth.uid() references auth.users (id) on delete cascade,
  day        date        not null,
  done       boolean,                                   -- null = not decided, true/false = marked
  passage    text        check (passage is null or char_length(passage) <= 200),
  answers    jsonb       not null default '[]'::jsonb,  -- [{ "q": "question", "a": "response" }, ...]
  updated_at timestamptz not null default now(),
  primary key (user_id, day),
  check (jsonb_typeof(answers) = 'array' and jsonb_array_length(answers) <= 12)
);

-- Row level security: every person can only ever see and change their own rows.
alter table public.entries enable row level security;

drop policy if exists "Read own entries"   on public.entries;
drop policy if exists "Insert own entries" on public.entries;
drop policy if exists "Update own entries" on public.entries;
drop policy if exists "Delete own entries" on public.entries;

create policy "Read own entries"
  on public.entries for select to authenticated
  using ((select auth.uid()) = user_id);

create policy "Insert own entries"
  on public.entries for insert to authenticated
  with check ((select auth.uid()) = user_id);

create policy "Update own entries"
  on public.entries for update to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

create policy "Delete own entries"
  on public.entries for delete to authenticated
  using ((select auth.uid()) = user_id);

-- Visitors who are not logged in get no access at all.
revoke all on public.entries from anon;
