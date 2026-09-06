import { expect, it } from 'vitest'
import { hash } from '../scripts/lib/v4-backfill-contract.mjs'
import { planAccountIdMappings } from '../scripts/lib/v4-account-id-mapping.mjs'
import { inspectAccountConversion, convertAccountRows } from '../scripts/lib/v4-account-conversion.mjs'
const evidence = row => ({ ...row, sourceHash: hash(row) })
function fixture() {
  const rows = ['2', '10'].map((id, index) => ({ id, user_id: String(index + 1), broker_server: 'Broker', login_account: '00123',
    nickname: index ? null : '', margin_mode: 'hedging', review_status: 'approved', observe_status: index ? 'transferred' : 'active',
    is_deleted: index ? '1' : '0', created_at: `2026-09-0${index + 1} 00:30:00`, updated_at: '2026-09-06 08:00:00',
    observed_until: null, identity_verified_at: '2026-09-02 08:00:00', first_verified_at: null, anomaly_code: index ? 'account_transferred' : null }))
  const input = { accounts: rows.map(row => evidence({ id: row.id, userId: row.user_id, server: row.broker_server, login: row.login_account })),
    terminals: rows.map(row => evidence({ id: `terminal${row.id}`, userId: row.user_id, platform: 'mt5', server: row.broker_server, login: row.login_account })),
    bindings: [evidence({ server: 'BROKER', login: '00123', currentUserId: '1', currentAccountId: '2', currency: 'USD' })] }
  return { rows, plan: planAccountIdMappings('test', input, ['2', '10']), options: { userIds: new Set(['1', '2']),
    timeBasis: { sourceTable: 'trading_accounts', offsetMinutes: 480, evidenceId: 'test-fixture-only' } } }
}
it('preserves both users settings and exact source fields while deriving one public entity', () => {
  const { rows, plan, options } = fixture(), result = convertAccountRows(rows, plan, options)
  expect(result.entities).toHaveLength(1); expect(result.settings).toHaveLength(2)
  expect(result.entities[0].target).toMatchObject({ account_login: '00123', created_at_utc: '2026-08-31 16:30:00.000', deleted_at_utc: null })
  expect(result.settings[0].target.nickname).toBe(''); expect(result.settings[1].target.nickname).toBeNull()
  expect(result.settings[1].target).toMatchObject({ hidden: '1', legacy_is_deleted: '1', observe_status: 'transferred', anomaly_code: 'account_transferred' })
  expect(result.settings.map(entry => entry.provenance.source)).toEqual(rows)
  expect(convertAccountRows([...rows].reverse(), plan, options).transformHash).toBe(result.transformHash)
})
it('allows inspection without a timezone but refuses to produce converted dates', () => {
  const { rows, plan, options } = fixture()
  expect(inspectAccountConversion(rows, plan, options.userIds).coveredFields).toHaveLength(15)
  expect(() => convertAccountRows(rows, plan, { ...options, timeBasis: null })).toThrow('account_conversion_time_basis_required')
  expect(() => convertAccountRows(rows, plan, { ...options, timeBasis: { ...options.timeBasis, sourceTable: 'mt5_account_ownership_history' } })).toThrow('account_conversion_time_basis_required')
})
it('rejects conflicting public margin facts, incomplete sets and unexpected fields', () => {
  const { rows, plan, options } = fixture()
  expect(() => inspectAccountConversion([{ ...rows[0], margin_mode: 'netting' }, rows[1]], plan, options.userIds)).toThrow('account_conversion_margin_conflict')
  expect(() => inspectAccountConversion(rows.slice(0, 1), plan, options.userIds)).toThrow('account_conversion_source_coverage_invalid')
  expect(() => inspectAccountConversion([{ ...rows[0], extra: 'unmapped' }, rows[1]], plan, options.userIds)).toThrow('backfill_shape_invalid')
})
it('rejects truncation, invalid delete flags and nonexistent users', () => {
  const { rows, plan, options } = fixture()
  expect(() => inspectAccountConversion([{ ...rows[0], nickname: '字'.repeat(101) }, rows[1]], plan, options.userIds)).toThrow('identity_text_too_long')
  expect(() => inspectAccountConversion([{ ...rows[0], is_deleted: '2' }, rows[1]], plan, options.userIds)).toThrow('account_conversion_deleted_invalid')
  expect(() => inspectAccountConversion(rows, plan, new Set(['1']))).toThrow('account_conversion_source_identity_invalid')
})
it('rejects mapping tampering even when a caller recalculates the digest', () => {
  const { rows, plan, options } = fixture()
  plan.mappings[0].target.pk[0].value = '999'
  plan.mappingHash = hash({ entities: plan.entities, mappings: plan.mappings, settings: plan.settings })
  expect(() => inspectAccountConversion(rows, plan, options.userIds)).toThrow('account_conversion_mapping_mismatch')
})
