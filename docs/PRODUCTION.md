# Production foundation

This document describes how the deployable web apps in this repository are audited,
built and shipped. It is the reference for maintainers.

## Layout

```
index.html            FAKSAB SMART CITY — hand-authored single-file app (live site root)
src/                  FAKSAB shared modules (Supabase world layer) + legacy template
supabase/schema.sql   database schema, RLS policies and the atomic purchase_plot RPC
apps/ofuq/            OFUQ — separate product, own app shell and modules
config/apps.json      single source of truth: entry points, versions, publish paths
tools/                dev server, static audit, production build (zero dependencies)
tests/                node:test suites (unit + build integration)
dist/                 build output (git-ignored)
```

## Commands

| Command | What it does |
| --- | --- |
| `npm run dev` | Static dev server on `0.0.0.0:8000` (override with `PORT`). Serves FAKSAB at `/` and OFUQ at `/apps/ofuq/`. |
| `npm run check` | Static audit: markup, ids, local references, manifests, service workers, JS/CSS syntax, secrets. |
| `npm run check:strict` | Same as above, but warnings also fail. This is what CI runs. |
| `npm test` | `node --test` suites. No dependencies, no network. |
| `npm run build` | Audit + assemble `dist/` + write `dist/build-info.json` (commit, file hashes). |
| `npm run verify` | `check && test && build` — run this before pushing. |

## What the audit enforces

`tools/lib/audit.mjs` inspects every app declared in `config/apps.json`:

- **Markup contract** — doctype, `lang="ar"`, `dir="rtl"`, charset, viewport, non-empty title.
- **No leftovers** — unresolved `__PLACEHOLDER__` tokens and escaped `\n` leaks that would
  render as visible text.
- **Broken references** — every local `src`/`href`/`srcset`/`url()`/ES-module import must
  exist on disk, including files listed in each service worker precache list.
- **Element contract** — unique ids, and every id a script looks up (`getElementById`, `$()`)
  must exist in the markup.
- **Syntax** — every inline script and every `.js`/`.mjs` file under an app's `src/` is
  parsed (`node --check` semantics); CSS must have balanced braces.
- **PWA contract** — manifest is valid JSON with installable fields, declared icons exist, and
  `manifest.version` matches `config/apps.json`. Service worker `CACHE_NAME` must contain the
  app version, otherwise clients keep stale files after a release.
- **Secrets** — no `service_role` keys, private keys, credential-bearing database URLs,
  GitHub tokens or hard-coded JWTs anywhere in text files.

## Publishing rules (GitHub Pages)

The live site is deployed from the `main` branch root today, so the app is served from
`https://<owner>.github.io/faksab-smart-city/`. Everything must therefore work both at a
domain root and under a repository subpath:

- Use **relative** URLs in markup (`./vendor/...`), never `/faksab-smart-city/...`.
- Manifest `id`, `start_url` and `scope` are `"./"` — they resolve against the manifest URL,
  which is correct in both deployment modes.
- Service workers derive their scope from `self.registration.scope` and precache relative
  paths, so the same file works locally and in production.
- Bump the app version in `config/apps.json` **and** the app's manifest when shipping; the
  audit fails if they disagree or if the service worker cache name is not bumped.

`npm run build` produces a deployable `dist/`. The `Deploy to GitHub Pages` workflow is
manual (`workflow_dispatch`) and only works after the Pages source is switched to
"GitHub Actions" in repository settings.

## Security boundaries

- The browser may hold the Supabase **project URL and publishable (anon) key** — they are
  public by design. Row Level Security in `supabase/schema.sql` is the security boundary.
- `service_role`, the database password and signing keys never enter this repository.
  `signing/` is git-ignored and the audit fails the build if a service key appears in any text
  file.
- Ownership and balances are server-managed: clients have `select` only on `plots`, and all
  writes go through the `purchase_plot` RPC.

## Release checklist

1. `npm run verify` is green locally.
2. Version bumped in `config/apps.json`, the app manifest, and the service worker cache name.
3. `CHANGELOG`-style summary written in the pull request.
4. CI is green on the pull request.
5. Merge to `main` (squash) — branch-based Pages deployment picks it up on the next build.
6. Verify the live URL on a phone: install prompt, offline reload, and the shared-world panel.

## Rollback

The site is static and versioned in Git: revert the merge commit on `main` and push. Because
service workers cache aggressively, a rollback also requires bumping the cache version so
clients pick the reverted files up instead of serving the newer cache.
