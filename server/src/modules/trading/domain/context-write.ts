import { TradingAccessError, type TradingContext } from './trading.js'

export type ContextWriteAction = 'select_account' | 'enter_observer' | 'leave_observer'
export interface ContextWriteCommand {
  userId: number
  requestId: string
  action: ContextWriteAction
  targetId: string | null
  expectedRevision: number
}
export interface ContextWriteReceipt {
  requestId: string
  action: ContextWriteAction
  targetId: string | null
  priorRevision: number
  result: TradingContext
  recordedAt: string
  replayed: boolean
}

export function normalizeContextWrite(input: ContextWriteCommand): ContextWriteCommand {
  if (!input || Object.keys(input).sort().join(',') !== 'action,expectedRevision,requestId,targetId,userId'
    || !Number.isSafeInteger(input.userId) || input.userId < 1 || input.userId > 2147483647
    || typeof input.requestId !== 'string' || input.requestId.length !== 36
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(input.requestId)
    || !Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0 || input.expectedRevision >= Number.MAX_SAFE_INTEGER
    || !['select_account', 'enter_observer', 'leave_observer'].includes(input.action)
    || (input.action === 'leave_observer' ? input.targetId !== null
      : typeof input.targetId !== 'string' || input.targetId.length > 191 || /[^A-Za-z0-9._:-]/.test(input.targetId)
        || !/^[A-Za-z0-9]/.test(input.targetId))) throw new TradingAccessError('trading_context_invalid', 400)
  return { userId: input.userId, requestId: input.requestId, action: input.action, targetId: input.targetId, expectedRevision: input.expectedRevision }
}

// Infrastructure hashes these deterministic bytes; the domain has no crypto/driver dependency.
export function contextWriteFingerprintInput(input: ContextWriteCommand): string {
  const command = normalizeContextWrite(input)
  return JSON.stringify(['trading-context-write/v1', command.userId, command.requestId, command.action, command.targetId, command.expectedRevision])
}
