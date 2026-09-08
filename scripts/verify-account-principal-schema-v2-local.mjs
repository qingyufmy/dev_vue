import assert from 'node:assert/strict'
import { open, readFile } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import { parse } from 'dotenv'
import { createMysqlPool } from '../server/dist-v4/bootstrap/runtime-resources.js'
import { assertAccountPrincipalReadSchemaV2 } from '../server/dist-v4/modules/auth/composition.js'
import { assertTradingSchemaReady } from '../server/dist-v4/modules/trading/composition.js'

const destination = process.argv[2]
assert.ok(process.argv.length === 3 && isAbsolute(destination))
const output = await open(destination, 'wx', 0o600)
let pool
try {
  const env = parse(await readFile(new URL('../server/.env', import.meta.url)))
  assert.equal(env.MYSQL_DATABASE, 'dev_vue'); assert.equal(env.MYSQL_HOST, '192.168.31.254')
  pool = createMysqlPool({ host: env.MYSQL_HOST, port: Number(env.MYSQL_PORT || 3306), user: env.MYSQL_USER,
    password: env.MYSQL_PASSWORD, database: env.MYSQL_DATABASE, poolSize: 1 })
  const [[identity]] = await pool.query('SELECT DATABASE() db,@@server_uuid serverUuid,@@session.time_zone timezone')
  assert.equal(identity.db, 'dev_vue'); assert.equal(identity.serverUuid, 'ac423207-6ef3-11f1-b302-000c29fda104')
  assert.equal(identity.timezone, '+00:00')
  let ownerChecks = 0
  await assertTradingSchemaReady(pool, async connection => {
    await assertAccountPrincipalReadSchemaV2(connection)
    ownerChecks++
  })
  assert.equal(ownerChecks, 1)
  await output.writeFile(JSON.stringify({ kind: 'account-principal-schema-readiness/v2', observedAt: new Date().toISOString(),
    identity, passed: true, ownerCapability: 'auth/account-principal-read/v2', ownerChecks,
    remainingExactTableChecks: 22, databaseWrites: 0,
    scope: 'Compiled readiness against current MySQL metadata and migration ledger under upgrade lock. Does not mutate schema, prove additive DDL in a second database, validate all auth writes or remove cross-domain SQL.' }, null, 2) + '\n')
  console.log('Account principal owner capability and remaining account readiness passed; database writes 0')
} catch {
  await output.writeFile(JSON.stringify({ passed: false, code: 'account_principal_schema_verification_failed' }) + '\n')
  process.exitCode = 1
} finally {
  if (pool) await pool.end()
  await output.sync(); await output.close()
}
