-- SDDMC — security hardening to apply to the LIVE database.
--
-- These are the findings from the security review that live in Postgres /
-- Supabase config, not in the app code. Paste the whole file into the Supabase
-- SQL editor and run it once. Safe to re-run (every statement is idempotent).
--
-- The matching source of truth for #1 already lives in db/schema.sql; this file
-- exists so the change actually reaches the running database, which schema.sql
-- does not do by itself.

-- 1. HIGH — a member could rename their own role to "President" (or reorder
--    themselves) by PATCHing profiles directly, past the client-side allow-list.
--    Pin role and sort_order for non-admin sessions. (Mirrors db/schema.sql.)
create or replace function public.profiles_no_self_promote() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is not null and not public.is_admin() then
    new.is_admin   := old.is_admin;
    new.is_roster  := old.is_roster;
    new.user_id    := old.user_id;
    new.email      := old.email;
    new.role       := old.role;
    new.sort_order := old.sort_order;
  end if;
  return new;
end $$;

-- 2. CRITICAL — the anon role can currently read profiles.email (login
--    usernames). schema.sql intends this revoke but it is not live. After this,
--    an anonymous `select *` on profiles will fail, and the roster's public
--    read path (ROSTER_PUBLIC_COLUMNS in api.js) becomes the only anon route.
revoke select (email) on public.profiles from anon;

-- 3. HIGH — the storage bucket has no size or type cap, so a signed-in member
--    can upload arbitrarily large or arbitrary-type files straight from
--    devtools, bypassing img.js and threatening the 1 GB free-tier allowance.
update storage.buckets
   set file_size_limit  = 10485760,  -- 10 MB
       allowed_mime_types = array['image/webp','image/jpeg','image/png']
 where id = 'work';

-- 4. MEDIUM — nothing ties a works row to the storage object it names, so a
--    member could insert a works row pointing image_path at another member's
--    file and claim their piece. Require the paths to sit under the owner's own
--    folder ({owner_id}/...), matching the storage policies already in place.
create or replace function public.works_own_paths() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is not null and not public.is_admin() then
    if split_part(new.image_path, '/', 1) <> new.owner_id::text
       or split_part(new.thumb_path, '/', 1) <> new.owner_id::text then
      raise exception 'work image paths must live under your own folder';
    end if;
  end if;
  return new;
end $$;

drop trigger if exists works_own_paths on public.works;
create trigger works_own_paths
  before insert or update on public.works
  for each row execute function public.works_own_paths();

-- After running: re-check that an anonymous `select *` on /rest/v1/profiles
-- returns 400 (email revoke live), and confirm in Authentication -> Providers
-- that every sign-in method except the admin's email/password is disabled
-- (disable_signup only blocks one signup route; the link_profile trigger still
-- auto-adds any new auth user to the public roster).
