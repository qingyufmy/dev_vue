import { createApiClient } from '@aurum/api-client'
import { readonly, shallowRef } from 'vue'
import type { TradingContext } from '@aurum/contracts'
import { createContextCommandController, ContextCommandRecoveryError, type ContextCommandAction, type ContextCommandStorage } from './context-command-controller'

interface Session { user: { id: string }; authenticated_at: string; csrf_token: string }
type Client = Pick<ReturnType<typeof createApiClient>, 'selectTradingAccount' | 'enterObserverMode' | 'leaveObserverMode' | 'getTradingContextReceipt' | 'getTradingContext'>

export function createContextCommandSession(client: Client, storage: ContextCommandStorage) {
  let session: Session | null = null
  let running: Promise<TradingContext | null> | null = null
  const scope = () => {
    if (!session) throw new ContextCommandRecoveryError('context_command_scope_changed')
    return { userId: session.user.id, sessionKey: session.authenticated_at }
  }
  const controller = createContextCommandController({ storage, transport: {
    async execute(command) {
      if (!session || session.user.id !== command.userId) throw new ContextCommandRecoveryError('context_command_scope_changed')
      const token = session.csrf_token
      if (command.action === 'select_account') return client.selectTradingAccount(token, command.targetId!, command.expectedRevision, command.requestId)
      if (command.action === 'enter_observer') return client.enterObserverMode(token, command.targetId!, command.expectedRevision, command.requestId)
      return client.leaveObserverMode(token, command.expectedRevision, command.requestId)
    },
    async receipt(requestId) { return (await client.getTradingContextReceipt(requestId)).data },
    async current() { return (await client.getTradingContext()).data },
  } })
  const state = shallowRef(controller.state)
  const sync = () => { state.value = controller.state }
  function bind(next: Session | null) {
    const changed = session && (session.user.id !== next?.user.id || session.authenticated_at !== next?.authenticated_at)
    session = next
    if (changed) { running = null; try { controller.clear() } finally { sync() } }
    if (next) { try { controller.restore(scope()) } finally { sync() } }
  }
  async function observe<T extends TradingContext | null>(operation: () => Promise<T>) {
    const pending = operation()
    running = pending
    sync()
    try { return await pending }
    finally { if (running === pending) running = null; sync() }
  }
  return {
    state: readonly(state), bind,
    async start(next: Session, action: ContextCommandAction, target: string | null, revision: number) {
      bind(next)
      if (controller.state.busy) throw new ContextCommandRecoveryError('context_command_pending')
      return { data: await observe(() => controller.start(scope(), action, target, revision)) }
    },
    async recover(next: Session) {
      bind(next)
      const data = await (running ?? observe(() => controller.recover(scope())))
      return data ? { data } : null
    },
    async retry(next: Session) {
      bind(next)
      if (controller.state.busy) throw new ContextCommandRecoveryError('context_command_pending')
      return { data: await observe(() => controller.retry(scope())) }
    },
  }
}

const shared = createContextCommandSession(createApiClient(), {
  getItem: key => sessionStorage.getItem(key),
  setItem: (key, value) => sessionStorage.setItem(key, value),
  removeItem: key => sessionStorage.removeItem(key),
})
export const contextCommandState = shared.state
export const bindContextCommandSession = shared.bind
export const runContextCommand = shared.start
export const recoverContextCommand = shared.recover
export const retryContextCommand = shared.retry
