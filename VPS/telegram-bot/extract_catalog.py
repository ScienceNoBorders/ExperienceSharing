#!/usr/bin/env python3
"""Parse html/bwgVps.html into catalog/plans.json. Table row + cart URL is source of truth."""

from __future__ import annotations

import json
import re
from html import unescape
from pathlib import Path

ROOT = Path(__file__).resolve().parent
HTML_PATH = ROOT.parent / "html" / "bwgVps.html"
OUT_PATH = ROOT / "catalog" / "plans.json"

LISA_PID = re.compile(r"lisahost\.com/cart\.php\?a=add&pid=(\d+)", re.I)
BWH_PID = re.compile(r"bwh81\.net/aff\.php\?aff=76211&pid=(\d+)", re.I)
TR_RE = re.compile(r"<tr([^>]*)>(.*?)</tr>", re.S | re.I)
TD_RE = re.compile(r"<td([^>]*)>(.*?)</td>", re.S | re.I)
SECTION_RE = re.compile(r"<section[^>]*id=\"([^\"]+)\"", re.I)
TAG_RE = re.compile(r"<span class=\"tag[^\"]*\">([^<]+)</span>", re.I)
BOLD_RE = re.compile(r"<b>(.*?)</b>", re.S | re.I)
LABEL_RE = re.compile(r'data-label="([^"]+)"', re.I)
PRICE_RE = re.compile(r"([¥$])(\d+(?:\.\d+)?)\s*<small>/([^<]+)</small>", re.I)
STRIP_TAGS = re.compile(r"<[^>]+>")

CYCLE_MAP = [
    ("半年", "semiannual"),
    ("季度", "quarterly"),
    ("季", "quarterly"),
    ("年起", "annual"),
    ("年", "annual"),
    ("月", "monthly"),
    ("1天", "daily"),
    ("天", "daily"),
]

INHERIT = {
    "lisa-annual": {"series": "annual"},
    "lisa-us9929": {
        "series": "us9929",
        "ip_bucket": "residential",
        "native_ip": True,
        "residential": True,
        "route": "9929",
        "regions": ["US"],
        "cn_path": "cn_optimized",
        "name_prefix": "美国 9929",
    },
    "lisa-us4837": {
        "series": "us4837",
        "ip_bucket": "residential",
        "native_ip": True,
        "residential": True,
        "route": "4837",
        "regions": ["US"],
        "cn_path": "cn_optimized",
        "name_prefix": "美国 4837",
    },
    "lisa-cera": {
        "series": "cera",
        "ip_bucket": "native",
        "native_ip": True,
        "residential": False,
        "route": "cn2_gia",
        "regions": ["US"],
        "cn_path": "cn_optimized",
        "name_prefix": "美国 CERA",
    },
    "lisa-hk": {
        "series": "hk",
        "ip_bucket": "native",
        "native_ip": True,
        "residential": False,
        "route": "cmi",
        "regions": ["HK"],
        "cn_path": "cn_optimized",
        "name_prefix": "香港 CMI",
    },
    "lisa-sg": {
        "series": "sg",
        "ip_bucket": "native",
        "native_ip": True,
        "residential": False,
        "route": "bgp",
        "regions": ["SG"],
        "cn_path": "relay_suggested",
        "name_prefix": "新加坡",
    },
    "lisa-tw": {
        "series": "tw",
        "ip_bucket": "native",
        "native_ip": True,
        "residential": False,
        "route": "bgp",
        "regions": ["TW"],
        "cn_path": "relay_suggested",
        "name_prefix": "台湾",
    },
    "lisa-jp": {
        "series": "jp",
        "ip_bucket": "native",
        "native_ip": True,
        "residential": False,
        "route": "bgp",
        "regions": ["JP"],
        "cn_path": "cn_optimized",
        "name_prefix": "日本",
    },
    "lisa-uk": {
        "series": "uk",
        "ip_bucket": "residential",
        "native_ip": True,
        "residential": True,
        "route": "bgp",
        "regions": ["UK"],
        "cn_path": "relay_suggested",
        "name_prefix": "英国",
    },
    "kvm": {
        "series": "kvm",
        "ip_bucket": "datacenter",
        "native_ip": False,
        "residential": False,
        "route": "znet",
        "regions": ["US", "CA", "NL"],
        "cn_path": "relay_suggested",
        "name_prefix": "搬瓦工 KVM",
    },
    "gia-e": {
        "series": "gia-e",
        "ip_bucket": "datacenter",
        "native_ip": False,
        "residential": False,
        "route": "cn2_gia_e",
        "regions": ["US", "JP", "NL", "CA"],
        "cn_path": "cn_optimized",
        "name_prefix": "搬瓦工 CN2 GIA-E",
    },
    "sla": {
        "series": "sla",
        "ip_bucket": "datacenter",
        "native_ip": False,
        "residential": False,
        "route": "cn2_gia",
        "regions": ["US"],
        "cn_path": "cn_optimized",
        "name_prefix": "搬瓦工 SLA",
    },
    "sg": {
        "series": "bwh-sg",
        "ip_bucket": "datacenter",
        "native_ip": False,
        "residential": False,
        "route": "cn2_gia",
        "regions": ["SG"],
        "cn_path": "cn_optimized",
        "name_prefix": "搬瓦工 新加坡",
    },
    "osaka": {
        "series": "osaka",
        "ip_bucket": "datacenter",
        "native_ip": False,
        "residential": False,
        "route": "softbank",
        "regions": ["JP"],
        "cn_path": "cn_optimized",
        "name_prefix": "搬瓦工 大阪",
    },
    "tokyo": {
        "series": "tokyo",
        "ip_bucket": "datacenter",
        "native_ip": False,
        "residential": False,
        "route": "cn2_gia",
        "regions": ["JP"],
        "cn_path": "cn_optimized",
        "name_prefix": "搬瓦工 东京",
    },
    "hk": {
        "series": "bwh-hk",
        "ip_bucket": "datacenter",
        "native_ip": False,
        "residential": False,
        "route": "cn2_gia",
        "regions": ["HK", "JP", "SG"],
        "cn_path": "cn_optimized",
        "name_prefix": "搬瓦工 香港 GIA",
    },
    "dubai": {
        "series": "dubai",
        "ip_bucket": "datacenter",
        "native_ip": False,
        "residential": False,
        "route": "mixed_premium",
        "regions": ["AE", "US"],
        "cn_path": "relay_suggested",
        "name_prefix": "搬瓦工 迪拜",
    },
}

FEATURED = {
    "lisahost-59",
    "lisahost-91",
    "bwh-44",
    "bwh-87",
    "bwh-95",
}

SIMILAR = {
    "lisahost-61": ["lisahost-168"],
    "lisahost-168": ["lisahost-61"],
    "lisahost-52": ["lisahost-169"],
    "lisahost-169": ["lisahost-52"],
    "lisahost-97": ["lisahost-175"],
    "lisahost-175": ["lisahost-97"],
    "lisahost-75": ["lisahost-172"],
    "lisahost-172": ["lisahost-75"],
    "lisahost-96": ["lisahost-171"],
    "lisahost-171": ["lisahost-96"],
    "lisahost-82": ["lisahost-180"],
    "lisahost-180": ["lisahost-82"],
    "lisahost-103": ["lisahost-173"],
    "lisahost-173": ["lisahost-103"],
}


def strip_html(text: str) -> str:
    text = re.sub(r"<br\s*/?>", " ", text, flags=re.I)
    text = STRIP_TAGS.sub("", text)
    return unescape(re.sub(r"\s+", " ", text)).strip()


def parse_cycle(blob: str) -> str | None:
    blob = blob.strip()
    for key, cycle in CYCLE_MAP:
        if blob.startswith(key) or key in blob[:6]:
            return cycle
    return None


def parse_prices(cell: str) -> list[dict]:
    out = []
    for m in PRICE_RE.finditer(cell):
        currency = "CNY" if m.group(1) == "¥" else "USD"
        amount = float(m.group(2))
        cycle = parse_cycle(m.group(3))
        if not cycle:
            continue
        out.append({"amount": amount, "currency": currency, "cycle": cycle})
    return out


def cells_by_label(inner: str) -> dict[str, str]:
    labeled = {}
    unlabeled = []
    for attrs, content in TD_RE.findall(inner):
        label_m = LABEL_RE.search(attrs)
        label = label_m.group(1) if label_m else ""
        if label:
            labeled[label] = content
        unlabeled.append(content)
    return labeled if labeled else {str(i): c for i, c in enumerate(unlabeled)}


def ip_from_row(inner: str, inherit: dict) -> tuple[str, bool, bool]:
    tags = " ".join(TAG_RE.findall(inner))
    if "非原生" in tags:
        return "datacenter", False, False
    if "双 ISP" in tags or "住宅" in tags:
        return "residential", True, True
    if "静态家宽" in tags:
        return "residential", True, True
    if "原生" in tags:
        return "native", True, False
    return (
        inherit.get("ip_bucket", "datacenter"),
        bool(inherit.get("native_ip", False)),
        bool(inherit.get("residential", False)),
    )


def guess_regions(name: str, inherit: dict) -> list[str]:
    mapping = [
        ("美国", "US"),
        ("洛杉矶", "US"),
        ("纽约", "US"),
        ("芝加哥", "US"),
        ("香港", "HK"),
        ("新加坡", "SG"),
        ("台湾", "TW"),
        ("日本", "JP"),
        ("英国", "UK"),
        ("荷兰", "NL"),
        ("加拿大", "CA"),
        ("迪拜", "AE"),
    ]
    found = []
    for needle, code in mapping:
        if needle in name and code not in found:
            found.append(code)
    return found or list(inherit.get("regions") or [])


def cn_path_from_row(inner: str, inherit: dict) -> str:
    blob = strip_html(inner)
    if "tag-relay" in inner or "建议中转" in blob:
        return "relay_suggested"
    if "tag-opt" in inner or "大陆优化" in blob or "三网优化" in blob or "三网直连" in blob:
        return "cn_optimized"
    return inherit.get("cn_path", "unknown")


def route_note_from_row(labeled: dict) -> str:
    cell = labeled.get("线路/中转") or labeled.get("线路") or ""
    text = strip_html(cell)
    for token in ("⚡ 大陆优化", "⚡大陆优化", "⚠️ 建议中转", "⚠ 建议中转", "建议中转", "大陆优化"):
        text = text.replace(token, "")
    return text.strip()


def guess_route(inner: str, inherit: dict) -> str:
    blob = strip_html(inner)
    if "GIA‑E" in blob or "GIA-E" in blob or "GIA－E" in blob:
        return "cn2_gia_e"
    if "CN2 GIA" in blob:
        return "cn2_gia"
    if "9929" in blob:
        return "9929"
    if "4837" in blob:
        return "4837"
    if "CMI" in blob:
        return "cmi"
    if "软银" in blob:
        return "softbank"
    if "ZNET" in blob or "普通线路" in blob:
        return "znet"
    return inherit.get("route", "bgp")


def section_at(pos: int, starts: list[tuple[int, str]]) -> str:
    current = ""
    for start, sid in starts:
        if start <= pos:
            current = sid
        else:
            break
    return current


def build_name(labeled: dict, inherit: dict, vendor: str) -> str:
    if "节点名称" in labeled:
        return strip_html(labeled["节点名称"])
    prefix = inherit.get("name_prefix") or ("LisaHost" if vendor == "lisahost" else "搬瓦工")
    ram = strip_html(labeled.get("内存", ""))
    cpu = strip_html(labeled.get("CPU", ""))
    parts = [prefix]
    if ram:
        parts.append(ram)
    if cpu:
        parts.append(cpu)
    return " ".join(parts)


def parse_ram_mb(*texts: str) -> int:
    blob = " ".join(texts)
    m = re.search(r"(\d+(?:\.\d+)?)\s*(GB|G|MB|M)\b", blob, re.I)
    if not m:
        return 1024
    n = float(m.group(1))
    return int(n * 1024) if m.group(2).upper().startswith("G") else int(n)


def parse_disk_gb(*texts: str) -> float:
    blob = " ".join(texts)
    m = re.search(r"(\d+(?:\.\d+)?)\s*G(?:B)?(?:\s*NVMe|\s*SSD)?", blob, re.I)
    if not m:
        return 10.0
    return float(m.group(1))


def parse_traffic_gb(*texts: str) -> float | None:
    blob = " ".join(texts)
    if "不限" in blob:
        return None
    m = re.search(r"(\d+(?:\.\d+)?)\s*(TB|T|GB|G)\b", blob, re.I)
    if not m:
        return 200.0
    n = float(m.group(1))
    unit = m.group(2).upper()
    return n * 1024 if unit.startswith("T") else n


def parse_bw_mbps(*texts: str) -> float:
    blob = " ".join(texts)
    m = re.search(r"(\d+(?:\.\d+)?)\s*(Gbps|Gbit/s|Mbps|Mbit/s)\b", blob, re.I)
    if not m:
        m = re.search(r"(\d+(?:\.\d+)?)\s*M", blob, re.I)
        return float(m.group(1)) if m else 50.0
    n = float(m.group(1))
    unit = m.group(2).lower()
    return n * 1000 if unit.startswith("g") else n


def spec_from_row(labeled: dict) -> dict:
    spec = {}
    cfg = strip_html(labeled.get("配置", ""))
    if cfg:
        spec["config_text"] = cfg
    for key, field in (
        ("CPU", "cpu"),
        ("内存", "ram"),
        ("硬盘", "disk"),
        ("流量", "traffic"),
        ("带宽", "bandwidth"),
        ("流量/带宽", "traffic_bw"),
        ("机房", "rooms"),
    ):
        if key in labeled:
            spec[field] = strip_html(labeled[key])
    ram_src = spec.get("ram") or ""
    disk_src = spec.get("disk") or ""
    tbw = spec.get("traffic_bw") or ""
    triple = re.search(
        r"(\d+)\s*核\s*/\s*(\d+(?:\.\d+)?)\s*(G|GB|M|MB)\s*/\s*(\d+(?:\.\d+)?)\s*G",
        cfg,
        re.I,
    )
    if ram_src:
        spec["ram_mb"] = parse_ram_mb(ram_src)
    elif triple:
        n = float(triple.group(2))
        spec["ram_mb"] = int(n * 1024) if triple.group(3).upper().startswith("G") else int(n)
    else:
        spec["ram_mb"] = parse_ram_mb(cfg) if cfg else 1024
    if disk_src:
        spec["disk_gb"] = parse_disk_gb(disk_src)
    elif triple:
        spec["disk_gb"] = float(triple.group(4))
    else:
        spec["disk_gb"] = parse_disk_gb(cfg) if cfg else 10.0
    if "/" in tbw:
        left, right = tbw.split("/", 1)
        spec["traffic_gb_month"] = parse_traffic_gb(left)
        spec["bandwidth_mbps"] = parse_bw_mbps(right)
    else:
        spec["traffic_gb_month"] = parse_traffic_gb(spec.get("traffic", ""), tbw)
        spec["bandwidth_mbps"] = parse_bw_mbps(spec.get("bandwidth", ""), tbw)
    return spec


def main() -> None:
    html = HTML_PATH.read_text(encoding="utf-8")
    starts = [(m.start(), m.group(1)) for m in SECTION_RE.finditer(html)]
    plans: dict[str, dict] = {}
    prev_rooms: dict[str, str] = {}

    for tr_m in TR_RE.finditer(html):
        attrs, inner = tr_m.group(1), tr_m.group(2)
        lisa = LISA_PID.search(inner)
        bwh = BWH_PID.search(inner)
        if not lisa and not bwh:
            continue
        vendor = "lisahost" if lisa else "bwh"
        pid = lisa.group(1) if lisa else bwh.group(1)
        plan_id = f"{vendor}-{pid}"
        if plan_id in plans:
            continue
        sid = section_at(tr_m.start(), starts)
        inherit = INHERIT.get(sid, {})
        labeled = cells_by_label(inner)
        name = build_name(labeled, inherit, vendor)
        prices = []
        for cell in labeled.values():
            prices.extend(parse_prices(cell))
        if not prices:
            continue
        ip_bucket, native_ip, residential = ip_from_row(inner, inherit)
        if vendor == "bwh":
            ip_bucket, native_ip, residential = "datacenter", False, False
        spec = spec_from_row(labeled)
        if spec.get("rooms") == "同上":
            spec["rooms"] = prev_rooms.get(sid, "")
        elif spec.get("rooms"):
            prev_rooms[sid] = spec["rooms"]
        rec_row = "class=\"rec\"" in attrs or "class='rec'" in attrs or " class=\"rec " in attrs
        if "rec" in attrs.split() or 'class="rec"' in attrs or "tr class=\"rec\"" in f"<tr{attrs}>":
            rec_row = True
        rec_row = bool(re.search(r'class="[^"]*\brec\b', attrs))
        url = (
            f"https://lisahost.com/cart.php?a=add&pid={pid}&aff=13150"
            if vendor == "lisahost"
            else f"https://bwh81.net/aff.php?aff=76211&pid={pid}"
        )
        plans[plan_id] = {
            "id": plan_id,
            "vendor": vendor,
            "pid": int(pid),
            "name_zh": name,
            "html_section": sid,
            "series": inherit.get("series") or sid or "other",
            "ip_bucket": ip_bucket,
            "native_ip": native_ip,
            "residential": residential,
            "route": guess_route(inner + name, inherit),
            "regions": guess_regions(name + " " + spec.get("rooms", ""), inherit),
            "cn_path": cn_path_from_row(inner, inherit),
            "route_note": route_note_from_row(labeled),
            "prices": prices,
            "spec": spec,
            "affiliate_url": url,
            "featured_on_vendor_home": plan_id in FEATURED,
            "rec_row": rec_row,
            "similar_to": SIMILAR.get(plan_id, []),
            "exclude_daily": any(p["cycle"] == "daily" for p in prices) and len(prices) == 1,
        }

    OUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    payload = {
        "last_verified_at": "2026-08-01",
        "fx_usd_cny": 7.25,
        "source": str(HTML_PATH),
        "plans": sorted(plans.values(), key=lambda p: (p["vendor"], p["pid"])),
    }
    OUT_PATH.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    lisa_n = sum(1 for p in payload["plans"] if p["vendor"] == "lisahost")
    bwh_n = sum(1 for p in payload["plans"] if p["vendor"] == "bwh")
    print(f"wrote {OUT_PATH}  lisa={lisa_n} bwh={bwh_n} total={lisa_n + bwh_n}")


if __name__ == "__main__":
    main()
