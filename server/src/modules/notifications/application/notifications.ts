export type DeliveryScope = 'off' | 'effective' | 'all'
export interface NotificationPreferences {
  analysis: DeliveryScope
  decision: DeliveryScope
  analysisSound: 'off' | 'bell' | 'chime' | 'pulse'
  decisionSound: 'off' | 'bell' | 'chime' | 'pulse'
  feishuEnabled: boolean
  emailEnabled: boolean
}
export const defaultPreferences: NotificationPreferences = { analysis: 'all', decision: 'all', analysisSound: 'off', decisionSound: 'off', feishuEnabled: false, emailEnabled: false }
export class NotificationError extends Error { constructor(readonly code: string, readonly status: number) { super(code) } }
export function shouldNotify(scope: DeliveryScope, actionable: boolean) { return scope === 'all' || scope === 'effective' && actionable }
