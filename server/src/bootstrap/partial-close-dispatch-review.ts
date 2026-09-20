import type { PoolConnection } from 'mysql2/promise'
import type { BridgeGatewayRoute } from '../modules/bridge/index.js'
import { createPartialCloseDispatchReviewer, type PartialCloseDispatchContextReader } from '../modules/risk/index.js'
import { createMysqlPositionProtectionClock } from '../modules/risk/composition.js'
import { createTransactionPositionManagementContextReader, type PositionManagementContextReader, type PositionProtectionReadLimits } from './position-protection-review.js'

/** An older projection can support price protection while remaining insufficient for a new volume-changing action. */
export function createPartialCloseDispatchContextReader(contexts: PositionManagementContextReader): PartialCloseDispatchContextReader {
  return { async read(request) {
    const context = await contexts.read(request)
    if (!context) return null
    const { volumeMin, volumeMax, volumeStep } = context.instrument
    if (typeof volumeMin !== 'string' || typeof volumeMax !== 'string' || typeof volumeStep !== 'string') return null
    return { ...context, instrument: { ...context.instrument, volumeMin, volumeMax, volumeStep } }
  } }
}

export function createTransactionPartialCloseDispatchReviewer(connection: PoolConnection, route: BridgeGatewayRoute, limits: PositionProtectionReadLimits) {
  const contexts = createTransactionPositionManagementContextReader(connection,route,limits)
  return createPartialCloseDispatchReviewer(createPartialCloseDispatchContextReader(contexts),createMysqlPositionProtectionClock(connection))
}
