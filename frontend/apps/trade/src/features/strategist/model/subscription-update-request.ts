import { strategySubscriptionPatchBodySchema, type StrategySubscriptionPatchBody } from '@aurum/contracts'

type Storage = Pick<globalThis.Storage, 'getItem' | 'setItem' | 'removeItem'>
const storageKey = (user: string, subscription: string) => `aurum:subscription-update:v1:${encodeURIComponent(user)}:${encodeURIComponent(subscription)}`
export function prepareSubscriptionUpdate(storage: Storage, user: string, subscription: string, body: StrategySubscriptionPatchBody,
  expectedRevision: number, key: () => string = () => crypto.randomUUID()) {
  const parsed = strategySubscriptionPatchBodySchema.parse(body), raw = storage.getItem(storageKey(user, subscription))
  if (Object.keys(parsed).length === 0) throw new Error('请填写需要修改的订阅内容')
  if (raw) {
    const pending = JSON.parse(raw) as { idempotencyKey: string; body: StrategySubscriptionPatchBody; expectedRevision: number }
    if (typeof pending.idempotencyKey !== 'string' || !/^[A-Za-z0-9._:-]{16,128}$/.test(pending.idempotencyKey)
      || !Number.isSafeInteger(pending.expectedRevision) || pending.expectedRevision < 1) throw new Error('订阅修改请求记录无效')
    const original = strategySubscriptionPatchBodySchema.parse(pending.body)
    if (JSON.stringify(original) !== JSON.stringify(parsed)) throw new Error('上次订阅修改尚未确认，请先按原内容确认')
    return { ...pending, body: original }
  }
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1) throw new Error('订阅版本无效，请重新读取订阅')
  const pending = { idempotencyKey: key(), body: parsed, expectedRevision }
  storage.setItem(storageKey(user, subscription), JSON.stringify(pending))
  return pending
}
export function clearSubscriptionUpdate(storage: Storage, user: string, subscription: string): void { storage.removeItem(storageKey(user, subscription)) }
