import { useState } from 'react';
import { supabase } from '../lib/supabase';
import { useMe } from '../lib/data';
import { Card, Page, Row } from '../components/ui';

// [file name, table or view]
const EXPORTS: [string, string][] = [
  ['orders', 'v_orders'], ['order_lines', 'order_lines'], ['order_costs', 'order_costs'], ['money_movements', 'money_movements'],
  ['stock_movements', 'stock_movements'], ['expenses', 'expenses'], ['purchases', 'purchases'], ['purchase_lines', 'purchase_lines'],
  ['owner_flows', 'owner_flows'], ['products', 'products'], ['variants', 'variants'], ['helium_norms', 'helium_norms'],
  ['templates', 'templates'], ['template_lines', 'template_lines'],
];

function csvCell(v: unknown): string {
  if (v === null || v === undefined) return '';
  const s = typeof v === 'object' ? JSON.stringify(v) : String(v);
  return /[",\n\r;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function toCsv(rows: Record<string, unknown>[]): string {
  if (rows.length === 0) return '';
  const cols = [...new Set(rows.flatMap((r) => Object.keys(r)))];
  return [cols.join(','), ...rows.map((r) => cols.map((c) => csvCell(r[c])).join(','))].join('\r\n');
}

async function fetchAll(table: string): Promise<Record<string, unknown>[]> {
  const out: Record<string, unknown>[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabase.from(table).select('*').range(from, from + 999);
    if (error) throw new Error(error.message);
    out.push(...(data ?? []));
    if (!data || data.length < 1000) return out;
  }
}

function download(name: string, text: string) {
  // BOM so Excel reads Cyrillic as UTF-8
  const url = URL.createObjectURL(new Blob(['\uFEFF', text], { type: 'text/csv;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

export default function More() {
  const me = useMe();
  const [state, setState] = useState<{ busy: boolean; done?: number; error?: string }>({ busy: false });

  async function exportAll() {
    setState({ busy: true, done: 0 });
    try {
      let n = 0;
      for (const [file, table] of EXPORTS) {
        download(`${file}.csv`, toCsv(await fetchAll(table)));
        setState({ busy: true, done: ++n });
        await new Promise((r) => setTimeout(r, 400));
      }
      setState({ busy: false, done: n });
    } catch (e) {
      setState({ busy: false, error: `Не удалось выгрузить: ${(e as Error).message}. Проверьте интернет и нажмите ещё раз.` });
    }
  }

  return (
    <Page title="Ещё">
      {me.data ? <p className="muted small">Вы вошли как {me.data.name} ({me.data.email})</p> : null}
      <Card>
        <Row label="Отчёты" to="/reports" />
        <Row label="Каталог" to="/catalog" />
        <Row label="Готовые композиции" to="/templates" />
        <Row label="Склад: пересчитать" to="/stock/count" />
        <Row label="Запуск учёта и настройки" to="/setup" />
      </Card>
      <Card>
        <button className="btn block" disabled={state.busy} onClick={exportAll}>
          {state.busy ? `Готовлю файлы… ${state.done ?? 0} из ${EXPORTS.length}` : 'Экспорт в Excel (CSV)'}
        </button>
        <p className="muted small">Скачается по одному файлу на каждую таблицу. Если телефон спросит разрешение на несколько загрузок — разрешите.</p>
        {state.error ? <div className="form-error" role="alert">{state.error}</div> : null}
        {!state.busy && !state.error && state.done ? <p className="small">Готово: скачано файлов — {state.done}.</p> : null}
      </Card>
      <button className="btn block danger" onClick={() => supabase.auth.signOut()}>Выйти</button>
    </Page>
  );
}
