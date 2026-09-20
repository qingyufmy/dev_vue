import { hash } from './v4-backfill-contract.mjs'
import { tableDefinitionHash } from './inplace-foundation-upgrade.mjs'
import { verifyRiskRestoredSnapshot } from './risk-backup-parity.mjs'
import { legacyCandlePromotionSnapshot } from './legacy-candle-promotion.mjs'
import { verifyRiskToolTransition } from './risk-tool-transition.mjs'

const check = (value, code) => { if (!value) throw Error('risk_structure_proof_' + code) }
export const riskStructureReferenceChecks = Object.freeze(['eight-ddl-transitions-with-enforced-foreign-keys',
  'active-version-must-belong-to-set', 'matching-active-version-accepted', 'account-scope-requires-account',
  'same-user-account-key-is-unique', 'different-user-can-use-same-key', 'account-breach-episode-is-unique',
  'release-user-must-exist', 'utc-millisecond-retained'])
export function prepareRiskStructureProof(plan, identity, priorProof, priorSnapshot, reference, restore, tools) {
  check(identity.database === 'dev_vue' && hash(identity) === hash(priorProof.identity), 'identity')
  const registryHash = hash(plan.steps.map(({ id, checksum }) => ({ id, checksum })))
  check(reference.kind === 'risk-structure-reference/v1' && hash(reference.identity) === hash(identity)
    && reference.registryHash === registryHash && reference.referenceDatabaseRemoved === true
    && reference.existingDatabaseWrites === 0, 'reference')
  check(hash(reference.checks) === hash(riskStructureReferenceChecks), 'reference_checks')
  check(Array.isArray(reference.definitions) && reference.definitions.length === plan.additions.length, 'definitions')
  const states = new Map()
  for (const [index, step] of plan.additions.entries()) {
    const row = reference.definitions[index]
    check(row.stepId === step.id && row.stepChecksum === step.checksum
      && row.beforeHash === (states.get(step.table) ?? null)
      && typeof row.canonicalDdl === 'string' && row.canonicalDdl.startsWith(`CREATE TABLE \`${step.table}\` (`)
      && row.afterHash === tableDefinitionHash(row.canonicalDdl) && row.beforeHash !== row.afterHash, 'definition')
    states.set(step.table, row.afterHash)
  }
  check(Array.isArray(priorSnapshot) && priorSnapshot.length > 0
    && new Set(priorSnapshot.map(row => row.name)).size === priorSnapshot.length
    && priorSnapshot.every(row => !states.has(row.name)), 'snapshot')
  const expectedNames = [...priorProof.priorSnapshot.map(row => row.name), 'trading_context_changes_v4'].sort()
  check(hash(priorSnapshot.map(row => row.name).sort()) === hash(expectedNames), 'prior_tables')
  check(restore.kind === 'risk-structure-restore/v1' && restore.passed === true
    && hash(restore.sourceIdentity) === hash(identity) && restore.registryHash === registryHash
    && restore.sourceSnapshotHash === hash(priorSnapshot)
    && restore.sourceWrites === 0 && restore.stepsCompleted === plan.steps.length, 'restore')
  // Retain both raw DDL fingerprints. Recompute equivalence from metadata and
  // row hashes, rather than trusting a boolean or equating normalized hashes.
  const evidence = restore.snapshotEvidence
  check(evidence && Array.isArray(evidence.source) && Array.isArray(evidence.restored), 'restore_evidence')
  verifyRiskRestoredSnapshot(evidence.source, evidence.restored)
  check(hash(legacyCandlePromotionSnapshot(evidence.source)) === restore.sourceSnapshotHash
    && hash(legacyCandlePromotionSnapshot(evidence.restored)) === restore.restoredSnapshotHash, 'restore_snapshot')
  check(Array.isArray(tools) && tools.length > 0 && hash(reference.tools) === hash(tools)
    && hash(restore.tools) === hash(tools), 'tools')
  if (restore.executionTools) verifyRiskToolTransition(restore.executionTools, tools, restore.toolTransition)
  const body = { kind: 'risk-structure-proof/v1', identity, registryHash, priorProofHash: hash(priorProof),
    priorSnapshot, definitions: reference.definitions, referenceHash: hash(reference), restoreHash: hash(restore), tools }
  return { ...body, proofHash: hash(body) }
}
