import { describe, expect, it } from 'vitest'
import {
  buildAiAccessContext, observerHttpRequestAllowed, observerWsActionAllowed,
  PLUS_OBSERVER_TABS, PRO_OBSERVER_TABS,
} from '../../server/routes/ai/observer-access.js'

describe('AI observer access', () => {
  it('keeps Plus permanently read-only and removes bridge download access', () => {
    const access = buildAiAccessContext({ role:'user', plan:'plus' }, { ownBridgeConnected:true })
    expect(access).toMatchObject({ mode:'observer', reason:'plus_plan', read_only:true, can_download_bridge:false, data_source:'platform_admin_account' })
    expect(access.allowed_tabs).toEqual(PLUS_OBSERVER_TABS)
  })

  it('makes offline Pro read-only while retaining bridge download access', () => {
    const access = buildAiAccessContext({ role:'user', plan:'pro' }, { ownBridgeConnected:false })
    expect(access).toMatchObject({ mode:'observer', reason:'bridge_offline', read_only:true, can_download_bridge:true })
    expect(access.allowed_tabs).toEqual(PRO_OBSERVER_TABS)
  })

  it('restores full Pro access only when the own bridge is connected', () => {
    expect(buildAiAccessContext({ role:'user', plan:'pro' }, { ownBridgeConnected:true }).read_only).toBe(false)
    expect(buildAiAccessContext({ role:'admin', plan:'plus' }, { ownBridgeConnected:false }).read_only).toBe(false)
  })

  it('allows observer data reads but blocks mutations and hidden modules', () => {
    const plus = buildAiAccessContext({ role:'user', plan:'plus' }, { ownBridgeConnected:false })
    const pro = buildAiAccessContext({ role:'user', plan:'pro' }, { ownBridgeConnected:false })
    expect(observerHttpRequestAllowed(plus, 'GET', '/ai/access-context')).toBe(true)
    expect(observerHttpRequestAllowed(plus, 'GET', '/ai/model-profiles')).toBe(false)
    expect(observerHttpRequestAllowed(pro, 'GET', '/ai/model-profiles')).toBe(true)
    expect(observerHttpRequestAllowed(pro, 'GET', '/ai/risk-center')).toBe(false)
    expect(observerHttpRequestAllowed(pro, 'POST', '/ai/strategies')).toBe(false)
  })

  it('allows only observer page data over the browser WebSocket', () => {
    const access = buildAiAccessContext({ role:'user', plan:'plus' }, { ownBridgeConnected:false })
    for (const action of ['health', 'account', 'positions', 'signals', 'history', 'rates']) {
      expect(observerWsActionAllowed(access, action)).toBe(true)
    }
    for (const action of ['analyze', 'open', 'execute', 'toggle_auto', 'audit_logs', 'admin_dashboard']) {
      expect(observerWsActionAllowed(access, action)).toBe(false)
    }
  })
})
