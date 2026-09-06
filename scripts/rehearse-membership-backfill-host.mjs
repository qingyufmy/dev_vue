import { readFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import { BackfillError, canonical, hash, streamIdentity } from './lib/v4-backfill-contract.mjs'
import { createMembershipBackfill } from './lib/v4-membership-backfill.mjs'
import { MysqlMembershipBackfillRepository, readMembershipTargetIdentity } from './lib/mysql-membership-backfill.mjs'
import { prepareBackfillRun, executeBackfillBatch, recoverBackfillBatch } from './lib/v4-membership-backfill-runner.mjs'
import { createMembershipWriter } from './lib/mysql-membership-writer.mjs'
import { readOriginalRows, validateColumnEvidence } from './lib/inplace-column-evidence.mjs'
import { verifyOriginalSchemaWithUserDefaults } from './lib/inplace-user-defaults.mjs'
import { loadMembershipCoordinator } from './lib/inplace-membership-schema.mjs'
import { withInplaceUpgradeLock } from './lib/mysql-inplace-column-store.mjs'
import { sha256 } from './lib/v4-migration-plan.mjs'
import { writePrivateJson } from './lib/v4-backup-io.mjs'

const root = new URL('../', import.meta.url), base = '/www/backup/aurum-v4/m1/20260906-01'
const database = 'dev_vue_m1_source_20260907_02', runId = 'ffffffff-ffff-4fff-8fff-ffffffffff02'
const json = async file => JSON.parse(await readFile(file, 'utf8'))
const check = (ok, code) => { if (!ok) throw new Error(code) }
let c, pool
try {
  check(process.platform === 'linux' && process.getuid() === 0, 'payment_backfill_probe_scope')
  const manifest = await json(new URL('../tools.json', root))
  for (const file of manifest) {
    check(/^[a-zA-Z0-9_./-]+$/.test(file.path) && !file.path.split('/').includes('..'), 'payment_backfill_probe_path')
    check(sha256(await readFile(new URL(file.path, root))) === file.sha256, 'payment_backfill_probe_tools')
  }
  const backup = await json(`${base}/artifacts/receipt.json`), columns = await json(`${base}/column-rehearsal/receipt.json`)
  validateColumnEvidence(backup, columns)
  const credentials = await json(`/proc/self/fd/${process.env.V4_BACKUP_CREDENTIAL_FD}`)
  const { default: mysql } = await import(pathToFileURL(process.env.V4_BACKUP_MYSQL2_MODULE).href)
  pool = mysql.createPool({ ...credentials, database, dateStrings: true, jsonStrings: true, timezone: 'Z', supportBigNumbers: true, bigNumberStrings: true, connectionLimit: 3 })
  c = await pool.getConnection()
  await c.query("SET SESSION time_zone='+00:00'")
  const identity = await readMembershipTargetIdentity(c)
  check(identity.database === database && identity.serverUuid === backup.serverUuid, 'payment_backfill_probe_identity')
  const plan = await loadMembershipCoordinator(root)
  const excluded = [...new Set(plan.steps.filter(step => !step.column).map(step => step.table))]
  const verifyOriginal = async () => {
    await verifyOriginalSchemaWithUserDefaults(c, backup.schemaSha256, excluded)
    check(canonical(await readOriginalRows(c, columns.originalColumns)) === canonical(columns.parity), 'payment_backfill_probe_original_changed')
  }
  const report = await withInplaceUpgradeLock(c, database, async () => {
    await verifyOriginal()
    const [selected] = await c.query("SELECT CAST(id AS CHAR) id,role,plan,plan_period,plan_source,plan_expires_at,updated_at FROM users WHERE id>0 AND plan='free' AND plan_expires_at IS NULL ORDER BY users.id LIMIT 2")
    check(selected.length === 2, 'payment_backfill_probe_source_scope')
    const sources = selected.map(row => ({ ...row })), ids = sources.map(row => row.id)
    const [[occupied]] = await c.execute('SELECT COUNT(*) n FROM memberships WHERE user_id IN (?,?)', ids)
    check(Number(occupied.n) === 0, 'payment_backfill_probe_fixture_exists')
    const options = { run: { id: runId, sourceSnapshotId: 'membership-rehearsal-only', registeredAtUtc: '2026-09-07T00:00:00.000Z' },
      evidenceCatalog: new Map([['synthetic-policy-only', 'b'.repeat(64)]]),
      basis: { version: 'membership-current-state/v1', sourceHash: hash(sources), sourceSnapshotId: 'membership-rehearsal-only',
        resolutions: sources.map(source => ({ sourceId: source.id, sourceHash: hash(source), rawExpiry: null,
          expirationKind: 'no_expiry', offsetMinutes: null, evidenceId: 'synthetic-policy-only', evidenceSha256: 'b'.repeat(64) })) } }
    const recipe = createMembershipBackfill(sources, options, { batchSize: 1 })
    const spec = { runId, admission: { approved: true, blockers: [] }, bindings: { logicalSourceId: 'membership-rehearsal-only', sourceDatabase: database,
      mirrorDatabase: 'dev_vue_m1_source_20260906_01', targetDatabase: database, targetServerUuid: identity.serverUuid, schemaHash: identity.schemaHash,
      snapshotHash: recipe.sourceHash, manifestHash: hash(manifest), transformHash: recipe.transformHash, storageMode: 'inplace-membership-v1', streams: [recipe.stream] } }
    let loseCommit = false, failEvidence = false
    const wrapped = new WeakSet()
    const repository = new MysqlMembershipBackfillRepository({ async getConnection() {
      const conn = await pool.getConnection()
      if (!wrapped.has(conn)) {
        wrapped.add(conn); const commit = conn.commit.bind(conn)
        conn.commit = async () => { await commit(); if (loseCommit) { loseCommit = false; conn.destroy(); throw new Error('synthetic_commit_response_lost') } }
      }
      return conn
    } }, (stream, row) => {
      if (failEvidence) { failEvidence = false; throw new BackfillError('backfill_fixture_evidence_failed') }
      return recipe.sourceEvidence(stream, row)
    })
    const counts = async () => {
      const [[row]] = await c.execute('SELECT (SELECT COUNT(*) FROM memberships WHERE migration_run_id=?) targets,(SELECT COUNT(*) FROM data_migration_id_maps WHERE created_run_id=?) maps,(SELECT COUNT(*) FROM data_migration_row_receipts WHERE run_id=?) receipts,(SELECT COUNT(*) FROM data_migration_source_rows WHERE run_id=?) sources,(SELECT COUNT(*) FROM data_migration_batches WHERE run_id=?) batches,(SELECT COUNT(*) FROM data_migration_checkpoints WHERE run_id=?) checkpoints,(SELECT COUNT(*) FROM data_migration_runs WHERE id=?) runs', Array(7).fill(runId))
      return row
    }
    check(Object.values(await counts()).every(n => Number(n) === 0), 'payment_backfill_probe_run_exists')
    await prepareBackfillRun(repository, spec)
    loseCommit = true
    let unknown = null
    try { await executeBackfillBatch(repository, spec, recipe.batches[0], recipe.writer) } catch (error) { unknown = error.code }
    check(unknown === 'backfill_commit_unknown' && !loseCommit, 'payment_backfill_probe_commit_fault')
    const recovery = await recoverBackfillBatch(repository, spec, recipe.batches[0])
    check(recovery.status === 'committed', 'payment_backfill_probe_recovery')
    const rowVerifier = createMembershipWriter(sources, options)
    await c.beginTransaction()
    await rowVerifier.write(c, rowVerifier.prepared.entries[0], { verifyOnly: true })
    await c.rollback()
    const beforeFailure = await counts()
    failEvidence = true
    let failed = null
    try { await executeBackfillBatch(repository, spec, recipe.batches[1], recipe.writer) } catch (error) { failed = error.code }
    check(failed === 'backfill_fixture_evidence_failed' && canonical(await counts()) === canonical(beforeFailure), 'payment_backfill_probe_atomic_rollback')
    await executeBackfillBatch(repository, spec, recipe.batches[1], recipe.writer)
    const committedCounts = await counts()
    check(['targets', 'maps', 'receipts', 'sources', 'batches'].every(key => Number(committedCounts[key]) === 2), 'payment_backfill_probe_components')
    for (const batch of recipe.batches) await executeBackfillBatch(repository, spec, batch, recipe.writer)
    check(canonical(await counts()) === canonical(committedCounts), 'payment_backfill_probe_repeat')
    const streamId = streamIdentity(recipe.stream)
    const [[checkpoint]] = await c.execute('SELECT sequence_number,processed_rows,cursor_json FROM data_migration_checkpoints WHERE run_id=? AND stream_id=?', [runId, streamId])
    const decode = value => typeof value === 'string' ? JSON.parse(value) : value
    check(Number(checkpoint.sequence_number) === 2 && String(checkpoint.processed_rows) === '2'
      && canonical(decode(checkpoint.cursor_json)) === canonical(recipe.batches[1].endCursor), 'payment_backfill_probe_checkpoint')
    const [maps] = await c.execute('SELECT logical_source_id,entity_kind,source_table,source_pk_sha256,source_pk_json,target_json FROM data_migration_id_maps WHERE created_run_id=?', [runId])
    const [receipts] = await c.execute('SELECT source_pk_sha256,batch_id,source_bytes_sha256,transformed_sha256,targets_json FROM data_migration_row_receipts WHERE run_id=? AND stream_id=?', [runId, streamId])
    for (const batch of recipe.batches) {
      const row = batch.rows[0], mapping = maps.find(m => m.source_pk_sha256 === hash(row.pk)), receipt = receipts.find(r => r.source_pk_sha256 === hash(row.pk))
      check(mapping?.logical_source_id === spec.bindings.logicalSourceId && mapping.entity_kind === 'membership' && mapping.source_table === 'users'
        && canonical(decode(mapping.source_pk_json)) === canonical(row.pk) && canonical(decode(mapping.target_json)) === canonical(row.targets[0]), 'payment_backfill_probe_mapping')
      check(receipt?.batch_id === batch.batchId && receipt.source_bytes_sha256 === row.sourceHash && receipt.transformed_sha256 === row.transformedHash
        && canonical(decode(receipt.targets_json)) === canonical(row.targets), 'payment_backfill_probe_receipt')
    }
    const [evidence] = await c.execute('SELECT source_pk_sha256,source_bytes_sha256,source_payload_json FROM data_migration_source_rows WHERE run_id=? AND stream_id=?', [runId, streamId])
    for (const batch of recipe.batches) {
      const row = batch.rows[0], saved = evidence.find(e => e.source_pk_sha256 === hash(row.pk))
      const payload = typeof saved?.source_payload_json === 'string' ? JSON.parse(saved.source_payload_json) : saved?.source_payload_json
      check(saved?.source_bytes_sha256 === row.sourceHash && canonical(payload) === canonical(recipe.sourceEvidence(streamId, row)), 'payment_backfill_probe_evidence')
    }
    const [actual] = await c.execute('SELECT CAST(user_id AS CHAR) user_id,plan_code,billing_period_code,source_code,expiration_kind,expires_at_utc FROM memberships WHERE migration_run_id=? ORDER BY memberships.user_id', [runId])
    check(actual.length === sources.length && actual.every((row, i) => row.user_id === sources[i].id && row.plan_code === sources[i].plan
      && row.billing_period_code === sources[i].plan_period && row.source_code === sources[i].plan_source
      && row.expiration_kind === 'no_expiry' && row.expires_at_utc === null), 'payment_backfill_probe_audit')
    for (const source of sources) {
      const saved = evidence.find(row => row.source_pk_sha256 === hash([{ type: 'integer', value: source.id }]))
      check(saved && canonical(decode(saved.source_payload_json).source) === canonical(source), 'payment_backfill_probe_source_archive')
    }
    await c.beginTransaction()
    for (const entry of rowVerifier.prepared.entries) await rowVerifier.write(c, entry, { verifyOnly: true })
    await c.rollback()
    const audit = { sourceRows: 2, targetRows: 2, sourceFactsMatch: true, originalSevenFieldsPreserved: true, historicalPolicyValidated: false }
    await c.beginTransaction()
    await c.execute('DELETE FROM memberships WHERE migration_run_id=? AND user_id IN (?,?)', [runId, ...ids])
    for (const table of ['data_migration_source_rows', 'data_migration_row_receipts', 'data_migration_batches', 'data_migration_checkpoints']) await c.execute(`DELETE FROM ${table} WHERE run_id=?`, [runId])
    await c.execute('DELETE FROM data_migration_id_maps WHERE created_run_id=? AND logical_source_id=?', [runId, spec.bindings.logicalSourceId])
    await c.execute('DELETE FROM data_migration_runs WHERE id=?', [runId])
    await c.commit()
    const finalCounts = await counts()
    check(Object.values(finalCounts).every(n => Number(n) === 0), 'payment_backfill_probe_cleanup')
    await verifyOriginal()
    return { kind: 'membership-backfill-probe/v1', identity, fixtureOnly: true, sourceRowsFromRestoredUsers: true, syntheticPolicyEvidence: true, toolManifest: manifest, commitUnknownObserved: true, recovery,
      sourceEvidenceFailureRolledBack: true, committedCounts, finalCounts, repeatNoop: true, checkpoint, mapsAndReceiptsVerified: true, audit,
      originalRows: backup.parity.rows, originalParityHash: sha256(JSON.stringify(columns.parity)), currentDevVueWritten: false, originalTablesWritten: false, realHistoricalTimeValidated: false }
  })
  await writePrivateJson(new URL('../receipt.json', root).pathname, report)
  console.log(JSON.stringify({ status: 'verified', commitUnknownObserved: true, recovered: 'committed', rows: 2, fixtureCleanup: true, originalRows: report.originalRows }))
} catch (error) {
  await c?.rollback().catch(() => {})
  console.error(JSON.stringify({ code: /^payment_backfill_probe_[a-z_]+$/.test(error.message) ? error.message : error.code ?? 'payment_backfill_probe_failed' })); process.exitCode = 1
} finally { c?.release(); await pool?.end() }
