import type { PendingOrder } from '../domain/trading.js'

export interface ExecutionPendingContext {
  userId: number
  accountId: string
  terminalInstanceId: string
  brokerServer: string
  login: string
  connectionEpoch: string
  ownershipRevision: string
}
export interface ExecutionPendingSnapshot extends ExecutionPendingContext {
  revision: string
  observedAt: string
  complete: true
  items: PendingOrder[]
}
export interface ExecutionPendingReader {
  read(input: ExecutionPendingContext): Promise<ExecutionPendingSnapshot | null>
}
