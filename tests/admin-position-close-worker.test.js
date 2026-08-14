import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => {
  const state = { targetStatuses:{ 1:'pending', 2:'pending' }, claimTargetChanges:1 }
  const queryAll = vi.fn()
  const queryOne = vi.fn()
  const queryRun = vi.fn(async () => ({ changes:1 }))
  const withTransaction = vi.fn(async callback => callback(async (sql, params = []) => {
    if (sql.includes('SELECT * FROM admin_position_close_targets')) {
      const id = Number(params[0])
      const source = id === 1
      return [[{
        id, job_id:1, target_role:source ? 'source' : 'subscriber',
        user_id:source ? 1 : 2, trading_account_id:source ? 10 : 20,
        status:state.targetStatuses[id], ticket:source ? '100' : '200', symbol:'EURUSD', direction:'buy', volume:0.1,
        magic:234000, broker_server_key:'DEMO', login_account:source ? '1' : '2',
        operation_id:`admin-position-close:1:${id}`, lease_token:null,
      }], []]
    }
    return [{ affectedRows:state.claimTargetChanges }, []]
  }))
  return {
    state, queryAll, queryOne, queryRun, withTransaction,
    sendBridgeCommand:vi.fn(), validateTarget:vi.fn(),
    inventoryExpectedState:vi.fn(position => ({ ticket:String(position.ticket), symbol:position.symbol, direction:'buy', volume:Number(position.volume), magic:234000 })),
    acquireLock:vi.fn(async () => ({ key:'delivery_inventory:1:EURUSD', token:'lock' })),
    releaseLock:vi.fn(async () => true),
  }
})

const { state, queryAll, queryOne, queryRun, withTransaction, sendBridgeCommand, validateTarget, inventoryExpectedState, acquireLock, releaseLock } = mocks

vi.mock('../server/db.js', () => ({ beijingNow:() => '2026-08-14 12:00:00', beijingAfter:() => '2026-08-14 12:02:00', queryAll:mocks.queryAll, queryOne:mocks.queryOne, queryRun:mocks.queryRun, withTransaction:mocks.withTransaction }))
vi.mock('../server/bridge-ws.js', () => ({ sendBridgeCommand:mocks.sendBridgeCommand, getBridgeGeneration:() => 7, isBridgeAlive:() => true }))
vi.mock('../server/routes/ai/market-data.js', () => ({ mt5Bridge:vi.fn() }))
vi.mock('../server/services/admin-system-position-targets.js', () => ({
  ADMIN_SYSTEM_POSITION_MAGIC:234000,
  validateAdminSystemPositionTarget:(...args) => mocks.validateTarget(...args),
  inventoryExpectedState:(...args) => mocks.inventoryExpectedState(...args),
}))
vi.mock('../server/services/account-symbol-inventory-lock.js', () => ({
  acquireAccountSymbolInventoryLock:(...args) => mocks.acquireLock(...args),
  releaseAccountSymbolInventoryLock:(...args) => mocks.releaseLock(...args),
}))

import { executeAdminPositionCloseTarget, __adminPositionCloseWorkerTest } from '../server/workers/admin-position-close-worker.js'

const source = { id:1, job_id:1, target_role:'source', user_id:1, trading_account_id:10, status:'pending', ticket:'100', symbol:'EURUSD', direction:'buy', volume:0.1, magic:234000, broker_server_key:'DEMO', login_account:'1', operation_id:'admin-position-close:1:1' }

beforeEach(() => {
  vi.clearAllMocks()
  state.targetStatuses = { 1:'pending', 2:'pending' }
  state.claimTargetChanges = 1
  validateTarget.mockResolvedValue({ ok:true, generation:7, position:{ ticket:'100', symbol:'EURUSD', type:'buy', volume:0.1, magic:234000 } })
  sendBridgeCommand.mockResolvedValue({ status:'success', acknowledged:true })
  queryOne.mockResolvedValue({ succeeded:2, failed:0, skipped:0, uncertain:0 })
  queryAll.mockResolvedValue([])
})

describe('admin system position close worker', () => {
  it('requires inventory disappearance after an ACK and never resends uncertain targets', async () => {
    validateTarget.mockResolvedValueOnce({ ok:true, generation:7, position:{ ticket:'100', symbol:'EURUSD', type:'buy', volume:0.1, magic:234000 } })
      .mockResolvedValueOnce({ ok:true, generation:7, position:{ ticket:'100', symbol:'EURUSD', type:'buy', volume:0.1, magic:234000 } })
    const first = await executeAdminPositionCloseTarget(source)
    expect(first.status).toBe('uncertain')
    expect(sendBridgeCommand).toHaveBeenCalledTimes(1)
    state.targetStatuses[1] = 'uncertain'
    validateTarget.mockResolvedValueOnce({ ok:false, reason:'position_not_found' })
    const reconciled = await executeAdminPositionCloseTarget({ ...source, status:'uncertain' })
    expect(reconciled.status).toBe('succeeded')
    expect(sendBridgeCommand).toHaveBeenCalledTimes(1)
  })

  it('executes subscribers before the source target', async () => {
    queryAll.mockResolvedValueOnce([
      { ...source, id:2, target_role:'subscriber', user_id:2, trading_account_id:20, ticket:'200', login_account:'2' },
      { ...source, id:1, target_role:'source', user_id:1, trading_account_id:10, ticket:'100', login_account:'1' },
    ])
    let validationCalls = 0
    validateTarget.mockImplementation(async target => {
      validationCalls += 1
      return validationCalls % 2 === 1
        ? { ok:true, generation:7, position:{ ticket:target.ticket, symbol:'EURUSD', type:'buy', volume:0.1, magic:234000 } }
        : { ok:false, reason:'position_not_found' }
    })
    const users = []
    sendBridgeCommand.mockImplementation(async userId => { users.push(Number(userId)); return { status:'success' } })
    queryOne.mockResolvedValue({ succeeded:2, failed:0, skipped:0, uncertain:0 })
    const result = await __adminPositionCloseWorkerTest.processCloseJob({ id:1, lease_token:'job-lease' })
    expect(result.status).toBe('completed')
    expect(users).toEqual([2, 1])
  })

  it('stops without sending when job lease renewal is lost', async () => {
    queryAll.mockResolvedValueOnce([source])
    queryRun.mockImplementation(async sql => String(sql).includes('lease_expires_at') ? { changes:0 } : { changes:1 })
    const result = await __adminPositionCloseWorkerTest.processCloseJob({ id:1, lease_token:'expired-job' })
    expect(result.status).toBe('lease_lost')
    expect(sendBridgeCommand).not.toHaveBeenCalled()
  })

  it('fences target writes with the claimed lease token', async () => {
    queryRun.mockResolvedValue({ changes:0 })
    const result = await __adminPositionCloseWorkerTest.markTarget({ ...source, lease_token:'stale-target-lease' }, 'failed', {
      error_code:'stale_lease',
    })
    expect(result).toBe(false)
    expect(queryRun.mock.calls.some(call => String(call[0]).includes('lease_token'))).toBe(true)
  })
})
