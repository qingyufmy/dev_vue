import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {readFile} from 'node:fs/promises'
import {splitSqlStatements} from './v4-migration-plan.mjs'
import {sha256Canonical} from '../../server/dist-v4/modules/execution/domain/execution.js'
import {createMysqlPositionProtectionPreparation} from '../../server/dist-v4/modules/execution/composition.js'
import mysql from 'mysql2/promise'
import {verifyPositionProtectionBinding} from './position-protection-binding-reference.mjs'

export async function verifyBoundChildPersistence(db,input){
 const [[origin]]=await db.query('SELECT DATABASE() db');assert.match(origin.db,/^dev_vue_history_ref_[a-f0-9]{32}$/)
 const name='dev_vue_protection_ref_'+randomUUID().replaceAll('-','')
 const {plan,ready,parentOperationId,review}=structuredClone(input)
 assert.equal(plan.target.userId,'7');assert.equal(plan.target.accountId,'5')
 const {workflowId,parentIntentId,parentCommandId}=plan
 let created=false,fault=null,reviewCalls=0,commandPool
 try{
  await db.query('CREATE DATABASE `'+name+'` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci');created=true
  await db.query('USE `'+name+'`')
  const id='CHAR(36) CHARACTER SET ascii COLLATE ascii_bin'
  for(const sql of [
   'CREATE TABLE users (id INT PRIMARY KEY) ENGINE=InnoDB','CREATE TABLE trading_accounts (id BIGINT UNSIGNED PRIMARY KEY) ENGINE=InnoDB',
   `CREATE TABLE risk_decisions_v4 (id ${id} PRIMARY KEY) ENGINE=InnoDB`,`CREATE TABLE trade_decisions (id ${id} PRIMARY KEY) ENGINE=InnoDB`,
   `CREATE TABLE user_execution_commands (id ${id} PRIMARY KEY) ENGINE=InnoDB`,
   "CREATE TABLE trading_account_ownerships (trading_account_id BIGINT UNSIGNED,user_id INT,role VARCHAR(32),revoked_at_utc DATETIME(3)) ENGINE=InnoDB",
   `CREATE TABLE bridge_commands_v4 (id VARCHAR(191) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,execution_intent_id ${id},user_id INT,trading_account_id BIGINT UNSIGNED,action VARCHAR(64),status VARCHAR(32)) ENGINE=InnoDB`,
   `CREATE TABLE outbox_events (event_id ${id} PRIMARY KEY,aggregate_type VARCHAR(64),aggregate_id VARCHAR(191),event_type VARCHAR(128),payload_json JSON,status VARCHAR(32),attempts INT,available_at_utc DATETIME(3),created_at_utc DATETIME(3)) ENGINE=InnoDB`,
  ]) await db.query(sql)
  const load=async path=>splitSqlStatements(await readFile(new URL('../../server/db/migrations/'+path,import.meta.url),'utf8'))
  const base=await load('20260903_009_execution_intents_and_reservations.sql')
  for(const table of ['operations','operation_events','execution_intents','execution_intent_payloads','execution_intent_events']) {
   const ddl=base.find(sql=>new RegExp('CREATE TABLE IF NOT EXISTS '+table+' \\(').test(sql));assert.ok(ddl);await db.query(ddl)
  }
  const user=await load('20260904_011_user_execution_commands_and_distributions.sql')
  await db.query(user.find(sql=>/ALTER TABLE operations/.test(sql)))
  for(const sql of await load('corrections/011-execution-intent-foreign-keys.sql'))await db.query(sql)
  for(const sql of await load('inplace/056_partial_close_workflows.sql'))await db.query(sql)
  const migration=await readFile(new URL('../../server/db/migrations/inplace/058_position_protection_children.sql',import.meta.url),'utf8')
  for(const sql of splitSqlStatements(migration))await db.query(sql)
  await db.query('INSERT INTO users VALUES (7)');await db.query('INSERT INTO trading_accounts VALUES (5)')
  await db.query("INSERT INTO trading_account_ownerships VALUES (5,7,'owner',NULL)")
  const userCommand=randomUUID();await db.execute('INSERT INTO user_execution_commands VALUES (?)',[userCommand])
   await db.execute(`INSERT INTO operations (id,user_id,trading_account_id,kind,status,source_type,source_id,idempotency_scope,idempotency_key,request_sha256,accepted_at_utc,updated_at_utc)
    VALUES (?,7,5,'user_execution_command','succeeded','user_command',?,'user_command',?,?,UTC_TIMESTAMP(3),UTC_TIMESTAMP(3))`,[parentOperationId,userCommand,sha256Canonical(parentOperationId),sha256Canonical('parent')])
   await db.execute(`INSERT INTO execution_intents (id,operation_id,risk_decision_id,trade_decision_id,user_command_id,risk_decision_revision,account_risk_revision,user_id,trading_account_id,action_id,action_kind,source_type,source_id,idempotency_key,request_sha256,expected_state_sha256,status,expires_at_utc,created_at_utc,updated_at_utc)
    VALUES (?,?,NULL,NULL,?,NULL,1,7,5,?,'close_position','user_command',?,?,?,?,'succeeded',DATE_ADD(UTC_TIMESTAMP(3),INTERVAL 1 MINUTE),UTC_TIMESTAMP(3),UTC_TIMESTAMP(3))`,
    [parentIntentId,parentOperationId,userCommand,parentIntentId,userCommand,sha256Canonical(parentIntentId),sha256Canonical('parent'),sha256Canonical({})])
   await db.execute("INSERT INTO bridge_commands_v4 (id,execution_intent_id,user_id,trading_account_id,action,status) VALUES (?,?,7,5,'position.close','succeeded')",[parentCommandId,parentIntentId])

  const time=value=>new Date(value).toISOString().replace('T',' ').replace('Z','')
  await db.execute(`INSERT INTO partial_close_workflows_v4 (id,parent_intent_id,parent_command_id,user_id,trading_account_id,plan_json,plan_sha256,status,revision,expires_at_utc,created_at_utc,updated_at_utc)
   VALUES (?,?,?,7,5,?,?,'risk_review_required',2,?,?,?)`,[workflowId,parentIntentId,parentCommandId,JSON.stringify(plan),sha256Canonical(plan),time(plan.expiresAt),time(ready.projectionObservedAt),time(ready.projectionObservedAt)])
  for(const [revision,type,payload] of [[1,'registered',{planHash:sha256Canonical(plan),parentIntentId,parentCommandId}],[2,'risk_review_required',{planHash:sha256Canonical(plan),assessment:ready}]])
   await db.execute('INSERT INTO partial_close_workflow_events_v4 VALUES (?,?,?,?,?,UTC_TIMESTAMP(3))',[workflowId,revision,type,JSON.stringify(payload),sha256Canonical(payload)])
  const wrapped=new Proxy(db,{get(target,key){
   if(key==='release')return ()=>{}
   if(key==='execute')return async(sql,...args)=>{const result=await target.execute(sql,...args);if(fault&&new RegExp('^\\s*(INSERT INTO|UPDATE) '+fault+'\\b').test(sql))throw Error('child_late_write_fault');return result}
   const value=target[key];return typeof value==='function'?value.bind(target):value
  }})
  const service=createMysqlPositionProtectionPreparation({async getConnection(){return wrapped}},async()=>()=>({async review(request){reviewCalls++;assert.equal(sha256Canonical(request),review.requestHash);return structuredClone(review)}}))
  const scope={workflowId,userId:7,accountId:'5'}
  const state=async()=>{
   const counts=[];for(const [table,key] of [['operations','source_id'],['execution_intents','position_workflow_id'],['position_protection_reviews_v4','workflow_id'],['partial_close_workflow_events_v4','workflow_id'],['outbox_events','aggregate_id']]){
    const [[row]]=await db.execute(`SELECT COUNT(*) n FROM ${table} WHERE ${key}=?`,[workflowId]);counts.push(Number(row.n))}
   const [[row]]=await db.execute('SELECT status,revision FROM partial_close_workflows_v4 WHERE id=?',[workflowId]);return {status:row.status,revision:Number(row.revision),counts}
  }
  const before=await state()
  for(const table of ['operations','operation_events','execution_intents','execution_intent_payloads','execution_intent_events','position_protection_reviews_v4','partial_close_workflows_v4','partial_close_workflow_events_v4','outbox_events']){
   fault=table;await assert.rejects(()=>service.prepare(scope),/child_late_write_fault/);assert.deepEqual(await state(),before)
  }
  fault=null;const result=await service.prepare(scope);assert.equal(result.status,'protecting')
  const after=await state();assert.deepEqual(after,{status:'protecting',revision:3,counts:[1,1,1,3,1]})
  const calls=reviewCalls;assert.equal((await service.prepare(scope)).replayed,true);assert.equal(reviewCalls,calls);assert.deepEqual(await state(),after)
  const config=db.config??db.connection?.config
  assert.ok(config)
  commandPool=mysql.createPool({host:config.host,port:config.port,user:config.user,password:config.password,database:name,timezone:'Z',connectionLimit:4})
  const scopedPool={execute:(...args)=>commandPool.execute(...args),async getConnection(){const connection=await commandPool.getConnection();await connection.query("SET SESSION time_zone='+00:00'");return connection}}
  const commandBinding=await verifyPositionProtectionBinding(scopedPool,scope,undefined,{bindingOnly:true,dispatch:true,result:true,target:plan.target})
  return {passed:true,commandBinding,checks:['bound-SQL-history-and-position-review-persists-one-child','nine-late-writes-rollback-entire-preparation','replay-uses-durable-receipt-without-review'],
   schema:'actual-009-011-056-058-with-minimal-parent-tables',review:'frozen-prior-deterministic-review',referenceDatabaseRemoved:true}
 }finally{if(commandPool)await commandPool.end();await db.rollback();await db.query('USE `'+origin.db+'`');if(created)await db.query('DROP DATABASE `'+name+'`')}
}
