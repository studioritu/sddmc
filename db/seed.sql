-- SDDMC — initial roster.
-- Run once, after db/schema.sql, in the Supabase SQL editor.
-- Safe to re-run: inserts are skipped if a row with that name already exists.
--
-- These are the five entries currently hardcoded at admin.html:253.
-- No emails are set here. See "Issuing logins" at the bottom before you
-- create anyone's account, including your own.

insert into public.profiles (name, role, sort_order)
select v.name, v.role, v.sort_order
from (values
  ('Saahil Talha',           'President',                10),
  ('Mahiba Arshia',          'Vice President',           20),
  ('Ahnaf Tahmid Khondaker', 'General Secretary',        30),
  ('Abrar Ibn Awwal',        'General Secretary',        40),
  ('[Moderator name]',       'Club moderator / Faculty', 50)
) as v(name, role, sort_order)
where not exists (
  select 1 from public.profiles p where p.name = v.name
);

select name, role, sort_order, email, user_id, is_admin
from public.profiles
order by sort_order;


-- ---------------------------------------------------------------------------
-- The admin dashboard account  (do this first)
-- ---------------------------------------------------------------------------
--
-- /admin asks for one club code, not an email and password. That code is the
-- password of a single shared account, so the dashboard signs in for real and
-- the database accepts what it does. Without this account the panel would open
-- and then every button would be refused by Row Level Security.
--
--   1. Authentication -> Users -> Add user -> Create new user
--        Email     admin@sddmc.club   (must match ADMIN_EMAIL in config.js)
--        Password  <the club code>    (Supabase requires 6 characters or more)
--        Tick "Auto Confirm User".
--
--      The address does not need to receive mail — it is a login name, and
--      nobody types it: the dashboard has one field and fills the email in
--      from config.js. The password IS the club code.
--
--      The code is deliberately not written down anywhere in this repository.
--      It lives only in Supabase, so it cannot be read out of the published
--      JavaScript and changing it never needs a redeploy.
--
--   2. Mark it admin, and keep it off the roster. is_roster = false is what
--      stops this account showing up as a club member on the site:
--
--        update public.profiles
--           set is_admin = true, is_roster = false, name = 'Club admin'
--         where email = 'admin@sddmc.club';
--
--   3. Check it worked:
--
--        select name, email, is_admin, is_roster from public.profiles
--         where email = 'admin@sddmc.club';
--
-- To change the club code later, change that user's password in the dashboard.
-- Nothing in this repository needs editing and no redeploy is needed.
--
-- Anyone who knows the code has full admin, and the database records every
-- action as this one account rather than as a named person. If you ever need
-- to know who approved what, give each exec their own login (see below) and
-- switch the dashboard back to email and password.


-- ---------------------------------------------------------------------------
-- Issuing member logins
-- ---------------------------------------------------------------------------
--
-- Order matters. The on_auth_user_created trigger links a new login to an
-- existing roster row *by email*. If the roster row has no email when you
-- create the login, the trigger cannot match it and creates a second,
-- duplicate profile instead.
--
-- So, for each person, always:
--
--   1. Set their email on the roster row FIRST:
--
--        update public.profiles
--           set email = 'someone@example.com'
--         where name = 'Their Name';
--
--   2. Then create the login in the dashboard:
--        Authentication → Users → Add user → Create new user
--        - use that same email
--        - set a password you generate for them, NOT one they already use
--        - tick "Auto Confirm User" (the free tier's built-in mail is rate
--          limited to a few messages an hour, so confirmation emails are
--          unreliable — and there is no self-service password reset without
--          your own SMTP; you reset from this dashboard instead)
--
--   3. Verify it linked rather than duplicated:
--
--        select name, email, user_id from public.profiles order by sort_order;
--
--      Each issued account should appear on exactly one row, with a
--      non-null user_id. Two rows for one person means step 1 was skipped.
--
-- Make yourself an admin once your own login exists:
--
--   update public.profiles set is_admin = true where email = 'you@example.com';
--
-- Give a second exec admin access too. Without a working login you cannot
-- reach the admin panel at all, and with only one admin there is nobody who
-- can restore your access if you lose it.
