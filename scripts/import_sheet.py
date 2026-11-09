# /// script
# requires-python = ">=3.11"
# dependencies = ["openpyxl>=3.1"]
# ///
"""
Builds private/import.sql from the NAYA BALLOONS spreadsheet.

The generated SQL contains real business data, so it is written to private/ (git-ignored).
It loads: owners, launch date, opening money, historical orders with their cost breakdown,
historical expenses and owner-confirmed corrections. Every record keeps a link to its source
row. The SQL ends with a reconciliation block that aborts the whole import if a control total
does not match.

Usage:
  uv run scripts/import_sheet.py --xlsx "path/to/file.xlsx" \
      --owner "Назарбек=<email>" --owner "Аянат=<email>" \
      --launch 2026-11-10 --opening "Kaspi=26446" --opening "Наличные=41000"
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
import pathlib
import re
from collections import defaultdict

import openpyxl

# Control totals of the original Excel history (checked before and after import).
HIST_ORDERS = 11
HIST_REVENUE = 152_640
HIST_MATERIALS = 67_279
HIST_OTHER = 500

# Owner-confirmed corrections (conversation of 09.11.2026).
AIRPORT_SALE = "NAYA-416b3af5-de9"
PERSONAL_EXPENSES = {"NAYA-49b423d3-f79", "NAYA-3157670a-19b"}  # "dr" 5 023 and "Прочее" 597: shared personal
RIBBON_PRICE = 4  # 800 ₸ / 200 m


def lit(v) -> str:
    if v is None:
        return "null"
    if isinstance(v, bool):
        return "true" if v else "false"
    if isinstance(v, (int, float)):
        return repr(round(float(v), 4))
    if isinstance(v, (dict, list)):
        return "'" + json.dumps(v, ensure_ascii=False).replace("'", "''") + "'::jsonb"
    return "'" + str(v).replace("'", "''") + "'"


def ts(d: dt.datetime | dt.date) -> str:
    if isinstance(d, dt.datetime):
        return lit(d.strftime("%Y-%m-%d %H:%M:%S") + "+05")
    return lit(d.strftime("%Y-%m-%d") + " 12:00:00+05")


def sheet_rows(wb, name: str, header_row: int = 5):
    ws = wb[name]
    header = [c.value for c in ws[header_row]]
    for r in ws.iter_rows(min_row=header_row + 1, values_only=True):
        if r[0] in (None, ""):
            continue
        yield dict(zip(header, r))


def archive_orders(wb):
    """Original Excel 'Заказы' sheet, preserved cell by cell in 'Архив Excel'."""
    cells: dict[int, dict[str, object]] = defaultdict(dict)
    for r in wb["Архив Excel"].iter_rows(min_row=6, values_only=True):
        f, s, c, v = r[:4]
        if s != "Заказы" or not f or "учет_прибыли" not in str(f):
            continue
        m = re.match(r"([A-Z]+)(\d+)", str(c))
        cells[int(m.group(2))][m.group(1)] = v
    out = []
    for row in sorted(cells):
        c = cells[row]
        if row == 1 or c.get("B") in (None, ""):
            continue
        num = lambda k: float(c.get(k) or 0)
        out.append({
            "row": row,
            "date": dt.datetime.fromisoformat(str(c["A"])).date(),
            "title": str(c["B"]).strip(),
            "revenue": num("C"),
            "parts": [("Шары", num("D")), ("Надпись", num("E")), ("Гелий", num("F")),
                      ("Лента / крепления", num("G")), ("Упаковка", num("H")), ("Доставка / такси", num("I"))],
            "other": num("J"),
        })
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--xlsx", required=True)
    ap.add_argument("--owner", action="append", required=True, help="Имя=email")
    ap.add_argument("--launch", required=True, help="YYYY-MM-DD")
    ap.add_argument("--opening", action="append", default=[], help="Счёт=сумма")
    ap.add_argument("--out", default="private/import.sql")
    a = ap.parse_args()

    wb = openpyxl.load_workbook(a.xlsx, data_only=True)
    launch = dt.date.fromisoformat(a.launch)
    sql: list[str] = ["begin;", "set local naya.reason = 'Перенос из Google Sheets';"]

    # ---------------------------------------------------------------- owners & settings
    for o in a.owner:
        name, email = o.split("=", 1)
        sql.append(f"insert into public.owners (email, name, share) values ({lit(email.strip().lower())}, {lit(name.strip())}, 0.5) "
                   "on conflict (email) do update set name = excluded.name;")
    sql.append("delete from public.owners where email like '%@example.test';")
    sql.append(f"update public.settings set launch_date = {lit(a.launch)}, default_coef = 2.4, min_coef = 2.0, helium_plan_price = 27;")

    # ---------------------------------------------------------------- opening money
    for o in a.opening:
        acc, amount = o.split("=", 1)
        sql.append(
            "insert into public.money_movements (occurred_at, account_id, amount, kind, note) "
            f"select {lit(a.launch + ' 00:00:00+05')}, id, {float(amount)}, 'opening', 'Остаток на дату запуска (по данным владельцев)' "
            f"from public.accounts where name = {lit(acc.strip())};")

    # ---------------------------------------------------------------- historical orders (original Excel)
    hist = archive_orders(wb)
    rev = sum(h["revenue"] for h in hist)
    mat = sum(sum(v for _, v in h["parts"]) for h in hist)
    oth = sum(h["other"] for h in hist)
    assert (len(hist), rev, mat, oth) == (HIST_ORDERS, HIST_REVENUE, HIST_MATERIALS, HIST_OTHER), (len(hist), rev, mat, oth)

    for i, h in enumerate(hist, 1):
        hid = f"HIST-{i:03d}"
        src = {"sheet": "Excel «Учёт прибыли» → Заказы", "row": f"строка {h['row']}", "id": hid}
        if hid in ("HIST-006", "HIST-007"):
            src["review"] = (f"Заказ «{h['title']}» от {h['date']:%d.%m}: в Excel два одинаковых заказа "
                             "(10 сердец, 10 000 ₸) и даты идут не по порядку — проверьте, что это разные заказы")
        sql.append(
            "with o as (insert into public.orders (title, price, status, issued_at, is_historical, payment_known, source) "
            f"values ({lit(h['title'])}, {h['revenue']}, 'issued', {ts(h['date'])}, true, false, {lit(src)}) returning id) "
            "insert into public.order_costs (order_id, kind, label, amount, occurred_at, source) values "
            + ", ".join(f"((select id from o), 'history', {lit(label)}, {v}, {ts(h['date'])}, {lit(src)})" for label, v in h["parts"] if v)
            + ";")
        if h["other"]:
            sql.append(
                "insert into public.expenses (occurred_at, class, category, description, amount, is_historical, source) values "
                f"({ts(h['date'])}, 'opex', 'Прочее', {lit('Реклама / прочее из заказа ' + h['title'])}, {h['other']}, true, "
                f"{lit({**src, 'review': 'Расход 500 ₸ «Реклама/прочее» из старого заказа — уточните, что это было'})});")

    # ---------------------------------------------------------------- sales entered in Google Sheets before launch
    moves = defaultdict(list)
    for m in sheet_rows(wb, "Движения склада"):
        if m["Тип"] == "Продажа":
            moves[m["ID источника"]].append(m)
    gs_sales = [s for s in sheet_rows(wb, "Продажи") if s.get("Источник") == "Новая продажа"]
    gs_revenue = 0.0
    for s in gs_sales:
        sid = s["ID продажи"]
        d = s["Дата"]
        gs_revenue += float(s["Выручка, ₸"])
        parts: list[tuple[str, float, dict]] = []
        for m in moves[sid]:
            label = f"{m['Название на дату']}: {abs(float(m['Количество +/−'])):g} × {float(m['Стоимость ед. на дату, ₸']):.2f} ₸"
            parts.append((label, -float(m["Стоимость +/−, ₸"]), {"sheet": "Движения склада", "id": m["ID движения"]}))
        review = (f"Дата {d:%d.%m} введена в таблицу вручную и может быть неточной. "
                  f"Оплата {float(s['Выручка, ₸']):,.0f} ₸".replace(',', ' ') + f" ({s.get('Способ оплаты') or 'счёт не указан'}) уже входит в остатки на дату запуска")
        if sid == AIRPORT_SALE:
            fixed = []
            for label, amount, src in parts:
                if label.startswith("Гигант 90"):
                    fixed.append(("Гигант 90 см: куплен для заказа в магазине", 1250.0, {**src, "fix": "600 → 1 250 по словам владельца"}))
                elif label.startswith("Упаковка"):
                    fixed.append(("Упаковка: 1 × 155 ₸ (покупка 09.11)", 155.0, {**src, "fix": "150 → 155 по покупке"}))
                elif label.startswith("Лента"):
                    meters = amount / 20
                    fixed.append((f"Лента: {meters:g} м × {RIBBON_PRICE} ₸", meters * RIBBON_PRICE,
                                  {**src, "fix": "цена 20 → 4 ₸/м (800 ₸ за 200 м)"}))
                elif label.startswith("Надпись"):
                    continue  # replaced by the two real print payments below
                else:
                    fixed.append((label, amount, src))
            fixed.append(("Надпись (sharland)", 500.0, {"sheet": "Закупки", "id": "NAYA-e6a4ec79-c8e"}))
            fixed.append(("Надпись повторно — сделали по ошибке (ukasha print)", 800.0, {"sheet": "Закупки", "id": "NAYA-cc9728d6-702", "mistake": True}))
            parts = fixed
            review += ". Себестоимость исправлена по словам владельцев: гигант 1 250 ₸, две надписи 500 + 800 ₸. Проверьте, сколько метров ленты ушло (в таблице 50 м)"
        src = {"sheet": "Продажи", "id": sid, "review": review}
        values = []
        for label, amount, psrc in parts:
            mistake = bool(psrc.get("mistake"))
            kind = "service" if label.startswith("Надпись") else "history"
            values.append(f"((select id from o), {lit(kind)}, {lit(label)}, {round(amount, 2)}, {lit(mistake)}, {ts(d)}, {lit(psrc)})")
        sql.append(
            "with o as (insert into public.orders (title, client_name, price, status, issued_at, is_historical, payment_known, date_uncertain, source) "
            f"values ({lit(s['Название на дату продажи'])}, {lit(s.get('Клиент / контакт'))}, {float(s['Выручка, ₸'])}, 'issued', {ts(d)}, true, false, true, {lit(src)}) returning id) "
            "insert into public.order_costs (order_id, kind, label, amount, is_mistake, occurred_at, source) values " + ", ".join(values) + ";")

    # ---------------------------------------------------------------- expenses entered before launch
    for e in sheet_rows(wb, "Расходы"):
        eid = e["ID расхода"]
        src = {"sheet": "Расходы", "id": eid}
        if eid in PERSONAL_EXPENSES:
            desc = (e.get("Описание") or e["Категория"])
            sql.append(
                "with x as (insert into public.expenses (occurred_at, class, category, description, amount, is_historical, source) "
                f"values ({ts(e['Дата'])}, 'personal', null, {lit(f'Общая личная трата: {desc}')}, {float(e['Сумма, ₸'])}, true, {lit(src)}) returning id) "
                "insert into public.owner_flows (occurred_at, owner_id, kind, amount, expense_id, note, is_historical) "
                f"select {ts(e['Дата'])}, w.id, 'personal', round({float(e['Сумма, ₸'])} * w.share, 2), x.id, 'До запуска учёта: не учитывается в расчёте 50/50', true "
                "from x, public.owners w;")
        else:
            review = None
            if e["Категория"] == "Упаковка":
                review = "Трата 14 ₸ «Упаковка» — проверьте, не входит ли она уже в себестоимость заказов"
            sql.append(
                "insert into public.expenses (occurred_at, class, category, description, amount, is_historical, source) values "
                f"({ts(e['Дата'])}, 'opex', {lit(e['Категория'])}, {lit(e.get('Описание'))}, {float(e['Сумма, ₸'])}, true, "
                f"{lit({**src, **({'review': review} if review else {})})});")

    # ---------------------------------------------------------------- purchases before launch (reference only: stock comes from the launch count)
    for pch in sheet_rows(wb, "Закупки"):
        sql.append(
            "insert into public.purchases (occurred_at, supplier, total, note, is_historical, source) values "
            f"({ts(pch['Дата'])}, {lit(pch['Поставщик'])}, {float(pch['Сумма, ₸'])}, "
            f"{lit(f'{pch['Название на дату']}: {float(pch['Количество']):g} × {float(pch['Цена за единицу, ₸']):g} ₸. До запуска: склад задаётся пересчётом, деньги — остатками')}, "
            f"true, {lit({'sheet': 'Закупки', 'id': pch['ID закупки']})});")

    # ---------------------------------------------------------------- reconciliation (aborts the import on mismatch)
    opening_total = sum(float(o.split("=", 1)[1]) for o in a.opening)
    sql.append(f"""
do $$
declare r record; bad text := '';
begin
  for r in
    select 'Исторических заказов из Excel' as what, {HIST_ORDERS}::numeric as expected,
           (select count(*) from public.orders where source->>'id' like 'HIST-%')::numeric as actual
    union all select 'Выручка Excel', {HIST_REVENUE}, (select sum(price) from public.orders where source->>'id' like 'HIST-%')
    union all select 'Материалы Excel', {HIST_MATERIALS}, (select sum(c.amount) from public.order_costs c join public.orders o on o.id = c.order_id where o.source->>'id' like 'HIST-%')
    union all select 'Прочие расходы Excel', {HIST_OTHER}, (select sum(amount) from public.expenses where source->>'id' like 'HIST-%')
    union all select 'Выручка из Google Sheets', {gs_revenue}, (select sum(price) from public.orders where source->>'sheet' = 'Продажи')
    union all select 'Выручка за всё время', {HIST_REVENUE + gs_revenue}, (select sum(amount) from public.v_revenue_items)
    union all select 'Деньги на дату запуска', {opening_total}, (select coalesce(sum(amount), 0) from public.money_movements)
    union all select 'Денежных движений по старым заказам', 0, (select count(*) from public.money_movements where order_id is not null)
    union all select 'Складских движений по старым заказам', 0, (select count(*) from public.stock_movements where order_id is not null)
  loop
    raise notice '% : ожидалось %, получилось %', r.what, r.expected, r.actual;
    if r.expected is distinct from r.actual then bad := bad || r.what || '; '; end if;
  end loop;
  if bad <> '' then raise exception 'Сверка не сошлась: %', bad; end if;
end $$;""")
    sql.append("commit;")

    out = pathlib.Path(a.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text("\n".join(sql) + "\n", encoding="utf-8")
    print(f"Written {out}: {len(hist)} Excel orders ({rev:,.0f} ₸), {len(gs_sales)} Sheets sales ({gs_revenue:,.0f} ₸)")


if __name__ == "__main__":
    main()
