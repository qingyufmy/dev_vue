import { describe, expect, it, vi } from 'vitest'
import type { PoolConnection } from 'mysql2/promise'
import type { BridgeGatewayRoute } from '../src/modules/bridge/index.js'
import type { BridgeCommand, ExecutionAction } from '../src/modules/execution/index.js'
import { createPartialCloseParentDispatchCapture } from '../src/bootstrap/partial-close-dispatch.js'

const spies = vi.hoisted(() => ({ write: vi.fn(async () => '2026-09-11T00:00:00.000Z'), reviewer: vi.fn(() => ({})), target: vi.fn(() => ({})) }))
vi.mock('../src/modules/execution/composition.js', () => ({ writePartialCloseParentDispatchReview: spies.write }))
vi.mock('../src/modules/trading/composition.js', () => ({ createMysqlExecutionPositionReader: () => ({}), createTransactionTerminalFactRouteGuard: () => ({}) }))
vi.mock('../src/bootstrap/partial-close-registration.js', () => ({ createPartialCloseRegistrationTargetReader: spies.target }))
vi.mock('../src/bootstrap/partial-close-dispatch-review.js', () => ({ createTransactionPartialCloseDispatchReviewer: spies.reviewer }))
const route = { userId: 7, accountId: '5', platform: 'mt5', terminalProfileId: 'profile', terminalInstanceId: 'terminal',
  brokerServer: 'Broker', login: '42', connectionEpoch: 1 } as BridgeGatewayRoute
const command = () => ({ id: 'command', requestHash: 'hash', userId: 7, accountId: '5', terminalProfileId: 'profile',
  route: { terminalInstanceId: 'terminal', brokerServer: 'Broker', login: '42', connectionEpoch: 1 } }) as BridgeCommand
const limits = { maxAgeMs: 30000, maxInstrumentAgeMs: 300000 }
describe('parent close dispatch capture', () => {
  it('freezes route and bounds before SQL and passes the locked candidate and one connection to the writer', async () => {
    vi.clearAllMocks()
    const mutableRoute = structuredClone(route), bounds = { ...limits }, source = command(), candidate = structuredClone(source)
    const current = vi.fn(async () => mutableRoute)
    const callback = await createPartialCloseParentDispatchCapture({ current }, bounds)(source)
    mutableRoute.connectionEpoch = 2; bounds.maxAgeMs = 1; source.requestHash = 'changed'
    expect(spies.write).not.toHaveBeenCalled()
    const connection = {} as PoolConnection, action = {} as ExecutionAction
    await expect(callback(connection, candidate, action, 1000)).resolves.toBe('2026-09-11T00:00:00.000Z')
    expect(current).toHaveBeenCalledExactlyOnceWith('5')
    expect(spies.reviewer).toHaveBeenCalledWith(connection, route, limits)
    expect(spies.write).toHaveBeenCalledWith(connection, candidate, action, 1000, expect.any(Object), expect.any(Object))
  })
  it.each([{ platform: 'mt4' }, { userId: 8 }, { accountId: '6' }, { terminalProfileId: 'other' },
    { terminalInstanceId: 'other' }, { brokerServer: 'broker' }, { login: '43' }, { connectionEpoch: 2 }])('rejects changed route %j before SQL', async patch => {
    vi.clearAllMocks()
    const callback = await createPartialCloseParentDispatchCapture({ current: async () => ({ ...route, ...patch }) as BridgeGatewayRoute }, limits)(command())
    await expect(callback({} as PoolConnection, command(), {} as ExecutionAction, 1000)).rejects.toThrow('partial_close_dispatch_route_unavailable')
    expect(spies.write).not.toHaveBeenCalled(); expect(spies.reviewer).not.toHaveBeenCalled()
  })
  it.each(['id', 'requestHash'] as const)('rejects a changed locked command %s', async field => {
    vi.clearAllMocks()
    const candidate = command(), callback = await createPartialCloseParentDispatchCapture({ current: async () => route }, limits)(candidate)
    candidate[field] = 'other'
    await expect(callback({} as PoolConnection, candidate, {} as ExecutionAction, 1000)).rejects.toThrow('partial_close_dispatch_route_unavailable')
    expect(spies.write).not.toHaveBeenCalled()
  })
  it('propagates missing route and Redis errors without SQL', async () => {
    vi.clearAllMocks()
    const callback = await createPartialCloseParentDispatchCapture({ current: async () => null }, limits)(command())
    await expect(callback({} as PoolConnection, command(), {} as ExecutionAction, 1000)).rejects.toThrow('partial_close_dispatch_route_unavailable')
    await expect(createPartialCloseParentDispatchCapture({ current: async () => { throw Error('redis_down') } }, limits)(command())).rejects.toThrow('redis_down')
    expect(spies.write).not.toHaveBeenCalled()
  })
})
