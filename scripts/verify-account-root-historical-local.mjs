import assert from 'node:assert/strict'
import { open, readFile } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import mysql from 'mysql2/promise'
import { hash } from './lib/v4-backfill-contract.mjs'
import { sha256 } from './lib/v4-migration-plan.mjs'
import { mysqlColumnStore, verifyInplaceJournal, withInplaceUpgradeLock } from './lib/mysql-inplace-column-store.mjs'
import { loadSubscriptionForeignKeyCoordinator } from './lib/inplace-subscription-foreign-key-schema.mjs'
import { coordinateInplaceSchema } from './lib/inplace-schema-coordinator.mjs'
import { promotedAccountHistoricalStore } from './lib/account-root-historical-schema.mjs'

const root = new URL('../', import.meta.url), target = 'dev_vue_m1_source_20260907_02'
let connection, output
try {
  const [mode, destination] = process.argv.slice(2)
  assert.ok(mode === '--read-only-restored' && isAbsolute(destination) && process.argv.length === 4)
  output = await open(destination, 'wx', 0o600)
  const chunks = []; for await (const chunk of process.stdin) chunks.push(chunk)
  const credentials = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  assert.equal(credentials.host, '127.0.0.1'); assert.equal(credentials.user, 'root')
  assert.ok(Number.isInteger(credentials.port) && credentials.port > 1024 && credentials.port < 65536)
  connection = await mysql.createConnection({ host: credentials.host, port: credentials.port, user: credentials.user, password: credentials.password,
    database: target, dateStrings: true, jsonStrings: true, timezone: 'Z', supportBigNumbers: true, bigNumberStrings: true, multipleStatements: false, connectTimeout: 5000 })
  await connection.query("SET SESSION time_zone='+00:00'")
  const [[identity]] = await connection.query('SELECT DATABASE() db,@@server_uuid uuid')
  assert.equal(identity.db, target); assert.equal(identity.uuid, 'ac423207-6ef3-11f1-b302-000c29fda104')
  const receipt = await withInplaceUpgradeLock(connection, target, async () => {
    assert.equal(await verifyInplaceJournal(connection), true)
    const plan = await loadSubscriptionForeignKeyCoordinator(root)
    assert.equal(plan.steps.length, 147)
    const history = await mysqlColumnStore(connection, true).history()
    const result = await coordinateInplaceSchema(await promotedAccountHistoricalStore(connection, plan, history), plan)
    assert.ok(result.structureComplete && result.steps.every(step => step.status === 'completed'))
    const [references] = await connection.query("SELECT REFERENCED_TABLE_NAME parent FROM information_schema.KEY_COLUMN_USAGE WHERE CONSTRAINT_SCHEMA=DATABASE() AND TABLE_NAME='strategy_subscriptions' AND CONSTRAINT_NAME='fk_strategy_subscriptions_account'")
    assert.deepEqual(references.map(row => row.parent), ['trading_accounts_legacy_v3'])
    const paths = ['scripts/verify-account-root-historical-local.mjs', 'scripts/lib/account-root-historical-schema.mjs', 'scripts/lib/account-root-promotion.mjs']
    return { kind: 'account-root-historical-schema-verification/v1', observedAt: new Date().toISOString(), target,
      physicalState: 'promoted', priorSteps: result.steps.length, priorRegistryHash: hash(plan.steps.map(({ id, checksum }) => ({ id, checksum }))),
      priorStructureComplete: result.structureComplete, legacySubscriptionParent: references[0].parent,
      tools: await Promise.all(paths.map(async path => ({ path, sha256: sha256(await readFile(new URL(path, root))) }))),
      databaseWrites: 0, currentDevVueWritten: false,
      scope: 'Read-only verification of the prior registry against physically promoted restored tables; not a registered promotion migration.' }
  })
  await output.writeFile(JSON.stringify(receipt, null, 2) + '\n')
  console.log(JSON.stringify(receipt))
} catch (error) {
  const code = /^account_historical_[a-z_]+$/.test(error?.message ?? '') ? error.message : 'account_historical_verification_failed'
  if (output) await output.writeFile(JSON.stringify({ failed: true, code, target }) + '\n').catch(() => {})
  console.error(JSON.stringify({ code })); process.exitCode = 1
} finally { if (connection) await connection.end().catch(() => {}); if (output) await output.close().catch(() => {}) }
