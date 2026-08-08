import { afterEach, describe, expect, it } from 'vitest'

import {
  __updateMaintenanceRegistryTest,
  beginBridgeDeliveryExecution,
  createUpdateMaintenanceFence,
  hasActiveBridgeDeliveryExecution,
  isBridgeDeliveryMaintenancePaused,
  isPlatformMarketMaintenancePaused,
  isPrivateInferenceMaintenancePaused,
  releaseUpdateMaintenanceFence,
  renewUpdateMaintenanceFence,
} from '../server/bridge-v3/update-maintenance-registry.js'

afterEach(() => {
  for (const fenceId of [...__updateMaintenanceRegistryTest.fences.keys()]) {
    releaseUpdateMaintenanceFence(fenceId)
  }
  __updateMaintenanceRegistryTest.activeDeliveryCounts.clear()
})
describe('bridge update maintenance registry', () => {
  it('keeps delivery, private inference and platform source scopes isolated', () => {
    const fence = createUpdateMaintenanceFence({
      deliveryUserIds:[7],
      privateOwnerUserIds:[7],
      marketSourceUserIds:[42],
      platformStrategyIds:[51],
    })

    expect(isBridgeDeliveryMaintenancePaused(7)).toBe(true)
    expect(isBridgeDeliveryMaintenancePaused(8)).toBe(false)
    expect(isPrivateInferenceMaintenancePaused(7)).toBe(true)
    expect(isPlatformMarketMaintenancePaused(42, 51)).toBe(true)
    expect(isPlatformMarketMaintenancePaused(42, 52)).toBe(false)
    expect(isPlatformMarketMaintenancePaused(43, 51)).toBe(false)

    expect(renewUpdateMaintenanceFence(fence.fence_id)).toBe(true)
    expect(releaseUpdateMaintenanceFence(fence.fence_id)).toBe(true)
    expect(isBridgeDeliveryMaintenancePaused(7)).toBe(false)
  })

  it('counts overlapping delivery work until every execution has completed', () => {
    const endFirst = beginBridgeDeliveryExecution(7)
    const endSecond = beginBridgeDeliveryExecution(7)
    expect(hasActiveBridgeDeliveryExecution([7])).toBe(true)

    endFirst()
    expect(hasActiveBridgeDeliveryExecution([7])).toBe(true)
    endSecond()
    expect(hasActiveBridgeDeliveryExecution([7])).toBe(false)
  })
})
