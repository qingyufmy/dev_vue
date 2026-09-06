import { canonical, hash, requireBackfill as check } from './v4-backfill-contract.mjs'
import { convertReferralAccounts } from './v4-referral-conversion.mjs'

// Opening rows record the already migrated balance; they never add that amount again.
export function prepareReferralOpenings(sourceRows, targetRows, run) {
  check(run?.spec?.bindings?.storageMode === 'inplace-referral-v1'
    && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(run.spec.runId), 'referral_opening_run_invalid')
  const converted = convertReferralAccounts(sourceRows, run.registeredAtUtc)
  check(converted.sourceHash === run.bindingManifest?.sourceHash && converted.sourceCount === run.bindingManifest?.sourceUsers,
    'referral_opening_source_changed')
  check(Array.isArray(targetRows) && targetRows.length === converted.entries.length, 'referral_opening_target_count')
  const targets = new Map()
  for (const row of targetRows) {
    check(!targets.has(row.user_id), 'referral_opening_target_duplicate'); targets.set(row.user_id, row)
  }
  const entries = converted.entries.map(entry => {
    check(canonical(targets.get(entry.target.user_id)) === canonical(entry.target), 'referral_opening_target_changed')
    return { user_id: entry.target.user_id, account_revision: '1', event_kind: 'opening',
      source_key: hash({ kind: 'referral-opening/v1', runId: run.spec.runId, userId: entry.target.user_id }),
      previous_balance: null, delta: null, resulting_balance: entry.target.referral_credit,
      migration_run_id: run.spec.runId, source_sha256: entry.sourceHash,
      recorded_at_utc: entry.target.updated_at_utc }
  })
  return { version: 'referral-opening/v1', entries, sourceHash: converted.sourceHash,
    migrationRunId: run.spec.runId, balanceUpdatesRequired: false, historicalTransactionsReconstructed: false }
}
