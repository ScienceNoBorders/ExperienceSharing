import raw from "../../catalog/plans.json";
import type { BillingCycle, PricePoint } from "./money";

export type IpBucket = "datacenter" | "native" | "residential";
export type VendorId = "lisahost" | "bwh";

export type Plan = {
  id: string;
  vendor: VendorId;
  pid: number;
  name_zh: string;
  html_section: string;
  series: string;
  ip_bucket: IpBucket;
  native_ip: boolean;
  residential: boolean;
  route: string;
  regions: string[];
  cn_path: string;
  route_note?: string;
  prices: PricePoint[];
  spec: Record<string, unknown> & {
    ram_mb?: number;
    disk_gb?: number;
    traffic_gb_month?: number | null;
    bandwidth_mbps?: number;
    config_text?: string;
    ram?: string;
    cpu?: string;
    disk?: string;
    traffic?: string;
    bandwidth?: string;
    rooms?: string;
    traffic_bw?: string;
  };
  affiliate_url: string;
  featured_on_vendor_home: boolean;
  rec_row: boolean;
  similar_to: string[];
  exclude_daily: boolean;
};

export const catalog = raw as { last_verified_at: string; fx_usd_cny: number; plans: Plan[] };
export const plans: Plan[] = catalog.plans;
export const fx = catalog.fx_usd_cny;
export const lastVerified = catalog.last_verified_at;

export const VENDOR_ZH: Record<VendorId, string> = { lisahost: "LisaHost", bwh: "搬瓦工" };
export const IP_ZH: Record<IpBucket, string> = {
  datacenter: "数据中心 IP",
  native: "原生 IP",
  residential: "住宅 IP",
};
export const REGION_ZH: Record<string, string> = {
  US: "美国",
  HK: "香港",
  SG: "新加坡",
  JP: "日本",
  TW: "台湾",
  UK: "英国",
  NL: "荷兰",
  CA: "加拿大",
  AE: "迪拜",
};

export const ROUTE_UI: Record<string, string> = {
  cn2: "CN2",
  cn2_gia: "CN2 GIA",
  cn2_gia_e: "CN2 GIA",
  "9929": "9929",
  as9929: "9929",
  "4837": "4837",
  as4837: "4837",
  cmi: "CMI",
  bgp: "BGP",
  znet: "基础",
  softbank: "软银",
  mixed_premium: "基础",
};

export function cnPathHint(plan: Pick<Plan, "cn_path">): { cls: string; text: string } | null {
  if (plan.cn_path === "cn_optimized") return { cls: "tag tag-opt", text: "⚡ 大陆优化" };
  if (plan.cn_path === "relay_suggested") return { cls: "tag tag-relay", text: "⚠️ 建议中转" };
  return null;
}

export function routeUiGroup(route: string): string {
  if (route === "cn2_gia" || route === "cn2_gia_e") return "cn2_gia";
  if (route === "as9929" || route === "9929") return "9929";
  if (route === "as4837" || route === "4837") return "4837";
  if (route === "znet" || route === "mixed_premium" || route === "softbank") return "bgp";
  return route;
}

export function planById(id: string): Plan | undefined {
  return plans.find((p) => p.id === id);
}

export const FEATURED_IDS = ["lisahost-59", "lisahost-91", "bwh-44", "bwh-87", "bwh-95"];
export const ANNUAL_LISA_IDS = plans
  .filter((p) => p.vendor === "lisahost" && p.series === "annual")
  .map((p) => p.id);

export const DETAIL_IDS = new Set([...FEATURED_IDS, ...ANNUAL_LISA_IDS]);

export const SERIES_LABEL: Record<string, string> = {
  annual: "年付特价",
  us9929: "美国 9929 住宅",
  us4837: "美国 4837 大带宽",
  cera: "美国 CERA 高防",
  hk: "香港 CMI",
  sg: "新加坡",
  tw: "台湾",
  jp: "日本",
  uk: "英国",
  kvm: "KVM 常规",
  "gia-e": "CN2 GIA-E",
  sla: "SLA",
  "bwh-sg": "新加坡 CN2 GIA",
  osaka: "大阪",
  tokyo: "东京",
  "bwh-hk": "香港 CN2 GIA",
  dubai: "迪拜",
};

export function specLine(plan: Plan): string {
  const s = plan.spec;
  return (
    s.config_text ||
    [s.cpu, s.ram, s.disk].filter(Boolean).join(" / ") ||
    `${s.ram_mb ?? "?"}MB RAM`
  );
}

export function hasCycle(plan: Plan, cycle: BillingCycle): boolean {
  return plan.prices.some((p) => p.cycle === cycle);
}
