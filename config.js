// SDDMC — Supabase connection details.
//
// Fill both values in from your Supabase dashboard:
//   Project Settings -> API -> Project URL, and the "anon public" key.
//
// The anon key belongs here in plain sight. It is a publishable identifier,
// not a password: it says which project you are talking to, and every request
// made with it is still filtered by the Row Level Security policies in
// db/schema.sql. That is what makes it safe to ship in a static site.
//
// The "service_role" key on that same dashboard page is the opposite. It
// bypasses RLS completely. Never put it in this file, in any other file in
// this repo, or anywhere the browser can reach it.

export const SUPABASE_URL = 'https://uslioumewsjucoytezph.supabase.co';
export const SUPABASE_ANON_KEY = 'sb_publishable_KZtQpNweqpvUZ1BYaU4lGg_0OHPnt6C';

// The admin dashboard asks for a club code rather than an email and password.
// That code IS the password of the single shared admin account named below,
// so the page can sign in for real and the database will actually accept its
// writes. A code merely compared in JavaScript would open the panel and then
// have every button rejected by Row Level Security.
//
// This is only an account name, not a secret — the code itself is never in
// this file. To change the code, change that account's password in the
// Supabase dashboard; no redeploy needed.
//
// Worth knowing: everyone who uses the dashboard shares this one identity, so
// the database cannot record which person approved what. Set up per-person
// admin logins instead if you ever need that.
export const ADMIN_EMAIL = 'admin@sddmc.club';
