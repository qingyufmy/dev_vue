import { readFile } from 'node:fs/promises'
import { canonical, hash, requireBackfill as check, streamIdentity } from './v4-backfill-contract.mjs'
import { sha256 } from './v4-migration-plan.mjs'
import { prepareNullExpiryMembershipBackfill } from './v4-null-membership-backfill.mjs'
import { MysqlMembershipBackfillRepository, readMembershipTargetIdentity } from './mysql-membership-backfill.mjs'
import { prepareBackfillRun, executeBackfillBatch, recoverBackfillBatch } from './v4-membership-backfill-runner.mjs'
import { auditMembershipImport, membershipAuditFields } from './v4-membership-audit.mjs'
import { loadMembershipCoordinator } from './inplace-membership-schema.mjs'
import { validateColumnEvidence, readOriginalRows } from './inplace-column-evidence.mjs'
import { verifyOriginalSchemaWithUserDefaults } from './inplace-user-defaults.mjs'
import { withInplaceUpgradeLock } from './mysql-inplace-column-store.mjs'

export const nullMembershipReviewSha256 = 'd787e0dfb878873225589be5235be12cb6beb02703f1e8340c41807ba6260830'
const root = new URL('../../', import.meta.url)
const json = async path => JSON.parse(await readFile(new URL(path, root), 'utf8'))
const decode = value => typeof value === 'string' ? JSON.parse(value) : value
const projection = membershipAuditFields.map(field => ['user_id', 'revision'].includes(field) ? `CAST(${field} AS CHAR) ${field}` : field).join(',')

export async function executeNullMembershipWave(connection, pool, { database, run, manifestHash, apply = false, beforeBatch = () => {} }) {
  check(['dev_vue', 'dev_vue_m1_source_20260907_02'].includes(database), 'null_membership_database')
  const backup = await json('docs/migration/dev-vue-inplace-backup-20260906.json')
  const columns = await json('docs/migration/dev-vue-inplace-column-rehearsal-20260906.json')
  validateColumnEvidence(backup, columns)
  const reviewBytes = await readFile(new URL('docs/migration/dev-vue-null-membership-review-20260907.json', root))
  check(sha256(reviewBytes) === nullMembershipReviewSha256, 'null_membership_review_changed')
  const plan = await loadMembershipCoordinator(root)
  await connection.query("SET SESSION time_zone='+00:00'")
  return withInplaceUpgradeLock(connection, database, async () => {
    const identity = await readMembershipTargetIdentity(connection)
    check(identity.database === database && identity.serverUuid === backup.serverUuid, 'null_membership_identity')
    const excluded = [...new Set(plan.steps.filter(step => !step.column).map(step => step.table))]
    const verifyOriginal = async () => {
      await verifyOriginalSchemaWithUserDefaults(connection, backup.schemaSha256, excluded)
      check(canonical(await readOriginalRows(connection, columns.originalColumns)) === canonical(columns.parity), 'null_membership_original_changed')
    }
    await verifyOriginal()
    const protectedTables = []
    for (const [table, primary] of Object.entries({ user_referral_accounts: ['user_id'], referral_credit_ledger: ['user_id', 'account_revision'],
      payment_orders: ['id'], payment_transactions: ['id'], payment_matches: ['id'] })) {
      const [names] = await connection.execute('SELECT COLUMN_NAME name FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=? ORDER BY ORDINAL_POSITION', [table])
      protectedTables.push({ name: table, primary, columns: names.map(row => row.name) })
    }
    const protectedBefore = await readOriginalRows(connection, protectedTables)
    const [users] = await connection.query('SELECT CAST(id AS CHAR) id,role,plan,plan_period,plan_source,plan_expires_at,updated_at FROM users ORDER BY users.id')
    const prepared = prepareNullExpiryMembershipBackfill(users.map(row => ({ ...row })), run, reviewBytes)
    const { recipe, options, selected } = prepared
    check(selected.length === 21 && prepared.deferredSourceIds.length === 4, 'null_membership_wave_size')
    const spec = { runId: run.id, admission: { approved: true, blockers: [] }, bindings: {
      logicalSourceId: 'dev-vue-null-memberships-20260907', sourceDatabase: database, targetDatabase: database,
      mirrorDatabase: 'dev_vue_m1_source_20260906_01', targetServerUuid: identity.serverUuid, schemaHash: identity.schemaHash,
      snapshotHash: recipe.sourceHash, manifestHash, transformHash: recipe.transformHash, storageMode: 'inplace-membership-v1', streams: [recipe.stream] } }
    if (!apply) return { status: 'planned', identity, run, selectedRows: selected.length, deferredRows: prepared.deferredSourceIds.length,
      batchSizes: recipe.batches.map(batch => batch.rows.length), reviewSha256: prepared.reviewSha256, sourceHash: recipe.sourceHash }
    const readOtherMemberships = async () => { const [rows] = await connection.execute(`SELECT ${projection} FROM memberships WHERE migration_run_id IS NULL OR migration_run_id<>? ORDER BY user_id`, [run.id]); return hash(rows.map(row => ({ ...row }))) }
    const otherMembershipHash = await readOtherMemberships()
    const repository = new MysqlMembershipBackfillRepository(pool, recipe.sourceEvidence)
    await prepareBackfillRun(repository, spec)
    const recovered = []
    for (const [index, batch] of recipe.batches.entries()) {
      await beforeBatch(index)
      try { await executeBackfillBatch(repository, spec, batch, recipe.writer) }
      catch (error) {
        if (error.code !== 'backfill_commit_unknown') throw error
        const result = await recoverBackfillBatch(repository, spec, batch)
        check(result.status === 'committed', 'null_membership_commit_unresolved')
        recovered.push(batch.batchId)
      }
    }
    for (const batch of recipe.batches) await executeBackfillBatch(repository, spec, batch, recipe.writer)
    const stream = streamIdentity(recipe.stream)
    const [actual] = await connection.execute(`SELECT ${projection} FROM memberships WHERE migration_run_id=? ORDER BY user_id`, [run.id])
    const [saved] = await connection.execute('SELECT run_id,source_pk_sha256,source_bytes_sha256,source_payload_json FROM data_migration_source_rows WHERE run_id=? AND stream_id=?', [run.id, stream])
    const archives = saved.map(row => { const payload = decode(row.source_payload_json); return { runId: row.run_id, sourceId: payload.source.id,
      sourcePkHash: row.source_pk_sha256, sourceHash: row.source_bytes_sha256, payload } })
    const audit = auditMembershipImport(selected, actual.map(row => ({ ...row })), archives, options)
    check(audit.importMatchesReviewedInputs, 'null_membership_audit_failed')
    const [maps] = await connection.execute('SELECT logical_source_id,entity_kind,source_table,source_pk_sha256,source_pk_json,target_json FROM data_migration_id_maps WHERE created_run_id=?', [run.id])
    const [receipts] = await connection.execute('SELECT source_pk_sha256,batch_id,source_bytes_sha256,transformed_sha256,targets_json FROM data_migration_row_receipts WHERE run_id=? AND stream_id=?', [run.id, stream])
    check(maps.length === selected.length && receipts.length === selected.length, 'null_membership_receipt_count')
    for (const batch of recipe.batches) for (const row of batch.rows) {
      const map = maps.find(item => item.source_pk_sha256 === hash(row.pk)), receipt = receipts.find(item => item.source_pk_sha256 === hash(row.pk))
      check(map?.logical_source_id === spec.bindings.logicalSourceId && map.entity_kind === 'membership' && map.source_table === 'users'
        && canonical(decode(map.source_pk_json)) === canonical(row.pk) && canonical(decode(map.target_json)) === canonical(row.targets[0]), 'null_membership_map_mismatch')
      check(receipt?.batch_id === batch.batchId && receipt.source_bytes_sha256 === row.sourceHash && receipt.transformed_sha256 === row.transformedHash
        && canonical(decode(receipt.targets_json)) === canonical(row.targets), 'null_membership_receipt_mismatch')
    }
    const [[checkpoint]] = await connection.execute('SELECT sequence_number,processed_rows,cursor_json FROM data_migration_checkpoints WHERE run_id=? AND stream_id=?', [run.id, stream])
    check(Number(checkpoint.sequence_number) === recipe.batches.length && String(checkpoint.processed_rows) === String(selected.length)
      && canonical(decode(checkpoint.cursor_json)) === canonical(recipe.batches.at(-1).endCursor), 'null_membership_checkpoint')
    await verifyOriginal()
    check(canonical(await readOriginalRows(connection, protectedTables)) === canonical(protectedBefore)
      && await readOtherMemberships() === otherMembershipHash, 'null_membership_other_data_changed')
    return { kind: 'null-membership-wave/v1', status: 'verified', identity, run, reviewSha256: prepared.reviewSha256,
      selectedRows: selected.length, deferredRows: prepared.deferredSourceIds.length, batchSizes: recipe.batches.map(batch => batch.rows.length),
      sourceHash: recipe.sourceHash, transformHash: recipe.transformHash, audit, recovered, repeatNoop: true,
      mapsAndReceiptsVerified: true, checkpoint, originalRows: backup.parity.rows, protectedRows: protectedBefore,
      originalParityHash: sha256(JSON.stringify(columns.parity)), otherMembershipHash,
      consumersSwitched: false, fullMembershipConverted: false }
  })
}
