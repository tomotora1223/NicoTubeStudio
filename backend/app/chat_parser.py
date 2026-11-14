from __future__ import annotations

import asyncio
import hashlib
import json
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable, Optional

import httpx

from .config import EMOTE_CACHE_DIR

TWITCH_GQL_URL = "https://gql.twitch.tv/gql"
TWITCH_CLIENT_ID = "kimne78kx3ncx6brgo4mv6wki5h1ko"
TWITCH_COMMENTS_SHA256 = "b70a3591ff0f4e0313d126c6a1502d79a1c02baebb288227c582044aa76adf6a"


def is_twitch_url(url: str) -> bool:
    u = (url or "").lower()
    return "twitch.tv/" in u


def extract_twitch_target(url: str) -> tuple[Optional[str], Optional[str]]:
    """Return (video_id, clip_slug) extracted from a Twitch URL."""
    vod_m = re.search(r"twitch\.tv/videos/(\d+)", url, re.IGNORECASE)
    if vod_m:
        return vod_m.group(1), None
    clip_m = re.search(r"(?:clips\.twitch\.tv/|twitch\.tv/[^/]+/clip/)([A-Za-z0-9_-]+)", url, re.IGNORECASE)
    if clip_m:
        return None, clip_m.group(1)
    return None, None


def resolve_twitch_clip_source(clip_slug: str) -> tuple[Optional[str], float, Optional[float]]:
    """Resolve a Twitch clip slug to (source_vod_id, vod_offset_sec, clip_duration_sec)."""
    query = (
        f'{{ clip(slug: "{clip_slug}") {{ '
        f"video {{ id }} videoOffsetSeconds durationSeconds }} }}"
    )
    try:
        with httpx.Client(timeout=10.0, follow_redirects=True) as client:
            resp = client.post(
                TWITCH_GQL_URL,
                headers={"Client-ID": TWITCH_CLIENT_ID, "Content-Type": "application/json"},
                json={"query": query},
            )
            if resp.status_code != 200:
                return None, 0.0, None
            clip = ((resp.json() or {}).get("data") or {}).get("clip") or {}
            vod_id = ((clip.get("video") or {}).get("id")) or None
            offset = float(clip.get("videoOffsetSeconds") or 0.0)
            dur = float(clip.get("durationSeconds") or 0.0) or None
            return str(vod_id) if vod_id else None, offset, dur
    except Exception:
        return None, 0.0, None


def fetch_twitch_chat_to_file(
    url: str,
    dest_path: Path,
    clip_start_sec: Optional[float] = None,
    clip_end_sec: Optional[float] = None,
    progress_cb: Optional[Callable[[float, str], None]] = None,
    cancel_check: Optional[Callable[[], bool]] = None,
) -> Optional[Path]:
    """Fetch Twitch VOD / Clip comments via public GQL API and save standardized JSON."""
    vod_id, clip_slug = extract_twitch_target(url)
    base_offset = 0.0
    if clip_slug:
        resolved_vod, vod_offset, clip_dur = resolve_twitch_clip_source(clip_slug)
        if not resolved_vod:
            return None
        vod_id = resolved_vod
        base_offset = vod_offset
        fetch_start = base_offset + max(0.0, float(clip_start_sec or 0.0))
        if clip_end_sec is not None:
            fetch_end: Optional[float] = base_offset + float(clip_end_sec)
        elif clip_dur is not None:
            fetch_end = base_offset + clip_dur
        else:
            fetch_end = None
    elif vod_id:
        fetch_start = max(0.0, float(clip_start_sec or 0.0))
        fetch_end = float(clip_end_sec) if clip_end_sec is not None else None
    else:
        return None

    collected: list[dict] = []
    cursor: Optional[str] = None
    max_pages = 300
    headers = {"Client-ID": TWITCH_CLIENT_ID, "Content-Type": "application/json"}

    with httpx.Client(timeout=15.0, follow_redirects=True) as client:
        for page_idx in range(max_pages):
            if cancel_check and cancel_check():
                raise RuntimeError("Cancelled by user")
            variables = {"videoID": str(vod_id)}
            if cursor:
                variables["cursor"] = cursor
            else:
                variables["contentOffsetSeconds"] = max(0, int(fetch_start))

            payload = [
                {
                    "operationName": "VideoCommentsByOffsetOrCursor",
                    "variables": variables,
                    "extensions": {
                        "persistedQuery": {
                            "version": 1,
                            "sha256Hash": TWITCH_COMMENTS_SHA256,
                        }
                    },
                }
            ]
            resp = client.post(TWITCH_GQL_URL, headers=headers, json=payload)
            if resp.status_code != 200:
                break
            body = resp.json()
            if not isinstance(body, list) or not body:
                break
            comments_conn = ((body[0].get("data") or {}).get("video") or {}).get("comments") or {}
            edges = comments_conn.get("edges") or []
            if not edges:
                break

            reached_end = False
            for edge in edges:
                node = edge.get("node") or {}
                raw_offset = node.get("contentOffsetSeconds")
                if raw_offset is None:
                    continue
                offset_val = float(raw_offset)
                if fetch_end is not None and offset_val > fetch_end + 1.5:
                    reached_end = True
                    break
                # Normalize relative to clip base offset when fetching a clip
                rel_offset = offset_val - base_offset
                if rel_offset < 0:
                    continue
                node_copy = dict(node)
                node_copy["contentOffsetSeconds"] = rel_offset
                collected.append(node_copy)
                cursor = edge.get("cursor") or cursor

            if progress_cb and page_idx % 3 == 0:
                progress_cb(0.05, f"Twitchコメント取得中 ({len(collected)}件)...")

            has_next = bool((comments_conn.get("pageInfo") or {}).get("hasNextPage"))
            if reached_end or not has_next or not cursor:
                break

    if not collected:
        return None

    dest_path.write_text(
        json.dumps({"source": "twitch", "vod_id": vod_id, "comments": collected}, ensure_ascii=False),
        encoding="utf-8",
    )
    if progress_cb:
        progress_cb(0.06, f"Twitchコメント取得完了 ({len(collected)}件)")
    return dest_path


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


def _parse_twitch_chat_payload(
    nodes: list[dict],
    c_start: float,
    c_end: Optional[float],
    ng_lower: list[str],
) -> list[ParsedChatItem]:
    result: list[ParsedChatItem] = []
    for node in nodes:
        raw_offset = node.get("contentOffsetSeconds")
        if raw_offset is None:
            continue
        offset_sec = float(raw_offset)
        if offset_sec < c_start:
            continue
        if c_end is not None and offset_sec > c_end:
            continue

        msg = node.get("message") or {}
        frags = msg.get("fragments") or []
        runs: list[ChatRun] = []
        plain_parts: list[str] = []
        for frag in frags:
            emote = frag.get("emote")
            txt = str(frag.get("text") or "")
            if emote and emote.get("emoteID"):
                eid = str(emote["emoteID"])
                runs.append(
                    ChatRun(
                        kind="emote",
                        text=txt or f":{eid}:",
                        emote_url=f"https://static-cdn.jtvnw.net/emoticons/v2/{eid}/default/dark/2.0",
                    )
                )
                plain_parts.append(txt or f":{eid}:")
            elif txt:
                runs.append(ChatRun(kind="text", text=txt))
                plain_parts.append(txt)

        plain_text = "".join(plain_parts).strip()
        if not plain_text and not runs:
            continue
        if ng_lower:
            low = plain_text.lower()
            if any(w in low for w in ng_lower):
                continue

        badges = msg.get("userBadges") or []
        kind = "normal"
        is_member = False
        for b in badges:
            sid = str(b.get("setID") or "").lower()
            if sid == "broadcaster":
                kind = "owner"
                break
            if sid == "moderator":
                kind = "moderator"
            elif sid in ("subscriber", "founder"):
                is_member = True
        if kind == "normal" and is_member:
            kind = "member"

        author = str(((node.get("commenter") or {}).get("displayName")) or "")
        result.append(
            ParsedChatItem(
                item_id=str(node.get("id") or ""),
                offset_sec=max(0.0, offset_sec - c_start),
                kind=kind,
                author=author,
                runs=runs,
                plain_text=plain_text,
            )
        )
    result.sort(key=lambda x: x.offset_sec)
    return result


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
    c_start = float(clip_start_sec) if clip_start_sec is not None else 0.0
    c_end = float(clip_end_sec) if clip_end_sec is not None else None

    if path.name.endswith(".twitch_chat.json"):
        try:
            payload = json.loads(path.read_text(encoding="utf-8", errors="ignore"))
            if isinstance(payload, dict) and payload.get("source") == "twitch":
                return _parse_twitch_chat_payload(payload.get("comments") or [], c_start, c_end, ng_lower)
        except Exception:
            return []

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
