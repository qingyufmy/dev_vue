import { describe, expect, it } from 'vitest'
import {
  BridgeCommandService, BridgeCommandError, canonicalHash, createBridgeCommand,
  type BridgeCommand, type BridgeCommandAcceptedEnvelope, type BridgeCommandRepository,
  type BridgeCommandResultEnvelope, type BridgeCommandTransport, type BridgeResultPersistence,
  type BridgeCommandRequestEnvelope, type BridgeCommandReconcileEnvelope,
} from '../src/modules/execution/index.js'

const NOW = new Date('2026-09-03T09:00:00.000Z')
const route = { terminalInstanceId: 'terminal_12345678', brokerServer: 'DPrime-Demo', login: '596520', connectionEpoch: 7 }

describe('Bridge V4 server command lifecycle', () => {
  it.each(['execution_subscription_changed', 'execution_schedule_invalid', 'execution_schedule_closed'])('fails before socket write and releases reservation for %s', async code => {
    const repo = new MemoryBridgeRepository(), transport = new MemoryTransport(repo.trace)
    repo.markDispatched = async () => { throw new BridgeCommandError(code, 409) }
    const service = new BridgeCommandService(repo), command = await service.create(input(), NOW)
    expect((await service.dispatch(command.id, transport, NOW)).status).toBe('failed')
    expect(repo.reservation).toBe('released')
    expect(transport.messages).toEqual([])
  })
  it('persists and marks dispatched before the first transport write', async () => {
    const repo = new MemoryBridgeRepository()
    const trace: string[] = repo.trace
    const transport = new MemoryTransport(trace)
    const service = new BridgeCommandService(repo)
    const command = await service.create(input(), NOW)
    const dispatched = await service.dispatch(command.id, transport, new Date(NOW.getTime() + 1))
    expect(dispatched.status).toBe('dispatched')
    expect(trace).toEqual(['persist:queued', 'resolve-route', 'persist:dispatched', 'send:command.request'])
  })

  it('returns the durable command when create is retried after dispatch', async () => {
    const repo = new MemoryBridgeRepository(); const service = new BridgeCommandService(repo)
    const created = await service.create(input(), NOW)
    const dispatched = await repo.markDispatched(created.id, created.revision, NOW.toISOString())
    const replayedCreate = await service.create(input(), new Date(NOW.getTime() + 60_000))
    expect(replayedCreate.id).toBe(created.id)
    expect(replayedCreate.status).toBe(dispatched.status)
    expect(repo.trace.filter(item => item === 'persist:queued')).toHaveLength(1)
  })

  it('treats a socket write exception as uncertain and never retries the request', async () => {
    const repo = new MemoryBridgeRepository(); const transport = new MemoryTransport(repo.trace, true)
    const service = new BridgeCommandService(repo); const command = await service.create(input(), NOW)
    const result = await service.dispatch(command.id, transport, new Date(NOW.getTime() + 1))
    expect(result.status).toBe('uncertain')
    expect(repo.reservation).toBe('active')
    expect(transport.messages.map(item => item.type)).toEqual(['command.request'])
    await expect(service.dispatch(command.id, transport, new Date(NOW.getTime() + 2))).rejects.toMatchObject({ code: 'bridge_command_dispatch_status_invalid' })
    expect(transport.messages).toHaveLength(1)
  })

  it('releases the reservation when the route is definitely unavailable before dispatch', async () => {
    const repo = new MemoryBridgeRepository(); const transport = new MemoryTransport(repo.trace, false, false)
    const service = new BridgeCommandService(repo); const command = await service.create(input(), NOW)
    const result = await service.dispatch(command.id, transport, new Date(NOW.getTime() + 1))
    expect(result.status).toBe('failed')
    expect(repo.reservation).toBe('released')
    expect(transport.messages).toHaveLength(0)
  })

  it('returns command.result_ack only after result and reservation state are durable', async () => {
    const repo = new MemoryBridgeRepository(); const service = new BridgeCommandService(repo)
    const command = await service.create(input(), NOW)
    await repo.markDispatched(command.id, command.revision, NOW.toISOString())
    await service.accepted(accepted(command), NOW)
    const result = await service.result(resultEnvelope(command, 'succeeded'), NOW)
    expect(repo.trace.slice(-3)).toEqual(['persist:accepted', 'persist:result:succeeded', 'persist:reservation:committed'])
    expect(result.acknowledgement.payload.status).toBe('persisted')
    expect(result.command.status).toBe('succeeded')
    expect(repo.reservation).toBe('committed')
    expect(repo.reservedCapacity()).toBe(1)
  })

  it.each([
    ['rejected', 'released'], ['failed', 'released'], ['uncertain', 'active'],
  ] as const)('maps %s result to the correct reservation lifecycle', async (status, reservation) => {
    const repo = new MemoryBridgeRepository(); const service = new BridgeCommandService(repo)
    const command = await service.create(input(), NOW); await repo.markDispatched(command.id, 1, NOW.toISOString())
    await service.result(resultEnvelope(command, status), NOW)
    expect(repo.reservation).toBe(reservation)
  })

  it('acks duplicate evidence but stores a conflicting result and fails closed to uncertain', async () => {
    const repo = new MemoryBridgeRepository(); const service = new BridgeCommandService(repo)
    const command = await service.create(input(), NOW); await repo.markDispatched(command.id, 1, NOW.toISOString())
    const success = resultEnvelope(command, 'succeeded')
    expect((await service.result(success, NOW)).disposition).toBe('persisted')
    expect((await service.result(success, NOW)).acknowledgement.payload.status).toBe('duplicate')
    const conflict = resultEnvelope(command, 'failed', 'result_conflict_12345678')
    const conflicted = await service.result(conflict, NOW)
    expect(conflicted.disposition).toBe('conflict')
    expect(conflicted.command.status).toBe('uncertain')
    expect(repo.conflicts).toHaveLength(1)
    expect(repo.reservation).toBe('active')
  })

  it('reactivates a released reservation when later evidence conflicts', async () => {
    const repo = new MemoryBridgeRepository(); const service = new BridgeCommandService(repo)
    const command = await service.create(input(), NOW); await repo.markDispatched(command.id, 1, NOW.toISOString())
    expect((await service.result(resultEnvelope(command, 'rejected'), NOW)).command.status).toBe('rejected')
    expect(repo.reservation).toBe('released')
    const conflicted = await service.result(resultEnvelope(command, 'succeeded', 'result_conflict_after_reject'), NOW)
    expect(conflicted.disposition).toBe('conflict')
    expect(repo.reservation).toBe('active')
    await expect(repo.beginReconciliation(command.id, conflicted.command.revision, NOW.toISOString()))
      .rejects.toMatchObject({ code: 'bridge_command_conflict_manual_review_required' })
  })

  it('accepts a terminal reconciliation result after a durable uncertain result', async () => {
    const repo = new MemoryBridgeRepository(); const service = new BridgeCommandService(repo)
    const command = await service.create(input(), NOW); await repo.markDispatched(command.id, 1, NOW.toISOString())
    const uncertain = await service.result(resultEnvelope(command, 'uncertain'), NOW)
    expect(uncertain.command.status).toBe('uncertain')
    const reconciling = await repo.beginReconciliation(command.id, uncertain.command.revision, NOW.toISOString())
    expect(reconciling.status).toBe('reconciling')
    const stillUncertainEnvelope = resultEnvelope(command, 'uncertain', 'result_still_uncertain')
    stillUncertainEnvelope.payload.completed_at_utc_msc += 1
    const stillUncertain = await service.result(stillUncertainEnvelope, NOW)
    expect(stillUncertain.disposition).toBe('persisted')
    expect(stillUncertain.command.status).toBe('uncertain')
    expect(repo.reservation).toBe('active')
    await repo.beginReconciliation(command.id, stillUncertain.command.revision, NOW.toISOString())
    const resolved = await service.result(resultEnvelope(command, 'succeeded', 'result_after_reconcile'), NOW)
    expect(resolved.disposition).toBe('persisted')
    expect(resolved.command.status).toBe('succeeded')
    expect(repo.reservation).toBe('committed')
  })

  it('accepts durable result evidence from a newer route epoch without changing command identity', async () => {
    const repo = new MemoryBridgeRepository(); const service = new BridgeCommandService(repo)
    const command = await service.create(input(), NOW); await repo.markDispatched(command.id, 1, NOW.toISOString())
    const envelope = resultEnvelope(command, 'succeeded')
    envelope.route.connection_epoch = route.connectionEpoch + 1
    const persisted = await service.result(envelope, NOW)
    expect(persisted.command.id).toBe(command.id)
    expect(persisted.acknowledgement.route.connection_epoch).toBe(route.connectionEpoch + 1)
  })

  it('reconciles an uncertain command without replaying command.request', async () => {
    const repo = new MemoryBridgeRepository(); const transport = new MemoryTransport(repo.trace)
    const service = new BridgeCommandService(repo); const command = await service.create(input(), NOW)
    await repo.markDispatched(command.id, 1, NOW.toISOString()); await repo.markUncertain(command.id, 2, 'write_unknown', NOW.toISOString())
    const reconciling = await service.reconcile(command.id, transport, null, NOW)
    expect(reconciling.status).toBe('reconciling')
    expect(transport.messages.map(item => item.type)).toEqual(['command.reconcile'])
    const resolved = await service.result(resultEnvelope(command, 'succeeded', 'result_reconciled_12345678'), NOW)
    expect(resolved.command.status).toBe('succeeded')
    expect(repo.reservation).toBe('committed')
  })

  it('converts a crash-left dispatched command to uncertain and reconciles without replay', async () => {
    const repo = new MemoryBridgeRepository(); const transport = new MemoryTransport(repo.trace)
    const service = new BridgeCommandService(repo); const command = await service.create(input(), NOW)
    await repo.markDispatched(command.id, 1, NOW.toISOString())
    const reconciling = await service.reconcile(command.id, transport, null, NOW)
    expect(reconciling.status).toBe('reconciling')
    expect(repo.trace).toContain('persist:uncertain')
    expect(transport.messages.map(item => item.type)).toEqual(['command.reconcile'])
    expect(transport.messages).not.toContainEqual(expect.objectContaining({ type: 'command.request' }))
  })

  it('retries an interrupted reconciling query without replaying the trading command', async () => {
    const repo = new MemoryBridgeRepository(); const firstTransport = new MemoryTransport(repo.trace)
    const service = new BridgeCommandService(repo); const command = await service.create(input(), NOW)
    await repo.markDispatched(command.id, 1, NOW.toISOString()); await repo.markUncertain(command.id, 2, 'write_unknown', NOW.toISOString())
    const first = await service.reconcile(command.id, firstTransport, null, NOW)
    const revision = first.revision
    const reconnectTransport = new MemoryTransport(repo.trace)
    const retried = await service.reconcile(command.id, reconnectTransport, null, NOW)
    expect(retried).toMatchObject({ status: 'reconciling', revision })
    expect(reconnectTransport.messages.map(item => item.type)).toEqual(['command.reconcile'])
    expect(reconnectTransport.messages).not.toContainEqual(expect.objectContaining({ type: 'command.request' }))
  })

  it('builds stable command identity from intent plus sequence', () => {
    const first = createBridgeCommand(input(), NOW)
    const second = createBridgeCommand(input(), NOW)
    expect(second.id).toBe(first.id)
    expect(second.idempotencyKey).toBe(first.idempotencyKey)
    expect(second.requestHash).toBe(first.requestHash)
  })

  it('rejects malformed protocol parameters before persistence', () => {
    expect(() => createBridgeCommand({ ...input(), params: { symbol: 'XAUUSD', direction: 'buy', order_type: 'market', volume: 0.1, magic: 7, deviation: 20 } }, NOW))
      .toThrowError(expect.objectContaining({ code: 'bridge_command_params_invalid' }))
  })
})

class MemoryTransport implements BridgeCommandTransport {
  readonly messages: Array<BridgeCommandRequestEnvelope | BridgeCommandReconcileEnvelope> = []
  constructor(private readonly trace: string[], private readonly fail = false, private readonly available = true) {}
  async currentRoute() { this.trace.push('resolve-route'); return this.available ? route : null }
  async send(message: BridgeCommandRequestEnvelope | BridgeCommandReconcileEnvelope) {
    this.trace.push(`send:${message.type}`); this.messages.push(message)
    if (this.fail) throw new Error('socket_closed_after_write')
  }
}

class MemoryBridgeRepository implements BridgeCommandRepository {
  readonly trace: string[] = []; readonly conflicts: string[] = []
  command: BridgeCommand | null = null
  reservation: 'active' | 'committed' | 'released' = 'active'
  lastEvidenceStatus: BridgeCommandResultEnvelope['payload']['status'] | null = null

  reservedCapacity() { return this.reservation === 'active' || this.reservation === 'committed' ? 1 : 0 }

  async create(command: BridgeCommand) {
    if (!this.command) { this.command = command; this.trace.push('persist:queued') }
    else if (this.command.requestHash !== command.requestHash) throw new Error('conflict')
    return this.command
  }
  async get(id: string) { return this.command?.id === id ? this.command : null }
  async markDispatched(id: string, revision: number, now: string) { return this.move(id, revision, 'dispatched', now, null, 'persist:dispatched') }
  async markAccepted(envelope: BridgeCommandAcceptedEnvelope, now: string) {
    const current = this.must(envelope.payload.command_id)
    if (current.status === 'accepted') return current
    return this.move(current.id, current.revision, 'accepted', now, null, 'persist:accepted')
  }
  async markPreDispatchFailed(id: string, revision: number, code: string, now: string) {
    const next = await this.move(id, revision, 'failed', now, code, 'persist:failed')
    this.reservation = 'released'; this.trace.push('persist:reservation:released'); return next
  }
  async markUncertain(id: string, revision: number, code: string, now: string) { return this.move(id, revision, 'uncertain', now, code, 'persist:uncertain') }
  async persistResult(envelope: BridgeCommandResultEnvelope, hash: string, now: string): Promise<BridgeResultPersistence> {
    const current = this.must(envelope.payload.command_id)
    if (current.resultHash === hash) return { command: current, disposition: 'duplicate' }
    if (current.resultHash && current.resultHash !== hash) {
      if (current.status === 'reconciling' && this.lastEvidenceStatus === 'uncertain') {
        this.command = { ...current, status: envelope.payload.status, resultHash: hash, resultMessageId: envelope.message_id,
          completedAt: new Date(envelope.payload.completed_at_utc_msc).toISOString(), errorCode: envelope.payload.error_code,
          revision: current.revision + 1, updatedAt: now } as BridgeCommand
        this.trace.push(`persist:result:${envelope.payload.status}`)
        this.reservation = envelope.payload.status === 'succeeded' ? 'committed'
          : envelope.payload.status === 'uncertain' ? 'active' : 'released'
        this.trace.push(`persist:reservation:${this.reservation}`)
        this.lastEvidenceStatus = envelope.payload.status
        return { command: this.command, disposition: 'persisted' }
      }
      this.conflicts.push(hash); this.command = { ...current, status: 'uncertain', errorCode: 'bridge_result_conflict', revision: current.revision + 1, updatedAt: now } as BridgeCommand
      this.reservation = 'active'; this.trace.push('persist:reservation:active')
      return { command: this.command, disposition: 'conflict' }
    }
    this.command = { ...current, status: envelope.payload.status, resultHash: hash, resultMessageId: envelope.message_id,
      completedAt: new Date(envelope.payload.completed_at_utc_msc).toISOString(), errorCode: envelope.payload.error_code,
      terminalCode: envelope.payload.terminal_code === undefined || envelope.payload.terminal_code === null ? null : String(envelope.payload.terminal_code),
      revision: current.revision + 1 } as BridgeCommand
    this.lastEvidenceStatus = envelope.payload.status
    this.trace.push(`persist:result:${envelope.payload.status}`)
    if (envelope.payload.status === 'succeeded') this.reservation = 'committed'
    else if (envelope.payload.status === 'rejected' || envelope.payload.status === 'failed') this.reservation = 'released'
    this.trace.push(`persist:reservation:${this.reservation}`)
    return { command: this.command, disposition: 'persisted' }
  }
  async beginReconciliation(id: string, revision: number, now: string) {
    const current = this.must(id)
    if (current.errorCode === 'bridge_result_conflict') throw Object.assign(new Error('manual review'), { code: 'bridge_command_conflict_manual_review_required' })
    return this.move(id, revision, 'reconciling', now, null, 'persist:reconciling')
  }
  async listReconciliationCandidates() {
    return this.command?.status === 'uncertain' ? [{ command: this.command, terminalTicket: null }] : []
  }
  private async move(id: string, revision: number, status: BridgeCommand['status'], now: string, errorCode: string | null, trace: string) {
    const current = this.must(id); if (current.revision !== revision) throw new Error('revision conflict')
    this.command = { ...current, status, errorCode, updatedAt: now, revision: revision + 1,
      dispatchedAt: status === 'dispatched' ? now : current.dispatchedAt,
      acceptedAt: status === 'accepted' ? now : current.acceptedAt } as BridgeCommand
    this.trace.push(trace); return this.command
  }
  private must(id: string) { if (!this.command || this.command.id !== id) throw new Error('missing'); return this.command }
}

function input() {
  return { executionIntentId: '11111111-1111-4111-8111-111111111111', commandSequence: 1, userId: 42,
    accountId: '7', terminalProfileId: 'profile_12345678', route, action: 'order.place' as const,
    params: { symbol: 'XAUUSD', direction: 'buy', order_type: 'market', volume: '0.10', magic: 7, deviation: 20 },
    expectedState: null, deadlineAt: new Date(NOW.getTime() + 30_000).toISOString() }
}

function accepted(command: BridgeCommand): BridgeCommandAcceptedEnvelope {
  return { v: 4, message_id: 'accepted_12345678', type: 'command.accepted', sent_at_utc_msc: NOW.getTime(), correlation_id: command.request.message_id,
    route: command.request.route, payload: { command_id: command.id, status: 'recorded', accepted_at_utc_msc: NOW.getTime() } }
}

function resultEnvelope(command: BridgeCommand, status: BridgeCommandResultEnvelope['payload']['status'], messageId = 'result_12345678'): BridgeCommandResultEnvelope {
  return { v: 4, message_id: messageId, type: 'command.result', sent_at_utc_msc: NOW.getTime(), correlation_id: command.id,
    route: command.request.route, payload: { command_id: command.id, action: command.action, status,
      completed_at_utc_msc: NOW.getTime(), result: status === 'succeeded' ? { ticket: '1001' } : null,
      error_code: status === 'succeeded' ? null : `bridge_${status}`, terminal_code: null } }
}

void canonicalHash
