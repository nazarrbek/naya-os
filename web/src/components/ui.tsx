import { useRef, useState, type ReactNode } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '../lib/supabase';
import { AppError, newRequestId } from '../lib/api';
import { parseAmount, tg } from '../lib/format';
import type { Account } from '../lib/data';

export function Page({ title, back, children, actions }: { title: string; back?: string | true; children: ReactNode; actions?: ReactNode }) {
  const nav = useNavigate();
  return (
    <div className="page">
      <header className="page-head">
        {back ? (
          <button className="back" aria-label="Назад" onClick={() => (back === true ? nav(-1) : nav(back))}>‹</button>
        ) : null}
        <h1>{title}</h1>
        {actions ? <div className="head-actions">{actions}</div> : null}
      </header>
      {children}
    </div>
  );
}

export function Card({ children, className = '', onClick }: { children: ReactNode; className?: string; onClick?: () => void }) {
  return (
    <div className={`card ${onClick ? 'tappable' : ''} ${className}`} onClick={onClick}>
      {children}
    </div>
  );
}

export function Field({ label, error, hint, children, action }: {
  label: string; error?: string | null; hint?: ReactNode; children: ReactNode; action?: ReactNode;
}) {
  return (
    <label className={`field ${error ? 'has-error' : ''}`}>
      <span className="field-label">{label}</span>
      {children}
      {error ? <span className="field-error" role="alert">{error}{action ? <> {action}</> : null}</span> : null}
      {!error && hint ? <span className="field-hint">{hint}</span> : null}
    </label>
  );
}

export function MoneyInput({ value, onChange, placeholder = '0', autoFocus }: {
  value: string; onChange: (v: string) => void; placeholder?: string; autoFocus?: boolean;
}) {
  return (
    <div className="money-input">
      <input
        inputMode="decimal"
        value={value}
        placeholder={placeholder}
        autoFocus={autoFocus}
        onChange={(e) => onChange(e.target.value.replace(/[^\d.,\s]/g, ''))}
      />
      <span>₸</span>
    </div>
  );
}

export function amountOf(v: string): number {
  return parseAmount(v) ?? 0;
}

/** Big buttons to pick an account: "Kaspi", "Наличные"... */
export function AccountPicker({ accounts, value, onChange, showBalance }: {
  accounts: Account[] | undefined; value: string | null; onChange: (id: string) => void; showBalance?: boolean;
}) {
  return (
    <div className="choice-row">
      {(accounts ?? []).filter((a) => a.active).map((a) => (
        <button type="button" key={a.account_id} aria-label={a.name} aria-pressed={value === a.account_id} className={`choice ${value === a.account_id ? "on" : ""}`} onClick={() => onChange(a.account_id)}>
          {a.name}
          {showBalance ? <small>{tg(a.balance)}</small> : null}
        </button>
      ))}
    </div>
  );
}

export function Choice<T extends string>({ options, value, onChange }: {
  options: { value: T; label: ReactNode }[]; value: T | null; onChange: (v: T) => void;
}) {
  return (
    <div className="choice-row">
      {options.map((o) => (
        <button type="button" key={o.value} aria-pressed={value === o.value} aria-label={typeof o.label === "string" ? o.label : undefined} className={`choice ${value === o.value ? "on" : ""}`} onClick={() => onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Sheet({ open, onClose, title, children }: { open: boolean; onClose: () => void; title: string; children: ReactNode }) {
  if (!open) return null;
  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div className="sheet" onClick={(e) => e.stopPropagation()} role="dialog" aria-label={title}>
        <div className="sheet-head">
          <h2>{title}</h2>
          <button className="sheet-close" onClick={onClose} aria-label="Закрыть">×</button>
        </div>
        {children}
      </div>
    </div>
  );
}

export function Badge({ tone = 'neutral', children }: { tone?: 'neutral' | 'ok' | 'warn' | 'bad' | 'info' | 'approx'; children: ReactNode }) {
  return <span className={`badge ${tone}`}>{children}</span>;
}

export function Row({ label, value, to, sub, strong }: { label: ReactNode; value?: ReactNode; to?: string; sub?: ReactNode; strong?: boolean }) {
  const body = (
    <>
      <div className="row-main">
        <span className="row-label">{label}</span>
        {sub ? <span className="row-sub">{sub}</span> : null}
      </div>
      {value !== undefined ? <span className={`row-value ${strong ? 'strong' : ''}`}>{value}</span> : null}
      {to ? <span className="chev">›</span> : null}
    </>
  );
  return to ? <Link className="row tappable" to={to}>{body}</Link> : <div className="row">{body}</div>;
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="empty">{children}</div>;
}

export function Loading() {
  return <div className="empty">Загружаю…</div>;
}

/** Note shown next to a number that is not exact (estimate, eyeballed helium). */
export function Approx({ show, children = 'примерно' }: { show: boolean; children?: ReactNode }) {
  return show ? <Badge tone="approx">{children}</Badge> : null;
}

/**
 * Form submit helper: one request id per form, so a double tap or a retry after a network error
 * is recorded once. A new id is issued only after a successful save.
 */
export function useSubmit<T>(fn: (requestId: string) => Promise<T>, onDone?: (r: T) => void) {
  const reqId = useRef(newRequestId());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<AppError | null>(null);
  async function submit() {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const r = await fn(reqId.current);
      reqId.current = newRequestId();
      onDone?.(r);
    } catch (e) {
      setError(e instanceof AppError ? e : new AppError(String((e as Error)?.message ?? e)));
    } finally {
      setBusy(false);
    }
  }
  const errorFor = (...fields: string[]) => (error && fields.includes(error.field) ? error.message : null);
  const generalError = error && !error.field ? error.message : null;
  return { submit, busy, error, errorFor, generalError, clearError: () => setError(null), resetRequest: () => { reqId.current = newRequestId(); } };
}

export function SubmitBar({ label, busy, onClick, error, disabled, inline }: {
  label: string; busy: boolean; onClick: () => void; error?: string | null; disabled?: boolean; inline?: boolean;
}) {
  return (
    <div className={`submit-bar ${inline ? "inline" : ""}`}>
      {error ? <div className="form-error" role="alert">{error}</div> : null}
      <button className="btn primary big" disabled={busy || disabled} onClick={onClick}>
        {busy ? 'Сохраняю…' : label}
      </button>
    </div>
  );
}

export function Stepper({ value, onChange, min = 0, step = 1 }: { value: number; onChange: (v: number) => void; min?: number; step?: number }) {
  return (
    <div className="stepper">
      <button type="button" aria-label="Меньше" onClick={() => onChange(Math.max(min, +(value - step).toFixed(3)))}>−</button>
      <input inputMode="decimal" value={String(value)} onChange={(e) => onChange(parseAmount(e.target.value) ?? 0)} />
      <button type="button" aria-label="Больше" onClick={() => onChange(+(value + step).toFixed(3))}>+</button>
    </div>
  );
}

export function Photo({ path, alt, size = 56 }: { path: string | null | undefined; alt: string; size?: number }) {
  const url = usePhotoUrl(path);
  return url ? (
    <img className="thumb" src={url} alt={alt} width={size} height={size} />
  ) : (
    <span className="thumb placeholder" style={{ width: size, height: size }} aria-hidden>🎈</span>
  );
}

export function usePhotoUrl(path: string | null | undefined) {
  const { data } = useQuery({
    queryKey: ['photo', path],
    enabled: !!path,
    staleTime: 50 * 60 * 1000,
    queryFn: async () => {
      const { data } = await supabase.storage.from('photos').createSignedUrl(path!, 3600);
      return data?.signedUrl ?? null;
    },
  });
  return data ?? null;
}

export async function uploadPhoto(file: File, folder: string): Promise<string> {
  const ext = file.name.split('.').pop() || 'jpg';
  const path = `${folder}/${crypto.randomUUID()}.${ext}`;
  const { error } = await supabase.storage.from('photos').upload(path, file, { contentType: file.type });
  if (error) throw new AppError('Не удалось загрузить фото. Попробуйте ещё раз');
  return path;
}
