import {loadInferenceRootUpgrade} from './lib/inference-root-upgrade.mjs'
import {coordinateInferenceRootPromotion} from './lib/inference-root-schema-state.mjs'
import {mysqlColumnStore,verifyInplaceJournal} from './lib/mysql-inplace-column-store.mjs'
import assert from 'node:assert/strict'
import {readFile,open,writeFile} from 'node:fs/promises'
import {isAbsolute,join} from 'node:path'
import mysql from 'mysql2/promise'
import {loadQuoteProvenanceUpgrade} from './lib/quote-provenance-upgrade.mjs'
import {loadInferenceBuildUpgrade} from './lib/inference-build-upgrade.mjs'
import {planInferenceRootPromotion} from './lib/inference-root-promotion.mjs'
import {readAccountRootSnapshot} from './lib/mysql-account-root-snapshot.mjs'
import {tableDefinitionHash} from './lib/inplace-foundation-upgrade.mjs'
import {sha256} from './lib/v4-migration-plan.mjs'
import {hash} from './lib/v4-backfill-contract.mjs'

const [destination]=process.argv.slice(2),root=new URL('../',import.meta.url)
assert.ok(process.argv.length===3 && isAbsolute(destination??''))
const target='dev_vue_m1_source_20260910_02'
const evidence=JSON.parse(await readFile(new URL('docs/architecture/quote-restored-replay-20260910.json',root)))
assert.ok(evidence.passed && evidence.target===target && evidence.currentDevVueWrites===0)
const proof=JSON.parse(await readFile(new URL('docs/architecture/inference-restored-baseline-20260910.json',root)))
const receipt=await readFile(join(proof.archiveDirectory,'receipt.json'))
assert.equal(sha256(receipt),evidence.receiptSha256);assert.equal(JSON.parse(receipt).status,'verified')
const inventory=JSON.parse(await readFile(new URL('docs/architecture/execution-upgrade-source-inventory-v2-20260910.json',root)))
const upgrade=await loadQuoteProvenanceUpgrade(root),build=await loadInferenceBuildUpgrade(root)
const plan=planInferenceRootPromotion(inventory,build.finalTableHashes)
const durablePlan=await loadInferenceRootUpgrade(root)
const output=await open(destination,'wx',0o600)
const report={kind:'inference-root-durable-rehearsal/v1',passed:false,target,currentDevVueWrites:0,
 receiptSha256:evidence.receiptSha256,planHash:hash(plan),phase:'admission',ddlAttempted:0}
let db,locked=false
try{
 const chunks=[];for await(const chunk of process.stdin)chunks.push(chunk)
 const credential=JSON.parse(Buffer.concat(chunks).toString('utf8'))
 assert.ok(credential.host==='127.0.0.1' && credential.port===13316 && credential.user==='root')
 db=await mysql.createConnection({...credential,database:target,timezone:'Z',dateStrings:true,jsonStrings:true,supportBigNumbers:true,bigNumberStrings:true})
 await db.query("SET SESSION time_zone='+00:00'")
 const [[identity]]=await db.query('SELECT DATABASE() db,@@server_uuid uuid,@@innodb_force_recovery recovery')
 assert.equal(identity.db,target);assert.equal(identity.uuid,evidence.serverUuid);assert.equal(Number(identity.recovery),0)
 const [[lock]]=await db.execute('SELECT GET_LOCK(?,0) acquired',['aurum:inplace:'+target]);assert.equal(Number(lock.acquired),1);locked=true
 const [[clients]]=await db.query('SELECT COUNT(*) n FROM information_schema.PROCESSLIST WHERE DB=DATABASE() AND ID<>CONNECTION_ID()');assert.equal(Number(clients.n),0)
 const [triggers]=await db.query('SELECT TRIGGER_NAME FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA=DATABASE()');assert.equal(triggers.length,0)
 const [journal]=await db.query('SELECT id,checksum_sha256,status FROM database_upgrade_steps_v4 ORDER BY id')
 assert.equal(journal.length,upgrade.steps.length)
 for(const step of upgrade.steps){const row=journal.find(item=>item.id===step.id);assert.equal(row?.status,'completed');assert.equal(row?.checksum_sha256,step.checksum)}
 const snapshot=async()=>{await db.query('START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY');try{return (await readAccountRootSnapshot(db)).tables}finally{await db.rollback()}}
 report.phase='baseline';const before=await snapshot()
 const byName=new Map(before.map(table=>[table.name,table]))
 for(const [name,record] of Object.entries(inventory.tables)){
  const table=byName.get(name)
  if(record.exists){assert.ok(table);assert.equal(tableDefinitionHash(table.ddl),record.sha256);assert.equal(String(table.rows),record.rows)}
  else assert.equal(table,undefined)
 }
 // Persist exact recovery inputs before the first DDL; reports contain hashes, never row payloads.
 const baseline={target,plan,before,receiptSha256:evidence.receiptSha256,journal}
 await writeFile(destination+'.baseline.json',JSON.stringify(baseline,null,2)+'\n',{flag:'wx',mode:0o600})
 report.baselineHash=hash(baseline);report.tableCount=before.length
 report.totalRows=before.reduce((sum,row)=>sum+Number(row.rows),0)
 report.phase='durable-coordinator'
 assert.ok(await verifyInplaceJournal(db))
 const journalStore=mysqlColumnStore(db,true)
 const verifyGuard=async()=>{
  const [[identity]]=await db.query('SELECT DATABASE() db,@@server_uuid uuid')
  assert.equal(identity.db,target);assert.equal(identity.uuid,evidence.serverUuid)
  const [[lock]]=await db.execute('SELECT IS_USED_LOCK(?) owner,CONNECTION_ID() currentId',['aurum:inplace:'+target]);assert.equal(String(lock.owner),String(lock.currentId))
 }
 const schemaTables=async()=>{
  const [names]=await db.query("SELECT TABLE_NAME name FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_TYPE='BASE TABLE'")
  const result=[]
  for(const {name} of names){assert.match(name,/^[a-z][a-z0-9_]*$/);const [[row]]=await db.query('SHOW CREATE TABLE `'+name+'`');result.push({name,ddl:row['Create Table']})}
  return result
 }
 let injected=null
 const store={...journalStore,verifyGuard,schemaTables,
  async begin(step){await journalStore.begin(step);if(injected==='begin')throw new Error('injected_begin_ack_loss')},
  async execute(sql){report.ddlAttempted++;await journalStore.execute(sql);if(injected==='ddl')throw new Error('injected_ddl_ack_loss')},
  async complete(step){await journalStore.complete(step);if(injected==='complete')throw new Error('injected_complete_ack_loss')}}
 report.cases=[]
 for(const fault of ['begin','ddl','complete']){
  injected=fault
  await assert.rejects(coordinateInferenceRootPromotion(store,durablePlan,{apply:true}),new RegExp('injected_'+fault+'_ack_loss'))
  report.cases.push({fault,ddlAttempted:report.ddlAttempted,history:await journalStore.history()})
 }
 injected=null
 report.replay=await coordinateInferenceRootPromotion(store,durablePlan,{apply:true})
 assert.ok(report.replay.structureComplete);assert.equal(report.ddlAttempted,1)
 const [finalJournal]=await db.query('SELECT id,checksum_sha256,status FROM database_upgrade_steps_v4 ORDER BY id')
 assert.equal(finalJournal.length,206)
 assert.deepEqual(finalJournal.filter(row=>row.id!==durablePlan.step.id),journal)
 assert.equal(finalJournal.find(row=>row.id===durablePlan.step.id)?.status,'completed')
 report.completedSteps=finalJournal.length
 report.phase='verify-promoted';const after=await snapshot(),actual=new Map(after.map(row=>[row.name,row]))
 const mapping=new Map(plan.renames.map(({from,to})=>[from,to]))
 assert.equal(after.length,before.length)
 for(const original of before){if(original.name==='database_upgrade_steps_v4')continue;const row=actual.get(mapping.get(original.name)??original.name)
  assert.ok(row);assert.equal(row.rows,original.rows);assert.equal(row.rowsSha256,original.rowsSha256)}
 report.promotedSnapshotHash=hash(after)
 report.passed=true;report.phase='complete'
 report.checks=['durable-start-ack-loss','durable-DDL-ack-loss-no-repeat-rename','durable-completion-ack-loss-replay',
  'all-business-row-digests-preserved','prior-205-journal-records-unchanged']
 report.durableUpgradeCoordinatorVerified=true
}catch(error){report.errorCode=error?.code??error?.name??'rehearsal_failed';process.exitCode=1}
finally{
 if(db){try{await db.rollback();if(locked)await db.execute('SELECT RELEASE_LOCK(?)',['aurum:inplace:'+target])}finally{await db.end()}}
 report.observedAt=new Date().toISOString();await output.writeFile(JSON.stringify(report,null,2)+'\n');await output.close()
 console.log(JSON.stringify({passed:report.passed,target:report.target,phase:report.phase,errorCode:report.errorCode,ddlAttempted:report.ddlAttempted,completedSteps:report.completedSteps,currentDevVueWrites:0}))
}
