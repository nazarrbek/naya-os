import type { Product, Settings, StockRow, Variant } from './data';
import { bestNorm, defaultVariant, roundUp } from './data';

/** A composition line being edited in the order form. */
export type DraftLine = {
  key: string;
  product_id: string;
  variant_id: string | null;
  qty: number;
  /** null = take the norm of the chosen maker; a number = set by hand for this order */
  helium_override: number | null;
  helium_source_override: string | null;
};

export type LineCalc = {
  product?: Product;
  variant?: Variant;
  heliumPerUnit: number | null;
  heliumSource: string | null;
  isMix: boolean;
  ribbon: number;
  heliumTotal: number;
  materialCost: number;
  heliumCost: number;
  ribbonCost: number;
  cost: number;
  costIsEstimate: boolean;
};

export function calcLine(
  l: DraftLine, products: Product[], stock: StockRow[], s: Settings,
): LineCalc {
  const product = products.find((p) => p.id === l.product_id);
  const variant = product?.variants.find((v) => v.id === l.variant_id) ?? (product?.kind === 'balloon' ? defaultVariant(product) : undefined);
  const norm = bestNorm(variant);
  const isBalloon = product?.kind === 'balloon';
  const heliumPerUnit = !isBalloon ? 0 : l.helium_override ?? (norm ? Number(norm.helium_l) : null);
  const heliumSource = !isBalloon ? null : l.helium_override !== null ? (l.helium_source_override ?? 'estimate') : norm?.source ?? null;
  const st = stock.find((x) => x.product_id === l.product_id);
  const unit = st ? Number(st.avg_cost) : Number(product?.ref_cost ?? 0);
  const ribbonAvg = Number(stock.find((x) => x.product_id === s.ribbon_product_id)?.avg_cost ?? 0);
  const ribbon = l.qty * Number(product?.ribbon_m_per_unit ?? 0);
  const materialCost = l.qty * unit;
  const heliumCost = l.qty * (heliumPerUnit ?? 0) * Number(s.helium_plan_price);
  const ribbonCost = ribbon * ribbonAvg;
  return {
    product, variant, heliumPerUnit, heliumSource, isMix: norm?.is_mix ?? false, ribbon,
    heliumTotal: l.qty * (heliumPerUnit ?? 0),
    materialCost, heliumCost, ribbonCost, cost: materialCost + heliumCost + ribbonCost,
    costIsEstimate: st ? st.cost_is_estimate : true,
  };
}

export type Pricing = {
  cost: number; heliumL: number; isApprox: boolean; coef: number; recommended: number; minPrice: number;
};

export function calcPricing(calcs: LineCalc[], serviceEstimate: number, s: Settings, coef: number | null): Pricing {
  const cost = calcs.reduce((t, c) => t + c.cost, 0) + serviceEstimate;
  const heliumL = calcs.reduce((t, c) => t + c.heliumTotal, 0);
  const k = coef ?? Number(s.default_coef);
  return {
    cost,
    heliumL,
    isApprox: calcs.some((c) => c.costIsEstimate || (c.product?.kind === 'balloon' && c.heliumSource !== 'measured')) || serviceEstimate > 0,
    coef: k,
    recommended: roundUp(cost * k, Number(s.price_round)),
    minPrice: Math.round(cost * Number(s.min_coef)),
  };
}

/** Profit / margin / markup with the correct formulas. */
export function profitOf(price: number, cost: number) {
  const profit = price - cost;
  return {
    profit,
    margin: price > 0 ? profit / price : null,   // прибыль ÷ цена
    markup: cost > 0 ? profit / cost : null,     // прибыль ÷ себестоимость
  };
}
