import type { On, SessionUsage, TurnUsage } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

const NOW = Date.parse('2098-12-31T21:30:00Z')
const MIN = 60_000
const SES_RESET = '2099-01-01T00:00:00Z'

const hhmm = (iso: string) => {
  const d = new Date(Date.parse(iso))
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

const usageWith = (ses: number, extra: Partial<SessionUsage['context']> = {}): SessionUsage => ({
  startedAt: 0,
  context: { tokens: 90_000, window: 200_000, percent: 45, ...extra },
  rateLimits: [
    { kind: 'five_hour', percentUsed: ses, resetsAt: SES_RESET },
    { kind: 'seven_day', percentUsed: 33, resetsAt: '2099-01-03T09:00:00Z' },
  ],
})

type Props = { source?: string; alt?: string }
const props = (e: unknown) => (e as { props?: Props }).props ?? {}

const mountBand = ($: Engine, surface: 'terminal' | 'desktop' = 'desktop') =>
  $.ui.mount({
    plugin: 'usage-bars',
    surface,
    component: 'AbovePrompt',
    props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 100, scroll: { offset: 0, bodyRows: 9 }, view: {} } as never,
  })

// The world: a mocked clock, a store in memory, no shared file, and what the toasts said.
// (A test cannot hook `ui.notify`: the notifications themselves go unchecked.)
const world = (on: On, opts: { usage?: (args: { breakdown?: unknown }) => SessionUsage; store?: Record<string, unknown> } = {}) => {
  const clock = mock.clock(on, { now: NOW })
  const store = new Map<string, unknown>(Object.entries(opts.store ?? {}))
  on('store.get', (_$, e) => ({ value: store.get(e.key) }))
  on('store.set', (_$, e) => {
    store.set(e.key, e.value)
    return { value: undefined }
  })
  const toasts: string[] = []
  on('env.get', () => ({ value: '/Users/test' }))
  on('session.id', () => ({ value: 's1' }))
  on('session.usage', (_$, e) => ({ value: (opts.usage ?? (() => usageWith(30)))(e) }))
  on('fs.read', () => ({ deny: 'no file' }))
  on('fs.write', () => ({ value: undefined }))
  on('process.run', () => ({ value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('session.measure', (_$, e) => ({ changed: e.changed }))
  on('turn.start', (_$, e) => ({ turnId: e.turnId }) as never)
  on('turn.complete', () => ({ text: '' }))
  on('ui.toast', (_$, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  return { clock, toasts, store }
}

const start = ($: Engine) => $.session.start({ cwd: '/work', surface: 'desktop' } as never)
const respond = ($: Engine) =>
  $.turn.complete({ answer: 'ok', durationMs: 1, isAborted: false, turnId: 't', reason: 'answer' } as never)

// One response of the main loop, with what it read from and wrote to the cache.
const stepWith = (on: On) => {
  let next: TurnUsage | null = null
  on('turn.step', async function* (_$, e) {
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: next ? 'tool_use' : null, usage: next } as never
  })
  return async ($: Engine, usage: TurnUsage) => {
    next = usage
    for await (const _ of $.turn.step({ turnId: 't', index: 0, model: usage.model, messageCount: 3 })) void _
  }
}
const read = (model: string, cached: number, written: number): TurnUsage => ({
  model,
  input_tokens: 500,
  output_tokens: 100,
  cache_read_input_tokens: cached,
  cache_creation_input_tokens: written,
})

test('a response after a pause that rewrote the cache teaches the 5-minute lifetime', async ($, on) => {
  const { clock, store } = world(on)
  const step = stepWith(on)
  await start($)
  await step($, read('m', 85_000, 4_000))
  // ten minutes later the same model wrote almost everything again: the cache had expired
  await clock.advance(10 * MIN)
  await step($, read('m', 2_000, 87_000))
  expect(store.get('cacheTtl')).toBe(5 * MIN)

  // the meter counts 5 minutes, and an expired cache is written again at 1.25x
  await clock.advance(2 * MIN)
  const ui = await mountBand($)
  expect(await ui.find({ type: 'Text', text: '3m' })).toBeDefined()
  const cch = props((await ui.findAll({ type: 'Svg' }))[1])
  expect(cch.alt).toContain('Expires in 3m · 5m cache')
  expect(cch.alt).toContain('9k now, 113k expired')
})

test('a response after a pause that read the cache brings the 1-hour lifetime back', async ($, on) => {
  const { clock, store } = world(on, { store: { cacheTtl: 5 * MIN } })
  const step = stepWith(on)
  await start($)
  await step($, read('m', 85_000, 4_000))
  await clock.advance(20 * MIN)
  await step($, read('m', 88_000, 1_500))
  expect(store.get('cacheTtl')).toBe(60 * MIN)
})

test('a short pause, another model or a mixed reading teach nothing', async ($, on) => {
  const { clock, store } = world(on)
  const step = stepWith(on)
  await start($)
  await step($, read('m', 85_000, 4_000))
  await clock.advance(3 * MIN)
  await step($, read('m', 1_000, 88_000))
  await clock.advance(10 * MIN)
  await step($, read('other', 1_000, 88_000))
  await clock.advance(10 * MIN)
  await step($, read('other', 50_000, 40_000))
  expect(store.get('cacheTtl')).toBeUndefined()
})

test('the cache about to expire is warned of once, and not while a turn runs', async ($, on) => {
  const { clock, toasts } = world(on)
  await start($)
  await respond($)
  // 54 minutes on: 6 minutes left, nothing yet
  await clock.advance(54 * MIN)
  expect(toasts).toEqual([])
  // 55½ minutes on: under 5 minutes left
  await clock.advance(MIN + 30_000)
  expect(toasts).toEqual(['Prompt cache expires in 5m: the next prompt costs 9k now, 180k after'])
  await clock.advance(2 * MIN)
  expect(toasts.length).toBe(1)

  // a turn running renews the cache itself: no warning while it does
  await respond($)
  await $.turn.start({ text: 'go', turnId: 't2' } as never)
  await clock.advance(58 * MIN)
  expect(toasts.length).toBe(1)
})

test('a window past 85% and past 95% is warned of once per band', async ($, on) => {
  let ses = 30
  const { toasts, store } = world(on, { usage: () => usageWith(ses) })
  await start($)
  const measure = async () => {
    const u = usageWith(ses)
    await $.session.measure({ context: u.context, rateLimits: u.rateLimits, changed: ['rateLimits'] })
  }
  ses = 87
  await measure()
  ses = 88
  await measure()
  expect(toasts).toEqual([`Session at 87% · resets at ${hhmm(SES_RESET)}`])
  ses = 96
  await measure()
  expect(toasts.at(-1)).toBe(`Session at 96% · resets at ${hhmm(SES_RESET)}`)
  // what was warned is in the store, for the other sessions
  expect(Object.keys((store.get('warned')) as object).sort()).toEqual([
    `ses:${Date.parse(SES_RESET)}:85`,
    `ses:${Date.parse(SES_RESET)}:95`,
  ])
})

for (const surface of ['terminal', 'desktop'] as const) {
  test(`the context bar marks where auto-compact runs (${surface})`, async ($, on) => {
    world(on, {
      usage: e => {
        const u = usageWith(30)
        return e.breakdown ? { ...u, context: { ...u.context, breakdown: { isAutoCompactEnabled: true, autoCompactThreshold: 160_000 } as never } } : u
      },
    })
    await start($)
    const ui = await mountBand($, surface)
    if (surface === 'desktop') {
      const ctx = props((await ui.findAll({ type: 'Svg' }))[0])
      // 80% of the 141 px bar, from its 3 px inset, less half the tick: 115.05
      const x = Number(/<rect x="([\d.]+)"[^>]*data-mark="compact"/.exec(ctx.source ?? '')?.[1])
      expect(Math.abs(x - 115.05)).toBeLessThan(0.1)
      expect(ctx.alt).toContain('Window: 200k · compacts at 160k')
      // the other bars carry no tick
      for (const p of (await ui.findAll({ type: 'Svg' })).slice(1).map(props)) expect(p.source).not.toContain('data-mark')
    } else {
      // the compact tick, beside the two of the 50–75% zone
      const ticks = (await ui.findAll({ type: 'Text', text: '▕' })).map(t => (t as { props?: { color?: string } }).props?.color)
      expect(ticks.filter(c => c === 'rgba(140,140,140,0.9)')).toHaveLength(1)
      expect(ticks).toHaveLength(3)
    }
  })
}

test('with auto-compact off the bar has no tick', async ($, on) => {
  world(on, {
    usage: e => {
      const u = usageWith(30)
      return e.breakdown ? { ...u, context: { ...u.context, breakdown: { isAutoCompactEnabled: false } as never } } : u
    },
  })
  await start($)
  const ui = await mountBand($)
  expect(props((await ui.findAll({ type: 'Svg' }))[0]).source).not.toContain('data-mark')
})

for (const surface of ['terminal', 'desktop'] as const) {
  test(`the context bar marks out 50% to 75%, the time to compact or hand over (${surface})`, async ($, on) => {
    world(on)
    await start($)
    const ui = await mountBand($, surface)
    if (surface === 'desktop') {
      const svgs = (await ui.findAll({ type: 'Svg' })).map(props)
      const ctx = svgs[0]?.source ?? ''
      // the 141 px bar from its 3 px inset: 50% at 73.5, 75% at 108.75
      const band = /<rect x="([\d.]+)" y="6" width="([\d.]+)" height="8" fill="[^"]+" data-zone="band"\/>/.exec(ctx)
      expect(Number(band?.[1])).toBe(73.5)
      expect(Math.abs(Number(band?.[2]) - 35.25)).toBeLessThan(0.1)
      expect(ctx).toContain('data-zone="50"')
      expect(ctx).toContain('data-zone="75"')
      // the band lies under the fill: the fill is drawn after it
      expect(ctx.indexOf('data-zone="band"')).toBeLessThan(ctx.indexOf('fill="#4f8ff7"'))
      // the other bars have none
      for (const p of svgs.slice(1)) expect(p.source).not.toContain('data-zone')
    } else {
      const zones = (await ui.findAll({ type: 'Box' }))
        .map(b => (b as { props?: { width?: unknown; position?: string } }).props ?? {})
        .filter(p => p.position === 'absolute' && (p.width === '50%' || p.width === '75%'))
        .map(p => p.width)
      // the context's come first (the session's arrow sits at 50% too)
      expect(zones.slice(0, 2)).toEqual(['50%', '75%'])
    }
  })
}

for (const surface of ['terminal', 'desktop'] as const) {
  test(`the week bar is cut into 7 equal segments, one per day (${surface})`, async ($, on) => {
    world(on)
    await start($)
    const ui = await mountBand($, surface)
    if (surface === 'desktop') {
      const svgs = (await ui.findAll({ type: 'Svg' })).map(props)
      const wk = svgs[3]?.source ?? ''
      const at = [...wk.matchAll(/data-divider="([\d.]+)"/g)].map(m => m[1])
      expect(at).toEqual(['14.3', '28.6', '42.9', '57.1', '71.4', '85.7'])
      // drawn over the fill
      expect(wk.indexOf('data-divider')).toBeGreaterThan(wk.indexOf('fill="#2cb5a0"'))
      for (const p of svgs.slice(0, 2)) expect(p.source).not.toContain('data-divider')
    } else {
      // with the session's 4
      expect(await ui.findAll({ type: 'Text', text: '│' })).toHaveLength(10)
    }
  })
}

for (const surface of ['terminal', 'desktop'] as const) {
  test(`the week bar marks how much of the week has gone (${surface})`, async ($, on) => {
    world(on)
    await start($)
    const ui = await mountBand($, surface)
    // 59.5 h left of 168: 108.5 h gone, 64.6%
    if (surface === 'desktop') {
      const svgs = (await ui.findAll({ type: 'Svg' })).map(props)
      expect(svgs[3]?.source).toContain('data-now="64.6"')
      for (const p of svgs.slice(0, 2)) expect(p.source).not.toContain('data-now')
    } else {
      // with the session's
      expect(await ui.findAll({ type: 'Text', text: '┃' })).toHaveLength(2)
      const now = (await ui.findAll({ type: 'Box' }))
        .map(b => (b as { props?: { width?: unknown; position?: string } }).props ?? {})
        .filter(p => p.position === 'absolute' && p.width === '65%')
      expect(now).toHaveLength(1)
    }
  })
}

for (const surface of ['terminal', 'desktop'] as const) {
  test(`the session bar is cut into 5 hours and marks how much of them has gone (${surface})`, async ($, on) => {
    world(on)
    await start($)
    const ui = await mountBand($, surface)
    // 2.5 h left of 5: half gone
    if (surface === 'desktop') {
      const ses = (await ui.findAll({ type: 'Svg' })).map(props)[2]?.source ?? ''
      expect([...ses.matchAll(/data-divider="([\d.]+)"/g)].map(m => m[1])).toEqual(['20.0', '40.0', '60.0', '80.0'])
      expect(ses).toContain('data-now="50.0"')
    } else {
      const widths = (await ui.findAll({ type: 'Box' }))
        .map(b => (b as { props?: { width?: unknown; position?: string } }).props ?? {})
        .filter(p => p.position === 'absolute')
        .map(p => p.width)
      for (const w of ['20%', '40%', '60%', '80%']) expect(widths).toContain(w)
    }
  })
}

const pointerOnValue = (ui: Awaited<ReturnType<typeof mountBand>>, type: 'enter' | 'leave' | 'down') =>
  ui.pointer({ type, x: 0, y: 0, ...(type === 'down' ? { button: 'left' as const } : {}), in: 'hit-value-cch' })
const forksOf = (on: On) => {
  const forks: string[] = []
  on('model.fork', (_$, e) => {
    forks.push(e.prompt)
    return { value: { isAnswered: true, text: 'ok', usage: { input_tokens: 10, output_tokens: 2, cache_read_input_tokens: 90_000, cache_creation_input_tokens: 0 } } }
  })
  return forks
}

test('while the cache lives its value turns into a keep-alive under the pointer, and back', async ($, on) => {
  world(on, { store: { lastResponseAt: { s1: NOW - 30 * MIN } } })
  await start($)
  const ui = await mountBand($)
  await pointerOnValue(ui, 'enter')
  expect(await ui.find({ type: 'Text', text: '↻' })).toBeDefined()
  const cch = props((await ui.findAll({ type: 'Svg' }))[1]).source ?? ''
  expect(cch).toContain('data-face="keep"')
  expect(cch).toContain('↻ Keep alive')
  await pointerOnValue(ui, 'leave')
  expect(await ui.find({ type: 'Text', text: '30m' })).toBeDefined()
})

test('a click arms the keep-alive, which runs once 2 minutes before expiry and disarms', async ($, on) => {
  const { clock, toasts } = world(on, { store: { lastResponseAt: { s1: NOW - 30 * MIN } } })
  const forks = forksOf(on)
  await start($)
  const ui = await mountBand($)
  await pointerOnValue(ui, 'enter')
  await pointerOnValue(ui, 'down')
  expect(forks).toHaveLength(0)
  expect(props((await ui.findAll({ type: 'Svg' }))[1]).source).toContain('↻ Keep-alive armed')
  // disabled: a second click arms nothing more
  await pointerOnValue(ui, 'down')
  await pointerOnValue(ui, 'leave')
  expect(await ui.find({ type: 'Text', text: '↻30m' })).toBeDefined()
  // not yet at 3 minutes left
  await clock.advance(27 * MIN)
  expect(forks).toHaveLength(0)
  // the warning of the cache about to expire is not given while armed
  expect(toasts.some(t => t.startsWith('Prompt cache expires'))).toBe(false)
  await clock.advance(1 * MIN + 30_000)
  expect(forks).toHaveLength(1)
  expect(toasts).toContain('Prompt cache kept alive: 90k read from it')
  // the countdown starts again, and the button is back
  expect(await ui.find({ type: 'Text', text: '60m' })).toBeDefined()
  await clock.advance(58 * MIN)
  expect(forks).toHaveLength(1)
})

test('a new prompt disarms the keep-alive', async ($, on) => {
  const { clock } = world(on, { store: { lastResponseAt: { s1: NOW - 30 * MIN } } })
  const forks = forksOf(on)
  await start($)
  const ui = await mountBand($)
  await pointerOnValue(ui, 'down')
  await $.turn.start({ turnId: 't2', prompt: 'hi' } as never)
  await respond($)
  // the turn renewed the cache; past where the keep-alive would now run
  await clock.advance(59 * MIN)
  expect(forks).toHaveLength(0)
  expect(await ui.find({ type: 'Text', text: '1m' })).toBeDefined()
})
