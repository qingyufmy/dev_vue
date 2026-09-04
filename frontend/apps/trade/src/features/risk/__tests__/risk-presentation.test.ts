import { describe, expect, it } from 'vitest'
import { riskPolicySchema, riskSummarySchema } from '@aurum/contracts'
import { availabilityLabel, formatDecimal, ratio, releaseRuleLabel, riskState } from '../model/risk-presentation'

const policy = riskPolicySchema.parse({
  account_id: '7', platform_policy_version_id: 'platform-1', account_policy_version_id: 'account-policy-1', global_kill_switch: false,
  allowed_symbols: ['XAUUSD'], fail_closed_on_incomplete_data: true, max_quote_age_seconds: 5, max_risk_summary_age_seconds: 10,
  max_decision_age_seconds: 20, max_price_deviation_percent: '0.30', manual_release_enabled: true,
  manual_release_max_daily_loss_percent: '8.00', manual_release_max_drawdown_percent: '12.00', manual_release_max_daily_open_count: 20,
  manual_release_consecutive_loss_limit: 8, max_risk_per_trade_percent: '1.00', max_daily_loss_percent: '4.00', max_drawdown_percent: '7.00',
  max_open_positions: 4, max_pending_orders: 4, max_total_volume: '2.00', max_spread_points: '50.0', min_open_interval_seconds: 300,
  max_daily_open_count: 8, consecutive_loss_limit: 3, loss_cooldown_minutes: 30, pending_valid_minutes: 60, weekend_close_minutes: 30,
  trade_send_enabled: true, account_kill_switch: false, require_stop_loss: true,
  editable_fields: ['max_daily_loss_percent', 'account_kill_switch'], revision: '2', updated_at: '2026-09-04T08:00:00.000Z',
})

function summary(overrides: Record<string, unknown> = {}) {
  return riskSummarySchema.parse({
    account_id: '7', business_date: '2026-09-04', equity: '10000.00', free_margin: '9000.00', margin_level_percent: '500.00',
    daily_loss_percent: '1.00', drawdown_percent: '2.00', open_positions: 1, pending_orders: 0, total_volume: '0.10', daily_open_count: 2,
    consecutive_losses: 0, terminal_timezone_offset_minutes: 180, clock_status: 'calibrated', last_successful_open_at: null, cooldown_until: null,
    data_complete: true, incomplete_reasons: [], observed_at: '2026-09-04T08:00:00.000Z', revision: '4', ...overrides,
  })
}

describe('risk presentation', () => {
  it('marks a complete account below every limit as healthy', () => {
    expect(riskState(policy, summary())).toMatchObject({ level: 'healthy', title: '风险状态正常', reasons: [] })
  })

  it('surfaces every active blocking reason without hiding the primary cause', () => {
    const result = riskState({ ...policy, accountKillSwitch: true }, summary({ daily_loss_percent: '4.50', data_complete: false, incomplete_reasons: ['history'] }))
    expect(result.level).toBe('blocked')
    expect(result.reasons).toEqual(expect.arrayContaining(['账户已手动暂停交易', '风险数据不完整', '触及当日亏损限制']))
  })

  it('caps progress and provides readable deterministic labels', () => {
    expect(ratio('9', '4')).toBe(100)
    expect(ratio('2', '4')).toBe(50)
    expect(formatDecimal('1.2')).toBe('1.20')
    expect(releaseRuleLabel('RISK_DRAWDOWN_LIMIT')).toBe('账户回撤限制')
    expect(availabilityLabel('risk_manual_release_platform_limit')).toContain('平台硬限制')
  })
})
