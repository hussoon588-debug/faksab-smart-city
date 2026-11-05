# OFUQ · أفق

A separate product in this repository: a local-first urban-investment simulation with its
own app shell, design system and state container. It shares the FAKSAB palette, the Cairo
webfont and the audit/build/CI tooling, but no runtime code.

```
apps/ofuq/
  index.html               shell: static markup, one module entry, no inline JS
  manifest.webmanifest     PWA manifest (relative id/start_url/scope)
  sw.js                    scope-relative service worker, versioned cache
  assets/                  style.css, icons, Cairo subsets (woff2)
  src/config.js            economy + content data (the balancing surface)
  src/core.js              pure simulation functions, no DOM / no storage
  src/store.js             state, mutations, migration, persistence
  src/ui.js                rendering + event delegation
  src/main.js              bootstrap, error boundary, service worker registration
```

## Product loop

1. **Buy a plot** in one of five districts — the price scales with the district tier.
2. **Develop** it into a residential, retail, office or hospitality asset (level-gated).
3. **Collect** accrued rent (capped at 8 hours, so idling is rewarded but bounded).
4. **Upgrade** to raise income, or **sell** back to the market for a 4% platform fee.
5. **Climb** the weekly league: score blends portfolio value, XP, activity and level.

All numbers live in `src/config.js` (`ECONOMY`, `LEVELS`, `DISTRICTS`, `ASSET_TYPES`,
`WEEKLY_CHALLENGES`). Balancing never requires touching the view layer.

## Architecture rules

- `core.js` is pure: it takes state/plot/district/`now` and returns values. Everything in it
  is unit-tested in `tests/ofuq/core.test.mjs`.
- `store.js` is the only writer. Actions return `{ ok, message }`; the UI never infers why an
  action failed, it just shows the message.
- `ui.js` renders from a store snapshot and routes clicks through `data-action` delegation.
  No inline handlers, no globals — this keeps a future CSP strict mode possible.
- Persistence is versioned (`schemaVersion`) and defensive: hostile or corrupt storage is
  coerced into a valid state instead of crashing the app (`tests/ofuq/store.test.mjs`).
- The DOM smoke test (`tests/ofuq/ui.smoke.test.mjs`) boots the real `index.html` in jsdom and
  walks the whole loop. `jsdom` is the only dev dependency; without it the suite skips.
- `scene.js` splits the city view in two: `buildCityModel()` is pure (snapshot → positioned
  plots, tested in Node) and `createCityScene()` takes the `THREE` namespace as an argument, so
  no test ever needs WebGL. The renderer is loaded with a dynamic `import()` only after
  `supportsWebGL()` returns true; without WebGL the grid and the 2D minimap stay in charge.

## The city view

The city is a 100-plot scene: five districts of twenty plots, positions derived from the same
`plotKey` the rest of the app uses.

- Height reads the level (a level-5 asset is a tower), colour reads the asset class, grey means
  locked, and a green marker means "rent is waiting".
- Drag pans, wheel or pinch zooms, search accepts `OF-014`, `14`, `harbor`, `حي الميناء` or an
  asset name, and the filter chips dim — never delete — the plots that do not match.
- A tap opens the same action sheet as the grid below, so there is exactly one place where a
  purchase can start.
- The minimap is plain 2D canvas: it works even when the 3D renderer does not, and it draws the
  current camera footprint.
- The scene owns no game state: every frame is derived from a store snapshot, which is why
  local mode and server mode look identical.

Vendoring: `vendor/three.module.min.js` (r150.1, MIT, 154 KB gzipped) is committed because the
app ships as plain ES modules with no bundler and must stay offline-capable. See
`apps/ofuq/vendor/README.md` for the exact provenance and the upgrade procedure.

## The shared city (server-authoritative mode)

The game ships in **local mode** (`APP.backend.mode === 'local'`). A complete
server-authoritative backend is included and tested, but it is **opt-in**: nothing changes at
runtime until it is configured. The footer badge states which mode is active («وضع محلي»,
«خادم · بحاجة لتسجيل الدخول», «مدينة مشتركة»), and the shell carries the «قيمة افتراضية داخل
اللعبة» disclaimer in every mode.

What exists:

| Piece | File | Notes |
| --- | --- | --- |
| Schema | `supabase/ofuq/schema.sql` | catalogs, wallets, append-only ledger, plots, weekly stats, missions, RLS + 6 game RPCs |
| Client adapter | `apps/ofuq/src/remote.js` | dependency-free `fetch` wrapper over the RPCs; maps failures to player-safe Arabic |
| Store seam | `apps/ofuq/src/store.js` | `dispatch()` sends **intent only** in server mode and adopts the returned snapshot |
| Contract test | `tests/ofuq/remote.test.mjs` | in-memory fake that mirrors the SQL (auth, ownership, idempotency, economics) |

Rules the backend enforces (never the browser):

- **Money moves only inside the database.** Every mutation writes one `ofuq_ledger` row inside a
  transaction; `ofuq_apply_balance` is the only place a balance changes.
- **Idempotency.** Each mutating RPC takes `p_idempotency` and `ofuq_ledger` has
  `unique(player_id, idempotency_key)`. A retried request is a no-op that returns the current
  snapshot instead of failing or double-charging.
- **Server-side economics.** Price, rent, upgrade cost, sale value and the 8-hour rent cap are
  computed in SQL — the same formulas `core.js` uses offline, duplicated on purpose so the
  client can never propose a price.
- **Validation.** Ownership, district unlock level and available balance are checked in the
  transaction (`for update`), so two tabs cannot buy the same plot.
- **Read access.** RLS gives `authenticated` a `select` on the public map and self-scoped reads
  of its own rows; `ofuq_plots` is public-read so the shared map renders before sign-in.
  Only `authenticated` may execute the RPCs, and no `service_role` key ever reaches the client.

### Turning it on

1. Create a Supabase project, open the SQL editor and run `supabase/ofuq/schema.sql` once.
   It is idempotent (`create or replace`, `on conflict do nothing`) and seeds the five
   districts and their 100 plots.
2. In `apps/ofuq/src/config.js` set `backend.mode = 'supabase'`, `supabaseUrl` and
   `publishableKey` (the **publishable/anon** key — the audit fails the build if a
   `service_role` key appears in any file).
3. `npm run verify` — the schema and adapter are contract-tested against the same fake server.
4. Sign-in: the adapter already exposes `signUp` / `signIn` / `restoreSession` / `signOut`, but
   **no login screen is mounted yet**. In server mode the app therefore boots as «بحاجة لتسجيل
   الدخول» and every write returns «سجّل الدخول للمشاركة في المدينة المشتركة.» until a session
   exists. That is deliberate: no fake buttons, no silent fallbacks.

### What is *not* built yet

- Sign-in / sign-up UI, session expiry UX and account linking (the adapter supports them).
- Realtime presence or push of other players' actions (the map refreshes on request only).
- Player-to-player market, rentals/offers, missions beyond `ofuq_missions` seeds, and the
  admin console. The ledger already has `mission_reward`, `market_fee` and `admin_adjustment`
  reasons so those flows can be added without a migration of history.
- The SQL has been validated by review and by the fake server, **not executed against a live
  Postgres** — no database is available in the build sandbox.

## Adding more server actions

Mirror the existing seam instead of inventing a new one:

1. Add the RPC in `supabase/ofuq/schema.sql` — `security definer`, `set search_path = public`,
   `revoke all` then `grant execute to authenticated`, take `p_idempotency`, write exactly one
   ledger row, and `return public.ofuq_snapshot()`.
2. Call it from `apps/ofuq/src/remote.js` through `guarded(...)`, and expose one method.
3. Route the intent from `store.dispatch()`; the UI needs no change.
4. Extend the fake in `tests/ofuq/remote.test.mjs` first — a rule that is not reachable in the
   fake is a rule the player will find for you in production.

## Documents

- `docs/OFUQ_BUILD_PROMPT.md` — the copy-paste build brief (identity, architecture, RPC
  contract, economy constants, screens, 20 hard rules, staged acceptance criteria).
- `docs/OFUQ_GAP_ANALYSIS.md` — what the published build has, what is wrong with it, and the
  remaining gap against this repository (including the open 3D decision).

## Roadmap

- Per-device ↔ account migration (import a local wallet into a signed-in account).
- Asset-specific upgrade curves instead of one global rate.
- Realtime "other investors" presence in the city: the scene already renders every plot from a
  snapshot, so presence only needs one more field.
- A sign-in screen (the adapter supports `signUp`/`signIn`/`restoreSession`; no UI is mounted).
