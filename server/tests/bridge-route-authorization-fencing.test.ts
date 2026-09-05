import { describe, expect, it, vi } from 'vitest'
import { BridgeGatewayCommandTransport } from '../src/modules/bridge/application/bridge-gateway-transport.js'
import { BridgeGatewayQueryTransport } from '../src/modules/bridge/application/bridge-gateway-query-transport.js'
import { BridgeGatewaySession } from '../src/modules/bridge/application/bridge-gateway-session.js'
import type { BridgeGatewayRoute } from '../src/modules/bridge/domain/bridge-gateway.js'
import type { BridgeGatewayDirectory, BridgeGatewayLeaseStore, BridgeGatewayRouteRepository } from '../src/modules/bridge/application/bridge-gateway-ports.js'
import type { BridgeCommand, BridgeCommandRequestEnvelope } from '../src/modules/execution/domain/bridge-command.js'
import type { BridgeCommandService } from '../src/modules/execution/application/bridge-command-service.js'

const route: BridgeGatewayRoute = {
  userId: 7, accountId: '42', platform: 'mt5', timezoneOffsetMinutes: 0, terminalProfileId: 'profile_fixture',
  installationId: 'installation_fixture', credentialGeneration: 1, ownershipRevision: '1',
  terminalInstanceId: 'terminal_fixture', brokerServer: 'Test-Demo', login: '12345678', connectionEpoch: 3,
  connectionId: 'connection_fixture', sessionId: 'session_fixture',
}
const wire = { terminal_instance_id: route.terminalInstanceId, account_ref: { broker_server: route.brokerServer, login: route.login }, connection_epoch: route.connectionEpoch }

function fixture() {
  const send = vi.fn()
  const current = vi.fn(async () => route as BridgeGatewayRoute | null)
  const leases: BridgeGatewayLeaseStore = { current, claim: vi.fn(), renew: vi.fn(async () => true), release: vi.fn() }
  const directory: BridgeGatewayDirectory = { get: () => ({ send, close: vi.fn() }), attach: vi.fn(), detach: vi.fn(), replace: vi.fn() }
  const authorization = { isAuthorized: vi.fn(async () => false) }
  return { send, current, leases, directory, authorization }
}

describe('P5A route authorization fencing', () => {
  it('never routes an old owner or profile command to a matching wire epoch on another profile', async () => {
    const f = fixture()
    f.authorization.isAuthorized.mockResolvedValue(true)
    const transport = new BridgeGatewayCommandTransport(f.leases, f.directory, f.authorization)
    for (const scope of [{ userId: 8, terminalProfileId: route.terminalProfileId }, { userId: route.userId, terminalProfileId: 'old_profile' }]) {
      expect(await transport.currentRoute({ accountId: route.accountId, ...scope } as BridgeCommand)).toBeNull()
      await expect(transport.send({ route: wire } as BridgeCommandRequestEnvelope, route.accountId, scope))
        .rejects.toMatchObject({ code: 'bridge_route_unavailable' })
    }
    expect(f.send).not.toHaveBeenCalled()
    expect(f.authorization.isAuthorized).not.toHaveBeenCalled()
  })

  it('never exposes a revoked route or sends a command to it', async () => {
    const f = fixture()
    const transport = new BridgeGatewayCommandTransport(f.leases, f.directory, f.authorization)
    expect(await transport.currentRoute({ accountId: '42', userId: route.userId, terminalProfileId: route.terminalProfileId } as BridgeCommand)).toBeNull()
    await expect(transport.send({ route: wire } as BridgeCommandRequestEnvelope, '42', route))
      .rejects.toMatchObject({ code: 'bridge_route_authorization_revoked', status: 403 })
    expect(f.send).not.toHaveBeenCalled()
  })

  it('rechecks the current lease after asynchronous command authorization', async () => {
    const f = fixture()
    f.authorization.isAuthorized.mockResolvedValue(true)
    f.current.mockResolvedValueOnce(route).mockResolvedValueOnce({ ...route, connectionId: 'replacement_fixture' })
    const transport = new BridgeGatewayCommandTransport(f.leases, f.directory, f.authorization)
    await expect(transport.send({ route: wire } as BridgeCommandRequestEnvelope, '42', route)).rejects.toMatchObject({ code: 'bridge_route_unavailable' })
    expect(f.send).not.toHaveBeenCalled()
  })

  it('fails closed on an authorization store error without sending a command', async () => {
    const f = fixture()
    f.authorization.isAuthorized.mockRejectedValue(new Error('storage_failure'))
    const transport = new BridgeGatewayCommandTransport(f.leases, f.directory, f.authorization)
    await expect(transport.send({ route: wire } as BridgeCommandRequestEnvelope, '42', route)).rejects.toThrow('storage_failure')
    expect(f.send).not.toHaveBeenCalled()
  })

  it('does not send history queries or allocate pending timers for a revoked route', async () => {
    const f = fixture()
    const transport = new BridgeGatewayQueryTransport(f.leases, f.directory, f.authorization)
    await expect(transport.query({ route, resource: 'history.deals', rangeStartUtcMsc: 1, rangeEndUtcMsc: 2 }))
      .rejects.toMatchObject({ code: 'bridge_route_authorization_revoked' })
    expect(f.send).not.toHaveBeenCalled()
    expect(transport.inflight()).toBe(0)
  })

  it('does not send a query after its lease was replaced during reauthorization', async () => {
    const f = fixture()
    f.authorization.isAuthorized.mockResolvedValue(true)
    f.current.mockResolvedValueOnce(route).mockResolvedValueOnce(null)
    const transport = new BridgeGatewayQueryTransport(f.leases, f.directory, f.authorization)
    await expect(transport.query({ route, resource: 'history.deals', rangeStartUtcMsc: 1, rangeEndUtcMsc: 2 }))
      .rejects.toMatchObject({ code: 'bridge_query_route_unavailable' })
    expect(f.send).not.toHaveBeenCalled()
    expect(transport.inflight()).toBe(0)
  })

  it('does not renew a revoked inbound session lease or ingest its stream', async () => {
    const f = fixture()
    const streams = { ingest: vi.fn() }
    const routes = { touch: vi.fn(async () => false) } as unknown as BridgeGatewayRouteRepository
    const transport = new BridgeGatewayCommandTransport(f.leases, f.directory, f.authorization)
    const session = new BridgeGatewaySession(route, { send: f.send, close: vi.fn() }, routes, f.leases, f.directory, transport,
      {} as BridgeCommandService, streams, () => new Date())
    await expect(session.receive({ type: 'stream.event', route: wire })).rejects.toMatchObject({ code: 'bridge_session_fenced' })
    expect(f.leases.renew).not.toHaveBeenCalled()
    expect(streams.ingest).not.toHaveBeenCalled()
  })
})
