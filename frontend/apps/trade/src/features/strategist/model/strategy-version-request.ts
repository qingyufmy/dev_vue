import { strategyVersionCreateBodySchema, type StrategyVersionCreateBody } from '@aurum/contracts'

export type StrategyVersionIntent = { action: 'create_version'; body: StrategyVersionCreateBody }
  | { action: 'publish_version'; versionId: string } | { action: 'retire_strategy' }
type Storage = Pick<globalThis.Storage, 'getItem' | 'setItem' | 'removeItem'>
const storageKey = (user: string, strategy: string) => `aurum:strategy-version:v1:${encodeURIComponent(user)}:${encodeURIComponent(strategy)}`
function normalize(intent: StrategyVersionIntent): StrategyVersionIntent {
  if (intent.action === 'create_version') return { action: intent.action, body: strategyVersionCreateBodySchema.parse(intent.body) }
  if (intent.action === 'retire_strategy') return { action: intent.action }
  if (intent.action === 'publish_version' && typeof intent.versionId === 'string' && intent.versionId.length > 0 && intent.versionId.length <= 191) {
    return { action: intent.action, versionId: intent.versionId }
  }
  throw new Error('策略版本请求无效')
}
export function prepareStrategyVersion(storage: Storage, user: string, strategy: string, intent: StrategyVersionIntent,
  expectedRevision: number, key: () => string = () => crypto.randomUUID()) {
  const parsed = normalize(intent), raw = storage.getItem(storageKey(user, strategy))
  if (raw) {
    const pending = JSON.parse(raw) as { intent: StrategyVersionIntent; expectedRevision: number; idempotencyKey: string }
    if (!Number.isSafeInteger(pending.expectedRevision) || pending.expectedRevision < 1
      || typeof pending.idempotencyKey !== 'string' || !/^[A-Za-z0-9._:-]{16,128}$/.test(pending.idempotencyKey)) throw new Error('策略版本请求记录无效')
    const original = normalize(pending.intent)
    if (JSON.stringify(original) !== JSON.stringify(parsed)) throw new Error('上次策略操作尚未确认，请先按原内容确认原操作')
    return { ...pending, intent: original }
  }
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1) throw new Error('策略版本无效，请重新读取策略')
  const pending = { intent: parsed, expectedRevision, idempotencyKey: key() }
  storage.setItem(storageKey(user, strategy), JSON.stringify(pending))
  return pending
}
export function clearStrategyVersion(storage: Storage, user: string, strategy: string): void { storage.removeItem(storageKey(user, strategy)) }
