import type { On, SessionUsage } from 'claude-code'
import { expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

const FILE = '/Users/test/.claude/usage-bars/latest.json'
const TMP = `${FILE}.s1.tmp`
const NOW = Date.parse('2098-12-31T21:30:00Z')
const MIN = 60_000
const ran = (exitCode: number) => ({ value: { exitCode, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })

const usage = (fiveHour = 72): SessionUsage => ({
  startedAt: 0,
  context: { tokens: 90_000, window: 200_000, percent: 45 },
  rateLimits: [
    { kind: 'five_hour', percentUsed: fiveHour, resetsAt: '2099-01-01T00:00:00Z' },
    { kind: 'seven_day', percentUsed: 33, resetsAt: '2099-01-03T09:00:00Z' },
  ],
})

const props = (e: unknown) => (e as { props?: { source?: string; alt?: string } }).props ?? {}

const mountBand = ($: Engine) =>
  $.ui.mount({
    plugin: 'usage-bars',
    surface: 'desktop',
    component: 'AbovePrompt',
    props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 100, scroll: { offset: 0, bodyRows: 9 }, view: {} } as never,
  })

// The world every test here shares: a home, a session id, a clock and the usage.
const world = (on: On, opts: { store?: unknown; file?: string; usage?: SessionUsage; now?: () => number } = {}) => {
  on('env.get', () => ({ value: '/Users/test' }))
  on('session.id', () => ({ value: 's1' }))
  on('session.usage', () => ({ value: opts.usage ?? usage() }))
  on('store.get', () => ({ value: opts.store }))
  on('fs.read', (_$, e) => (e.path === FILE && opts.file !== undefined ? { value: opts.file } : { deny: 'no file' }))
  on('clock.now', () => ({ value: opts.now?.() ?? NOW }))
  on('clock.every', () => ({ value: undefined }))
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('turn.complete', () => ({ text: '' }))
}

const start = ($: Engine) => $.session.start({ cwd: '/work', surface: 'desktop' } as never)
const respond = ($: Engine) =>
  $.turn.complete({ answer: 'ok', durationMs: 1, isAborted: false, turnId: 't', reason: 'answer' } as never)

test('a resumed session takes up the cache countdown it had', async ($, on) => {
  // its last response was 50 minutes ago: 10 of the 60 minutes left
  world(on, { store: { s1: NOW - 50 * MIN } })
  await start($)
  const ui = await mountBand($)
  expect(await ui.find({ type: 'Text', text: '10m' })).toBeDefined()
  expect(props((await ui.findAll({ type: 'Svg' }))[1]).alt).toContain('Expires in 10m')
})

test('another session’s countdown is not taken up', async ($, on) => {
  world(on, { store: { other: NOW - 5 * MIN } })
  await start($)
  const ui = await mountBand($)
  expect(props((await ui.findAll({ type: 'Svg' }))[1]).alt).toContain('No response yet')
})

test('a response keeps its time in the store and drops the expired ones', async ($, on) => {
  const sets: unknown[] = []
  world(on, { store: { old: NOW - 2 * 60 * MIN, live: NOW - 20 * MIN } })
  on('store.set', (_$, e) => {
    sets.push(e.value)
    return { value: undefined }
  })
  on('fs.write', () => ({ value: undefined }))
  on('process.run', () => ran(0))
  await start($)
  await respond($)
  expect(sets.at(-1)).toEqual({ s1: NOW, live: NOW - 20 * MIN })
})

test('the shared file is written whole beside it, then moved over it', async ($, on) => {
  const writes: string[] = []
  const runs: (readonly string[])[] = []
  world(on)
  on('store.set', () => ({ value: undefined }))
  on('fs.write', (_$, e) => {
    writes.push(e.path)
    return { value: undefined }
  })
  on('process.run', (_$, e) => {
    runs.push(e.argv)
    return ran(0)
  })
  await start($)
  await respond($)
  expect(writes).toEqual([TMP])
  expect(runs).toEqual([['mv', '-f', TMP, FILE]])
})

test('where the move fails the file is written in place', async ($, on) => {
  const writes: string[] = []
  world(on)
  on('store.set', () => ({ value: undefined }))
  on('fs.write', (_$, e) => {
    writes.push(e.path)
    return { value: undefined }
  })
  on('process.run', () => ran(1))
  await start($)
  await respond($)
  expect(writes).toEqual([TMP, FILE])
})

test('an older reading never replaces a fresher one already shared', async ($, on) => {
  const writes: string[] = []
  // another session shared one a minute in the future of this response
  const fresher = { readAt: NOW + MIN, fiveHour: { percent: 80 }, week: { percent: 40 } }
  world(on, { file: JSON.stringify(fresher) })
  on('store.set', () => ({ value: undefined }))
  on('fs.write', (_$, e) => {
    writes.push(e.path)
    return { value: undefined }
  })
  on('process.run', () => ran(0))
  await start($)
  await respond($)
  expect(writes).toEqual([])
})

test('a half-written shared file is passed over', async ($, on) => {
  world(on, { file: '{"readAt": 409', usage: usage(72) })
  await start($)
  const ui = await mountBand($)
  expect(await ui.find({ type: 'Text', text: '72%' })).toBeDefined()
})

test('past its lifetime the cache reads expired, with what the next prompt costs', async ($, on) => {
  world(on, { store: { s1: NOW - 75 * MIN } })
  await start($)
  const ui = await mountBand($)
  expect(await ui.find({ type: 'Text', text: 'exp' })).toBeDefined()
  const cch = props((await ui.findAll({ type: 'Svg' }))[1])
  expect(cch.alt).toBe('Expired 15m ago. Next prompt: 180k')
  expect(cch.source).toContain('data-face="alt"')
})
