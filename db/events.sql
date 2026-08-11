-- SDDMC — events table.
--
-- The list of events a design can be "made for" used to be hardcoded in two
-- different places: a fixed array in admin.html and, in the Studio, whatever
-- events already had uploads. They drifted apart. This table is the single
-- source of truth both upload dropdowns now read from, and the admin portal
-- manages it (add / rename / delete).
--
-- "Personal / off-theme" is NOT stored here — it is a fixed choice appended in
-- the UI for work that belongs to no event.
--
-- Run once in the Supabase SQL editor. Idempotent.

create table if not exists public.events (
  id         uuid primary key default gen_random_uuid(),
  name       text not null unique,
  sort_order int  not null default 100,
  created_at timestamptz not null default now()
);

alter table public.events enable row level security;

grant select on public.events to anon, authenticated;
grant insert, update, delete on public.events to authenticated;

-- Anyone may read the list (it drives the public Studio dropdown); only an
-- admin may change it. is_admin() is the same helper the rest of the schema
-- uses, so nothing new is exposed.
drop policy if exists events_read  on public.events;
create policy events_read on public.events for select using (true);

drop policy if exists events_write on public.events;
create policy events_write on public.events
  for all using (public.is_admin()) with check (public.is_admin());

-- Seed with the current real events. Adjust freely from the admin portal after.
insert into public.events (name, sort_order) values
  ('STEMCON 2025',                  10),
  ('Sunnydale EcoBiz Summit III',   20),
  ('Sunnydale MusicXDance Fest III', 30),
  ('Sunnydale Theatre Carnival I',  40),
  ('SDMUN Session V',               50),
  ('Sunnydale Film Fest',           60),
  ('Sunnydale Games',               70)
on conflict (name) do nothing;
