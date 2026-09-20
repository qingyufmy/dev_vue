import {loadReviewArchiveSource} from './lib/review-archive-source.mjs'
import assert from 'node:assert/strict'
import {open,readFile} from 'node:fs/promises'
import {randomUUID} from 'node:crypto'
import {isAbsolute} from 'node:path'
import mysql from 'mysql2/promise'
import {loadReviewHistoryUpgrade} from './lib/review-history-upgrade.mjs'
import {createSchemaTransitionReference} from './lib/schema-transition-reference.mjs'
import {inferenceRootSchemaState} from './lib/inference-root-schema-state.mjs'
import {sha256,splitSqlStatements} from './lib/v4-migration-plan.mjs'

const [destination]=process.argv.slice(2),root=new URL('../',import.meta.url)
assert.ok(process.argv.length===3&&isAbsolute(destination??''))
const plan=await loadReviewHistoryUpgrade(root),output=await open(destination,'wx',0o600)
const report={kind:'review-archive-full-schema-reference/v1',passed:false,existingDatabaseWrites:0,dataCopied:false,referenceDatabaseRemoved:false}
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
 const source=await loadReviewArchiveSource(root)
 for(const sql of source.statements)await transition.connection.query(sql)
 report.sources=source.sources;report.initialSchemaState=transition.initial
 report.transitions=transition.transitions;report.sourceSteps=history.length;report.tableCount=tables.length
 assert.equal(history.length,256);assert.equal(tables.length,307);assert.equal(transition.transitions.length,3)
 assert.ok(transition.transitions.every(row=>row.removed.length===0))
 report.definitions={}
 for(const table of new Set(transition.transitions.flatMap(row=>row.changed.map(item=>item.name)))){
  const [[definition]]=await db.query('SHOW CREATE TABLE `'+table+'`');report.definitions[table]=definition['Create Table']
 }
 assert.equal(Object.keys(report.definitions).length,3)
 const [columns]=await db.query("SELECT TABLE_NAME tableName,COLUMN_NAME columnName,IS_NULLABLE nullable,COLUMN_TYPE columnType FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND ((TABLE_NAME='review_versions_v4' AND COLUMN_NAME='trade_count') OR (TABLE_NAME='review_cases_v4' AND COLUMN_NAME='status'))")
 assert.equal(columns.find(row=>row.columnName==='trade_count').nullable,'YES')
 assert.match(columns.find(row=>row.columnName==='status').columnType,/'archived'/)
 const [refs]=await db.query("SELECT REFERENCED_TABLE_NAME parent FROM information_schema.REFERENTIAL_CONSTRAINTS WHERE CONSTRAINT_SCHEMA=DATABASE() AND TABLE_NAME='review_case_history_v4'")
 assert.deepEqual(refs.map(row=>row.parent).sort(),['data_migration_checkpoints','review_cases_v4'])
 report.checks=['all-307-DDLs-cloned','3-append-only-transitions','unknown-historical-count-nullable','archived-state','case-and-archive-stream-foreign-keys']
 report.passed=true
}catch(error){report.errorCode=error?.code??error?.name??'reference_failed';process.exitCode=1}
finally{
 if(db){try{await db.rollback();if(created){await db.query('DROP DATABASE `'+name+'`');report.referenceDatabaseRemoved=true}
  if(locked)await db.execute('SELECT RELEASE_LOCK(?)',['aurum:inplace:dev_vue'])}finally{await db.end()}}
 report.observedAt=new Date().toISOString();await output.writeFile(JSON.stringify(report,null,2)+'\n');await output.close()
 console.log(JSON.stringify({passed:report.passed,errorCode:report.errorCode,referenceDatabaseRemoved:report.referenceDatabaseRemoved,existingDatabaseWrites:0}))
}
