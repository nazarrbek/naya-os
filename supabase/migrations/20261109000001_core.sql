-- NAYA BALLOONS CRM — core tables.
-- Ledgers (money_movements, stock_movements) are append-only and written only by RPC functions.

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------- owners
create table public.owners (
  id uuid primary key default gen_random_uuid(),
  email text not null unique,
  name text not null,
  share numeric(5,4) not null default 0.5 check (share >= 0 and share <= 1),
  user_id uuid unique references auth.users(id) on delete set null,
  created_at timestamptz not null default now()
);

create or replace function public.current_owner_id() returns uuid
language sql stable security definer set search_path = public as $$
  select id from public.owners where user_id = auth.uid()
$$;

create or replace function public.is_owner() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.owners where user_id = auth.uid())
$$;

-- Link an auth user to the owners list by e-mail; other e-mails get no access.
create or replace function public.link_owner_on_signup() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  update public.owners set user_id = new.id where lower(email) = lower(new.email) and user_id is null;
  return new;
end $$;

create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.link_owner_on_signup();

-- ---------------------------------------------------------------- settings (single row)
create table public.settings (
  id boolean primary key default true check (id),
  launch_date date not null default current_date,
  default_coef numeric(6,3) not null default 2.4,
  min_coef numeric(6,3) not null default 2.0,
  helium_plan_price numeric(10,2) not null default 27,       -- ₸ per litre for price estimates
  price_round integer not null default 100,
  tax_enabled boolean not null default false,
  tax_rate numeric(6,4),
  opening_retained_profit numeric(14,2) not null default 0,
  minimum_reserve numeric(14,2) not null default 0,
  helium_product_id uuid,
  ribbon_product_id uuid,
  updated_at timestamptz not null default now()
);
insert into public.settings default values;

-- ---------------------------------------------------------------- money accounts
create table public.accounts (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  kind text not null default 'other' check (kind in ('kaspi','cash','deposit','other')),
  sort integer not null default 0,
  active boolean not null default true
);

-- ---------------------------------------------------------------- catalog
create table public.products (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  kind text not null check (kind in ('balloon','material','helium')),
  category text,
  unit text not null default 'шт.',
  photo_path text,
  ref_cost numeric(12,2),            -- reference cost when there are no purchases yet ("оценка")
  ref_cost_note text,
  wholesale_cost numeric(12,2),      -- informational: "при опте было бы так"
  ribbon_m_per_unit numeric(8,3),    -- ribbon norm per balloon, metres
  min_stock numeric(12,3),
  active boolean not null default true,
  note text,
  source jsonb,                      -- origin in the old spreadsheet
  created_at timestamptz not null default now()
);
create unique index products_name_uq on public.products (lower(name));

alter table public.settings
  add constraint settings_helium_fk foreign key (helium_product_id) references public.products(id),
  add constraint settings_ribbon_fk foreign key (ribbon_product_id) references public.products(id);

-- Maker / variant of a balloon: the same pack size can need different helium.
create table public.variants (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null references public.products(id) on delete cascade,
  maker text not null,
  pack_size text,
  real_size text,
  photo_path text,
  is_default boolean not null default false,
  is_unknown boolean not null default false,
  active boolean not null default true,
  note text
);
create unique index variants_one_default on public.variants (product_id) where is_default;

-- Helium norm per variant. Several may exist; the best source wins (measured > estimate > cheatsheet > excel).
create table public.helium_norms (
  id uuid primary key default gen_random_uuid(),
  variant_id uuid not null references public.variants(id) on delete cascade,
  helium_l numeric(10,2) not null check (helium_l >= 0),
  total_l numeric(10,2),             -- full fill volume when mixed with air
  helium_share numeric(5,4) check (helium_share is null or (helium_share > 0 and helium_share <= 1)),
  is_mix boolean not null default false,
  source text not null check (source in ('measured','estimate','cheatsheet','excel')),
  note text,
  set_at timestamptz not null default now(),
  set_by uuid references public.owners(id),
  active boolean not null default true
);

-- ---------------------------------------------------------------- templates (compositions)
create table public.templates (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  photo_path text,
  coef numeric(6,3),
  manual_price numeric(12,2),
  service_label text,                                  -- e.g. "Надпись"
  service_estimate numeric(12,2) not null default 0,   -- expected print cost, used only for price advice
  active boolean not null default true,
  sort integer not null default 0,
  source jsonb
);
create table public.template_lines (
  id uuid primary key default gen_random_uuid(),
  template_id uuid not null references public.templates(id) on delete cascade,
  product_id uuid not null references public.products(id),
  variant_id uuid references public.variants(id),
  qty numeric(12,3) not null check (qty > 0),
  sort integer not null default 0
);

-- ---------------------------------------------------------------- customers (optional)
create table public.customers (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  phone text,
  note text,
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------- orders
create sequence public.order_number_seq start 1;

create table public.orders (
  id uuid primary key default gen_random_uuid(),
  number integer not null unique default nextval('public.order_number_seq'),
  title text not null,
  customer_id uuid references public.customers(id),
  client_name text,
  client_phone text,
  due_at timestamptz,
  delivery text not null default 'pickup' check (delivery in ('pickup','delivery')),
  address text,
  delivery_price numeric(12,2) not null default 0,   -- charged to the client, part of the price
  template_id uuid references public.templates(id),
  coef numeric(6,3),
  price numeric(12,2) not null default 0 check (price >= 0),  -- final amount for the client (after discount)
  discount numeric(12,2) not null default 0,
  low_price_ack boolean not null default false,
  comment text,
  inscription text,
  design text,
  photo_path text,
  service_label text,
  service_estimate numeric(12,2) not null default 0,   -- planned print cost until the real one is recorded
  status text not null default 'new' check (status in ('new','assembled','issued','cancelled')),
  assembled_at timestamptz,
  issued_at timestamptz,
  cancelled_at timestamptz,
  cancel_reason text,
  cancel_revenue numeric(12,2) not null default 0,   -- kept prepayment on cancellation
  is_historical boolean not null default false,
  payment_known boolean not null default true,
  date_uncertain boolean not null default false,
  source jsonb,
  version integer not null default 1,
  created_by uuid references public.owners(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index orders_due_idx on public.orders (due_at) where status in ('new','assembled');
create index orders_issued_idx on public.orders (issued_at);

create table public.order_lines (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.orders(id) on delete cascade,
  product_id uuid not null references public.products(id),
  variant_id uuid references public.variants(id),
  qty numeric(12,3) not null check (qty > 0),
  helium_l_per_unit numeric(10,2),    -- null = unknown, needs attention
  helium_source text,                 -- copy of norm source at the moment it was chosen
  helium_is_mix boolean not null default false,
  ribbon_m numeric(10,3) not null default 0,
  sort integer not null default 0
);
create index order_lines_order_idx on public.order_lines (order_id);

-- Costs attached directly to one order: print shop services, delivery taxi, historical cost breakdown.
create table public.order_costs (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.orders(id) on delete cascade,
  kind text not null check (kind in ('service','delivery','history')),
  label text not null,
  amount numeric(12,2) not null check (amount >= 0),
  is_mistake boolean not null default false,
  occurred_at timestamptz not null default now(),
  account_id uuid references public.accounts(id),
  supplier text,
  source jsonb,
  created_by uuid references public.owners(id),
  created_at timestamptz not null default now()
);
create index order_costs_order_idx on public.order_costs (order_id);

-- ---------------------------------------------------------------- purchases
create table public.purchases (
  id uuid primary key default gen_random_uuid(),
  occurred_at timestamptz not null default now(),
  supplier text,
  account_id uuid references public.accounts(id),
  total numeric(12,2) not null check (total >= 0),
  note text,
  is_helium_refill boolean not null default false,
  reserve_item_id uuid,
  is_historical boolean not null default false,
  source jsonb,
  created_by uuid references public.owners(id),
  created_at timestamptz not null default now()
);
create table public.purchase_lines (
  id uuid primary key default gen_random_uuid(),
  purchase_id uuid not null references public.purchases(id) on delete cascade,
  product_id uuid not null references public.products(id),
  variant_id uuid references public.variants(id),
  qty numeric(12,3) not null check (qty > 0),
  amount numeric(12,2) not null check (amount >= 0),
  order_id uuid references public.orders(id)       -- bought specifically for this order
);

-- Helium cylinders: each refill starts one; used to compare written-off litres with the real volume.
create table public.helium_cylinders (
  id uuid primary key default gen_random_uuid(),
  started_at timestamptz not null default now(),
  nominal_l numeric(10,2) not null,
  start_is_estimate boolean not null default false,
  note text,
  purchase_id uuid references public.purchases(id),
  ended_at timestamptz,
  used_l_at_end numeric(10,2)
);

-- ---------------------------------------------------------------- expenses & owner flows
create table public.expense_categories (
  name text primary key,
  class text not null check (class in ('opex','equipment','tax')),
  sort integer not null default 0
);

create table public.expenses (
  id uuid primary key default gen_random_uuid(),
  occurred_at timestamptz not null default now(),
  class text not null check (class in ('opex','equipment','tax','personal')),
  category text,
  description text,
  amount numeric(12,2) not null check (amount > 0),
  account_id uuid references public.accounts(id),
  order_id uuid references public.orders(id),
  reserve_item_id uuid,
  is_historical boolean not null default false,
  source jsonb,
  created_by uuid references public.owners(id),
  created_at timestamptz not null default now()
);

-- Money owners take out (withdrawal or personal spending from business money) or put in.
create table public.owner_flows (
  id uuid primary key default gen_random_uuid(),
  occurred_at timestamptz not null default now(),
  owner_id uuid not null references public.owners(id),
  kind text not null check (kind in ('withdrawal','personal','contribution')),
  amount numeric(12,2) not null check (amount > 0),
  expense_id uuid references public.expenses(id) on delete cascade,
  note text,
  is_historical boolean not null default false,
  created_at timestamptz not null default now()
);

create table public.transfers (
  id uuid primary key default gen_random_uuid(),
  occurred_at timestamptz not null default now(),
  from_account_id uuid not null references public.accounts(id),
  to_account_id uuid not null references public.accounts(id),
  amount numeric(12,2) not null check (amount > 0),
  note text,
  created_by uuid references public.owners(id),
  check (from_account_id <> to_account_id)
);

-- ---------------------------------------------------------------- reserves
create table public.reserve_items (
  id uuid primary key default gen_random_uuid(),
  bucket text not null check (bucket in ('purchases','mandatory','planned')),
  title text not null,
  amount numeric(12,2) not null check (amount >= 0),
  due_date date,
  active boolean not null default true,
  created_at timestamptz not null default now()
);
alter table public.expenses add constraint expenses_reserve_fk foreign key (reserve_item_id) references public.reserve_items(id);
alter table public.purchases add constraint purchases_reserve_fk foreign key (reserve_item_id) references public.reserve_items(id);

-- ---------------------------------------------------------------- inventory counts
create table public.inventory_counts (
  id uuid primary key default gen_random_uuid(),
  occurred_at timestamptz not null default now(),
  is_opening boolean not null default false,
  note text,
  created_by uuid references public.owners(id)
);

-- ---------------------------------------------------------------- ledgers
create table public.money_movements (
  id uuid primary key default gen_random_uuid(),
  occurred_at timestamptz not null,
  account_id uuid not null references public.accounts(id),
  amount numeric(14,2) not null check (amount <> 0),
  kind text not null check (kind in ('opening','client_payment','client_refund','purchase','order_cost',
                                     'expense','owner_withdrawal','owner_contribution','transfer','adjustment')),
  order_id uuid references public.orders(id),
  order_cost_id uuid references public.order_costs(id) on delete cascade,
  purchase_id uuid references public.purchases(id) on delete cascade,
  expense_id uuid references public.expenses(id) on delete cascade,
  transfer_id uuid references public.transfers(id) on delete cascade,
  owner_flow_id uuid references public.owner_flows(id) on delete cascade,
  reduces_revenue boolean not null default false,   -- refund of an already issued order
  note text,
  created_by uuid references public.owners(id),
  created_at timestamptz not null default now()
);
create index money_movements_account_idx on public.money_movements (account_id, occurred_at);
create index money_movements_order_idx on public.money_movements (order_id);

create table public.stock_movements (
  id uuid primary key default gen_random_uuid(),
  occurred_at timestamptz not null,
  product_id uuid not null references public.products(id),
  variant_id uuid references public.variants(id),
  qty numeric(14,3) not null check (qty <> 0),
  unit_cost numeric(14,4) not null default 0,
  value numeric(14,2) generated always as (round(qty * unit_cost, 2)) stored,
  kind text not null check (kind in ('opening','purchase','order_use','defect','adjustment','loss')),
  order_id uuid references public.orders(id),
  purchase_line_id uuid references public.purchase_lines(id) on delete cascade,
  inventory_count_id uuid references public.inventory_counts(id),
  is_direct boolean not null default false,  -- receipt bought for a specific order; excluded from average cost
  cost_is_estimate boolean not null default false,
  note text,
  created_by uuid references public.owners(id),
  created_at timestamptz not null default now()
);
create index stock_movements_product_idx on public.stock_movements (product_id, occurred_at);
create index stock_movements_order_idx on public.stock_movements (order_id);

-- ---------------------------------------------------------------- idempotency & audit
create table public.request_log (
  request_id uuid primary key,
  fn text not null,
  result jsonb,
  owner_id uuid,
  created_at timestamptz not null default now()
);

create table public.audit_log (
  id bigserial primary key,
  at timestamptz not null default now(),
  owner_id uuid,
  table_name text not null,
  row_id uuid,
  action text not null,
  reason text,
  old_data jsonb,
  new_data jsonb
);
create index audit_log_row_idx on public.audit_log (row_id);

create or replace function public.audit_trigger() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_reason text := nullif(current_setting('naya.reason', true), '');
  v_id text := (case when tg_op = 'DELETE' then to_jsonb(old) else to_jsonb(new) end)->>'id';
begin
  insert into public.audit_log (owner_id, table_name, row_id, action, reason, old_data, new_data)
  values (public.current_owner_id(), tg_table_name,
          case when v_id ~ '^[0-9a-f-]{36}$' then v_id::uuid end,
          lower(tg_op), v_reason,
          case when tg_op <> 'INSERT' then to_jsonb(old) end,
          case when tg_op <> 'DELETE' then to_jsonb(new) end);
  return coalesce(new, old);
end $$;

do $$
declare t text;
begin
  foreach t in array array['orders','order_lines','order_costs','purchases','purchase_lines','expenses',
                           'owner_flows','transfers','products','variants','helium_norms','templates',
                           'template_lines','settings','accounts','reserve_items']
  loop
    execute format('create trigger audit_%1$s after insert or update or delete on public.%1$s
                    for each row execute function public.audit_trigger()', t);
  end loop;
end $$;
