import { expect, it, vi } from 'vitest'
import type { PoolConnection } from 'mysql2/promise'
import { readExecutionPendingSnapshot } from '../src/modules/trading/infrastructure/mysql-trading-repository.js'

const input = { userId: 7, accountId: '42', terminalInstanceId: 't1', brokerServer: 'Broker-Demo', login: '123', connectionEpoch: '9', ownershipRevision: '2' }
const account = { id: '42', owner_user_id: 7, ownership_interval_id: 'i1', ownership_revision: '2', profile_id: 'p1', terminal_instance_id: 't1', broker_server: 'Broker-Demo', account_login: '123' }
const source = { revision: 3, projection_revision: 3, source_user_id: 7, source_interval_id: 'i1', source_ownership_revision: '2',
  source_profile_id: 'p1', source_instance_id: 't1', source_connection_epoch: '9', observed_at: '2026-09-09T02:00:00.123000Z' }
function fixture(options: { source?: object; accounts?: object[]; sessions?: object[]; items?: object[] } = {}) {
  const execute = vi.fn(async (sql: string) => {
    if (sql.startsWith('SELECT id FROM trading_accounts')) return [[{ id: '42' }]]
    if (sql.includes('trading_projection_provenance_v4')) return [[options.source ?? source]]
    if (sql.includes('FROM bridge_connection_sessions')) return [options.sessions ?? [{ id: 's1' }]]
    if (sql.includes('FROM pending_order_snapshots')) return [options.items ?? []]
    return [options.accounts ?? [account]]
  })
  return { connection: { execute } as unknown as PoolConnection, execute }
}
it('returns complete empty snapshot only after ownership, provenance and live session checks', async () => {
  const f = fixture()
  await expect(readExecutionPendingSnapshot(f.connection, input)).resolves.toMatchObject({ complete: true, revision: '3', observedAt: '2026-09-09T02:00:00.123Z', items: [] })
  expect(f.execute.mock.calls.filter(([sql]) => sql.includes('FOR SHARE'))).toHaveLength(4)
})
it.each([{ accounts: [] }, { source: { ...source, source_interval_id: 'old' } }, { source: { ...source, source_connection_epoch: '8' } },
  { accounts: [{ ...account, broker_server: 'broker-demo' }] }, { accounts: [{ ...account, account_login: '0123' }] },
  { sessions: [] }, { source: { ...source, projection_revision: 2 } },
  { items: [{ revision: 2, payload_json: {} }] }, { items: [{ revision: 3, payload_json: '{bad' }] },
  { items: [{ revision: 3, payload_json: { accountId: 'other', revision: 3, ticket: '1' } }] }])('rejects incomplete or stale source rather than returning empty complete', async options => {
  const f = fixture(options)
  await expect(readExecutionPendingSnapshot(f.connection, input)).resolves.toBeNull()
})
