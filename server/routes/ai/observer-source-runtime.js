import { applyBridgeRuntimeState, disconnectUserBridgeConnections } from '../../bridge-ws.js'
import { reconcileAutoSchedulers } from './scheduler.js'

function positiveUserId(value) {
  const id = Number(value)
  return Number.isInteger(id) && id > 0 ? id : null
}

async function guardedSync(label, callback) {
  try {
    return { ok:true, result:await callback() }
  } catch (error) {
    console.error(`[ObserverSourceRuntime] ${label} failed:`, error)
    return { ok:false, degraded:true, error:`observer_source_${label}_sync_pending` }
  }
}

export async function synchronizeObserverSourceRuntime(source, {
  deleted = false,
  reconcileSchedulers = reconcileAutoSchedulers,
  applyRuntime = applyBridgeRuntimeState,
  disconnectUser = disconnectUserBridgeConnections,
} = {}) {
  const currentUserId = positiveUserId(source?.bridge_user_id)
  const previousUserId = positiveUserId(source?.runtime_transition?.previous_bridge_user_id)
  const reconnectRequired = deleted || source?.runtime_transition?.reconnect_required === true

  if (reconnectRequired) {
    const affectedUsers = new Set([previousUserId, currentUserId].filter(Boolean))
    for (const userId of affectedUsers) {
      disconnectUser(userId, 'observer_source_binding_changed')
    }
  }

  const active = !deleted && source?.status === 'active'
  const [scheduler_sync, bridge_sync] = await Promise.all([
    guardedSync('scheduler', () => reconcileSchedulers()),
    currentUserId
      ? guardedSync('bridge', () => applyRuntime(currentUserId, {
          tradeEnabled:active && Boolean(source?.trade_send_enabled),
          autoReasoningEnabled:active && Boolean(source?.auto_inference_enabled),
        }))
      : Promise.resolve({ ok:true, result:{ connected:false, skipped:true } }),
  ])

  return {
    scheduler_sync,
    bridge_sync,
    disconnected_for_rebind:reconnectRequired,
    degraded:!scheduler_sync.ok || !bridge_sync.ok,
  }
}
