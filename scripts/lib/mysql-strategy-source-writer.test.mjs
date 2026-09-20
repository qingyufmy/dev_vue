import test from 'node:test'
import assert from 'node:assert/strict'
import { hash } from './v4-backfill-contract.mjs'
import { legacyStrategyFields } from './v4-strategy-source-review.mjs'
import { strategyRoleLegacyIdentity } from './strategy-role-legacy-identity.mjs'
import { createStrategySourceWriter } from './mysql-strategy-source-writer.mjs'

function fixture() {
  const source = Object.fromEntries(legacyStrategyFields.map(field => [field, null]))
  source.id = '1'; source.version = '44'
  const roles = Object.fromEntries(['analysis', 'trader'].map((kind, i) => {
    const identity = strategyRoleLegacyIdentity('1', '44', kind), time = '2026-09-09 00:00:00.123'
    return [kind, { strategy: { id: String(i + 1), kind, scope: 'platform', owner_user_id: null, name: 'fixture', description: '', status: 'draft',
      active_version_id: String(i + 11), revision: '1', legacy_source_table: identity.sourceTable, legacy_id: identity.strategy.legacyId,
      created_at_utc: time, updated_at_utc: time, deleted_at_utc: null },
    version: { id: String(i + 11), strategy_id: String(i + 1), version_number: '44', prompt_text: 'fixture', prompt_sha256: 'a'.repeat(64),
      input_contract_version: 'fixture/v1', output_contract_version: 'fixture/v1', config_json: {}, created_by_user_id: '7',
      legacy_source_table: identity.sourceTable, legacy_id: identity.version.legacyId, created_at_utc: time } }]
  }))
  const entry = { source, sourceHash: hash(source), roles }
  const savedRoles = structuredClone(roles)
  const maps = new Map(), state = { source: structuredClone(source), targetReads: 0, mapWrites: 0 }
  const tx = { connection: { async execute(sql, args) {
    if (sql.includes('FROM auto_prompt_types')) {
      assert.ok(sql.includes('FOR UPDATE'))
      return [state.source ? [structuredClone(state.source)] : []]
    }
    state.targetReads++
    const part = sql.includes('FROM strategy_versions') ? 'version' : 'strategy'
    const found = Object.values(savedRoles).find(role => role[part].id === args[0])
    assert.ok(sql.startsWith('SELECT '))
    return [[structuredClone(found[part])]]
  } }, async findMapping(_, mapping) { return maps.get(mapping.entityKind) ?? null },
  async insertMapping(_, __, mapping) {
    state.mapWrites++; maps.set(mapping.entityKind, { sourcePk: mapping.sourcePk, target: mapping.target })
  } }
  const writer = createStrategySourceWriter([entry], { logicalSourceId: 'dev_vue', runId: '11111111-1111-1111-1111-111111111111' })
  return { writer, entry, tx, state, maps }
}

test('four persistent role maps keep the original PK and replay without map inserts', async () => {
  const f = fixture(), first = await f.writer.write(f.tx, f.entry)
  assert.equal(first.mappingsInserted, 4)
  assert.equal(f.state.mapWrites, 4)
  assert.ok(first.idMaps.every(item => item.sourcePk[0].value === '1'))
  assert.equal((await f.writer.write(f.tx, f.entry)).mappingsInserted, 0)
  assert.equal((await f.writer.write(f.tx, f.entry, { verifyOnly: true })).mappingsInserted, 0)
  assert.equal(f.state.mapWrites, 4)
})
test('source changed or deleted stops before target reads and map writes', async () => {
  for (const remove of [false, true]) {
    const f = fixture()
    if (remove) f.state.source = null
    else f.state.source.title = 'changed'
    await assert.rejects(f.writer.write(f.tx, f.entry), { code: 'strategy_source_changed' })
    assert.equal(f.state.targetReads, 0); assert.equal(f.state.mapWrites, 0)
  }
})
test('conflicting map is detected before any target work', async () => {
  const f = fixture()
  f.maps.set('strategy-analysis', { sourcePk: [{ type: 'integer', value: '1' }], target: { table: 'strategies', pk: [{ type: 'integer', value: '999' }] } })
  await assert.rejects(f.writer.write(f.tx, f.entry), { code: 'strategy_source_mapping_conflict' })
  assert.equal(f.state.targetReads, 0); assert.equal(f.state.mapWrites, 0)
})
test('verify only and modified frozen input cannot backfill missing mappings', async () => {
  const f = fixture()
  await assert.rejects(f.writer.write(f.tx, f.entry, { verifyOnly: true }), { code: 'strategy_source_mapping_missing' })
  f.entry.roles.analysis.strategy.name = 'changed'
  await assert.rejects(f.writer.write(f.tx, f.entry), { code: 'strategy_source_input_changed' })
  assert.equal(f.state.mapWrites, 0)
})
test('a failed map readback is surfaced to the caller-owned transaction', async () => {
  const f = fixture()
  f.tx.insertMapping = async () => {}
  await assert.rejects(f.writer.write(f.tx, f.entry), { code: 'strategy_source_mapping_readback' })
})

test('caller mutation during an asynchronous source read cannot change the frozen write', async () => {
  const f = fixture(), execute = f.tx.connection.execute.bind(f.tx.connection)
  f.tx.connection.execute = async (...args) => {
    const result = await execute(...args)
    if (args[0].includes('FROM auto_prompt_types')) f.entry.roles.analysis.strategy.name = 'changed while waiting'
    return result
  }
  const result = await f.writer.write(f.tx, f.entry)
  assert.equal(result.mappingsInserted, 4)
})
