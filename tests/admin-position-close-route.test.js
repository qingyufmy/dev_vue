import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  queryAll:vi.fn(), queryOne:vi.fn(), queryRun:vi.fn(), withTransaction:vi.fn(),
  resolvePreview:vi.fn(), logAudit:vi.fn(),
  state:{ existing:null, job:null, targets:[], failed:[{ id:2 }], transactionSql:[] },
}))

vi.mock('../server/db.js', () => ({
  beijingNow:() => '2026-08-14 12:00:00',
  queryAll:mocks.queryAll, queryOne:mocks.queryOne, queryRun:mocks.queryRun,
  withTransaction:mocks.withTransaction, logAudit:mocks.logAudit,
}))
vi.mock('../server/middleware/auth.js', () => ({
  authMiddleware:(req, res, next) => next(), adminOnly:(req, res, next) => next(),
}))
vi.mock('../server/services/admin-system-position-targets.js', () => ({
  ADMIN_SYSTEM_POSITION_MAGIC:234000,
  ADMIN_SYSTEM_POSITION_SOURCE:'admin_strategy_dispatch',
  resolveAdminSystemPositionTargets:mocks.resolvePreview,
}))

import {
  createAdminPositionCloseJob,
  retryFailedAdminPositionCloseJob,
} from '../server/routes/admin-position-close.js'

const source = {
  id:21, target_role:'source', is_source:true, eligible:true, user_id:7,
  trading_account_id:10, ownership_history_id:9, outcome_id:31, signal_id:5,
  broker_server_key:'DEMO', login_account:'1', ticket:'100', symbol:'EURUSD',
  direction:'buy', volume:0.1, magic:234000, bridge_generation:7,
  user_snapshot:{ id:7 }, account_snapshot:{ id:10 }, ownership_snapshot:{ id:9 },
  outcome_snapshot:{ id:31, status:'open' }, target_snapshot:{},
}
const subscriber = { ...source, id:22, target_role:'subscriber', is_source:false, user_id:8, trading_account_id:20, ticket:'200' }

function jobRow(overrides = {}) {
  return {
    id:42, idempotency_key:'close-42', actor_user_id:7, source_signal_id:5,
    source_ticket:'100', source_user_id:7, source_trading_account_id:10,
    source_symbol:'EURUSD', source_direction:'buy', source_volume:0.1, source_magic:234000,
    reason:'weekly close', preview_hash:'preview-hash', status:'partial', target_count:2,
    eligible_target_count:2, succeeded_target_count:1, failed_target_count:1,
    skipped_target_count:0, uncertain_target_count:0, ...overrides,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.state.existing = null
  mocks.state.job = jobRow({ status:'queued', succeeded_target_count:0, failed_target_count:0 })
  mocks.state.targets = [source, subscriber].map((target, index) => ({
    ...target, id:index + 1, target_order:index, status:'pending', operation_id:`admin-position-close:42:${index + 1}`,
    attempt_count:0, last_result_json:null,
  }))
  mocks.state.failed = [{ id:2 }]
  mocks.state.transactionSql = []
  mocks.resolvePreview.mockResolvedValue({
    ok:true, source, source_signal_id:5, source_ticket:'100', preview_hash:'preview-hash',
    targets:[subscriber, source], exclusions:[],
  })
  mocks.queryOne.mockImplementation(async sql => {
    const query = String(sql)
    if (query.includes('idempotency_key')) return mocks.state.existing
    if (query.includes('FROM admin_position_close_jobs')) return mocks.state.job
    return null
  })
  mocks.queryAll.mockImplementation(async sql => {
    const query = String(sql)
    if (query.includes('SELECT id FROM admin_position_close_targets')) return mocks.state.failed
    if (query.includes('FROM admin_position_close_targets')) return mocks.state.targets
    return []
  })
  mocks.queryRun.mockResolvedValue({ affectedRows:1 })
  mocks.withTransaction.mockImplementation(async callback => callback(async (sql, params = []) => {
    const query = String(sql)
    mocks.state.transactionSql.push(query)
    if (query.includes('SELECT id, actor_user_id')) return [[], []]
    if (query.includes('INSERT INTO admin_position_close_jobs')) {
      mocks.state.job = jobRow({ status:'queued', idempotency_key:params[0], preview_hash:params[11], target_count:params[12], eligible_target_count:params[13] })
      return [{ insertId:42 }, []]
    }
    if (query.includes('INSERT INTO admin_position_close_targets')) return [{ insertId: Number(mocks.state.targets.length + 1) }, []]
    return [{ affectedRows:1 }, []]
  }))
})

describe('admin position close routes', () => {
  it('creates a frozen job only after the preview hash and keeps idempotency stable', async () => {
    const body = { source_ticket:'100', reason:'weekly close', preview_hash:'preview-hash', idempotency_key:'close-42' }

    const first = await createAdminPositionCloseJob(7, body)
    expect(first.id).toBe(42)
    expect(mocks.resolvePreview).toHaveBeenCalledTimes(1)
    expect(mocks.withTransaction).toHaveBeenCalled()

    mocks.state.existing = { id:42, actor_user_id:7 }
    const second = await createAdminPositionCloseJob(7, body)
    expect(second.id).toBe(42)
    expect(mocks.resolvePreview).toHaveBeenCalledTimes(1)
  })

  it('retries failed targets only and leaves succeeded targets terminal', async () => {
    mocks.state.job = jobRow({ status:'partial' })
    mocks.state.targets = [
      { ...source, id:1, status:'succeeded', operation_id:'admin-position-close:42:1', attempt_count:1 },
      { ...subscriber, id:2, status:'failed', operation_id:'admin-position-close:42:2', attempt_count:1, error_code:'bridge_error' },
    ]

    const result = await retryFailedAdminPositionCloseJob(7, 42, { preview_hash:'preview-hash' })

    expect(result.id).toBe(42)
    expect(mocks.resolvePreview).toHaveBeenCalledTimes(1)
    expect(mocks.withTransaction).toHaveBeenCalled()
    expect(mocks.state.transactionSql.some(sql => sql.includes("SET status = 'pending'") && sql.includes("status = 'failed'"))).toBe(true)
    expect(mocks.state.transactionSql.some(sql => sql.includes("SET status = 'queued'") && sql.includes('preview_hash'))).toBe(true)
  })
})
