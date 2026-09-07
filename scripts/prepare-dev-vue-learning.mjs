import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import mysql from 'mysql2/promise'
import { loadSettingsMigrationEnvironment as loadEnvironment, settingsMigrationConnectionOptions as connectionOptions } from './lib/settings-migration-environment.mjs'
import { exactKeys, requireBackfill as check } from './lib/v4-backfill-contract.mjs'
import { buildLearningManifestPair } from './lib/v4-learning-manifest-pair.mjs'
import { persistLearningManifest } from './lib/v4-learning-manifest.mjs'
import { readLearningCourseTargetIdentity } from './lib/mysql-learning-course-backfill.mjs'
import { readLearningProgressTargetIdentity } from './lib/mysql-learning-progress-backfill.mjs'
import { readLearningCourseAudit } from './lib/mysql-learning-course-audit-reader.mjs'
import { readLearningProgressAudit } from './lib/mysql-learning-progress-audit-reader.mjs'
import { withInplaceUpgradeLock } from './lib/mysql-inplace-column-store.mjs'

const root = new URL('../', import.meta.url)
const json = async path => JSON.parse(await readFile(path, 'utf8'))
let pool, connection
try {
  const [flag, reviewPath, evidencePath, coursePath, progressPath] = process.argv.slice(2)
  if (flag === '--help' && process.argv.length === 3) {
    console.log('node scripts/prepare-dev-vue-learning.mjs --write <reviewed-basis.json> <reviewed-evidence.json> <course-manifest.json> <progress-manifest.json>')
  } else {
    check(process.argv.length === 7 && flag === '--write', 'learning_prepare_arguments')
    const paths = [reviewPath, evidencePath, coursePath, progressPath].map(path => resolve(path))
    const comparablePaths = process.platform === 'win32' ? paths.map(path => path.toLowerCase()) : paths
    check(new Set(comparablePaths).size === 4, 'learning_prepare_paths')
    const review = await json(paths[0]), evidence = await json(paths[1])
    exactKeys(review, ['version', 'logicalSourceId', 'mirrorDatabase', 'admission', 'courses', 'progress', 'courseBatchSize', 'progressBatchSize'])
    check(review.version === 'learning-reviewed-basis/v1', 'learning_prepare_review_version')
    exactKeys(review.courses, ['run', 'basis']); exactKeys(review.progress, ['run', 'basis', 'lessonMappings'])
    check(Array.isArray(evidence) && evidence.length > 0 && evidence.every(row => Array.isArray(row) && row.length === 2), 'learning_prepare_evidence')
    const evidenceCatalog = new Map(evidence)
    check(evidenceCatalog.size === evidence.length, 'learning_prepare_evidence_duplicate')
    const env = await loadEnvironment(root), backup = await json(new URL('docs/migration/dev-vue-inplace-backup-20260906.json', root))
    pool = mysql.createPool({ ...connectionOptions(env), connectionLimit: 1 })
    connection = await pool.getConnection()
    await connection.query("SET SESSION time_zone='+00:00'")
    await connection.query('SET SESSION TRANSACTION ISOLATION LEVEL REPEATABLE READ')
    const manifests = await withInplaceUpgradeLock(connection, env.MYSQL_DATABASE, async () => {
      await connection.query('START TRANSACTION READ ONLY')
      try {
        const targetIdentities = { courses: await readLearningCourseTargetIdentity(connection), progress: await readLearningProgressTargetIdentity(connection) }
        check(Object.values(targetIdentities).every(identity => identity.serverUuid === backup.serverUuid && identity.database === env.MYSQL_DATABASE), 'learning_prepare_identity')
        const courses = await readLearningCourseAudit(connection, review.courses.run.id)
        const progress = await readLearningProgressAudit(connection, review.progress.run.id)
        return buildLearningManifestPair({ ...review, sources: { courses: courses.sources, progress: progress.sources }, targetIdentities,
          options: { courses: { ...review.courses, evidenceCatalog }, progress: { ...review.progress, evidenceCatalog, userIds: progress.userIds } } })
      } finally { await connection.rollback() }
    })
    // Both domains are validated before either file is created. A second-file
    // failure leaves the first intact; rerunning requires the identical content.
    await persistLearningManifest(paths[2], manifests.courses)
    await persistLearningManifest(paths[3], manifests.progress)
    console.log(JSON.stringify({ status: 'prepared', databaseWrites: 0, courseManifestHash: manifests.courses.spec.bindings.manifestHash,
      progressManifestHash: manifests.progress.spec.bindings.manifestHash }))
  }
} catch (error) {
  console.error(JSON.stringify({ code: /^(learning|backfill|inplace|settings_environment)_[a-z_]+$/.test(error.message) ? error.message : 'learning_prepare_failed' }))
  process.exitCode = 1
} finally { connection?.release(); await pool?.end() }
