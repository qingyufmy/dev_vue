import { queryAll } from '../db.js'
import { getWeeklySystemFlattenState } from '../jobs/weekly-system-flatten.js'
import { isWeeklyFlattenWindow } from '../jobs/weekly-risk-window.js'
import { getRegisteredAutoSchedulerState } from '../routes/ai/runtime-state-registry.js'
import {
  createUpdateMaintenanceFence,
  hasActiveBridgeDeliveryExecution,
  releaseUpdateMaintenanceFence,
  renewUpdateMaintenanceFence,
} from './update-maintenance-registry.js'

function placeholders(values) {
  return values.map(() => '?').join(',')
}

function numericIds(values) {
  return [...new Set((values || []).map(Number)
    .filter(value => Number.isSafeInteger(value) && value > 0))]
}

function denial(code, retryAfterSeconds, details = {}) {
  return {
    allowed:false,
    code,
    retry_after_seconds:retryAfterSeconds,
    ...details,
  }
}

export function createBridgeUpdateAdmissionController({
  queryAllFn = queryAll,
  schedulerState = getRegisteredAutoSchedulerState,
  weeklyState = getWeeklySystemFlattenState,
  weeklyWindow = isWeeklyFlattenWindow,
  createFence = createUpdateMaintenanceFence,
  hasActiveDelivery = hasActiveBridgeDeliveryExecution,
  renewFence = renewUpdateMaintenanceFence,
  releaseFence = releaseUpdateMaintenanceFence,
} = {}) {
  const fenceByLeaseId = new Map()

  async function resolveScope({ actor, authorizedUserIds }) {
    const userIds = numericIds(authorizedUserIds)
    const subscriptions = userIds.length === 0 ? [] : await queryAllFn(`
      SELECT subscriptions.user_id, strategies.id AS strategy_id,
        strategies.scope, strategies.owner_user_id
      FROM strategy_subscriptions subscriptions
      JOIN auto_prompt_types strategies ON strategies.id = subscriptions.strategy_id
      WHERE subscriptions.user_id IN (${placeholders(userIds)})
        AND subscriptions.execution_enabled = 1 AND subscriptions.is_deleted = 0
        AND strategies.is_active = 1 AND strategies.deleted_at IS NULL`, userIds)

    const privateOwnerUserIds = numericIds(subscriptions
      .filter(row => row.scope === 'private'
        && Number(row.owner_user_id) === Number(row.user_id))
      .map(row => row.user_id))
    const privateStrategyIds = numericIds(subscriptions
      .filter(row => row.scope === 'private'
        && Number(row.owner_user_id) === Number(row.user_id))
      .map(row => row.strategy_id))

    const sources = userIds.length === 0 ? [] : await queryAllFn(`
      SELECT bridge_user_id, strategy_id
      FROM ai_observer_sources
      WHERE bridge_user_id IN (${placeholders(userIds)}) AND status = 'active'`, userIds)
    const marketSourceUserIds = numericIds(sources.map(row => row.bridge_user_id))
    const platformStrategyIds = numericIds(sources.map(row => row.strategy_id))

    if (String(actor?.role || '').toLowerCase() === 'admin'
      && userIds.includes(Number(actor?.id))) {
      const fallbackStrategies = await queryAllFn(`
        SELECT strategies.id AS strategy_id
        FROM auto_prompt_types strategies
        WHERE strategies.scope = 'platform' AND strategies.is_active = 1
          AND strategies.deleted_at IS NULL
          AND NOT EXISTS (
            SELECT 1 FROM ai_observer_sources sources
            WHERE sources.strategy_id = strategies.id AND sources.status = 'active'
          )`)
      if (fallbackStrategies.length > 0) {
        marketSourceUserIds.push(Number(actor.id))
        platformStrategyIds.push(...numericIds(fallbackStrategies.map(row => row.strategy_id)))
      }
    }

    return {
      deliveryUserIds:userIds,
      privateOwnerUserIds:numericIds(privateOwnerUserIds),
      privateStrategyIds,
      marketSourceUserIds:numericIds(marketSourceUserIds),
      platformStrategyIds:numericIds(platformStrategyIds),
    }
  }

  async function prepare({ actor, authorizedUserIds }) {
    const scope = await resolveScope({ actor, authorizedUserIds })
    const weekly = weeklyState(scope.deliveryUserIds)
    if (weeklyWindow() || weekly.affected) {
      return denial('bridge_maintenance_weekly_task_active', 30, {
        active_user_ids:weekly.affected_user_ids || [],
      })
    }

    // Install the scoped fence before inspecting scheduler state. JavaScript's
    // synchronous section makes the state check atomic with respect to a new
    // local scheduler tick; the scheduler also rechecks after its Redis lock.
    const fence = createFence({ ...scope, ttlSeconds:95 })
    if (hasActiveDelivery(scope.deliveryUserIds)) {
      releaseFence(fence.fence_id)
      return denial('bridge_maintenance_delivery_in_flight', 5)
    }
    const blockedStrategyIds = new Set([
      ...scope.platformStrategyIds,
      ...scope.privateStrategyIds,
    ])
    const activeCycles = Object.values(schedulerState()).filter(state =>
      state?.inFlight && blockedStrategyIds.has(Number(state.promptTypeId)))
    if (activeCycles.length > 0) {
      releaseFence(fence.fence_id)
      return denial('bridge_maintenance_scheduler_in_flight', 5, {
        active_cycles:activeCycles.map(state => ({
          prompt_type_id:Number(state.promptTypeId),
          symbol:String(state.symbol || ''),
          stage:String(state.stage || 'running'),
        })),
      })
    }
    return { allowed:true, fence_id:fence.fence_id, scope }
  }

  function bindLease(leaseId, fenceId) {
    if (!leaseId || !fenceId) return false
    if (!renewFence(String(fenceId), { ttlSeconds:95 })) return false
    fenceByLeaseId.set(String(leaseId), String(fenceId))
    return true
  }

  function discardFence(fenceId) {
    return releaseFence(String(fenceId || ''))
  }

  function renewLease(leaseId) {
    const normalizedLeaseId = String(leaseId || '')
    const fenceId = fenceByLeaseId.get(normalizedLeaseId)
    const renewed = fenceId ? renewFence(fenceId, { ttlSeconds:95 }) : false
    if (!renewed) fenceByLeaseId.delete(normalizedLeaseId)
    return renewed
  }

  function releaseLease(leaseId) {
    const normalizedLeaseId = String(leaseId || '')
    const fenceId = fenceByLeaseId.get(normalizedLeaseId)
    fenceByLeaseId.delete(normalizedLeaseId)
    return fenceId ? releaseFence(fenceId) : false
  }

  return { prepare, bindLease, discardFence, renewLease, releaseLease }
}

export const bridgeUpdateAdmission = createBridgeUpdateAdmissionController()
