import type { DeepReadonly } from 'vue'
import type { SessionSummary } from '@aurum/contracts'

export type TradeSessionSnapshot = DeepReadonly<SessionSummary>
export { useTradeSession } from './session'

export const loadLoginView = () => import('./LoginView.vue')
