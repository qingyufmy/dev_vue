import { canonical, hash, streamIdentity, requireBackfill as check } from './v4-backfill-contract.mjs'
import { prepareReferralOpenings } from './v4-referral-opening.mjs'
import { createReferralBackfill } from './v4-referral-backfill-writer.mjs'
import { auditReferralLedger } from './v4-referral-ledger-audit.mjs'
import { referralSourceEvidence } from './mysql-referral-backfill.mjs'
import { loadReferralLedgerCoordinator } from './inplace-referral-ledger-schema.mjs'
import { coordinateInplaceSchema } from './inplace-schema-coordinator.mjs'

const root = new URL('../../', import.meta.url)
const columns = ['user_id', 'account_revision', 'event_kind', 'source_key', 'previous_balance', 'delta', 'resulting_balance', 'migration_run_id', 'source_sha256', 'recorded_at_utc']
const projection = "CAST(user_id AS CHAR) user_id,CAST(account_revision AS CHAR) account_revision,event_kind,source_key,previous_balance,delta,resulting_balance,migration_run_id,source_sha256,DATE_FORMAT(recorded_at_utc,'%Y-%m-%d %H:%i:%s.%f') recorded_at_utc"
const decode = value => typeof value === 'string' ? JSON.parse(value) : value

// Caller owns a transaction and the upgrade lock. An exact existing opening is the receipt.
export async function persistOpeningRows(connection, prepared, { verifyOnly = false } = {}) {
  const expected = new Map(prepared.entries.map(row => [row.user_id, row]))
  check(expected.size === prepared.entries.length, 'referral_opening_duplicate_input')
  const [existing] = await connection.query(`SELECT ${projection} FROM referral_credit_ledger ORDER BY user_id,account_revision FOR UPDATE`)
  const observed = new Set()
  for (const value of existing) {
    const row = { ...value }
    check(typeof row.recorded_at_utc === 'string' && /\.\d{3}000$/.test(row.recorded_at_utc), 'referral_opening_time_precision')
    row.recorded_at_utc = row.recorded_at_utc.slice(0, -3)
    check(!observed.has(row.user_id) && expected.has(row.user_id) && canonical(row) === canonical(expected.get(row.user_id)), 'referral_opening_ledger_conflict')
    observed.add(row.user_id)
  }
  let inserted = 0
  check(!verifyOnly || observed.size === expected.size, 'referral_opening_not_committed')
  for (const row of prepared.entries) {
    if (observed.has(row.user_id)) continue
    await connection.execute(`INSERT INTO referral_credit_ledger (${columns.join(',')}) VALUES (${columns.map(() => '?').join(',')})`, columns.map(column => row[column]))
    inserted++
  }
  return { inserted, existing: observed.size, rows: expected.size }
}

export async function writeReferralOpenings(connection, run, { verifyOnly = false } = {}) {
  check(run.spec.bindings.manifestHash === hash(run.bindingManifest), 'referral_opening_manifest_changed')
  const [[identity]] = await connection.query('SELECT DATABASE() db,@@server_uuid uuid')
  check(identity.db === run.spec.bindings.targetDatabase && identity.uuid === run.spec.bindings.targetServerUuid, 'referral_opening_identity')
  const plan = await loadReferralLedgerCoordinator(root)
  check((await coordinateInplaceSchema(plan.store(connection), plan)).structureComplete, 'referral_opening_schema')
  const [runs] = await connection.execute('SELECT bindings_sha256 FROM data_migration_runs WHERE id=? FOR UPDATE', [run.spec.runId])
  check(runs.length === 1 && runs[0].bindings_sha256 === hash(run.spec.bindings), 'referral_opening_run_mismatch')
  const [sourceRows] = await connection.query('SELECT CAST(id AS CHAR) id,referral_code,referred_by,referral_credit,created_at,updated_at FROM users ORDER BY users.id FOR UPDATE')
  const [targetRows] = await connection.query('SELECT CAST(user_id AS CHAR) user_id,referral_code,referred_by_code,referral_credit,CAST(revision AS CHAR) revision,updated_at_utc FROM user_referral_accounts ORDER BY user_id FOR UPDATE')
  const sources = sourceRows.map(row => ({ ...row })), targets = targetRows.map(row => ({ ...row }))
  const prepared = prepareReferralOpenings(sources, targets, run)
  const prior = createReferralBackfill(sources, run.registeredAtUtc, { batchSize: run.bindingManifest.batchSize })
  const migrationAudit = await auditReferralLedger(connection, run.spec, prior), stream = streamIdentity(prior.stream)
  const [evidence] = await connection.execute('SELECT source_pk_sha256,source_bytes_sha256,source_payload_json FROM data_migration_source_rows WHERE run_id=? AND stream_id=?', [run.spec.runId, stream])
  check(evidence.length === sources.length, 'referral_opening_evidence_count')
  for (const row of prior.batches.flatMap(batch => batch.rows)) {
    const saved = evidence.find(value => value.source_pk_sha256 === hash(row.pk))
    check(saved?.source_bytes_sha256 === row.sourceHash && canonical(decode(saved.source_payload_json)) === canonical(referralSourceEvidence(stream, row)), 'referral_opening_evidence_changed')
  }
  const result = await persistOpeningRows(connection, prepared, { verifyOnly })
  const repeated = await persistOpeningRows(connection, prepared)
  check(repeated.inserted === 0 && repeated.existing === sources.length, 'referral_opening_readback')
  return { ...result, migrationAudit, openingsHash: hash(prepared.entries), sourceHash: prepared.sourceHash, balanceUpdates: 0 }
}
