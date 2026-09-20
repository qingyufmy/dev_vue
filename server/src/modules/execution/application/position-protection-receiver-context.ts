import { randomUUID } from 'node:crypto'
import { BridgeCommandError, bridgeCommandId, type BridgeCommand } from '../domain/bridge-command.js'
import type { PartialCloseWorkflowScope } from './partial-close-workflow-progress.js'
import type { AccountExecutionLeaseStore, ExecutionCommandSource } from './execution-dispatch-ports.js'
import type { BridgeCommandService } from './bridge-command-service.js'

export interface PositionProtectionReceiverScopeReader {
  read(scope: PartialCloseWorkflowScope, childIntentId: string): Promise<'active' | 'terminal'>
}
export interface PositionProtectionPreparationDependencies {
  scope: PositionProtectionReceiverScopeReader; source: ExecutionCommandSource; leases: AccountExecutionLeaseStore
  commands: Pick<BridgeCommandService, 'findByIntent' | 'create'>; now?: () => Date
}

/** Shared scope, lease and idempotent creation; no terminal transport capability. */
export function createPositionProtectionReceiverContext(deps: PositionProtectionPreparationDependencies) {
  const now = deps.now ?? (() => new Date())
  function fail(code: string): never { throw new BridgeCommandError(`position_protection_receiver_${code}`, 409) }
  function check(command: BridgeCommand, scope: PartialCloseWorkflowScope, childId: string) {
    if (command.id !== bridgeCommandId(childId, 1) || command.executionIntentId !== childId || command.commandSequence !== 1
      || command.userId !== scope.userId || command.accountId !== scope.accountId || command.action !== 'position.protection.set') fail('scope_mismatch')
  }
  async function leased(input: PartialCloseWorkflowScope, childId: string, work: (scope: PartialCloseWorkflowScope, renew: () => Promise<void>) => Promise<void>) {
    const scope = structuredClone(input)
    bridgeCommandId(childId, 1)
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(scope.workflowId) || !Number.isSafeInteger(scope.userId) || scope.userId < 1 || scope.userId > 2147483647
      || !/^[1-9][0-9]{0,19}$/.test(scope.accountId) || BigInt(scope.accountId) > 18446744073709551615n) fail('scope_invalid')
    const owner = `protection:${randomUUID()}`
    if (!await deps.leases.acquire(scope.accountId, owner, 15)) fail('busy')
    let failed = false
    try {
      if (await deps.scope.read(scope, childId) === 'terminal') return
      const renew = async () => { if (!await deps.leases.renew(scope.accountId, owner, 15)) fail('lease_lost') }
      await work(scope, renew)
    } catch (error) { failed = true; throw error }
    finally { try { await deps.leases.release(scope.accountId, owner) } catch (error) { if (!failed) throw error } }
  }
  async function prepare(scope: PartialCloseWorkflowScope, childId: string, renew: () => Promise<void>) {
    let command = await deps.commands.findByIntent(childId, 1)
    if (!command) {
      const candidate = await deps.source.loadPrepared(childId, now().toISOString())
      if (!candidate || 'blocked' in candidate) fail('candidate_unavailable')
      if (candidate.intentId !== childId || candidate.accountId !== scope.accountId || candidate.command.executionIntentId !== childId
        || candidate.command.accountId !== scope.accountId || candidate.command.userId !== scope.userId
        || candidate.command.commandSequence !== 1 || candidate.command.action !== 'position.protection.set') fail('scope_mismatch')
      await renew()
      command = await deps.commands.create(candidate.command, now())
    }
    check(command, scope, childId)
    return command
  }
  return { now, fail, check, leased, prepare }
}
