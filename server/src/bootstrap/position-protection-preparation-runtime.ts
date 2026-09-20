import type { Pool } from 'mysql2/promise'
import type { Redis } from 'ioredis'
import type { BridgeGatewayLeaseStore } from '../modules/bridge/index.js'
import { createPositionProtectionPreparationReceiver } from '../modules/execution/index.js'
import { createMysqlPositionProtectionReconciliationRequest, createMysqlPositionProtectionReceiverScope, MysqlExecutionCommandSource,
  RedisAccountExecutionLeaseStore } from '../modules/execution/composition.js'
import { createPositionProtectionCommandRuntime } from './position-protection-command-runtime.js'
import type { PositionProtectionReadLimits } from './position-protection-review.js'

/** Execution Worker receiver: command creation and bridge.command.queued outbox share the repository transaction. */
export async function createPositionProtectionPreparationRuntime(input: { pool: Pool; cache: Redis;
  routes: Pick<BridgeGatewayLeaseStore, 'current'>; limits: PositionProtectionReadLimits; magic: number; deviation: number }) {
  const { commands } = await createPositionProtectionCommandRuntime(input)
  return { commands, reconcile: createMysqlPositionProtectionReconciliationRequest(input.pool), prepared: createPositionProtectionPreparationReceiver({
    scope: createMysqlPositionProtectionReceiverScope(input.pool),
    source: new MysqlExecutionCommandSource(input.pool, { magic: input.magic, deviation: input.deviation }),
    leases: new RedisAccountExecutionLeaseStore(input.cache),
    commands,
  }) }
}
