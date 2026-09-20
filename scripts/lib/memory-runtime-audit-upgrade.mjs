import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { loadHistoryCollectionTaskUpgrade } from './history-collection-task-upgrade.mjs'
import { splitSqlStatements, sha256 } from './v4-migration-plan.mjs'
import { tableDefinitionHash } from './inplace-foundation-upgrade.mjs'
import { hash } from './v4-backfill-contract.mjs'

export function memoryRuntimeAuditPlan(prior, report, inventory, bytes) {
  const table='strategy_memory_injection_logs_v4',source='server/db/migrations/inplace/050_strategy_memory_runtime_audit.sql'
  const reference=report.runtimeMemory
  assert.equal(prior.steps.length,191)
  assert.ok(prior.steps.at(-1).id.startsWith('inplace_053_'))
  assert.ok(report.passed && report.existingDatabaseWrites===0 && report.referenceDatabaseRemoved===true && reference?.passed)
  assert.equal(report.serverUuid,'ac423207-6ef3-11f1-b302-000c29fda104')
  assert.ok(inventory.passed && inventory.writes===0 && inventory.identity.db==='dev_vue'
    && inventory.identity.serverUuid===report.serverUuid && inventory.upgradeJournal.completed && inventory.upgradeJournal.count===191)
  for(const check of ['audit-migration-preserves-legacy-token-count-and-row','trader-preparation-audit-keeps-real-usage-unknown','audit-snapshot-fk-hash-and-method-constraints']) assert.ok(reference.checks.includes(check))
  const sourceSha256=sha256(bytes)
  assert.equal(reference.auditDdlSha256,sourceSha256)
  const statements=splitSqlStatements(bytes.toString('utf8'))
  assert.ok(statements.length===1 && statements[0].startsWith(`ALTER TABLE ${table}\n`))
  for(const ddl of [reference.auditBeforeDdl,reference.auditAfterDdl]) assert.ok(typeof ddl==='string' && ddl.startsWith('CREATE TABLE `'+table+'` ('))
  const beforeHash=tableDefinitionHash(reference.auditBeforeDdl),afterHash=tableDefinitionHash(reference.auditAfterDdl)
  assert.notEqual(beforeHash,afterHash)
  assert.equal(inventory.tables[table].definitionHash,beforeHash)
  assert.equal(tableDefinitionHash(inventory.tables[table].ddl),beforeHash)
  const parentHashes=Object.fromEntries(['users','strategies','strategy_versions','strategy_memory_libraries_v4','strategy_memory_library_revisions_v4','inference_snapshots'].map(name=>{
    const value=inventory.tables[name];assert.ok(value?.exists && value.definitionHash===tableDefinitionHash(value.ddl))
    return [name,value.definitionHash]
  }))
  // The SQL source number is historical. Its registry transition is appended after 053, never inserted into prior history.
  const value={id:'inplace_054_01_strategy_memory_runtime_audit',table,operation:'ALTER',protocol:'memory-runtime-audit-structure/v1',
    source,sourceSha256,sql:statements[0],beforeHash,afterHash,priorRegistryHash:hash(prior.steps.map(({id,checksum})=>({id,checksum}))),parentHashes}
  const step={...value,checksum:hash(value)}
  return {prior,steps:[...prior.steps,step],added:[step],transitions:[{step,key:table,before:beforeHash,after:afterHash}],
    initialTableHashes:{[table]:beforeHash},finalTableHashes:{[table]:afterHash},parentHashes,referenceHash:hash(report),inventoryHash:hash(inventory)}
}
export async function loadMemoryRuntimeAuditUpgrade(root) {
  const [prior,report,inventory,bytes]=await Promise.all([
    loadHistoryCollectionTaskUpgrade(root),
    readFile(new URL('docs/architecture/strategy-write-reference-v59-20260910.json',root),'utf8').then(JSON.parse),
    readFile(new URL('docs/architecture/memory-upgrade-current-inventory-v2-20260910.json',root),'utf8').then(JSON.parse),
    readFile(new URL('server/db/migrations/inplace/050_strategy_memory_runtime_audit.sql',root))])
  return memoryRuntimeAuditPlan(prior,report,inventory,bytes)
}
