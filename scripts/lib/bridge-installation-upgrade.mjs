import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { loadEntryEventUpgrade } from './entry-event-upgrade.mjs'
import { loadBridgeInstallationSource } from './bridge-installation-upgrade-source.mjs'
import { hash } from './v4-backfill-contract.mjs'
import { tableDefinitionHash } from './inplace-foundation-upgrade.mjs'

export function composeBridgeInstallationUpgrade(prior, source, proof) {
  assert.equal(prior.steps.length, 267)
  assert.equal(proof.sourceSteps, 267)
  assert.equal(proof.initialSchemaState.definitions.length, 315)
  assert.equal(proof.tableCount, 318)
  assert.equal(proof.initialSchemaState.sha256, prior.finalSchemaHash)
  assert.deepEqual(proof.sources, source.sources)
  assert.deepEqual(proof.transitions.map(row => row.sql), source.statements)
  assert.equal(proof.transitions.length, 4)
  const finalTableHashes = { ...prior.finalTableHashes }, added = []
  let before = prior.finalSchemaHash
  const expected = ['bridge_installation_request_limits', 'bridge_installation_authorizations', 'bridge_installation_requests', 'bridge_refresh_sessions']
  for (const [index, transition] of proof.transitions.entries()) {
    assert.equal(transition.ordinal, index + 1)
    assert.equal(transition.beforeHash, before)
    assert.deepEqual(transition.removed, [])
    assert.deepEqual(transition.changed.map(row => row.name), [expected[index]])
    for (const row of transition.changed) finalTableHashes[row.name] = row.sha256
    const after = hash(Object.entries(finalTableHashes).map(([name, sha256]) => ({ name, sha256 })).sort((a, b) => a.name.localeCompare(b.name)))
    assert.equal(after, transition.afterHash)
    const body = { id: `inplace_080_${String(index + 1).padStart(2, '0')}_bridge_installation`, table: 'execution_workflow_schema',
      protocol: 'bridge-installation-authorizations/v1', sql: transition.sql, sources: source.sources, beforeHash: before, afterHash: after,
      priorRegistryHash: hash(prior.steps.map(({ id, checksum }) => ({ id, checksum }))), referenceHash: hash(proof) }
    added.push({ ...body, checksum: hash(body) }); before = after
  }
  assert.deepEqual(Object.keys(proof.definitions).sort(), [...expected].sort())
  for (const [name, ddl] of Object.entries(proof.definitions)) assert.equal(tableDefinitionHash(ddl), finalTableHashes[name])
  return { prior, added, steps: [...prior.steps, ...added], finalTableHashes, finalSchemaHash: before, definitions: proof.definitions,
    transitions: [...prior.transitions, ...added.map(step => ({ step, key: step.table, before: step.beforeHash, after: step.afterHash }))] }
}

export async function loadBridgeInstallationUpgrade(root) {
  const reference = JSON.parse(await readFile(new URL('docs/architecture/bridge-installation-reference-v1-20260914.json', root), 'utf8'))
  assert.ok(reference.passed && reference.referenceDatabaseRemoved && reference.existingDatabaseWrites === 0
    && reference.ddlAckLossRecovered && reference.replayNoDDL && reference.concurrentSingleWinner
    && reference.bootstrapExtensionMatches && reference.sourceSchemaUnchanged && reference.sourceJournalUnchanged)
  assert.equal(reference.ddlAckLossCases, 4)
  return composeBridgeInstallationUpgrade(await loadEntryEventUpgrade(root), await loadBridgeInstallationSource(root), reference.schemaProof)
}
