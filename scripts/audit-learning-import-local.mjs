import { readFile, open } from 'node:fs/promises'
import { resolve, relative, isAbsolute, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import mysql from 'mysql2/promise'
import { loadSettingsMigrationEnvironment, settingsMigrationConnectionOptions } from './lib/settings-migration-environment.mjs'
import { readLearningCourseTargetIdentity } from './lib/mysql-learning-course-backfill.mjs'
import { readLearningProgressTargetIdentity } from './lib/mysql-learning-progress-backfill.mjs'
import { readLearningCourseAudit } from './lib/mysql-learning-course-audit-reader.mjs'
import { readLearningProgressAudit } from './lib/mysql-learning-progress-audit-reader.mjs'
import { learningSecondsToMilliseconds } from './lib/v4-learning-duration.mjs'
import { learningMediaKinds } from './lib/v4-learning-course-rows.mjs'
import { inspectWallClock } from './lib/v4-identity-time.mjs'
import { hash, requireBackfill as check } from './lib/v4-backfill-contract.mjs'

const root = new URL('../', import.meta.url)
let connection, output
try {
  const [flag, path] = process.argv.slice(2)
  if (flag === '--help' && process.argv.length === 3) {
    console.log('node scripts/audit-learning-import-local.mjs --write <absolute-private-snapshot.json>')
  } else {
    check(flag === '--write' && process.argv.length === 4 && isAbsolute(path), 'learning_review_arguments')
    const location = relative(fileURLToPath(root), resolve(path))
    check(location.startsWith(`..${sep}`) || isAbsolute(location), 'learning_review_private_output')
    output = await open(path, 'wx', 0o600)
    const env = await loadSettingsMigrationEnvironment(root)
    check(env.MYSQL_DATABASE === 'dev_vue', 'learning_review_database')
    connection = await mysql.createConnection({ ...settingsMigrationConnectionOptions(env), jsonStrings: true })
    await connection.query("SET SESSION time_zone='+00:00'")
    await connection.query('SET SESSION TRANSACTION ISOLATION LEVEL REPEATABLE READ')
    await connection.query('START TRANSACTION READ ONLY')
    const backup = JSON.parse(await readFile(new URL('docs/migration/dev-vue-inplace-backup-20260906.json', root)))
    const identities = { courses: await readLearningCourseTargetIdentity(connection), progress: await readLearningProgressTargetIdentity(connection) }
    check(Object.values(identities).every(row => row.database === 'dev_vue' && row.serverUuid === backup.serverUuid), 'learning_review_identity')
    const run = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'
    const course = await readLearningCourseAudit(connection, run), progress = await readLearningProgressAudit(connection, run)
    const issues = [], episodes = new Set(), users = progress.userIds
    const courses = course.sources.map(row => {
      check(!episodes.has(row.episode_id), 'learning_review_duplicate_episode'); episodes.add(row.episode_id)
      inspectWallClock(row.created_at); inspectWallClock(row.updated_at)
      check([null, 'free', 'logged_in', 'plus_pro', 'pro_only'].includes(row.access_level)
        && [null, 'draft', 'published', 'archived'].includes(row.status)
        && [null, 'video', 'article'].includes(row.content_type), 'learning_review_enum')
      return { sourceId: row.id, sourceHash: hash(row), durationMs: learningSecondsToMilliseconds(row.duration),
        accessLevel: row.access_level, status: row.status, mediaKinds: learningMediaKinds.filter(kind => row[kind] !== null && row[kind] !== ''),
        createdAtNeedsBasis: row.created_at !== null, updatedAtNeedsBasis: row.updated_at !== null }
    })
    const progressReview = progress.sources.map(row => {
      if (!episodes.has(row.episode_id)) issues.push({ sourceId: row.id, code: 'missing_episode' })
      if (!users.has(row.user_id)) issues.push({ sourceId: row.id, code: 'missing_user' })
      inspectWallClock(row.updated_at)
      check([null, '0', '1'].includes(row.completed) && [null, '0', '1'].includes(row.quiz_passed), 'learning_review_progress_flag')
      const watchedMs = learningSecondsToMilliseconds(row.watched_seconds), durationMs = learningSecondsToMilliseconds(row.total_duration)
      return { sourceId: row.id, sourceHash: hash(row), watchedMs, durationMs, updatedAtNeedsBasis: row.updated_at !== null,
        watchedExceedsDuration: watchedMs !== null && durationMs !== null && BigInt(watchedMs) > BigInt(durationMs) }
    })
    const counts = {}
    for (const table of ['learning_courses', 'learning_lessons', 'learning_media_references', 'learning_progress']) {
      const [[row]] = await connection.query(`SELECT COUNT(*) total FROM ${table}`); counts[table] = Number(row.total)
    }
    const report = { kind: 'learning-source-review/v1', capturedAtUtc: new Date().toISOString(), identities,
      sources: { courses: course.sources, progress: progress.sources }, userIds: [...users],
      sourceHashes: { courses: hash(course.sources), progress: hash(progress.sources) }, courses, progress: progressReview,
      issues, targetCounts: counts, historicalTimezoneConfirmed: false, mediaAvailabilityVerified: false,
      databaseWrites: false, currentDevVueApplyAuthorized: false }
    await connection.rollback()
    await output.writeFile(JSON.stringify(report, null, 2) + '\n'); await output.sync()
    console.log(JSON.stringify({ status: 'reviewed', courseRows: courses.length, progressRows: progressReview.length,
      unresolvedRelations: issues.length, nonNullTimeFields: courses.reduce((n, row) => n + Number(row.createdAtNeedsBasis) + Number(row.updatedAtNeedsBasis), 0)
        + progressReview.filter(row => row.updatedAtNeedsBasis).length, targetCounts: counts, databaseWrites: false }))
  }
} catch (error) {
  console.error(JSON.stringify({ code: /^(learning|backfill|inplace)_[a-z_]+$/.test(error.message) ? error.message : 'learning_review_failed' }))
  process.exitCode = 1
} finally { await connection?.rollback().catch(() => {}); await connection?.end(); await output?.close() }
