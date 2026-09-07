import { readFile, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { createHash } from 'node:crypto'
import { splitSqlStatements } from './lib/v4-migration-plan.mjs'

const root = new URL('../', import.meta.url)
const sha = value => createHash('sha256').update(value).digest('hex')
const check = (ok, code) => { if (!ok) throw new Error(code) }
const tables = ['learning_courses', 'learning_lessons', 'learning_media_references', 'learning_progress']
let connection, locked = false
try {
  check(process.platform === 'linux' && process.getuid() === 0, 'learning_probe_scope')
  const manifest = JSON.parse(await readFile(new URL('../tools.json', root), 'utf8'))
  for (const file of manifest) check(/^[a-zA-Z0-9_./-]+$/.test(file.path) && !file.path.split('/').includes('..')
    && sha(await readFile(new URL(file.path, root))) === file.sha256, 'learning_probe_tools')
  const mysql = createRequire(import.meta.url)('/www/wwwroot/aurum-ai/node_modules/mysql2/promise.js')
  const credentials = JSON.parse(await readFile(`/proc/self/fd/${process.env.V4_BACKUP_CREDENTIAL_FD}`, 'utf8'))
  connection = await mysql.createConnection({ ...credentials, database: 'dev_vue_m1_a', dateStrings: true, supportBigNumbers: true, bigNumberStrings: true })
  const [[identity]] = await connection.query('SELECT DATABASE() db,@@server_uuid uuid,VERSION() version')
  check(identity.db === 'dev_vue_m1_a' && identity.uuid === 'ac423207-6ef3-11f1-b302-000c29fda104', 'learning_probe_identity')
  await connection.query("SET SESSION time_zone='+00:00'")
  const [[claim]] = await connection.query("SELECT GET_LOCK('v4-learning-reference-probe',0) acquired")
  check(Number(claim.acquired) === 1, 'learning_probe_lock'); locked = true
  for (const table of tables) {
    const [[exists]] = await connection.execute('SELECT COUNT(*) n FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=?', [table])
    check(Number(exists.n) === 0, 'learning_probe_table_exists')
  }
  const sql = await readFile(new URL('server/db/migrations/inplace/022_learning_core.sql', root), 'utf8')
  const statements = splitSqlStatements(sql)
  check(statements.length === 4, 'learning_probe_statements')
  const definitions = []
  for (let i = 0; i < tables.length; i++) {
    check(statements[i].startsWith(`CREATE TABLE ${tables[i]} (`), 'learning_probe_statement_scope')
    await connection.query(statements[i])
    const [[row]] = await connection.query(`SHOW CREATE TABLE ${tables[i]}`)
    definitions.push({ table: tables[i], ddl: row['Create Table'] })
  }
  await connection.beginTransaction()
  await connection.execute("INSERT INTO users (id,password,role,created_at,updated_at) VALUES (777970,'disabled-fixture','user',UTC_TIMESTAMP(3),UTC_TIMESTAMP(3))")
  const common = { origin: 'native', revision: '9007199254740993', updated_at_utc: '2026-09-07 00:00:00.123' }
  const course = { id: 777970, title: 'fixture', access_level: 'logged_in', status: 'published', created_at_utc: '2026-09-07 00:00:00.123', ...common }
  const lesson = { id: 777970, course_id: 777970, public_episode_id: 888970, title: 'fixture', content_type: 'video', duration_ms: '9223372036854775807', sort_order: 0, created_at_utc: common.updated_at_utc, ...common }
  const progress = { id: 777970, user_id: 777970, lesson_id: 777970, watched_ms: '2049000', reported_duration_ms: '599000', completed: 1, quiz_passed: 0, ...common }
  const media = { id: 777970, lesson_id: 777970, source_kind: 'bilibili_id', locator: 'fixture-only', created_at_utc: common.updated_at_utc, ...common }
  const insert = async (table, row) => {
    check(tables.includes(table), 'learning_probe_insert_scope')
    const keys = Object.keys(row)
    return connection.execute(`INSERT INTO ${table} (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`, keys.map(key => row[key]))
  }
  for (const [table, row] of [['learning_courses', course], ['learning_lessons', lesson], ['learning_progress', progress], ['learning_media_references', media]]) await insert(table, row)
  const rejected = []
  const cases = [
    ['access_case', 'learning_courses', { ...course, id: 777971, access_level: 'FREE' }, 3819],
    ['access_space', 'learning_courses', { ...course, id: 777971, access_level: 'free ' }, 3819],
    ['status_lf', 'learning_courses', { ...course, id: 777971, status: 'published\n' }, 3819],
    ['native_time', 'learning_courses', { ...course, id: 777971, created_at_utc: null }, 3819],
    ['revision', 'learning_courses', { ...course, id: 777971, revision: '0' }, 3819],
    ['import_evidence', 'learning_courses', { ...course, id: 777971, origin: 'legacy_import' }, 3819],
    ['lesson_parent', 'learning_lessons', { ...lesson, id: 777971, public_episode_id: 888971, course_id: -777971 }, 1452],
    ['episode_duplicate', 'learning_lessons', { ...lesson, id: 777971 }, 1062],
    ['lesson_duration', 'learning_lessons', { ...lesson, id: 777971, public_episode_id: 888971, duration_ms: '-1' }, 3819],
    ['lesson_type', 'learning_lessons', { ...lesson, id: 777971, public_episode_id: 888971, content_type: 'video ' }, 3819],
    ['progress_duplicate', 'learning_progress', { ...progress, id: 777971 }, 1062],
    ['progress_user', 'learning_progress', { ...progress, id: 777971, user_id: -777971 }, 1452],
    ['progress_lesson', 'learning_progress', { ...progress, id: 777971, lesson_id: -777971 }, 1452],
    ['progress_flag', 'learning_progress', { ...progress, id: 777971, completed: 2 }, 3819],
    ['progress_negative', 'learning_progress', { ...progress, id: 777971, watched_ms: '-1' }, 3819],
    ['media_duplicate', 'learning_media_references', { ...media, id: 777971 }, 1062],
    ['media_empty', 'learning_media_references', { ...media, id: 777971, source_kind: 'youtube_id', locator: '' }, 3819],
    ['media_kind', 'learning_media_references', { ...media, id: 777971, source_kind: 'youtube_id\n' }, 3819],
  ]
  for (const [name, table, row, expected] of cases) {
    let errno = null
    try { await insert(table, row) } catch (error) { errno = error.errno }
    check(errno === expected, `learning_probe_case_${name}`)
    rejected.push({ name, errno })
  }
  const [[saved]] = await connection.query('SELECT CAST(watched_ms AS CHAR) watched,CAST(reported_duration_ms AS CHAR) duration,completed,quiz_passed,CAST(revision AS CHAR) revision,updated_at_utc FROM learning_progress WHERE id=777970')
  const [[duration]] = await connection.query('SELECT CAST(duration_ms AS CHAR) duration FROM learning_lessons WHERE id=777970')
  check(saved.watched === progress.watched_ms && saved.duration === progress.reported_duration_ms && saved.completed === 1 && saved.quiz_passed === 0
    && saved.revision === common.revision && saved.updated_at_utc === common.updated_at_utc && duration.duration === lesson.duration_ms, 'learning_probe_precision')
  await connection.rollback()
  const counts = {}
  for (const table of tables) counts[table] = Number((await connection.query(`SELECT COUNT(*) n FROM ${table}`))[0][0].n)
  check(Object.values(counts).every(count => count === 0), 'learning_probe_cleanup')
  check(Number((await connection.query('SELECT COUNT(*) n FROM users WHERE id=777970'))[0][0].n) === 0, 'learning_probe_user_cleanup')
  const report = { kind: 'learning-schema-probe/v1', identity, sourceSqlSha256: sha(sql), definitions, rejected,
    acceptedRows: 4, exactPrecision: true, overDurationPreserved: true, rolledBack: true, counts, toolManifest: manifest, currentDevVueWritten: false }
  await writeFile(new URL('../receipt.json', root), JSON.stringify(report, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
  console.log(JSON.stringify({ status: 'verified', tables: 4, rejected: rejected.length, rolledBack: true }))
} catch (error) {
  await connection?.rollback().catch(() => {})
  console.error(JSON.stringify({ code: /^learning_probe_[a-z_]+$/.test(error.message) ? error.message : 'learning_probe_failed', errno: error.errno ?? null })); process.exitCode = 1
} finally {
  if (locked) await connection.query("SELECT RELEASE_LOCK('v4-learning-reference-probe')").catch(() => {})
  await connection?.end()
}
