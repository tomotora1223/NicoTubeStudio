---
name: niconico-danmaku
description: Niconico official HTML5 comment player layout rules, collision detection algorithm, and YouTube Live Chat mapping specification. Use when implementing or modifying comment parsing, lane allocation, preview rendering, or video burn-in rendering.
---

# Niconico-Compatible Danmaku Engine & YouTube Chat Mapping

## 1. Virtual Coordinate System (Niconico Official Spec)

- Niconico HTML5 player operates on a **16:9 virtual stage** of `640 × 360` (or scaled proportionally to `target_height`, e.g., `1920 × 1080` has scale `s = target_height / 360.0 = 3.0`).
- All font sizes, margins, and stroke widths scale linearly by `s = output_height / 360.0` (with optional user `font_scale` multiplier).
- **Default Official Ratios (at `1.0x` scale on 360p virtual height)**:
  - `medium` (default): font size `24px` (line height `29px`, ~11-12 lanes on screen)
  - `big`: font size `36px` (line height `42px`)
  - `small`: font size `15px` (line height `19px`)
  - Outline (shadow/stroke): ~`2.0px` dark outline (`rgba(0, 0, 0, 0.85)`) + subtle drop shadow for legibility on bright video frames.
  - Default opacity: `0.85` (adjustable `0.10` – `1.00`).
  - Default scroll duration (`naka`): `4.0` seconds (plus `1.0` second lead/exit buffer or exact edge-to-edge transit time; standard Niconico `naka` traverses screen + own width in `4.0s` or `4.0s` on-screen). Let's parameterize `duration_sec` (default `4.0s`, user range `2.0s – 10.0s`).
  - Fixed comments (`ue` / `shita`): `3.0` seconds (user adjustable).

## 2. Lane Allocation & Collision Prevention (`naka` Scrolling)

For each `naka` comment `c` appearing at `t_start` with rendered pixel width `W` and height `H`, moving across stage width `V_W` over duration `D`:
- Velocity: `v = (V_W + W) / D` (pixels/sec).
- Leading edge at time `t`: `x_left(t) = V_W - v * (t - t_start)`.
- Trailing edge at time `t`: `x_right(t) = x_left(t) + W`.
- **Two conditions for comment `c` to share a lane with previous comment `p` (which started at `p.t_start` with width `p.W`, velocity `p.v`)**:
  1. **Entry gap**: At `t = t_start`, `p` must have already entered the screen completely with safety margin `gap`:
     `p.x_right(t_start) <= V_W - gap`
  2. **No catch-up collision**: Before `p` exits the left edge (`t_p_exit = p.t_start + D`), `c` must not overtake `p`:
     At `t = t_p_exit`, `c.x_left(t_p_exit) >= gap`
- Lanes are scanned top-to-bottom within `display_area_ratio` (e.g., `100%`, `75%`, `50%` top half).
- **When all lanes collide (Danmaku Barrage / 弾幕ラッシュ)**:
  - Mode `danmaku` (Niconico default): Randomly/cyclically pick a lane (or least-overlapping lane) so barrage comments still appear (authentic Niconico feel).
  - Mode `drop`: Skip overflowing comments when `max_concurrent` or lanes are full.
  - Mode `stagger`: Delay `t_start` slightly (up to `max_delay_ms`) until a lane opens.

## 3. Fixed Comments (`ue` / `shita`)

- `ue` (top-pinned) stacks downward from top edge (`y = margin_top + lane_y`).
- `shita` (bottom-pinned) stacks upward from bottom edge (`y = V_H - margin_bottom - lane_y - H`).
- Non-overlapping interval check `[t_start, t_start + fixed_duration]`.

## 4. YouTube Live Chat Feature Mapping

Parse `yt-dlp` `.live_chat.json` (NDJSON) actions (`addChatItemAction`, `addLiveChatTickerItemAction`, `markChatItemAsDeletedAction`, etc.):

1. **Normal Viewer**: Standard text color (`#FFFFFF` default, or user-configured).
2. **Channel Member**:
   - Detected via `authorBadges` containing `member` / custom badge tooltip.
   - Option to tint comment text color (default `#2BA640` / `#66FF99` customizable) and/or prepend subtle `[Member]` / star marker.
3. **Moderator / Broadcaster (Owner)**:
   - Moderator: configurable color (default `#5E84F1` / `#4DA6FF`).
   - Owner / Broadcaster: configurable color (default `#FFD600`, optionally `ue` top-pinned).
4. **Super Chat (Paid Message)**:
   - Map YouTube's `headerBackgroundColor` / `bodyBackgroundColor` (or JPY/USD amount tier) to YouTube's 7 official tiers:
     - Blue (`#1565C0` / `#1E88E5`): ~¥200–¥499
     - Light Blue / Cyan (`#00B8D4` / `#00E5FF`): ~¥500–¥999
     - Green (`#00BFA5` / `#1DE9B6`): ~¥1,000–¥1,999
     - Yellow (`#FFB300` / `#FFCA28`): ~¥2,000–¥4,999
     - Orange (`#E65100` / `#F57C00`): ~¥5,000–¥9,999
     - Magenta (`#C2185B` / `#E91E63`): ~¥10,000–¥19,999
     - Red (`#D00000` / `#E62117`): ¥20,000+
   - Display options:
     - `card_scroll`: Compact rounded pill/badge with tier color + amount + message scrolling across screen (`big` or `medium`).
     - `card_top` (`ue` fixed): Pinned at top (`ue`) with tier card styling so viewers can read it cleanly without blocking center video.
     - `text_color`: Colored Niconico text (`¥1,000 メッセージ`) without card background.
5. **Super Sticker (`liveChatPaidStickerRenderer`)**:
   - Render sticker badge `[Super Sticker ¥amount]` (plus sticker image if emotes/stickers enabled).
6. **Membership Events**:
   - `liveChatMembershipItemRenderer`: New member join or Milestone month message (green badge/highlight).
   - `liveChatSponsorshipsGiftPurchaseAnnouncementRenderer`: Gift membership announcement (distinct celebration highlight).
7. **YouTube Custom Channel Emotes & Unicode Emojis**:
   - Message `runs` list contains `{text: "..."}` and `{emoji: {emojiId, shortcuts, image: {thumbnails: [{url}]}, isCustomEmoji}}`.
   - Unicode emojis: Render in full color (using `Segoe UI Emoji` / OS color emoji font in both Canvas preview and backend rasterizer).
   - Custom channel emotes (`isCustomEmoji: true`): Download highest-res thumbnail once into local disk cache (`cache/emotes/<hash>.png`), and inline-render at `line_height * 1.05` square aligned vertically with text baseline!

## 5. Clip Range Synchronization

When clipping `[clip_start_sec, clip_end_sec]`:
- Filter comments where `clip_start_sec <= offset_sec <= clip_end_sec` (allow `-duration_sec` lead-in optionally or strict `>= clip_start_sec`).
- Shift timestamp: `relative_sec = offset_sec - clip_start_sec`.
- Ensure preview simulation and backend burn-in consume the **exact same preset JSON schema**.
