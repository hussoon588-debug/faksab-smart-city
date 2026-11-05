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

## Adding a backend (the sync seam)

The shell is deliberately local-first (`APP.backend.mode === 'local'`). To synchronise
between devices, mirror the FAKSAB approach:

1. Create the tables/functions in Supabase (see `supabase/schema.sql` for the RLS pattern:
   clients get `select` only, every write goes through a `security definer` RPC).
2. Add the project URL + publishable key to a new `src/remote.js`; never ship a
   `service_role` key (the audit fails the build if one appears).
3. Extend `store.js`: keep the optimistic local mutation, then push it through the RPC and
   reconcile on `realtime` events. Actions already funnel through one place, so the UI does
   not change.
4. Flip `APP.backend.mode` and update the footer badge.

## Roadmap

- Per-device ↔ account migration (import a local wallet into a signed-in account).
- Asset-specific upgrade curves instead of one global rate.
- Realtime "other investors" presence in the city grid.
