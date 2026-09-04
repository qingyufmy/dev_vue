import {
  distributionCloseAsUserCommand,
  distributionCommandAsUserCommand,
  ExecutionDistributionError,
  type DistributionOrderCommand,
} from '../domain/execution-distribution.js'
import { UserExecutionCommandError } from '../domain/user-execution-command.js'
import type { UserExecutionOrderType } from '../domain/user-execution-command.js'
import type { UserExecutionCommandInput, UserExecutionCommandResult } from '../domain/user-execution-command.js'
import type {
  DistributionTargetRunResult,
  ExecutionDistributionTargetRepository,
  RunnableDistributionTarget,
} from './execution-distribution-ports.js'

/** Runs one frozen distribution target through the same account command path. */
export class ExecutionDistributionTargetWorker {
  constructor(
    private readonly repository: ExecutionDistributionTargetRepository,
    private readonly commands: { execute(input: UserExecutionCommandInput, now?: Date): Promise<UserExecutionCommandResult> },
  ) {}

  async run(targetId: string, now = new Date()): Promise<DistributionTargetRunResult> {
    const runnable = await this.repository.claimTarget(targetId, now)
    if (!runnable) return { targetId, distributionId: '', kind: 'manual_order', childOperationId: null, status: 'no_work' }
    try {
      const command = commandFor(runnable)
      const result = await this.commands.execute(command, now)
      const status = result.operation.status === 'rejected' ? 'rejected' : 'running'
      await this.repository.completeTarget({
        targetId,
        childOperationId: result.operation.id,
        status,
        errorCode: result.operation.errorCode,
        completedAt: status === 'rejected' ? now.toISOString() : null,
      }, now)
      return {
        targetId,
        distributionId: runnable.distribution.id,
        kind: runnable.distribution.kind,
        childOperationId: result.operation.id,
        status,
      }
    } catch (error) {
      if (!(error instanceof UserExecutionCommandError) && !(error instanceof ExecutionDistributionError)) throw error
      await this.repository.completeTarget({
        targetId,
        childOperationId: null,
        status: 'rejected',
        errorCode: error.code,
        completedAt: now.toISOString(),
      }, now)
      return {
        targetId,
        distributionId: runnable.distribution.id,
        kind: runnable.distribution.kind,
        childOperationId: null,
        status: 'rejected',
      }
    }
  }
}

function commandFor(input: RunnableDistributionTarget) {
  const idempotencyKey = `dist-target:${input.target.id}`
  if (input.distribution.kind === 'close') {
    return distributionCloseAsUserCommand(
      input.target,
      input.parentOperation.id,
      input.distribution.id,
      idempotencyKey,
    )
  }
  return distributionCommandAsUserCommand(
    storedOrderCommand(input.distribution.command),
    input.target,
    input.parentOperation.id,
    input.distribution.id,
    idempotencyKey,
  )
}

function storedOrderCommand(value: Record<string, unknown>): DistributionOrderCommand {
  if (value.command_type === 'market_order') return {
    commandType: 'market_order',
    symbol: String(value.symbol),
    side: value.side === 'sell' ? 'sell' : 'buy',
    volume: String(value.volume),
    stopLoss: String(value.stop_loss),
    takeProfit: value.take_profit === null ? null : String(value.take_profit),
    referencePrice: String(value.reference_price),
  }
  if (value.command_type !== 'pending_order') throw new ExecutionDistributionError('distribution_command_type_invalid', 422)
  return {
    commandType: 'pending_order',
    symbol: String(value.symbol),
    orderType: String(value.order_type) as UserExecutionOrderType,
    volume: String(value.volume),
    price: String(value.price),
    stopLimitPrice: value.stop_limit_price === null ? null : String(value.stop_limit_price),
    stopLoss: String(value.stop_loss),
    takeProfit: value.take_profit === null ? null : String(value.take_profit),
    referencePrice: String(value.reference_price),
    expirationUtcMsc: value.expiration_utc_msc === null ? null : Number(value.expiration_utc_msc),
  }
}
