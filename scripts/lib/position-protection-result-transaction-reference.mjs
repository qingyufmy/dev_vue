import assert from 'node:assert/strict'
import {MysqlBridgeCommandRepository} from '../../server/dist-v4/modules/execution/composition.js'

export async function verifyProtectionResultTransaction(db,pool,source,payload,resultHash) {
 const [[identity]]=await db.query('SELECT DATABASE() db');assert.match(identity.db,/^dev_vue_protection_ref_[a-f0-9]{32}$/)
 await db.query('ALTER TABLE bridge_command_results_v4 ADD id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY, ADD received_at_utc DATETIME(3)')
 await db.query(`CREATE TABLE execution_outcomes (id CHAR(36) PRIMARY KEY,execution_intent_id CHAR(36) NOT NULL UNIQUE,
  distribution_target_id CHAR(36),trading_account_id BIGINT UNSIGNED,resource_kind VARCHAR(32),ticket VARCHAR(64),result_sha256 CHAR(64),
  status VARCHAR(32),result_json JSON,confirmed_at_utc DATETIME(3),created_at_utc DATETIME(3),updated_at_utc DATETIME(3),revision BIGINT) ENGINE=InnoDB`)
 await db.query('CREATE TABLE risk_reservations_v4 (id CHAR(36) PRIMARY KEY,execution_intent_id CHAR(36),status VARCHAR(32),revision BIGINT) ENGINE=InnoDB')
 const [[intent]]=await db.execute('SELECT operation_id,source_id FROM execution_intents WHERE id=?',[source.executionIntentId])
 const envelope={message_id:'result-1',route:{terminal_instance_id:source.route.terminalInstanceId,
  account_ref:{broker_server:source.route.brokerServer,login:source.route.login},connection_epoch:source.route.connectionEpoch},payload}
 const now=new Date(payload.completed_at_utc_msc).toISOString()
 const state=async()=>{
  const [[command]]=await db.execute('SELECT status,revision,result_sha256,result_message_id FROM bridge_commands_v4 WHERE id=?',[source.id])
  const [[child]]=await db.execute('SELECT status,revision FROM execution_intents WHERE id=?',[source.executionIntentId])
  const [[operation]]=await db.execute('SELECT status,revision FROM operations WHERE id=?',[intent.operation_id])
  const counts={}
  for(const [table,column,value] of [['bridge_command_results_v4','bridge_command_id',source.id],['bridge_command_events_v4','bridge_command_id',source.id],
   ['execution_intent_events','execution_intent_id',source.executionIntentId],['execution_outcomes','execution_intent_id',source.executionIntentId],
   ['operation_events','operation_id',intent.operation_id],['outbox_events','aggregate_id',intent.source_id],['outbox_events','aggregate_id',intent.operation_id]]){
   const [[row]]=await db.execute(`SELECT COUNT(*) n FROM ${table} WHERE ${column}=?`,[value]);counts[table+':'+value]=Number(row.n)
  }
  return {command,child,operation,counts}
 }
 const make=(fault=null)=>new MysqlBridgeCommandRepository({execute:(...args)=>db.execute(...args),async getConnection(){
  const connection=await pool.getConnection()
  return new Proxy(connection,{get(target,key){
   if(key==='commit')return async()=>{await target.commit();if(fault==='commit')throw Error('result_commit_ack_lost')}
   if(key==='execute')return async(sql,...args)=>{
    const result=await target.execute(sql,...args)
    const matches=fault==='wakeup'?sql.includes("'execution.partial-close.requested'"):
     fault && new RegExp('^\\s*(INSERT INTO|UPDATE) '+fault+'\\b').test(sql)
    if(matches)throw Error('result_late_write_fault')
    return result
   }
   const value=target[key];return typeof value==='function'?value.bind(target):value
  }})
 }},()=>{throw Error('unexpected_clock')},()=>{throw Error('unexpected_policy')})
 const before=await state();assert.equal(before.command.status,'dispatched')
 for(const fault of ['bridge_command_results_v4','bridge_commands_v4','execution_intents','execution_outcomes','operations','wakeup']){
  await assert.rejects(()=>make(fault).persistResult(envelope,resultHash,now),/result_late_write_fault/)
  assert.deepEqual(await state(),before)
 }
 await assert.rejects(()=>make('commit').persistResult(envelope,resultHash,now),/bridge_command_commit_unknown/)
 const after=await state();assert.equal(after.command.status,'succeeded');assert.equal(after.child.status,'succeeded');assert.equal(after.operation.status,'succeeded')
 const [wakeups]=await db.execute("SELECT payload_json FROM outbox_events WHERE aggregate_id=? AND event_type='execution.partial-close.requested'",[intent.source_id])
 assert.equal(wakeups.length,1)
 const wake=typeof wakeups[0].payload_json==='string'?JSON.parse(wakeups[0].payload_json):wakeups[0].payload_json
 assert.deepEqual(wake,{workflow_id:intent.source_id,user_id:source.userId,trading_account_id:source.accountId})
 const repeated=await Promise.all([make().persistResult(envelope,resultHash,now),make().persistResult(envelope,resultHash,now)])
 assert.ok(repeated.every(result=>result.disposition==='duplicate'));assert.deepEqual(await state(),after)
 return {passed:true,checks:['six-late-writes-rollback-result-command-intent-operation-and-wakeup',
  'commit-ack-loss-persists-result-and-one-workflow-wakeup','concurrent-result-redelivery-adds-no-wakeup-or-outcome'],
  persistence:'actual-MysqlBridgeCommandRepository',schema:'query-scaffold',reservation:'empty-no-risk-settlement-proof',terminalResult:'synthetic'}
}
