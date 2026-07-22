import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import {
  buildAiAccessContext, observerHttpRequestAllowed, observerWsActionAllowed,
  PLUS_OBSERVER_TABS, PRO_OBSERVER_TABS,
} from '../../server/routes/ai/observer-access.js'

const app = readFileSync(new URL('../../public/ai/app.js', import.meta.url), 'utf8')
const css = readFileSync(new URL('../../public/ai/styles.css', import.meta.url), 'utf8')
const bridgeWs = readFileSync(new URL('../../server/bridge-ws.js', import.meta.url), 'utf8')

describe('AI observer access', () => {
  it('keeps Plus permanently read-only and removes bridge download access', () => {
    const access = buildAiAccessContext({ role:'user', plan:'plus' }, { ownBridgeConnected:true })
    expect(access).toMatchObject({ mode:'observer', reason:'plus_plan', read_only:true, can_download_bridge:false, data_source:'platform_admin_account' })
    expect(access.allowed_tabs).toEqual(PLUS_OBSERVER_TABS)
    expect(access.allowed_tabs).toContain('feedback')
    expect(access.allowed_tabs).not.toContain('signals')
  })

  it('makes offline Pro read-only while retaining bridge download access', () => {
    const access = buildAiAccessContext({ role:'user', plan:'pro' }, { ownBridgeConnected:false })
    expect(access).toMatchObject({ mode:'observer', reason:'bridge_offline', read_only:true, can_download_bridge:true })
    expect(access.allowed_tabs).toEqual(PRO_OBSERVER_TABS)
    expect(access.allowed_tabs).toContain('feedback')
    expect(access.allowed_tabs).not.toContain('signals')
  })

  it('restores full Pro access only when the own bridge is connected', () => {
    expect(buildAiAccessContext({ role:'user', plan:'pro' }, { ownBridgeConnected:true }).read_only).toBe(false)
    expect(buildAiAccessContext({ role:'admin', plan:'plus' }, { ownBridgeConnected:false }).read_only).toBe(false)
  })

  it('allows observer data reads but blocks mutations and hidden modules', () => {
    const plus = buildAiAccessContext({ role:'user', plan:'plus' }, { ownBridgeConnected:false })
    const pro = buildAiAccessContext({ role:'user', plan:'pro' }, { ownBridgeConnected:false })
    expect(observerHttpRequestAllowed(plus, 'GET', '/ai/access-context')).toBe(true)
    expect(observerHttpRequestAllowed(plus, 'GET', '/ai/observer-channels')).toBe(true)
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

  it('keeps observer controls visible while locking their interactions', () => {
    expect(app).toContain("bottomGroup.style.display = ''")
    expect(app).toContain("document.querySelectorAll('.observer-action-panel').forEach(panel => setObserverPanelLock(panel, observer))")
    expect(app).toContain("panel.querySelectorAll('#buyBtn, #sellBtn')")
    expect(app).toContain("badge.setAttribute('aria-disabled', String(observer))")
    expect(app).toContain('renderObserverSwitchStates({')
    expect(css).toContain('.ai-observer-mode .observer-action-panel.is-readonly')
    expect(css).toContain(':is(#buyBtn, #sellBtn)')
    expect(css).not.toContain('.ai-observer-mode .observer-action-panel,')
    expect(css).not.toContain('.ai-observer-mode #autoAnalyzeMode,')
    expect(bridgeWs).toContain('auto_reasoning_enabled: autoReasoningEnabled')
    expect(bridgeWs).toContain('const tradeEnabled = alive ? !!bridge.tradeEnabled : undefined')
    expect(bridgeWs).toContain('const channelSource = await getDefaultObserverSource()')
    expect(bridgeWs).toContain('Never silently show another')
    expect(bridgeWs).toContain('params.observer_channel_id')
    expect(app).toContain('observer_channel_id = state.selectedObserverChannelId')
    expect(app).toContain('changeObserverChannel(select.value)')
  })
})
