import { expect, it } from 'vitest'
import { convertOwnershipRows, resolveOwnershipTime } from '../scripts/lib/v4-ownership-conversion.mjs'

const basis = { sourceTable: 'mt5_account_ownership_history', offsetMinutes: 480, evidenceId: 'synthetic-test-only' }
const options = { logicalSourceId: 'fixture', accountMap: new Map([
  ['1', { targetAccountId: '10', brokerServerKey: 'BROKER', accountLogin: '123' }],
  ['2', { targetAccountId: '10', brokerServerKey: 'BROKER', accountLogin: '123' }],
]), userIds: new Set(['1', '2']), timeBasis: basis }
const row = (extra = {}) => ({ id: '1', broker_server_key: 'BROKER', login_account: '123', user_id: '1', trading_account_id: '1',
  started_at: '2026-09-06 08:00:00', ended_at: '2026-09-06 09:00:00', end_reason: 'account_transferred',
  created_at: '2026-09-06 08:00:00', updated_at: '2026-09-06 09:00:00', ...extra })

it('requires an explicit historical basis and preserves millisecond precision', () => {
  expect(() => resolveOwnershipTime('2026-09-06 08:00:00', null)).toThrow('ownership_time_basis_required')
  expect(resolveOwnershipTime('2026-09-06 08:00:00.123', basis)).toBe('2026-09-06 00:00:00.123')
  expect(() => resolveOwnershipTime('2026-09-06 08:00:00.123001', basis)).toThrow('identity_time_precision_loss')
  expect(() => resolveOwnershipTime('1000-01-01 00:00:00', basis)).toThrow('ownership_time_out_of_range')
})
it('preserves every interval and the historical owner through an account merge', () => {
  const rows = [row(), row({ id: '2', trading_account_id: '2', user_id: '2', started_at: '2026-09-06 09:00:00', ended_at: null, end_reason: null })]
  const result = convertOwnershipRows(rows, options)
  expect(result.intervalCount).toBe(2)
  expect(result.openCount).toBe(1)
  expect(result.entries.map(entry => entry.target.user_id)).toEqual(['1', '2'])
  expect(result.grants.find(grant => grant.user_id === '1').revoked_at_utc).toBe('2026-09-06 01:00:00.000')
  expect(result.grants.find(grant => grant.user_id === '2').revoked_at_utc).toBeNull()
  expect(convertOwnershipRows([...rows].reverse(), options).transformationHash).toBe(result.transformationHash)
})
it('checks overlap after merging legacy IDs and rejects stale identity mappings', () => {
  expect(() => convertOwnershipRows([row(), row({ id: '2', trading_account_id: '2', started_at: '2026-09-06 08:30:00' })], options)).toThrow('ownership_interval_overlap')
  expect(() => convertOwnershipRows([row({ broker_server_key: 'OTHER' })], options)).toThrow('ownership_account_mapping_mismatch')
  expect(() => convertOwnershipRows([row({ user_id: '3' })], options)).toThrow('ownership_source_user_missing')
})
it('retains zero-length evidence without revoking an overlapping current owner', () => {
  const result = convertOwnershipRows([row({ ended_at: null, end_reason: null }),
    row({ id: '2', started_at: '2026-09-06 09:00:00', ended_at: '2026-09-06 09:00:00' })], options)
  expect(result.intervalCount).toBe(2)
  expect(result.grants).toHaveLength(1)
  expect(result.grants[0].revoked_at_utc).toBeNull()
})
it('rejects duplicate and reversed source intervals instead of silently skipping', () => {
  expect(() => convertOwnershipRows([row(), row()], options)).toThrow('ownership_duplicate_source_interval')
  expect(() => convertOwnershipRows([row({ ended_at: '2026-09-06 07:00:00' })], options)).toThrow('ownership_interval_reversed')
})
it('rejects two different broker identities assigned to one target account even without overlap', () => {
  const accountMap = new Map(options.accountMap)
  accountMap.set('2', { targetAccountId: '10', brokerServerKey: 'OTHER', accountLogin: '123' })
  expect(() => convertOwnershipRows([row()], { ...options, accountMap })).toThrow('ownership_target_identity_collision')
})
