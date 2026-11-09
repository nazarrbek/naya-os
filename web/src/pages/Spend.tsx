import { useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '../lib/supabase';
import { q, rpc } from '../lib/api';
import { localInputToISO, nowLocalInput, num, tg } from '../lib/format';
import { useAccounts, useOwners, usePayout, useProducts, useSettings } from '../lib/data';
import { AccountPicker, Card, Field, Loading, MoneyInput, Page, SubmitBar, amountOf, useSubmit } from '../components/ui';

type Kind =
  | 'materials' | 'helium' | 'print' | 'ads' | 'delivery' | 'rent' | 'fees' | 'other'
  | 'equipment' | 'tax' | 'withdrawal' | 'personal' | 'contribution';

const KINDS: { kind: Kind; name: string; sub: string; icon: string }[] = [
  { kind: 'materials', name: 'Материалы', sub: 'Купили товары для склада', icon: '🛍️' },
  { kind: 'helium', name: 'Заправка гелия', sub: 'Баллон гелия', icon: '🎈' },
  { kind: 'print', name: 'Печать / услуга для заказа', sub: 'Идёт в себестоимость заказа', icon: '🖨️' },
  { kind: 'ads', name: 'Реклама', sub: 'Instagram, TikTok, OLX…', icon: '📣' },
  { kind: 'delivery', name: 'Доставка / такси', sub: 'Курьер, такси', icon: '🚕' },
  { kind: 'rent', name: 'Аренда', sub: 'Помещение', icon: '🏠' },
  { kind: 'fees', name: 'Комиссии', sub: 'Банк, сервисы', icon: '💳' },
  { kind: 'other', name: 'Другое', sub: 'Связь, ремонт, прочее', icon: '🧾' },
  { kind: 'equipment', name: 'Оборудование', sub: 'Инвестиция, не расход', icon: '🔧' },
  { kind: 'tax', name: 'Налог', sub: 'Уплата налогов', icon: '🏛️' },
  { kind: 'withdrawal', name: 'Взять себе', sub: 'Получить свою долю', icon: '👛' },
  { kind: 'personal', name: 'Личная трата из денег бизнеса', sub: 'Купили себе из кассы', icon: '🙋' },
  { kind: 'contribution', name: 'Внести свои деньги', sub: 'Положить в бизнес', icon: '➕' },
];

const TITLES = Object.fromEntries(KINDS.map((k) => [k.kind, k.name])) as Record<Kind, string>;
const OPEX_FIXED: Partial<Record<Kind, string>> = { ads: 'Реклама', rent: 'Аренда', fees: 'Комиссии' };

// ?kind=print is the URL name for «Печать / услуга для заказа»
const KIND_ALIAS: Record<string, Kind> = { print: 'print', materials: 'materials' };

type Line = { key: number; product_id: string; qty: string; amount: string };
type OrderOpt = { id: string; number: number; title: string; client_name: string | null; status: string };

export default function Spend() {
  const [params] = useSearchParams();
  const raw = params.get('kind');
  const initial = raw ? (KIND_ALIAS[raw] ?? (raw in TITLES ? (raw as Kind) : null)) : null;
  const [kind, setKind] = useState<Kind | null>(initial);
  const [done, setDone] = useState(false);
  const nav = useNavigate();
  const loc = useLocation();
  const goBack = () => (loc.key !== 'default' ? nav(-1) : nav('/'));

  useEffect(() => {
    if (!done) return;
    const t = setTimeout(goBack, 1200);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [done]);

  if (done) {
    return (
      <Page title="Готово">
        <Card>
          <div className="big-number">✓ Записано</div>
          <p className="muted">Запись сохранена. Возвращаю вас назад…</p>
          <button className="btn block" onClick={goBack}>Вернуться</button>
        </Card>
      </Page>
    );
  }

  if (!kind) {
    return (
      <Page title="Записать трату" back>
        <p className="muted">Что вы хотите записать?</p>
        <div className="tiles">
          {KINDS.map((k) => (
            <button key={k.kind} className="tile" onClick={() => setKind(k.kind)}>
              <span style={{ fontSize: 26 }}>{k.icon}</span>
              <span className="t-name">{k.name}</span>
              <span className="t-sub">{k.sub}</span>
            </button>
          ))}
        </div>
      </Page>
    );
  }

  return (
    <Page
      title={TITLES[kind]}
      back={initial ? true : undefined}
      actions={initial ? undefined : <button className="btn ghost" onClick={() => setKind(null)}>Назад к выбору</button>}
    >
      <SpendForm kind={kind} onDone={() => setDone(true)} />
    </Page>
  );
}

function SpendForm({ kind, onDone }: { kind: Kind; onDone: () => void }) {
  const [params] = useSearchParams();
  const qc = useQueryClient();
  const accounts = useAccounts();
  const owners = useOwners();
  const products = useProducts();
  const settings = useSettings();
  const payout = usePayout();

  const reserves = useQuery({
    queryKey: ['reserve_items_active'],
    queryFn: () => q<{ id: string; title: string; bucket: string; remaining: number }[]>(
      supabase.from('v_reserves').select('id,title,bucket,remaining').eq('active', true).order('title')),
  });
  const categories = useQuery({
    queryKey: ['expense_categories'],
    queryFn: () => q<{ name: string; class: string; sort: number }[]>(supabase.from('expense_categories').select('*').order('sort')),
  });
  const needOrders = kind === 'materials' || kind === 'print';
  const orders = useQuery({
    queryKey: ['orders_open_pick'],
    enabled: needOrders,
    queryFn: () => q<OrderOpt[]>(
      supabase.from('orders').select('id,number,title,client_name,status').in('status', ['new', 'assembled']).order('number', { ascending: false })),
  });

  const [amount, setAmount] = useState('');
  const [accountId, setAccountId] = useState<string | null>(null);
  const [at, setAt] = useState(nowLocalInput());
  const [note, setNote] = useState('');
  const [reserveId, setReserveId] = useState('');
  const [orderId, setOrderId] = useState(params.get('order') ?? '');
  const [supplier, setSupplier] = useState('');
  const [category, setCategory] = useState('');
  const [ownerId, setOwnerId] = useState<string | null>(null);
  const [litres, setLitres] = useState('5250');
  const [label, setLabel] = useState('Печать');
  const [mistake, setMistake] = useState(false);
  const keyRef = useRef(1);
  const [lines, setLines] = useState<Line[]>(() => [
    { key: 0, product_id: params.get('product') ?? '', qty: '', amount: '' },
  ]);
  const ack = useRef(false);

  const isOwnerKind = kind === 'withdrawal' || kind === 'contribution';
  const isDelivery = kind === 'delivery';
  const materialProducts = useMemo(
    () => (products.data ?? []).filter((p) => p.active && p.kind !== 'helium'),
    [products.data]);
  const linesTotal = lines.reduce((s, l) => s + amountOf(l.amount), 0);
  const shownAmount = kind === 'materials' ? linesTotal : amountOf(amount);
  const can = payout.data && ownerId ? payout.data.owners[ownerId]?.can_take ?? 0 : null;

  const s = useSubmit(async (requestId) => {
    const occurred_at = localInputToISO(at);
    const base = { occurred_at, account_id: accountId ?? '', reserve_item_id: reserveId || null };
    const description = note.trim();
    const sup = supplier.trim();
    let r: unknown;
    if (kind === 'materials') {
      r = await rpc('record_purchase', {
        p_request_id: requestId,
        p: {
          ...base, supplier: sup, note: description,
          lines: lines.filter((l) => l.product_id || l.qty || l.amount).map((l) => ({
            product_id: l.product_id, qty: amountOf(l.qty), amount: amountOf(l.amount), order_id: orderId || null,
          })),
        },
      });
    } else if (kind === 'helium') {
      r = await rpc('record_purchase', {
        p_request_id: requestId,
        p: {
          ...base, supplier: sup, note: description, helium_refill: true,
          lines: [{ product_id: settings.data?.helium_product_id ?? '', qty: amountOf(litres), amount: amountOf(amount) }],
        },
      });
    } else if (kind === 'print') {
      r = await rpc('add_order_cost', {
        p_request_id: requestId,
        p: { order_id: orderId, kind: 'service', label: label.trim() || 'Печать', amount: amountOf(amount),
          supplier: sup, account_id: accountId ?? '', occurred_at, is_mistake: mistake },
      });
    } else if (isOwnerKind) {
      r = await rpc('record_owner_flow', {
        p_request_id: requestId,
        p: { kind, owner_id: ownerId ?? '', amount: amountOf(amount), account_id: accountId ?? '', occurred_at,
          note: description, over_limit_ack: ack.current },
      });
    } else {
      const cls = kind === 'equipment' ? 'equipment' : kind === 'tax' ? 'tax' : kind === 'personal' ? 'personal' : 'opex';
      const cat = kind === 'equipment' ? 'Оборудование' : kind === 'tax' ? 'Налоги'
        : kind === 'personal' ? '' : kind === 'other' || isDelivery ? category : OPEX_FIXED[kind] ?? '';
      r = await rpc('record_expense', {
        p_request_id: requestId,
        p: { ...base, class: cls, category: cat, description, amount: amountOf(amount),
          owner_id: kind === 'personal' ? ownerId ?? '' : '' },
      });
    }
    ack.current = false;
    return r;
  }, () => { qc.invalidateQueries(); onDone(); });

  if (accounts.isLoading || settings.isLoading) return <Loading />;

  const opexCats = (categories.data ?? []).filter((c) => c.class === 'opex');
  const deliveryCats = opexCats.filter((c) => c.name === 'Доставка' || c.name === 'Такси');
  const amountErr = s.errorFor('amount', 'amount_over');

  const setLine = (key: number, patch: Partial<Line>) =>
    setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...patch } : l)));

  return (
    <>
      {kind === 'materials' && (
        <Card>
          <h3>Что купили</h3>
          {lines.map((l, i) => (
            <div key={l.key} className="line-item" style={{ flexDirection: 'column', alignItems: 'stretch' }}>
              <Field label={lines.length > 1 ? `Товар ${i + 1}` : 'Товар'}>
                <select value={l.product_id} onChange={(e) => setLine(l.key, { product_id: e.target.value })}>
                  <option value="">Выберите из каталога…</option>
                  {materialProducts.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                </select>
              </Field>
              <Field label={`Сколько, ${materialProducts.find((p) => p.id === l.product_id)?.unit ?? 'шт'}`}>
                <input inputMode="decimal" value={l.qty} placeholder="0"
                  onChange={(e) => setLine(l.key, { qty: e.target.value.replace(/[^\d.,]/g, '') })} />
              </Field>
              <Field label="Сколько заплатили за эту позицию">
                <MoneyInput value={l.amount} onChange={(v) => setLine(l.key, { amount: v })} autoFocus={i === 0 && !l.product_id} />
              </Field>
              {lines.length > 1 && (
                <button className="btn ghost" onClick={() => setLines((ls) => ls.filter((x) => x.key !== l.key))}>Убрать позицию</button>
              )}
            </div>
          ))}
          {s.errorFor('lines') && <div className="field-error" role="alert">{s.errorFor('lines')}</div>}
          <button className="btn block"
            onClick={() => setLines((ls) => [...ls, { key: keyRef.current++, product_id: '', qty: '', amount: '' }])}>
            + Добавить ещё товар
          </button>
          <p className="big-number" style={{ fontSize: 24 }}>Итого: {tg(linesTotal)}</p>
          {amountErr && <div className="field-error" role="alert">{amountErr}</div>}
        </Card>
      )}

      {kind === 'helium' && (
        <Card>
          <Field label="Сколько литров">
            <input inputMode="decimal" value={litres} onChange={(e) => setLitres(e.target.value.replace(/[^\d.,]/g, ''))} />
          </Field>
          <Field label="Сколько заплатили" error={amountErr}>
            <MoneyInput value={amount} onChange={setAmount} autoFocus />
          </Field>
          {amountOf(amount) > 0 && amountOf(litres) > 0 && (
            <p className="muted">Выходит {num(Math.round((amountOf(amount) / amountOf(litres)) * 100) / 100)} ₸ за литр.</p>
          )}
          <div className="explain">
            Средняя цена литра считается по заправкам: чем точнее вы записываете каждую заправку, тем точнее себестоимость шаров.
          </div>
          {!settings.data?.helium_product_id && (
            <div className="notice bad">Гелий не выбран в каталоге. Без этого заправку записать нельзя.</div>
          )}
        </Card>
      )}

      {kind === 'print' && (
        <Card>
          <OrderSelect orders={orders.data} value={orderId} onChange={setOrderId} error={s.errorFor('order')} />
          <Field label="Что сделали">
            <input value={label} onChange={(e) => setLabel(e.target.value)} />
          </Field>
          <Field label="Сколько заплатили" error={amountErr}>
            <MoneyInput value={amount} onChange={setAmount} autoFocus />
          </Field>
          <Field label="Кому заплатили (необязательно)">
            <input value={supplier} onChange={(e) => setSupplier(e.target.value)} placeholder="Например, типография" />
          </Field>
          <label className="check">
            <input type="checkbox" checked={mistake} onChange={(e) => setMistake(e.target.checked)} />
            Сделали по ошибке / брак
          </label>
          <div className="explain">Сумма войдёт только в себестоимость этого заказа — не в склад и не в расходы.</div>
        </Card>
      )}

      {(kind === 'ads' || kind === 'rent' || kind === 'fees' || kind === 'other' || isDelivery || kind === 'equipment' || kind === 'tax' || kind === 'personal') && (
        <Card>
          {kind === 'other' && (
            <Field label="На что потратили" error={s.errorFor('category')}>
              <select value={category} onChange={(e) => setCategory(e.target.value)}>
                <option value="">Выберите…</option>
                {opexCats.map((c) => <option key={c.name} value={c.name}>{c.name}</option>)}
              </select>
            </Field>
          )}
          {isDelivery && (
            <Field label="Что именно" error={s.errorFor('category')}>
              <div className="choice-row">
                {(deliveryCats.length ? deliveryCats : [{ name: 'Доставка' }, { name: 'Такси' }]).map((c) => (
                  <button type="button" key={c.name} className={`choice ${category === c.name ? 'on' : ''}`} onClick={() => setCategory(c.name)}>{c.name}</button>
                ))}
              </div>
            </Field>
          )}
          {kind === 'personal' && (
            <OwnerPick owners={owners.data} value={ownerId} onChange={setOwnerId} shared />
          )}
          <Field label="Сумма" error={amountErr}>
            <MoneyInput value={amount} onChange={setAmount} autoFocus />
          </Field>
          {kind === 'equipment' && (
            <div className="explain">Оборудование не считается расходом в прибыли — оно показывается отдельно как вложение в бизнес.</div>
          )}
          {kind === 'personal' && (
            <div className="explain">Эта сумма считается деньгами, которые владелец уже взял. «Общая» делится по долям владельцев.</div>
          )}
        </Card>
      )}

      {isOwnerKind && (
        <Card>
          <OwnerPick owners={owners.data} value={ownerId} onChange={setOwnerId} error={s.errorFor('owner')} />
          {kind === 'withdrawal' && ownerId && (
            <p className="muted">Сейчас можно взять: <b>{tg(can ?? 0)}</b></p>
          )}
          <Field label="Сумма" error={amountErr}
            action={s.errorFor('amount_over') ? (
              <button type="button" className="btn danger" onClick={() => { ack.current = true; s.submit(); }}>Взять всё равно</button>
            ) : undefined}>
            <MoneyInput value={amount} onChange={setAmount} autoFocus />
          </Field>
          {kind === 'contribution' && <div className="explain">Внесённые деньги увеличивают остаток на счёте. Прибыль они не меняют.</div>}
        </Card>
      )}

      {kind === 'materials' && (
        <Card>
          <OrderSelect orders={orders.data} value={orderId} onChange={setOrderId} optional />
          <Field label="Где купили (необязательно)">
            <input value={supplier} onChange={(e) => setSupplier(e.target.value)} />
          </Field>
        </Card>
      )}
      {kind === 'helium' && (
        <Card>
          <Field label="Где заправляли (необязательно)">
            <input value={supplier} onChange={(e) => setSupplier(e.target.value)} />
          </Field>
        </Card>
      )}

      <Card>
        <Field label={kind === 'contribution' ? 'На какой счёт положили' : kind === 'withdrawal' ? 'С какого счёта взяли' : 'С какого счёта платили'} error={s.errorFor('account')}>
          <AccountPicker accounts={accounts.data} value={accountId} onChange={setAccountId} showBalance />
        </Field>
        <Field label="Когда" hint="Если запись за другой день — поменяйте дату">
          <input type="datetime-local" value={at} onChange={(e) => setAt(e.target.value)} />
        </Field>
        <Field label="Коротко: что это (необязательно)">
          <input value={note} onChange={(e) => setNote(e.target.value)} />
        </Field>
        {!isOwnerKind && kind !== 'print' && (reserves.data?.length ?? 0) > 0 && (
          <Field label="Это оплата из плана?" hint="Тогда резерв уменьшится, и деньги не зарезервированы дважды">
            <select value={reserveId} onChange={(e) => setReserveId(e.target.value)}>
              <option value="">Нет, обычная трата</option>
              {reserves.data!.map((r) => <option key={r.id} value={r.id}>{r.title} (осталось {tg(r.remaining)})</option>)}
            </select>
          </Field>
        )}
      </Card>

      <SubmitBar label={`Записать ${shownAmount > 0 ? tg(shownAmount) : ''}`.trim()} busy={s.busy}
        onClick={() => { ack.current = false; s.submit(); }}
        error={s.generalError ?? s.errorFor('class', 'kind')} />
    </>
  );
}

function OrderSelect({ orders, value, onChange, error, optional }: {
  orders: OrderOpt[] | undefined; value: string; onChange: (v: string) => void; error?: string | null; optional?: boolean;
}) {
  return (
    <Field label={optional ? 'Для заказа (необязательно)' : 'Для какого заказа'} error={error}
      hint={optional ? 'Если купили под конкретный заказ — товар сразу закрепится за ним' : undefined}>
      <select value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">{optional ? 'Не для заказа, на склад' : 'Выберите заказ…'}</option>
        {(orders ?? []).map((o) => (
          <option key={o.id} value={o.id}>№{o.number} · {o.client_name || o.title}</option>
        ))}
      </select>
    </Field>
  );
}

function OwnerPick({ owners, value, onChange, shared, error }: {
  owners: { id: string; name: string }[] | undefined; value: string | null; onChange: (v: string | null) => void;
  shared?: boolean; error?: string | null;
}) {
  return (
    <Field label={shared ? 'Чья трата' : 'Кто'} error={error}>
      <div className="choice-row">
        {shared && (
          <button type="button" className={`choice ${value === null ? 'on' : ''}`} onClick={() => onChange(null)}>Общая (пополам)</button>
        )}
        {(owners ?? []).map((o) => (
          <button type="button" key={o.id} className={`choice ${value === o.id ? 'on' : ''}`} onClick={() => onChange(o.id)}>{o.name}</button>
        ))}
      </div>
    </Field>
  );
}
