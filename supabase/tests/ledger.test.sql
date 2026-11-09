begin;
create extension if not exists pgtap with schema extensions;
select plan(43);

-- act as Назарбек
insert into auth.users (id, email, aud, role, instance_id)
values ('11111111-1111-1111-1111-111111111111', 'nazarbek@example.test', 'authenticated', 'authenticated', '00000000-0000-0000-0000-000000000000');


create temp table ids (k text primary key, v uuid) on commit drop;
insert into ids select 'kaspi', id from public.accounts where name = 'Kaspi';
insert into ids select 'cash', id from public.accounts where name = 'Наличные';
insert into ids select 'heart', id from public.products where name = 'Фольга сердце 18″';
insert into ids select 'giant', id from public.products where name = 'Гигант 90 см';
insert into ids select 'pack', id from public.products where name = 'Упаковка (пакет)';
insert into ids select 'helium', id from public.products where name = 'Гелий';
insert into ids select 'ribbon', id from public.products where name = 'Лента';
insert into ids select 'nazarbek', id from public.owners where name = 'Назарбек';
insert into ids select 'ayanat', id from public.owners where name = 'Аянат';
create function pg_temp.id(k text) returns uuid language sql as $$ select v from ids where ids.k = $1 $$;
grant select, insert on ids to authenticated;
set local role authenticated;
set local request.jwt.claims = '{"sub":"11111111-1111-1111-1111-111111111111","role":"authenticated"}';
select ok(public.is_owner(), 'owner linked by e-mail');

-- ---------------------------------------------------------------- start: money and stock
select lives_ok($$ select public.set_opening_money(gen_random_uuid(), now() - interval '1 hour',
  jsonb_build_object(pg_temp.id('kaspi'), 26446, pg_temp.id('cash'), 41000)) $$, 'opening money');
select is((select sum(balance) from public.v_balances), 67446::numeric, 'all money 67 446');

select lives_ok($$ select public.record_inventory(gen_random_uuid(), jsonb_build_object('is_opening', true, 'lines', jsonb_build_array(
  jsonb_build_object('product_id', pg_temp.id('heart'), 'counted', 44, 'unit_cost', 75),
  jsonb_build_object('product_id', pg_temp.id('pack'), 'counted', 9, 'unit_cost', 155),
  jsonb_build_object('product_id', pg_temp.id('helium'), 'counted', 5250, 'unit_cost', 26.6667),
  jsonb_build_object('product_id', pg_temp.id('ribbon'), 'counted', 200, 'unit_cost', 4)))) $$, 'opening inventory');
select is(public.stock_qty(pg_temp.id('helium')), 5250::numeric, 'helium 5 250 л');
select is((select count(*)::int from public.helium_cylinders where start_is_estimate), 1, 'cylinder start marked as estimate');

-- ---------------------------------------------------------------- order with prepayment (Аянат's path)
select lives_ok($$
  select public.save_order('aaaaaaaa-0000-0000-0000-000000000001', jsonb_build_object(
    'title', '6 сердец + гигант 90', 'client_name', 'Айгерим', 'due_at', now() + interval '1 day',
    'price', 18000, 'service_label', 'Надпись', 'service_estimate', 500,
    'lines', jsonb_build_array(
      jsonb_build_object('product_id', pg_temp.id('heart'), 'qty', 6),
      jsonb_build_object('product_id', pg_temp.id('giant'), 'qty', 1),
      jsonb_build_object('product_id', pg_temp.id('pack'), 'qty', 1)),
    'prepayment', jsonb_build_object('amount', 5000, 'account_id', pg_temp.id('cash'))))
$$, 'create order with prepayment');
insert into ids select 'o1', id from public.orders where title = '6 сердец + гигант 90';

select is((select due from public.v_orders where id = pg_temp.id('o1')), 13000::numeric, 'left to pay 13 000');
select is((select payment_status from public.v_orders where id = pg_temp.id('o1')), 'partial', 'status: prepayment');
select is((select helium_l_per_unit from public.order_lines where order_id = pg_temp.id('o1') and product_id = pg_temp.id('giant')), 60.00, 'giant gets the default estimate norm');
select is((select helium_source from public.order_lines where order_id = pg_temp.id('o1') and product_id = pg_temp.id('heart')), 'estimate', 'heart norm: owners estimate beats cheatsheet');
select is((select ribbon_m from public.order_lines where order_id = pg_temp.id('o1') and product_id = pg_temp.id('giant')), 1.5, 'ribbon norm filled in');
select is((select balance from public.v_balances where account_id = pg_temp.id('cash')), 46000::numeric, 'prepayment changes money at once');
select is((select coalesce(sum(amount), 0) from public.v_revenue_items), 0::numeric, 'prepayment is not revenue');

-- repeat of the same request returns the first result and creates nothing new
select is(public.save_order('aaaaaaaa-0000-0000-0000-000000000001', '{"title":"x","lines":[]}')->>'id', pg_temp.id('o1')::text, 'retry returns first result');
select is((select count(*)::int from public.money_movements where order_id = pg_temp.id('o1')), 1, 'retry did not double the prepayment');

-- reservation: 6 hearts reserved, still 44 physical
select is((select physical from public.v_stock where product_id = pg_temp.id('heart')), 44::numeric, 'physical hearts');
select is((select available from public.v_stock where product_id = pg_temp.id('heart')), 38::numeric, 'available hearts after reservation');

-- giant is missing → attention + purchase for this order at shop price
select ok(public.attention()::text like '%Не хватает «Гигант 90 см»%', 'shortage shown in attention list');
select lives_ok($$ select public.record_purchase(gen_random_uuid(), jsonb_build_object('account_id', pg_temp.id('kaspi'), 'supplier', 'Магазин рядом',
  'lines', jsonb_build_array(jsonb_build_object('product_id', pg_temp.id('giant'), 'qty', 1, 'amount', 1250, 'order_id', pg_temp.id('o1'))))) $$, 'buy giant for the order');
select ok(public.attention()::text not like '%Не хватает «Гигант 90 см»%', 'shortage gone');

-- low price needs explicit confirmation
select throws_ok($$ select public.save_order(gen_random_uuid(), jsonb_build_object('id', pg_temp.id('o1'), 'version', 1,
  'title', '6 сердец + гигант 90', 'price', 5000, 'lines', jsonb_build_array(jsonb_build_object('product_id', pg_temp.id('heart'), 'qty', 6),
  jsonb_build_object('product_id', pg_temp.id('giant'), 'qty', 1)))) $$, 'P0001', null, 'low price blocked without confirmation');

-- stale version from the other device is refused
select throws_ok($$ select public.save_order(gen_random_uuid(), jsonb_build_object('id', pg_temp.id('o1'), 'version', 99,
  'title', 'x', 'price', 18000, 'lines', jsonb_build_array(jsonb_build_object('product_id', pg_temp.id('heart'), 'qty', 6)))) $$,
  'P0001', 'Этот заказ только что изменили на другом устройстве. Обновите страницу и проверьте изменения', 'concurrent edit detected');

-- print for this order: only in this order's cost
select lives_ok($$ select public.add_order_cost(gen_random_uuid(), jsonb_build_object('order_id', pg_temp.id('o1'), 'label', 'Надпись',
  'amount', 500, 'account_id', pg_temp.id('kaspi'), 'supplier', 'ukasha print')) $$, 'print recorded from the order');

-- ---------------------------------------------------------------- issue: double tap
select lives_ok($$ select public.issue_order('bbbbbbbb-0000-0000-0000-000000000001', pg_temp.id('o1'), 13000, pg_temp.id('kaspi')) $$, 'issue with final payment');
select lives_ok($$ select public.issue_order('bbbbbbbb-0000-0000-0000-000000000002', pg_temp.id('o1'), 13000, pg_temp.id('kaspi')) $$, 'second tap (new request id)');
select is((select count(*)::int from public.stock_movements where order_id = pg_temp.id('o1') and kind = 'order_use'), 5, 'written off once: heart, giant, pack, helium, ribbon');
select is((select payment_status from public.v_orders where id = pg_temp.id('o1')), 'paid', 'fully paid, payment not doubled');

-- cost: hearts 6×75 + giant 1250 (bought for it) + pack 155 + helium (6×13.8+60)×26.6667 + ribbon (6+1.5)×4 + print 500
select is(round(public.order_actual_cost(pg_temp.id('o1')), 0),
          round(6*75 + 1250 + 155 + (6*13.8 + 60) * 26.6667 + 7.5*4 + 500, 0), 'actual cost uses real purchase prices');
select is(public.stock_qty(pg_temp.id('giant')), 0::numeric, 'giant bought for the order is consumed');

-- ---------------------------------------------------------------- expenses and money
select lives_ok($$ select public.record_expense(gen_random_uuid(), jsonb_build_object('class', 'opex', 'category', 'Такси',
  'amount', 1400, 'account_id', pg_temp.id('kaspi'))) $$, 'taxi');
select lives_ok($$ select public.record_expense(gen_random_uuid(), jsonb_build_object('class', 'personal',
  'description', 'общая личная трата', 'amount', 5620, 'account_id', pg_temp.id('kaspi'))) $$, 'shared personal spending');
select is((select sum(amount) from public.owner_flows where kind = 'personal'), 5620::numeric, 'personal split between owners');
select is((select amount from public.owner_flows where kind = 'personal' and owner_id = pg_temp.id('ayanat')), 2810::numeric, 'Аянат 50%');

select lives_ok($$ select public.record_transfer(gen_random_uuid(), pg_temp.id('kaspi'), pg_temp.id('cash'), 6000) $$, 'transfer');
select is((select sum(balance) from public.v_balances),
          67446 + 5000 + 13000 - 1250 - 500 - 1400 - 5620::numeric, 'transfer keeps total money');

-- report: revenue 18 000, opex 1 400 only (print is in cost, personal is not an expense)
select is((public.report_summary(current_date - 1, current_date + 1)->>'revenue')::numeric, 18000::numeric, 'revenue on issue');
select is((public.report_summary(current_date - 1, current_date + 1)->>'opex')::numeric, 1400::numeric, 'opex excludes print and personal');

-- ---------------------------------------------------------------- cancel after prepayment
select lives_ok($$ select public.save_order(gen_random_uuid(), jsonb_build_object('title', '10 сердец', 'price', 10000,
  'lines', jsonb_build_array(jsonb_build_object('product_id', pg_temp.id('heart'), 'qty', 10)),
  'prepayment', jsonb_build_object('amount', 3000, 'account_id', pg_temp.id('kaspi')))) $$, 'second order');
select lives_ok($$ select public.cancel_order(gen_random_uuid(), (select id from public.orders where title = '10 сердец'), 2000, pg_temp.id('kaspi'), 'клиент передумал') $$, 'cancel with partial refund');
select is((select cancel_revenue from public.orders where title = '10 сердец'), 1000::numeric, 'kept 1 000 is revenue');
select is((select available from public.v_stock where product_id = pg_temp.id('heart')), 38::numeric, 'cancelled order releases reservation');

-- ---------------------------------------------------------------- payout
select is((public.payout_summary()->>'draws')::numeric, 5620::numeric, 'personal spending counts as received by owners');

select * from finish();
rollback;
