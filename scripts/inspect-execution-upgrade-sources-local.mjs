import assert from 'node:assert/strict'
import {readFile,open} from 'node:fs/promises'
import {isAbsolute} from 'node:path'
import {parse} from 'dotenv'
import mysql from 'mysql2/promise'
import {loadQuoteProvenanceUpgrade} from './lib/quote-provenance-upgrade.mjs'
import {inferenceBuildMapping} from './lib/inference-build-schema.mjs'
import {tableDefinitionHash} from './lib/inplace-foundation-upgrade.mjs'
import {sha256} from './lib/v4-migration-plan.mjs'

const [destination]=process.argv.slice(2)
assert.ok(process.argv.length===3 && isAbsolute(destination??''))
const root=new URL('../',import.meta.url)
const env=parse(await readFile(new URL('server/.env',root)))
assert.equal(env.MYSQL_HOST,'192.168.1.254');assert.equal(env.MYSQL_DATABASE,'dev_vue')
const files=['20260903_009_execution_intents_and_reservations.sql','20260903_010_bridge_v4_command_ledger.sql',
 '20260904_011_user_execution_commands_and_distributions.sql','corrections/011-execution-intent-foreign-keys.sql']
const names=new Set([...Object.keys(inferenceBuildMapping),...Object.values(inferenceBuildMapping)])
for(const name of Object.keys(inferenceBuildMapping))names.add(name+'_legacy_v3')
const sources=[]
for(const file of files){
 const sql=await readFile(new URL('server/db/migrations/'+file,root),'utf8')
 const identifiers=[...sql.matchAll(/(?:CREATE TABLE(?: IF NOT EXISTS)?|ALTER TABLE|REFERENCES)\s+`?([a-z][a-z0-9_]*)`?/g)].map(match=>match[1])
 for(const name of identifiers)names.add(name)
 sources.push({file,sha256:sha256(sql),tables:[...new Set(identifiers)].sort()})
}
const output=await open(destination,'wx',0o600)
const report={kind:'execution-upgrade-source-inventory/v1',passed:false,writes:0,sources,tables:{}}
let db,locked=false
try{
 db=await mysql.createConnection({host:env.MYSQL_HOST,port:Number(env.MYSQL_PORT),user:env.MYSQL_USER,
  password:env.MYSQL_PASSWORD,database:env.MYSQL_DATABASE,dateStrings:true,timezone:'Z'})
 await db.query("SET SESSION time_zone='+00:00'")
 const [[identity]]=await db.query('SELECT DATABASE() db,@@server_uuid uuid')
 assert.equal(identity.db,'dev_vue');assert.equal(identity.uuid,'ac423207-6ef3-11f1-b302-000c29fda104');report.identity=identity
 const [[lock]]=await db.execute('SELECT GET_LOCK(?,0) acquired',['aurum:inplace:dev_vue'])
 assert.equal(Number(lock.acquired),1);locked=true
 await db.query('START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY')
 const prior=await loadQuoteProvenanceUpgrade(root)
 const [journal]=await db.query('SELECT id,checksum_sha256,status FROM database_upgrade_steps_v4 ORDER BY id')
 assert.equal(journal.length,prior.steps.length)
 for(const step of prior.steps){const row=journal.find(item=>item.id===step.id);assert.equal(row?.status,'completed');assert.equal(row?.checksum_sha256,step.checksum)}
 report.completedSteps=journal.length
 const [available]=await db.query('SELECT TABLE_NAME name,TABLE_TYPE kind FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE()')
 for(const name of [...names].sort()){
  assert.match(name,/^[a-z][a-z0-9_]*$/)
  const existing=available.find(row=>row.name===name)
  if(!existing){report.tables[name]={exists:false};continue}
  assert.equal(existing.kind,'BASE TABLE')
  const [[definition]]=await db.query('SHOW CREATE TABLE `'+name+'`')
  const [[count]]=await db.query('SELECT COUNT(*) quantity FROM `'+name+'`')
  const ddl=definition['Create Table']
  report.tables[name]={exists:true,rows:String(count.quantity),ddl,sha256:tableDefinitionHash(ddl)}
 }
 const [foreignKeys]=await db.query(`SELECT TABLE_NAME tableName,CONSTRAINT_NAME constraintName,COLUMN_NAME columnName,
  REFERENCED_TABLE_NAME parent,REFERENCED_COLUMN_NAME parentColumn,ORDINAL_POSITION ordinal
  FROM information_schema.KEY_COLUMN_USAGE WHERE TABLE_SCHEMA=DATABASE() AND REFERENCED_TABLE_NAME IS NOT NULL
  ORDER BY TABLE_NAME,CONSTRAINT_NAME,ORDINAL_POSITION`)
 report.foreignKeys=foreignKeys.filter(row=>names.has(row.tableName)||names.has(row.parent))
 for(const [name,table] of Object.entries(report.tables))if(table.exists){
  const [[definition]]=await db.query('SHOW CREATE TABLE `'+name+'`');assert.equal(tableDefinitionHash(definition['Create Table']),table.sha256)
 }
 await db.rollback();report.passed=true
}catch(error){report.errorCode=error?.code??error?.name??'inventory_failed';process.exitCode=1}
finally{
 if(db){try{await db.rollback();if(locked)await db.execute('SELECT RELEASE_LOCK(?)',['aurum:inplace:dev_vue'])}finally{await db.end()}}
 report.observedAt=new Date().toISOString()
 await output.writeFile(JSON.stringify(report,null,2)+'\n');await output.close()
 console.log(JSON.stringify({passed:report.passed,completedSteps:report.completedSteps,errorCode:report.errorCode,
  missing:Object.entries(report.tables).filter(([,table])=>!table.exists).map(([name])=>name),writes:0}))
}
