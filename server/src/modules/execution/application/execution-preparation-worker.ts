import { randomUUID } from 'node:crypto'
import type { BridgeCommandService } from './bridge-command-service.js'
import type { AccountExecutionLeaseStore, ExecutionCommandSource } from './execution-dispatch-ports.js'

/**
 * Converts a prepared execution intent into one durable queued Bridge command.
 * Socket delivery belongs to the Bridge gateway process and is woken by outbox.
 */
export class ExecutionPreparationWorker {
  constructor(
    private readonly source: ExecutionCommandSource,
    private readonly leases: AccountExecutionLeaseStore,
    private readonly commands: BridgeCommandService,
    private readonly now = () => new Date(),
  ) {}

  async run(intentId: string) {
    const existing = await this.commands.findByIntent(intentId)
    if (existing) return { kind: 'existing' as const, command: existing }
    const first = await this.source.loadPrepared(intentId, this.now().toISOString())
    if (!first) return { kind: 'no_work' as const }
    const owner = `execution-prepare:${randomUUID()}`
    if (!await this.leases.acquire(first.accountId, owner, 15)) {
      return { kind: 'busy' as const, accountId: first.accountId }
    }
    try {
      const candidate = await this.source.loadPrepared(intentId, this.now().toISOString())
      if (!candidate || candidate.accountId !== first.accountId) return { kind: 'no_work' as const }
      const command = await this.commands.create(candidate.command, this.now())
      return { kind: command.status === 'queued' ? 'queued' as const : 'existing' as const, command }
    } finally {
      await this.leases.release(first.accountId, owner)
    }
  }
}
