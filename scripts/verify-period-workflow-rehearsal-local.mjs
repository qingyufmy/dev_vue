import {loadPeriodWorkflowUpgrade} from './lib/period-workflow-upgrade.mjs'
import {coordinateInplaceSchema} from './lib/inplace-schema-coordinator.mjs'
import {mysqlColumnStore} from './lib/mysql-inplace-column-store.mjs'
import {hash} from './lib/v4-backfill-contract.mjs'
import {loadPeriodWorkflowSource} from './lib/period-workflow-source.mjs'
import assert from 'node:assert/strict'
import {open,readFile} from 'node:fs/promises'
import {randomUUID} from 'node:crypto'
import {isAbsolute} from 'node:path'
import mysql from 'mysql2/promise'
import {loadClockObservationUpgrade} from './lib/clock-observation-upgrade.mjs'
import {createSchemaTransitionReference} from './lib/schema-transition-reference.mjs'
import {inferenceRootSchemaState} from './lib/inference-root-schema-state.mjs'
import {sha256,splitSqlStatements} from './lib/v4-migration-plan.mjs'

const [destination]=process.argv.slice(2),root=new URL('../',import.meta.url)
assert.ok(process.argv.length===3&&isAbsolute(destination??''))
const plan=await loadClockObservationUpgrade(root),output=await open(destination,'wx',0o600)
const report={kind:'period-workflow-empty-schema-rehearsal/v1',passed:false,existingDatabaseWrites:0,dataCopied:false,referenceDatabaseRemoved:false}
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
 const upgrade=await loadPeriodWorkflowUpgrade(root)
 await db.query(`INSERT INTO database_upgrade_steps_v4 (id,checksum_sha256,status,started_at_utc,completed_at_utc)
   SELECT id,checksum_sha256,status,started_at_utc,completed_at_utc FROM dev_vue.database_upgrade_steps_v4`)
 const journal=mysqlColumnStore(db,true)
 const schema=async()=>{
   const [names]=await db.query("SELECT TABLE_NAME name FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_TYPE='BASE TABLE'")
   const values=[]
   for(const {name:table} of names){assert.match(table,/^[a-z][a-z0-9_]*$/);const [[row]]=await db.query('SHOW CREATE TABLE `'+table+'`');values.push({name:table,ddl:row['Create Table']})}
   return inferenceRootSchemaState(values).sha256
 }
 let injected=false,ddlAttempts=0
 const store={...journal,async tableHash(key){assert.equal(key,'execution_workflow_schema');return schema()},
   async execute(sql){assert.ok(upgrade.added.some(row=>row.sql===sql));ddlAttempts++;await db.query(sql);if(!injected){injected=true;throw Error('injected_ddl_ack_loss')}}}
 await assert.rejects(coordinateInplaceSchema(store,upgrade,{apply:true}),/injected_ddl_ack_loss/)
 assert.equal((await journal.history()).find(row=>row.id===upgrade.added[0].id).status,'started')
 await coordinateInplaceSchema(store,upgrade,{apply:true})
 await coordinateInplaceSchema(store,upgrade,{apply:true})
 assert.equal(ddlAttempts,1);assert.equal(await schema(),upgrade.finalSchemaHash)
 assert.equal((await journal.history()).length,265)
 Object.assign(report,{planHash:hash(upgrade.steps),ddlAckLossRecovered:true,replayNoDDL:true,ddlAttempts,steps:265,
   scope:'Cloned current DDL and migration journal; no business data copied. Current upgrade separately checks every old table data hash.'})
 report.passed=true
}catch(error){report.errorCode=error?.code??error?.name??'reference_failed';process.exitCode=1}
finally{
 if(db){try{await db.rollback();if(created){await db.query('DROP DATABASE `'+name+'`');report.referenceDatabaseRemoved=true}
  if(locked)await db.execute('SELECT RELEASE_LOCK(?)',['aurum:inplace:dev_vue'])}finally{await db.end()}}
 report.observedAt=new Date().toISOString();await output.writeFile(JSON.stringify(report,null,2)+'\n');await output.close()
 console.log(JSON.stringify({passed:report.passed,errorCode:report.errorCode,referenceDatabaseRemoved:report.referenceDatabaseRemoved,existingDatabaseWrites:0}))
}
