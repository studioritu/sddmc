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

export const SUPABASE_URL = 'https://YOUR-PROJECT-REF.supabase.co';
export const SUPABASE_ANON_KEY = 'YOUR-ANON-PUBLIC-KEY';
