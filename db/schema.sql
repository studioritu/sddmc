-- SDDMC — database schema, access rules and storage rules.
-- Run once in the Supabase SQL editor (Dashboard → SQL Editor → New query).
-- Safe to re-run: every object is created with "if not exists" or dropped first.

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------

-- A roster entry. Deliberately independent of auth.users so a member can appear
-- on the public roster before (or without) ever being issued a login.
create table if not exists public.profiles (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid unique references auth.users(id) on delete set null,
  email       text unique,
  name        text not null,
  role        text not null default 'Member',
  grade       text,
  avatar_path text,
  is_admin    boolean not null default false,
  is_public   boolean not null default true,
  show_grade  boolean not null default false,
  show_badges boolean not null default true,
  sort_order  int not null default 100,
  created_at  timestamptz not null default now()
);

create table if not exists public.works (
  id          uuid primary key default gen_random_uuid(),
  owner_id    uuid not null references public.profiles(id) on delete cascade,
  title       text not null default 'Untitled',
  kind        text not null check (kind in ('design','art')),
  event       text,
  destination text not null default 'profile' check (destination in ('profile','exhibition')),
  status      text not null default 'pending'  check (status in ('pending','approved','declined')),
  made_on     date not null default current_date,
  image_path  text not null,
  thumb_path  text not null,
  note        text,
  is_winner   boolean not null default false,
  is_public   boolean not null default true,
  created_at  timestamptz not null default now()
);

create index if not exists works_owner_idx  on public.works (owner_id);
create index if not exists works_status_idx on public.works (status) where status = 'pending';

-- ---------------------------------------------------------------------------
-- Helper functions
--
-- These are `security definer` on purpose. A policy ON profiles that reads
-- FROM profiles recurses infinitely; running the lookup as the definer skips
-- RLS for that one read and breaks the cycle. `set search_path` is required —
-- without it a security-definer function is a privilege-escalation vector.
-- ---------------------------------------------------------------------------

create or replace function public.is_admin() returns boolean
language sql security definer stable set search_path = public as $$
  select exists (
    select 1 from public.profiles
    where user_id = auth.uid() and is_admin
  );
$$;

create or replace function public.my_profile_id() returns uuid
language sql security definer stable set search_path = public as $$
  select id from public.profiles where user_id = auth.uid();
$$;

-- ---------------------------------------------------------------------------
-- Account linking
--
-- When an admin issues a login in the Supabase dashboard, attach it to the
-- roster row that already exists for that email rather than orphaning it.
-- ---------------------------------------------------------------------------

create or replace function public.link_profile() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  update public.profiles
     set user_id = new.id
   where email = new.email and user_id is null;

  if not found then
    insert into public.profiles (user_id, email, name)
    values (new.id, new.email, split_part(new.email, '@', 1));
  end if;

  return new;
end $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.link_profile();

-- ---------------------------------------------------------------------------
-- Privilege guard
--
-- RLS alone cannot stop a member from setting is_winner on their own pending
-- row and having it silently promoted when an admin later approves the piece.
-- This forces the trusted columns to safe values for anyone who is not admin.
-- ---------------------------------------------------------------------------

create or replace function public.guard_work_flags() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if public.is_admin() then
    return new;
  end if;

  if tg_op = 'INSERT' then
    new.status    := 'pending';
    new.is_winner := false;
  else
    new.status    := old.status;
    new.is_winner := old.is_winner;
    new.owner_id  := old.owner_id;
  end if;

  return new;
end $$;

drop trigger if exists guard_work_flags on public.works;
create trigger guard_work_flags
  before insert or update on public.works
  for each row execute function public.guard_work_flags();

-- ---------------------------------------------------------------------------
-- Row Level Security
-- ---------------------------------------------------------------------------

alter table public.profiles enable row level security;
alter table public.works    enable row level security;

grant usage on schema public to anon, authenticated;
grant select on public.profiles, public.works to anon, authenticated;
grant insert, update, delete on public.profiles, public.works to authenticated;

-- profiles ------------------------------------------------------------------

drop policy if exists profiles_read   on public.profiles;
drop policy if exists profiles_update on public.profiles;
drop policy if exists profiles_insert on public.profiles;
drop policy if exists profiles_delete on public.profiles;

create policy profiles_read on public.profiles
  for select using (
    is_public or user_id = auth.uid() or public.is_admin()
  );

-- A member may edit their own display settings; only an admin may touch
-- anyone else. Note this lets a member target their own is_admin column —
-- neutralised below by the profiles_no_self_promote trigger.
create policy profiles_update on public.profiles
  for update using (
    user_id = auth.uid() or public.is_admin()
  ) with check (
    user_id = auth.uid() or public.is_admin()
  );

create policy profiles_insert on public.profiles
  for insert with check (public.is_admin());

create policy profiles_delete on public.profiles
  for delete using (public.is_admin());

create or replace function public.profiles_no_self_promote() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then
    new.is_admin := old.is_admin;
    new.user_id  := old.user_id;
    new.email    := old.email;
  end if;
  return new;
end $$;

drop trigger if exists profiles_no_self_promote on public.profiles;
create trigger profiles_no_self_promote
  before update on public.profiles
  for each row execute function public.profiles_no_self_promote();

-- works ---------------------------------------------------------------------

drop policy if exists works_read   on public.works;
drop policy if exists works_insert on public.works;
drop policy if exists works_update on public.works;
drop policy if exists works_delete on public.works;

create policy works_read on public.works
  for select using (
    (status = 'approved' and is_public)
    or owner_id = public.my_profile_id()
    or public.is_admin()
  );

-- The important one: a member can only ever create rows they own. The
-- guard_work_flags trigger additionally pins status to 'pending', so
-- self-approval is impossible even by editing the shipped JavaScript.
create policy works_insert on public.works
  for insert with check (
    owner_id = public.my_profile_id() or public.is_admin()
  );

create policy works_update on public.works
  for update using (
    public.is_admin()
    or (owner_id = public.my_profile_id() and status = 'pending')
  ) with check (
    public.is_admin()
    or (owner_id = public.my_profile_id() and status = 'pending')
  );

create policy works_delete on public.works
  for delete using (
    owner_id = public.my_profile_id() or public.is_admin()
  );

-- ---------------------------------------------------------------------------
-- Storage
--
-- Files live at  {profile_id}/{uuid}.webp  and  {profile_id}/{uuid}-t.webp,
-- so the first path segment is the owner and can be checked directly.
-- ---------------------------------------------------------------------------

insert into storage.buckets (id, name, public)
values ('work', 'work', true)
on conflict (id) do update set public = true;

drop policy if exists work_read   on storage.objects;
drop policy if exists work_insert on storage.objects;
drop policy if exists work_update on storage.objects;
drop policy if exists work_delete on storage.objects;

create policy work_read on storage.objects
  for select using (bucket_id = 'work');

create policy work_insert on storage.objects
  for insert with check (
    bucket_id = 'work' and (
      (storage.foldername(name))[1] = public.my_profile_id()::text
      or public.is_admin()
    )
  );

create policy work_update on storage.objects
  for update using (
    bucket_id = 'work' and (
      (storage.foldername(name))[1] = public.my_profile_id()::text
      or public.is_admin()
    )
  );

create policy work_delete on storage.objects
  for delete using (
    bucket_id = 'work' and (
      (storage.foldername(name))[1] = public.my_profile_id()::text
      or public.is_admin()
    )
  );
