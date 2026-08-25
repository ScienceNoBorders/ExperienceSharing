import type { Plan } from "./catalog";
import { routeUiGroup } from "./catalog";
import { payable, type BillingCycle } from "./money";

export type FilterQuery = {
  budget: number | null;
  cycle: BillingCycle;
  region: string; // "" = any
  route: string; // "" = any, cn2_gia includes gia_e
  ip: string[]; // buckets, empty = all
  vendor: string; // "" = any
  strictCycle: boolean;
};

export function matchPlan(plan: Plan, q: FilterQuery, fx: number): boolean {
  if (q.vendor && plan.vendor !== q.vendor) return false;
  if (q.region && !plan.regions.includes(q.region)) return false;
  if (q.route && routeUiGroup(plan.route) !== q.route && plan.route !== q.route) return false;
  if (q.ip.length && !q.ip.includes(plan.ip_bucket)) return false;
  if (q.strictCycle && !plan.prices.some((p) => p.cycle === q.cycle)) return false;
  if (q.budget != null) {
    const pay = payable(plan.prices, q.cycle, !q.strictCycle, fx);
    if (!pay || pay.amount_cny > q.budget * 1.02) return false;
  }
  return true;
}
