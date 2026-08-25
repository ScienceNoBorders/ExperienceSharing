import { flags } from "./flags";
import type { Plan } from "./catalog";
import { payable, TO_YEAR, type BillingCycle } from "./money";

const W_WEB = {
  budget: 0.22,
  ram: 0.16,
  disk: 0.12,
  traffic: 0.12,
  route: 0.14,
  ip: 0.1,
  value: 0.08,
  editorial: 0.06,
};

const ROUTE_BASE: Record<string, number> = {
  cn2_gia: 95,
  cn2_gia_e: 95,
  cmi: 95,
  "9929": 88,
  as9929: 88,
  softbank: 80,
  "4837": 75,
  as4837: 75,
  cn2: 70,
  bgp: 55,
  znet: 40,
  mixed_premium: 40,
  unknown: 30,
};

function clamp(n: number, lo = 0, hi = 100): number {
  return Math.min(hi, Math.max(lo, n));
}
function lerp(x0: number, x1: number, y0: number, y1: number, x: number): number {
  return y0 + ((y1 - y0) * (x - x0)) / (x1 - x0);
}
function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

function ramFactor(mb: number): number {
  if (mb >= 4096) return 100;
  if (mb >= 2048) return lerp(2048, 4096, 80, 100, mb);
  if (mb >= 1024) return lerp(1024, 2048, 55, 80, mb);
  if (mb >= 512) return lerp(512, 1024, 20, 55, mb);
  return 20 * (mb / 512);
}
function diskFactor(gb: number): number {
  if (gb >= 80) return 100;
  if (gb >= 40) return lerp(40, 80, 85, 100, gb);
  if (gb >= 20) return lerp(20, 40, 60, 85, gb);
  if (gb >= 10) return lerp(10, 20, 30, 60, gb);
  return 30 * (gb / 10);
}
function trafficFactor(gb: number | null | undefined, bw: number): number {
  if (gb == null) return bw < 30 ? 70 : 100;
  if (gb >= 2000) return 100;
  if (gb >= 1000) return lerp(1000, 2000, 70, 100, gb);
  if (gb >= 400) return lerp(400, 1000, 40, 70, gb);
  if (gb >= 200) return lerp(200, 400, 15, 40, gb);
  return 15 * (gb / 200);
}

export type WizardInput = {
  budget_cny: number;
  budget_cycle: BillingCycle;
  regions: string[];
  ip_need: "any" | "native" | "residential" | "datacenter";
  exclude_daily?: boolean;
};

export type Ranked = {
  plan: Plan;
  score: number;
  pay: NonNullable<ReturnType<typeof payable>>;
};

export function scorePlan(plan: Plan, pay: NonNullable<ReturnType<typeof payable>>, input: WizardInput): number {
  const ram = Number(plan.spec.ram_mb ?? 1024);
  const disk = Number(plan.spec.disk_gb ?? 10);
  const traffic = (plan.spec.traffic_gb_month ?? 200) as number | null;
  const bw = Number(plan.spec.bandwidth_mbps ?? 50);
  const yearly = pay.amount_cny * TO_YEAR[input.budget_cycle];
  let route = ROUTE_BASE[plan.route] ?? 30;
  if (plan.cn_path === "relay_suggested") route = Math.min(route, 40);
  let ip = 40;
  if (input.ip_need === "native") ip = plan.native_ip ? 100 : 0;
  else if (input.ip_need === "residential") ip = plan.residential ? 100 : 0;
  else if (input.ip_need === "datacenter") ip = plan.ip_bucket === "datacenter" ? 100 : 40;
  else ip = plan.native_ip ? 80 : 40;
  let editorial = 0;
  if (plan.rec_row) editorial += 20;
  if (plan.featured_on_vendor_home) editorial += 15;
  editorial = Math.min(100, editorial);
  const r = yearly ? ram / (yearly / 12) : 0;
  let value = 20 * (r / 10);
  if (r >= 50) value = 100;
  else if (r >= 40) value = lerp(40, 50, 85, 100, r);
  else if (r >= 30) value = lerp(30, 40, 70, 85, r);
  else if (r >= 20) value = lerp(20, 30, 50, 70, r);
  else if (r >= 10) value = lerp(10, 20, 20, 50, r);
  const f = {
    budget: clamp(100 * (1 - pay.amount_cny / input.budget_cny)),
    ram: ramFactor(ram),
    disk: diskFactor(disk),
    traffic: trafficFactor(traffic, bw),
    route,
    ip,
    value,
    editorial,
  };
  const raw = (Object.keys(W_WEB) as (keyof typeof W_WEB)[]).reduce((s, k) => s + W_WEB[k] * f[k], 0);
  return round1(clamp(raw));
}

export function recommendTopK(all: Plan[], input: WizardInput, fx: number, k = 3): Ranked[] {
  const ranked: Ranked[] = [];
  for (const plan of all) {
    if (input.exclude_daily !== false && plan.exclude_daily) continue;
    if (input.ip_need === "native") {
      if (!plan.native_ip || plan.ip_bucket === "datacenter") continue;
      if (plan.vendor === "bwh" && !flags.bwh_counts_as_native) continue;
    }
    if (input.ip_need === "residential" && !plan.residential) continue;
    if (input.ip_need === "datacenter" && plan.ip_bucket !== "datacenter") continue;
    if (input.regions.length && !plan.regions.some((r) => input.regions.includes(r))) continue;
    const pay = payable(plan.prices, input.budget_cycle, true, fx);
    if (!pay) continue;
    if (pay.amount_cny > input.budget_cny * 1.02) continue;
    ranked.push({ plan, pay, score: scorePlan(plan, pay, input) });
  }
  ranked.sort((a, b) => b.score - a.score || a.pay.amount_cny - b.pay.amount_cny);
  const top: Ranked[] = [];
  const seriesCount = new Map<string, number>();
  for (const item of ranked) {
    if ((seriesCount.get(item.plan.series) ?? 0) >= 2) continue;
    if (item.plan.similar_to.some((id) => top.some((t) => t.plan.id === id))) continue;
    seriesCount.set(item.plan.series, (seriesCount.get(item.plan.series) ?? 0) + 1);
    top.push(item);
    if (top.length === k) break;
  }
  return top;
}

export const NORTH_STAR: WizardInput = {
  budget_cny: 500,
  budget_cycle: "annual",
  regions: ["US"],
  ip_need: "native",
  exclude_daily: true,
};
