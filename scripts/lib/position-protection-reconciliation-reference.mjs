import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import {createHash} from 'node:crypto'
import {createMysqlPositionProtectionReconciliationRequest} from '../../server/dist-v4/modules/execution/composition.js'

export async function verifyProtectionReconciliationRequest(pool,db,scope,command) {
 const [[identity]]=await db.query('SELECT DATABASE() db')
 assert.match(identity.db,/^dev_vue_protection_ref_[a-f0-9]{32}$/)
 // Install the canonical numeric identity before exercising the request query and downstream queue fixture.
 await db.query('ALTER TABLE outbox_events ADD id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT, ADD UNIQUE KEY uk_reference_outbox_id (id)')
 const migration=await readFile(new URL('../../server/db/migrations/inplace/065_bridge_reconciliation_outbox_index.sql',import.meta.url),'utf8')
 await db.query(migration)
 const [index]=await db.query("SHOW INDEX FROM outbox_events WHERE Key_name='idx_outbox_aggregate_event'")
 assert.deepEqual(index.sort((a,b)=>a.Seq_in_index-b.Seq_in_index).map(row=>row.Column_name),['aggregate_type','aggregate_id','event_type','id'])
 const rows=async()=>{
  const [result]=await db.execute("SELECT event_id,status,payload_json FROM outbox_events WHERE aggregate_id=? AND event_type='bridge.command.reconcile.requested' ORDER BY id",[command.id])
  return result
 }
 const make=(fault=null)=>createMysqlPositionProtectionReconciliationRequest({async getConnection(){
  const connection=await pool.getConnection()
  return new Proxy(connection,{get(target,key){
   if(key==='commit')return async()=>{await target.commit();if(fault==='commit')throw Error('reconcile_commit_ack_lost')}
   if(key==='execute')return async(sql,...args)=>{
    const result=await target.execute(sql,...args)
    if(fault==='insert' && /INSERT INTO outbox_events/.test(sql))throw Error('reconcile_after_insert_fault')
    return result
   }
   const value=target[key];return typeof value==='function'?value.bind(target):value
  }})
 }})
 const request=make(),invoke=receiver=>receiver(scope,command.executionIntentId,command.id)
 await assert.rejects(()=>invoke(make('insert')),/reconcile_after_insert_fault/)
 assert.equal((await rows()).length,0)
 await assert.rejects(()=>invoke(make('commit')),/bridge_command_commit_unknown/)
 assert.equal((await rows()).length,1)
 await Promise.all([invoke(request),invoke(request),invoke(request)])
 const pending=await rows();assert.equal(pending.length,1);assert.equal(pending[0].status,'pending')
 assert.deepEqual(typeof pending[0].payload_json==='string'?JSON.parse(pending[0].payload_json):pending[0].payload_json,{command_id:command.id})
 await db.execute("UPDATE outbox_events SET status='dispatching',created_at_utc=DATE_SUB(UTC_TIMESTAMP(3),INTERVAL 10 SECOND) WHERE event_id=?",[pending[0].event_id])
 await invoke(request);assert.equal((await rows()).length,1)
 await db.execute("UPDATE outbox_events SET status='dispatched',created_at_utc=UTC_TIMESTAMP(3) WHERE event_id=?",[pending[0].event_id])
 await invoke(request);assert.equal((await rows()).length,1)
 await db.execute('UPDATE outbox_events SET created_at_utc=DATE_SUB(UTC_TIMESTAMP(3),INTERVAL 10 SECOND) WHERE event_id=?',[pending[0].event_id])
 await Promise.all([invoke(request),invoke(request)])
 const retried=await rows();assert.equal(retried.length,2);assert.notEqual(retried[0].event_id,retried[1].event_id)
 await assert.rejects(()=>request({...scope,userId:scope.userId+1},command.executionIntentId,command.id),/scope_unavailable/)
 assert.equal((await rows()).length,2)
 const [[saved]]=await db.execute('SELECT status,revision FROM bridge_commands_v4 WHERE id=?',[command.id])
 assert.equal(saved.status,'dispatched');assert.equal(Number(saved.revision),2)
 return {passed:true,checks:['indexed-command-event-lookup','late-insert-fault-rolls-back','commit-ack-loss-persists-one-request',
  'concurrent-redelivery-reuses-pending-request','dispatching-request-retained-after-cooldown',
  'delivered-request-cooldown-and-concurrent-renewal','wrong-owner-rejected','command-state-and-revision-unchanged'],
  migrationSha256:createHash('sha256').update(migration).digest('hex'),requestCount:2,
  terminalTransport:'not-provided',sourceSchema:'existing-protection-reference-query-scaffold'}
}
