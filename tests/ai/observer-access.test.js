import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import {
  buildAiAccessContext, observerHttpRequestAllowed, observerWsActionAllowed,
  normalizeAiRequestPath, PLUS_OBSERVER_TABS, PRO_OBSERVER_TABS,
} from '../../server/routes/ai/observer-access.js'

const app = readFileSync(new URL('../../public/ai/app.js', import.meta.url), 'utf8')
const css = readFileSync(new URL('../../public/ai/styles.css', import.meta.url), 'utf8')
const bridgeWs = readFileSync(new URL('../../server/bridge-ws.js', import.meta.url), 'utf8')

describe('AI observer access', () => {
  it('normalizes only one known API prefix and one trailing slash', () => {
    expect(normalizeAiRequestPath('/api/ai/access-context?channel_id=1')).toBe('/ai/access-context')
    expect(normalizeAiRequestPath('/aurum-api/ai/access-context/')).toBe('/ai/access-context')
    expect(normalizeAiRequestPath('/api')).toBe('/')
    expect(normalizeAiRequestPath('/aurum-api/')).toBe('/')
    expect(normalizeAiRequestPath('/api/ai/access-context//')).toBe('/ai/access-context//')
    expect(normalizeAiRequestPath('/api//ai/access-context')).toBe('//ai/access-context')
    expect(normalizeAiRequestPath('/api/%2Fai/access-context')).toBe('/%2Fai/access-context')
    expect(normalizeAiRequestPath('/apiary/ai/access-context')).toBe('/apiary/ai/access-context')
    expect(normalizeAiRequestPath('/api/aurum-api/ai/access-context')).toBe('/aurum-api/ai/access-context')
  })

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

  it('blocks expired and free memberships at the server boundary', () => {
    const expired = buildAiAccessContext({ role:'user', plan:'pro', plan_expires_at:'2020-01-01 00:00:00' }, { ownBridgeConnected:true })
    const free = buildAiAccessContext({ role:'user', plan:'free' }, { ownBridgeConnected:true })
    expect(expired).toMatchObject({ mode:'blocked', reason:'membership_expired', read_only:true, can_download_bridge:false })
    expect(free).toMatchObject({ mode:'blocked', reason:'membership_required', read_only:true, can_download_bridge:false })
    expect(observerHttpRequestAllowed(expired, 'GET', '/ai/access-context')).toBe(true)
    expect(observerHttpRequestAllowed(expired, 'GET', '/ai/model-profiles')).toBe(false)
    expect(observerWsActionAllowed(expired, 'signals')).toBe(false)
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

  it('keeps both API prefixes and every observer identity method-consistent', () => {
    const identities = [
      { name:'admin', access:buildAiAccessContext({ role:'admin', plan:'plus' }, { ownBridgeConnected:false }), readOnly:false },
      { name:'plus observer', access:buildAiAccessContext({ role:'user', plan:'plus' }, { ownBridgeConnected:false }), readOnly:true },
      { name:'pro bridge offline', access:buildAiAccessContext({ role:'user', plan:'pro' }, { ownBridgeConnected:false }), readOnly:true },
      { name:'pro bridge online', access:buildAiAccessContext({ role:'user', plan:'pro' }, { ownBridgeConnected:true }), readOnly:false },
      { name:'free', access:buildAiAccessContext({ role:'user', plan:'free' }, { ownBridgeConnected:false }), readOnly:true },
      { name:'expired', access:buildAiAccessContext({ role:'user', plan:'pro', plan_expires_at:'2020-01-01 00:00:00' }, { ownBridgeConnected:true }), readOnly:true },
    ]
    const prefixes = ['/api', '/aurum-api']
    const methods = ['GET', 'POST', 'PUT', 'DELETE']

    for (const identity of identities) {
      for (const method of methods) {
        const results = prefixes.map(prefix => observerHttpRequestAllowed(
          identity.access, method, `${prefix}/ai/access-context/`,
        ))
        expect(results, `${identity.name} ${method}`).toEqual([results[0], results[0]])
        if (identity.readOnly) {
          expect(results[0], `${identity.name} ${method}`).toBe(method === 'GET')
        } else {
          expect(results[0], `${identity.name} ${method}`).toBe(true)
        }
      }
    }

    const plus = identities.find(identity => identity.name === 'plus observer').access
    const proOffline = identities.find(identity => identity.name === 'pro bridge offline').access
    const free = identities.find(identity => identity.name === 'free').access
    for (const prefix of prefixes) {
      expect(observerHttpRequestAllowed(plus, 'GET', `${prefix}/ai/observer-channels`)).toBe(true)
      expect(observerHttpRequestAllowed(plus, 'GET', `${prefix}/ai/model-profiles`)).toBe(false)
      expect(observerHttpRequestAllowed(proOffline, 'GET', `${prefix}/ai/model-profiles`)).toBe(true)
      expect(observerHttpRequestAllowed(proOffline, 'GET', `${prefix}/ai/risk-center`)).toBe(false)
      expect(observerHttpRequestAllowed(free, 'GET', `${prefix}/ai/access-context`)).toBe(true)
      expect(observerHttpRequestAllowed(free, 'GET', `${prefix}/ai/observer-channels`)).toBe(false)
      expect(observerHttpRequestAllowed(plus, 'GET', `${prefix}/ai/access-context//`)).toBe(false)
    }
    expect(observerHttpRequestAllowed(plus, 'GET', '/api/aurum-api/ai/access-context')).toBe(false)
    expect(observerHttpRequestAllowed(plus, 'GET', '/aurum-api/api/ai/access-context')).toBe(false)
  })

  it('allows only observer page data over the browser WebSocket', () => {
    const access = buildAiAccessContext({ role:'user', plan:'plus' }, { ownBridgeConnected:false })
    for (const action of ['health', 'account', 'positions', 'signals', 'signal_detail', 'signal_evidence',
      'history', 'history_chart_data', 'history_prepare_status_v1', 'rates']) {
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
    expect(bridgeWs).toContain('const tradeEnabled = alive ? isTradeEnabled(dataUserId) : undefined')
    expect(bridgeWs).toContain('const channelSource = await getDefaultObserverSource()')
    expect(bridgeWs).toContain('Never silently show another')
    expect(bridgeWs).toContain('params.observer_channel_id')
    expect(app).toContain('observer_channel_id = state.selectedObserverChannelId')
    expect(app).toContain('changeObserverChannel(option.dataset.observerChannelId)')
    expect(app).toContain('setObserverChannelMenuOpen(false)')
  })
})
