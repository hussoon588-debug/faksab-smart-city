# فكسب · FAKSAB SMART CITY 8.2

Arabic RTL real-estate city game. The web build is published on GitHub Pages:

- Game: https://hussoon588-debug.github.io/faksab-smart-city/
- OFUQ (new product in this repo): https://hussoon588-debug.github.io/faksab-smart-city/apps/ofuq/
- Hub: https://hussoon588-debug.github.io/projects/

## What is in this release

- Single-file city game (`index.html`) — map, building, levels, economy (local save).
- Shared world layer (`src/supabase-world.js`) — Supabase Auth + PostgreSQL `plots`
  table + Realtime, five cities × 50 plots, atomic `purchase_plot` RPC.
- `supabase/schema.sql` — tables, RLS, trigger, seed data and the purchase function.
- **OFUQ · أفق** (`apps/ofuq/`) — separate product: a local-first urban-investment
  simulation with its own app shell, pure simulation core and tests. See
  [`docs/OFUQ.md`](docs/OFUQ.md).

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

```bash
npm run dev        # → http://localhost:8000/          (FAKSAB)
                   # → http://localhost:8000/apps/ofuq/  (OFUQ)
```

No install step is required: the tooling uses Node.js built-ins only
(`node >= 20.11`, see `.nvmrc`). Any static server works too, e.g.
`python3 -m http.server 8000`. Service workers require `http://` or `https://`.

## Checks, build and CI

| Command | Purpose |
| --- | --- |
| `npm run check` | Static audit (markup, ids, references, manifests, service workers, JS/CSS syntax, secrets). |
| `npm test` | Unit + build tests (`node --test`), no network access. |
| `npm run build` | Audit, then assemble `dist/` with `dist/build-info.json` (commit + file hashes). |
| `npm run verify` | `check && test && build` — run before pushing. |

Apps, versions and publish paths live in `config/apps.json`; the audit fails when a
manifest version or a service worker cache name drifts from it. CI runs the same gates on
every push and pull request (`.github/workflows/ci.yml`).

Read [`docs/PRODUCTION.md`](docs/PRODUCTION.md) for the deployment model, GitHub Pages rules
(relative paths only) and the security boundaries, and [`CONTRIBUTING.md`](CONTRIBUTING.md)
before changing the schema or shipping a release.
