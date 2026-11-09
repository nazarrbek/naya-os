import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '../lib/supabase';
import { q } from '../lib/api';
import type { OrderRow } from '../lib/data';
import { Empty, Loading, Page } from '../components/ui';
import { OrderCard } from './Home';

type Tab = 'active' | 'issued' | 'cancelled';

export default function Orders() {
  const nav = useNavigate();
  const [tab, setTab] = useState<Tab>('active');
  const [search, setSearch] = useState('');
  const list = useQuery({
    queryKey: ['orders', tab],
    queryFn: () => {
      let query = supabase.from('v_orders').select('*');
      if (tab === 'active') query = query.in('status', ['new', 'assembled']).order('due_at', { ascending: true, nullsFirst: false });
      if (tab === 'issued') query = query.eq('status', 'issued').order('issued_at', { ascending: false }).limit(200);
      if (tab === 'cancelled') query = query.eq('status', 'cancelled').order('cancelled_at', { ascending: false }).limit(100);
      return q<OrderRow[]>(query);
    },
  });
  const s = search.trim().toLowerCase();
  const rows = (list.data ?? []).filter((o) =>
    !s || `${o.number} ${o.title} ${o.client_name ?? ''} ${o.client_phone ?? ''}`.toLowerCase().includes(s));

  return (
    <Page title="Заказы" actions={<button className="btn primary" onClick={() => nav('/orders/new')}>+ Новый</button>}>
      <div className="segmented" style={{ marginBottom: 10 }}>
        <button className={tab === 'active' ? 'on' : ''} onClick={() => setTab('active')}>Предстоящие</button>
        <button className={tab === 'issued' ? 'on' : ''} onClick={() => setTab('issued')}>Выданные</button>
        <button className={tab === 'cancelled' ? 'on' : ''} onClick={() => setTab('cancelled')}>Отменённые</button>
      </div>
      <input className="input" placeholder="Поиск: имя, телефон, номер" value={search} onChange={(e) => setSearch(e.target.value)} />
      <div className="spacer" />
      {list.isLoading ? <Loading /> : rows.length === 0 ? <Empty>Здесь пока пусто</Empty> : rows.map((o) => <OrderCard key={o.id} o={o} />)}
    </Page>
  );
}
