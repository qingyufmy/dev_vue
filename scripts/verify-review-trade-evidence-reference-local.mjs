import { createMysqlOwnedHistoryAccess } from '../server/dist-v4/modules/trading/composition.js'
import { createActivePrincipalAccess } from '../server/dist-v4/modules/auth/composition.js'
import assert from 'node:assert/strict'
import { open } from 'node:fs/promises'
import { randomUUID, createHash } from 'node:crypto'
import { isAbsolute } from 'node:path'
import mysql from 'mysql2/promise'
import { loadCandidateTaskUpgrade } from './lib/candidate-task-upgrade.mjs'
import { createTransactionReviewTradeEvidenceReader } from '../server/dist-v4/modules/trade-history/composition.js'
import { canonicalEvidence } from '../server/dist-v4/modules/trade-history/domain/terminal-history-projection.js'
const [destination] = process.argv.slice(2)
assert.ok(process.argv.length === 3 && isAbsolute(destination ?? ''))
const output = await open(destination, 'wx', 0o600), name = 'dev_vue_pending_ref_' + randomUUID().replaceAll('-', '')
const report = { kind: 'review-trade-evidence-reference/v1', passed: false, existingDatabaseWrites: 0, foreignKeysVerified: false, checks: [] }
let db, pool, created = false
try {
  const chunks = []; for await (const chunk of process.stdin) chunks.push(chunk)
  const credentials = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  assert.ok(credentials.host === '127.0.0.1' && credentials.port === 13316 && credentials.user === 'root')
  db = await mysql.createConnection({ ...credentials, database: 'dev_vue', timezone: 'Z' })
  const [[identity]] = await db.query('SELECT @@server_uuid uuid,@@innodb_force_recovery recovery')
  assert.equal(identity.uuid, 'ac423207-6ef3-11f1-b302-000c29fda104'); assert.equal(Number(identity.recovery), 0)
  const plan = await loadCandidateTaskUpgrade(new URL('../', import.meta.url))
  const [history] = await db.query('SELECT id,checksum_sha256 checksum,status FROM database_upgrade_steps_v4 ORDER BY id')
  assert.equal(history.length, plan.steps.length)
  const checksums = new Map(plan.steps.map(step => [step.id, step.checksum]))
  for (const row of history) { assert.equal(row.status, 'completed'); assert.equal(row.checksum, checksums.get(row.id)) }
  const tables = ['users', 'trading_accounts', 'trading_account_ownerships', 'trading_account_ownership_intervals', 'account_trade_records_v4', 'account_trade_record_deals_v4', 'terminal_history_deals_v4']
  const definitions = []
  for (const table of tables) {
    const [[row]] = await db.query('SHOW CREATE TABLE `' + table + '`')
    const original = row['Create Table']
    definitions.push({ table, sha256: createHash('sha256').update(original).digest('hex'),
      ddl: original.split('\n').filter(line => !line.includes('FOREIGN KEY')).join('\n').replace(/,\n\)/g, '\n)') })
  }
  await db.query('CREATE DATABASE `' + name + '` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci'); created = true
  await db.query('USE `' + name + '`')
  for (const definition of definitions) await db.query(definition.ddl)
  report.tables = definitions.map(({ table, sha256 }) => ({ table, sha256 }))
  pool = mysql.createPool({ ...credentials, database: name, timezone: 'Z', supportBigNumbers: true, bigNumberStrings: true, connectionLimit: 3 })
  const at = new Date(), sqlTime = at.toISOString().slice(0, 23).replace('T', ' '), expiry = new Date(at.getTime() + 120000)
  const insert = async (table, values) => {
    report.fixtureTable = table
    assert.ok(tables.includes(table))
    const [columns] = await db.execute('SELECT COLUMN_NAME name,DATA_TYPE type,COLUMN_TYPE definition,IS_NULLABLE nullable,COLUMN_DEFAULT fallback,EXTRA extra FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=? AND TABLE_NAME=? ORDER BY ORDINAL_POSITION', [name, table])
    const row = { ...values }
    // Synthetic fixtures only; required unrelated fields use deterministic values.
    for (const col of columns) {
      if (Object.hasOwn(row, col.name) || col.nullable === 'YES' || col.fallback !== null || /auto_increment|GENERATED/.test(col.extra)) continue
      row[col.name] = col.type === 'enum' ? /^enum\('([^']+)'/.exec(col.definition)[1]
        : col.type === 'json' ? '{}' : ['datetime', 'timestamp'].includes(col.type) ? sqlTime
          : /int|decimal|float|double/.test(col.type) ? 1 : col.name.includes('sha256') ? 'a'.repeat(64) : 'fixture'
    }
    const keys = Object.keys(row); assert.ok(keys.every(key => /^[a-z][a-z0-9_]*$/.test(key)))
    await db.execute(`INSERT INTO ${table} (${keys.map(key => '`' + key + '`').join(',')}) VALUES (${keys.map(() => '?').join(',')})`, Object.values(row))
  }
  const sql = value => new Date(value).toISOString().slice(0, 23).replace('T', ' ')
  const opened = sql(at.getTime()-7200000), closed = sql(at.getTime()-3600000)
  const interval = randomUUID(), record = randomUUID(), deal = randomUUID()
  const entryId = randomUUID()
  const dealIdentity = { position_id: '100', symbol: 'XAUUSD', deal_kind: 'trade', volume: '0.01', account_currency: 'USD', currency_evidence: 'explicit_record' }
  const entry = canonicalEvidence({ ...dealIdentity, deal_ticket:'9000', entry_kind:'in', side:'buy', price:'2500', time_utc_msc:at.getTime()-7200000, profit:'0',commission:'0',swap:'0',fee:'0' })
  const fact = canonicalEvidence({ ...dealIdentity, entry_kind:'out', side:'sell',price:'2501', deal_ticket: '9001', time_utc_msc: at.getTime()-3600000, profit: '10.00', commission: '-1.00', swap: '0', fee: '0.00' })
  const aggregate = hash => createHash('sha256').update([entry.hash,hash].sort().join('|')).digest('hex')
  await insert('users', { id: 7, deletion_status: 'active' })
  await insert('trading_account_ownership_intervals', { id: interval, user_id: 7, trading_account_id: 5, role: 'owner', started_at_utc: sql(at.getTime()-10800000) })
  await insert('trading_accounts', { id:5, platform:'mt5', ownership_revision:1 })
  await insert('trading_account_ownerships', { user_id:7,trading_account_id:5,role:'owner',revision:1,interval_id:interval,granted_at_utc:sql(at.getTime()-10800000) })
  await insert('account_trade_records_v4', { id: record, user_id: 7, trading_account_id: 5, ownership_interval_id: interval,
    platform: 'mt5', position_id:'100', status: 'closed', source_classification: 'manual', attribution_status: 'exact', evidence_status: 'complete',
    opened_at_utc: opened, closed_at_utc: closed, close_business_date: opened.slice(0,10),
    account_currency: 'USD', currency_evidence: 'explicit_record', evidence_sha256: aggregate(fact.hash), terminal_timezone_offset_minutes: 180 })
  await insert('terminal_history_deals_v4', { id: entryId, trading_account_id:5, platform:'mt5', deal_ticket:'9000', evidence_json:entry.json,evidence_sha256:entry.hash })
  await insert('account_trade_record_deals_v4', { trade_record_id:record,terminal_deal_id:entryId,role:'entry',sequence_number:0 })
  await insert('terminal_history_deals_v4', { id: deal, trading_account_id: 5, platform: 'mt5', deal_ticket: '9001', evidence_json: fact.json, evidence_sha256: fact.hash })
  await insert('account_trade_record_deals_v4', { trade_record_id: record, terminal_deal_id: deal, role: 'exit', sequence_number: 1 })
  const reader = createTransactionReviewTradeEvidenceReader(db), scope = { userId: 7, recordId: record, expectedRevision: 1 }
  const transaction = async work => { await db.beginTransaction(); try { return await work() } finally { await db.rollback() } }
  await transaction(async () => {
    const result = await reader.read(scope)
    assert.equal(result.status, 'captured'); assert.equal(result.evidence.facts[1].costs.fields.fee.value, '0.00')
    assert.equal(result.evidence.ownershipIntervalId, interval)
    assert.equal(result.evidence.openedAt, opened.replace(' ', 'T')+'Z')
    assert.deepEqual(await reader.read({ ...scope, userId: 8 }), { status: 'unresolved', reason: 'record_unavailable' })
    assert.deepEqual(await reader.read({ ...scope, expectedRevision: 2 }), { status: 'unresolved', reason: 'revision_changed' })
  })
  report.checks.push('actual-SQL-owned-facts-UTC-cross-user-and-revision')
  const ownershipReader=createMysqlOwnedHistoryAccess(db,createActivePrincipalAccess(db))
  const ownershipScope={userId:7,accountId:'5',platform:'mt5',ownershipIntervalId:interval,
    openedAt:opened.replace(' ','T')+'Z',closedAt:closed.replace(' ','T')+'Z'}
  await transaction(async()=>{
    assert.deepEqual(await ownershipReader.read(ownershipScope),{userId:7,accountId:'5',platform:'mt5',currentOwnershipRevision:'1',
      currentOwnershipIntervalId:interval,historicalOwnershipIntervalId:interval})
    assert.equal(await ownershipReader.read({...ownershipScope,userId:8}),null)
    assert.equal(await ownershipReader.read({...ownershipScope,platform:'mt4'}),null)
  })
  for(const [mutation,args] of [
    ['UPDATE trading_account_ownerships SET revoked_at_utc=? WHERE user_id=7',[sqlTime]],
    ['UPDATE trading_accounts SET ownership_revision=2 WHERE id=5',[]],
    ["UPDATE users SET deletion_status='deleted' WHERE id=7",[]],
    ['UPDATE trading_accounts SET deleted_at_utc=? WHERE id=5',[sqlTime]],
    ['UPDATE trading_account_ownership_intervals SET ended_at_utc=? WHERE id=?',[closed,interval]],
  ])await transaction(async()=>{await db.execute(mutation,args);assert.equal(await ownershipReader.read(ownershipScope),null)})
  await transaction(async()=>{
    await insert('trading_account_ownership_intervals',{id:randomUUID(),origin_ref:randomUUID(),user_id:7,trading_account_id:5,role:'owner',started_at_utc:opened,ended_at_utc:sqlTime})
    assert.equal(await ownershipReader.read(ownershipScope),null)
  })
  report.checks.push('current-and-historical-owner-proof-rejects-revocation-revision-deletion-platform-and-overlap')

  for (const [label, mutation, args, reason] of [
    ['ownership-ended', 'UPDATE trading_account_ownership_intervals SET ended_at_utc=? WHERE id=?', [opened,interval], 'record_unavailable'],
    ['missing-deal', 'DELETE FROM terminal_history_deals_v4 WHERE id=?', [deal], 'facts_incomplete'],
    ['wrong-account-deal', 'UPDATE terminal_history_deals_v4 SET trading_account_id=6 WHERE id=?', [deal], 'facts_incomplete'],
    ['unresolved-attribution', "UPDATE account_trade_records_v4 SET attribution_status='unresolved' WHERE id=?", [record], 'record_not_eligible'],
    ['record-hash-mismatch', 'UPDATE account_trade_records_v4 SET evidence_sha256=? WHERE id=?', ['b'.repeat(64),record], 'facts_incomplete'],
  ]) {
    await transaction(async () => { await db.execute(mutation,args); assert.deepEqual(await reader.read(scope), { status:'unresolved',reason }) })
    report.checks.push(label+'-refused')
  }
  await transaction(async () => {
    const missing = canonicalEvidence({ ...dealIdentity,entry_kind:'out',side:'sell',price:'2501', deal_ticket: '9001', time_utc_msc: at.getTime()-3600000, profit:'10.00', commission:'-1.00',swap:'0' })
    await db.execute('UPDATE terminal_history_deals_v4 SET evidence_json=?,evidence_sha256=? WHERE id=?',[missing.json,missing.hash,deal])
    await db.execute('UPDATE account_trade_records_v4 SET evidence_sha256=? WHERE id=?',[aggregate(missing.hash),record])
    assert.deepEqual(await reader.read(scope),{status:'unresolved',reason:'cost_fields_incomplete'})
  })
  report.checks.push('missing-fee-not-inferred-from-normalized-zero')
  await transaction(async () => {
    await db.execute("UPDATE terminal_history_deals_v4 SET evidence_json=JSON_SET(evidence_json,'$.fee','100') WHERE id=?",[deal])
    await assert.rejects(reader.read(scope),{code:'trade_cost_evidence_invalid'})
  })
  report.checks.push('tampered-raw-evidence-rejected')
  await transaction(async () => {
    await db.execute("UPDATE terminal_history_deals_v4 SET deal_ticket='9002' WHERE id=?",[deal])
    await assert.rejects(reader.read(scope),{code:'review_trade_fact_identity_invalid'})
  })
  report.checks.push('raw-deal-ticket-must-match-linked-terminal-row')
  await transaction(async () => {
    const partial = canonicalEvidence({ ...JSON.parse(fact.json), volume:'0.005' })
    await db.execute('UPDATE terminal_history_deals_v4 SET evidence_json=?,evidence_sha256=? WHERE id=?',[partial.json,partial.hash,deal])
    await db.execute('UPDATE account_trade_records_v4 SET evidence_sha256=? WHERE id=?',[aggregate(partial.hash),record])
    assert.deepEqual(await reader.read(scope),{status:'unresolved',reason:'lifecycle_incomplete'})
  })
  report.checks.push('closed-label-with-partial-exit-rejected-despite-matching-hashes')
  await transaction(async () => {
    const feeId = randomUUID()
    const fee = canonicalEvidence({ ...dealIdentity,deal_ticket:'9002',deal_kind:'fee',entry_kind:'',side:'none',volume:'0',
      time_utc_msc:at.getTime()-1800000,profit:'-0.30',commission:'0',swap:'0',fee:'-0.05' })
    await insert('terminal_history_deals_v4',{id:feeId,trading_account_id:5,platform:'mt5',deal_ticket:'9002',evidence_json:fee.json,evidence_sha256:fee.hash})
    await insert('account_trade_record_deals_v4',{trade_record_id:record,terminal_deal_id:feeId,role:'fee',sequence_number:2})
    const combined = createHash('sha256').update([entry.hash,fact.hash,fee.hash].sort().join('|')).digest('hex')
    await db.execute('UPDATE account_trade_records_v4 SET evidence_sha256=? WHERE id=?',[combined,record])
    const captured = await reader.read(scope)
    assert.equal(captured.status,'captured')
    assert.equal(captured.evidence.projection.cashAdjustments,'-0.3')
    assert.equal(captured.evidence.projection.netProfit,'8.65')
    assert.equal(captured.evidence.facts.length,3)
    assert.equal(captured.evidence.closedAt,closed.replace(' ','T')+'Z')
  })
  report.checks.push('late-position-fee-included-once-with-separate-cash-adjustment')
  report.passed = true
} catch (error) {
  report.constraint = /Check constraint '([^']+)'/.exec(String(error?.sqlMessage ?? ''))?.[1]; report.errorCode = error?.code ?? error?.name
  report.actualCode = error?.actual?.code
  report.locations = String(error?.stack ?? '').split('\n').filter(line => /^\s+at /.test(line)).slice(0, 3)
  process.exitCode = 1
} finally {
  if (pool) await pool.end()
  if (db) { if (created) { assert.match(name, /^dev_vue_pending_ref_[a-f0-9]{32}$/); await db.query('DROP DATABASE `' + name + '`'); report.referenceDatabaseRemoved = true } await db.end() }
  report.observedAt = new Date().toISOString(); await output.writeFile(JSON.stringify(report, null, 2) + '\n'); await output.close()
  console.log(JSON.stringify({ passed: report.passed, errorCode: report.errorCode, actualCode: report.actualCode, checks: report.checks, referenceDatabaseRemoved: report.referenceDatabaseRemoved }))
}
