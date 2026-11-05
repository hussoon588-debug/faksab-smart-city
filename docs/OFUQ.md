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

## The market (players only)

Selling to the city is instant and always available. Selling **to another player** is a
different product: a real listing, a real price and a real counterparty.

- **No simulation.** In local mode the market tab shows a gate («السوق بين اللاعبين يحتاج جلسة
  خادم») and the board stays empty. There is no generated seller, no fake offer, no button that
  cannot work.
- **Listing** happens from the plot sheet: a price (minimum 100), a 48-hour default clock, one
  open offer per plot. The sheet shows the **net after the 4% fee** before publishing, and warns
  when the price is more than 15% below book value.
- **Accepting** takes two taps on purpose (arm → confirm), because it moves real balance.
- **One transaction, three ledger rows**: the buyer is debited `plot_purchase`, the seller is
  credited `sale` and charged `market_fee`. The plot keeps its asset and level; the rental clock
  restarts at the transfer, so the buyer never inherits the seller's accrued rent.
- **Expiry** is enforced server-side (`expires_at`), the board only lists live offers, and an
  expired offer cannot be accepted.

| RPC | What it guarantees |
| --- | --- |
| `ofuq_list_offer(plot, price, hours, key)` | ownership, developed plot, price bounds, one open offer per plot |
| `ofuq_cancel_offer(offer, key)` | seller only, open only |
| `ofuq_accept_offer(offer, key)` | not your own offer, live offer, unchanged ownership, sufficient balance, atomic transfer |

Non-monetary actions are idempotent too: `ofuq_market_requests (player_id, request_key)` makes a
retried `list`/`cancel`/`accept` a no-op that returns the current snapshot.


## Leasing (renting the income, not the plot)

A sale moves the deed. A **lease** moves only the *income* for a fixed window: the tenant pays
up front, collects the rent until the clock runs out, and the plot goes back to earning for its
owner. Ownership never changes hands, so nobody loses a building they paid for.

- **Listing** happens from the plot sheet, next to the market block: a fee (minimum 100), a
  window of 1–168 hours (24 by default) and a 48-hour listing clock. The sheet shows the net
  after the 4% fee, the rent per hour, and how much the tenant can actually collect.
- **Accrued rent is settled to the owner first.** The instant a lease is accepted, whatever the
  plot earned since the owner's last collection is paid to the owner in its own `rent` row. The
  handover never confiscates earned income, and the tenant starts from zero.
- **While the lease runs** the owner cannot collect («الإيجار للمستأجر حتى نهاية المدة»), cannot
  sell to the city, and cannot list the plot for sale. The tenant collects through the normal
  `ofuq_collect_rent`, capped at the same 8 hours.
- **When it ends** the income returns to the owner automatically: leases are read as
  `status = 'active' and ends_at > now()`, and `ofuq_expire_leases()` closes stale rows.
- **One transaction, three ledger rows**: the tenant is debited `lease_payment`, the owner is
  credited `lease_income` and charged `market_fee`.
- **No simulation.** In local mode the lease board shows a gate; no lease is ever invented.

| RPC | What it guarantees |
| --- | --- |
| `ofuq_list_lease(plot, fee, hours, window, key)` | ownership, developed plot, no running lease, no open offer, fee/hour bounds |
| `ofuq_accept_lease(offer, key)` | lease offer only, not your own, live offer, unchanged ownership, no running lease, sufficient balance, settles accrued rent, atomic handover |

A lease is private: `ofuq_leases` is readable only by its two players, while the *listing* lives
on the public market board like any other offer.

## The ledger

Money is not a number that changes; it is the sum of movements. Every action that touches the
balance writes exactly one row — `{ reason, amount, balanceAfter, ref, ts }` — in `state.ledger`
(local mode) or comes back inside the server snapshot (`ofuq_ledger`, last 100 rows).

- **Same vocabulary in both modes.** Reasons are the SQL strings: `signup_bonus`,
  `plot_purchase`, `development`, `upgrade`, `rent`, `sale`, `mission_reward`, `market_fee`,
  `lease_payment`, `lease_income`,
  `admin_adjustment` — plus `opening_balance` for a wallet that predates the ledger.
- **`balanceAfter` is the proof.** The wallet prints «الرصيد X — مطابق للسجل» by comparing the
  newest row with the balance. If they ever disagree the screen says so instead of hiding it.
- **`ref` ties a row to a plot**, so the plot sheet shows its own history (purchase, works,
  upgrades, every rent collection) and a sold plot keeps its record.
- `collectAll` writes **one row per building**, so a lump sum never hides which asset paid what.
- The list is capped at 400 rows locally (storage safety) and grouped by day with a per-day net;
  filters are «الكل / داخل / خارج / إيجار».
- A pre-ledger save is migrated to a single `opening_balance` row dated at the wallet's creation
  rather than pretending the history exists.

## Weekly report & milestones

Both are **derived, never stored** — they read the same ledger rows as the wallet, so they
cannot tell a different story than the balance.

- **تقرير الأسبوع** (league tab): income, spend and net for the current ISO week (Monday →
  Monday, in the player's own timezone), a seven-bar chart whose bars are that day's net, the
  best day, and the plot that earned the most. Comparison with last week appears only when last
  week actually has rows; otherwise the card says «لا بيانات للأسبوع الماضي» instead of a fake
  percentage.
- **Opening balances are not income.** `signup_bonus` and `opening_balance` are excluded from
  the report, otherwise every new wallet would "earn" 12,000 in week one.
- **الإنجازات**: ten milestones (first plot, first build, five plots, all five districts, a
  level-5 tower, ten collections, 100/hour income, 40,000 net worth, three sales, fifty ledger
  rows) with a progress bar and no rewards. No cash, no XP, nothing to claim — a milestone you
  cannot mint money from is a milestone that stays honest in both local and server mode.

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
| Contract test | `tests/ofuq/remote.test.mjs` | in-memory fake that mirrors the SQL (auth, ownership, idempotency, economics, ledger) |

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

### Accounts

`store.auth` is the seam between the UI and the adapter, and the settings sheet is its only
door:

- **Local mode** (default): the panel says «هذه النسخة تعمل محلياً…» and shows no form, because
  a login button with no server is exactly the fake button the rules forbid.
- **Server mode, signed out**: email + password with client-side validation (email shape, six
  characters minimum), «تسجيل الدخول» and «إنشاء حساب». Every failure is a sentence, not a
  silent no-op.
- **Server mode, signed in**: the account row shows the email, «مزامنة» re-reads the city, and
  «خروج» ends the session. The mirror stays on screen (the city is still readable) but every
  write returns «سجّل الدخول…».
- A stored session is restored at boot, so a returning player is not asked again.
- `حذف التقدم` is **disabled in server mode**: wiping the local mirror would hide, not delete,
  the account — the exact lie this product forbids.

Not built yet: password reset, email confirmation UX, Google/Apple sign-in, MFA and session
listing. Those are provider features that need a domain and an identity decision.

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

- Password reset, email confirmation, Google/Apple, MFA, account linking and session expiry UX.
- Realtime presence or push of other players' actions (the map refreshes on request only).
- **Rentals** (lease an asset for a number of hours) — sale offers ship in 0.5.0, rentals do not.
- Missions beyond the `ofuq_missions` seeds, and the admin console. The ledger already has
  `mission_reward` and `admin_adjustment` reasons so those flows need no history migration.
- A browser-side market in local mode: deliberately not built — see «The market» above.
- A local-mode lease: renting needs two real accounts, so the board stays gated instead.
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
