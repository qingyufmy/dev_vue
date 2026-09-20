import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { parse } from 'dotenv'

/** Development probes share the configured VM, but each owns a fresh queue prefix. */
export async function developmentRedisConnection() {
  const env = parse(await readFile(new URL('../../server/.env', import.meta.url)))
  assert.equal(env.MYSQL_DATABASE, 'dev_vue', 'development_database_required')
  assert.equal(env.REDIS_HOST, '192.168.1.254', 'development_vm_redis_required')
  const port = Number(env.REDIS_PORT), db = Number(env.REDIS_DB)
  assert.ok(Number.isSafeInteger(port) && port > 0 && port <= 65535, 'redis_port_invalid')
  assert.ok(env.REDIS_DB !== undefined && Number.isSafeInteger(db) && db >= 0 && db <= 15, 'redis_db_invalid')
  assert.ok(env.REDIS_PASSWORD, 'redis_password_required')
  return { host: env.REDIS_HOST, port, db, password: env.REDIS_PASSWORD }
}
