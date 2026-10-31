# فكسب · FAKSAB SMART CITY 8.2

Arabic RTL real-estate city game. The web build is published on GitHub Pages:

- Game: https://hussoon588-debug.github.io/faksab-smart-city/
- Hub: https://hussoon588-debug.github.io/projects/

## What is in this release

- Single-file city game (`index.html`) — map, building, levels, economy (local save).
- Shared world layer (`src/supabase-world.js`) — Supabase Auth + PostgreSQL `plots`
  table + Realtime, five cities × 50 plots, atomic `purchase_plot` RPC.
- `supabase/schema.sql` — tables, RLS, trigger, seed data and the purchase function.

## Backend setup (one time, owner's dashboard)

1. Supabase Dashboard → SQL Editor → New query → paste `supabase/schema.sql` → Run.
2. Authentication → Providers → Email → keep enabled. For instant sign-up, turn
   **Confirm email** off; otherwise new players must click a link before logging in.

The browser holds only the project URL and the publishable (anon) key — those are
meant for the client. Never put the database password or `service_role` key in this
repository or in any front-end file.

## Known seam

The shared world (Supabase panel) and the local city game currently run side by side:
a plot bought in the Supabase panel does not appear on the local map, and the local
`buyLand()` does not write to the database. Wiring the two is the next development
step.

## Local run

Any static server over the folder, e.g. `python3 -m http.server 8000`, then open
`http://localhost:8000/`. Service worker requires `http://` or `https://`.
