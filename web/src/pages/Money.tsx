import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '../lib/supabase';
import { q, rpc } from '../lib/api';
import { dayLabel, num, tg, when } from '../lib/format';
import { useAccounts, usePayout, useSettings, type Account } from '../lib/data';
import { Badge, Card, Empty, Field, Loading, MoneyInput, Page, Row, Sheet, amountOf, useSubmit } from '../components/ui';

const KIND_LABEL: Record<string, string> = {
  client_payment: 'Оплата клиента', client_refund: 'Возврат клиенту', purchase: 'Покупка', order_cost: 'Услуга для заказа',
  expense: 'Трата', owner_withdrawal: 'Взял(а) себе', owner_contribution: 'Внесение', transfer: 'Перевод',
  opening: 'Остаток на старте', adjustment: 'Сверка счёта',
};
const BUCKET_LABEL: Record<string, string> = {
  purchases: 'Будущие закупки', mandatory: 'Обязательные платежи', planned: 'Запланированные траты',
};

type Reserve = {
  id: string; bucket: string; title: string; amount: number; due_date: string | null; active: boolean;
  spent: number; remaining: number;
};
type Movement = {
  id: string; occurred_at: string; account_id: string; amount: number; kind: string; order_id: string | null;
  note: string | null; accounts: { name: string } | { name: string }[] | null;
};

export default function Money() {
  const nav = useNavigate();
  const accounts = useAccounts();
  const [reconcile, setReconcile] = useState<Account | null>(null);

  const moves = useQuery({
    queryKey: ['money_movements_recent'],
    queryFn: () => q<Movement[]>(
      supabase.from('money_movements').select('id,occurred_at,account_id,amount,kind,order_id,note,accounts(name)')
        .order('occurred_at', { ascending: false }).limit(50)),
  });

  if (accounts.isLoading) return <Loading />;
  const total = (accounts.data ?? []).filter((a) => a.active).reduce((s, a) => s + Number(a.balance), 0);

  return (
    <Page title="Деньги">
      <Card>
        <div className="muted">Всего денег</div>
        <div className="big-number">{tg(total)}</div>
        {(accounts.data ?? []).filter((a) => a.active).map((a) => (
          <div key={a.account_id} className="row">
            <div className="row-main"><span className="row-label">{a.name}</span></div>
            <span className="row-value strong">{tg(a.balance)}</span>
            <button className="btn ghost" onClick={() => setReconcile(a)}>Сверить</button>
          </div>
        ))}
      </Card>

      <div className="btn-row">
        <button className="btn primary" onClick={() => nav('/spend')}>Записать трату</button>
        <button className="btn" onClick={() => nav('/transfer')}>Перевести</button>
        <button className="btn" onClick={() => nav('/spend?kind=withdrawal')}>Взять себе</button>
      </div>

      <PayoutSection />
      <ReservesSection />

      <h2>Последние движения</h2>
      <Card>
        {moves.isLoading ? <Loading /> : (moves.data ?? []).length === 0 ? <Empty>Пока нет движений денег</Empty> :
          moves.data!.map((m) => (
            <Row key={m.id}
              to={m.order_id ? `/orders/${m.order_id}` : undefined}
              label={KIND_LABEL[m.kind] ?? m.kind}
              sub={[Array.isArray(m.accounts) ? m.accounts[0]?.name : m.accounts?.name, when(m.occurred_at), m.note].filter(Boolean).join(' · ')}
              value={<span style={{ color: m.amount < 0 ? 'var(--bad)' : undefined }}>{m.amount > 0 ? '+' : ''}{tg(m.amount)}</span>} />
          ))}
      </Card>

      <ReconcileSheet account={reconcile} onClose={() => setReconcile(null)} />
    </Page>
  );
}

function PayoutSection() {
  const payout = usePayout();
  const p = payout.data;
  return (
    <>
      <h2>Можно забрать себе</h2>
      {!p ? <Loading /> : (
        <Card>
          <div className="kpis">
            {Object.entries(p.owners).map(([id, o]) => (
              <div key={id} className="kpi">
                <div className="k">{o.name}</div>
                <div className="v">{tg(o.can_take)}</div>
                <div className="small muted">уже получил(а): {tg(o.taken)}</div>
              </div>
            ))}
          </div>
          <details className="more">
            <summary>Как это посчитано</summary>
            <div className="explain">
              <p><b>1. Свободные деньги.</b> Все деньги на счетах {tg(p.money)}
                {' '}− резервы {tg(p.reserves)} = <b>{tg(p.free)}</b>.</p>
              <ul>
                <li>Будущие закупки: {tg(p.reserve_purchases)}</li>
                <li>Обязательные платежи: {tg(p.reserve_mandatory)}</li>
                <li>Запланированные траты: {tg(p.reserve_planned)}</li>
                <li>Минимальный резерв бизнеса: {tg(p.reserve_minimum)}</li>
              </ul>
              <p><b>2. Нераспределённая прибыль.</b> Прибыль с даты запуска ({dayLabel(p.launch_date)}) {tg(p.profit_since_launch)}
                {' '}+ прибыль на старте {tg(p.opening_retained)} − уже получено владельцами {tg(p.draws)} = <b>{tg(p.retained)}</b>.</p>
              <p><b>3. Всего можно распределить:</b> меньшее из двух чисел — <b>{tg(p.distributable)}</b>.
                {' '}{p.limited_by === 'money'
                  ? 'Сейчас ограничивают свободные деньги: прибыли больше, чем денег сверх резервов.'
                  : 'Сейчас ограничивает прибыль: свободных денег больше, чем заработано.'}</p>
              <p><b>4. Доля каждого.</b> У каждого владельца своя доля
                {' '}({Object.values(p.owners).map((o) => `${o.name} — ${Math.round(o.share * 100)}%`).join(', ')}).
                Из его доли вычитается то, что он уже взял.</p>
              {p.contributions > 0 && <p className="small">Внесённые своими деньгами ({tg(p.contributions)}) на прибыль не влияют.</p>}
            </div>
          </details>
        </Card>
      )}
    </>
  );
}

function ReservesSection() {
  const qc = useQueryClient();
  const settings = useSettings();
  const reserves = useQuery({
    queryKey: ['v_reserves'],
    queryFn: () => q<Reserve[]>(supabase.from('v_reserves').select('*').order('bucket').order('title')),
  });
  const [edit, setEdit] = useState<Partial<Reserve> | null>(null);
  const [minOpen, setMinOpen] = useState(false);

  async function toggle(r: Reserve) {
    await supabase.from('reserve_items').update({ active: !r.active }).eq('id', r.id);
    qc.invalidateQueries();
  }

  return (
    <>
      <h2>Резервы</h2>
      <Card>
        <div className="explain" style={{ marginTop: 0 }}>
          Резерв — деньги, которые уже «заняты» планами и не считаются свободными. Когда вы платите с пометкой
          «Это оплата из плана», резерв уменьшается — деньги не резервируются дважды.
        </div>
        <Row label="Минимальный резерв бизнеса" value={tg(settings.data?.minimum_reserve ?? 0)} sub="Запас, который всегда остаётся в бизнесе" />
        <button className="btn ghost" onClick={() => setMinOpen(true)}>Изменить минимальный резерв</button>
        {(['purchases', 'mandatory', 'planned'] as const).map((b) => {
          const items = (reserves.data ?? []).filter((r) => r.bucket === b);
          return (
            <div key={b}>
              <h3>{BUCKET_LABEL[b]}</h3>
              {items.length === 0 ? <p className="muted small">Пусто</p> : items.map((r) => (
                <div key={r.id} className="line-item">
                  <div className="li-body">
                    <div className="li-title">{r.title} {!r.active && <Badge>выключено</Badge>}</div>
                    <div className="li-meta">
                      <span>Осталось {tg(r.remaining)}</span>
                      <span>из {tg(r.amount)}</span>
                      <span>потрачено {tg(r.spent)}</span>
                      {r.due_date && <span>к {dayLabel(r.due_date)}</span>}
                    </div>
                  </div>
                  <button className="btn ghost" onClick={() => setEdit(r)}>Изменить</button>
                  <button className="btn ghost" onClick={() => toggle(r)}>{r.active ? 'Выключить' : 'Включить'}</button>
                </div>
              ))}
            </div>
          );
        })}
        <button className="btn block" onClick={() => setEdit({ bucket: 'planned', title: '', amount: 0, active: true })}>+ Добавить в резерв</button>
      </Card>
      <ReserveSheet item={edit} onClose={() => setEdit(null)} />
      <MinReserveSheet open={minOpen} onClose={() => setMinOpen(false)} current={settings.data?.minimum_reserve ?? 0} />
    </>
  );
}

function ReserveSheet({ item, onClose }: { item: Partial<Reserve> | null; onClose: () => void }) {
  return (
    <Sheet open={!!item} onClose={onClose} title={item?.id ? 'Изменить резерв' : 'Новый резерв'}>
      {item && <ReserveForm key={item.id ?? 'new'} item={item} onClose={onClose} />}
    </Sheet>
  );
}

function ReserveForm({ item, onClose }: { item: Partial<Reserve>; onClose: () => void }) {
  const qc = useQueryClient();
  const [bucket, setBucket] = useState(item.bucket ?? 'planned');
  const [title, setTitle] = useState(item.title ?? '');
  const [amount, setAmount] = useState(item.amount ? String(item.amount) : '');
  const [due, setDue] = useState(item.due_date ?? '');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function save() {
    if (!title.trim()) return setErr('Напишите название');
    if (amountOf(amount) <= 0) return setErr('Введите сумму');
    setBusy(true);
    const row = { bucket, title: title.trim(), amount: amountOf(amount), due_date: due || null };
    const { error } = item.id
      ? await supabase.from('reserve_items').update(row).eq('id', item.id)
      : await supabase.from('reserve_items').insert(row);
    setBusy(false);
    if (error) return setErr(error.message);
    qc.invalidateQueries();
    onClose();
  }

  return (
    <>
      <Field label="Для чего">
        <div className="choice-row">
          {Object.entries(BUCKET_LABEL).map(([k, v]) => (
            <button type="button" key={k} className={`choice ${bucket === k ? 'on' : ''}`} onClick={() => setBucket(k)}>{v}</button>
          ))}
        </div>
      </Field>
      <Field label="Название"><input value={title} onChange={(e) => setTitle(e.target.value)} /></Field>
      <Field label="Сумма"><MoneyInput value={amount} onChange={setAmount} /></Field>
      <Field label="К какой дате (необязательно)"><input type="date" value={due} onChange={(e) => setDue(e.target.value)} /></Field>
      {err && <div className="form-error" role="alert">{err}</div>}
      <button className="btn primary big block" disabled={busy} onClick={save}>{busy ? 'Сохраняю…' : 'Сохранить'}</button>
    </>
  );
}

function MinReserveSheet({ open, onClose, current }: { open: boolean; onClose: () => void; current: number }) {
  const qc = useQueryClient();
  const [v, setV] = useState(String(current || ''));
  const [err, setErr] = useState<string | null>(null);
  async function save() {
    const { error } = await supabase.from('settings').update({ minimum_reserve: amountOf(v) }).eq('id', true);
    if (error) return setErr(error.message);
    qc.invalidateQueries();
    onClose();
  }
  return (
    <Sheet open={open} onClose={onClose} title="Минимальный резерв бизнеса">
      <Field label="Сколько всегда оставлять в бизнесе" error={err}><MoneyInput value={v} onChange={setV} autoFocus /></Field>
      <button className="btn primary big block" onClick={save}>Сохранить</button>
    </Sheet>
  );
}

function ReconcileSheet({ account, onClose }: { account: Account | null; onClose: () => void }) {
  return (
    <Sheet open={!!account} onClose={onClose} title={account ? `Сверить: ${account.name}` : ''}>
      {account && <ReconcileForm key={account.account_id} account={account} onClose={onClose} />}
    </Sheet>
  );
}

function ReconcileForm({ account, onClose }: { account: Account; onClose: () => void }) {
  const qc = useQueryClient();
  const [real, setReal] = useState('');
  const [reason, setReason] = useState('');
  const s = useSubmit(
    (requestId) => rpc('reconcile_account', { p_request_id: requestId, p_account_id: account.account_id, p_real: amountOf(real), p_note: reason }),
    () => { qc.invalidateQueries(); onClose(); },
  );
  const diff = real ? amountOf(real) - Number(account.balance) : null;
  return (
    <>
      <p className="muted">В учёте сейчас {tg(account.balance)}. Пересчитайте деньги и введите, сколько на самом деле.</p>
      <Field label="Сколько на самом деле" error={s.errorFor('amount')}>
        <MoneyInput value={real} onChange={setReal} autoFocus />
      </Field>
      {diff !== null && diff !== 0 && <p className="muted">Разница: {diff > 0 ? '+' : ''}{tg(diff)} ({num(diff)})</p>}
      <Field label="Причина расхождения" error={s.errorFor('reason')}>
        <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Например: не записали оплату за 03.11" />
      </Field>
      {s.generalError && <div className="form-error" role="alert">{s.generalError}</div>}
      <button className="btn primary big block" disabled={s.busy || !real} onClick={s.submit}>{s.busy ? 'Сохраняю…' : 'Исправить остаток'}</button>
      <p className="small muted">Лучше сначала записать забытые оплаты и траты, а сверкой исправлять только остаток.</p>
    </>
  );
}
