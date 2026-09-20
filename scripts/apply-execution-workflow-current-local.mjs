import {withDevelopmentAccountWriteFreeze} from './lib/development-account-write-freeze.mjs'
import assert from 'node:assert/strict'
import {readFile,open,writeFile} from 'node:fs/promises'
import {isAbsolute,join} from 'node:path'
import mysql from 'mysql2/promise'
import {loadCombinedExecutionWorkflowPlan} from './lib/execution-workflow-combined-plan.mjs'
import {inferenceRootSchemaState} from './lib/inference-root-schema-state.mjs'
import {coordinateInplaceSchema} from './lib/inplace-schema-coordinator.mjs'
import {mysqlColumnStore,verifyInplaceJournal} from './lib/mysql-inplace-column-store.mjs'
import {validateColumnHistory} from './lib/dev-vue-column-upgrade.mjs'
import {readAccountRootSnapshot} from './lib/mysql-account-root-snapshot.mjs'
import {subscriptionRootRenames} from './lib/subscription-root-promotion.mjs'
import {hash} from './lib/v4-backfill-contract.mjs'
import {sha256} from './lib/v4-migration-plan.mjs'

const [destination]=process.argv.slice(2),root=new URL('../',import.meta.url),target='dev_vue'
assert.ok(process.argv.length===3&&isAbsolute(destination??''))
const plan=await loadCombinedExecutionWorkflowPlan(root),planHash=hash({steps:plan.steps,transitions:plan.transitions})
const evidence=JSON.parse(await readFile(new URL('docs/architecture/inference-root-durable-v1-20260910.json',root),'utf8'))
assert.ok(evidence.passed&&evidence.target==='dev_vue_m1_source_20260910_02'&&evidence.completedSteps===206&&evidence.currentDevVueWrites===0)
const proof=JSON.parse(await readFile(new URL('docs/architecture/inference-restored-baseline-20260910.json',root),'utf8'))
const receipt=await readFile(join(proof.archiveDirectory,'receipt.json'))
assert.equal(sha256(receipt),evidence.receiptSha256);assert.equal(JSON.parse(receipt).status,'verified')
const preflight=JSON.parse(await readFile(new URL('docs/architecture/execution-workflow-current-preflight-v1-20260910.json',root)))
assert.ok(preflight.passed&&preflight.backupCiphertextVerified&&preflight.writes===0);assert.equal(preflight.planHash,planHash)
const restored=JSON.parse(await readFile(new URL('docs/architecture/execution-workflow-restored-v1-20260910.json',root)))
const replayed=JSON.parse(await readFile(new URL('docs/architecture/execution-workflow-restored-v2-20260910.json',root)))
assert.ok(restored.passed&&replayed.passed&&restored.completedSteps===238&&restored.ddlAttempted===32&&replayed.ddlAttempted===0)
assert.equal(restored.afterSnapshotHash,replayed.afterSnapshotHash);assert.equal(new Set(restored.cases.map(row=>row.id)).size,32)
const rootCandidate=JSON.parse(await readFile(new URL('docs/architecture/inference-root-promotion-candidate-v1-20260910.json',root)))
const baselinePath=new URL('docs/architecture/execution-workflow-current-baseline-20260910.json',root)
const output=await open(destination,'wx',0o600)
const report={kind:'execution-workflow-current-upgrade/v1',passed:false,target,planHash,receiptSha256:evidence.receiptSha256,
 businessDataWrites:0,phase:'admission',ddlAttempted:0,cases:[]}
let db,locked=false,held
try{
 const chunks=[];for await(const chunk of process.stdin)chunks.push(chunk)
 const credential=JSON.parse(Buffer.concat(chunks).toString('utf8'))
 assert.ok(credential.host==='127.0.0.1'&&credential.port===13316&&credential.user==='root')
 db=await mysql.createConnection({...credential,database:target,timezone:'Z',dateStrings:true,jsonStrings:true,supportBigNumbers:true,bigNumberStrings:true})
 await db.query("SET SESSION time_zone='+00:00'")
 const [[lock]]=await db.execute('SELECT GET_LOCK(?,0) acquired',['aurum:inplace:'+target]);assert.equal(Number(lock.acquired),1);locked=true
 const guard=async()=>{
  if(held)await held.assertHeld()
  const [[identity]]=await db.query('SELECT DATABASE() db,@@server_uuid uuid,@@innodb_force_recovery recovery,@@session.time_zone timezone')
  assert.equal(identity.db,target);assert.equal(identity.uuid,'ac423207-6ef3-11f1-b302-000c29fda104');assert.equal(Number(identity.recovery),0);assert.equal(identity.timezone,'+00:00')
  const [[lock]]=await db.execute('SELECT IS_USED_LOCK(?) owner,CONNECTION_ID() currentId',['aurum:inplace:'+target]);assert.equal(String(lock.owner),String(lock.currentId))
  const [[clients]]=await db.query('SELECT COUNT(*) n FROM information_schema.PROCESSLIST WHERE DB=DATABASE() AND ID<>CONNECTION_ID()');assert.equal(Number(clients.n),0)
  const [triggers]=await db.query('SELECT TRIGGER_NAME FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA=DATABASE()');assert.equal(triggers.length,0)
 }
 await guard()
 await withDevelopmentAccountWriteFreeze(db,async freeze=>{
 held=freeze;report.frozenAccountCount=freeze.accountCount
 assert.ok(await verifyInplaceJournal(db))
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
  assert.equal(history.length,205);assert.ok(history.every(row=>row.status==='completed'))
  assert.equal((await schema()).sha256,plan.added[0].beforeHash)
  const tables=await snapshot();assert.equal(hash(tables),preflight.snapshotHash,'current_preflight_drift')
  baseline={target,planHash,receiptSha256:evidence.receiptSha256,history,tables}
  await writeFile(baselinePath,JSON.stringify(baseline,null,2)+'\n',{flag:'wx',mode:0o600})
 }
 assert.equal(baseline.target,target);assert.equal(baseline.planHash,planHash);assert.equal(baseline.receiptSha256,evidence.receiptSha256)
 report.baselineHash=hash(baseline)
 let inject=false
 const store={...journal,async tableHash(key){assert.ok(['inference_root_schema','execution_workflow_schema'].includes(key));await guard();return (await schema()).sha256},
  async execute(sql){await guard();assert.ok(plan.added.some(step=>step.sql===sql));report.ddlAttempted++;await journal.execute(sql)
   if(inject){const step=plan.added.find(step=>step.sql===sql);report.cases.push({id:step.id,kind:'DDL-persisted-ack-lost'});throw new Error('injected_DDL_ack_loss')}}}
 report.phase='apply'
 for(let attempt=0;attempt<=plan.added.length;attempt++){
  try{report.result=await coordinateInplaceSchema(store,plan,{apply:true});break}
  catch(error){if(error.message!=='injected_DDL_ack_loss')throw error}
 }
 assert.ok(report.result?.structureComplete)
 inject=false;const executions=report.ddlAttempted
 report.replay=await coordinateInplaceSchema(store,plan,{apply:true});assert.equal(report.ddlAttempted,executions)
 report.phase='verify-data';const after=await snapshot(),byName=new Map(after.map(row=>[row.name,row])),mapping=new Map([...rootCandidate.renames.map(({from,to})=>[from,to]),...subscriptionRootRenames])
 assert.equal(after.length,293)
 for(const row of baseline.tables){if(row.name==='database_upgrade_steps_v4')continue
  const actual=byName.get(mapping.get(row.name)??row.name);assert.ok(actual);assert.equal(actual.rows,row.rows);assert.equal(actual.rowsSha256,row.rowsSha256)}
 const originalNames=new Set(baseline.tables.map(row=>mapping.get(row.name)??row.name))
 for(const row of after)if(!originalNames.has(row.name))assert.equal(row.rows,0)
 const finalHistory=await journal.history();assert.equal(finalHistory.length,238);assert.ok(finalHistory.every(row=>row.status==='completed'))
 assert.deepEqual(finalHistory.filter(row=>!plan.added.some(step=>step.id===row.id)),baseline.history)
 assert.equal((await schema()).sha256,plan.finalSchemaHash)
 report.completedSteps=238;report.tableCount=after.length;report.businessRows=after.filter(row=>row.name!=='database_upgrade_steps_v4').reduce((sum,row)=>sum+row.rows,0)
 report.afterSnapshotHash=hash(after);report.phase='complete'
 });held=undefined;report.writeFreezeRestored=true;report.passed=true
}catch(error){report.passed=false;report.errorCode=error?.code??error?.name??'rehearsal_failed';report.assertion=error?.code==='ERR_ASSERTION'?{operator:error.operator}:undefined;process.exitCode=1}
finally{
 if(db){try{await db.rollback();if(locked)await db.execute('SELECT RELEASE_LOCK(?)',['aurum:inplace:'+target])}finally{await db.end()}}
 report.observedAt=new Date().toISOString();await output.writeFile(JSON.stringify(report,null,2)+'\n');await output.close()
 console.log(JSON.stringify({passed:report.passed,phase:report.phase,errorCode:report.errorCode,ddlAttempted:report.ddlAttempted,completedSteps:report.completedSteps,tableCount:report.tableCount,businessDataWrites:0}))
}
