import { Link, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '../lib/supabase';
import { q } from '../lib/api';
import { useAccounts, useAttention, useMe, type OrderRow } from '../lib/data';
import { addDays, tg, todayISO, when } from '../lib/format';
import { Badge, Card, Empty, Page } from '../components/ui';
import { useState } from 'react';

export function useUpcomingOrders() {
  return useQuery({
    queryKey: ['orders', 'upcoming'],
    queryFn: () =>
      q<OrderRow[]>(
        supabase.from('v_orders').select('*').in('status', ['new', 'assembled'])
          .lt('due_at', `${addDays(todayISO(), 2)}T00:00:00+05:00`).order('due_at'),
      ),
  });
}

export default function Home() {
  const nav = useNavigate();
  const me = useMe();
  const upcoming = useUpcomingOrders();
  const attention = useAttention();
  const accounts = useAccounts();
  const [allAttention, setAllAttention] = useState(false);
  const [showReview, setShowReview] = useState(false);
  const total = (accounts.data ?? []).reduce((s, a) => s + Number(a.balance), 0);
  // notes about data moved from the old spreadsheet are folded into one line
  const items = (attention.data ?? []).filter((a) => a.tone !== 'review');
  const review = (attention.data ?? []).filter((a) => a.tone === 'review');
  const shown = allAttention ? items : items.slice(0, 4);

  return (
    <Page title={`Привет${me.data ? `, ${me.data.name}` : ''}!`}>
      <div className="main-actions">
        <button className="big-action primary" onClick={() => nav('/orders/new')}><span className="ico">🎈</span>Новый заказ</button>
        <button className="big-action" onClick={() => nav('/spend')}><span className="ico">🧾</span>Записать трату</button>
        <button className="big-action" onClick={() => nav('/transfer')}><span className="ico">🔁</span>Перевести деньги</button>
      </div>

      <h2>Выдать сегодня и завтра</h2>
      {upcoming.data && upcoming.data.length === 0 ? <Empty>Заказов на сегодня и завтра нет</Empty> : null}
      {(upcoming.data ?? []).map((o) => <OrderCard key={o.id} o={o} />)}

      {items.length > 0 || review.length > 0 ? (
        <>
          <h2>Требует внимания</h2>
          {shown.map((a, i) => (
            <Link key={i} to={a.link} className={`notice ${a.tone}`}>
              <span style={{ flex: 1 }}>{a.text}</span>
              <span className="act">→ {a.action}</span>
            </Link>
          ))}
          {items.length > 4 ? (
            <button className="btn ghost" onClick={() => setAllAttention(!allAttention)}>
              {allAttention ? 'Свернуть' : `Ещё ${items.length - 4}`}
            </button>
          ) : null}
          {review.length > 0 ? (
            <button className="notice review" style={{ width: '100%', border: 0, textAlign: 'left' }} onClick={() => setShowReview(!showReview)}>
              <span style={{ flex: 1 }}>Проверить данные, перенесённые из таблицы: {review.length}</span>
              <span className="act">{showReview ? 'свернуть' : '→ открыть'}</span>
            </button>
          ) : null}
          {showReview ? review.map((a, i) => (
            <Link key={`r${i}`} to={a.link} className="notice review" style={{ fontSize: 15 }}>
              <span style={{ flex: 1 }}>{a.text}</span>
              <span className="act">→</span>
            </Link>
          )) : null}
        </>
      ) : null}

      <h2>Деньги сейчас</h2>
      <Card onClick={() => nav('/money')}>
        <div className="muted small">Все счета</div>
        <div className="big-number">{tg(total)}</div>
        <div className="small muted">
          {(accounts.data ?? []).filter((a) => Number(a.balance) !== 0).map((a) => `${a.name} ${tg(a.balance)}`).join(' · ')}
        </div>
      </Card>
    </Page>
  );
}

export function OrderCard({ o }: { o: OrderRow }) {
  const nav = useNavigate();
  const overdue = o.due_at && new Date(o.due_at).getTime() < Date.now() - 3 * 3600_000 && (o.status === 'new' || o.status === 'assembled');
  return (
    <Card onClick={() => nav(`/orders/${o.id}`)}>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
        <div style={{ minWidth: 0 }}>
          <div className={overdue ? '' : 'muted'} style={{ fontSize: 15, color: overdue ? 'var(--bad)' : undefined }}>
            {when(o.due_at)}{o.delivery === 'delivery' ? ' · доставка' : ''}{o.status === 'assembled' ? ' · собран' : ''}
          </div>
          <div style={{ fontWeight: 650 }}>№{o.number} {o.title}</div>
          {o.client_name ? <div className="small muted">{o.client_name}</div> : null}
        </div>
        <div style={{ textAlign: 'right', flex: 'none' }}>
          {o.status === 'cancelled' ? <Badge>Отменён</Badge>
            : o.payment_status === 'unknown' ? <Badge>до запуска</Badge>
            : Number(o.due) > 0 ? <><div className="small muted">осталось</div><div style={{ fontWeight: 700 }}>{tg(o.due)}</div></>
            : <Badge tone="ok">оплачен</Badge>}
        </div>
      </div>
      {o.helium_missing ? <div className="small" style={{ color: 'var(--warn)', marginTop: 6 }}>Не указан расход гелия</div> : null}
    </Card>
  );
}
