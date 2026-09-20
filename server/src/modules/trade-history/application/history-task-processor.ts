import type { BridgeGatewayRoute, BridgeHistoryQueryClient } from '../../bridge/index.js'
import type { HistoryCollectionTasks } from './history-collection-tasks.js'
import { freezeHistoryCollectionClaim, historyTaskRoute, type HistoryCollectionClaim } from './history-collection-task.js'
import type { TradeHistoryCollectorRepository } from './trade-history-collector-ports.js'
import { restoreHistoryTaskCompletion } from './history-task-completion.js'
import { TradeHistoryCollector } from './trade-history-collector.js'
import { HistoryCommitUnknown } from './history-commit-unknown.js'

export class HistoryTaskProcessor {
  constructor(
    private readonly tasks: HistoryCollectionTasks,
    private readonly repository: (claim: HistoryCollectionClaim) => TradeHistoryCollectorRepository,
    private readonly queries: BridgeHistoryQueryClient,
    private readonly now = () => new Date(),
  ) {}

  async process(taskId: string, input: BridgeGatewayRoute) {
    const route = structuredClone(input)
    const result = await this.tasks.claim(taskId, structuredClone(route))
    if (result.state === 'busy' || result.state === 'terminal') return result
    const claim = freezeHistoryCollectionClaim(result.claim)
    if (claim.taskId !== taskId || claim.accountId !== route.accountId || claim.routeHash !== historyTaskRoute(route).hash) {
      throw Error('history_task_claim_mismatch')
    }
    if (result.state === 'collecting') {
      const collected = await new TradeHistoryCollector(this.repository(claim), this.queries, this.now).collect(route)
      return { state: 'succeeded' as const, freshThroughUtcMsc: collected.freshThroughUtcMsc }
    }
    // Recovery must use durable evidence, never begin a new window or refetch terminal pages.
    const completion = restoreHistoryTaskCompletion(claim, route, result.completion.json, result.completion.hash)
    const repository = this.repository(claim)
    const complete = () => repository.complete(structuredClone(route), claim.rangeEndUtcMsc, this.now(), structuredClone(completion.value.pageChains))
    try { await complete() } catch (error) {
      if (!(error instanceof HistoryCommitUnknown)) throw error
      try { await complete() } catch { throw new HistoryCommitUnknown() }
    }
    return { state: 'succeeded' as const, freshThroughUtcMsc: claim.rangeEndUtcMsc }
  }
}
