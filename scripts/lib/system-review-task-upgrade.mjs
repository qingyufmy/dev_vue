import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { loadCandidateTaskUpgrade } from './candidate-task-upgrade.mjs'
import { loadSystemReviewTaskSource } from './system-review-task-source.mjs'
import { tableDefinitionHash } from './inplace-foundation-upgrade.mjs'
import { hash } from './v4-backfill-contract.mjs'

export async function loadSystemReviewTaskUpgrade(root) {
  const prior = await loadCandidateTaskUpgrade(root), source = await loadSystemReviewTaskSource(root)
  const reference = JSON.parse(await readFile(new URL('docs/architecture/system-review-task-full-schema-v1-20260911.json', root), 'utf8'))
  assert.ok(reference.passed && reference.referenceDatabaseRemoved && reference.existingDatabaseWrites === 0)
  assert.equal(prior.steps.length, 262); assert.equal(reference.sourceSteps, 262); assert.equal(reference.tableCount, 311)
  assert.equal(reference.initialSchemaState.sha256, prior.finalSchemaHash)
  assert.deepEqual(reference.sources, source.sources)
  assert.deepEqual(reference.transitions.map(row => row.sql), source.statements)
  const finalTableHashes = { ...prior.finalTableHashes }, added = []
  let before = prior.finalSchemaHash
  for (const [index, transition] of reference.transitions.entries()) {
    assert.equal(transition.beforeHash, before); assert.deepEqual(transition.removed, [])
    for (const row of transition.changed) finalTableHashes[row.name] = row.sha256
    const after = hash(Object.entries(finalTableHashes).map(([name, sha256]) => ({ name, sha256 })).sort((a, b) => a.name.localeCompare(b.name)))
    assert.equal(after, transition.afterHash)
    const body = { id: `inplace_075_${String(index + 1).padStart(2, '0')}_system_review_task`, table: 'execution_workflow_schema',
      protocol: 'system-review-task/v1', sql: transition.sql, sources: source.sources, beforeHash: before, afterHash: after,
      priorRegistryHash: hash(prior.steps.map(({ id, checksum }) => ({ id, checksum }))), referenceHash: hash(reference) }
    added.push({ ...body, checksum: hash(body) }); before = after
  }
  for (const [name, ddl] of Object.entries(reference.definitions)) assert.equal(tableDefinitionHash(ddl), finalTableHashes[name])
  assert.equal(added.length, 1); assert.equal(Object.keys(finalTableHashes).length, 312)
  return { prior, added, steps: [...prior.steps, ...added], finalTableHashes, finalSchemaHash: before, definitions: reference.definitions,
    transitions: [...prior.transitions, ...added.map(step => ({ step, key: step.table, before: step.beforeHash, after: step.afterHash }))] }
}
