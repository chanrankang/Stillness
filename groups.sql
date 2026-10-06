-- Stillness: groups. Run this SECOND, after schema.sql.
-- Paste this whole file into Supabase > SQL Editor > New query, then press Run.
-- It is safe to run more than once.

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------

-- The name friends see. One row per person, created the first time they join or start a group.
create table if not exists public.profiles (
  id           uuid primary key references auth.users (id) on delete cascade,
  display_name text not null check (char_length(btrim(display_name)) between 1 and 30),
  created_at   timestamptz not null default now()
);

create table if not exists public.groups (
  id          uuid primary key default gen_random_uuid(),
  name        text not null check (char_length(btrim(name)) between 1 and 40),
  invite_code text not null unique,
  created_by  uuid not null default auth.uid() references auth.users (id) on delete cascade,
  created_at  timestamptz not null default now()
);

create table if not exists public.group_members (
  group_id      uuid not null references public.groups (id) on delete cascade,
  user_id       uuid not null default auth.uid() references auth.users (id) on delete cascade,
  role          text not null default 'member' check (role in ('owner', 'member')),
  show_in_count boolean not null default true,   -- include me in the group's quiet daily count
  joined_at     timestamptz not null default now(),
  primary key (group_id, user_id)
);
create index if not exists group_members_user_idx on public.group_members (user_id);

-- A reflection someone chose to share with a group. Private responses are never copied here.
create table if not exists public.shares (
  id         uuid primary key default gen_random_uuid(),
  group_id   uuid not null references public.groups (id) on delete cascade,
  user_id    uuid not null default auth.uid() references auth.users (id) on delete cascade,
  day        date not null,
  passage    text check (passage is null or char_length(passage) <= 200),
  body       text not null check (char_length(btrim(body)) between 1 and 600),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (group_id, user_id, day)
);
create index if not exists shares_group_idx on public.shares (group_id, day desc, created_at desc);

-- ---------------------------------------------------------------------------
-- Helper checks (they run with elevated rights so the rules below do not loop)
-- ---------------------------------------------------------------------------

create or replace function public.is_group_member(gid uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.group_members
    where group_id = gid and user_id = (select auth.uid())
  );
$$;

create or replace function public.is_group_owner(gid uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.group_members
    where group_id = gid and user_id = (select auth.uid()) and role = 'owner'
  );
$$;

create or replace function public.shares_group_with(other uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1
    from public.group_members a
    join public.group_members b on b.group_id = a.group_id
    where a.user_id = (select auth.uid()) and b.user_id = other
  );
$$;

-- ---------------------------------------------------------------------------
-- Actions the app calls: start a group, join with a code, see the quiet count
-- ---------------------------------------------------------------------------

create or replace function public.create_group(group_name text)
returns public.groups language plpgsql security definer set search_path = '' as $$
declare
  g public.groups;
  code text;
  tries int := 0;
begin
  if auth.uid() is null then raise exception 'Please log in first.'; end if;
  if not exists (select 1 from public.profiles where id = auth.uid()) then
    raise exception 'Choose a display name first.';
  end if;
  if (select count(*) from public.groups where created_by = auth.uid()) >= 10 then
    raise exception 'You have reached the limit of 10 groups.';
  end if;
  loop
    code := upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 10));
    begin
      insert into public.groups (name, invite_code, created_by)
      values (btrim(group_name), code, auth.uid())
      returning * into g;
      exit;
    exception when unique_violation then
      tries := tries + 1;
      if tries > 5 then raise; end if;
    end;
  end loop;
  insert into public.group_members (group_id, user_id, role) values (g.id, auth.uid(), 'owner');
  return g;
end;
$$;

create or replace function public.join_group(code text)
returns public.groups language plpgsql security definer set search_path = '' as $$
declare
  g public.groups;
  c text := upper(regexp_replace(coalesce(code, ''), '[^0-9A-Za-z]', '', 'g'));
begin
  if auth.uid() is null then raise exception 'Please log in first.'; end if;
  if not exists (select 1 from public.profiles where id = auth.uid()) then
    raise exception 'Choose a display name first.';
  end if;
  select * into g from public.groups where invite_code = c;
  if not found then raise exception 'That code did not match a group.'; end if;
  if (select count(*) from public.group_members where group_id = g.id) >= 30 then
    raise exception 'This group is full.';
  end if;
  insert into public.group_members (group_id, user_id, role)
  values (g.id, auth.uid(), 'member')
  on conflict do nothing;
  return g;
end;
$$;

-- The quiet daily count: only two numbers, never who. Counts only people who left themselves included.
create or replace function public.group_count(gid uuid, d date)
returns json language plpgsql stable security definer set search_path = '' as $$
begin
  if not public.is_group_member(gid) then raise exception 'You are not in this group.'; end if;
  return (
    select json_build_object(
      'counted', count(*),
      'done', count(*) filter (where e.done is true)
    )
    from public.group_members m
    left join public.entries e on e.user_id = m.user_id and e.day = d
    where m.group_id = gid and m.show_in_count
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- Rules: who can see and change what
-- ---------------------------------------------------------------------------

alter table public.profiles      enable row level security;
alter table public.groups        enable row level security;
alter table public.group_members enable row level security;
alter table public.shares        enable row level security;

drop policy if exists "See yourself and people in your groups" on public.profiles;
drop policy if exists "Create your own profile"                on public.profiles;
drop policy if exists "Change your own profile"                on public.profiles;
create policy "See yourself and people in your groups" on public.profiles for select to authenticated
  using (id = (select auth.uid()) or public.shares_group_with(id));
create policy "Create your own profile" on public.profiles for insert to authenticated
  with check (id = (select auth.uid()));
create policy "Change your own profile" on public.profiles for update to authenticated
  using (id = (select auth.uid())) with check (id = (select auth.uid()));

drop policy if exists "See your groups"        on public.groups;
drop policy if exists "Owner renames group"    on public.groups;
drop policy if exists "Owner deletes group"    on public.groups;
create policy "See your groups" on public.groups for select to authenticated
  using (public.is_group_member(id));
create policy "Owner renames group" on public.groups for update to authenticated
  using (public.is_group_owner(id)) with check (public.is_group_owner(id));
create policy "Owner deletes group" on public.groups for delete to authenticated
  using (public.is_group_owner(id));

drop policy if exists "See members of your groups"    on public.group_members;
drop policy if exists "Change your own count setting" on public.group_members;
drop policy if exists "Leave, or owner removes"       on public.group_members;
create policy "See members of your groups" on public.group_members for select to authenticated
  using (public.is_group_member(group_id));
create policy "Change your own count setting" on public.group_members for update to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy "Leave, or owner removes" on public.group_members for delete to authenticated
  using (role = 'member' and (user_id = (select auth.uid()) or public.is_group_owner(group_id)));

drop policy if exists "See shares in your groups" on public.shares;
drop policy if exists "Share into your groups"    on public.shares;
drop policy if exists "Edit your own shares"      on public.shares;
drop policy if exists "Remove your own shares"    on public.shares;
create policy "See shares in your groups" on public.shares for select to authenticated
  using (public.is_group_member(group_id));
create policy "Share into your groups" on public.shares for insert to authenticated
  with check (user_id = (select auth.uid()) and public.is_group_member(group_id));
create policy "Edit your own shares" on public.shares for update to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()) and public.is_group_member(group_id));
create policy "Remove your own shares" on public.shares for delete to authenticated
  using (user_id = (select auth.uid()));

-- ---------------------------------------------------------------------------
-- Permissions: keep the door narrow
-- ---------------------------------------------------------------------------

revoke all on public.entries, public.profiles, public.groups, public.group_members, public.shares from anon;

-- Groups and memberships are only created through create_group and join_group above.
revoke insert on public.groups        from authenticated;
revoke insert on public.group_members from authenticated;
revoke update on public.groups        from authenticated;
grant  update (name) on public.groups to authenticated;
revoke update on public.group_members from authenticated;
grant  update (show_in_count) on public.group_members to authenticated;

revoke execute on function public.is_group_member(uuid), public.is_group_owner(uuid), public.shares_group_with(uuid),
                           public.create_group(text), public.join_group(text), public.group_count(uuid, date)
  from public, anon;
grant  execute on function public.is_group_member(uuid), public.is_group_owner(uuid), public.shares_group_with(uuid),
                           public.create_group(text), public.join_group(text), public.group_count(uuid, date)
  to authenticated;
