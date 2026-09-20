import assert from 'node:assert/strict'
import { createMysqlTradeHistoryScheduler } from '../../server/dist-v4/modules/trade-history/composition.js'
import { createAccountInventorySummaryReader } from '../../server/dist-v4/modules/trading/composition.js'
import { sha256 } from './v4-migration-plan.mjs'

export async function verifyHistoryTaskSchedulerReference(admin, pool, snapshots, now, inject) {
  const [[identity]] = await admin.query('SELECT DATABASE() db')
  assert.match(identity.db, /^dev_vue_history_ref_[a-f0-9]{32}$/)
  await admin.query('ALTER TABLE trading_accounts ADD COLUMN deleted_at_utc DATETIME(3) NULL')
  await admin.query('CREATE TABLE terminal_profiles (id VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY) ENGINE=InnoDB')
  const ddl = snapshots.find(t => t.name === 'bridge_connection_sessions').ddl
  await admin.query(ddl)
  await admin.query("INSERT INTO terminal_profiles (id) VALUES ('scheduler-profile')")
  for (const id of [6,7,8,9,10,11]) {
    await admin.execute('INSERT INTO trading_accounts (id,deleted_at_utc) VALUES (?,?)', [id,id===9 ? now : null])
    await admin.execute(`INSERT INTO bridge_connection_sessions (user_id,trading_account_id,terminal_profile_id,terminal_instance_id,
      connection_epoch,connection_epoch_v4,connected_at_utc,last_seen_at_utc,disconnected_at_utc)
      VALUES (7,?,'scheduler-profile',?,'1',1,?,?,?)`, [id,`scheduler-terminal-${id}`,now,
      new Date(now.getTime()-(id===7 ? 61000 : 0)),id===8 ? now : null])
  }
  await admin.execute(`INSERT INTO trade_history_sync_states_v4 (trading_account_id,status,history_revision,fresh_through_utc,updated_at_utc)
    VALUES (10,'ready',0,?,?),(11,'failed',0,?,?)`, [now,now,new Date(now.getTime()-3600000),new Date(now.getTime()-31000)])
  const scheduler = createMysqlTradeHistoryScheduler(pool, createAccountInventorySummaryReader)
  const state = async () => {
    const [tasks] = await admin.query('SELECT * FROM history_collection_tasks_v4 WHERE trading_account_id BETWEEN 6 AND 11 ORDER BY id')
    const [outbox] = await admin.query("SELECT * FROM outbox_events WHERE aggregate_type='trade_history_task' ORDER BY id")
    const [sync] = await admin.query('SELECT * FROM trade_history_sync_states_v4 WHERE trading_account_id BETWEEN 6 AND 11 ORDER BY trading_account_id')
    return {tasks,outbox,sync}
  }
  const before = await state(), checks = []
  inject('outbox-before-commit')
  await assert.rejects(scheduler.schedule(10, now), { message: 'injected_precommit_failure' })
  assert.deepEqual(await state(),before)
  checks.push('actual-due-query-and-registration-rollback-on-event-failure')
  await Promise.all([scheduler.schedule(10,now),scheduler.schedule(10,now)])
  const after = await state()
  assert.deepEqual(after.tasks.map(t=>Number(t.trading_account_id)).sort((a,b)=>a-b),[6,11])
  assert.equal(after.outbox.length,before.outbox.length+2)
  assert.deepEqual(after.sync,before.sync)
  for (const task of after.tasks) {
    const expectedStart = Number(task.trading_account_id)===6 ? Date.UTC(2000,0,1) : now.getTime()-3600000-86400000
    assert.equal(new Date(task.range_start_utc).getTime(),expectedStart)
    assert.equal(new Date(task.range_end_utc).getTime(),now.getTime())
    const event = after.outbox.find(e=>e.event_id===task.id)
    assert.ok(event)
    assert.deepEqual(typeof event.payload_json==='string' ? JSON.parse(event.payload_json) : event.payload_json,{task_id:task.id})
  }
  checks.push('concurrent-schedulers-create-only-online-due-accounts-with-fixed-windows')
  assert.deepEqual(await scheduler.schedule(10,now),[])
  assert.deepEqual(await state(),after)
  checks.push('active-tasks-excluded-without-premature-sync-state-change')
  const first = after.tasks.find(t=>Number(t.trading_account_id)===6)
  await admin.execute("UPDATE history_collection_tasks_v4 SET status='failed',completed_at_utc=UTC_TIMESTAMP(3),error_code='reference_end' WHERE id=?",[first.id])
  inject('commit-ack')
  await assert.rejects(scheduler.schedule(10,now),{message:'trade_history_commit_unknown'})
  const unknown = await state()
  assert.equal(unknown.tasks.length,3); assert.equal(unknown.outbox.length,after.outbox.length+1)
  assert.deepEqual(await scheduler.schedule(10,now),[])
  assert.deepEqual(await state(),unknown)
  checks.push('failed-task-replaced-once-and-commit-unknown-does-not-duplicate-batch')
  for (let round=0;round<20;round++) {
    await admin.query("UPDATE history_collection_tasks_v4 SET status='failed',completed_at_utc=UTC_TIMESTAMP(3),error_code='reference_end' WHERE trading_account_id IN (6,11) AND status='pending'")
    const prior = await state()
    const results = await Promise.allSettled([scheduler.schedule(10,now),scheduler.schedule(10,now)])
    const failed = results.find(r=>r.status==='rejected')
    if(failed) throw failed.reason
    const next = await state()
    assert.equal(next.tasks.length,prior.tasks.length+2)
    assert.equal(next.outbox.length,prior.outbox.length+2)
    assert.equal(next.tasks.filter(t=>t.status==='pending').length,2)
    assert.deepEqual(next.sync,prior.sync)
  }
  checks.push('twenty-concurrent-rounds-preserve-one-active-task-per-account')
  return {passed:true,concurrencyRounds:20,checks,sessionDdlHash:sha256(ddl),parents:'minimal-account-profile-user-fixtures',actualTerminalConnectivity:false}
}
