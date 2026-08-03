import { describe, expect, it } from 'vitest'
import {
  auditPayloadClock,
  auditTradingAccountId,
  buildAuditClockSnapshot,
} from '../../server/routes/ai/audit-clock.js'

describe('audit terminal clock evidence', () => {
  it('freezes the account, canonical UTC instant, offset, status, and source', () => {
    const snapshot = buildAuditClockSnapshot({
      request:{
        trading_account_id:17,
        mt5_timezone_offset_minutes:180,
        mt5_clock_status:'progressing_tick',
        mt5_clock_source:'bridge_v3',
      },
      createdAtUtcMsc:Date.UTC(2026, 7, 3, 8, 11, 49),
    })
    expect(snapshot).toEqual({
      trading_account_id:17,
      created_at_utc_msc:Date.UTC(2026, 7, 3, 8, 11, 49),
      terminal_timezone_offset_minutes:180,
      terminal_clock_status:'progressing_tick',
      terminal_clock_source:'bridge_v3',
    })
  })

  it('does not accept an offset without a trusted clock status', () => {
    expect(auditPayloadClock({ timezone_offset_minutes:180, clock_status:'unknown' })).toBeNull()
    expect(buildAuditClockSnapshot({ request:{ trading_account_id:9 }, createdAtUtcMsc:1 }))
      .toMatchObject({ trading_account_id:9, terminal_timezone_offset_minutes:null,
        terminal_clock_status:null, terminal_clock_source:null })
  })

  it('finds account identity in nested account evidence without guessing', () => {
    expect(auditTradingAccountId({}, { account:{ account_id:'22' } })).toBe(22)
    expect(auditTradingAccountId({}, {})).toBeNull()
  })

  it('keeps each account event bound to its own frozen DST offset', () => {
    const winter = buildAuditClockSnapshot({ request:{ trading_account_id:1,
      timezone_offset_minutes:120, clock_status:'verified' }, createdAtUtcMsc:1000 })
    const summer = buildAuditClockSnapshot({ request:{ trading_account_id:2,
      timezone_offset_minutes:180, clock_status:'verified' }, createdAtUtcMsc:1000 })
    expect(winter.terminal_timezone_offset_minutes).toBe(120)
    expect(summer.terminal_timezone_offset_minutes).toBe(180)
  })
})
