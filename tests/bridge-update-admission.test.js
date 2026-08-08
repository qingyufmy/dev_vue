import { describe, expect, it, vi } from 'vitest'

import { createBridgeUpdateAdmissionController } from '../server/bridge-v3/update-admission.js'

function queryFixture({ subscriptions = [], sources = [], fallbackStrategies = [] } = {}) {
  return vi.fn().mockImplementation(async sql => {
    if (sql.includes('FROM strategy_subscriptions')) return subscriptions
    if (sql.includes('FROM ai_observer_sources')) return sources
    if (sql.includes("strategies.scope = 'platform'")) return fallbackStrategies
    return []
  })
}

function controller({ queries, scheduler = {}, weekly = {}, weeklyWindow = false, activeDelivery = false } = {}) {
  const createFence = vi.fn().mockReturnValue({ fence_id:'fence_test', expires_at_utc_msc:Date.now() + 95_000 })
  const releaseFence = vi.fn().mockReturnValue(true)
  const renewFence = vi.fn().mockReturnValue(true)
  return {
    createFence,
    releaseFence,
    renewFence,
    admission:createBridgeUpdateAdmissionController({
      queryAllFn:queries || queryFixture(),
      schedulerState:() => scheduler,
      weeklyState:() => ({ affected:false, affected_user_ids:[], ...weekly }),
      weeklyWindow:() => weeklyWindow,
      createFence,
      hasActiveDelivery:() => activeDelivery,
      releaseFence,
      renewFence,
    }),
  }
}

describe('bridge update scheduler admission', () => {
  it('does not pause a shared platform inference for an ordinary subscriber', async () => {
    const { admission, createFence } = controller({
      queries:queryFixture({ subscriptions:[{
        user_id:7, strategy_id:31, scope:'platform', owner_user_id:0,
      }] }),
      scheduler:{ '31:XAUUSD':{
        promptTypeId:31, symbol:'XAUUSD', inFlight:true, subscribers:new Set([7, 8]),
      } },
    })

    const result = await admission.prepare({
      actor:{ id:7, role:'user' }, authorizedUserIds:[7],
    })

    expect(result.allowed).toBe(true)
    expect(createFence).toHaveBeenCalledWith(expect.objectContaining({
      deliveryUserIds:[7],
      privateOwnerUserIds:[],
      platformStrategyIds:[],
    }))
  })

  it('waits for the current private strategy round and removes its provisional fence', async () => {
    const { admission, releaseFence } = controller({
      queries:queryFixture({ subscriptions:[{
        user_id:7, strategy_id:41, scope:'private', owner_user_id:7,
      }] }),
      scheduler:{ '41:XAUUSD':{
        promptTypeId:41, symbol:'XAUUSD', stage:'ai', inFlight:true, subscribers:new Set([7]),
      } },
    })

    const result = await admission.prepare({
      actor:{ id:7, role:'user' }, authorizedUserIds:[7],
    })

    expect(result).toMatchObject({
      allowed:false,
      code:'bridge_maintenance_scheduler_in_flight',
      active_cycles:[{ prompt_type_id:41, symbol:'XAUUSD', stage:'ai' }],
    })
    expect(releaseFence).toHaveBeenCalledWith('fence_test')
  })

  it('waits only for a platform cycle that depends on an included observer source', async () => {
    const { admission } = controller({
      queries:queryFixture({
        sources:[{ bridge_user_id:42, strategy_id:51 }],
      }),
      scheduler:{
        '51:XAUUSD':{ promptTypeId:51, symbol:'XAUUSD', inFlight:true, subscribers:new Set([9]) },
        '52:EURUSD':{ promptTypeId:52, symbol:'EURUSD', inFlight:true, subscribers:new Set([10]) },
      },
    })

    const result = await admission.prepare({
      actor:{ id:1, role:'admin' }, authorizedUserIds:[1, 42],
    })

    expect(result.active_cycles).toEqual([
      expect.objectContaining({ prompt_type_id:51 }),
    ])
  })

  it('gives the weekly account-protection task priority without creating a fence', async () => {
    const { admission, createFence } = controller({
      weekly:{ affected:true, affected_user_ids:[7] },
    })

    const result = await admission.prepare({
      actor:{ id:7, role:'user' }, authorizedUserIds:[7],
    })

    expect(result).toMatchObject({
      allowed:false,
      code:'bridge_maintenance_weekly_task_active',
      active_user_ids:[7],
    })
    expect(createFence).not.toHaveBeenCalled()
  })

  it('waits for an already-started per-user delivery without pausing shared inference', async () => {
    const { admission, releaseFence } = controller({ activeDelivery:true })

    const result = await admission.prepare({
      actor:{ id:7, role:'user' }, authorizedUserIds:[7],
    })

    expect(result).toMatchObject({
      allowed:false,
      code:'bridge_maintenance_delivery_in_flight',
    })
    expect(releaseFence).toHaveBeenCalledWith('fence_test')
  })

  it('binds, renews and releases a scheduler fence with its gateway lease', async () => {
    const { admission, renewFence, releaseFence } = controller()
    const prepared = await admission.prepare({
      actor:{ id:7, role:'user' }, authorizedUserIds:[7],
    })
    admission.bindLease('lease_test', prepared.fence_id)

    expect(admission.renewLease('lease_test')).toBe(true)
    expect(renewFence).toHaveBeenCalledWith('fence_test', { ttlSeconds:95 })
    expect(admission.releaseLease('lease_test')).toBe(true)
    expect(releaseFence).toHaveBeenCalledWith('fence_test')
  })
})
