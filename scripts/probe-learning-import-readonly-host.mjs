import { readFile, open } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { sha256 } from './lib/v4-migration-plan.mjs'
import { hash } from './lib/v4-backfill-contract.mjs'
import { readLearningCourseTargetIdentity } from './lib/mysql-learning-course-backfill.mjs'
import { readLearningProgressTargetIdentity } from './lib/mysql-learning-progress-backfill.mjs'
import { readLearningCourseAudit } from './lib/mysql-learning-course-audit-reader.mjs'
import { readLearningProgressAudit } from './lib/mysql-learning-progress-audit-reader.mjs'

const root = new URL('../', import.meta.url)
let connection
try {
  if (process.platform !== 'linux' || process.getuid() !== 0) throw Error('learning_readonly_scope')
  const manifest = JSON.parse(await readFile(new URL('../tools.json', root)))
  for (const file of manifest) {
    if (!/^[a-zA-Z0-9_./-]+$/.test(file.path) || file.path.split('/').includes('..')
      || sha256(await readFile(new URL(file.path, root))) !== file.sha256) throw Error('learning_readonly_manifest')
  }
  const mysql = createRequire(import.meta.url)('/www/wwwroot/aurum-ai/node_modules/mysql2/promise.js')
  const credentials = JSON.parse(await readFile(`/proc/self/fd/${process.env.V4_BACKUP_CREDENTIAL_FD}`, 'utf8'))
  const databases = []
  for (const database of ['dev_vue', 'dev_vue_m1_source_20260907_02']) {
    connection = await mysql.createConnection({ ...credentials, database, dateStrings: true, jsonStrings: true,
      supportBigNumbers: true, bigNumberStrings: true, timezone: 'Z' })
    await connection.query("SET SESSION time_zone='+00:00'")
    await connection.query('SET SESSION TRANSACTION ISOLATION LEVEL REPEATABLE READ')
    await connection.query('START TRANSACTION READ ONLY')
    const [[identity]] = await connection.query('SELECT DATABASE() db,@@server_uuid uuid,@@version version')
    if (identity.db !== database || identity.uuid !== 'ac423207-6ef3-11f1-b302-000c29fda104') throw Error('learning_readonly_identity')
    const courseIdentity = await readLearningCourseTargetIdentity(connection)
    const progressIdentity = await readLearningProgressTargetIdentity(connection)
    const runId = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'
    const course = await readLearningCourseAudit(connection, runId)
    const progress = await readLearningProgressAudit(connection, runId)
    const counts = {}
    for (const table of ['learning_courses', 'learning_lessons', 'learning_media_references', 'learning_progress']) {
      const [[row]] = await connection.query(`SELECT CAST(COUNT(*) AS CHAR) total FROM ${table}`)
      counts[table] = row.total
    }
    const [[journal]] = await connection.query("SELECT CAST(COUNT(*) AS CHAR) total FROM database_upgrade_steps_v4 WHERE status='completed'")
    databases.push({ identity, courseIdentity, progressIdentity, courseSourceRows: course.sources.length, courseSourceHash: hash(course.sources),
      progressSourceRows: progress.sources.length, progressSourceHash: hash(progress.sources), learningCounts: counts, completedSteps: journal.total,
      courseCreatedNonNull: course.sources.filter(row => row.created_at !== null).length, progressUpdatedNonNull: progress.sources.filter(row => row.updated_at !== null).length,
      emptyProbeRun: Object.values(course.actual).every(rows => rows.length === 0) && course.archives.length === 0 && progress.actual.length === 0 && progress.archives.length === 0 })
    await connection.rollback(); await connection.end(); connection = null
  }
  const file = await open(new URL('../receipt.json', root), 'wx', 0o600)
  try { await file.writeFile(JSON.stringify({ kind: 'learning-import-readonly/v1', databases, toolManifest: manifest, databaseWrites: false }, null, 2) + '\n'); await file.sync() }
  finally { await file.close() }
  console.log(JSON.stringify({ status: 'verified', databases: databases.map(row => ({ database: row.identity.db, courseRows: row.courseSourceRows, progressRows: row.progressSourceRows, completedSteps: row.completedSteps })) }))
} catch (error) {
  console.error(JSON.stringify({ code: error.code ?? 'learning_readonly_failed' })); process.exitCode = 1
} finally { await connection?.rollback().catch(() => {}); await connection?.end() }
