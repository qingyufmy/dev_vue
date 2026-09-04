import { describe, expect, it } from 'vitest'
import { traderDecisionDetailSchema } from '@aurum/contracts'
import {
  actionLabel,
  clockStatusLabel,
  actionParameterRecords,
  decisionStatusLabel,
  expectedStateRecords,
  formatDecimal,
  formatDateTime,
  formatPrice,
  formatNullable,
  orderTypeLabel,
  pnlClass,
  readableValue,
  sideLabel,
  sourceLabel,
  statusLabel,
} from '../model/trader-presentation'

describe('trader presentation', () => {
  it('renders nullish values as a readable placeholder', () => {
    expect(formatNullable(null)).toBe('--')
    expect(formatNullable(undefined)).toBe('--')
    expect(formatNullable('')).toBe('--')
    expect(formatPrice(null)).toBe('--')
    expect(formatDecimal('0.1', 2)).toBe('0.10')
    expect(formatPrice('1.08765')).toBe('1.08765')
  })

  it('maps action, status, side, order type, and source to Chinese labels', () => {
    expect(actionLabel('market_order')).toBe('市价单')
    expect(actionLabel('modify_position')).toBe('修改持仓')
    expect(decisionStatusLabel('risk_rejected')).toBe('风控拒绝')
    expect(statusLabel('uncertain')).toBe('待核实')
    expect(sideLabel('buy')).toBe('买入')
    expect(orderTypeLabel('sell_stop_limit')).toBe('卖出止损限价')
    expect(sourceLabel('signal')).toBe('AI 信号')
    expect(clockStatusLabel('calibrated')).toBe('已校准')
    expect(actionLabel('future_action')).toContain('未识别')
  })

  it('uses semantic profit classes and preserves zero as neutral', () => {
    expect(pnlClass('12.40')).toBe('text-trade-up')
    expect(pnlClass('-0.20')).toBe('text-trade-down')
    expect(pnlClass('0')).toBe('text-foreground')
    expect(pnlClass(null)).toBe('text-muted-foreground')
  })

  it('formats timestamps without exposing an invalid placeholder for valid dates', () => {
    expect(formatDateTime('2026-09-04T08:00:00.000Z')).toMatch(/^\d{2}\/\d{2}/)
    expect(formatDateTime('2026-09-04T08:00:00.000Z', 180)).toContain('11:00:00')
    expect(formatDateTime('not-a-date')).toBe('not-a-date')
  })

  it('serializes generic action parameters safely and readably', () => {
    const detail = traderDecisionDetailSchema.parse({
      summary: {
        decision_id: 'decision-1', analysis_id: 'analysis-1', trading_account_id: 'account-1',
        strategy_id: 'strategy-1', strategy_version_id: 'version-1', action: 'market_order', side: 'buy',
        confidence: 74, summary: '满足执行条件', status: 'proposed', created_at: '2026-09-04T08:00:00.000Z', revision: '1',
      },
      actions: [{
        action_id: 'action-1', kind: 'market_order',
        parameters: { volume: '0.10', stop_loss: null, nested: ['x', 1] },
        expected_state: { position: { side: 'buy' }, ticket: null },
      }],
      reasoning: '依据完整快照判断',
      input_snapshot_hash: 'a'.repeat(64),
    })
    const action = detail.actions.at(0)
    expect(action).toBeDefined()
    if (!action) return
    expect(actionParameterRecords(action)).toEqual([
      { key: 'volume', label: '手数', value: '0.10' },
      { key: 'stop_loss', label: '止损价', value: '--' },
      { key: 'nested', label: 'nested', value: '["x",1]' },
    ])
    expect(expectedStateRecords(action)).toEqual([
      { key: 'position', label: 'position', value: '{"side":"buy"}' },
      { key: 'ticket', label: '订单号', value: '--' },
    ])
    expect(readableValue({ '<script>': 'not-html' })).toBe('{"<script>":"not-html"}')
  })
})
