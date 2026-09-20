import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import { loadEntryEventUpgrade } from './entry-event-upgrade.mjs'
import { loadBridgeInstallationSource } from './bridge-installation-upgrade-source.mjs'
import { composeBridgeInstallationUpgrade, loadBridgeInstallationUpgrade } from './bridge-installation-upgrade.mjs'

const root = new URL('../../', import.meta.url)
const prior = await loadEntryEventUpgrade(root), source = await loadBridgeInstallationSource(root)
const reference = JSON.parse(await readFile(new URL('docs/architecture/bridge-installation-reference-v1-20260914.json', root), 'utf8'))
test('promotes the real reference proof while preserving all 267 previous checksums', async () => {
  const plan = await loadBridgeInstallationUpgrade(root)
  assert.equal(plan.steps.length, 271)
  assert.equal(Object.keys(plan.finalTableHashes).length, 318)
  assert.deepEqual(plan.steps.slice(0, 267), prior.steps)
  assert.equal(plan.finalSchemaHash, reference.schemaProof.transitions.at(-1).afterHash)
})
test('rejects changed source identity, broken transitions and unrelated table mutations', () => {
  for (const mutate of [
    proof => { proof.sourceSteps = 266 },
    proof => { proof.tableCount = 317 },
    proof => { proof.sources[0].sha256 = '0'.repeat(64) },
    proof => { proof.transitions[1].beforeHash = '0'.repeat(64) },
    proof => { proof.transitions[0].removed = ['users'] },
    proof => { proof.transitions[0].changed[0].name = 'users' },
    proof => { proof.definitions.bridge_refresh_sessions += '\n-- changed' },
  ]) {
    const proof = structuredClone(reference.schemaProof)
    mutate(proof)
    assert.throws(() => composeBridgeInstallationUpgrade(prior, source, proof))
  }
})
