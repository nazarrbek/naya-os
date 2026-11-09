import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { supabase } from '../lib/supabase';
import { q } from '../lib/api';
import { num, parseAmount, tg } from '../lib/format';
import {
  bestNorm, defaultVariant, roundUp, useProducts, useSettings, useStock, useTemplates,
  type Product, type Settings, type StockRow, type Template,
} from '../lib/data';
import {
  amountOf, Approx, Card, Empty, Field, Loading, MoneyInput, Page, Photo, Sheet, Stepper, SubmitBar, uploadPhoto, useSubmit,
} from '../components/ui';

type Line = { product_id: string; variant_id: string | null; qty: number };
type Ctx = { products: Product[]; stock: StockRow[]; settings: Settings };

/** Cost from average purchase prices + planned helium + ribbon + print; price = cost × coefficient, rounded up. */
function calc(lines: Line[], service: number, coef: number | null, ctx: Ctx) {
  const { products, stock, settings } = ctx;
  const avg = (id: string | null) => Number(stock.find((s) => s.product_id === id)?.avg_cost ?? 0);
  let cost = service;
  let missingHelium = false;
  for (const l of lines) {
    const p = products.find((x) => x.id === l.product_id);
    if (!p) continue;
    cost += avg(p.id) * l.qty;
    if (p.kind === 'balloon') {
      const v = p.variants.find((x) => x.id === l.variant_id) ?? defaultVariant(p);
      const n = bestNorm(v);
      if (n) cost += Number(n.helium_l) * l.qty * Number(settings.helium_plan_price);
      else missingHelium = true;
      if (p.ribbon_m_per_unit) cost += Number(p.ribbon_m_per_unit) * l.qty * avg(settings.ribbon_product_id);
    }
  }
  const c = coef ?? Number(settings.default_coef);
  return { cost, price: roundUp(cost * c, settings.price_round), coef: c, missingHelium };
}

export default function Templates() {
  const templates = useTemplates();
  const products = useProducts();
  const stock = useStock();
  const settings = useSettings();
  const [editing, setEditing] = useState<Template | 'new' | null>(null);
  const ready = products.data && stock.data && settings.data;
  const ctx: Ctx | null = ready ? { products: products.data!, stock: stock.data!, settings: settings.data! } : null;
  const list = (templates.data ?? []).filter((t) => t.active);

  return (
    <Page title="Готовые композиции" back="/catalog" actions={<button className="btn primary" onClick={() => setEditing('new')}>+ Добавить</button>}>
      <div className="notice info"><div>Если изменить композицию, уже созданные заказы не поменяются.</div></div>
      {templates.isLoading || !ctx ? <Loading /> : null}
      {!templates.isLoading && list.length === 0 ? <Empty>Композиций пока нет</Empty> : null}
      {ctx ? list.map((t) => {
        const r = calc(t.template_lines, Number(t.service_estimate), t.coef != null ? Number(t.coef) : null, ctx);
        return (
          <Card key={t.id} onClick={() => setEditing(t)}>
            <div className="line-item" style={{ padding: 0, borderBottom: 0 }}>
              <Photo path={t.photo_path} alt={t.name} size={64} />
              <div className="li-body">
                <div className="li-title">{t.name}</div>
                <div className="li-meta">
                  <span>Расчётная себестоимость ≈ {tg(r.cost)}</span>
                </div>
                <div className="li-meta">
                  <span>{t.manual_price != null ? `Цена: ${tg(t.manual_price)}` : `Рекомендуем ≈ ${tg(r.price)}`}</span>
                </div>
              </div>
            </div>
          </Card>
        );
      }) : null}
      {ctx && editing ? (
        <TemplateForm key={editing === 'new' ? 'new' : editing.id} template={editing === 'new' ? null : editing} ctx={ctx} onClose={() => setEditing(null)} />
      ) : null}
    </Page>
  );
}

function TemplateForm({ template, ctx, onClose }: { template: Template | null; ctx: Ctx; onClose: () => void }) {
  const qc = useQueryClient();
  const [name, setName] = useState(template?.name ?? '');
  const [photo, setPhoto] = useState(template?.photo_path ?? null);
  const [photoBusy, setPhotoBusy] = useState(false);
  const [lines, setLines] = useState<Line[]>(
    (template?.template_lines ?? []).slice().sort((a, b) => a.sort - b.sort).map((l) => ({ product_id: l.product_id, variant_id: l.variant_id, qty: Number(l.qty) })),
  );
  const [svcLabel, setSvcLabel] = useState(template?.service_label ?? 'Надпись');
  const [svc, setSvc] = useState(template && Number(template.service_estimate) ? String(template.service_estimate) : '');
  const [coef, setCoef] = useState(template?.coef != null ? String(template.coef) : '');
  const [manual, setManual] = useState(template?.manual_price != null ? String(template.manual_price) : '');
  const [err, setErr] = useState<{ field: string; msg: string } | null>(null);

  const coefN = coef.trim() ? parseAmount(coef) : null;
  const r = calc(lines, amountOf(svc), coefN, ctx);
  const items = ctx.products.filter((p) => p.active);

  const setLine = (i: number, patch: Partial<Line>) => setLines(lines.map((l, k) => (k === i ? { ...l, ...patch } : l)));

  const form = useSubmit(
    async () => {
      const fail = (field: string, msg: string): never => { setErr({ field, msg }); throw new Error(msg); };
      if (!name.trim()) fail('name', 'Впишите название композиции');
      if (lines.length === 0) fail('lines', 'Добавьте хотя бы один товар');
      if (coef.trim() && (coefN == null || coefN <= 0)) fail('coef', 'Коэффициент — число больше нуля, например 2,5. Или оставьте пустым');
      const row = {
        name: name.trim(),
        photo_path: photo,
        coef: coefN,
        manual_price: manual.trim() ? amountOf(manual) : null,
        service_label: svcLabel.trim() || null,
        service_estimate: amountOf(svc),
      };
      let id = template?.id;
      if (id) {
        await q(supabase.from('templates').update(row).eq('id', id));
        await q(supabase.from('template_lines').delete().eq('template_id', id));
      } else {
        id = (await q<{ id: string }>(supabase.from('templates').insert(row).select('id').single())).id;
      }
      await q(supabase.from('template_lines').insert(lines.map((l, i) => ({ template_id: id, product_id: l.product_id, variant_id: l.variant_id, qty: l.qty, sort: i }))));
    },
    () => { qc.invalidateQueries(); onClose(); },
  );
  const hide = useSubmit(
    async () => { await q(supabase.from('templates').update({ active: false }).eq('id', template!.id)); },
    () => { qc.invalidateQueries(); onClose(); },
  );

  async function onPhoto(file: File | undefined) {
    if (!file) return;
    setPhotoBusy(true);
    try { setPhoto(await uploadPhoto(file, 'templates')); }
    catch (e) { setErr({ field: 'photo', msg: (e as Error).message }); }
    finally { setPhotoBusy(false); }
  }
  const e = (f: string) => (err?.field === f ? err.msg : null);

  return (
    <Sheet open onClose={onClose} title={template ? 'Композиция' : 'Новая композиция'}>
      <Field label="Название" error={e('name')}>
        <input value={name} onChange={(ev) => { setName(ev.target.value); setErr(null); }} />
      </Field>
      <div className="line-item" style={{ alignItems: 'center' }}>
        <Photo path={photo} alt={name} size={56} />
        <label className="btn">
          {photoBusy ? 'Загружаю…' : 'Фото'}
          <input type="file" accept="image/*" hidden onChange={(ev) => onPhoto(ev.target.files?.[0])} />
        </label>
        {e('photo') ? <span className="field-error">{e('photo')}</span> : null}
      </div>

      <h3>Что входит</h3>
      {lines.map((l, i) => {
        const p = ctx.products.find((x) => x.id === l.product_id);
        const variants = (p?.variants ?? []).filter((v) => v.active);
        return (
          <Card key={i} className="flat">
            <div className="field">
              <select value={l.product_id} onChange={(ev) => setLine(i, { product_id: ev.target.value, variant_id: null })}>
                {items.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
                {p && !p.active ? <option value={p.id}>{p.name}</option> : null}
              </select>
            </div>
            {variants.length > 1 ? (
              <div className="field">
                <select value={l.variant_id ?? ''} onChange={(ev) => setLine(i, { variant_id: ev.target.value || null })}>
                  <option value="">Производитель: основной</option>
                  {variants.map((v) => <option key={v.id} value={v.id}>{v.is_unknown ? 'Другой / неизвестен' : v.maker}</option>)}
                </select>
              </div>
            ) : null}
            <div className="btn-row" style={{ alignItems: 'center' }}>
              <Stepper value={l.qty} min={1} onChange={(v) => setLine(i, { qty: v })} />
              <button className="btn ghost" onClick={() => setLines(lines.filter((_, k) => k !== i))}>убрать</button>
            </div>
          </Card>
        );
      })}
      {e('lines') ? <div className="field-error" role="alert">{e('lines')}</div> : null}
      <button className="btn block" style={{ marginBottom: 14 }}
        onClick={() => { if (items[0]) { setLines([...lines, { product_id: items[0].id, variant_id: null, qty: 1 }]); setErr(null); } }}>
        + Добавить товар
      </button>

      <Field label="Что ещё входит в работу" hint="Например: Надпись">
        <input value={svcLabel} onChange={(ev) => setSvcLabel(ev.target.value)} />
      </Field>
      <Field label="Планируемая стоимость надписи / печати" hint="Только для подсказки цены, в заказ сама не попадает">
        <MoneyInput value={svc} onChange={setSvc} />
      </Field>
      <Field label="Коэффициент наценки" error={e('coef')} hint={`Пусто — стандартный (${num(ctx.settings.default_coef)})`}>
        <input inputMode="decimal" value={coef} onChange={(ev) => { setCoef(ev.target.value); setErr(null); }} />
      </Field>
      <Field label="Своя цена" hint="Если заполнить, она будет вместо рекомендованной">
        <MoneyInput value={manual} onChange={setManual} />
      </Field>

      <Card className="flat">
        <div className="row">
          <div className="row-main"><span className="row-label">Расчётная себестоимость</span></div>
          <span className="row-value strong">≈ {tg(r.cost)}</span>
        </div>
        <div className="row">
          <div className="row-main"><span className="row-label">Рекомендуемая цена</span><span className="row-sub">× {num(r.coef)}, округлено вверх</span></div>
          <span className="row-value strong">≈ {tg(r.price)}</span>
        </div>
        <Approx show>считается по средним ценам и нормам гелия</Approx>
        {r.missingHelium ? <p className="muted small">Для некоторых шаров не указан расход гелия — он не учтён.</p> : null}
      </Card>
      <p className="muted small">Изменение композиции не меняет уже созданные заказы.</p>

      <SubmitBar label="Сохранить" busy={form.busy} onClick={form.submit} error={err ? null : form.generalError} />
      {template ? <button className="btn danger block" disabled={hide.busy} onClick={hide.submit}>Убрать композицию</button> : null}
    </Sheet>
  );
}
