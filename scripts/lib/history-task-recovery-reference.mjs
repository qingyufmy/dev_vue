import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { createMysqlHistoryTaskRecovery } from '../../server/dist-v4/modules/trade-history/composition.js'
import { createAccountInventorySummaryReader } from '../../server/dist-v4/modules/trading/composition.js'
import { registerHistoryCollectionTask } from '../../server/dist-v4/modules/trade-history/infrastructure/mysql-history-task-registration.js'
import { historyTransaction } from '../../server/dist-v4/modules/trade-history/infrastructure/history-transaction.js'
import { MysqlTradeHistoryCollectorRepository } from '../../server/dist-v4/modules/trade-history/infrastructure/mysql-trade-history-collector-repository.js'
import { MysqlHistoryCollectionTasks } from '../../server/dist-v4/modules/trade-history/infrastructure/mysql-history-collection-tasks.js'
import { prepareHistoryTaskCompletion } from '../../server/dist-v4/modules/trade-history/infrastructure/mysql-history-task-completion.js'

export async function verifyHistoryTaskRecoveryReference(admin, pool, route, now, inject) {
  const [[identity]] = await admin.query('SELECT DATABASE() db')
  assert.match(identity.db, /^dev_vue_history_ref_[a-f0-9]{32}$/)
  const request = { taskId: randomUUID(), accountId: route.accountId, rangeStartUtcMsc: now.getTime()-10000, rangeEndUtcMsc: now.getTime() }
  await historyTransaction(pool, c => registerHistoryCollectionTask(c, createAccountInventorySummaryReader(c), request, now))
  const recovery = createMysqlHistoryTaskRecovery(pool), checks = []
  const age = () => admin.execute('UPDATE history_collection_tasks_v4 SET updated_at_utc=UTC_TIMESTAMP(3)-INTERVAL 4 MINUTE WHERE id=?', [request.taskId])
  const acknowledgeEvents = () => admin.execute("UPDATE outbox_events SET status='dispatched' WHERE aggregate_type='trade_history_task' AND aggregate_id=?", [request.taskId])
  const capture = async () => {
    const [task] = await admin.execute('SELECT * FROM history_collection_tasks_v4 WHERE id=?', [request.taskId])
    const [events] = await admin.execute("SELECT * FROM outbox_events WHERE aggregate_type='trade_history_task' AND aggregate_id=? ORDER BY id", [request.taskId])
    return { task, events }
  }
  await age()
  assert.equal(await recovery.schedule(10), 0)
  checks.push('pending-outbox-prevents-duplicate-recovery')
  await acknowledgeEvents()
  const before = await capture()
  inject('outbox-before-commit')
  await assert.rejects(recovery.schedule(10), { message: 'injected_precommit_failure' })
  assert.deepEqual(await capture(), before)
  checks.push('recovery-event-and-cooldown-rollback-together')
  const counts = await Promise.all([recovery.schedule(10), recovery.schedule(10)])
  assert.equal(counts.reduce((a,b)=>a+b,0), 1)
  const recovered = await capture()
  assert.equal(recovered.events.length, before.events.length+1)
  assert.deepEqual({ ...recovered.task[0], updated_at_utc: null }, { ...before.task[0], updated_at_utc: null })
  const event = recovered.events.at(-1)
  assert.notEqual(event.event_id, request.taskId)
  assert.deepEqual(typeof event.payload_json === 'string' ? JSON.parse(event.payload_json) : event.payload_json, { task_id: request.taskId })
  await acknowledgeEvents()
  assert.equal(await recovery.schedule(10), 0)
  checks.push('concurrent-pending-recovery-one-delivery-original-task-and-cooldown')
  const guard = () => ({ async assert(candidate) { assert.deepEqual(candidate, route) } })
  const tasks = new MysqlHistoryCollectionTasks(pool, guard)
  const claimed = await tasks.claim(request.taskId, route)
  assert.equal(claimed.state, 'collecting')
  await new MysqlTradeHistoryCollectorRepository(pool, guard, claimed.claim).begin(route, now)
  await age()
  assert.equal(await recovery.schedule(10), 0)
  checks.push('live-running-lease-is-not-republished')
  const chains = ['history.orders', 'history.deals'].map(resource => ({ resource, rangeStartUtcMsc: request.rangeStartUtcMsc,
    rangeEndUtcMsc: request.rangeEndUtcMsc, source: 'terminal', sourceRevision: 'recovery', pageCount: 1, itemCount: 0, pageChainHash: 'c'.repeat(64) }))
  await historyTransaction(pool, c => prepareHistoryTaskCompletion(c, claimed.claim, route, chains))
  await admin.execute('UPDATE history_collection_tasks_v4 SET lease_expires_at_utc=UTC_TIMESTAMP(3)-INTERVAL 1 SECOND,updated_at_utc=UTC_TIMESTAMP(3)-INTERVAL 4 MINUTE WHERE id=?', [request.taskId])
  const prepared = await capture()
  inject('commit-ack')
  await assert.rejects(recovery.schedule(10), { message: 'trade_history_commit_unknown' })
  const committed = await capture()
  assert.equal(committed.events.length, prepared.events.length+1)
  assert.deepEqual({ ...committed.task[0], updated_at_utc: null }, { ...prepared.task[0], updated_at_utc: null })
  assert.equal(await recovery.schedule(10), 0)
  assert.deepEqual(await capture(), committed)
  checks.push('expired-completing-republished-without-changing-evidence-and-unknown-commit-recovers')
  return { passed: true, checks, queueDeliveryVerified: false }
}
