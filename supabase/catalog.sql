-- NAYA BALLOONS — starting catalog: products, makers, helium norms with their source.
-- Norm sources: 'cheatsheet' = «Книга — расход гелия в шарах» (ОПТШАР.РФ, 1 порция = 14 л);
-- 'excel' = old calculator / spreadsheet; 'estimate' = owners' own estimate.
-- Safe to run once on an empty database.

insert into public.accounts (name, kind, sort) values
  ('Kaspi', 'kaspi', 1), ('Наличные', 'cash', 2), ('Депозит', 'deposit', 3), ('Другой', 'other', 4);

insert into public.expense_categories (name, class, sort) values
  ('Реклама', 'opex', 1), ('Instagram', 'opex', 2), ('TikTok', 'opex', 3), ('OLX', 'opex', 4),
  ('Доставка', 'opex', 5), ('Такси', 'opex', 6), ('Аренда', 'opex', 7), ('Комиссии', 'opex', 8),
  ('Связь', 'opex', 9), ('Ремонт', 'opex', 10), ('Прочее', 'opex', 11),
  ('Оборудование', 'equipment', 20), ('Налоги', 'tax', 30);

do $$
declare
  v_he uuid; v_rib uuid; p uuid; v uuid;
  -- digit norms, litres: Китай Slim 40″ (cheatsheet) and old calculator (Flexmetal 5500/шт.)
  d_china numeric[] := array[43.4, 29.4, 43.4, 37.8, 37.8, 36.4, 37.8, 33.6, 39.2, 37.8];
  d_excel numeric[] := array[50.5, 52.9, 68.8, 57.3, 58.5, 65.5, 63.2, 44.7, 65.5, 63.2];
  d_size text[] := array['66×85 см','40×85 см','56×87 см','55×85 см','88×87 см','53×85 см','60×90 см','60×90 см','58×90 см','60×90 см'];
  i int;
begin
  -- ---------------------------------------------------------- helium & materials
  insert into public.products (name, kind, category, unit, ref_cost, ref_cost_note, note)
  values ('Гелий', 'helium', 'Гелий', 'л', 26.67, '140 000 ₸ / 5 250 л ≈ 26,67 ₸/л',
          'Полная заправка баллона — 5 250 л. Цена заправки меняется: фактическая берётся из каждой заправки.')
  returning id into v_he;

  insert into public.products (name, kind, category, unit, ref_cost, ref_cost_note, wholesale_cost, note)
  values ('Лента', 'material', 'Материалы', 'м', 4, '800 ₸ за 200 м', null,
          'Расход ленты подставляется сам: норма в метрах на каждый шар.')
  returning id into v_rib;

  update public.settings set helium_product_id = v_he, ribbon_product_id = v_rib;

  insert into public.products (name, kind, category, unit, ref_cost, ref_cost_note, wholesale_cost, source) values
    ('Упаковка (пакет)', 'material', 'Материалы', 'шт.', 155, 'Покупка 09.11: 10 шт. по 155 ₸', 150, '{"sheet":"Товары","row":"M03"}'),
    ('Грузик', 'material', 'Материалы', 'шт.', 16, 'Цена из старой таблицы, не подтверждена', null,
       '{"sheet":"Товары","row":"M05","review":"Грузик: цена 16 ₸ из старой таблицы — проверьте"}'),
    ('Hi-Float / клей', 'material', 'Материалы', 'мл', 15, 'Цена из старой таблицы, не подтверждена', null,
       '{"sheet":"Товары","row":"M04","review":"Hi-Float: цена 15 ₸/мл из старой таблицы — проверьте"}'),
    ('Хлопушка', 'material', 'Материалы', 'шт.', null, null, null,
       '{"sheet":"Архив Excel","note":"встречается в старых заказах (хлп, хлоп)"}');

  -- ---------------------------------------------------------- balloons
  -- Фольга сердце 18″
  insert into public.products (name, kind, category, unit, ref_cost, ref_cost_note, wholesale_cost, ribbon_m_per_unit, source)
  values ('Фольга сердце 18″', 'balloon', 'Фольга', 'шт.', 75, 'Покупка 09.11: 50 шт. по 75 ₸', null, 1, '{"sheet":"Товары","row":"P003"}')
  returning id into p;
  insert into public.variants (product_id, maker, pack_size, real_size, is_default) values (p, 'Китай', '18″', '≈36 см', true) returning id into v;
  insert into public.helium_norms (variant_id, helium_l, source, note) values
    (v, 13.8, 'estimate', 'Отмечено «подтверждено» в старой таблице'),
    (v, 11.2, 'cheatsheet', 'Шпаргалка: сердце 18″ Китай — 0,8 порции');
  insert into public.variants (product_id, maker, pack_size, real_size) values (p, 'Flexmetal', '18″', '39 см') returning id into v;
  insert into public.helium_norms (variant_id, helium_l, source, note) values (v, 14, 'cheatsheet', 'Шпаргалка: 1 порция');
  insert into public.variants (product_id, maker, pack_size, real_size) values (p, 'Agura', '18″', '39 см') returning id into v;
  insert into public.helium_norms (variant_id, helium_l, source, note) values (v, 14, 'cheatsheet', 'Шпаргалка: 1 порция');
  insert into public.variants (product_id, maker, pack_size, real_size) values (p, 'Anagram', '18″', '35 см') returning id into v;
  insert into public.helium_norms (variant_id, helium_l, source, note) values (v, 11.2, 'cheatsheet', 'Шпаргалка: 0,8 порции');
  insert into public.variants (product_id, maker, is_unknown) values (p, 'Другой / неизвестен', true);

  -- Фольга звезда 18″
  insert into public.products (name, kind, category, unit, ref_cost, ref_cost_note, ribbon_m_per_unit, source)
  values ('Фольга звезда 18″', 'balloon', 'Фольга', 'шт.', 90, 'Цена из старой таблицы', 1, '{"sheet":"Товары","row":"P004"}')
  returning id into p;
  insert into public.variants (product_id, maker, pack_size, real_size, is_default) values (p, 'Китай', '18″', '42 см', true) returning id into v;
  insert into public.helium_norms (variant_id, helium_l, source, note) values (v, 11.2, 'cheatsheet', 'Шпаргалка: звезда 18″ Китай — 0,8 порции');
  insert into public.variants (product_id, maker, pack_size, real_size) values (p, 'Flexmetal', '18″', '37×37 см') returning id into v;
  insert into public.helium_norms (variant_id, helium_l, source, note) values
    (v, 12.6, 'cheatsheet', 'Шпаргалка: 0,9 порции'),
    (v, 14.95, 'excel', 'Старый калькулятор: 5 500 л / 368 шт.');
  insert into public.variants (product_id, maker, is_unknown) values (p, 'Другой / неизвестен', true);

  -- Латекс 12″
  insert into public.products (name, kind, category, unit, ref_cost, ref_cost_note, ribbon_m_per_unit, source)
  values ('Латекс 12″', 'balloon', 'Латекс', 'шт.', 30, 'Цена из старой таблицы', 1, '{"sheet":"Товары","row":"P001"}')
  returning id into p;
  insert into public.variants (product_id, maker, pack_size, real_size, is_default) values (p, 'Китай', '12″', '30 см', true) returning id into v;
  insert into public.helium_norms (variant_id, helium_l, source, note) values
    (v, 14, 'cheatsheet', 'Шпаргалка: 12″/30 см — 1 порция'),
    (v, 12, 'excel', 'Старый калькулятор');
  insert into public.variants (product_id, maker, is_unknown) values (p, 'Другой / неизвестен', true);

  -- Хромовый шар (латекс 12″ хром)
  insert into public.products (name, kind, category, unit, ref_cost, ref_cost_note, ribbon_m_per_unit, source)
  values ('Хромовый шар 12″', 'balloon', 'Латекс', 'шт.', 50, 'Цена из старой таблицы', 1, '{"sheet":"Товары","row":"M07"}')
  returning id into p;
  insert into public.variants (product_id, maker, pack_size, is_default) values (p, 'Китай', '12″', true) returning id into v;
  insert into public.helium_norms (variant_id, helium_l, source, note) values
    (v, 14, 'cheatsheet', 'Шпаргалка: латекс 12″ хром — 1 порция');
  insert into public.variants (product_id, maker, is_unknown) values (p, 'Другой / неизвестен', true);

  -- Bubble (BOBO) — sizes on the pack differ from real inflated sizes
  insert into public.products (name, kind, category, unit, ref_cost, ref_cost_note, ribbon_m_per_unit, source)
  values ('Bubble 20″', 'balloon', 'Bubble', 'шт.', 200, 'Цена из старой таблицы', 1,
          '{"sheet":"Товары","row":"P005","review":"Bubble 20″: в старой таблице 68,7 л — больше, чем у Bubble 36″. Укажите свой расход"}')
  returning id into p;
  insert into public.variants (product_id, maker, is_unknown, is_default) values (p, 'Другой / неизвестен', true, true) returning id into v;
  insert into public.helium_norms (variant_id, helium_l, source, note) values (v, 68.7, 'excel', 'Старый калькулятор, вероятно ошибка');
  insert into public.variants (product_id, maker, pack_size, real_size) values (p, 'Qualatex Deco', '20″', '38 см') returning id into v;
  insert into public.helium_norms (variant_id, helium_l, source, note) values (v, 19.6, 'cheatsheet', 'Шпаргалка: 1,4 порции');

  insert into public.products (name, kind, category, unit, ref_cost, ref_cost_note, ribbon_m_per_unit, source)
  values ('Bubble 24″', 'balloon', 'Bubble', 'шт.', 250, 'Цена из старой таблицы', 1,
          '{"sheet":"Товары","row":"P006","review":"Bubble 24″: в старой таблице 118,5 л, по шпаргалке BOBO 24″ — 52–84 л в зависимости от размера. Укажите свой расход"}')
  returning id into p;
  insert into public.variants (product_id, maker, is_unknown, is_default) values (p, 'Другой / неизвестен', true, true) returning id into v;
  insert into public.helium_norms (variant_id, helium_l, source, note) values (v, 118.5, 'excel', 'Старый калькулятор');
  insert into public.variants (product_id, maker, pack_size, real_size) values (p, 'BOBO', '24″', '45 см') returning id into v;
  insert into public.helium_norms (variant_id, helium_l, source, note) values (v, 51.8, 'cheatsheet', 'Шпаргалка: 3,7 порции');
  insert into public.variants (product_id, maker, pack_size, real_size) values (p, 'BOBO', '24″', '50 см') returning id into v;
  insert into public.helium_norms (variant_id, helium_l, source, note) values (v, 56, 'cheatsheet', 'Шпаргалка: 4 порции');
  insert into public.variants (product_id, maker, pack_size, real_size) values (p, 'BOBO', '24″', '55 см') returning id into v;
  insert into public.helium_norms (variant_id, helium_l, source, note) values (v, 84, 'cheatsheet', 'Шпаргалка: 6 порций');

  insert into public.products (name, kind, category, unit, ref_cost, ref_cost_note, ribbon_m_per_unit, source)
  values ('Bubble 36″', 'balloon', 'Bubble', 'шт.', 440, 'Цена из старой таблицы', 1.5,
          '{"sheet":"Товары","row":"P002","review":"Bubble 36″: в старой таблице 33 л — это строка «Обычный шар 18″», перенесённая по ошибке. Взята норма из шпаргалки"}')
  returning id into p;
  insert into public.variants (product_id, maker, pack_size, real_size, is_default) values (p, 'BOBO', '36″', '78 см', true) returning id into v;
  insert into public.helium_norms (variant_id, helium_l, total_l, helium_share, is_mix, source, note)
  values (v, 151.2, 252, 0.6, true, 'cheatsheet', 'Шпаргалка: 18 порций = 252 л, смесь 60% гелия');
  insert into public.variants (product_id, maker, pack_size, real_size) values (p, 'BOBO', '36″', '69 см') returning id into v;
  insert into public.helium_norms (variant_id, helium_l, total_l, helium_share, is_mix, source, note)
  values (v, 123.2, 154, 0.8, true, 'cheatsheet', 'Шпаргалка: 11 порций = 154 л, смесь 80% гелия');
  insert into public.variants (product_id, maker, is_unknown) values (p, 'Другой / неизвестен', true);

  -- Giant foil balloons: filled with a helium/air mix by eye until they fly
  insert into public.products (name, kind, category, unit, ref_cost, ref_cost_note, wholesale_cost, ribbon_m_per_unit, source)
  values ('Гигант 90 см', 'balloon', 'Фольга', 'шт.', 1250, 'Ближайший магазин; оптом ≈600 ₸', 600, 1.5,
          '{"sheet":"Товары","row":"P007"}')
  returning id into p;
  insert into public.variants (product_id, maker, real_size, is_default) values (p, 'Китай', '90 см', true) returning id into v;
  insert into public.helium_norms (variant_id, helium_l, is_mix, source, note) values
    (v, 60, true, 'estimate', 'Смесь на глаз. Оценка по прошлым заказам: ≈50–60 л'),
    (v, 90.7, false, 'excel', 'Старая таблица');
  insert into public.variants (product_id, maker, is_unknown) values (p, 'Другой / неизвестен', true);

  insert into public.products (name, kind, category, unit, ref_cost, ref_cost_note, ribbon_m_per_unit, source)
  values ('Гигант 163 см', 'balloon', 'Фольга', 'шт.', 1000, 'Цена из старой таблицы, не подтверждена', 1.5,
          '{"sheet":"Товары","row":"P008","review":"Гигант 163 см: цена 1 000 ₸ из старой таблицы — проверьте"}')
  returning id into p;
  insert into public.variants (product_id, maker, real_size, is_default) values (p, 'Китай', '163 см', true) returning id into v;
  insert into public.helium_norms (variant_id, helium_l, is_mix, source, note) values
    (v, 110, true, 'estimate', 'Смесь на глаз. Оценка по заказу от 20.10: ≈105 л');
  insert into public.variants (product_id, maker, is_unknown) values (p, 'Другой / неизвестен', true);

  -- Digits 0–9, 40″
  for i in 0..9 loop
    insert into public.products (name, kind, category, unit, ref_cost, ref_cost_note, ribbon_m_per_unit, source)
    values ('Цифра ' || i || ' (40″)', 'balloon', 'Цифры', 'шт.', 250, 'Цена из старой таблицы', 1,
            jsonb_build_object('sheet', 'Товары', 'row', 'P0' || lpad((9 + i)::text, 2, '0')))
    returning id into p;
    insert into public.variants (product_id, maker, pack_size, real_size, is_default)
    values (p, 'Китай Slim', '40″', '85–86 см', true) returning id into v;
    insert into public.helium_norms (variant_id, helium_l, source, note)
    values (v, d_china[i + 1], 'cheatsheet', 'Шпаргалка: цифры Китай Slim 40″');
    insert into public.variants (product_id, maker, pack_size, real_size)
    values (p, 'Flexmetal', '40″', d_size[i + 1]) returning id into v;
    insert into public.helium_norms (variant_id, helium_l, source, note)
    values (v, d_excel[i + 1], 'excel', 'Старый калькулятор: 5 500 л / кол-во шаров');
    insert into public.variants (product_id, maker, is_unknown) values (p, 'Другой / неизвестен', true);
  end loop;
end $$;

-- ---------------------------------------------------------- templates
do $$
declare t uuid;
  heart uuid := (select id from public.products where name = 'Фольга сердце 18″');
  giant uuid := (select id from public.products where name = 'Гигант 90 см');
  pack uuid := (select id from public.products where name = 'Упаковка (пакет)');
begin
  insert into public.templates (name, service_label, service_estimate, sort, source)
  values ('6 сердец + гигант 90 + надпись', 'Надпись', 500, 1, '{"sheet":"Композиции","row":"C001"}') returning id into t;
  insert into public.template_lines (template_id, product_id, qty, sort) values (t, heart, 6, 1), (t, giant, 1, 2), (t, pack, 1, 3);

  insert into public.templates (name, sort, source) values ('6 сердечек', 2, '{"sheet":"Композиции","row":"C002"}') returning id into t;
  insert into public.template_lines (template_id, product_id, qty, sort) values (t, heart, 6, 1), (t, pack, 1, 2);

  insert into public.templates (name, sort, source) values ('10 красных сердец', 3, '{"sheet":"Композиции","row":"C003"}') returning id into t;
  insert into public.template_lines (template_id, product_id, qty, sort) values (t, heart, 10, 1), (t, pack, 1, 2);

  insert into public.templates (name, sort, source) values ('Цифры 1 и 8', 4, '{"sheet":"Композиции","row":"C004"}') returning id into t;
  insert into public.template_lines (template_id, product_id, qty, sort) values
    (t, (select id from public.products where name = 'Цифра 1 (40″)'), 1, 1),
    (t, (select id from public.products where name = 'Цифра 8 (40″)'), 1, 2);

  insert into public.templates (name, sort, source) values ('15 хромовых шаров', 5, '{"sheet":"Композиции","row":"C005"}') returning id into t;
  insert into public.template_lines (template_id, product_id, qty, sort) values
    (t, (select id from public.products where name = 'Хромовый шар 12″'), 15, 1);
end $$;
