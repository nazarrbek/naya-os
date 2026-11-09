import { useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '../lib/supabase';
import { q, rpc } from '../lib/api';
import { num, parseAmount } from '../lib/format';
import { useProducts, useSettings, useStock } from '../lib/data';
import { Badge, Card, Empty, Loading, Page, Photo, SubmitBar, useSubmit } from '../components/ui';

const HELIUM_HINT = '≈5 250 л со слов продавца, без манометра';

export default function InventoryCount() {
  const nav = useNavigate();
  const qc = useQueryClient();
  const [params] = useSearchParams();
  const wantOpening = params.get('opening') === '1';
  const products = useProducts();
  const stock = useStock();
  const settings = useSettings();
  const existingOpening = useQuery({
    queryKey: ['inventory_opening_exists'],
    queryFn: async () => (await q<{ id: string }[]>(supabase.from('inventory_counts').select('id').eq('is_opening', true).limit(1))).length > 0,
  });
  const [counted, setCounted] = useState<Record<string, string>>({});
  const [costs, setCosts] = useState<Record<string, string>>({});
  const [confirm, setConfirm] = useState(false);
  const note = '';

  const isOpening = wantOpening && existingOpening.data === false;
  const heliumId = settings.data?.helium_product_id;
  const list = (products.data ?? []).filter((p) => p.active);
  const book = (id: string) => Number(stock.data?.find((s) => s.product_id === id)?.physical ?? 0);
  const costOf = (id: string, ref: number | null) => costs[id] ?? (ref != null ? String(ref) : '');

  const changed = list
    .filter((p) => (counted[p.id] ?? '').trim() !== '' && parseAmount(counted[p.id]) != null)
    .map((p) => ({ p, n: parseAmount(counted[p.id])!, diff: parseAmount(counted[p.id])! - book(p.id) }));
  const diffs = changed.filter((c) => c.diff !== 0);

  const form = useSubmit(
    (requestId) => rpc('record_inventory', {
      p_request_id: requestId,
      p: {
        is_opening: isOpening,
        note: note.trim() || null,
        lines: changed.map(({ p, n }) => {
          const line: Record<string, unknown> = { product_id: p.id, counted: n };
          if (isOpening) {
            const raw = costOf(p.id, p.ref_cost);
            const c = parseAmount(raw);
            if (c != null) line.unit_cost = c;
            // a price left as the reference one is a guess, not a real purchase price
            line.is_estimate = raw === '' || (p.ref_cost != null && c === Number(p.ref_cost));
          }
          return line;
        }),
      },
    }),
    () => {
      qc.invalidateQueries();
      nav('/stock');
    },
  );

  if (products.isLoading || stock.isLoading || existingOpening.isLoading) return <Page title="Пересчёт склада" back><Loading /></Page>;

  if (confirm) {
    return (
      <Page title="Проверьте перед сохранением" back={undefined}>
        {diffs.length === 0 ? (
          <Empty>Расхождений нет — всё совпало с учётом.</Empty>
        ) : (
          <Card>
            {diffs.map(({ p, diff }) => (
              <div className="row" key={p.id}>
                <div className="row-main"><span className="row-label">{p.name}</span></div>
                <Badge tone={diff < 0 ? 'bad' : 'ok'}>{diffText(diff, isOpening)}</Badge>
              </div>
            ))}
          </Card>
        )}
        <p className="muted small">
          {isOpening
            ? 'Это стартовые остатки: они станут началом учёта.'
            : 'Недостачи попадут в потери, излишки добавятся на склад. Исправить потом можно только новым пересчётом.'}
        </p>
        <SubmitBar label="Сохранить" busy={form.busy} onClick={form.submit} error={form.generalError}
          disabled={changed.length === 0} />
        <button className="btn block" style={{ marginTop: 8 }} onClick={() => { setConfirm(false); form.clearError(); }}>Назад к списку</button>
      </Page>
    );
  }

  return (
    <Page title={isOpening ? 'Начальные остатки' : 'Пересчёт склада'} back>
      {wantOpening && existingOpening.data ? (
        <div className="notice">
          <div>
            Начальные остатки уже внесены, второй раз их записать нельзя. Можно сделать обычный пересчёт.{' '}
            <Link className="act" to="/stock/count">Пересчитать</Link>
          </div>
        </div>
      ) : null}
      <p className="muted small">
        Впишите, сколько реально насчитали. Если поле пустое — товар не считали, он не изменится.
      </p>
      {list.length === 0 ? <Empty>В каталоге пока нет товаров</Empty> : null}
      {list.map((p) => {
        const raw = counted[p.id] ?? '';
        const n = parseAmount(raw);
        const diff = n != null ? n - book(p.id) : null;
        const isHelium = p.id === heliumId || p.kind === 'helium';
        return (
          <Card key={p.id}>
            <div className="line-item" style={{ padding: 0, borderBottom: 0 }}>
              <Photo path={p.photo_path} alt={p.name} size={44} />
              <div className="li-body">
                <div className="li-title">{p.name}</div>
                <div className="li-meta"><span>по учёту: {num(book(p.id))} {p.unit}</span></div>
              </div>
            </div>
            <div className="spacer" />
            <label className="field" style={{ marginBottom: 6 }}>
              <span className="field-label">Насчитали, {p.unit}</span>
              <input inputMode="decimal" value={raw} placeholder="не считали"
                onChange={(e) => setCounted({ ...counted, [p.id]: e.target.value.replace(/[^\d.,\s]/g, '') })} />
              {isHelium ? <span className="field-hint">{HELIUM_HINT}</span> : null}
            </label>
            {diff != null && diff !== 0 ? <Badge tone={diff < 0 ? 'bad' : 'ok'}>{diffText(diff, isOpening)}</Badge> : null}
            {diff === 0 ? <Badge tone="ok">совпадает</Badge> : null}
            {isOpening && n != null && n > 0 ? (
              <label className="field" style={{ marginTop: 10, marginBottom: 0 }}>
                <span className="field-label">Цена за единицу, ₸ (необязательно)</span>
                <input inputMode="decimal" value={costOf(p.id, p.ref_cost)} placeholder="не знаю"
                  onChange={(e) => setCosts({ ...costs, [p.id]: e.target.value.replace(/[^\d.,\s]/g, '') })} />
                <span className="field-hint">
                  {p.ref_cost_note || (p.ref_cost != null ? 'Примерная цена из каталога — уточните, если знаете' : 'Без цены себестоимость будет неизвестна')}
                </span>
              </label>
            ) : null}
          </Card>
        );
      })}
      <SubmitBar label={`Дальше${changed.length ? ` (посчитано: ${changed.length})` : ''}`} busy={false}
        disabled={changed.length === 0} onClick={() => setConfirm(true)} />
    </Page>
  );
}

function diffText(diff: number, opening: boolean): string {
  if (opening && diff > 0) return `+${num(diff)} на склад`;
  return `${diff < 0 ? '−' : '+'}${num(Math.abs(diff))}`;
}
