import { readFile, open } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { pathToFileURL } from 'node:url'
import { canonical, hash, streamIdentity, requireBackfill as check } from './lib/v4-backfill-contract.mjs'
import { createReferralBackfill } from './lib/v4-referral-backfill-writer.mjs'
import { reconcileReferralAccounts } from './lib/v4-referral-conversion.mjs'
import { MysqlReferralBackfillRepository, readReferralTargetIdentity, referralSourceEvidence } from './lib/mysql-referral-backfill.mjs'
import { prepareBackfillRun, executeBackfillBatch, recoverBackfillBatch } from './lib/v4-referral-backfill-runner.mjs'
import { loadReferralSchemaCoordinator } from './lib/inplace-referral-schema.mjs'
import { verifyOriginalSchemaWithUserDefaults } from './lib/inplace-user-defaults.mjs'
import { readOriginalRows, validateColumnEvidence } from './lib/inplace-column-evidence.mjs'
import { sha256 } from './lib/v4-migration-plan.mjs'

const root = new URL('../', import.meta.url), database = 'dev_vue_m1_source_20260907_02'
const json = async file => JSON.parse(await readFile(file, 'utf8'))
const decode = value => typeof value === 'string' ? JSON.parse(value) : value
async function immutable(file, value) {
  const handle = await open(file, 'wx', 0o600)
  try { await handle.writeFile(JSON.stringify(value, null, 2) + '\n'); await handle.sync() } finally { await handle.close() }
}
let pool, control
try {
  check(process.platform === 'linux' && process.getuid() === 0 && process.argv.length === 2, 'referral_rehearsal_scope')
  const manifest = await json(new URL('../tools.json', root))
  for (const file of manifest) {
    check(/^[a-zA-Z0-9_./-]+$/.test(file.path) && !file.path.startsWith('/') && !file.path.split('/').includes('..'), 'referral_tool_path')
    check(sha256(await readFile(new URL(file.path, root))) === file.sha256, 'referral_tool_changed')
  }
  const backup = await json(new URL('docs/migration/dev-vue-inplace-backup-20260906.json', root))
  const columns = await json(new URL('docs/migration/dev-vue-inplace-column-rehearsal-20260906.json', root))
  const reviewed = await json(new URL('docs/migration/dev-vue-referral-source-review-20260907.json', root))
  validateColumnEvidence(backup, columns)
  const credential = await json(`/proc/self/fd/${process.env.V4_BACKUP_CREDENTIAL_FD}`)
  const { default: mysql } = await import(pathToFileURL(process.env.V4_BACKUP_MYSQL2_MODULE).href)
  pool = mysql.createPool({ ...credential, database, timezone: 'Z', dateStrings: true, jsonStrings: true,
    supportBigNumbers: true, bigNumberStrings: true, connectionLimit: 3, multipleStatements: false })
  control = await pool.getConnection()
  await control.query("SET SESSION time_zone='+00:00'")
  const identity = await readReferralTargetIdentity(control)
  check(identity.database === database && identity.serverUuid === backup.serverUuid, 'referral_rehearsal_identity')
  const [[lock]] = await control.execute('SELECT GET_LOCK(?,0) acquired', [`aurum:inplace:${database}`])
  check(Number(lock.acquired) === 1, 'referral_rehearsal_busy')
  const plan = await loadReferralSchemaCoordinator(root)
  const verifyOriginal = async () => {
    await verifyOriginalSchemaWithUserDefaults(control, backup.schemaSha256, [...new Set(plan.steps.filter(s => !s.column).map(s => s.table))])
    check(JSON.stringify(await readOriginalRows(control, columns.originalColumns)) === JSON.stringify(columns.parity), 'referral_source_changed')
  }
  await verifyOriginal()
  const readSource = async () => {
    const [rows] = await control.query('SELECT CAST(id AS CHAR) id,referral_code,referred_by,referral_credit,created_at,updated_at FROM users ORDER BY users.id')
    return rows.map(row => ({ ...row }))
  }
  const sources = await readSource()
  check(hash(sources) === reviewed.sourceProjectionHash, 'referral_source_review_changed')
  const runFile = new URL('../run.json', root)
  let saved
  try { saved = await json(runFile) } catch (error) { if (error.code !== 'ENOENT') throw error }
  const registeredAtUtc = saved?.registeredAtUtc ?? new Date().toISOString()
  const prepared = createReferralBackfill(sources, registeredAtUtc, { batchSize: 10 })
  const bindingManifest = { kind: 'referral-backfill-manifest/v1', sourceHash: prepared.sourceHash, registeredAtUtc,
    sourceUsers: sources.length, batchSize: 10, toolManifestHash: hash(manifest) }
  const spec = { runId: saved?.spec.runId ?? randomUUID(), admission: { approved: true, blockers: [] }, bindings: {
    logicalSourceId: `referral:${database}`, sourceDatabase: database, mirrorDatabase: 'dev_vue_m1_source_20260906_01',
    targetDatabase: database, targetServerUuid: identity.serverUuid, storageMode: identity.storageMode,
    snapshotHash: backup.rawSql.sha256, schemaHash: identity.schemaHash, manifestHash: hash(bindingManifest),
    transformHash: prepared.transformHash, streams: [prepared.stream] } }
  const run = { registeredAtUtc, bindingManifest, spec }
  if (saved) check(canonical(saved) === canonical(run), 'referral_run_changed')
  else {
    const [[count]] = await control.query('SELECT COUNT(*) n FROM user_referral_accounts')
    check(Number(count.n) === 0, 'referral_initial_target_nonempty')
    await immutable(runFile, run)
  }
  let inject = false, injected = false, businessInserts = 0, mutations = 0
  const wrappedPool = { async getConnection() {
    const connection = await pool.getConnection()
    return { query: (...args) => connection.query(...args), beginTransaction: () => connection.beginTransaction(),
      rollback: () => connection.rollback(), destroy: () => connection.destroy(), release: () => connection.release(),
      async execute(sql, values) {
        const result = await connection.execute(sql, values)
        if (/^(INSERT|UPDATE|DELETE)\b/.test(sql)) mutations++
        if (sql.startsWith('INSERT INTO user_referral_accounts')) businessInserts++
        return result
      }, async commit() {
        await connection.commit()
        if (inject) { inject = false; injected = true; connection.destroy(); throw new Error('injected_commit_response_loss') }
      } }
  } }
  const repository = new MysqlReferralBackfillRepository(wrappedPool)
  await prepareBackfillRun(repository, spec)
  inject = !saved
  const outcomes = []
  for (const batch of prepared.batches) {
    try { outcomes.push(await executeBackfillBatch(repository, spec, batch, prepared.writer)) }
    catch (error) {
      check(error.code === 'backfill_commit_unknown', 'referral_unexpected_failure')
      const recovered = await recoverBackfillBatch(repository, spec, batch)
      check(recovered.status === 'committed', 'referral_commit_unresolved')
      outcomes.push(recovered)
    }
  }
  const beforeRepeat = mutations
  for (const batch of prepared.batches) await executeBackfillBatch(repository, spec, batch, prepared.writer)
  check(mutations === beforeRepeat, 'referral_repeat_wrote')
  const [actualRows] = await control.query('SELECT CAST(user_id AS CHAR) user_id,referral_code,referred_by_code,referral_credit,CAST(revision AS CHAR) revision,updated_at_utc FROM user_referral_accounts ORDER BY user_id')
  const reconciliation = reconcileReferralAccounts(await readSource(), actualRows.map(row => ({ ...row })), registeredAtUtc)
  check(reconciliation.rowsMatch && reconciliation.totalMatches, 'referral_target_mismatch')
  const stream = streamIdentity(prepared.stream)
  const [receipts] = await control.execute('SELECT source_pk_sha256,source_bytes_sha256,transformed_sha256,targets_json FROM data_migration_row_receipts WHERE run_id=? AND stream_id=?', [spec.runId, stream])
  const [evidence] = await control.execute('SELECT source_pk_sha256,source_bytes_sha256,source_payload_json FROM data_migration_source_rows WHERE run_id=? AND stream_id=?', [spec.runId, stream])
  const expected = prepared.batches.flatMap(batch => batch.rows)
  check(receipts.length === expected.length && evidence.length === expected.length, 'referral_receipt_count')
  for (const row of expected) {
    const receipt = receipts.find(r => r.source_pk_sha256 === hash(row.pk)), savedSource = evidence.find(r => r.source_pk_sha256 === hash(row.pk))
    check(receipt?.source_bytes_sha256 === row.sourceHash && receipt.transformed_sha256 === row.transformedHash
      && canonical(decode(receipt.targets_json)) === canonical(row.targets), 'referral_receipt_mismatch')
    check(savedSource?.source_bytes_sha256 === row.sourceHash && canonical(decode(savedSource.source_payload_json)) === canonical(referralSourceEvidence(stream, row)), 'referral_evidence_mismatch')
  }
  await verifyOriginal()
  check(saved || (injected && businessInserts === sources.length), 'referral_injection_missing')
  const report = { kind: 'referral-backfill-rehearsal/v1', status: 'verified', identity, runId: spec.runId, registeredAtUtc,
    runManifestHash: hash(run), toolManifest: manifest, originalTables: columns.parity.length, originalRows: backup.parity.rows,
    originalParityHash: sha256(JSON.stringify(columns.parity)), sourceHash: prepared.sourceHash, reconciliation,
    businessInserts, commitResponseLossInjected: injected, outcomes, repeatMutations: mutations - beforeRepeat,
    receiptsVerified: receipts.length, sourceEvidenceVerified: evidence.length, sourceDatabaseWritten: false,
    fullNormalizationComplete: false }
  await immutable(new URL(saved ? '../repeat-receipt.json' : '../receipt.json', root), report)
  console.log(JSON.stringify({ status: report.status, businessInserts, receiptsVerified: receipts.length,
    commitResponseLossInjected: injected, repeatMutations: report.repeatMutations, originalRows: report.originalRows }))
} catch (error) {
  console.error(JSON.stringify({ code: /^(?:referral|backfill|inplace)_[a-z_]+$/.test(error.code ?? error.message) ? error.code ?? error.message : 'referral_rehearsal_failed' }))
  process.exitCode = 1
} finally { if (control) control.release(); if (pool) await pool.end() }
