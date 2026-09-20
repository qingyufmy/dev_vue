import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import {createHash} from 'node:crypto'
import {splitSqlStatements} from './v4-migration-plan.mjs'
import {writePositionProtectionCommandBinding,replayPositionProtectionCommandBinding,MysqlBridgeCommandRepository,createMysqlPositionProtectionCommandReviewer,readPositionProtectionDispatchReview,writePositionProtectionDispatchReview} from '../../server/dist-v4/modules/execution/composition.js'
import {createBridgeCommand} from '../../server/dist-v4/modules/execution/domain/bridge-command.js'
import {reviewPositionProtectionCommand} from '../../server/dist-v4/modules/execution/domain/position-protection-command-review.js'
import {sha256Canonical} from '../../server/dist-v4/modules/execution/domain/execution.js'
import {BridgeCommandService} from '../../server/dist-v4/modules/execution/application/bridge-command-service.js'
import {verifyProtectionOutcomeReceipt} from './position-protection-outcome-reference.mjs'
import {verifyProtectionUnissuedExpiry} from './position-protection-unissued-reference.mjs'
import {verifyProtectionReceiverDispatch,verifyProtectionReceiverPreparation} from './position-protection-receiver-reference.mjs'
import {verifyProtectionReconciliationRequest} from './position-protection-reconciliation-reference.mjs'

export async function verifyPositionProtectionBinding(pool,scope,createExpiryScope,options={}) {
 const db=await pool.getConnection(),checks=[],parked=[]
 try {
  const [[identity]]=await db.query('SELECT DATABASE() db');assert.match(identity.db,/^dev_vue_protection_ref_[a-f0-9]{32}$/)
  await db.query('ALTER TABLE bridge_commands_v4 ADD COLUMN request_sha256 CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NULL')
  await db.query('CREATE TABLE bridge_command_payloads_v4 (bridge_command_id VARCHAR(191) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,request_envelope_json JSON,FOREIGN KEY(bridge_command_id) REFERENCES bridge_commands_v4(id)) ENGINE=InnoDB')
  await db.query('CREATE TABLE bridge_command_events_v4 (bridge_command_id VARCHAR(191) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,event_type VARCHAR(64),FOREIGN KEY(bridge_command_id) REFERENCES bridge_commands_v4(id)) ENGINE=InnoDB')
  await db.query('CREATE TABLE bridge_trade_state_snapshots_v4 (trading_account_id BIGINT UNSIGNED,entity_kind VARCHAR(32),ticket VARCHAR(32),terminal_instance_id VARCHAR(191),connection_epoch BIGINT,projection_revision BIGINT,state_json JSON,state_sha256 CHAR(64),PRIMARY KEY(trading_account_id,entity_kind,ticket)) ENGINE=InnoDB')
  await db.query(`ALTER TABLE trading_accounts ADD broker_server VARCHAR(128) DEFAULT 'Broker', ADD account_login VARCHAR(64) DEFAULT '42', ADD deleted_at_utc DATETIME(3) NULL`)
  await db.query(`ALTER TABLE bridge_commands_v4
    ADD command_sequence INT NOT NULL DEFAULT 1, ADD terminal_profile_id VARCHAR(128), ADD terminal_instance_id VARCHAR(128),
    ADD broker_server VARCHAR(128), ADD account_login VARCHAR(64), ADD connection_epoch BIGINT,
    ADD idempotency_key VARCHAR(191), ADD issued_at_utc DATETIME(3), ADD deadline_at_utc DATETIME(3),
    ADD dispatched_at_utc DATETIME(3), ADD accepted_at_utc DATETIME(3), ADD completed_at_utc DATETIME(3),
    ADD error_code VARCHAR(128), ADD terminal_code VARCHAR(128), ADD result_sha256 CHAR(64), ADD result_message_id VARCHAR(191),
    ADD revision INT NOT NULL DEFAULT 1, ADD created_at_utc DATETIME(3), ADD updated_at_utc DATETIME(3),
    ADD UNIQUE KEY uk_protection_sequence (execution_intent_id,command_sequence)`)
  await db.query('ALTER TABLE bridge_command_payloads_v4 ADD params_json JSON, ADD expected_state_json JSON, ADD payload_bytes INT')
  await db.query(`ALTER TABLE bridge_command_events_v4 ADD from_status VARCHAR(32), ADD to_status VARCHAR(32), ADD reason_code VARCHAR(128),
    ADD from_revision INT, ADD to_revision INT, ADD evidence_sha256 CHAR(64), ADD occurred_at_utc DATETIME(3)`)
  for(const [name,fields] of [
   ['terminal_profiles','id VARCHAR(128) PRIMARY KEY,user_id INT,deleted_at_utc DATETIME(3)'],
   ['terminal_account_bindings','trading_account_id BIGINT,terminal_profile_id VARCHAR(128),terminal_instance_id VARCHAR(128),unbound_at_utc DATETIME(3)'],
   ['bridge_connection_sessions','id VARCHAR(128),trading_account_id BIGINT,user_id INT,terminal_profile_id VARCHAR(128),terminal_instance_id VARCHAR(128),connection_epoch_v4 BIGINT,disconnected_at_utc DATETIME(3)'],
   ['account_runtime_snapshots','trading_account_id BIGINT PRIMARY KEY,trade_permission TINYINT'],
  ])await db.query(`CREATE TABLE ${name} (${fields}) ENGINE=InnoDB`)
  await db.query("INSERT INTO terminal_profiles VALUES ('profile-1',7,NULL)")
  await db.query("INSERT INTO terminal_account_bindings VALUES (5,'profile-1','terminal-1',NULL)")
  await db.query("INSERT INTO bridge_connection_sessions VALUES ('session',5,7,'profile-1','terminal-1',1,NULL)")
  await db.query('INSERT INTO account_runtime_snapshots VALUES (5,1)')
  if(options.target){
   const target=options.target
   assert.equal(scope.userId,7);assert.equal(scope.accountId,'5')
   await db.execute('UPDATE trading_accounts SET broker_server=?,account_login=? WHERE id=5',[target.brokerServer,target.login])
   await db.execute('UPDATE terminal_account_bindings SET terminal_instance_id=? WHERE trading_account_id=5',[target.terminalInstanceId])
   await db.execute('UPDATE bridge_connection_sessions SET terminal_instance_id=? WHERE trading_account_id=5',[target.terminalInstanceId])
  }
  const migration=await readFile(new URL('../../server/db/migrations/inplace/059_position_protection_commands.sql',import.meta.url),'utf8')
  for(const sql of splitSqlStatements(migration))await db.query(sql)
  const [[receipt]]=await db.execute('SELECT child_json FROM position_protection_reviews_v4 WHERE workflow_id=?',[scope.workflowId])
  const child=typeof receipt.child_json==='string'?JSON.parse(receipt.child_json):receipt.child_json
  const [[clock]]=await db.query('SELECT UNIX_TIMESTAMP(UTC_TIMESTAMP(3))*1000 at'),now=new Date(Number(clock.at))
  const review=structuredClone(child.review);review.evaluation.evaluatedAt=now.toISOString();review.contextHash='e'.repeat(64)
  review.evaluation.approvedActions[0].expectedState.positionsRevision++
  const authority=reviewPositionProtectionCommand(child,review,now),target=child.request.target
  const state={ticket:target.ticket,symbol:target.symbol,direction:target.side,volume:child.request.remainingVolume,order_type:'market',magic:0,
   open_price:'2450',stop_limit_price:null,stop_loss:'2400',take_profit:null,expiration_utc_msc:null}
  const commandInput={executionIntentId:child.intent.id,commandSequence:1,userId:scope.userId,accountId:scope.accountId,terminalProfileId:'profile-1',
   route:{terminalInstanceId:target.terminalInstanceId,brokerServer:target.brokerServer,login:target.login,connectionEpoch:1},action:'position.protection.set',
   params:authority.action.parameters,expectedState:state,deadlineAt:authority.expiresAt}
  const command=createBridgeCommand(commandInput,now)
  await db.execute("INSERT INTO bridge_trade_state_snapshots_v4 VALUES (?,'position',?,?,1,?,?,?)",[scope.accountId,target.ticket,target.terminalInstanceId,authority.action.expectedState.positionsRevision,JSON.stringify(state),sha256Canonical(state)])
  const counts=async()=>{
   const result={}
   for(const [table,column,id] of [['bridge_commands_v4','id',command.id],['bridge_command_payloads_v4','bridge_command_id',command.id],['position_protection_commands_v4','bridge_command_id',command.id],['bridge_command_events_v4','bridge_command_id',command.id],['outbox_events','aggregate_id',command.id]]) {
    const [[row]]=await db.execute(`SELECT COUNT(*) n FROM ${table} WHERE ${column}=?`,[id]);result[table]=Number(row.n)
   }return result
  }
  const empty=await counts()
  let authorizeCalls=0,replayCalls=0
  const repository=(after=null,loseAck=false,dispatch=false)=>{
   const wrapped={execute:(...args)=>db.execute(...args),async getConnection(){const c=await pool.getConnection();return new Proxy(c,{get(t,key){
    if(key==='commit')return async()=>{await t.commit();if(loseAck)throw Error('binding_commit_ack_loss')}
    if(key==='execute')return async(sql,...args)=>{const result=await t.execute(sql,...args)
     const table={command:'bridge_commands_v4',payload:'bridge_command_payloads_v4',event:'bridge_command_events_v4',outbox:'outbox_events'}[after]
     if(table && new RegExp('^\\s*INSERT INTO '+table+'\\b').test(sql))throw Error('binding_after_'+after+'_fault')
     if(after?.startsWith('dispatch:') && new RegExp('^\\s*(INSERT INTO|UPDATE) '+after.slice(9)+'\\b').test(sql))throw Error('dispatch_write_fault')
     return result}
    const value=t[key];return typeof value==='function'?value.bind(t):value
   }})}}
   return new MysqlBridgeCommandRepository(wrapped,()=>{throw Error('unexpected_clock')},()=>{throw Error('unexpected_policy')},undefined,async()=>({
    async authorize(connection,candidate,workflowId){authorizeCalls++
     const reviewer=createMysqlPositionProtectionCommandReviewer(connection,{async review(){return structuredClone(review)}},{async now(){
      const [[clock]]=await connection.query('SELECT UNIX_TIMESTAMP(UTC_TIMESTAMP(3))*1000 at');return new Date(Number(clock.at))
     }})
     return reviewer.review({...scope,workflowId},candidate.executionIntentId)
    },
    async bind(connection,candidate,current){await writePositionProtectionCommandBinding(connection,candidate,current);if(after==='binding')throw Error('binding_after_write_fault')},
    async replay(connection,candidate,workflowId){replayCalls++;await replayPositionProtectionCommandBinding(connection,candidate,workflowId)},
   }),dispatch?async()=>async(connection,candidate,workflowId)=>{
    const clock={async now(){const [[row]]=await connection.query('SELECT UNIX_TIMESTAMP(UTC_TIMESTAMP(3))*1000 at');return new Date(Number(row.at))}}
    const reviewer=createMysqlPositionProtectionCommandReviewer(connection,{async review(){
     const fresh=structuredClone(review);fresh.evaluation.evaluatedAt=(await clock.now()).toISOString();return fresh
    }},clock)
    return writePositionProtectionDispatchReview(connection,candidate,workflowId,reviewer)
   }:undefined)
  }
  const [activeFixtures]=await db.query("SELECT id,status FROM bridge_commands_v4 WHERE status IN ('queued','dispatched','accepted','uncertain','reconciling')")
  if(activeFixtures.length){
   await assert.rejects(()=>repository().create(command),/bridge_account_command_inflight/);assert.deepEqual(await counts(),empty)
   checks.push('unrelated-active-command-blocks-new-protection-command')
   for(const row of activeFixtures){parked.push(row);await db.execute("UPDATE bridge_commands_v4 SET status='succeeded' WHERE id=?",[row.id])}
  }
  for(const phase of ['command','payload','binding','event','outbox']){await assert.rejects(()=>repository(phase).create(command),/binding_after_/);assert.deepEqual(await counts(),empty)}
  checks.push('command-payload-binding-event-outbox-rollback-together-on-late-faults')
  await db.query('UPDATE bridge_trade_state_snapshots_v4 SET projection_revision=projection_revision+1')
  await assert.rejects(()=>repository().create(command),/bridge_command_intent_payload_mismatch/);assert.deepEqual(await counts(),empty)
  await db.query('UPDATE bridge_trade_state_snapshots_v4 SET projection_revision=projection_revision-1')
  checks.push('current-Bridge-snapshot-revision-mismatch-refuses-binding-and-rolls-command-back')
  let preparationReceiverEvidence
  if(options.bindingOnly){
   await assert.rejects(()=>repository(null,true).create(command),/bridge_command_commit_unknown/)
   preparationReceiverEvidence={scope:'repository-only',transportInvoked:false}
  }else preparationReceiverEvidence=await verifyProtectionReceiverPreparation(pool,repository,commandInput,scope,now)
  const saved=await counts();assert.ok(Object.values(saved).every(n=>n===1))
  const reviewed=authorizeCalls
  const recovered=await repository().create(command);assert.equal(recovered.id,command.id);assert.deepEqual(await counts(),saved)
  assert.equal(authorizeCalls,reviewed);assert.equal(replayCalls,1)
  checks.push('committed-binding-ack-loss-replays-original-command-and-authority-with-no-second-outbox')
  const concurrent=await Promise.all([repository().create(command),repository().create(command)])
  assert.ok(concurrent.every(c=>c.id===command.id && c.requestHash===command.requestHash))
  assert.equal(authorizeCalls,reviewed);assert.deepEqual(await counts(),saved)
  checks.push('concurrent-recovery-reuses-command-binding-without-new-risk-review-or-outbox')
  if(options.bindingOnly&&!options.dispatch)return {passed:true,checks,preparationReceiverEvidence,commandId:command.id,childIntentId:child.intent.id,
   migrationSha256:createHash('sha256').update(migration).digest('hex'),commandCreation:'actual-MysqlBridgeCommandRepository',
   riskReview:'injected-current-risk-port-with-real-source-reviewer',dispatched:false}
  const preflight=async()=>{
   await db.beginTransaction()
   try {
    const clock={async now(){const [[row]]=await db.query('SELECT UNIX_TIMESTAMP(UTC_TIMESTAMP(3))*1000 at');return new Date(Number(row.at))}}
    const reviewer=createMysqlPositionProtectionCommandReviewer(db,{async review(){
     const fresh=structuredClone(review);fresh.evaluation.evaluatedAt=(await clock.now()).toISOString();return fresh
    }},clock)
    return await readPositionProtectionDispatchReview(db,recovered,scope.workflowId,reviewer)
   }finally{await db.rollback()}
  }
  const dispatchReview=await preflight()
  assert.equal(dispatchReview.commandId,command.id);assert.equal(dispatchReview.commandHash,command.requestHash)
  assert.deepEqual(await counts(),saved)
  await db.query('UPDATE bridge_trade_state_snapshots_v4 SET projection_revision=projection_revision+1')
  await assert.rejects(preflight,/position_protection_dispatch_snapshot_invalid/)
  await db.query('UPDATE bridge_trade_state_snapshots_v4 SET projection_revision=projection_revision-1')
  const changedState={...state,stop_loss:'2401'}
  await db.execute('UPDATE bridge_trade_state_snapshots_v4 SET state_json=?,state_sha256=?',[JSON.stringify(changedState),sha256Canonical(changedState)])
  await assert.rejects(preflight,/position_protection_dispatch_snapshot_invalid/)
  await db.execute('UPDATE bridge_trade_state_snapshots_v4 SET state_json=?,state_sha256=?',[JSON.stringify(state),sha256Canonical(state)])
  assert.deepEqual(await counts(),saved)
  checks.push('dispatch-review-real-source-and-binding-rejects-changed-snapshot-without-rewriting-command')
  await db.beginTransaction()
  try {
   const changed=structuredClone(authority);changed.review.contextHash='f'.repeat(64)
   await assert.rejects(()=>writePositionProtectionCommandBinding(db,command,changed),/command_binding_invalid/)
  } finally {await db.rollback()}
  checks.push('changed-authority-cannot-replace-existing-binding')
  await assert.rejects(()=>db.execute("UPDATE position_protection_commands_v4 SET child_intent_id='33333333-3333-5333-a333-333333333333' WHERE bridge_command_id=?",[command.id]),e=>e.code==='ER_NO_REFERENCED_ROW_2')
  checks.push('actual-059-composite-foreign-keys-bind-command-to-its-child-and-workflow')
  const dispatchMigration=await readFile(new URL('../../server/db/migrations/inplace/060_position_protection_dispatches.sql',import.meta.url),'utf8')
  for(const sql of splitSqlStatements(dispatchMigration))await db.query(sql)
  await db.query('ALTER TABLE bridge_command_events_v4 ADD KEY idx_protection_command_events (bridge_command_id)')
  await db.query('ALTER TABLE bridge_command_events_v4 DROP PRIMARY KEY, ADD id BIGINT AUTO_INCREMENT PRIMARY KEY')
  await db.query('CREATE TABLE execution_distribution_targets (id CHAR(36),distribution_id CHAR(36),child_operation_id CHAR(36),status VARCHAR(32),revision INT) ENGINE=InnoDB')
  const dispatchState=async()=>{
   const [[row]]=await db.execute(`SELECT c.status command_status,c.revision command_revision,i.status intent_status,i.revision intent_revision,
    o.status operation_status,o.revision operation_revision FROM bridge_commands_v4 c
    JOIN execution_intents i ON i.id=c.execution_intent_id JOIN operations o ON o.id=i.operation_id WHERE c.id=?`,[command.id])
   const [[receipts]]=await db.execute('SELECT COUNT(*) n FROM position_protection_dispatches_v4 WHERE bridge_command_id=?',[command.id])
   return {row,receipts:Number(receipts.n),counts:await counts()}
  }
  const beforeDispatch=await dispatchState()
  await assert.rejects(()=>repository().markDispatched(command.id,1,now.toISOString()),/position_protection_dispatch_unavailable/)
  for(const table of ['position_protection_dispatches_v4','bridge_commands_v4','execution_intents','operations','operation_events','outbox_events']){
   await assert.rejects(()=>repository('dispatch:'+table,false,true).markDispatched(command.id,1,now.toISOString()),/dispatch_write_fault/)
   assert.deepEqual(await dispatchState(),beforeDispatch)
  }
  checks.push('actual-dispatch-review-command-intent-operation-and-outbox-roll-back-on-six-write-faults')
  let sends=0
  const transport={async currentRoute(){return command.route},async send(){sends++}}
  let receiverEvidence
  if(options.bindingOnly){
   await assert.rejects(()=>repository(null,true,true).markDispatched(command.id,1,now.toISOString()),/bridge_command_commit_unknown/)
   receiverEvidence={scope:'repository-dispatch-transaction-only',transportInvoked:false}
  }else receiverEvidence=await verifyProtectionReceiverDispatch(pool,repository,command,scope,now)
  assert.equal(sends,0)
  const afterDispatch=await dispatchState()
  assert.equal(afterDispatch.row.command_status,'dispatched');assert.equal(afterDispatch.row.command_revision,2)
  assert.equal(afterDispatch.row.intent_status,'dispatching');assert.equal(afterDispatch.row.operation_status,'running');assert.equal(afterDispatch.receipts,1)
  await assert.rejects(()=>repository(null,false,true).markDispatched(command.id,1,now.toISOString()),/bridge_command_revision_conflict/)
  const resume=await new BridgeCommandService(repository(null,false,true)).dispatchQueued(command.id,transport,now)
  assert.equal(resume.dispatched,false);assert.equal(sends,0)
  assert.deepEqual(await dispatchState(),afterDispatch)
  checks.push('dispatch-commit-ack-loss-persists-one-review-and-service-recovery-never-resends')
  if(options.bindingOnly){
   const outcomeReceiptEvidence=options.result?await verifyProtectionOutcomeReceipt(db,await repository().get(command.id),pool):undefined
   return {passed:true,checks,preparationReceiverEvidence,receiverEvidence,outcomeReceiptEvidence,commandId:command.id,childIntentId:child.intent.id,
   migrationSha256:createHash('sha256').update(migration).digest('hex'),dispatchMigrationSha256:createHash('sha256').update(dispatchMigration).digest('hex'),
   commandCreation:'actual-MysqlBridgeCommandRepository',riskReview:'injected-current-risk-port-with-real-source-reviewer',dispatchState:afterDispatch,sends}
  }
  const reconciliationRequestEvidence=await verifyProtectionReconciliationRequest(pool,db,scope,command)
  checks.push('durable-reconciliation-request-concurrency-commit-loss-and-cooldown-verified')
  const outcomeReceiptEvidence=await verifyProtectionOutcomeReceipt(db,await repository().get(command.id),pool)
  const unissuedExpiryEvidence=await verifyProtectionUnissuedExpiry(pool,await createExpiryScope())
  return {passed:true,checks,reconciliationRequestEvidence,preparationReceiverEvidence,receiverEvidence,outcomeReceiptEvidence,unissuedExpiryEvidence,migrationSha256:createHash('sha256').update(migration).digest('hex'),commandCreation:'actual-MysqlBridgeCommandRepository',riskReview:'injected-current-risk-port-with-real-source-reviewer',bridgeParentSchema:'query-scaffold',runtimeRepositoryWired:false}
 }finally{await db.rollback();for(const row of parked)await db.execute('UPDATE bridge_commands_v4 SET status=? WHERE id=?',[row.status,row.id]);db.release()}
}
