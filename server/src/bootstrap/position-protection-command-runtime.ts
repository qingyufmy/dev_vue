import type { Pool } from 'mysql2/promise'
import type { BridgeGatewayLeaseStore } from '../modules/bridge/index.js'
import { BridgeCommandService } from '../modules/execution/index.js'
import { assertMysqlExecutionWorkflowSchemaReady, MysqlBridgeCommandRepository, createMysqlPendingCommandReviewer } from '../modules/execution/composition.js'
import { createTransactionAccountClock, createTransactionPendingReader, createMysqlInstrumentSnapshotReader } from '../modules/trading/composition.js'
import { createTransactionTradeDecisionOriginReader, createTransactionTradeDecisionAnalysisReader } from '../modules/inference/composition.js'
import { createTransactionRiskPolicyReader } from '../modules/risk/composition.js'
import { createStrategyExecutionConfigReader } from '../modules/strategies/composition.js'
import { createPartialCloseRegistrationCapture } from './partial-close-registration.js'
import { createPositionProtectionCommandProviderCapture } from './position-protection-command-provider.js'
import { createPositionProtectionDispatchCapture } from './position-protection-dispatch.js'
import { createPartialCloseParentDispatchCapture } from './partial-close-dispatch.js'
import type { PositionProtectionReadLimits } from './position-protection-review.js'

/** Command persistence and dispatch guards only. No workflow consumer, recovery scan or WebSocket directory. */
export async function createPositionProtectionCommandRuntime(input: { pool: Pool;
  routes: Pick<BridgeGatewayLeaseStore, 'current'>; limits: PositionProtectionReadLimits }) {
  await assertMysqlExecutionWorkflowSchemaReady(input.pool)
  const { pool, routes } = input, limits = structuredClone(input.limits)
  return { commands: new BridgeCommandService(new MysqlBridgeCommandRepository(pool,
    createTransactionAccountClock, createTransactionRiskPolicyReader,
    createPartialCloseRegistrationCapture(routes, limits.maxAgeMs),
    createPositionProtectionCommandProviderCapture(routes, limits),
    createPositionProtectionDispatchCapture(routes, limits),
    createPartialCloseParentDispatchCapture(routes, limits), createStrategyExecutionConfigReader,
    connection => createMysqlPendingCommandReviewer(connection, { pending: createTransactionPendingReader(connection),
      instruments: createMysqlInstrumentSnapshotReader(connection), decisions: createTransactionTradeDecisionOriginReader(connection),
      analyses: createTransactionTradeDecisionAnalysisReader(connection) }))) }
}
