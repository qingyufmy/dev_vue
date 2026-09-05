import {
  BridgeCommandError, assertAcceptedEnvelope, assertResultEnvelope, bridgeCommandId, bridgeCommandInputMatches, bridgeResultHash,
  createBridgeCommand, reconcileEnvelope, resultAck, routeContinues, routeMatches,
  type BridgeCommandAcceptedEnvelope, type BridgeCommandResultEnvelope, type CreateBridgeCommandInput,
} from '../domain/bridge-command.js'
import type { BridgeCommandRepository, BridgeCommandScope, BridgeCommandTransport } from './bridge-command-ports.js'

export class BridgeCommandService {
  constructor(private readonly repository: BridgeCommandRepository) {}

  async create(input: CreateBridgeCommandInput, now = new Date()) {
    const existing = await this.repository.get(bridgeCommandId(input.executionIntentId, input.commandSequence))
    if (existing) {
      if (!bridgeCommandInputMatches(existing, input)) throw new BridgeCommandError('bridge_command_idempotency_conflict', 409)
      return existing
    }
    const candidate = createBridgeCommand(input, now)
    return this.repository.create(candidate)
  }

  async findByIntent(executionIntentId: string, commandSequence = 1) {
    return this.repository.get(bridgeCommandId(executionIntentId, commandSequence))
  }

  /** Resume only a durable queued command after a worker crash; never re-send a possibly dispatched command. */
  async resume(executionIntentId: string, commandSequence: number, transport: BridgeCommandTransport, now = new Date()) {
    const command = await this.repository.get(bridgeCommandId(executionIntentId, commandSequence))
    if (!command) return null
    if (command.status !== 'queued') return { command, dispatched: false }
    return { command: await this.dispatch(command.id, transport, now), dispatched: true }
  }

  /** Queue consumers may be delivered more than once. Only a durable queued command may cross the socket boundary. */
  async dispatchQueued(commandId: string, transport: BridgeCommandTransport, now = new Date()) {
    const command = await this.required(commandId)
    if (command.status !== 'queued') return { command, dispatched: false as const }
    return { command: await this.dispatch(command.id, transport, now), dispatched: true as const }
  }

  /** Persist dispatched before attempting a socket write; a thrown write is possibly sent. */
  async dispatch(commandId: string, transport: BridgeCommandTransport, now = new Date()) {
    const command = await this.required(commandId)
    if (command.status !== 'queued') throw new BridgeCommandError('bridge_command_dispatch_status_invalid', 409)
    if (Date.parse(command.deadlineAt) <= now.getTime()) {
      return this.repository.markPreDispatchFailed(command.id, command.revision, 'bridge_command_deadline_expired', now.toISOString())
    }
    const activeRoute = await transport.currentRoute(command)
    if (!activeRoute || activeRoute.terminalInstanceId !== command.route.terminalInstanceId
      || activeRoute.brokerServer !== command.route.brokerServer || activeRoute.login !== command.route.login
      || activeRoute.connectionEpoch !== command.route.connectionEpoch) {
      return this.repository.markPreDispatchFailed(command.id, command.revision, 'bridge_route_unavailable', now.toISOString())
    }
    const dispatched = await this.repository.markDispatched(command.id, command.revision, now.toISOString())
    try {
      await transport.send(dispatched.request, dispatched.accountId, commandScope(dispatched))
      return dispatched
    } catch {
      return this.repository.markUncertain(dispatched.id, dispatched.revision, 'bridge_transport_write_uncertain', new Date().toISOString())
    }
  }

  async accepted(envelope: BridgeCommandAcceptedEnvelope, now = new Date(), scope?: BridgeCommandScope) {
    assertAcceptedEnvelope(envelope)
    const command = await this.required(envelope.payload.command_id)
    assertCommandScope(command, scope)
    if (!routeMatches(command, envelope.route)) throw new BridgeCommandError('bridge_command_route_mismatch', 409)
    if (envelope.payload.accepted_at_utc_msc < command.request.payload.issued_at_utc_msc) throw new BridgeCommandError('bridge_command_accepted_time_invalid', 409)
    return this.repository.markAccepted(envelope, now.toISOString())
  }

  /** The acknowledgement is constructed only after repository persistence returns. */
  async result(envelope: BridgeCommandResultEnvelope, now = new Date(), scope?: BridgeCommandScope) {
    assertResultEnvelope(envelope)
    const command = await this.required(envelope.payload.command_id)
    assertCommandScope(command, scope)
    if (!routeContinues(command, envelope.route) || envelope.payload.action !== command.action) {
      throw new BridgeCommandError('bridge_command_result_route_mismatch', 409)
    }
    if (envelope.payload.completed_at_utc_msc < command.request.payload.issued_at_utc_msc) throw new BridgeCommandError('bridge_command_result_time_invalid', 409)
    const persisted = await this.repository.persistResult(envelope, bridgeResultHash(envelope), now.toISOString())
    return {
      command: persisted.command,
      acknowledgement: resultAck(persisted.command, envelope.message_id, persisted.disposition === 'duplicate', now, envelope.route),
      disposition: persisted.disposition,
    }
  }

  /** Reconciliation queries the durable Bridge ledger and never resends command.request. */
  async reconcile(commandId: string, transport: BridgeCommandTransport, terminalTicket: string | null, now = new Date()) {
    let command = await this.required(commandId)
    const activeRoute = await transport.currentRoute(command)
    if (!activeRoute) return command
    const wireRoute = { terminal_instance_id: activeRoute.terminalInstanceId,
      account_ref: { broker_server: activeRoute.brokerServer, login: activeRoute.login }, connection_epoch: activeRoute.connectionEpoch }
    if (!routeContinues(command, wireRoute)) throw new BridgeCommandError('bridge_command_reconcile_route_mismatch', 409)
    if (command.status === 'dispatched' || command.status === 'accepted') {
      command = await this.repository.markUncertain(command.id, command.revision, 'bridge_connection_interrupted', now.toISOString())
    }
    const message = reconcileEnvelope(command, terminalTicket, now, wireRoute)
    const reconciling = command.status === 'reconciling'
      ? command
      : await this.repository.beginReconciliation(command.id, command.revision, now.toISOString())
    try {
      await transport.send(message, command.accountId, commandScope(command))
      return reconciling
    } catch {
      return this.repository.markUncertain(reconciling.id, reconciling.revision, 'bridge_reconcile_transport_uncertain', new Date().toISOString())
    }
  }

  /** Reconnect recovery is reconciliation-only; it never sends command.request. */
  async recover(accountId: string, route: import('../domain/bridge-command.js').BridgeRoute, transport: BridgeCommandTransport, now = new Date(), limit = 1) {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 32) throw new BridgeCommandError('bridge_command_reconcile_limit_invalid', 422)
    const candidates = await this.repository.listReconciliationCandidates(accountId, route, limit)
    const recovered = []
    for (const candidate of candidates) {
      recovered.push(await this.reconcile(candidate.command.id, transport, candidate.terminalTicket, now))
    }
    return recovered
  }

  private async required(commandId: string) {
    const command = await this.repository.get(commandId)
    if (!command) throw new BridgeCommandError('bridge_command_not_found', 404)
    return command
  }
}

function commandScope(command: { userId: number; terminalProfileId: string }): BridgeCommandScope {
  return { userId: command.userId, terminalProfileId: command.terminalProfileId }
}

function assertCommandScope(command: { userId: number; terminalProfileId: string }, scope: BridgeCommandScope | undefined) {
  if (scope === undefined) return
  if (scope.userId !== command.userId || scope.terminalProfileId !== command.terminalProfileId) {
    throw new BridgeCommandError('bridge_command_scope_mismatch', 403)
  }
}
