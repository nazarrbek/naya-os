// Formatting for Kazakhstan: tenge, Asia/Almaty dates, Russian words.

export const TZ = 'Asia/Almaty';

const moneyFmt = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 0 });
const numFmt = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 2 });

export function tg(v: number | string | null | undefined): string {
  if (v === null || v === undefined || v === '') return '—';
  return `${moneyFmt.format(Math.round(Number(v)))} ₸`;
}

export function num(v: number | string | null | undefined): string {
  if (v === null || v === undefined || v === '') return '—';
  return numFmt.format(Number(v));
}

export function pct(v: number | string | null | undefined): string {
  if (v === null || v === undefined) return '—';
  return `${numFmt.format(Math.round(Number(v) * 1000) / 10)}%`;
}

const dayFmt = new Intl.DateTimeFormat('ru-RU', { timeZone: TZ, day: 'numeric', month: 'long' });
const dayYearFmt = new Intl.DateTimeFormat('ru-RU', { timeZone: TZ, day: 'numeric', month: 'long', year: 'numeric' });
const timeFmt = new Intl.DateTimeFormat('ru-RU', { timeZone: TZ, hour: '2-digit', minute: '2-digit' });
const weekdayFmt = new Intl.DateTimeFormat('ru-RU', { timeZone: TZ, weekday: 'short' });

/** Today's date in Almaty as YYYY-MM-DD. */
export function todayISO(): string {
  return isoDay(new Date());
}

export function isoDay(d: Date): string {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
  return parts; // en-CA gives YYYY-MM-DD
}

export function addDays(iso: string, n: number): string {
  const d = new Date(`${iso}T12:00:00+05:00`);
  d.setUTCDate(d.getUTCDate() + n);
  return isoDay(d);
}

/** "сегодня 15:00", "завтра 10:30", "12 ноября, пт 14:00" */
export function when(ts: string | null | undefined, withTime = true): string {
  if (!ts) return 'без даты';
  const d = new Date(ts);
  const day = isoDay(d);
  const today = todayISO();
  let label: string;
  if (day === today) label = 'сегодня';
  else if (day === addDays(today, 1)) label = 'завтра';
  else if (day === addDays(today, -1)) label = 'вчера';
  else {
    const sameYear = day.slice(0, 4) === today.slice(0, 4);
    label = `${(sameYear ? dayFmt : dayYearFmt).format(d)}, ${weekdayFmt.format(d)}`;
  }
  return withTime ? `${label} ${timeFmt.format(d)}` : label;
}

/** "12 ноября 2026" for a YYYY-MM-DD string */
export function dayLabel(iso: string): string {
  return dayYearFmt.format(new Date(`${iso}T12:00:00+05:00`));
}

/** Local datetime-input value (YYYY-MM-DDTHH:mm) in Almaty → ISO with +05:00 offset. */
export function localInputToISO(v: string): string | null {
  if (!v) return null;
  return `${v}:00+05:00`;
}

export function isoToLocalInput(ts: string | null | undefined): string {
  if (!ts) return '';
  const d = new Date(ts);
  const p = new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(d);
  const g = (t: string) => p.find((x) => x.type === t)?.value ?? '';
  return `${g('year')}-${g('month')}-${g('day')}T${g('hour') === '24' ? '00' : g('hour')}:${g('minute')}`;
}

export function nowLocalInput(): string {
  return isoToLocalInput(new Date().toISOString());
}

export const SOURCE_LABEL: Record<string, string> = {
  measured: 'замер',
  estimate: 'своя оценка',
  cheatsheet: 'по шпаргалке',
  excel: 'из старой таблицы',
};

export const STATUS_LABEL: Record<string, string> = {
  new: 'Принят',
  assembled: 'Собран',
  issued: 'Выдан',
  cancelled: 'Отменён',
};

export const PAYMENT_LABEL: Record<string, string> = {
  unpaid: 'Не оплачен',
  partial: 'Предоплата',
  paid: 'Оплачен',
  overpaid: 'Переплата',
  unknown: 'Оплата до запуска учёта',
};

export function parseAmount(v: string): number | null {
  const s = v.replace(/\s/g, '').replace(',', '.');
  if (s === '') return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}
