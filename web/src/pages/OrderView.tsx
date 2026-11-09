import { useEffect, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '../lib/supabase';
import { q, rpc } from '../lib/api';
import { useAccounts, useProducts, useSettings, variantLabel, type MoneyMovement, type OrderCost, type OrderLine, type OrderRow } from '../lib/data';
import { profitOf } from '../lib/estimate';
import { PAYMENT_LABEL, STATUS_LABEL, isoToLocalInput, localInputToISO, num, pct, SOURCE_LABEL, tg, when } from '../lib/format';
import {
  AccountPicker, Approx, Badge, Card, Field, Loading, MoneyInput, Page, Photo, Row, Sheet, SubmitBar, amountOf, useSubmit,
} from '../components/ui';

type Estimate = {
  cost: number; helium_l: number; is_approx: boolean; order_costs: number;
  lines: { line_id: string; product: string; maker: string | null; qty: number; unit_cost: number; helium_l: number; helium_unknown: boolean; helium_source: string | null; ribbon_m: number; cost: number }[];
};

type SheetKind = null | 'pay' | 'issue' | 'assemble' | 'buy' | 'service' | 'defect' | 'cancel' | 'refund' | 'correct';

export default function OrderView() {
  const { id } = useParams();
  const [params] = useSearchParams();
  const qc = useQueryClient();
  const accounts = useAccounts();
  const products = useProducts();
  const settings = useSettings();
  const [sheet, setSheet] = useState<SheetKind>(null);

  const data = useQuery({
    queryKey: ['order', id, 'view'],
    queryFn: async () => {
      const [order, lines, costs, payments, estimate, history] = await Promise.all([
        q<OrderRow>(supabase.from('v_orders').select('*').eq('id', id!).single()),
        q<OrderLine[]>(supabase.from('order_lines').select('*').eq('order_id', id!).order('sort')),
        q<OrderCost[]>(supabase.from('order_costs').select('*').eq('order_id', id!).order('occurred_at')),
        q<MoneyMovement[]>(supabase.from('money_movements').select('*').eq('order_id', id!).in('kind', ['client_payment', 'client_refund']).order('occurred_at')),
        q<Estimate>(supabase.rpc('order_estimate', { p_order_id: id })),
        q<{ id: number; at: string; action: string; reason: string | null; table_name: string }[]>(
          supabase.from('audit_log').select('id, at, action, reason, table_name').eq('row_id', id!).order('at', { ascending: false }).limit(30)),
      ]);
      return { order, lines, costs, payments, estimate, history };
    },
  });

  useEffect(() => {
    if (params.get('cost') === '1') setSheet('service');
  }, [params]);

  if (!data.data) return <Page title="Заказ" back="/orders"><Loading /></Page>;
  const { order: o, lines, costs, payments, estimate, history } = data.data;
  const done = () => { setSheet(null); qc.invalidateQueries(); };
  const accountName = (aid: string | null) => accounts.data?.find((a) => a.account_id === aid)?.name ?? '';
  const isOpen = o.status === 'new' || o.status === 'assembled';
  const writtenOff = o.status === 'issued' || o.status === 'assembled';
  const cost = writtenOff || o.is_historical ? Number(o.actual_cost ?? 0) : Number(estimate.cost);
  const pr = profitOf(Number(o.price), cost);
  const review = typeof o.source?.review === 'string' && !o.source?.reviewed ? (o.source.review as string) : null;

  return (
    <Page title={`Заказ №${o.number}`} back="/orders">
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 8 }}>
        <Badge tone={o.status === 'issued' ? 'ok' : o.status === 'cancelled' ? 'bad' : 'info'}>{STATUS_LABEL[o.status]}</Badge>
        {o.status !== 'cancelled' ? <Badge tone={o.payment_status === 'paid' ? 'ok' : o.payment_status === 'unknown' ? 'neutral' : 'warn'}>{PAYMENT_LABEL[o.payment_status]}</Badge> : null}
        {o.is_historical ? <Badge>из старой таблицы</Badge> : null}
      </div>
      <div style={{ fontSize: 20, fontWeight: 700, marginBottom: 4 }}>{o.title}</div>
      <div className="muted">
        {o.status === 'issued' ? `Выдан ${when(o.issued_at, !o.is_historical)}` : o.status === 'cancelled' ? `Отменён ${when(o.cancelled_at)}` : `Выдать ${when(o.due_at)}`}
        {o.date_uncertain ? ' · дата может быть неточной' : ''}
      </div>

      {review ? (
        <div className="notice review" style={{ marginTop: 10 }}>
          <span style={{ flex: 1 }}>{review}</span>
          <button className="link" onClick={async () => { await rpc('mark_reviewed', { p_table: 'orders', p_id: o.id }); done(); }}>Проверено</button>
        </div>
      ) : null}

      {/* Money block */}
      <Card className="" >
        {o.status === 'cancelled' ? (
          <div>Заказ отменён. {Number(o.cancel_revenue) > 0 ? `Оставили себе ${tg(o.cancel_revenue)}.` : ''}</div>
        ) : o.payment_known ? (
          <>
            <div className="muted small">{Number(o.due) > 0 ? 'Осталось получить' : Number(o.due) < 0 ? 'Клиент переплатил' : 'Оплачен полностью'}</div>
            <div className={`big-number ${Number(o.due) > 0 ? 'due' : ''}`}>{Number(o.due) !== 0 ? tg(Math.abs(Number(o.due))) : '✓'}</div>
            <div className="small muted">Цена {tg(o.price)} · получено {tg(o.paid)}</div>
          </>
        ) : (
          <>
            <div className="muted small">Цена</div>
            <div className="big-number">{tg(o.price)}</div>
            <div className="small muted">Заказ до запуска учёта: деньги уже входят в остатки на дату запуска, оплата по нему отдельно не записана.</div>
          </>
        )}
        <div className="spacer" />
        <div className="btn-row">
          {isOpen ? <button className="btn primary" onClick={() => setSheet('issue')}>Выдать</button> : null}
          {o.status !== 'cancelled' && o.payment_known && Number(o.due) > 0 ? <button className="btn" onClick={() => setSheet('pay')}>Принять оплату</button> : null}
          {o.status === 'new' ? <button className="btn" onClick={() => setSheet('assemble')}>Собрать заранее</button> : null}
        </div>
      </Card>

      {/* Client */}
      {(o.client_name || o.client_phone || o.address) ? (
        <Card>
          {o.client_name ? <div style={{ fontWeight: 650 }}>{o.client_name}</div> : null}
          {o.client_phone ? <a className="link" href={`tel:${o.client_phone}`}>{o.client_phone}</a> : null}
          <div className="small muted">{o.delivery === 'delivery' ? `Доставка${o.address ? `: ${o.address}` : ''}${Number(o.delivery_price) ? ` · ${tg(o.delivery_price)}` : ''}` : 'Самовывоз'}</div>
        </Card>
      ) : null}

      {(o.inscription || o.design || o.comment || o.photo_path) ? (
        <Card>
          {o.inscription ? <div><span className="muted">Надпись:</span> {o.inscription}</div> : null}
          {o.design ? <div><span className="muted">Оформление:</span> {o.design}</div> : null}
          {o.comment ? <div><span className="muted">Комментарий:</span> {o.comment}</div> : null}
          {o.photo_path ? <Photo path={o.photo_path} alt="Фото заказа" size={140} /> : null}
        </Card>
      ) : null}

      {/* Composition */}
      <h2>Состав</h2>
      <Card>
        {lines.length === 0 && o.is_historical ? <div className="muted small">Состав не сохранился в старой таблице — есть только суммы затрат.</div> : null}
        {lines.map((l) => {
          const p = products.data?.find((x) => x.id === l.product_id);
          const v = p?.variants.find((x) => x.id === l.variant_id);
          return (
            <div className="line-item" key={l.id}>
              <div className="li-body">
                <div className="li-title">{num(l.qty)} × {p?.name}</div>
                <div className="li-meta">
                  {v ? <span>{variantLabel(v)}</span> : null}
                  {p?.kind === 'balloon' ? (
                    l.helium_l_per_unit === null ? <span style={{ color: 'var(--warn)' }}>гелий не указан</span>
                      : <span>гелий ≈{num(Number(l.helium_l_per_unit) * Number(l.qty))} л · {SOURCE_LABEL[l.helium_source ?? ''] ?? ''}</span>
                  ) : null}
                  {Number(l.ribbon_m) > 0 ? <span>лента {num(l.ribbon_m)} м</span> : null}
                </div>
              </div>
            </div>
          );
        })}
        {isOpen ? <Link className="btn ghost" to={`/orders/${o.id}/edit`}>Изменить заказ</Link> : null}
      </Card>

      {/* Cost */}
      <h2>Себестоимость и прибыль</h2>
      <Card>
        <Row label={<>{writtenOff || o.is_historical ? 'Себестоимость' : 'Расчётная себестоимость'} <Approx show={estimate.is_approx || o.helium_approx} /></>} value={tg(cost)} strong />
        <Row label="Прибыль" value={tg(pr.profit)} />
        <Row label="Маржа · наценка" value={`${pct(pr.margin)} · ${pct(pr.markup)}`} />
        <details className="more">
          <summary>Из чего сложилась сумма</summary>
          <div className="explain">
            {writtenOff ? (
              <>Материалы списаны со склада по средней цене закупки; купленное специально для заказа — по своей цене. Гелий — по средней цене заправок.</>
            ) : o.is_historical ? (
              <>Суммы затрат перенесены из старой таблицы.</>
            ) : (
              <>Пока заказ не выдан, гелий считается по {tg(settings.data?.helium_plan_price)}/л для расчёта, материалы — по средней цене закупки. При выдаче сумма пересчитается по фактическим ценам.</>
            )}
          </div>
          {!o.is_historical ? estimate.lines.map((l) => (
            <Row key={l.line_id} label={`${num(l.qty)} × ${l.product}`} sub={l.helium_l ? `гелий ≈${num(l.helium_l)} л` : undefined} value={tg(l.cost)} />
          )) : null}
          {costs.map((c) => (
            <Row key={c.id} label={c.label} sub={[c.supplier, c.is_mistake ? 'по ошибке / брак' : null, c.account_id ? `оплачено: ${accountName(c.account_id)}` : null].filter(Boolean).join(' · ') || undefined} value={tg(c.amount)} />
          ))}
          {!costs.some((c) => c.kind === 'service') && Number(o.service_estimate) > 0 ? (
            <Row label={`${o.service_label ?? 'Печать'} (план)`} value={`≈${tg(o.service_estimate)}`} />
          ) : null}
        </details>
        {o.status !== 'cancelled' && !o.is_historical ? (
          <div className="btn-row" style={{ marginTop: 8 }}>
            <button className="btn" onClick={() => setSheet('service')}>Печать / услуга</button>
            {isOpen ? <button className="btn" onClick={() => setSheet('buy')}>Купили для заказа</button> : null}
            {o.status !== 'new' ? <button className="btn" onClick={() => setSheet('defect')}>Брак / замена</button> : null}
          </div>
        ) : null}
      </Card>

      {/* Payments */}
      {payments.length > 0 ? (
        <>
          <h2>Оплаты</h2>
          <Card>
            {payments.map((m) => (
              <Row key={m.id} label={m.kind === 'client_refund' ? 'Возврат клиенту' : (m.note ?? 'Оплата')} sub={`${when(m.occurred_at)} · ${accountName(m.account_id)}`}
                value={tg(m.amount)} />
            ))}
          </Card>
        </>
      ) : null}

      {/* More actions */}
      {!o.is_historical ? (
        <details className="more">
          <summary>Ещё действия</summary>
          <div className="btn-row">
            {isOpen ? <button className="btn danger" onClick={() => setSheet('cancel')}>Отменить заказ</button> : null}
            {o.status === 'issued' && Number(o.paid) > 0 ? <button className="btn" onClick={() => setSheet('refund')}>Вернуть деньги</button> : null}
            {o.status === 'issued' ? <button className="btn" onClick={() => setSheet('correct')}>Исправить выданный заказ</button> : null}
          </div>
        </details>
      ) : null}

      {history.length > 0 ? (
        <details className="more">
          <summary>История изменений ({history.length})</summary>
          {history.map((h) => <Row key={h.id} label={h.reason ?? (h.action === 'insert' ? 'Создан' : 'Изменён')} sub={when(h.at)} />)}
        </details>
      ) : null}

      {o.source ? <p className="small muted">Источник: {String(o.source.sheet ?? '')} {String(o.source.row ?? '')}</p> : null}

      <PaySheet open={sheet === 'pay'} order={o} onDone={done} onClose={() => setSheet(null)} />
      <IssueSheet open={sheet === 'issue'} order={o} helium={estimate} onDone={done} onClose={() => setSheet(null)} />
      <AssembleSheet open={sheet === 'assemble'} order={o} onDone={done} onClose={() => setSheet(null)} />
      <BuySheet open={sheet === 'buy'} order={o} lines={lines} onDone={done} onClose={() => setSheet(null)} />
      <ServiceSheet open={sheet === 'service'} order={o} onDone={done} onClose={() => setSheet(null)} />
      <DefectSheet open={sheet === 'defect'} order={o} lines={lines} onDone={done} onClose={() => setSheet(null)} />
      <CancelSheet open={sheet === 'cancel'} order={o} onDone={done} onClose={() => setSheet(null)} />
      <RefundSheet open={sheet === 'refund'} order={o} onDone={done} onClose={() => setSheet(null)} />
      <CorrectSheet open={sheet === 'correct'} order={o} onDone={done} onClose={() => setSheet(null)} />
    </Page>
  );
}

type SheetProps = { open: boolean; order: OrderRow; onDone: () => void; onClose: () => void };

function PaySheet({ open, order, onDone, onClose }: SheetProps) {
  const accounts = useAccounts();
  const [amount, setAmount] = useState('');
  const [account, setAccount] = useState<string | null>(null);
  useEffect(() => { if (open) setAmount(String(Math.max(0, Number(order.due)))); }, [open, order.due]);
  const s = useSubmit((rid) => rpc('add_payment', { p_request_id: rid, p_order_id: order.id, p_amount: amountOf(amount), p_account_id: account }), onDone);
  return (
    <Sheet open={open} onClose={onClose} title="Принять оплату">
      <Field label="Сумма" error={s.errorFor('amount')} hint={`Осталось получить ${tg(order.due)}`}><MoneyInput value={amount} onChange={setAmount} autoFocus /></Field>
      <Field label="Куда пришли деньги" error={s.errorFor('account')}><AccountPicker accounts={accounts.data} value={account} onChange={setAccount} /></Field>
      <SubmitBar label="Записать оплату" busy={s.busy} onClick={s.submit} error={s.generalError} />
    </Sheet>
  );
}

function IssueSheet({ open, order, helium, onDone, onClose }: SheetProps & { helium: Estimate }) {
  const accounts = useAccounts();
  const due = Math.max(0, Number(order.due ?? 0));
  const [amount, setAmount] = useState('');
  const [account, setAccount] = useState<string | null>(null);
  const [later, setLater] = useState(false);
  useEffect(() => { if (open) { setAmount(String(due)); setLater(false); } }, [open, due]);
  const s = useSubmit((rid) => rpc('issue_order', {
    p_request_id: rid, p_order_id: order.id,
    p_payment_amount: later ? null : amountOf(amount) || null, p_payment_account_id: later ? null : account,
  }), onDone);
  const missing = helium.lines.filter((l) => l.helium_unknown);
  return (
    <Sheet open={open} onClose={onClose} title="Выдать заказ">
      {missing.length > 0 ? (
        <div className="notice">Для «{missing[0].product}» не указан расход гелия — гелий по этой строке не спишется. <Link className="act" to={`/orders/${order.id}/edit`}>→ указать</Link></div>
      ) : null}
      {order.status === 'new' ? <p className="small muted">Материалы и гелий (≈{num(helium.helium_l)} л) спишутся со склада сейчас.</p> : <p className="small muted">Заказ уже собран — материалы повторно не спишутся.</p>}
      {due > 0 ? (
        <>
          <div className="big-number due">{tg(due)}</div>
          <p className="muted">осталось получить от клиента</p>
          {!later ? (
            <>
              <Field label="Получили сейчас" error={s.errorFor('amount')}><MoneyInput value={amount} onChange={setAmount} /></Field>
              <Field label="Куда" error={s.errorFor('account')}><AccountPicker accounts={accounts.data} value={account} onChange={setAccount} /></Field>
            </>
          ) : <div className="notice info">Долг клиента {tg(due)} останется в заказе и в списке «Требует внимания».</div>}
          <label className="check"><input type="checkbox" checked={later} onChange={(e) => setLater(e.target.checked)} />Клиент заплатит позже</label>
        </>
      ) : <p>Заказ оплачен полностью.</p>}
      <SubmitBar label="Заказ выдан" busy={s.busy} onClick={s.submit} error={s.generalError ?? s.errorFor('price')} />
    </Sheet>
  );
}

function AssembleSheet({ open, order, onDone, onClose }: SheetProps) {
  const s = useSubmit((rid) => rpc('assemble_order', { p_request_id: rid, p_order_id: order.id }), onDone);
  return (
    <Sheet open={open} onClose={onClose} title="Собрать заранее">
      <p>Шары, гелий и лента спишутся со склада сейчас. При выдаче повторно не спишутся.</p>
      <p className="small muted">Если потом поменяете состав — спишется или вернётся только разница.</p>
      <SubmitBar label="Заказ собран" busy={s.busy} onClick={s.submit} error={s.generalError} />
    </Sheet>
  );
}

function BuySheet({ open, order, lines, onDone, onClose }: SheetProps & { lines: OrderLine[] }) {
  const accounts = useAccounts();
  const products = useProducts();
  const [productId, setProductId] = useState<string | null>(null);
  const [qty, setQty] = useState('1');
  const [amount, setAmount] = useState('');
  const [supplier, setSupplier] = useState('');
  const [account, setAccount] = useState<string | null>(null);
  const s = useSubmit((rid) => rpc('record_purchase', {
    p_request_id: rid,
    p: { account_id: account, supplier, lines: [{ product_id: productId, qty: amountOf(qty), amount: amountOf(amount), order_id: order.id }] },
  }), onDone);
  const opts = Array.from(new Set(lines.map((l) => l.product_id)));
  return (
    <Sheet open={open} onClose={onClose} title="Купили для этого заказа">
      <p className="small muted">Цена войдёт в себестоимость этого заказа как есть. Если купили больше, чем нужно, остаток уйдёт на склад.</p>
      <Field label="Что купили" error={s.errorFor('lines')}>
        <div className="choice-row">
          {opts.map((pid) => (
            <button type="button" key={pid} className={`choice ${productId === pid ? 'on' : ''}`} onClick={() => setProductId(pid)}>
              {products.data?.find((p) => p.id === pid)?.name}
            </button>
          ))}
        </div>
      </Field>
      <Field label="Сколько штук"><input inputMode="decimal" value={qty} onChange={(e) => setQty(e.target.value)} /></Field>
      <Field label="Заплатили всего" error={s.errorFor('amount')}><MoneyInput value={amount} onChange={setAmount} /></Field>
      <Field label="Где купили"><input value={supplier} onChange={(e) => setSupplier(e.target.value)} placeholder="Например: магазин рядом" /></Field>
      <Field label="С какого счёта" error={s.errorFor('account')}><AccountPicker accounts={accounts.data} value={account} onChange={setAccount} showBalance /></Field>
      <SubmitBar label="Записать покупку" busy={s.busy} onClick={s.submit} error={s.generalError} disabled={!productId} />
    </Sheet>
  );
}

function ServiceSheet({ open, order, onDone, onClose }: SheetProps) {
  const accounts = useAccounts();
  const [label, setLabel] = useState('');
  const [amount, setAmount] = useState('');
  const [supplier, setSupplier] = useState('');
  const [account, setAccount] = useState<string | null>(null);
  const [mistake, setMistake] = useState(false);
  useEffect(() => { if (open) { setLabel(order.service_label ?? 'Печать'); setAmount(Number(order.service_estimate) ? String(order.service_estimate) : ''); } }, [open]); // eslint-disable-line react-hooks/exhaustive-deps
  const s = useSubmit((rid) => rpc('add_order_cost', {
    p_request_id: rid, p: { order_id: order.id, kind: 'service', label, amount: amountOf(amount), supplier, account_id: account, is_mistake: mistake },
  }), onDone);
  return (
    <Sheet open={open} onClose={onClose} title="Печать или услуга для заказа">
      <p className="small muted">Сумма войдёт только в себестоимость этого заказа — не в склад и не в расходы бизнеса, поэтому дважды не посчитается.</p>
      <Field label="Что"><input value={label} onChange={(e) => setLabel(e.target.value)} /></Field>
      <Field label="Сколько заплатили" error={s.errorFor('amount')}><MoneyInput value={amount} onChange={setAmount} autoFocus /></Field>
      <Field label="Где (полиграфия)"><input value={supplier} onChange={(e) => setSupplier(e.target.value)} /></Field>
      <Field label="С какого счёта" hint="Не выбирайте счёт, если оплата уже записана другой тратой"><AccountPicker accounts={accounts.data} value={account} onChange={setAccount} showBalance /></Field>
      <label className="check"><input type="checkbox" checked={mistake} onChange={(e) => setMistake(e.target.checked)} />Сделали по ошибке / переделка</label>
      <SubmitBar label="Записать" busy={s.busy} onClick={s.submit} error={s.generalError ?? s.errorFor('order')} />
    </Sheet>
  );
}

function DefectSheet({ open, order, lines, onDone, onClose }: SheetProps & { lines: OrderLine[] }) {
  const products = useProducts();
  const [productId, setProductId] = useState<string | null>(null);
  const [qty, setQty] = useState('1');
  const [withHelium, setWithHelium] = useState(true);
  const s = useSubmit((rid) => rpc('report_defect', {
    p_request_id: rid, p_order_id: order.id, p_product_id: productId, p_qty: amountOf(qty), p_with_helium: withHelium,
  }), onDone);
  const opts = Array.from(new Set(lines.map((l) => l.product_id)));
  const isBalloon = products.data?.find((p) => p.id === productId)?.kind === 'balloon';
  return (
    <Sheet open={open} onClose={onClose} title="Брак или замена">
      <p className="small muted">Замена спишется со склада и войдёт в себестоимость этого заказа.</p>
      <div className="choice-row">
        {opts.map((pid) => (
          <button type="button" key={pid} className={`choice ${productId === pid ? 'on' : ''}`} onClick={() => setProductId(pid)}>
            {products.data?.find((p) => p.id === pid)?.name}
          </button>
        ))}
      </div>
      <div className="spacer" />
      <Field label="Сколько заменили" error={s.errorFor('qty')}><input inputMode="decimal" value={qty} onChange={(e) => setQty(e.target.value)} /></Field>
      {isBalloon ? <label className="check"><input type="checkbox" checked={withHelium} onChange={(e) => setWithHelium(e.target.checked)} />Шар успели надуть — списать и гелий</label> : null}
      <SubmitBar label="Записать замену" busy={s.busy} onClick={s.submit} error={s.generalError} disabled={!productId} />
    </Sheet>
  );
}

function CancelSheet({ open, order, onDone, onClose }: SheetProps) {
  const accounts = useAccounts();
  const [refund, setRefund] = useState('');
  const [account, setAccount] = useState<string | null>(null);
  const [reason, setReason] = useState('');
  useEffect(() => { if (open) setRefund(String(Number(order.paid))); }, [open, order.paid]);
  const s = useSubmit((rid) => rpc('cancel_order', {
    p_request_id: rid, p_order_id: order.id, p_refund_amount: amountOf(refund), p_refund_account_id: account, p_reason: reason,
  }), onDone);
  const kept = Number(order.paid) - amountOf(refund);
  return (
    <Sheet open={open} onClose={onClose} title="Отменить заказ">
      {order.status === 'assembled' ? <div className="notice">Заказ уже собран: потраченные материалы попадут в «Потери».</div> : <p className="small muted">Склад не изменится — резерв материалов снимется.</p>}
      {Number(order.paid) > 0 ? (
        <>
          <Field label={`Вернуть клиенту (заплатил ${tg(order.paid)})`} error={s.errorFor('amount')}><MoneyInput value={refund} onChange={setRefund} /></Field>
          {amountOf(refund) > 0 ? <Field label="Откуда вернули" error={s.errorFor('account')}><AccountPicker accounts={accounts.data} value={account} onChange={setAccount} showBalance /></Field> : null}
          {kept > 0 ? <p className="small">Оставите себе {tg(kept)} — это будет выручкой за отмену.</p> : null}
        </>
      ) : null}
      <Field label="Причина"><input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Например: клиент передумал" /></Field>
      <SubmitBar label="Отменить заказ" busy={s.busy} onClick={s.submit} error={s.generalError} />
    </Sheet>
  );
}

function RefundSheet({ open, order, onDone, onClose }: SheetProps) {
  const accounts = useAccounts();
  const [amount, setAmount] = useState('');
  const [account, setAccount] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const s = useSubmit((rid) => rpc('refund_payment', {
    p_request_id: rid, p_order_id: order.id, p_amount: amountOf(amount), p_account_id: account, p_note: note || null,
  }), onDone);
  return (
    <Sheet open={open} onClose={onClose} title="Вернуть деньги клиенту">
      <p className="small muted">Возврат уменьшит деньги на счёте и выручку в день возврата. Материалы остаются в себестоимости.</p>
      <Field label="Сумма возврата" error={s.errorFor('amount')}><MoneyInput value={amount} onChange={setAmount} autoFocus /></Field>
      <Field label="Откуда" error={s.errorFor('account')}><AccountPicker accounts={accounts.data} value={account} onChange={setAccount} showBalance /></Field>
      <Field label="Причина"><input value={note} onChange={(e) => setNote(e.target.value)} /></Field>
      <SubmitBar label="Вернуть" busy={s.busy} onClick={s.submit} error={s.generalError} />
    </Sheet>
  );
}

function CorrectSheet({ open, order, onDone, onClose }: SheetProps) {
  const [price, setPrice] = useState('');
  const [date, setDate] = useState('');
  const [reason, setReason] = useState('');
  useEffect(() => { if (open) { setPrice(String(order.price)); setDate(isoToLocalInput(order.issued_at)); setReason(''); } }, [open]); // eslint-disable-line react-hooks/exhaustive-deps
  const s = useSubmit((rid) => {
    const patch: Record<string, unknown> = {};
    if (amountOf(price) !== Number(order.price)) patch.price = amountOf(price);
    if (date !== isoToLocalInput(order.issued_at)) patch.issued_at = localInputToISO(date);
    return rpc('correct_issued_order', { p_request_id: rid, p_order_id: order.id, p_reason: reason, p: patch });
  }, onDone);
  return (
    <Sheet open={open} onClose={onClose} title="Исправить выданный заказ">
      <p className="small muted">Исправление сохранится в истории заказа вместе с причиной.</p>
      <Field label="Цена"><MoneyInput value={price} onChange={setPrice} /></Field>
      <Field label="Дата выдачи"><input type="datetime-local" value={date} onChange={(e) => setDate(e.target.value)} /></Field>
      <Field label="Что и почему исправляете" error={s.errorFor('reason')}><input value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
      <SubmitBar label="Сохранить исправление" busy={s.busy} onClick={s.submit} error={s.generalError} />
    </Sheet>
  );
}
