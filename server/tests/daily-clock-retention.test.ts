import { expect, it, vi } from 'vitest'
import type { PoolConnection } from 'mysql2/promise'
import type { TrustedBridgeProjectionWrite } from '../src/modules/trading/index.js'
import { resolveStoredAccountClock } from '../src/modules/trading/infrastructure/mysql-account-clock.js'

const input = { route: { accountId: '1', userId: 2, terminalProfileId: 'profile', terminalInstanceId: 'terminal', connectionEpoch: 3 },
  projection: { resource: 'account.metrics', data: { observedAt: '2026-09-15T07:00:00.000Z', clockStatus: 'unavailable', timezoneOffsetMinutes: null } },
} as TrustedBridgeProjectionWrite
const ownership = { intervalId: 'owner', ownershipRevision: '1' }
it('retains a daily proof without treating metrics as a fresh calibration', async () => {
  const execute = vi.fn().mockResolvedValueOnce([[{ reported_offset_minutes: 0 }]])
  expect(await resolveStoredAccountClock({ execute } as unknown as PoolConnection, input, ownership))
    .toEqual({ timezoneOffsetMinutes: 0, clockStatus: 'calibrated' })
  expect(input.projection.resource === 'account.metrics' && input.projection.data.clockStatus).toBe('unavailable')
  const [sql, params] = execute.mock.calls[0]!
  expect(sql).toContain("reported_status='calibrated'")
  expect(sql).toContain('INTERVAL 24 HOUR')
  expect(params.slice(0, 6)).toEqual(['1', 2, 'owner', '1', 'profile', 'terminal'])
})
it('fails stale when no unexpired proof exists instead of renewing a retained offset', async () => {
  const execute = vi.fn().mockResolvedValueOnce([[]]).mockResolvedValueOnce([[{ timezone_offset_minutes: 180, clock_status: 'calibrated' }]])
  expect(await resolveStoredAccountClock({ execute } as unknown as PoolConnection, input, ownership))
    .toEqual({ timezoneOffsetMinutes: 180, clockStatus: 'stale' })
})
it('does not override explicit stale status with an earlier observation', async () => {
  const changed = structuredClone(input)
  if (changed.projection.resource === 'account.metrics') changed.projection.data.clockStatus = 'stale'
  const execute = vi.fn().mockResolvedValueOnce([[]])
  expect((await resolveStoredAccountClock({ execute } as unknown as PoolConnection, changed, ownership))?.clockStatus).toBe('unavailable')
  expect(execute.mock.calls[0]![0]).not.toContain('terminal_clock_observations_v4')
})
