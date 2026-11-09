import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { supabase } from '../lib/supabase';
import { q } from '../lib/api';
import { num, SOURCE_LABEL } from '../lib/format';
import { bestNorm, defaultVariant, useProducts, type Product } from '../lib/data';
import { Badge, Card, Choice, Empty, Field, Loading, MoneyInput, amountOf, Page, Photo, Sheet, SubmitBar, useSubmit } from '../components/ui';

type Tab = 'balloon' | 'material';

export default function Catalog() {
  const products = useProducts();
  const [tab, setTab] = useState<Tab>('balloon');
  const [adding, setAdding] = useState(false);
  const list = (products.data ?? []).filter((p) => (tab === 'balloon' ? p.kind === 'balloon' : p.kind !== 'balloon'));

  return (
    <Page title="Каталог" back="/more" actions={<button className="btn primary" onClick={() => setAdding(true)}>+ Добавить</button>}>
      <div className="segmented" style={{ marginBottom: 12 }}>
        <button className={tab === 'balloon' ? 'on' : ''} onClick={() => setTab('balloon')}>Шары</button>
        <button className={tab === 'material' ? 'on' : ''} onClick={() => setTab('material')}>Материалы</button>
      </div>
      {products.isLoading ? <Loading /> : null}
      {!products.isLoading && list.length === 0 ? <Empty>Здесь пока пусто</Empty> : null}
      <Card>
        {list.map((p) => <CatalogItem key={p.id} p={p} />)}
      </Card>
      <Link className="btn block" to="/templates">Готовые композиции</Link>
      <AddProduct open={adding} onClose={() => setAdding(false)} defaultKind={tab} />
    </Page>
  );
}

function CatalogItem({ p }: { p: Product }) {
  const nav = useNavigate();
  const v = defaultVariant(p);
  const norm = bestNorm(v);
  return (
    <div className="line-item" role="link" style={{ cursor: 'pointer' }} onClick={() => nav(`/catalog/${p.id}`)}>
      <Photo path={p.photo_path} alt={p.name} />
      <div className="li-body">
        <div className="li-title">{p.name} {!p.active ? <Badge>скрыт</Badge> : null}</div>
        <div className="li-meta">
          {p.category ? <span>{p.category}</span> : null}
          {p.kind === 'balloon' && v ? <span>{v.is_unknown ? 'производитель не указан' : v.maker}</span> : null}
        </div>
        {p.kind === 'balloon' ? (
          <div className="li-meta">
            {norm
              ? <span>≈{num(norm.helium_l)} л · {SOURCE_LABEL[norm.source]}</span>
              : <span style={{ color: 'var(--warn)' }}>расход гелия не указан</span>}
          </div>
        ) : null}
      </div>
    </div>
  );
}

function AddProduct({ open, onClose, defaultKind }: { open: boolean; onClose: () => void; defaultKind: Tab }) {
  const nav = useNavigate();
  const qc = useQueryClient();
  const [name, setName] = useState('');
  const [kind, setKind] = useState<Tab>(defaultKind);
  const [category, setCategory] = useState('');
  const [unit, setUnit] = useState('шт.');
  const [price, setPrice] = useState('');
  const [ribbon, setRibbon] = useState('');
  const [nameError, setNameError] = useState<string | null>(null);

  const form = useSubmit(
    async () => {
      if (!name.trim()) {
        setNameError('Впишите название');
        throw new Error('Впишите название');
      }
      const row = await q<{ id: string }>(supabase.from('products').insert({
        name: name.trim(),
        kind,
        category: category.trim() || null,
        unit: unit.trim() || 'шт.',
        ref_cost: price.trim() ? amountOf(price) : null,
        ribbon_m_per_unit: kind === 'balloon' && ribbon.trim() ? amountOf(ribbon) : null,
      }).select('id').single());
      if (kind === 'balloon') {
        await q(supabase.from('variants').insert({ product_id: row.id, maker: 'Другой / неизвестен', is_unknown: true, is_default: true }));
      }
      return row.id;
    },
    (id) => {
      qc.invalidateQueries();
      onClose();
      nav(`/catalog/${id}`);
    },
  );

  // the unique-name index gives a raw database error; say it in plain words
  const dupe = form.error?.message.includes('products_name_uq') || form.error?.message.includes('duplicate');
  const general = dupe ? null : form.generalError && form.generalError !== 'Впишите название' ? form.generalError : null;

  return (
    <Sheet open={open} onClose={onClose} title="Новый товар">
      <Field label="Название" error={nameError ?? (dupe ? 'Товар с таким названием уже есть. Откройте его в списке или измените название.' : null)}>
        <input value={name} onChange={(e) => { setName(e.target.value); setNameError(null); form.clearError(); }} />
      </Field>
      <Field label="Что это">
        <Choice value={kind} onChange={setKind} options={[{ value: 'balloon', label: 'Шар' }, { value: 'material', label: 'Материал' }]} />
      </Field>
      <Field label="Категория" hint="Например: Сердца, Цифры, Ленты">
        <input value={category} onChange={(e) => setCategory(e.target.value)} />
      </Field>
      <Field label="Единица">
        <input value={unit} onChange={(e) => setUnit(e.target.value)} />
      </Field>
      <Field label="Примерная цена закупки" hint="Можно оставить пустой — потом уточните при пересчёте или покупке">
        <MoneyInput value={price} onChange={setPrice} />
      </Field>
      {kind === 'balloon' ? (
        <Field label="Лента на один шар, м" hint="Если лента не нужна — оставьте пустым">
          <input inputMode="decimal" value={ribbon} onChange={(e) => setRibbon(e.target.value)} />
        </Field>
      ) : null}
      <SubmitBar label="Добавить" busy={form.busy} onClick={form.submit} error={general} />
    </Sheet>
  );
}
