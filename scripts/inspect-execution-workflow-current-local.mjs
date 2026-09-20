import assert from 'node:assert/strict'
import {open,readFile} from 'node:fs/promises'
import {createReadStream} from 'node:fs'
import {createHash} from 'node:crypto'
import {isAbsolute,join} from 'node:path'
import {parse} from 'dotenv'
import mysql from 'mysql2/promise'
import {loadCombinedExecutionWorkflowPlan} from './lib/execution-workflow-combined-plan.mjs'
import {mysqlColumnStore,verifyInplaceJournal} from './lib/mysql-inplace-column-store.mjs'
import {validateColumnHistory} from './lib/dev-vue-column-upgrade.mjs'
import {readAccountRootSnapshot} from './lib/mysql-account-root-snapshot.mjs'
import {inferenceRootSchemaState} from './lib/inference-root-schema-state.mjs'
import {hash} from './lib/v4-backfill-contract.mjs'
import {sha256} from './lib/v4-migration-plan.mjs'

const [destination]=process.argv.slice(2),root=new URL('../',import.meta.url)
assert.ok(process.argv.length===3&&isAbsolute(destination??''))
const plan=await loadCombinedExecutionWorkflowPlan(root)
const baselineBytes=await readFile(new URL('docs/architecture/inference-root-restored-v1-20260910.json.baseline.json',root)),baseline=JSON.parse(baselineBytes)
const rehearsal=JSON.parse(await readFile(new URL('docs/architecture/inference-root-restored-v1-20260910.json',root)))
assert.ok(rehearsal.passed);assert.equal(hash(baseline),rehearsal.baselineHash)
const proof=JSON.parse(await readFile(new URL('docs/architecture/inference-restored-baseline-20260910.json',root)))
const receiptBytes=await readFile(join(proof.archiveDirectory,'receipt.json')),receipt=JSON.parse(receiptBytes)
assert.equal(sha256(receiptBytes),baseline.receiptSha256);assert.equal(receipt.status,'verified')
const digest=createHash('sha256');let bytes=0
for await(const chunk of createReadStream(join(proof.archiveDirectory,'source.sql.enc'))){digest.update(chunk);bytes+=chunk.length}
assert.equal(bytes,receipt.artifact.ciphertext.bytes);assert.equal(digest.digest('hex'),receipt.artifact.ciphertext.sha256)
const env=parse(await readFile(new URL('server/.env',root)));assert.equal(env.MYSQL_HOST,'192.168.1.254');assert.equal(env.MYSQL_DATABASE,'dev_vue')
const output=await open(destination,'wx',0o600),report={kind:'execution-workflow-current-preflight/v1',passed:false,writes:0,
 planHash:hash({steps:plan.steps,transitions:plan.transitions}),baselineSha256:sha256(baselineBytes),receiptSha256:sha256(receiptBytes),backupCiphertextVerified:true}
let db,locked=false
try{
 db=await mysql.createConnection({host:env.MYSQL_HOST,port:Number(env.MYSQL_PORT),user:env.MYSQL_USER,password:env.MYSQL_PASSWORD,database:env.MYSQL_DATABASE,
  timezone:'Z',dateStrings:true,jsonStrings:true,supportBigNumbers:true,bigNumberStrings:true})
 await db.query("SET SESSION time_zone='+00:00'")
 const [[identity]]=await db.query('SELECT DATABASE() db,@@server_uuid uuid,@@innodb_force_recovery recovery')
 assert.equal(identity.db,'dev_vue');assert.equal(identity.uuid,'ac423207-6ef3-11f1-b302-000c29fda104');assert.equal(Number(identity.recovery),0)
 const [[lock]]=await db.execute('SELECT GET_LOCK(?,0) acquired',['aurum:inplace:dev_vue']);assert.equal(Number(lock.acquired),1);locked=true
 assert.ok(await verifyInplaceJournal(db));const history=await mysqlColumnStore(db,true).history();validateColumnHistory(history,plan.steps)
 assert.equal(history.length,205);assert.ok(history.every(row=>row.status==='completed'))
 await db.query('START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY')
 const tables=(await readAccountRootSnapshot(db)).tables
 await db.rollback()
 assert.equal(tables.length,baseline.before.length)
 assert.equal(inferenceRootSchemaState(tables).sha256,plan.added[0].beforeHash)
 const actual=new Map(tables.map(row=>[row.name,row]))
 for(const row of baseline.before){if(row.name==='database_upgrade_steps_v4')continue
  const current=actual.get(row.name);assert.ok(current);assert.equal(current.rows,row.rows);assert.equal(current.rowsSha256,row.rowsSha256)}
 report.completedSteps=history.length;report.tableCount=tables.length
 report.businessRows=tables.filter(row=>row.name!=='database_upgrade_steps_v4').reduce((sum,row)=>sum+row.rows,0)
 report.snapshotHash=hash(tables);report.passed=true
 report.checks=['encrypted-backup-bytes-and-hash-verified','current-205-history-and-complete-schema-match','all-business-row-digests-match-restored-baseline']
 report.writeFreezeVerified=false
}catch(error){report.errorCode=error?.code??error?.name??'preflight_failed';process.exitCode=1}
finally{if(db){try{await db.rollback();if(locked)await db.execute('SELECT RELEASE_LOCK(?)',['aurum:inplace:dev_vue'])}finally{await db.end()}}
 report.observedAt=new Date().toISOString();await output.writeFile(JSON.stringify(report,null,2)+'\n');await output.close();console.log(JSON.stringify(report))}
