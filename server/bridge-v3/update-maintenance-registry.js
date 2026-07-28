import crypto from 'node:crypto'

const fences = new Map()
const activeDeliveryCounts = new Map()

function normalizedIds(values) {
  return new Set((values || []).map(Number).filter(value => Number.isSafeInteger(value) && value > 0))
}

function purgeExpired(now = Date.now()) {
  for (const fence of fences.values()) {
    if (fence.expires_at_utc_msc <= now) releaseUpdateMaintenanceFence(fence.fence_id)
  }
}

function contains(scopeName, value) {
  purgeExpired()
  const normalized = Number(value)
  for (const fence of fences.values()) {
    if (fence[scopeName].has(normalized)) return true
  }
  return false
}

export function createUpdateMaintenanceFence({
  deliveryUserIds = [],
  privateOwnerUserIds = [],
  platformStrategyIds = [],
  marketSourceUserIds = [],
  ttlSeconds = 95,
} = {}) {
  if (!Number.isSafeInteger(ttlSeconds) || ttlSeconds < 60 || ttlSeconds > 300) {
    throw Object.assign(new Error('bridge_update_fence_ttl_invalid'), { code:'bridge_update_fence_ttl_invalid' })
  }
  const fence = {
    fence_id:`update_fence_${crypto.randomUUID()}`,
    delivery_user_ids:normalizedIds(deliveryUserIds),
    private_owner_user_ids:normalizedIds(privateOwnerUserIds),
    platform_strategy_ids:normalizedIds(platformStrategyIds),
    market_source_user_ids:normalizedIds(marketSourceUserIds),
    expires_at_utc_msc:Date.now() + ttlSeconds * 1000,
    timer:null,
  }
  fence.timer = setTimeout(() => releaseUpdateMaintenanceFence(fence.fence_id), ttlSeconds * 1000)
  fence.timer.unref?.()
  fences.set(fence.fence_id, fence)
  return {
    fence_id:fence.fence_id,
    expires_at_utc_msc:fence.expires_at_utc_msc,
  }
}

export function renewUpdateMaintenanceFence(fenceId, { ttlSeconds = 95 } = {}) {
  purgeExpired()
  const fence = fences.get(String(fenceId || ''))
  if (!fence) return false
  if (!Number.isSafeInteger(ttlSeconds) || ttlSeconds < 60 || ttlSeconds > 300) return false
  if (fence.timer) clearTimeout(fence.timer)
  fence.expires_at_utc_msc = Date.now() + ttlSeconds * 1000
  fence.timer = setTimeout(() => releaseUpdateMaintenanceFence(fence.fence_id), ttlSeconds * 1000)
  fence.timer.unref?.()
  return true
}

export function releaseUpdateMaintenanceFence(fenceId) {
  const fence = fences.get(String(fenceId || ''))
  if (!fence) return false
  if (fence.timer) clearTimeout(fence.timer)
  fences.delete(fence.fence_id)
  return true
}

export function isBridgeDeliveryMaintenancePaused(userId) {
  return contains('delivery_user_ids', userId)
}

export function beginBridgeDeliveryExecution(userId) {
  const normalizedUserId = Number(userId)
  activeDeliveryCounts.set(normalizedUserId, Number(activeDeliveryCounts.get(normalizedUserId) || 0) + 1)
  let ended = false
  return () => {
    if (ended) return
    ended = true
    const remaining = Number(activeDeliveryCounts.get(normalizedUserId) || 1) - 1
    if (remaining > 0) activeDeliveryCounts.set(normalizedUserId, remaining)
    else activeDeliveryCounts.delete(normalizedUserId)
  }
}

export function hasActiveBridgeDeliveryExecution(userIds) {
  return (userIds || []).some(userId => Number(activeDeliveryCounts.get(Number(userId)) || 0) > 0)
}

export function isPrivateInferenceMaintenancePaused(ownerUserId) {
  return contains('private_owner_user_ids', ownerUserId)
}

export function isPlatformMarketMaintenancePaused(sourceUserId, strategyId) {
  purgeExpired()
  const sourceId = Number(sourceUserId)
  const promptTypeId = Number(strategyId)
  for (const fence of fences.values()) {
    if (fence.market_source_user_ids.has(sourceId)
      && fence.platform_strategy_ids.has(promptTypeId)) return true
  }
  return false
}

export const __updateMaintenanceRegistryTest = {
  fences,
  activeDeliveryCounts,
  purgeExpired,
}
