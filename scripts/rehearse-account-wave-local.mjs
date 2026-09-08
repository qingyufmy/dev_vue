import { open, readFile, readdir } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import { randomUUID, createHash } from 'node:crypto'
import assert from 'node:assert/strict'
import mysql from 'mysql2/promise'
import { hash } from './lib/v4-backfill-contract.mjs'
import { accountSourceFields } from './lib/v4-account-conversion.mjs'
import { planAccountIdMappings } from './lib/v4-account-id-mapping.mjs'
import { reviewAccountOwnership } from './lib/v4-account-ownership-consistency.mjs'
import { createAccountBackfill } from './lib/v4-account-backfill-writer.mjs'
import { createOwnershipBackfill } from './lib/v4-ownership-backfill-writer.mjs'
import { readAccountBackfillV2Identity, MysqlAccountBackfillV2Repository } from './lib/mysql-account-backfill-v2.mjs'
import { withInplaceUpgradeLock } from './lib/mysql-inplace-column-store.mjs'
import { readOriginalRows } from './lib/inplace-column-evidence.mjs'
import { prepareBackfillRun, executeBackfillBatch, recoverBackfillBatch } from './lib/v4-backfill-runner.mjs'

const root = new URL('../', import.meta.url)
const target = 'dev_vue_m1_source_20260907_02'
const build = ['trading_accounts_v4_build', 'user_trading_account_settings_v4_build', 'trading_account_ownership_intervals_v4_build', 'trading_account_ownerships_v4_build']
const ledger = ['data_migration_runs', 'data_migration_checkpoints', 'data_migration_batches', 'data_migration_id_maps', 'data_migration_row_receipts', 'data_migration_source_rows']
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
let control, pool, output, phase = 'arguments'
try {
  const [mode, destination] = process.argv.slice(2)
  assert.ok(mode === '--apply-restored-only' && process.argv.length === 4 && isAbsolute(destination))
  output = await open(destination, 'wx', 0o600)
  const chunks = []
  for await (const chunk of process.stdin) chunks.push(chunk)
  const credentials = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  assert.equal(credentials.host, '127.0.0.1')
  assert.ok(Number.isInteger(credentials.port) && credentials.port > 1024 && credentials.port < 65536)
  assert.equal(credentials.user, 'root')
  const options = { host: credentials.host, port: credentials.port, user: credentials.user, password: credentials.password,
    database: target, dateStrings: true, jsonStrings: true, timezone: 'Z', supportBigNumbers: true, bigNumberStrings: true,
    multipleStatements: false, connectTimeout: 5000, connectionLimit: 2 }
  phase = 'connect'
  control = await mysql.createConnection(options)
  pool = mysql.createPool(options)
  await control.query("SET SESSION time_zone='+00:00'")
  const [[identity]] = await control.query('SELECT DATABASE() db,@@server_uuid uuid')
  assert.equal(identity.db, target)
  assert.equal(identity.uuid, 'ac423207-6ef3-11f1-b302-000c29fda104')
  const paths = ['scripts/rehearse-account-wave-local.mjs', 'package.json', 'pnpm-lock.yaml',
    ...(await readdir(new URL('scripts/lib/', root))).filter(name => name.endsWith('.mjs')).map(name => `scripts/lib/${name}`)]
  const tools = await Promise.all(paths.sort().map(async path => ({ path, sha256: sha(await readFile(new URL(path, root))) })))
  const baseline = JSON.parse(await readFile(new URL('docs/architecture/account-root-cutover-review-20260908-v3.json', root)))
  const receipt = await withInplaceUpgradeLock(control, target, async () => {
    phase = 'schema'
    const targetIdentity = await readAccountBackfillV2Identity(control)
    const count = async table => {
      assert.ok([...build, ...ledger, 'trading_accounts', 'mt5_account_ownership_history'].includes(table))
      return (await control.query(`SELECT CAST(COUNT(*) AS CHAR) n FROM \`${table}\``))[0][0].n
    }
    phase = 'empty-target'
    for (const table of build) assert.equal(await count(table), '0', `nonempty ${table}`)
    const beforeLedger = Object.fromEntries(await Promise.all(ledger.map(async table => [table, await count(table)])))
    const [metadata] = await control.query('SELECT TABLE_NAME table_name,COLUMN_NAME column_name,COLUMN_KEY column_key FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() ORDER BY TABLE_NAME,ORDINAL_POSITION')
    const tables = new Map()
    for (const row of metadata) {
      if (!tables.has(row.table_name)) tables.set(row.table_name, { name: row.table_name, columns: [], primary: [] })
      const table = tables.get(row.table_name)
      table.columns.push(row.column_name)
      if (row.column_key === 'PRI') table.primary.push(row.column_name)
    }
    const quote = name => { assert.match(name, /^[a-z][a-z0-9_]*$/); return `\`${name}\`` }
    const priorLedgerRows = []
    for (const name of ledger) {
      const table = tables.get(name)
      assert.ok(table.primary.length)
      const [values] = await control.query(`SELECT ${table.columns.map(quote).join(',')} FROM ${quote(name)} ORDER BY ${table.primary.map(quote).join(',')}`)
      priorLedgerRows.push({ table, values })
    }
    const [[existingAccountMaps]] = await control.query("SELECT COUNT(*) n FROM data_migration_id_maps WHERE logical_source_id='dev_vue' AND source_table IN ('trading_accounts','mt5_account_ownership_history')")
    assert.equal(Number(existingAccountMaps.n), 0)
    const protectedTables = [...tables.values()].filter(table => ![...build, ...ledger].includes(table.name))
    const protectedBefore = await readOriginalRows(control, protectedTables)
    await control.query('START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY')
    let rows, users, terminals, bindings, intervals
    try {
      const columns = accountSourceFields.map(name => ['id', 'user_id', 'is_deleted'].includes(name) ? `CAST(\`${name}\` AS CHAR) \`${name}\`` : `\`${name}\``).join(',')
      ;[rows] = await control.query(`SELECT ${columns} FROM trading_accounts ORDER BY id`)
      ;[users] = await control.query('SELECT CAST(id AS CHAR) id FROM users ORDER BY id')
      ;[terminals] = await control.query('SELECT terminal_instance_id id,CAST(user_id AS CHAR) userId,platform,broker_server server,login_account login FROM bridge_v3_terminal_sessions ORDER BY terminal_instance_id')
      ;[bindings] = await control.query('SELECT broker_server_key server,login_account login,CAST(current_user_id AS CHAR) currentUserId,CAST(current_trading_account_id AS CHAR) currentAccountId,account_currency currency FROM mt5_account_bindings ORDER BY broker_server_key,login_account')
      ;[intervals] = await control.query('SELECT CAST(id AS CHAR) id,broker_server_key,login_account,CAST(user_id AS CHAR) user_id,CAST(trading_account_id AS CHAR) trading_account_id,started_at,ended_at,end_reason,created_at,updated_at FROM mt5_account_ownership_history ORDER BY id')
    } finally { await control.rollback() }
    phase = 'source-conversion'
    const accounts = rows.map(row => ({ id: row.id, userId: row.user_id, server: row.broker_server, login: row.login_account }))
    const input = Object.fromEntries(Object.entries({ accounts, terminals, bindings }).map(([key, values]) => [key, values.map(row => ({ ...row, sourceHash: hash({ ...row }) }))]))
    const plan = planAccountIdMappings('dev_vue', input, accounts.map(row => row.id)), userIds = new Set(users.map(row => row.id))
    const ownership = reviewAccountOwnership({ accounts: rows, bindings, intervals, accountMap: plan.ownershipMap, userIds })
    assert.equal(ownership.currentOwnershipConsistent, true)
    assert.equal(ownership.evidenceHash, baseline.ownership.evidenceHash)
    assert.equal(plan.mappingHash, baseline.mappingHash)
    const basis = sourceTable => ({ sourceTable, offsetMinutes: 0, evidenceId: 'user-confirmed-legacy-utc-20260908' })
    const account = createAccountBackfill(rows, plan, { userIds, timeBasis: basis('trading_accounts') }, { batchSize: 2, preserveSource: true })
    assert.equal(account.sourceHash, baseline.sourceHash)
    const history = createOwnershipBackfill(intervals, { logicalSourceId: 'dev_vue', accountMap: plan.ownershipMap, userIds, timeBasis: basis('mt5_account_ownership_history') },
      { batchSize: 64, expectedSourceIds: intervals.map(row => row.id), preserveSource: true })
    const frozen = { targetIdentity, tools, protectedBefore, beforeLedger, account: { sourceHash: account.sourceHash, transformHash: account.transformHash },
      ownership: { evidenceHash: ownership.evidenceHash, transformHash: history.transformHash }, timeOffsetMinutes: 0 }
    let loseCommitResponse = false
    const repository = new MysqlAccountBackfillV2Repository({ getConnection: async () => {
      const connection = await pool.getConnection()
      return new Proxy(connection, { get(object, key) {
        if (key === 'commit') return async () => { await object.commit(); if (loseCommitResponse) { loseCommitResponse = false; throw Error('injected_lost_commit_response') } }
        const value = Reflect.get(object, key)
        return typeof value === 'function' ? value.bind(object) : value
      } })
    } })
    const runs = []
    for (const [index, prepared] of [account, history].entries()) {
      const spec = { runId: randomUUID(), admission: { approved: true, blockers: [] }, bindings: {
        logicalSourceId: 'dev_vue', sourceDatabase: target, mirrorDatabase: 'dev_vue', storageMode: 'inplace-account-v2',
        snapshotHash: hash({ account: account.sourceHash, ownership: ownership.evidenceHash }), targetServerUuid: identity.uuid,
        targetDatabase: target, schemaHash: targetIdentity.schemaHash, manifestHash: hash(frozen), transformHash: prepared.transformHash, streams: [prepared.stream] } }
      phase = `stream-${index}-prepare`
      await prepareBackfillRun(repository, spec)
      if (index === 0) {
        phase = 'rollback-fault'
        await assert.rejects(executeBackfillBatch(repository, spec, prepared.batches[0], { ...prepared.writer,
          write: async (connection, row) => { await prepared.writer.write(connection, row); throw Error('injected_after_write') } }), /backfill_storage_failed/)
        for (const table of build) assert.equal(await count(table), '0')
        phase = 'commit-unknown-fault'
        loseCommitResponse = true
        await assert.rejects(executeBackfillBatch(repository, spec, prepared.batches[0], prepared.writer), /backfill_commit_unknown/)
        assert.equal((await recoverBackfillBatch(repository, spec, prepared.batches[0])).status, 'committed')
      }
      phase = `stream-${index}-batches`
      for (const batch of prepared.batches) {
        assert.equal((await executeBackfillBatch(repository, spec, batch, prepared.writer)).status, 'committed')
        assert.equal((await executeBackfillBatch(repository, spec, batch, prepared.writer)).status, 'committed')
      }
      runs.push({ runId: spec.runId, stream: prepared.stream, batches: prepared.batches.length, rows: prepared.sourceRows ?? intervals.length })
    }
    phase = 'reconciliation'
    const counts = Object.fromEntries(await Promise.all([...build, ...ledger].map(async name => [name, await count(name)])))
    assert.equal(counts[build[0]], '3'); assert.equal(counts[build[1]], '4'); assert.equal(counts[build[2]], '274'); assert.equal(counts[build[3]], '4')
    for (const name of ['data_migration_row_receipts', 'data_migration_source_rows', 'data_migration_id_maps']) assert.equal(BigInt(counts[name]) - BigInt(beforeLedger[name]), 278n)
    assert.equal(await count('trading_accounts'), '4'); assert.equal(await count('mt5_account_ownership_history'), '274')
    assert.deepEqual(await readOriginalRows(control, protectedTables), protectedBefore)
    for (const { table, values } of priorLedgerRows) for (const row of values) {
      const [found] = await control.execute(`SELECT ${table.columns.map(quote).join(',')} FROM ${quote(table.name)} WHERE ${table.primary.map(key => `${quote(key)}=?`).join(' AND ')}`, table.primary.map(key => row[key]))
      assert.deepEqual(found, [row])
    }
    for (const tool of tools) assert.equal(sha(await readFile(new URL(tool.path, root))), tool.sha256)
    return { kind: 'account-wave-local-rehearsal/v2', observedAt: new Date().toISOString(), target, currentDevVueWritten: false,
      manifestHash: hash(frozen), frozen, runs, counts, protectedTables: protectedTables.length, priorLedgerRowsPreserved: true,
      rollbackAfterWrite: true, lostCommitRecovered: true, repeatedBatches: true,
      scope: 'Real restored-database batches only; no formal table promotion or current dev_vue backfill.' }
  })
  await output.writeFile(JSON.stringify(receipt, null, 2) + '\n')
  console.log(JSON.stringify({ status: 'rehearsed', target, counts: receipt.counts, rollbackAfterWrite: true, lostCommitRecovered: true, currentDevVueWritten: false }))
} catch (error) {
  const code = /^[a-zA-Z][a-zA-Z0-9_]+$/.test(error?.code ?? '') ? error.code : 'account_wave_rehearsal_failed'
  if (output) await output.writeFile(JSON.stringify({ failed: true, code, target, phase }) + '\n').catch(() => {})
  console.error(JSON.stringify({ code, phase })); process.exitCode = 1
} finally { if (pool) await pool.end().catch(() => {}); if (control) await control.end().catch(() => {}); if (output) await output.close().catch(() => {}) }
