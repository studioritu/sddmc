-- SDDMC — bulk-create member logins.
--
-- Edit the list below, paste the whole file into the Supabase SQL editor, Run.
-- It prints a table of name / email / password at the end. Copy that table
-- somewhere before you close the tab — the passwords are hashed on the way in
-- and cannot be read back afterwards.
--
-- Safe to re-run: anyone who already has a login is skipped, so you can add
-- names to the list later and run the whole thing again.
--
-- A caveat worth knowing: this writes straight into auth.users, which is
-- Supabase's own table. The supported route is Authentication -> Users -> Add
-- user, one at a time. That is fine for five people and miserable for
-- twenty-five, hence this. The risk is that Supabase changes the shape of
-- auth.users in a future release and this stops working. If it errors, do not
-- fight it — fall back to the dashboard form.
--
-- TEST IT WITH ONE NAME FIRST. Confirm that member can sign in, then add the
-- rest and run it again.

do $$
declare
  r    record;
  uid  uuid;
  pw   text;
begin
  create temp table if not exists new_logins (
    name text, email text, password text
  ) on commit preserve rows;

  for r in
    -- ------------------------------------------------------------------
    -- EDIT HERE: roster name, then the login email to give them.
    -- The name must match public.profiles.name exactly for existing
    -- members; any name not on the roster is added to it.
    -- The email is a login identifier only. No mail is ever sent to it.
    -- ------------------------------------------------------------------
    select * from (values
      ('Mahiba Arshia',          'mahiba@sddmc.club'),
      ('Ahnaf Tahmid Khondaker', 'ahnaf@sddmc.club'),
      ('Abrar Ibn Awwal',        'abrar@sddmc.club')
      -- ,('New Member Name',    'newmember@sddmc.club')
    ) as t(pname, pemail)
  loop
    -- Already has a login: leave it completely alone.
    if exists (select 1 from auth.users where email = r.pemail) then
      continue;
    end if;

    -- The link_profile trigger matches an auth account to a roster row by
    -- email, so the roster row has to carry the email BEFORE the account is
    -- created. Getting this order wrong produces a duplicate profile.
    if exists (select 1 from public.profiles where name = r.pname) then
      update public.profiles set email = r.pemail where name = r.pname;
    else
      insert into public.profiles (name, email, role) values (r.pname, r.pemail, 'Member');
    end if;

    pw  := substr(md5(random()::text || clock_timestamp()::text), 1, 8);
    uid := gen_random_uuid();

    insert into auth.users (
      instance_id, id, aud, role, email, encrypted_password,
      email_confirmed_at, created_at, updated_at,
      raw_app_meta_data, raw_user_meta_data
    ) values (
      '00000000-0000-0000-0000-000000000000', uid, 'authenticated', 'authenticated',
      r.pemail, extensions.crypt(pw, extensions.gen_salt('bf')),
      -- Setting this is what "Auto Confirm User" does in the dashboard.
      -- Without it the account exists but cannot sign in.
      now(), now(), now(),
      '{"provider":"email","providers":["email"]}'::jsonb, '{}'::jsonb
    );

    -- Recent versions of Supabase Auth will not authenticate a user with no
    -- matching identity row, even when the password is correct.
    insert into auth.identities (
      id, user_id, identity_data, provider, provider_id,
      last_sign_in_at, created_at, updated_at
    ) values (
      gen_random_uuid(), uid,
      jsonb_build_object('sub', uid::text, 'email', r.pemail),
      'email', uid::text, now(), now(), now()
    );

    insert into new_logins values (r.pname, r.pemail, pw);
  end loop;
end $$;

-- Hand these out. They are not recoverable later; to change one, use
-- Authentication -> Users -> ... -> Reset password.
select name, email, password from new_logins order by name;
