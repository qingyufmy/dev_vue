import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { loadRiskStructureMigration } from '../scripts/lib/inplace-risk-structure.mjs'
import { verifyRiskRehearsalChain } from '../scripts/lib/risk-restoration-evidence.mjs'
const root = new URL('../', import.meta.url)
const json = async name => JSON.parse(await readFile(new URL('docs/architecture/' + name + '-20260909.json', root), 'utf8'))
const plan = await loadRiskStructureMigration(root)
const baseline = await json('risk-restored-baseline-166')
const reference = await json('risk-structure-reference-rehearsal')
const reports = await Promise.all(['create-loss', 'alter-loss', 'complete', 'replay'].map(name => json('risk-rehearsal-' + name)))
test('validates the archived real 166 to 174 step interruption and replay chain', () => {
  assert.equal(verifyRiskRehearsalChain(plan, baseline, reference, reports).stepsCompleted, 174)
})
test('rejects mixed targets, altered protected data, replaced tool versions and broken receipt links', () => {
  for (const mutate of [r => { r.identity.database = 'dev_vue' }, r => { r.protectedSnapshotHash = 'wrong' },
    r => { r.tools = [] }, r => { r.referenceHash = 'wrong' }, r => { r.baselineHash = 'wrong' },
    r => { r.sourceWrites = 1 }]) {
    const changed = structuredClone(reports); mutate(changed[2])
    assert.throws(() => verifyRiskRehearsalChain(plan, baseline, reference, changed), /risk_restoration_evidence_/)
  }
})
test('rejects missing steps, nonzero replay DDL and lost interruption evidence', () => {
  for (const mutate of [r => { r[3].ddlCount = 1 }, r => { r[2].history.pop() },
    r => { r[0].result.status = 'completed' }, r => { r[1].result.next = 'another_step' }]) {
    const changed = structuredClone(reports); mutate(changed)
    assert.throws(() => verifyRiskRehearsalChain(plan, baseline, reference, changed))
  }
})
