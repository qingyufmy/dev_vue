import type { JsonObject } from '../domain/inference.js'

export type RuntimeModelUsageKind = 'manual' | 'auto'
export type RuntimeCredentialSource = 'user' | 'platform_shared'

export interface RuntimeModelUsageContext {
  userId: number
  profileId: string
  strategyId: string
  credentialSource: RuntimeCredentialSource
  usage: RuntimeModelUsageKind
}

export interface ModelUsageCompletion {
  status: 'success' | 'error'
  errorCode?: string | null
  usage?: JsonObject | null
  providerRequestId?: string | null
  requestBytes: number
  responseBytes: number
  durationMs: number
}

export interface ModelUsageLedger {
  begin(context: RuntimeModelUsageContext): Promise<string>
  finish(reservationId: string, completion: ModelUsageCompletion): Promise<void>
}

export interface ModelUsageRecovery {
  recoverAbandoned(before: Date, limit: number): Promise<number>
}
