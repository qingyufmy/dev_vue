import { createPositionProtectionReceiverContext, type PositionProtectionReceiverScopeReader } from './position-protection-receiver-context.js'
import { bridgeCommandId } from '../domain/bridge-command.js'
import type { PartialCloseWorkflowScope } from './partial-close-workflow-progress.js'
import type { AccountExecutionLeaseStore, ExecutionCommandSource } from './execution-dispatch-ports.js'
import type { BridgeCommandService } from './bridge-command-service.js'
import type { BridgeCommandTransport } from './bridge-command-ports.js'

export type { PositionProtectionReceiverScopeReader } from './position-protection-receiver-context.js'
export function createPositionProtectionReceivers(deps: {
  scope: PositionProtectionReceiverScopeReader; source: ExecutionCommandSource; leases: AccountExecutionLeaseStore
  commands: Pick<BridgeCommandService, 'findByIntent' | 'create' | 'dispatch' | 'reconcile'>
  transport: BridgeCommandTransport; now?: () => Date
}) {
  const { now, fail, check, leased, prepare } = createPositionProtectionReceiverContext(deps)
  return {
    async prepared(scope: PartialCloseWorkflowScope, childId: string): Promise<void> {
      await leased(scope, childId, async (scope, renew) => {
        const command = await prepare(scope, childId, renew)
        // Recovery of any possibly dispatched command is owned by the reconciliation path.
        if (command.status !== 'queued') return
        await renew()
        await deps.commands.dispatch(command.id, deps.transport, now())
      })
    },
    async reconcile(scope: PartialCloseWorkflowScope, childId: string, commandId: string): Promise<void> {
      if (commandId !== bridgeCommandId(childId, 1)) fail('scope_mismatch')
      await leased(scope, childId, async (scope, renew) => {
        const command = await deps.commands.findByIntent(childId, 1)
        if (!command) return fail('command_missing')
        check(command, scope, childId)
        if (['succeeded', 'failed', 'rejected'].includes(command.status)) return
        if (!['dispatched', 'accepted', 'uncertain', 'reconciling'].includes(command.status)) fail('reconcile_status_invalid')
        await renew()
        await deps.commands.reconcile(command.id, deps.transport, null, now())
      })
    },
  }
}
