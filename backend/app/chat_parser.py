from __future__ import annotations

import asyncio
import hashlib
import json
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable, Optional

import httpx

from .config import EMOTE_CACHE_DIR


@dataclass
class ChatRun:
    kind: str  # "text" | "emote"
    text: str = ""
    emote_url: Optional[str] = None
    emote_path: Optional[str] = None


@dataclass
class ParsedChatItem:
    item_id: str
    offset_sec: float
    kind: str  # "normal" | "member" | "moderator" | "owner" | "superchat" | "sticker" | "membership" | "gift"
    author: str
    runs: list[ChatRun] = field(default_factory=list)
    plain_text: str = ""
    amount_text: str = ""
    sc_tier: Optional[str] = None
    bg_color: Optional[str] = None
    fg_color: Optional[str] = None
    sticker_url: Optional[str] = None
    sticker_path: Optional[str] = None


YOUTUBE_SUPERCHAT_TIERS: dict[str, str] = {
    "blue": "#1E88E5",
    "lightblue": "#00B8D4",
    "green": "#00BFA5",
    "yellow": "#FFB300",
    "orange": "#E65100",
    "magenta": "#C2185B",
    "red": "#D00000",
}

_KNOWN_HEX_TO_TIER: dict[str, str] = {
    "#1565C0": "blue",
    "#1E88E5": "blue",
    "#00B8D4": "lightblue",
    "#00E5FF": "lightblue",
    "#00BFA5": "green",
    "#1DE9B6": "green",
    "#0F9D58": "green",
    "#FFB300": "yellow",
    "#FFCA28": "yellow",
    "#E65100": "orange",
    "#F57C00": "orange",
    "#C2185B": "magenta",
    "#E91E63": "magenta",
    "#D00000": "red",
    "#E62117": "red",
}


def detect_superchat_tier(hex_color: str, amount_text: str = "") -> str:
    norm = (hex_color or "").upper()
    if norm in _KNOWN_HEX_TO_TIER:
        return _KNOWN_HEX_TO_TIER[norm]
    # Try RGB proximity against official tier colors
    h = norm.lstrip("#")
    if len(h) == 6:
        try:
            r, g, b = int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16)
            best_tier = "blue"
            best_dist = 10**9
            for t_name, t_hex in YOUTUBE_SUPERCHAT_TIERS.items():
                th = t_hex.lstrip("#")
                tr, tg, tb = int(th[0:2], 16), int(th[2:4], 16), int(th[4:6], 16)
                d = (r - tr) ** 2 + (g - tg) ** 2 + (b - tb) ** 2
                if d < best_dist:
                    best_dist = d
                    best_tier = t_name
            return best_tier
        except Exception:
            pass
    # Numeric JPY heuristic fallback
    digits = "".join(ch for ch in (amount_text or "") if ch.isdigit())
    if digits and ("¥" in amount_text or "￥" in amount_text):
        val = int(digits)
        if val >= 10000:
            return "red"
        if val >= 5000:
            return "magenta"
        if val >= 2000:
            return "orange"
        if val >= 1000:
            return "yellow"
        if val >= 500:
            return "green"
        if val >= 200:
            return "lightblue"
    return "blue"


def _argb_int_to_hex(val: Optional[int], default: str = "#1E88E5") -> str:
    if val is None:
        return default
    try:
        rgb = int(val) & 0xFFFFFF
        return f"#{rgb:06X}"
    except Exception:
        return default


def _contrast_text_for_bg(hex_color: str) -> str:
    h = hex_color.lstrip("#")
    if len(h) != 6:
        return "#FFFFFF"
    r, g, b = int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16)
    lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255.0
    return "#111111" if lum > 0.62 else "#FFFFFF"


def _extract_runs(runs_raw: list[dict]) -> tuple[list[ChatRun], str]:
    runs: list[ChatRun] = []
    plain_parts: list[str] = []

    for r in runs_raw or []:
        if "text" in r:
            t = r["text"]
            if t:
                runs.append(ChatRun(kind="text", text=t))
                plain_parts.append(t)
        elif "emoji" in r:
            em = r["emoji"]
            is_custom = bool(em.get("isCustomEmoji"))
            thumbs = ((em.get("image") or {}).get("thumbnails")) or []
            url = thumbs[-1].get("url") if thumbs else None
            shortcuts = em.get("shortcuts") or []
            fallback_txt = shortcuts[0] if shortcuts else em.get("emojiId", "")

            if is_custom and url:
                runs.append(ChatRun(kind="emote", text=fallback_txt, emote_url=url))
                plain_parts.append(fallback_txt)
            else:
                emoji_char = em.get("emojiId") or fallback_txt
                if emoji_char:
                    runs.append(ChatRun(kind="text", text=emoji_char))
                    plain_parts.append(emoji_char)

    return runs, "".join(plain_parts)


def _detect_author_role(renderer: dict) -> str:
    badges = renderer.get("authorBadges") or []
    is_member = False
    for b in badges:
        br = b.get("liveChatAuthorBadgeRenderer") or {}
        icon_type = ((br.get("icon") or {}).get("iconType") or "").upper()
        tooltip = (br.get("tooltip") or "").lower()
        if icon_type == "OWNER" or "owner" in tooltip or "チャンネル所有者" in tooltip:
            return "owner"
        if icon_type == "MODERATOR" or "moderator" in tooltip or "モデレーター" in tooltip:
            return "moderator"
        if br.get("customThumbnail") or "member" in tooltip or "メンバー" in tooltip:
            is_member = True
    return "member" if is_member else "normal"


def parse_live_chat_json(
    json_path: str | Path,
    clip_start_sec: Optional[float] = None,
    clip_end_sec: Optional[float] = None,
    ng_words: Optional[list[str]] = None,
) -> list[ParsedChatItem]:
    path = Path(json_path)
    if not path.exists():
        return []

    deleted_ids: set[str] = set()
    raw_items: list[ParsedChatItem] = []
    first_ts_usec: Optional[int] = None

    ng_lower = [w.strip().lower() for w in (ng_words or []) if w.strip()]

    with open(path, "r", encoding="utf-8", errors="ignore") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                obj = json.loads(line)
            except Exception:
                continue

            replay = obj.get("replayChatItemAction")
            if replay:
                offset_ms = replay.get("videoOffsetTimeMsec")
                actions = replay.get("actions") or []
            else:
                offset_ms = None
                actions = [obj] if "addChatItemAction" in obj else (obj.get("actions") or [])

            for act in actions:
                if "markChatItemAsDeletedAction" in act:
                    tid = act["markChatItemAsDeletedAction"].get("targetItemId")
                    if tid:
                        deleted_ids.add(tid)
                    continue

                add_act = act.get("addChatItemAction")
                if not add_act:
                    continue
                item = add_act.get("item") or {}

                # Determine timestamp in seconds
                offset_sec: Optional[float] = None
                if offset_ms is not None:
                    try:
                        offset_sec = float(offset_ms) / 1000.0
                    except Exception:
                        offset_sec = None

                # Parse specific renderers
                parsed: Optional[ParsedChatItem] = None

                if "liveChatTextMessageRenderer" in item:
                    r = item["liveChatTextMessageRenderer"]
                    ts_usec = r.get("timestampUsec")
                    if offset_sec is None and ts_usec:
                        u = int(ts_usec)
                        if first_ts_usec is None:
                            first_ts_usec = u
                        offset_sec = max(0.0, (u - first_ts_usec) / 1_000_000.0)
                    if offset_sec is None:
                        continue
                    runs, plain = _extract_runs((r.get("message") or {}).get("runs") or [])
                    if not runs:
                        continue
                    role = _detect_author_role(r)
                    parsed = ParsedChatItem(
                        item_id=r.get("id", ""),
                        offset_sec=offset_sec,
                        kind=role,
                        author=((r.get("authorName") or {}).get("simpleText")) or "",
                        runs=runs,
                        plain_text=plain,
                    )

                elif "liveChatPaidMessageRenderer" in item:
                    r = item["liveChatPaidMessageRenderer"]
                    if offset_sec is None:
                        continue
                    amount = ((r.get("purchaseAmountText") or {}).get("simpleText")) or ""
                    raw_bg = _argb_int_to_hex(r.get("headerBackgroundColor") or r.get("bodyBackgroundColor"), "#1E88E5")
                    tier = detect_superchat_tier(raw_bg, amount)
                    fg = _contrast_text_for_bg(raw_bg)
                    runs, plain = _extract_runs((r.get("message") or {}).get("runs") or [])
                    parsed = ParsedChatItem(
                        item_id=r.get("id", ""),
                        offset_sec=offset_sec,
                        kind="superchat",
                        author=((r.get("authorName") or {}).get("simpleText")) or "",
                        runs=runs,
                        plain_text=plain,
                        amount_text=amount,
                        sc_tier=tier,
                        bg_color=raw_bg,
                        fg_color=fg,
                    )

                elif "liveChatPaidStickerRenderer" in item:
                    r = item["liveChatPaidStickerRenderer"]
                    if offset_sec is None:
                        continue
                    amount = ((r.get("purchaseAmountText") or {}).get("simpleText")) or ""
                    raw_bg = _argb_int_to_hex(r.get("backgroundColor"), "#E91E63")
                    tier = detect_superchat_tier(raw_bg, amount)
                    fg = _contrast_text_for_bg(raw_bg)
                    thumbs = ((r.get("sticker") or {}).get("thumbnails")) or []
                    sticker_url = thumbs[-1].get("url") if thumbs else None
                    parsed = ParsedChatItem(
                        item_id=r.get("id", ""),
                        offset_sec=offset_sec,
                        kind="sticker",
                        author=((r.get("authorName") or {}).get("simpleText")) or "",
                        runs=[ChatRun(kind="text", text=f"ステッカー {amount}".strip())],
                        plain_text=f"ステッカー {amount}".strip(),
                        amount_text=amount,
                        sc_tier=tier,
                        bg_color=raw_bg,
                        fg_color=fg,
                        sticker_url=sticker_url,
                    )

                elif "liveChatMembershipItemRenderer" in item:
                    r = item["liveChatMembershipItemRenderer"]
                    if offset_sec is None:
                        continue
                    hdr_runs, hdr_plain = _extract_runs((r.get("headerSubtext") or {}).get("runs") or [])
                    if not hdr_runs:
                        hdr_runs, hdr_plain = _extract_runs((r.get("headerPrimaryText") or {}).get("runs") or [])
                    msg_runs, msg_plain = _extract_runs((r.get("message") or {}).get("runs") or [])
                    author = ((r.get("authorName") or {}).get("simpleText")) or ""
                    prefix_text = f"{author}: " if author else ""
                    combined_runs = ([ChatRun(kind="text", text=prefix_text)] if prefix_text else []) + hdr_runs
                    if msg_runs:
                        combined_runs.append(ChatRun(kind="text", text=" "))
                        combined_runs.extend(msg_runs)
                    plain = f"{prefix_text}{hdr_plain} {msg_plain}".strip()
                    if not plain:
                        plain = f"{author} メンバーシップ"
                        combined_runs = [ChatRun(kind="text", text=plain)]
                    parsed = ParsedChatItem(
                        item_id=r.get("id", ""),
                        offset_sec=offset_sec,
                        kind="membership",
                        author=author,
                        runs=combined_runs,
                        plain_text=plain,
                        bg_color="#0F9D58",
                        fg_color="#FFFFFF",
                    )

                elif "liveChatSponsorshipsGiftPurchaseAnnouncementRenderer" in item:
                    r = item["liveChatSponsorshipsGiftPurchaseAnnouncementRenderer"]
                    if offset_sec is None:
                        continue
                    hdr = ((r.get("header") or {}).get("liveChatSponsorshipsHeaderRenderer")) or {}
                    p_runs, p_plain = _extract_runs((hdr.get("primaryText") or {}).get("runs") or [])
                    author = ((hdr.get("authorName") or {}).get("simpleText")) or ""
                    if not p_runs and author:
                        p_runs = [ChatRun(kind="text", text=f"{author} がメンバーシップギフトを贈りました")]
                        p_plain = p_runs[0].text
                    if not p_runs:
                        continue
                    parsed = ParsedChatItem(
                        item_id=r.get("id", ""),
                        offset_sec=offset_sec,
                        kind="gift",
                        author=author,
                        runs=p_runs,
                        plain_text=p_plain,
                        bg_color="#0F9D58",
                        fg_color="#FFFFFF",
                    )

                if parsed is not None:
                    raw_items.append(parsed)

    # Filter deleted, clip range, NG words, and normalize clip timestamps
    c_start = float(clip_start_sec) if clip_start_sec is not None else 0.0
    c_end = float(clip_end_sec) if clip_end_sec is not None else None

    result: list[ParsedChatItem] = []
    for it in raw_items:
        if it.item_id and it.item_id in deleted_ids:
            continue
        if it.offset_sec < c_start:
            continue
        if c_end is not None and it.offset_sec > c_end:
            continue
        if ng_lower:
            low = it.plain_text.lower()
            if any(w in low for w in ng_lower):
                continue
        it.offset_sec = max(0.0, it.offset_sec - c_start)
        result.append(it)

    result.sort(key=lambda x: x.offset_sec)
    return result


async def download_chat_emotes(
    items: list[ParsedChatItem],
    progress_cb: Optional[Callable[[float, str], None]] = None,
) -> None:
    """Download unique custom emotes & stickers to EMOTE_CACHE_DIR and attach local paths."""
    EMOTE_CACHE_DIR.mkdir(parents=True, exist_ok=True)
    urls: set[str] = set()
    for it in items:
        if it.sticker_url:
            urls.add(it.sticker_url)
        for run in it.runs:
            if run.kind == "emote" and run.emote_url:
                urls.add(run.emote_url)

    if not urls:
        return

    url_to_path: dict[str, str] = {}
    to_fetch: list[tuple[str, Path]] = []

    for u in urls:
        h = hashlib.sha1(u.encode("utf-8")).hexdigest()[:24]
        dest = EMOTE_CACHE_DIR / f"{h}.img"
        if dest.exists() and dest.stat().st_size > 0:
            url_to_path[u] = str(dest)
        else:
            to_fetch.append((u, dest))

    if to_fetch:
        sem = asyncio.Semaphore(16)
        done = 0
        total = len(to_fetch)

        async with httpx.AsyncClient(timeout=15.0, follow_redirects=True) as client:
            async def fetch_one(url: str, dest: Path) -> None:
                nonlocal done
                async with sem:
                    try:
                        resp = await client.get(url)
                        if resp.status_code == 200 and resp.content:
                            dest.write_bytes(resp.content)
                            url_to_path[url] = str(dest)
                    except Exception:
                        pass
                    finally:
                        done += 1
                        if progress_cb and (done % 10 == 0 or done == total):
                            progress_cb(done / total, f"スタンプ画像をキャッシュ中 ({done}/{total})")

            await asyncio.gather(*(fetch_one(u, d) for u, d in to_fetch))

    for it in items:
        if it.sticker_url and it.sticker_url in url_to_path:
            it.sticker_path = url_to_path[it.sticker_url]
        for run in it.runs:
            if run.kind == "emote" and run.emote_url in url_to_path:
                run.emote_path = url_to_path[run.emote_url]
