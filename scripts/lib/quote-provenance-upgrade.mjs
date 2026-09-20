import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { loadInferenceBuildUpgrade } from './inference-build-upgrade.mjs'
import { splitSqlStatements,sha256 } from './v4-migration-plan.mjs'
import { tableDefinitionHash } from './inplace-foundation-upgrade.mjs'
import { validateColumnHistory } from './dev-vue-column-upgrade.mjs'
import { coordinateInplaceSchema } from './inplace-schema-coordinator.mjs'
import { hash } from './v4-backfill-contract.mjs'

export async function loadQuoteProvenanceUpgrade(root) {
  const prior=await loadInferenceBuildUpgrade(root)
  assert.equal(prior.steps.length,204)
  const source='server/db/migrations/inplace/057_market_quote_provenance.sql',bytes=await readFile(new URL(source,root))
  assert.equal(sha256(bytes),'09c812648cce5e882cb40e402a506e1d3b2b800859cffdb6c1bee1b476017bd2')
  const statements=splitSqlStatements(bytes.toString('utf8'));assert.equal(statements.length,1)
  const report=JSON.parse(await readFile(new URL('docs/architecture/strategy-write-reference-v101-20260910.json',root),'utf8'))
  assert.ok(report.passed&&report.referenceDatabaseRemoved===true&&report.existingDatabaseWrites===0)
  assert.equal(report.serverUuid,'ac423207-6ef3-11f1-b302-000c29fda104')
  const reference=report.quoteProvenance
  assert.ok(reference.passed&&reference.referenceDatabaseRemoved===true&&reference.existingDatabaseWrites===0)
  assert.equal(reference.migrationSha256,sha256(bytes))
  assert.deepEqual(reference.checks,[
    'old-schema-rejects-source-capability-and-rolls-back-quote-and-revision',
    'single-alter-preserves-all-three-existing-source-kinds-and-foreign-keys',
    'real-parent-quote-revision-and-source-all-rollback-after-source-insert',
    'actual-repository-quote-and-source-commit-with-exact-milliseconds-repeated-revision-no-write',
    'unsupported-kind-and-invalid-source-user-still-rejected',
  ])
  const beforeHash=tableDefinitionHash(reference.beforeDdl),afterHash=tableDefinitionHash(reference.afterDdl)
  assert.equal(beforeHash,'af9447fdb2f5dc6c3343146b6854b47e958779111dd19a08f6ea07527d76f26e')
  assert.equal(afterHash,'5b2fe36ade9eb9573273158aedabe586802b0089851857d48f81bccd5e355db8')
  const body={id:'inplace_057_01_market_quote_provenance',table:'trading_projection_provenance_v4',protocol:'quote-provenance-upgrade/v1',
    sql:statements[0],source,sourceSha256:sha256(bytes),beforeHash,afterHash,
    priorRegistryHash:hash(prior.steps.map(({id,checksum})=>({id,checksum}))),referenceHash:hash(reference)}
  const step={...body,checksum:hash(body)}
  return {prior,step,steps:[...prior.steps,step],transitions:[{step,key:step.table,before:beforeHash,after:afterHash}],referenceHash:hash(report)}
}

/** Store verifies exact host/schema/upgrade lock, unchanged prior tables and target rows; no backup or identity is inferred here. */
export async function coordinateQuoteProvenanceUpgrade(store,plan,options={}) {
  assert.equal(plan.prior.steps.length,204);assert.equal(plan.steps.length,205)
  assert.equal(plan.step.id,'inplace_057_01_market_quote_provenance')
  const inspect=async()=>{
    await store.verifyPlan(plan)
    const history=await store.history(),entries=validateColumnHistory(history,plan.steps)
    assert.ok(plan.prior.steps.every(step=>entries.get(step.id)?.status==='completed'),'quote_upgrade_prior_incomplete')
    await store.verifyPrior(history.filter(row=>row.id!==plan.step.id))
    await store.verifyProtected()
  }
  await inspect()
  const guarded={history:()=>store.history(),tableHash:table=>store.tableHash(table),
    begin:async step=>{await inspect();await store.begin(step)},
    execute:async sql=>{await inspect();assert.equal(sql,plan.step.sql);await store.execute(sql)},
    complete:async step=>{await inspect();await store.complete(step)}}
  const result=await coordinateInplaceSchema(guarded,plan,options)
  await inspect()
  return result
}
