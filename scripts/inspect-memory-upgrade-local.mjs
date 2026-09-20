import assert from 'node:assert/strict'
import { open, readFile } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import { parse } from 'dotenv'
import mysql from 'mysql2/promise'
import { tableDefinitionHash } from './lib/inplace-foundation-upgrade.mjs'
import { mysqlColumnStore, verifyInplaceJournal } from './lib/mysql-inplace-column-store.mjs'
import { loadHistoryCollectionTaskUpgrade } from './lib/history-collection-task-upgrade.mjs'
import { validateColumnHistory } from './lib/dev-vue-column-upgrade.mjs'
const [destination]=process.argv.slice(2)
assert.ok(process.argv.length===3 && isAbsolute(destination??''))
const root=new URL('../',import.meta.url),env=parse(await readFile(new URL('server/.env',root)))
assert.equal(env.MYSQL_HOST,'192.168.1.254');assert.equal(env.MYSQL_DATABASE,'dev_vue')
const file=await open(destination,'wx',0o600),report={kind:'memory-upgrade-current-inventory/v1',passed:false,writes:0}
let connection
try {
  connection=await mysql.createConnection({host:env.MYSQL_HOST,port:Number(env.MYSQL_PORT),user:env.MYSQL_USER,password:env.MYSQL_PASSWORD,
    database:env.MYSQL_DATABASE,dateStrings:true,timezone:'Z'})
  await connection.query("SET SESSION time_zone='+00:00'")
  await connection.query('START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY')
  const [[identity]]=await connection.query('SELECT DATABASE() db,@@server_uuid serverUuid,@@version version')
  assert.equal(identity.db,'dev_vue');assert.equal(identity.serverUuid,'ac423207-6ef3-11f1-b302-000c29fda104');report.identity=identity
  const names=['strategy_memory_libraries_v4','strategy_memory_library_revisions_v4','strategy_memory_injection_logs_v4','strategies','strategy_versions','inference_snapshots','users']
  report.tables={}
  for(const table of names){
    const [found]=await connection.execute('SELECT TABLE_TYPE kind,ENGINE engine FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=?',[table])
    if(!found.length){report.tables[table]={exists:false};continue}
    assert.equal(found.length,1);assert.equal(found[0].kind,'BASE TABLE');assert.equal(found[0].engine,'InnoDB')
    const [[ddl]]=await connection.query(`SHOW CREATE TABLE ${table}`)
    const [[count]]=await connection.query(`SELECT CAST(COUNT(*) AS CHAR) n FROM ${table}`)
    report.tables[table]={exists:true,rows:count.n,ddl:ddl['Create Table'],definitionHash:tableDefinitionHash(ddl['Create Table'])}
  }
  assert.ok(await verifyInplaceJournal(connection))
  const loaded=await loadHistoryCollectionTaskUpgrade(root),history=await mysqlColumnStore(connection,true).history()
  const entries=validateColumnHistory(history,loaded.steps)
  assert.ok(loaded.steps.every(step=>entries.get(step.id)?.status==='completed'))
  report.upgradeJournal={count:history.length,expected:loaded.steps.length,completed:true}
  report.passed=true
} catch(error){report.errorCode=error?.code??error?.name??'inspection_failed';process.exitCode=1}
finally {
  if(connection){await connection.rollback();await connection.end()}
  report.observedAt=new Date().toISOString();await file.writeFile(JSON.stringify(report,null,2)+'\n');await file.close()
  console.log(JSON.stringify({passed:report.passed,writes:0,journal:report.upgradeJournal,tables:Object.fromEntries(Object.entries(report.tables??{}).map(([name,value])=>[name,{exists:value.exists,rows:value.rows}]))}))
}
