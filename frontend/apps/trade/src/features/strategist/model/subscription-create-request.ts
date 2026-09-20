import { strategySubscriptionCreateBodySchema, type StrategySubscriptionCreateBody } from '@aurum/contracts'

type Storage = Pick<globalThis.Storage, 'getItem' | 'setItem' | 'removeItem'>
const storageKey = (user: string, account: string) => `aurum:subscription-create:v1:${encodeURIComponent(user)}:${encodeURIComponent(account)}`
export function prepareSubscriptionCreate(storage: Storage, user: string, body: StrategySubscriptionCreateBody,
  key: () => string = () => crypto.randomUUID()) {
  const parsed = strategySubscriptionCreateBodySchema.parse(body), raw = storage.getItem(storageKey(user, parsed.trading_account_id))
  if (raw) {
    const pending = JSON.parse(raw) as { idempotencyKey: string; body: StrategySubscriptionCreateBody }
    if (typeof pending.idempotencyKey !== 'string' || !/^[A-Za-z0-9._:-]{16,128}$/.test(pending.idempotencyKey)) throw new Error('订阅创建请求记录无效')
    const original = strategySubscriptionCreateBodySchema.parse(pending.body)
    if (JSON.stringify(original) !== JSON.stringify(parsed)) throw new Error('上次订阅创建尚未确认，请先按原内容确认')
    return { idempotencyKey: pending.idempotencyKey, body: original }
  }
  const pending = { idempotencyKey: key(), body: parsed }
  storage.setItem(storageKey(user, parsed.trading_account_id), JSON.stringify(pending))
  return pending
}
export function clearSubscriptionCreate(storage: Storage, user: string, account: string): void { storage.removeItem(storageKey(user, account)) }
