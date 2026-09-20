import assert from 'node:assert/strict'
import {open} from 'node:fs/promises'
import {isAbsolute} from 'node:path'
import mysql from 'mysql2/promise'
import {assertMysqlExecutionWorkflowSchemaReady} from '../server/dist-v4/modules/execution/composition.js'

const [destination]=process.argv.slice(2)
assert.ok(process.argv.length===3&&isAbsolute(destination??''))
const output=await open(destination,'wx',0o600)
const report={kind:'execution-workflow-readiness/v1',passed:false,writes:0,checks:[]}
const pools=[]
let locker
try{
 const chunks=[];for await(const chunk of process.stdin)chunks.push(chunk)
 const credential=JSON.parse(Buffer.concat(chunks).toString('utf8'))
 assert.ok(credential.host==='127.0.0.1'&&credential.port===13316&&credential.user==='root')
 const create=database=>{const pool=mysql.createPool({...credential,database,timezone:'Z',connectionLimit:1});pools.push(pool);return pool}
 const scoped=(pool,timezone='+00:00')=>({async getConnection(){const connection=await pool.getConnection();await connection.query('SET SESSION time_zone=?',[timezone]);return connection}})
 const current=create('dev_vue'),restored=create('dev_vue_m1_source_20260910_02')
 const [[identity]]=await current.query('SELECT @@server_uuid uuid');assert.equal(identity.uuid,'ac423207-6ef3-11f1-b302-000c29fda104')
 await assert.rejects(assertMysqlExecutionWorkflowSchemaReady(scoped(current)),/execution_workflow_schema_not_ready/)
 report.checks.push('current-205-step-database-rejected')
 await assertMysqlExecutionWorkflowSchemaReady(scoped(restored))
 report.checks.push('restored-238-step-database-41-table-gate-passed')
 await assert.rejects(assertMysqlExecutionWorkflowSchemaReady(scoped(restored,'+08:00')),/execution_workflow_schema_not_ready/)
 report.checks.push('non-UTC-session-rejected')
 locker=await mysql.createConnection({...credential,database:'dev_vue_m1_source_20260910_02'})
 const name='aurum:inplace:dev_vue_m1_source_20260910_02'
 const [[held]]=await locker.execute('SELECT GET_LOCK(?,0) acquired',[name]);assert.equal(Number(held.acquired),1)
 await assert.rejects(assertMysqlExecutionWorkflowSchemaReady(scoped(restored)),/execution_workflow_schema_not_ready/)
 await locker.execute('SELECT RELEASE_LOCK(?)',[name]);await locker.end();locker=undefined
 await assertMysqlExecutionWorkflowSchemaReady(scoped(restored))
 const [[released]]=await restored.execute('SELECT IS_FREE_LOCK(?) free',[name]);assert.equal(Number(released.free),1)
 report.checks.push('upgrade-lock-contention-rejected-and-retry-releases-lock')
 report.passed=true
}catch(error){report.errorCode=error?.code??error?.name??'readiness_failed';process.exitCode=1}
finally{
 if(locker)await locker.end()
 for(const pool of pools)await pool.end()
 report.observedAt=new Date().toISOString();await output.writeFile(JSON.stringify(report,null,2)+'\n');await output.close()
 console.log(JSON.stringify(report))
}
