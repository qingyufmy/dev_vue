import test from 'node:test'
import assert from 'node:assert/strict'
import { createSubscriptionBuildWriter } from './mysql-subscription-build-writer.mjs'
import { subscriptionBuildFixture } from './subscription-build-writer-reference.mjs'

test('canonical namespace writes and replays all three promoted tables', async () => {
  const projection = subscriptionBuildFixture('1', '11')
  const writer = createSubscriptionBuildWriter([projection], { namespace: 'canonical' })
  const rows = new Map(), writes = []
  const connection = { async execute(sql, args) {
    assert.doesNotMatch(sql, /_v4_build/)
    if (sql.startsWith('SELECT ')) {
      const table = /FROM (\w+)/.exec(sql)[1]
      return [rows.has(table) ? [structuredClone(rows.get(table))] : []]
    }
    const [, table, fields] = /^INSERT INTO (\w+) \(([^)]+)\)/.exec(sql)
    rows.set(table, Object.fromEntries(fields.split(',').map((field, index) => [field, args[index]])))
    writes.push(table); return [{ affectedRows: 1 }]
  } }
  assert.equal((await writer.write(connection, projection)).inserted, 3)
  assert.equal((await writer.write(connection, projection, { verifyOnly: true })).inserted, 0)
  assert.deepEqual(writes, ['strategy_subscriptions', 'subscription_schedules', 'subscription_execution_preferences'])
  assert.throws(() => createSubscriptionBuildWriter([projection], { namespace: 'arbitrary_table' }),
    { code: 'subscription_writer_namespace' })
})

test('rejects lossy identifiers, malformed dates and inconsistent child linkage before SQL', () => {
  for (const mutate of [
    p => { p.subscription.id = 9007199254740992 },
    p => { p.subscription.user_id = '2147483648' },
    p => { p.subscription.revision = '18446744073709551616' },
    p => { p.subscription.created_at_utc = '2026-02-30 00:00:00.000' },
    p => { p.subscription.created_at_utc = '2026-09-09 00:00:00.000001' },
    p => { p.schedule.subscription_id = '2' },
    p => { p.preferences.contract_version = 2 },
    p => { p.subscription.trader_strategy_id = '2' },
    p => { p.subscription.trade_send_enabled = 1 },
    p => { p.subscription.analysis_enabled = '0' },
  ]) {
    const projection = subscriptionBuildFixture('1', '11'); mutate(projection)
    assert.throws(() => createSubscriptionBuildWriter([projection]))
  }
})

test('rejects ID, natural-key and legacy-key collisions inside the frozen batch', () => {
  const first = subscriptionBuildFixture('1', '11')
  for (const overrides of [{}, { id: '90002', legacy_id: 'other' }, { id: '90002', standard_symbol: 'EURUSD' }]) {
    assert.throws(() => createSubscriptionBuildWriter([first, subscriptionBuildFixture('1', '11', overrides)]),
      { code: 'subscription_build_writer_duplicate' })
  }
})

test('does not accept changed projection after the writer was prepared', async () => {
  const projection = subscriptionBuildFixture('1', '11'), writer = createSubscriptionBuildWriter([projection])
  projection.preferences.take_profit_mode = 'trend'
  await assert.rejects(writer.write({ execute() { assert.fail('SQL must not run') } }, projection),
    { code: 'subscription_build_writer_input_changed' })
})

test('freezes the whole projection before asynchronous reads and replays without inserts', async () => {
  const projection = subscriptionBuildFixture('1', '11'), writer = createSubscriptionBuildWriter([projection])
  const rows = new Map(), writes = []
  let mutated = false
  const connection = { async execute(sql, args) {
    if (!mutated) {
      mutated = true
      projection.subscription.standard_symbol = 'EURUSD'
      projection.schedule.receive_window_json.windows[0].start = '09:00'
      projection.preferences.take_profit_mode = 'trend'
    }
    if (sql.startsWith('SELECT ')) {
      const table = /FROM (\w+)/.exec(sql)[1]
      return [rows.has(table) ? [structuredClone(rows.get(table))] : []]
    }
    const [, table, fields] = /^INSERT INTO (\w+) \(([^)]+)\)/.exec(sql)
    rows.set(table, Object.fromEntries(fields.split(',').map((field, i) => [field, args[i]])))
    writes.push(table)
    return [{ affectedRows: 1 }]
  } }
  assert.equal((await writer.write(connection, projection)).inserted, 3)
  assert.equal(rows.get('strategy_subscriptions_v4_build').standard_symbol, 'XAUUSD')
  assert.equal(JSON.parse(rows.get('subscription_schedules_v4_build').receive_window_json).windows[0].start, '00:00')
  assert.equal(rows.get('subscription_execution_preferences_v4_build').take_profit_mode, 'standard')
  assert.equal((await writer.write(connection, subscriptionBuildFixture('1', '11'), { verifyOnly: true })).inserted, 0)
  assert.equal(writes.length, 3)
})
