import test from 'node:test'
import assert from 'node:assert/strict'
import { hash } from '../scripts/lib/v4-backfill-contract.mjs'
import { verifyRiskToolTransition } from '../scripts/lib/risk-tool-transition.mjs'
import { readFile } from 'node:fs/promises'
const path = 'scripts/lib/risk-structure-proof.mjs'
const before = [{ path, sha256: 'a'.repeat(64) }]
const after = [{ path, sha256: 'b'.repeat(64) }]
const review = () => ({ kind: 'risk-tool-transition-review/v1', fromToolsHash: hash(before), toToolsHash: hash(after),
  changes: [{ path, before: before[0].sha256, after: after[0].sha256, reason: 'Recompute strict restore parity from original metadata.' }] })
test('binds a reviewed proof change to exact old and new tool hashes', () => {
  assert.equal(verifyRiskToolTransition(before, after, review()).changes.length, 1)
})
test('rejects unreviewed changes, missing reasons, duplicates and modified execution code', () => {
  for (const change of [r => { r.changes = [] }, r => { r.changes[0].reason = '' },
    r => { r.changes[0].after = 'c'.repeat(64) }]) {
    const r = review(); change(r)
    assert.throws(() => verifyRiskToolTransition(before, after, r), /risk_tool_transition_/)
  }
  assert.throws(() => verifyRiskToolTransition([...before, ...before], after, review()), /inventory/)
  const path = 'scripts/lib/risk-structure-coordinator.mjs'
  const old = [{ ...before[0], path }], next = [{ ...after[0], path }]
  const r = review(); r.fromToolsHash = hash(old); r.toToolsHash = hash(next); r.changes[0].path = path
  assert.throws(() => verifyRiskToolTransition(old, next, r), /execution_change_requires_rehearsal/)
})

test('requires bound reference and unchanged restored replay for a new application wrapper', async () => {
  const json = async name => JSON.parse(await readFile(new URL('../docs/architecture/' + name, import.meta.url), 'utf8'))
  const historicalReference = await json('risk-structure-reference-rehearsal-20260909.json')
  const historicalReplay = await json('risk-rehearsal-replay-20260909.json')
  const old = historicalReference.tools
  const path = 'scripts/apply-risk-current-upgrade-local.mjs'
  const next = [...old, { path, sha256: 'f'.repeat(64) }]
  const reference = { ...structuredClone(historicalReference), tools: next }
  const replay = { ...structuredClone(historicalReplay), tools: next, referenceHash: hash(reference) }
  const review = { kind: 'risk-tool-transition-review/v1', fromToolsHash: hash(old), toToolsHash: hash(next),
    changes: [{ path, before: null, after: 'f'.repeat(64), reason: 'Reviewed wrapper delegates to unchanged coordinator and store.' }],
    entrypointEvidence: { kind: 'risk-entrypoint-review/v1', reference, replay, historicalReference, historicalReplay } }
  assert.equal(verifyRiskToolTransition(old, next, review).changes.length, 1)
  for (const mutate of [r => { delete r.entrypointEvidence }, r => { r.entrypointEvidence.replay.history.pop() },
    r => { r.entrypointEvidence.replay.ddlCount = 1 }, r => { r.entrypointEvidence.reference.definitions[0].afterHash = 'a'.repeat(64) },
    r => { r.entrypointEvidence.replay.protectedSnapshotHash = 'bad' }, r => { r.entrypointEvidence.replay.tools = [] }]) {
    const invalid = structuredClone(review); mutate(invalid)
    assert.throws(() => verifyRiskToolTransition(old, next, invalid), /entrypoint_/)
  }
})
