import { canonical, hash } from './v4-backfill-contract.mjs'
import { readOriginalRows, validateColumnEvidence } from './inplace-column-evidence.mjs'
import { verifyOriginalSchemaWithReferralRules } from './inplace-referral-rule-schema.mjs'
import { loadLearningCoreCoordinator } from './inplace-learning-core-schema.mjs'
import { withInplaceUpgradeLock } from './mysql-inplace-column-store.mjs'
import { readLearningCourseTargetIdentity } from './mysql-learning-course-backfill.mjs'
import { readLearningProgressTargetIdentity } from './mysql-learning-progress-backfill.mjs'
import { readLearningCourseAudit } from './mysql-learning-course-audit-reader.mjs'
import { readLearningProgressAudit } from './mysql-learning-progress-audit-reader.mjs'
import { prepareLearningRehearsalInputs } from './learning-rehearsal-inputs.mjs'
import { learningRehearsalFaultPool } from './learning-rehearsal-fault-pool.mjs'
import { executeLearningManifests } from './v4-learning-manifest-executor.mjs'
import { readRestoredLearningSchema } from './learning-restored-schema.mjs'

const database = 'dev_vue_m1_source_20260907_02'
const runs = ['ffffffff-ffff-4fff-8fff-ffffffffff41', 'ffffffff-ffff-4fff-8fff-ffffffffff42']
const check = (condition, code) => { if (!condition) throw Error(code) }

export async function rehearseLearningBackfill({ pool, root, backup, columns, manifest, historicalDefinitions, onFixture = async () => {} }) {
  validateColumnEvidence(backup, columns)
  const connection = await pool.getConnection()
  try {
    await connection.query("SET SESSION time_zone='+00:00'")
    return await withInplaceUpgradeLock(connection, database, async () => {
      const identities = { courses: await readLearningCourseTargetIdentity(connection), progress: await readLearningProgressTargetIdentity(connection) }
      check(Object.values(identities).every(identity => identity.database === database && identity.serverUuid === backup.serverUuid), 'learning_rehearsal_identity')
      const plan = await loadLearningCoreCoordinator(root)
      const excluded = [...new Set(plan.steps.filter(step => !step.column).map(step => step.table))]
      let restoredSchema
      const verifyOriginal = async () => {
        if (historicalDefinitions) {
          const current = await readRestoredLearningSchema(connection, { backup, definitions: historicalDefinitions, reference: plan.referralRuleReference, excluded })
          check(!restoredSchema || current.currentHash === restoredSchema.currentHash, 'learning_rehearsal_original_schema_changed')
          restoredSchema ??= current
        } else await verifyOriginalSchemaWithReferralRules(connection, backup.schemaSha256, excluded, plan.referralRuleReference)
        check(canonical(await readOriginalRows(connection, columns.originalColumns)) === canonical(columns.parity), 'learning_rehearsal_original_changed')
      }
      await verifyOriginal()
      const protectedTables = []
      for (const name of excluded) {
        const [fields] = await connection.execute('SELECT COLUMN_NAME name FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=? ORDER BY ORDINAL_POSITION', [name])
        const [primary] = await connection.execute("SELECT COLUMN_NAME name FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=? AND INDEX_NAME='PRIMARY' ORDER BY SEQ_IN_INDEX", [name])
        protectedTables.push({ name, columns: fields.map(row => row.name), primary: primary.map(row => row.name) })
      }
      const protectedBefore = await readOriginalRows(connection, protectedTables)
      for (const table of ['learning_courses', 'learning_lessons', 'learning_media_references', 'learning_progress']) {
        const [[row]] = await connection.query(`SELECT COUNT(*) total FROM ${table}`)
        check(Number(row.total) === 0, 'learning_rehearsal_targets_not_empty')
      }
      const [[occupied]] = await connection.execute('SELECT COUNT(*) total FROM data_migration_runs WHERE id IN (?,?)', runs)
      check(Number(occupied.total) === 0, 'learning_rehearsal_runs_exist')
      const [[mapped]] = await connection.execute('SELECT COUNT(*) total FROM data_migration_id_maps WHERE logical_source_id=?', ['synthetic-learning-rehearsal-01'])
      check(Number(mapped.total) === 0, 'learning_rehearsal_maps_exist')
      const courses = await readLearningCourseAudit(connection, runs[0]), progress = await readLearningProgressAudit(connection, runs[1])
      check(courses.sources.length > 1 && progress.sources.length > 0, 'learning_rehearsal_sources_insufficient')
      const fixture = prepareLearningRehearsalInputs({ sources: { courses: courses.sources, progress: progress.sources }, targetIdentities: identities,
        userIds: progress.userIds, registeredAtUtc: '2026-09-07T00:00:00.000Z' })
      await onFixture(fixture)
      const args = { pool, courseManifest: fixture.manifests.courses, progressManifest: fixture.manifests.progress,
        sources: fixture.sources, userIds: progress.userIds, evidenceCatalog: fixture.evidenceCatalog }
      const faultPool = learningRehearsalFaultPool(pool)
      let observed = false
      try { await executeLearningManifests({ ...args, pool: faultPool, mode: 'apply' }) }
      catch (error) { check(error.code === 'backfill_commit_unknown', 'learning_rehearsal_wrong_fault'); observed = true }
      check(observed && faultPool.injected, 'learning_rehearsal_fault_missing')
      const partialBefore = await readOriginalRows(connection, protectedTables)
      const recovered = await executeLearningManifests({ ...args, mode: 'recover' })
      check(recovered.status === 'not_committed' && recovered.progress === null, 'learning_rehearsal_partial_recovery')
      check(canonical(await readOriginalRows(connection, protectedTables)) === canonical(partialBefore), 'learning_rehearsal_recovery_wrote')
      const applied = await executeLearningManifests({ ...args, mode: 'apply' })
      check(applied.status === 'verified' && applied.courses.audit.control.verified && applied.progress.audit.control.verified, 'learning_rehearsal_apply_failed')
      const committed = await readOriginalRows(connection, protectedTables)
      for (const mode of ['recover', 'verify', 'apply']) check((await executeLearningManifests({ ...args, mode })).status === 'verified', 'learning_rehearsal_repeat_failed')
      check(canonical(await readOriginalRows(connection, protectedTables)) === canonical(committed), 'learning_rehearsal_repeat_changed')
      await verifyOriginal()
      // Cleanup only after full successful verification. On earlier failure leave
      // the precise run evidence intact for diagnosis instead of deleting it.
      await cleanupLearningRehearsal(connection)
      await verifyOriginal()
      check(canonical(await readOriginalRows(connection, protectedTables)) === canonical(protectedBefore), 'learning_rehearsal_cleanup_changed')
      return { kind: 'learning-backfill-rehearsal/v1', identities, toolManifest: manifest, fixtureOnly: true, syntheticTimeEvidence: true,
        realHistoricalTimeValidated: false, commitUnknownObserved: true, partialRecoveryDidNotWrite: true, fullRecoveryVerified: true,
        repeatNoop: true, fixtureCleanupVerified: true, originalRows: backup.parity.rows, originalParityHash: hash(columns.parity),
        protectedRowsHash: hash(protectedBefore), courseAudit: applied.courses.audit, progressAudit: applied.progress.audit,
        currentDevVueWritten: false, originalTablesWritten: false, cliEndToEndVerified: false, restoredSchema }
    })
  } finally { connection.release() }
}

export async function cleanupLearningRehearsal(connection) {
  const [[identity]] = await connection.query('SELECT DATABASE() db,@@server_uuid uuid')
  check(identity.db === database && identity.uuid === 'ac423207-6ef3-11f1-b302-000c29fda104', 'learning_rehearsal_cleanup_scope')
  await connection.beginTransaction()
  try {
    for (const table of ['learning_progress', 'learning_media_references', 'learning_lessons', 'learning_courses']) {
      await connection.execute(`DELETE FROM ${table} WHERE migration_run_id IN (?,?)`, runs)
    }
    for (const table of ['data_migration_source_rows', 'data_migration_row_receipts', 'data_migration_batches', 'data_migration_checkpoints']) {
      await connection.execute(`DELETE FROM ${table} WHERE run_id IN (?,?)`, runs)
    }
    await connection.execute('DELETE FROM data_migration_id_maps WHERE created_run_id IN (?,?) AND logical_source_id=?', [...runs, 'synthetic-learning-rehearsal-01'])
    await connection.execute('DELETE FROM data_migration_runs WHERE id IN (?,?)', runs)
    await connection.commit()
  } catch (error) { await connection.rollback(); throw error }
}
