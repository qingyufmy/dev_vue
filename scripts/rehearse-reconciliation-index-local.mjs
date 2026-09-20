import assert from 'node:assert/strict'
import {readFile,open,writeFile} from 'node:fs/promises'
import {isAbsolute,join} from 'node:path'
import mysql from 'mysql2/promise'
import {loadReconciliationIndexUpgrade} from './lib/reconciliation-index-upgrade.mjs'
import {inferenceRootSchemaState} from './lib/inference-root-schema-state.mjs'
import {coordinateInplaceSchema} from './lib/inplace-schema-coordinator.mjs'
import {mysqlColumnStore,verifyInplaceJournal} from './lib/mysql-inplace-column-store.mjs'
import {validateColumnHistory} from './lib/dev-vue-column-upgrade.mjs'
import {readAccountRootSnapshot} from './lib/mysql-account-root-snapshot.mjs'
import {hash} from './lib/v4-backfill-contract.mjs'
import {sha256} from './lib/v4-migration-plan.mjs'

const [destination]=process.argv.slice(2),root=new URL('../',import.meta.url),target='dev_vue_m1_source_20260910_02'
assert.ok(process.argv.length===3&&isAbsolute(destination??''))
const plan=await loadReconciliationIndexUpgrade(root),planHash=hash({steps:plan.steps,transitions:plan.transitions})
const proof=JSON.parse(await readFile(new URL('docs/architecture/inference-restored-baseline-20260910.json',root)))
const receipt=await readFile(join(proof.archiveDirectory,'receipt.json'))
const previous=JSON.parse(await readFile(new URL('docs/architecture/execution-workflow-restored-v2-20260910.json',root)))
assert.ok(previous.passed&&previous.target===target&&previous.completedSteps===238&&previous.currentDevVueWrites===0)
assert.equal(sha256(receipt),previous.receiptSha256);assert.equal(JSON.parse(receipt).status,'verified')
const baselinePath=new URL('docs/architecture/reconciliation-index-restored-baseline-20260911.json',root)
const output=await open(destination,'wx',0o600)
const report={kind:'reconciliation-index-restored-rehearsal/v1',passed:false,target,planHash,receiptSha256:sha256(receipt),currentDevVueWrites:0,ddlAttempted:0,phase:'admission'}
let db,locked=false
try{
 const chunks=[];for await(const chunk of process.stdin)chunks.push(chunk)
 const credential=JSON.parse(Buffer.concat(chunks).toString('utf8'))
 assert.ok(credential.host==='127.0.0.1'&&credential.port===13316&&credential.user==='root')
 db=await mysql.createConnection({...credential,database:target,timezone:'Z',dateStrings:true,jsonStrings:true,supportBigNumbers:true,bigNumberStrings:true})
 await db.query("SET SESSION time_zone='+00:00'")
 const [[lock]]=await db.execute('SELECT GET_LOCK(?,0) acquired',['aurum:inplace:'+target]);assert.equal(Number(lock.acquired),1);locked=true
 const guard=async()=>{
  const [[identity]]=await db.query('SELECT DATABASE() db,@@server_uuid uuid,@@innodb_force_recovery recovery,@@session.time_zone timezone')
  assert.equal(identity.db,target);assert.equal(identity.uuid,'ac423207-6ef3-11f1-b302-000c29fda104');assert.equal(Number(identity.recovery),0);assert.equal(identity.timezone,'+00:00')
  const [[owner]]=await db.execute('SELECT IS_USED_LOCK(?) owner,CONNECTION_ID() currentId',['aurum:inplace:'+target]);assert.equal(String(owner.owner),String(owner.currentId))
  const [[clients]]=await db.query('SELECT COUNT(*) n FROM information_schema.PROCESSLIST WHERE DB=DATABASE() AND ID<>CONNECTION_ID()');assert.equal(Number(clients.n),0)
  const [triggers]=await db.query('SELECT TRIGGER_NAME FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA=DATABASE()');assert.equal(triggers.length,0)
 }
 await guard();assert.ok(await verifyInplaceJournal(db))
 const journal=mysqlColumnStore(db,true),history=await journal.history();validateColumnHistory(history,plan.steps)
 const schema=async()=>{
  const [names]=await db.query("SELECT TABLE_NAME name FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_TYPE='BASE TABLE'")
  const tables=[];for(const {name} of names){assert.match(name,/^[a-z][a-z0-9_]*$/);const [[row]]=await db.query('SHOW CREATE TABLE `'+name+'`');tables.push({name,ddl:row['Create Table']})}
  return inferenceRootSchemaState(tables)
 }
 const snapshot=async()=>{await db.query('START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY');try{return (await readAccountRootSnapshot(db)).tables}finally{await db.rollback()}}
 let baseline
 try{baseline=JSON.parse(await readFile(baselinePath,'utf8'))}catch(error){if(error.code!=='ENOENT')throw error}
 if(!baseline){
  assert.equal(history.length,238);assert.ok(history.every(row=>row.status==='completed'))
  assert.equal((await schema()).sha256,plan.step.beforeHash)
  baseline={target,planHash,receiptSha256:sha256(receipt),history,tables:await snapshot()}
  await writeFile(baselinePath,JSON.stringify(baseline,null,2)+'\n',{flag:'wx',mode:0o600})
 }
 assert.equal(baseline.target,target);assert.equal(baseline.planHash,planHash);assert.equal(baseline.receiptSha256,sha256(receipt))
 report.baselineHash=hash(baseline)
 const store={...journal,async tableHash(key){assert.equal(key,'execution_workflow_schema');await guard();return (await schema()).sha256},
  async execute(sql){await guard();assert.equal(sql,plan.step.sql);report.ddlAttempted++;await journal.execute(sql);throw Error('injected_DDL_ack_loss')}}
 report.phase='apply-with-DDL-ack-loss'
 try{report.result=await coordinateInplaceSchema(store,plan,{apply:true})}
 catch(error){if(error.message!=='injected_DDL_ack_loss')throw error
  const interrupted=await journal.history();assert.equal(interrupted.find(row=>row.id===plan.step.id)?.status,'started')
  assert.equal((await schema()).sha256,plan.step.afterHash);report.persistedDDLWithStartedJournal=true
  report.result=await coordinateInplaceSchema(store,plan,{apply:true})
 }
 assert.ok(report.result.structureComplete)
 const executions=report.ddlAttempted
 report.replay=await coordinateInplaceSchema(store,plan,{apply:true});assert.equal(report.ddlAttempted,executions)
 report.phase='verify-data';const after=await snapshot(),byName=new Map(after.map(row=>[row.name,row]))
 assert.equal(after.length,293)
 for(const row of baseline.tables){if(row.name==='database_upgrade_steps_v4')continue
  const actual=byName.get(row.name);assert.ok(actual);assert.equal(actual.rows,row.rows);assert.equal(actual.rowsSha256,row.rowsSha256)}
 const finalHistory=await journal.history();assert.equal(finalHistory.length,239);assert.ok(finalHistory.every(row=>row.status==='completed'))
 assert.deepEqual(finalHistory.filter(row=>row.id!==plan.step.id),baseline.history)
 assert.equal((await schema()).sha256,plan.finalSchemaHash)
 report.completedSteps=239;report.tableCount=after.length;report.businessRows=after.filter(row=>row.name!=='database_upgrade_steps_v4').reduce((sum,row)=>sum+row.rows,0)
 report.afterSnapshotHash=hash(after);report.passed=true;report.phase='complete'
}catch(error){report.errorCode=error?.code??error?.name??'rehearsal_failed';report.assertion=error?.code==='ERR_ASSERTION'?{operator:error.operator}:undefined;process.exitCode=1}
finally{
 if(db){try{await db.rollback();if(locked)await db.execute('SELECT RELEASE_LOCK(?)',['aurum:inplace:'+target])}finally{await db.end()}}
 report.observedAt=new Date().toISOString();await output.writeFile(JSON.stringify(report,null,2)+'\n');await output.close()
 console.log(JSON.stringify({passed:report.passed,phase:report.phase,errorCode:report.errorCode,ddlAttempted:report.ddlAttempted,completedSteps:report.completedSteps,businessRows:report.businessRows,currentDevVueWrites:0}))
}
