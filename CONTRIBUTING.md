# Contributing

## Workflow

1. Branch from `main` (`feature/...`, `fix/...`).
2. Keep changes scoped; the FAKSAB game shell is a single hand-authored file — avoid
   reformatting it wholesale, it makes review impossible.
3. Run `npm run verify` (audit → tests → build) before opening a pull request.
4. Open a pull request with the template filled in: what changed, which checks ran, and the
   risk to existing functionality.

## Rules that the CI enforces

- `npm run check:strict` must pass — broken local references, duplicate/missing element ids,
  invalid manifests, un-bumped service worker cache names, unresolved placeholders and
  committed secrets all fail the build.
- `npm test` must pass.
- `npm run build` must succeed (it runs the audit again as a pre-flight gate).

## Conventions

- **Paths**: relative only (`./vendor/...`). The site is served from a repository subpath and
  must also work from a domain root.
- **Versions**: bump `config/apps.json` *and* the app manifest *and* the service worker
  `CACHE_NAME` in the same change.
- **Secrets**: only the Supabase publishable (anon) key and project URL may appear in client
  code. Never commit `service_role`, database passwords, APK signing keys (`signing/`) or
  `.env` files.
- **Arabic UI**: every user-facing string is Arabic and the document is RTL. Numbers use
  `toLocaleString('ar-EG' | 'en-US')` consistently per screen.
- **Dependencies**: the tooling is deliberately dependency-free (Node built-ins only). Adding a
  runtime dependency to a static app needs a clear justification in the pull request.

## Adding a new app

1. Create the folder, e.g. `apps/my-app/` with `index.html`, a manifest, a service worker and
   `src/` ES modules.
2. Register it in `config/apps.json` (`entry`, `manifest`, `serviceWorker`, `requiredFiles`,
   `copy`).
3. Run `npm run check` — it audits the new app with the same gates as the existing ones.
