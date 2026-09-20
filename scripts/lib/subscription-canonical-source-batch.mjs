import { hash } from './v4-backfill-contract.mjs'
import { createSubscriptionSourceWriter } from './mysql-subscription-source-writer.mjs'
import { createFrozenSourceBatch } from './frozen-source-batch.mjs'

// A receipt owns the whole original source row and all per-symbol targets.
// The owning coordinator separately verifies the archived parent strategy source.
export function createCanonicalSubscriptionSourceBatch(entries, options) {
  return createFrozenSourceBatch(entries, options, {
    sourceTable: 'strategy_subscriptions', role: 'subscription-symbols-canonical-v2', errorPrefix: 'subscription', createWriter: (entries, options) => createSubscriptionSourceWriter(entries, { ...options, namespace: 'canonical' }),
    projectRow(entry) {
      const targets = entry.projections.flatMap(projection => [
        { table: 'strategy_subscriptions', pk: [{ type: 'integer', value: projection.subscription.id }] },
        { table: 'subscription_schedules', pk: [{ type: 'integer', value: projection.schedule.subscription_id }] },
        { table: 'subscription_execution_preferences', pk: [{ type: 'integer', value: projection.preferences.subscription_id }] },
      ])
      return { pk: [{ type: 'integer', value: entry.source.id }], sourceHash: entry.sourceHash,
        transformedHash: hash({ projections: entry.projections, strategySourceHash: entry.strategySourceHash, targets }),
        targets, source: entry.source }
    },
  })
}
