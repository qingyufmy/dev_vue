import assert from 'node:assert/strict'
import { open, readFile } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import mysql from 'mysql2/promise'
import { sha256 } from './lib/v4-migration-plan.mjs'
import { hash } from './lib/v4-backfill-contract.mjs'
import { withInplaceUpgradeLock } from './lib/mysql-inplace-column-store.mjs'
import { readAccountBackfillV2Identity } from './lib/mysql-account-backfill-v2.mjs'
import { readAccountRootSnapshot } from './lib/mysql-account-root-snapshot.mjs'
import { accountRootMigrationSnapshot } from './lib/inplace-account-root-migration.mjs'

const root = new URL('../', import.meta.url), target = 'dev_vue_m1_source_20260907_02'
let connection, output
try {
  const [mode, destination] = process.argv.slice(2)
  assert.ok(mode === '--read-only' && isAbsolute(destination) && process.argv.length === 4)
  output = await open(destination, 'wx', 0o600)
  const chunks = []; for await (const chunk of process.stdin) chunks.push(chunk)
  const credentials = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  assert.equal(credentials.host, '127.0.0.1'); assert.equal(credentials.user, 'root')
  assert.ok(Number.isInteger(credentials.port) && credentials.port > 1024 && credentials.port < 65536)
  const config = { host: credentials.host, port: credentials.port, user: credentials.user, password: credentials.password,
    dateStrings: true, jsonStrings: true, timezone: 'Z', supportBigNumbers: true, bigNumberStrings: true, multipleStatements: false, connectTimeout: 5000 }
  connection = await mysql.createConnection({ ...config, database: target })
  await connection.query("SET SESSION time_zone='+00:00'")
  const [[identity]] = await connection.query('SELECT DATABASE() db,@@server_uuid uuid')
  assert.equal(identity.db, target); assert.equal(identity.uuid, 'ac423207-6ef3-11f1-b302-000c29fda104')
  const restored = await withInplaceUpgradeLock(connection, target, async () => {
    const proof = JSON.parse(await readFile(new URL('docs/architecture/account-root-registered-plan-20260908.json', root)))
    const { proofHash, ...body } = proof; assert.equal(hash(body), proofHash)
    const actual = accountRootMigrationSnapshot((await readAccountRootSnapshot(connection)).tables)
    assert.equal(hash(actual), hash(proof.after))
    const previous = JSON.parse(await readFile(new URL('docs/architecture/account-root-promotion-rehearsal-20260908-v2.json.plan.json', root)))
    const expected = previous.before.find(row => row.name === 'database_upgrade_steps_v4')
    const [rows] = await connection.query({ sql: 'SELECT id,checksum_sha256,status,started_at_utc,completed_at_utc FROM database_upgrade_steps_v4 WHERE id <> ? ORDER BY id',
      values: ['inplace_035_01_account_root_promotion'], rowsAsArray: true })
    assert.equal(rows.length, expected.rows); assert.equal(sha256(rows.map(row => JSON.stringify(row) + '\n').join('')), expected.rowsSha256)
    const [[journal]] = await connection.query("SELECT COUNT(*) steps,SUM(status='completed') completed FROM database_upgrade_steps_v4")
    assert.equal(Number(journal.steps), 148); assert.equal(Number(journal.completed), 148)
    return { target, proofHash, tables: actual.length, completedSteps: 148, original147JournalRowsUnchanged: true,
      allNonJournalRowsAndDdlMatchPromotion: true }
  })
  await connection.end(); connection = await mysql.createConnection({ ...config, database: 'dev_vue' })
  await connection.query("SET SESSION time_zone='+00:00'")
  const current = await withInplaceUpgradeLock(connection, 'dev_vue', async () => {
    const identity = await readAccountBackfillV2Identity(connection)
    assert.equal(identity.serverUuid, 'ac423207-6ef3-11f1-b302-000c29fda104')
    const counts = {}
    for (const table of ['trading_accounts', 'trading_accounts_v4_build', 'trading_account_ownership_intervals_v4_build', 'trading_account_ownerships_v4_build', 'user_trading_account_settings_v4_build']) {
      const [[row]] = await connection.query(`SELECT COUNT(*) n FROM \`${table}\``); counts[table] = Number(row.n)
    }
    assert.deepEqual(Object.values(counts), [4, 0, 0, 0, 0])
    return { database: 'dev_vue', verifiedSteps: 147, accountCounts: counts }
  })
  const receipt = { kind: 'account-root-registered-result-verification/v1', observedAt: new Date().toISOString(), restored, current,
    databaseWrites: 0, toolSha256: sha256(await readFile(new URL('scripts/verify-account-root-registered-result-local.mjs', root))) }
  await output.writeFile(JSON.stringify(receipt, null, 2) + '\n'); console.log(JSON.stringify(receipt))
} catch {
  const code = 'account_root_registered_result_failed'
  if (output) await output.writeFile(JSON.stringify({ failed: true, code }) + '\n').catch(() => {})
  console.error(JSON.stringify({ code })); process.exitCode = 1
} finally { if (connection) await connection.end().catch(() => {}); if (output) await output.close().catch(() => {}) }
