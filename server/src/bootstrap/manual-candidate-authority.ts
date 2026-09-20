import type { ManualCandidateAuthority } from '../modules/reviews/index.js'
import type { OwnedHistoryAccessReader } from '../modules/trading/index.js'

const utc = (value: string) => {
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value ? parsed : NaN
}

export function createManualCandidateAuthority(ownership: OwnedHistoryAccessReader): ManualCandidateAuthority {
  return { async verify(input) {
    const trade = structuredClone(input), e = trade.evidence
    const scope = { userId: e.userId, accountId: e.accountId, platform: e.platform,
      ownershipIntervalId: e.ownershipIntervalId, openedAt: e.openedAt, closedAt: e.closedAt }
    const owned = await ownership.read(scope)
    if (!owned || owned.userId !== e.userId || owned.accountId !== e.accountId || owned.platform !== e.platform
      || owned.historicalOwnershipIntervalId !== e.ownershipIntervalId) return { status: 'unresolved', reason: 'review_ownership_unavailable' }
    const opened = utc(e.openedAt), closed = utc(e.closedAt)
    if (![opened, closed].every(Number.isFinite) || opened > closed || closed > trade.asOfUtcMsc
      || !Number.isSafeInteger(trade.asOfUtcMsc) || !Number.isInteger(e.terminalTimezoneOffsetMinutes)
      || Math.abs(e.terminalTimezoneOffsetMinutes) > 840) {
      return { status: 'unresolved', reason: 'manual_review_time_invalid' }
    }
    return { status: 'verified', evidence: { ownership: structuredClone(owned), timeSemantics: 'utc_trade_lifecycle',
      terminalDisplay: { timezoneOffsetMinutes: e.terminalTimezoneOffsetMinutes, source: 'collected_record_offset',
        historicalIntervalVerified: false } } }
  } }
}
