import type { SessionUsage } from 'claude-code'
import { expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

const FILE = '/Users/test/.claude/usage-bars/latest.json'
const NOW = Date.parse('2098-12-31T21:30:00Z')

const props = (e: unknown) => (e as { props?: { source?: string; alt?: string } }).props ?? {}

const mountBand = ($: Engine) =>
  $.ui.mount({
    plugin: 'usage-bars',
    surface: 'desktop',
    component: 'AbovePrompt',
    props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 100, scroll: { offset: 0, bodyRows: 9 }, view: {} } as never,
  })

test('an idle session takes the fresher reading another session shared', async ($, on) => {
  // this session last saw 30% / 40%; another one shared 64% / 51% two minutes ago
  const stale: SessionUsage = {
    startedAt: 0,
    context: { tokens: 90_000, window: 200_000, percent: 45 },
    rateLimits: [
      { kind: 'five_hour', percentUsed: 30, resetsAt: '2099-01-01T00:00:00Z' },
      { kind: 'seven_day', percentUsed: 40, resetsAt: '2099-01-03T09:00:00Z' },
    ],
  }
  const shared = {
    readAt: NOW - 2 * 60_000,
    fiveHour: { percent: 64, resetsAt: '2099-01-01T00:00:00Z' },
    week: { percent: 51, resetsAt: '2099-01-03T09:00:00Z' },
  }
  on('env.get', () => ({ value: '/Users/test' }))
  on('session.usage', () => ({ value: stale }))
  on('fs.read', (_$, e) => (e.path === FILE ? { value: JSON.stringify(shared) } : { deny: 'no file' }))
  on('clock.now', () => ({ value: NOW }))
  on('clock.every', () => ({ value: undefined }))
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  await $.session.start({ cwd: '/work', surface: 'desktop' } as never)

  const ui = await mountBand($)
  for (const v of ['64%', '51%']) expect(await ui.find({ type: 'Text', text: v })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '30%' })).toBeUndefined()
  // the verbose text says how old the reading is
  expect(props((await ui.findAll({ type: 'Svg' }))[2]).alt).toContain('· 2m ago')
})

test('a response shares its reading through the file', async ($, on) => {
  const fresh: SessionUsage = {
    startedAt: 0,
    context: { tokens: 90_000, window: 200_000, percent: 45 },
    rateLimits: [
      { kind: 'five_hour', percentUsed: 72, resetsAt: '2099-01-01T00:00:00Z' },
      { kind: 'seven_day', percentUsed: 33, resetsAt: '2099-01-03T09:00:00Z' },
    ],
  }
  const writes: { path: string; text: string }[] = []
  on('env.get', () => ({ value: '/Users/test' }))
  on('session.usage', () => ({ value: fresh }))
  on('fs.read', () => ({ deny: 'no file' }))
  on('fs.write', (_$, e) => {
    writes.push({ path: e.path, text: e.text })
    return { value: undefined }
  })
  on('clock.now', () => ({ value: NOW }))
  on('clock.every', () => ({ value: undefined }))
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('turn.complete', () => ({ text: '' }))
  await $.session.start({ cwd: '/work', surface: 'desktop' } as never)
  await $.turn.complete({ answer: 'ok', durationMs: 1, isAborted: false, turnId: 't', reason: 'answer' } as never)

  const last = writes.at(-1)
  expect(last?.path).toBe(FILE)
  expect(JSON.parse(last?.text ?? '{}')).toEqual({
    readAt: NOW,
    fiveHour: { percent: 72, resetsAt: '2099-01-01T00:00:00Z' },
    week: { percent: 33, resetsAt: '2099-01-03T09:00:00Z' },
  })
})

test('past its reset time a window shows 0% until a new reading', async ($, on) => {
  const old: SessionUsage = {
    startedAt: 0,
    context: { tokens: 90_000, window: 200_000, percent: 45 },
    rateLimits: [
      { kind: 'five_hour', percentUsed: 99, resetsAt: '2098-12-31T21:00:00Z' },
      { kind: 'seven_day', percentUsed: 40, resetsAt: '2099-01-03T09:00:00Z' },
    ],
  }
  on('env.get', () => ({ value: '/Users/test' }))
  on('session.usage', () => ({ value: old }))
  on('fs.read', () => ({ deny: 'no file' }))
  on('clock.now', () => ({ value: NOW }))
  on('clock.every', () => ({ value: undefined }))
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  await $.session.start({ cwd: '/work', surface: 'desktop' } as never)

  const ui = await mountBand($)
  expect(await ui.find({ type: 'Text', text: '99%' })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: '0%' })).toBeDefined()
  expect(props((await ui.findAll({ type: 'Svg' }))[2]).alt).toContain('awaiting a new reading')
})
