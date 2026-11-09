import { useEffect, useState } from 'react';
import { NavLink, Route, Routes } from 'react-router-dom';
import type { Session } from '@supabase/supabase-js';
import { supabase } from './lib/supabase';
import { useLiveUpdates, useMe } from './lib/data';
import Login from './pages/Login';
import Home from './pages/Home';
import Orders from './pages/Orders';
import OrderForm from './pages/OrderForm';
import OrderView from './pages/OrderView';
import Spend from './pages/Spend';
import Transfer from './pages/Transfer';
import Money from './pages/Money';
import Stock from './pages/Stock';
import InventoryCount from './pages/InventoryCount';
import Catalog from './pages/Catalog';
import ProductPage from './pages/ProductPage';
import Templates from './pages/Templates';
import Reports from './pages/Reports';
import Setup from './pages/Setup';
import More from './pages/More';
import { Loading } from './components/ui';

export default function App() {
  const [session, setSession] = useState<Session | null | undefined>(undefined);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => setSession(data.session));
    const { data } = supabase.auth.onAuthStateChange((_e, s) => setSession(s));
    return () => data.subscription.unsubscribe();
  }, []);

  if (session === undefined) return <Loading />;
  if (!session) return <Login />;
  return <Shell />;
}

function Shell() {
  useLiveUpdates();
  const me = useMe();
  if (me.isLoading) return <Loading />;
  if (!me.data) {
    return (
      <div className="login">
        <p className="center">Этот аккаунт не добавлен как владелец NAYA BALLOONS.</p>
        <button className="btn" onClick={() => supabase.auth.signOut()}>Выйти</button>
      </div>
    );
  }
  return (
    <div className="app">
      <Routes>
        <Route path="/" element={<Home />} />
        <Route path="/orders" element={<Orders />} />
        <Route path="/orders/new" element={<OrderForm />} />
        <Route path="/orders/:id" element={<OrderView />} />
        <Route path="/orders/:id/edit" element={<OrderForm />} />
        <Route path="/spend" element={<Spend />} />
        <Route path="/transfer" element={<Transfer />} />
        <Route path="/money" element={<Money />} />
        <Route path="/stock" element={<Stock />} />
        <Route path="/stock/count" element={<InventoryCount />} />
        <Route path="/catalog" element={<Catalog />} />
        <Route path="/catalog/:id" element={<ProductPage />} />
        <Route path="/templates" element={<Templates />} />
        <Route path="/reports" element={<Reports />} />
        <Route path="/setup" element={<Setup />} />
        <Route path="/more" element={<More />} />
        <Route path="*" element={<Home />} />
      </Routes>
      <footer className="tabbar">
        <nav>
          <NavLink to="/" end><span className="ico">🏠</span>Главная</NavLink>
          <NavLink to="/orders"><span className="ico">🎈</span>Заказы</NavLink>
          <NavLink to="/money"><span className="ico">💰</span>Деньги</NavLink>
          <NavLink to="/stock"><span className="ico">📦</span>Склад</NavLink>
          <NavLink to="/more"><span className="ico">☰</span>Ещё</NavLink>
        </nav>
      </footer>
    </div>
  );
}
