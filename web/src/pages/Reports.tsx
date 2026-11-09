import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '../lib/supabase';
import { q, rpc } from '../lib/api';
import { addDays, dayLabel, num, pct, tg, todayISO } from '../lib/format';
import { useAccounts, useStock } from '../lib/data';
import { Approx, Badge, Card, Empty, Loading, Page, Row, Sheet } from '../components/ui';

type Mode = 'day' | 'week' | 'month' | 'year' | 'custom' | 'all';
type Range = { from: string; to: string };
type Summary = {
  revenue: number; cost: number; gross: number; gross_margin: number | null; losses: number; opex: number; tax: number;
  equipment: number; net: number; net_margin: number | null; orders: number; avg_check: number | null; payments: number;
  refunds: number; owner_draws: number; owner_contributions: number; purchases: number; approx_orders: number; historical_orders: number;
};
type Item = { key: string; day: string; label: string; amount: number; orderId?: string | null; badge?: string };

const MODES: { value: Mode; label: string }[] = [
  { value: 'day', label: 'День' }, { value: 'week', label: 'Неделя' }, { value: 'month', label: 'Месяц' },
  { value: 'year', label: 'Год' }, { value: 'custom', label: 'Свой период' }, { value: 'all', label: 'Всё время' },
];

const utc = (iso: string) => new Date(`${iso}T12:00:00Z`);
const toIso = (d: Date) => d.toISOString().slice(0, 10);
const daysBetween = (a: string, b: string) => Math.round((utc(b).getTime() - utc(a).getTime()) / 86400000);

function shiftMonths(iso: string, n: number): string {
  const d = utc(iso);
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + n);
  return toIso(d);
}

/** Range of the period that contains `anchor` (Monday-based weeks). */
function rangeOf(mode: Mode, anchor: string, custom: Range): Range {
  switch (mode) {
    case 'day': return { from: anchor, to: anchor };
    case 'week': {
      const wd = (utc(anchor).getUTCDay() + 6) % 7;
      const from = addDays(anchor, -wd);
      return { from, to: addDays(from, 6) };
    }
    case 'month': {
      const from = shiftMonths(anchor, 0);
      return { from, to: addDays(shiftMonths(anchor, 1), -1) };
    }
    case 'year': return { from: `${anchor.slice(0, 4)}-01-01`, to: `${anchor.slice(0, 4)}-12-31` };
    case 'custom': return custom;
    default: return { from: '2000-01-01', to: '2100-01-01' };
  }
}

function moveAnchor(mode: Mode, anchor: string, dir: 1 | -1): string {
  switch (mode) {
    case 'day': return addDays(anchor, dir);
    case 'week': return addDays(anchor, 7 * dir);
    case 'month': return shiftMonths(anchor, dir);
    case 'year': return `${Number(anchor.slice(0, 4)) + dir}-${anchor.slice(5)}`;
    default: return anchor;
  }
}

type Metric = {
  key: string; label: string; get: (s: Summary) => number | null; fmt?: 'money' | 'count' | 'pct'; hint?: string; explain?: boolean;
};

const METRICS: Metric[] = [
  { key: 'revenue', label: 'Выручка', get: (s) => s.revenue, hint: 'выданные заказы + оставленные предоплаты − возвраты' },
  { key: 'cost', label: 'Себестоимость', get: (s) => s.cost },
  { key: 'gross', label: 'Валовая прибыль', get: (s) => s.gross, explain: true },
  { key: 'losses', label: 'Потери', get: (s) => s.losses, hint: 'брак, недостачи, отменённые после сборки' },
  { key: 'opex', label: 'Расходы бизнеса', get: (s) => s.opex },
  { key: 'tax', label: 'Налоги', get: (s) => s.tax },
  { key: 'net', label: 'Чистая прибыль', get: (s) => s.net, explain: true },
  { key: 'orders', label: 'Заказов', get: (s) => s.orders, fmt: 'count' },
  { key: 'avg_check', label: 'Средний чек', get: (s) => s.avg_check },
  { key: 'payments', label: 'Получено от клиентов', get: (s) => s.payments },
  { key: 'refunds', label: 'Возвраты', get: (s) => s.refunds },
  { key: 'owner_draws', label: 'Владельцы взяли', get: (s) => s.owner_draws },
  { key: 'purchases', label: 'Покупки материалов (деньги)', get: (s) => s.purchases },
  { key: 'equipment', label: 'Оборудование', get: (s) => s.equipment },
];

export default function Reports() {
  const [mode, setMode] = useState<Mode>('month');
  const [anchor, setAnchor] = useState(todayISO());
  const [custom, setCustom] = useState<Range>({ from: addDays(todayISO(), -6), to: todayISO() });
  const [open, setOpen] = useState<Metric | null>(null);

  const range = rangeOf(mode, anchor, custom);
  const len = daysBetween(range.from, range.to) + 1;
  const prev: Range | null = mode === 'all' ? null
    : mode === 'month' ? rangeOf('month', shiftMonths(anchor, -1), custom)
    : mode === 'year' ? rangeOf('year', moveAnchor('year', anchor, -1), custom)
    : { from: addDays(range.from, -len), to: addDays(range.from, -1) };

  const cur = useQuery({
    queryKey: ['report', range.from, range.to],
    queryFn: () => rpc<Summary>('report_summary', { p_from: range.from, p_to: range.to }),
  });
  const old = useQuery({
    queryKey: ['report', prev?.from, prev?.to],
    enabled: !!prev,
    queryFn: () => rpc<Summary>('report_summary', { p_from: prev!.from, p_to: prev!.to }),
  });

  function move(dir: 1 | -1) {
    if (mode === 'custom') {
      setCustom({ from: addDays(custom.from, len * dir), to: addDays(custom.to, len * dir) });
    } else setAnchor(moveAnchor(mode, anchor, dir));
  }
  const s = cur.data;

  return (
    <Page title="Отчёты" back="/more">
      <div className="segmented" style={{ marginBottom: 12 }}>
        {MODES.map((m) => (
          <button key={m.value} className={mode === m.value ? 'on' : ''} onClick={() => setMode(m.value)}>{m.label}</button>
        ))}
      </div>

      {mode === 'custom' ? (
        <div className="btn-row" style={{ marginBottom: 12 }}>
          <label className="field" style={{ flex: 1, marginBottom: 0 }}>
            <span className="field-label">С</span>
            <input type="date" value={custom.from} onChange={(e) => e.target.value && setCustom({ ...custom, from: e.target.value })} />
          </label>
          <label className="field" style={{ flex: 1, marginBottom: 0 }}>
            <span className="field-label">По</span>
            <input type="date" value={custom.to} min={custom.from} onChange={(e) => e.target.value && setCustom({ ...custom, to: e.target.value })} />
          </label>
        </div>
      ) : null}

      <div className="btn-row" style={{ alignItems: 'center', marginBottom: 12, flexWrap: 'nowrap' }}>
        {mode !== 'all' ? <button className="btn" style={{ flex: 'none', width: 52 }} aria-label="Назад" onClick={() => move(-1)}>‹</button> : null}
        <div className="center" style={{ flex: 1 }}>
          {mode === 'all' ? <b>Всё время</b> : (
            <>
              <b>{range.from === range.to ? dayLabel(range.from) : `${dayLabel(range.from)} — ${dayLabel(range.to)}`}</b>
            </>
          )}
        </div>
        {mode !== 'all' ? <button className="btn" style={{ flex: 'none', width: 52 }} aria-label="Вперёд" onClick={() => move(1)}>›</button> : null}
      </div>

      {cur.isLoading ? <Loading /> : null}
      {cur.error ? <div className="form-error">{(cur.error as Error).message}. Потяните страницу вниз или попробуйте ещё раз.</div> : null}
      {s ? (
        <>
          {s.historical_orders > 0 ? (
            <div className="notice info">
              <div>Заказов: {s.orders}, из них {s.historical_orders} до запуска учёта — оплата неизвестна.</div>
            </div>
          ) : null}
          <Card>
            {METRICS.map((m) => (
              <MetricRow key={m.key} m={m} s={s} old={prev ? old.data : undefined} onOpen={() => setOpen(m)} />
            ))}
          </Card>
          <details className="more">
            <summary>Как считаются маржа и наценка</summary>
            <div className="explain">
              <b>Маржа</b> = прибыль ÷ выручка. <b>Наценка</b> = прибыль ÷ себестоимость.<br />
              Например: шары стоили 1 000 ₸, продали за 2 500 ₸. Прибыль 1 500 ₸, маржа 60%, наценка 150%.
            </div>
          </details>
        </>
      ) : null}

      <Now />
      <MetricSheet m={open} s={s} range={range} onClose={() => setOpen(null)} />
    </Page>
  );
}

function MetricRow({ m, s, old, onOpen }: { m: Metric; s: Summary; old: Summary | undefined; onOpen: () => void }) {
  const v = m.get(s);
  const o = old ? m.get(old) : null;
  const fmt = (x: number | null) => (x == null ? '—' : m.fmt === 'count' ? num(x) : tg(x));
  const delta = v != null && o != null ? v - o : null;
  const margin = m.key === 'gross' ? s.gross_margin : m.key === 'net' ? s.net_margin : null;
  const sub = [
    m.key === 'gross' && s.gross_margin != null ? `маржа ${pct(margin)}` : null,
    m.key === 'net' && s.net_margin != null ? `чистая маржа ${pct(margin)}` : null,
    m.hint ?? null,
  ].filter(Boolean).join(' · ');
  return (
    <div className="row tappable" role="button" style={{ cursor: 'pointer' }} onClick={onOpen}>
      <div className="row-main">
        <span className="row-label">
          {m.label} {m.key === 'cost' && s.approx_orders > 0 ? <Badge tone="approx">есть примерные</Badge> : null}
        </span>
        {sub ? <span className="row-sub">{sub}</span> : null}
        {delta != null ? (
          <span className="row-sub">
            {delta === 0 ? 'как в прошлом периоде' : `${delta > 0 ? '+' : '−'}${m.fmt === 'count' ? num(Math.abs(delta)) : tg(Math.abs(delta))} к прошлому периоду`}
          </span>
        ) : null}
      </div>
      <span className="row-value strong">{fmt(v)}</span>
      <span className="chev">›</span>
    </div>
  );
}

/** Current state: does not depend on the chosen period. */
function Now() {
  const accounts = useAccounts();
  const stock = useStock();
  const owed = useQuery({
    queryKey: ['report_owed'],
    queryFn: async () => {
      const r = await q<{ due: number }[]>(supabase.from('v_orders').select('due').eq('status', 'issued').eq('payment_known', true).gt('due', 0));
      return r.reduce((a, x) => a + Number(x.due), 0);
    },
  });
  const active = (stock.data ?? []).filter((r) => r.active);
  const value = active.reduce((a, r) => a + Number(r.value), 0);
  const approx = active.some((r) => r.cost_is_estimate && Number(r.physical) !== 0);
  return (
    <>
      <h2>Сейчас</h2>
      <p className="muted small" style={{ marginTop: -4 }}>Это состояние на сегодня, оно не зависит от выбранного периода.</p>
      <Card>
        {(accounts.data ?? []).filter((a) => a.active).map((a) => <Row key={a.account_id} label={a.name} value={tg(a.balance)} />)}
        <Row label="Клиенты должны" value={owed.data == null ? '…' : tg(owed.data)} sub="только выданные заказы с известной оплатой" />
        <Row label="Склад" value={<>{approx ? '≈ ' : ''}{tg(value)} <Approx show={approx} /></>} sub="по средним ценам закупки" />
      </Card>
    </>
  );
}

async function loadItems(key: string, r: Range): Promise<Item[]> {
  const between = <T extends { gte: (c: string, v: string) => T; lte: (c: string, v: string) => T }>(b: T) => b.gte('day', r.from).lte('day', r.to);
  type Rev = { day: string; order_id: string | null; amount: number; kind: string; label: string; is_historical: boolean };
  switch (key) {
    case 'revenue':
    case 'orders':
    case 'avg_check': {
      const rows = await q<Rev[]>(between(supabase.from('v_revenue_items').select('*')).order('day', { ascending: false }));
      return rows.filter((x) => key === 'revenue' || x.kind === 'sale')
        .map((x, i) => ({ key: `${i}`, day: x.day, label: x.label, amount: Number(x.amount), orderId: x.order_id, badge: x.is_historical ? 'до запуска' : undefined }));
    }
    case 'cost': {
      const rows = await q<{ day: string; order_id: string; amount: number; label: string; is_historical: boolean; is_approx: boolean }[]>(
        between(supabase.from('v_cost_items').select('*')).order('day', { ascending: false }));
      return rows.map((x, i) => ({ key: `${i}`, day: x.day, label: x.label, amount: Number(x.amount), orderId: x.order_id, badge: x.is_approx ? 'примерно' : undefined }));
    }
    case 'losses': {
      const rows = await q<{ day: string; order_id: string | null; amount: number; label: string }[]>(
        between(supabase.from('v_loss_items').select('*')).order('day', { ascending: false }));
      return rows.map((x, i) => ({ key: `${i}`, day: x.day, label: x.label, amount: Number(x.amount), orderId: x.order_id }));
    }
    case 'opex':
    case 'tax':
    case 'equipment': {
      const rows = await q<{ day: string; expense_id: string; amount: number; label: string; is_historical: boolean }[]>(
        between(supabase.from('v_expense_items').select('*').eq('class', key)).order('day', { ascending: false }));
      return rows.map((x) => ({ key: x.expense_id, day: x.day, label: x.label, amount: Number(x.amount), badge: x.is_historical ? 'до запуска' : undefined }));
    }
    case 'payments':
    case 'refunds': {
      const rows = await q<{ day: string; movement_id: string; order_id: string; amount: number; label: string }[]>(
        between(supabase.from('v_payment_items').select('*').eq('kind', key === 'payments' ? 'client_payment' : 'client_refund')).order('day', { ascending: false }));
      return rows.map((x) => ({ key: x.movement_id, day: x.day, label: x.label, amount: Math.abs(Number(x.amount)), orderId: x.order_id }));
    }
    case 'owner_draws': {
      const rows = await q<{ day: string; owner_name: string; kind: string; amount: number; note: string | null }[]>(
        between(supabase.from('v_owner_flow_items').select('*').in('kind', ['withdrawal', 'personal'])).order('day', { ascending: false }));
      return rows.map((x, i) => ({ key: `${i}`, day: x.day, label: `${x.owner_name}${x.note ? ` — ${x.note}` : ''}`, amount: Number(x.amount) }));
    }
    case 'purchases': {
      const rows = await q<{ id: string; occurred_at: string; supplier: string | null; total: number; note: string | null }[]>(
        supabase.from('purchases').select('id, occurred_at, supplier, total, note').eq('is_historical', false)
          .gte('occurred_at', `${r.from}T00:00:00+05:00`).lt('occurred_at', `${addDays(r.to, 1)}T00:00:00+05:00`).order('occurred_at', { ascending: false }));
      return rows.map((x) => ({
        key: x.id, day: x.occurred_at.slice(0, 10), label: [x.supplier, x.note].filter(Boolean).join(' — ') || 'Покупка', amount: Number(x.total),
      }));
    }
    default: return [];
  }
}

function MetricSheet({ m, s, range, onClose }: { m: Metric | null; s: Summary | undefined; range: Range; onClose: () => void }) {
  const items = useQuery({
    queryKey: ['report_items', m?.key, range.from, range.to],
    enabled: !!m && !m.explain,
    queryFn: () => loadItems(m!.key, range),
  });
  return (
    <Sheet open={!!m} onClose={onClose} title={m?.label ?? ''}>
      {m?.explain && s ? (
        <div className="explain">
          {m.key === 'gross'
            ? <>Валовая прибыль = выручка − себестоимость: <b>{tg(s.revenue)} − {tg(s.cost)} = {tg(s.gross)}</b>. Маржа {pct(s.gross_margin)}.</>
            : <>Чистая прибыль = выручка − себестоимость − потери − расходы − налоги: <b>{tg(s.net)}</b>. Чистая маржа {pct(s.net_margin)}. Оборудование сюда не входит.</>}
          <br />Маржа = прибыль ÷ выручка. Наценка = прибыль ÷ себестоимость.
        </div>
      ) : null}
      {m && !m.explain ? (
        <>
          {items.isLoading ? <Loading /> : null}
          {items.error ? <div className="form-error">Не удалось загрузить. Закройте и откройте ещё раз.</div> : null}
          {items.data && items.data.length === 0 ? <Empty>За этот период записей нет</Empty> : null}
          {(items.data ?? []).map((it) => {
            const body = (
              <>
                <div className="row-main">
                  <span className="row-label">{it.label} {it.badge ? <Badge tone={it.badge === 'примерно' ? 'approx' : 'neutral'}>{it.badge}</Badge> : null}</span>
                  <span className="row-sub">{dayLabel(it.day)}</span>
                </div>
                <span className="row-value">{tg(it.amount)}</span>
                {it.orderId ? <span className="chev">›</span> : null}
              </>
            );
            return it.orderId
              ? <Link key={it.key} className="row tappable" to={`/orders/${it.orderId}`}>{body}</Link>
              : <div key={it.key} className="row">{body}</div>;
          })}
        </>
      ) : null}
    </Sheet>
  );
}
