import assert from 'node:assert/strict'
import { open, readFile } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import { parse } from 'dotenv'
import { createMysqlPool } from '../server/dist-v4/bootstrap/runtime-resources.js'
import { verifyProposedEvidenceReference } from './lib/proposed-evidence-reference.mjs'

const [destination] = process.argv.slice(2)
assert.ok(process.argv.length === 3 && isAbsolute(destination))
const output = await open(destination, 'wx', 0o600)
let pool, connection
let stage = 'connect'
const checks = []
try {
  const env = parse(await readFile(new URL('../server/.env', import.meta.url)))
  pool = createMysqlPool({ host: env.MYSQL_HOST, port: Number(env.MYSQL_PORT || 3306), user: env.MYSQL_USER,
    password: env.MYSQL_PASSWORD, database: env.MYSQL_DATABASE, poolSize: 1 })
  connection = await pool.getConnection()
  const [[identity]] = await connection.query('SELECT DATABASE() db,@@server_uuid serverUuid,@@session.time_zone timezone')
  assert.equal(identity.db, 'dev_vue')
  assert.equal(identity.serverUuid, 'ac423207-6ef3-11f1-b302-000c29fda104')
  assert.equal(identity.timezone, '+00:00')
  stage = 'reference-query'
  checks.push(...(await verifyProposedEvidenceReference(connection)).checks)
  await output.writeFile(JSON.stringify({ passed: true, kind: 'proposed-evidence-mysql/v1', observedAt: new Date().toISOString(), identity, checks,
    scope: 'Actual MySQL query and current column/index definitions via session-local DDL shadows without foreign keys. No permanent writes, foreign-key or concurrent transaction proof, worker restart or trading.' }, null, 2) + '\n')
  console.log(JSON.stringify({ passed: true, checks: checks.length }))
} catch (error) {
  await output.writeFile(JSON.stringify({ passed: false, code: error.code || 'evidence_verification_failed', stage, checks }) + '\n')
  console.log(JSON.stringify({ passed: false, code: error.code || 'evidence_verification_failed', stage, checks: checks.length }))
  process.exitCode = 1
} finally {
  connection?.destroy()
  await pool?.end()
  await output.sync(); await output.close()
}
