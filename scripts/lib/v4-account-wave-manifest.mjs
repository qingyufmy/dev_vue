import { canonical, hash, requireBackfill as check } from './v4-backfill-contract.mjs'
import { validateColumnEvidence } from './inplace-column-evidence.mjs'

// This draft freezes verified facts but cannot authorize a writer or invent a time basis.
export function freezeAccountWave({ backup, columnProof, review, targetIdentity, originalRows, tools }) {
  validateColumnEvidence(backup, columnProof)
  check(targetIdentity.database === backup.source && targetIdentity.serverUuid === backup.serverUuid
    && targetIdentity.storageMode === 'inplace-account-v2' && canonical(review.targetIdentity) === canonical(targetIdentity), 'account_wave_target_mismatch')
  check(review.kind === 'dev_vue_account_ownership_review' && review.ownership.currentOwnershipConsistent === true
    && review.ownership.issues.length === 0 && review.businessWritesPerformed === false, 'account_wave_ownership_unresolved')
  check(canonical(originalRows) === canonical(columnProof.parity), 'account_wave_source_changed')
  check(Array.isArray(tools) && tools.length > 0 && tools.every(item => /^[a-zA-Z0-9_./-]+$/.test(item.path)
    && !item.path.split('/').includes('..') && /^[a-f0-9]{64}$/.test(item.sha256))
    && new Set(tools.map(item => item.path)).size === tools.length, 'account_wave_tools_invalid')
  const manifest = { kind: 'dev_vue_account_wave_draft', version: 1,
    sourceDatabase: backup.source, restoreDatabase: backup.target, targetIdentity,
    backupSnapshotId: backup.sourceSnapshotId, originalSchemaHash: backup.schemaSha256, originalRowsHash: hash(originalRows),
    sourceEvidenceHash: review.ownership.evidenceHash, accountSourceHash: review.sourceHash, accountMappingHash: review.mappingHash,
    counts: review.ownership.counts, ownershipNotes: review.ownership.notes,
    tools: [...tools].sort((a, b) => a.path.localeCompare(b.path)),
    timeBases: { trading_accounts: null, mt5_account_ownership_history: null },
    sourceProvenanceRequired: true,
    admission: { approved: false, blockers: ['historical_time_basis_required', 'historical_platform_currency_coverage',
      'permission_projection_reconciliation', 'real_business_rehearsal_required'] },
    scope: { sourceTables: ['trading_accounts', 'mt5_account_ownership_history'], sourceRows: review.counts.sourceRows + review.ownership.counts.historicalIntervals,
      writes: ['trading_accounts_v4_build', 'user_trading_account_settings_v4_build', 'trading_account_ownership_intervals_v4_build', 'trading_account_ownerships_v4_build'],
      activation: false, rename: false, deleteLegacy: false }, executable: false }
  return { ...manifest, manifestHash: hash(manifest) }
}
