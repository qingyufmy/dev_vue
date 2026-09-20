import { DelayedError, type Job } from 'bullmq'
import type { BridgeInstrumentWorker } from '../modules/bridge/index.js'
import type { BridgeInstrumentJob } from './task-queues.js'

export function createBridgeInstrumentProcessor(instruments: Pick<BridgeInstrumentWorker, 'run'>) {
  return async (job: Job<BridgeInstrumentJob>, token?: string) => {
    const result = await instruments.run(job.data.requestId)
    if (result.state === 'retry') {
      const retryAt = Date.parse(result.retryAt)
      if (!Number.isFinite(retryAt)) throw new Error('instrument_retry_time_invalid')
      await job.moveToDelayed(Math.max(Date.now() + 250, retryAt), token)
      throw new DelayedError()
    }
    return result
  }
}
