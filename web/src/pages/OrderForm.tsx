import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '../lib/supabase';
import { q, rpc } from '../lib/api';
import {
  bestNorm, defaultVariant, useAccounts, useProducts, useSettings, useStock, useTemplates, variantLabel,
  type OrderLine, type OrderRow, type Product,
} from '../lib/data';
import { calcLine, calcPricing, profitOf, type DraftLine } from '../lib/estimate';
import { isoToLocalInput, localInputToISO, num, parseAmount, pct, SOURCE_LABEL, tg } from '../lib/format';
import {
  AccountPicker, Approx, Badge, Card, Choice, Field, Loading, MoneyInput, Page, Photo, Sheet, Stepper, SubmitBar,
  amountOf, uploadPhoto, useSubmit,
} from '../components/ui';

const COEFS = [2, 2.2, 2.4, 2.5, 3];
let keySeq = 0;
const newKey = () => `l${++keySeq}`;

export default function OrderForm() {
  const { id } = useParams();
  const editing = !!id;
  const nav = useNavigate();
  const qc = useQueryClient();
  const products = useProducts();
  const stock = useStock();
  const settings = useSettings();
  const templates = useTemplates();
  const accounts = useAccounts();

  const existing = useQuery({
    queryKey: ['order', id],
    enabled: editing,
    queryFn: async () => ({
      order: await q<OrderRow>(supabase.from('v_orders').select('*').eq('id', id!).single()),
      lines: await q<OrderLine[]>(supabase.from('order_lines').select('*').eq('order_id', id!).order('sort')),
    }),
  });

  const [loaded, setLoaded] = useState(!editing);
  const [title, setTitle] = useState('');
  const [titleTouched, setTitleTouched] = useState(false);
  const [templateId, setTemplateId] = useState<string | null>(null);
  const [lines, setLines] = useState<DraftLine[]>([]);
  const [coef, setCoef] = useState<number | null>(null);
  const [customCoef, setCustomCoef] = useState('');
  const [listPrice, setListPrice] = useState('');
  const [priceTouched, setPriceTouched] = useState(false);
  const [discount, setDiscount] = useState('');
  const [lowAck, setLowAck] = useState(false);
  const [clientName, setClientName] = useState('');
  const [clientPhone, setClientPhone] = useState('');
  const [due, setDue] = useState('');
  const [delivery, setDelivery] = useState<'pickup' | 'delivery'>('pickup');
  const [address, setAddress] = useState('');
  const [deliveryPrice, setDeliveryPrice] = useState('');
  const [prepay, setPrepay] = useState('');
  const [prepayAccount, setPrepayAccount] = useState<string | null>(null);
  const [inscription, setInscription] = useState('');
  const [design, setDesign] = useState('');
  const [comment, setComment] = useState('');
  const [photoPath, setPhotoPath] = useState<string | null>(null);
  const [serviceLabel, setServiceLabel] = useState('Надпись');
  const [serviceEstimate, setServiceEstimate] = useState('');
  const [picker, setPicker] = useState(false);
  const [makerFor, setMakerFor] = useState<string | null>(null);
  const [heliumFor, setHeliumFor] = useState<string | null>(null);

  // load an existing order into the form once
  useEffect(() => {
    if (!editing || loaded || !existing.data) return;
    const { order: o, lines: ls } = existing.data;
    setTitle(o.title); setTitleTouched(true); setTemplateId(o.template_id);
    setLines(ls.map((l) => ({
      key: newKey(), product_id: l.product_id, variant_id: l.variant_id, qty: Number(l.qty),
      helium_override: l.helium_l_per_unit === null ? null : Number(l.helium_l_per_unit),
      helium_source_override: l.helium_source,
    })));
    setCoef(o.coef === null ? null : Number(o.coef));
    setListPrice(String(Number(o.price) + Number(o.discount) - Number(o.delivery_price)));
    setPriceTouched(true); setDiscount(Number(o.discount) ? String(o.discount) : ''); setLowAck(o.low_price_ack);
    setClientName(o.client_name ?? ''); setClientPhone(o.client_phone ?? '');
    setDue(isoToLocalInput(o.due_at)); setDelivery(o.delivery); setAddress(o.address ?? '');
    setDeliveryPrice(Number(o.delivery_price) ? String(o.delivery_price) : '');
    setInscription(o.inscription ?? ''); setDesign(o.design ?? ''); setComment(o.comment ?? ''); setPhotoPath(o.photo_path);
    setServiceLabel(o.service_label ?? 'Надпись'); setServiceEstimate(Number(o.service_estimate) ? String(o.service_estimate) : '');
    setLoaded(true);
  }, [editing, loaded, existing.data]);

  const ready = products.data && stock.data && settings.data && loaded;
  const calcs = useMemo(
    () => (ready ? lines.map((l) => calcLine(l, products.data!, stock.data!, settings.data!)) : []),
    [ready, lines, products.data, stock.data, settings.data],
  );
  const pricing = ready ? calcPricing(calcs, amountOf(serviceEstimate), settings.data!, coef) : null;

  // suggested price follows the composition until the user types their own
  useEffect(() => {
    if (pricing && !priceTouched) setListPrice(pricing.cost > 0 ? String(pricing.recommended) : '');
  }, [pricing?.recommended, priceTouched]); // eslint-disable-line react-hooks/exhaustive-deps

  const finalPrice = Math.max(0, amountOf(listPrice) - amountOf(discount) + (delivery === 'delivery' ? amountOf(deliveryPrice) : 0));
  const itemsPrice = Math.max(0, amountOf(listPrice) - amountOf(discount));
  const tooLow = pricing ? itemsPrice > 0 && itemsPrice < pricing.minPrice : false;

  function autoTitle(ls: DraftLine[]) {
    if (titleTouched || !products.data) return;
    setTitle(ls.map((l) => `${num(l.qty)} ${products.data!.find((p) => p.id === l.product_id)?.name ?? ''}`).join(' + '));
  }

  function applyTemplate(tid: string | null) {
    setTemplateId(tid);
    if (!tid) return;
    const t = templates.data?.find((x) => x.id === tid);
    if (!t) return;
    const ls = [...t.template_lines].sort((a, b) => a.sort - b.sort).map((tl) => ({
      key: newKey(), product_id: tl.product_id, variant_id: tl.variant_id, qty: Number(tl.qty),
      helium_override: null, helium_source_override: null,
    }));
    setLines(ls);
    if (!titleTouched) setTitle(t.name);
    if (t.coef) setCoef(Number(t.coef));
    if (t.manual_price) { setListPrice(String(t.manual_price)); setPriceTouched(true); } else setPriceTouched(false);
    if (Number(t.service_estimate) > 0) { setServiceLabel(t.service_label ?? 'Надпись'); setServiceEstimate(String(t.service_estimate)); }
    else setServiceEstimate('');
  }

  function addProduct(p: Product) {
    const ls = [...lines];
    const same = ls.find((l) => l.product_id === p.id);
    if (same) same.qty += 1;
    else ls.push({ key: newKey(), product_id: p.id, variant_id: p.kind === 'balloon' ? defaultVariant(p)?.id ?? null : null, qty: 1, helium_override: null, helium_source_override: null });
    setLines(ls);
    autoTitle(ls);
    setPicker(false);
  }

  function updateLine(key: string, patch: Partial<DraftLine>) {
    const ls = lines.map((l) => (l.key === key ? { ...l, ...patch } : l));
    setLines(ls);
    if ('qty' in patch) autoTitle(ls);
  }

  const save = useSubmit(
    (requestId) => rpc<{ id: string }>('save_order', {
      p_request_id: requestId,
      p: {
        id: id ?? null,
        version: existing.data?.order.version,
        title: title.trim(),
        template_id: templateId,
        client_name: clientName, client_phone: clientPhone,
        due_at: localInputToISO(due), delivery, address,
        delivery_price: delivery === 'delivery' ? amountOf(deliveryPrice) : 0,
        coef: coef, price: finalPrice, discount: amountOf(discount), low_price_ack: lowAck,
        inscription, design, comment, photo_path: photoPath,
        service_label: serviceLabel, service_estimate: amountOf(serviceEstimate),
        lines: lines.map((l, i) => {
          const c = calcs[i];
          return {
            product_id: l.product_id, variant_id: c?.variant?.id ?? l.variant_id, qty: l.qty,
            ...(l.helium_override !== null ? { helium_l_per_unit: l.helium_override, helium_source: l.helium_source_override ?? 'estimate' } : {}),
          };
        }),
        prepayment: !editing && amountOf(prepay) > 0 ? { amount: amountOf(prepay), account_id: prepayAccount } : null,
      },
    }),
    (r) => {
      qc.invalidateQueries();
      nav(`/orders/${r.id}`, { replace: true });
    },
  );

  if (!ready || (editing && existing.isLoading)) return <Page title={editing ? 'Изменить заказ' : 'Новый заказ'} back><Loading /></Page>;
  if (existing.data && (existing.data.order.status === 'issued' || existing.data.order.status === 'cancelled')) {
    return <Page title="Изменить заказ" back><div className="notice">Заказ уже {existing.data.order.status === 'issued' ? 'выдан' : 'отменён'}. Исправление — в карточке заказа: «Исправить выданный заказ».</div></Page>;
  }

  const p = pricing!;
  const pr = profitOf(itemsPrice, p.cost);
  const activeTemplates = (templates.data ?? []).filter((t) => t.active);

  return (
    <Page title={editing ? `Заказ №${existing.data?.order.number}` : 'Новый заказ'} back>
      {existing.data?.order.status === 'assembled' ? (
        <div className="notice info">Заказ уже собран: если изменить состав, на склад вернётся или спишется только разница.</div>
      ) : null}

      {/* 1. What */}
      <h2>Что заказали</h2>
      {!editing && activeTemplates.length > 0 ? (
        <div className="tiles" style={{ marginBottom: 12 }}>
          {activeTemplates.map((t) => (
            <button type="button" key={t.id} className={`tile ${templateId === t.id ? 'on' : ''}`} onClick={() => applyTemplate(t.id)}>
              <Photo path={t.photo_path} alt={t.name} size={44} />
              <span className="t-name">{t.name}</span>
            </button>
          ))}
          <button type="button" className={`tile ${templateId === null && lines.length > 0 ? 'on' : ''}`} onClick={() => { setTemplateId(null); setPicker(true); }}>
            <span style={{ fontSize: 30 }}>＋</span>
            <span className="t-name">Свой состав</span>
          </button>
        </div>
      ) : null}

      {lines.length > 0 ? (
        <Card>
          {lines.map((l, i) => {
            const c = calcs[i];
            return (
              <div className="line-item" key={l.key}>
                <Photo path={c.variant?.photo_path ?? c.product?.photo_path} alt={c.product?.name ?? ''} size={48} />
                <div className="li-body">
                  <div className="li-title">{c.product?.name}</div>
                  <div className="li-meta">
                    {c.product?.kind === 'balloon' ? (
                      <button type="button" className="link" onClick={() => setMakerFor(l.key)}>{variantLabel(c.variant) || 'производитель?'}</button>
                    ) : null}
                    {c.product?.kind === 'balloon' ? (
                      c.heliumPerUnit === null ? null : (
                        <button type="button" className="link" onClick={() => setHeliumFor(l.key)}>
                          гелий ≈{num(c.heliumPerUnit)} л/шт · {SOURCE_LABEL[c.heliumSource ?? ''] ?? ''}{c.isMix && l.helium_override === null ? ' · смесь' : ''}
                        </button>
                      )
                    ) : null}
                  </div>
                  {c.product?.kind === 'balloon' && c.heliumPerUnit === null ? (
                    <div className="li-warn">Для «{c.product.name}» не указан расход гелия → <button type="button" className="link" onClick={() => setHeliumFor(l.key)}>указать</button></div>
                  ) : null}
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 6 }}>
                  <Stepper value={l.qty} min={0} onChange={(v) => v === 0 ? setLines(lines.filter((x) => x.key !== l.key)) : updateLine(l.key, { qty: v })} />
                </div>
              </div>
            );
          })}
          <button type="button" className="btn ghost" onClick={() => setPicker(true)}>＋ Добавить шар или товар</button>
          <details className="more">
            <summary>Гелий ≈{num(p.heliumL)} л, лента ≈{num(calcs.reduce((t, c) => t + c.ribbon, 0))} м</summary>
            <div className="explain">
              Гелий и лента подставляются сами по нормам каждого шара. Со склада спишется только гелий — воздух в смеси не учитывается.
              Нормы на глаз помечены «своя оценка» — это примерный расход, не замер.
            </div>
          </details>
        </Card>
      ) : editing ? null : (
        <button type="button" className="btn block" onClick={() => setPicker(true)}>＋ Выбрать шары и товары</button>
      )}
      {save.errorFor('lines') ? <div className="field-error">{save.errorFor('lines')}</div> : null}

      <Field label="Название заказа" error={save.errorFor('title')} hint="Так заказ будет виден в списке">
        <input value={title} onChange={(e) => { setTitle(e.target.value); setTitleTouched(true); }} placeholder="Например: 6 сердец + гигант" />
      </Field>

      {/* 2. Price */}
      <h2>Цена</h2>
      <Card>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
          <span className="muted">Расчётная себестоимость <Approx show={p.isApprox} /></span>
          <b>{tg(p.cost)}</b>
        </div>
        <div className="field-label" style={{ marginTop: 12 }}>Наценка</div>
        <div className="choice-row">
          {COEFS.map((k) => (
            <button type="button" key={k} className={`choice ${p.coef === k && !customCoef ? 'on' : ''}`}
              onClick={() => { setCoef(k === Number(settings.data!.default_coef) ? null : k); setCustomCoef(''); setPriceTouched(false); }}>
              ×{num(k)}<small>{tg(Math.ceil((p.cost * k) / Number(settings.data!.price_round)) * Number(settings.data!.price_round))}</small>
            </button>
          ))}
          <input className="input" style={{ width: 90, minHeight: 46 }} inputMode="decimal" placeholder="свой ×"
            value={customCoef} onChange={(e) => { setCustomCoef(e.target.value); const k = parseAmount(e.target.value); if (k) { setCoef(k); setPriceTouched(false); } }} />
        </div>
        <div className="spacer" />
        <Field label="Цена для клиента" error={save.errorFor('price')}
          hint={priceTouched && pricing && amountOf(listPrice) !== p.recommended ? <>Рекомендуем {tg(p.recommended)} · <button type="button" className="link" onClick={() => setPriceTouched(false)}>вернуть</button></> : 'Рекомендованная цена — можно изменить'}>
          <MoneyInput value={listPrice} onChange={(v) => { setListPrice(v); setPriceTouched(true); setLowAck(false); }} />
        </Field>
        <details className="more">
          <summary>Скидка, прибыль и маржа</summary>
          <Field label="Скидка"><MoneyInput value={discount} onChange={(v) => { setDiscount(v); setLowAck(false); }} /></Field>
          <div className="explain">
            Прибыль: <b>{tg(pr.profit)}</b><br />
            Маржа (прибыль ÷ цена): <b>{pct(pr.margin)}</b><br />
            Наценка (прибыль ÷ себестоимость): <b>{pct(pr.markup)}</b>
          </div>
        </details>
        {tooLow || save.errorFor('price_low') ? (
          <div className="notice" style={{ marginTop: 10 }}>
            <div style={{ flex: 1 }}>
              Цена ниже минимальной ({tg(p.minPrice)} = себестоимость ×{num(settings.data!.min_coef)}). Прибыль будет {tg(pr.profit)}.
              <label className="check"><input type="checkbox" checked={lowAck} onChange={(e) => setLowAck(e.target.checked)} />Да, сохранить с этой ценой</label>
            </div>
          </div>
        ) : null}
      </Card>

      {/* 3. Client & when */}
      <h2>Клиент и выдача</h2>
      <Field label="Имя клиента"><input value={clientName} onChange={(e) => setClientName(e.target.value)} placeholder="Можно не заполнять" /></Field>
      <Field label="Телефон"><input type="tel" inputMode="tel" value={clientPhone} onChange={(e) => setClientPhone(e.target.value)} placeholder="+7" /></Field>
      <Field label="Когда выдать"><input type="datetime-local" value={due} onChange={(e) => setDue(e.target.value)} /></Field>
      <Choice options={[{ value: 'pickup', label: 'Самовывоз' }, { value: 'delivery', label: 'Доставка' }]} value={delivery} onChange={setDelivery} />
      <div className="spacer" />
      {delivery === 'delivery' ? (
        <>
          <Field label="Адрес"><input value={address} onChange={(e) => setAddress(e.target.value)} /></Field>
          <Field label="Доставка для клиента" hint="Прибавится к цене. Такси за ваш счёт записывается из карточки заказа">
            <MoneyInput value={deliveryPrice} onChange={setDeliveryPrice} />
          </Field>
        </>
      ) : null}

      {/* 4. Prepayment */}
      {!editing ? (
        <>
          <h2>Предоплата</h2>
          <Field label="Сколько клиент заплатил сейчас" hint="Пусто — без предоплаты">
            <MoneyInput value={prepay} onChange={setPrepay} />
          </Field>
          {amountOf(prepay) > 0 ? (
            <Field label="Куда пришли деньги" error={save.errorFor('prepayment_account')}>
              <AccountPicker accounts={accounts.data} value={prepayAccount} onChange={setPrepayAccount} />
            </Field>
          ) : null}
        </>
      ) : null}

      {/* 5. Details */}
      <details className="more">
        <summary>Надпись, оформление, фото, комментарий</summary>
        <Field label="Текст надписи"><input value={inscription} onChange={(e) => setInscription(e.target.value)} /></Field>
        <Field label="Печать надписи / фото (примерная стоимость)" hint="Нужна для цены. Реальную сумму запишите в заказе, когда заплатите полиграфии">
          <MoneyInput value={serviceEstimate} onChange={setServiceEstimate} />
        </Field>
        <Field label="Оформление (цвета, лента)"><input value={design} onChange={(e) => setDesign(e.target.value)} /></Field>
        <Field label="Комментарий"><textarea value={comment} onChange={(e) => setComment(e.target.value)} /></Field>
        <Field label="Фото примера">
          <input type="file" accept="image/*" onChange={async (e) => { const f = e.target.files?.[0]; if (f) setPhotoPath(await uploadPhoto(f, 'orders')); }} />
        </Field>
        {photoPath ? <Photo path={photoPath} alt="Фото заказа" size={120} /> : null}
      </details>

      <div className="card flat" style={{ marginTop: 16 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between' }}><span>К оплате</span><b>{tg(finalPrice)}</b></div>
        {!editing && amountOf(prepay) > 0 ? (
          <div style={{ display: 'flex', justifyContent: 'space-between' }} className="muted"><span>Останется получить</span><span>{tg(finalPrice - amountOf(prepay))}</span></div>
        ) : null}
      </div>

      <SubmitBar label={editing ? 'Сохранить изменения' : 'Сохранить заказ'} busy={save.busy} onClick={save.submit}
        error={save.generalError ?? (save.error?.field === 'version' ? save.error.message : null)} />

      <ProductPickerSheet open={picker} onClose={() => setPicker(false)} products={products.data!} onPick={addProduct} />
      <MakerSheet line={lines.find((l) => l.key === makerFor)} products={products.data!} onClose={() => setMakerFor(null)}
        onPick={(variantId) => { updateLine(makerFor!, { variant_id: variantId, helium_override: null, helium_source_override: null }); setMakerFor(null); }} />
      <HeliumSheet line={lines.find((l) => l.key === heliumFor)} calc={calcs[lines.findIndex((l) => l.key === heliumFor)]}
        onClose={() => setHeliumFor(null)}
        onSave={(litres, remember, variantId) => {
          updateLine(heliumFor!, { helium_override: litres, helium_source_override: 'estimate' });
          setHeliumFor(null);
          if (remember && variantId) {
            supabase.from('helium_norms').insert({ variant_id: variantId, helium_l: litres, source: 'estimate', note: 'Указано в заказе' })
              .then(() => qc.invalidateQueries({ queryKey: ['products'] }));
          }
        }} />
    </Page>
  );
}

function ProductPickerSheet({ open, onClose, products, onPick }: {
  open: boolean; onClose: () => void; products: Product[]; onPick: (p: Product) => void;
}) {
  const [s, setS] = useState('');
  const list = products.filter((p) => p.active && p.kind !== 'helium' && p.name !== 'Лента' && p.name.toLowerCase().includes(s.trim().toLowerCase()));
  const groups = Array.from(new Set(list.map((p) => p.category ?? 'Другое')));
  return (
    <Sheet open={open} onClose={onClose} title="Добавить в заказ">
      <input className="input" placeholder="Поиск по названию" value={s} onChange={(e) => setS(e.target.value)} />
      {groups.map((g) => (
        <div key={g}>
          <h3>{g}</h3>
          <div className="tiles">
            {list.filter((p) => (p.category ?? 'Другое') === g).map((p) => (
              <button type="button" key={p.id} className="tile" onClick={() => onPick(p)}>
                <Photo path={p.photo_path ?? defaultVariant(p)?.photo_path} alt={p.name} size={44} />
                <span className="t-name">{p.name}</span>
              </button>
            ))}
          </div>
        </div>
      ))}
    </Sheet>
  );
}

function MakerSheet({ line, products, onClose, onPick }: {
  line?: DraftLine; products: Product[]; onClose: () => void; onPick: (variantId: string) => void;
}) {
  const p = products.find((x) => x.id === line?.product_id);
  return (
    <Sheet open={!!line} onClose={onClose} title={`Производитель: ${p?.name ?? ''}`}>
      <p className="muted small">Одинаковый размер у разных производителей берёт разный объём гелия. Замена действует только для этого заказа.</p>
      {(p?.variants ?? []).filter((v) => v.active).map((v) => {
        const n = bestNorm(v);
        return (
          <Card key={v.id} onClick={() => onPick(v.id)} className={line?.variant_id === v.id ? 'flat' : ''}>
            <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
              <Photo path={v.photo_path} alt={v.maker} size={44} />
              <div style={{ flex: 1 }}>
                <div style={{ fontWeight: 650 }}>{v.maker} {v.is_default ? <Badge tone="info">основной</Badge> : null}</div>
                <div className="small muted">
                  {[v.pack_size && `на упаковке ${v.pack_size}`, v.real_size && `надутый ${v.real_size}`].filter(Boolean).join(' · ')}
                </div>
                <div className="small">{n ? `гелий ≈${num(n.helium_l)} л · ${SOURCE_LABEL[n.source]}${n.is_mix ? ' · смесь' : ''}` : 'расход гелия не указан'}</div>
              </div>
              {line?.variant_id === v.id ? <Badge tone="ok">выбран</Badge> : null}
            </div>
          </Card>
        );
      })}
    </Sheet>
  );
}

function HeliumSheet({ line, calc, onClose, onSave }: {
  line?: DraftLine; calc?: ReturnType<typeof calcLine>; onClose: () => void;
  onSave: (litres: number, remember: boolean, variantId: string | null) => void;
}) {
  const [litres, setLitres] = useState('');
  const [mix, setMix] = useState(false);
  const [total, setTotal] = useState('');
  const [share, setShare] = useState('');
  const [remember, setRemember] = useState(true);
  useEffect(() => {
    if (line) { setLitres(calc?.heliumPerUnit != null ? String(calc.heliumPerUnit) : ''); setMix(false); setTotal(''); setShare(''); }
  }, [line?.key]); // eslint-disable-line react-hooks/exhaustive-deps
  const computed = mix && amountOf(total) > 0 && amountOf(share) > 0 ? +(amountOf(total) * amountOf(share) / 100).toFixed(1) : null;
  const value = computed ?? parseAmount(litres);
  return (
    <Sheet open={!!line} onClose={onClose} title={`Гелий: ${calc?.product?.name ?? ''}`}>
      <p className="muted small">Сколько литров гелия уходит на один шар. Если наполняете на глаз — укажите примерно, это будет отмечено как «своя оценка».</p>
      <Field label="Гелий на 1 шар, л">
        <input inputMode="decimal" value={computed !== null ? String(computed) : litres} onChange={(e) => { setLitres(e.target.value); setMix(false); }} />
      </Field>
      <label className="check"><input type="checkbox" checked={mix} onChange={(e) => setMix(e.target.checked)} />Знаю объём смеси и долю гелия</label>
      {mix ? (
        <div style={{ display: 'flex', gap: 8 }}>
          <Field label="Весь объём, л"><input inputMode="decimal" value={total} onChange={(e) => setTotal(e.target.value)} /></Field>
          <Field label="Гелия, %"><input inputMode="decimal" value={share} onChange={(e) => setShare(e.target.value)} /></Field>
        </div>
      ) : null}
      {calc?.variant ? (
        <label className="check"><input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} />Запомнить для «{calc.variant.maker}» в следующих заказах</label>
      ) : null}
      <div className="spacer" />
      <button className="btn primary big" disabled={value === null} onClick={() => value !== null && onSave(value, remember, calc?.variant?.id ?? null)}>Готово</button>
    </Sheet>
  );
}
