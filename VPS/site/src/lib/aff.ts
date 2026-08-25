export const LISA_AFF = "13150";
export const BWH_AFF = "76211";
export const LISA_CODE = "TS-CBP205DQJE";

export function assertAffiliate(url: string): boolean {
  if (url.includes("lisahost.com")) return url.includes(`aff=${LISA_AFF}`);
  if (url.includes("bwh81.net") || url.includes("bandwagonhost")) return url.includes(`aff=${BWH_AFF}`);
  return false;
}
