import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const bridge = readFileSync(new URL('../../server/bridge-ws.js', import.meta.url), 'utf8')

describe('shared signal delivery presentation', () => {
  it('overlays the authenticated user pending state in detail and list responses', () => {
    expect(bridge).toContain('item.pending_ticket = delivery.pending_ticket')
    expect(bridge).toContain('item.pending_state = delivery.pending_state')
    expect(bridge).toContain('d.pending_ticket, d.pending_state')
  })
})
