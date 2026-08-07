// Keeps the Supabase project awake.
//
// Free projects pause after roughly a week with no requests, and a club site
// can easily go that quiet over a holiday. A paused project means the whole
// site stops loading until someone unpauses it by hand in the dashboard, so
// this is less trivial than it looks.
//
// Driven by the "crons" entry in vercel.json. Vercel Hobby allows one cron run
// per day, which is well inside the pause window.
//
// Set these in Vercel: Project Settings -> Environment Variables.
//   SUPABASE_URL       same value as in config.js
//   SUPABASE_ANON_KEY  same value as in config.js
// The anon key is fine here. Never put the service_role key in this project.

const TIMEOUT_MS = 8000;

export default async function handler(req, res) {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_ANON_KEY;

  if (!url || !key) {
    return res.status(500).json({
      ok: false,
      error: 'Set SUPABASE_URL and SUPABASE_ANON_KEY in the Vercel project environment variables.',
    });
  }

  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), TIMEOUT_MS);

  try {
    // Cheapest read that still touches Postgres. A request that only hit the
    // CDN would not count as activity and the project would pause anyway.
    const r = await fetch(`${url}/rest/v1/profiles?select=id&limit=1`, {
      headers: { apikey: key, Authorization: `Bearer ${key}` },
      signal: abort.signal,
    });
    return res.status(r.ok ? 200 : 502).json({ ok: r.ok, status: r.status });
  } catch (error) {
    return res.status(502).json({ ok: false, error: error.message });
  } finally {
    clearTimeout(timer);
  }
}
