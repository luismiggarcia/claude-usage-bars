import type { ClientModule } from 'claude-code'

// An invisible region laid over one meter's graph, label or value: it reports the
// pointer entering, leaving and clicking to the hooks module, which picks the
// face the graph shows (pill, alternative, verbose or the label's full name)
// and keeps the pins.
type Props = { meter: string; part?: 'graph' | 'label' | 'value' }

const Hit: ClientModule<Props, true> = (props, surface) => {
  if (surface.state === undefined) {
    surface.onPointer(e => {
      if (e.type === 'enter' || e.type === 'leave') surface.post({ meter: props.meter, part: props.part ?? 'graph', type: e.type })
      else if (e.type === 'down' && e.button === 'left') surface.post({ meter: props.meter, part: props.part ?? 'graph', type: 'click' })
    })
    surface.setState(true)
  }
  const { Box } = surface.elements
  return <Box width="100%" height={1} />
}

export default Hit
