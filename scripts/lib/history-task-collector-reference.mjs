import assert from 'node:assert/strict'
import { createMysqlHistoryTaskWorker } from '../../server/dist-v4/modules/trade-history/composition.js'
import { MysqlHistoryCollectionTasks } from '../../server/dist-v4/modules/trade-history/infrastructure/mysql-history-collection-tasks.js'
import { MysqlTradeHistoryCollectorRepository } from '../../server/dist-v4/modules/trade-history/infrastructure/mysql-trade-history-collector-repository.js'

export async function verifyHistoryTaskCollectorReference(admin, pool, route, now, inject) {
  const [[identity]] = await admin.query('SELECT DATABASE() db,@@server_uuid uuid')
  assert.match(identity.db, /^dev_vue_history_ref_[a-f0-9]{32}$/)
  const guard = connection => ({ async assert(candidate) {
    assert.deepEqual(candidate, route)
    const [[actual]] = await connection.query('SELECT DATABASE() db,@@server_uuid uuid')
    assert.deepEqual(actual, identity)
  } })
  const [pending] = await admin.query("SELECT id FROM history_collection_tasks_v4 WHERE active_account_id=5 AND status='pending'")
  assert.equal(pending.length, 1)
  const tasks = new MysqlHistoryCollectionTasks(pool, guard)
  const result = await tasks.claim(pending[0].id, route)
  assert.equal(result.state, 'collecting')
  let claim = result.claim
  let repository = new MysqlTradeHistoryCollectorRepository(pool, guard, claim)
  assert.deepEqual(await repository.begin(route, new Date(now.getTime()+9999)), {
    rangeStartUtcMsc: claim.rangeStartUtcMsc, rangeEndUtcMsc: claim.rangeEndUtcMsc })
  const chains = ['history.orders', 'history.deals'].map(resource => ({ resource,
    rangeStartUtcMsc: claim.rangeStartUtcMsc, rangeEndUtcMsc: claim.rangeEndUtcMsc,
    source: 'terminal', sourceRevision: 'task-reference', pageCount: 1, itemCount: 0, pageChainHash: 'b'.repeat(64) }))
  const capture = async () => {
    const output = {}
    for (const table of ['trade_history_sync_states_v4', 'terminal_history_collection_receipts_v4', 'account_trade_daily_summaries_v4', 'outbox_events']) {
      const [rows] = await admin.query(`SELECT * FROM ${table} ORDER BY 1`)
      output[table] = rows
    }
    return output
  }
  const checks = ['begin-preserves-claimed-window']
  const raw = { ticket: '12346', type: 'buy', entry: 'in', time_msc: claim.rangeEndUtcMsc-500, volume: '1', price: '2500' }
  const response = { v: 4, type: 'query.response', message_id: 'task-page-response', correlation_id: 'task-page-query', sent_at_utc_msc: now.getTime(),
    route: { terminal_instance_id: route.terminalInstanceId, account_ref: { broker_server: route.brokerServer, login: route.login }, connection_epoch: route.connectionEpoch },
    payload: { request_id: 'task-page-request', resource: 'history.deals', source: 'terminal', source_revision: 'task-reference', observed_at_utc_msc: now.getTime()-1,
      items: [raw], has_more: false, next_cursor: null } }
  const pageState = async () => {
    const [facts] = await admin.query("SELECT * FROM terminal_history_deals_v4 WHERE deal_ticket='12346'")
    const [sources] = await admin.query("SELECT * FROM terminal_history_deal_provenance_v4 WHERE response_message_id='task-page-response'")
    const [task] = await admin.execute('SELECT * FROM history_collection_tasks_v4 WHERE id=?', [claim.taskId])
    return { facts, sources, task, business: await capture() }
  }
  const pageBefore = await pageState()
  inject('deal-provenance-before-commit')
  await assert.rejects(repository.persistPage(route, 'history.deals', response, now), { message: 'injected_deal_provenance_failure' })
  assert.deepEqual(await pageState(), pageBefore)
  checks.push('bound-page-fact-provenance-sync-and-task-rollback')
  const oldRepository = repository, oldClaim = claim
  await admin.execute('UPDATE history_collection_tasks_v4 SET lease_expires_at_utc=UTC_TIMESTAMP(3)-INTERVAL 1 SECOND WHERE id=?', [claim.taskId])
  const takeover = await tasks.claim(claim.taskId, route)
  assert.equal(takeover.state, 'collecting'); assert.notEqual(takeover.claim.leaseToken, oldClaim.leaseToken)
  claim = takeover.claim
  repository = new MysqlTradeHistoryCollectorRepository(pool, guard, claim)
  const takenOver = await pageState()
  await assert.rejects(oldRepository.persistPage(route, 'history.deals', response, now), { message: 'history_task_lease_lost' })
  await assert.rejects(oldRepository.fail(route, 'history_query_failed', now), { message: 'history_task_lease_lost' })
  assert.deepEqual(await pageState(), takenOver)
  checks.push('actual-claim-takeover-fences-old-page-and-failure-writes')
  await repository.persistPage(route, 'history.deals', response, now)
  const written = await pageState()
  assert.equal(written.facts.length, 1); assert.equal(written.sources.length, 1)
  assert.equal(written.task[0].lease_token, claim.leaseToken)
  await repository.persistPage(route, 'history.deals', response, now)
  const replayed = await pageState()
  assert.deepEqual(replayed.facts, written.facts); assert.deepEqual(replayed.sources, written.sources)
  assert.deepEqual(replayed.business, written.business)
  checks.push('new-lease-page-commits-and-replay-keeps-one-fact-and-source')
  const before = await capture()
  inject('outbox-before-commit')
  await assert.rejects(repository.complete(route, claim.rangeEndUtcMsc, now, chains), { message: 'injected_precommit_failure' })
  assert.deepEqual(await capture(), before)
  const [[prepared]] = await admin.execute('SELECT status,completion_sha256,result_receipt_id FROM history_collection_tasks_v4 WHERE id=?', [claim.taskId])
  assert.equal(prepared.status, 'completing'); assert.match(prepared.completion_sha256, /^[a-f0-9]{64}$/)
  assert.equal(prepared.result_receipt_id, null)
  checks.push('prepared-task-survives-business-transaction-rollback')
  await admin.execute('UPDATE history_collection_tasks_v4 SET lease_expires_at_utc=UTC_TIMESTAMP(3)-INTERVAL 1 SECOND WHERE id=?', [claim.taskId])
  let terminalQueries = 0
  let routeReads = 0
  const worker = createMysqlHistoryTaskWorker(pool, { async query() { terminalQueries++; throw Error('unexpected_terminal_query') } },
    { async current(accountId) { routeReads++; assert.equal(accountId, route.accountId); return route } }, guard)
  inject('task-completion-ack')
  assert.deepEqual(await worker.run(claim.taskId), { state: 'succeeded', freshThroughUtcMsc: claim.rangeEndUtcMsc })
  assert.equal(terminalQueries, 0)
  assert.equal(routeReads, 1)
  assert.deepEqual(await worker.run(claim.taskId), { state: 'terminal', status: 'succeeded' })
  assert.equal(routeReads, 1)
  checks.push('actual-worker-resolves-persisted-account-and-acknowledges-terminal-without-route')
  checks.push('actual-composition-resumes-expired-prepared-task-and-confirms-unknown-without-terminal-query')
  const committed = await capture()
  const [[finished]] = await admin.execute('SELECT status,result_receipt_id,lease_token FROM history_collection_tasks_v4 WHERE id=?', [claim.taskId])
  assert.equal(finished.status, 'succeeded'); assert.equal(finished.lease_token, null)
  assert.ok(committed.terminal_history_collection_receipts_v4.some(row => row.id === finished.result_receipt_id))
  assert.equal(committed.terminal_history_collection_receipts_v4.length, before.terminal_history_collection_receipts_v4.length+1)
  assert.equal(committed.outbox_events.length, before.outbox_events.length+2)
  assert.equal(BigInt(committed.trade_history_sync_states_v4[0].history_revision), BigInt(before.trade_history_sync_states_v4[0].history_revision)+1n)
  assert.equal(committed.outbox_events.filter(row => row.event_type === 'trade.history.task.completed' && row.aggregate_id === claim.taskId).length, 1)
  checks.push('task-success-and-completion-event-committed-before-ack-loss')
  await repository.complete(route, claim.rangeEndUtcMsc, new Date(now.getTime()+2000), chains)
  assert.deepEqual(await capture(), committed)
  checks.push('completed-task-replay-confirms-without-lease-or-additional-writes')
  await assert.rejects(repository.fail(route, 'history_query_failed', now), { message: 'history_task_lease_lost' })
  await assert.rejects(repository.begin(route, now), { message: 'history_task_lease_lost' })
  assert.deepEqual(await capture(), committed)
  checks.push('ended-task-cannot-restart-or-fail-current-sync')
  return { passed: true, checks, queueIntegrationVerified: false, terminalPaginationVerified: false, boundMt5PageVerified: true, leaseTakeoverFencingVerified: true }
}
