import type { SessionUsage } from 'claude-code'
import { expect, test } from 'claude-code/testing'

const SES_RESET = '2099-01-01T00:00:00Z'
const WK_RESET = '2099-01-03T09:00:00Z'

const usage: SessionUsage = {
  startedAt: 0,
  context: { tokens: 90_000, window: 200_000, percent: 45 },
  rateLimits: [
    { kind: 'five_hour', percentUsed: 72, resetsAt: SES_RESET },
    { kind: 'seven_day', percentUsed: 96, resetsAt: WK_RESET },
  ],
}

const hhmm = (iso: string) => {
  const d = new Date(Date.parse(iso))
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}
const day = (iso: string) => ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][new Date(Date.parse(iso)).getDay()]

type Props = { source?: string; alt?: string; height?: number; color?: string; bold?: boolean; width?: unknown; backgroundColor?: string }
const props = (e: unknown) => (e as { props?: Props }).props ?? {}

for (const surface of ['terminal', 'desktop'] as const) {
  test(`draws the four meters (${surface})`, async ($, on) => {
    on('session.usage', () => ({ value: usage }))
    on('session.measure', (_$, e) => ({ changed: e.changed }))
    let clock = Date.parse('2098-12-31T20:40:00Z')
    on('clock.now', () => ({ value: clock }))
    on('turn.complete', () => ({ text: '' }))
    // last response at 20:40; drawn at 21:30 → 10 of 60 min left
    await $.turn.complete({
      answer: 'ok',
      durationMs: 1000,
      isAborted: false,
      turnId: 't1',
      reason: 'answer',
      usage: { model: 'm', input_tokens: 1_000, output_tokens: 2_000, cache_read_input_tokens: 800_000, cache_creation_input_tokens: 97_000 },
    } as never)
    clock = Date.parse('2098-12-31T21:30:00Z')
    await $.session.measure({ context: usage.context, rateLimits: usage.rateLimits, changed: ['context', 'rateLimits'] })

    const ui = await $.ui.mount({
      plugin: 'usage-bars',
      surface,
      component: 'AbovePrompt',
      props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 100, scroll: { offset: 0, bodyRows: 9 }, view: {} } as never,
    })

    // short English labels, in order
    for (const l of ['Ctx', 'Cch', 'Ses', 'Wk']) expect(await ui.find({ type: 'Text', text: l })).toBeDefined()

    // values on the scale: 45% and 72% in the meter's hue, cache 83% gone → yellow, week 96% → red bold
    const values = (await ui.findAll({ type: 'Text', text: /^\d+(%|m)$/ })).map(t => [props(t).color, props(t).bold === true])
    expect(values).toEqual([['#4f8ff7', false], ['#d4a72c', false], ['#9b7bf0', false], ['#e5534b', true]])

    const pointer = (type: 'enter' | 'leave' | 'down', meter: string) =>
      ui.pointer({ type, x: 1, y: 0, ...(type === 'down' ? { button: 'left' as const } : {}), in: `hit-${meter}` })
    const labelPointer = (type: 'enter' | 'leave' | 'down', meter: string) =>
      ui.pointer({ type, x: 0, y: 0, ...(type === 'down' ? { button: 'left' as const } : {}), in: `hit-label-${meter}` })

    if (surface === 'desktop') {
      const svgs = async () => (await ui.findAll({ type: 'Svg' })).map(props)
      const faceOf = async (i: number) => /data-face="(\w+)"/.exec((await svgs())[i]?.source ?? '')?.[1]
      const [ctx, cch, ses, wk] = await svgs()
      for (const p of [ctx, cch, ses, wk]) expect(p?.height).toBe(20)
      // 100 columns: (100 - 3 × 2) / 4 = 23.5 cells per column, the graph takes 15.5 of them
      for (const p of [ctx, cch, ses, wk]) expect(p?.source).toContain('width="147"')
      // alternative texts centred in the graph's room
      expect(wk?.source).toContain('text-anchor:middle')
      expect(wk?.source).toContain('<text x="73.5" y="8"')
      // at rest: pills in their own hue; the red-band week shows its alternative text by itself
      expect(/<rect[^>]*\/><rect[^>]*fill="(#[0-9a-f]{6})"/.exec(ctx?.source ?? '')?.[1]).toBe('#4f8ff7')
      expect(/<(?:rect|path)[^>]*\/><rect[^>]*fill="(#[0-9a-f]{6})"/.exec(cch?.source ?? '')?.[1]).toBe('#e07bb5')
      expect([await faceOf(0), await faceOf(1), await faceOf(2), await faceOf(3)]).toEqual(['pill', 'pill', 'pill', 'alt'])
      expect(wk?.source).toContain(`>${day(WK_RESET)} ${hhmm(WK_RESET)}</text>`)
      expect(ses?.alt).toBe(`Resets in 2h 30m. at ${hhmm(SES_RESET)} · now`)

      // hover shows the two-line alternative text; leaving brings the pill back
      await pointer('enter', 'cch')
      expect(await faceOf(1)).toBe('alt')
      expect((await svgs())[1]?.source).toContain('>10 min</text>')
      expect((await svgs())[1]?.source).toContain('>9k → 180k</text>')
      await pointer('leave', 'cch')
      expect(await faceOf(1)).toBe('pill')

      // a click pins it: it stays after the pointer leaves; hovering it shows the verbose form
      await pointer('enter', 'ses')
      await pointer('down', 'ses')
      await pointer('leave', 'ses')
      expect(await faceOf(2)).toBe('alt')
      expect((await svgs())[2]?.source).toContain('>-2h 30m</text>')
      expect((await svgs())[2]?.source).toContain(`>${hhmm(SES_RESET)}</text>`)
      await pointer('enter', 'ses')
      expect(await faceOf(2)).toBe('verbose')
      expect((await svgs())[2]?.source).toContain('>Resets in 2h 30m</text>')
      // a second click unpins it
      await pointer('down', 'ses')
      await pointer('leave', 'ses')
      expect(await faceOf(2)).toBe('pill')

      // the label's tooltip: its full name in the graph's place, gone when the pointer leaves
      await labelPointer('enter', 'ses')
      expect(await faceOf(2)).toBe('name')
      expect((await svgs())[2]?.source).toContain('>Session</text>')
      expect((await svgs())[2]?.source).toContain('>5-hour window</text>')
      await labelPointer('leave', 'ses')
      expect(await faceOf(2)).toBe('pill')

      // the label pins too, and the cache cost reads in full when hovered while pinned
      await labelPointer('down', 'cch')
      await labelPointer('leave', 'cch')
      await pointer('enter', 'cch')
      expect((await svgs())[1]?.source).toContain('>9k now, 180k expired</text>')
    } else {
      // terminal: blocks in the meter's hue; the red-band week shows its alternative text
      const fills = (await ui.findAll({ type: 'Box' }))
        .map(props)
        .filter(p => typeof p.width === 'string' && p.width !== '100%' && p.backgroundColor !== undefined)
        .map(p => [p.width, p.backgroundColor])
      expect(fills).toEqual([['45%', '#4f8ff7'], ['17%', '#e07bb5'], ['72%', '#9b7bf0']])
      expect(await ui.find({ type: 'Text', text: ` -2d 11h · ${day(WK_RESET)} ${hhmm(WK_RESET)}` })).toBeDefined()
      await labelPointer('enter', 'wk')
      expect(await ui.find({ type: 'Text', text: ' Week · weekly limit' })).toBeDefined()
      await labelPointer('leave', 'wk')
      await pointer('enter', 'ctx')
      expect(await ui.find({ type: 'Text', text: ' 90k · 200k' })).toBeDefined()
      await pointer('down', 'ctx')
      await pointer('leave', 'ctx')
      expect(await ui.find({ type: 'Text', text: ' 90k · 200k' })).toBeDefined()
    }
  })
}
