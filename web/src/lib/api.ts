import { supabase } from './supabase';

/** Error from a posting function: a human message plus the form field it belongs to. */
export class AppError extends Error {
  field: string;
  constructor(message: string, field = '') {
    super(message);
    this.field = field;
  }
}

function toAppError(e: { message?: string; hint?: string | null; code?: string } | null): AppError {
  if (!e) return new AppError('Что-то пошло не так. Попробуйте ещё раз');
  if (e.code === 'P0001') return new AppError(e.message ?? 'Ошибка', e.hint ?? '');
  if (e.message?.includes('Failed to fetch') || e.message?.includes('NetworkError')) {
    return new AppError('Нет связи с интернетом. Проверьте сеть и нажмите ещё раз — запись не задвоится');
  }
  return new AppError(e.message ?? 'Что-то пошло не так. Попробуйте ещё раз');
}

/**
 * Calls a posting function. The request id is created once per form and reused on retries,
 * so a double tap or a repeated request is recorded only once.
 */
export async function rpc<T = Record<string, unknown>>(fn: string, args: Record<string, unknown>): Promise<T> {
  const { data, error } = await supabase.rpc(fn, args);
  if (error) throw toAppError(error);
  return data as T;
}

export async function q<T>(promise: PromiseLike<{ data: T | null; error: { message: string; code?: string; hint?: string | null } | null }>): Promise<T> {
  const { data, error } = await promise;
  if (error) throw toAppError(error);
  return data as T;
}

export function newRequestId(): string {
  return crypto.randomUUID();
}
