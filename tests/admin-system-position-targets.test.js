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
})
