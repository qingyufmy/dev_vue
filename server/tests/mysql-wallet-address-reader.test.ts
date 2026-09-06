import { expect, it, vi } from 'vitest'
import type { PoolConnection } from 'mysql2/promise'
import { listWalletAddresses } from '../src/modules/commerce/infrastructure/mysql-wallet-address-reader.js'
const row = (id = '1', index = '0') => ({ id, chain: 'TRON', address_index: index, address: 'synthetic-address',
  created_at_utc: '2026-09-07T01:02:03.123Z', revision: '9007199254740993', custody_reference: null,
  custody_evidence_sha256: null, custody_verified_at_utc: null })
function fixture(rows: unknown[]) {
  const execute = vi.fn(async () => [rows, []])
  return { execute, c: { execute } as unknown as Pick<PoolConnection, 'execute'> }
}
it('enumerates sparse IDs and derivation indices with an exact cursor and bigint revision', async () => {
  const f = fixture([row('4', '9'), row('15', '100')])
  expect(await listWalletAddresses(f.c, { chain: 'TRON', afterId: '2', limit: 1 })).toEqual({ items: [{
    id: '4', chain: 'TRON', addressIndex: '9', address: 'synthetic-address', createdAtUtc: '2026-09-07T01:02:03.123Z',
    revision: '9007199254740993', custody: { status: 'unverified' } }], nextAfterId: '4' })
  expect(f.execute.mock.calls[0]).toEqual([expect.stringContaining('ORDER BY id LIMIT 2'), ['TRON', '2']])
})
it('preserves NULL creation and separates complete custody evidence from unverified metadata', async () => {
  const f = fixture([{ ...row(), created_at_utc: null, custody_reference: 'vault:key-1', custody_evidence_sha256: 'a'.repeat(64), custody_verified_at_utc: '2026-09-07T00:00:00.000Z' }])
  expect((await listWalletAddresses(f.c, { chain: 'TRON' })).items[0]).toMatchObject({ createdAtUtc: null, custody: { status: 'verified', reference: 'vault:key-1' } })
  expect(await listWalletAddresses(fixture([]).c, { chain: 'TRON' })).toEqual({ items: [], nextAfterId: null })
})
it('rejects bad scope before SQL and rejects unordered or cross-chain pages including lookahead', async () => {
  for (const change of [{ limit: 0 }, { limit: 201 }, { afterId: '01' }, { afterId: '2147483648' }]) {
    const f = fixture([])
    await expect(listWalletAddresses(f.c, { chain: 'TRON', ...change })).rejects.toThrow('scope_invalid')
    expect(f.execute).not.toHaveBeenCalled()
  }
  for (const rows of [[row('2'), row('1')], [row('1'), row('1')], [row(), { ...row('2'), chain: 'ETH' }]]) {
    await expect(listWalletAddresses(fixture(rows).c, { chain: 'TRON', limit: 1 })).rejects.toThrow('state_invalid')
  }
})
it('rejects precision loss, impossible timestamps and partial custody without exposing a usable record', async () => {
  for (const change of [{ revision: 9007199254740992 }, { address_index: '-1' }, { address: 'addr ' },
    { created_at_utc: '2026-02-30T00:00:00.000Z' }, { custody_reference: 'vault:key-1' },
    { custody_evidence_sha256: 'a'.repeat(64) }]) {
    await expect(listWalletAddresses(fixture([{ ...row(), ...change }]).c, { chain: 'TRON' })).rejects.toThrow()
  }
})
