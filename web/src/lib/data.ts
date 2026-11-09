import { useEffect } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from './supabase';
import { q } from './api';

// ---------------------------------------------------------------- types
export type Account = { account_id: string; name: string; kind: string; sort: number; active: boolean; balance: number };
export type Norm = {
  id: string; variant_id: string; helium_l: number; total_l: number | null; helium_share: number | null;
  is_mix: boolean; source: 'measured' | 'estimate' | 'cheatsheet' | 'excel'; note: string | null; set_at: string; active: boolean;
};
export type Variant = {
  id: string; product_id: string; maker: string; pack_size: string | null; real_size: string | null; photo_path: string | null;
  is_default: boolean; is_unknown: boolean; active: boolean; note: string | null; helium_norms: Norm[];
};
export type Product = {
  id: string; name: string; kind: 'balloon' | 'material' | 'helium'; category: string | null; unit: string;
  photo_path: string | null; ref_cost: number | null; ref_cost_note: string | null; wholesale_cost: number | null;
  ribbon_m_per_unit: number | null; min_stock: number | null; active: boolean; note: string | null;
  source: Record<string, unknown> | null; variants: Variant[];
};
export type StockRow = {
  product_id: string; name: string; kind: string; category: string | null; unit: string; photo_path: string | null;
  min_stock: number | null; active: boolean; physical: number; reserved: number; available: number;
  avg_cost: number; cost_is_estimate: boolean; value: number; has_opening: boolean;
};
export type TemplateLine = { id: string; product_id: string; variant_id: string | null; qty: number; sort: number };
export type Template = {
  id: string; name: string; photo_path: string | null; coef: number | null; manual_price: number | null;
  service_label: string | null; service_estimate: number; active: boolean; sort: number; template_lines: TemplateLine[];
};
export type Settings = {
  launch_date: string; default_coef: number; min_coef: number; helium_plan_price: number; price_round: number;
  tax_enabled: boolean; tax_rate: number | null; opening_retained_profit: number; minimum_reserve: number;
  helium_product_id: string | null; ribbon_product_id: string | null;
};
export type Owner = { id: string; email: string; name: string; share: number; user_id: string | null };
export type OrderRow = {
  id: string; number: number; title: string; client_name: string | null; client_phone: string | null;
  due_at: string | null; delivery: 'pickup' | 'delivery'; address: string | null; delivery_price: number;
  template_id: string | null; coef: number | null; price: number; discount: number; low_price_ack: boolean;
  comment: string | null; inscription: string | null; design: string | null; photo_path: string | null;
  service_label: string | null; service_estimate: number;
  status: 'new' | 'assembled' | 'issued' | 'cancelled'; assembled_at: string | null; issued_at: string | null;
  cancelled_at: string | null; cancel_reason: string | null; cancel_revenue: number;
  is_historical: boolean; payment_known: boolean; date_uncertain: boolean; source: Record<string, unknown> | null;
  version: number; created_at: string;
  paid: number; due: number | null; actual_cost: number | null; payment_status: string;
  helium_l: number; helium_missing: boolean; helium_approx: boolean;
};
export type OrderLine = {
  id: string; order_id: string; product_id: string; variant_id: string | null; qty: number;
  helium_l_per_unit: number | null; helium_source: string | null; helium_is_mix: boolean; ribbon_m: number; sort: number;
};
export type OrderCost = {
  id: string; order_id: string; kind: string; label: string; amount: number; is_mistake: boolean;
  occurred_at: string; account_id: string | null; supplier: string | null;
};
export type MoneyMovement = {
  id: string; occurred_at: string; account_id: string; amount: number; kind: string; order_id: string | null;
  note: string | null; created_by: string | null;
};

// ---------------------------------------------------------------- live updates
const LIVE_TABLES = ['orders', 'order_lines', 'order_costs', 'money_movements', 'stock_movements', 'products',
  'variants', 'helium_norms', 'templates', 'template_lines', 'expenses', 'reserve_items', 'settings'];

/** When the other owner saves something, every open screen refreshes. */
export function useLiveUpdates() {
  const qc = useQueryClient();
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const ch = supabase.channel('naya-live');
    for (const t of LIVE_TABLES) {
      ch.on('postgres_changes', { event: '*', schema: 'public', table: t }, () => {
        clearTimeout(timer);
        timer = setTimeout(() => qc.invalidateQueries(), 300);
      });
    }
    ch.subscribe();
    return () => {
      clearTimeout(timer);
      supabase.removeChannel(ch);
    };
  }, [qc]);
}

// ---------------------------------------------------------------- queries
export function useSettings() {
  return useQuery({
    queryKey: ['settings'],
    queryFn: () => q<Settings>(supabase.from('settings').select('*').single()),
  });
}

export function useOwners() {
  return useQuery({
    queryKey: ['owners'],
    queryFn: () => q<Owner[]>(supabase.from('owners').select('*').order('email')),
  });
}

export function useMe() {
  return useQuery({
    queryKey: ['me'],
    queryFn: async () => {
      const { data } = await supabase.auth.getUser();
      const owners = await q<Owner[]>(supabase.from('owners').select('*'));
      return owners.find((o) => o.user_id === data.user?.id) ?? null;
    },
  });
}

export function useAccounts() {
  return useQuery({
    queryKey: ['accounts'],
    queryFn: () => q<Account[]>(supabase.from('v_balances').select('*').order('sort')),
  });
}

export function useProducts() {
  return useQuery({
    queryKey: ['products'],
    queryFn: () =>
      q<Product[]>(supabase.from('products').select('*, variants(*, helium_norms(*))').order('category').order('name')),
  });
}

export function useStock() {
  return useQuery({
    queryKey: ['stock'],
    queryFn: () => q<StockRow[]>(supabase.from('v_stock').select('*').order('name')),
  });
}

export function useTemplates() {
  return useQuery({
    queryKey: ['templates'],
    queryFn: () => q<Template[]>(supabase.from('templates').select('*, template_lines(*)').order('sort').order('name')),
  });
}

export function useAttention() {
  return useQuery({
    queryKey: ['attention'],
    queryFn: () => q<{ tone: string; text: string; action: string; link: string }[]>(supabase.rpc('attention')),
  });
}

export function usePayout() {
  return useQuery({ queryKey: ['payout'], queryFn: () => q<Payout>(supabase.rpc('payout_summary')) });
}

export type Payout = {
  money: number; reserve_purchases: number; reserve_mandatory: number; reserve_planned: number; reserve_minimum: number;
  reserves: number; free: number; launch_date: string; opening_retained: number; profit_since_launch: number;
  draws: number; contributions: number; retained: number; distributable: number; limited_by: 'money' | 'profit';
  owners: Record<string, { name: string; share: number; taken: number; can_take: number }>;
};

// ---------------------------------------------------------------- helium norm & cost helpers
const SOURCE_RANK: Record<string, number> = { measured: 1, estimate: 2, cheatsheet: 3, excel: 4 };

/** Same rule as the database: measured > own estimate > cheatsheet > old spreadsheet, newest first. */
export function bestNorm(v: Variant | undefined): Norm | undefined {
  if (!v) return undefined;
  return [...v.helium_norms]
    .filter((n) => n.active)
    .sort((a, b) => SOURCE_RANK[a.source] - SOURCE_RANK[b.source] || b.set_at.localeCompare(a.set_at))[0];
}

export function defaultVariant(p: Product | undefined): Variant | undefined {
  if (!p) return undefined;
  const vs = p.variants.filter((v) => v.active);
  return vs.find((v) => v.is_default) ?? vs.find((v) => !v.is_unknown) ?? vs[0];
}

export function variantLabel(v: Variant | undefined): string {
  if (!v) return '';
  return [v.maker, v.real_size ?? v.pack_size].filter(Boolean).join(' · ');
}

export function roundUp(v: number, step: number): number {
  return step > 1 ? Math.ceil(v / step) * step : Math.ceil(v);
}
