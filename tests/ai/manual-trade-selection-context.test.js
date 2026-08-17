import { describe, expect, it, vi } from 'vitest'

vi.mock('../../server/config.js', () => ({ JWT_SECRET:'manual-review-test-secret' }))

import { createManualTradeSelectionContext, verifyManualTradeSelectionContext } from '../../server/routes/ai/manual-trade-selection-context.js'

const context = (overrides = {}) => ({
  userId:7, tradingAccountId:12, platform:'mt5',
  rangeStartUtcMsc:1_700_000_000_000, rangeEndUtcMsc:1_700_604_800_000,
  historySnapshotId:'snapshot-1', nowUtcMsc:1_700_000_001_000, ttlMsc:900_000,
  ...overrides,
})

describe('manual trade review selection context', () => {
  it('issues and verifies a context bound to user, account, platform, range and snapshot', () => {
    const token = createManualTradeSelectionContext(context())
    expect(verifyManualTradeSelectionContext(token, context())).toMatchObject({
      contract:'manual-trade-selection-v1', user_id:7, trading_account_id:12, platform:'mt5',
      range_start_utc_msc:1_700_000_000_000, range_end_utc_msc:1_700_604_800_000,
      history_snapshot_id:'snapshot-1', expires_at_utc_msc:1_700_000_901_000,
    })
  })

  it('rejects a changed signature, user, account or platform', () => {
    const token = createManualTradeSelectionContext(context())
    const [encoded, signature] = token.split('.')
    const changed = `${encoded.slice(0, -1)}${encoded.at(-1) === 'A' ? 'B' : 'A'}.${signature}`
    expect(() => verifyManualTradeSelectionContext(changed, context())).toThrow('manual_trade_review_selection_context_invalid')
    expect(() => verifyManualTradeSelectionContext(token, context({ userId:8 }))).toThrow('manual_trade_review_selection_context_mismatch')
    expect(() => verifyManualTradeSelectionContext(token, context({ tradingAccountId:13 }))).toThrow('manual_trade_review_selection_context_mismatch')
    expect(() => verifyManualTradeSelectionContext(token, context({ platform:'mt4' }))).toThrow('manual_trade_review_selection_context_mismatch')
  })

  it('rejects an expired context and accepts time progression inside its TTL', () => {
    const token = createManualTradeSelectionContext(context())
    expect(() => verifyManualTradeSelectionContext(token, context({ nowUtcMsc:1_700_000_899_999 }))).not.toThrow()
    expect(() => verifyManualTradeSelectionContext(token, context({ nowUtcMsc:1_700_000_901_000 })))
      .toThrow('manual_trade_review_selection_context_expired')
  })
})
