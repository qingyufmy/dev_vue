import assert from 'node:assert/strict'
import { readFile, open } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import { parse } from 'dotenv'
import { createMysqlPool } from '../server/dist-v4/bootstrap/runtime-resources.js'
import { mapLegacyRiskControl } from './lib/risk-legacy-control-mapping.mjs'

const [destination] = process.argv.slice(2)
assert.ok(process.argv.length === 3 && isAbsolute(destination))
const env = parse(await readFile(new URL('../server/.env', import.meta.url)))
assert.equal(env.MYSQL_HOST, '192.168.1.254')
assert.equal(env.MYSQL_DATABASE, 'dev_vue')
const output = await open(destination, 'wx', 0o600)
const pool = createMysqlPool({ host: env.MYSQL_HOST, port: Number(env.MYSQL_PORT || 3306),
  user: env.MYSQL_USER, password: env.MYSQL_PASSWORD, database: env.MYSQL_DATABASE, poolSize: 1 })
let connection
try {
  connection = await pool.getConnection()
  const [[identity]] = await connection.query('SELECT DATABASE() db,@@server_uuid serverUuid,@@session.time_zone timezone')
  assert.equal(identity.db, 'dev_vue')
  assert.equal(identity.serverUuid, 'ac423207-6ef3-11f1-b302-000c29fda104')
  assert.equal(identity.timezone, '+00:00')
  await connection.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ')
  await connection.query('START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY')
  const [rows] = await connection.query(`SELECT id,global_kill_switch,reason,changed_by,
    DATE_FORMAT(updated_at,'%Y-%m-%d %H:%i:%s') updated_at FROM global_risk_control ORDER BY id LIMIT 2`)
  const [users] = await connection.query(`SELECT id FROM users WHERE id IN
    (SELECT changed_by FROM global_risk_control WHERE changed_by > 0)`)
  const [[target]] = await connection.query('SELECT COUNT(*) n FROM global_risk_controls')
  const mapped = mapLegacyRiskControl(rows, new Set(users.map(user => String(user.id))))
  const report = { kind: 'risk-legacy-control-preview/v1', inspected: true, observedAt: new Date().toISOString(), identity,
    sourceCount: rows.length, sourceSha256: mapped.sourceSha256, targetCount: String(target.n),
    mappingValid: true, insertCandidate: String(target.n) === '0', actorMapping: mapped.actorMapping,
    writes: 0, scope: 'Read-only mapping preview; reason and actor IDs not exported. Not a persisted archive, write approval or migration completion.' }
  await connection.rollback()
  await output.writeFile(JSON.stringify(report, null, 2) + '\n')
  console.log(JSON.stringify(report))
} catch (error) {
  await output.writeFile(JSON.stringify({ inspected: false, code: 'risk_legacy_control_preview_failed', driverCode: error.code }) + '\n')
  console.log(JSON.stringify({ inspected: false, code: 'risk_legacy_control_preview_failed', driverCode: error.code }))
  process.exitCode = 1
} finally {
  if (connection) { await connection.rollback().catch(() => {}); connection.destroy() }
  await pool.end()
  await output.sync()
  await output.close()
}
