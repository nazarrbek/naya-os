import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '../lib/supabase';
import { q, rpc } from '../lib/api';
import { num, pct, tg, when } from '../lib/format';
import { useSettings, useStock, type StockRow } from '../lib/data';
import { amountOf, Approx, Badge, Card, Empty, Field, Loading, Page, Photo, Sheet, SubmitBar, useSubmit } from '../components/ui';

type Cylinder = { id: string; started_at: string; nominal_l: number; start_is_estimate: boolean; note: string | null };
type EndResult = { nominal_l: number; used_by_orders_l: number; real_used_l: number; ratio: number | null };

export default function Stock() {
  const nav = useNavigate();
  const stock = useStock();
  const settings = useSettings();
  const [search, setSearch] = useState('');

  const active = (stock.data ?? []).filter((r) => r.active);
  const rows = active.filter((r) => r.kind !== 'helium');
  const helium = (stock.data ?? []).find((r) => r.product_id === settings.data?.helium_product_id);
  const needle = search.trim().toLowerCase();
  const shown = rows.filter((r) => !needle || r.name.toLowerCase().includes(needle));
  const groups = new Map<string, StockRow[]>();
  for (const r of shown) {
    const k = r.category || 'Без категории';
    groups.set(k, [...(groups.get(k) ?? []), r]);
  }
  const total = active.reduce((s, r) => s + Number(r.value), 0);
  const totalApprox = active.some((r) => r.cost_is_estimate && Number(r.physical) !== 0);

  return (
    <Page title="Склад">
      <HeliumCard helium={helium} />
      <div className="btn-row" style={{ marginBottom: 12 }}>
        <button className="btn" onClick={() => nav('/stock/count')}>Пересчитать склад</button>
        <button className="btn" onClick={() => nav('/spend?kind=materials')}>Записать покупку</button>
      </div>
      <div className="field">
        <input className="input" type="search" placeholder="Найти товар" value={search} onChange={(e) => setSearch(e.target.value)} />
      </div>
      {stock.isLoading ? <Loading /> : null}
      {!stock.isLoading && shown.length === 0 ? <Empty>Ничего не найдено</Empty> : null}
      {[...groups.entries()].map(([cat, items]) => (
        <section key={cat}>
          <h3>{cat}</h3>
          <Card>
            {items.map((r) => <StockItem key={r.product_id} r={r} />)}
          </Card>
        </section>
      ))}
      <Card>
        <div className="row">
          <div className="row-main"><span className="row-label">Всего на складе</span></div>
          <span className="row-value strong">{totalApprox ? '≈ ' : ''}{tg(total)}</span>
          <Approx show={totalApprox} />
        </div>
        <details className="more">
          <summary>Что такое «Средняя цена закупки»?</summary>
          <div className="explain">
            <b>Средняя цена закупки</b> — средняя цена всех поступлений: начального остатка и покупок на склад.
            Покупки, сделанные под конкретный заказ, сюда не входят — они идут в себестоимость этого заказа.
            Если цена у части товара ещё не известна, сумма помечена «примерно».
          </div>
        </details>
      </Card>
    </Page>
  );
}

function StockItem({ r }: { r: StockRow }) {
  const nav = useNavigate();
  const short = Number(r.available) < 0;
  const low = !short && r.min_stock != null && Number(r.physical) <= Number(r.min_stock);
  return (
    <div className="line-item" role="link" style={{ cursor: 'pointer' }} onClick={() => nav(`/catalog/${r.product_id}`)}>
      <Photo path={r.photo_path} alt={r.name} />
      <div className="li-body">
        <div className="li-title">{r.name}</div>
        <div className="li-meta">
          <span>есть {num(r.physical)} {r.unit}</span>
          <span>свободно {num(r.available)}</span>
          {Number(r.reserved) > 0 ? <span>{num(r.reserved)} под заказы</span> : null}
        </div>
        {short ? <div style={{ marginTop: 4 }}><Badge tone="bad">не хватает {num(-Number(r.available))}</Badge></div> : null}
        {low ? <div style={{ marginTop: 4 }}><Badge tone="warn">заканчивается</Badge></div> : null}
      </div>
    </div>
  );
}

function HeliumCard({ helium }: { helium: StockRow | undefined }) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [left, setLeft] = useState('');
  const [result, setResult] = useState<EndResult | null>(null);
  const cyl = useQuery({
    queryKey: ['helium_cylinder_current'],
    queryFn: async () => {
      const r = await q<Cylinder[]>(
        supabase.from('helium_cylinders').select('*').is('ended_at', null).order('started_at', { ascending: false }).limit(1),
      );
      return r[0] ?? null;
    },
  });
  const form = useSubmit(
    (requestId) => rpc<EndResult>('end_helium_cylinder', { p_request_id: requestId, p_left_l: amountOf(left) }),
    (r) => {
      setResult(r);
      qc.invalidateQueries();
    },
  );
  const c = cyl.data;
  const close = () => { setOpen(false); setResult(null); setLeft(''); form.clearError(); };

  return (
    <Card>
      <div className="muted small">Примерный остаток</div>
      <div className="big-number">Гелий ≈ {helium ? num(Math.round(Number(helium.physical))) : '—'} л</div>
      <div className="muted small" style={{ marginTop: 4 }}>
        Манометра нет — остаток считается по заказам, поэтому он всегда примерный.
      </div>
      {c ? (
        <div className="small" style={{ marginTop: 8 }}>
          Баллон с {when(c.started_at, false)}: {num(c.nominal_l)} л {c.start_is_estimate ? <Approx show>на глаз</Approx> : null}
        </div>
      ) : (
        <div className="small muted" style={{ marginTop: 8 }}>Нет активного баллона — запишите заправку.</div>
      )}
      <div className="spacer" />
      <button className="btn block" onClick={() => setOpen(true)} disabled={!c}>Баллон пуст</button>

      <Sheet open={open} onClose={close} title="Баллон пуст">
        {result ? <EndSummary r={result} onClose={close} /> : (
          <>
            <Field label="Сколько литров осталось, л (если знаете)" hint="Если оставить пустым — считаем, что 0 л" error={form.errorFor('p_left_l', 'left_l')}>
              <input inputMode="decimal" value={left} placeholder="0" onChange={(e) => setLeft(e.target.value)} />
            </Field>
            <p className="muted small">Сравним, сколько гелия списано по заказам и сколько ушло на самом деле.</p>
            <SubmitBar label="Закрыть баллон" busy={form.busy} onClick={form.submit} error={form.generalError} />
          </>
        )}
      </Sheet>
    </Card>
  );
}

function EndSummary({ r, onClose }: { r: EndResult; onClose: () => void }) {
  const used = Number(r.used_by_orders_l);
  const real = Number(r.real_used_l);
  const ratio = r.ratio != null ? Number(r.ratio) : null;
  let verdict: string | null = null;
  if (ratio != null) {
    const d = Math.abs(ratio - 1);
    verdict = d < 0.03
      ? 'Нормы почти совпали с реальным расходом.'
      : `Нормы ${ratio > 1 ? 'занижены' : 'завышены'} примерно на ${pct(d)} — уточните нормы гелия.`;
  }
  return (
    <>
      <div className="notice info">
        <div>
          По заказам списано {num(Math.round(used))} л из ≈{num(Math.round(real))} л.{' '}
          {verdict ?? 'Заказов с гелием в этом баллоне не было.'}
        </div>
      </div>
      <div className="btn-row">
        <Link className="btn" to="/catalog" onClick={onClose}>Открыть каталог</Link>
        <button className="btn primary" onClick={onClose}>Готово</button>
      </div>
    </>
  );
}
