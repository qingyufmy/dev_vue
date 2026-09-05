import { randomUUID } from 'node:crypto'
import type { BridgeCommandService } from '../../execution/application/bridge-command-service.js'
import { assertAcceptedEnvelope, assertResultEnvelope, type BridgeCommandAcceptedEnvelope, type BridgeCommandResultEnvelope } from '../../execution/domain/bridge-command.js'
import { assertHeartbeat, assertSessionHello, BridgeGatewayError, welcomeEnvelope, type BridgeGatewayRoute, type BridgeHeartbeatEnvelope, type BridgeSessionHelloEnvelope } from '../domain/bridge-gateway.js'
import type {
  BridgeGatewayCapacityRepository, BridgeGatewayDirectory, BridgeGatewayLeaseStore, BridgeGatewayRouteRepository,
  BridgeGatewayQueryReceiver, BridgeGatewaySink, BridgeGatewayStreamIngestor, BridgeSessionTicketStore,
} from './bridge-gateway-ports.js'
import type { BridgeGatewayCommandTransport } from './bridge-gateway-transport.js'

export interface OpenBridgeGatewayInput {
  ticket: string
  hello: BridgeSessionHelloEnvelope
  sink: BridgeGatewaySink
}

export class BridgeGatewayService {
  constructor(
    private readonly tickets: BridgeSessionTicketStore,
    private readonly routes: BridgeGatewayRouteRepository,
    private readonly leases: BridgeGatewayLeaseStore,
    private readonly capacities: BridgeGatewayCapacityRepository,
    private readonly directory: BridgeGatewayDirectory,
    private readonly transport: BridgeGatewayCommandTransport,
    private readonly commands: BridgeCommandService,
    private readonly streams: BridgeGatewayStreamIngestor,
    private readonly now = () => new Date(),
    private readonly queries: BridgeGatewayQueryReceiver = NO_QUERY_RECEIVER,
  ) {}

  async open(input: OpenBridgeGatewayInput) {
    const hello = assertSessionHello(input.hello)
    const claims = await this.tickets.consume(input.ticket)
    if (hello.payload.installation_id !== claims.installationId || hello.payload.profile_id !== claims.profileId) {
      throw new BridgeGatewayError('bridge_session_claim_mismatch', 403)
    }
    const connectionId = randomUUID()
    const openedAt = this.now()
    const route = await this.routes.authorizeAndOpen({ claims, hello, connectionId, connectedAt: openedAt.toISOString() })
    let claimAttempted = false
    try {
      const capacity = 1 + await this.capacities.getPurchasedCapacity(claims.userId)
      claimAttempted = true
      const lease = await this.leases.claim({ route, capacity, ttlSeconds: 45 })
      await this.routes.activate(route, this.now().toISOString())
      this.directory.attach(route, input.sink)
      await input.sink.send(welcomeEnvelope(route, hello, openedAt))
      if (lease.replacedConnectionId && lease.replacedConnectionId !== route.connectionId) {
        this.directory.replace(lease.replacedConnectionId, 4001, 'bridge_connection_replaced')
      }
      // The new epoch can only reconcile durable uncertain commands. It never
      // enters the ordinary dispatch path during reconnect recovery.
      await this.commands.recover(route.accountId, route, this.transport, this.now()).catch(() => [])
      return new BridgeGatewaySession(route, input.sink, this.routes, this.leases, this.directory, this.transport, this.commands, this.streams, this.now, this.queries)
    } catch (error) {
      const failures = await runCleanup([
        () => this.directory.detach(route.connectionId),
        // claim may have committed before its response was lost. Release is
        // fenced by this connection ID and cannot release a newer connection.
        () => claimAttempted ? this.leases.release(route) : undefined,
        () => this.routes.close(route, 'bridge_session_open_failed', this.now().toISOString()),
      ])
      if (failures.length) throw new AggregateError([error, ...failures], 'bridge_session_open_cleanup_failed')
      throw error
    }
  }
}

export class BridgeGatewaySession {
  private closed = false
  private closeTask: Promise<void> | undefined
  constructor(
    readonly route: BridgeGatewayRoute,
    private readonly sink: BridgeGatewaySink,
    private readonly routes: BridgeGatewayRouteRepository,
    private readonly leases: BridgeGatewayLeaseStore,
    private readonly directory: BridgeGatewayDirectory,
    private readonly transport: BridgeGatewayCommandTransport,
    private readonly commands: BridgeCommandService,
    private readonly streams: BridgeGatewayStreamIngestor,
    private readonly now: () => Date,
    private readonly queries: BridgeGatewayQueryReceiver = NO_QUERY_RECEIVER,
  ) {}

  async receive(message: unknown) {
    if (this.closed) throw new BridgeGatewayError('bridge_session_closed', 409)
    if (!message || typeof message !== 'object') throw new BridgeGatewayError('bridge_message_invalid', 400)
    const envelope = message as { type?: string; route?: BridgeCommandResultEnvelope['route']; payload?: { session_id?: string } }
    switch (envelope.type) {
      case 'system.heartbeat':
        return this.heartbeat(assertHeartbeat(message))
      case 'command.accepted': {
        const accepted = message as BridgeCommandAcceptedEnvelope
        assertAcceptedEnvelope(accepted); this.assertRoute(accepted.route)
        await this.ensureCurrent()
        return this.commands.accepted(accepted, this.now(), this.route)
      }
      case 'command.result': {
        const result = message as BridgeCommandResultEnvelope
        assertResultEnvelope(result); this.assertRoute(result.route)
        await this.ensureCurrent()
        const persisted = await this.commands.result(result, this.now(), this.route)
        await this.sink.send(persisted.acknowledgement)
        await this.commands.recover(this.route.accountId, this.route, this.transport, this.now(), 1).catch(() => [])
        return persisted.command
      }
      case 'stream.event':
        this.assertRoute(envelope.route)
        {
          await this.ensureCurrent()
          const acknowledgement = await this.streams.ingest(this.route, message)
          if (acknowledgement) await this.sink.send(acknowledgement)
          return acknowledgement
        }
      case 'query.response':
      case 'query.error':
        this.assertRoute(envelope.route)
        await this.ensureCurrent()
        return this.queries.receive(this.route, message)
      default:
        throw new BridgeGatewayError('bridge_message_type_unsupported', 400)
    }
  }

  close(reason = 'bridge_socket_closed'): Promise<void> {
    if (this.closeTask) return this.closeTask
    this.closed = true
    this.closeTask = this.cleanup(reason).catch(error => {
      // A failed cleanup remains retryable without reopening message handling.
      this.closeTask = undefined
      throw error
    })
    return this.closeTask
  }

  private async cleanup(reason: string) {
    const failures = await runCleanup([
      () => this.queries.cancelConnection(this.route.connectionId),
      () => this.directory.detach(this.route.connectionId),
      () => this.leases.release(this.route),
      () => this.routes.close(this.route, reason, this.now().toISOString()),
    ])
    if (failures.length) throw new AggregateError(failures, 'bridge_session_close_cleanup_failed')
  }

  private async heartbeat(message: BridgeHeartbeatEnvelope) {
    if (message.payload?.session_id !== this.route.sessionId) throw new BridgeGatewayError('bridge_session_id_mismatch', 409)
    await this.ensureCurrent()
    const acknowledgement = {
      v: 4, message_id: `heartbeat:${randomUUID()}`, type: 'system.heartbeat_ack', sent_at_utc_msc: this.now().getTime(),
      correlation_id: message.message_id,
      payload: { session_id: this.route.sessionId, last_received_message_id: message.message_id, queue: message.payload.queue },
    }
    await this.sink.send(acknowledgement)
    return acknowledgement
  }

  private async ensureCurrent() {
    if (!await this.routes.touch(this.route, this.now().toISOString()) || !await this.leases.renew(this.route, 45)) {
      throw new BridgeGatewayError('bridge_session_fenced', 409)
    }
  }

  private assertRoute(route: BridgeCommandResultEnvelope['route'] | undefined) {
    if (!route) throw new BridgeGatewayError('bridge_session_route_invalid', 409)
    const matches = route.terminal_instance_id === this.route.terminalInstanceId
      && route.account_ref.broker_server === this.route.brokerServer && route.account_ref.login === this.route.login
      && route.connection_epoch === this.route.connectionEpoch
    if (!matches) {
      throw new BridgeGatewayError('bridge_session_route_mismatch', 409)
    }
  }
}

const NO_QUERY_RECEIVER: BridgeGatewayQueryReceiver = {
  receive() { throw new BridgeGatewayError('bridge_query_result_unsupported', 400) },
  cancelConnection() {},
}

async function runCleanup(actions: Array<() => void | Promise<void>>): Promise<unknown[]> {
  const results = await Promise.allSettled(actions.map(action => Promise.resolve().then(action)))
  return results.flatMap(result => result.status === 'rejected' ? [result.reason] : [])
}
