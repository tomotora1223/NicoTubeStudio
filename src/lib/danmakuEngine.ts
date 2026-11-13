import {
  DEFAULT_SUPERCHAT_TIER_COLORS,
  type CommentStyleConfig,
  type SuperChatTierKey,
} from '../types/studio'

function hexToRgba(hex: string, alpha: number): string {
  const clean = (hex || '#000000').replace('#', '')
  if (clean.length !== 6) return `rgba(0,0,0,${alpha})`
  const r = parseInt(clean.slice(0, 2), 16)
  const g = parseInt(clean.slice(2, 4), 16)
  const b = parseInt(clean.slice(4, 6), 16)
  return `rgba(${r},${g},${b},${Math.max(0, Math.min(1, alpha))})`
}

function contrastTextForHex(hex: string): string {
  const clean = (hex || '#1E88E5').replace('#', '')
  if (clean.length !== 6) return '#FFFFFF'
  const r = parseInt(clean.slice(0, 2), 16)
  const g = parseInt(clean.slice(2, 4), 16)
  const b = parseInt(clean.slice(4, 6), 16)
  const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255
  return lum > 0.62 ? '#111111' : '#FFFFFF'
}

export type PreviewScenario = 'standard' | 'barrage' | 'longtext'

export interface SimRun {
  kind: 'text' | 'emote'
  text: string
  emoteKey?: string
}

export interface SimComment {
  id: string
  offsetSec: number
  kind: 'normal' | 'member' | 'moderator' | 'owner' | 'superchat' | 'sticker' | 'membership' | 'gift'
  runs: SimRun[]
  plainText: string
  amountText?: string
  scTier?: SuperChatTierKey
  bgColor?: string
  fgColor?: string
}

export interface ScheduledSimComment {
  item: SimComment
  tStart: number
  tEnd: number
  mode: 'naka' | 'ue' | 'shita'
  y: number
  width: number
  height: number
  velocity: number
  isCard: boolean
  textColor: string
  fontPx: number
}

// Built-in vector channel emotes (self-contained offline Data URLs)
function makeEmoteSvgDataUrl(bg: string, label: string, fg = '#141415'): string {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="48" height="48" viewBox="0 0 48 48">
    <rect x="2" y="2" width="44" height="44" rx="12" fill="${bg}" />
    <text x="24" y="30" text-anchor="middle" font-family="Yu Gothic UI, sans-serif" font-weight="700" font-size="18" fill="${fg}">${label}</text>
  </svg>`
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`
}

const SAMPLE_EMOTE_URLS: Record<string, string> = {
  gg: makeEmoteSvgDataUrl('#4CC38A', 'GG'),
  kusa: makeEmoteSvgDataUrl('#6BA5FF', '草'),
  love: makeEmoteSvgDataUrl('#E85D56', '♥', '#FAFAFA'),
  star: makeEmoteSvgDataUrl('#FFD447', '★'),
}

const emoteImageCache = new Map<string, HTMLImageElement>()

export function getSampleEmoteImage(key: string): HTMLImageElement | null {
  const url = SAMPLE_EMOTE_URLS[key]
  if (!url) return null
  const existing = emoteImageCache.get(key)
  if (existing) return existing.complete ? existing : null
  const img = new Image()
  img.src = url
  emoteImageCache.set(key, img)
  return img.complete ? img : null
}

function parseRuns(text: string): { runs: SimRun[]; plain: string } {
  // Support tokens like :gg: :kusa: :love: :star:
  const parts = text.split(/(:(?:gg|kusa|love|star):)/g)
  const runs: SimRun[] = []
  let plain = ''
  for (const p of parts) {
    if (!p) continue
    const m = /^:(gg|kusa|love|star):$/.exec(p)
    if (m) {
      runs.push({ kind: 'emote', text: p, emoteKey: m[1] })
      plain += p
    } else {
      runs.push({ kind: 'text', text: p })
      plain += p
    }
  }
  return { runs, plain }
}

export function buildPreviewScenario(scenario: PreviewScenario, loopSec = 36): SimComment[] {
  const list: SimComment[] = []
  let seq = 0

  const add = (
    offsetSec: number,
    kind: SimComment['kind'],
    text: string,
    extra?: { amountText?: string; scTier?: SuperChatTierKey; bgColor?: string; fgColor?: string }
  ) => {
    const { runs, plain } = parseRuns(text)
    list.push({
      id: `sim-${seq++}`,
      offsetSec,
      kind,
      runs,
      plainText: plain,
      ...extra,
    })
  }

  if (scenario === 'standard') {
    const templates: Array<[number, SimComment['kind'], string, { amountText?: string; scTier?: SuperChatTierKey; bgColor?: string; fgColor?: string }?]> = [
      [0.2, 'owner', '【配信者】アーカイブ勢もようこそ。ここから後半戦スタートです'],
      [0.5, 'normal', 'きたあああああ！'],
      [0.9, 'member', '待機してました :love: :gg:'],
      [1.3, 'normal', '画質めっちゃ綺麗'],
      [1.7, 'normal', '草 :kusa:'],
      [2.1, 'superchat', '応援してます！今日の企画めちゃくちゃ面白いです🔥', { amountText: '¥1,000', scTier: 'green', bgColor: '#00BFA5', fgColor: '#111111' }],
      [2.6, 'normal', 'そこ気をつけてｗ'],
      [3.0, 'member', 'メンバー3年目突入！これからも推します :star:'],
      [3.5, 'moderator', '初見さんも概要欄のルール一読お願いします'],
      [3.9, 'normal', 'うおおおおおおお！！！！！'],
      [4.2, 'normal', 'えっ今の判定通るの！？マジかｗｗｗ'],
      [4.7, 'membership', '新規メンバーシップへようこそ：Tomorin さん'],
      [5.0, 'sticker', 'ステッカー送信 :star:', { amountText: '¥500', scTier: 'lightblue', bgColor: '#00B8D4', fgColor: '#111111' }],
      [5.3, 'normal', '8888888888888'],
      [5.7, 'superchat', '神プレイすぎて声出た、ナイスGG :gg: :star:', { amountText: '¥5,000', scTier: 'orange', bgColor: '#E65100', fgColor: '#FFFFFF' }],
      [6.4, 'normal', '助かる'],
      [6.8, 'member', 'ここすき :love:'],
      [7.2, 'normal', '今のタイミング完璧すぎるだろ…何回見ても気持ちいい'],
      [7.8, 'normal', 'wwwwww'],
      [8.3, 'gift', 'Kuro さんがメンバーシップギフトを 5 個贈りました'],
      [8.9, 'superchat', '達成おめでとうございます！！最高の配信をありがとう🎉👏', { amountText: '¥10,000', scTier: 'magenta', bgColor: '#C2185B', fgColor: '#FFFFFF' }],
      [9.6, 'normal', 'これは保存版'],
      [10.2, 'member', '夜中に声出して笑った :kusa: :kusa:'],
      [10.8, 'normal', 'おつかれさま〜'],
      [11.3, 'superchat', 'ちょっとだけお茶代', { amountText: '¥200', scTier: 'blue', bgColor: '#1E88E5', fgColor: '#FFFFFF' }],
    ]
    // Repeat cleanly across loopSec so scrolling never stops
    for (let rep = 0; rep < 3; rep++) {
      const base = rep * 12.0
      if (base >= loopSec) break
      for (const [t, k, txt, ex] of templates) {
        if (base + t < loopSec) add(base + t, k, txt, ex)
      }
    }
  } else if (scenario === 'barrage') {
    const rushTexts = [
      '888888888888888',
      'うおおおおおおお🔥',
      'きたああああああああ！！',
      '草 :kusa: :kusa:',
      '神回確定',
      'ナイスすぎ :gg:',
      'まじかｗｗｗｗｗ',
      'すごすぎる',
      '鳥肌立った…',
      '最高 :love: :star:',
    ]
    for (let t = 0.1; t < loopSec; t += 0.14) {
      const idx = Math.floor(t * 13) % rushTexts.length
      const isMem = idx % 3 === 0
      add(t, isMem ? 'member' : 'normal', rushTexts[idx])
      if (Math.abs((t % 4.0) - 1.0) < 0.14) {
        add(t, 'superchat', '伝説の瞬間！！おめでとうございます！！🎉', {
          amountText: '¥20,000',
          scTier: 'red',
          bgColor: '#D00000',
          fgColor: '#FFFFFF',
        })
      }
    }
    add(0.4, 'owner', 'みんなありがとう！！ついに達成したぞ！！')
  } else {
    // longtext & multi-tier stress test
    const cases: Array<[number, SimComment['kind'], string, { amountText?: string; scTier?: SuperChatTierKey; bgColor?: string; fgColor?: string }?]> = [
      [0.3, 'normal', '短'],
      [0.7, 'normal', 'このくらいの標準的な長さの日本語コメントの見え方をチェック中 :gg:'],
      [1.2, 'member', '【超長文テスト】配信開始からずっと追いかけていましたが、このパートの伏線回収とBGMの入り方が本当に完璧すぎて言葉になりません。スタンプも混ざります :love: :star: :kusa:'],
      [2.0, 'superchat', '青スパチャ ¥200', { amountText: '¥200', scTier: 'blue', bgColor: '#1E88E5', fgColor: '#FFFFFF' }],
      [2.5, 'sticker', 'スーパーステッカー ¥500 :gg:', { amountText: '¥500', scTier: 'lightblue', bgColor: '#00B8D4', fgColor: '#111111' }],
      [3.0, 'superchat', '緑スパチャ ¥1,000 🔥', { amountText: '¥1,000', scTier: 'green', bgColor: '#00BFA5', fgColor: '#111111' }],
      [3.5, 'superchat', '黄スパチャ ¥2,000 とても見やすいか確認', { amountText: '¥2,000', scTier: 'yellow', bgColor: '#FFB300', fgColor: '#111111' }],
      [4.0, 'superchat', '橙スパチャ ¥5,000 ナイスファイト！', { amountText: '¥5,000', scTier: 'orange', bgColor: '#E65100', fgColor: '#FFFFFF' }],
      [4.5, 'superchat', 'マゼンタ ¥10,000 演出最高 :love:', { amountText: '¥10,000', scTier: 'magenta', bgColor: '#C2185B', fgColor: '#FFFFFF' }],
      [5.0, 'superchat', '赤スパチャ ¥50,000 伝説のアーカイブ永久保存版！！🎊✨🔥', { amountText: '¥50,000', scTier: 'red', bgColor: '#D00000', fgColor: '#FFFFFF' }],
      [5.8, 'owner', '【配信者ピン留め】テスト再生中：上部固定表示と重なり具合を確認'],
      [6.4, 'normal', 'ASCII & Numbers 1234567890 ABCDEFGHIJKLMNOPQRSTUVWXYZ :star:'],
      [7.1, 'normal', '絵文字テスト 😀😂🔥👏🎉🎊💎🚀🎮🎵'],
    ]
    for (let rep = 0; rep < 3; rep++) {
      const base = rep * 10.0
      if (base >= loopSec) break
      for (const [t, k, txt, ex] of cases) {
        if (base + t < loopSec) add(base + t, k, txt, ex)
      }
    }
  }

  return list.sort((a, b) => a.offsetSec - b.offsetSec)
}

function measureSimRuns(
  ctx: CanvasRenderingContext2D,
  runs: SimRun[],
  fontPx: number,
  scale: number,
  style: CommentStyleConfig,
  amountPrefix?: string
): number {
  let w = 0
  const emoteSize = fontPx * 1.12
  if (amountPrefix) {
    ctx.font = `${style.font_weight} ${Math.round(fontPx * 0.86)}px "${style.font_family}", "Yu Gothic UI", sans-serif`
    w += ctx.measureText(amountPrefix).width + fontPx * 0.45
  }
  ctx.font = `${style.font_weight} ${Math.round(fontPx)}px "${style.font_family}", "Segoe UI Emoji", "Yu Gothic UI", sans-serif`
  for (const r of runs) {
    if (r.kind === 'emote' && style.custom_emotes_enabled && r.emoteKey) {
      w += emoteSize + 2 * scale
    } else if (r.kind === 'text') {
      let txt = r.text
      if (!style.unicode_emoji_enabled) {
        txt = txt.replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu, '')
      }
      if (txt) w += ctx.measureText(txt).width
    }
  }
  return Math.max(12, w)
}

export function scheduleSimComments(
  ctx: CanvasRenderingContext2D,
  items: SimComment[],
  stageWidth: number,
  stageHeight: number,
  style: CommentStyleConfig
): ScheduledSimComment[] {
  const scale = stageHeight / 360.0
  const baseFontPx = 24.0 * scale * style.font_scale
  const laneHeight = Math.max(12, baseFontPx * style.line_height_ratio)
  const usableH = stageHeight * style.display_area_ratio
  const marginTop = 3 * scale
  const numLanes = Math.max(1, Math.floor((usableH - marginTop) / laneHeight))
  const gap = style.lane_gap_px * scale

  const ngLower = style.ng_words.map((w) => w.trim().toLowerCase()).filter(Boolean)

  type LaneState = { tStart: number; w: number; v: number; dur: number } | null
  const nakaLanes: LaneState[] = Array(numLanes).fill(null)
  const ueLanesEnd: number[] = Array(numLanes).fill(0)
  const shitaLanesEnd: number[] = Array(numLanes).fill(0)

  const scheduled: ScheduledSimComment[] = []
  let activeEndTimes: number[] = []

  items.forEach((it, idx) => {
    if (ngLower.length > 0 && ngLower.some((w) => it.plainText.toLowerCase().includes(w))) {
      return
    }
    if (it.kind === 'moderator' && style.moderator_mode === 'hide') return

    let mode = (style.normal_pin_mode || 'naka') as 'naka' | 'ue' | 'shita'
    let isCard = false
    let fontPx = baseFontPx
    let textColor = style.default_color
    let amountPrefix: string | undefined
    let runsToUse = it.runs
    let itemBgColor = it.bgColor
    let itemFgColor = it.fgColor
    let speedMult = 1.0

    if (it.kind === 'member') {
      mode = (style.member_pin_mode || 'naka') as 'naka' | 'ue' | 'shita'
      fontPx = baseFontPx * (style.member_scale ?? 1.0)
      if (style.member_color_enabled) textColor = style.member_color
      if (style.member_badge_prefix && style.member_badge_text) {
        runsToUse = [{ kind: 'text', text: `${style.member_badge_text} ` }, ...it.runs]
      }
    } else if (it.kind === 'moderator') {
      mode = (style.moderator_pin_mode || 'naka') as 'naka' | 'ue' | 'shita'
      fontPx = baseFontPx * (style.moderator_scale ?? 1.0)
      if (style.moderator_mode === 'color' && style.moderator_color_enabled) {
        textColor = style.moderator_color
      }
      if (style.moderator_badge_prefix && style.moderator_badge_text) {
        runsToUse = [{ kind: 'text', text: `${style.moderator_badge_text} ` }, ...it.runs]
      }
    } else if (it.kind === 'owner') {
      fontPx = baseFontPx * (style.owner_scale ?? 1.05)
      if (style.owner_color_enabled) textColor = style.owner_color
      mode = (style.owner_pin_mode || (style.owner_pin_top ? 'ue' : 'naka')) as 'naka' | 'ue' | 'shita'
      if (style.owner_badge_prefix && style.owner_badge_text) {
        runsToUse = [{ kind: 'text', text: `${style.owner_badge_text} ` }, ...it.runs]
      }
    } else if (it.kind === 'superchat' || it.kind === 'sticker') {
      const effMode =
        it.kind === 'sticker' && style.supersticker_mode !== 'follow_superchat'
          ? style.supersticker_mode
          : style.superchat_mode
      if (effMode === 'hide') return
      fontPx = baseFontPx * (it.kind === 'sticker' ? (style.supersticker_scale ?? style.superchat_scale) : style.superchat_scale)
      speedMult = style.superchat_speed_multiplier ?? 1.0
      const tier = it.scTier || 'blue'
      if (style.superchat_color_source === 'custom') {
        itemBgColor = style.superchat_tier_colors?.[tier] || DEFAULT_SUPERCHAT_TIER_COLORS[tier]
      } else if (style.superchat_color_source === 'official') {
        itemBgColor = DEFAULT_SUPERCHAT_TIER_COLORS[tier] || it.bgColor || '#1E88E5'
      }
      itemFgColor = contrastTextForHex(itemBgColor || '#1E88E5')

      if (effMode === 'card_scroll' || effMode === 'card_top') {
        isCard = true
        mode = effMode === 'card_top' ? 'ue' : 'naka'
        if (style.superchat_show_amount) amountPrefix = it.amountText
      } else {
        textColor = itemBgColor || '#FFCA28'
        if (style.superchat_show_amount && it.amountText) {
          runsToUse = [{ kind: 'text', text: `[${it.amountText}] ` }, ...it.runs]
        }
      }
    } else if (it.kind === 'membership' || it.kind === 'gift') {
      if (!style.membership_events_enabled) return
      const evMode = it.kind === 'membership' ? style.membership_mode : style.gift_mode
      if (evMode === 'hide') return
      const evColor = it.kind === 'membership' ? style.membership_color : style.gift_color
      itemBgColor = evColor
      itemFgColor = contrastTextForHex(evColor)
      fontPx = baseFontPx * (it.kind === 'membership' ? (style.membership_scale ?? 0.96) : (style.gift_scale ?? 0.96))
      if (evMode === 'card_scroll' || evMode === 'card_top') {
        isCard = true
        mode = evMode === 'card_top' ? 'ue' : 'naka'
      } else {
        textColor = evColor
      }
    }

    let w = measureSimRuns(ctx, runsToUse, fontPx, scale, style, amountPrefix)
    let h = fontPx * 1.32
    if (isCard) {
      w += 18 * scale
      h += 8 * scale
    }

    let tStart = it.offsetSec
    if (style.max_concurrent > 0) {
      activeEndTimes = activeEndTimes.filter((et) => et > tStart)
      if (activeEndTimes.length >= style.max_concurrent) return
    }

    const workItem: SimComment = { ...it, runs: runsToUse, bgColor: itemBgColor, fgColor: itemFgColor }

    if (mode === 'ue' || mode === 'shita') {
      const dur = style.fixed_duration_sec
      const arr = mode === 'ue' ? ueLanesEnd : shitaLanesEnd
      let chosen = arr.findIndex((endT) => endT <= tStart)
      if (chosen === -1) {
        if (style.collision_mode === 'drop') return
        chosen = arr.reduce((best, cur, i, a) => (cur < a[best] ? i : best), 0)
      }
      arr[chosen] = tStart + dur
      const y =
        mode === 'ue'
          ? marginTop + chosen * laneHeight
          : stageHeight - marginTop - (chosen + 1) * laneHeight
      const tEnd = tStart + dur
      activeEndTimes.push(tEnd)
      scheduled.push({
        item: workItem,
        tStart,
        tEnd,
        mode,
        y,
        width: w,
        height: h,
        velocity: 0,
        isCard,
        textColor,
        fontPx,
      })
    } else {
      const dur = Math.max(1.2, style.scroll_duration_sec / Math.max(0.5, speedMult))
      const vel = (stageWidth + w) / dur

      const fits = (ls: LaneState, ts: number) => {
        if (!ls) return true
        const pExit = ls.tStart + ls.dur
        if (ts >= pExit) return true
        const pRightAtTs = stageWidth - ls.v * (ts - ls.tStart) + ls.w
        if (pRightAtTs > stageWidth - gap) return false
        const cLeftAtExit = stageWidth - vel * (pExit - ts)
        if (cLeftAtExit < gap) return false
        return true
      }

      let chosen = nakaLanes.findIndex((ls) => fits(ls, tStart))
      if (chosen === -1) {
        if (style.collision_mode === 'drop') return
        if (style.collision_mode === 'stagger') {
          let found = false
          for (let step = 1; step <= 15; step++) {
            const cand = tStart + step * 0.1
            const idxFound = nakaLanes.findIndex((ls) => fits(ls, cand))
            if (idxFound !== -1) {
              tStart = cand
              chosen = idxFound
              found = true
              break
            }
          }
          if (!found) return
        } else {
          chosen = idx % numLanes
        }
      }

      nakaLanes[chosen] = { tStart, w, v: vel, dur }
      const y = marginTop + chosen * laneHeight
      const tEnd = tStart + dur
      activeEndTimes.push(tEnd)
      scheduled.push({
        item: workItem,
        tStart,
        tEnd,
        mode: 'naka',
        y,
        width: w,
        height: h,
        velocity: vel,
        isCard,
        textColor,
        fontPx,
      })
    }
  })

  return scheduled
}

export function drawDanmakuFrame(
  ctx: CanvasRenderingContext2D,
  scheduled: ScheduledSimComment[],
  t: number,
  stageWidth: number,
  stageHeight: number,
  style: CommentStyleConfig
): number {
  const scale = stageHeight / 360.0
  const outlineW = style.outline_width * scale
  const emoteSizeRatio = 1.12
  let activeCount = 0

  ctx.save()
  ctx.textBaseline = 'alphabetic'

  for (const s of scheduled) {
    if (t < s.tStart || t > s.tEnd) continue
    activeCount++

    const xBase =
      s.mode === 'naka'
        ? stageWidth - s.velocity * (t - s.tStart)
        : (stageWidth - s.width) * 0.5
    const yTop = s.y
    const baselineY = yTop + s.fontPx * 0.92

    ctx.save()

    if (s.isCard) {
      const cardAlpha = Math.max(0.25, Math.min(1, style.card_opacity ?? 0.92))
      ctx.globalAlpha = cardAlpha
      const r = (style.card_radius_px ?? 7) * scale
      const padX = 8 * scale
      const boxW = s.width
      const boxH = s.height

      ctx.beginPath()
      ctx.roundRect(xBase, yTop, boxW, boxH, r)
      ctx.fillStyle = s.item.bgColor || '#1E88E5'
      ctx.fill()
      if ((style.card_border_opacity ?? 0.28) > 0.01) {
        ctx.lineWidth = Math.max(1, 1 * scale)
        ctx.strokeStyle = `rgba(255,255,255,${style.card_border_opacity ?? 0.28})`
        ctx.stroke()
      }

      let cx = xBase + padX
      if (style.superchat_show_amount && s.item.amountText) {
        ctx.font = `${style.font_weight} ${Math.round(s.fontPx * 0.86)}px "${style.font_family}", "Yu Gothic UI", sans-serif`
        const amtW = ctx.measureText(s.item.amountText).width
        const chipPad = 5 * scale
        ctx.beginPath()
        ctx.roundRect(cx - 2 * scale, yTop + 3 * scale, amtW + chipPad * 1.4, boxH - 6 * scale, Math.max(2, r * 0.55))
        ctx.fillStyle = 'rgba(0,0,0,0.28)'
        ctx.fill()
        ctx.fillStyle = s.item.fgColor || '#FFFFFF'
        ctx.fillText(s.item.amountText, cx + chipPad * 0.45, baselineY + 2 * scale)
        cx += amtW + s.fontPx * 0.45
      }

      ctx.font = `${style.font_weight} ${Math.round(s.fontPx)}px "${style.font_family}", "Segoe UI Emoji", "Yu Gothic UI", sans-serif`
      const textCol = s.item.fgColor || '#FFFFFF'
      const emoteSize = s.fontPx * emoteSizeRatio

      for (const run of s.item.runs) {
        if (run.kind === 'emote' && style.custom_emotes_enabled && run.emoteKey) {
          const img = getSampleEmoteImage(run.emoteKey)
          if (img) {
            ctx.drawImage(img, cx, yTop + (boxH - emoteSize) * 0.5, emoteSize, emoteSize)
          }
          cx += emoteSize + 2 * scale
        } else if (run.kind === 'text') {
          let txt = run.text
          if (!style.unicode_emoji_enabled) {
            txt = txt.replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu, '')
          }
          if (txt) {
            ctx.fillStyle = textCol
            ctx.fillText(txt, cx, baselineY + 2 * scale)
            cx += ctx.measureText(txt).width
          }
        }
      }
    } else {
      ctx.globalAlpha = style.opacity
      ctx.font = `${style.font_weight} ${Math.round(s.fontPx)}px "${style.font_family}", "Segoe UI Emoji", "Yu Gothic UI", sans-serif`
      ctx.lineJoin = 'round'
      ctx.lineCap = 'round'

      const outline2W = (style.outline2_width ?? 0) * scale
      const shadowColorRgba = hexToRgba(style.shadow_color || '#000000', style.shadow_opacity ?? 0.55)
      const outline1ColorRgba = hexToRgba(style.outline_color || '#000000', style.outline_opacity)
      const outline2ColorRgba = hexToRgba(style.outline2_color || '#FFFFFF', style.outline2_opacity ?? 0.65)
      const sdx = (style.shadow_offset_x ?? 1.5) * scale
      const sdy = (style.shadow_offset_y ?? 1.5) * scale

      let cx = xBase
      const emoteSize = s.fontPx * emoteSizeRatio

      for (const run of s.item.runs) {
        if (run.kind === 'emote' && style.custom_emotes_enabled && run.emoteKey) {
          const img = getSampleEmoteImage(run.emoteKey)
          if (img) {
            ctx.drawImage(img, cx, yTop + (s.height - emoteSize) * 0.45, emoteSize, emoteSize)
          }
          cx += emoteSize + 2 * scale
        } else if (run.kind === 'text') {
          let txt = run.text
          if (!style.unicode_emoji_enabled) {
            txt = txt.replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu, '')
          }
          if (!txt) continue

          if (style.shadow_enabled && (style.shadow_opacity ?? 0.55) > 0.01) {
            ctx.save()
            if ((style.shadow_blur ?? 0) > 0.05) {
              ctx.shadowColor = shadowColorRgba
              ctx.shadowBlur = (style.shadow_blur ?? 0) * scale
              ctx.shadowOffsetX = sdx
              ctx.shadowOffsetY = sdy
              ctx.fillStyle = shadowColorRgba
              ctx.fillText(txt, cx, baselineY)
            } else {
              ctx.fillStyle = shadowColorRgba
              ctx.fillText(txt, cx + sdx, baselineY + sdy)
            }
            ctx.restore()
          }
          if (outline2W > 0.05 && (style.outline2_opacity ?? 0.65) > 0.01) {
            ctx.lineWidth = (outlineW + outline2W) * 2
            ctx.strokeStyle = outline2ColorRgba
            ctx.strokeText(txt, cx, baselineY)
          }
          if (outlineW > 0.05 && style.outline_opacity > 0.01) {
            ctx.lineWidth = outlineW * 2
            ctx.strokeStyle = outline1ColorRgba
            ctx.strokeText(txt, cx, baselineY)
          }
          ctx.fillStyle = s.textColor
          ctx.fillText(txt, cx, baselineY)
          cx += ctx.measureText(txt).width
        }
      }
    }

    ctx.restore()
  }

  ctx.restore()
  return activeCount
}
