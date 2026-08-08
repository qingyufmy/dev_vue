import { describe, expect, it, vi } from 'vitest'

vi.mock('../../server/bridge-ws.js', () => ({
  applyBridgeRuntimeState:vi.fn(),
  disconnectUserBridgeConnections:vi.fn(),
}))
vi.mock('../../server/routes/ai/scheduler.js', () => ({
  reconcileAutoSchedulers:vi.fn(),
}))

import { synchronizeObserverSourceRuntime } from '../../server/routes/ai/observer-source-runtime.js'

function source(overrides = {}) {
  return {
    bridge_user_id:9,
    status:'active',
    trade_send_enabled:true,
    auto_inference_enabled:true,
    runtime_transition:{
      reconnect_required:false,
      previous_bridge_user_id:9,
    },
    ...overrides,
  }
}

describe('observer source runtime synchronization', () => {
  it('fences both old and new users before applying a changed binding', async () => {
    const events = []
    const disconnectUser = vi.fn((userId) => events.push(`disconnect:${userId}`))
    const reconcileSchedulers = vi.fn(async () => {
      events.push('scheduler')
      return { started:1 }
    })
    const applyRuntime = vi.fn(async (userId, options) => {
      events.push(`apply:${userId}`)
      return { connected:false, options }
    })

    const result = await synchronizeObserverSourceRuntime(source({
      runtime_transition:{ reconnect_required:true, previous_bridge_user_id:7 },
    }), { disconnectUser, reconcileSchedulers, applyRuntime })

    expect(disconnectUser.mock.calls).toEqual([
      [7, 'observer_source_binding_changed'],
      [9, 'observer_source_binding_changed'],
    ])
    expect(events.slice(0, 2)).toEqual(['disconnect:7', 'disconnect:9'])
    expect(applyRuntime).toHaveBeenCalledWith(9, {
      tradeEnabled:true, autoReasoningEnabled:true,
    })
    expect(result).toMatchObject({ degraded:false, disconnected_for_rebind:true })
  })

  it('updates runtime switches without disconnecting an unchanged binding', async () => {
    const disconnectUser = vi.fn()
    const reconcileSchedulers = vi.fn().mockResolvedValue({})
    const applyRuntime = vi.fn().mockResolvedValue({ connected:true })

    await expect(synchronizeObserverSourceRuntime(source({
      trade_send_enabled:false,
      auto_inference_enabled:false,
    }), { disconnectUser, reconcileSchedulers, applyRuntime })).resolves.toMatchObject({
      degraded:false, disconnected_for_rebind:false,
    })
    expect(disconnectUser).not.toHaveBeenCalled()
    expect(applyRuntime).toHaveBeenCalledWith(9, {
      tradeEnabled:false, autoReasoningEnabled:false,
    })
  })

  it('disconnects a deleted source and applies a disabled runtime state', async () => {
    const disconnectUser = vi.fn()
    const reconcileSchedulers = vi.fn().mockResolvedValue({})
    const applyRuntime = vi.fn().mockResolvedValue({ connected:false })

    await synchronizeObserverSourceRuntime(source(), {
      deleted:true, disconnectUser, reconcileSchedulers, applyRuntime,
    })

    expect(disconnectUser).toHaveBeenCalledWith(9, 'observer_source_binding_changed')
    expect(applyRuntime).toHaveBeenCalledWith(9, {
      tradeEnabled:false, autoReasoningEnabled:false,
    })
  })

  it('reports scheduler and bridge degradation independently', async () => {
    const result = await synchronizeObserverSourceRuntime(source(), {
      disconnectUser:vi.fn(),
      reconcileSchedulers:vi.fn().mockRejectedValue(new Error('scheduler down')),
      applyRuntime:vi.fn().mockRejectedValue(new Error('bridge down')),
    })

    expect(result).toMatchObject({
      degraded:true,
      scheduler_sync:{ ok:false, error:'observer_source_scheduler_sync_pending' },
      bridge_sync:{ ok:false, error:'observer_source_bridge_sync_pending' },
    })
  })
})
