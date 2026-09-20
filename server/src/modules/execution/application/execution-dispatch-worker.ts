import { randomUUID } from 'node:crypto'
import type { BridgeCommandTransport } from './bridge-command-ports.js'
import type { BridgeCommandService } from './bridge-command-service.js'
import type { AccountExecutionLeaseStore, ExecutionCommandSource } from './execution-dispatch-ports.js'

export class ExecutionDispatchWorker {
  constructor(
    private readonly source: ExecutionCommandSource,
    private readonly leases: AccountExecutionLeaseStore,
    private readonly commands: BridgeCommandService,
    private readonly transport: BridgeCommandTransport,
    private readonly now = () => new Date(),
  ) {}

  async run(intentId: string) {
    const first = await this.source.loadPrepared(intentId, this.now().toISOString())
    if (!first) return { kind: 'no_work' as const }
    if ('blocked' in first) return { kind: 'busy' as const, accountId: first.accountId }
    const owner = `execution:${randomUUID()}`
    if (!await this.leases.acquire(first.accountId, owner, 15)) return { kind: 'busy' as const, accountId: first.accountId }
    try {
      // Re-read after owning the account lease. The first read is only a routing
      // hint and is never authoritative for command construction.
      const resumed = await this.commands.resume(intentId, 1, this.transport, this.now())
      if (resumed) return { kind: resumed.dispatched ? 'dispatched' as const : 'existing' as const, command: resumed.command }
      const candidate = await this.source.loadPrepared(intentId, this.now().toISOString())
      if (!candidate || candidate.accountId !== first.accountId) return { kind: 'no_work' as const }
      if ('blocked' in candidate) return { kind: 'busy' as const, accountId: candidate.accountId }
      const command = await this.commands.create(candidate.command, this.now())
      if (command.status !== 'queued') return { kind: 'existing' as const, command }
      return { kind: 'dispatched' as const, command: await this.commands.dispatch(command.id, this.transport, this.now()) }
    } finally {
      await this.leases.release(first.accountId, owner)
    }
  }
}
