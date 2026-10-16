import type { Register, SessionContextUsage, SessionRateLimit } from 'claude-code'

type Window = { percent: number; resetsAt?: string }

type Usage = {
  context: { percent?: number; tokens?: number; window: number }
  fiveHour: Window | null
  week: Window | null
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

// Uma cor por gráfico; no limite (85% ou mais) qualquer um passa a vermelho.
const HUES = { ctx: '#4f8ff7', '5h': '#9b7bf0', sem: '#2cb5a0' } as const
const LIMIT = '#e5534b'
const TRACK = 'rgba(140,140,140,0.16)'
const colorFor = (key: keyof typeof HUES, percent: number) => (percent >= 85 ? LIMIT : HUES[key])

// Desktop: cada coluna da faixa mede cerca de 9,5 px (medido: 95 colunas).
const PX_PER_COLUMN = 9.5
const BAR_HEIGHT = 8
const FRAME_HEIGHT = 16

const esc = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

// Barra em forma de pílula: calha suave e preenchimento arredondado. Com o rato
// por cima (CSS :hover, que funciona na moldura isolada do SVG), a pílula dá
// lugar ao detalhe, no mesmo sítio e na mesma cor.
const pill = (width: number, percent: number, color: string, title: string, detail: string) => {
  const r = BAR_HEIGHT / 2
  const top = (FRAME_HEIGHT - BAR_HEIGHT) / 2
  const fill = percent <= 0 ? 0 : Math.max(BAR_HEIGHT, (clamp(percent) / 100) * width)
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${FRAME_HEIGHT}" viewBox="0 0 ${width} ${FRAME_HEIGHT}">` +
    `<style>` +
    `.d{opacity:0;transition:opacity .12s}.b{transition:opacity .12s}` +
    `svg:hover .b{opacity:0}svg:hover .d{opacity:1}` +
    `text{font:500 11px -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif}` +
    `</style>` +
    `<title>${esc(title)}</title>` +
    `<rect width="${width}" height="${FRAME_HEIGHT}" fill="transparent"/>` +
    `<g class="b">` +
    `<rect y="${top}" width="${width}" height="${BAR_HEIGHT}" rx="${r}" fill="${TRACK}"/>` +
    (fill ? `<rect y="${top}" width="${fill.toFixed(1)}" height="${BAR_HEIGHT}" rx="${r}" fill="${color}"/>` : '') +
    `</g>` +
    `<text class="d" x="0" y="${FRAME_HEIGHT / 2}" dominant-baseline="central" fill="${color}">${esc(detail)}</text>` +
    `</svg>`
  )
}

const clamp = (percent: number) => Math.min(Math.max(percent, 0), 100)

const kTokens = (n: number) => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : `${Math.round(n / 1000)}k`)

const untilReset = (resetsAt: string | undefined, now: number) => {
  if (!resetsAt) return ''
  const ms = Date.parse(resetsAt) - now
  if (!Number.isFinite(ms) || ms <= 0) return ''
  const minutes = Math.round(ms / 60_000)
  const d = Math.floor(minutes / 1440)
  const h = Math.floor((minutes % 1440) / 60)
  const m = minutes % 60
  return `repõe em ${d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : `${m}m`}`
}

export const register: Register = on => {
  let current: Usage | null = null

  on('session.start', async ($, e, next) => {
    const { context, rateLimits } = await $.session.usage()
    current = toUsage(context, rateLimits)
    $.ui.invalidate('ui.render')
    return next(e)
  })

  on('session.measure', async ($, e, next) => {
    current = toUsage(e.context, e.rateLimits)
    $.ui.invalidate('ui.render')
    return next(e)
  })

  // Os elementos vêm da tabela de cada superfície. Três colunas de largura igual:
  // nome, barra e percentagem. No desktop a barra é uma pílula SVG com o detalhe
  // no hover; no terminal é um bloco de cor e o detalhe entra ao lado no hover.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const usageLine = (Box: any, Text: any, Svg: any, usage: Usage, now: number, bodyColumns: number) => {
    const isTerminal = Svg === undefined
    const ctx = usage.context
    const pct = (percent: number | undefined) => (percent === undefined ? '—' : `${Math.round(percent)}%`)

    const columns: { key: keyof typeof HUES; label: string; percent: number | undefined; detail: string }[] = [
      {
        key: 'ctx',
        label: 'Contexto',
        percent: ctx.percent,
        detail: ctx.tokens !== undefined ? `${kTokens(ctx.tokens)} / ${kTokens(ctx.window)}` : `${kTokens(ctx.window)} tokens`,
      },
      { key: '5h', label: 'Sessão', percent: usage.fiveHour?.percent, detail: untilReset(usage.fiveHour?.resetsAt, now) || 'sem leitura' },
      { key: 'sem', label: 'Semana', percent: usage.week?.percent, detail: untilReset(usage.week?.resetsAt, now) || 'sem leitura' },
    ]

    return (
      <Box flexDirection="row" width="100%" columnGap={4}>
        {columns.map(c => {
          const color = c.percent === undefined ? 'inactive' : colorFor(c.key, c.percent)
          const fill = `${clamp(c.percent ?? 0)}%`
          const label = `${c.label}: ${pct(c.percent)} · ${c.detail}`
          // Três colunas, 4 de intervalo; em cada uma, nome (8), percentagem (4) e espaços (2).
          const barColumns = Math.max(6, Math.floor((bodyColumns - 8) / 3) - 14)
          const barPx = Math.round(barColumns * PX_PER_COLUMN)
          const bar = isTerminal ? (
            <Box flexGrow={1} width={0} height={1} backgroundColor="subtle" overflow="hidden">
              <Box width={fill} height={1} backgroundColor={color} />
            </Box>
          ) : (
            <Box flexGrow={1} height={1} alignItems="center" overflow="hidden">
              <Svg
                source={pill(barPx, c.percent ?? 0, color === 'inactive' ? '#8c8c8c' : color, label, c.detail)}
                alt={label}
                width={barPx}
                height={FRAME_HEIGHT}
                isInteractive
              />
            </Box>
          )
          return (
            <Box key={`usage-${c.key}`} flexGrow={1} width={0} flexDirection="row" alignItems="center" columnGap={1}>
              <Box width={8} flexShrink={0}>
                <Text dimColor wrap="truncate-end">{c.label}</Text>
              </Box>
              {bar}
              <Box width={4} flexShrink={0} justifyContent="flex-end">
                <Text color={color}>{pct(c.percent)}</Text>
              </Box>
              {isTerminal ? (
                <Box display="none" hover={{ display: 'flex' }} flexShrink={0}>
                  <Text dimColor wrap="truncate-end">{c.detail}</Text>
                </Box>
              ) : null}
            </Box>
          )
        })}
      </Box>
    )
  }

  // Uma linha na faixa imediatamente acima da caixa do prompt (terminal e desktop).
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (current === null || e.props.hasSurvey) return next(e)

    const now = await $.clock.now()
    if (e.surface === 'terminal') {
      const { Box, Text } = $.ui.resolve(e)
      return usageLine(Box, Text, undefined, current, now, e.props.bodyColumns)
    }
    const { Box, Text, Svg } = $.ui.resolve(e)
    return usageLine(Box, Text, Svg, current, now, e.props.bodyColumns)
  })
}
