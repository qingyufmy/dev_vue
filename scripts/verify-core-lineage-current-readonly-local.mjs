import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile, open } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import mysql from 'mysql2/promise'
import { parse } from 'dotenv'
import { readLegacySignalArchive, readLegacyExecutionArchive } from './lib/legacy-trading-archive-reader.mjs'

const [destination] = process.argv.slice(2)
assert.ok(process.argv.length === 3 && isAbsolute(destination ?? ''))
const env = parse(await readFile(new URL('../server/.env', import.meta.url)))
assert.equal(env.MYSQL_HOST, '192.168.1.254'); assert.equal(env.MYSQL_DATABASE, 'dev_vue')
const output = await open(destination, 'wx', 0o600)
const report = { kind: 'core-legacy-lineage-current/v1', passed: false, writes: 0, checks: [] }
const quote = value => { assert.match(value, /^[a-zA-Z_][a-zA-Z0-9_]*$/); return '`' + value + '`' }
let db
try {
  db = await mysql.createConnection({ host: env.MYSQL_HOST, port: Number(env.MYSQL_PORT), user: env.MYSQL_USER,
    password: env.MYSQL_PASSWORD, database: env.MYSQL_DATABASE, timezone: 'Z', dateStrings: true,
    supportBigNumbers: true, bigNumberStrings: true, jsonStrings: true })
  await db.query("SET SESSION time_zone='+00:00'")
  await db.query('START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY')
  const [[identity]] = await db.query('SELECT DATABASE() db,@@server_uuid uuid,@@innodb_force_recovery recovery')
  assert.equal(identity.db, 'dev_vue'); assert.equal(identity.uuid, 'ac423207-6ef3-11f1-b302-000c29fda104'); assert.equal(Number(identity.recovery), 0)
  report.identity = identity
  const tables = ['ai_signals','inference_snapshots_legacy_v3','ai_model_tasks_legacy_v3','auto_signal_deliveries',
    'order_intents','risk_decisions','signal_outcomes','signal_outcome_deals']
  report.archives = []
  for (const table of tables) {
    const [fields] = await db.execute('SELECT COLUMN_NAME name,COLUMN_KEY keyKind FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=? ORDER BY ORDINAL_POSITION', [table])
    assert.ok(fields.length && fields.some(row => row.keyKind === 'PRI'))
    const primary = fields.filter(row => row.keyKind === 'PRI').map(row => quote(row.name)).join(',')
    const [rows] = await db.query(`SELECT ${fields.map(row => quote(row.name)).join(',')} FROM ${quote(table)} ORDER BY ${primary}`)
    const digest = createHash('sha256')
    for (const row of rows) digest.update(JSON.stringify(row) + '\n')
    const owner = fields.find(row => ['user_id','owner_user_id'].includes(row.name))?.name
    const owners = owner ? (await db.query(`SELECT ${quote(owner)} user_id,COUNT(*) records FROM ${quote(table)} GROUP BY ${quote(owner)} ORDER BY ${quote(owner)}`))[0] : []
    report.archives.push({ table, records: rows.length, rowSha256: digest.digest('hex'), owners, readDestination: 'retained-legacy-archive', v4RuntimeBackfill: false })
  }
  // Audit every installed core constraint, including composite-key NULL semantics.
  const core = ['strategy_subscriptions','ai_model_tasks','inference_snapshots','inference_snapshot_payloads','market_analyses',
    'ai_trader_runs','trade_decisions','risk_decisions_v4','execution_intents','execution_outcomes','bridge_commands_v4']
  const [keys] = await db.query('SELECT TABLE_NAME child,CONSTRAINT_NAME name,COLUMN_NAME columnName,REFERENCED_TABLE_NAME parent,REFERENCED_COLUMN_NAME parentColumn FROM information_schema.KEY_COLUMN_USAGE WHERE TABLE_SCHEMA=DATABASE() AND REFERENCED_TABLE_NAME IS NOT NULL ORDER BY TABLE_NAME,CONSTRAINT_NAME,ORDINAL_POSITION')
  const groups = new Map()
  for (const key of keys.filter(key => core.includes(key.child))) {
    const id = key.child + ':' + key.name
    if (!groups.has(id)) groups.set(id, [])
    groups.get(id).push(key)
  }
  report.foreignKeys = []
  for (const group of groups.values()) {
    const first = group[0]
    const nonNull = group.map(key => 'c.' + quote(key.columnName) + ' IS NOT NULL').join(' AND ')
    const match = group.map(key => 'p.' + quote(key.parentColumn) + '=c.' + quote(key.columnName)).join(' AND ')
    const [[value]] = await db.query(`SELECT COUNT(*) n FROM ${quote(first.child)} c WHERE ${nonNull} AND NOT EXISTS (SELECT 1 FROM ${quote(first.parent)} p WHERE ${match})`)
    report.foreignKeys.push({ table: first.child, name: first.name, parent: first.parent, columns: group.map(key => key.columnName), orphans: String(value.n) })
    assert.equal(String(value.n), '0')
  }
  report.coreTablesWithoutForeignKeys = core.filter(table => !report.foreignKeys.some(key => key.table === table))
  assert.deepEqual(report.coreTablesWithoutForeignKeys, [])
  const relations = {
    snapshot_signal: 'SELECT COUNT(*) n FROM inference_snapshots_legacy_v3 s LEFT JOIN ai_signals a ON a.id=s.signal_id WHERE a.id IS NULL OR NOT(s.owner_user_id <=> a.user_id)',
    signal_task: 'SELECT COUNT(*) n FROM ai_signals a LEFT JOIN ai_model_tasks_legacy_v3 t ON t.task_id=a.inference_task_id WHERE a.inference_task_id IS NOT NULL AND (t.task_id IS NULL OR NOT(t.owner_user_id <=> a.user_id))',
    delivery_intent: 'SELECT COUNT(*) n FROM auto_signal_deliveries d LEFT JOIN order_intents i ON i.id=d.order_intent_id WHERE d.order_intent_id IS NOT NULL AND (i.id IS NULL OR NOT(i.user_id <=> d.user_id))',
    outcome_intent: 'SELECT COUNT(*) n FROM signal_outcomes o LEFT JOIN order_intents i ON i.id=o.order_intent_id WHERE o.order_intent_id IS NOT NULL AND (i.id IS NULL OR NOT(i.user_id <=> o.user_id) OR NOT(i.trading_account_id <=> o.trading_account_id))',
    deal_outcome: 'SELECT COUNT(*) n FROM signal_outcome_deals d LEFT JOIN signal_outcomes o ON o.id=d.outcome_id WHERE o.id IS NULL OR NOT(o.user_id <=> d.user_id) OR NOT(o.trading_account_id <=> d.trading_account_id)',
  }
  report.legacyRelations = {}
  for (const [name, sql] of Object.entries(relations)) report.legacyRelations[name] = String((await db.query(sql))[0][0].n)
  report.amounts = (await db.query('SELECT user_id,trading_account_id,COUNT(*) records,SUM(entry_volume) entry_volume,SUM(closed_volume) closed_volume,SUM(gross_profit) gross_profit,SUM(commission) commission,SUM(swap) swap,SUM(fee) fee,SUM(net_profit) net_profit FROM signal_outcomes GROUP BY user_id,trading_account_id ORDER BY user_id,trading_account_id'))[0]
  report.idMaps = (await db.query('SELECT entity_kind,source_table,COUNT(*) records FROM data_migration_id_maps GROUP BY entity_kind,source_table ORDER BY entity_kind,source_table'))[0]
  report.accountIdentityMappings = (await db.query("SELECT source_pk_json,target_json FROM data_migration_id_maps WHERE entity_kind='trading_account' ORDER BY source_pk_sha256"))[0]
  const [examples] = await db.query('SELECT s.id,s.user_id FROM ai_signals s INNER JOIN inference_snapshots_legacy_v3 p ON p.signal_id=s.id AND p.owner_user_id=s.user_id ORDER BY s.id DESC LIMIT 3')
  assert.ok(examples.length)
  report.archiveReadChecks = []
  for (const row of examples) {
    const value = await readLegacySignalArchive(db, { userId: Number(row.user_id), signalId: String(row.id) })
    assert.ok(value && value.snapshots.length); assert.equal(value.executable, false)
    assert.equal(await readLegacySignalArchive(db, { userId: 2147483647, signalId: String(row.id) }), null)
    report.archiveReadChecks.push({ signalId: String(row.id), userId: Number(row.user_id), snapshots: value.snapshots.length,
      tasks: value.tasks.length, intents: value.intents.length, unresolvedIntentIds: value.unresolvedIntentIds, wrongUserDenied: true })
  }
  const [executionExamples] = await db.query('SELECT i.id,i.user_id FROM order_intents i INNER JOIN signal_outcomes o ON o.order_intent_id=i.id AND o.user_id=i.user_id AND o.trading_account_id=i.trading_account_id ORDER BY i.id DESC LIMIT 3')
  assert.ok(executionExamples.length)
  report.executionArchiveReadChecks = []
  for (const row of executionExamples) {
    const value = await readLegacyExecutionArchive(db, { userId: Number(row.user_id), intentId: String(row.id) })
    assert.ok(value && value.outcomes.length)
    assert.equal(await readLegacyExecutionArchive(db, { userId: 2147483647, intentId: String(row.id) }), null)
    report.executionArchiveReadChecks.push({ intentId: String(row.id), userId: Number(row.user_id), outcomes: value.outcomes.length,
      deals: value.deals.length, risks: value.risks.length, wrongUserDenied: true })
  }
  report.checks.push('all-retained-source-rows-read-and-hashed-without-payload-disclosure', 'installed-core-foreign-keys-have-no-orphans',
    'legacy-archive-reader-preserves-original-identity-and-rejects-other-user', 'financial-aggregates-use-MySQL-decimal')
  report.limits = ['local-archive-reader-is-not-a-browser-API','legacy-system-user-zero-is-not-assigned-to-a-current-user',
    'historical-unresolved-links-are-reported-not-repaired-by-guessing','current-digests-are-not-an-independent-backup-comparison']
  report.passed = true
} catch (error) { report.errorCode = error?.code ?? error?.message ?? 'lineage_probe_failed'; process.exitCode = 1 }
finally {
  if (db) { await db.rollback(); await db.end() }
  report.observedAt = new Date().toISOString()
  await output.writeFile(JSON.stringify(report, null, 2) + '\n'); await output.close()
  console.log(JSON.stringify({ passed: report.passed, errorCode: report.errorCode, archives: report.archives?.map(({table,records})=>({table,records})),
    foreignKeyCount: report.foreignKeys?.length, coreTablesWithoutForeignKeys: report.coreTablesWithoutForeignKeys, legacyRelations: report.legacyRelations, archiveReadChecks: report.archiveReadChecks, writes: 0 }))
}
