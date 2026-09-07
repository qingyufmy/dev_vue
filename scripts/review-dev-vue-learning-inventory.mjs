import { readFile, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import mysql from 'mysql2/promise'
import { loadSettingsMigrationEnvironment, settingsMigrationConnectionOptions } from './lib/settings-migration-environment.mjs'
import { loadSettingRequestCoordinator } from './lib/inplace-setting-request-schema.mjs'
import { coordinateInplaceSchema } from './lib/inplace-schema-coordinator.mjs'
import { verifyInplaceJournal } from './lib/mysql-inplace-column-store.mjs'
import { hash, requireBackfill as check } from './lib/v4-backfill-contract.mjs'

const root = new URL('../', import.meta.url)
const reportPath = new URL('docs/migration/dev-vue-learning-inventory-20260907.json', root)
const tables = ['courses', 'course_resources', 'quiz_questions', 'progress', 'video_streams', 'stored_files', 'storage_upload_sessions', 'comments', 'comment_likes']
let connection
try {
  const [mode] = process.argv.slice(2)
  check(process.argv.length === 3 && ['--write', '--verify'].includes(mode), 'learning_inventory_arguments')
  const previous = mode === '--verify' ? JSON.parse(await readFile(reportPath, 'utf8')) : null
  const baseline = JSON.parse(await readFile(new URL('docs/migration/m1-source-target-inventory-20260905.json', root), 'utf8'))
  const backup = JSON.parse(await readFile(new URL('docs/migration/dev-vue-inplace-backup-20260906.json', root), 'utf8'))
  const env = await loadSettingsMigrationEnvironment(root)
  check(env.MYSQL_DATABASE === 'dev_vue', 'learning_inventory_database')
  connection = await mysql.createConnection(settingsMigrationConnectionOptions(env))
  await connection.query("SET SESSION time_zone='+00:00'")
  await connection.query('START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY')
  const [[identity]] = await connection.query('SELECT DATABASE() db,@@server_uuid uuid')
  check(identity.uuid === backup.serverUuid && identity.db === 'dev_vue', 'learning_inventory_identity')
  const plan = await loadSettingRequestCoordinator(root)
  check(await verifyInplaceJournal(connection) && (await coordinateInplaceSchema(plan.store(connection), plan)).structureComplete, 'learning_inventory_schema')
  const entries = []
  for (const table of tables) {
    const expected = baseline.source_tables.find(item => item.name === table)
    const [columns] = await connection.execute('SELECT COLUMN_NAME name,COLUMN_TYPE type,IS_NULLABLE nullable,COLUMN_DEFAULT defaultValue,COLLATION_NAME collationName FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=? ORDER BY ORDINAL_POSITION', [table])
    check(expected && JSON.stringify(columns.map(column => column.name)) === JSON.stringify(expected.columns), 'learning_inventory_columns_changed')
    const fields = columns.map(column => {
      check(/^[a-z_][a-z0-9_]*$/.test(column.name), 'learning_inventory_column_name')
      return /^(datetime|timestamp)/.test(column.type) ? `DATE_FORMAT(\`${column.name}\`,'%Y-%m-%d %H:%i:%s.%f')` : `\`${column.name}\``
    })
    const [rows] = await connection.query(`SELECT CAST(id AS CHAR) id,SHA2(CAST(JSON_ARRAY(${fields.join(',')}) AS CHAR CHARACTER SET utf8mb4),256) rowSha256 FROM \`${table}\` ORDER BY id`)
    const [indexes] = await connection.execute('SELECT INDEX_NAME name,NON_UNIQUE nonUnique,SEQ_IN_INDEX position,COLUMN_NAME columnName FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=? ORDER BY INDEX_NAME,SEQ_IN_INDEX', [table])
    entries.push({ table, rows: rows.length, baselineRows: expected.row_count, columns, indexes, sourceRowsHash: hash(rows), rowHashes: rows })
  }
  const checks = {}
  const queries = {
    courses: "SELECT COUNT(*) total,COUNT(DISTINCT episode_id) distinctEpisodes,COUNT(DISTINCT BINARY episode_id) binaryDistinctEpisodes,SUM(episode_id IS NULL OR TRIM(episode_id)='') emptyEpisodes,SUM(duration IS NULL) nullDuration,SUM(duration='') emptyDuration,SUM(created_at IS NOT NULL) nonNullCreated,SUM(updated_at IS NOT NULL) nonNullUpdated FROM courses",
    progress: 'SELECT COUNT(*) total,SUM(p.watched_seconds<0) negativeWatched,SUM(p.total_duration<0) negativeDuration,SUM(p.watched_seconds>p.total_duration) watchedOverDuration,SUM(p.watched_seconds IS NULL) nullWatched,SUM(p.total_duration IS NULL) nullDuration,SUM(u.id IS NULL) missingUsers,SUM(c.id IS NULL) missingEpisodes,SUM(p.updated_at IS NOT NULL) nonNullUpdated FROM progress p LEFT JOIN users u ON u.id=p.user_id LEFT JOIN courses c ON c.episode_id=p.episode_id',
    progressDuplicates: 'SELECT COUNT(*) groupsWithDuplicates FROM (SELECT user_id,episode_id FROM progress GROUP BY user_id,episode_id HAVING COUNT(*)>1) q',
    resources: 'SELECT COUNT(*) total,SUM(c.id IS NULL) missingEpisodes,SUM(r.stored_file_id IS NOT NULL AND f.id IS NULL) missingStoredFiles,SUM(r.stored_file_id IS NULL) noStoredFile,SUM(r.url IS NOT NULL AND r.url<>\'\') withUrl FROM course_resources r LEFT JOIN courses c ON c.episode_id=r.episode_id LEFT JOIN stored_files f ON f.id=r.stored_file_id',
    quiz: 'SELECT COUNT(*) total,SUM(c.id IS NULL) missingEpisodes,SUM(NOT JSON_VALID(q.options)) invalidOptionsJson FROM quiz_questions q LEFT JOIN courses c ON c.episode_id=q.episode_id',
  }
  for (const [name, query] of Object.entries(queries)) checks[name] = (await connection.query(query))[0][0]
  const distributions = {}
  for (const [name, query] of Object.entries({ courseTypes: 'SELECT content_type value,COUNT(*) n FROM courses GROUP BY content_type ORDER BY content_type',
    courseAccess: 'SELECT access_level value,COUNT(*) n FROM courses GROUP BY access_level ORDER BY access_level',
    courseStatus: 'SELECT status value,COUNT(*) n FROM courses GROUP BY status ORDER BY status',
    resourceTypes: 'SELECT type value,COUNT(*) n FROM course_resources GROUP BY type ORDER BY type',
    progressStates: 'SELECT completed,quiz_passed,COUNT(*) n FROM progress GROUP BY completed,quiz_passed ORDER BY completed,quiz_passed' })) distributions[name] = (await connection.query(query))[0]
  const [durations] = await connection.query('SELECT CAST(id AS CHAR) id,duration FROM courses ORDER BY id')
  const [progressValues] = await connection.query('SELECT CAST(id AS CHAR) id,CAST(watched_seconds AS CHAR) watchedSeconds,CAST(total_duration AS CHAR) totalDuration,completed,quiz_passed FROM progress ORDER BY id')
  const referenceFiles = []
  for (const path of ['server/routes/courses.js', 'server/course-attachments.js', 'server/admin/content-system.js']) {
    referenceFiles.push({ path, sha256: createHash('sha256').update(await readFile(new URL(path, 'file:///D:/dev_codex/wall-street-skill-local/'))).digest('hex') })
  }
  const report = { kind: 'learning-inventory/v1', identity, schemaSteps: plan.steps.length, entries, checks, distributions, durations, progressValues, referenceFiles,
    databaseWrites: 0, mediaObjectsVerified: false, historicalTimeVerified: false, migrationComplete: false }
  await connection.rollback()
  if (mode === '--write') await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' })
  else check(canonicalReport(previous) === canonicalReport(report), 'learning_inventory_changed')
  console.log(JSON.stringify({ status: 'verified', tables: entries.length, rows: entries.reduce((sum, entry) => sum + entry.rows, 0), checks, databaseWrites: 0 }))
} catch (error) {
  console.error(JSON.stringify({ code: /^learning_inventory_[a-z_]+$/.test(error.message) ? error.message : 'learning_inventory_failed' })); process.exitCode = 1
} finally { if (connection) { await connection.rollback().catch(() => {}); await connection.end().catch(() => {}) } }
function canonicalReport(report) { return JSON.stringify(report) }
