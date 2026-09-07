import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import mysql from 'mysql2/promise'
import { loadSettingsMigrationEnvironment, settingsMigrationConnectionOptions } from './lib/settings-migration-environment.mjs'
import { readLearningCourseAudit } from './lib/mysql-learning-course-audit-reader.mjs'
import { readLearningProgressAudit } from './lib/mysql-learning-progress-audit-reader.mjs'
import { decodeLearningManifest } from './lib/v4-learning-manifest.mjs'
import { createLearningCourseBackfill } from './lib/v4-learning-course-backfill.mjs'
import { createLearningProgressBackfill } from './lib/v4-learning-progress-backfill.mjs'
import { migrateLearningCore } from './lib/v4-learning-core-migration.mjs'
import { MysqlLearningCourseVerificationV2, MysqlLearningProgressVerificationV2, readLearningVerificationIdentityV2, learningVerificationPool } from './lib/mysql-learning-verification-v2.mjs'
import { withInplaceUpgradeLock } from './lib/mysql-inplace-column-store.mjs'

const root = new URL('../', import.meta.url)
let pool, connection
try {
  const [flag, coursePath, progressPath, evidencePath] = process.argv.slice(2)
  if (flag === '--help' && process.argv.length === 3) console.log('node scripts/verify-learning-import-v2-local.mjs --verify <course-manifest.json> <progress-manifest.json> <evidence.json>')
  else {
    if (flag !== '--verify' || process.argv.length !== 6) throw Error('learning_verify_arguments')
    const json = async path => JSON.parse(await readFile(resolve(path), 'utf8'))
    const courseManifest = await json(coursePath), progressManifest = await json(progressPath), entries = await json(evidencePath)
    const evidenceCatalog = new Map(entries)
    if (!Array.isArray(entries) || evidenceCatalog.size !== entries.length) throw Error('learning_verify_evidence')
    const env = await loadSettingsMigrationEnvironment(root)
    if (env.MYSQL_DATABASE !== 'dev_vue') throw Error('learning_verify_database')
    pool = mysql.createPool({ ...settingsMigrationConnectionOptions(env), connectionLimit: 3 })
    connection = await pool.getConnection()
    await connection.query("SET SESSION time_zone='+00:00'")
    const result = await withInplaceUpgradeLock(connection, 'dev_vue', async () => {
      await readLearningVerificationIdentityV2(connection, 'courses')
      await connection.query('SET SESSION TRANSACTION ISOLATION LEVEL REPEATABLE READ')
      await connection.query('START TRANSACTION READ ONLY')
      let sourceCourses, sourceProgress
      try {
        sourceCourses = await readLearningCourseAudit(connection, courseManifest.spec.runId)
        sourceProgress = await readLearningProgressAudit(connection, progressManifest.spec.runId)
      } finally { await connection.rollback() }
      const courses = decodeLearningManifest(courseManifest, { sources: sourceCourses.sources, evidenceCatalog })
      const progress = decodeLearningManifest(progressManifest, { sources: sourceProgress.sources, evidenceCatalog, userIds: sourceProgress.userIds })
      const parent = createLearningCourseBackfill(courses.sources, courses.options, { batchSize: courses.batchSize })
      const child = createLearningProgressBackfill(progress.sources, progress.options, { batchSize: progress.batchSize })
      const readOnlyPool = learningVerificationPool(pool)
      return migrateLearningCore({
        courses: { repository: new MysqlLearningCourseVerificationV2(readOnlyPool, parent.sourceEvidence), spec: courses.spec, sources: courses.sources, options: courses.options },
        progress: { repository: new MysqlLearningProgressVerificationV2(readOnlyPool, child.sourceEvidence), spec: progress.spec, sources: progress.sources, options: progress.options },
      }, { mode: 'verify', courseBatchSize: courses.batchSize, progressBatchSize: progress.batchSize })
    })
    if (result.status !== 'verified') throw Error('learning_verify_not_verified')
    console.log(JSON.stringify({ status: result.status, courses: result.courses.status, progress: result.progress.status, schemaSteps: 64, databaseWrites: 0 }))
  }
} catch (error) {
  console.error(JSON.stringify({ code: /^(learning|backfill|inplace)_[a-z_]+$/.test(error.message) ? error.message : 'learning_verify_failed' }))
  process.exitCode = 1
} finally { connection?.release(); await pool?.end() }
