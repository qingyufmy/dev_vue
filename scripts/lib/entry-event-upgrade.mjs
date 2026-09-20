import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { loadMemoryAuditCompletionUpgrade } from './memory-audit-completion-upgrade.mjs'
import { sha256, splitSqlStatements } from './v4-migration-plan.mjs'
import { hash } from './v4-backfill-contract.mjs'
import { tableDefinitionHash } from './inplace-foundation-upgrade.mjs'

export async function loadEntryEventSource(root) {
  const path = 'server/db/migrations/inplace/079_entry_event_claims.sql', bytes = await readFile(new URL(path, root))
  const statements = splitSqlStatements(bytes.toString('utf8'))
  assert.equal(statements.length, 1)
  return { sources: [{ path, sha256: sha256(bytes) }], statements }
}
export function composeEntryEventUpgrade(prior, source, proof) {
  assert.equal(prior.steps.length, 266); assert.equal(proof.sourceSteps, 266); assert.equal(proof.tableCount, 315)
  assert.equal(proof.initialSchemaState.sha256, prior.finalSchemaHash)
  assert.deepEqual(proof.sources, source.sources); assert.deepEqual(proof.transitions.map(row => row.sql), source.statements)
  const finalTableHashes = { ...prior.finalTableHashes }, added = []
  let before = prior.finalSchemaHash
  for (const [index, transition] of proof.transitions.entries()) {
    assert.equal(transition.beforeHash, before); assert.deepEqual(transition.removed, [])
    for (const row of transition.changed) finalTableHashes[row.name] = row.sha256
    const after = hash(Object.entries(finalTableHashes).map(([name, sha256]) => ({ name, sha256 })).sort((a, b) => a.name.localeCompare(b.name)))
    assert.equal(after, transition.afterHash)
    const body = { id: `inplace_079_${String(index + 1).padStart(2, '0')}_entry_event_claims`, table: 'execution_workflow_schema',
      protocol: 'entry-event-claims/v1', sql: transition.sql, sources: source.sources, beforeHash: before, afterHash: after,
      priorRegistryHash: hash(prior.steps.map(({ id, checksum }) => ({ id, checksum }))), referenceHash: hash(proof) }
    added.push({ ...body, checksum: hash(body) }); before = after
  }
  for (const [name, ddl] of Object.entries(proof.definitions)) assert.equal(tableDefinitionHash(ddl), finalTableHashes[name])
  return { prior, added, steps: [...prior.steps, ...added], finalTableHashes, finalSchemaHash: before, definitions: proof.definitions,
    transitions: [...prior.transitions, ...added.map(step => ({ step, key: step.table, before: step.beforeHash, after: step.afterHash }))] }
}
export async function loadEntryEventUpgrade(root) {
  const reference = JSON.parse(await readFile(new URL('docs/architecture/entry-event-reference-v1-20260913.json', root), 'utf8'))
  assert.ok(reference.passed && reference.referenceDatabaseRemoved && reference.existingDatabaseWrites === 0
    && reference.ddlAckLossRecovered && reference.replayNoDDL && reference.concurrentSingleWinner)
  return composeEntryEventUpgrade(await loadMemoryAuditCompletionUpgrade(root), await loadEntryEventSource(root), reference.schemaProof)
}
