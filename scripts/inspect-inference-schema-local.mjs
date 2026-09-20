import { inferenceBuildNames, inferenceBuildMapping } from './lib/inference-build-schema.mjs'
import assert from 'node:assert/strict'
import { open, readFile } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import mysql from 'mysql2/promise'
import { tableDefinitionHash } from './lib/inplace-foundation-upgrade.mjs'
const [mode,destination]=process.argv.slice(2)
assert.ok(['--current','--restored'].includes(mode) && isAbsolute(destination??'') && process.argv.length===4)
const database=mode==='--current'?'dev_vue':'dev_vue_m1_source_20260910_01'
const sql=await readFile(new URL('../server/db/migrations/20260903_004_ai_strategy_and_inference_core.sql',import.meta.url),'utf8')
const names=[...new Set([...sql.matchAll(/CREATE TABLE(?: IF NOT EXISTS)? ([a-z0-9_]+)/g)].map(m=>m[1]).concat(...inferenceBuildNames,'strategy_memory_injection_logs_v4','users','trading_accounts','risk_decisions_v4','risk_policy_versions_v4','risk_policy_sets_v4','strategy_subscriptions_v4_build','subscription_schedules_v4_build','subscription_execution_preferences_v4_build',...inferenceBuildNames.map(name=>inferenceBuildMapping[name])))]
assert.ok(names.includes('inference_snapshots'))
const file=await open(destination,'wx',0o600),report={kind:'inference-schema-inventory/v1',passed:false,writes:0,target:database,tables:{}}
let connection
try{
  const chunks=[];for await(const chunk of process.stdin)chunks.push(chunk)
  const credential=JSON.parse(Buffer.concat(chunks).toString('utf8'))
  assert.ok(credential.host==='127.0.0.1' && credential.port===13316 && credential.user==='root')
  connection=await mysql.createConnection({...credential,database,dateStrings:true,timezone:'Z',supportBigNumbers:true,bigNumberStrings:true})
  await connection.query("SET SESSION time_zone='+00:00'")
  await connection.query('START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY')
  const [[identity]]=await connection.query('SELECT DATABASE() db,@@server_uuid uuid,@@innodb_force_recovery recovery')
  assert.equal(identity.db,database);assert.equal(identity.uuid,'ac423207-6ef3-11f1-b302-000c29fda104');assert.equal(Number(identity.recovery),0);report.identity=identity
  for(const name of names){
    const [columns]=await connection.execute('SELECT COLUMN_NAME name,COLUMN_TYPE type,IS_NULLABLE nullable,COLLATION_NAME collation,COLUMN_KEY columnKey FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=? ORDER BY ORDINAL_POSITION',[name])
    if(!columns.length){report.tables[name]={exists:false};continue}
    const [[ddl]]=await connection.query(`SHOW CREATE TABLE ${name}`),[[count]]=await connection.query(`SELECT CAST(COUNT(*) AS CHAR) n FROM ${name}`)
    report.tables[name]={exists:true,rows:count.n,columns,ddl:ddl['Create Table'],hash:tableDefinitionHash(ddl['Create Table'])}
  }
  const [links]=await connection.execute(`SELECT TABLE_NAME tableName,COLUMN_NAME columnName,CONSTRAINT_NAME name,REFERENCED_TABLE_NAME parent,REFERENCED_COLUMN_NAME parentColumn
    FROM information_schema.KEY_COLUMN_USAGE WHERE TABLE_SCHEMA=DATABASE() AND (TABLE_NAME IN ('inference_snapshots','ai_model_tasks','strategy_subscriptions','strategy_subscriptions_v4_build') OR REFERENCED_TABLE_NAME IN ('inference_snapshots','ai_model_tasks','strategy_subscriptions','strategy_subscriptions_v4_build')) ORDER BY TABLE_NAME,CONSTRAINT_NAME,ORDINAL_POSITION`)
  report.inferenceAndSubscriptionKeys=links
  report.snapshotForeignKeys=links.filter(r=>r.tableName==='inference_snapshots' || r.parent==='inference_snapshots')
  const [history]=await connection.query('SELECT id,checksum_sha256 checksum,status FROM database_upgrade_steps_v4 ORDER BY id')
  report.history=history;report.completedSteps=history.filter(r=>r.status==='completed').length
  report.startedSteps=history.filter(r=>r.status==='started').map(r=>r.id)
  const target=report.tables.strategy_memory_injection_logs_v4
  report.memoryAuditAlterPresent=target.columns.some(c=>c.name==='record_version')
  report.snapshotIdType=report.tables.inference_snapshots.columns.find(c=>c.name==='id').type
  report.passed=true
}catch(error){report.error={code:error.code??'inspection_failed',reason:error.name};process.exitCode=1}
finally{
  if(connection){await connection.rollback();await connection.end()}
  report.observedAt=new Date().toISOString();await file.writeFile(JSON.stringify(report,null,2)+'\n');await file.close()
  console.log(JSON.stringify({passed:report.passed,target:database,writes:0,completedSteps:report.completedSteps,startedSteps:report.startedSteps,
    snapshotIdType:report.snapshotIdType,memoryAuditAlterPresent:report.memoryAuditAlterPresent,missing:names.filter(n=>report.tables[n]?.exists===false),error:report.error}))
}
