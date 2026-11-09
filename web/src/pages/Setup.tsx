import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '../lib/supabase';
import { q, rpc } from '../lib/api';
import { num, parseAmount, tg } from '../lib/format';
import { useAccounts, useSettings } from '../lib/data';
import { Card, Field, Loading, MoneyInput, Page, Row, SubmitBar, amountOf, useSubmit } from '../components/ui';

export default function Setup() {
  return (
    <Page title="Запуск учёта" back>
      <p className="muted">Один раз укажите, с чего вы начинаете. Потом всё считается само.</p>
      <OpeningMoney />
      <Card>
        <h3>Остатки на складе</h3>
        <p className="muted">Пересчитайте, сколько чего есть сейчас, и укажите цену закупки.</p>
        <Link className="btn block" to="/stock/count?opening=1">Ввести остатки склада</Link>
      </Card>
      <SettingsForm />
    </Page>
  );
}

function OpeningMoney() {
  const qc = useQueryClient();
  const accounts = useAccounts();
  const settings = useSettings();
  const opened = useQuery({
    queryKey: ['opening_movements'],
    queryFn: () => q<{ account_id: string; amount: number }[]>(
      supabase.from('money_movements').select('account_id,amount').eq('kind', 'opening')),
  });
  const [vals, setVals] = useState<Record<string, string>>({});

  const s = useSubmit(
    (requestId) => {
      const balances: Record<string, number> = {};
      for (const [id, v] of Object.entries(vals)) if (v.trim() !== '') balances[id] = amountOf(v);
      return rpc('set_opening_money', {
        p_request_id: requestId, p_at: `${settings.data?.launch_date ?? new Date().toISOString().slice(0, 10)}T00:00:00+05:00`,
        p_balances: balances,
      });
    },
    () => { setVals({}); qc.invalidateQueries(); },
  );

  if (accounts.isLoading || opened.isLoading) return <Loading />;
  const done = new Map((opened.data ?? []).map((m) => [m.account_id, Number(m.amount)]));
  const open = (accounts.data ?? []).filter((a) => a.active && !done.has(a.account_id));

  return (
    <>
      <h2>Деньги на старте</h2>
      <Card>
        {[...done.entries()].map(([id, amt]) => (
          <Row key={id} label={accounts.data?.find((a) => a.account_id === id)?.name ?? 'Счёт'} value={tg(amt)} sub="записано, не меняется" />
        ))}
        {open.length === 0 ? <p className="muted">Все счета заполнены. Если реальная сумма другая — сделайте «Сверить» на экране «Деньги».</p> : (
          <>
            <p className="muted">Сколько было на каждом счёте в день запуска.</p>
            {open.map((a) => (
              <Field key={a.account_id} label={a.name}>
                <MoneyInput value={vals[a.account_id] ?? ''} onChange={(v) => setVals((o) => ({ ...o, [a.account_id]: v }))} />
              </Field>
            ))}
            {s.generalError && <div className="form-error" role="alert">{s.generalError}</div>}
            <button className="btn primary big block" disabled={s.busy || Object.values(vals).every((v) => !v.trim())} onClick={s.submit}>
              {s.busy ? 'Сохраняю…' : 'Записать остатки'}
            </button>
            <p className="small muted">Остаток записывается один раз и потом не редактируется — расхождения исправляются сверкой.</p>
          </>
        )}
      </Card>
    </>
  );
}

function SettingsForm() {
  const qc = useQueryClient();
  const settings = useSettings();
  const [f, setF] = useState<Record<string, string>>({});
  const [tax, setTax] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    const s = settings.data;
    if (!s) return;
    setF({
      launch_date: s.launch_date, default_coef: String(s.default_coef), min_coef: String(s.min_coef),
      helium_plan_price: String(s.helium_plan_price), price_round: String(s.price_round),
      opening_retained_profit: String(s.opening_retained_profit || ''),
      tax_rate: s.tax_rate != null ? String(Math.round(s.tax_rate * 10000) / 100) : '',
    });
    setTax(s.tax_enabled);
  }, [settings.data]);

  const set = (k: string) => (v: string) => { setSaved(false); setF((o) => ({ ...o, [k]: v })); };
  const err = (k: string, ok: boolean, msg: string) => (ok || !(k in f) ? null : msg);

  const coef = parseAmount(f.default_coef ?? '');
  const minCoef = parseAmount(f.min_coef ?? '');
  const rate = parseAmount(f.tax_rate ?? '');
  const errors = {
    default_coef: err('default_coef', !!coef && coef > 0, 'Введите число больше нуля, например 2,4'),
    min_coef: err('min_coef', !!minCoef && minCoef > 0 && (!coef || minCoef <= coef), 'Должен быть больше нуля и не больше обычного'),
    helium_plan_price: err('helium_plan_price', amountOf(f.helium_plan_price ?? '') > 0, 'Введите цену литра'),
    price_round: err('price_round', amountOf(f.price_round ?? '') >= 1, 'Например, 100'),
    tax_rate: tax ? err('tax_rate', rate != null && rate > 0 && rate < 100, 'Введите ставку в процентах, например 3') : null,
    launch_date: err('launch_date', !!f.launch_date, 'Выберите дату'),
  };
  const bad = Object.values(errors).some(Boolean);

  const s = useSubmit(async () => {
    const { error } = await supabase.from('settings').update({
      launch_date: f.launch_date,
      default_coef: coef, min_coef: minCoef,
      helium_plan_price: amountOf(f.helium_plan_price), price_round: Math.round(amountOf(f.price_round)),
      opening_retained_profit: amountOf(f.opening_retained_profit ?? ''),
      tax_enabled: tax, tax_rate: tax && rate != null ? rate / 100 : null,
    }).eq('id', true);
    if (error) throw new Error(error.message);
  }, () => { setSaved(true); qc.invalidateQueries(); });

  if (settings.isLoading || !settings.data) return <Loading />;

  return (
    <>
      <h2>Настройки</h2>
      <Card>
        <Field label="Дата запуска учёта" error={errors.launch_date} hint="Прибыль и «Можно забрать себе» считаются с этой даты">
          <input type="date" value={f.launch_date ?? ''} onChange={(e) => set('launch_date')(e.target.value)} />
        </Field>
        <Field label="Обычная наценка (коэффициент)" error={errors.default_coef} hint="Цена = себестоимость × коэффициент">
          <input inputMode="decimal" value={f.default_coef ?? ''} onChange={(e) => set('default_coef')(e.target.value.replace(/[^\d.,]/g, ''))} />
        </Field>
        <Field label="Минимальный коэффициент" error={errors.min_coef} hint="Ниже этого приложение предупредит, что цена слишком низкая">
          <input inputMode="decimal" value={f.min_coef ?? ''} onChange={(e) => set('min_coef')(e.target.value.replace(/[^\d.,]/g, ''))} />
        </Field>
        <Field label="Цена гелия для расчёта цены, ₸ за литр" error={errors.helium_plan_price} hint="Пока нет заправок, цена шаров считается по ней">
          <MoneyInput value={f.helium_plan_price ?? ''} onChange={set('helium_plan_price')} />
        </Field>
        <Field label="Округлять цену до, ₸" error={errors.price_round} hint={`Например, ${num(100)} — цена будет кратна 100`}>
          <MoneyInput value={f.price_round ?? ''} onChange={set('price_round')} />
        </Field>
        <Field label="Прибыль, которая уже накоплена на старте" hint="Нераспределённая прибыль до даты запуска. Если не знаете — оставьте пустым">
          <MoneyInput value={f.opening_retained_profit ?? ''} onChange={set('opening_retained_profit')} />
        </Field>
        <label className="check">
          <input type="checkbox" checked={tax} onChange={(e) => { setSaved(false); setTax(e.target.checked); }} />
          Считать налоги
        </label>
        {tax && (
          <Field label="Ставка налога, %" error={errors.tax_rate}>
            <input inputMode="decimal" value={f.tax_rate ?? ''} onChange={(e) => set('tax_rate')(e.target.value.replace(/[^\d.,]/g, ''))} />
          </Field>
        )}
        <div className="explain">Налоги считаются только если вы их включите. Без этого отчёты показывают прибыль без налогов.</div>
      </Card>
      {saved && <div className="notice info">✓ Настройки сохранены</div>}
      <SubmitBar inline label="Сохранить настройки" busy={s.busy} onClick={s.submit} disabled={bad} error={s.generalError} />
    </>
  );
}
