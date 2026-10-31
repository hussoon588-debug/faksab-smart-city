-- FAKSAB SMART CITY 8.2 — run once in Supabase SQL Editor.
-- Uses Supabase Auth identity. Never expose service_role or database password in the browser.
create extension if not exists pgcrypto;

create table if not exists public.players (
  id uuid primary key references auth.users(id) on delete cascade,
  display_name text not null default 'لاعب جديد' check (char_length(display_name) between 2 and 24),
  coins bigint not null default 5000 check (coins >= 0),
  created_at timestamptz not null default now()
);

create table if not exists public.plots (
  id uuid primary key default gen_random_uuid(),
  city_id text not null check (city_id in ('elite-city','business-city','coast-city','future-city','challenge-city')),
  plot_no integer not null check (plot_no between 1 and 50),
  price bigint not null default 500 check (price > 0),
  owner_id uuid references public.players(id),
  owner_name text,
  purchased_at timestamptz,
  unique(city_id, plot_no)
);

create table if not exists public.transactions (
  id uuid primary key default gen_random_uuid(),
  player_id uuid not null references public.players(id),
  plot_id uuid not null references public.plots(id),
  amount bigint not null check (amount > 0),
  transaction_type text not null check (transaction_type = 'plot_purchase'),
  created_at timestamptz not null default now()
);

-- Create a player profile on account creation. The starter balance is game currency only.
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  insert into public.players (id, display_name)
  values (
    new.id,
    coalesce(nullif(left(trim(new.raw_user_meta_data ->> 'display_name'), 24), ''), 'لاعب جديد')
  ) on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created_faksab on auth.users;
create trigger on_auth_user_created_faksab
after insert on auth.users
for each row execute procedure public.handle_new_user();

-- Seed 50 plots in each of the five cities. Safe to run repeatedly.
insert into public.plots(city_id, plot_no, price)
select c.city_id, n, case when n % 10 = 0 then 1200 else 500 end
from (values ('elite-city'),('business-city'),('coast-city'),('future-city'),('challenge-city')) as c(city_id)
cross join generate_series(1,50) as n
on conflict (city_id, plot_no) do nothing;

alter table public.players enable row level security;
alter table public.plots enable row level security;
alter table public.transactions enable row level security;

-- Authenticated players can inspect the shared city/ownership map.
drop policy if exists "players_read_self" on public.players;
create policy "players_read_self" on public.players for select to authenticated using (id = (select auth.uid()));
drop policy if exists "plots_read_authenticated" on public.plots;
create policy "plots_read_authenticated" on public.plots for select to authenticated using (true);
drop policy if exists "transactions_read_self" on public.transactions;
create policy "transactions_read_self" on public.transactions for select to authenticated using (player_id = (select auth.uid()));
-- No client insert/update/delete policies: ownership and balances are server-managed.

revoke all on public.players from anon, authenticated;
grant select on public.players to authenticated;
revoke insert, update, delete on public.plots from anon, authenticated;
grant select on public.plots to authenticated;
revoke all on public.transactions from anon, authenticated;
grant select on public.transactions to authenticated;

create or replace function public.purchase_plot(p_city_id text, p_plot_no integer)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_plot public.plots%rowtype;
  v_player public.players%rowtype;
  v_name text;
begin
  if v_uid is null then raise exception 'يجب تسجيل الدخول أولاً'; end if;
  if p_city_id not in ('elite-city','business-city','coast-city','future-city','challenge-city')
     or p_plot_no < 1 or p_plot_no > 50 then
    raise exception 'المدينة أو رقم القطعة غير صالح';
  end if;

  select * into v_plot from public.plots
   where city_id = p_city_id and plot_no = p_plot_no
   for update;
  if not found then raise exception 'القطعة غير موجودة'; end if;
  if v_plot.owner_id is not null then raise exception 'هذه القطعة مملوكة بالفعل'; end if;

  select * into v_player from public.players where id = v_uid for update;
  if not found then raise exception 'ملف اللاعب غير موجود'; end if;
  if v_player.coins < v_plot.price then raise exception 'رصيدك غير كافٍ'; end if;
  v_name := v_player.display_name;

  update public.players set coins = coins - v_plot.price where id = v_uid;
  update public.plots set owner_id = v_uid, owner_name = v_name, purchased_at = now() where id = v_plot.id;
  insert into public.transactions(player_id, plot_id, amount, transaction_type)
  values (v_uid, v_plot.id, v_plot.price, 'plot_purchase');

  return jsonb_build_object('success', true, 'message', 'تم شراء القطعة ' || p_plot_no || ' بنجاح في ' || p_city_id, 'plot_no', p_plot_no, 'price', v_plot.price);
end;
$$;

revoke all on function public.purchase_plot(text, integer) from public, anon;
grant execute on function public.purchase_plot(text, integer) to authenticated;

-- Enable Realtime notifications for plot ownership changes.
do $$ begin
  alter publication supabase_realtime add table public.plots;
exception when duplicate_object then null;
when undefined_object then raise notice 'Publication supabase_realtime not found; enable Realtime for public.plots in dashboard.';
end $$;
