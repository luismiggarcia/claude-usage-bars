import type { Register, SessionContextUsage, SessionRateLimit } from 'claude-code'

type Window = { percent: number; resetsAt?: string }

type Usage = {
  context: { percent?: number; tokens?: number; window: number }
  fiveHour: Window | null
  week: Window | null
}

type Key = 'ctx' | 'cch' | 'ses' | 'wk'

// The account's windows as last read by any session with this mod, shared
// through a file so an idle session shows what an active one saw.
type Shared = { readAt: number; fiveHour: Window | null; week: Window | null }
const SHARED_FILE = '.claude/usage-bars/latest.json'

// One meter as drawn: the bar, the value beside it, and the two texts that
// replace the bar: the alternative text (short) and its verbose form.
type Meter = {
  key: Key
  label: string
  // Drives the colour scale: share of the limit already used (for the cache,
  // share of its lifetime already gone, so its scale reads the other way round).
  level: number | undefined
  fill: number
  value: string
  alt: [string, string]
  verbose: [string, string]
}

const pickWindow = (limits: readonly SessionRateLimit[], kind: string): Window | null => {
  const found = limits.find(l => l.kind === kind)
  return found ? { percent: found.percentUsed, resetsAt: found.resetsAt } : null
}

const toUsage = (context: SessionContextUsage, limits: readonly SessionRateLimit[]): Usage => ({
  context: { percent: context.percent, tokens: context.tokens, window: context.window },
  fiveHour: pickWindow(limits, 'five_hour'),
  week: pickWindow(limits, 'seven_day'),
})

// One colour per meter, fixed on the bar. The value follows the scale near the
// limit: 75% yellow, 85% orange bold, 95% red bold; in the red band the meter
// shows its alternative text by itself.
const HUES: Record<Key, string> = { ctx: '#4f8ff7', cch: '#e07bb5', ses: '#9b7bf0', wk: '#2cb5a0' }
const SCALE = [
  { from: 95, color: '#e5534b', isBold: true },
  { from: 85, color: '#f0883e', isBold: true },
  { from: 75, color: '#d4a72c', isBold: false },
] as const
const RED_BAND = 95
const TRACK = 'rgba(140,140,140,0.16)'
const levelFor = (level: number) => SCALE.find(l => level >= l.from)

// The prompt cache lives 1 hour after the last response (5 minutes once the
// account is in overage: the mod cannot tell, so this is an estimate).
const CACHE_TTL_MS = 60 * 60_000
// The next prompt rereads the whole context: from a live cache at 0.1x a plain
// input token, or, once the 1-hour cache has expired, writing it again at 2x.
// (in hundredths, to keep the arithmetic exact)
const CACHE_READ_HUNDREDTHS = 10
const CACHE_WRITE_1H_HUNDREDTHS = 200

// Desktop: one cell of the band is about 9.5 px (measured: 95 columns).
const PX_PER_COLUMN = 9.5
const BAR_HEIGHT = 8
const FRAME_HEIGHT = 20
const BAR_INSET = 3
// Average advance of the 9 px face, to cut a text that would not fit.
const PX_PER_CHAR = 5.2

const clamp = (percent: number) => Math.min(Math.max(percent, 0), 100)

const esc = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

const kTokens = (n: number) => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : `${Math.round(n / 1000)}k`)

const duration = (ms: number) => {
  const minutes = Math.max(0, Math.round(ms / 60_000))
  const d = Math.floor(minutes / 1440)
  const h = Math.floor((minutes % 1440) / 60)
  const m = minutes % 60
  return d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : `${m}m`
}

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const clockTime = (ms: number) => {
  const at = new Date(ms)
  return `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`
}
const dayTime = (ms: number) => `${DAYS[new Date(ms).getDay()]} ${clockTime(ms)}`

// What a meter shows in place of its bar: the pill, its alternative text, or
// the verbose form of that text.
type Face = 'pill' | 'alt' | 'verbose' | 'name'

// The label's tooltip: its name in full, drawn in the graph's place while the
// pointer is on the label.
const NAMES: Record<Key, [string, string]> = {
  ctx: ['Context', 'context window'],
  cch: ['Cache', 'prompt cache'],
  ses: ['Session', '5-hour window'],
  wk: ['Week', 'weekly limit'],
}

// The graph is a plain SVG image of one face: the pointer is read by the
// invisible Client laid over it (hit.tsx), not by CSS, so a face can stay put.
const meterSvg = (width: number, m: Meter, face: Face) => {
  const color = HUES[m.key]
  const barWidth = width - 2 * BAR_INSET
  const r = BAR_HEIGHT / 2
  const top = (FRAME_HEIGHT - BAR_HEIGHT) / 2
  const fill = m.fill <= 0 ? 0 : Math.max(BAR_HEIGHT, (clamp(m.fill) / 100) * barWidth)
  const room = Math.max(4, Math.floor((width - BAR_INSET) / PX_PER_CHAR))
  const fit = (t: string) => (t.length > room ? `${t.slice(0, room - 1)}…` : t)
  const lines = ([a, b]: [string, string]) =>
    `<text x="${width / 2}" y="8" fill="${color}">${esc(fit(a))}</text>` +
    `<text x="${width / 2}" y="18" fill="${color}" class="s">${esc(fit(b))}</text>`
  const body =
    face === 'pill'
      ? `<rect x="${BAR_INSET}" y="${top}" width="${barWidth}" height="${BAR_HEIGHT}" rx="${r}" fill="${TRACK}"/>` +
        (fill ? `<rect x="${BAR_INSET}" y="${top}" width="${fill.toFixed(1)}" height="${BAR_HEIGHT}" rx="${r}" fill="${color}"/>` : '')
      : lines(face === 'alt' ? m.alt : face === 'name' ? NAMES[m.key] : m.verbose)
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${FRAME_HEIGHT}" viewBox="0 0 ${width} ${FRAME_HEIGHT}" data-face="${face}">` +
    `<style>text{font:600 9px -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;text-anchor:middle}.s{font-weight:400;opacity:.8}</style>` +
    body +
    `</svg>`
  )
}

// The shared file, read and written straight from the disk so each session sees
// what the others wrote. A missing or broken file reads as nothing.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function readShared($: any, path: string | null): Promise<Shared | null> {
  if (path === null) return null
  try {
    const shared = JSON.parse(String(await $.fs.read(path))) as Shared
    return typeof shared.readAt === 'number' ? shared : null
  } catch {
    return null
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function writeShared($: any, path: string | null, shared: Shared | null): Promise<void> {
  if (path === null || shared === null) return
  await $.fs.write(path, JSON.stringify(shared)).catch(() => undefined)
}

export const register: Register = on => {
  let current: Usage | null = null
  // When the session and week figures in `current` were read, by whichever session.
  let readAt: number | null = null
  let sharedPath: string | null = null
  let lastResponseAt: number | null = null
  // Meters the person pinned to their alternative text with a click, and the
  // one under the pointer.
  const pinned = new Set<Key>()
  let hovered: Key | null = null
  let hoveredLabel: Key | null = null
  const isKey = (k: unknown): k is Key => k === 'ctx' || k === 'cch' || k === 'ses' || k === 'wk'
  const toggle = (k: Key) => {
    if (pinned.has(k)) pinned.delete(k)
    else pinned.add(k)
  }

  // Stamps this session's fresh reading of the windows, as the others read it.
  const stamp = (at: number): Shared | null => {
    if (current === null) return null
    readAt = at
    return { readAt: at, fiveHour: current.fiveHour, week: current.week }
  }

  // Takes the shared reading when it is fresher than the one shown.
  const adopt = (shared: Shared | null) => {
    if (shared === null || current === null || (readAt !== null && shared.readAt <= readAt)) return
    current = { ...current, fiveHour: shared.fiveHour, week: shared.week }
    readAt = shared.readAt
  }

  // The invisible regions over the graphs report the pointer here.
  on('ui.message', async ($, e, next) => {
    const data = e.data as { meter?: unknown; part?: unknown; type?: unknown } | null
    if (e.module.endsWith('hit.tsx') && data && isKey(data.meter)) {
      const isLabel = data.part === 'label'
      if (data.type === 'enter') {
        if (isLabel) hoveredLabel = data.meter
        else hovered = data.meter
      } else if (data.type === 'leave') {
        if (isLabel) hoveredLabel = hoveredLabel === data.meter ? null : hoveredLabel
        else hovered = hovered === data.meter ? null : hovered
      } else if (data.type === 'click') toggle(data.meter)
      $.ui.invalidate('ui.render')
      return {}
    }
    return next(e)
  })

  on('session.start', async ($, e, next) => {
    const home = await $.env.get('HOME')
    sharedPath = home ? `${home}/${SHARED_FILE}` : null
    const { context, rateLimits } = await $.session.usage()
    current = toUsage(context, rateLimits)
    adopt(await readShared($, sharedPath))
    // Every 30 s: take a fresher reading another session shared, and redraw
    // (the cache countdown and the reset times move on their own).
    void $.clock.every(30_000, async () => {
      adopt(await readShared($, sharedPath))
      $.ui.invalidate('ui.render')
    })
    $.ui.invalidate('ui.render')
    return next(e)
  })

  on('session.measure', async ($, e, next) => {
    current = toUsage(e.context, e.rateLimits)
    if (e.rateLimits.length > 0) await writeShared($, sharedPath, stamp(await $.clock.now()))
    $.ui.invalidate('ui.render')
    return next(e)
  })

  // The main conversation's last response renews the cache, and brought the
  // account's windows as they are now: share them.
  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (!e.agentId) {
      lastResponseAt = await $.clock.now()
      const { context, rateLimits } = await $.session.usage()
      if (rateLimits.length > 0) {
        current = toUsage(context, rateLimits)
        await writeShared($, sharedPath, stamp(lastResponseAt))
      }
      $.ui.invalidate('ui.render')
    }
    return result
  })

  const meters = (usage: Usage, now: number): Meter[] => {
    const ctx = usage.context
    const pct = (p: number | undefined) => (p === undefined ? '—' : `${Math.round(p)}%`)

    const ctxUsed = ctx.tokens !== undefined ? kTokens(ctx.tokens) : '—'
    const ctxMeter: Meter = {
      key: 'ctx',
      label: 'Ctx',
      level: ctx.percent,
      fill: ctx.percent ?? 0,
      value: pct(ctx.percent),
      alt: [ctxUsed, kTokens(ctx.window)],
      verbose: [`Used: ${ctxUsed} tokens`, `Window: ${kTokens(ctx.window)}`],
    }

    const elapsed = lastResponseAt === null ? undefined : Math.max(0, now - lastResponseAt)
    const left = elapsed === undefined ? undefined : CACHE_TTL_MS - elapsed
    // What the next prompt costs for the context, in plain input-token
    // equivalents: with the cache alive, and once it has expired.
    const warm = ctx.tokens !== undefined ? (ctx.tokens * CACHE_READ_HUNDREDTHS) / 100 : undefined
    const cold = ctx.tokens !== undefined ? (ctx.tokens * CACHE_WRITE_1H_HUNDREDTHS) / 100 : undefined
    const cost = warm === undefined || cold === undefined ? '—' : `${kTokens(warm)} → ${kTokens(cold)}`
    const costVerbose =
      warm === undefined || cold === undefined ? 'Next prompt: n/a' : `${kTokens(warm)} now, ${kTokens(cold)} expired`
    const cchMeter: Meter =
      left === undefined || elapsed === undefined
        ? { key: 'cch', label: 'Cch', level: undefined, fill: 0, value: '—', alt: ['—', cost], verbose: ['No response yet', costVerbose] }
        : left <= 0
          ? {
              key: 'cch',
              label: 'Cch',
              level: 100,
              fill: 0,
              value: 'exp',
              alt: ['expired', cold === undefined ? '—' : `→ ${kTokens(cold)}`],
              verbose: [`Expired ${duration(-left)} ago`, cold === undefined ? 'Next prompt: n/a' : `Next prompt: ${kTokens(cold)}`],
            }
          : {
              key: 'cch',
              label: 'Cch',
              level: (elapsed / CACHE_TTL_MS) * 100,
              fill: (left / CACHE_TTL_MS) * 100,
              value: `${Math.ceil(left / 60_000)}m`,
              alt: [`${Math.ceil(left / 60_000)} min`, cost],
              verbose: [`Expires in ${duration(left)}`, costVerbose],
            }

    const age = readAt === null ? '' : now - readAt < 60_000 ? 'now' : `${duration(now - readAt)} ago`
    const resetMeter = (key: Key, label: string, w: Window | null, isWeek: boolean): Meter => {
      const resetAt = w?.resetsAt ? Date.parse(w.resetsAt) : NaN
      const when = (ms: number) => (isWeek ? dayTime(ms) : clockTime(ms))
      // Past its reset time the window is back to zero, whatever was last read.
      if (Number.isFinite(resetAt) && resetAt <= now) {
        return {
          key,
          label,
          level: undefined,
          fill: 0,
          value: '0%',
          alt: ['reset', when(resetAt)],
          verbose: [`Reset ${isWeek ? 'on' : 'at'} ${when(resetAt)}`, 'awaiting a new reading'],
        }
      }
      const hasReset = Number.isFinite(resetAt)
      const at = hasReset ? when(resetAt) : ''
      return {
        key,
        label,
        level: w?.percent,
        fill: w?.percent ?? 0,
        value: pct(w?.percent),
        alt: hasReset ? [`-${duration(resetAt - now)}`, at] : ['—', '—'],
        verbose: hasReset
          ? [`Resets in ${duration(resetAt - now)}`, `${isWeek ? 'on' : 'at'} ${at}${age ? ` · ${age}` : ''}`]
          : ['No reading yet', ''],
      }
    }

    return [
      ctxMeter,
      cchMeter,
      resetMeter('ses', 'Ses', usage.fiveHour, false),
      resetMeter('wk', 'Wk', usage.week, true),
    ]
  }

  // The elements come from each surface's table. Four columns of equal width:
  // label, graph and value. Hovering the graph shows the next face; a click on
  // the graph or on the label pins the alternative text, a second one unpins
  // it; in the red band the alternative text shows by itself.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const usageLine = (Box: any, Text: any, Button: any, Svg: any, Client: any, list: Meter[], bodyColumns: number, onLabel: (k: Key) => void) => {
    const isTerminal = Svg === undefined
    // Per column: label (3) and value (4) hug the graph, which takes the rest;
    // 2 cells between columns, one more kept spare.
    const gap = 2
    const columnCells = (bodyColumns - gap * (list.length - 1)) / list.length
    const barPx = Math.round(Math.max(6, columnCells - 3 - 4 - 1) * PX_PER_COLUMN)

    return (
      <Box flexDirection="row" width="100%" columnGap={gap}>
        {list.map(m => {
          const level = m.level === undefined ? undefined : levelFor(m.level)
          const valueColor = m.level === undefined ? 'inactive' : (level?.color ?? HUES[m.key])
          const isPinned = pinned.has(m.key) || (m.level !== undefined && m.level >= RED_BAND)
          const rest: Face = isPinned ? 'alt' : 'pill'
          const face: Face =
            hoveredLabel === m.key ? 'name' : hovered === m.key ? (rest === 'alt' ? 'verbose' : 'alt') : rest
          const text = face === 'alt' ? m.alt : face === 'name' ? NAMES[m.key] : m.verbose
          const graph = isTerminal ? (
            face === 'pill' ? (
              <Box width="100%" height={1} backgroundColor="subtle" overflow="hidden">
                <Box width={`${Math.round(clamp(m.fill))}%`} height={1} backgroundColor={HUES[m.key]} />
              </Box>
            ) : (
              <Text color={HUES[m.key]} wrap="truncate-end">{` ${text[0]} · ${text[1]}`}</Text>
            )
          ) : (
            <Svg source={meterSvg(barPx, m, face)} alt={`${m.verbose[0]}. ${m.verbose[1]}`} width={barPx} height={FRAME_HEIGHT} />
          )
          const bar = (
            <Box {...(isTerminal ? { flexGrow: 1, width: 0 } : { flexShrink: 0 })} height={1} position="relative" alignItems="center" overflow="hidden">
              {graph}
              {Client ? (
                <Box position="absolute" top={0} left={0} right={0} bottom={0}>
                  <Client key={`hit-${m.key}`} module="./hit.tsx" props={{ meter: m.key }} width="100%" height={1} />
                </Box>
              ) : null}
            </Box>
          )
          return (
            <Box key={`usage-${m.key}`} flexGrow={1} width={0} flexDirection="row" alignItems="center">
              {Client ? (
                <Box position="relative" flexShrink={0}>
                  <Text dimColor>{m.label}</Text>
                  <Box position="absolute" top={0} left={0} right={0} bottom={0}>
                    <Client key={`hit-label-${m.key}`} module="./hit.tsx" props={{ meter: m.key, part: 'label' }} width="100%" height={1} />
                  </Box>
                </Box>
              ) : (
                <Button key={`label-${m.key}`} label={m.label} plain dimColor onPress={() => onLabel(m.key)} />
              )}
              {bar}
              <Box flexShrink={0} marginLeft={isTerminal ? 1 : 0}>
                <Text color={valueColor} bold={level?.isBold === true}>{m.value}</Text>
              </Box>
            </Box>
          )
        })}
      </Box>
    )
  }

  // One line in the band right above the prompt box (terminal and desktop).
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (current === null || e.props.hasSurvey) return next(e)

    const now = await $.clock.now()
    const list = meters(current, now)
    const onLabel = (k: Key) => {
      toggle(k)
      $.ui.invalidate('ui.render')
    }
    if (e.surface === 'terminal') {
      const { Box, Text, Button, Client } = $.ui.resolve(e)
      return usageLine(Box, Text, Button, undefined, Client, list, e.props.bodyColumns, onLabel)
    }
    const { Box, Text, Button, Svg } = $.ui.resolve(e)
    const Client = e.surface === 'desktop' ? $.ui.resolve(e).Client : undefined
    return usageLine(Box, Text, Button, Svg, Client, list, e.props.bodyColumns, onLabel)
  })
}
