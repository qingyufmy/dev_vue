import { Queue, type ConnectionOptions } from 'bullmq'
import type { PartialCloseWorkflowScope } from '../modules/execution/index.js'

export const PARTIAL_CLOSE_WORKFLOW_QUEUE = 'aurum-v4-partial-close-workflow'
export type PartialCloseWorkflowJob = PartialCloseWorkflowScope
export type PartialCloseWorkflowTaskQueue = Pick<Queue<PartialCloseWorkflowJob>, 'add'>

/** Explicit capability: existing runtimes do not create this queue before workflow readiness is admitted. */
export function createPartialCloseWorkflowQueue(connection: ConnectionOptions, prefix: string): Queue<PartialCloseWorkflowJob> {
  return new Queue(PARTIAL_CLOSE_WORKFLOW_QUEUE,{connection,prefix,defaultJobOptions:{attempts:5,
    backoff:{type:'exponential',delay:1000},removeOnComplete:{count:2000},removeOnFail:{count:5000}}})
}

export function parsePartialCloseWorkflowJob(value: unknown): PartialCloseWorkflowJob {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('partial_close_job_invalid')
  const data = value as Record<string,unknown>
  if (Object.keys(data).length !== 3 || typeof data.workflowId !== 'string'
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(data.workflowId)
    || !Number.isSafeInteger(data.userId) || Number(data.userId) < 1 || Number(data.userId) > 2147483647
    || typeof data.accountId !== 'string' || !/^[1-9][0-9]{0,19}$/.test(data.accountId) || BigInt(data.accountId) > 18446744073709551615n) throw Error('partial_close_job_invalid')
  return {workflowId:data.workflowId,userId:data.userId as number,accountId:data.accountId}
}
