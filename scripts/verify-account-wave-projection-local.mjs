import { open, readFile } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import { createHash } from 'node:crypto'
import assert from 'node:assert/strict'
import mysql from 'mysql2/promise'
import ts from 'typescript'
import { canonical, hash, inplaceAccountTargets } from './lib/v4-backfill-contract.mjs'
import { accountSourceFields, convertAccountRows } from './lib/v4-account-conversion.mjs'
import { planAccountIdMappings } from './lib/v4-account-id-mapping.mjs'
import { convertOwnershipRows } from './lib/v4-ownership-conversion.mjs'
import { createAccountBackfill } from './lib/v4-account-backfill-writer.mjs'
import { createOwnershipBackfill } from './lib/v4-ownership-backfill-writer.mjs'
import { readAccountBackfillV2Identity } from './lib/mysql-account-backfill-v2.mjs'
import { withInplaceUpgradeLock } from './lib/mysql-inplace-column-store.mjs'

const root = new URL('../', import.meta.url), target = 'dev_vue_m1_source_20260907_02'
const sha = value => createHash('sha256').update(value).digest('hex')
const quote = name => { assert.match(name, /^[a-z][a-z0-9_]*$/); return `\`${name}\`` }
let connection, output, phase = 'arguments'
try {
  const [mode, destination] = process.argv.slice(2)
  assert.ok(mode === '--read-only' && process.argv.length === 4 && isAbsolute(destination))
  output = await open(destination, 'wx', 0o600)
  const chunks = []; for await (const chunk of process.stdin) chunks.push(chunk)
  const credentials = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  assert.equal(credentials.host, '127.0.0.1'); assert.equal(credentials.user, 'root')
  assert.ok(Number.isInteger(credentials.port) && credentials.port > 1024 && credentials.port < 65536)
  const rehearsal = JSON.parse(await readFile(new URL('docs/architecture/account-wave-local-rehearsal-20260908-v3.json', root)))
  assert.equal(rehearsal.target, target); assert.equal(hash(rehearsal.frozen), rehearsal.manifestHash)
  for (const file of rehearsal.frozen.tools) assert.equal(sha(await readFile(new URL(file.path, root))), file.sha256)
  connection = await mysql.createConnection({ host: credentials.host, port: credentials.port, user: credentials.user,
    password: credentials.password, database: target, dateStrings: true, jsonStrings: true, timezone: 'Z',
    supportBigNumbers: true, bigNumberStrings: true, multipleStatements: false, connectTimeout: 5000 })
  await connection.query("SET SESSION time_zone='+00:00'")
  const receipt = await withInplaceUpgradeLock(connection, target, async () => {
    await connection.query('START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY')
    try {
      phase = 'identity'
      assert.deepEqual(await readAccountBackfillV2Identity(connection), rehearsal.frozen.targetIdentity)
      const columns = accountSourceFields.map(name => ['id', 'user_id', 'is_deleted'].includes(name) ? `CAST(${quote(name)} AS CHAR) ${quote(name)}` : quote(name)).join(',')
      const [rows] = await connection.query(`SELECT ${columns} FROM trading_accounts ORDER BY id`)
      const [users] = await connection.query('SELECT CAST(id AS CHAR) id,deletion_status,deleted_at FROM users ORDER BY id')
      const [terminals] = await connection.query('SELECT terminal_instance_id id,CAST(user_id AS CHAR) userId,platform,broker_server server,login_account login FROM bridge_v3_terminal_sessions ORDER BY terminal_instance_id')
      const [bindings] = await connection.query('SELECT broker_server_key server,login_account login,CAST(current_user_id AS CHAR) currentUserId,CAST(current_trading_account_id AS CHAR) currentAccountId,account_currency currency FROM mt5_account_bindings ORDER BY broker_server_key,login_account')
      const [intervals] = await connection.query('SELECT CAST(id AS CHAR) id,broker_server_key,login_account,CAST(user_id AS CHAR) user_id,CAST(trading_account_id AS CHAR) trading_account_id,started_at,ended_at,end_reason,created_at,updated_at FROM mt5_account_ownership_history ORDER BY id')
      const accounts = rows.map(row => ({ id: row.id, userId: row.user_id, server: row.broker_server, login: row.login_account }))
      const input = Object.fromEntries(Object.entries({ accounts, terminals, bindings }).map(([key, values]) => [key, values.map(row => ({ ...row, sourceHash: hash({ ...row }) }))]))
      const plan = planAccountIdMappings('dev_vue', input, accounts.map(row => row.id)), userIds = new Set(users.map(row => row.id))
      const basis = sourceTable => ({ sourceTable, offsetMinutes: 0, evidenceId: 'user-confirmed-legacy-utc-20260908' })
      const converted = convertAccountRows(rows, plan, { userIds, timeBasis: basis('trading_accounts') })
      assert.equal(converted.sourceHash, rehearsal.frozen.account.sourceHash)
      const history = convertOwnershipRows(intervals, { logicalSourceId: 'dev_vue', accountMap: plan.ownershipMap, userIds, timeBasis: basis('mt5_account_ownership_history') })
      assert.equal(createAccountBackfill(rows, plan, { userIds, timeBasis: basis('trading_accounts') }, { preserveSource: true }).transformHash, rehearsal.frozen.account.transformHash)
      assert.equal(createOwnershipBackfill(intervals, { logicalSourceId: 'dev_vue', accountMap: plan.ownershipMap, userIds, timeBasis: basis('mt5_account_ownership_history') },
        { expectedSourceIds: intervals.map(row => row.id), preserveSource: true }).transformHash, rehearsal.frozen.ownership.transformHash)
      const expected = { trading_accounts: converted.entities.map(row => row.target), user_trading_account_settings: converted.settings.map(row => row.target),
        trading_account_ownership_intervals: history.entries.map(row => row.target), trading_account_ownerships: history.grants }
      phase = 'full-row-comparison'
      const comparisons = []
      for (const [logical, values] of Object.entries(expected)) {
        assert.ok(values.length)
        const physical = inplaceAccountTargets[logical], names = Object.keys(values[0])
        const [types] = await connection.execute('SELECT COLUMN_NAME name,DATA_TYPE type FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=?', [physical])
        const byName = new Map(types.map(row => [row.name, row.type]))
        const select = names.map(name => {
          assert.ok(byName.has(name))
          const column = quote(name), type = byName.get(name)
          return ['int', 'bigint', 'tinyint', 'smallint'].includes(type) ? `CAST(${column} AS CHAR) ${column}`
            : type === 'datetime' ? `DATE_FORMAT(${column},'%Y-%m-%d %H:%i:%s.%f') ${column}` : column
        })
        const [actual] = await connection.query(`SELECT ${select.join(',')} FROM ${quote(physical)}`)
        for (const row of actual) for (const name of names) if (byName.get(name) === 'datetime' && row[name] !== null) {
          assert.match(row[name], /\.\d{3}000$/); row[name] = row[name].slice(0, -3)
        }
        const normalized = actual.map(row => canonical({ ...row })).sort(), expectedNormalized = values.map(canonical).sort()
        assert.deepEqual(normalized, expectedNormalized)
        comparisons.push({ table: physical, rows: actual.length, columns: names.length, sha256: hash(normalized) })
      }
      phase = 'ownership-predicate'
      const source = await readFile(new URL('server/src/modules/trading/infrastructure/mysql-account-registration.ts', root), 'utf8')
      const ast = ts.createSourceFile('mysql-account-registration.ts', source, ts.ScriptTarget.Latest, true)
      const statements = []
      function visit(node) {
        if (ts.isMethodDeclaration(node) && node.name.getText(ast) === 'lockCurrentOwnership') {
          function sql(child) { if (ts.isCallExpression(child) && ts.isPropertyAccessExpression(child.expression) && child.expression.name.text === 'execute') statements.push(child.arguments[0].text); ts.forEachChild(child, sql) }
          sql(node)
        } else ts.forEachChild(node, visit)
      }
      visit(ast); assert.equal(statements.length, 1); assert.match(statements[0], /FOR UPDATE$/)
      let projection = statements[0].replace(/FOR UPDATE$/, '')
      for (const [logical, physical] of Object.entries(inplaceAccountTargets)) projection = projection.replace(new RegExp(`\\b${logical}\\b`, 'g'), physical)
      let allowed = 0, denied = 0
      for (const user of users) for (const entity of converted.entities) {
        const grants = history.grants.filter(grant => grant.user_id === user.id && grant.trading_account_id === entity.target.id && grant.revoked_at_utc === null)
        const permitted = user.deletion_status === 'active' && user.deleted_at === null && grants.length === 1
        const [result] = await connection.execute(projection, [user.id, entity.target.id])
        assert.equal(result.length, permitted ? 1 : 0)
        if (permitted) { assert.equal(String(result[0].ownership_revision), '1'); assert.equal(result[0].interval_id, grants[0].interval_id); allowed++ } else denied++
      }
      return { kind: 'account-wave-projection-verification/v1', observedAt: new Date().toISOString(), target, databaseWrites: 0,
        rehearsalManifestHash: rehearsal.manifestHash, comparisons, ownerPairs: { allowed, denied }, runtimeSourceSha256: sha(source),
        scope: 'Exact target business columns and current-owner predicate using build table names; excludes lock concurrency, Bridge credentials, quotas and full API permissions.' }
    } finally { await connection.rollback() }
  })
  await output.writeFile(JSON.stringify(receipt, null, 2) + '\n')
  console.log(JSON.stringify({ status: 'verified', comparisons: receipt.comparisons, ownerPairs: receipt.ownerPairs, databaseWrites: 0 }))
} catch (error) {
  const code = /^[a-zA-Z][a-zA-Z0-9_]+$/.test(error?.code ?? '') ? error.code : 'account_projection_verification_failed'
  if (output) await output.writeFile(JSON.stringify({ failed: true, code, phase }) + '\n').catch(() => {})
  console.error(JSON.stringify({ code, phase })); process.exitCode = 1
} finally { if (connection) await connection.end().catch(() => {}); if (output) await output.close().catch(() => {}) }
