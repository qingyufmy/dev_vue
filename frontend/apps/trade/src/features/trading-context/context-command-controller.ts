import type { TradingContext } from '@aurum/contracts'
import { ApiClientError } from '@aurum/api-client'

export type ContextCommandAction = 'select_account' | 'enter_observer' | 'leave_observer'
export interface ContextCommandScope { userId: string; sessionKey: string }
export interface ContextCommandIntent {
  userId: string
  requestId: string
  action: ContextCommandAction
  targetId: string | null
  expectedRevision: number
}
export interface ContextCommandReceipt {
  requestId: string
  action: ContextCommandAction
  targetId: string | null
  priorRevision: number
  result: TradingContext
}
export interface ContextCommandTransport {
  execute(intent: Readonly<ContextCommandIntent>): Promise<unknown>
  receipt(requestId: string): Promise<ContextCommandReceipt | null>
  current(): Promise<TradingContext>
}
export interface ContextCommandStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

export class ContextCommandRecoveryError extends Error {
  constructor(readonly code: 'context_command_pending' | 'context_command_uncertain' | 'context_command_scope_changed'
    | 'context_command_invalid' | 'context_command_storage_unavailable' | 'context_command_receipt_invalid') {
    super({ context_command_pending: '上一次账户切换仍待确认，请先确认结果', context_command_uncertain: '账户切换结果待确认，请保留当前请求并查询结果',
      context_command_scope_changed: '当前登录会话已变化，请重新读取账户', context_command_invalid: '账户切换请求无效',
      context_command_storage_unavailable: '无法保存账户切换请求，请检查浏览器存储后重试',
      context_command_receipt_invalid: '账户切换回执不匹配，请保留原请求并重新确认' }[code])
    this.name = 'ContextCommandRecoveryError'
  }
}

function normalizeIntent(value: ContextCommandIntent): Readonly<ContextCommandIntent> {
  if (!value || Object.keys(value).sort().join(',') !== 'action,expectedRevision,requestId,targetId,userId'
    || typeof value.userId !== 'string' || !/^[1-9][0-9]{0,9}$/.test(value.userId) || Number(value.userId) > 2147483647
    || typeof value.requestId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value.requestId)
    || !Number.isSafeInteger(value.expectedRevision) || value.expectedRevision < 0 || value.expectedRevision >= Number.MAX_SAFE_INTEGER
    || !['select_account', 'enter_observer', 'leave_observer'].includes(value.action)
    || (value.action === 'leave_observer' ? value.targetId !== null
      : typeof value.targetId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,190}$/.test(value.targetId))) throw new ContextCommandRecoveryError('context_command_invalid')
  return Object.freeze({ ...value })
}

// One controller belongs to the account-context feature, shared by all three workspaces.
// Storage contains only a session-bound command identity, never tokens or account facts.
export function createContextCommandController(options: {
  transport: ContextCommandTransport
  storage: ContextCommandStorage
  newRequestId?: () => string
}) {
  const storageKey = 'aurum:trading-context-command:v1'
  let scope: ContextCommandScope | null = null, intent: Readonly<ContextCommandIntent> | null = null
  let generation = 0, busy = false
  let ambiguous = false
  let status: 'idle' | 'submitting' | 'uncertain' | 'confirming' = 'idle'
  const sameScope = (left: ContextCommandScope | null, right: ContextCommandScope) => left?.userId === right.userId && left?.sessionKey === right.sessionKey
  const storage = <T>(operation: () => T): T => {
    try { return operation() }
    catch { throw new ContextCommandRecoveryError('context_command_storage_unavailable') }
  }
  function bind(next: ContextCommandScope) {
    if (!next || typeof next.sessionKey !== 'string' || !next.sessionKey || next.sessionKey.length > 512
      || typeof next.userId !== 'string' || !/^[1-9][0-9]{0,9}$/.test(next.userId) || Number(next.userId) > 2147483647) throw new ContextCommandRecoveryError('context_command_invalid')
    if (sameScope(scope, next)) return
    generation++; scope = { ...next }; intent = null; busy = false; status = 'idle'
    let raw: string | null
    try { raw = storage(() => options.storage.getItem(storageKey)) }
    catch (error) { scope = null; throw error }
    if (!raw) return
    let saved: { scope: ContextCommandScope; intent: ContextCommandIntent }
    try {
      saved = JSON.parse(raw) as typeof saved
      if (!saved || Object.keys(saved).sort().join(',') !== 'intent,scope' || !saved.scope
        || Object.keys(saved.scope).sort().join(',') !== 'sessionKey,userId'
        || typeof saved.scope.userId !== 'string' || typeof saved.scope.sessionKey !== 'string'
        || !saved.scope.sessionKey || saved.scope.sessionKey.length > 512
        || !/^[1-9][0-9]{0,9}$/.test(saved.scope.userId) || Number(saved.scope.userId) > 2147483647) throw Error('invalid-stored-scope')
    }
    catch { scope = null; throw new ContextCommandRecoveryError('context_command_invalid') }
    if (!sameScope(saved.scope, next)) {
      storage(() => options.storage.removeItem(storageKey))
      return
    }
    try {
      intent = normalizeIntent(saved.intent)
      if (intent.userId !== next.userId) throw new ContextCommandRecoveryError('context_command_invalid')
    } catch (error) { scope = null; intent = null; throw error }
    ambiguous = true; status = 'uncertain'
  }
  function check(current: number) {
    if (current !== generation) throw new ContextCommandRecoveryError('context_command_scope_changed')
  }
  function validContext(value: TradingContext, userId: string) {
    return value && value.userId === userId && Number.isSafeInteger(value.revision) && value.revision >= 0 && typeof value.readOnly === 'boolean'
      && (value.mode === 'full' ? typeof value.accountId === 'string' && value.accountId.length > 0 && value.observerChannelId === null
        : value.mode === 'observer' ? value.accountId === null && typeof value.observerChannelId === 'string' && value.observerChannelId.length > 0 && value.readOnly
          : value.mode === 'blocked' && value.accountId === null && value.observerChannelId === null && value.readOnly)
  }
  function assertReceipt(receipt: ContextCommandReceipt, command: Readonly<ContextCommandIntent>) {
    const result = receipt.result
    if (receipt.requestId !== command.requestId || receipt.action !== command.action || receipt.targetId !== command.targetId
      || receipt.priorRevision !== command.expectedRevision || !validContext(result, command.userId)
      || result.revision !== command.expectedRevision + 1
      || (command.action === 'select_account' && (result.mode !== 'full' || result.accountId !== command.targetId || result.observerChannelId !== null))
      || (command.action === 'enter_observer' && (result.mode !== 'observer' || result.observerChannelId !== command.targetId || result.accountId !== null || result.readOnly !== true))
      || (command.action === 'leave_observer' && (result.mode === 'observer' || result.observerChannelId !== null))) throw new ContextCommandRecoveryError('context_command_receipt_invalid')
  }
  async function confirm(current: number, command: Readonly<ContextCommandIntent>) {
    const receipt = await options.transport.receipt(command.requestId)
    check(current)
    if (!receipt) throw new ContextCommandRecoveryError('context_command_uncertain')
    assertReceipt(receipt, command)
    const receiptRevision = receipt.result.revision
    // The receipt is historical; another tab may already have selected a newer context.
    const context = await options.transport.current()
    check(current)
    if (!validContext(context, command.userId) || context.revision < receiptRevision) throw new ContextCommandRecoveryError('context_command_receipt_invalid')
    storage(() => options.storage.removeItem(storageKey))
    intent = null; status = 'idle'
    return context
  }
  async function run(send: boolean) {
    if (busy || !intent) throw new ContextCommandRecoveryError('context_command_pending')
    const current = generation, command = intent
    busy = true; status = send ? 'submitting' : 'confirming'
    try {
      if (send) {
        try { await options.transport.execute(command) }
        catch (error) {
          check(current)
          const definite = error instanceof ApiClientError && error.problem && [400, 401, 403, 409].includes(error.status)
            && ['revision_conflict', 'trading_context_invalid', 'trading_account_forbidden', 'csrf_invalid', 'api_request_invalid'].includes(error.problem.code)
          if (!ambiguous && definite) {
            storage(() => options.storage.removeItem(storageKey))
            intent = null; status = 'idle'
            throw error
          }
        }
        check(current)
      }
      ambiguous = true
      return await confirm(current, command)
    } catch (error) {
      if (current === generation && intent) { ambiguous = true; status = 'uncertain' }
      throw error
    } finally { if (current === generation) busy = false }
  }
  return {
    get state() { return { status, busy, intent: intent ? { ...intent } : null } },
    restore(next: ContextCommandScope) { bind(next) },
    async start(next: ContextCommandScope, action: ContextCommandAction, targetId: string | null, expectedRevision: number) {
      bind(next)
      if (intent || busy) throw new ContextCommandRecoveryError('context_command_pending')
      const command = normalizeIntent({ userId: next.userId, requestId: (options.newRequestId ?? (() => crypto.randomUUID()))(), action, targetId, expectedRevision })
      storage(() => options.storage.setItem(storageKey, JSON.stringify({ scope, intent: command })))
      intent = command; ambiguous = false
      return run(true)
    },
    async recover(next: ContextCommandScope) { bind(next); return intent ? run(false) : null },
    async retry(next: ContextCommandScope) { bind(next); return run(true) },
    // Session teardown only; uncertain commands must not expose a discard-and-resubmit action.
    clear() {
      generation++; scope = null; intent = null; busy = false; status = 'idle'
      storage(() => options.storage.removeItem(storageKey))
    },
  }
}
