import { hash } from './v4-backfill-contract.mjs'

const check = (value, code) => { if (!value) throw Error('risk_tool_transition_' + code) }
function inventory(rows) {
  check(Array.isArray(rows) && rows.length > 0 && rows.every(row => typeof row.path === 'string'
    && /^[a-f0-9]{64}$/.test(row.sha256)) && new Set(rows.map(row => row.path)).size === rows.length, 'inventory')
  return new Map(rows.map(row => [row.path, row.sha256]))
}

export function verifyRiskToolTransition(before, after, review) {
  const old = inventory(before), current = inventory(after)
  const changes = [...new Set([...old.keys(), ...current.keys()])].sort().flatMap(path =>
    old.get(path) === current.get(path) ? [] : [{ path, before: old.get(path) ?? null, after: current.get(path) ?? null }])
  check(review.kind === 'risk-tool-transition-review/v1' && review.fromToolsHash === hash(before)
    && review.toToolsHash === hash(after) && Array.isArray(review.changes), 'binding')
  check(hash(changes) === hash(review.changes.map(({ path, before, after }) => ({ path, before, after })))
    && review.changes.every(row => typeof row.reason === 'string' && row.reason.trim().length > 0), 'changes')
  // A proof/inspection change may reuse the original DDL rehearsal. Actual
  // execution code, migrations and frozen historical inputs cannot use this path.
  const allowed = new Set(['scripts/lib/risk-structure-proof.mjs', 'scripts/lib/mysql-risk-structure-store.mjs',
    'scripts/lib/risk-restoration-evidence.mjs', 'scripts/lib/risk-tool-transition.mjs',
    'scripts/verify-risk-restoration-evidence-local.mjs', 'scripts/prepare-risk-upgrade-proof-local.mjs'])
  const entrypoints = new Set(['scripts/apply-risk-current-upgrade-local.mjs', 'scripts/run-risk-current-application-local.py',
    'scripts/rehearse-risk-structure-local.mjs', 'scripts/run-risk-rehearsal-local.py'])
  const needsEntrypointEvidence = changes.some(row => !allowed.has(row.path))
  check(changes.every(row => (allowed.has(row.path) || entrypoints.has(row.path)) && row.after !== null), 'execution_change_requires_rehearsal')
  if (needsEntrypointEvidence) {
    const evidence = review.entrypointEvidence
    check(evidence?.kind === 'risk-entrypoint-review/v1', 'entrypoint_evidence_required')
    const { reference, replay, historicalReference, historicalReplay } = evidence
    check(reference?.kind === 'risk-structure-reference/v1' && historicalReference?.kind === reference.kind
      && reference.referenceDatabaseRemoved === true && reference.existingDatabaseWrites === 0
      && hash(reference.tools) === hash(after) && hash(historicalReference.tools) === hash(before)
      && hash(reference.identity) === hash(historicalReference.identity)
      && reference.registryHash === historicalReference.registryHash
      && hash(reference.checks) === hash(historicalReference.checks)
      && hash(reference.definitions) === hash(historicalReference.definitions), 'entrypoint_reference')
    check(replay?.kind === 'risk-structure-rehearsal/v1' && historicalReplay?.kind === replay.kind
      && replay.passed === true && historicalReplay.passed === true
      && replay.mode === '--resume' && replay.ddlCount === 0 && replay.sourceWrites === 0
      && replay.result?.status === 'completed' && replay.result.ddlCount === 0
      && hash(replay.tools) === hash(after) && hash(historicalReplay.tools) === hash(before)
      && replay.referenceHash === hash(reference) && historicalReplay.referenceHash === hash(historicalReference)
      && hash(replay.identity) === hash(historicalReplay.identity)
      && replay.baselineHash === historicalReplay.baselineHash
      && replay.protectedSnapshotHash === historicalReplay.protectedSnapshotHash
      && replay.tableCount === historicalReplay.tableCount
      && hash(replay.history) === hash(historicalReplay.history), 'entrypoint_replay')
    // New wrappers may reuse the historical fault injection only when no core
    // executor/migration change is admitted above. This evidence is a replay,
    // not a claim of new CREATE/ALTER fault injection on restored data.
  }
  return { reviewHash: hash(review), changes }
}
