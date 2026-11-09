-- NAYA BALLOONS CRM — reports, payouts, attention list, security.
-- Every report number is a sum over one of the v_*_items views, so the app can open the exact records behind it.

create or replace function public.almaty_day(t timestamptz) returns date
language sql immutable as $$ select (t at time zone 'Asia/Almaty')::date $$;

-- ---------------------------------------------------------------- orders overview
create or replace view public.v_orders with (security_invoker = true) as
select o.*,
  public.order_paid(o.id) as paid,
  case when o.payment_known then o.price - public.order_paid(o.id) end as due,
  case when o.status in ('assembled','issued','cancelled') or o.is_historical then public.order_actual_cost(o.id) end as actual_cost,
  case
    when not o.payment_known then 'unknown'
    when public.order_paid(o.id) <= 0 then 'unpaid'
    when public.order_paid(o.id) < o.price then 'partial'
    when public.order_paid(o.id) = o.price then 'paid'
    else 'overpaid'
  end as payment_status,
  (select coalesce(sum(qty * coalesce(helium_l_per_unit, 0)), 0) from public.order_lines l where l.order_id = o.id) as helium_l,
  exists (select 1 from public.order_lines l join public.products p on p.id = l.product_id
          where l.order_id = o.id and p.kind = 'balloon' and l.helium_l_per_unit is null) as helium_missing,
  exists (select 1 from public.order_lines l join public.products p on p.id = l.product_id
          where l.order_id = o.id and p.kind = 'balloon' and coalesce(l.helium_source, '') <> 'measured') as helium_approx
from public.orders o;

-- ---------------------------------------------------------------- stock overview
create or replace view public.v_stock with (security_invoker = true) as
with reserved as (
  select r.product_id, sum(r.qty) as qty
  from public.orders o, lateral public.order_requirements(o.id) r
  where o.status = 'new'
  group by r.product_id
), direct as (
  select m.product_id, sum(m.qty) as qty
  from public.stock_movements m join public.orders o on o.id = m.order_id
  where m.is_direct and o.status = 'new'
  group by m.product_id
)
select p.id as product_id, p.name, p.kind, p.category, p.unit, p.photo_path, p.min_stock, p.active,
  public.stock_qty(p.id) as physical,
  greatest(0, coalesce(r.qty, 0) - coalesce(d.qty, 0)) + coalesce(d.qty, 0) as reserved,
  public.stock_qty(p.id) - coalesce(r.qty, 0) as available,
  a.cost as avg_cost, a.is_estimate as cost_is_estimate,
  round(public.stock_qty(p.id) * a.cost, 2) as value,
  exists (select 1 from public.stock_movements m where m.product_id = p.id and m.kind = 'opening') as has_opening
from public.products p
left join reserved r on r.product_id = p.id
left join direct d on d.product_id = p.id
cross join lateral public.avg_cost(p.id) a;

create or replace view public.v_balances with (security_invoker = true) as
select a.id as account_id, a.name, a.kind, a.sort, a.active,
  coalesce((select sum(amount) from public.money_movements m where m.account_id = a.id), 0) as balance
from public.accounts a;

-- ---------------------------------------------------------------- report item views
create or replace view public.v_revenue_items with (security_invoker = true) as
select public.almaty_day(o.issued_at) as day, o.id as order_id, o.price as amount, 'sale'::text as kind,
       '№' || o.number || ' ' || o.title as label, o.is_historical
from public.orders o where o.status = 'issued'
union all
select public.almaty_day(o.cancelled_at), o.id, o.cancel_revenue, 'cancel_fee', '№' || o.number || ' отмена: оставили предоплату', false
from public.orders o where o.status = 'cancelled' and o.cancel_revenue <> 0
union all
select public.almaty_day(m.occurred_at), m.order_id, m.amount, 'refund', 'Возврат клиенту №' || o.number, false
from public.money_movements m join public.orders o on o.id = m.order_id
where m.kind = 'client_refund' and m.reduces_revenue;

create or replace view public.v_cost_items with (security_invoker = true) as
select public.almaty_day(o.issued_at) as day, o.id as order_id, public.order_actual_cost(o.id) as amount,
       '№' || o.number || ' ' || o.title as label, o.is_historical,
       exists (select 1 from public.stock_movements m where m.order_id = o.id and m.cost_is_estimate)
         or exists (select 1 from public.order_lines l join public.products p on p.id = l.product_id
                    where l.order_id = o.id and p.kind = 'balloon' and coalesce(l.helium_source, '') <> 'measured') as is_approx
from public.orders o where o.status = 'issued';

create or replace view public.v_loss_items with (security_invoker = true) as
select public.almaty_day(o.cancelled_at) as day, o.id as order_id, null::uuid as product_id,
       public.order_actual_cost(o.id) as amount, '№' || o.number || ' отменён после сборки' as label
from public.orders o where o.status = 'cancelled' and public.order_actual_cost(o.id) <> 0
union all
select public.almaty_day(m.occurred_at), null, m.product_id, -m.value, p.name || ': ' || coalesce(m.note, 'списание')
from public.stock_movements m join public.products p on p.id = m.product_id
where m.kind in ('loss','adjustment') and m.value <> 0;

create or replace view public.v_expense_items with (security_invoker = true) as
select public.almaty_day(e.occurred_at) as day, e.id as expense_id, e.class, e.category, e.amount,
       coalesce(e.category, '') || coalesce(' — ' || e.description, '') as label, e.is_historical
from public.expenses e where e.class <> 'personal';

create or replace view public.v_payment_items with (security_invoker = true) as
select public.almaty_day(m.occurred_at) as day, m.id as movement_id, m.order_id, m.account_id, m.amount, m.kind,
       '№' || o.number || ' ' || o.title as label
from public.money_movements m join public.orders o on o.id = m.order_id
where m.kind in ('client_payment','client_refund');

create or replace view public.v_owner_flow_items with (security_invoker = true) as
select public.almaty_day(f.occurred_at) as day, f.id, f.owner_id, w.name as owner_name, f.kind, f.amount, f.note, f.is_historical
from public.owner_flows f join public.owners w on w.id = f.owner_id;

-- ---------------------------------------------------------------- period report
create or replace function public.report_summary(p_from date, p_to date) returns jsonb
language plpgsql stable security invoker set search_path = public as $$
declare
  v_rev numeric; v_cost numeric; v_loss numeric; v_opex numeric; v_tax numeric; v_eq numeric;
  v_orders int; v_pay numeric; v_ref numeric; v_draw numeric; v_contrib numeric; v_purch numeric;
  v_approx int; v_hist int;
begin
  select coalesce(sum(amount), 0) into v_rev from public.v_revenue_items where day between p_from and p_to;
  select coalesce(sum(amount), 0), count(*) filter (where is_approx), count(*) filter (where is_historical), count(*)
    into v_cost, v_approx, v_hist, v_orders from public.v_cost_items where day between p_from and p_to;
  select coalesce(sum(amount), 0) into v_loss from public.v_loss_items where day between p_from and p_to;
  select coalesce(sum(amount) filter (where class = 'opex'), 0), coalesce(sum(amount) filter (where class = 'tax'), 0),
         coalesce(sum(amount) filter (where class = 'equipment'), 0)
    into v_opex, v_tax, v_eq from public.v_expense_items where day between p_from and p_to;
  select coalesce(sum(amount) filter (where kind = 'client_payment'), 0), coalesce(-sum(amount) filter (where kind = 'client_refund'), 0)
    into v_pay, v_ref from public.v_payment_items where day between p_from and p_to;
  select coalesce(sum(amount) filter (where kind in ('withdrawal','personal')), 0),
         coalesce(sum(amount) filter (where kind = 'contribution'), 0)
    into v_draw, v_contrib from public.v_owner_flow_items where day between p_from and p_to;
  select coalesce(sum(total), 0) into v_purch from public.purchases
    where public.almaty_day(occurred_at) between p_from and p_to and not is_historical;
  return jsonb_build_object(
    'from', p_from, 'to', p_to,
    'revenue', v_rev, 'cost', v_cost, 'gross', v_rev - v_cost,
    'gross_margin', case when v_rev <> 0 then round((v_rev - v_cost) / v_rev, 4) end,
    'losses', v_loss, 'opex', v_opex, 'tax', v_tax, 'equipment', v_eq,
    'net', v_rev - v_cost - v_loss - v_opex - v_tax,
    'net_margin', case when v_rev <> 0 then round((v_rev - v_cost - v_loss - v_opex - v_tax) / v_rev, 4) end,
    'orders', v_orders, 'avg_check', case when v_orders > 0 then round(v_rev / v_orders) end,
    'payments', v_pay, 'refunds', v_ref, 'owner_draws', v_draw, 'owner_contributions', v_contrib,
    'purchases', v_purch, 'approx_orders', v_approx, 'historical_orders', v_hist);
end $$;

-- ---------------------------------------------------------------- reserves & payouts
create or replace view public.v_reserves with (security_invoker = true) as
select r.*,
  coalesce((select sum(amount) from public.expenses e where e.reserve_item_id = r.id), 0)
  + coalesce((select sum(total) from public.purchases p where p.reserve_item_id = r.id), 0) as spent,
  greatest(0, r.amount
    - coalesce((select sum(amount) from public.expenses e where e.reserve_item_id = r.id), 0)
    - coalesce((select sum(total) from public.purchases p where p.reserve_item_id = r.id), 0)) as remaining
from public.reserve_items r;

create or replace function public.payout_summary() returns jsonb
language plpgsql stable security invoker set search_path = public as $$
declare
  s public.settings; v_money numeric; v_res_p numeric; v_res_m numeric; v_res_o numeric; v_reserves numeric;
  v_free numeric; v_profit numeric; v_draws numeric; v_retained numeric; v_dist numeric; v_owners jsonb := '{}';
  o record; v_own numeric; v_entitled numeric; v_rep jsonb; v_contrib numeric;
begin
  select * into s from public.settings;
  select coalesce(sum(balance), 0) into v_money from public.v_balances;
  select coalesce(sum(remaining) filter (where bucket = 'purchases'), 0),
         coalesce(sum(remaining) filter (where bucket = 'mandatory'), 0),
         coalesce(sum(remaining) filter (where bucket = 'planned'), 0)
    into v_res_p, v_res_m, v_res_o from public.v_reserves where active;
  v_reserves := v_res_p + v_res_m + v_res_o + s.minimum_reserve;
  v_free := v_money - v_reserves;
  v_rep := public.report_summary(s.launch_date, public.almaty_day(now()) + 3650);
  v_profit := (v_rep->>'net')::numeric;
  select coalesce(sum(amount) filter (where kind in ('withdrawal','personal')), 0),
         coalesce(sum(amount) filter (where kind = 'contribution'), 0)
    into v_draws, v_contrib from public.owner_flows where not is_historical and public.almaty_day(occurred_at) >= s.launch_date;
  v_retained := s.opening_retained_profit + v_profit - v_draws;
  v_dist := greatest(0, least(v_free, v_retained));
  for o in select * from public.owners order by email loop
    select coalesce(sum(amount), 0) into v_own from public.owner_flows
      where owner_id = o.id and kind in ('withdrawal','personal') and not is_historical
        and public.almaty_day(occurred_at) >= s.launch_date;
    v_entitled := o.share * (v_dist + v_draws) - v_own;
    v_owners := v_owners || jsonb_build_object(o.id::text, jsonb_build_object(
      'name', o.name, 'share', o.share, 'taken', v_own,
      'can_take', round(greatest(0, least(v_dist, v_entitled)), 0)));
  end loop;
  return jsonb_build_object(
    'money', v_money, 'reserve_purchases', v_res_p, 'reserve_mandatory', v_res_m, 'reserve_planned', v_res_o,
    'reserve_minimum', s.minimum_reserve, 'reserves', v_reserves, 'free', v_free,
    'launch_date', s.launch_date, 'opening_retained', s.opening_retained_profit, 'profit_since_launch', v_profit,
    'draws', v_draws, 'contributions', v_contrib, 'retained', v_retained, 'distributable', v_dist,
    'limited_by', case when v_free <= v_retained then 'money' else 'profit' end,
    'owners', v_owners);
end $$;

-- ---------------------------------------------------------------- attention list
create or replace function public.attention() returns jsonb
language sql stable security invoker set search_path = public as $$
  select coalesce(jsonb_agg(x order by x->>'sort'), '[]'::jsonb) from (
    select jsonb_build_object('sort', '1', 'tone', 'warn',
      'text', 'Для «' || p.name || '» в заказе №' || o.number || ' не указан расход гелия',
      'action', 'указать', 'link', '/orders/' || o.id) as x
    from public.order_lines l join public.orders o on o.id = l.order_id join public.products p on p.id = l.product_id
    where o.status in ('new','assembled') and p.kind = 'balloon' and l.helium_l_per_unit is null
    union all
    select jsonb_build_object('sort', '2', 'tone', 'warn',
      'text', 'Заказ №' || o.number || ' «' || o.title || '» — срок прошёл, но он не отмечен выданным',
      'action', 'открыть', 'link', '/orders/' || o.id)
    from public.orders o where o.status in ('new','assembled') and o.due_at < now() - interval '3 hours'
    union all
    select jsonb_build_object('sort', '3', 'tone', 'warn',
      'text', 'Не хватает «' || v.name || '» для заказов: нужно ещё ' || trim(to_char(-v.available, 'FM999999990.##')) || ' ' || v.unit,
      'action', 'записать покупку', 'link', '/spend?kind=materials&product=' || v.product_id)
    from public.v_stock v where v.available < 0 and v.kind <> 'helium'
      and exists (select 1 from public.inventory_counts where is_opening)
    union all
    select jsonb_build_object('sort', '4', 'tone', 'info',
      'text', 'Заказ №' || o.number || ': клиент должен ' || trim(to_char(o.due, 'FM999 999 990')) || ' ₸',
      'action', 'принять оплату', 'link', '/orders/' || o.id)
    from public.v_orders o where o.status = 'issued' and o.payment_known and o.due > 0
    union all
    select jsonb_build_object('sort', '4', 'tone', 'info',
      'text', 'В заказе №' || o.number || ' планировалась ' || lower(coalesce(o.service_label, 'печать')) ||
              ' (≈' || round(o.service_estimate) || ' ₸), но её стоимость не записана',
      'action', 'записать', 'link', '/orders/' || o.id || '?cost=1')
    from public.orders o where o.status = 'issued' and not o.is_historical and o.service_estimate > 0
      and not exists (select 1 from public.order_costs c where c.order_id = o.id and c.kind = 'service')
    union all
    select jsonb_build_object('sort', '5', 'tone', 'info',
      'text', 'Мало «' || v.name || '»: осталось ' || trim(to_char(v.physical, 'FM999999990.##')) || ' ' || v.unit,
      'action', 'записать покупку', 'link', '/spend?kind=materials&product=' || v.product_id)
    from public.v_stock v where v.min_stock is not null and v.physical <= v.min_stock and v.active and v.has_opening
    union all
    select jsonb_build_object('sort', '6', 'tone', 'info',
      'text', 'Для «' || p.name || '» нет нормы гелия', 'action', 'указать', 'link', '/catalog/' || p.id)
    from public.products p where p.kind = 'balloon' and p.active and not exists (
      select 1 from public.variants v join public.helium_norms n on n.variant_id = v.id and n.active where v.product_id = p.id)
    union all
    select jsonb_build_object('sort', '7', 'tone', 'setup', 'text', 'Укажите, сколько денег на счетах на дату запуска',
      'action', 'указать', 'link', '/setup')
    where not exists (select 1 from public.money_movements where kind = 'opening')
    union all
    select jsonb_build_object('sort', '8', 'tone', 'setup', 'text', 'Пересчитайте склад на дату запуска',
      'action', 'начать', 'link', '/stock/count?opening=1')
    where not exists (select 1 from public.inventory_counts where is_opening)
    union all
    select jsonb_build_object('sort', '9', 'tone', 'review', 'text', o.source->>'review', 'action', 'проверить',
      'link', '/orders/' || o.id)
    from public.orders o where o.source ? 'review' and not coalesce((o.source->>'reviewed')::boolean, false)
    union all
    select jsonb_build_object('sort', '9', 'tone', 'review', 'text', p.source->>'review', 'action', 'проверить',
      'link', '/catalog/' || p.id)
    from public.products p where p.source ? 'review' and not coalesce((p.source->>'reviewed')::boolean, false)
  ) t
$$;

-- Mark an imported record's review note as handled.
create or replace function public.mark_reviewed(p_table text, p_id uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  perform public.require_owner();
  if p_table = 'orders' then
    update public.orders set source = source || '{"reviewed":true}' where id = p_id;
  elsif p_table = 'products' then
    update public.products set source = source || '{"reviewed":true}' where id = p_id;
  end if;
end $$;

-- ---------------------------------------------------------------- row level security
do $$
declare t text;
begin
  foreach t in array array['owners','settings','accounts','products','variants','helium_norms','templates','template_lines',
    'customers','orders','order_lines','order_costs','purchases','purchase_lines','helium_cylinders','expense_categories',
    'expenses','owner_flows','transfers','reserve_items','inventory_counts','money_movements','stock_movements',
    'request_log','audit_log']
  loop
    execute format('alter table public.%I enable row level security', t);
    execute format('create policy owners_read on public.%I for select to authenticated using (public.is_owner())', t);
  end loop;
  -- Catalog and plans are edited directly from the app; ledgers and orders only through the functions above.
  foreach t in array array['accounts','products','variants','helium_norms','templates','template_lines','customers',
    'expense_categories','reserve_items']
  loop
    execute format('create policy owners_insert on public.%I for insert to authenticated with check (public.is_owner())', t);
    execute format('create policy owners_update on public.%I for update to authenticated using (public.is_owner()) with check (public.is_owner())', t);
    execute format('create policy owners_delete on public.%I for delete to authenticated using (public.is_owner())', t);
  end loop;
  execute 'create policy owners_update on public.settings for update to authenticated using (public.is_owner()) with check (public.is_owner())';
end $$;

revoke all on all tables in schema public from anon;
revoke execute on all functions in schema public from public, anon;
grant execute on all functions in schema public to authenticated;
-- internal building blocks: callable only from the posting functions
revoke execute on function public.sync_writeoff(uuid, timestamptz) from authenticated;
revoke execute on function public.request_begin(uuid, text) from authenticated;
revoke execute on function public.request_end(uuid, jsonb) from authenticated;
revoke execute on function public.link_owner_on_signup() from authenticated;
revoke execute on function public.audit_trigger() from authenticated;

-- ---------------------------------------------------------------- realtime: the other owner sees changes at once
alter publication supabase_realtime add table public.orders, public.order_lines, public.order_costs,
  public.money_movements, public.stock_movements, public.products, public.variants, public.helium_norms,
  public.templates, public.template_lines, public.expenses, public.reserve_items, public.settings;

-- ---------------------------------------------------------------- photos (private bucket)
insert into storage.buckets (id, name, public) values ('photos', 'photos', false) on conflict (id) do nothing;
create policy photos_read on storage.objects for select to authenticated using (bucket_id = 'photos' and public.is_owner());
create policy photos_write on storage.objects for insert to authenticated with check (bucket_id = 'photos' and public.is_owner());
create policy photos_update on storage.objects for update to authenticated using (bucket_id = 'photos' and public.is_owner());
create policy photos_delete on storage.objects for delete to authenticated using (bucket_id = 'photos' and public.is_owner());
