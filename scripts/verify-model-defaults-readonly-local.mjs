import assert from 'node:assert/strict'
import { readFile, open } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import mysql from 'mysql2/promise'
import { parse } from 'dotenv'
import { MysqlRuntimeModelProfileCatalog, loadCredentialKeyring } from '../server/dist-v4/modules/inference/infrastructure/mysql-model-gateway-resolver.js'
import { createAccountPrincipalReader } from '../server/dist-v4/modules/auth/composition.js'
import { createRuntimeStrategyAccess } from '../server/dist-v4/modules/strategies/composition.js'

const [destination] = process.argv.slice(2)
assert.ok(process.argv.length === 3 && isAbsolute(destination ?? ''))
const env = parse(await readFile(new URL('../server/.env', import.meta.url)))
assert.equal(env.MYSQL_HOST, '192.168.1.254'); assert.equal(env.MYSQL_DATABASE, 'dev_vue')
const output = await open(destination, 'wx', 0o600)
const report = { kind: 'model-default-selection-readonly/v1', passed: false, writes: 0, modelRequests: 0, checks: [] }
let db
try {
  db = await mysql.createConnection({ host: env.MYSQL_HOST, port: Number(env.MYSQL_PORT || 3306), user: env.MYSQL_USER,
    password: env.MYSQL_PASSWORD, database: env.MYSQL_DATABASE, timezone: 'Z', supportBigNumbers: true, bigNumberStrings: true })
  await db.query("SET SESSION time_zone='+00:00'")
  const [[identity]] = await db.query('SELECT @@server_uuid uuid')
  assert.equal(identity.uuid, 'ac423207-6ef3-11f1-b302-000c29fda104')
  await db.query('START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY')
  const executor = { execute: db.execute.bind(db) }, principals = createAccountPrincipalReader(executor)
  const keyring = loadCredentialKeyring(env), options = { allowPrivateEndpoints: false, maxAttempts: 1, defaultTimeoutMs: 30000 }
  const access = createRuntimeStrategyAccess(executor)
  const guarded = new MysqlRuntimeModelProfileCatalog(executor, keyring, options, access, principals)
  const [strategies] = await db.query("SELECT CAST(id AS CHAR) id,CAST(active_version_id AS CHAR) version_id FROM strategies WHERE status='draft' ORDER BY id LIMIT 1")
  assert.equal(strategies.length, 1)
  await assert.rejects(guarded.resolve({ userId: 1, strategyId: strategies[0].id, strategyVersionId: '1', usage: 'auto' }), { code: 'model_strategy_unavailable' })
  report.checks.push({ kind: 'actual_strategy_gate', result: 'draft_rejected' })
  // Isolate model selection from draft strategy admission without publishing it.
  const catalog = new MysqlRuntimeModelProfileCatalog(executor, keyring, options,
    { canUseCurrent: async () => true, canUseFrozenReview: async () => true }, principals)
  report.selectionStrategyGateStubbed = true
  for (const userId of [1, 28, 29]) for (const usage of ['manual', 'auto']) {
    try {
      const profile = await catalog.resolve({ userId, strategyId: strategies[0].id, strategyVersionId: '1', usage })
      assert.ok(profile.apiKey.length > 0)
      report.checks.push({ userId, usage, result: 'resolved', profileId: profile.id, credentialSource: profile.usage.credentialSource })
    } catch (error) {
      if (!['model_profile_not_verified', 'platform_model_sharing_unavailable', 'model_profile_unavailable', 'model_credential_key_unavailable', 'model_credential_decryption_failed'].includes(error?.code)) throw error
      report.checks.push({ userId, usage, result: 'rejected', code: error.code })
    }
  }
  report.passed = true
} catch (error) {
  report.errorCode = error?.code ?? error?.name
  report.locations = String(error?.stack ?? '').split('\n').filter(line => /^\s+at /.test(line)).slice(0, 3)
  process.exitCode = 1
} finally {
  if (db) { await db.rollback(); await db.end() }
  report.observedAt = new Date().toISOString()
  await output.writeFile(JSON.stringify(report, null, 2) + '\n'); await output.close()
  console.log(JSON.stringify(report))
}
