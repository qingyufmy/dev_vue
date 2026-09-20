import type { StrategyCombinationCreateBody, StrategyCombinationVersionCreateBody } from '@aurum/contracts'

type Body = StrategyCombinationCreateBody | StrategyCombinationVersionCreateBody
interface Pending { body: Body; expectedRevision: number | null; idempotencyKey: string }

function key(userId: string, strategyId: string) { return `aurum:v4:strategy-combination:${userId}:${strategyId || 'new'}` }

export function prepareStrategyCombination(storage: Storage, userId: string, strategyId: string, body: Body, expectedRevision: number | null): Pending {
  const storageKey = key(userId, strategyId)
  const current = storage.getItem(storageKey)
  if (current) {
    try {
      const parsed = JSON.parse(current) as Pending
      if (JSON.stringify(parsed.body) === JSON.stringify(body) && parsed.expectedRevision === expectedRevision && /^[A-Za-z0-9._:-]{16,128}$/.test(parsed.idempotencyKey)) return parsed
    } catch { /* replace invalid local state */ }
  }
  const pending = { body, expectedRevision, idempotencyKey: crypto.randomUUID() }
  storage.setItem(storageKey, JSON.stringify(pending))
  return pending
}

export function clearStrategyCombination(storage: Storage, userId: string, strategyId: string) {
  storage.removeItem(key(userId, strategyId))
}
