import { open } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import mysql from 'mysql2/promise'
import { loadSettingsMigrationEnvironment, settingsMigrationConnectionOptions } from './lib/settings-migration-environment.mjs'
import { learningCompletionProbeGrant } from './lib/learning-completion-probe-grant.mjs'
import { MysqlLearningCompletion } from '../server/dist-v4/modules/learning/infrastructure/mysql-learning-completion.js'
import { MysqlLearningMembershipReader } from '../server/dist-v4/modules/commerce/index.js'
import { withInplaceUpgradeLock } from './lib/mysql-inplace-column-store.mjs'
import { randomUUID } from 'node:crypto'
const root = new URL('../', import.meta.url), database = 'dev_vue_m1_source_20260907_02', id = 777983
const check = (value, code) => { if (!value) throw Error(`learning_completion_access_${code}`) }
let pool, connection, grant, receipt, host
const report = { kind: 'learning-completion-access-probe/v1', verified: false, currentDevVueWritten: false }
try {
  const [flag, path, sshHost] = process.argv.slice(2)
  check(flag === '--apply' && process.argv.length === 5 && isAbsolute(path), 'arguments')
  receipt = await open(path, 'wx', 0o600); host = sshHost
  const env = await loadSettingsMigrationEnvironment(root)
  check(env.MYSQL_DATABASE === 'dev_vue', 'environment')
  grant = learningCompletionProbeGrant(host, 'grant')
  pool = mysql.createPool({ ...settingsMigrationConnectionOptions(env), database, connectionLimit: 4 })
  connection = await pool.getConnection()
  await connection.query("SET SESSION time_zone='+00:00'")
  const [[identity]] = await connection.query('SELECT DATABASE() db,@@server_uuid uuid')
  check(identity.db === database && identity.uuid === 'ac423207-6ef3-11f1-b302-000c29fda104', 'identity'); report.identity = identity
  await withInplaceUpgradeLock(connection, database, async () => {
    const names = ['learning_courses','learning_lessons','learning_progress'], counters = {}
    for (const name of [...names,'learning_progress_changes']) {
      const [[count]] = await connection.query(`SELECT COUNT(*) n FROM ${name}`)
      check(Number(count.n) === 0, 'fixture_not_empty')
      if (names.includes(name)) {
        const [[row]] = await connection.execute('SELECT AUTO_INCREMENT next_id FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=?', [name])
        counters[name] = String(row.next_id ?? 1)
      }
    }
    const [[user]] = await connection.query("SELECT id FROM users WHERE deletion_status='active' AND deleted_at IS NULL ORDER BY id LIMIT 1")
    check(user, 'user_missing')
    const userId = Number(user.id)
    const [[membership]] = await connection.execute('SELECT plan_code,expiration_kind,expires_at_utc FROM memberships WHERE user_id=?', [userId])
    let fixtures = false, memberChanged = false
    try {
      await connection.beginTransaction()
      try {
        await connection.execute("INSERT INTO learning_courses (id,title,access_level,status,created_at_utc,updated_at_utc,origin) VALUES (?,'access fixture','logged_in','published',UTC_TIMESTAMP(3),UTC_TIMESTAMP(3),'native')", [id])
        await connection.execute("INSERT INTO learning_lessons (id,course_id,title,content_type,sort_order,created_at_utc,updated_at_utc,origin) VALUES (?,?,'access fixture','video',0,UTC_TIMESTAMP(3),UTC_TIMESTAMP(3),'native')", [id,id])
        await connection.commit(); fixtures = true
      } catch (error) { await connection.rollback(); throw error }
      const repository = new MysqlLearningCompletion(pool, MysqlLearningMembershipReader.forTransaction)
      const commands = [true,false].map(completed => ({ userId, courseId: String(id), lessonId: String(id), requestId: randomUUID(), expectedRevision: '0', completed }))
      const results = await Promise.allSettled(commands.map(command => repository.execute(command)))
      check(results.filter(row => row.status === 'fulfilled').length === 1 && results.some(row => row.status === 'rejected' && row.reason.code === 'learning_revision_conflict'), 'create_race')
      const winner = commands[results.findIndex(row => row.status === 'fulfilled')]
      report.concurrentFirstCreateSingleWinner = true
      const reject = async code => { let actual; try { await repository.execute(winner) } catch (error) { actual = error.code }; check(actual === code, 'reauthorization') }
      if (membership) await connection.execute("UPDATE memberships SET plan_code='pro',expiration_kind='at_time',expires_at_utc='2000-01-01 00:00:00.000' WHERE user_id=?", [userId])
      else await connection.execute("INSERT INTO memberships (user_id,plan_code,expiration_kind,expires_at_utc,current_state_observed_at_utc,origin) VALUES (?,'pro','at_time','2000-01-01 00:00:00.000',UTC_TIMESTAMP(3),'native')", [userId])
      memberChanged = true
      await connection.execute("UPDATE learning_courses SET access_level='pro_only' WHERE id=?", [id])
      await reject('learning_membership_required'); report.expiredMembershipReplayRejected = true
      await connection.execute("UPDATE learning_courses SET access_level='logged_in',status='draft' WHERE id=?", [id])
      await reject('learning_course_not_found'); report.unpublishedCourseReplayRejected = true
      await connection.execute("UPDATE learning_courses SET status='published' WHERE id=?", [id])
      check((await repository.execute(winner)).replayed, 'replay')
      const [[saved]] = await connection.execute('SELECT CAST(revision AS CHAR) revision,watched_ms,reported_duration_ms,quiz_passed FROM learning_progress WHERE user_id=? AND lesson_id=?', [userId,id])
      const [[receipts]] = await connection.query('SELECT COUNT(*) n FROM learning_progress_changes')
      check(saved.revision === '1' && saved.watched_ms === null && saved.reported_duration_ms === null && saved.quiz_passed === null && Number(receipts.n) === 1, 'single_receipt')
      report.singleNativeRowAndReceiptVerified = true; report.verified = true
    } finally {
      if (memberChanged) {
        if (membership) await connection.execute('UPDATE memberships SET plan_code=?,expiration_kind=?,expires_at_utc=? WHERE user_id=?', [membership.plan_code,membership.expiration_kind,membership.expires_at_utc,userId])
        else await connection.execute('DELETE FROM memberships WHERE user_id=?', [userId])
      }
      if (fixtures) {
        await connection.beginTransaction()
        try {
          await connection.execute('DELETE FROM learning_progress_changes WHERE user_id=? AND lesson_id=?', [userId,id])
          await connection.execute('DELETE FROM learning_progress WHERE user_id=? AND lesson_id=?', [userId,id])
          await connection.execute('DELETE FROM learning_lessons WHERE id=? AND course_id=?', [id,id])
          await connection.execute("DELETE FROM learning_courses WHERE id=? AND title='access fixture'", [id])
          await connection.commit()
        } catch (error) { await connection.rollback(); throw error }
      }
      for (const name of names) {
        const [[row]] = await connection.query(`SELECT COUNT(*) n FROM ${name}`)
        check(Number(row.n) === 0 && /^[1-9][0-9]*$/.test(counters[name]), 'cleanup')
        await connection.query(`ALTER TABLE ${name} AUTO_INCREMENT=${counters[name]}`)
      }
      const [[restored]] = await connection.execute('SELECT plan_code,expiration_kind,expires_at_utc FROM memberships WHERE user_id=?', [userId])
      check(JSON.stringify(restored ?? null) === JSON.stringify(membership ?? null), 'membership_restore')
      report.fixtureCleanupVerified = true
    }
  })
} catch (error) { report.verified = false; report.code = /^learning_completion_[a-z_]+$/.test(error.message) ? error.message : 'learning_completion_access_failed'; process.exitCode = 1 }
finally {
  connection?.release(); await pool?.end()
  if (grant) {
    try { report.grantsRestored = learningCompletionProbeGrant(host, 'restore', grant.priorGrantsSha256).status === 'restored' }
    catch { report.grantsRestored = false; report.verified = false; process.exitCode = 1 }
  }
  if (receipt) { await receipt.writeFile(JSON.stringify(report,null,2)+'\n'); await receipt.sync(); await receipt.close() }
  console.log(JSON.stringify(report))
}
