import assert from 'node:assert/strict'
import { open, readFile } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import { parse } from 'dotenv'
import { localAccountEnvironment } from './run-local-account-api.mjs'
import { loadV4ApiRuntimeConfig } from '../server/dist-v4/bootstrap/runtime-config.js'
import { createMysqlPool, createCacheRedis, connectCacheRedis } from '../server/dist-v4/bootstrap/runtime-resources.js'
import { createAuthModule } from '../server/dist-v4/modules/auth/composition.js'

const [fixturePath, configPath, destination, mode] = process.argv.slice(2)
assert.ok(process.argv.length === 6 && ['--inspect', '--retire'].includes(mode))
assert.ok([fixturePath, configPath, destination].every(isAbsolute))
const fixture = JSON.parse(await readFile(fixturePath, 'utf8'))
assert.equal(fixture.kind, 'local-account-fixture/v1')
assert.equal(fixture.identity.db, 'dev_vue')
assert.match(fixture.email, /^v4-local-[a-f0-9-]+@example\.invalid$/)
assert.ok(Number.isSafeInteger(fixture.userId) && fixture.userId > 0)
const output = await open(destination, 'wx', 0o600)
let pool, redis, before, identity, phase = 'inspect'
const snapshotSql = `SELECT CAST(id AS CHAR) id,client_id clientId,revoked_at_utc revokedAt,revocation_reason reason
  FROM auth_sessions WHERE user_id=? ORDER BY id LIMIT 501`
async function report(value) {
  const data = Buffer.from(JSON.stringify(value, null, 2) + '\n')
  await output.truncate(0); await output.write(data, 0, data.length, 0); await output.sync()
}
try {
  const env = localAccountEnvironment(parse(await readFile(new URL('../server/.env', import.meta.url))), parse(await readFile(configPath)))
  pool = createMysqlPool({ host: env.MYSQL_HOST, port: Number(env.MYSQL_PORT || 3306), user: env.MYSQL_USER,
    password: env.MYSQL_PASSWORD, database: env.MYSQL_DATABASE, poolSize: 2 })
  ;[[identity]] = await pool.query('SELECT DATABASE() db,@@server_uuid serverUuid,@@session.time_zone timezone')
  assert.equal(identity.db, 'dev_vue')
  assert.equal(identity.serverUuid, 'ac423207-6ef3-11f1-b302-000c29fda104')
  assert.equal(identity.timezone, '+00:00')
  const validateUser = async executor => {
    const [rows] = await executor.execute("SELECT id FROM users WHERE id=? AND email=? AND role='user' AND deletion_status='active' AND deleted_at IS NULL FOR UPDATE", [fixture.userId, fixture.email])
    assert.equal(rows.length, 1)
  }
  await validateUser(pool)
  ;[before] = await pool.execute(snapshotSql, [fixture.userId])
  assert.ok(before.length < 501)
  assert.ok(before.every(row => ['auth', 'www-web', 'trade-web', 'admin-web'].includes(row.clientId)))
  redis = createCacheRedis({ host: env.REDIS_HOST, port: Number(env.REDIS_PORT), db: Number(env.REDIS_DB), password: env.REDIS_PASSWORD })
  await connectCacheRedis(redis)
  const ticketIndex = `auth:v4:realtime:user:${fixture.userId}`
  const ticketCountBefore = await redis.scard(ticketIndex)
  const intent = { kind: 'local-account-web-session-retirement/v1', mode, identity, userId: fixture.userId,
    scope: 'Only the exact synthetic user web sessions and user-indexed realtime tickets; retain rows, account ownership, observer grants and all business history.',
    before, ticketCountBefore, observedAt: new Date().toISOString() }
  await report({ ...intent, status: 'inspected' })
  if (mode === '--retire') {
    phase = 'logout-requested'
    await report({ ...intent, status: phase })
    // Recheck identity under a lock before the real auth repository's only SQL mutation.
    const guardedPool = { async execute(sql, args) {
      assert.match(sql, /UPDATE auth_sessions SET revoked_at_utc/)
      assert.equal(args[1], 'logout_all_web'); assert.equal(args[2], fixture.userId)
      const connection = await pool.getConnection()
      try {
        await connection.beginTransaction()
        await validateUser(connection)
        const result = await connection.execute(sql, args)
        await connection.commit()
        return result
      } catch (error) { await connection.rollback(); throw error }
      finally { connection.release() }
    } }
    const auth = createAuthModule(guardedPool, redis, loadV4ApiRuntimeConfig(env).auth, {
      revokeUserDevices: async () => { throw Error('device_mutation_forbidden') },
    })
    await auth.logoutWeb(fixture.userId)
    phase = 'verify'
    const [after] = await pool.execute(snapshotSql, [fixture.userId])
    assert.deepEqual(after.map(row => row.id), before.map(row => row.id))
    assert.ok(after.every(row => row.revokedAt !== null))
    for (let index = 0; index < before.length; index++) {
      if (before[index].revokedAt !== null) assert.deepEqual(after[index], before[index])
      else assert.equal(after[index].reason, 'logout_all_web')
    }
    assert.equal(await redis.exists(ticketIndex), 0)
    await report({ ...intent, status: 'verified', after, remainingUnrevoked: 0, ticketIndexRemoved: true })
  }
  console.log(JSON.stringify({ passed: true, mode, sessions: before.length, previouslyUnrevoked: before.filter(row => row.revokedAt === null).length }))
} catch {
  await report({ kind: 'local-account-web-session-retirement/v1', passed: false, phase, identity, before,
    recovery: 'Inspect database revocation and Redis ticket index before resuming; database logout may already be committed. Do not restore sessions or decrement identity versions.' })
  process.exitCode = 1
  console.log(JSON.stringify({ passed: false, phase }))
} finally {
  await Promise.allSettled([redis?.quit(), pool?.end()])
  await output.close()
}
