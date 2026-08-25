#!/usr/bin/env python3
"""VPS 选购神器 Telegram bot. Token lives in .env only."""

from __future__ import annotations

import json
import os
import re
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from html import escape
from pathlib import Path

ROOT = Path(__file__).resolve().parent
CATALOG_PATH = ROOT / "catalog" / "plans.json"
STATE_PATH = ROOT / "data" / "state.json"
WATCH_PATH = ROOT / "data" / "watches.json"
ENV_PATH = ROOT / ".env"

TO_YEAR = {"daily": 365, "monthly": 12, "quarterly": 4, "semiannual": 2, "annual": 1}
CYCLE_ALIASES = {
    "年": "annual",
    "年付": "annual",
    "annual": "annual",
    "year": "annual",
    "月": "monthly",
    "月付": "monthly",
    "monthly": "monthly",
    "month": "monthly",
    "季": "quarterly",
    "季度": "quarterly",
    "quarterly": "quarterly",
    "半年": "semiannual",
    "semiannual": "semiannual",
}
REGION_ALIASES = {
    "美国": "US",
    "美": "US",
    "us": "US",
    "usa": "US",
    "香港": "HK",
    "hk": "HK",
    "新加坡": "SG",
    "sg": "SG",
    "日本": "JP",
    "jp": "JP",
    "台湾": "TW",
    "tw": "TW",
    "英国": "UK",
    "uk": "UK",
    "荷兰": "NL",
    "加拿大": "CA",
    "迪拜": "AE",
}
VENDOR_ZH = {"lisahost": "LisaHost", "bwh": "搬瓦工"}
IP_ZH = {"datacenter": "数据中心 IP", "native": "原生 IP", "residential": "住宅 IP"}
CYCLE_ZH = {
    "daily": "天",
    "monthly": "月",
    "quarterly": "季",
    "semiannual": "半年",
    "annual": "年",
}

HELP = """VPS 选购神器 · @xiaoxiavip_bot

从 LisaHost + 搬瓦工目录里筛套餐、盯降价。非官方整理，下单跳转官网。

<b>命令</b>
/recommend — 预算 500 年付 · 美国 · 原生 · 建站 的 Top 3
/recommend 800 香港 住宅 — 自定义
/deals — 年付特价
/plan lisahost-66 — 套餐详情
/search 9929 — 关键词搜索
/watch lisahost-66 250 annual — 降到门槛提醒我
/unwatch lisahost-66
/watches — 我的提醒
/help — 本说明

<b>管理员</b>
把本 bot 加成频道管理员（可发帖），会自动绑定频道。
/pushdeals — 把今日特价推到频道
/channel — 查看绑定

「需要原生 IP」不含搬瓦工（机房 IP = 数据中心 IP）。
Lisa 优惠码 TS-CBP205DQJE 结算 9 折，标价未预折。"""


def load_env(path: Path) -> None:
    if not path.exists():
        if os.environ.get("TELEGRAM_BOT_TOKEN"):
            return
        raise SystemExit(f"missing {path}; copy .env.example")
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, val = line.partition("=")
        os.environ.setdefault(key.strip(), val.strip().strip('"').strip("'"))


def load_json(path: Path, default):
    if not path.exists():
        return default
    return json.loads(path.read_text(encoding="utf-8"))


def save_json(path: Path, data) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    tmp.replace(path)


def usd_to_cny(usd: float, fx: float) -> float:
    return round(usd * fx * 100) / 100


def payable(plan: dict, budget_cycle: str, infer: bool, fx: float):
    prices = plan.get("prices") or []
    exact = next((p for p in prices if p["cycle"] == budget_cycle), None)
    pick = exact
    inferred = False
    if pick is None and infer:
        best = None
        best_yearly = None
        for p in prices:
            cny = usd_to_cny(p["amount"], fx) if p["currency"] == "USD" else p["amount"]
            yearly = cny * TO_YEAR[p["cycle"]]
            if best_yearly is None or yearly < best_yearly:
                best_yearly = yearly
                best = p
        pick = best
        inferred = True
    if pick is None:
        return None
    cny = usd_to_cny(pick["amount"], fx) if pick["currency"] == "USD" else pick["amount"]
    yearly = cny * TO_YEAR[pick["cycle"]]
    amount = round((yearly / TO_YEAR[budget_cycle]) * 100) / 100
    return {"amount_cny": amount, "source_cycle": pick["cycle"], "inferred": inferred, "raw": pick}


def clamp(n: float, lo: float = 0, hi: float = 100) -> float:
    return min(hi, max(lo, n))


def lerp(x0: float, x1: float, y0: float, y1: float, x: float) -> float:
    return y0 + ((y1 - y0) * (x - x0)) / (x1 - x0)


def round1(n: float) -> float:
    return round(n * 10) / 10


def ram_factor(mb: float) -> float:
    if mb >= 4096:
        return 100
    if mb >= 2048:
        return lerp(2048, 4096, 80, 100, mb)
    if mb >= 1024:
        return lerp(1024, 2048, 55, 80, mb)
    if mb >= 512:
        return lerp(512, 1024, 20, 55, mb)
    return 20 * (mb / 512)


def disk_factor(gb: float) -> float:
    if gb >= 80:
        return 100
    if gb >= 40:
        return lerp(40, 80, 85, 100, gb)
    if gb >= 20:
        return lerp(20, 40, 60, 85, gb)
    if gb >= 10:
        return lerp(10, 20, 30, 60, gb)
    return 30 * (gb / 10)


def traffic_factor(gb, bw: float) -> float:
    if gb is None:
        return 70 if bw < 30 else 100
    if gb >= 2000:
        return 100
    if gb >= 1000:
        return lerp(1000, 2000, 70, 100, gb)
    if gb >= 400:
        return lerp(400, 1000, 40, 70, gb)
    if gb >= 200:
        return lerp(200, 400, 15, 40, gb)
    return 15 * (gb / 200)


ROUTE_BASE = {
    "cn2_gia": 95,
    "cn2_gia_e": 95,
    "cmi": 95,
    "9929": 88,
    "as9929": 88,
    "softbank": 80,
    "4837": 75,
    "as4837": 75,
    "cn2": 70,
    "bgp": 55,
    "znet": 40,
    "mixed_premium": 40,
    "unknown": 30,
}

W_WEB = {
    "budget": 0.22,
    "ram": 0.16,
    "disk": 0.12,
    "traffic": 0.12,
    "route": 0.14,
    "ip": 0.10,
    "value": 0.08,
    "editorial": 0.06,
}


def score_plan(plan: dict, pay: dict, budget_cny: float, budget_cycle: str, ip_need: str) -> float:
    spec = plan.get("spec") or {}
    ram_mb = float(spec.get("ram_mb") or 1024)
    disk_gb = float(spec.get("disk_gb") or 10)
    traffic_gb = spec.get("traffic_gb_month")
    bw = float(spec.get("bandwidth_mbps") or 50)
    yearly = pay["amount_cny"] * TO_YEAR[budget_cycle]
    route = ROUTE_BASE.get(plan.get("route") or "unknown", 30)
    if plan.get("cn_path") == "relay_suggested":
        route = min(route, 40)
    if ip_need == "native":
        ip_f = 100 if plan.get("native_ip") else 0
    elif ip_need == "residential":
        ip_f = 100 if plan.get("residential") else 0
    else:
        ip_f = 80 if plan.get("native_ip") else 40
    editorial = 0
    if plan.get("rec_row"):
        editorial += 20
    if plan.get("featured_on_vendor_home"):
        editorial += 15
    editorial = min(100, editorial)
    r = ram_mb / (yearly / 12) if yearly else 0
    if r >= 50:
        value = 100
    elif r >= 40:
        value = lerp(40, 50, 85, 100, r)
    elif r >= 30:
        value = lerp(30, 40, 70, 85, r)
    elif r >= 20:
        value = lerp(20, 30, 50, 70, r)
    elif r >= 10:
        value = lerp(10, 20, 20, 50, r)
    else:
        value = 20 * (r / 10)
    f = {
        "budget": clamp(100 * (1 - pay["amount_cny"] / budget_cny)),
        "ram": ram_factor(ram_mb),
        "disk": disk_factor(disk_gb),
        "traffic": traffic_factor(traffic_gb, bw),
        "route": route,
        "ip": ip_f,
        "value": value,
        "editorial": editorial,
    }
    raw = sum(W_WEB[k] * f[k] for k in W_WEB)
    return round1(clamp(raw))


def fmt_price(plan: dict, fx: float) -> str:
    parts = []
    for p in plan["prices"]:
        if p["currency"] == "USD":
            parts.append(f"${p['amount']:g}/{CYCLE_ZH[p['cycle']]} (≈¥{usd_to_cny(p['amount'], fx):.2f})")
        else:
            parts.append(f"¥{p['amount']:g}/{CYCLE_ZH[p['cycle']]}")
    return " · ".join(parts)


class Telegram:
    def __init__(self, token: str):
        self.base = f"https://api.telegram.org/bot{token}/"

    def call(self, method: str, payload: dict | None = None) -> dict:
        data = json.dumps(payload or {}).encode("utf-8")
        req = urllib.request.Request(
            self.base + method,
            data=data,
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        try:
            with urllib.request.urlopen(req, timeout=90) as resp:
                return json.loads(resp.read().decode("utf-8"))
        except urllib.error.HTTPError as e:
            body = e.read().decode("utf-8", "replace")
            try:
                return json.loads(body)
            except json.JSONDecodeError:
                return {"ok": False, "description": body, "error_code": e.code}

    def get_updates(self, offset: int) -> dict:
        payload = {"offset": offset, "timeout": 50, "allowed_updates": ["message", "my_chat_member"]}
        return self.call("getUpdates", payload)

    def send(
        self,
        chat_id: int | str,
        text: str,
        buttons: list[list[dict]] | None = None,
        reply_to: int | None = None,
    ) -> dict:
        payload = {
            "chat_id": chat_id,
            "text": text,
            "parse_mode": "HTML",
            "disable_web_page_preview": True,
        }
        if buttons:
            payload["reply_markup"] = {"inline_keyboard": buttons}
        if reply_to:
            payload["reply_to_message_id"] = reply_to
        return self.call("sendMessage", payload)


class Bot:
    def __init__(self):
        load_env(ENV_PATH)
        token = os.environ.get("TELEGRAM_BOT_TOKEN", "").strip()
        if not token:
            raise SystemExit("TELEGRAM_BOT_TOKEN empty")
        self.api = Telegram(token)
        catalog = load_json(CATALOG_PATH, {})
        self.fx = float(os.environ.get("FX_USD_CNY") or catalog.get("fx_usd_cny") or 6.7)
        self.plans = {p["id"]: p for p in catalog.get("plans", [])}
        self.state = load_json(STATE_PATH, {"offset": 0, "admin_id": None, "channel_id": None})
        self.watches = load_json(WATCH_PATH, [])
        env_admin = os.environ.get("TELEGRAM_ADMIN_ID", "").strip()
        env_channel = os.environ.get("TELEGRAM_CHANNEL_ID", "").strip()
        if env_admin:
            self.state["admin_id"] = int(env_admin)
        if env_channel:
            self.state["channel_id"] = int(env_channel) if env_channel.lstrip("-").isdigit() else env_channel

    def persist(self) -> None:
        save_json(STATE_PATH, self.state)
        save_json(WATCH_PATH, self.watches)

    def is_admin(self, user_id: int | None) -> bool:
        admin = self.state.get("admin_id")
        return admin is not None and user_id == admin

    def claim_admin(self, user_id: int) -> None:
        if self.state.get("admin_id") is None:
            self.state["admin_id"] = user_id
            self.persist()

    def find_plan(self, token: str) -> dict | None:
        token = token.strip().lower()
        if token in self.plans:
            return self.plans[token]
        if token.isdigit():
            hits = [p for p in self.plans.values() if str(p["pid"]) == token]
            if len(hits) == 1:
                return hits[0]
        if token.startswith("lisa") and "-" not in token:
            key = token.replace("lisahost", "lisahost-").replace("lisa", "lisahost-")
            key = re.sub(r"lisahost-+", "lisahost-", key)
            return self.plans.get(key)
        return self.plans.get(token)

    def buy_button(self, plan: dict) -> list[list[dict]]:
        return [[{"text": "去官网购买", "url": plan["affiliate_url"]}]]

    def plan_card(self, plan: dict, pay=None) -> str:
        vendor = VENDOR_ZH[plan["vendor"]]
        ip = IP_ZH.get(plan["ip_bucket"], plan["ip_bucket"])
        spec = plan.get("spec") or {}
        bits = [spec.get("config_text") or "", spec.get("ram") or "", spec.get("cpu") or ""]
        spec_line = " / ".join(x for x in bits if x) or "—"
        extra = []
        if spec.get("traffic_bw"):
            extra.append(spec["traffic_bw"])
        elif spec.get("traffic"):
            extra.append(spec["traffic"])
        if spec.get("bandwidth"):
            extra.append(spec["bandwidth"])
        if spec.get("rooms"):
            extra.append(spec["rooms"])
        pay_line = ""
        if pay:
            flag = "（周期折算）" if pay["inferred"] else ""
            pay_line = f"\n应付（所选周期）: ¥{pay['amount_cny']:.2f}{flag}"
        return (
            f"<b>{escape(plan['name_zh'])}</b>\n"
            f"<code>{escape(plan['id'])}</code> · {escape(vendor)} · {escape(ip)}\n"
            f"{escape(fmt_price(plan, self.fx))}{pay_line}\n"
            f"{escape(spec_line)}\n"
            f"{escape(' · '.join(extra))}"
        ).strip()

    def recommend(self, budget: float, cycle: str, regions: list[str], ip_need: str, exclude_daily: bool = True):
        ranked = []
        eliminated = []
        series_count: dict[str, int] = {}
        vendor_count: dict[str, int] = {}
        for plan in self.plans.values():
            if exclude_daily and plan.get("exclude_daily"):
                eliminated.append((plan["id"], "daily_excluded"))
                continue
            if ip_need == "native" and not plan["native_ip"]:
                eliminated.append((plan["id"], "native_required"))
                continue
            if ip_need == "native" and plan["ip_bucket"] == "datacenter":
                eliminated.append((plan["id"], "native_required"))
                continue
            if ip_need == "residential" and not plan["residential"]:
                eliminated.append((plan["id"], "residential_required"))
                continue
            if ip_need == "datacenter" and plan["ip_bucket"] != "datacenter":
                eliminated.append((plan["id"], "datacenter_required"))
                continue
            if regions and not set(plan.get("regions") or []) & set(regions):
                eliminated.append((plan["id"], "region_mismatch"))
                continue
            pay = payable(plan, cycle, infer=True, fx=self.fx)
            if pay is None:
                eliminated.append((plan["id"], "no_price"))
                continue
            if pay["amount_cny"] > budget * 1.02:
                eliminated.append((plan["id"], "over_budget"))
                continue
            score = score_plan(plan, pay, budget, cycle, ip_need)
            ranked.append((score, plan, pay))
        ranked.sort(key=lambda x: -x[0])
        top = []
        for score, plan, pay in ranked:
            series = plan["series"]
            vendor = plan["vendor"]
            if series_count.get(series, 0) >= 2:
                continue
            similar_hit = False
            for other in plan.get("similar_to") or []:
                if any(t["plan"]["id"] == other for t in top):
                    similar_hit = True
                    break
            if similar_hit:
                continue
            series_count[series] = series_count.get(series, 0) + 1
            vendor_count[vendor] = vendor_count.get(vendor, 0) + 1
            top.append({"score": round(score, 1), "plan": plan, "pay": pay})
            if len(top) == 3:
                break
        return top, eliminated

    def deals(self, cycle: str = "annual", limit: int = 8) -> list[tuple[dict, dict]]:
        rows = []
        for plan in self.plans.values():
            if plan.get("exclude_daily"):
                continue
            pay = payable(plan, cycle, infer=True, fx=self.fx)
            if pay is None:
                continue
            rows.append((pay["amount_cny"], plan, pay))
        rows.sort(key=lambda x: x[0])
        return [(p, pay) for _, p, pay in rows[:limit]]

    def search(self, q: str, limit: int = 8) -> list[dict]:
        q = q.lower()
        hits = []
        for plan in self.plans.values():
            blob = " ".join(
                [
                    plan["id"],
                    plan["name_zh"],
                    plan["route"],
                    plan["ip_bucket"],
                    str(plan["pid"]),
                    plan.get("series", ""),
                    json.dumps(plan.get("spec") or {}, ensure_ascii=False),
                ]
            ).lower()
            if q in blob:
                hits.append(plan)
        return hits[:limit]

    def format_top(self, title: str, top: list[dict]) -> tuple[str, list[list[dict]] | None]:
        if not top:
            return "没有符合条件的套餐。放宽预算、地区或 IP 档再试。", None
        lines = [f"<b>{escape(title)}</b>", ""]
        buttons = []
        for i, item in enumerate(top, 1):
            plan, pay = item["plan"], item["pay"]
            lines.append(f"{i}. {self.plan_card(plan, pay)}")
            lines.append("")
            buttons.append([{"text": f"{i}. 购买 {plan['id']}", "url": plan["affiliate_url"]}])
        lines.append("非官方整理，价格以结算页为准。")
        return "\n".join(lines).strip(), buttons

    def parse_recommend_args(self, rest: str) -> dict:
        budget = 500.0
        cycle = "annual"
        regions: list[str] = ["US"]
        ip_need = "native"
        if not rest.strip():
            return {"budget": budget, "cycle": cycle, "regions": regions, "ip_need": ip_need}
        tokens = rest.replace("，", " ").replace(",", " ").split()
        regions = []
        ip_need = "any"
        got_budget = False
        for tok in tokens:
            low = tok.lower()
            if re.fullmatch(r"\d+(?:\.\d+)?", tok):
                budget = float(tok)
                got_budget = True
                continue
            if low in CYCLE_ALIASES:
                cycle = CYCLE_ALIASES[low]
                continue
            if tok in REGION_ALIASES or low in REGION_ALIASES:
                regions.append(REGION_ALIASES.get(tok) or REGION_ALIASES[low])
                continue
            if tok in ("原生", "native"):
                ip_need = "native"
                continue
            if tok in ("住宅", "residential"):
                ip_need = "residential"
                continue
            if tok in ("数据中心", "机房", "datacenter"):
                ip_need = "datacenter"
                continue
            if tok in ("建站", "web"):
                continue
        if not got_budget:
            budget = 500.0
        if not regions:
            regions = ["US"]
        if ip_need == "any":
            ip_need = "native"
        return {"budget": budget, "cycle": cycle, "regions": regions, "ip_need": ip_need}

    def handle_command(self, chat_id: int, user_id: int | None, text: str, chat_type: str) -> None:
        parts = text.strip().split(maxsplit=1)
        cmd = parts[0].split("@", 1)[0].lower()
        rest = parts[1] if len(parts) > 1 else ""

        if chat_type == "private" and user_id:
            self.claim_admin(user_id)

        if cmd in ("/start", "/help"):
            self.api.send(chat_id, HELP)
            return

        if cmd == "/recommend":
            args = self.parse_recommend_args(rest)
            ip_label = {"native": "原生", "residential": "住宅", "datacenter": "数据中心"}.get(args["ip_need"], args["ip_need"])
            title = f"Top 3 · ¥{args['budget']:g}/{CYCLE_ZH[args['cycle']]} · {','.join(args['regions'])} · {ip_label}"
            top, _ = self.recommend(args["budget"], args["cycle"], args["regions"], args["ip_need"])
            text_out, buttons = self.format_top(title, top)
            self.api.send(chat_id, text_out, buttons)
            return

        if cmd == "/deals":
            cycle = CYCLE_ALIASES.get(rest.strip().lower(), "annual")
            rows = self.deals(cycle=cycle)
            top = [{"plan": p, "pay": pay, "score": 0} for p, pay in rows]
            text_out, buttons = self.format_top(f"特价 · {CYCLE_ZH[cycle]}付预算折算最低", top)
            self.api.send(chat_id, text_out, buttons)
            return

        if cmd == "/plan":
            if not rest:
                self.api.send(chat_id, "用法: /plan lisahost-66  或  /plan 66")
                return
            plan = self.find_plan(rest)
            if not plan:
                self.api.send(chat_id, f"找不到套餐 <code>{escape(rest)}</code>")
                return
            pay = payable(plan, "annual", infer=True, fx=self.fx)
            self.api.send(chat_id, self.plan_card(plan, pay), self.buy_button(plan))
            return

        if cmd == "/search":
            if not rest:
                self.api.send(chat_id, "用法: /search 9929")
                return
            hits = self.search(rest)
            if not hits:
                self.api.send(chat_id, "没有匹配。")
                return
            top = [{"plan": p, "pay": payable(p, "annual", True, self.fx), "score": 0} for p in hits]
            top = [t for t in top if t["pay"]]
            text_out, buttons = self.format_top(f"搜索: {rest}", top)
            self.api.send(chat_id, text_out, buttons)
            return

        if cmd == "/watch":
            if chat_type != "private":
                self.api.send(chat_id, "请私聊机器人设置降价提醒。")
                return
            bits = rest.split()
            if len(bits) < 2:
                self.api.send(chat_id, "用法: /watch lisahost-66 250 annual\n门槛单位与周期一致（annual=年付人民币）。")
                return
            plan = self.find_plan(bits[0])
            if not plan:
                self.api.send(chat_id, f"找不到套餐 <code>{escape(bits[0])}</code>")
                return
            try:
                threshold = float(bits[1])
            except ValueError:
                self.api.send(chat_id, "门槛必须是数字。")
                return
            cycle = CYCLE_ALIASES.get((bits[2].lower() if len(bits) > 2 else "annual"), "annual")
            pay = payable(plan, cycle, True, self.fx)
            self.watches = [
                w
                for w in self.watches
                if not (w["chat_id"] == chat_id and w["plan_id"] == plan["id"] and w["cycle"] == cycle)
            ]
            self.watches.append(
                {
                    "chat_id": chat_id,
                    "user_id": user_id,
                    "plan_id": plan["id"],
                    "threshold_cny": threshold,
                    "cycle": cycle,
                    "created_at": datetime.now(timezone.utc).isoformat(),
                    "last_notified_at": None,
                    "last_seen_cny": pay["amount_cny"] if pay else None,
                }
            )
            self.persist()
            now = f"¥{pay['amount_cny']:.2f}/{CYCLE_ZH[cycle]}" if pay else "无报价"
            self.api.send(
                chat_id,
                f"已盯 <code>{escape(plan['id'])}</code>\n当前 {now}\n门槛 ¥{threshold:g}/{CYCLE_ZH[cycle]}\n"
                f"跌破门槛且跌幅≥10%（或直接低于门槛）时提醒，72 小时冷却。",
            )
            return

        if cmd == "/unwatch":
            if not rest:
                self.api.send(chat_id, "用法: /unwatch lisahost-66")
                return
            plan = self.find_plan(rest)
            pid = plan["id"] if plan else rest.strip()
            before = len(self.watches)
            self.watches = [w for w in self.watches if not (w["chat_id"] == chat_id and w["plan_id"] == pid)]
            self.persist()
            n = before - len(self.watches)
            self.api.send(chat_id, f"已取消 {n} 条提醒。" if n else "没有这条提醒。")
            return

        if cmd == "/watches":
            mine = [w for w in self.watches if w["chat_id"] == chat_id]
            if not mine:
                self.api.send(chat_id, "还没有提醒。用法: /watch lisahost-66 250 annual")
                return
            lines = ["<b>我的降价提醒</b>", ""]
            for w in mine:
                plan = self.plans.get(w["plan_id"])
                name = plan["name_zh"] if plan else w["plan_id"]
                lines.append(
                    f"• <code>{escape(w['plan_id'])}</code> {escape(name)}\n"
                    f"  门槛 ¥{w['threshold_cny']:g}/{CYCLE_ZH[w['cycle']]}"
                )
            self.api.send(chat_id, "\n".join(lines))
            return

        if cmd == "/channel":
            if not self.is_admin(user_id):
                self.api.send(chat_id, "仅管理员。")
                return
            ch = self.state.get("channel_id")
            self.api.send(chat_id, f"频道: <code>{escape(str(ch))}</code>" if ch else "尚未绑定。把 bot 加成频道管理员即可。")
            return

        if cmd == "/pushdeals":
            if not self.is_admin(user_id):
                self.api.send(chat_id, "仅管理员。")
                return
            ch = self.state.get("channel_id")
            if not ch:
                self.api.send(chat_id, "还没绑定频道。")
                return
            rows = self.deals("annual", limit=6)
            top = [{"plan": p, "pay": pay, "score": 0} for p, pay in rows]
            date = datetime.now().strftime("%Y-%m-%d")
            text_out, buttons = self.format_top(f"【VPS 特价 {date}】年付折算最低", top)
            res = self.api.send(ch, text_out, buttons)
            if res.get("ok"):
                self.api.send(chat_id, "已推送到频道。")
            else:
                self.api.send(chat_id, f"推送失败: {escape(str(res.get('description')))}")
            return

        self.api.send(chat_id, "未知命令。/help")

    def on_my_chat_member(self, upd: dict) -> None:
        mcm = upd.get("my_chat_member") or {}
        chat = mcm.get("chat") or {}
        new = mcm.get("new_chat_member") or {}
        if chat.get("type") != "channel":
            return
        status = new.get("status")
        if status in ("administrator", "creator"):
            self.state["channel_id"] = chat["id"]
            self.persist()
            admin = self.state.get("admin_id")
            title = chat.get("title") or str(chat["id"])
            if admin:
                self.api.send(admin, f"已绑定频道: {escape(title)}\n<code>{chat['id']}</code>\n用 /pushdeals 推特价。")
        elif status in ("kicked", "left"):
            if self.state.get("channel_id") == chat.get("id"):
                self.state["channel_id"] = None
                self.persist()

    def check_watches(self) -> None:
        now = time.time()
        cooldown = 72 * 3600
        changed = False
        for w in self.watches:
            plan = self.plans.get(w["plan_id"])
            if not plan:
                continue
            pay = payable(plan, w["cycle"], True, self.fx)
            if not pay:
                continue
            current = pay["amount_cny"]
            last_seen = w.get("last_seen_cny")
            w["last_seen_cny"] = current
            threshold = w["threshold_cny"]
            drop_ok = current <= threshold
            drop_pct = last_seen is not None and last_seen > 0 and (last_seen - current) / last_seen >= 0.10
            if not drop_ok:
                continue
            if not (drop_pct or current <= threshold):
                continue
            last_n = w.get("last_notified_at")
            if last_n:
                try:
                    last_ts = datetime.fromisoformat(last_n).timestamp()
                except ValueError:
                    last_ts = 0
                if now - last_ts < cooldown:
                    continue
            # hysteresis: if current was already under threshold at subscribe, only fire on additional 10% drop
            created_under = last_seen is not None and last_seen <= threshold and not drop_pct
            if created_under:
                continue
            text = (
                f"降价提醒 <code>{escape(plan['id'])}</code>\n"
                f"{escape(plan['name_zh'])}\n"
                f"当前 ¥{current:.2f}/{CYCLE_ZH[w['cycle']]} ≤ 门槛 ¥{threshold:g}"
            )
            self.api.send(w["chat_id"], text, self.buy_button(plan))
            w["last_notified_at"] = datetime.now(timezone.utc).isoformat()
            changed = True
        if changed:
            self.persist()
        else:
            save_json(WATCH_PATH, self.watches)

    def setup_commands(self) -> None:
        self.api.call(
            "setMyCommands",
            {
                "commands": [
                    {"command": "recommend", "description": "按预算/地区/IP 推荐 Top 3"},
                    {"command": "deals", "description": "年付特价"},
                    {"command": "plan", "description": "套餐详情"},
                    {"command": "search", "description": "搜索套餐"},
                    {"command": "watch", "description": "降价提醒"},
                    {"command": "unwatch", "description": "取消提醒"},
                    {"command": "watches", "description": "我的提醒"},
                    {"command": "help", "description": "说明"},
                ]
            },
        )

    def run(self) -> None:
        me = self.api.call("getMe", {})
        if not me.get("ok"):
            raise SystemExit(f"getMe failed: {me}")
        username = me["result"]["username"]
        self.setup_commands()
        print(f"bot @{username} polling  plans={len(self.plans)}", flush=True)
        last_watch_check = 0.0
        while True:
            try:
                res = self.api.get_updates(self.state.get("offset") or 0)
            except Exception as e:
                print(f"getUpdates error: {e}", flush=True)
                time.sleep(3)
                continue
            if not res.get("ok"):
                print(f"getUpdates not ok: {res}", flush=True)
                time.sleep(3)
                continue
            for upd in res.get("result") or []:
                self.state["offset"] = upd["update_id"] + 1
                self.persist()
                if "my_chat_member" in upd:
                    self.on_my_chat_member(upd)
                    continue
                msg = upd.get("message") or {}
                text = msg.get("text") or ""
                if not text.startswith("/"):
                    continue
                chat = msg.get("chat") or {}
                user = msg.get("from") or {}
                self.handle_command(chat["id"], user.get("id"), text, chat.get("type") or "")
            now = time.time()
            if now - last_watch_check > 60:
                self.check_watches()
                last_watch_check = now


if __name__ == "__main__":
    Bot().run()
