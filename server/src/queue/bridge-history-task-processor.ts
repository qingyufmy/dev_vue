import { DelayedError, type Job } from 'bullmq'
import type { HistoryTaskWorker } from '../modules/trade-history/index.js'

import type { BridgeHistoryTaskJob } from './task-queues.js'
export type { BridgeHistoryTaskJob } from './task-queues.js'

export function createBridgeHistoryTaskProcessor(worker: Pick<HistoryTaskWorker, 'run'>) {
  return async (job: Job<BridgeHistoryTaskJob>, token?: string) => {
    const result = await worker.run(job.data.taskId)
    if (result.state === 'busy') {
      const retryAt = Date.parse(result.retryAt)
      if (!Number.isFinite(retryAt)) throw Error('history_task_retry_time_invalid')
      await job.moveToDelayed(Math.max(Date.now() + 250, retryAt), token)
      throw new DelayedError()
    }
    return result
  }
}
