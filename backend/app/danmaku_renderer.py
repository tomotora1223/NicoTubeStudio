from __future__ import annotations

import asyncio
import math
import queue
import subprocess
import threading
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Callable, Optional

import numpy as np
import skia

from .chat_parser import ChatRun, ParsedChatItem, YOUTUBE_SUPERCHAT_TIERS, _contrast_text_for_bg
from .ffmpeg_tools import (
    find_ffmpeg,
    get_audio_codec,
    get_video_metadata,
    resolve_ffmpeg_video_args,
    resolve_hw_decode_args,
)
from .fonts import resolve_typeface_file
from .models import (
    DEFAULT_SUPERCHAT_TIER_COLORS,
    CollisionMode,
    CommentStyleConfig,
    EncodeConfig,
    EncoderProbeResult,
    EventDisplayMode,
    RoleDisplayMode,
    SuperChatMode,
)


def _parse_hex_color(hex_str: str, alpha: int = 255) -> int:
    s = (hex_str or "#FFFFFF").lstrip("#")
    if len(s) == 6:
        r, g, b = int(s[0:2], 16), int(s[2:4], 16), int(s[4:6], 16)
        return skia.ColorSetARGB(alpha, r, g, b)
    return skia.ColorSetARGB(alpha, 255, 255, 255)


def _is_emoji_char(cp: int) -> bool:
    return (
        0x1F300 <= cp <= 0x1FAFF
        or 0x2600 <= cp <= 0x27BF
        or 0xFE00 <= cp <= 0xFE0F
        or cp == 0x200D
        or 0x1F1E6 <= cp <= 0x1F1FF
    )


class FontResolver:
    def __init__(self, primary_family: str, weight: int) -> None:
        self.fm = skia.FontMgr.RefDefault()
        sk_weight = max(100, min(900, weight))
        self.font_style = skia.FontStyle(
            sk_weight, skia.FontStyle.kNormal_Width, skia.FontStyle.kUpright_Slant
        )
        tf = None
        # Prefer dynamically resolved file when user installed a font without restarting
        font_file = resolve_typeface_file(primary_family)
        matched = self.fm.matchFamilyStyle(primary_family, self.font_style)
        if matched is not None and matched.getFamilyName().lower() == primary_family.strip().lower():
            tf = matched
        elif font_file is not None:
            try:
                tf = skia.Typeface.MakeFromFile(str(font_file))
            except Exception:
                tf = None
        if tf is None:
            tf = matched

        self.primary_tf = (
            tf
            or self.fm.matchFamilyStyle("Yu Gothic UI", self.font_style)
            or self.fm.matchFamilyStyle("Meiryo", self.font_style)
            or self.fm.legacyMakeTypeface(None, self.font_style)
        )
        self.emoji_tf = self.fm.matchFamilyStyle(
            "Segoe UI Emoji", skia.FontStyle.Normal()
        )
        self._fallback_cache: dict[int, skia.Typeface] = {}

    def typeface_for_char(self, ch: str) -> skia.Typeface:
        cp = ord(ch)
        if _is_emoji_char(cp) and self.emoji_tf is not None:
            if self.emoji_tf.unicharToGlyph(cp) != 0:
                return self.emoji_tf
        if self.primary_tf is not None and self.primary_tf.unicharToGlyph(cp) != 0:
            return self.primary_tf
        if cp in self._fallback_cache:
            return self._fallback_cache[cp]
        fb = self.fm.matchFamilyStyleCharacter("", self.font_style, ["ja", "en"], cp)
        res = fb or self.primary_tf
        self._fallback_cache[cp] = res
        return res

    def segment_text(self, text: str, include_unicode_emoji: bool) -> list[tuple[str, skia.Typeface]]:
        segments: list[tuple[str, skia.Typeface]] = []
        cur_buf: list[str] = []
        cur_tf: Optional[skia.Typeface] = None

        for ch in text:
            if not include_unicode_emoji and _is_emoji_char(ord(ch)):
                continue
            tf = self.typeface_for_char(ch)
            if cur_tf is None:
                cur_tf = tf
                cur_buf.append(ch)
            elif tf == cur_tf:
                cur_buf.append(ch)
            else:
                segments.append(("".join(cur_buf), cur_tf))
                cur_buf = [ch]
                cur_tf = tf
        if cur_buf and cur_tf is not None:
            segments.append(("".join(cur_buf), cur_tf))
        return segments


class EmoteImageCache:
    def __init__(self) -> None:
        self._images: dict[str, Optional[skia.Image]] = {}

    def get(self, path: Optional[str]) -> Optional[skia.Image]:
        if not path:
            return None
        if path in self._images:
            return self._images[path]
        try:
            data = Path(path).read_bytes()
            sk_data = skia.Data.MakeWithCopy(data)
            img = skia.Image.MakeFromEncoded(sk_data)
            self._images[path] = img
            return img
        except Exception:
            self._images[path] = None
            return None


@dataclass
class ScheduledDanmaku:
    item: ParsedChatItem
    t_start: float
    t_end: float
    mode: str  # "naka" | "ue" | "shita"
    y: float
    width: float
    height: float
    velocity: float
    is_card: bool
    text_color: str
    font_px: float
    pad_x: float = 0.0
    pad_y: float = 0.0
    sprite: Optional[skia.Image] = None


class DanmakuEngine:
    """Niconico-authentic layout + Skia sprite rasterizer."""

    def __init__(self, width: int, height: int, style: CommentStyleConfig) -> None:
        self.width = width
        self.height = height
        self.style = style
        self.scale = height / 360.0
        self.base_font_px = 24.0 * self.scale * style.font_scale
        self.lane_height = max(12.0, self.base_font_px * style.line_height_ratio)
        self.font_resolver = FontResolver(style.font_family, style.font_weight)
        self.emote_cache = EmoteImageCache()

    def _measure_runs(
        self,
        runs: list[ChatRun],
        font_px: float,
        amount_prefix: str = "",
        sticker_path: Optional[str] = None,
    ) -> tuple[float, float]:
        w = 0.0
        emote_size = font_px * 1.12
        if amount_prefix:
            seg_font = skia.Font(self.font_resolver.primary_tf, font_px * 0.88)
            w += seg_font.measureText(amount_prefix) + font_px * 0.45

        for run in runs:
            if run.kind == "emote" and self.style.custom_emotes_enabled and run.emote_path:
                w += emote_size + 2.0 * self.scale
            else:
                txt = run.text
                if run.kind == "emote" and not self.style.custom_emotes_enabled:
                    txt = ""
                if not txt:
                    continue
                for seg_txt, tf in self.font_resolver.segment_text(txt, self.style.unicode_emoji_enabled):
                    f = skia.Font(tf, font_px)
                    w += f.measureText(seg_txt)

        if sticker_path and self.style.custom_emotes_enabled:
            w += emote_size * 1.45 + 4.0 * self.scale

        h = font_px * 1.32
        return max(1.0, w), h

    def render_sprite(self, sched: ScheduledDanmaku) -> skia.Image:
        font_px = sched.font_px
        emote_size = font_px * 1.12
        outline_w = self.style.outline_width * self.scale
        outline2_w = self.style.outline2_width * self.scale
        shadow_extra = (
            max(abs(self.style.shadow_offset_x), abs(self.style.shadow_offset_y)) * self.scale
            + self.style.shadow_blur * self.scale
        ) if self.style.shadow_enabled else 0.0
        pad_x = int(math.ceil((10.0 * self.scale if sched.is_card else 4.0 * self.scale) + outline_w + outline2_w + shadow_extra + 2))
        pad_y = int(math.ceil((5.0 * self.scale if sched.is_card else 3.0 * self.scale) + outline_w + outline2_w + shadow_extra + 2))
        sched.pad_x = float(pad_x)
        sched.pad_y = float(pad_y)

        img_w = max(8, int(math.ceil(sched.width)) + pad_x * 2)
        img_h = max(8, int(math.ceil(sched.height)) + pad_y * 2)

        info = skia.ImageInfo.Make(
            img_w, img_h, skia.ColorType.kBGRA_8888_ColorType, skia.AlphaType.kPremul_AlphaType
        )
        surface = skia.Surface.MakeRaster(info)
        canvas = surface.getCanvas()
        canvas.clear(skia.ColorTRANSPARENT)

        opacity_alpha = max(10, min(255, int(round(self.style.opacity * 255))))

        if sched.is_card:
            bg_hex = sched.item.bg_color or "#1E88E5"
            fg_hex = sched.item.fg_color or _contrast_text_for_bg(bg_hex)
            card_alpha = min(255, int(round(self.style.card_opacity * 255)))
            card_radius = float(self.style.card_radius_px) * self.scale
            rect = skia.Rect.MakeXYWH(2, 2, img_w - 4, img_h - 4)
            rr = skia.RRect.MakeRectXY(rect, card_radius, card_radius)

            bg_paint = skia.Paint(
                Color=_parse_hex_color(bg_hex, card_alpha),
                AntiAlias=True,
            )
            canvas.drawRRect(rr, bg_paint)
            if self.style.card_border_opacity > 0.01:
                border_alpha = int(round(card_alpha * self.style.card_border_opacity))
                border_paint = skia.Paint(
                    Color=skia.ColorSetARGB(border_alpha, 255, 255, 255),
                    Style=skia.Paint.kStroke_Style,
                    StrokeWidth=max(1.0, 1.0 * self.scale),
                    AntiAlias=True,
                )
                canvas.drawRRect(rr, border_paint)
            text_col = _parse_hex_color(fg_hex, min(255, max(card_alpha, 235)))
        else:
            text_col = _parse_hex_color(sched.text_color, opacity_alpha)

        cursor_x = float(pad_x)
        baseline_y = float(pad_y) + font_px * 0.90

        # Amount badge inside Super Chat card
        if sched.is_card and self.style.superchat_show_amount and sched.item.amount_text:
            amt_font = skia.Font(self.font_resolver.primary_tf, font_px * 0.86)
            amt_w = amt_font.measureText(sched.item.amount_text)
            chip_pad = 5.0 * self.scale
            chip_rect = skia.Rect.MakeXYWH(
                cursor_x - 2.0 * self.scale,
                pad_y + 1.0 * self.scale,
                amt_w + chip_pad * 1.4,
                sched.height - 2.0 * self.scale,
            )
            chip_rr = skia.RRect.MakeRectXY(chip_rect, max(2.0, self.style.card_radius_px * 0.55) * self.scale, max(2.0, self.style.card_radius_px * 0.55) * self.scale)
            canvas.drawRRect(
                chip_rr,
                skia.Paint(Color=skia.ColorSetARGB(72, 0, 0, 0), AntiAlias=True),
            )
            amt_paint = skia.Paint(Color=text_col, AntiAlias=True)
            canvas.drawSimpleText(
                sched.item.amount_text, cursor_x + chip_pad * 0.45, baseline_y - font_px * 0.04, amt_font, amt_paint
            )
            cursor_x += amt_w + font_px * 0.45

        outline_alpha = int(round(opacity_alpha * self.style.outline_opacity))
        outline_paint = skia.Paint(
            Color=_parse_hex_color(self.style.outline_color, outline_alpha),
            Style=skia.Paint.kStroke_Style,
            StrokeWidth=max(0.5, outline_w * 2.0),
            StrokeJoin=skia.Paint.kRound_Join,
            StrokeCap=skia.Paint.kRound_Cap,
            AntiAlias=True,
        )
        outline2_alpha = int(round(opacity_alpha * self.style.outline2_opacity))
        outline2_paint = skia.Paint(
            Color=_parse_hex_color(self.style.outline2_color, outline2_alpha),
            Style=skia.Paint.kStroke_Style,
            StrokeWidth=max(0.5, (outline_w + outline2_w) * 2.0),
            StrokeJoin=skia.Paint.kRound_Join,
            StrokeCap=skia.Paint.kRound_Cap,
            AntiAlias=True,
        )
        shadow_alpha = int(round(opacity_alpha * self.style.shadow_opacity))
        shadow_paint = skia.Paint(
            Color=_parse_hex_color(self.style.shadow_color, shadow_alpha),
            AntiAlias=True,
        )
        if self.style.shadow_enabled and self.style.shadow_blur > 0.05:
            shadow_paint.setMaskFilter(
                skia.MaskFilter.MakeBlur(skia.kNormal_BlurStyle, float(self.style.shadow_blur) * self.scale * 0.6)
            )
        shadow_dx = float(self.style.shadow_offset_x) * self.scale
        shadow_dy = float(self.style.shadow_offset_y) * self.scale

        fill_paint = skia.Paint(Color=text_col, AntiAlias=True)
        img_paint = skia.Paint(Alpha=opacity_alpha)
        sampling = skia.SamplingOptions(skia.FilterMode.kLinear, skia.MipmapMode.kNone)

        # Sticker image if present
        if sched.item.sticker_path and self.style.custom_emotes_enabled:
            st_img = self.emote_cache.get(sched.item.sticker_path)
            if st_img is not None:
                st_size = emote_size * 1.35
                dst = skia.Rect.MakeXYWH(
                    cursor_x, pad_y + (sched.height - st_size) * 0.5, st_size, st_size
                )
                canvas.drawImageRect(st_img, dst, sampling, img_paint)
                cursor_x += st_size + 4.0 * self.scale

        for run in sched.item.runs:
            if run.kind == "emote" and self.style.custom_emotes_enabled and run.emote_path:
                em_img = self.emote_cache.get(run.emote_path)
                if em_img is not None:
                    dst = skia.Rect.MakeXYWH(
                        cursor_x,
                        pad_y + (sched.height - emote_size) * 0.45,
                        emote_size,
                        emote_size,
                    )
                    canvas.drawImageRect(em_img, dst, sampling, img_paint)
                    cursor_x += emote_size + 2.0 * self.scale
                    continue
                continue

            txt = run.text
            if run.kind == "emote" and not self.style.custom_emotes_enabled:
                continue
            if not txt:
                continue

            for seg_txt, tf in self.font_resolver.segment_text(txt, self.style.unicode_emoji_enabled):
                seg_font = skia.Font(tf, font_px)
                seg_font.setEdging(skia.Font.Edging.kAntiAlias)
                is_emoji_seg = tf == self.font_resolver.emoji_tf

                if not sched.is_card and not is_emoji_seg:
                    if self.style.shadow_enabled and shadow_alpha > 0:
                        canvas.drawSimpleText(seg_txt, cursor_x + shadow_dx, baseline_y + shadow_dy, seg_font, shadow_paint)
                    if outline2_w > 0.05 and outline2_alpha > 0:
                        canvas.drawSimpleText(seg_txt, cursor_x, baseline_y, seg_font, outline2_paint)
                    if outline_w > 0.05 and outline_alpha > 0:
                        canvas.drawSimpleText(seg_txt, cursor_x, baseline_y, seg_font, outline_paint)

                canvas.drawSimpleText(seg_txt, cursor_x, baseline_y, seg_font, fill_paint)
                cursor_x += seg_font.measureText(seg_txt)

        return surface.makeImageSnapshot()

    def schedule_comments(self, items: list[ParsedChatItem]) -> list[ScheduledDanmaku]:
        usable_h = self.height * self.style.display_area_ratio
        margin_top = 3.0 * self.scale
        num_lanes = max(1, int((usable_h - margin_top) // self.lane_height))
        gap = self.style.lane_gap_px * self.scale

        # Track last comment per naka lane: (t_start, width, velocity, duration)
        naka_lanes: list[Optional[tuple[float, float, float, float]]] = [None] * num_lanes
        ue_lanes_end: list[float] = [0.0] * num_lanes
        shita_lanes_end: list[float] = [0.0] * num_lanes

        scheduled: list[ScheduledDanmaku] = []
        active_windows: list[float] = []  # sorted end times for max_concurrent check

        for idx, it in enumerate(items):
            # Determine mode, color, card, font size
            mode = self.style.normal_pin_mode or "naka"
            is_card = False
            font_px = self.base_font_px
            text_color = self.style.default_color
            amount_prefix = ""
            runs_to_use = it.runs
            item_bg_color = it.bg_color
            item_fg_color = it.fg_color
            speed_mult = 1.0

            if it.kind == "member":
                mode = self.style.member_pin_mode or "naka"
                font_px = self.base_font_px * self.style.member_scale
                if self.style.member_color_enabled:
                    text_color = self.style.member_color
                if self.style.member_badge_prefix and self.style.member_badge_text:
                    runs_to_use = [ChatRun(kind="text", text=f"{self.style.member_badge_text} ")] + it.runs
            elif it.kind == "moderator":
                if self.style.moderator_mode == RoleDisplayMode.HIDE:
                    continue
                mode = self.style.moderator_pin_mode or "naka"
                font_px = self.base_font_px * self.style.moderator_scale
                if self.style.moderator_mode == RoleDisplayMode.COLOR and self.style.moderator_color_enabled:
                    text_color = self.style.moderator_color
                if self.style.moderator_badge_prefix and self.style.moderator_badge_text:
                    runs_to_use = [ChatRun(kind="text", text=f"{self.style.moderator_badge_text} ")] + it.runs
            elif it.kind == "owner":
                font_px = self.base_font_px * self.style.owner_scale
                if self.style.owner_color_enabled:
                    text_color = self.style.owner_color
                mode = self.style.owner_pin_mode or ("ue" if self.style.owner_pin_top else "naka")
                if self.style.owner_badge_prefix and self.style.owner_badge_text:
                    runs_to_use = [ChatRun(kind="text", text=f"{self.style.owner_badge_text} ")] + it.runs
            elif it.kind in ("superchat", "sticker"):
                eff_mode = (
                    self.style.superchat_mode.value
                    if it.kind == "superchat" or self.style.supersticker_mode == EventDisplayMode.FOLLOW_SUPERCHAT
                    else self.style.supersticker_mode.value
                )
                if eff_mode == "hide":
                    continue
                font_px = self.base_font_px * (
                    self.style.supersticker_scale if it.kind == "sticker" else self.style.superchat_scale
                )
                speed_mult = self.style.superchat_speed_multiplier
                tier = it.sc_tier or "blue"
                if self.style.superchat_color_source == "custom":
                    item_bg_color = self.style.superchat_tier_colors.get(
                        tier, DEFAULT_SUPERCHAT_TIER_COLORS.get(tier, "#1E88E5")
                    )
                elif self.style.superchat_color_source == "official":
                    item_bg_color = YOUTUBE_SUPERCHAT_TIERS.get(tier, it.bg_color or "#1E88E5")
                else:
                    item_bg_color = it.bg_color or YOUTUBE_SUPERCHAT_TIERS.get(tier, "#1E88E5")
                item_fg_color = _contrast_text_for_bg(item_bg_color)

                if eff_mode in ("card_scroll", "card_top"):
                    is_card = True
                    mode = "ue" if eff_mode == "card_top" else "naka"
                    if self.style.superchat_show_amount:
                        amount_prefix = it.amount_text
                else:
                    text_color = item_bg_color
                    if self.style.superchat_show_amount and it.amount_text:
                        runs_to_use = [ChatRun(kind="text", text=f"[{it.amount_text}] ")] + it.runs
            elif it.kind in ("membership", "gift"):
                if not self.style.membership_events_enabled:
                    continue
                ev_mode = (
                    self.style.membership_mode
                    if it.kind == "membership"
                    else self.style.gift_mode
                )
                if ev_mode == EventDisplayMode.HIDE:
                    continue
                ev_color = self.style.membership_color if it.kind == "membership" else self.style.gift_color
                item_bg_color = ev_color
                item_fg_color = _contrast_text_for_bg(ev_color)
                font_px = self.base_font_px * (
                    self.style.membership_scale if it.kind == "membership" else self.style.gift_scale
                )
                if ev_mode in (EventDisplayMode.CARD_SCROLL, EventDisplayMode.CARD_TOP):
                    is_card = True
                    mode = "ue" if ev_mode == EventDisplayMode.CARD_TOP else "naka"
                else:
                    text_color = ev_color

            # Create working copy of item if runs modified
            work_item = ParsedChatItem(
                item_id=it.item_id,
                offset_sec=it.offset_sec,
                kind=it.kind,
                author=it.author,
                runs=runs_to_use,
                plain_text=it.plain_text,
                amount_text=it.amount_text,
                sc_tier=it.sc_tier,
                bg_color=item_bg_color,
                fg_color=item_fg_color,
                sticker_url=it.sticker_url,
                sticker_path=it.sticker_path,
            )

            w, h = self._measure_runs(
                work_item.runs, font_px, amount_prefix=amount_prefix, sticker_path=work_item.sticker_path
            )
            if is_card:
                w += 16.0 * self.scale
                h += 8.0 * self.scale

            t_start = it.offset_sec

            # Concurrency cap
            if self.style.max_concurrent > 0:
                active_windows = [et for et in active_windows if et > t_start]
                if len(active_windows) >= self.style.max_concurrent:
                    continue

            if mode in ("ue", "shita"):
                dur = self.style.fixed_duration_sec
                lanes_arr = ue_lanes_end if mode == "ue" else shita_lanes_end
                chosen_lane = None
                for li in range(num_lanes):
                    if lanes_arr[li] <= t_start:
                        chosen_lane = li
                        break
                if chosen_lane is None:
                    if self.style.collision_mode == CollisionMode.DROP:
                        continue
                    chosen_lane = min(range(num_lanes), key=lambda li: lanes_arr[li])
                lanes_arr[chosen_lane] = t_start + dur

                y = (
                    margin_top + chosen_lane * self.lane_height
                    if mode == "ue"
                    else self.height - margin_top - (chosen_lane + 1) * self.lane_height
                )
                t_end = t_start + dur
                active_windows.append(t_end)
                scheduled.append(
                    ScheduledDanmaku(
                        item=work_item,
                        t_start=t_start,
                        t_end=t_end,
                        mode=mode,
                        y=y,
                        width=w,
                        height=h,
                        velocity=0.0,
                        is_card=is_card,
                        text_color=text_color,
                        font_px=font_px,
                    )
                )
            else:
                dur = max(1.2, self.style.scroll_duration_sec / max(0.5, speed_mult))
                vel = (self.width + w) / dur

                def fits_lane(lane_state: Optional[tuple[float, float, float, float]], ts: float) -> bool:
                    if lane_state is None:
                        return True
                    p_start, p_w, p_v, p_dur = lane_state
                    p_exit = p_start + p_dur
                    if ts >= p_exit:
                        return True
                    # Condition 1: previous comment trailing edge is inside screen with gap
                    p_right_at_ts = (self.width - p_v * (ts - p_start)) + p_w
                    if p_right_at_ts > self.width - gap:
                        return False
                    # Condition 2: new comment leading edge does not catch up before p exits
                    c_left_at_exit = self.width - vel * (p_exit - ts)
                    if c_left_at_exit < gap:
                        return False
                    return True

                chosen_lane = None
                for li in range(num_lanes):
                    if fits_lane(naka_lanes[li], t_start):
                        chosen_lane = li
                        break

                if chosen_lane is None:
                    if self.style.collision_mode == CollisionMode.DROP:
                        continue
                    elif self.style.collision_mode == CollisionMode.STAGGER:
                        # Probe small delays up to 1.5s
                        found = False
                        for step in range(1, 16):
                            cand_t = t_start + step * 0.1
                            for li in range(num_lanes):
                                if fits_lane(naka_lanes[li], cand_t):
                                    t_start = cand_t
                                    chosen_lane = li
                                    found = True
                                    break
                            if found:
                                break
                        if not found:
                            continue
                    else:
                        # Danmaku barrage fallback: pick lane whose previous comment exits earliest
                        chosen_lane = idx % num_lanes

                naka_lanes[chosen_lane] = (t_start, w, vel, dur)
                y = margin_top + chosen_lane * self.lane_height
                t_end = t_start + dur
                active_windows.append(t_end)
                scheduled.append(
                    ScheduledDanmaku(
                        item=work_item,
                        t_start=t_start,
                        t_end=t_end,
                        mode="naka",
                        y=y,
                        width=w,
                        height=h,
                        velocity=vel,
                        is_card=is_card,
                        text_color=text_color,
                        font_px=font_px,
                    )
                )

        scheduled.sort(key=lambda s: s.t_start)
        return scheduled


def burn_danmaku_with_ffmpeg(
    source_video: str,
    output_video: str,
    items: list[ParsedChatItem],
    style: CommentStyleConfig,
    encode: EncodeConfig,
    probe: EncoderProbeResult,
    progress_cb: Optional[Callable[[float, float, str, Optional[int]], None]] = None,
    cancel_event: Optional[threading.Event] = None,
    clip_offset_sec: float = 0.0,
    clip_duration_sec: Optional[float] = None,
    proc_hook: Optional[Callable[[subprocess.Popen, bool], None]] = None,
) -> None:
    ffmpeg_exe = find_ffmpeg()
    if not ffmpeg_exe:
        raise RuntimeError("FFmpegが見つかりません。設定画面からFFmpegをインストールしてください。")

    width, height, fps, duration = get_video_metadata(source_video)
    if clip_duration_sec is not None and clip_duration_sec > 0:
        duration = clip_duration_sec
    elif clip_offset_sec > 0 and duration > clip_offset_sec:
        duration = duration - clip_offset_sec
    if encode.max_fps > 0 and fps > encode.max_fps:
        fps = float(encode.max_fps)

    engine = DanmakuEngine(width, height, style)
    scheduled = engine.schedule_comments(items)

    total_frames = max(1, int(math.ceil(duration * fps))) if duration > 0 else 1
    enc_args = resolve_ffmpeg_video_args(
        encode.codec, encode.hw_encoder, encode.quality_cq, encode.preset_speed, probe
    )
    hw_dec_args = resolve_hw_decode_args(encode.hw_encoder, probe)

    src_audio_codec = get_audio_codec(source_video)
    can_copy_audio = (encode.container == "mkv" or src_audio_codec == "aac") and clip_offset_sec <= 0.05
    audio_args = ["-c:a", "copy"] if can_copy_audio else ["-c:a", "aac", "-b:a", "192k"]
    container_args = ["-movflags", "+faststart"] if encode.container == "mp4" else []

    clip_in_args: list[str] = []
    if clip_offset_sec > 0:
        clip_in_args += ["-ss", f"{clip_offset_sec:.3f}"]
    if clip_duration_sec is not None and clip_duration_sec > 0:
        clip_in_args += ["-t", f"{clip_duration_sec:.3f}"]

    def _run_pass(in_hw_args: list[str]) -> tuple[int, str]:
        cmd = [
            ffmpeg_exe,
            "-y",
            "-hide_banner",
            "-loglevel",
            "error",
            "-threads",
            "0",
            "-progress",
            "pipe:1",
            *in_hw_args,
            *clip_in_args,
            "-i",
            source_video,
            "-f",
            "rawvideo",
            "-pix_fmt",
            "bgra",
            "-s",
            f"{width}x{height}",
            "-r",
            f"{fps:.6f}",
            "-i",
            "pipe:0",
            "-filter_complex",
            f"[0:v]fps={fps:.6f},format=yuv420p[bg];[1:v]format=bgra[ov];[bg][ov]overlay=0:0:shortest=1:alpha=premultiplied[v]",
            "-map",
            "[v]",
            "-map",
            "0:a?",
            *enc_args,
            *audio_args,
            *container_args,
            output_video,
        ]

        proc = subprocess.Popen(
            cmd,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            bufsize=8 * 1024 * 1024,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
        if proc_hook:
            proc_hook(proc, True)

        # Read ffmpeg -progress pipe:1 and stderr in background threads
        latest_stats = {"fps": 0.0, "speed": "", "out_us": 0}
        stderr_chunks: list[bytes] = []

        def read_progress() -> None:
            assert proc.stdout is not None
            for raw_line in proc.stdout:
                line = raw_line.decode("utf-8", errors="ignore").strip()
                if "=" not in line:
                    continue
                k, v = line.split("=", 1)
                if k == "fps":
                    try:
                        latest_stats["fps"] = float(v)
                    except Exception:
                        pass
                elif k == "speed":
                    latest_stats["speed"] = v
                elif k == "out_time_us":
                    try:
                        latest_stats["out_us"] = int(v)
                    except Exception:
                        pass

        def drain_err() -> None:
            if proc.stderr is None:
                return
            while True:
                chunk = proc.stderr.read(4096)
                if not chunk:
                    break
                if len(stderr_chunks) < 16:
                    stderr_chunks.append(chunk)

        prog_thread = threading.Thread(target=read_progress, daemon=True)
        err_thread = threading.Thread(target=drain_err, daemon=True)
        prog_thread.start()
        err_thread.start()

        # Prepare frame buffer backed by numpy + Skia surface, plus async pipe writer
        frame_buf = np.zeros((height, width, 4), dtype=np.uint8)
        empty_bytes = bytes(height * width * 4)
        img_info = skia.ImageInfo.Make(
            width, height, skia.ColorType.kBGRA_8888_ColorType, skia.AlphaType.kPremul_AlphaType
        )
        surface = skia.Surface.MakeRasterDirect(img_info, frame_buf)
        canvas = surface.getCanvas()
        blit_paint = skia.Paint()
        blit_sampling = skia.SamplingOptions()

        write_q: queue.Queue[Optional[bytes]] = queue.Queue(maxsize=4)
        write_err: list[BaseException] = []

        def pipe_writer() -> None:
            assert proc.stdin is not None
            try:
                while True:
                    chunk = write_q.get()
                    if chunk is None:
                        break
                    proc.stdin.write(chunk)
            except BaseException as exc:
                write_err.append(exc)
            finally:
                try:
                    proc.stdin.close()
                except Exception:
                    pass

        writer_thread = threading.Thread(target=pipe_writer, daemon=True)
        writer_thread.start()

        next_idx = 0
        active: list[ScheduledDanmaku] = []
        n_sched = len(scheduled)
        start_wall = time.monotonic()

        try:
            for frame_idx in range(total_frames):
                if cancel_event and cancel_event.is_set():
                    try:
                        proc.kill()
                    except Exception:
                        pass
                    raise RuntimeError("ジョブがキャンセルされました")
                if write_err:
                    raise write_err[0]

                t = frame_idx / fps

                while next_idx < n_sched and scheduled[next_idx].t_start <= t:
                    item_s = scheduled[next_idx]
                    if item_s.t_end >= t:
                        if item_s.sprite is None:
                            item_s.sprite = engine.render_sprite(item_s)
                        active.append(item_s)
                    next_idx += 1

                # Drop expired & free sprite memory
                still_active: list[ScheduledDanmaku] = []
                for s in active:
                    if s.t_end >= t:
                        still_active.append(s)
                    else:
                        s.sprite = None
                active = still_active

                if not active:
                    write_q.put(empty_bytes)
                else:
                    canvas.clear(skia.ColorTRANSPARENT)
                    for s in active:
                        if s.sprite is None:
                            continue
                        if s.mode == "naka":
                            x = width - s.velocity * (t - s.t_start)
                        else:
                            x = (width - s.sprite.width()) * 0.5 + s.pad_x
                        canvas.drawImage(
                            s.sprite,
                            float(x) - s.pad_x,
                            float(s.y) - s.pad_y,
                            blit_sampling,
                            blit_paint,
                        )
                    write_q.put(frame_buf.tobytes())

                if progress_cb and (frame_idx % max(1, int(fps // 2)) == 0 or frame_idx == total_frames - 1):
                    pct = min(0.99, (frame_idx + 1) / total_frames)
                    elapsed = max(0.1, time.monotonic() - start_wall)
                    eta = int((elapsed / pct) * (1.0 - pct)) if pct > 0.01 else None
                    progress_cb(
                        pct,
                        latest_stats["fps"] or ((frame_idx + 1) / elapsed),
                        latest_stats["speed"],
                        eta,
                    )

            write_q.put(None)
            writer_thread.join(timeout=30.0)
            if write_err and not isinstance(write_err[0], BrokenPipeError):
                raise write_err[0]
        except BrokenPipeError:
            pass
        finally:
            try:
                write_q.put_nowait(None)
            except Exception:
                pass
            if cancel_event and cancel_event.is_set():
                try:
                    proc.kill()
                except Exception:
                    pass
            writer_thread.join(timeout=2.0)
            if proc_hook:
                proc_hook(proc, False)

        ret = proc.wait()
        prog_thread.join(timeout=2.0)
        err_thread.join(timeout=1.0)
        err_txt = b"".join(stderr_chunks).decode("utf-8", errors="ignore")
        return ret, err_txt

    try:
        ret, err = _run_pass(hw_dec_args)
    except BrokenPipeError:
        if hw_dec_args and not (cancel_event and cancel_event.is_set()):
            ret, err = _run_pass([])
        else:
            raise
    if ret != 0 and hw_dec_args and not (cancel_event and cancel_event.is_set()):
        # Fallback to software decode when GPU decode fails on exotic streams
        ret, err = _run_pass([])

    if cancel_event and cancel_event.is_set():
        raise RuntimeError("ジョブがキャンセルされました")
    if ret != 0:
        raise RuntimeError(f"FFmpeg合成エラー (code {ret}): {err[-500:]}")
