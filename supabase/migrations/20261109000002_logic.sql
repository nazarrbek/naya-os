-- NAYA BALLOONS CRM — posting logic.
-- Every write goes through one of these functions: one call = one transaction = all linked records.
-- p_request_id makes a call idempotent: a repeated tap or network retry returns the first result.
-- Errors are human messages; HINT carries the form field to highlight.

-- ---------------------------------------------------------------- helpers
create or replace function public.fail(p_message text, p_field text default null) returns void
language plpgsql as $$
begin
  raise exception using message = p_message, hint = coalesce(p_field, ''), errcode = 'P0001';
end $$;

create or replace function public.require_owner() returns uuid
language plpgsql stable security definer set search_path = public as $$
declare v uuid := public.current_owner_id();
begin
  if v is null then perform public.fail('Нет доступа: войдите под своим аккаунтом'); end if;
  return v;
end $$;

-- Returns the stored result when this request was already processed; otherwise registers it.
create or replace function public.request_begin(p_request_id uuid, p_fn text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_result jsonb; v_inserted int;
begin
  if p_request_id is null then return null; end if;
  insert into public.request_log (request_id, fn, owner_id) values (p_request_id, p_fn, public.current_owner_id())
  on conflict (request_id) do nothing;
  get diagnostics v_inserted = row_count;
  if v_inserted = 0 then
    select result into v_result from public.request_log where request_id = p_request_id;
    return coalesce(v_result, '{"duplicate":true}'::jsonb);
  end if;
  return null;
end $$;

create or replace function public.request_end(p_request_id uuid, p_result jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
begin
  if p_request_id is not null then
    update public.request_log set result = p_result where request_id = p_request_id;
  end if;
  return p_result;
end $$;

create or replace function public.money_round(v numeric) returns numeric
language sql immutable as $$ select round(v, 2) $$;

create or replace function public.round_up(v numeric, p_step integer) returns numeric
language sql immutable as $$
  select case when p_step is null or p_step <= 1 then ceil(v) else ceil(v / p_step) * p_step end
$$;

-- Best helium norm for a variant: measured > estimate > cheatsheet > excel, newest first.
create or replace function public.current_norm(p_variant_id uuid)
returns table (norm_id uuid, helium_l numeric, source text, is_mix boolean, total_l numeric, helium_share numeric, set_at timestamptz)
language sql stable as $$
  select id, helium_l, source, is_mix, total_l, helium_share, set_at
  from public.helium_norms
  where variant_id = p_variant_id and active
  order by case source when 'measured' then 1 when 'estimate' then 2 when 'cheatsheet' then 3 else 4 end, set_at desc
  limit 1
$$;

create or replace function public.default_variant(p_product_id uuid) returns uuid
language sql stable as $$
  select id from public.variants where product_id = p_product_id and active
  order by is_default desc, is_unknown, maker limit 1
$$;

-- Average purchase cost: all receipts to general stock (opening, purchases, count surpluses).
-- Receipts bought for one order are excluded: their price belongs to that order only.
create or replace function public.avg_cost(p_product_id uuid, out cost numeric, out is_estimate boolean)
language plpgsql stable as $$
declare v_qty numeric; v_val numeric;
begin
  select sum(qty), sum(qty * unit_cost) into v_qty, v_val
  from public.stock_movements
  where product_id = p_product_id and qty > 0 and not is_direct
    and kind in ('opening','purchase','adjustment') and unit_cost > 0;
  if coalesce(v_qty, 0) > 0 then
    cost := v_val / v_qty;
    is_estimate := exists (select 1 from public.stock_movements where product_id = p_product_id
                           and qty > 0 and not is_direct and cost_is_estimate);
  else
    select ref_cost into cost from public.products where id = p_product_id;
    cost := coalesce(cost, 0);
    is_estimate := true;
  end if;
end $$;

create or replace function public.stock_qty(p_product_id uuid) returns numeric
language sql stable as $$
  select coalesce(sum(qty), 0) from public.stock_movements where product_id = p_product_id
$$;

-- What an order needs from stock: its lines plus helium litres and ribbon metres.
create or replace function public.order_requirements(p_order_id uuid)
returns table (product_id uuid, qty numeric)
language sql stable as $$
  with s as (select helium_product_id, ribbon_product_id from public.settings)
  select product_id, sum(qty) from (
    select l.product_id, l.qty from public.order_lines l where l.order_id = p_order_id
    union all
    select s.helium_product_id, sum(l.qty * coalesce(l.helium_l_per_unit, 0))
      from public.order_lines l, s where l.order_id = p_order_id and s.helium_product_id is not null group by 1
    union all
    select s.ribbon_product_id, sum(l.ribbon_m)
      from public.order_lines l, s where l.order_id = p_order_id and s.ribbon_product_id is not null group by 1
  ) x where qty > 0 group by product_id
$$;

-- Bring the order's stock consumption to exactly its requirements. Safe to call any number of times:
-- a second call finds nothing to do, so a double tap on "Выдан" never writes off twice.
create or replace function public.sync_writeoff(p_order_id uuid, p_at timestamptz) returns void
language plpgsql security definer set search_path = public as $$
declare
  r record;
  v_used numeric; v_used_val numeric; v_diff numeric;
  v_direct_qty numeric; v_direct_val numeric; v_from_direct numeric; v_rest numeric;
  v_avg record; v_unit numeric; v_est boolean;
  v_owner uuid := public.current_owner_id();
begin
  for r in
    select coalesce(req.product_id, used.product_id) as product_id, coalesce(req.qty, 0) as need
    from public.order_requirements(p_order_id) req
    full join (select product_id from public.stock_movements
               where order_id = p_order_id and kind = 'order_use' group by product_id) used
      on used.product_id = req.product_id
  loop
    select coalesce(-sum(qty), 0), coalesce(-sum(qty * unit_cost), 0) into v_used, v_used_val
      from public.stock_movements where order_id = p_order_id and kind = 'order_use' and product_id = r.product_id;
    v_diff := r.need - v_used;
    continue when v_diff = 0;

    if v_diff > 0 then
      select coalesce(sum(qty), 0), coalesce(sum(qty * unit_cost), 0) into v_direct_qty, v_direct_val
        from public.stock_movements where order_id = p_order_id and is_direct and product_id = r.product_id;
      v_from_direct := greatest(0, least(v_diff, v_direct_qty - least(v_used, v_direct_qty)));
      v_rest := v_diff - v_from_direct;
      select * into v_avg from public.avg_cost(r.product_id);
      v_unit := ((case when v_direct_qty > 0 then v_from_direct * v_direct_val / v_direct_qty else 0 end)
                 + v_rest * v_avg.cost) / v_diff;
      v_est := v_rest > 0 and v_avg.is_estimate;
      insert into public.stock_movements (occurred_at, product_id, qty, unit_cost, kind, order_id, cost_is_estimate, created_by)
      values (p_at, r.product_id, -v_diff, v_unit, 'order_use', p_order_id, v_est, v_owner);
    else
      -- composition got smaller: return to stock at the cost it was taken
      v_unit := case when v_used > 0 then v_used_val / v_used else 0 end;
      insert into public.stock_movements (occurred_at, product_id, qty, unit_cost, kind, order_id, created_by, note)
      values (p_at, r.product_id, -v_diff, v_unit, 'order_use', p_order_id, v_owner, 'Возврат на склад после изменения состава');
    end if;
  end loop;
end $$;

-- Preliminary cost of an order from its current composition (used for price advice before it is issued).
-- Helium is priced at the planning price per litre; materials at average purchase cost.
create or replace function public.order_estimate(p_order_id uuid) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  s public.settings; v_lines jsonb := '[]'::jsonb; r record; v_avg record; v_rib record;
  v_total numeric := 0; v_helium_l numeric := 0; v_approx boolean := false; v_line_cost numeric;
  v_costs numeric; v_direct record;
begin
  select * into s from public.settings;
  select * into v_rib from public.avg_cost(s.ribbon_product_id);
  for r in
    select l.*, p.name as product_name, p.kind as product_kind, v.maker
    from public.order_lines l join public.products p on p.id = l.product_id
    left join public.variants v on v.id = l.variant_id
    where l.order_id = p_order_id order by l.sort, p.name
  loop
    select * into v_avg from public.avg_cost(r.product_id);
    select coalesce(sum(qty), 0) as q, coalesce(sum(qty * unit_cost), 0) as v into v_direct
      from public.stock_movements where order_id = p_order_id and is_direct and product_id = r.product_id;
    v_line_cost := least(r.qty, v_direct.q) * (case when v_direct.q > 0 then v_direct.v / v_direct.q else 0 end)
                 + greatest(0, r.qty - v_direct.q) * v_avg.cost
                 + r.qty * coalesce(r.helium_l_per_unit, 0) * s.helium_plan_price
                 + r.ribbon_m * coalesce(v_rib.cost, 0);
    v_total := v_total + v_line_cost;
    v_helium_l := v_helium_l + r.qty * coalesce(r.helium_l_per_unit, 0);
    if (r.product_kind = 'balloon' and (r.helium_l_per_unit is null or coalesce(r.helium_source, '') <> 'measured'))
       or (v_avg.is_estimate and r.qty > v_direct.q) then
      v_approx := true;
    end if;
    v_lines := v_lines || jsonb_build_object(
      'line_id', r.id, 'product', r.product_name, 'maker', r.maker, 'qty', r.qty,
      'unit_cost', round(v_avg.cost, 2), 'helium_l', r.qty * coalesce(r.helium_l_per_unit, 0),
      'helium_unknown', r.product_kind = 'balloon' and r.helium_l_per_unit is null,
      'helium_source', r.helium_source, 'ribbon_m', r.ribbon_m, 'cost', round(v_line_cost, 2));
  end loop;
  select coalesce(sum(amount), 0) into v_costs from public.order_costs where order_id = p_order_id;
  -- until the real print is recorded, the planned one is used for price advice
  if v_costs = 0 then
    select coalesce(service_estimate, 0) into v_costs from public.orders where id = p_order_id;
    if v_costs > 0 then v_approx := true; end if;
  end if;
  v_total := v_total + v_costs;
  return jsonb_build_object('cost', round(v_total, 2), 'helium_l', v_helium_l, 'is_approx', v_approx,
                            'order_costs', v_costs, 'lines', v_lines, 'helium_price', s.helium_plan_price);
end $$;

-- Actual cost of an order: what was really written off (at purchase prices) + its direct costs.
create or replace function public.order_actual_cost(p_order_id uuid) returns numeric
language sql stable as $$
  select coalesce((select -sum(value) from public.stock_movements
                   where order_id = p_order_id and kind in ('order_use','defect')), 0)
       + coalesce((select sum(amount) from public.order_costs where order_id = p_order_id), 0)
$$;

create or replace function public.order_paid(p_order_id uuid) returns numeric
language sql stable as $$
  select coalesce(sum(amount), 0) from public.money_movements
  where order_id = p_order_id and kind in ('client_payment','client_refund')
$$;

-- ---------------------------------------------------------------- orders
create or replace function public.save_order(p_request_id uuid, p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_owner uuid := public.require_owner();
  v_prev jsonb; v_order public.orders; v_id uuid := nullif(p->>'id', '')::uuid;
  v_line jsonb; v_est jsonb; s public.settings; v_min numeric; i int := 0;
  v_variant uuid; v_norm record; v_product public.products;
begin
  v_prev := public.request_begin(p_request_id, 'save_order');
  if v_prev is not null then return v_prev; end if;
  select * into s from public.settings;

  if coalesce(trim(p->>'title'), '') = '' then perform public.fail('Напишите, что заказали', 'title'); end if;
  if jsonb_array_length(coalesce(p->'lines', '[]'::jsonb)) = 0 then
    perform public.fail('Добавьте хотя бы один шар или товар', 'lines');
  end if;
  if coalesce((p->>'price')::numeric, 0) < 0 then perform public.fail('Цена не может быть меньше нуля', 'price'); end if;

  if v_id is null then
    insert into public.orders (title, created_by) values (p->>'title', v_owner) returning * into v_order;
  else
    select * into v_order from public.orders where id = v_id for update;
    if not found then perform public.fail('Заказ не найден'); end if;
    if v_order.status in ('issued','cancelled') then
      perform public.fail('Заказ уже ' || case v_order.status when 'issued' then 'выдан' else 'отменён' end
                          || '. Изменить можно через «Исправить выданный заказ»');
    end if;
    if p ? 'version' and (p->>'version')::int <> v_order.version then
      perform public.fail('Этот заказ только что изменили на другом устройстве. Обновите страницу и проверьте изменения', 'version');
    end if;
  end if;

  update public.orders set
    title = p->>'title',
    customer_id = nullif(p->>'customer_id', '')::uuid,
    client_name = nullif(trim(p->>'client_name'), ''),
    client_phone = nullif(trim(p->>'client_phone'), ''),
    due_at = nullif(p->>'due_at', '')::timestamptz,
    delivery = coalesce(nullif(p->>'delivery', ''), 'pickup'),
    address = nullif(trim(p->>'address'), ''),
    delivery_price = coalesce((p->>'delivery_price')::numeric, 0),
    template_id = nullif(p->>'template_id', '')::uuid,
    coef = nullif(p->>'coef', '')::numeric,
    price = coalesce((p->>'price')::numeric, 0),
    discount = coalesce((p->>'discount')::numeric, 0),
    low_price_ack = coalesce((p->>'low_price_ack')::boolean, false),
    comment = nullif(p->>'comment', ''),
    inscription = nullif(p->>'inscription', ''),
    design = nullif(p->>'design', ''),
    photo_path = nullif(p->>'photo_path', ''),
    service_label = nullif(trim(p->>'service_label'), ''),
    service_estimate = coalesce(nullif(p->>'service_estimate', '')::numeric, 0),
    version = version + case when v_id is null then 0 else 1 end,
    updated_at = now()
  where id = v_order.id;

  delete from public.order_lines where order_id = v_order.id;
  for v_line in select * from jsonb_array_elements(p->'lines') loop
    i := i + 1;
    select * into v_product from public.products where id = (v_line->>'product_id')::uuid;
    if not found then perform public.fail('Товар не найден в каталоге', 'lines'); end if;
    if coalesce((v_line->>'qty')::numeric, 0) <= 0 then
      perform public.fail('Для «' || v_product.name || '» укажите количество больше нуля', 'lines');
    end if;
    v_variant := coalesce(nullif(v_line->>'variant_id', '')::uuid,
                          case when v_product.kind = 'balloon' then public.default_variant(v_product.id) end);
    select * into v_norm from public.current_norm(v_variant);
    insert into public.order_lines (order_id, product_id, variant_id, qty, helium_l_per_unit, helium_source,
                                    helium_is_mix, ribbon_m, sort)
    values (v_order.id, v_product.id, v_variant, (v_line->>'qty')::numeric,
            case when v_line ? 'helium_l_per_unit' then nullif(v_line->>'helium_l_per_unit', '')::numeric
                 when v_product.kind = 'balloon' then v_norm.helium_l end,
            case when v_line ? 'helium_l_per_unit' then coalesce(nullif(v_line->>'helium_source', ''), 'estimate')
                 when v_product.kind = 'balloon' then v_norm.source end,
            coalesce((v_line->>'helium_is_mix')::boolean, coalesce(v_norm.is_mix, false)),
            coalesce(nullif(v_line->>'ribbon_m', '')::numeric,
                     (v_line->>'qty')::numeric * coalesce(v_product.ribbon_m_per_unit, 0)),
            i);
  end loop;

  -- Price below the minimum coefficient needs an explicit confirmation.
  v_est := public.order_estimate(v_order.id);
  v_min := round((v_est->>'cost')::numeric * s.min_coef);
  if coalesce((p->>'price')::numeric, 0) > 0 and (p->>'price')::numeric < v_min
     and not coalesce((p->>'low_price_ack')::boolean, false) then
    perform public.fail('Цена ниже минимальной (' || v_min || ' ₸ при себестоимости ≈ '
                        || round((v_est->>'cost')::numeric) || ' ₸). Сохранить всё равно?', 'price_low');
  end if;

  if v_order.status = 'assembled' then perform public.sync_writeoff(v_order.id, now()); end if;

  -- Prepayment in the same save: one tap creates the order and the money record.
  if coalesce((p->'prepayment'->>'amount')::numeric, 0) > 0 then
    if nullif(p->'prepayment'->>'account_id', '') is null then
      perform public.fail('Выберите, куда пришла предоплата', 'prepayment_account');
    end if;
    insert into public.money_movements (occurred_at, account_id, amount, kind, order_id, note, created_by)
    values (coalesce(nullif(p->'prepayment'->>'at', '')::timestamptz, now()),
            (p->'prepayment'->>'account_id')::uuid, (p->'prepayment'->>'amount')::numeric,
            'client_payment', v_order.id, 'Предоплата', v_owner);
  end if;

  select * into v_order from public.orders where id = v_order.id;
  return public.request_end(p_request_id,
    jsonb_build_object('id', v_order.id, 'number', v_order.number, 'version', v_order.version));
end $$;

create or replace function public.add_payment(p_request_id uuid, p_order_id uuid, p_amount numeric,
  p_account_id uuid, p_at timestamptz default null, p_note text default null) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_owner uuid := public.require_owner(); v_prev jsonb; v_order public.orders; v_id uuid;
begin
  v_prev := public.request_begin(p_request_id, 'add_payment');
  if v_prev is not null then return v_prev; end if;
  if coalesce(p_amount, 0) <= 0 then perform public.fail('Введите сумму оплаты', 'amount'); end if;
  if p_account_id is null then perform public.fail('Выберите, куда пришли деньги', 'account'); end if;
  select * into v_order from public.orders where id = p_order_id for update;
  if not found then perform public.fail('Заказ не найден'); end if;
  if v_order.status = 'cancelled' then perform public.fail('Заказ отменён — оплату к нему принять нельзя'); end if;
  insert into public.money_movements (occurred_at, account_id, amount, kind, order_id, note, created_by)
  values (coalesce(p_at, now()), p_account_id, p_amount, 'client_payment', p_order_id, p_note, v_owner)
  returning id into v_id;
  return public.request_end(p_request_id, jsonb_build_object('id', v_id, 'paid', public.order_paid(p_order_id)));
end $$;

create or replace function public.refund_payment(p_request_id uuid, p_order_id uuid, p_amount numeric,
  p_account_id uuid, p_at timestamptz default null, p_note text default null) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_owner uuid := public.require_owner(); v_prev jsonb; v_order public.orders; v_paid numeric;
begin
  v_prev := public.request_begin(p_request_id, 'refund_payment');
  if v_prev is not null then return v_prev; end if;
  select * into v_order from public.orders where id = p_order_id for update;
  if not found then perform public.fail('Заказ не найден'); end if;
  if coalesce(p_amount, 0) <= 0 then perform public.fail('Введите сумму возврата', 'amount'); end if;
  if p_account_id is null then perform public.fail('Выберите, откуда вернули деньги', 'account'); end if;
  v_paid := public.order_paid(p_order_id);
  if v_order.payment_known and p_amount > v_paid then
    perform public.fail('Клиент заплатил ' || v_paid || ' ₸ — вернуть больше нельзя', 'amount');
  end if;
  insert into public.money_movements (occurred_at, account_id, amount, kind, order_id, note, reduces_revenue, created_by)
  values (coalesce(p_at, now()), p_account_id, -p_amount, 'client_refund', p_order_id,
          coalesce(p_note, 'Возврат клиенту'), v_order.status = 'issued', v_owner);
  return public.request_end(p_request_id, jsonb_build_object('paid', public.order_paid(p_order_id)));
end $$;

create or replace function public.assemble_order(p_request_id uuid, p_order_id uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_owner uuid := public.require_owner(); v_prev jsonb; v_order public.orders;
begin
  v_prev := public.request_begin(p_request_id, 'assemble_order');
  if v_prev is not null then return v_prev; end if;
  select * into v_order from public.orders where id = p_order_id for update;
  if not found then perform public.fail('Заказ не найден'); end if;
  if v_order.status = 'new' then
    perform public.sync_writeoff(p_order_id, now());
    update public.orders set status = 'assembled', assembled_at = now(), version = version + 1, updated_at = now()
    where id = p_order_id;
  elsif v_order.status = 'cancelled' then
    perform public.fail('Заказ отменён');
  end if;
  return public.request_end(p_request_id, jsonb_build_object('status', (select status from public.orders where id = p_order_id)));
end $$;

-- "Заказ выдан": writes off materials (unless already assembled), recognises revenue, optionally takes the final payment.
create or replace function public.issue_order(p_request_id uuid, p_order_id uuid,
  p_payment_amount numeric default null, p_payment_account_id uuid default null, p_at timestamptz default null)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_owner uuid := public.require_owner(); v_prev jsonb; v_order public.orders; v_at timestamptz := coalesce(p_at, now());
begin
  v_prev := public.request_begin(p_request_id, 'issue_order');
  if v_prev is not null then return v_prev; end if;
  select * into v_order from public.orders where id = p_order_id for update;
  if not found then perform public.fail('Заказ не найден'); end if;
  if v_order.status = 'cancelled' then perform public.fail('Заказ отменён — выдать его нельзя'); end if;
  if v_order.status <> 'issued' then
    if v_order.price <= 0 then perform public.fail('Укажите цену заказа перед выдачей', 'price'); end if;
    perform public.sync_writeoff(p_order_id, v_at);
    update public.orders set status = 'issued', issued_at = v_at, version = version + 1, updated_at = now()
    where id = p_order_id;
    if coalesce(p_payment_amount, 0) > 0 then
      if p_payment_account_id is null then perform public.fail('Выберите, куда пришли деньги', 'account'); end if;
      insert into public.money_movements (occurred_at, account_id, amount, kind, order_id, note, created_by)
      values (v_at, p_payment_account_id, p_payment_amount, 'client_payment', p_order_id, 'Оплата при выдаче', v_owner);
    end if;
  end if;
  return public.request_end(p_request_id, jsonb_build_object('status', 'issued',
    'paid', public.order_paid(p_order_id), 'cost', public.order_actual_cost(p_order_id)));
end $$;

create or replace function public.cancel_order(p_request_id uuid, p_order_id uuid, p_refund_amount numeric,
  p_refund_account_id uuid, p_reason text default null) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_owner uuid := public.require_owner(); v_prev jsonb; v_order public.orders; v_paid numeric;
begin
  v_prev := public.request_begin(p_request_id, 'cancel_order');
  if v_prev is not null then return v_prev; end if;
  select * into v_order from public.orders where id = p_order_id for update;
  if not found then perform public.fail('Заказ не найден'); end if;
  if v_order.status = 'cancelled' then return public.request_end(p_request_id, '{"status":"cancelled"}'); end if;
  if v_order.status = 'issued' then
    perform public.fail('Заказ уже выдан. Для возврата денег используйте «Вернуть деньги»');
  end if;
  v_paid := public.order_paid(p_order_id);
  if coalesce(p_refund_amount, 0) > v_paid then
    perform public.fail('Клиент заплатил ' || v_paid || ' ₸ — вернуть больше нельзя', 'amount');
  end if;
  if coalesce(p_refund_amount, 0) > 0 then
    if p_refund_account_id is null then perform public.fail('Выберите, откуда вернули деньги', 'account'); end if;
    insert into public.money_movements (occurred_at, account_id, amount, kind, order_id, note, created_by)
    values (now(), p_refund_account_id, -p_refund_amount, 'client_refund', p_order_id, 'Возврат при отмене', v_owner);
  end if;
  update public.orders set status = 'cancelled', cancelled_at = now(), cancel_reason = p_reason,
    cancel_revenue = v_paid - coalesce(p_refund_amount, 0), version = version + 1, updated_at = now()
  where id = p_order_id;
  return public.request_end(p_request_id, jsonb_build_object('status', 'cancelled',
    'kept', v_paid - coalesce(p_refund_amount, 0)));
end $$;

-- A burst / defective balloon replaced in an order: material (and its helium) go to this order's cost.
create or replace function public.report_defect(p_request_id uuid, p_order_id uuid, p_product_id uuid,
  p_qty numeric, p_with_helium boolean default true, p_note text default null) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_owner uuid := public.require_owner(); v_prev jsonb; v_avg record; v_product public.products;
  v_helium numeric; v_he_avg record; s public.settings;
begin
  v_prev := public.request_begin(p_request_id, 'report_defect');
  if v_prev is not null then return v_prev; end if;
  if coalesce(p_qty, 0) <= 0 then perform public.fail('Укажите количество', 'qty'); end if;
  select * into s from public.settings;
  select * into v_product from public.products where id = p_product_id;
  select * into v_avg from public.avg_cost(p_product_id);
  insert into public.stock_movements (occurred_at, product_id, qty, unit_cost, kind, order_id, cost_is_estimate, note, created_by)
  values (now(), p_product_id, -p_qty, v_avg.cost, 'defect', p_order_id, v_avg.is_estimate,
          coalesce(p_note, 'Брак / замена'), v_owner);
  if p_with_helium and v_product.kind = 'balloon' and s.helium_product_id is not null then
    select coalesce(l.helium_l_per_unit, n.helium_l) into v_helium
    from public.order_lines l left join lateral public.current_norm(l.variant_id) n on true
    where l.order_id = p_order_id and l.product_id = p_product_id limit 1;
    if coalesce(v_helium, 0) > 0 then
      select * into v_he_avg from public.avg_cost(s.helium_product_id);
      insert into public.stock_movements (occurred_at, product_id, qty, unit_cost, kind, order_id, cost_is_estimate, note, created_by)
      values (now(), s.helium_product_id, -(p_qty * v_helium), v_he_avg.cost, 'defect', p_order_id, true,
              'Гелий на замену: ' || v_product.name, v_owner);
    end if;
  end if;
  return public.request_end(p_request_id, jsonb_build_object('cost', public.order_actual_cost(p_order_id)));
end $$;

-- Print shop, delivery taxi, other service for one order. Goes into this order's cost only:
-- not into stock, not into business expenses — so it can never be counted twice.
create or replace function public.add_order_cost(p_request_id uuid, p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_owner uuid := public.require_owner(); v_prev jsonb; v_id uuid; v_order public.orders;
begin
  v_prev := public.request_begin(p_request_id, 'add_order_cost');
  if v_prev is not null then return v_prev; end if;
  select * into v_order from public.orders where id = nullif(p->>'order_id', '')::uuid;
  if not found then perform public.fail('Выберите заказ, к которому относится трата', 'order'); end if;
  if coalesce((p->>'amount')::numeric, 0) <= 0 then perform public.fail('Введите сумму', 'amount'); end if;
  insert into public.order_costs (order_id, kind, label, amount, is_mistake, occurred_at, account_id, supplier, created_by)
  values (v_order.id, coalesce(nullif(p->>'kind', ''), 'service'), coalesce(nullif(trim(p->>'label'), ''), 'Печать'),
          (p->>'amount')::numeric, coalesce((p->>'is_mistake')::boolean, false),
          coalesce(nullif(p->>'occurred_at', '')::timestamptz, now()),
          nullif(p->>'account_id', '')::uuid, nullif(p->>'supplier', ''), v_owner)
  returning id into v_id;
  if nullif(p->>'account_id', '') is not null then
    insert into public.money_movements (occurred_at, account_id, amount, kind, order_id, order_cost_id, note, created_by)
    values (coalesce(nullif(p->>'occurred_at', '')::timestamptz, now()), (p->>'account_id')::uuid,
            -(p->>'amount')::numeric, 'order_cost', v_order.id, v_id, p->>'label', v_owner);
  end if;
  return public.request_end(p_request_id, jsonb_build_object('id', v_id, 'cost', public.order_actual_cost(v_order.id)));
end $$;

-- Owner-confirmed correction of an issued order: price, date or composition. Reason is required and kept in history.
create or replace function public.correct_issued_order(p_request_id uuid, p_order_id uuid, p_reason text, p jsonb)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_owner uuid := public.require_owner(); v_prev jsonb; v_order public.orders; v_line jsonb; i int := 0;
begin
  v_prev := public.request_begin(p_request_id, 'correct_issued_order');
  if v_prev is not null then return v_prev; end if;
  if coalesce(trim(p_reason), '') = '' then perform public.fail('Напишите, что и почему исправляете', 'reason'); end if;
  select * into v_order from public.orders where id = p_order_id for update;
  if v_order.status <> 'issued' then perform public.fail('Исправление нужно только для выданных заказов'); end if;
  perform set_config('naya.reason', p_reason, true);
  update public.orders set
    price = coalesce((p->>'price')::numeric, price),
    issued_at = coalesce(nullif(p->>'issued_at', '')::timestamptz, issued_at),
    date_uncertain = case when p ? 'issued_at' then false else date_uncertain end,
    version = version + 1, updated_at = now()
  where id = p_order_id;
  if p ? 'lines' and not v_order.is_historical then
    delete from public.order_lines where order_id = p_order_id;
    for v_line in select * from jsonb_array_elements(p->'lines') loop
      i := i + 1;
      insert into public.order_lines (order_id, product_id, variant_id, qty, helium_l_per_unit, helium_source, helium_is_mix, ribbon_m, sort)
      values (p_order_id, (v_line->>'product_id')::uuid, nullif(v_line->>'variant_id', '')::uuid, (v_line->>'qty')::numeric,
              nullif(v_line->>'helium_l_per_unit', '')::numeric, nullif(v_line->>'helium_source', ''),
              coalesce((v_line->>'helium_is_mix')::boolean, false), coalesce((v_line->>'ribbon_m')::numeric, 0), i);
    end loop;
    perform public.sync_writeoff(p_order_id, now());
  end if;
  return public.request_end(p_request_id, jsonb_build_object('ok', true));
end $$;

-- ---------------------------------------------------------------- purchases & helium
create or replace function public.record_purchase(p_request_id uuid, p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_owner uuid := public.require_owner(); v_prev jsonb; v_purchase uuid; v_line jsonb; v_pl uuid;
  v_total numeric := 0; v_at timestamptz := coalesce(nullif(p->>'occurred_at', '')::timestamptz, now());
  v_qty numeric; v_amount numeric; v_unit numeric; v_order public.orders; v_need numeric; v_direct numeric;
  v_product public.products; s public.settings; v_refill boolean := coalesce((p->>'helium_refill')::boolean, false);
  v_cyl public.helium_cylinders;
begin
  v_prev := public.request_begin(p_request_id, 'record_purchase');
  if v_prev is not null then return v_prev; end if;
  select * into s from public.settings;
  if jsonb_array_length(coalesce(p->'lines', '[]'::jsonb)) = 0 then
    perform public.fail('Добавьте, что купили', 'lines');
  end if;
  if nullif(p->>'account_id', '') is null then perform public.fail('Выберите, с какого счёта платили', 'account'); end if;
  for v_line in select * from jsonb_array_elements(p->'lines') loop
    v_total := v_total + coalesce((v_line->>'amount')::numeric, 0);
  end loop;
  if v_total <= 0 then perform public.fail('Введите сумму покупки', 'amount'); end if;

  insert into public.purchases (occurred_at, supplier, account_id, total, note, is_helium_refill, reserve_item_id, created_by)
  values (v_at, nullif(trim(p->>'supplier'), ''), (p->>'account_id')::uuid, v_total, nullif(p->>'note', ''),
          v_refill, nullif(p->>'reserve_item_id', '')::uuid, v_owner)
  returning id into v_purchase;

  for v_line in select * from jsonb_array_elements(p->'lines') loop
    select * into v_product from public.products where id = (v_line->>'product_id')::uuid;
    if not found then perform public.fail('Товар не найден в каталоге', 'lines'); end if;
    v_qty := (v_line->>'qty')::numeric; v_amount := coalesce((v_line->>'amount')::numeric, 0);
    if coalesce(v_qty, 0) <= 0 then perform public.fail('Для «' || v_product.name || '» укажите количество', 'lines'); end if;
    v_unit := v_amount / v_qty;
    insert into public.purchase_lines (purchase_id, product_id, variant_id, qty, amount, order_id)
    values (v_purchase, v_product.id, nullif(v_line->>'variant_id', '')::uuid, v_qty, v_amount, nullif(v_line->>'order_id', '')::uuid)
    returning id into v_pl;

    v_direct := 0;
    if nullif(v_line->>'order_id', '') is not null then
      select * into v_order from public.orders where id = (v_line->>'order_id')::uuid for update;
      if v_order.status = 'new' then
        -- only what the order still needs is "for the order"; the rest goes to general stock at the same price
        select coalesce(sum(r.qty), 0) into v_need from public.order_requirements(v_order.id) r where r.product_id = v_product.id;
        select v_need - coalesce(sum(qty), 0) into v_need from public.stock_movements
          where order_id = v_order.id and is_direct and product_id = v_product.id;
        v_direct := greatest(0, least(v_qty, v_need));
      end if;
    end if;
    if v_direct > 0 then
      insert into public.stock_movements (occurred_at, product_id, variant_id, qty, unit_cost, kind, order_id, purchase_line_id, is_direct, created_by, note)
      values (v_at, v_product.id, nullif(v_line->>'variant_id', '')::uuid, v_direct, v_unit, 'purchase', v_order.id, v_pl, true, v_owner,
              'Куплено для заказа №' || v_order.number);
    end if;
    if v_qty - v_direct > 0 then
      insert into public.stock_movements (occurred_at, product_id, variant_id, qty, unit_cost, kind, purchase_line_id, created_by)
      values (v_at, v_product.id, nullif(v_line->>'variant_id', '')::uuid, v_qty - v_direct, v_unit, 'purchase', v_pl, v_owner);
    end if;
  end loop;

  insert into public.money_movements (occurred_at, account_id, amount, kind, purchase_id, note, created_by)
  values (v_at, (p->>'account_id')::uuid, -v_total, 'purchase', v_purchase,
          case when v_refill then 'Заправка гелия' else coalesce(nullif(trim(p->>'supplier'), ''), 'Покупка материалов') end, v_owner);

  if v_refill then
    select * into v_cyl from public.helium_cylinders where ended_at is null order by started_at desc limit 1;
    if found then
      update public.helium_cylinders set ended_at = v_at,
        used_l_at_end = (select coalesce(-sum(qty), 0) from public.stock_movements
                         where product_id = s.helium_product_id and kind in ('order_use','defect','loss')
                           and occurred_at >= v_cyl.started_at and occurred_at < v_at)
      where id = v_cyl.id;
    end if;
    insert into public.helium_cylinders (started_at, nominal_l, purchase_id, note)
    values (v_at, (select sum((l->>'qty')::numeric) from jsonb_array_elements(p->'lines') l
                   where (l->>'product_id')::uuid = s.helium_product_id), v_purchase, 'Заправка');
  end if;

  return public.request_end(p_request_id, jsonb_build_object('id', v_purchase, 'total', v_total));
end $$;

-- "Баллон пуст": compares litres written off by orders with the cylinder volume.
create or replace function public.end_helium_cylinder(p_request_id uuid, p_left_l numeric default 0) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_owner uuid := public.require_owner(); v_prev jsonb; v_cyl public.helium_cylinders; s public.settings;
  v_used numeric; v_stock numeric; v_he_avg record; v_real numeric;
begin
  v_prev := public.request_begin(p_request_id, 'end_helium_cylinder');
  if v_prev is not null then return v_prev; end if;
  select * into s from public.settings;
  select * into v_cyl from public.helium_cylinders where ended_at is null order by started_at desc limit 1 for update;
  if not found then perform public.fail('Нет активного баллона — запишите заправку'); end if;
  select coalesce(-sum(qty), 0) into v_used from public.stock_movements
    where product_id = s.helium_product_id and kind in ('order_use','defect') and occurred_at >= v_cyl.started_at;
  v_real := v_cyl.nominal_l - coalesce(p_left_l, 0);
  update public.helium_cylinders set ended_at = now(), used_l_at_end = v_used where id = v_cyl.id;
  -- whatever litres the books still show are written off as "потери / неучтённый расход"
  v_stock := public.stock_qty(s.helium_product_id) - coalesce(p_left_l, 0);
  if v_stock <> 0 then
    select * into v_he_avg from public.avg_cost(s.helium_product_id);
    insert into public.stock_movements (occurred_at, product_id, qty, unit_cost, kind, note, created_by)
    values (now(), s.helium_product_id, -v_stock, v_he_avg.cost, 'loss', 'Баллон пуст: выравнивание остатка гелия', v_owner);
  end if;
  return public.request_end(p_request_id, jsonb_build_object(
    'nominal_l', v_cyl.nominal_l, 'start_is_estimate', v_cyl.start_is_estimate, 'used_by_orders_l', v_used,
    'real_used_l', v_real, 'diff_l', v_real - v_used,
    'ratio', case when v_used > 0 then round(v_real / v_used, 3) end));
end $$;

-- ---------------------------------------------------------------- expenses, owners, transfers
create or replace function public.record_expense(p_request_id uuid, p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_owner uuid := public.require_owner(); v_prev jsonb; v_id uuid; v_class text := p->>'class';
  v_amount numeric := (p->>'amount')::numeric; v_at timestamptz := coalesce(nullif(p->>'occurred_at', '')::timestamptz, now());
  o record; v_total_share numeric;
begin
  v_prev := public.request_begin(p_request_id, 'record_expense');
  if v_prev is not null then return v_prev; end if;
  if coalesce(v_amount, 0) <= 0 then perform public.fail('Введите сумму', 'amount'); end if;
  if nullif(p->>'account_id', '') is null then perform public.fail('Выберите, с какого счёта платили', 'account'); end if;
  if v_class not in ('opex','equipment','tax','personal') then perform public.fail('Выберите вид траты', 'class'); end if;
  if v_class = 'opex' and coalesce(p->>'category', '') = '' then perform public.fail('Выберите, на что потратили', 'category'); end if;

  insert into public.expenses (occurred_at, class, category, description, amount, account_id, order_id, reserve_item_id, created_by)
  values (v_at, v_class, nullif(p->>'category', ''), nullif(trim(p->>'description'), ''), v_amount,
          (p->>'account_id')::uuid, nullif(p->>'order_id', '')::uuid, nullif(p->>'reserve_item_id', '')::uuid, v_owner)
  returning id into v_id;
  insert into public.money_movements (occurred_at, account_id, amount, kind, expense_id, note, created_by)
  values (v_at, (p->>'account_id')::uuid, -v_amount, 'expense', v_id,
          coalesce(nullif(p->>'category', ''), nullif(trim(p->>'description'), '')), v_owner);

  -- Personal spending from business money counts as money received by the owner (or both, by shares).
  if v_class = 'personal' then
    if nullif(p->>'owner_id', '') is not null then
      insert into public.owner_flows (occurred_at, owner_id, kind, amount, expense_id, note)
      values (v_at, (p->>'owner_id')::uuid, 'personal', v_amount, v_id, p->>'description');
    else
      select sum(share) into v_total_share from public.owners;
      for o in select * from public.owners order by email loop
        insert into public.owner_flows (occurred_at, owner_id, kind, amount, expense_id, note)
        values (v_at, o.id, 'personal', round(v_amount * o.share / v_total_share, 2), v_id,
                coalesce(p->>'description', '') || ' (общая личная трата)');
      end loop;
    end if;
  end if;
  return public.request_end(p_request_id, jsonb_build_object('id', v_id));
end $$;

create or replace function public.record_owner_flow(p_request_id uuid, p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_owner uuid := public.require_owner(); v_prev jsonb; v_id uuid; v_kind text := p->>'kind';
  v_amount numeric := (p->>'amount')::numeric; v_at timestamptz := coalesce(nullif(p->>'occurred_at', '')::timestamptz, now());
  v_avail jsonb;
begin
  v_prev := public.request_begin(p_request_id, 'record_owner_flow');
  if v_prev is not null then return v_prev; end if;
  if v_kind not in ('withdrawal','contribution') then perform public.fail('Выберите: взять или внести', 'kind'); end if;
  if coalesce(v_amount, 0) <= 0 then perform public.fail('Введите сумму', 'amount'); end if;
  if nullif(p->>'owner_id', '') is null then perform public.fail('Выберите, кто', 'owner'); end if;
  if nullif(p->>'account_id', '') is null then perform public.fail('Выберите счёт', 'account'); end if;
  if v_kind = 'withdrawal' and not coalesce((p->>'over_limit_ack')::boolean, false) then
    v_avail := public.payout_summary();
    if v_amount > coalesce((v_avail->'owners'->(p->>'owner_id')->>'can_take')::numeric, 0) then
      perform public.fail('Это больше доступной доли (' ||
        coalesce((v_avail->'owners'->(p->>'owner_id')->>'can_take'), '0') || ' ₸). Взять всё равно?', 'amount_over');
    end if;
  end if;
  insert into public.owner_flows (occurred_at, owner_id, kind, amount, note)
  values (v_at, (p->>'owner_id')::uuid, v_kind, v_amount, nullif(p->>'note', ''))
  returning id into v_id;
  insert into public.money_movements (occurred_at, account_id, amount, kind, owner_flow_id, note, created_by)
  values (v_at, (p->>'account_id')::uuid, case when v_kind = 'withdrawal' then -v_amount else v_amount end,
          case when v_kind = 'withdrawal' then 'owner_withdrawal' else 'owner_contribution' end, v_id, p->>'note', v_owner);
  return public.request_end(p_request_id, jsonb_build_object('id', v_id));
end $$;

create or replace function public.record_transfer(p_request_id uuid, p_from uuid, p_to uuid, p_amount numeric,
  p_at timestamptz default null, p_note text default null) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_owner uuid := public.require_owner(); v_prev jsonb; v_id uuid; v_at timestamptz := coalesce(p_at, now());
begin
  v_prev := public.request_begin(p_request_id, 'record_transfer');
  if v_prev is not null then return v_prev; end if;
  if p_from is null then perform public.fail('Выберите, откуда', 'from'); end if;
  if p_to is null then perform public.fail('Выберите, куда', 'to'); end if;
  if p_from = p_to then perform public.fail('Счета должны быть разными', 'to'); end if;
  if coalesce(p_amount, 0) <= 0 then perform public.fail('Введите сумму', 'amount'); end if;
  insert into public.transfers (occurred_at, from_account_id, to_account_id, amount, note, created_by)
  values (v_at, p_from, p_to, p_amount, p_note, v_owner) returning id into v_id;
  insert into public.money_movements (occurred_at, account_id, amount, kind, transfer_id, note, created_by)
  values (v_at, p_from, -p_amount, 'transfer', v_id, p_note, v_owner),
         (v_at, p_to, p_amount, 'transfer', v_id, p_note, v_owner);
  return public.request_end(p_request_id, jsonb_build_object('id', v_id));
end $$;

-- ---------------------------------------------------------------- start balances & inventory
create or replace function public.set_opening_money(p_request_id uuid, p_at timestamptz, p_balances jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_owner uuid := public.require_owner(); v_prev jsonb; k text; v numeric;
begin
  v_prev := public.request_begin(p_request_id, 'set_opening_money');
  if v_prev is not null then return v_prev; end if;
  for k, v in select key, value::numeric from jsonb_each_text(p_balances) loop
    if exists (select 1 from public.money_movements where account_id = k::uuid and kind = 'opening') then
      perform public.fail('Начальный остаток этого счёта уже записан. Для исправления сделайте сверку счёта');
    end if;
    if v <> 0 then
      insert into public.money_movements (occurred_at, account_id, amount, kind, note, created_by)
      values (p_at, k::uuid, v, 'opening', 'Остаток на дату запуска', v_owner);
    end if;
  end loop;
  return public.request_end(p_request_id, '{"ok":true}');
end $$;

-- Account reconciliation: the real balance differs from the books → one explicit adjustment.
create or replace function public.reconcile_account(p_request_id uuid, p_account_id uuid, p_real numeric, p_note text)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_owner uuid := public.require_owner(); v_prev jsonb; v_book numeric;
begin
  v_prev := public.request_begin(p_request_id, 'reconcile_account');
  if v_prev is not null then return v_prev; end if;
  if coalesce(trim(p_note), '') = '' then perform public.fail('Напишите причину расхождения', 'reason'); end if;
  select coalesce(sum(amount), 0) into v_book from public.money_movements where account_id = p_account_id;
  if p_real <> v_book then
    insert into public.money_movements (occurred_at, account_id, amount, kind, note, created_by)
    values (now(), p_account_id, p_real - v_book, 'adjustment', p_note, v_owner);
  end if;
  return public.request_end(p_request_id, jsonb_build_object('diff', p_real - v_book));
end $$;

-- Inventory count. Opening count sets start quantities and prices; later counts post the difference.
create or replace function public.record_inventory(p_request_id uuid, p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_owner uuid := public.require_owner(); v_prev jsonb; v_count uuid; v_line jsonb; v_product public.products;
  v_opening boolean := coalesce((p->>'is_opening')::boolean, false); v_diff numeric; v_avg record; v_cost numeric;
  v_at timestamptz := coalesce(nullif(p->>'occurred_at', '')::timestamptz, now()); v_changes int := 0; s public.settings;
begin
  v_prev := public.request_begin(p_request_id, 'record_inventory');
  if v_prev is not null then return v_prev; end if;
  select * into s from public.settings;
  insert into public.inventory_counts (occurred_at, is_opening, note, created_by)
  values (v_at, v_opening, nullif(p->>'note', ''), v_owner) returning id into v_count;
  for v_line in select * from jsonb_array_elements(coalesce(p->'lines', '[]'::jsonb)) loop
    continue when nullif(v_line->>'counted', '') is null;
    select * into v_product from public.products where id = (v_line->>'product_id')::uuid;
    v_diff := (v_line->>'counted')::numeric - public.stock_qty(v_product.id);
    continue when v_diff = 0;
    if v_opening and v_diff > 0 then
      v_cost := coalesce(nullif(v_line->>'unit_cost', '')::numeric, v_product.ref_cost, 0);
      insert into public.stock_movements (occurred_at, product_id, qty, unit_cost, kind, inventory_count_id, cost_is_estimate, note, created_by)
      values (v_at, v_product.id, v_diff, v_cost, 'opening', v_count,
              nullif(v_line->>'unit_cost', '') is null or coalesce((v_line->>'is_estimate')::boolean, false),
              'Начальный остаток', v_owner);
      if v_product.id = s.helium_product_id and not exists (select 1 from public.helium_cylinders where ended_at is null) then
        insert into public.helium_cylinders (started_at, nominal_l, start_is_estimate, note)
        values (v_at, (v_line->>'counted')::numeric, true, 'Остаток на дату запуска — оценка без манометра');
      end if;
    else
      select * into v_avg from public.avg_cost(v_product.id);
      insert into public.stock_movements (occurred_at, product_id, qty, unit_cost, kind, inventory_count_id, cost_is_estimate, note, created_by)
      values (v_at, v_product.id, v_diff, v_avg.cost, 'adjustment', v_count, v_avg.is_estimate,
              case when v_diff < 0 then 'Недостача при пересчёте' else 'Излишек при пересчёте' end, v_owner);
    end if;
    v_changes := v_changes + 1;
  end loop;
  return public.request_end(p_request_id, jsonb_build_object('id', v_count, 'changes', v_changes));
end $$;
