import type { CreateBridgeCommandInput } from '../domain/bridge-command.js'

export interface ExecutionDispatchCandidate {
  intentId: string
  accountId: string
  command: CreateBridgeCommandInput
}

export interface ExecutionCommandSource {
  loadPrepared(intentId: string, now: string): Promise<ExecutionDispatchCandidate | null>
}

export interface AccountExecutionLeaseStore {
  acquire(accountId: string, owner: string, ttlSeconds: number): Promise<boolean>
  renew(accountId: string, owner: string, ttlSeconds: number): Promise<boolean>
  release(accountId: string, owner: string): Promise<void>
}
