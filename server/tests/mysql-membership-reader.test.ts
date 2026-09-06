import type { PoolConnection } from 'mysql2/promise'
import { expect, it, vi } from 'vitest'
import { readCurrentMembership } from '../src/modules/commerce/infrastructure/mysql-membership-reader.js'
const row = () => ({ user_id: '2', plan_code: 'plus', billing_period_code: '', source_code: null,
  expiration_kind: 'at_time', expires_at_utc: '2026-09-07T01:00:00.123Z', revision: '9007199254740993' })
const fixture = (rows: unknown[]) => {
  const execute = vi.fn(async (_sql: string, _params: unknown[]) => [rows, []])
  return { execute, connection: { execute } as unknown as Pick<PoolConnection, 'execute'> }
}
it('reads only the requested normalized membership with exact revision and UTC milliseconds', async () => {
  const { execute, connection } = fixture([row()])
  expect(await readCurrentMembership(connection, 2)).toMatchObject({ userId: 2, revision: '9007199254740993', expiresAtUtc: '2026-09-07T01:00:00.123Z' })
  expect(execute.mock.calls[0]?.[1]).toEqual([2])
})
it('reports missing rows and rejects wrong owners, duplicate rows and invalid state', async () => {
  expect(await readCurrentMembership(fixture([]).connection, 2)).toBeNull()
  for (const rows of [[{ ...row(), user_id: '3' }], [row(), row()]]) {
    await expect(readCurrentMembership(fixture(rows).connection, 2)).rejects.toThrow('membership_read_identity_mismatch')
  }
  await expect(readCurrentMembership(fixture([{ ...row(), expiration_kind: 'no_expiry' }]).connection, 2)).rejects.toThrow('membership_expiry_invalid')
})
it('rejects invalid users before SQL', async () => {
  const { connection, execute } = fixture([])
  await expect(readCurrentMembership(connection, 0)).rejects.toThrow('membership_user_invalid')
  expect(execute).not.toHaveBeenCalled()
})
