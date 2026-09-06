import { readFile, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import assert from 'node:assert/strict'
import mysql from 'mysql2/promise'
import dotenv from 'dotenv'
import { readTransactionAccountClock } from '../server/dist-v4/modules/trading/infrastructure/mysql-transaction-account-clock.js'
import { evaluateSubscriptionWindow } from '../server/dist-v4/modules/strategies/domain/subscription-window.js'

const root = new URL('../', import.meta.url)
const mode = process.argv[2] ?? '--write'
assert.ok(process.argv.length <= 3 && ['--write', '--verify'].includes(mode))
const env = dotenv.parse(await readFile(new URL('server/.env', root)))
assert.equal(env.MYSQL_DATABASE, 'dev_vue')
const connection = await mysql.createConnection({ host: env.MYSQL_HOST, port: Number(env.MYSQL_PORT || 3306), user: env.MYSQL_USER,
  password: env.MYSQL_PASSWORD, database: env.MYSQL_DATABASE, timezone: 'Z' })
const baseline = () => ({
  trading_accounts: [{ id: 7, platform: 'mt5', ownership_revision: 2, deleted_at_utc: null }],
  trading_account_ownerships: [{ trading_account_id: 7, user_id: 42, role: 'owner', revoked_at_utc: null, revision: 2, interval_id: 'interval', granted_at_utc: '2000-01-01 00:00:00' }],
  trading_account_ownership_intervals: [{ id: 'interval', user_id: 42, trading_account_id: 7, role: 'owner', ended_at_utc: null, started_at_utc: '2000-01-01 00:00:00' }],
  users: [{ id: 42, deletion_status: 'active', deleted_at: null }],
  terminal_account_bindings: [{ trading_account_id: 7, terminal_profile_id: 'profile', terminal_instance_id: 'terminal', unbound_at_utc: null }],
  terminal_profiles: [{ id: 'profile', user_id: 42, platform: 'mt5', deleted_at_utc: null }],
  account_runtime_snapshots: [{ trading_account_id: 7, revision: 9, timezone_offset_minutes: 180, clock_status: 'calibrated' }],
  trading_projection_revisions: [{ trading_account_id: 7, resource_kind: 'account.metrics', resource_id: 'current', revision: 9 }],
  trading_projection_provenance_v4: [{ trading_account_id: 7, resource_kind: 'account.metrics', resource_id: 'current', projection_revision: 9,
    user_id: 42, ownership_interval_id: 'interval', ownership_revision: 2, terminal_profile_id: 'profile', terminal_instance_id: 'terminal', connection_epoch: 3 }],
  bridge_connection_sessions: [{ terminal_profile_id: 'profile', disconnected_at_utc: null, connection_epoch: 3 }],
})
const cases = [
  ['matching_source', () => {}, true, true],
  ['old_owner_revision', f => { f.trading_account_ownerships[0].revision = 1 }, false],
  ['wrong_owner', f => { f.trading_account_ownerships[0].user_id = 43 }, false],
  ['ended_interval', f => { f.trading_account_ownership_intervals[0].ended_at_utc = '2001-01-01' }, false],
  ['deleted_user', f => { f.users[0].deletion_status = 'deleted' }, false],
  ['unbound_terminal', f => { f.terminal_account_bindings[0].unbound_at_utc = '2001-01-01' }, false],
  ['different_profile_user', f => { f.terminal_profiles[0].user_id = 43 }, false],
  ['different_platform', f => { f.terminal_profiles[0].platform = 'mt4' }, false],
  ['torn_projection', f => { f.trading_projection_revisions[0].revision = 10 }, false],
  ['wrong_provenance_user', f => { f.trading_projection_provenance_v4[0].user_id = 43 }, false],
  ['wrong_provenance_interval', f => { f.trading_projection_provenance_v4[0].ownership_interval_id = 'other' }, false],
  ['rebound_instance', f => { f.terminal_account_bindings[0].terminal_instance_id = 'new-terminal' }, false],
  ['new_connection_epoch', f => { f.bridge_connection_sessions[0].connection_epoch = 4 }, false],
  ['multiple_bindings', f => { f.terminal_account_bindings.push({ ...f.terminal_account_bindings[0], terminal_profile_id: 'other' }) }, false],
  ['stale_clock', f => { f.account_runtime_snapshots[0].clock_status = 'stale' }, true, false],
  ['bootstrap_clock', f => { f.account_runtime_snapshots[0].clock_status = 'observer_bootstrap' }, true, false],
]
const results = []
let sqlHash
try {
  await connection.query("SET SESSION time_zone='+00:00'")
  await connection.query('START TRANSACTION READ ONLY')
  const [[identity]] = await connection.query('SELECT DATABASE() db,@@server_uuid uuid,VERSION() version')
  assert.equal(identity.uuid, 'ac423207-6ef3-11f1-b302-000c29fda104')
  for (const [name, mutate, expectedSource, expectedAllowed = false] of cases) {
    const fixture = baseline(); mutate(fixture)
    const parameters = []
    const ctes = Object.entries(fixture).map(([table, rows]) => `${table} AS (${rows.map(row => `SELECT ${Object.entries(row).map(([key, value]) => {
      parameters.push(value); return `? AS \`${key}\``
    }).join(',')}`).join(' UNION ALL ')})`).join(',')
    const clock = await readTransactionAccountClock({ async execute(sql, bindings) {
      assert.ok(sql.startsWith('SELECT ')); assert.ok(!sql.includes(';'))
      for (const [, table] of sql.matchAll(/(?:FROM|JOIN)\s+([a-z0-9_]+)/gi)) assert.ok(Object.hasOwn(fixture, table), 'physical_table_not_shadowed')
      const digest = createHash('sha256').update(sql).digest('hex')
      if (sqlHash) assert.equal(digest, sqlHash); else sqlHash = digest
      return connection.execute(`WITH ${ctes} ${sql}`, [...parameters, ...bindings])
    } }, 42, '7')
    assert.equal(clock !== null, expectedSource, name)
    const decision = evaluateSubscriptionWindow({ version: 1, enabled: true, timezone: 'terminal_server', weekdays: [1],
      windows: [{ start: '22:00', end: '02:00' }], outsideBehavior: 'pause_all' }, 'terminal_server', new Date('2026-09-07T19:00:00Z'), clock)
    assert.equal(decision.executionAllowed, expectedAllowed, name)
    results.push({ name, fixtureSha256: createHash('sha256').update(JSON.stringify(fixture)).digest('hex'), sourceMatched: clock !== null, executionAllowed: decision.executionAllowed })
  }
  await connection.rollback()
  const report = { kind: 'subscription-clock-fixtures/v1', observedAt: new Date().toISOString(), identity, sqlHash, results,
    businessWritesPerformed: false, concurrencyVerified: false }
  const path = new URL('docs/migration/subscription-clock-fixtures-20260907.json', root)
  if (mode === '--verify') {
    const previous = JSON.parse(await readFile(path, 'utf8'))
    const stable = ({ observedAt, ...value }) => value
    assert.deepEqual(stable(report), stable(previous))
  } else await writeFile(path, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' })
  console.log(JSON.stringify({ cases: results.length, sqlHash, businessWritesPerformed: false }))
} catch (error) {
  await connection.rollback().catch(() => {})
  console.error(JSON.stringify({ code: error.code ?? 'clock_fixture_failed', case: cases[results.length]?.[0] }))
  process.exitCode = 1
} finally { await connection.end() }
