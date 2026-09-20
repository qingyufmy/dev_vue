import type { PartialCloseProtectionPlan } from '../src/modules/execution/domain/partial-close-protection.js'
import { describe, expect, it, vi } from 'vitest'
import type { PoolConnection } from 'mysql2/promise'
import type { BridgeGatewayRoute } from '../src/modules/bridge/index.js'
import type { BridgeCommand } from '../src/modules/execution/index.js'
import { createPartialCloseRegistrationCapture } from '../src/bootstrap/partial-close-registration.js'
import { bridgeCommandSqlTime } from '../src/modules/execution/infrastructure/bridge-command-sql-time.js'

const register = vi.hoisted(() => vi.fn(async () => {}))
vi.mock('../src/modules/execution/composition.js', () => ({ createMysqlPartialCloseWorkflowWriter: () => ({ register }) }))
const route: BridgeGatewayRoute = { userId: 7, accountId: '5', platform: 'mt5', terminalProfileId: 'profile', terminalInstanceId: 'terminal',
  brokerServer: 'Broker', login: '42', connectionEpoch: 1, connectionId: 'connection', sessionId: 'session', installationId: 'installation',
  credentialGeneration: 1, ownershipRevision: '1', timezoneOffsetMinutes: 180 }
const command = () => ({ userId: 7, accountId: '5', terminalProfileId: 'profile', route: { terminalInstanceId: 'terminal', brokerServer: 'Broker', login: '42', connectionEpoch: 1 } }) as BridgeCommand
describe('partial close route capture boundary', () => {
  it('freezes route and command before the transaction callback and never rereads Redis from that callback', async () => {
    register.mockClear()
    const currentRoute = structuredClone(route), current = vi.fn(async () => currentRoute), input = command()
    const callback = await createPartialCloseRegistrationCapture({ current }, 30000)(input)
    expect(current).toHaveBeenCalledExactlyOnceWith('5')
    expect(register).not.toHaveBeenCalled()
    currentRoute.connectionEpoch = 2
    input.route.connectionEpoch = 3
    const plan = {} as PartialCloseProtectionPlan
    await callback({} as PoolConnection, plan)
    expect(register).toHaveBeenCalledExactlyOnceWith(plan)
    expect(current).toHaveBeenCalledTimes(1)
  })
  it.each([{ platform: 'mt4' }, { userId: 8 }, { accountId: '6' }, { terminalProfileId: 'other' },
    { terminalInstanceId: 'other' }, { brokerServer: 'broker' }, { login: '43' }, { connectionEpoch: 2 }])('rejects a mismatched route %j before SQL registration', async patch => {
    register.mockClear()
    const current = async () => ({ ...route, ...patch }) as BridgeGatewayRoute
    const callback = await createPartialCloseRegistrationCapture({ current }, 30000)(command())
    await expect(callback({} as PoolConnection, {} as PartialCloseProtectionPlan)).rejects.toThrow('partial_close_registration_route_unavailable')
    expect(register).not.toHaveBeenCalled()
  })
  it('leaves missing routes unusable and propagates lookup failures before transaction creation', async () => {
    const callback = await createPartialCloseRegistrationCapture({ current: async () => null }, 30000)(command())
    await expect(callback({} as PoolConnection, {} as PartialCloseProtectionPlan)).rejects.toThrow('partial_close_registration_route_unavailable')
    await expect(createPartialCloseRegistrationCapture({ current: async () => { throw Error('redis_down') } }, 30000)(command())).rejects.toThrow('redis_down')
  })
})
describe('Bridge SQL UTC timestamp binding', () => {
  it('preserves milliseconds and UTC calendar fields without a timezone conversion', () => {
    expect(bridgeCommandSqlTime('2026-09-10T23:59:59.123Z')).toBe('2026-09-10 23:59:59.123')
  })
  it.each(['2026-02-30T00:00:00.000Z', '2026-09-10T00:00:00.000+08:00', '2026-09-10 00:00:00.000', 'invalid'])('rejects noncanonical or impossible UTC time %s', value => {
    expect(() => bridgeCommandSqlTime(value)).toThrow('bridge_command_time_invalid')
  })
})
