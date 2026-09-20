import test from 'node:test'
import assert from 'node:assert/strict'
import { hash } from './v4-backfill-contract.mjs'
import { legacyStrategyFields, legacySubscriptionFields } from './v4-strategy-source-review.mjs'
import { createSubscriptionSourceWriter } from './mysql-subscription-source-writer.mjs'
import { subscriptionLegacyIdentity } from './subscription-legacy-identity.mjs'
import { subscriptionBuildFixture } from './subscription-build-writer-reference.mjs'

function fixture(namespace = 'build') {
  const source = { ...Object.fromEntries(legacySubscriptionFields.map(field => [field, null])),
    id: '31', user_id: '7', trading_account_id: '9', strategy_id: '21', take_profit_mode: 'standard',
    created_at: '2026-09-09 00:00:00.123', updated_at: '2026-09-09 00:00:00.123' }
  const strategySource = { ...Object.fromEntries(legacyStrategyFields.map(field => [field, null])),
    id: '21', version: '44', symbols_json: '["EURUSD","XAUUSD"]' }
  const projections = ['EURUSD', 'XAUUSD'].map((symbol, i) => subscriptionBuildFixture('1', '11',
    { id: String(91001 + i), standard_symbol: symbol, legacy_id: `31:${symbol}` }))
  const entry = { source, sourceHash: hash(source), strategySource, strategySourceHash: hash(strategySource), projections }
  const saved = structuredClone(entry), maps = new Map(), state = { targetReads: 0, mapWrites: 0, missingParent: false, queries: [] }
  const tx = { connection: { async execute(sql, args) {
    state.queries.push(sql)
    if (sql.includes(`FROM ${namespace === 'canonical' ? 'strategy_subscriptions_legacy_v3' : 'strategy_subscriptions'} WHERE`)) return [[structuredClone(saved.source)]]
    if (sql.includes('FROM auto_prompt_types WHERE')) return [[structuredClone(saved.strategySource)]]
    assert.ok(sql.startsWith('SELECT ')); state.targetReads++
    const kind = sql.includes('FROM subscription_schedules') ? 'schedule'
      : sql.includes('FROM subscription_execution_preferences') ? 'preferences' : 'subscription'
    const row = saved.projections.find(p => p.subscription.id === args[0])[kind]
    return [[structuredClone(row)]]
  } }, async findMapping(_, mapping) {
    if (mapping.entityKind.startsWith('subscription-')) return maps.get(mapping.entityKind) ?? null
    if (state.missingParent) return null
    return { sourcePk: mapping.sourcePk, target: mapping.target }
  }, async insertMapping(_, __, mapping) {
    state.mapWrites++; maps.set(mapping.entityKind, { sourcePk: mapping.sourcePk, target: mapping.target })
  } }
  const options = { runId: '11111111-1111-1111-1111-111111111111', logicalSourceId: 'dev_vue', namespace }
  return { entry, saved, state, maps, tx, options, writer: createSubscriptionSourceWriter([entry], options) }
}

test('canonical source reads preserved legacy rows and verifies promoted targets', async () => {
  const f = fixture('canonical')
  assert.equal((await f.writer.write(f.tx, f.entry)).mappingsInserted, 2)
  assert.equal((await f.writer.write(f.tx, f.entry, { verifyOnly: true })).mappingsInserted, 0)
  assert.ok(f.state.queries.some(sql => sql.includes('FROM strategy_subscriptions_legacy_v3 WHERE')))
  assert.ok(f.state.queries.some(sql => sql.includes('FROM strategy_subscriptions WHERE')))
  assert.ok(f.state.queries.every(sql => !sql.includes('_v4_build')))
})

test('symbol identities preserve uint64 source PK and remain bounded and distinct', () => {
  const a = subscriptionLegacyIdentity('18446744073709551615', 'XAUUSD'), b = subscriptionLegacyIdentity('18446744073709551615', 'EURUSD')
  assert.notEqual(a.entityKind, b.entityKind)
  assert.equal(a.sourcePk[0].value, '18446744073709551615')
  assert.ok(subscriptionLegacyIdentity('1', 'A'.repeat(64)).entityKind.length <= 64)
  assert.throws(() => subscriptionLegacyIdentity('18446744073709551616', 'XAUUSD'))
})
test('maps two symbols to one real source PK and verifies replay without extra mappings', async () => {
  const f = fixture(), result = await f.writer.write(f.tx, f.entry)
  assert.equal(result.mappingsInserted, 2)
  assert.ok(result.idMaps.every(map => map.sourcePk[0].value === '31' && map.target.table === 'strategy_subscriptions'))
  assert.equal((await f.writer.write(f.tx, f.entry, { verifyOnly: true })).mappingsInserted, 0)
  assert.equal(f.state.mapWrites, 2)
})
test('source and inherited strategy changes fail before target or map writes', async () => {
  for (const key of ['source', 'strategySource']) {
    const f = fixture()
    if (key === 'source') f.saved.source.is_deleted = '1'
    else f.saved.strategySource.symbols_json = '["XAUUSD"]'
    await assert.rejects(f.writer.write(f.tx, f.entry), { code: 'subscription_source_changed' })
    assert.equal(f.state.targetReads, 0); assert.equal(f.state.mapWrites, 0)
  }
})
test('unmapped parents and conflicting symbol maps fail before target access', async () => {
  const missing = fixture(); missing.state.missingParent = true
  await assert.rejects(missing.writer.write(missing.tx, missing.entry), { code: 'subscription_source_parent_mapping_conflict' })
  assert.equal(missing.state.targetReads, 0)
  const conflict = fixture(), identity = subscriptionLegacyIdentity('31', 'EURUSD')
  conflict.maps.set(identity.entityKind, { sourcePk: identity.sourcePk, target: { table: 'strategy_subscriptions', pk: [{ type: 'integer', value: '999' }] } })
  await assert.rejects(conflict.writer.write(conflict.tx, conflict.entry), { code: 'subscription_source_mapping_conflict' })
  assert.equal(conflict.state.targetReads, 0)
})
test('symbol omission, source-user substitution and missing verify-only maps are rejected', async () => {
  const f = fixture()
  await assert.rejects(f.writer.write(f.tx, f.entry, { verifyOnly: true }), { code: 'subscription_source_mapping_missing' })
  f.entry.projections.pop()
  assert.throws(() => createSubscriptionSourceWriter([f.entry], f.options), { code: 'subscription_source_symbols_unresolved' })
  const other = fixture(); other.entry.projections[0].subscription.user_id = '8'
  assert.throws(() => createSubscriptionSourceWriter([other.entry], other.options), { code: 'subscription_source_target_identity' })
})
test('freezes source and target projections before the first await', async () => {
  const f = fixture(), execute = f.tx.connection.execute.bind(f.tx.connection)
  f.tx.connection.execute = async (...args) => {
    const result = await execute(...args)
    f.entry.projections[0].preferences.take_profit_mode = 'trend'
    f.entry.source.user_id = '8'
    return result
  }
  assert.equal((await f.writer.write(f.tx, f.entry)).mappingsInserted, 2)
  await assert.rejects(f.writer.write(f.tx, f.entry), { code: 'subscription_source_input_changed' })
})
test('map insertion without matching persistent readback fails', async () => {
  const f = fixture(); f.tx.insertMapping = async () => {}
  await assert.rejects(f.writer.write(f.tx, f.entry), { code: 'subscription_source_mapping_readback' })
})

test('projection cannot silently change source take-profit preference or historical timestamp', () => {
  for (const mutate of [p => { p.take_profit_mode = 'trend' }, p => { p.created_at_utc = '2026-09-09 08:00:00.123' }]) {
    const f = fixture(); mutate(f.entry.projections[0].preferences)
    assert.throws(() => createSubscriptionSourceWriter([f.entry], f.options), { code: 'subscription_source_preferences_conflict' })
  }
})
