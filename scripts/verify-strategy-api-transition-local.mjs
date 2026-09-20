import assert from 'node:assert/strict'
import { readFile, open } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import { randomUUID } from 'node:crypto'
import mysql from 'mysql2/promise'
import Fastify from 'fastify'
import { createMysqlStrategyService, createStrategyHttp } from '../server/dist-v4/modules/strategies/composition.js'
import { assertMysqlExecutionWorkflowSchemaReady } from '../server/dist-v4/modules/execution/composition.js'
import { readAccountRootSnapshot } from './lib/mysql-account-root-snapshot.mjs'
import { hash } from './lib/v4-backfill-contract.mjs'

const [destination] = process.argv.slice(2)
assert.ok(process.argv.length === 3 && isAbsolute(destination ?? ''))
const output = await open(destination, 'wx', 0o600)
const report = { kind: 'strategy-api-migrated-data/v1', passed: false, target: 'dev_vue_m1_source_20260910_02',
  currentDevVueWrites: 0, realAuthenticationVerified: false, realCommitVerified: false,
  transactionMode: 'outer-rollback-with-per-request-savepoints', checks: [] }
let db, app, outer = false
try {
  const chunks = []; for await (const chunk of process.stdin) chunks.push(chunk)
  const credentials = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  assert.ok(credentials.host === '127.0.0.1' && credentials.port === 13316 && credentials.user === 'root')
  db = await mysql.createConnection({ ...credentials, database: report.target, timezone: 'Z', dateStrings: true,
    jsonStrings: true, supportBigNumbers: true, bigNumberStrings: true })
  await db.query("SET SESSION time_zone='+00:00'")
  const [[identity]] = await db.query('SELECT DATABASE() db,@@server_uuid uuid,@@innodb_force_recovery recovery')
  assert.equal(identity.db, report.target); assert.equal(identity.uuid, 'ac423207-6ef3-11f1-b302-000c29fda104')
  assert.equal(Number(identity.recovery), 0)
  const simpleConnection = new Proxy(db, { get(target, key) {
    if (key === 'release') return () => {}
    const value = target[key]; return typeof value === 'function' ? value.bind(target) : value
  } })
  await assertMysqlExecutionWorkflowSchemaReady({ getConnection: async () => simpleConnection })
  const snapshot = async () => {
    await db.query('START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY')
    try { return (await readAccountRootSnapshot(db)).tables.map(row => ({ ...row, ddl: row.ddl.replace(/ AUTO_INCREMENT=\d+/g, '') })) }
    finally { await db.rollback() }
  }
  const before = await snapshot()
  const candidate = JSON.parse(await readFile('D:/dev_codex/.backup-core-20260910-01/strategy-subscription-transition-v1.json', 'utf8'))
  const migrated = JSON.parse(await readFile(new URL('../docs/architecture/strategy-subscription-transition-restored-v4-20260911.json', import.meta.url), 'utf8'))
  const applied = JSON.parse(await readFile(new URL('../docs/architecture/strategy-receipt-restored-v1-20260911.json', import.meta.url), 'utf8'))
  assert.ok(applied.passed && migrated.passed); assert.equal(migrated.candidateHash, hash(candidate)); assert.equal(hash(before), applied.afterSnapshotHash)
  await db.beginTransaction(); outer = true
  // Real routes, contracts, application and SQL. Savepoints allow multiple HTTP
  // writes to observe one another while the outer test always rolls them back.
  const requestConnection = new Proxy(db, { get(target, key) {
    if (key === 'execute') return async (...args) => {
      try { return await db.execute(...args) }
      catch (error) { report.sqlFailure = { code: error.code, sqlState: error.sqlState }; throw error }
    }
    if (key === 'beginTransaction') return () => db.query('SAVEPOINT strategy_api_request')
    if (key === 'commit') return () => db.query('RELEASE SAVEPOINT strategy_api_request')
    if (key === 'rollback') return () => db.query('ROLLBACK TO SAVEPOINT strategy_api_request')
    if (key === 'release') return () => {}
    if (key === 'destroy') return () => { throw Error('probe_connection_discarded') }
    const value = target[key]; return typeof value === 'function' ? value.bind(target) : value
  } })
  const pool = { getConnection: async () => requestConnection, execute: db.execute.bind(db) }
  let actor = Number(candidate.subscriptionEntries[0].source.user_id), serial = 0
  app = Fastify()
  await app.register(createStrategyHttp(createMysqlStrategyService(pool), {
    authenticate: async () => ({ userId: actor }), assertWrite: async () => ({ userId: actor }),
  }))
  const request = async (method, path, payload, expected = 200, revision, key) => {
    const headers = { 'x-csrf-token': 'csrf-token-123456789', 'idempotency-key': key ?? `api-transition-${randomUUID()}` }
    if (revision !== undefined) headers['if-match'] = `"${revision}"`
    const response = await app.inject({ method, url: '/api/v4' + path, headers, ...(payload === undefined ? {} : { payload }) })
    serial++
    if (response.statusCode !== expected) { report.failedRequest = { serial, method, path, expected, actual: response.statusCode, code: response.json().code }; throw Error('api_probe_status') }
    return response.json()
  }
  for (const entry of candidate.strategyEntries) for (const role of Object.values(entry.roles)) {
    if (role.strategy.deleted_at_utc !== null) {
      await request('GET', `/strategies/${role.strategy.id}`, undefined, 404)
      await request('PATCH', `/strategies/${role.strategy.id}`, { name: 'Not permitted', description: '' }, 404, '1')
      continue
    }
    const value = (await request('GET', `/strategies/${role.strategy.id}`)).data
    assert.equal(value.status, role.strategy.status); assert.equal(value.active_version_id, null)
    assert.equal(value.versions[0].prompt_hash, role.version.prompt_sha256)
    assert.equal(value.versions[0].version, Number(entry.source.version))
    await request('PATCH', `/strategies/${role.strategy.id}`, { name: 'Not permitted', description: '' }, 403, '1')
  }
  report.checks.push('migrated-role-details-and-original-version-hashes', 'deleted-roles-hidden', 'platform-strategies-read-only')
  for (const entry of candidate.subscriptionEntries) {
    actor = Number(entry.source.user_id)
    const admission = candidate.subscriptionAdmissions.find(row => row.sourceId === entry.source.id)
    const listed = (await request('GET', '/strategy-subscriptions')).data.items
    assert.ok(listed.every(row => row.user_id === String(actor)))
    for (const { subscription: row } of entry.projections) {
      const path = `/strategy-subscriptions/${row.id}`
      if (admission.ownershipDisposition === 'historical_only') {
        assert.ok(!listed.some(item => item.id === row.id))
        await request('PATCH', path, { status: 'active', analysis_enabled: true }, 404, '1')
      } else {
        assert.ok(listed.some(item => item.id === row.id && item.status === row.status))
        await request('PATCH', path, { status: 'active', analysis_enabled: true, trader_enabled: true }, 409, '1')
        const edited = (await request('PATCH', path, { status: 'paused' }, 200, '1')).data
        assert.equal(edited.revision, '2'); assert.equal(edited.schedule.receive_timezone, 'terminal_server')
        await request('PATCH', path, { status: 'ended' }, 200, '2')
      }
    }
  }
  report.checks.push('subscriptions-isolated-by-user', 'historical-owner-cannot-mutate', 'draft-activation-rejected', 'paused-edit-and-end-retain-window')
  actor = Number(candidate.subscriptionEntries[0].source.user_id)
  const own = candidate.subscriptionEntries.find(entry => candidate.subscriptionAdmissions.some(row => row.sourceId === entry.source.id && row.ownershipDisposition === 'current_owner') && Number(entry.source.user_id) === actor)
  const account = own.projections[0].subscription.trading_account_id
  const created = (await request('POST', '/strategies', { kind: 'analysis', name: 'Local API transition verification', description: '', prompt_text: 'Analyse only; do not trade.', config: {} }, 201)).data
  const id = created.id, version = created.versions[0].id
  await request('POST', `/strategies/${id}/versions/${version}/publish`, undefined, 200, '1')
  const subscription = (await request('POST', '/strategy-subscriptions', { trading_account_id: account, symbol: 'XAUUSD', analysis_strategy_id: id, analysis_enabled: true, trader_enabled: false, trade_send_enabled: false, status: 'paused' }, 201)).data
  const activationKey = `api-transition-${randomUUID()}`
  const activated = (await request('PATCH', `/strategy-subscriptions/${subscription.id}`, { status: 'active' }, 200, '1', activationKey)).data
  assert.equal(activated.analysis_strategy_version_id, version)
  const replay = (await request('PATCH', `/strategy-subscriptions/${subscription.id}`, { status: 'active' }, 200, '1', activationKey)).data
  assert.deepEqual(replay, activated)
  await request('POST', `/strategies/${id}/retire`, undefined, 200, '2')
  await request('PATCH', `/strategy-subscriptions/${subscription.id}`, { status: 'active' }, 409, '2')
  await request('PATCH', `/strategy-subscriptions/${subscription.id}`, { status: 'ended' }, 200, '2')
  report.checks.push('create-publish-subscribe-activate-through-real-API-SQL', 'activation-receipt-replay', 'retired-strategy-rejected-with-end-still-available')
  await db.rollback(); outer = false
  const after = await snapshot()
  assert.equal(hash(after), hash(before), 'probe_original_data_changed')
  report.requests = serial; report.originalDataUnchanged = true; report.tableCount = before.length
  report.passed = true
} catch (error) {
  report.errorCode = error?.code ?? error?.name ?? 'api_probe_failed'
  report.errorLocations = String(error?.stack ?? '').split('\n').filter(line => /^\s+at /.test(line)).slice(0, 3)
  process.exitCode = 1
} finally {
  if (outer) await db.rollback()
  if (app) await app.close()
  if (db) await db.end()
  report.observedAt = new Date().toISOString()
  await output.writeFile(JSON.stringify(report, null, 2) + '\n'); await output.close()
  console.log(JSON.stringify(report))
}
