import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { loadHistoryCollectionTaskUpgrade } from './history-collection-task-upgrade.mjs'
import { inferenceBuildNames,inferenceBuildMapping,inferenceBuildDefinition,inferenceBuildPhases,assertInferenceBuildParents } from './inference-build-schema.mjs'
import { splitSqlStatements,sha256 } from './v4-migration-plan.mjs'
import { tableDefinitionHash } from './inplace-foundation-upgrade.mjs'
import { hash } from './v4-backfill-contract.mjs'
export async function loadInferenceBuildUpgrade(root){
  const prior=await loadHistoryCollectionTaskUpgrade(root)
  const report=JSON.parse(await readFile(new URL('docs/architecture/strategy-write-reference-v65-20260910.json',root),'utf8'))
  const inventory=JSON.parse(await readFile(new URL('docs/architecture/inference-schema-current-inventory-v4-20260910.json',root),'utf8'))
  assert.ok(report.passed && report.referenceDatabaseRemoved===true && report.existingDatabaseWrites===0 && report.inferenceBuild?.passed)
  assert.equal(report.serverUuid,'ac423207-6ef3-11f1-b302-000c29fda104');assert.equal(prior.steps.length,191)
  assert.equal(sha256(await readFile(new URL('server/db/migrations/20260903_004_ai_strategy_and_inference_core.sql',root))),report.parentSources.strategy)
  for(const record of report.evidenceMigrationSources)assert.equal(sha256(await readFile(new URL('server/db/migrations/'+record.file,root))),record.sha256)
  const reference=report.inferenceBuild
  assertInferenceBuildParents(inventory,reference.parentRequirements)
  assert.deepEqual(reference.tables.map(row=>row.name),inferenceBuildNames)
  for(const row of reference.tables)assert.equal(inferenceBuildDefinition(row.name,row.sourceDdl),row.buildSql)
  const phases=inferenceBuildPhases(reference.tables.map(row=>({name:row.name,sql:row.buildSql})))
  assert.deepEqual(phases,reference.phases)
  const source='server/db/migrations/inplace/055_inference_decision_build.sql',bytes=await readFile(new URL(source,root)),sql=splitSqlStatements(bytes.toString('utf8'))
  assert.deepEqual(sql,[...phases.creates,...phases.deferred].map(row=>row.sql))
  assert.equal(sql.length,13);assert.equal(reference.transitions.length,13)
  const states=new Map(),priorRegistryHash=hash(prior.steps.map(({id,checksum})=>({id,checksum})))
  const added=reference.transitions.map((row,index)=>{
    assert.equal(row.sql,sql[index]);assert.ok(Object.values(inferenceBuildMapping).includes(row.table))
    assert.equal(row.beforeHash,states.get(row.table)??null);assert.equal(row.afterHash,tableDefinitionHash(row.ddl));states.set(row.table,row.afterHash)
    const value={id:`inplace_055_${String(index+1).padStart(2,'0')}_${row.table}`,table:row.table,sql:row.sql,beforeHash:row.beforeHash,afterHash:row.afterHash,
      protocol:'inference-decision-build/v1',source,sourceSha256:sha256(bytes),priorRegistryHash,referenceHash:hash(reference)}
    return {...value,checksum:hash(value)}
  })
  return {prior,steps:[...prior.steps,...added],added,transitions:added.map(step=>({step,key:step.table,before:step.beforeHash,after:step.afterHash})),
    finalTableHashes:Object.fromEntries(states),parentRequirements:reference.parentRequirements,referenceHash:hash(report),inventoryHash:hash(inventory)}
}
