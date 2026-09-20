import { expect, it, vi } from 'vitest'
import type { PoolConnection } from 'mysql2/promise'
import type { TrustedBridgeProjectionWrite } from '../src/modules/trading/application/trading-ports.js'
import { appendClockObservation } from '../src/modules/trading/infrastructure/mysql-clock-observation-writer.js'

const input = (): TrustedBridgeProjectionWrite => ({
  route: { accountId: '5', userId: 7, terminalProfileId: 'profile', terminalInstanceId: 'terminal', connectionEpoch: 9, connectionId: 'connection' },
  projection: { resource: 'account.metrics', resourceId: 'current', accountId: '5', revision: 12,
    data: { id: '5', revision: 12, timezoneOffsetMinutes: null, clockStatus: 'unavailable', observedAt: '2026-09-11T00:00:00.000Z' } },
} as TrustedBridgeProjectionWrite)
const ownership = { intervalId: 'interval', ownershipRevision: '3' }
const effective = { timezoneOffsetMinutes: 180, clockStatus: 'stale' as const }
it('retains the raw unavailable observation separately from the carried offset', async () => {
  const execute = vi.fn().mockResolvedValue([{}, []])
  await appendClockObservation({ execute } as unknown as PoolConnection, input(), ownership, effective)
  const [sql, values] = execute.mock.calls[0]!
  expect(sql).not.toContain('ON DUPLICATE KEY')
  expect(values.slice(0,14)).toEqual(['5',12,7,'interval','3','profile','terminal',9,'connection',null,'unavailable',180,'stale','2026-09-11 00:00:00.000'])
  expect(values[14]).toMatch(/^[a-f0-9]{64}$/)
  const changed = input(); changed.route.connectionEpoch++
  await appendClockObservation({ execute } as unknown as PoolConnection, changed, ownership, effective)
  expect(execute.mock.calls[1]![1][14]).not.toBe(values[14])
})
it('rejects mismatched account/revision and non-canonical observation times before SQL', async () => {
  const execute = vi.fn()
  for (const mutate of [
    (value: TrustedBridgeProjectionWrite) => { value.route.accountId = '6' },
    (value: TrustedBridgeProjectionWrite) => { value.projection.revision = 13 },
    (value: TrustedBridgeProjectionWrite) => { if (value.projection.resource === 'account.metrics') value.projection.data.observedAt = '2026-09-11T03:00:00+03:00' },
  ]) {
    const value = input(); mutate(value)
    await expect(appendClockObservation({ execute } as unknown as PoolConnection, value, ownership, effective)).rejects.toThrow('trading_context_invalid')
  }
  expect(execute).not.toHaveBeenCalled()
})
it('propagates insert failure so the caller rolls back its projection transaction', async () => {
  const execute = vi.fn().mockRejectedValue(Error('db_failed'))
  await expect(appendClockObservation({ execute } as unknown as PoolConnection, input(), ownership, effective)).rejects.toThrow('db_failed')
})
