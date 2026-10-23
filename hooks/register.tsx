import type { Register, SessionContextUsage, SessionRateLimit, TurnUsage } from 'claude-code'

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

// When each session's main conversation last got a response, kept in the
// plugin's store so a resumed session (or a hot reload) picks up the cache
// countdown where it was. Entries past the cache lifetime are dropped.
const LAST_RESPONSE_KEY = 'lastResponseAt'
type LastResponses = Record<string, number>

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
  // A tick on the bar, as a share of it (the context's auto-compact point).
  mark?: number
  // A stretch of the bar marked out, from and to, as shares of it (the
  // context's: the time to compact or hand over).
  zone?: readonly [number, number]
  // Equal segments the bar is cut into, as a gauge for the pace of use (the
  // week's: one per day).
  segments?: number
  // Where the window is now, as a share of the bar: how much of its time has
  // gone, to read the use against.
  now?: number
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

// The prompt cache lives 1 hour after the last response, or 5 minutes (an
// account in overage, say). No response says which: the mod deduces it from
// what a response after a pause read from the cache (deduceTtl), assumes 1
// hour until it knows, and keeps what it learned in the store for every session.
const TTL_1H = 60 * 60_000
const TTL_5M = 5 * 60_000
const TTL_KEY = 'cacheTtl'
// The next prompt rereads the whole context: from a live cache at 0.1x a plain
// input token, or, once the cache has expired, writing it again at 2x (1-hour
// cache) or 1.25x (5-minute cache). (in hundredths, to keep the arithmetic exact)
const CACHE_READ_HUNDREDTHS = 10
const writeHundredths = (ttlMs: number) => (ttlMs === TTL_5M ? 125 : 200)

// What a response after a pause says of the cache's lifetime. Past 5 minutes
// and within the hour, a 5-minute cache has expired: the response writes most
// of its input again; a 1-hour cache is still there: it reads most of it.
// Only the same model counts (each model has its own cache), and a short
// pause, a small prompt or a mixed reading say nothing.
type Seen = { at: number; model: string }
const deduceTtl = (prev: Seen | null, at: number, usage: TurnUsage): number | undefined => {
  if (prev === null || prev.model !== usage.model) return undefined
  const gap = at - prev.at
  if (gap <= TTL_5M + 30_000 || gap >= TTL_1H) return undefined
  const total = usage.input_tokens + usage.cache_read_input_tokens + usage.cache_creation_input_tokens
  if (total < 4096) return undefined
  if (usage.cache_read_input_tokens >= total * 0.8) return TTL_1H
  if (usage.cache_creation_input_tokens >= total * 0.5) return TTL_5M
  return undefined
}

// Warnings, each given once: the cache about to expire while the session
// waits (per response), and the session or week window crossing 85% and 95%
// (per reset and band, kept in the store so the other sessions do not repeat it).
const WARNED_KEY = 'warned'
type Warned = Record<string, number>
const LIMIT_BANDS = [95, 85] as const
const cacheWarnBefore = (ttlMs: number) => (ttlMs === TTL_5M ? 60_000 : 5 * 60_000)

// The tick for the auto-compact point.
const MARK = 'rgba(140,140,140,0.9)'
// The context's zone, from half the window to three quarters: the time to deal
// with its size (compact, hand over) before the model works on a crowded one.
// A faint stretch of the track, ticked at both ends, in the scale's yellow.
const CTX_ZONE = [50, 75] as const
const ZONE_FILL = 'rgba(212,167,44,0.22)'
const ZONE_TICK = 'rgba(212,167,44,0.85)'
// The faint dividers between a bar's segments, over the fill as on the track.
const DIVIDER = 'rgba(140,140,140,0.45)'
// The share of the bar at each divider: 7 segments, 6 dividers.
// The tick for where the window is now: taller than the dividers, solid.
const NOW_TICK = 'rgba(110,110,110,0.95)'
const WEEK = 7 * 24 * 60 * 60_000
const dividers = (segments: number | undefined) =>
  segments === undefined ? [] : Array.from({ length: segments - 1 }, (_, i) => ((i + 1) / segments) * 100)

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
  const xAt = (percent: number) => BAR_INSET + (clamp(percent) / 100) * barWidth
  const fill = m.fill <= 0 ? 0 : Math.max(BAR_HEIGHT, (clamp(m.fill) / 100) * barWidth)
  const room = Math.max(4, Math.floor((width - BAR_INSET) / PX_PER_CHAR))
  const fit = (t: string) => (t.length > room ? `${t.slice(0, room - 1)}…` : t)
  const lines = ([a, b]: [string, string]) =>
    `<text x="${width / 2}" y="8" fill="${color}">${esc(fit(a))}</text>` +
    `<text x="${width / 2}" y="18" fill="${color}" class="s">${esc(fit(b))}</text>`
  const body =
    face === 'pill'
      ? `<rect x="${BAR_INSET}" y="${top}" width="${barWidth}" height="${BAR_HEIGHT}" rx="${r}" fill="${TRACK}"/>` +
        (m.zone === undefined
          ? ''
          : `<rect x="${xAt(m.zone[0]).toFixed(1)}" y="${top}" width="${(xAt(m.zone[1]) - xAt(m.zone[0])).toFixed(1)}" height="${BAR_HEIGHT}" fill="${ZONE_FILL}" data-zone="band"/>`) +
        (fill ? `<rect x="${BAR_INSET}" y="${top}" width="${fill.toFixed(1)}" height="${BAR_HEIGHT}" rx="${r}" fill="${color}"/>` : '') +
        (m.zone === undefined
          ? ''
          : m.zone
              .map(at => `<rect x="${(xAt(at) - 0.5).toFixed(1)}" y="${top - 2}" width="1" height="${BAR_HEIGHT + 4}" fill="${ZONE_TICK}" data-zone="${at}"/>`)
              .join('')) +
        dividers(m.segments)
          .map(at => `<rect x="${(xAt(at) - 0.5).toFixed(1)}" y="${top}" width="1" height="${BAR_HEIGHT}" fill="${DIVIDER}" data-divider="${at.toFixed(1)}"/>`)
          .join('') +
        (m.now === undefined
          ? ''
          : `<rect x="${(xAt(m.now) - 0.75).toFixed(1)}" y="${top - 3}" width="1.5" height="${BAR_HEIGHT + 6}" rx="0.75" fill="${NOW_TICK}" data-now="${m.now.toFixed(1)}"/>`) +
        (m.mark === undefined
          ? ''
          : `<rect x="${(BAR_INSET + (clamp(m.mark) / 100) * barWidth - 0.75).toFixed(1)}" y="${top - 3}" width="1.5" height="${BAR_HEIGHT + 6}" rx="0.75" fill="${MARK}" data-mark="compact"/>`)
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

// Written whole to a file of this session's own, then moved over the shared one,
// so a reader never meets it half written. Where the move cannot run (no `mv`,
// no process on this host) it is written in place. A reading older than the
// one already shared is not written: two sessions answering at once never
// put the older one back.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function writeShared($: any, path: string | null, tmp: string | null, shared: Shared | null): Promise<void> {
  if (path === null || shared === null) return
  const there = await readShared($, path)
  if (there !== null && there.readAt > shared.readAt) return
  const text = JSON.stringify(shared)
  if (tmp !== null) {
    const isMoved = await $.fs
      .write(tmp, text)
      .then(() => $.process.run(['mv', '-f', tmp, path]))
      .then((r: { exitCode: number }) => r.exitCode === 0)
      .catch(() => false)
    if (isMoved) return
  }
  await $.fs.write(path, text).catch(() => undefined)
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function readLastResponses($: any): Promise<LastResponses> {
  const value = await $.store.get(LAST_RESPONSE_KEY).catch(() => undefined)
  return value !== null && typeof value === 'object' ? (value as LastResponses) : {}
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function saveLastResponse($: any, sessionId: string | null, at: number): Promise<void> {
  if (sessionId === null) return
  const kept: LastResponses = { [sessionId]: at }
  for (const [id, t] of Object.entries(await readLastResponses($))) {
    if (id !== sessionId && typeof t === 'number' && at - t < TTL_1H) kept[id] = t
  }
  await $.store.set(LAST_RESPONSE_KEY, kept).catch(() => undefined)
}

// The lifetime a session deduced, kept in the store for all of them.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function readTtl($: any): Promise<number | undefined> {
  const saved = await $.store.get(TTL_KEY).catch(() => undefined)
  return saved === TTL_5M || saved === TTL_1H ? saved : undefined
}

// The token count at which the context is compacted; undefined when off.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function readCompactAt($: any): Promise<number | undefined> {
  const usage = await $.session.usage({ breakdown: 'summary' }).catch(() => null)
  const breakdown = usage?.context?.breakdown
  return breakdown?.isAutoCompactEnabled ? breakdown.autoCompactThreshold : undefined
}

// A toast; an urgent one also as a notification, for a person away from the window.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function warn($: any, text: string, isUrgent: boolean, title: string): void {
  try {
    $.ui.toast(text, { timeoutMs: 15_000 })
  } catch {
    // nowhere to show it
  }
  if (!isUrgent) return
  try {
    void Promise.resolve($.ui.notify(text, { title })).catch(() => undefined)
  } catch {
    // no notification channel here
  }
}

// The session or week window past 85% or 95%: once per reset and band, for
// every session (the store remembers it was given).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function warnLimits($: any, usage: Usage | null, now: number): Promise<void> {
  if (usage === null) return
  const windows = [
    ['ses', 'Session', usage.fiveHour, false],
    ['wk', 'Week', usage.week, true],
  ] as const
  const due = windows.flatMap(([key, name, w, isWeek]) => {
    const resetAt = w?.resetsAt ? Date.parse(w.resetsAt) : NaN
    const band = w ? LIMIT_BANDS.find(b => w.percent >= b) : undefined
    if (!w || band === undefined || !Number.isFinite(resetAt) || resetAt <= now) return []
    const when = isWeek ? dayTime(resetAt) : `at ${clockTime(resetAt)}`
    return [{ id: `${key}:${resetAt}:${band}`, resetAt, band, text: `${name} at ${Math.round(w.percent)}% · resets ${when}` }]
  })
  if (due.length === 0) return
  const saved = await $.store.get(WARNED_KEY).catch(() => undefined)
  const warned: Warned = {}
  for (const [id, at] of Object.entries((saved ?? {}) as Warned)) if (typeof at === 'number' && at > now) warned[id] = at
  const fresh = due.filter(d => warned[d.id] === undefined)
  if (fresh.length === 0) return
  for (const d of fresh) {
    warned[d.id] = d.resetAt
    warn($, d.text, d.band >= RED_BAND, 'Usage limit')
  }
  await $.store.set(WARNED_KEY, warned).catch(() => undefined)
}

export const register: Register = on => {
  let current: Usage | null = null
  // When the session and week figures in `current` were read, by whichever session.
  let readAt: number | null = null
  let sharedPath: string | null = null
  // This session's own file for writing the shared one whole before the move.
  let tmpPath: string | null = null
  let sessionId: string | null = null
  let lastResponseAt: number | null = null
  // The last response's model, beside its time, to deduce the cache's lifetime.
  let lastSeen: Seen | null = null
  let ttl = TTL_1H
  let isTurnRunning = false
  // The response the cache warning was last given for.
  let cacheWarnedFor: number | null = null
  // The token count at which the context is compacted; undefined when off.
  let compactAt: number | undefined
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

  // The cache about to expire while the session waits for a prompt: what to
  // say, once per response, or null.
  const cacheWarning = (now: number): string | null => {
    if (isTurnRunning || lastResponseAt === null || cacheWarnedFor === lastResponseAt) return null
    const left = lastResponseAt + ttl - now
    if (left <= 0 || left > cacheWarnBefore(ttl)) return null
    cacheWarnedFor = lastResponseAt
    const tokens = current?.context.tokens
    const cost =
      tokens === undefined
        ? ''
        : `: the next prompt costs ${kTokens((tokens * CACHE_READ_HUNDREDTHS) / 100)} now, ${kTokens((tokens * writeHundredths(ttl)) / 100)} after`
    return `Prompt cache expires in ${duration(left)}${cost}`
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
    sessionId = await $.session.id().catch(() => null)
    tmpPath = sharedPath === null ? null : `${sharedPath}.${sessionId ?? crypto.randomUUID()}.tmp`
    // A resumed session (or a reload) takes up the cache countdown it had.
    const saved = sessionId === null ? undefined : (await readLastResponses($))[sessionId]
    if (typeof saved === 'number') lastResponseAt = saved
    ttl = (await readTtl($)) ?? ttl
    const { context, rateLimits } = await $.session.usage()
    current = toUsage(context, rateLimits)
    compactAt = await readCompactAt($)
    adopt(await readShared($, sharedPath))
    // Every 30 s: take a fresher reading and lifetime another session shared,
    // warn what is due, and redraw (the cache countdown and the reset times
    // move on their own).
    void $.clock.every(30_000, async () => {
      adopt(await readShared($, sharedPath))
      ttl = (await readTtl($)) ?? ttl
      const now = await $.clock.now()
      const cacheText = cacheWarning(now)
      if (cacheText !== null) warn($, cacheText, true, 'Prompt cache')
      await warnLimits($, current, now)
      $.ui.invalidate('ui.render')
    })
    $.ui.invalidate('ui.render')
    return next(e)
  })

  on('session.measure', async ($, e, next) => {
    current = toUsage(e.context, e.rateLimits)
    const now = await $.clock.now()
    if (e.rateLimits.length > 0) await writeShared($, sharedPath, tmpPath, stamp(now))
    await warnLimits($, current, now)
    $.ui.invalidate('ui.render')
    return next(e)
  })

  on('turn.start', async ($, e, next) => {
    if (!e.agentId) isTurnRunning = true
    return next(e)
  })

  // Every response of the main conversation renews the cache, the ones in the
  // middle of a long turn too (each tool call's round trip rereads it): the
  // countdown starts again as each one arrives, not only when the turn ends.
  on('turn.step', async function* ($, e, next) {
    const result = yield* next(e)
    if (!e.agentId && result.usage !== null) {
      const at = await $.clock.now()
      const learned = deduceTtl(lastSeen, at, result.usage)
      if (learned !== undefined && learned !== ttl) {
        ttl = learned
        await $.store.set(TTL_KEY, ttl).catch(() => undefined)
      }
      lastSeen = { at, model: result.usage.model }
      lastResponseAt = at
      await saveLastResponse($, sessionId, lastResponseAt)
      $.ui.invalidate('ui.render')
    }
    return result
  })

  // The main conversation's last response renews the cache, and brought the
  // account's windows as they are now: share them.
  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (!e.agentId) {
      isTurnRunning = false
      lastResponseAt = await $.clock.now()
      await saveLastResponse($, sessionId, lastResponseAt)
      const { context, rateLimits } = await $.session.usage()
      if (rateLimits.length > 0) {
        current = toUsage(context, rateLimits)
        await writeShared($, sharedPath, tmpPath, stamp(lastResponseAt))
        await warnLimits($, current, lastResponseAt)
      }
      compactAt = await readCompactAt($)
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
      verbose: [
        `Used: ${ctxUsed} tokens`,
        `Window: ${kTokens(ctx.window)}${compactAt !== undefined ? ` · compacts at ${kTokens(compactAt)}` : ''}`,
      ],
      zone: CTX_ZONE,
      ...(compactAt !== undefined && compactAt < ctx.window ? { mark: (compactAt / ctx.window) * 100 } : {}),
    }

    const elapsed = lastResponseAt === null ? undefined : Math.max(0, now - lastResponseAt)
    const left = elapsed === undefined ? undefined : ttl - elapsed
    // What the next prompt costs for the context, in plain input-token
    // equivalents: with the cache alive, and once it has expired.
    const warm = ctx.tokens !== undefined ? (ctx.tokens * CACHE_READ_HUNDREDTHS) / 100 : undefined
    const cold = ctx.tokens !== undefined ? (ctx.tokens * writeHundredths(ttl)) / 100 : undefined
    // Said only when it is not the 1 hour assumed.
    const ttlNote = ttl === TTL_5M ? ' · 5m cache' : ''
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
              verbose: [`Expired ${duration(-left)} ago${ttlNote}`, cold === undefined ? 'Next prompt: n/a' : `Next prompt: ${kTokens(cold)}`],
            }
          : {
              key: 'cch',
              label: 'Cch',
              level: (elapsed / ttl) * 100,
              fill: (left / ttl) * 100,
              value: `${Math.ceil(left / 60_000)}m`,
              alt: [`${Math.ceil(left / 60_000)} min`, cost],
              verbose: [`Expires in ${duration(left)}${ttlNote}`, costVerbose],
            }

    const age = readAt === null ? '' : now - readAt < 60_000 ? 'now' : `${duration(now - readAt)} ago`
    const resetMeter = (key: Key, label: string, w: Window | null, isWeek: boolean, segments?: number, spanMs?: number): Meter => {
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
          ...(segments === undefined ? {} : { segments }),
        }
      }
      const hasReset = Number.isFinite(resetAt)
      const at = hasReset ? when(resetAt) : ''
      const nowAt = hasReset && spanMs !== undefined ? clamp(100 - ((resetAt - now) / spanMs) * 100) : undefined
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
        ...(segments === undefined ? {} : { segments }),
        ...(nowAt === undefined ? {} : { now: nowAt }),
      }
    }

    return [
      ctxMeter,
      cchMeter,
      resetMeter('ses', 'Ses', usage.fiveHour, false),
      resetMeter('wk', 'Wk', usage.week, true, 7, WEEK),
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
              <Box width="100%" height={1} backgroundColor="subtle" overflow="hidden" position="relative">
                <Box width={`${Math.round(clamp(m.fill))}%`} height={1} backgroundColor={HUES[m.key]} />
                {(m.zone ?? []).map(at => (
                  <Box key={`zone-${m.key}-${at}`} position="absolute" top={0} left={0} width={`${at}%`} height={1} flexDirection="row" justifyContent="flex-end">
                    <Text color={ZONE_TICK}>▕</Text>
                  </Box>
                ))}
                {dividers(m.segments).map(at => (
                  <Box key={`divider-${m.key}-${at}`} position="absolute" top={0} left={0} width={`${Math.round(at)}%`} height={1} flexDirection="row" justifyContent="flex-end">
                    <Text color={DIVIDER}>│</Text>
                  </Box>
                ))}
                {m.now === undefined ? null : (
                  <Box key={`now-${m.key}`} position="absolute" top={0} left={0} width={`${Math.round(m.now)}%`} height={1} flexDirection="row" justifyContent="flex-end">
                    <Text color={NOW_TICK}>┃</Text>
                  </Box>
                )}
                {m.mark === undefined ? null : (
                  <Box key={`mark-${m.key}`} position="absolute" top={0} left={0} width={`${Math.round(clamp(m.mark))}%`} height={1} flexDirection="row" justifyContent="flex-end">
                    <Text color={MARK}>▕</Text>
                  </Box>
                )}
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
