export type BillingCycle = "daily" | "monthly" | "quarterly" | "semiannual" | "annual";

export const TO_YEAR: Record<BillingCycle, number> = {
  daily: 365,
  monthly: 12,
  quarterly: 4,
  semiannual: 2,
  annual: 1,
};

export const CYCLE_ZH: Record<BillingCycle, string> = {
  daily: "天",
  monthly: "月",
  quarterly: "季",
  semiannual: "半年",
  annual: "年",
};

export type PricePoint = { amount: number; currency: "CNY" | "USD"; cycle: BillingCycle };

export function usdToCny(usd: number, fx: number): number {
  return Math.round(usd * fx * 100) / 100;
}

export function unitCny(p: PricePoint, fx: number): number {
  return p.currency === "USD" ? usdToCny(p.amount, fx) : p.amount;
}

export function payable(
  prices: PricePoint[],
  budgetCycle: BillingCycle,
  infer: boolean,
  fx: number,
): { amount_cny: number; source_cycle: BillingCycle; inferred: boolean; raw: PricePoint } | null {
  const exact = prices.find((p) => p.cycle === budgetCycle);
  let pick = exact ?? null;
  let inferred = false;
  if (!pick && infer) {
    let bestYearly: number | null = null;
    for (const p of prices) {
      const yearly = unitCny(p, fx) * TO_YEAR[p.cycle];
      if (bestYearly === null || yearly < bestYearly) {
        bestYearly = yearly;
        pick = p;
      }
    }
    inferred = true;
  }
  if (!pick) return null;
  const yearly = unitCny(pick, fx) * TO_YEAR[pick.cycle];
  const amount_cny = Math.round((yearly / TO_YEAR[budgetCycle]) * 100) / 100;
  return { amount_cny, source_cycle: pick.cycle, inferred, raw: pick };
}

export function formatPrices(prices: PricePoint[], fx: number): string {
  return prices
    .map((p) =>
      p.currency === "USD"
        ? `$${p.amount}/${CYCLE_ZH[p.cycle]} (≈¥${usdToCny(p.amount, fx).toFixed(2)})`
        : `¥${p.amount}/${CYCLE_ZH[p.cycle]}`,
    )
    .join(" · ");
}
