import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const bridge = readFileSync(new URL('../../server/bridge-ws.js', import.meta.url), 'utf8')

describe('shared signal delivery presentation', () => {
  it('overlays the authenticated user pending state in detail and list responses', () => {
    expect(bridge).toContain('function applyVisibleSignalRecord(row, delivery, source')
    expect(bridge).toContain('result.pending_ticket = delivery.pending_ticket')
    expect(bridge).toContain('result.pending_state = delivery.pending_state')
    expect(bridge).toContain('d.pending_ticket, d.pending_state')
  })

  it('uses the same visibility and delivery overlay path for detail and evidence', () => {
    const visibilityCalls = bridge.match(/const visible = await loadVisibleSignalRecord\(signalId, detailUserId, observerStrategyId\)/g) || []
    expect(visibilityCalls.length).toBeGreaterThanOrEqual(2)
    expect(bridge).toContain('const item = applyVisibleSignalRecord(visible.row, visible.delivery, visible.source')
    expect(bridge).toContain("case 'signal_evidence':")
  })
})
