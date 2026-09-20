import test from 'node:test'
import assert from 'node:assert/strict'
import { strategyRoleLegacyIdentity } from './strategy-role-legacy-identity.mjs'

test('role split has distinct target keys but retains the same exact original PK', () => {
  const analysis = strategyRoleLegacyIdentity('9007199254740993', '44', 'analysis')
  const trader = strategyRoleLegacyIdentity('9007199254740993', '44', 'trader')
  assert.notEqual(analysis.strategy.legacyId, trader.strategy.legacyId)
  assert.notEqual(analysis.version.legacyId, trader.version.legacyId)
  assert.notEqual(analysis.strategy.entityKind, trader.strategy.entityKind)
  assert.deepEqual(analysis.sourcePk, trader.sourcePk)
  assert.deepEqual(analysis.sourcePk, [{ type: 'integer', value: '9007199254740993' }])
})
test('new source version changes version identity without duplicating strategy identity', () => {
  const first = strategyRoleLegacyIdentity('1', '44', 'trader')
  const next = strategyRoleLegacyIdentity('1', '45', 'trader')
  assert.deepEqual(first.strategy, next.strategy)
  assert.notEqual(first.version.legacyId, next.version.legacyId)
  const maximum = strategyRoleLegacyIdentity('18446744073709551615', '4294967295', 'analysis')
  assert.ok(maximum.version.legacyId.length <= 191)
  assert.match(maximum.version.legacyId, /^[\x20-\x7e]+$/)
})
test('rejects noncanonical IDs, out of range values and invented roles', () => {
  for (const args of [['01','1','analysis'], ['0','1','analysis'], ['1','0','analysis'],
    ['18446744073709551616','1','analysis'], ['1','4294967296','analysis'],
    ['1','1','mixed'], [1,'1','analysis'], ['1','1:analysis','trader']]) {
    assert.throws(() => strategyRoleLegacyIdentity(...args), /strategy_legacy_identity_invalid/)
  }
})
