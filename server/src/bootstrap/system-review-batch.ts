import type { Pool, PoolConnection } from 'mysql2/promise'
import type { SystemReviewPageProcessor } from '../modules/reviews/index.js'
import { createMysqlSystemReviewTask } from '../modules/reviews/composition.js'
import { createMysqlSystemReviewPageReader } from '../modules/trade-history/composition.js'
import { createTransactionSystemTradeReviewCollector } from './system-trade-review.js'

export function createTransactionSystemReviewPageProcessor(connection: PoolConnection): SystemReviewPageProcessor {
  return { async run(taskId, afterRecordId) {
    const page = await createMysqlSystemReviewPageReader(connection).read(taskId,afterRecordId,20)
    if (page.status !== 'read') return page
    const collector = createTransactionSystemTradeReviewCollector(connection), results = []
    for (const record of page.records) results.push({ recordId: record.recordId,
      result: await collector.collect({ userId: page.route.userId, recordId: record.recordId, expectedRevision: record.revision,
        taskId, route: page.route, asOfUtcMsc: page.asOfUtcMsc }) })
    return { status: 'processed', nextRecordId: page.nextRecordId, results }
  } }
}
export function createSystemReviewTaskRunner(pool: Pool) {
  return createMysqlSystemReviewTask(pool,createTransactionSystemReviewPageProcessor)
}
