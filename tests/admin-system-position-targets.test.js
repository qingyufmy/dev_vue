import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  queryAll: vi.fn(),
  queryOne: vi.fn(),
  queryRun: vi.fn(),
  inventory: vi.fn(),
}))

vi.mock('../server/db.js', () => ({
  queryAll:mocks.queryAll, queryOne:mocks.queryOne, queryRun:mocks.queryRun,
}))
vi.mock('../server/bridge-ws.js', () => ({
  getBridgeGeneration:() => 7,
  isBridgeAlive:() => true,
}))
vi.mock('../server/routes/ai/market-data.js', () => ({ mt5Bridge:mocks.inventory }))

import {
  resolveAdminDispatchExemptions,
  resolveAdminSystemPositionTargets,
} from '../server/services/admin-system-position-targets.js'

beforeEach(() => {
  vi.clearAllMocks()
  mocks.queryAll.mockResolvedValue([])
  mocks.queryOne.mockResolvedValue(null)
  mocks.queryRun.mockResolvedValue({ affectedRows:1 })
  mocks.inventory.mockResolvedValue({
    status:'success', account:{ server:'DEMO', login:'1' },
    positions:[{ ticket:'100', symbol:'EURUSD', type:'buy', volume:0.1, magic:234000 }],
  })
})

describe('admin system position attribution', () => {
  it('fails closed when the active-target query fails', async () => {
    mocks.queryAll.mockRejectedValueOnce(new Error('db unavailable'))

    const result = await resolveAdminDispatchExemptions(7, { positions:[] })

    expect(result.status).toBe('fail_closed')
    expect(result.reason).toBe('admin_dispatch_attribution_query_unavailable')
  })

  it('does not treat stale succeeded intents without an outcome as active', async () => {
    let sql = ''
    let params = []
    mocks.queryAll.mockImplementationOnce((query, values) => {
      sql = String(query)
      params = values
      return []
    })

    const result = await resolveAdminDispatchExemptions(7, { positions:[] })

    expect(result.status).toBe('ok')
    expect(sql).toContain('DATE_SUB(NOW(), INTERVAL 2 HOUR)')
    expect(params.slice(-4)).toEqual(['preparing', 'prepared', 'bridge_sending', 'uncertain'])
  })

  it('rejects duplicate open outcome/source target attribution', async () => {
    mocks.queryOne.mockResolvedValueOnce({
      trading_account_id:10, user_id:7, broker_server:'DEMO', login_account:'1',
      ownership_history_id:9, ownership_broker_server_key:'DEMO', ownership_login_account:'1',
    })
    mocks.queryAll.mockResolvedValueOnce([
      { root_signal_id:5, signal_source:'admin_strategy_dispatch', outcome_id:11, admin_target_id:21, target_role:'source' },
      { root_signal_id:5, signal_source:'admin_strategy_dispatch', outcome_id:12, admin_target_id:22, target_role:'source' },
    ])

    await expect(resolveAdminSystemPositionTargets(7, '100'))
      .rejects.toMatchObject({ code:'admin_dispatch_attribution_ambiguous' })
  })

  it('returns safe identity and inclusion fields for targets and exclusions', async () => {
    const sourceAccount = {
      trading_account_id:10, user_id:7, broker_server:'DEMO', login_account:'1',
      ownership_history_id:9, ownership_broker_server_key:'DEMO', ownership_login_account:'1',
      account_name:'源账户',
    }
    const sourceRow = {
      root_signal_id:5, signal_source:'admin_strategy_dispatch', outcome_id:11,
      outcome_signal_id:5, outcome_status:'open', outcome_position_id:'100', outcome_system_magic:234000,
      outcome_trading_account_id:10, outcome_symbol:'EURUSD', outcome_direction:'buy', outcome_volume:0.1,
      admin_target_id:21, target_role:'source', trade_ticket:'100', standard_symbol:'EURUSD',
      broker_server_key:'DEMO', login_account:'1', dispatch_id:31, dispatch_status:'succeeded',
      user_email:'source@example.com', user_nickname:'源用户', account_name:'源账户',
    }
    const subscriberRow = {
      id:22, root_signal_id:5, signal_id:5, signal_source:'admin_strategy_dispatch',
      target_role:'subscriber', target_status:'succeeded', status:'succeeded', trade_ticket:'200',
      target_role:'subscriber', user_id:8, trading_account_id:20, dispatch_id:31,
      broker_server_key:'DEMO', login_account:'2', standard_symbol:'EURUSD', direction:'buy', volume:0.2,
      bridge_generation:7, user_email:'subscriber@example.com', user_nickname:'订阅用户', account_name:'订阅账户',
      outcome_id:12, outcome_signal_id:5, outcome_status:'open', outcome_position_id:'200',
      outcome_system_magic:234000, outcome_trading_account_id:20, outcome_symbol:'EURUSD',
      outcome_direction:'buy', outcome_volume:0.2,
    }
    mocks.queryOne
      .mockResolvedValueOnce(sourceAccount)
      .mockResolvedValueOnce({
        trading_account_id:20, user_id:8, broker_server:'DEMO', login_account:'2',
        ownership_history_id:10, ownership_broker_server_key:'DEMO', ownership_login_account:'2',
        ownership_user_id:8, ownership_trading_account_id:20,
      })
    mocks.queryAll
      .mockResolvedValueOnce([sourceRow])
      .mockResolvedValueOnce([subscriberRow])
    mocks.inventory
      .mockResolvedValueOnce({
        status:'success', account:{ server:'DEMO', login:'1' },
        positions:[{ ticket:'100', symbol:'EURUSD', type:'buy', volume:0.1, magic:234000 }],
      })
      .mockResolvedValueOnce({
        status:'success', account:{ server:'DEMO', login:'2' },
        positions:[{ ticket:'200', symbol:'EURUSD', type:'buy', volume:0.2, magic:234000 }],
      })

    const result = await resolveAdminSystemPositionTargets(7, '100')
    expect(result.targets).toEqual(expect.arrayContaining([
      expect.objectContaining({
        target_role:'source', nickname:'源用户', account_name:'源账户', email:'source@example.com',
        user_label:'源用户', login_account:'1', bridge_connected:true,
        inclusion_status:'source_only', reason_code:null,
      }),
      expect.objectContaining({
        target_role:'subscriber', nickname:'订阅用户', account_name:'订阅账户', email:'subscriber@example.com',
        user_label:'订阅用户', login_account:'2', bridge_connected:true,
        inclusion_status:'included', reason_code:null,
      }),
    ]))
    expect(result.exclusions).toEqual([])
    expect(result.summary).toEqual({
      target_count:2, eligible_target_count:2, excluded_target_count:0,
      subscriber_users:1, subscriber_positions:1,
    })

    mocks.queryOne.mockReset()
    mocks.queryOne
      .mockResolvedValueOnce(sourceAccount)
      .mockResolvedValueOnce({
        trading_account_id:20, user_id:8, broker_server:'DEMO', login_account:'2',
        ownership_history_id:10, ownership_broker_server_key:'DEMO', ownership_login_account:'2',
        ownership_user_id:8, ownership_trading_account_id:20,
      })
    mocks.queryAll.mockReset()
    mocks.queryAll
      .mockResolvedValueOnce([{ ...sourceRow, user_email:'source-changed@example.com', user_nickname:'源用户改名', account_name:'源账户改名' }])
      .mockResolvedValueOnce([{ ...subscriberRow, user_email:'subscriber-changed@example.com', user_nickname:'订阅用户改名', account_name:'订阅账户改名' }])
    mocks.inventory.mockReset()
    mocks.inventory
      .mockResolvedValueOnce({
        status:'success', account:{ server:'DEMO', login:'1' },
        positions:[{ ticket:'100', symbol:'EURUSD', type:'buy', volume:0.1, magic:234000 }],
      })
      .mockResolvedValueOnce({
        status:'success', account:{ server:'DEMO', login:'2' },
        positions:[{ ticket:'200', symbol:'EURUSD', type:'buy', volume:0.2, magic:234000 }],
      })
    const changedDisplay = await resolveAdminSystemPositionTargets(7, '100')
    expect(changedDisplay.preview_hash).toBe(result.preview_hash)
  })
})
