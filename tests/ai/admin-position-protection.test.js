import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../server/db.js', () => ({
  beijingNow:() => '2026-07-24 12:00:00',
  logAudit:vi.fn(),
  queryAll:vi.fn(),
  queryOne:vi.fn(),
  queryRun:vi.fn(),
  withTransaction:vi.fn(),
}))

vi.mock('../../server/bridge-ws.js', () => ({
  broadcastAdminEvent:vi.fn(),
  getBridgeGeneration:vi.fn(() => 7),
  isBridgeAlive:vi.fn(() => true),
  sendBridgeCommand:vi.fn(),
  sendToAdminBrowsers:vi.fn(),
}))

vi.mock('../../server/routes/ai/market-data.js', () => ({ mt5Bridge:vi.fn() }))

import {
  completePositionProtectionTarget,
  executePositionProtectionTarget,
  getPositionProtectionPreview,
  normalizeProtectionInput,
  processPositionProtectionJob,
  SYSTEM_POSITION_MAGIC,
} from '../../server/routes/admin-position-protection.js'
import { isBridgeAlive, sendBridgeCommand, sendToAdminBrowsers } from '../../server/bridge-ws.js'
import { queryAll, queryOne, queryRun } from '../../server/db.js'
import { mt5Bridge } from '../../server/routes/ai/market-data.js'

const sourceOutcome = {
  id:41,
  signal_id:9001,
  user_id:1,
  trading_account_id:11,
  position_id:'70001',
  entry_order_ticket:'70001',
  system_magic:SYSTEM_POSITION_MAGIC,
  symbol:'XAUUSD.s',
  original_symbol:'XAUUSD.s',
  entry_direction:'buy',
  expected_volume:0.1,
  nickname:'管理员',
  email:'admin@example.com',
}

beforeEach(() => {
  vi.clearAllMocks()
  isBridgeAlive.mockReturnValue(true)
  mt5Bridge.mockResolvedValue({
    status:'success',
    account:{ login:10001, server:'Broker-Demo' },
    positions:[{
      ticket:70001, symbol:'XAUUSD.s', type:'buy', volume:0.1,
      sl:4010, tp:4100, magic:SYSTEM_POSITION_MAGIC,
    }],
  })
  queryOne.mockResolvedValue({
    trading_account_id:11,
    user_id:1,
    margin_mode:'hedging',
    ownership_history_id:101,
    broker_server_key:'BROKER-DEMO',
    login_account:'10001',
    account_name:'源账户',
  })
})

describe('admin position protection', () => {
  it('requires a positive protection price and an auditable reason', () => {
    expect(() => normalizeProtectionInput({ reason:'调整' })).toThrow('protection_price_required')
    expect(() => normalizeProtectionInput({ stop_loss:0, reason:'调整' })).toThrow('invalid_stop_loss')
    expect(() => normalizeProtectionInput({ stop_loss:4020, reason:'a' })).toThrow('change_reason_required')
    expect(normalizeProtectionInput({ stop_loss:'4020.5', take_profit:'', sync_scope:'signal', reason:'结构失效调整' }))
      .toEqual({ stopLoss:4020.5, takeProfit:null, syncScope:'signal', reason:'结构失效调整' })
  })

  it('keeps an unattributed system position editable only at source scope', async () => {
    queryAll.mockResolvedValueOnce([])
    const preview = await getPositionProtectionPreview(1, '70001')
    expect(preview.sync_available).toBe(false)
    expect(preview.affected_users).toBe(1)
    expect(preview.affected_positions).toBe(1)
    expect(preview.source.magic).toBe(SYSTEM_POSITION_MAGIC)
    expect(preview.targets[0]).toMatchObject({
      is_source:true, ticket:'70001', user_id:1,
      account_name:'源账户', user_label:'源账户',
      login_account:'10001', bridge_connected:true,
      inclusion_status:'source_only', reason_code:null,
    })
  })

  it('resolves all uniquely attributed positions from the same signal', async () => {
    const follower = {
      id:42,
      signal_id:9001,
      user_id:2,
      trading_account_id:22,
      position_id:'80002',
      system_magic:SYSTEM_POSITION_MAGIC,
      symbol:'XAUUSD.c',
      original_symbol:'XAUUSD.c',
      entry_direction:'buy',
      expected_volume:0.2,
      current_ownership_history_id:202,
      current_broker_server_key:'BROKER-LIVE',
      current_login_account:'20002',
      position_source_count:1,
      nickname:'跟随用户',
      email:'follower@example.com',
      account_name:'跟随账户',
    }
    queryAll
      .mockResolvedValueOnce([sourceOutcome])
      .mockResolvedValueOnce([
        { ...sourceOutcome, current_ownership_history_id:101, current_broker_server_key:'BROKER-DEMO',
          current_login_account:'10001', position_source_count:1 },
        follower,
      ])
    const preview = await getPositionProtectionPreview(1, '70001', { syncScope:'signal' })
    expect(preview.sync_available).toBe(true)
    expect(preview.affected_users).toBe(2)
    expect(preview.affected_positions).toBe(2)
    expect(preview.targets.map(item => item.ticket)).toEqual(['70001', '80002'])
    expect(preview.targets[1]).toMatchObject({
      nickname:'跟随用户', account_name:'跟随账户', email:'follower@example.com',
      user_label:'跟随用户', login_account:'20002', bridge_connected:true,
      inclusion_status:'included', reason_code:null,
    })
    expect(preview.exclusions).toEqual([])
  })

  it('exposes identity and reason for a multiple-position-source exclusion', async () => {
    const duplicate = {
      ...sourceOutcome,
      id:52,
      user_id:2,
      trading_account_id:22,
      position_id:'80002',
      current_ownership_history_id:202,
      current_broker_server_key:'BROKER-LIVE',
      current_login_account:'20002',
      nickname:'重复来源用户',
      email:'duplicate@example.com',
      account_name:'重复来源账户',
      position_source_count:2,
    }
    queryAll
      .mockResolvedValueOnce([sourceOutcome])
      .mockResolvedValueOnce([duplicate])
    const preview = await getPositionProtectionPreview(1, '70001', { syncScope:'signal' })
    expect(preview.exclusions).toEqual([expect.objectContaining({
      user_id:2, trading_account_id:22, ticket:'80002',
      nickname:'重复来源用户', account_name:'重复来源账户', email:'duplicate@example.com',
      user_label:'重复来源用户', login_account:'20002', bridge_connected:true,
      inclusion_status:'excluded', reason_code:'multiple_position_sources',
      reason:'multiple_position_sources',
    })])
  })

  it('does not include display identity fields in the preview hash', async () => {
    const sourceA = { ...sourceOutcome, nickname:'管理员 A', email:'a@example.com' }
    const followerA = {
      ...sourceOutcome, id:42, user_id:2, trading_account_id:22, position_id:'80002',
      current_ownership_history_id:202, current_broker_server_key:'BROKER-LIVE', current_login_account:'20002',
      position_source_count:1, nickname:'跟随 A', email:'follower-a@example.com', account_name:'账户 A',
    }
    const sourceB = { ...sourceA, nickname:'管理员 B', email:'b@example.com', account_name:'账户 B' }
    const followerB = { ...followerA, nickname:'跟随 B', email:'follower-b@example.com', account_name:'账户 C' }
    queryAll
      .mockResolvedValueOnce([sourceA])
      .mockResolvedValueOnce([sourceA, followerA])
      .mockResolvedValueOnce([sourceB])
      .mockResolvedValueOnce([sourceB, followerB])
    const first = await getPositionProtectionPreview(1, '70001', { syncScope:'signal' })
    const second = await getPositionProtectionPreview(1, '70001', { syncScope:'signal' })
    expect(second.preview_hash).toBe(first.preview_hash)
  })

  it('fails closed when the source position maps to multiple outcomes', async () => {
    queryAll.mockResolvedValueOnce([sourceOutcome, { ...sourceOutcome, id:43, signal_id:9002 }])
    await expect(getPositionProtectionPreview(1, '70001', { syncScope:'signal' }))
      .rejects.toThrow('multiple_source_signals')
  })

  it('executes only changed fields and keeps the confirmed source snapshot as the write precondition', async () => {
    mt5Bridge.mockResolvedValueOnce({
      status:'success', account:{ login:'10001', server:'Broker-Demo' },
      positions:[{ ticket:'70001', symbol:'XAUUSD.s', type:'buy', volume:0.1,
        sl:4025, tp:4100, magic:SYSTEM_POSITION_MAGIC }],
    })
    sendBridgeCommand.mockResolvedValueOnce({ status:'success', ticket:'70001', stop_loss:4025, take_profit:4120 })
    await executePositionProtectionTarget(
      { id:71, requested_stop_loss:null, requested_take_profit:4120 },
      { id:81, user_id:1, is_source:1, attempt_count:0, ticket:'70001', symbol:'XAUUSD.s',
        direction:'buy', volume:0.1, broker_server_key:'BROKER-DEMO', login_account:'10001',
        expected_stop_loss:4010, expected_take_profit:4100 },
    )
    expect(sendBridgeCommand).toHaveBeenCalledWith(1, 'modify_system_position_protection', expect.objectContaining({
      ticket:'70001', stop_loss:null, take_profit:4120,
      expected_state:expect.objectContaining({ stop_loss:4010, take_profit:4100 }),
    }), expect.any(Number), expect.any(Object))
  })

  it('updates the authorization baseline for every open outcome tied to the physical position', async () => {
    queryOne
      .mockResolvedValueOnce({ succeeded:1, failed:0, skipped:0, pending:0 })
      .mockResolvedValueOnce({ id:71, status:'running', total_positions:1, succeeded_positions:1,
        failed_positions:0, skipped_positions:0, pending_positions:0 })
    queryRun.mockResolvedValue({ changes:1 })
    await completePositionProtectionTarget(
      { id:71, actor_user_id:1 },
      { id:81, user_id:1, trading_account_id:11, ticket:'70001' },
      'succeeded',
      { result:{ ticket:'70001', stop_loss:4020, take_profit:4120 } },
    )
    const baselineUpdate = queryRun.mock.calls.find(([sql]) => sql.includes('UPDATE signal_outcomes SET actual_stop_loss'))
    expect(baselineUpdate?.[0]).toContain('(position_id = ? OR entry_order_ticket = ?)')
    expect(baselineUpdate?.[1].slice(-2)).toEqual(['70001', '70001'])
    expect(sendToAdminBrowsers).toHaveBeenCalledWith(expect.objectContaining({
      type:'position_protection_target_updated', job_id:71,
    }))
  })

  it('stops fanout after a source write failure and marks untouched followers as skipped', async () => {
    const sourceTarget = { id:81, user_id:1, trading_account_id:11, is_source:1,
      ticket:'70001', symbol:'XAUUSD.s', direction:'buy', volume:0.1,
      broker_server_key:'BROKER-DEMO', login_account:'10001', status:'pending' }
    const followerTarget = { id:82, user_id:2, trading_account_id:22, is_source:0,
      ticket:'80002', symbol:'XAUUSD.c', direction:'buy', volume:0.2,
      broker_server_key:'BROKER-LIVE', login_account:'20002', status:'pending' }
    queryAll.mockImplementation(async sql => {
      if (sql.includes("status = 'pending'")) return [sourceTarget, followerTarget]
      if (sql.includes('FROM admin_position_protection_targets targets')) return [sourceTarget, followerTarget]
      return []
    })
    queryOne.mockImplementation(async sql => {
      if (sql.includes('SELECT * FROM admin_position_protection_jobs')) return {
        id:71, status:'failed', source_ticket:'70001', sync_scope:'signal', total_positions:2,
        succeeded_positions:0, failed_positions:1, skipped_positions:1, pending_positions:0,
      }
      return { succeeded:0, failed:1, skipped:1, pending:0 }
    })
    queryRun.mockResolvedValue({ changes:1 })
    sendBridgeCommand.mockResolvedValueOnce({ status:'rejected', message:'position_stop_loss_changed' })
    await processPositionProtectionJob({
      id:71, actor_user_id:1, requested_stop_loss:4020, requested_take_profit:null,
    })
    expect(sendBridgeCommand).toHaveBeenCalledTimes(1)
    expect(queryRun.mock.calls.some(([sql, params]) => sql.includes("SET status = 'skipped'")
      && params.includes('source_position_update_failed'))).toBe(true)
    expect(queryRun.mock.calls.some(([sql, params]) => sql.includes('completed_at = ?')
      && params.includes('failed'))).toBe(true)
  })
})
