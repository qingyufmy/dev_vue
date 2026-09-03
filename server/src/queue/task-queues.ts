import { Queue, type ConnectionOptions, type JobsOptions } from 'bullmq'

export const EXECUTION_QUEUE = 'aurum-v4-execution'
export const BRIDGE_DISPATCH_QUEUE = 'aurum-v4-bridge-dispatch'

export interface ExecutionIntentJob { intentId: string }
export interface BridgeCommandJob { commandId: string }

const jobOptions: JobsOptions = {
  attempts: 5,
  backoff: { type: 'exponential', delay: 1_000 },
  removeOnComplete: { count: 2_000 },
  removeOnFail: { count: 5_000 },
}

export class RuntimeTaskQueues {
  readonly execution: Queue<ExecutionIntentJob>
  readonly bridgeDispatch: Queue<BridgeCommandJob>

  constructor(connection: ConnectionOptions, prefix: string) {
    this.execution = new Queue(EXECUTION_QUEUE, { connection, prefix, defaultJobOptions: jobOptions })
    this.bridgeDispatch = new Queue(BRIDGE_DISPATCH_QUEUE, { connection, prefix, defaultJobOptions: jobOptions })
  }

  async close() {
    await Promise.all([this.execution.close(), this.bridgeDispatch.close()])
  }
}
