import type { SessionUsage } from 'claude-code'
import { expect, test } from 'claude-code/testing'

const usage: SessionUsage = {
  startedAt: 0,
  context: { tokens: 90_000, window: 200_000, percent: 45 },
  rateLimits: [
    { kind: 'five_hour', percentUsed: 72, resetsAt: '2099-01-01T00:00:00Z' },
    { kind: 'seven_day', percentUsed: 90 },
  ],
}

for (const surface of ['terminal', 'desktop'] as const) {
  test(`desenha as três barras (${surface})`, async ($, on) => {
    on('session.usage', () => ({ value: usage }))
    on('session.measure', (_$, e) => ({ changed: e.changed }))
    on('clock.now', () => ({ value: Date.parse('2098-12-31T21:30:00Z') }))
    await $.session.measure({ context: usage.context, rateLimits: usage.rateLimits, changed: ['context', 'rateLimits'] })

    const ui = await $.ui.mount({
      plugin: 'usage-bars',
      surface,
      component: 'AbovePrompt',
      props: {
        hasSurvey: false,
        isWorking: false,
        maxRows: 10,
        bodyColumns: 100,
        scroll: { offset: 0, bodyRows: 9 },
        view: {},
      } as never,
    })

    // três colunas com nome e percentagem
    for (const t of ['Contexto', '45%', 'Sessão', '72%', 'Semana', '90%']) {
      expect(await ui.find({ type: 'Text', text: t })).toBeDefined()
    }
    if (surface === 'terminal') {
      // barras: bloco com a largura da percentagem, cor por gráfico, vermelho no limite
      const fills = (await ui.findAll({ type: 'Box' }))
        .map(b => (b as { props?: { width?: unknown; backgroundColor?: string } }).props)
        .filter(p => typeof p?.width === 'string' && p.width !== '100%')
        .map(p => [p?.width, p?.backgroundColor])
      expect(fills).toEqual([['45%', '#4f8ff7'], ['72%', '#9b7bf0'], ['90%', '#e5534b']])
      expect(await ui.find({ text: '90k / 200k' })).toBeDefined()
      expect(await ui.find({ text: 'repõe em 2h 30m' })).toBeDefined()
    } else {
      // pílulas SVG de 8 px, cantos redondos, cor por gráfico, detalhe na dica
      const svgs = (await ui.findAll({ type: 'Svg' })).map(
        e => (e as { props?: { source?: string; alt?: string } }).props ?? {},
      )
      expect(svgs).toHaveLength(3)
      expect(svgs.map(p => /<g class="b">.*?rx="4" fill="[^"]+"\/><rect[^>]*fill="(#[0-9a-f]{6})"/.exec(p.source ?? '')?.[1])).toEqual(['#4f8ff7', '#9b7bf0', '#e5534b'])
      for (const p of svgs) expect(p.source).toMatch(/height="8" rx="4"/)
      // hover: a pílula esconde-se e o detalhe aparece, por CSS
      for (const p of svgs) expect(p.source).toContain('svg:hover .d{opacity:1}')
      expect(svgs[0]?.source).toContain('>90k / 200k</text>')
      expect(svgs[1]?.source).toContain('>repõe em 2h 30m</text>')
      for (const e of await ui.findAll({ type: 'Svg' })) expect((e as { props?: { height?: number } }).props?.height).toBe(16)
      expect(svgs[0]?.alt).toBe('Contexto: 45% · 90k / 200k')
      expect(svgs[1]?.alt).toBe('Sessão: 72% · repõe em 2h 30m')
    }
  })
}
