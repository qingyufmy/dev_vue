import assert from 'node:assert/strict'
import {open,readFile} from 'node:fs/promises'
import {randomUUID} from 'node:crypto'
import {isAbsolute} from 'node:path'
import mysql from 'mysql2/promise'
import {loadExecutionWorkflowUpgrade} from './lib/execution-workflow-upgrade.mjs'
import {createSchemaTransitionReference} from './lib/schema-transition-reference.mjs'
import {inferenceRootSchemaState} from './lib/inference-root-schema-state.mjs'
import {sha256,splitSqlStatements} from './lib/v4-migration-plan.mjs'

const [destination]=process.argv.slice(2),root=new URL('../',import.meta.url)
assert.ok(process.argv.length===3&&isAbsolute(destination??''))
const plan=await loadExecutionWorkflowUpgrade(root),output=await open(destination,'wx',0o600)
const report={kind:'reconciliation-index-full-schema-reference/v1',passed:false,existingDatabaseWrites:0,dataCopied:false,referenceDatabaseRemoved:false}
const name='dev_vue_workflow_schema_ref_'+randomUUID().replaceAll('-','')
let db,created=false,locked=false
try{
 const chunks=[];for await(const chunk of process.stdin)chunks.push(chunk)
 const credential=JSON.parse(Buffer.concat(chunks).toString('utf8'))
 assert.ok(credential.host==='127.0.0.1'&&credential.port===13316&&credential.user==='root')
 db=await mysql.createConnection({...credential,database:'dev_vue',timezone:'Z',dateStrings:true,supportBigNumbers:true,bigNumberStrings:true})
 await db.query("SET SESSION time_zone='+00:00'")
 const [[identity]]=await db.query('SELECT @@server_uuid uuid,@@innodb_force_recovery recovery')
 assert.equal(identity.uuid,'ac423207-6ef3-11f1-b302-000c29fda104');assert.equal(Number(identity.recovery),0)
 const [[lock]]=await db.execute('SELECT GET_LOCK(?,0) acquired',['aurum:inplace:dev_vue'])
 assert.equal(Number(lock.acquired),1);locked=true
 const [history]=await db.query('SELECT id,checksum_sha256 checksum,status FROM database_upgrade_steps_v4 ORDER BY id')
 assert.equal(history.length,plan.steps.length)
 const expected=new Map(plan.steps.map(step=>[step.id,step.checksum]))
 for(const row of history){assert.equal(row.status,'completed');assert.equal(row.checksum,expected.get(row.id))}
 const [names]=await db.query("SELECT TABLE_NAME name FROM information_schema.TABLES WHERE TABLE_SCHEMA='dev_vue' AND TABLE_TYPE='BASE TABLE' ORDER BY TABLE_NAME")
 const tables=[]
 for(const {name:table} of names){assert.match(table,/^[a-z][a-z0-9_]*$/)
  const [[row]]=await db.query('SHOW CREATE TABLE `'+table+'`'),ddl=row['Create Table']
  assert.doesNotMatch(ddl,/REFERENCES\s+`[^`]+`\s*\./i);tables.push({name:table,ddl})}
 assert.equal(inferenceRootSchemaState(tables).sha256,plan.finalSchemaHash)
 await db.query('CREATE DATABASE `'+name+'` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci');created=true
 await db.query('USE `'+name+'`');await db.query('SET SESSION foreign_key_checks=0')
 for(const table of tables)await db.query(table.ddl)
 await db.query('SET SESSION foreign_key_checks=1')
 const transition=await createSchemaTransitionReference(db)
 assert.equal(transition.initial.sha256,plan.finalSchemaHash)
 const source='server/db/migrations/inplace/065_bridge_reconciliation_outbox_index.sql',bytes=await readFile(new URL(source,root))
 const statements=splitSqlStatements(bytes.toString('utf8'));assert.equal(statements.length,1)
 await transition.connection.query(statements[0])
 const [[outbox]]=await db.query('SHOW CREATE TABLE outbox_events')
 report.source={file:source,sha256:sha256(bytes)};report.initialSchemaState=transition.initial
 report.transitions=transition.transitions;report.outboxDdl=outbox['Create Table'];report.sourceSteps=history.length;report.tableCount=tables.length
 // Synthetic rows only; no source business payload or account data is copied.
 const values=Array.from({length:256},(_,index)=>[randomUUID(),'bridge_command','command-'+index,
  'bridge.command.reconcile.requested','{}','dispatched',0,new Date(),new Date()])
 await db.query('INSERT INTO outbox_events (event_id,aggregate_type,aggregate_id,event_type,payload_json,status,attempts,available_at_utc,created_at_utc) VALUES ?',[values])
 await db.query('ANALYZE TABLE outbox_events')
 const [explain]=await db.execute(`EXPLAIN SELECT status,created_at_utc>DATE_SUB(UTC_TIMESTAMP(3),INTERVAL 5 SECOND) AS recent
  FROM outbox_events WHERE aggregate_type='bridge_command' AND aggregate_id=?
  AND event_type='bridge.command.reconcile.requested' ORDER BY id DESC LIMIT 1 FOR UPDATE`,['command-128'])
 assert.equal(explain[0].key,'idx_outbox_aggregate_event')
 assert.ok(Number(explain[0].rows)<=2)
 report.explain=explain;report.syntheticRows=256;report.passed=true
}catch(error){report.errorCode=error?.code??error?.name??'reference_failed';process.exitCode=1}
finally{
 if(db){try{await db.rollback();if(created){await db.query('DROP DATABASE `'+name+'`');report.referenceDatabaseRemoved=true}
  if(locked)await db.execute('SELECT RELEASE_LOCK(?)',['aurum:inplace:dev_vue'])}finally{await db.end()}}
 report.observedAt=new Date().toISOString();await output.writeFile(JSON.stringify(report,null,2)+'\n');await output.close()
 console.log(JSON.stringify({passed:report.passed,errorCode:report.errorCode,referenceDatabaseRemoved:report.referenceDatabaseRemoved,existingDatabaseWrites:0}))
}
