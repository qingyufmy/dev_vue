import type { Pool, PoolConnection } from 'mysql2/promise'
import type { ManualCandidatePageProcessor } from '../modules/reviews/index.js'
import { createMysqlManualCandidateTask } from '../modules/reviews/composition.js'
import { createMysqlManualCandidatePageReader } from '../modules/trade-history/composition.js'
import { createTransactionManualCandidateCollector } from './manual-candidate-collection.js'

export function createTransactionManualCandidatePageProcessor(connection: PoolConnection): ManualCandidatePageProcessor {
  return { async run(taskId, afterRecordId) {
    const page = await createMysqlManualCandidatePageReader(connection).read(taskId,afterRecordId,20)
    if (page.status !== 'read') return page
    const collector = createTransactionManualCandidateCollector(connection)
    const results = []
    for (const record of page.records) results.push({ recordId: record.recordId,
      result: await collector.collect({ userId: page.route.userId, recordId: record.recordId, expectedRevision: record.revision,
        taskId, route: page.route, asOfUtcMsc: page.asOfUtcMsc }) })
    return { status: 'processed', nextRecordId: page.nextRecordId, results }
  } }
}

export function createManualCandidateTaskRunner(pool: Pool) {
  return createMysqlManualCandidateTask(pool,createTransactionManualCandidatePageProcessor)
}

/** One bounded page per transaction. Queue orchestration must retain unresolved records and the next cursor. */
export function createManualCandidateBatch(pool: Pool) {
  return { async run(taskId: string, afterRecordId: string | null = null) {
    const connection = await pool.getConnection()
    let committing = false, destroyed = false
    try {
      await connection.beginTransaction()
      const result = await createTransactionManualCandidatePageProcessor(connection).run(taskId,afterRecordId)
      committing = true
      await connection.commit()
      return result
    } catch (error) {
      if (committing) { destroyed = true; connection.destroy(); throw Error('manual_candidate_batch_commit_unknown') }
      try { await connection.rollback() } catch { destroyed = true; connection.destroy() }
      throw error
    } finally { if (!destroyed) connection.release() }
  } }
}
