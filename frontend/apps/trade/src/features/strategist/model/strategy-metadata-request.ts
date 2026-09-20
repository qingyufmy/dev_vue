import { strategyMetadataPatchBodySchema, type StrategyMetadataPatchBody } from '@aurum/contracts'

type Storage = Pick<globalThis.Storage, 'getItem' | 'setItem' | 'removeItem'>
const storageKey = (userId: string, strategyId: string) => `aurum:strategy-metadata:v1:${encodeURIComponent(userId)}:${encodeURIComponent(strategyId)}`

export function prepareStrategyMetadata(storage: Storage, userId: string, strategyId: string,
  body: StrategyMetadataPatchBody, expectedRevision: number, key: () => string = () => crypto.randomUUID()) {
  const parsed = strategyMetadataPatchBodySchema.parse(body)
  const stored = storage.getItem(storageKey(userId, strategyId))
  if (stored) {
    const pending = JSON.parse(stored) as { idempotencyKey: string; body: StrategyMetadataPatchBody; expectedRevision: number }
    if (typeof pending.idempotencyKey !== 'string' || !/^[A-Za-z0-9._:-]{16,128}$/.test(pending.idempotencyKey)
      || !Number.isSafeInteger(pending.expectedRevision) || pending.expectedRevision < 1) throw new Error('策略修改请求记录无效，请先核实策略资料')
    const original = strategyMetadataPatchBodySchema.parse(pending.body)
    if (JSON.stringify(original) !== JSON.stringify(parsed)) throw new Error('上次修改结果尚未确认，请恢复原内容后再次提交')
    return { ...pending, body: original }
  }
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1) throw new Error('策略版本无效，请重新读取策略')
  const pending = { idempotencyKey: key(), body: parsed, expectedRevision }
  storage.setItem(storageKey(userId, strategyId), JSON.stringify(pending))
  return pending
}

export function clearStrategyMetadata(storage: Storage, userId: string, strategyId: string): void {
  storage.removeItem(storageKey(userId, strategyId))
}
