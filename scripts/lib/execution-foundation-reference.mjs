import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import {splitSqlStatements,sha256} from './v4-migration-plan.mjs'
import {subscriptionRootRenameSql} from './subscription-root-promotion.mjs'
import {tableDefinitionHash} from './inplace-foundation-upgrade.mjs'

/** Caller supplies an isolated full-DDL clone with promoted inference roots. No data backfill. */
export async function verifyExecutionFoundationDdl(db){
 const [[identity]]=await db.query('SELECT DATABASE() db')
 assert.match(identity.db,/^dev_vue_workflow_schema_ref_[a-f0-9]{32}$/)
 const sources=[],executed=[],alreadySuperseded=[]
 let stage='subscription-root'
 try{
  const subscriptionSql=subscriptionRootRenameSql()
  await db.query(subscriptionSql);executed.push({source:'subscription-root-promotion',sql:subscriptionSql})
  stage='008-risk-decision-manual-release-structure'
  const manualFile='20260903_008_manual_risk_release.sql'
  const manualBytes=await readFile(new URL('../../server/db/migrations/'+manualFile,import.meta.url))
  sources.push({file:manualFile,sha256:sha256(manualBytes)})
  const manualAlter=splitSqlStatements(manualBytes.toString('utf8')).filter(sql=>/^ALTER TABLE risk_decisions_v4\b/.test(sql))
  assert.equal(manualAlter.length,1)
  await db.query(manualAlter[0]);executed.push({source:manualFile,sql:manualAlter[0],scope:'risk-decision-structure-only'})
  const correction=await readFile(new URL('../../server/db/migrations/corrections/011-execution-intent-foreign-keys.sql',import.meta.url),'utf8')
  sources.push({file:'corrections/011-execution-intent-foreign-keys.sql',sha256:sha256(correction)})
  const corrected=splitSqlStatements(correction);assert.equal(corrected.length,1)
  for(const file of ['20260903_009_execution_intents_and_reservations.sql','20260903_010_bridge_v4_command_ledger.sql',
   '20260904_011_user_execution_commands_and_distributions.sql']){
   const bytes=await readFile(new URL('../../server/db/migrations/'+file,import.meta.url))
   sources.push({file,sha256:sha256(bytes)})
   for(const [index,original] of splitSqlStatements(bytes.toString('utf8')).entries()){
    stage=file+':'+(index+1)
    if(file.includes('_010_')&&/^ALTER TABLE bridge_connection_sessions\b/.test(original)){
     const inventory=JSON.parse(await readFile(new URL('../../docs/architecture/execution-upgrade-source-inventory-v2-20260910.json',import.meta.url),'utf8'))
     const [[row]]=await db.query('SHOW CREATE TABLE bridge_connection_sessions')
     assert.equal(tableDefinitionHash(row['Create Table']),inventory.tables.bridge_connection_sessions.sha256)
     // 036 established the profile-scoped route index; do not restore the superseded 010 layout.
     const replacement='inplace/036_terminal_route_tables.sql'
     sources.push({file:replacement,sha256:sha256(await readFile(new URL('../../server/db/migrations/'+replacement,import.meta.url)))})
     alreadySuperseded.push({file,index:index+1,by:replacement,tableHash:inventory.tables.bridge_connection_sessions.sha256})
     continue
    }
    const sql=file.includes('_011_')&&/^ALTER TABLE execution_intents\b/.test(original)?corrected[0]:original
    const name=/^CREATE TABLE IF NOT EXISTS ([a-z][a-z0-9_]*)/.exec(sql)?.[1]
    if(name){const [existing]=await db.execute('SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=?',[name]);assert.equal(existing.length,0,'foundation_target_already_exists')}
    await db.query(sql);executed.push({source:file,index:index+1,corrected:sql!==original,sql})
   }
  }
  return {passed:true,sources,executed,alreadySuperseded,dataBackfilled:false}
 }catch(error){error.referenceStatement='execution-foundation:'+stage+':'+error.message;throw error}
}
