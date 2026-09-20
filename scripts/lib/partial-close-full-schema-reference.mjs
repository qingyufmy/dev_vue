import {createSchemaTransitionReference} from './schema-transition-reference.mjs'
import {verifyExecutionFoundationDdl} from './execution-foundation-reference.mjs'
import {inferenceRootSchemaState} from './inference-root-schema-state.mjs'
import assert from 'node:assert/strict'
import {randomUUID,createHash} from 'node:crypto'
import {readFile} from 'node:fs/promises'
import {splitSqlStatements} from './v4-migration-plan.mjs'
import {loadQuoteProvenanceUpgrade} from './quote-provenance-upgrade.mjs'
import {tableDefinitionHash} from './inplace-foundation-upgrade.mjs'
import {loadInferenceBuildUpgrade} from './inference-build-upgrade.mjs'
import {planInferenceRootPromotion} from './inference-root-promotion.mjs'

/** Structure only: no source rows are copied or changed. This is not a data restoration rehearsal. */
export async function verifyPartialCloseFullSchema(pool,{inferencePromotionOnly=false,executionFoundation=false}={}) {
 const db=await pool.getConnection(),name='dev_vue_workflow_schema_ref_'+randomUUID().replaceAll('-','')
 assert.match(name,/^dev_vue_workflow_schema_ref_[a-f0-9]{32}$/)
 let original,locked=false,created=false,stage='source'
 try {
  const [[identity]]=await db.query('SELECT DATABASE() db,@@server_uuid uuid');original=identity.db
  assert.equal(identity.uuid,'ac423207-6ef3-11f1-b302-000c29fda104')
  const [[lock]]=await db.execute('SELECT GET_LOCK(?,0) acquired',['aurum:inplace:dev_vue']);assert.equal(Number(lock.acquired),1);locked=true
  const prior=await loadQuoteProvenanceUpgrade(new URL('../../',import.meta.url))
  const [journal]=await db.query('SELECT id,checksum_sha256,status FROM dev_vue.database_upgrade_steps_v4 ORDER BY id')
  assert.equal(journal.length,prior.steps.length)
  for(const step of prior.steps){const row=journal.find(r=>r.id===step.id);assert.equal(row?.status,'completed');assert.equal(row?.checksum_sha256,step.checksum)}
  const [tables]=await db.query("SELECT TABLE_NAME name FROM information_schema.TABLES WHERE TABLE_SCHEMA='dev_vue' AND TABLE_TYPE='BASE TABLE' ORDER BY TABLE_NAME")
  const requiredParents=['execution_intents','bridge_commands_v4','users','trading_accounts']
  const available=new Set(tables.map(row=>row.name))
  const missingParents=requiredParents.filter(table=>!available.has(table))
  if(missingParents.length && !inferencePromotionOnly && !executionFoundation)return {
   passed:false,sourceDatabase:'dev_vue',sourceSteps:journal.length,sourceTableCount:tables.length,
   admission:'missing-canonical-parents',requiredParents,missingParents,
   checks:['current-upgrade-journal-verified','canonical-parent-existence-checked-before-DDL'],
   existingDatabaseWrites:0,dataCopied:false,dataPreservationVerified:false,referenceDatabaseCreated:false,
  }
  const [triggers]=await db.query("SELECT TRIGGER_NAME FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA='dev_vue'");assert.equal(triggers.length,0)
  const source={}
  for(const {name:table} of tables){assert.match(table,/^[a-zA-Z0-9_]+$/)
   const [[row]]=await db.query('SHOW CREATE TABLE dev_vue.`'+table+'`');const ddl=row['Create Table']
   assert.equal(typeof ddl,'string');assert.doesNotMatch(ddl,/REFERENCES\s+`[^`]+`\s*\./i)
   source[table]=ddl
  }
  await db.query('CREATE DATABASE `'+name+'` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci');created=true
  await db.query('USE `'+name+'`');await db.query("SET SESSION time_zone='+00:00'")
  // Only empty DDL is created with FK checks suspended; every referenced table is also cloned.
  await db.query('SET SESSION foreign_key_checks=0')
  for(const [table,ddl] of Object.entries(source)){stage='clone:'+table;await db.query(ddl)}
  await db.query('SET SESSION foreign_key_checks=1')
  const before={}
  for(const table of Object.keys(source)){
   const [[row]]=await db.query('SHOW CREATE TABLE `'+table+'`');before[table]=tableDefinitionHash(row['Create Table'])
   assert.equal(before[table],tableDefinitionHash(source[table]))
  }
  let foundationEvidence,transitionReference
  if(inferencePromotionOnly || executionFoundation){
   stage='inference-promotion'
   const inventory=JSON.parse(await readFile(new URL('../../docs/architecture/execution-upgrade-source-inventory-v2-20260910.json',import.meta.url),'utf8'))
   for(const [table,record] of Object.entries(inventory.tables)){
    if(record.exists)assert.equal(before[table],record.sha256,'promotion_source_inventory_drift')
    else assert.equal(Object.hasOwn(before,table),false,'promotion_source_namespace_drift')
   }
   const upgrade=await loadInferenceBuildUpgrade(new URL('../../',import.meta.url))
   const plan=planInferenceRootPromotion(inventory,upgrade.finalTableHashes)
   const fkSql=`SELECT TABLE_NAME tableName,CONSTRAINT_NAME constraintName,COLUMN_NAME columnName,
    REFERENCED_TABLE_NAME parent,REFERENCED_COLUMN_NAME parentColumn,ORDINAL_POSITION ordinal
    FROM information_schema.KEY_COLUMN_USAGE WHERE TABLE_SCHEMA=DATABASE() AND REFERENCED_TABLE_NAME IS NOT NULL`
   const [originalLinks]=await db.query(fkSql)
   await db.query(plan.sql)
   const [actualLinks]=await db.query(fkSql)
   const [promotedNames]=await db.query("SELECT TABLE_NAME name FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_TYPE='BASE TABLE'")
   const promotedDefinitions=[]
   for(const {name:table} of promotedNames){const [[row]]=await db.query('SHOW CREATE TABLE `'+table+'`');promotedDefinitions.push({name:table,ddl:row['Create Table']})}
   const beforeDefinitions=Object.entries(source).map(([name,ddl])=>({name,ddl}))
   const predicted=inferenceRootSchemaState(beforeDefinitions,plan.renames),observed=inferenceRootSchemaState(promotedDefinitions)
   assert.deepEqual(observed,predicted)
   const mapping=new Map(plan.renames.map(({from,to})=>[from,to]))
   const stable=rows=>rows.map(row=>JSON.stringify(row)).sort()
   assert.deepEqual(stable(actualLinks),stable(originalLinks.map(row=>({...row,tableName:mapping.get(row.tableName)??row.tableName,parent:mapping.get(row.parent)??row.parent}))))
   const promoted={}
   for(const {from,to} of plan.renames){
    const [[row]]=await db.query('SHOW CREATE TABLE `'+to+'`')
    promoted[to]={ddl:row['Create Table'],sha256:tableDefinitionHash(row['Create Table']),sourceTable:from}
   }
   stage='inference-promotion-reverse'
   await db.query('RENAME TABLE '+[...plan.renames].reverse().map(({from,to})=>'`'+to+'` TO `'+from+'`').join(', '))
   const [restoredLinks]=await db.query(fkSql)
   assert.deepEqual(stable(restoredLinks),stable(originalLinks))
   for(const table of Object.keys(source)){
    const [[row]]=await db.query('SHOW CREATE TABLE `'+table+'`');assert.equal(tableDefinitionHash(row['Create Table']),before[table])
   }
   for(const table of Object.keys(source)){
    const [[row]]=await db.query('SHOW CREATE TABLE dev_vue.`'+table+'`');assert.equal(tableDefinitionHash(row['Create Table']),before[table])
   }
   if(!executionFoundation)return {passed:true,sourceDatabase:'dev_vue',sourceSteps:journal.length,sourceTableCount:tables.length,
    promotionSql:plan.sql,beforeSchemaHash:inferenceRootSchemaState(beforeDefinitions).sha256,afterSchemaHash:observed.sha256,promotedTables:promoted,foreignKeysVerified:actualLinks.length,
    checks:['complete-current-source-DDL-cloned-without-data','atomic-inference-root-rename',
     'all-incoming-and-outgoing-foreign-keys-retargeted-exactly','reverse-rename-restores-all-DDL-and-foreign-keys','source-DDL-unchanged'],
    existingDatabaseWrites:0,dataCopied:false,dataPreservationVerified:false,referenceDatabaseRemoved:true}
   await db.query(plan.sql)
   transitionReference=await createSchemaTransitionReference(db)
   foundationEvidence=await verifyExecutionFoundationDdl(transitionReference.connection)
  }
  const files=['056_partial_close_workflows.sql','058_position_protection_children.sql','059_position_protection_commands.sql',
   '060_position_protection_dispatches.sql','061_position_protection_outcomes.sql','062_position_protection_unissued_expiries.sql']
  const migrations=[]
  for(const file of files){const bytes=await readFile(new URL('../../server/db/migrations/inplace/'+file,import.meta.url))
   const statements=splitSqlStatements(bytes.toString('utf8'))
   for(const [index,sql] of statements.entries()){stage=file+':'+(index+1);await (transitionReference?.connection??db).query(sql)}
   migrations.push({file,sha256:createHash('sha256').update(bytes).digest('hex'),statements:statements.length})
  }
  const after={},changed=[]
  const [finalTables]=await db.query('SHOW FULL TABLES WHERE Table_type=\'BASE TABLE\'')
  for(const item of finalTables){const table=item['Tables_in_'+name];const [[row]]=await db.query('SHOW CREATE TABLE `'+table+'`')
   const ddl=row['Create Table'],hash=tableDefinitionHash(ddl)
   if(before[table]!==hash){changed.push(table);after[table]={ddl,sha256:hash}}
  }
  for(const table of Object.keys(source)){
   const [[row]]=await db.query('SHOW CREATE TABLE dev_vue.`'+table+'`');assert.equal(tableDefinitionHash(row['Create Table']),before[table])
  }
  return {passed:true,sourceDatabase:'dev_vue',sourceSteps:journal.length,sourceTableCount:tables.length,finalTableCount:finalTables.length,
   foundationEvidence,schemaTransitions:transitionReference?.transitions,initialSchemaState:transitionReference?.initial,migrations,changedTables:changed.sort(),canonicalTables:after,checks:['complete-current-source-DDL-cloned-without-data','all-candidate-DDL-applies-to-complete-parents','source-DDL-unchanged'],
   existingDatabaseWrites:0,dataCopied:false,dataPreservationVerified:false,referenceDatabaseRemoved:true}
 }catch(error){error.referenceStatement??='full-schema:'+stage+':'+error.message;throw error}finally{
  try {await db.query('SET SESSION foreign_key_checks=1');if(original)await db.query('USE `'+original+'`');if(created)await db.query('DROP DATABASE `'+name+'`')}
  finally{if(locked)await db.execute('SELECT RELEASE_LOCK(?)',['aurum:inplace:dev_vue']);db.release()}
 }
}
