import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { sha256 } from './v4-migration-plan.mjs'
import { historyTaskRoute } from '../../server/dist-v4/modules/trade-history/application/history-collection-task.js'
import { lockHistoryCollectionTask } from '../../server/dist-v4/modules/trade-history/infrastructure/mysql-history-task-lock.js'
import { prepareHistoryTaskCompletion, loadHistoryTaskCompletion } from '../../server/dist-v4/modules/trade-history/infrastructure/mysql-history-task-completion.js'
import { MysqlHistoryCollectionTasks } from '../../server/dist-v4/modules/trade-history/infrastructure/mysql-history-collection-tasks.js'

export async function verifyHistoryTaskReference(connection, route, now) {
  const [[identity]] = await connection.query('SELECT DATABASE() db,@@session.time_zone tz')
  assert.match(identity.db, /^dev_vue_history_ref_[a-f0-9]{32}$/); assert.equal(identity.tz, '+00:00')
  const sql = await readFile(new URL('../../server/db/migrations/inplace/053_history_collection_tasks.sql', import.meta.url), 'utf8')
  await connection.query(sql)
  const [[definition]] = await connection.query('SHOW CREATE TABLE history_collection_tasks_v4')
  const claim = { taskId: randomUUID(), accountId: route.accountId, leaseToken: randomUUID(),
    routeHash: historyTaskRoute(route).hash, rangeStartUtcMsc: now.getTime()-10000, rangeEndUtcMsc: now.getTime() }
  const create = id => connection.execute(`INSERT INTO history_collection_tasks_v4
    (id,trading_account_id,range_start_utc,range_end_utc,created_at_utc,updated_at_utc) VALUES (?,?,?,?,?,?)`,
    [id, claim.accountId, new Date(claim.rangeStartUtcMsc), now, now, now])
  await create(claim.taskId)
  await assert.rejects(create(randomUUID()), { code: 'ER_DUP_ENTRY' })
  const checks = ['one-active-task-per-account-enforced-by-mysql']
  await connection.execute(`UPDATE history_collection_tasks_v4 SET status='running',attempts=1,lease_token=?,
    lease_expires_at_utc=UTC_TIMESTAMP(3)+INTERVAL 90 SECOND,route_json=?,route_sha256=? WHERE id=?`,
    [claim.leaseToken, historyTaskRoute(route).json, claim.routeHash, claim.taskId])
  await connection.beginTransaction()
  assert.deepEqual(await lockHistoryCollectionTask(connection, claim, route, 'page'), claim)
  await connection.rollback()
  checks.push('actual-utc-window-route-and-live-lease-row-lock')
  await connection.beginTransaction()
  await assert.rejects(lockHistoryCollectionTask(connection, { ...claim, leaseToken: randomUUID() }, route, 'page'), { message: 'history_task_lease_lost' })
  await connection.rollback()
  await connection.beginTransaction()
  await connection.execute('UPDATE history_collection_tasks_v4 SET lease_expires_at_utc=UTC_TIMESTAMP(3)-INTERVAL 1 SECOND WHERE id=?', [claim.taskId])
  await assert.rejects(lockHistoryCollectionTask(connection, claim, route, 'page'), { message: 'history_task_lease_lost' })
  await connection.rollback()
  checks.push('old-token-and-expired-lease-rejected')
  await connection.beginTransaction()
  await connection.execute('UPDATE history_collection_tasks_v4 SET route_json=JSON_OBJECT() WHERE id=?', [claim.taskId])
  await assert.rejects(lockHistoryCollectionTask(connection, claim, route, 'page'), { message: 'history_task_route_corrupt' })
  await connection.rollback()
  checks.push('persisted-route-body-rehashed-before-acceptance')
  for (const mutation of ['lease_token=NULL', 'range_end_utc=range_start_utc', "route_sha256=REPEAT('A',64)",
    "status='completing'", "status='succeeded',lease_token=NULL,lease_expires_at_utc=NULL,completed_at_utc=UTC_TIMESTAMP(3)"]) {
    await connection.beginTransaction()
    try { await assert.rejects(connection.query(`UPDATE history_collection_tasks_v4 SET ${mutation}`), { code: 'ER_CHECK_CONSTRAINT_VIOLATED' }) }
    finally { await connection.rollback() }
  }
  checks.push('mysql-lease-window-route-completion-and-result-checks')
  await connection.beginTransaction()
  try { await assert.rejects(connection.query('UPDATE history_collection_tasks_v4 SET trading_account_id=999999'), { code: 'ER_NO_REFERENCED_ROW_2' }) }
  finally { await connection.rollback() }
  checks.push('actual-account-foreign-key')
  const chains = ['history.orders', 'history.deals'].map(resource => ({ resource, rangeStartUtcMsc: claim.rangeStartUtcMsc,
    rangeEndUtcMsc: claim.rangeEndUtcMsc, source: 'terminal', sourceRevision: 'task-r1', pageCount: 1, itemCount: 2, pageChainHash: 'a'.repeat(64) }))
  const readPrepared = async () => {
    const [[row]] = await connection.execute('SELECT status,completion_json,completion_sha256,updated_at_utc FROM history_collection_tasks_v4 WHERE id=?', [claim.taskId])
    return { ...row }
  }
  const unprepared = await readPrepared()
  await connection.beginTransaction()
  await prepareHistoryTaskCompletion(connection, claim, route, chains)
  await connection.rollback()
  assert.deepEqual(await readPrepared(), unprepared)
  checks.push('completion-preparation-rolls-back-with-caller-transaction')
  await connection.beginTransaction()
  const completion = await prepareHistoryTaskCompletion(connection, claim, route, chains)
  await connection.commit()
  const prepared = await readPrepared()
  assert.equal(prepared.status, 'completing')
  await connection.beginTransaction()
  assert.deepEqual(await prepareHistoryTaskCompletion(connection, claim, route, chains), completion)
  await connection.commit()
  assert.deepEqual(await readPrepared(), prepared)
  checks.push('same-prepared-completion-replays-without-updating-state')
  await connection.beginTransaction()
  await assert.rejects(prepareHistoryTaskCompletion(connection, claim, route, chains.map(c => ({ ...c, sourceRevision: 'changed' }))),
    { message: 'history_task_completion_conflict' })
  await connection.rollback()
  assert.deepEqual(await readPrepared(), prepared)
  checks.push('changed-completion-does-not-overwrite-prepared-evidence')
  // Fixture rotates a lease; the production claim/takeover service is not yet wired.
  const recoveredClaim = { ...claim, leaseToken: randomUUID() }
  await connection.execute('UPDATE history_collection_tasks_v4 SET lease_token=? WHERE id=?', [recoveredClaim.leaseToken, claim.taskId])
  await connection.beginTransaction()
  await assert.rejects(loadHistoryTaskCompletion(connection, claim, route), { message: 'history_task_lease_lost' })
  assert.deepEqual(await loadHistoryTaskCompletion(connection, recoveredClaim, route), completion)
  await connection.rollback()
  assert.deepEqual(await readPrepared(), prepared)
  checks.push('new-lease-reads-original-completion-and-old-lease-is-fenced')
  await connection.beginTransaction()
  await connection.execute('UPDATE history_collection_tasks_v4 SET completion_json=JSON_OBJECT() WHERE id=?', [claim.taskId])
  await assert.rejects(loadHistoryTaskCompletion(connection, recoveredClaim, route), { message: 'history_task_completion_corrupt' })
  await connection.rollback()
  checks.push('corrupt-persisted-completion-rejected')
  await connection.execute(`UPDATE history_collection_tasks_v4 SET status='failed',lease_token=NULL,lease_expires_at_utc=NULL,
    completed_at_utc=UTC_TIMESTAMP(3),error_code='reference_failure' WHERE id=?`, [claim.taskId])
  await create(randomUUID())
  await connection.beginTransaction()
  await assert.rejects(lockHistoryCollectionTask(connection, claim, route, 'page'), { message: 'history_task_lease_lost' })
  await connection.rollback()
  const [[counts]] = await connection.query('SELECT COUNT(*) n,COUNT(active_account_id) active FROM history_collection_tasks_v4')
  assert.equal(Number(counts.n), 2); assert.equal(Number(counts.active), 1)
  checks.push('terminal-task-retained-and-replacement-task-isolated')
  return { passed: true, checks, canonicalDdl: definition['Create Table'], migrationSha256: sha256(sql),
    leaseRotationMethod: 'direct-fixture-update', queueIntegrationVerified: false }
}

export async function verifyHistoryTaskClaimsReference(connection, pool, route, inject) {
  const [[identity]] = await connection.query('SELECT DATABASE() db,@@server_uuid uuid')
  assert.match(identity.db, /^dev_vue_history_ref_[a-f0-9]{32}$/)
  const [pending] = await connection.query("SELECT id FROM history_collection_tasks_v4 WHERE trading_account_id=5 AND status='pending'")
  assert.equal(pending.length, 1)
  const id = pending[0].id, changedRoute = { ...route, connectionEpoch: route.connectionEpoch+1 }
  const tasks = new MysqlHistoryCollectionTasks(pool, c => ({ async assert(candidate) {
    assert.ok([historyTaskRoute(route).hash, historyTaskRoute(changedRoute).hash].includes(historyTaskRoute(candidate).hash))
    const [[actual]] = await c.query('SELECT DATABASE() db,@@server_uuid uuid')
    assert.equal(actual.db, identity.db); assert.equal(actual.uuid, identity.uuid)
  } }))
  const concurrent = await Promise.all([tasks.claim(id, route), tasks.claim(id, route)])
  assert.deepEqual(concurrent.map(r => r.state).sort(), ['busy', 'collecting'])
  const first = concurrent.find(r => r.state === 'collecting').claim
  const read = async () => {
    const [[row]] = await connection.execute('SELECT status,attempts,lease_token,completion_sha256,error_code FROM history_collection_tasks_v4 WHERE id=?', [id])
    return { ...row }
  }
  const expire = () => connection.execute('UPDATE history_collection_tasks_v4 SET lease_expires_at_utc=UTC_TIMESTAMP(3)-INTERVAL 1 SECOND WHERE id=?', [id])
  assert.equal((await read()).attempts, 1)
  const checks = ['two-real-connections-only-one-claim']
  await tasks.renew(first, route)
  await expire()
  const second = await tasks.claim(id, route)
  assert.equal(second.state, 'collecting'); assert.notEqual(second.claim.leaseToken, first.leaseToken)
  await assert.rejects(tasks.renew(first, route), { message: 'history_task_lease_lost' })
  await tasks.renew(second.claim, route)
  checks.push('real-expired-lease-takeover-and-old-token-renewal-rejection')
  const chains = ['history.orders', 'history.deals'].map(resource => ({ resource, rangeStartUtcMsc: first.rangeStartUtcMsc,
    rangeEndUtcMsc: first.rangeEndUtcMsc, source: 'terminal', sourceRevision: 'claim-r1', pageCount: 1, itemCount: 0, pageChainHash: 'a'.repeat(64) }))
  await connection.beginTransaction()
  const completion = await prepareHistoryTaskCompletion(connection, second.claim, route, chains)
  await connection.commit()
  await expire()
  const third = await tasks.claim(id, route)
  assert.equal(third.state, 'completing'); assert.deepEqual(third.completion, completion)
  checks.push('claim-service-recovers-original-prepared-completion')
  await expire()
  const fourth = await tasks.claim(id, changedRoute)
  assert.equal(fourth.state, 'collecting'); assert.equal((await read()).completion_sha256, null)
  assert.equal(fourth.claim.rangeStartUtcMsc, first.rangeStartUtcMsc); assert.equal(fourth.claim.rangeEndUtcMsc, first.rangeEndUtcMsc)
  checks.push('new-route-clears-preparation-and-retains-original-window')
  await expire()
  assert.equal((await tasks.claim(id, changedRoute)).state, 'collecting')
  assert.equal((await read()).attempts, 5)
  assert.equal((await tasks.claim(id, changedRoute)).state, 'busy')
  await expire()
  assert.deepEqual(await tasks.claim(id, changedRoute), { state: 'terminal', status: 'failed' })
  assert.deepEqual(await read(), { status: 'failed', attempts: 5, lease_token: null, completion_sha256: null, error_code: 'history_task_attempts_exhausted' })
  checks.push('fifth-live-attempt-preserved-and-sixth-claim-refused')
  const uncertainId = randomUUID()
  await connection.execute(`INSERT INTO history_collection_tasks_v4 (id,trading_account_id,range_start_utc,range_end_utc,created_at_utc,updated_at_utc)
    VALUES (?,5,?,?,UTC_TIMESTAMP(3),UTC_TIMESTAMP(3))`, [uncertainId, new Date(first.rangeStartUtcMsc), new Date(first.rangeEndUtcMsc)])
  inject('commit-ack')
  await assert.rejects(tasks.claim(uncertainId, route), { message: 'trade_history_commit_unknown' })
  assert.equal((await tasks.claim(uncertainId, route)).state, 'busy')
  const [[uncertain]] = await connection.execute('SELECT attempts,status FROM history_collection_tasks_v4 WHERE id=?', [uncertainId])
  assert.equal(uncertain.attempts, 1); assert.equal(uncertain.status, 'running')
  checks.push('lost-claim-commit-does-not-consume-another-attempt')
  return { passed: true, checks, claimTakeoverVerified: true, queueIntegrationVerified: false, authorization: 'injected-route-guard' }
}
