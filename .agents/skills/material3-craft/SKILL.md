---
name: material3-craft
description: Material Design 3 surface hierarchy, tonal palette, shape tokens, and component craft combined with unslop discipline for desktop media tools. Use whenever building or refining UI components, themes, layout, or styling.
---

# Material 3 Craft (for NicoTube Studio)

Combines Google Material Design 3 structural clarity with strict `unslop` craft principles.

## Direction (5 Lines)

- **Product.** A Windows desktop studio that downloads YouTube livestreams/clips via `yt-dlp`, renders Niconico-authentic scrolling danmaku with YouTube Super Chat and channel emotes, and hardware-encodes the output.
- **Character.** Exact, studio-grade, responsive.
- **World.** Broadcast control room & video editing timeline — deep neutral graphite surfaces, calibrated status indicators, and a single crisp accent.
- **Moments.** (1) The live 60fps Niconico comment preview canvas with real-time layout & fullscreen rehearsal mode; (2) The clip trim & hardware-encode timeline bar.
- **Signature.** Calibrated timecode & FPS tabular badges (`tabular-nums`) and subtle surface-stepped tonal containers instead of glowing borders or gradients.

## Color Tokens (Graphite / Material 3 Neutral Ramp)

### Dark Mode (Default Studio Theme)
- `md-sys-color-surface-dim`: `#0f0f10` (Navigation Rail / Deepest chrome)
- `md-sys-color-background`: `#141415` (App canvas)
- `md-sys-color-surface-container-low`: `#19191b` (Primary cards / Inspector panels)
- `md-sys-color-surface-container`: `#1f1f22` (Nested groups / Preview backdrop)
- `md-sys-color-surface-container-high`: `#27272b` (Inputs / Active rows / Hover steps)
- `md-sys-color-outline-variant`: `rgba(237, 237, 237, 0.08)` (Quiet hairlines)
- `md-sys-color-outline`: `rgba(237, 237, 237, 0.16)` (Focused / interactive borders)
- `md-sys-color-on-surface`: `#ededed` (Primary text)
- `md-sys-color-on-surface-variant`: `#a1a1a6` (Secondary text)
- `md-sys-color-on-surface-muted`: `#85858b` (Meta / captions / icons)
- `md-sys-color-primary` (Single Accent — Broadcast Crimson/Coral tuned for >= 4.5:1): `#e85d56` (dark text `#141415` on filled primary, or `#d94841` with white text `#fafafa`)
- `md-sys-color-primary-container`: `rgba(232, 93, 86, 0.14)` (Tonal selection pill)
- `md-sys-color-on-primary-container`: `#ffb4ad`
- Semantic: Positive `#4cc38a`, Warning `#e5a93c`, Error `#e5484d`

### Light Mode (Optional Toggle)
- `md-sys-color-surface-dim`: `#f2f2f4`
- `md-sys-color-background`: `#fafafa`
- `md-sys-color-surface-container-low`: `#ffffff`
- `md-sys-color-surface-container`: `#f4f4f6`
- `md-sys-color-surface-container-high`: `#eaecef`
- `md-sys-color-outline-variant`: `rgba(23, 23, 23, 0.08)`
- `md-sys-color-on-surface`: `#171717`
- `md-sys-color-on-surface-variant`: `#525252`
- `md-sys-color-on-surface-muted`: `#737373`
- `md-sys-color-primary`: `#c93832` (with `#ffffff` text)

## Spacing & Shape Rules

- Strict **4px grid** (`4, 8, 12, 16, 20, 24, 32`).
- **Navigation Rail**: `76px` compact rail or `240px` expanded sidebar; rows `36px` tall, `4px` gap.
- **Nested Radius**: `inner = outer - padding` (minimum `4px`).
  - Window / Large panels: `16px`
  - Cards: `12px`
  - Inputs / List rows / Standard buttons: `8px`
  - M3 Action FAB / Primary Pill CTA: `20px` (40px tall) or `10px`
  - Keycaps / Timecode chips: `6px`

## Typography & Icons

- UI Font: `'Inter', 'Noto Sans JP', 'Yu Gothic UI', sans-serif`
- Monospace (Timecodes, FPS, Bitrate, Counters): `'JetBrains Mono', 'Consolas', monospace` with `font-variant-numeric: tabular-nums`.
- Weights: `400` (regular) and `500` (medium), `600` only for rare emphasis. Never `700+`.
- Sentence case everywhere. Never uppercase-tracked section headers.
- Icons: `lucide-react` exclusively, `16px` or `18px`, `strokeWidth={1.5}`, colored via text role (`on-surface-variant` / `on-surface-muted`). Never use emojis as UI icons.

## Motion

- Single easing curve: `cubic-bezier(0.22, 1, 0.36, 1)`.
- Transitions only on `color`, `background-color`, `border-color`, `opacity`, `transform`. Never `transition-all`.
- Press scale `0.98`, hover is a clean surface-container step. No looping pulse/glow animations.
