import { beforeEach, expect, it, vi } from 'vitest'
import type { PoolConnection } from 'mysql2/promise'
import type { BridgeGatewayRoute } from '../src/modules/bridge/index.js'
import type { BridgeCommand, PositionProtectionChild } from '../src/modules/execution/index.js'
const mocks = vi.hoisted(() => ({ read: vi.fn(), make: vi.fn() }))
vi.mock('../src/modules/trading/composition.js', () => ({
  createTransactionTerminalFactRouteGuard: () => ({}),
  createMysqlExecutionPositionCollectionReader: mocks.make,
}))
import { createPositionProtectionOutcomeProjectionCapture } from '../src/bootstrap/position-protection-outcome.js'
const scope = { workflowId: '11111111-1111-4111-a111-111111111111', userId: 7, accountId: '5' }
const route = { userId: 7, accountId: '5', platform: 'mt5', terminalInstanceId: 'terminal-1', brokerServer: 'Broker', login: '42', connectionEpoch: 2 } as BridgeGatewayRoute
const target = { terminalInstanceId: 'terminal-1', brokerServer: 'Broker', login: '42', ticket: '101', positionIdentifier: '100', symbol: 'XAUUSD', side: 'buy' }
const child = { request: { ...scope, target } } as PositionProtectionChild
const command = { route: { connectionEpoch: 1 } } as BridgeCommand
const db = {} as PoolConnection
const position = { accountId: '5', ticket: '101', positionIdentifier: '100', symbol: 'XAUUSD', side: 'buy', volume: '0.02', takeProfit: null }
beforeEach(() => { vi.clearAllMocks(); mocks.make.mockReturnValue({ read: mocks.read }); mocks.read.mockResolvedValue({ accountId: '5', revision: 9, observedAt: '2026-09-10T00:00:00.000Z', positions: [position] }) })
it('freezes route before SQL and preserves unknown versus absent protection', async () => {
  const active = structuredClone(route), current = vi.fn(async () => active)
  const reader = await createPositionProtectionOutcomeProjectionCapture({ current }, 1000)(scope)
  active.connectionEpoch = 99
  const result = await reader(db, child, command)
  expect(current).toHaveBeenCalledExactlyOnceWith('5')
  expect(mocks.read.mock.calls[0]![0].route.connectionEpoch).toBe(2)
  expect(result?.positions[0]).not.toHaveProperty('stopLoss')
  expect(result?.positions[0]?.takeProfit).toBeNull()
})
it.each([null, { ...route, platform: 'mt4' }, { ...route, userId: 8 }, { ...route, connectionEpoch: 0 }])('rejects unavailable or foreign route before reading positions', async active => {
  const reader = await createPositionProtectionOutcomeProjectionCapture({ current: async () => active as BridgeGatewayRoute | null }, 1000)(scope)
  expect(await reader(db, child, command)).toBeNull(); expect(mocks.read).not.toHaveBeenCalled()
})
it('does not treat unknown stable identity as verified absence', async () => {
  mocks.read.mockResolvedValue({ accountId: '5', revision: 9, observedAt: '2026-09-10T00:00:00.000Z', positions: [{ ...position, positionIdentifier: null }] })
  const reader = await createPositionProtectionOutcomeProjectionCapture({ current: async () => route }, 1000)(scope)
  expect(await reader(db, child, command)).toBeNull()
})
it('accepts verified empty complete collections as absence evidence', async () => {
  mocks.read.mockResolvedValue({ accountId: '5', revision: 9, observedAt: '2026-09-10T00:00:00.000Z', positions: [] })
  const reader = await createPositionProtectionOutcomeProjectionCapture({ current: async () => route }, 1000)(scope)
  expect(await reader(db, child, command)).toMatchObject({ complete: true, positions: [] })
})
it('defers Redis errors until new outcome facts are required', async () => {
  const error = new Error('redis_unavailable')
  const reader = await createPositionProtectionOutcomeProjectionCapture({ current: async () => { throw error } }, 1000)(scope)
  expect(mocks.make).not.toHaveBeenCalled()
  await expect(reader(db, child, command)).rejects.toBe(error)
})
