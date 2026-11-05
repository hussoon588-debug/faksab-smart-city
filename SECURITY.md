# Security policy

## Supported surface

This repository ships static web applications (FAKSAB SMART CITY, OFUQ) plus the Supabase
schema and RLS policies in `supabase/schema.sql`.

## Reporting a vulnerability

Open a private security advisory on the GitHub repository (Security → Advisories) or contact
the maintainer directly. Please do not open a public issue for anything that could be abused
before it is fixed. We aim to acknowledge reports within 72 hours.

## What may live in the client

- Supabase project URL and the **publishable / anon key** — these are public by design and are
  protected by Row Level Security.
- Game state and preferences in `localStorage`.

## What must never be committed

- `service_role` keys, database passwords, JWT signing secrets.
- APK signing keystores or passwords (`signing/` is git-ignored).
- `.env` files or credentials of any kind.

`npm run check` scans every text file for these patterns and fails the build; CI runs the scan
in strict mode on every push and pull request.

## Backend hardening expectations

- RLS is enabled on `players`, `plots` and `transactions`; clients get `select` only.
- Ownership, balances and prices are written exclusively by `security definer` functions
  (`purchase_plot`) with `set search_path = ''` and `revoke all ... from public, anon`.
- Realtime is read-only for the client; the publication only exposes `public.plots`.

If you change the schema, run it against a scratch Supabase project first and confirm that an
authenticated user cannot update another player's plot or balance directly with the REST API.
