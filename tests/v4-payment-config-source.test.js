import { expect, it } from 'vitest'
import { inspectPaymentConfigSources } from '../scripts/lib/v4-payment-config-source.mjs'
const row = () => ({ id: '1', category: 'crypto_wallet', key: 'fixed_tron_address', value: 'synthetic-address', label: '收款地址', sort_order: '10', created_at: '2026-01-01 00:00:00', updated_at: null })
it('preserves all eight columns and records unresolved time without inventing history', () => {
  const r = row(), result = inspectPaymentConfigSources([r])
  expect(result.entries[0].source).toEqual(r)
  expect(result.blockers).toEqual([{ sourceId: '1', code: 'payment_config_time_basis_required' }])
  expect(result.historicalRecipientBindingVerified).toBe(false)
})
it('distinguishes absent keys, NULL values and empty values', () => {
  for (const [value, kind] of [[null, 'null'], ['', 'empty'], ['x', 'text']]) {
    const result = inspectPaymentConfigSources([{ ...row(), value }])
    expect(result.entries[0].valueKind).toBe(kind)
    expect(result.missingKeys).not.toContain('fixed_tron_address')
  }
  expect(inspectPaymentConfigSources([]).missingKeys).toContain('fixed_tron_address')
})
it('rejects unrelated or duplicate rows and does not trim or normalize invalid addresses', () => {
  for (const r of [{ ...row(), category: 'other' }, { ...row(), key: 'secret' }, { ...row(), extra: 'value' }]) {
    expect(() => inspectPaymentConfigSources([r])).toThrow()
  }
  expect(() => inspectPaymentConfigSources([row(), { ...row(), id: '2' }])).toThrow()
  expect(inspectPaymentConfigSources([{ ...row(), value: 'addr ' }]).blockers).toContainEqual({ sourceId: '1', code: 'payment_config_address_representation_invalid' })
})
it('accepts only the existing fixed mode as resolved, without granting custody', () => {
  for (const value of ['dynamic', null, '']) expect(inspectPaymentConfigSources([{ ...row(), key: 'payment_mode', value }]).blockers.some(b => b.code === 'payment_config_mode_resolution_required')).toBe(true)
  expect(inspectPaymentConfigSources([{ ...row(), key: 'payment_mode', value: 'fixed', created_at: null }]).blockers).toEqual([])
})
