import type { Pool } from 'mysql2/promise'
import type { Queue } from 'bullmq'
import { createMysqlCompletedHistoryTasks } from '../modules/trade-history/composition.js'
import { createMysqlManualCandidateDue } from '../modules/reviews/composition.js'

/** Reconciles missing and due tasks, including completions predating the outbox event. */
export function createManualCandidateRecovery(pool: Pool, queue: Pick<Queue, 'add'>) {
  const history = createMysqlCompletedHistoryTasks(pool), due = createMysqlManualCandidateDue(pool)
  let cursor: string | null = null, pending: Promise<void> | null = null, stopped = false
  async function sweep() {
    const ids = await history.list(cursor, 100)
    const ready = await due.filter(ids)
    for (const taskId of ready) {
      if (stopped) return
      await queue.add('review.candidates.collect', { taskId }, {
        jobId: `manual-candidate-recovery-${taskId}`, attempts: 5,
        backoff: { type: 'exponential', delay: 1000 }, removeOnComplete: true, removeOnFail: true,
      })
    }
    cursor = ids.length === 100 ? ids[ids.length - 1]! : null
  }
  return {
    tick(): Promise<void> {
      if (stopped) return Promise.resolve()
      return pending ??= sweep().finally(() => { pending = null })
    },
    async stop() { stopped = true; await pending },
  }
}
