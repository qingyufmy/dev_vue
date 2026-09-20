import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { loadRiskStructureMigration } from './lib/inplace-risk-structure.mjs'
import { prepareRiskRestorationEvidence } from './lib/risk-restoration-evidence.mjs'
import { verifyRiskToolTransition } from './lib/risk-tool-transition.mjs'
import { prepareRiskStructureProof } from './lib/risk-structure-proof.mjs'
import { freezeRiskStructureTools } from './lib/mysql-risk-structure-store.mjs'
import { legacyCandlePromotionSnapshot } from './lib/legacy-candle-promotion.mjs'
import { hash } from './lib/v4-backfill-contract.mjs'

const [referencePath, reviewPath, destinationDirectory] = process.argv.slice(2)
assert.ok(process.argv.length === 5 && [referencePath, reviewPath, destinationDirectory].every(path => isAbsolute(path ?? '')))
const root = new URL('../', import.meta.url), base = 'D:/dev_codex/.backup-risk-20260909-01/'
const json = async path => JSON.parse(await readFile(path, 'utf8'))
const doc = name => new URL('docs/architecture/' + name + '.json', root)
const plan = await loadRiskStructureMigration(root), tools = await freezeRiskStructureTools(root)
const input = {
  baseline: await json(doc('risk-restored-baseline-166-20260909')),
  reference: await json(doc('risk-structure-reference-rehearsal-20260909')),
  reports: await Promise.all(['create-loss', 'alter-loss', 'complete', 'replay']
    .map(name => json(doc('risk-rehearsal-' + name + '-20260909')))),
  receiptBytes: await readFile(base + 'receipt.json'),
  publicReceipt: await json(doc('risk-local-backup-verified-20260909')),
  source: await json(base + 'source-snapshot.json'), restored: await json(base + 'restored-snapshot.json'),
  priorProof: await json(doc('current-context-changes-proof-20260908')),
}
const evidence = prepareRiskRestorationEvidence(plan, input)
const toolTransition = await json(reviewPath)
verifyRiskToolTransition(evidence.executionTools, tools, toolTransition)
const reference = await json(referencePath)
assert.deepEqual(reference.definitions, input.reference.definitions)
const restore = { kind: 'risk-structure-restore/v1', passed: true,
  sourceIdentity: evidence.sourceIdentity, registryHash: evidence.registryHash,
  sourceSnapshotHash: evidence.sourceSnapshotHash, restoredSnapshotHash: evidence.restoredSnapshotHash,
  sourceWrites: 0, stepsCompleted: evidence.stepsCompleted, tools, executionTools: evidence.executionTools,
  toolTransition, historicalEvidence: evidence, snapshotEvidence: { source: input.source, restored: input.restored },
  scope: 'Historical DDL fault-injection evidence plus exact reviewed tool changes. Entrypoint changes additionally bind current reference and restored replay. Current database must be independently inspected.' }
const proof = prepareRiskStructureProof(plan, evidence.sourceIdentity, input.priorProof,
  legacyCandlePromotionSnapshot(input.source), reference, restore, tools)
// Destination is an existing controlled local archive; never overwrite proof files.
await writeFile(join(destinationDirectory, 'risk-structure-restore.json'), JSON.stringify(restore, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
await writeFile(join(destinationDirectory, 'risk-structure-proof.json'), JSON.stringify(proof, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
console.log(JSON.stringify({ passed: true, proofHash: proof.proofHash, restoreHash: hash(restore),
  historicalEvidenceHash: hash(evidence), steps: plan.steps.length, currentDatabaseUpgraded: false }))
