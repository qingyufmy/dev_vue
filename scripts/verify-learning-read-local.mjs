import Ajv from 'ajv'
import { readFile } from 'node:fs/promises'
import mysql from 'mysql2/promise'
import Fastify from 'fastify'
import { loadSettingsMigrationEnvironment, settingsMigrationConnectionOptions } from './lib/settings-migration-environment.mjs'
import { createMysqlLearningService, createLearningHttp } from '../server/dist-v4/modules/learning/composition.js'
import { MysqlLearningMembershipReader } from '../server/dist-v4/modules/commerce/index.js'
import { requireBackfill as check } from './lib/v4-backfill-contract.mjs'

const root = new URL('../', import.meta.url)
let connection, app
try {
  check(process.argv.length === 3 && process.argv[2] === '--read-only', 'learning_probe_arguments')
  const env = await loadSettingsMigrationEnvironment(root)
  check(env.MYSQL_DATABASE === 'dev_vue', 'learning_probe_database')
  connection = await mysql.createConnection(settingsMigrationConnectionOptions(env))
  await connection.query("SET SESSION time_zone='+00:00'")
  await connection.query('SET SESSION TRANSACTION ISOLATION LEVEL REPEATABLE READ')
  await connection.query('START TRANSACTION READ ONLY')
  const [[identity]] = await connection.query('SELECT DATABASE() database_name,@@server_uuid server_uuid')
  const backup = JSON.parse(await readFile(new URL('docs/migration/dev-vue-inplace-backup-20260906.json', root)))
  check(identity.database_name === 'dev_vue' && identity.server_uuid === backup.serverUuid, 'learning_probe_identity')
  const contract = JSON.parse(await readFile(new URL('contracts/openapi-v4.json', root), 'utf8'))
  const ajv = new Ajv({ strict: false, formats: { 'date-time': true, uri: true } })
  const schema = name => ({ ...contract.components.schemas[name], components: { schemas: { LearningCourse: contract.components.schemas.LearningCourse } } })
  const validateList = ajv.compile(schema('LearningListResponse')), validateDetail = ajv.compile(schema('LearningDetailResponse'))
  const service = createMysqlLearningService(connection, new MysqlLearningMembershipReader(connection))
  const [counts] = await connection.query("SELECT COUNT(*) total FROM learning_courses WHERE status='published'")
  let cursor, courses = []
  do { const page = await service.list(cursor); courses.push(...page.items); cursor = page.next_cursor ?? undefined } while (cursor)
  check(courses.length === Number(counts[0].total), 'learning_probe_course_count')
  app = Fastify()
  await app.register(createLearningHttp({ read: service },
    { cookieName: () => 'probe_www_session', resolveSession: async () => { throw Error('probe_real_session_not_enabled') } },
    { wwwOrigin: 'https://learning.local.test' }))
  const response = await app.inject({ url: '/api/v4/learning/courses', headers: { host: 'learning.local.test' } })
  check(validateList(response.json()), 'learning_probe_list_contract')
  check(response.statusCode === 200 && response.json().data.items.length === Math.min(courses.length, 20), 'learning_probe_http_list')
  let guestLocked = 0
  for (const course of courses) {
    const detail = await app.inject({ url: `/api/v4/learning/courses/${course.id}`, headers: { host: 'learning.local.test' } })
    check(detail.statusCode === 200, 'learning_probe_http_detail')
    check(validateDetail(detail.json()), 'learning_probe_detail_contract')
    const data = detail.json().data
    if (course.access_level !== 'free') { check(data.access === 'login_required' && data.lessons.length === 0, 'learning_probe_guest_leak'); guestLocked++ }
  }
  const [progress] = await connection.query(`SELECT user_id,CAST(lesson_id AS CHAR) lesson_id,CAST(watched_ms AS CHAR) watched_ms,
    CAST(reported_duration_ms AS CHAR) reported_duration_ms,completed FROM learning_progress ORDER BY user_id,lesson_id`)
  let matchedProgress = 0
  for (const userId of [...new Set(progress.map(row => row.user_id))]) {
    const own = progress.filter(row => row.user_id === userId)
    for (const course of courses) {
      const detail = await service.detail(course.id, Number(userId))
      check(validateDetail({ data: detail, meta: { request_id: 'probe', generated_at: new Date().toISOString() } }), 'learning_probe_private_contract')
      for (const lesson of detail.lessons) {
        if (!lesson.progress) continue
        const expected = own.find(row => row.lesson_id === lesson.id)
        check(expected && expected.watched_ms === lesson.progress.watched_ms && expected.reported_duration_ms === lesson.progress.reported_duration_ms
          && (expected.completed === null ? null : Boolean(expected.completed)) === lesson.progress.completed, 'learning_probe_progress_scope')
        matchedProgress++
      }
    }
  }
  check(matchedProgress === progress.length, 'learning_probe_progress_count')
  console.log(JSON.stringify({ status: 'verified', database: 'dev_vue', courses: courses.length, guestLocked, matchedProgress,
    networkListenerStarted: false, databaseWrites: false, realSsoVerified: false }))
} finally { await app?.close(); await connection?.rollback(); await connection?.end() }
