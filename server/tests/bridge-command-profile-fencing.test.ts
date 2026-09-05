import { describe, expect, it } from 'vitest'
import {
  BridgeCommandService, createBridgeCommand,
  type BridgeCommand, type BridgeCommandAcceptedEnvelope, type BridgeCommandRepository,
  type BridgeCommandResultEnvelope, type BridgeCommandScope, type BridgeCommandTransport,
  type BridgeResultPersistence, type BridgeCommandReconcileEnvelope, type BridgeCommandRequestEnvelope,
} from '../src/modules/execution/index.js'

const NOW = new Date('2026-09-06T01:00:00.000Z')
const route = { terminalInstanceId: 'terminal_12345678', brokerServer: 'Demo-Server', login: '596520', connectionEpoch: 7 }

describe('P5A command profile fencing', () => {
  it('sends the persisted command scope for dispatch and reconciliation', async () => {
    const repository = new FakeRepository(createCommand())
    const transport = new CapturingTransport()
    const service = new BridgeCommandService(repository)

    await expect(service.dispatch(repository.command.id, transport, new Date(NOW.getTime() + 1))).resolves.toMatchObject({ status: 'dispatched' })
    expect(transport.sent[0]?.scope).toEqual({ userId: 42, terminalProfileId: 'profile_12345678' })

    repository.command = { ...repository.command, status: 'uncertain', revision: repository.command.revision + 1 }
    await expect(service.reconcile(repository.command.id, transport, null, new Date(NOW.getTime() + 2))).resolves.toMatchObject({ status: 'reconciling' })
    expect(transport.sent[1]?.scope).toEqual({ userId: 42, terminalProfileId: 'profile_12345678' })
    expect(transport.sent.map(value => value.message.type)).toEqual(['command.request', 'command.reconcile'])
  })

  it('rejects accepted evidence from a different user or profile before any write', async () => {
    for (const scope of [
      { userId: 99, terminalProfileId: 'profile_12345678' },
      { userId: 42, terminalProfileId: 'profile_other' },
    ] satisfies BridgeCommandScope[]) {
      const repository = new FakeRepository(createCommand())
      const service = new BridgeCommandService(repository)
      await expect(service.accepted(accepted(repository.command), NOW, scope))
        .rejects.toMatchObject({ code: 'bridge_command_scope_mismatch', status: 403 })
      expect(repository.acceptedWrites).toBe(0)
      expect(repository.resultWrites).toBe(0)
    }
  })

  it('rejects result evidence from a different user or profile before persisting or acknowledging', async () => {
    for (const scope of [
      { userId: 99, terminalProfileId: 'profile_12345678' },
      { userId: 42, terminalProfileId: 'profile_other' },
    ] satisfies BridgeCommandScope[]) {
      const repository = new FakeRepository(createCommand())
      const service = new BridgeCommandService(repository)
      const envelope = resultEnvelope(repository.command)
      await expect(service.result(envelope, NOW, scope))
        .rejects.toMatchObject({ code: 'bridge_command_scope_mismatch', status: 403 })
      expect(repository.resultWrites).toBe(0)
      expect(repository.command.resultHash).toBeNull()
    }
  })

  it('keeps a possibly delivered command uncertain and never resends command.request', async () => {
    const repository = new FakeRepository(createCommand())
    const transport = new CapturingTransport(true)
    const service = new BridgeCommandService(repository)

    await expect(service.dispatch(repository.command.id, transport, new Date(NOW.getTime() + 1))).resolves.toMatchObject({ status: 'uncertain' })
    await expect(service.dispatch(repository.command.id, transport, new Date(NOW.getTime() + 2)))
      .rejects.toMatchObject({ code: 'bridge_command_dispatch_status_invalid' })
    expect(transport.sent.map(value => value.message.type)).toEqual(['command.request'])
  })
})

class CapturingTransport implements BridgeCommandTransport {
  readonly sent: Array<{
    message: BridgeCommandRequestEnvelope | BridgeCommandReconcileEnvelope
    accountId: string
    scope: BridgeCommandScope
  }> = []

  constructor(private readonly fail = false) {}

  async currentRoute(command: BridgeCommand) { return command.route }

  async send(
    message: BridgeCommandRequestEnvelope | BridgeCommandReconcileEnvelope,
    accountId: string,
    scope: BridgeCommandScope,
  ) {
    this.sent.push({ message, accountId, scope })
    if (this.fail) throw new Error('socket_closed_after_write')
  }
}

class FakeRepository implements BridgeCommandRepository {
  acceptedWrites = 0
  resultWrites = 0

  constructor(public command: BridgeCommand) {}

  async create(command: BridgeCommand) { this.command = command; return command }
  async get(commandId: string) { return this.command.id === commandId ? this.command : null }

  async markDispatched(commandId: string, expectedRevision: number, now: string) {
    this.assertRevision(commandId, expectedRevision)
    this.command = { ...this.command, status: 'dispatched', dispatchedAt: now, revision: expectedRevision + 1, updatedAt: now }
    return this.command
  }

  async markAccepted(_envelope: BridgeCommandAcceptedEnvelope, now: string) {
    this.acceptedWrites += 1
    this.command = { ...this.command, status: 'accepted', acceptedAt: now, revision: this.command.revision + 1, updatedAt: now }
    return this.command
  }

  async markPreDispatchFailed(_commandId: string, _expectedRevision: number, errorCode: string, now: string) {
    this.command = { ...this.command, status: 'failed', errorCode, revision: this.command.revision + 1, updatedAt: now }
    return this.command
  }

  async markUncertain(_commandId: string, _expectedRevision: number, errorCode: string, now: string) {
    this.command = { ...this.command, status: 'uncertain', errorCode, revision: this.command.revision + 1, updatedAt: now }
    return this.command
  }

  async persistResult(envelope: BridgeCommandResultEnvelope, resultHash: string, now: string): Promise<BridgeResultPersistence> {
    this.resultWrites += 1
    this.command = { ...this.command, status: envelope.payload.status, resultHash, resultMessageId: envelope.message_id,
      completedAt: new Date(envelope.payload.completed_at_utc_msc).toISOString(), revision: this.command.revision + 1, updatedAt: now }
    return { command: this.command, disposition: 'persisted' }
  }

  async beginReconciliation(_commandId: string, _expectedRevision: number, now: string) {
    this.command = { ...this.command, status: 'reconciling', revision: this.command.revision + 1, updatedAt: now }
    return this.command
  }

  async listReconciliationCandidates() { return [] }

  private assertRevision(commandId: string, expectedRevision: number) {
    if (this.command.id !== commandId || this.command.revision !== expectedRevision) throw new Error('revision_conflict')
  }
}

function createCommand() {
  return createBridgeCommand({
    executionIntentId: '11111111-1111-4111-8111-111111111111', commandSequence: 1, userId: 42, accountId: '7',
    terminalProfileId: 'profile_12345678', route, action: 'order.place',
    params: { symbol: 'XAUUSD', direction: 'buy', order_type: 'market', volume: '0.10', magic: 7, deviation: 20 },
    expectedState: null, deadlineAt: new Date(NOW.getTime() + 30_000).toISOString(),
  }, NOW)
}

function accepted(command: BridgeCommand): BridgeCommandAcceptedEnvelope {
  return { v: 4, message_id: 'accepted_12345678', type: 'command.accepted', sent_at_utc_msc: NOW.getTime(),
    correlation_id: command.request.message_id, route: command.request.route,
    payload: { command_id: command.id, status: 'recorded', accepted_at_utc_msc: NOW.getTime() } }
}

function resultEnvelope(command: BridgeCommand): BridgeCommandResultEnvelope {
  return { v: 4, message_id: 'result_12345678', type: 'command.result', sent_at_utc_msc: NOW.getTime(),
    correlation_id: command.id, route: command.request.route,
    payload: { command_id: command.id, action: command.action, status: 'succeeded', completed_at_utc_msc: NOW.getTime(),
      result: { ticket: '1001' }, error_code: null, terminal_code: null } }
}
