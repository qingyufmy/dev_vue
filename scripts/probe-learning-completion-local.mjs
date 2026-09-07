import { readFile, open } from 'node:fs/promises'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID, createHash } from 'node:crypto'
import mysql from 'mysql2/promise'
import { loadSettingsMigrationEnvironment, settingsMigrationConnectionOptions } from './lib/settings-migration-environment.mjs'
import { withInplaceUpgradeLock } from './lib/mysql-inplace-column-store.mjs'
import { learningCompletionProbeGrant } from './lib/learning-completion-probe-grant.mjs'
import { MysqlLearningCompletion } from '../server/dist-v4/modules/learning/infrastructure/mysql-learning-completion.js'
import { MysqlLearningMembershipReader } from '../server/dist-v4/modules/commerce/index.js'

const root = new URL('../', import.meta.url), database = 'dev_vue_m1_source_20260907_02'
const table = 'learning_progress_changes', fixtureId = 777982
const tables = ['learning_courses', 'learning_lessons', 'learning_progress', 'learning_media_references']
const sha = value => createHash('sha256').update(value).digest('hex')
const check = (condition, code) => { if (!condition) throw Error(`learning_completion_probe_${code}`) }
let pool, receipt, grant, host
const report = { kind: 'learning-completion-probe/v1', executionHost: 'local', currentDevVueWritten: false, verified: false }
try {
  const [flag, destination, sshHost] = process.argv.slice(2)
  if (flag === '--help' && process.argv.length === 3) {
    console.log('node scripts/probe-learning-completion-local.mjs --apply <private-absolute-receipt.json> <ssh-alias>')
  } else {
    check(flag === '--apply' && process.argv.length === 5 && isAbsolute(destination), 'arguments')
    const path = relative(fileURLToPath(root), resolve(destination))
    check(path.startsWith(`..${sep}`) || isAbsolute(path), 'private_receipt')
    receipt = await open(destination, 'wx', 0o600)
    report.toolManifest = await Promise.all([
      'scripts/probe-learning-completion-local.mjs', 'scripts/lib/learning-completion-probe-grant.mjs',
      'server/db/migrations/inplace/023_learning_progress_changes.sql', 'server/db/migrations/inplace/024_learning_request_key_preservation.sql',
      'server/src/modules/learning/domain/learning-completion.ts', 'server/src/modules/learning/infrastructure/mysql-learning-completion.ts',
      'server/src/modules/commerce/infrastructure/mysql-learning-membership-reader.ts',
    ].map(async path => ({ path, sha256: sha(await readFile(new URL(path, root))) })))
    const env = await loadSettingsMigrationEnvironment(root)
    check(env.MYSQL_DATABASE === 'dev_vue' && env.MYSQL_USER === 'dev_vue', 'environment')
    host = sshHost
    grant = learningCompletionProbeGrant(host, 'grant')
    report.priorGrantsSha256 = grant.priorGrantsSha256
    pool = mysql.createPool({ ...settingsMigrationConnectionOptions(env), database, connectionLimit: 5 })
    const connection = await pool.getConnection()
    try {
      await connection.query("SET SESSION time_zone='+00:00'")
      const [[identity]] = await connection.query('SELECT DATABASE() db,@@server_uuid uuid,VERSION() version')
      check(identity.db === database && identity.uuid === 'ac423207-6ef3-11f1-b302-000c29fda104', 'identity')
      report.identity = identity
      await withInplaceUpgradeLock(connection, database, async () => {
        const [[existing]] = await connection.execute('SELECT COUNT(*) n FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=?', [table])
        check(Number(existing.n) === 0, 'table_exists')
        const before = {}
        for (const name of tables) {
          const [[count]] = await connection.query(`SELECT COUNT(*) n FROM ${name}`)
          check(Number(count.n) === 0, 'fixture_tables_not_empty')
          const [[metadata]] = await connection.execute('SELECT AUTO_INCREMENT next_id FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=?', [name])
          before[name] = String(metadata.next_id ?? '1')
        }
        const [[user]] = await connection.query("SELECT id FROM users WHERE deletion_status='active' AND deleted_at IS NULL ORDER BY id LIMIT 1")
        check(user && Number.isSafeInteger(Number(user.id)), 'user_missing')
        const source = await readFile(new URL('server/db/migrations/inplace/023_learning_progress_changes.sql', root), 'utf8')
        const correction = await readFile(new URL('server/db/migrations/inplace/024_learning_request_key_preservation.sql', root), 'utf8')
        check(source.startsWith(`CREATE TABLE ${table} (`), 'sql_scope')
        report.sourceSqlSha256 = sha(source)
        report.correctionSqlSha256 = sha(correction)
        let created = false, fixtures = false
        try {
          await connection.query(source); created = true
          const [[definition]] = await connection.query(`SHOW CREATE TABLE ${table}`)
          report.initialDefinition = definition['Create Table']
          await connection.query(correction)
          const [[corrected]] = await connection.query(`SHOW CREATE TABLE ${table}`)
          report.definition = corrected['Create Table']
          await connection.beginTransaction()
          try {
            await connection.execute(`INSERT INTO learning_courses
              (id,title,access_level,status,created_at_utc,updated_at_utc,origin) VALUES (?,'completion fixture','logged_in','published',UTC_TIMESTAMP(3),UTC_TIMESTAMP(3),'native')`, [fixtureId])
            await connection.execute(`INSERT INTO learning_lessons
              (id,course_id,title,content_type,sort_order,created_at_utc,updated_at_utc,origin)
              VALUES (?,?,'completion fixture','video',0,UTC_TIMESTAMP(3),UTC_TIMESTAMP(3),'native')`, [fixtureId, fixtureId])
            await connection.commit(); fixtures = true
          } catch (error) { await connection.rollback(); throw error }
          const repository = new MysqlLearningCompletion(pool, MysqlLearningMembershipReader.forTransaction)
          const command = { userId: Number(user.id), courseId: String(fixtureId), lessonId: String(fixtureId),
            requestId: randomUUID(), expectedRevision: '0', completed: true }
          const first = await repository.execute(command)
          check(first.revision === '1' && first.completed === true && !first.replayed, 'create')
          check((await repository.execute(command)).replayed, 'replay')
          const conflict = async (work, code) => {
            let actual
            try { await work() } catch (error) { actual = error.code }
            check(actual === code, `expected_${code}`)
          }
          await conflict(() => repository.execute({ ...command, completed: false }), 'learning_idempotency_conflict')
          const concurrent = await Promise.allSettled([true, false].map(completed => repository.execute({ ...command,
            requestId: randomUUID(), expectedRevision: '1', completed })))
          check(concurrent.filter(row => row.status === 'fulfilled').length === 1
            && concurrent.some(row => row.status === 'rejected' && row.reason.code === 'learning_revision_conflict'), 'concurrency')
          report.concurrentSingleWinner = true
          await connection.execute(`UPDATE learning_progress SET revision=9007199254740993,watched_ms=9007199254740993,
            reported_duration_ms=5000,quiz_passed=0 WHERE user_id=? AND lesson_id=?`, [command.userId, fixtureId])
          const precise = await repository.execute({ ...command, requestId: randomUUID(), expectedRevision: '9007199254740993' })
          check(precise.revision === '9007199254740994', 'precision')
          const snapshot = async () => {
            const [[row]] = await connection.execute(`SELECT CAST(revision AS CHAR) revision,CAST(watched_ms AS CHAR) watched_ms,
              CAST(reported_duration_ms AS CHAR) reported_duration_ms,completed,quiz_passed,origin,source_sha256,updated_at_utc
              FROM learning_progress WHERE user_id=? AND lesson_id=?`, [command.userId, fixtureId])
            return row
          }
          const preciseRow = await snapshot()
          check(preciseRow.watched_ms === '9007199254740993' && preciseRow.reported_duration_ms === '5000'
            && Number(preciseRow.quiz_passed) === 0 && preciseRow.origin === 'native', 'history_preserved')
          report.exactPrecisionAndOverDuration = true
          // Execute a real COMMIT, then simulate the caller losing its acknowledgement.
          let injectCommit = true
          const faultPool = { async getConnection() {
            const current = await pool.getConnection()
            return new Proxy(current, { get(target, key) {
              if (key === 'commit') return async () => { await target.commit(); if (injectCommit) { injectCommit = false; throw Error('injected_ack_loss') } }
              const value = target[key]; return typeof value === 'function' ? value.bind(target) : value
            } })
          } }
          const unknownCommand = { ...command, requestId: randomUUID(), expectedRevision: precise.revision, completed: false }
          await conflict(() => new MysqlLearningCompletion(faultPool, MysqlLearningMembershipReader.forTransaction).execute(unknownCommand), 'learning_commit_unknown')
          const recovered = await repository.execute(unknownCommand)
          check(recovered.replayed && recovered.revision === '9007199254740995' && !recovered.completed, 'commit_recovery')
          report.commitUnknownRecovered = true
          const beforeFailure = await snapshot()
          const auditFaultPool = { async getConnection() {
            const current = await pool.getConnection()
            return new Proxy(current, { get(target, key) {
              if (key === 'execute') return async (sql, values) => {
                if (sql.startsWith('INSERT INTO learning_progress_changes')) throw Error('injected_audit_failure')
                return target.execute(sql, values)
              }
              const value = target[key]; return typeof value === 'function' ? value.bind(target) : value
            } })
          } }
          await conflict(() => new MysqlLearningCompletion(auditFaultPool, MysqlLearningMembershipReader.forTransaction).execute({
            ...command, requestId: randomUUID(), expectedRevision: recovered.revision }), 'learning_write_failed')
          check(JSON.stringify(await snapshot()) === JSON.stringify(beforeFailure), 'audit_rollback')
          report.auditRollbackVerified = true
          // Schema checks execute in a transaction that is always rolled back.
          const columns = ['user_id','request_id','request_sha256','course_id','lesson_id','prior_revision','revision','prior_completed','completed','recorded_at_utc']
          const base = [command.userId, randomUUID(), 'a'.repeat(64), fixtureId, fixtureId, '19', '20', null, 1, '2026-09-07 00:00:00.123']
          const insert = values => connection.execute(`INSERT INTO ${table} (${columns.join(',')}) VALUES (${columns.map(() => '?').join(',')})`, values)
          const rejected = []
          await connection.beginTransaction()
          try {
            for (const [name, index, value] of [['bad_uuid',1,'bad'],['uuid_newline',1,randomUUID()+'\n'],['hash_case',2,'A'.repeat(64)],
              ['revision_gap',5,'18'],['bad_completed',8,2],['missing_lesson',4,2147483647]]) {
              const values = [...base]; values[index] = value
              let errno
              try { await insert(values) } catch (error) { errno = error.errno }
              if (![3819,1452,1406].includes(errno)) report.failedConstraint = { name, errno: errno ?? null }
              check([3819,1452,1406].includes(errno), `constraint_${name}`); rejected.push({ name, errno })
            }
            await insert(base)
          } finally { await connection.rollback() }
          report.rejectedConstraints = rejected
          report.acceptedConstraintRow = true
          report.verified = true
        } finally {
          if (fixtures) {
            await connection.beginTransaction()
            try {
              await connection.execute(`DELETE FROM ${table} WHERE user_id=? AND lesson_id=?`, [Number(user.id), fixtureId])
              await connection.execute('DELETE FROM learning_progress WHERE user_id=? AND lesson_id=?', [Number(user.id), fixtureId])
              await connection.execute('DELETE FROM learning_lessons WHERE id=? AND course_id=?', [fixtureId, fixtureId])
              await connection.execute("DELETE FROM learning_courses WHERE id=? AND title='completion fixture'", [fixtureId])
              await connection.commit()
            } catch (error) { await connection.rollback(); throw error }
          }
          if (created) {
            const [[count]] = await connection.query(`SELECT COUNT(*) n FROM ${table}`)
            check(Number(count.n) === 0, 'cleanup_receipts_not_empty')
            await connection.query(`DROP TABLE ${table}`)
          }
          for (const name of tables) {
            const [[count]] = await connection.query(`SELECT COUNT(*) n FROM ${name}`)
            check(Number(count.n) === 0 && /^[1-9][0-9]*$/.test(before[name]), 'cleanup_data')
            await connection.query(`ALTER TABLE ${name} AUTO_INCREMENT=${before[name]}`)
          }
          report.fixtureCleanupVerified = true
        }
      })
    } finally { connection.release() }
  }
} catch (error) {
  report.verified = false
  report.error = /^learning_completion_[a-z_]+$/.test(error.message) ? error.message : 'learning_completion_probe_failed'
  process.exitCode = 1
} finally {
  await pool?.end()
  if (grant) {
    try { report.grantsRestored = learningCompletionProbeGrant(host, 'restore', grant.priorGrantsSha256).status === 'restored' }
    catch { report.verified = false; report.grantsRestored = false; process.exitCode = 1 }
  }
  if (receipt) { await receipt.writeFile(JSON.stringify(report, null, 2) + '\n'); await receipt.sync(); await receipt.close() }
  if (receipt) console.log(JSON.stringify({ verified: report.verified, error: report.error, fixtureCleanupVerified: report.fixtureCleanupVerified,
    grantsRestored: report.grantsRestored, database, currentDevVueWritten: false }))
}
