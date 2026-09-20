import { strategyCreateBodySchema, type StrategyCreateBody } from '@aurum/contracts'

type Storage = Pick<globalThis.Storage, 'getItem' | 'setItem' | 'removeItem'>
const storageKey = (userId: string) => `aurum:strategy-create:v1:${encodeURIComponent(userId)}`

export function prepareStrategyCreate(storage: Storage, userId: string, body: StrategyCreateBody,
  key: () => string = () => crypto.randomUUID()): { idempotencyKey: string; body: StrategyCreateBody } {
  const parsed = strategyCreateBodySchema.parse(body)
  const stored = storage.getItem(storageKey(userId))
  if (stored) {
    const pending = JSON.parse(stored) as { idempotencyKey: string; body: StrategyCreateBody }
    if (typeof pending.idempotencyKey !== 'string' || !/^[A-Za-z0-9._:-]{16,128}$/.test(pending.idempotencyKey)) {
      throw new Error('创建请求记录无效，请先核实已有策略')
    }
    const original = strategyCreateBodySchema.parse(pending.body)
    if (JSON.stringify(original) !== JSON.stringify(parsed)) throw new Error('上次创建结果尚未确认，请恢复原内容后再次提交，先确认原请求')
    return { idempotencyKey: pending.idempotencyKey, body: original }
  }
  const request = { idempotencyKey: key(), body: parsed }
  storage.setItem(storageKey(userId), JSON.stringify(request))
  return request
}

export function clearStrategyCreate(storage: Storage, userId: string): void { storage.removeItem(storageKey(userId)) }
