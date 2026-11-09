import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '../lib/supabase';
import { AppError, q, rpc } from '../lib/api';
import { num, parseAmount, SOURCE_LABEL, tg, when } from '../lib/format';
import { bestNorm, useMe, useProducts, type Product, type Variant } from '../lib/data';
import {
  Approx, Badge, Card, Choice, Empty, Field, Loading, MoneyInput, Page, Photo, Sheet, SubmitBar, uploadPhoto, useSubmit,
} from '../components/ui';

const KIND_LABEL: Record<string, string> = {
  opening: 'Начальный остаток', purchase: 'Покупка', order_use: 'Списано на заказ', defect: 'Брак',
  adjustment: 'Пересчёт', loss: 'Потеря',
};

const numOrNull = (v: string) => (v.trim() === '' ? null : parseAmount(v));
const show = (v: number | null | undefined) => (v == null ? '' : String(v));

export default function ProductPage() {
  const { id } = useParams();
  const products = useProducts();
  const p = products.data?.find((x) => x.id === id);
  if (products.isLoading) return <Page title="Товар" back="/catalog"><Loading /></Page>;
  if (!p) return <Page title="Товар" back="/catalog"><Empty>Такого товара нет. Вернитесь в каталог и выберите из списка.</Empty></Page>;
  return <ProductEditor key={p.id} p={p} />;
}

function ProductEditor({ p }: { p: Product }) {
  const qc = useQueryClient();
  const [name, setName] = useState(p.name);
  const [refCost, setRefCost] = useState(show(p.ref_cost));
  const [refNote, setRefNote] = useState(p.ref_cost_note ?? '');
  const [wholesale, setWholesale] = useState(show(p.wholesale_cost));
  const [ribbon, setRibbon] = useState(show(p.ribbon_m_per_unit));
  const [minStock, setMinStock] = useState(show(p.min_stock));
  const [active, setActive] = useState(p.active);
  const [saved, setSaved] = useState(false);
  const [photoBusy, setPhotoBusy] = useState(false);
  const [photoError, setPhotoError] = useState<string | null>(null);
  const [variantSheet, setVariantSheet] = useState<Variant | 'new' | null>(null);

  const reviewText = typeof p.source?.review === 'string' ? (p.source.review as string) : null;
  const needsReview = !!reviewText && !p.source?.reviewed;

  const save = useSubmit(
    async () => {
      if (!name.trim()) throw new Error('Впишите название');
      await q(supabase.from('products').update({
        name: name.trim(),
        ref_cost: numOrNull(refCost),
        ref_cost_note: refNote.trim() || null,
        wholesale_cost: numOrNull(wholesale),
        ribbon_m_per_unit: numOrNull(ribbon),
        min_stock: numOrNull(minStock),
        active,
      }).eq('id', p.id));
    },
    () => { setSaved(true); qc.invalidateQueries(); },
  );
  const review = useSubmit(
    async () => { await rpc('mark_reviewed', { p_table: 'products', p_id: p.id }); },
    () => qc.invalidateQueries(),
  );

  async function onPhoto(file: File | undefined) {
    if (!file) return;
    setPhotoBusy(true);
    setPhotoError(null);
    try {
      const path = await uploadPhoto(file, 'products');
      await q(supabase.from('products').update({ photo_path: path }).eq('id', p.id));
      qc.invalidateQueries();
    } catch (e) {
      setPhotoError((e as Error).message);
    } finally {
      setPhotoBusy(false);
    }
  }

  const dupe = save.error?.message.includes('products_name_uq') || save.error?.message.includes('duplicate');
  const touch = () => { setSaved(false); save.clearError(); };

  return (
    <Page title={p.name} back="/catalog">
      {needsReview ? (
        <div className="notice review">
          <div style={{ flex: 1 }}>
            <b>Нужно проверить.</b> {reviewText}
            {review.generalError ? <div className="field-error">{review.generalError}</div> : null}
          </div>
          <button className="btn act" disabled={review.busy} onClick={review.submit}>Проверено</button>
        </div>
      ) : null}

      <Card>
        <div className="line-item" style={{ borderBottom: 0, padding: 0, alignItems: 'center' }}>
          <Photo path={p.photo_path} alt={p.name} size={72} />
          <div className="li-body">
            <label className="btn">
              {photoBusy ? 'Загружаю…' : p.photo_path ? 'Заменить фото' : 'Добавить фото'}
              <input type="file" accept="image/*" hidden onChange={(e) => onPhoto(e.target.files?.[0])} />
            </label>
            {photoError ? <div className="field-error">{photoError}</div> : null}
          </div>
        </div>
        <div className="spacer" />
        <Field label="Название" error={dupe ? 'Товар с таким названием уже есть. Измените название.' : save.generalError === 'Впишите название' ? 'Впишите название' : null}>
          <input value={name} onChange={(e) => { setName(e.target.value); touch(); }} />
        </Field>
        <Field label="Примерная цена закупки" hint="Используется, пока нет настоящих покупок">
          <MoneyInput value={refCost} onChange={(v) => { setRefCost(v); touch(); }} />
        </Field>
        <Field label="Откуда эта цена">
          <input value={refNote} placeholder="например: цена в магазине, оценка" onChange={(e) => { setRefNote(e.target.value); touch(); }} />
        </Field>
        <Field label="При опте было бы" hint="Только для справки, в расчёты не входит">
          <MoneyInput value={wholesale} onChange={(v) => { setWholesale(v); touch(); }} />
        </Field>
        {p.kind === 'balloon' ? (
          <Field label="Лента на один шар, м">
            <input inputMode="decimal" value={ribbon} onChange={(e) => { setRibbon(e.target.value); touch(); }} />
          </Field>
        ) : null}
        <Field label={`Минимальный остаток, ${p.unit}`} hint="Когда останется столько или меньше — на складе появится пометка">
          <input inputMode="decimal" value={minStock} onChange={(e) => { setMinStock(e.target.value); touch(); }} />
        </Field>
        <label className="check">
          <input type="checkbox" checked={active} onChange={(e) => { setActive(e.target.checked); touch(); }} />
          Товар используется (снимите галочку, чтобы скрыть)
        </label>
        <SubmitBar inline label={saved ? 'Сохранено ✓' : 'Сохранить'} busy={save.busy} onClick={save.submit}
          error={dupe || save.generalError === 'Впишите название' ? null : save.generalError} />
      </Card>

      {p.kind === 'balloon' ? (
        <>
          <h2>Производители</h2>
          {p.variants.filter((v) => v.active).length === 0 ? <Empty>Производитель не указан</Empty> : null}
          {p.variants.filter((v) => v.active).map((v) => (
            <VariantCard key={v.id} v={v} onEdit={() => setVariantSheet(v)} />
          ))}
          <button className="btn block" onClick={() => setVariantSheet('new')}>+ Добавить производителя</button>
          <VariantSheet product={p} variant={variantSheet} onClose={() => setVariantSheet(null)} />
        </>
      ) : null}

      <History productId={p.id} />
    </Page>
  );
}

function VariantCard({ v, onEdit }: { v: Variant; onEdit: () => void }) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const best = bestNorm(v);
  const norms = [...v.helium_norms].sort((a, b) =>
    (a.id === best?.id ? -1 : 0) - (b.id === best?.id ? -1 : 0) || b.set_at.localeCompare(a.set_at));

  const [removing, setRemoving] = useState<string | null>(null);
  async function removeNorm(id: string) {
    setRemoving(id);
    try { await q(supabase.from('helium_norms').update({ active: false }).eq('id', id)); qc.invalidateQueries(); }
    finally { setRemoving(null); }
  }

  return (
    <Card>
      <div className="line-item" style={{ padding: 0, borderBottom: 0 }}>
        <Photo path={v.photo_path} alt={v.maker} size={48} />
        <div className="li-body">
          <div className="li-title">
            {v.is_unknown ? 'Другой / неизвестен' : v.maker} {v.is_default ? <Badge tone="info">основной</Badge> : null}
          </div>
          <div className="li-meta">
            {v.pack_size ? <span>на упаковке: {v.pack_size}</span> : null}
            {v.real_size ? <span>на деле: {v.real_size}</span> : null}
          </div>
        </div>
        <button className="btn ghost" onClick={onEdit}>Изменить</button>
      </div>

      <h3>Расход гелия на один шар</h3>
      {norms.length === 0 ? <p className="muted small">Расход не указан — гелий в заказах придётся вписывать вручную.</p> : null}
      {norms.map((n) => {
        const used = n.id === best?.id;
        return (
          <div className="row" key={n.id} style={{ opacity: used ? 1 : 0.55 }}>
            <div className="row-main">
              <span className="row-label">
                ≈{num(n.helium_l)} л · {SOURCE_LABEL[n.source]} {used ? <Badge tone="ok">используется</Badge> : null}
                {!n.active ? <> <Badge>убрано</Badge></> : null}
              </span>
              <span className="row-sub">
                {when(n.set_at, false)}
                {n.is_mix && n.total_l ? ` · смесь: ${num(n.total_l)} л, гелия ${n.helium_share != null ? Math.round(Number(n.helium_share) * 100) : '?'}%` : ''}
                {n.note ? ` · ${n.note}` : ''}
              </span>
            </div>
            {n.active ? <button className="btn ghost" disabled={removing === n.id} onClick={() => removeNorm(n.id)}>убрать</button> : null}
          </div>
        );
      })}
      <div className="spacer" />
      <button className="btn block" onClick={() => setOpen(true)}>Указать расход гелия</button>
      <NormSheet variant={v} open={open} onClose={() => setOpen(false)} />
    </Card>
  );
}

function NormSheet({ variant, open, onClose }: { variant: Variant; open: boolean; onClose: () => void }) {
  const qc = useQueryClient();
  const me = useMe();
  const [litres, setLitres] = useState('');
  const [mix, setMix] = useState(false);
  const [total, setTotal] = useState('');
  const [share, setShare] = useState('');
  const [source, setSource] = useState<'estimate' | 'measured'>('estimate');
  const [note, setNote] = useState('');
  const [err, setErr] = useState<string | null>(null);

  const totalN = numOrNull(total);
  const shareN = numOrNull(share);
  const mixLitres = mix && totalN && shareN ? Math.round(totalN * shareN) / 100 : null;

  const form = useSubmit(
    async () => {
      const helium = mixLitres ?? numOrNull(litres);
      if (helium == null || helium < 0) { setErr('Впишите, сколько литров гелия уходит на один шар'); throw new AppError('', 'local'); }
      if (shareN != null && (shareN <= 0 || shareN > 100)) { setErr('Доля гелия — от 1 до 100 %'); throw new AppError('', 'local'); }
      await q(supabase.from('helium_norms').insert({
        variant_id: variant.id,
        helium_l: helium,
        is_mix: mix,
        total_l: mix ? totalN : null,
        helium_share: mix && shareN ? shareN / 100 : null,
        source,
        note: note.trim() || null,
        set_by: me.data?.id ?? null,
      }));
    },
    () => {
      qc.invalidateQueries();
      setLitres(''); setMix(false); setTotal(''); setShare(''); setNote(''); setErr(null);
      onClose();
    },
  );

  return (
    <Sheet open={open} onClose={onClose} title="Расход гелия на один шар">
      <Field label="Гелия на один шар, л" hint="Если смешиваете на глаз — впишите примерное число" error={err}>
        <input inputMode="decimal" value={mixLitres != null ? String(mixLitres) : litres} disabled={mixLitres != null}
          onChange={(e) => { setLitres(e.target.value); setErr(null); }} />
      </Field>
      <label className="check">
        <input type="checkbox" checked={mix} onChange={(e) => setMix(e.target.checked)} />
        Смесь с воздухом
      </label>
      {mix ? (
        <div className="card flat">
          <Field label="Весь объём шара, л (необязательно)">
            <input inputMode="decimal" value={total} onChange={(e) => setTotal(e.target.value)} />
          </Field>
          <Field label="Доля гелия, % (необязательно)" hint={mixLitres != null ? `Выйдет ≈${num(mixLitres)} л гелия` : 'Впишите оба числа — литры посчитаются сами'}>
            <input inputMode="decimal" value={share} onChange={(e) => setShare(e.target.value)} />
          </Field>
        </div>
      ) : null}
      <Field label="Как узнали">
        <Choice value={source} onChange={setSource}
          options={[{ value: 'estimate', label: 'На глаз / своя оценка' }, { value: 'measured', label: 'Замерили' }]} />
      </Field>
      <Field label="Заметка">
        <input value={note} onChange={(e) => setNote(e.target.value)} />
      </Field>
      <p className="muted small">Старые значения не пропадают — они остаются в истории. Заказы, которые уже сохранены, не меняются.</p>
      <SubmitBar label="Сохранить" busy={form.busy} onClick={form.submit} error={form.generalError} />
    </Sheet>
  );
}

function VariantSheet({ product, variant, onClose }: { product: Product; variant: Variant | 'new' | null; onClose: () => void }) {
  if (!variant) return null;
  return <VariantForm key={variant === 'new' ? 'new' : variant.id} product={product} variant={variant === 'new' ? null : variant} onClose={onClose} />;
}

function VariantForm({ product, variant, onClose }: { product: Product; variant: Variant | null; onClose: () => void }) {
  const qc = useQueryClient();
  const [unknown, setUnknown] = useState(variant?.is_unknown ?? false);
  const [maker, setMaker] = useState(variant && !variant.is_unknown ? variant.maker : '');
  const [pack, setPack] = useState(variant?.pack_size ?? '');
  const [real, setReal] = useState(variant?.real_size ?? '');
  const [isDefault, setIsDefault] = useState(variant?.is_default ?? product.variants.filter((v) => v.active).length === 0);
  const [photo, setPhoto] = useState(variant?.photo_path ?? null);
  const [photoBusy, setPhotoBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const form = useSubmit(
    async () => {
      if (!unknown && !maker.trim()) { setErr('Впишите производителя или выберите «Другой / неизвестен»'); throw new AppError('', 'local'); }
      const row = {
        maker: unknown ? 'Другой / неизвестен' : maker.trim(),
        is_unknown: unknown,
        pack_size: pack.trim() || null,
        real_size: real.trim() || null,
        photo_path: photo,
      };
      // only one default per product: clear the old one first
      if (isDefault && !variant?.is_default) {
        await q(supabase.from('variants').update({ is_default: false }).eq('product_id', product.id).eq('is_default', true));
      }
      if (variant) {
        await q(supabase.from('variants').update({ ...row, is_default: isDefault }).eq('id', variant.id));
      } else {
        await q(supabase.from('variants').insert({ ...row, product_id: product.id, is_default: isDefault }));
      }
    },
    () => { qc.invalidateQueries(); onClose(); },
  );
  const hide = useSubmit(
    async () => {
      await q(supabase.from('variants').update({ active: false, is_default: false }).eq('id', variant!.id));
    },
    () => { qc.invalidateQueries(); onClose(); },
  );

  async function onPhoto(file: File | undefined) {
    if (!file) return;
    setPhotoBusy(true);
    try { setPhoto(await uploadPhoto(file, 'variants')); setErr(null); }
    catch (e) { setErr((e as Error).message); }
    finally { setPhotoBusy(false); }
  }

  return (
    <Sheet open onClose={onClose} title={variant ? 'Производитель' : 'Новый производитель'}>
      <Field label="Производитель" error={err}>
        <Choice value={unknown ? 'unknown' : 'known'} onChange={(v) => { setUnknown(v === 'unknown'); setErr(null); }}
          options={[{ value: 'known', label: 'Известен' }, { value: 'unknown', label: 'Другой / неизвестен' }]} />
      </Field>
      {!unknown ? (
        <Field label="Название производителя">
          <input value={maker} onChange={(e) => { setMaker(e.target.value); setErr(null); }} />
        </Field>
      ) : null}
      <Field label="Размер на упаковке">
        <input value={pack} placeholder="например: 18″" onChange={(e) => setPack(e.target.value)} />
      </Field>
      <Field label="Реальный размер" hint="Если на деле шар получается другим">
        <input value={real} onChange={(e) => setReal(e.target.value)} />
      </Field>
      <div className="line-item" style={{ alignItems: 'center' }}>
        <Photo path={photo} alt="Упаковка" size={56} />
        <label className="btn">
          {photoBusy ? 'Загружаю…' : 'Фото упаковки'}
          <input type="file" accept="image/*" hidden onChange={(e) => onPhoto(e.target.files?.[0])} />
        </label>
      </div>
      <label className="check">
        <input type="checkbox" checked={isDefault} onChange={(e) => setIsDefault(e.target.checked)} />
        Основной (подставляется в заказ сам)
      </label>
      <SubmitBar label="Сохранить" busy={form.busy} onClick={form.submit} error={form.generalError} />
      {variant ? (
        <button className="btn danger block" disabled={hide.busy} onClick={hide.submit}>Убрать из списка</button>
      ) : null}
    </Sheet>
  );
}

type Movement = {
  id: string; occurred_at: string; kind: string; qty: number; unit_cost: number; cost_is_estimate: boolean; order_id: string | null; note: string | null;
};

function History({ productId }: { productId: string }) {
  const moves = useQuery({
    queryKey: ['stock_movements', productId],
    queryFn: () => q<Movement[]>(supabase.from('stock_movements')
      .select('id, occurred_at, kind, qty, unit_cost, cost_is_estimate, order_id, note')
      .eq('product_id', productId).order('occurred_at', { ascending: false }).limit(30)),
  });
  return (
    <>
      <h2>Движение по складу</h2>
      <Card>
        {moves.isLoading ? <Loading /> : null}
        {!moves.isLoading && (moves.data ?? []).length === 0 ? <Empty>Движений пока не было</Empty> : null}
        {(moves.data ?? []).map((m) => (
          <div className="row" key={m.id}>
            <div className="row-main">
              <span className="row-label">{KIND_LABEL[m.kind] ?? m.kind}</span>
              <span className="row-sub">
                {when(m.occurred_at, false)} · цена {tg(m.unit_cost)} <Approx show={m.cost_is_estimate} />
                {m.order_id ? <> · <Link className="link" to={`/orders/${m.order_id}`}>заказ</Link></> : null}
              </span>
            </div>
            <span className="row-value strong" style={{ color: Number(m.qty) < 0 ? 'var(--bad)' : 'var(--ok)' }}>
              {Number(m.qty) > 0 ? '+' : '−'}{num(Math.abs(Number(m.qty)))}
            </span>
          </div>
        ))}
      </Card>
    </>
  );
}
