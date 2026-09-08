import assert from 'node:assert/strict'
import { readFile, open } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import { fileURLToPath } from 'node:url'
import mysql from 'mysql2/promise'
import { hash } from './lib/v4-backfill-contract.mjs'
import { sha256 } from './lib/v4-migration-plan.mjs'
import { withInplaceUpgradeLock } from './lib/mysql-inplace-column-store.mjs'
import { loadAccountProjectionMigration } from './lib/inplace-account-projection-migration.mjs'
import { mysqlAccountProjectionMigrationStore } from './lib/mysql-account-projection-migration.mjs'
import { coordinateAccountProjectionMigration } from './lib/account-projection-coordinator.mjs'
import { planAccountIdMappings } from './lib/v4-account-id-mapping.mjs'
import { planLegacyCandleSources, planLegacyCandleConversion } from './lib/legacy-candle-conversion.mjs'

const root = new URL('../', import.meta.url), target = 'dev_vue_m1_source_20260907_02'
const path = name => fileURLToPath(new URL('docs/architecture/' + name, root))
let db, output, phase = 'arguments', readCounts
try {
  const [mode, destination] = process.argv.slice(2)
  assert.ok(mode === '--read-only-restored' && process.argv.length === 4 && isAbsolute(destination ?? ''))
  output = await open(destination, 'wx', 0o600)
  const chunks = []; for await (const chunk of process.stdin) chunks.push(chunk)
  const credentials = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  assert.ok(credentials.host === '127.0.0.1' && credentials.user === 'root' && Number.isInteger(credentials.port)
    && credentials.port > 1024 && credentials.port < 65536)
  db = await mysql.createConnection({ host: credentials.host, port: credentials.port, user: credentials.user, password: credentials.password,
    database: target, dateStrings: true, jsonStrings: true, timezone: 'Z', supportBigNumbers: true, bigNumberStrings: true,
    multipleStatements: false, connectTimeout: 5000 })
  await db.query("SET SESSION time_zone='+00:00'")
  const [[identity]] = await db.query('SELECT DATABASE() databaseName,@@server_uuid serverUuid,@@version version')
  assert.equal(identity.databaseName, target); assert.equal(identity.serverUuid, 'ac423207-6ef3-11f1-b302-000c29fda104')
  const report = await withInplaceUpgradeLock(db, target, async () => {
    phase = 'registered-history'
    const plan = await loadAccountProjectionMigration(root)
    const store = await mysqlAccountProjectionMigrationStore(db, plan, root,
      path('account-projection-registered-plan-20260908.json'), path('observer-context-registered-plan-20260908.json'),
      path('terminal-route-registered-plan-20260908.json'), path('account-root-registered-plan-20260908.json'))
    assert.ok((await coordinateAccountProjectionMigration(store, plan)).steps.every(step => step.status === 'completed'))
    const rootStore = store.priorStore.priorStore.rootStore
    const beforeSnapshot = hash(await rootStore.snapshot()), beforeHistory = hash(await store.history())
    await db.query('START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY')
    let sourcePlan, conversion
    try {
      phase = 'account-source-mapping'
      const [accounts] = await db.query('SELECT CAST(id AS CHAR) id,CAST(user_id AS CHAR) userId,broker_server server,login_account login FROM trading_accounts_legacy_v3 ORDER BY id LIMIT 10001')
      const [terminals] = await db.query('SELECT terminal_instance_id id,CAST(user_id AS CHAR) userId,platform,broker_server server,login_account login FROM bridge_v3_terminal_sessions ORDER BY terminal_instance_id LIMIT 10001')
      const [bindings] = await db.query('SELECT broker_server_key server,login_account login,CAST(current_user_id AS CHAR) currentUserId,CAST(current_trading_account_id AS CHAR) currentAccountId,account_currency currency FROM mt5_account_bindings ORDER BY broker_server_key,login_account LIMIT 10001')
      assert.ok([accounts, terminals, bindings].every(rows => rows.length <= 10000))
      const input = Object.fromEntries(Object.entries({ accounts, terminals, bindings }).map(([key, rows]) =>
        [key, rows.map(row => ({ ...row, sourceHash: hash({ ...row }) }))]))
      const accountPlan = planAccountIdMappings('dev_vue', input, accounts.map(row => row.id))
      const reviewed = JSON.parse(await readFile(path('account-reference-review-20260908-v4.json'), 'utf8'))
      assert.equal(accountPlan.mappingHash, reviewed.mappingHash)
      const [sources] = await db.query('SELECT CAST(id AS CHAR) id,CAST(bridge_user_id AS CHAR) userId,broker_server server,CAST(account_login AS CHAR) login FROM market_data_sources ORDER BY id LIMIT 10001')
      sourcePlan = planLegacyCandleSources(sources, accountPlan)
      phase = 'bounded-candle-read'
      const [[count]] = await db.query('SELECT CAST(COUNT(*) AS CHAR) total FROM market_candles')
      readCounts = { expected: String(count.total), read: 0, countType: typeof count.total }
      if (BigInt(count.total) > 100000n) throw Error('legacy_candle_source_row_budget')
      const rows = []; let cursor = '0'
      for (;;) {
        // Qualify the numeric base column: ORDER BY id would sort the CAST alias lexically.
        const [page] = await db.execute('SELECT CAST(id AS CHAR) id,CAST(source_id AS CHAR) source_id,broker_symbol,standard_symbol,timeframe,CAST(open_time_utc_msc AS CHAR) open_time_utc_msc,broker_time,open_price,high_price,low_price,close_price,CAST(tick_volume AS CHAR) tick_volume,CAST(spread AS CHAR) spread,updated_at FROM market_candles WHERE market_candles.id > ? ORDER BY market_candles.id LIMIT 500', [cursor])
        if (!page.length) break
        if (BigInt(page[0].id) <= BigInt(cursor)) throw Error('legacy_candle_cursor_not_advancing')
        if (rows.length + page.length > 100000) throw Error('legacy_candle_page_row_budget')
        rows.push(...page); cursor = page.at(-1).id
        readCounts.read = rows.length
      }
      if (String(rows.length) !== count.total) throw Error('legacy_candle_read_count_mismatch')
      phase = 'conversion'
      const basis = { closedPolicy: 'legacy-closed-writer/v1', symbolPolicy: 'stored-standard-symbol/v1',
        writerHash: sha256(await readFile(new URL('server/routes/ai/platform-market-data.js', root))), revision: '1' }
      conversion = planLegacyCandleConversion(rows, sourcePlan, basis)
    } finally { await db.rollback() }
    phase = 'unchanged-verification'
    assert.equal(hash(await rootStore.snapshot()), beforeSnapshot)
    assert.equal(hash(await store.history()), beforeHistory)
    const { mappings, projections, ...summary } = conversion
    assert.equal(hash(mappings), summary.mappingHash); assert.equal(hash(projections), summary.projectionHash)
    return { kind: 'legacy-candle-conversion-rehearsal/v1', observedAt: new Date().toISOString(), identity,
      registrySteps: plan.steps.length, sourcePlan, conversion: summary,
      snapshotHash: beforeSnapshot, historyHash: beforeHistory,
      conversionToolHash: sha256(await readFile(new URL('scripts/lib/legacy-candle-conversion.mjs', root))),
      captureToolHash: sha256(await readFile(new URL('scripts/rehearse-legacy-candle-conversion-local.mjs', root))),
      databaseWrites: 0, scope: 'Read-only conversion of restored legacy rows; no persisted backfill, table promotion, authorization grant or live market trust.' }
  })
  await output.writeFile(JSON.stringify(report, null, 2) + '\n'); await output.sync()
  console.log(JSON.stringify({ inputRows: report.conversion.inputRows, outputRows: report.conversion.outputRows,
    duplicateRows: report.conversion.duplicateRows, planHash: report.conversion.planHash, databaseWrites: 0 }))
} catch (error) {
  const code = /^legacy_candle_[a-z_]+$/.test(error?.message ?? '') ? error.message : 'legacy_candle_rehearsal_failed'
  const failure = { failed: true, code, phase, readCounts, databaseError: /^ER_[A-Z_]+$/.test(error?.code ?? '') ? error.code : undefined }
  if (output) { await output.writeFile(JSON.stringify(failure) + '\n').catch(() => {}); await output.sync().catch(() => {}) }
  console.error(JSON.stringify(failure)); process.exitCode = 1
} finally { if (db) await db.end().catch(() => {}); if (output) await output.close().catch(() => {}) }
