import { describe, expect, it } from 'vitest'
import { createManualCandidateAuthority } from '../src/bootstrap/manual-candidate-authority.js'
import type { ReadyReviewTrade } from '../src/modules/reviews/index.js'

function setup() {
  const trade = { asOfUtcMsc: Date.parse('2026-09-01T02:00:00.000Z'), evidence: {
    userId: 7, accountId: '5', platform: 'mt5', ownershipIntervalId: 'interval',
    openedAt: '2026-09-01T00:00:00.000Z', closedAt: '2026-09-01T01:00:00.000Z', terminalTimezoneOffsetMinutes: 180 } } as ReadyReviewTrade
  const owned = { userId: 7, accountId: '5', platform: 'mt5' as const, currentOwnershipRevision: '2',
    currentOwnershipIntervalId: 'current', historicalOwnershipIntervalId: 'interval' }
  return { trade, owned, authority: createManualCandidateAuthority({ read: async () => owned }) }
}
describe('manual candidate UTC authority', () => {
  it('freezes ownership and display offset without claiming historical calendar proof', async () => {
    const f = setup()
    expect(await f.authority.verify(f.trade)).toEqual({ status: 'verified', evidence: { ownership: f.owned,
      timeSemantics: 'utc_trade_lifecycle', terminalDisplay: { timezoneOffsetMinutes: 180,
        source: 'collected_record_offset', historicalIntervalVerified: false } } })
  })
  it('denies revoked ownership and different historical ownership', async () => {
    const f = setup()
    expect(await createManualCandidateAuthority({ read: async () => null }).verify(f.trade)).toMatchObject({ reason: 'review_ownership_unavailable' })
    f.owned.historicalOwnershipIntervalId = 'other'
    expect(await f.authority.verify(f.trade)).toMatchObject({ reason: 'review_ownership_unavailable' })
  })
  it.each(['offset', 'cutoff', 'invalid', 'reversed'])('rejects %s time evidence', async kind => {
    const f = setup()
    if (kind === 'offset') f.trade.evidence.terminalTimezoneOffsetMinutes = 841
    if (kind === 'cutoff') f.trade.asOfUtcMsc = Date.parse(f.trade.evidence.openedAt)
    if (kind === 'invalid') f.trade.evidence.openedAt = 'invalid'
    if (kind === 'reversed') f.trade.evidence.openedAt = '2026-09-01T02:00:00.000Z'
    expect(await f.authority.verify(f.trade)).toMatchObject({ reason: 'manual_review_time_invalid' })
  })
})
