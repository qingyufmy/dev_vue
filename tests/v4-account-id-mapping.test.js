import { expect, it } from 'vitest'
import { planAccountIdMappings } from '../scripts/lib/v4-account-id-mapping.mjs'
import { hash } from '../scripts/lib/v4-backfill-contract.mjs'

const evidence = row => ({ ...row, sourceHash: hash(row) })
function fixture() {
  return { accounts: [
    evidence({ id: '10', userId: '1', server: 'Broker', login: '00123' }),
    evidence({ id: '2', userId: '2', server: 'BROKER', login: '00123' }),
  ], terminals: [
    evidence({ id: 'terminal1', userId: '1', platform: 'mt5', server: 'Broker', login: '00123' }),
    evidence({ id: 'terminal2', userId: '2', platform: 'mt5', server: 'BROKER', login: '00123' }),
  ], bindings: [evidence({ server: 'BROKER', login: '00123', currentUserId: '2', currentAccountId: '2', currency: 'USD' })] }
}
it('uses numeric IDs deterministically and preserves every old ID and user settings key', () => {
  const input = fixture(), result = planAccountIdMappings('source', input, ['10', '2'])
  expect(result.entities).toHaveLength(1)
  expect(result.entities[0].targetAccountId).toBe('2')
  expect(result.entities[0].accountLogin).toBe('00123')
  expect(result.mappings.map(mapping => mapping.sourcePk[0].value)).toEqual(['2', '10'])
  expect(result.settings.map(setting => setting.userId)).toEqual(['2', '1'])
  const reversed = Object.fromEntries(Object.entries(input).map(([key, values]) => [key, [...values].reverse()]))
  const again = planAccountIdMappings('source', reversed, ['2', '10'])
  expect(again.mappingHash).toBe(result.mappingHash)
  expect(again.sourceFingerprint).toBe(result.sourceFingerprint)
})
it('rejects a partial page instead of assigning a different representative ID', () => {
  expect(() => planAccountIdMappings('source', fixture(), ['1', '2', '10'])).toThrow('account_mapping_source_incomplete')
})
it('does not silently collapse two settings rows belonging to the same user', () => {
  const input = fixture()
  input.accounts[0].userId = '2'
  expect(() => planAccountIdMappings('source', input, ['2', '10'])).toThrow('account_mapping_settings_collision')
})
it('refuses unresolved currency and ambiguous platform evidence', () => {
  const input = fixture()
  input.bindings[0].currency = null
  expect(() => planAccountIdMappings('source', input, ['2', '10'])).toThrow('account_mapping_evidence_unresolved')
  const ambiguous = fixture()
  ambiguous.terminals.push(evidence({ id: 'terminal3', userId: '2', platform: 'mt4', server: 'BROKER', login: '00123' }))
  expect(() => planAccountIdMappings('source', ambiguous, ['2', '10'])).toThrow('account_mapping_evidence_unresolved')
})
it('rejects orphan bindings even when no account candidate would inspect that identity', () => {
  const input = fixture()
  input.bindings.push(evidence({ server: 'OTHER', login: '999', currentUserId: '2', currentAccountId: '99', currency: 'USD' }))
  expect(() => planAccountIdMappings('source', input, ['2', '10'])).toThrow('account_mapping_orphan_binding')
})
