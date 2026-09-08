import type { ContextWritePort } from '../../src/modules/trading/application/context-write-port.js'
import { contextWriteFingerprintInput, type ContextWriteCommand, type ContextWriteReceipt } from '../../src/modules/trading/domain/context-write.js'
import { TradingAccessError, type TradingContext } from '../../src/modules/trading/domain/trading.js'

// HTTP test adapter only. Real transaction/authorization tests use the MySQL implementations.
export function contextCommandPort(options: {
  initial?: TradingContext
  resolve?: (command: ContextWriteCommand) => Promise<Omit<TradingContext, 'revision'>>
} = {}) {
  const receipts = new Map<string, { fingerprint: string; receipt: ContextWriteReceipt }>()
  const contexts = new Map<number, TradingContext>()
  if (options.initial) contexts.set(options.initial.userId, options.initial)
  const port: ContextWritePort = {
    async execute(command) {
      const fingerprint = contextWriteFingerprintInput(command), key = `${command.userId}:${command.requestId}`
      const previous = receipts.get(key)
      if (previous) {
        if (previous.fingerprint !== fingerprint) throw new TradingAccessError('trading_context_idempotency_conflict', 409)
        return { ...structuredClone(previous.receipt), replayed: true }
      }
      if ((contexts.get(command.userId)?.revision ?? 0) !== command.expectedRevision) throw new TradingAccessError('revision_conflict', 409)
      const next: Omit<TradingContext, 'revision'> = options.resolve ? await options.resolve(command) : {
        userId: command.userId, mode: command.action === 'select_account' ? 'full' : command.action === 'enter_observer' ? 'observer' : 'blocked',
        accountId: command.action === 'select_account' ? command.targetId : null,
        observerChannelId: command.action === 'enter_observer' ? command.targetId : null, readOnly: command.action !== 'select_account',
      }
      const result = { ...next, revision: command.expectedRevision + 1 }
      const receipt = { requestId: command.requestId, action: command.action, targetId: command.targetId,
        priorRevision: command.expectedRevision, result, recordedAt: '2026-09-08T12:00:00.000Z', replayed: false }
      contexts.set(command.userId, result)
      receipts.set(key, { fingerprint, receipt })
      return structuredClone(receipt)
    },
    async receipt(userId, requestId) { return structuredClone(receipts.get(`${userId}:${requestId}`)?.receipt ?? null) },
  }
  return { port, context: async (userId: number) => contexts.get(userId) ?? { userId, mode: 'blocked' as const, accountId: null, observerChannelId: null, readOnly: true, revision: 0 } }
}
