import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import {loadParentDispatchUpgrade} from './parent-dispatch-upgrade.mjs'
import {hash} from './v4-backfill-contract.mjs'
import {sha256,splitSqlStatements} from './v4-migration-plan.mjs'
import {tableDefinitionHash} from './inplace-foundation-upgrade.mjs'

/** Append one evidenced receipt table step; the original 240 checksums remain unchanged. */
export async function loadStrategyReceiptUpgrade(root) {
 const prior=await loadParentDispatchUpgrade(root)
 assert.equal(prior.steps.length,240)
 const reference=JSON.parse(await readFile(new URL('docs/architecture/strategy-receipt-full-schema-v1-20260911.json',root),'utf8'))
 assert.ok(reference.passed && reference.referenceDatabaseRemoved && reference.existingDatabaseWrites===0)
 assert.equal(reference.sourceSteps,240);assert.equal(reference.tableCount,294)
 assert.equal(reference.initialSchemaState.sha256,prior.finalSchemaHash)
 assert.equal(reference.transitions.length,1)
 const transition=reference.transitions[0],source='server/db/migrations/inplace/048_strategy_write_receipts.sql'
 const bytes=await readFile(new URL(source,root))
 assert.equal(reference.source.file,source);assert.equal(reference.source.sha256,sha256(bytes))
 assert.deepEqual(splitSqlStatements(bytes.toString('utf8')),[transition.sql])
 assert.equal(transition.beforeHash,prior.finalSchemaHash);assert.equal(transition.ordinal,1)
 assert.deepEqual(transition.removed,[])
 assert.deepEqual(transition.changed,[{name:'strategy_write_receipts_v4',sha256:tableDefinitionHash(reference.receiptDdl)}])
 assert.equal(prior.finalTableHashes.strategy_write_receipts_v4,undefined)
 const finalTableHashes={...prior.finalTableHashes,strategy_write_receipts_v4:transition.changed[0].sha256}
 const finalSchemaHash=hash(Object.entries(finalTableHashes).map(([name,sha256])=>({name,sha256})).sort((a,b)=>a.name.localeCompare(b.name)))
 assert.equal(finalSchemaHash,transition.afterHash);assert.notEqual(finalSchemaHash,prior.finalSchemaHash)
 const body={id:'inplace_067_01_strategy_write_receipts',table:'execution_workflow_schema',
  protocol:'strategy-write-receipt/v1',sql:transition.sql,source,sourceSha256:sha256(bytes),
  beforeHash:transition.beforeHash,afterHash:transition.afterHash,
  priorRegistryHash:hash(prior.steps.map(({id,checksum})=>({id,checksum}))),referenceHash:hash(reference)}
 const step={...body,checksum:hash(body)}
 return {prior,step,steps:[...prior.steps,step],finalTableHashes,finalSchemaHash,receiptDdl:reference.receiptDdl,
  transitions:[...prior.transitions,{step,key:step.table,before:step.beforeHash,after:step.afterHash}]}
}
