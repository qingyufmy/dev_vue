import { describe, expect, it } from 'vitest'
import {
  BridgeGatewayCommandTransport, BridgeGatewayService, InProcessBridgeGatewayDirectory,
  assertHeartbeat, assertSessionHello,
  type BridgeGatewayLeaseStore, type BridgeGatewayRoute, type BridgeGatewayRouteRepository, type BridgeGatewaySink,
  type BridgeSessionHelloEnvelope,
} from '../src/modules/bridge/index.js'
import {
  BridgeCommandService, ExecutionDispatchWorker, createBridgeCommand, bridgeResultHash,
  type AccountExecutionLeaseStore, type BridgeCommand, type BridgeCommandAcceptedEnvelope, type BridgeCommandRepository,
  type BridgeCommandResultEnvelope, type BridgeResultPersistence, type ExecutionCommandSource,
} from '../src/modules/execution/index.js'

const NOW = new Date('2026-09-03T09:00:00.000Z')
const oldRoute = { terminalInstanceId: 'terminal_12345678', brokerServer: 'DPrime-Demo', login: '8950701', connectionEpoch: 1 }

describe('Stage 12G Bridge V4 gateway and execution worker', () => {
  it('rejects malformed heartbeat queues with a protocol error', () => {
    expect(() => assertHeartbeat({
      v: 4,
      message_id: 'heartbeat:12345678',
      type: 'system.heartbeat',
      sent_at_utc_msc: NOW.getTime(),
      correlation_id: null,
      payload: {
        session_id: 'session:12345678',
        last_received_message_id: null,
        queue: { commands: 0, results: 0, queries: -1, stream_events: 0 },
      },
    })).toThrowError(expect.objectContaining({ code: 'bridge_heartbeat_invalid', status: 400 }))
  })

  it('recovers a reconnect by sending reconcile only, then persists result before ACK', async () => {
    const repository = new MemoryCommands()
    const command = createBridgeCommand(commandInput(), NOW)
    repository.command = { ...command, status: 'uncertain', revision: 2, errorCode: 'bridge_transport_write_uncertain' }
    const service = new BridgeCommandService(repository)
    const leases = new MemoryGatewayLeases()
    const directory = new InProcessBridgeGatewayDirectory()
    const transport = new BridgeGatewayCommandTransport(leases, directory)
    const sink = new MemorySink()
    const gateway = new BridgeGatewayService(
      { async issue() { throw new Error('unused') }, async consume() { return { userId: 42, installationId: 'installation_12345678', profileId: 'profile_12345678', generation: 1 } } },
      new MemoryRoutes(), leases, { async getPurchasedCapacity() { return 0 } }, directory, transport, service,
      { async ingest() { return null } }, () => NOW,
    )
    const session = await gateway.open({ ticket: 'ticket', hello: hello(2), sink })
    expect(sink.messages.map(message => (message as { type: string }).type)).toEqual(['session.welcome', 'command.reconcile'])
    expect(sink.messages).not.toContainEqual(expect.objectContaining({ type: 'command.request' }))
    expect(repository.command?.status).toBe('reconciling')

    await session.receive(result(repository.command!, 2))
    expect(repository.trace).toContain('persist:result:succeeded')
    expect(sink.messages.at(-1)).toMatchObject({ type: 'command.result_ack', payload: { status: 'persisted' } })
  })

  it('serializes an account dispatch and never sends the existing command twice', async () => {
    const repository = new MemoryCommands()
    const service = new BridgeCommandService(repository)
    const source: ExecutionCommandSource = { async loadPrepared() { return { intentId: commandInput().executionIntentId, accountId: '7', command: commandInput() } } }
    const leases = new MemoryAccountLeases()
    const sent: unknown[] = []
    const worker = new ExecutionDispatchWorker(source, leases, service, {
      async currentRoute() { return oldRoute }, async send(message) { sent.push(message) },
    }, () => NOW)
    await expect(worker.run(commandInput().executionIntentId)).resolves.toMatchObject({ kind: 'dispatched', command: { status: 'dispatched' } })
    await expect(worker.run(commandInput().executionIntentId)).resolves.toMatchObject({ kind: 'existing', command: { status: 'dispatched' } })
    expect(sent).toHaveLength(1)
    expect(leases.trace).toEqual(['acquire:7', 'release:7', 'acquire:7', 'release:7'])
  })

  it('does not create a command when another worker owns the account lease', async () => {
    const repository = new MemoryCommands(); const leases = new MemoryAccountLeases(); leases.busy = true
    const worker = new ExecutionDispatchWorker(
      { async loadPrepared() { return { intentId: commandInput().executionIntentId, accountId: '7', command: commandInput() } } },
      leases, new BridgeCommandService(repository), { async currentRoute() { return oldRoute }, async send() {} }, () => NOW,
    )
    await expect(worker.run(commandInput().executionIntentId)).resolves.toEqual({ kind: 'busy', accountId: '7' })
    expect(repository.command).toBeNull()
  })

  it('resumes a durable queued command after a worker crash without rebuilding it from a newer route', async () => {
    const repository = new MemoryCommands(); repository.command = createBridgeCommand(commandInput(), NOW)
    const sent: unknown[] = []
    const worker = new ExecutionDispatchWorker(
      { async loadPrepared() { return { intentId: commandInput().executionIntentId, accountId: '7', command: { ...commandInput(), route: { ...oldRoute, connectionEpoch: 2 } } } } },
      new MemoryAccountLeases(), new BridgeCommandService(repository),
      { async currentRoute() { return oldRoute }, async send(message) { sent.push(message) } }, () => NOW,
    )
    await expect(worker.run(commandInput().executionIntentId)).resolves.toMatchObject({ kind: 'dispatched', command: { route: { connectionEpoch: 1 } } })
    expect(sent).toHaveLength(1)
  })

  it('rejects a hello spanning multiple terminal routes at the server boundary', () => {
    const value = hello(1); value.payload.terminals.push({ ...value.payload.terminals[0]!, route: { ...value.payload.terminals[0]!.route, connection_epoch: 2 } })
    expect(() => assertSessionHello(value)).toThrowError(expect.objectContaining({ code: 'bridge_session_route_count_invalid' }))
  })
})

class MemorySink implements BridgeGatewaySink {
  messages: unknown[] = []; closed: Array<[number, string]> = []
  send(message: unknown) { this.messages.push(message) }
  close(code: number, reason: string) { this.closed.push([code, reason]) }
}

class MemoryGatewayLeases implements BridgeGatewayLeaseStore {
  route: BridgeGatewayRoute | null = null
  async claim(input: Parameters<BridgeGatewayLeaseStore['claim']>[0]) { const replacedConnectionId = this.route?.connectionId ?? null; this.route = input.route; return { replacedConnectionId } }
  async renew(route: BridgeGatewayRoute) { return this.route?.connectionId === route.connectionId }
  async release(route: BridgeGatewayRoute) { if (this.route?.connectionId === route.connectionId) this.route = null }
  async current(accountId: string) { return this.route?.accountId === accountId ? this.route : null }
}

class MemoryRoutes implements BridgeGatewayRouteRepository {
  async authorizeAndOpen(input: Parameters<BridgeGatewayRouteRepository['authorizeAndOpen']>[0]) {
    const route = input.hello.payload.terminals[0]!.route
    return { userId: input.claims.userId, accountId: '7', terminalProfileId: input.claims.profileId,
      terminalInstanceId: route.terminal_instance_id, brokerServer: route.account_ref.broker_server, login: route.account_ref.login,
      connectionEpoch: route.connection_epoch, connectionId: input.connectionId, sessionId: input.hello.payload.session_id }
  }
  async activate() {}
  async touch() { return true }
  async close() {}
}

class MemoryAccountLeases implements AccountExecutionLeaseStore {
  busy = false; trace: string[] = []
  async acquire(accountId: string) { this.trace.push(`acquire:${accountId}`); return !this.busy }
  async renew() { return true }
  async release(accountId: string) { this.trace.push(`release:${accountId}`) }
}

class MemoryCommands implements BridgeCommandRepository {
  command: BridgeCommand | null = null; trace: string[] = []
  async create(command: BridgeCommand) { if (!this.command) { this.command = command; this.trace.push('persist:queued') }; return this.command }
  async get(id: string) { return this.command?.id === id ? this.command : null }
  async markDispatched(id: string, revision: number, now: string) { return this.move(id, revision, 'dispatched', now) }
  async markAccepted(_envelope: BridgeCommandAcceptedEnvelope, now: string) { return this.move(this.command!.id, this.command!.revision, 'accepted', now) }
  async markPreDispatchFailed(id: string, revision: number, code: string, now: string) { return this.move(id, revision, 'failed', now, code) }
  async markUncertain(id: string, revision: number, code: string, now: string) { return this.move(id, revision, 'uncertain', now, code) }
  async persistResult(envelope: BridgeCommandResultEnvelope, hash: string, now: string): Promise<BridgeResultPersistence> {
    if (this.command?.resultHash === hash) return { command: this.command, disposition: 'duplicate' }
    this.command = { ...this.command!, status: envelope.payload.status, resultHash: hash, resultMessageId: envelope.message_id,
      completedAt: new Date(envelope.payload.completed_at_utc_msc).toISOString(), updatedAt: now, revision: this.command!.revision + 1 }
    this.trace.push(`persist:result:${envelope.payload.status}`)
    return { command: this.command, disposition: 'persisted' }
  }
  async beginReconciliation(id: string, revision: number, now: string) { return this.move(id, revision, 'reconciling', now) }
  async listReconciliationCandidates(accountId: string, route: BridgeCommand['route']) {
    return this.command?.accountId === accountId && this.command.status === 'uncertain' && route.connectionEpoch >= this.command.route.connectionEpoch
      ? [{ command: this.command, terminalTicket: null }] : []
  }
  private async move(id: string, revision: number, status: BridgeCommand['status'], now: string, errorCode: string | null = null) {
    if (!this.command || this.command.id !== id || this.command.revision !== revision) throw new Error('revision_conflict')
    this.command = { ...this.command, status, errorCode, updatedAt: now, revision: revision + 1 }
    this.trace.push(`persist:${status}`); return this.command
  }
}

function commandInput() {
  return { executionIntentId: '11111111-1111-4111-8111-111111111111', commandSequence: 1, userId: 42, accountId: '7', terminalProfileId: 'profile_12345678',
    route: oldRoute, action: 'order.place' as const, params: { symbol: 'XAUUSD', direction: 'buy', order_type: 'market', volume: '0.10', magic: 7, deviation: 20 },
    expectedState: null, deadlineAt: '2026-09-03T09:00:30.000Z' }
}

function hello(epoch: number): BridgeSessionHelloEnvelope {
  return { v: 4, message_id: 'hello_12345678', type: 'session.hello', sent_at_utc_msc: NOW.getTime(), correlation_id: null,
    payload: { session_id: 'session_12345678', installation_id: 'installation_12345678', profile_id: 'profile_12345678', bridge_version: '4.0.0',
      protocol_versions: [4], platforms: ['mt5'], capabilities: ['command.reconcile'],
      limits: { max_frame_bytes: 262144, max_page_size: 500, max_inflight_queries: 8, max_inflight_commands: 1 },
      terminals: [{ route: { terminal_instance_id: oldRoute.terminalInstanceId, account_ref: { broker_server: oldRoute.brokerServer, login: oldRoute.login }, connection_epoch: epoch },
        platform: 'mt5', terminal_version: '5.0', trade_permission: 'full', timezone_offset_minutes: 180, clock_status: 'calibrated' }] } }
}

function result(command: BridgeCommand, epoch: number): BridgeCommandResultEnvelope {
  const envelope: BridgeCommandResultEnvelope = { v: 4, message_id: 'result_12345678', type: 'command.result', sent_at_utc_msc: NOW.getTime(), correlation_id: command.id,
    route: { ...command.request.route, connection_epoch: epoch }, payload: { command_id: command.id, action: command.action, status: 'succeeded',
      completed_at_utc_msc: NOW.getTime(), result: { position_ticket: '1001' }, error_code: null, terminal_code: null } }
  void bridgeResultHash(envelope)
  return envelope
}
