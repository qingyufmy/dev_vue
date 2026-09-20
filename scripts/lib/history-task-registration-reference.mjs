import { createMysqlHistoryRangeRequester } from '../../server/dist-v4/modules/trade-history/composition.js'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { registerHistoryCollectionTask } from '../../server/dist-v4/modules/trade-history/infrastructure/mysql-history-task-registration.js'
import { historyTransaction } from '../../server/dist-v4/modules/trade-history/infrastructure/history-transaction.js'
import { createAccountInventorySummaryReader } from '../../server/dist-v4/modules/trading/composition.js'

export async function verifyHistoryTaskRegistrationReference(connection, pool, now, inject) {
  const [[identity]] = await connection.query('SELECT DATABASE() db')
  assert.match(identity.db, /^dev_vue_history_ref_[a-f0-9]{32}$/)
  const [active] = await connection.query('SELECT id FROM history_collection_tasks_v4 WHERE active_account_id=5')
  assert.equal(active.length, 1)
  await connection.execute(`UPDATE history_collection_tasks_v4 SET status='failed',lease_token=NULL,lease_expires_at_utc=NULL,
    completed_at_utc=UTC_TIMESTAMP(3),error_code='reference_end' WHERE id=?`, [active[0].id])
  const request = { taskId: randomUUID(), accountId: '5', rangeStartUtcMsc: now.getTime()-10000, rangeEndUtcMsc: now.getTime() }
  const register = value => historyTransaction(pool, c => registerHistoryCollectionTask(c, createAccountInventorySummaryReader(c), value, now))
  const count = async () => {
    const [[tasks]] = await connection.query('SELECT COUNT(*) n FROM history_collection_tasks_v4')
    const [[events]] = await connection.query("SELECT COUNT(*) n FROM outbox_events WHERE event_type='trade.history.task.requested'")
    return [Number(tasks.n), Number(events.n)]
  }
  const before = await count(), checks = []
  inject('outbox-before-commit')
  await assert.rejects(register(request), { message: 'injected_precommit_failure' })
  assert.deepEqual(await count(), before)
  checks.push('actual-account-lock-task-and-outbox-rollback-together')
  inject('commit-ack')
  await assert.rejects(register(request), { message: 'trade_history_commit_unknown' })
  assert.deepEqual(await count(), [before[0]+1, before[1]+1])
  assert.deepEqual(await register(request), { taskId: request.taskId, created: false })
  assert.deepEqual(await count(), [before[0]+1, before[1]+1])
  checks.push('committed-registration-recovered-without-second-task-or-event')
  await assert.rejects(register({ ...request, rangeStartUtcMsc: request.rangeStartUtcMsc-1 }), { message: 'history_task_registration_conflict' })
  await connection.beginTransaction()
  await connection.execute('DELETE FROM outbox_events WHERE event_id=?', [request.taskId])
  await assert.rejects(registerHistoryCollectionTask(connection, createAccountInventorySummaryReader(connection), request, now), { message: 'history_task_registration_incomplete' })
  await connection.rollback()
  checks.push('changed-window-and-missing-event-rejected')
  await connection.execute(`UPDATE history_collection_tasks_v4 SET status='failed',completed_at_utc=UTC_TIMESTAMP(3),error_code='reference_end' WHERE id=?`, [request.taskId])
  const left = { ...request, taskId: randomUUID() }, right = { ...request, taskId: randomUUID(), rangeStartUtcMsc: request.rangeStartUtcMsc-1 }
  const concurrent = await Promise.all([register(left), register(right)])
  assert.equal(concurrent.filter(r => r.created).length, 1)
  assert.equal(concurrent[0].taskId, concurrent[1].taskId)
  assert.deepEqual(await count(), [before[0]+2, before[1]+2])
  const winner = concurrent[0].taskId === left.taskId ? left : right
  const [[stored]] = await connection.execute('SELECT CAST(UNIX_TIMESTAMP(range_start_utc)*1000 AS CHAR) start_msc FROM history_collection_tasks_v4 WHERE id=?', [winner.taskId])
  assert.equal(Number(stored.start_msc), winner.rangeStartUtcMsc)
  checks.push('concurrent-registration-reuses-winning-fixed-window')
  await connection.beginTransaction()
  try {
    const wide = { ...request, taskId: randomUUID(), rangeStartUtcMsc: request.rangeEndUtcMsc-32*86400000,
      userId: 7, platform: 'mt5', ownershipIntervalId: 'range-reference' }
    const requester = createMysqlHistoryRangeRequester(connection,createAccountInventorySummaryReader(connection),async () => ({ownershipRevision:'1'}))
    const busy = await requester.ensure(wide,now)
    assert.equal(busy.status,'waiting');assert.equal(busy.reason,'history_account_busy');assert.equal(busy.taskId,winner.taskId)
    await connection.execute("UPDATE history_collection_tasks_v4 SET status='failed',completed_at_utc=UTC_TIMESTAMP(3),error_code='reference_range' WHERE id=?",[winner.taskId])
    const pending = await requester.ensure(wide,now)
    assert.deepEqual(pending,{status:'waiting',taskId:wide.taskId,reason:'history_collection_pending'})
    assert.deepEqual(await requester.ensure(wide,now),pending)
    const [[window]] = await connection.execute('SELECT CAST(UNIX_TIMESTAMP(range_start_utc)*1000 AS CHAR) start_msc FROM history_collection_tasks_v4 WHERE id=?',[wide.taskId])
    assert.equal(Number(window.start_msc),wide.rangeStartUtcMsc)
    const [[events]] = await connection.execute('SELECT COUNT(*) n FROM outbox_events WHERE event_id=?',[wide.taskId]);assert.equal(Number(events.n),1)
    await assert.rejects(requester.ensure({...wide,rangeStartUtcMsc:wide.rangeStartUtcMsc-1},now),/history_task_registration_conflict/)
    const denied = createMysqlHistoryRangeRequester(connection,createAccountInventorySummaryReader(connection),async () => null)
    assert.equal((await denied.ensure({...wide,taskId:randomUUID()},now)).reason,'history_range_ownership_unavailable')
    await connection.execute("UPDATE history_collection_tasks_v4 SET status='failed',completed_at_utc=UTC_TIMESTAMP(3),error_code='reference_range' WHERE id=?",[wide.taskId])
    assert.deepEqual(await requester.ensure(wide,now),{status:'failed',taskId:wide.taskId})
  } finally { await connection.rollback() }
  checks.push('explicit-32-day-window-preserved','range-request-waits-for-other-active-task','same-range-replays-one-task-and-event','range-denial-does-not-register','range-failure-remains-explicit')
  return { passed: true, checks, accountLockProvider: 'actual-trading-public-composition', queuePublicationVerified: false }
}
