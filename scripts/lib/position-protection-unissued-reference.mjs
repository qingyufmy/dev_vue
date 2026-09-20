import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {mergePositionProtectionOutcome,createMysqlPositionProtectionPreparation} from '../../server/dist-v4/modules/execution/composition.js'
import {bridgeCommandTransaction} from '../../server/dist-v4/modules/execution/infrastructure/bridge-command-transaction.js'

export async function verifyProtectionUnissuedExpiry(pool,scope) {
 const db=await pool.getConnection()
 try {
  const [[identity]]=await db.query('SELECT DATABASE() db');assert.match(identity.db,/^dev_vue_protection_ref_[a-f0-9]{32}$/)
  const [[row]]=await db.execute('SELECT child_json FROM position_protection_reviews_v4 WHERE workflow_id=?',[scope.workflowId])
  const child=typeof row.child_json==='string'?JSON.parse(row.child_json):row.child_json
  const future=Math.ceil(Date.parse(child.intent.expiresAt)/1000)+1
  const projection=async()=>{throw Error('unissued_must_not_request_projection')}
  const before=await bridgeCommandTransaction(pool,c=>mergePositionProtectionOutcome(c,scope,projection,30000))
  assert.equal(before.outcome.state,'waiting')
  const counts=async()=>{
   const [[row]]=await db.execute(`SELECT w.status,w.revision,i.status intent_status,i.revision intent_revision,o.status operation_status,o.revision operation_revision,
    (SELECT COUNT(*) FROM position_protection_unissued_expiries_v4 WHERE workflow_id=w.id) receipts,
    (SELECT COUNT(*) FROM partial_close_workflow_events_v4 WHERE workflow_id=w.id) events,
    (SELECT COUNT(*) FROM outbox_events WHERE aggregate_id IN (w.id,o.id)) outbox
    FROM partial_close_workflows_v4 w JOIN execution_intents i ON i.position_workflow_id=w.id JOIN operations o ON o.id=i.operation_id WHERE w.id=?`,[scope.workflowId])
   return row
  }
  const base=await counts()
  const wrapped=(fault=null,loseAck=false)=>({async getConnection(){const c=await pool.getConnection();await c.query('SET timestamp = '+future)
   return new Proxy(c,{get(t,key){
    if(key==='execute')return async(sql,...args)=>{const result=await t.execute(sql,...args);if(fault&&new RegExp('^\\s*(INSERT INTO|UPDATE) '+fault+'\\b').test(sql))throw Error('unissued_write_fault');return result}
    if(key==='commit')return async()=>{await t.commit();if(loseAck)throw Error('unissued_commit_ack_loss')}
    const value=t[key];return typeof value==='function'?value.bind(t):value
   }})}})
  const existing=randomUUID()
  await db.execute("INSERT INTO bridge_commands_v4 (id,execution_intent_id,user_id,trading_account_id,action,status) VALUES (?,?,7,5,'position.protection.set','uncertain')",[existing,child.intent.id])
  await assert.rejects(()=>bridgeCommandTransaction(wrapped(),c=>mergePositionProtectionOutcome(c,scope,projection,30000)),/position_protection_unissued_expiry_invalid/)
  await db.execute('DELETE FROM bridge_commands_v4 WHERE id=?',[existing])
  assert.deepEqual(await counts(),base)
  for(const table of ['execution_intents','operations','execution_intent_events','operation_events','position_protection_unissued_expiries_v4','partial_close_workflows_v4','partial_close_workflow_events_v4','outbox_events']){
   await assert.rejects(()=>bridgeCommandTransaction(wrapped(table),c=>mergePositionProtectionOutcome(c,scope,projection,30000)),/unissued_write_fault/)
   assert.deepEqual(await counts(),base)
  }
  await assert.rejects(()=>bridgeCommandTransaction(wrapped(null,true),c=>mergePositionProtectionOutcome(c,scope,projection,30000)),/bridge_command_commit_unknown/)
  const saved=await counts();assert.equal(saved.status,'stopped');assert.equal(saved.intent_status,'expired');assert.equal(saved.operation_status,'expired');assert.equal(Number(saved.receipts),1)
  const replay=await bridgeCommandTransaction(wrapped(),c=>mergePositionProtectionOutcome(c,scope,projection,30000))
  assert.equal(replay.replayed,true);assert.equal(replay.outcome.reason,'command_not_created_before_expiry');assert.deepEqual(await counts(),saved)
  const prepared=await createMysqlPositionProtectionPreparation(wrapped(),async()=>()=>({review:projection})).prepare(scope)
  assert.equal(prepared.status,'stopped');assert.equal(prepared.childIntentId,child.intent.id);assert.equal(prepared.revision,4)
  return {passed:true,checks:['unexpired-child-waits','any-existing-command-prevents-unissued-expiry','eight-write-faults-rollback-all-state','commit-ack-loss-recovers-unique-expiry','preparation-replays-stopped-child'],clock:'isolated-session-SET-timestamp',existingDatabaseWrites:0}
 }finally{db.release()}
}
