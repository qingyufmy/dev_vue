import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import {loadInferenceRootUpgrade} from './inference-root-upgrade.mjs'
import {hash} from './v4-backfill-contract.mjs'
import {splitSqlStatements,sha256} from './v4-migration-plan.mjs'

export async function loadExecutionWorkflowUpgrade(root){
 const prior=await loadInferenceRootUpgrade(root);assert.equal(prior.steps.length,206)
 const reference=JSON.parse(await readFile(new URL('docs/architecture/strategy-write-reference-v154-20260910.json',root),'utf8')).executionFoundationFullSchema
 assert.ok(reference.passed && reference.referenceDatabaseRemoved && reference.existingDatabaseWrites===0)
 assert.equal(reference.finalTableCount,293);assert.equal(reference.schemaTransitions.length,32)
 assert.equal(reference.initialSchemaState.sha256,prior.step.afterHash)
 const sources=[...reference.foundationEvidence.sources,...reference.migrations.map(row=>({...row,file:'inplace/'+row.file}))]
 for(const {file,sha256:expected} of sources)assert.equal(sha256(await readFile(new URL('server/db/migrations/'+file,root))),expected)
 const source='server/db/migrations/inplace/064_execution_workflow_foundation.sql',bytes=await readFile(new URL(source,root))
 const statements=splitSqlStatements(bytes.toString('utf8'))
 assert.deepEqual(statements,reference.schemaTransitions.map(row=>row.sql))
 const definitions=new Map(reference.initialSchemaState.definitions.map(row=>[row.name,row.sha256]))
 const stateHash=()=>hash([...definitions].map(([name,sha256])=>({name,sha256})).sort((a,b)=>a.name.localeCompare(b.name)))
 assert.equal(stateHash(),reference.initialSchemaState.sha256)
 const priorRegistryHash=hash(prior.steps.map(({id,checksum})=>({id,checksum}))),referenceHash=hash(reference)
 const added=reference.schemaTransitions.map((row,index)=>{
  assert.equal(row.ordinal,index+1);assert.equal(stateHash(),row.beforeHash)
  for(const name of row.removed){assert.ok(definitions.delete(name),'removed_table_missing')}
  for(const changed of row.changed){assert.match(changed.name,/^[a-z][a-z0-9_]*$/);assert.match(changed.sha256,/^[a-f0-9]{64}$/);definitions.set(changed.name,changed.sha256)}
  assert.equal(stateHash(),row.afterHash);assert.notEqual(row.beforeHash,row.afterHash)
  const body={id:'inplace_064_'+String(index+1).padStart(2,'0')+'_execution_workflow',table:'execution_workflow_schema',
   protocol:'execution-workflow-foundation/v1',sql:row.sql,source,sourceSha256:sha256(bytes),
   beforeHash:row.beforeHash,afterHash:row.afterHash,priorRegistryHash,referenceHash}
  return {...body,checksum:hash(body)}
 })
 assert.equal(definitions.size,293)
 return {prior,added,steps:[...prior.steps,...added],transitions:added.map(step=>({step,key:step.table,before:step.beforeHash,after:step.afterHash})),
  finalSchemaHash:stateHash(),finalTableHashes:Object.fromEntries(definitions),referenceHash}
}
