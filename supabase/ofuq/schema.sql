-- OFUQ · أفق — server-authoritative economy (run once in the Supabase SQL editor).
--
-- Design rules (from the production checklist):
--   * The browser is never the source of truth for balance, price, ownership or income.
--   * Every balance change is an append-only ledger row (delta + balance_after + reason).
--   * All writes go through SECURITY DEFINER functions; clients get SELECT only.
--   * Every mutating RPC takes an idempotency key so a retried request can never be
--     applied twice (unique (player_id, idempotency_key)).
--   * Prices, costs, rents and XP gates are read from catalog tables, never from the client.
--
-- Apply in order. Safe to re-run: tables use IF NOT EXISTS, seeds use ON CONFLICT.

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------- catalogs ---

create table if not exists public.ofuq_levels (
  level integer primary key check (level between 1 and 10),
  xp bigint not null check (xp >= 0),
  name text not null
);

create table if not exists public.ofuq_districts (
  id text primary key,
  name text not null,
  tier numeric(4,2) not null check (tier >= 1),
  unlock_level integer not null default 1 check (unlock_level between 1 and 10),
  plots integer not null default 20 check (plots between 1 and 200),
  accent text not null default '#3ad6ff'
);

create table if not exists public.ofuq_assets (
  id text primary key,
  name text not null,
  cost bigint not null check (cost > 0),
  rent bigint not null check (rent >= 0),
  unlock_level integer not null default 1 check (unlock_level between 1 and 10)
);

create table if not exists public.ofuq_missions (
  id text primary key,
  title text not null,
  metric text not null check (metric in ('developed', 'collected', 'upgraded', 'plotsOwned')),
  target integer not null check (target > 0),
  reward bigint not null check (reward > 0),
  xp integer not null default 0 check (xp >= 0)
);

-- ------------------------------------------------------------------ players ---

create table if not exists public.ofuq_players (
  id uuid primary key references auth.users(id) on delete cascade,
  display_name text not null default 'مستثمر أفق' check (char_length(display_name) between 2 and 24),
  xp bigint not null default 0 check (xp >= 0),
  created_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now()
);

create table if not exists public.ofuq_wallets (
  player_id uuid primary key references public.ofuq_players(id) on delete cascade,
  balance bigint not null default 0 check (balance >= 0),
  updated_at timestamptz not null default now()
);

-- Append-only: no UPDATE/DELETE policies and no grants, so the client cannot rewrite history.
create table if not exists public.ofuq_ledger (
  id bigserial primary key,
  player_id uuid not null references public.ofuq_players(id) on delete cascade,
  delta bigint not null check (delta <> 0),
  balance_after bigint not null check (balance_after >= 0),
  reason text not null check (reason in (
    'signup_bonus', 'plot_purchase', 'development', 'upgrade', 'rent', 'sale',
    'mission_reward', 'market_fee', 'admin_adjustment', 'lease_payment', 'lease_income'
  )),
  ref_id text,
  idempotency_key text,
  created_at timestamptz not null default now(),
  unique (player_id, idempotency_key)
);
-- Leasing added two reasons; widen the check on databases created before it existed.
alter table public.ofuq_ledger drop constraint if exists ofuq_ledger_reason_check;
alter table public.ofuq_ledger add constraint ofuq_ledger_reason_check check (reason in (
  'signup_bonus', 'plot_purchase', 'development', 'upgrade', 'rent', 'sale',
  'mission_reward', 'market_fee', 'admin_adjustment', 'lease_payment', 'lease_income'
));

create index if not exists ofuq_ledger_player_idx on public.ofuq_ledger (player_id, created_at desc);

-- -------------------------------------------------------------------- plots ---

create table if not exists public.ofuq_plots (
  id uuid primary key default gen_random_uuid(),
  district_id text not null references public.ofuq_districts(id),
  plot_no integer not null check (plot_no between 1 and 200),
  price bigint not null check (price > 0),
  owner_id uuid references public.ofuq_players(id) on delete set null,
  asset_id text references public.ofuq_assets(id),
  level integer not null default 0 check (level between 0 and 5),
  purchased_at timestamptz,
  last_collected_at timestamptz,
  unique (district_id, plot_no),
  check (asset_id is null or owner_id is not null),
  check ((asset_id is null and level = 0) or asset_id is not null)
);
create index if not exists ofuq_plots_owner_idx on public.ofuq_plots (owner_id);

create table if not exists public.ofuq_weekly_stats (
  player_id uuid not null references public.ofuq_players(id) on delete cascade,
  week_key text not null,
  bought integer not null default 0 check (bought >= 0),
  developed integer not null default 0 check (developed >= 0),
  upgraded integer not null default 0 check (upgraded >= 0),
  collected integer not null default 0 check (collected >= 0),
  primary key (player_id, week_key)
);

create table if not exists public.ofuq_claims (
  player_id uuid not null references public.ofuq_players(id) on delete cascade,
  week_key text not null,
  mission_id text not null references public.ofuq_missions(id),
  reward bigint not null,
  xp integer not null default 0,
  created_at timestamptz not null default now(),
  primary key (player_id, week_key, mission_id)
);

-- ------------------------------------------------------------- seed catalogs ---

insert into public.ofuq_levels (level, xp, name) values
  (1, 0, 'مستثمر جديد'),
  (2, 700, 'مالك قطعة'),
  (3, 1800, 'مطوّر ناشئ'),
  (4, 3600, 'مستثمر محلي'),
  (5, 6000, 'مطوّر حضري'),
  (6, 9000, 'مستثمر إقليمي'),
  (7, 13000, 'شريك تطوير'),
  (8, 18000, 'صندوق عقاري'),
  (9, 24500, 'مستثمر استراتيجي'),
  (10, 32000, 'قطب حضري')
on conflict (level) do update set xp = excluded.xp, name = excluded.name;

insert into public.ofuq_districts (id, name, tier, unlock_level, plots, accent) values
  ('harbor',   'حي الميناء',    1.00, 1, 20, '#3ad6ff'),
  ('garden',   'حي الحدائق',    1.15, 1, 20, '#33e08c'),
  ('downtown', 'المركز التجاري', 1.35, 2, 20, '#ffd24a'),
  ('tech',     'وادي التقنية',   1.60, 3, 20, '#8a6bff'),
  ('horizon',  'أفق الشمال',    2.00, 4, 20, '#ff8a5c')
on conflict (id) do update set name = excluded.name, tier = excluded.tier,
  unlock_level = excluded.unlock_level, plots = excluded.plots, accent = excluded.accent;

insert into public.ofuq_assets (id, name, cost, rent, unlock_level) values
  ('studio',      'سكني',  1400, 34,  1),
  ('retail',      'تجاري', 3000, 82,  2),
  ('office',      'مكتبي', 5600, 168, 3),
  ('hospitality', 'فندقي', 9500, 300, 5)
on conflict (id) do update set name = excluded.name, cost = excluded.cost,
  rent = excluded.rent, unlock_level = excluded.unlock_level;

insert into public.ofuq_missions (id, title, metric, target, reward, xp) values
  ('develop3', 'ثلاثة أصول',      'developed',  3, 600, 90),
  ('collect8', 'حصّاد الإيجارات', 'collected',  8, 750, 110),
  ('upgrade2', 'رفع السقف',       'upgraded',   2, 650, 100),
  ('own4',     'محفظة متنوعة',    'plotsOwned', 4, 800, 120)
on conflict (id) do update set title = excluded.title, metric = excluded.metric,
  target = excluded.target, reward = excluded.reward, xp = excluded.xp;

-- 5 districts × 20 plots. Price = round(400 × tier / 50) × 50, identical to the client formula.
insert into public.ofuq_plots (district_id, plot_no, price)
select d.id, n, (round(400 * d.tier / 50.0) * 50)::bigint
from public.ofuq_districts d
cross join generate_series(1, 200) as n
where n <= d.plots
on conflict (district_id, plot_no) do nothing;

-- ------------------------------------------------------------------ helpers ---

create or replace function public.ofuq_iso_week()
returns text language sql stable as $$
  select to_char(now(), 'IYYY-"W"IW');
$$;

create or replace function public.ofuq_level(p_xp bigint)
returns integer language sql stable set search_path = '' as $$
  select coalesce(max(level), 1) from public.ofuq_levels where xp <= greatest(p_xp, 0);
$$;

-- Creates the player + wallet on first call (users created before the trigger existed).
create or replace function public.ofuq_ensure_player()
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null then raise exception 'يجب تسجيل الدخول أولاً' using errcode = '28000'; end if;

  insert into public.ofuq_players (id, display_name)
  values (v_uid, coalesce(nullif(left(trim(coalesce(auth.jwt() -> 'user_metadata' ->> 'display_name', '')), 24), ''), 'مستثمر أفق'))
  on conflict (id) do nothing;

  insert into public.ofuq_wallets (player_id, balance) values (v_uid, 0)
  on conflict (player_id) do nothing;

  -- Starter grant, recorded like every other balance change.
  if not exists (select 1 from public.ofuq_ledger l where l.player_id = v_uid and l.idempotency_key = 'signup_bonus') then
    update public.ofuq_wallets set balance = balance + 12000, updated_at = now() where player_id = v_uid;
    insert into public.ofuq_ledger (player_id, delta, balance_after, reason, idempotency_key)
    select v_uid, 12000, w.balance, 'signup_bonus', 'signup_bonus'
    from public.ofuq_wallets w where w.player_id = v_uid;
  end if;

  return v_uid;
end;
$$;

-- The single place that moves money. Locks the wallet, refuses overdrafts, records the ledger.
create or replace function public.ofuq_apply_balance(
  p_player uuid, p_delta bigint, p_reason text, p_ref text, p_key text
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_balance bigint;
  v_new bigint;
begin
  select balance into v_balance from public.ofuq_wallets where player_id = p_player for update;
  if not found then raise exception 'المحفظة غير موجودة' using errcode = 'P0002'; end if;

  if p_key is not null and exists (
    select 1 from public.ofuq_ledger l where l.player_id = p_player and l.idempotency_key = p_key
  ) then
    return jsonb_build_object('ok', true, 'replayed', true, 'balance', v_balance);
  end if;

  v_new := v_balance + p_delta;
  if v_new < 0 then raise exception 'السيولة غير كافية' using errcode = 'P0001'; end if;

  update public.ofuq_wallets set balance = v_new, updated_at = now() where player_id = p_player;
  insert into public.ofuq_ledger (player_id, delta, balance_after, reason, ref_id, idempotency_key)
  values (p_player, p_delta, v_new, p_reason, p_ref, p_key);

  return jsonb_build_object('ok', true, 'replayed', false, 'balance', v_new);
end;
$$;

-- Deterministic economics, mirrored from apps/ofuq/src/core.js. The client never sends prices.
create or replace function public.ofuq_plot_rent(p_asset text, p_level integer, p_tier numeric)
returns bigint language sql stable set search_path = '' as $$
  select round(
           a.rent
           * (1 + 0.35 * (greatest(p_level, 1) - 1))
           * (1 + 0.15 * (p_tier - 1))
         )::bigint
  from public.ofuq_assets a where a.id = p_asset;
$$;

create or replace function public.ofuq_upgrade_cost(p_asset text, p_level integer, p_tier numeric)
returns bigint language sql stable set search_path = '' as $$
  select (round(a.cost * 0.55 * greatest(p_level, 1) / p_tier / 50.0) * 50)::bigint
  from public.ofuq_assets a where a.id = p_asset;
$$;

create or replace function public.ofuq_plot_value(p_price bigint, p_asset text, p_level integer)
returns bigint language sql stable set search_path = '' as $$
  select p_price + coalesce((
    select round(a.cost * (1 + 0.35 * (greatest(p_level, 1) - 1)) * 0.9)::bigint
    from public.ofuq_assets a where a.id = p_asset
  ), 0);
$$;

-- Authoritative player state: what the client renders after every mutation.
create or replace function public.ofuq_snapshot()
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := public.ofuq_ensure_player();
  v_week text := public.ofuq_iso_week();
  v_result jsonb;
begin
  select jsonb_build_object(
    'player', jsonb_build_object(
      'id', p.id,
      'name', p.display_name,
      'xp', p.xp,
      'level', public.ofuq_level(p.xp)
    ),
    'balance', w.balance,
    'week', v_week,
    'plots', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', pl.id,
        'districtId', pl.district_id,
        'plotNo', pl.plot_no,
        'assetId', pl.asset_id,
        'level', pl.level,
        'purchasedAt', pl.purchased_at,
        'lastCollectedAt', pl.last_collected_at,
        'rent', case when pl.asset_id is null then 0
                     else public.ofuq_plot_rent(pl.asset_id, pl.level, d.tier) end,
        'value', public.ofuq_plot_value(pl.price, pl.asset_id, pl.level)
      ) order by pl.district_id, pl.plot_no)
      from public.ofuq_plots pl
      join public.ofuq_districts d on d.id = pl.district_id
      where pl.owner_id = p.id
    ), '[]'::jsonb),
    'weekly', coalesce((
      select jsonb_build_object('bought', s.bought, 'developed', s.developed,
                                'upgraded', s.upgraded, 'collected', s.collected)
      from public.ofuq_weekly_stats s
      where s.player_id = p.id and s.week_key = v_week
    ), jsonb_build_object('bought', 0, 'developed', 0, 'upgraded', 0, 'collected', 0)),
    'claims', coalesce((
      select jsonb_agg(c.mission_id) from public.ofuq_claims c
      where c.player_id = p.id and c.week_key = v_week
    ), '[]'::jsonb),
    -- The board: every live offer from every player, plus who is selling it.
    'offers', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', o.id,
        'plotId', pl.id,
        'districtId', pl.district_id,
        'plotNo', pl.plot_no,
        'assetId', pl.asset_id,
        'level', pl.level,
        'sellerId', o.seller_id,
        'sellerName', sp.display_name,
        'kind', o.kind,
        'price', o.price,
        'fee', coalesce(o.fee, 0),
        'hours', o.hours,
        'value', public.ofuq_plot_value(pl.price, pl.asset_id, pl.level),
        'expiresAt', o.expires_at,
        'createdAt', o.created_at,
        'mine', o.seller_id = v_uid
      ) order by o.created_at desc)
      from public.ofuq_market_offers o
      join public.ofuq_plots pl on pl.id = o.plot_id
      join public.ofuq_players sp on sp.id = o.seller_id
      where o.status = 'open' and o.expires_at > now()
    ), '[]'::jsonb),
    -- Leases the player is part of: the ones they rent out, and the ones they rent.
    'leases', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', lease.id,
        'plotId', pl.id,
        'districtId', pl.district_id,
        'plotNo', pl.plot_no,
        'assetId', pl.asset_id,
        'level', pl.level,
        'rent', case when pl.asset_id is null then 0
                     else public.ofuq_plot_rent(pl.asset_id, pl.level, d.tier) end,
        'fee', lease.fee,
        'lessorId', lease.lessor_id,
        'lessorName', lp.display_name,
        'lesseeId', lease.lessee_id,
        'lesseeName', tp.display_name,
        'startsAt', lease.starts_at,
        'endsAt', lease.ends_at,
        'lastCollectedAt', coalesce(pl.last_collected_at, lease.starts_at),
        'tenant', lease.lessee_id = v_uid,
        'owner', lease.lessor_id = v_uid
      ) order by lease.starts_at desc)
      from public.ofuq_leases lease
      join public.ofuq_plots pl on pl.id = lease.plot_id
      join public.ofuq_districts d on d.id = pl.district_id
      join public.ofuq_players lp on lp.id = lease.lessor_id
      join public.ofuq_players tp on tp.id = lease.lessee_id
      where lease.status = 'active' and lease.ends_at > now()
        and (lease.lessor_id = p.id or lease.lessee_id = p.id)
    ), '[]'::jsonb),
    -- The wallet screen can only prove the balance if it can read the movements.
    'ledger', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', l.id,
        'seq', l.id,
        'ts', l.created_at,
        'reason', l.reason,
        'amount', l.delta,
        'balanceAfter', l.balance_after,
        'ref', l.ref_id
      ) order by l.created_at desc, l.id desc)
      from (
        select * from public.ofuq_ledger where player_id = p.id
        order by created_at desc, id desc limit 100
      ) l
    ), '[]'::jsonb)
  ) into v_result
  from public.ofuq_players p
  join public.ofuq_wallets w on w.player_id = p.id
  where p.id = v_uid;

  return v_result;
end;
$$;

-- --------------------------------------------------------------- game RPCs ---

create or replace function public.ofuq_purchase_plot(p_district text, p_plot_no integer, p_idempotency text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := public.ofuq_ensure_player();
  v_plot public.ofuq_plots%rowtype;
  v_district public.ofuq_districts%rowtype;
  v_level integer;
  v_player public.ofuq_players%rowtype;
  v_move jsonb;
begin
  -- Retry of a request that already committed: return the truth, do not re-validate state.
  if p_idempotency is not null and exists (
    select 1 from public.ofuq_ledger l where l.player_id = v_uid and l.idempotency_key = p_idempotency
  ) then
    return public.ofuq_snapshot();
  end if;

  select * into v_district from public.ofuq_districts where id = p_district;
  if not found then raise exception 'الحي غير معروف' using errcode = 'P0001'; end if;

  select * into v_player from public.ofuq_players where id = v_uid;
  v_level := public.ofuq_level(v_player.xp);
  if v_level < v_district.unlock_level then
    raise exception 'هذا الحي يُفتح في المستوى %', v_district.unlock_level using errcode = 'P0001';
  end if;

  select * into v_plot from public.ofuq_plots
   where district_id = p_district and plot_no = p_plot_no for update;
  if not found then raise exception 'القطعة غير موجودة' using errcode = 'P0002'; end if;
  if v_plot.owner_id is not null then raise exception 'هذه القطعة مملوكة بالفعل' using errcode = 'P0001'; end if;

  v_move := public.ofuq_apply_balance(v_uid, -v_plot.price, 'plot_purchase', v_plot.id::text, p_idempotency);
  if (v_move ->> 'replayed')::boolean then return public.ofuq_snapshot(); end if;

  update public.ofuq_plots
     set owner_id = v_uid, purchased_at = now()
   where id = v_plot.id;

  update public.ofuq_players set xp = xp + 40, last_seen_at = now() where id = v_uid;
  insert into public.ofuq_weekly_stats (player_id, week_key, bought)
  values (v_uid, public.ofuq_iso_week(), 1)
  on conflict (player_id, week_key) do update set bought = public.ofuq_weekly_stats.bought + 1;

  return public.ofuq_snapshot();
end;
$$;

create or replace function public.ofuq_develop_plot(p_plot uuid, p_asset text, p_idempotency text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := public.ofuq_ensure_player();
  v_plot public.ofuq_plots%rowtype;
  v_asset public.ofuq_assets%rowtype;
  v_player public.ofuq_players%rowtype;
  v_move jsonb;
begin
  -- Retry of a request that already committed: return the truth, do not re-validate state.
  if p_idempotency is not null and exists (
    select 1 from public.ofuq_ledger l where l.player_id = v_uid and l.idempotency_key = p_idempotency
  ) then
    return public.ofuq_snapshot();
  end if;

  select * into v_plot from public.ofuq_plots where id = p_plot for update;
  if not found then raise exception 'القطعة غير موجودة' using errcode = 'P0002'; end if;
  if v_plot.owner_id is distinct from v_uid then raise exception 'هذه القطعة ليست لك' using errcode = '42501'; end if;
  if v_plot.asset_id is not null then raise exception 'القطعة مطوّرة بالفعل' using errcode = 'P0001'; end if;

  select * into v_asset from public.ofuq_assets where id = p_asset;
  if not found then raise exception 'نوع الأصل غير معروف' using errcode = 'P0001'; end if;

  select * into v_player from public.ofuq_players where id = v_uid;
  if public.ofuq_level(v_player.xp) < v_asset.unlock_level then
    raise exception 'هذا الأصل يُفتح في المستوى %', v_asset.unlock_level using errcode = 'P0001';
  end if;

  v_move := public.ofuq_apply_balance(v_uid, -v_asset.cost, 'development', v_plot.id::text, p_idempotency);
  if (v_move ->> 'replayed')::boolean then return public.ofuq_snapshot(); end if;

  update public.ofuq_plots
     set asset_id = v_asset.id, level = 1, last_collected_at = now()
   where id = v_plot.id;

  update public.ofuq_players set xp = xp + 120, last_seen_at = now() where id = v_uid;
  insert into public.ofuq_weekly_stats (player_id, week_key, developed)
  values (v_uid, public.ofuq_iso_week(), 1)
  on conflict (player_id, week_key) do update set developed = public.ofuq_weekly_stats.developed + 1;

  return public.ofuq_snapshot();
end;
$$;

create or replace function public.ofuq_upgrade_plot(p_plot uuid, p_idempotency text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := public.ofuq_ensure_player();
  v_plot public.ofuq_plots%rowtype;
  v_district public.ofuq_districts%rowtype;
  v_cost bigint;
  v_move jsonb;
begin
  -- Retry of a request that already committed: return the truth, do not re-validate state.
  if p_idempotency is not null and exists (
    select 1 from public.ofuq_ledger l where l.player_id = v_uid and l.idempotency_key = p_idempotency
  ) then
    return public.ofuq_snapshot();
  end if;

  select * into v_plot from public.ofuq_plots where id = p_plot for update;
  if not found then raise exception 'القطعة غير موجودة' using errcode = 'P0002'; end if;
  if v_plot.owner_id is distinct from v_uid then raise exception 'هذه القطعة ليست لك' using errcode = '42501'; end if;
  if v_plot.asset_id is null then raise exception 'طوّر القطعة أولاً' using errcode = 'P0001'; end if;
  if v_plot.level >= 5 then raise exception 'وصل الأصل إلى أعلى مستوى' using errcode = 'P0001'; end if;

  select * into v_district from public.ofuq_districts where id = v_plot.district_id;
  v_cost := public.ofuq_upgrade_cost(v_plot.asset_id, v_plot.level, v_district.tier);

  v_move := public.ofuq_apply_balance(v_uid, -v_cost, 'upgrade', v_plot.id::text, p_idempotency);
  if (v_move ->> 'replayed')::boolean then return public.ofuq_snapshot(); end if;

  update public.ofuq_plots set level = level + 1 where id = v_plot.id;
  update public.ofuq_players set xp = xp + 90, last_seen_at = now() where id = v_uid;
  insert into public.ofuq_weekly_stats (player_id, week_key, upgraded)
  values (v_uid, public.ofuq_iso_week(), 1)
  on conflict (player_id, week_key) do update set upgraded = public.ofuq_weekly_stats.upgraded + 1;

  return public.ofuq_snapshot();
end;
$$;

-- Rent is computed from the server clock; the client only asks for it.
create or replace function public.ofuq_collect_rent(p_plot uuid, p_idempotency text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := public.ofuq_ensure_player();
  v_plot public.ofuq_plots%rowtype;
  v_district public.ofuq_districts%rowtype;
  v_lease_lessee uuid;
  v_is_tenant boolean := false;
  v_rate bigint;
  v_elapsed numeric;
  v_capped numeric;
  v_amount bigint;
  v_anchor timestamptz;
begin
  -- Retry of a request that already committed: return the truth, do not re-validate state.
  if p_idempotency is not null and exists (
    select 1 from public.ofuq_ledger l where l.player_id = v_uid and l.idempotency_key = p_idempotency
  ) then
    return public.ofuq_snapshot();
  end if;

  select * into v_plot from public.ofuq_plots where id = p_plot for update;
  if not found then raise exception 'القطعة غير موجودة' using errcode = 'P0002'; end if;
  v_lease_lessee := public.ofuq_active_lease_lessee(v_plot.id);
  v_is_tenant := v_lease_lessee is not null and v_lease_lessee = v_uid;
  if v_plot.owner_id is distinct from v_uid and not v_is_tenant then
    raise exception 'هذه القطعة ليست لك' using errcode = '42501';
  end if;
  -- While a lease runs the income belongs to the tenant: the owner already took the fee.
  if v_lease_lessee is not null and v_plot.owner_id = v_uid then
    raise exception 'القطعة مؤجَّرة — الإيجار للمستأجر حتى نهاية المدة' using errcode = 'P0001';
  end if;
  if v_plot.asset_id is null then raise exception 'لا يوجد أصل على هذه القطعة' using errcode = 'P0001'; end if;
  select * into v_district from public.ofuq_districts where id = v_plot.district_id;
  v_rate := public.ofuq_plot_rent(v_plot.asset_id, v_plot.level, v_district.tier);

  v_elapsed := extract(epoch from (now() - coalesce(v_plot.last_collected_at, now()))) / 3600.0;
  v_capped := least(greatest(v_elapsed, 0), 8);           -- 8h accrual cap, same as the client
  v_amount := floor(v_capped * v_rate)::bigint;

  if v_amount <= 0 then raise exception 'لم يتراكم إيجار كافٍ بعد' using errcode = 'P0001'; end if;

  v_anchor := case when v_elapsed > 8 then now()
                   else coalesce(v_plot.last_collected_at, now()) + (v_capped * interval '1 hour') end;

  perform public.ofuq_apply_balance(v_uid, v_amount, 'rent', v_plot.id::text, p_idempotency);
  update public.ofuq_plots set last_collected_at = v_anchor where id = v_plot.id;
  update public.ofuq_players set xp = xp + 6, last_seen_at = now() where id = v_uid;
  insert into public.ofuq_weekly_stats (player_id, week_key, collected)
  values (v_uid, public.ofuq_iso_week(), 1)
  on conflict (player_id, week_key) do update set collected = public.ofuq_weekly_stats.collected + 1;

  return public.ofuq_snapshot();
end;
$$;

create or replace function public.ofuq_sell_plot(p_plot uuid, p_idempotency text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := public.ofuq_ensure_player();
  v_plot public.ofuq_plots%rowtype;
  v_value bigint;
  v_proceeds bigint;
begin
  select * into v_plot from public.ofuq_plots where id = p_plot for update;
  if not found then raise exception 'القطعة غير موجودة' using errcode = 'P0002'; end if;
  if v_plot.owner_id is distinct from v_uid then raise exception 'هذه القطعة ليست لك' using errcode = '42501'; end if;
  if public.ofuq_plot_is_leased(v_plot.id) then
    raise exception 'القطعة مؤجَّرة — انتظر انتهاء الإيجار قبل البيع' using errcode = 'P0001';
  end if;

  v_value := public.ofuq_plot_value(v_plot.price, v_plot.asset_id, v_plot.level);
  v_proceeds := round(v_value * 0.96);                     -- 4% platform fee

  perform public.ofuq_apply_balance(v_uid, v_proceeds, 'sale', v_plot.id::text, p_idempotency);
  update public.ofuq_plots
     set owner_id = null, asset_id = null, level = 0, purchased_at = null, last_collected_at = null
   where id = v_plot.id;
  update public.ofuq_players set xp = xp + 50, last_seen_at = now() where id = v_uid;

  return public.ofuq_snapshot();
end;
$$;

create or replace function public.ofuq_claim_mission(p_mission text, p_idempotency text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := public.ofuq_ensure_player();
  v_week text := public.ofuq_iso_week();
  v_mission public.ofuq_missions%rowtype;
  v_stats public.ofuq_weekly_stats%rowtype;
  v_owned integer;
  v_progress integer;
begin
  -- Retry of a request that already committed: return the truth, do not re-validate state.
  if p_idempotency is not null and exists (
    select 1 from public.ofuq_ledger l where l.player_id = v_uid and l.idempotency_key = p_idempotency
  ) then
    return public.ofuq_snapshot();
  end if;

  select * into v_mission from public.ofuq_missions where id = p_mission;
  if not found then raise exception 'التحدي غير معروف' using errcode = 'P0001'; end if;
  if exists (select 1 from public.ofuq_claims c where c.player_id = v_uid and c.week_key = v_week and c.mission_id = p_mission) then
    raise exception 'استلمت مكافأة هذا التحدي' using errcode = 'P0001';
  end if;

  select * into v_stats from public.ofuq_weekly_stats where player_id = v_uid and week_key = v_week;
  select count(*) into v_owned from public.ofuq_plots where owner_id = v_uid;

  v_progress := case v_mission.metric
    when 'developed' then coalesce(v_stats.developed, 0)
    when 'collected' then coalesce(v_stats.collected, 0)
    when 'upgraded'  then coalesce(v_stats.upgraded, 0)
    when 'plotsOwned' then v_owned
    else 0
  end;
  if v_progress < v_mission.target then
    raise exception 'لم يكتمل التحدي بعد' using errcode = 'P0001';
  end if;

  perform public.ofuq_apply_balance(v_uid, v_mission.reward, 'mission_reward', p_mission, p_idempotency);
  insert into public.ofuq_claims (player_id, week_key, mission_id, reward, xp)
  values (v_uid, v_week, p_mission, v_mission.reward, v_mission.xp);
  update public.ofuq_players set xp = xp + v_mission.xp, last_seen_at = now() where id = v_uid;

  return public.ofuq_snapshot();
end;
$$;

-- ------------------------------------------------------------- provisioning ---

create or replace function public.ofuq_handle_new_user()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  insert into public.ofuq_players (id, display_name)
  values (
    new.id,
    coalesce(nullif(left(trim(new.raw_user_meta_data ->> 'display_name'), 24), ''), 'مستثمر أفق')
  ) on conflict (id) do nothing;

  insert into public.ofuq_wallets (player_id, balance) values (new.id, 12000)
  on conflict (player_id) do nothing;

  insert into public.ofuq_ledger (player_id, delta, balance_after, reason, idempotency_key)
  values (new.id, 12000, 12000, 'signup_bonus', 'signup_bonus')
  on conflict (player_id, idempotency_key) do nothing;

  return new;
end;
$$;

drop trigger if exists on_auth_user_created_ofuq on auth.users;
create trigger on_auth_user_created_ofuq
after insert on auth.users
for each row execute procedure public.ofuq_handle_new_user();


-- ------------------------------------------------------------ player market ---
-- The market is between real players only. There is no simulated counterparty: an offer
-- is a real plot, with a real owner, a real price and a real expiry.

create table if not exists public.ofuq_market_offers (
  id uuid primary key default gen_random_uuid(),
  plot_id uuid not null references public.ofuq_plots(id) on delete cascade,
  seller_id uuid not null references public.ofuq_players(id) on delete cascade,
  -- A listing is either a sale ('sale') or a lease of the plot's income ('lease').
  kind text not null default 'sale' check (kind in ('sale', 'lease')),
  price bigint not null default 0 check (price >= 0),
  fee bigint check (fee is null or fee > 0),
  hours integer check (hours is null or (hours >= 1 and hours <= 168)),
  status text not null default 'open' check (status in ('open', 'accepted', 'cancelled', 'expired')),
  buyer_id uuid references public.ofuq_players(id) on delete set null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  closed_at timestamptz,
  check (expires_at > created_at)
);

-- Databases created before leasing: add the columns and keep the price rule per kind.
alter table public.ofuq_market_offers add column if not exists kind text not null default 'sale';
alter table public.ofuq_market_offers add column if not exists fee bigint;
alter table public.ofuq_market_offers add column if not exists hours integer;
alter table public.ofuq_market_offers drop constraint if exists ofuq_market_offers_price_check;
alter table public.ofuq_market_offers add constraint ofuq_market_offers_price_check check (
  (kind = 'sale' and price > 0) or
  (kind = 'lease' and coalesce(fee, 0) > 0 and hours between 1 and 168)
);
alter table public.ofuq_market_offers drop constraint if exists ofuq_market_offers_kind_check;
alter table public.ofuq_market_offers add constraint ofuq_market_offers_kind_check
  check (kind in ('sale', 'lease'));

-- A plot can sit on the market once, and only while the offer is open.
create unique index if not exists ofuq_market_one_open_per_plot
  on public.ofuq_market_offers (plot_id) where status = 'open';

create index if not exists ofuq_market_open_idx
  on public.ofuq_market_offers (status, expires_at);

-- Non-monetary RPCs need idempotency too (nothing in the ledger to key on).
create table if not exists public.ofuq_market_requests (
  player_id uuid not null references public.ofuq_players(id) on delete cascade,
  request_key text not null,
  kind text not null,
  offer_id uuid,
  created_at timestamptz not null default now(),
  primary key (player_id, request_key)
);

create or replace function public.ofuq_market_replay(p_player uuid, p_key text)
returns boolean language plpgsql security definer set search_path = '' as $$
begin
  if p_key is null then return false; end if;
  if exists (
    select 1 from public.ofuq_market_requests r
    where r.player_id = p_player and r.request_key = p_key
  ) then
    return true;
  end if;
  return false;
end;
$$;

create or replace function public.ofuq_market_remember(p_player uuid, p_key text, p_kind text, p_offer uuid)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if p_key is null then return; end if;
  insert into public.ofuq_market_requests (player_id, request_key, kind, offer_id)
  values (p_player, p_key, p_kind, p_offer)
  on conflict (player_id, request_key) do nothing;
end;
$$;

/** Close every offer whose clock ran out. Cheap, indexed, called by the market RPCs. */
create or replace function public.ofuq_expire_offers()
returns void language plpgsql security definer set search_path = '' as $$
begin
  update public.ofuq_market_offers
     set status = 'expired', closed_at = now()
   where status = 'open' and expires_at <= now();
end;
$$;

create or replace function public.ofuq_list_offer(
  p_plot uuid, p_price bigint, p_hours integer, p_idempotency text
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := public.ofuq_ensure_player();
  v_plot public.ofuq_plots%rowtype;
begin
  if public.ofuq_market_replay(v_uid, p_idempotency) then
    return public.ofuq_snapshot();
  end if;

  perform public.ofuq_expire_offers();

  select * into v_plot from public.ofuq_plots where id = p_plot for update;
  if not found then raise exception 'القطعة غير موجودة' using errcode = 'P0002'; end if;
  if v_plot.owner_id is distinct from v_uid then raise exception 'هذه القطعة ليست لك' using errcode = '42501'; end if;
  if v_plot.asset_id is null then raise exception 'طوّر القطعة قبل عرضها للبيع' using errcode = 'P0001'; end if;
  if public.ofuq_plot_is_leased(v_plot.id) then
    raise exception 'القطعة مؤجَّرة — انتظر انتهاء الإيجار قبل البيع' using errcode = 'P0001';
  end if;
  if p_price is null or p_price < 100 then raise exception 'أقل سعر مسموح 100 عملة' using errcode = 'P0001'; end if;
  if p_price > 100000000 then raise exception 'السعر أعلى من الحد المسموح' using errcode = 'P0001'; end if;
  if p_hours is null or p_hours < 1 or p_hours > 168 then raise exception 'مدة العرض بين ساعة و168 ساعة' using errcode = 'P0001'; end if;

  update public.ofuq_market_offers
     set status = 'cancelled', closed_at = now()
   where plot_id = p_plot and status = 'open';

  insert into public.ofuq_market_offers (plot_id, seller_id, price, expires_at)
  values (p_plot, v_uid, p_price, now() + make_interval(hours => p_hours));

  perform public.ofuq_market_remember(v_uid, p_idempotency, 'list', p_plot);
  return public.ofuq_snapshot();
end;
$$;

create or replace function public.ofuq_cancel_offer(p_offer uuid, p_idempotency text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := public.ofuq_ensure_player();
  v_offer public.ofuq_market_offers%rowtype;
begin
  if public.ofuq_market_replay(v_uid, p_idempotency) then
    return public.ofuq_snapshot();
  end if;

  select * into v_offer from public.ofuq_market_offers where id = p_offer for update;
  if not found then raise exception 'العرض غير موجود' using errcode = 'P0002'; end if;
  if v_offer.seller_id is distinct from v_uid then raise exception 'هذا العرض ليس لك' using errcode = '42501'; end if;
  if v_offer.status <> 'open' then raise exception 'العرض لم يعد مفتوحاً' using errcode = 'P0001'; end if;

  update public.ofuq_market_offers
     set status = 'cancelled', closed_at = now()
   where id = p_offer;

  perform public.ofuq_market_remember(v_uid, p_idempotency, 'cancel', p_offer);
  return public.ofuq_snapshot();
end;
$$;

/**
 * Buy a plot from another player. One transaction: the buyer pays, the seller is paid and
 * charged the 4% market fee, ownership moves, and three ledger rows explain all of it.
 * The plot keeps its asset and level — the buyer inherits the building, not the seller's
 * accrued rent (the accrual clock restarts at the transfer).
 */
create or replace function public.ofuq_accept_offer(p_offer uuid, p_idempotency text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := public.ofuq_ensure_player();
  v_offer public.ofuq_market_offers%rowtype;
  v_plot public.ofuq_plots%rowtype;
  v_fee bigint;
  v_net bigint;
begin
  if public.ofuq_market_replay(v_uid, p_idempotency) then
    return public.ofuq_snapshot();
  end if;

  perform public.ofuq_expire_offers();

  select * into v_offer from public.ofuq_market_offers where id = p_offer for update;
  if not found then raise exception 'العرض غير موجود' using errcode = 'P0002'; end if;
  if v_offer.status <> 'open' then raise exception 'العرض لم يعد متاحاً' using errcode = 'P0001'; end if;
  if v_offer.seller_id = v_uid then raise exception 'لا يمكنك قبول عرضك' using errcode = 'P0001'; end if;

  select * into v_plot from public.ofuq_plots where id = v_offer.plot_id for update;
  if v_plot.owner_id is distinct from v_offer.seller_id then
    raise exception 'العرض غير صالح — تغيّرت ملكية القطعة' using errcode = 'P0001';
  end if;

  -- Buyer pays the full price…
  perform public.ofuq_apply_balance(v_uid, -v_offer.price, 'plot_purchase', v_offer.plot_id::text, p_idempotency || ':buy');
  -- …the seller is credited the price and charged the fee as two separate rows.
  v_fee := round(v_offer.price * 0.04);
  v_net := v_offer.price - v_fee;
  perform public.ofuq_apply_balance(v_offer.seller_id, v_offer.price, 'sale', v_offer.plot_id::text, p_idempotency || ':sale');
  perform public.ofuq_apply_balance(v_offer.seller_id, -v_fee, 'market_fee', v_offer.plot_id::text, p_idempotency || ':fee');

  update public.ofuq_plots
     set owner_id = v_uid, purchased_at = now(), last_collected_at = now()
   where id = v_plot.id;

  update public.ofuq_market_offers
     set status = 'accepted', buyer_id = v_uid, closed_at = now()
   where id = p_offer;

  update public.ofuq_players set xp = xp + 40, last_seen_at = now() where id = v_uid;
  update public.ofuq_players set xp = xp + 50, last_seen_at = now() where id = v_offer.seller_id;

  perform public.ofuq_market_remember(v_uid, p_idempotency, 'accept', p_offer);
  return public.ofuq_snapshot();
end;
$$;


-- -------------------------------------------------------------------- leases ---
-- A lease rents out the *income* of a developed plot for a fixed window. The deed never
-- moves: the tenant pays the fee up front and collects the rent until the clock runs out,
-- then the plot goes back to earning for its owner. Nobody loses the rent that accrued
-- before the handover — it is settled to the owner in the same transaction.

create table if not exists public.ofuq_leases (
  id uuid primary key default gen_random_uuid(),
  offer_id uuid references public.ofuq_market_offers(id) on delete set null,
  plot_id uuid not null references public.ofuq_plots(id) on delete cascade,
  lessor_id uuid not null references public.ofuq_players(id) on delete cascade,
  lessee_id uuid not null references public.ofuq_players(id) on delete cascade,
  fee bigint not null check (fee > 0),
  status text not null default 'active' check (status in ('active', 'ended')),
  starts_at timestamptz not null default now(),
  ends_at timestamptz not null,
  created_at timestamptz not null default now(),
  check (ends_at > starts_at),
  check (lessor_id <> lessee_id)
);

-- One running lease per plot. The predicate must be immutable, hence the status column.
create unique index if not exists ofuq_leases_one_active_per_plot
  on public.ofuq_leases (plot_id) where status = 'active';

create index if not exists ofuq_leases_party_idx
  on public.ofuq_leases (lessor_id, lessee_id, ends_at);

/** Close every lease whose window ran out. Called by the lease RPCs and the snapshot. */
create or replace function public.ofuq_expire_leases()
returns void language plpgsql security definer set search_path = '' as $$
begin
  update public.ofuq_leases
     set status = 'ended'
   where status = 'active' and ends_at <= now();
end;
$$;

/** Is a lease running on this plot right now? */
create or replace function public.ofuq_plot_is_leased(p_plot uuid)
returns boolean language plpgsql security definer set search_path = '' as $$
begin
  return exists (
    select 1 from public.ofuq_leases
    where plot_id = p_plot and status = 'active' and ends_at > now()
  );
end;
$$;

/** Who collects this plot's rent right now, if it is leased? NULL when it is not. */
create or replace function public.ofuq_active_lease_lessee(p_plot uuid)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  v_lessee uuid;
begin
  select lessee_id into v_lessee
    from public.ofuq_leases
   where plot_id = p_plot and status = 'active' and ends_at > now()
   limit 1;
  return v_lessee;
end;
$$;

/**
 * Pay the owner the rent that accrued up to this moment, so handing the plot over to a
 * tenant never confiscates what the owner already earned. Returns the amount credited.
 */
create or replace function public.ofuq_settle_rent(p_plot uuid, p_key text)
returns bigint language plpgsql security definer set search_path = '' as $$
declare
  v_plot public.ofuq_plots%rowtype;
  v_district public.ofuq_districts%rowtype;
  v_rate bigint;
  v_amount bigint;
begin
  select * into v_plot from public.ofuq_plots where id = p_plot for update;
  if not found or v_plot.owner_id is null or v_plot.asset_id is null then return 0; end if;
  select * into v_district from public.ofuq_districts where id = v_plot.district_id;
  v_rate := public.ofuq_plot_rent(v_plot.asset_id, v_plot.level, v_district.tier);
  v_amount := floor(least(greatest(extract(epoch from (now() - coalesce(v_plot.last_collected_at, now()))) / 3600.0, 0), 8) * v_rate)::bigint;
  if v_amount <= 0 then return 0; end if;
  perform public.ofuq_apply_balance(v_plot.owner_id, v_amount, 'rent', v_plot.id::text, p_key);
  update public.ofuq_plots set last_collected_at = now() where id = v_plot.id;
  return v_amount;
end;
$$;

create or replace function public.ofuq_list_lease(
  p_plot uuid, p_fee bigint, p_hours integer, p_window integer, p_idempotency text
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := public.ofuq_ensure_player();
  v_plot public.ofuq_plots%rowtype;
  v_window integer := coalesce(p_window, 48);
begin
  if public.ofuq_market_replay(v_uid, p_idempotency) then
    return public.ofuq_snapshot();
  end if;

  perform public.ofuq_expire_offers();
  perform public.ofuq_expire_leases();

  select * into v_plot from public.ofuq_plots where id = p_plot for update;
  if not found then raise exception 'القطعة غير موجودة' using errcode = 'P0002'; end if;
  if v_plot.owner_id is distinct from v_uid then raise exception 'هذه القطعة ليست لك' using errcode = '42501'; end if;
  if v_plot.asset_id is null then raise exception 'طوّر القطعة قبل تأجيرها' using errcode = 'P0001'; end if;
  if public.ofuq_plot_is_leased(p_plot) then raise exception 'القطعة مؤجَّرة بالفعل' using errcode = 'P0001'; end if;
  if exists (select 1 from public.ofuq_market_offers where plot_id = p_plot and status = 'open') then
    raise exception 'هذه القطعة معروضة بالفعل — ألغِ العرض أولاً' using errcode = 'P0001';
  end if;
  if p_fee is null or p_fee < 100 then raise exception 'أقل مبلغ مسموح 100 عملة' using errcode = 'P0001'; end if;
  if p_fee > 100000000 then raise exception 'المبلغ أعلى من الحد المسموح' using errcode = 'P0001'; end if;
  if p_hours is null or p_hours < 1 or p_hours > 168 then
    raise exception 'مدة الإيجار بين 1 و168 ساعة' using errcode = 'P0001';
  end if;
  if v_window < 1 or v_window > 168 then v_window := 48; end if;

  insert into public.ofuq_market_offers (plot_id, seller_id, kind, price, fee, hours, expires_at)
  values (p_plot, v_uid, 'lease', 0, p_fee, p_hours, now() + make_interval(hours => v_window));

  perform public.ofuq_market_remember(v_uid, p_idempotency, 'lease-list', p_plot);
  return public.ofuq_snapshot();
end;
$$;

/**
 * Rent a plot's income from another player. One transaction: the tenant pays the fee, the
 * owner is paid and charged the 4% platform fee, the rent already accrued is settled to the
 * owner, and the lease starts. The plot itself never changes hands.
 */
create or replace function public.ofuq_accept_lease(p_offer uuid, p_idempotency text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := public.ofuq_ensure_player();
  v_offer public.ofuq_market_offers%rowtype;
  v_plot public.ofuq_plots%rowtype;
  v_platform_fee bigint;
begin
  if public.ofuq_market_replay(v_uid, p_idempotency) then
    return public.ofuq_snapshot();
  end if;

  perform public.ofuq_expire_offers();
  perform public.ofuq_expire_leases();

  select * into v_offer from public.ofuq_market_offers where id = p_offer for update;
  if not found then raise exception 'العرض غير موجود' using errcode = 'P0002'; end if;
  if v_offer.kind <> 'lease' then raise exception 'هذا عرض بيع — استخدم شراء القطعة' using errcode = 'P0001'; end if;
  if v_offer.status <> 'open' then raise exception 'العرض لم يعد متاحاً' using errcode = 'P0001'; end if;
  if v_offer.seller_id = v_uid then raise exception 'لا يمكنك استئجار أصلك' using errcode = 'P0001'; end if;

  select * into v_plot from public.ofuq_plots where id = v_offer.plot_id for update;
  if v_plot.owner_id is distinct from v_offer.seller_id then
    raise exception 'العرض غير صالح — تغيّرت ملكية القطعة' using errcode = 'P0001';
  end if;
  if public.ofuq_plot_is_leased(v_plot.id) then
    raise exception 'القطعة مؤجَّرة بالفعل' using errcode = 'P0001';
  end if;

  -- The owner keeps what the plot earned before the tenant took over.
  perform public.ofuq_settle_rent(v_plot.id, p_idempotency || ':settle');

  perform public.ofuq_apply_balance(v_uid, -v_offer.fee, 'lease_payment', v_plot.id::text, p_idempotency || ':pay');
  v_platform_fee := round(v_offer.fee * 0.04);
  perform public.ofuq_apply_balance(v_offer.seller_id, v_offer.fee, 'lease_income', v_plot.id::text, p_idempotency || ':income');
  perform public.ofuq_apply_balance(v_offer.seller_id, -v_platform_fee, 'market_fee', v_plot.id::text, p_idempotency || ':fee');

  insert into public.ofuq_leases (offer_id, plot_id, lessor_id, lessee_id, fee, starts_at, ends_at)
  values (v_offer.id, v_plot.id, v_offer.seller_id, v_uid, v_offer.fee, now(), now() + make_interval(hours => v_offer.hours));

  update public.ofuq_plots set last_collected_at = now() where id = v_plot.id;
  update public.ofuq_market_offers
     set status = 'accepted', buyer_id = v_uid, closed_at = now()
   where id = p_offer;

  update public.ofuq_players set xp = xp + 30, last_seen_at = now() where id = v_uid;
  update public.ofuq_players set xp = xp + 40, last_seen_at = now() where id = v_offer.seller_id;

  perform public.ofuq_market_remember(v_uid, p_idempotency, 'lease-accept', p_offer);
  return public.ofuq_snapshot();
end;
$$;

-- --------------------------------------------------------------------- RLS ---

alter table public.ofuq_players      enable row level security;
alter table public.ofuq_wallets      enable row level security;
alter table public.ofuq_ledger       enable row level security;
alter table public.ofuq_plots        enable row level security;
alter table public.ofuq_weekly_stats enable row level security;
alter table public.ofuq_claims       enable row level security;
alter table public.ofuq_districts    enable row level security;
alter table public.ofuq_assets       enable row level security;
alter table public.ofuq_missions     enable row level security;
alter table public.ofuq_levels       enable row level security;
alter table public.ofuq_market_offers   enable row level security;
alter table public.ofuq_market_requests enable row level security;

drop policy if exists ofuq_players_read_self on public.ofuq_players;
create policy ofuq_players_read_self on public.ofuq_players
  for select to authenticated using (id = (select auth.uid()));

drop policy if exists ofuq_wallets_read_self on public.ofuq_wallets;
create policy ofuq_wallets_read_self on public.ofuq_wallets
  for select to authenticated using (player_id = (select auth.uid()));

drop policy if exists ofuq_ledger_read_self on public.ofuq_ledger;
create policy ofuq_ledger_read_self on public.ofuq_ledger
  for select to authenticated using (player_id = (select auth.uid()));

-- The city map is public read: ownership is what makes the shared world interesting.
drop policy if exists ofuq_plots_read_authenticated on public.ofuq_plots;
create policy ofuq_plots_read_authenticated on public.ofuq_plots
  for select to authenticated using (true);

drop policy if exists ofuq_weekly_read_self on public.ofuq_weekly_stats;
create policy ofuq_weekly_read_self on public.ofuq_weekly_stats
  for select to authenticated using (player_id = (select auth.uid()));

drop policy if exists ofuq_claims_read_self on public.ofuq_claims;
create policy ofuq_claims_read_self on public.ofuq_claims
  for select to authenticated using (player_id = (select auth.uid()));

drop policy if exists ofuq_districts_read on public.ofuq_districts;
create policy ofuq_districts_read on public.ofuq_districts for select to authenticated using (true);

drop policy if exists ofuq_assets_read on public.ofuq_assets;
create policy ofuq_assets_read on public.ofuq_assets for select to authenticated using (true);

drop policy if exists ofuq_missions_read on public.ofuq_missions;
create policy ofuq_missions_read on public.ofuq_missions for select to authenticated using (true);

drop policy if exists ofuq_levels_read on public.ofuq_levels;
create policy ofuq_levels_read on public.ofuq_levels for select to authenticated using (true);

-- The board is readable by every signed-in player: an offer nobody can see is not an offer.
drop policy if exists ofuq_market_offers_read on public.ofuq_market_offers;
create policy ofuq_market_offers_read on public.ofuq_market_offers
  for select to authenticated using (true);

-- A lease is visible to the two players who signed it, and to nobody else.
drop policy if exists ofuq_leases_read on public.ofuq_leases;
create policy ofuq_leases_read on public.ofuq_leases
  for select to authenticated using (lessor_id = auth.uid() or lessee_id = auth.uid());

-- No INSERT/UPDATE/DELETE policies anywhere: only the SECURITY DEFINER functions write.

revoke all on public.ofuq_players, public.ofuq_wallets, public.ofuq_ledger,
              public.ofuq_plots, public.ofuq_weekly_stats, public.ofuq_claims,
              public.ofuq_districts, public.ofuq_assets, public.ofuq_missions,
              public.ofuq_levels, public.ofuq_market_offers, public.ofuq_market_requests,
              public.ofuq_leases
  from anon, authenticated;

grant select on public.ofuq_players, public.ofuq_wallets, public.ofuq_ledger,
                public.ofuq_plots, public.ofuq_weekly_stats, public.ofuq_claims,
                public.ofuq_districts, public.ofuq_assets, public.ofuq_missions,
                public.ofuq_levels, public.ofuq_market_offers, public.ofuq_leases
  to authenticated;

-- RPC surface: authenticated only.
revoke all on function public.ofuq_snapshot() from public, anon;
revoke all on function public.ofuq_purchase_plot(text, integer, text) from public, anon;
revoke all on function public.ofuq_develop_plot(uuid, text, text) from public, anon;
revoke all on function public.ofuq_upgrade_plot(uuid, text) from public, anon;
revoke all on function public.ofuq_collect_rent(uuid, text) from public, anon;
revoke all on function public.ofuq_sell_plot(uuid, text) from public, anon;
revoke all on function public.ofuq_claim_mission(text, text) from public, anon;
revoke all on function public.ofuq_list_offer(uuid, bigint, integer, text) from public, anon;
revoke all on function public.ofuq_cancel_offer(uuid, text) from public, anon;
revoke all on function public.ofuq_accept_offer(uuid, text) from public, anon;
revoke all on function public.ofuq_expire_offers() from public, anon;
revoke all on function public.ofuq_market_replay(uuid, text) from public, anon;
revoke all on function public.ofuq_list_lease(uuid, bigint, integer, integer, text) from public, anon;
revoke all on function public.ofuq_accept_lease(uuid, text) from public, anon;
revoke all on function public.ofuq_expire_leases() from public, anon;
revoke all on function public.ofuq_plot_is_leased(uuid) from public, anon;
revoke all on function public.ofuq_active_lease_lessee(uuid) from public, anon;
revoke all on function public.ofuq_settle_rent(uuid, text) from public, anon;
revoke all on function public.ofuq_market_remember(uuid, text, text, uuid) from public, anon;

grant execute on function public.ofuq_snapshot() to authenticated;
grant execute on function public.ofuq_purchase_plot(text, integer, text) to authenticated;
grant execute on function public.ofuq_develop_plot(uuid, text, text) to authenticated;
grant execute on function public.ofuq_upgrade_plot(uuid, text) to authenticated;
grant execute on function public.ofuq_collect_rent(uuid, text) to authenticated;
grant execute on function public.ofuq_sell_plot(uuid, text) to authenticated;
grant execute on function public.ofuq_claim_mission(text, text) to authenticated;
grant execute on function public.ofuq_list_offer(uuid, bigint, integer, text) to authenticated;
grant execute on function public.ofuq_cancel_offer(uuid, text) to authenticated;
grant execute on function public.ofuq_accept_offer(uuid, text) to authenticated;
grant execute on function public.ofuq_list_lease(uuid, bigint, integer, integer, text) to authenticated;
grant execute on function public.ofuq_accept_lease(uuid, text) to authenticated;

-- Live city updates (ownership changes appear for every player).
do $$ begin
  alter publication supabase_realtime add table public.ofuq_plots;
exception when duplicate_object then null;
when undefined_object then raise notice 'Realtime publication not found; enable it for public.ofuq_plots in the dashboard.';
end $$;
