import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'

const html = readFileSync(new URL('../../public/ai/index.html', import.meta.url), 'utf8')
const app = readFileSync(new URL('../../public/ai/app.js', import.meta.url), 'utf8')
const css = readFileSync(new URL('../../public/ai/styles.css', import.meta.url), 'utf8')
const routes = readFileSync(new URL('../../server/routes/ai/index.js', import.meta.url), 'utf8')
const bridgeWs = readFileSync(new URL('../../server/bridge-ws.js', import.meta.url), 'utf8')
const profiles = readFileSync(new URL('../../server/routes/ai/model-profiles.js', import.meta.url), 'utf8')

describe('AI governance navigation and DOM contract', () => {
  it('provides the unified user and administrator information architecture', () => {
    for (const tab of ['model-strategy', 'trading', 'risk-center', 'history', 'review-memory']) {
      expect(html).toContain(`data-tab="${tab}"`)
      expect(html).toContain(`id="${tab}"`)
    }
    expect(html).toContain('data-model-strategy-tab="strategies"')
    expect(html).toContain('data-model-strategy-tab="models"')
    expect(html).toContain('data-model-strategy-panel="strategies"')
    expect(html).toContain('data-model-strategy-panel="models"')
    expect(html).not.toContain('data-tab="model-management"')
    expect(html).not.toContain('data-tab="ai-config"')
    for (const tab of ['global-risk', 'audit']) expect(html).toContain(`data-tab="${tab}"`)
    expect(html).not.toContain('data-tab="account-review"')
  })

  it('accepts a token handoff before the early authentication redirect', () => {
    const earlyAuth = html.slice(html.indexOf('(function()'), html.indexOf('</script>'))
    expect(earlyAuth).toContain("new URLSearchParams(window.location.search).get('token')")
    expect(earlyAuth.indexOf("localStorage.setItem('authToken', t)")).toBeLessThan(earlyAuth.indexOf("window.location.replace('/')"))
  })

  it('marks administrator controls and keeps private review and memory pages user-scoped', () => {
    expect(html).toContain('id="global-risk" class="tab-panel admin-only"')
    expect(html).toContain('id="accountExceptionList"')
    expect(html).not.toContain('id="account-review"')
    expect(app).toContain('api(`/api/ai/reviews${query}`)')
    expect(app).toContain('api("/api/ai/memory")')
    expect(routes).toContain("WHERE id = ? AND user_id = ?")
  })

  it('exposes explicit model source, shared credential and quota copy without storing a key in state', () => {
    expect(html).toContain('id="modelSourceNotice"')
    expect(html).toContain('id="sharedCredentialNotice"')
    expect(html).toContain('id="policyDailyRequests"')
    const stateBlock = app.slice(app.indexOf('const state = {'), app.indexOf('// ===== History Cache'))
    expect(stateBlock).not.toMatch(/^\s*(?:apiKey|api_key|credential)\s*:/mi)
    expect(html).not.toContain('id="apiKey"')
    expect(html).not.toContain('id="autoApiKey"')
    expect(app).not.toContain('$("apiKey")')
    expect(html).toContain('付费配对实验（额外一次调用）')
  })

  it('shows user-editable price controls and separates AI, cap and final execution volume', () => {
    expect(app).toContain('pending_price_deviation_pct')
    expect(app).toContain('market_signal_drift_atr')
    expect(app).toContain('AI 建议')
    expect(app).toContain('风险上限')
    expect(app).toContain('最终')
  })

  it('provides account and platform kill switches plus a reviewed recovery workflow', () => {
    expect(html).toContain('id="globalKillSwitchBtn"')
    expect(html).toContain('id="adminRecoveryList"')
    expect(app).toContain('data-kill-switch=')
    expect(app).toContain('data-risk-recovery=')
    expect(routes).toContain("'/ai/admin/recoveries/:id/review'")
    expect(routes).toContain("'/ai/admin/risk-center/kill-switch'")
  })

  it('uses an explicit shared history scope and keeps the platform start server-owned', () => {
    expect(html).toContain('id="historyRangeMode"')
    expect(html).toContain('<option value="all">全账户历史</option>')
    expect(html).toContain('<option value="platform">平台接入后</option>')
    expect(html).toContain('<option value="custom">自定义日期</option>')
    expect(app).toContain('history_scope: scope')
    expect(app).toContain('从当前会员账户在平台注册之日开始。')
    expect(bridgeWs).toContain("DATE_FORMAT(created_at, '%Y-%m-%d') AS account_created_date")
    expect(bridgeWs).toContain('FROM users WHERE id = ? LIMIT 1')
    expect(bridgeWs).not.toContain('AS first_verified_date')
    expect(html).not.toContain('id="filterCloseFrom"')
    expect(html).not.toContain('id="chartDateFrom"')
  })

  it('lets administrators operate adjustable rule rollouts while forced rules stay disabled', () => {
    expect(html).toContain('id="riskRuleRolloutList"')
    expect(app).toContain('data-risk-rollout=')
    expect(app).toContain('/api/ai/admin/risk-rule-rollouts/')
    expect(app).toContain("rule.forced_enforce ? 'disabled' : ''")
  })

  it('uses exact review language and separates process issue from content confirmation', () => {
    expect(app).toContain('内容准确并加入记忆')
    expect(app).toContain('内容有问题，继续修改')
    expect(app).toContain('交易流程问题')
    expect(app).toContain('复盘内容确认')
  })

  it('separates strategy visibility, editing and execution permissions in the UI', () => {
    expect(html).toContain('id="strategyScopeField" class="admin-only"')
    expect(html).toContain('平台全局策略')
    expect(html).toContain('你创建的私有策略仅自己可见、可选和执行')
    expect(app).toContain("const canSubscribe = item.scope === 'platform' || Number(item.owner_user_id) === Number(state.user?.id)")
    expect(app).toContain('仅审计可见')
  })

  it('uses one strategy control plane and a credential-free preference endpoint', () => {
    expect(app).toContain('/api/ai/inference-preferences')
    expect(routes).toContain("router.get('/ai/inference-preferences', authMiddleware")
    expect(routes).toContain("router.put('/ai/inference-preferences', authMiddleware")
    expect(html).not.toContain('id="auto-config"')
    expect(html).not.toContain('id="promptTypeModal"')
    expect(app).not.toContain("wsApi('get_auto_config')")
    expect(app).not.toContain('wsApi("save_config"')
    expect(app).not.toContain('initAutoSymbolsSelector')
  })

  it('has responsive behavior, loading skeletons and reduced-motion handling', () => {
    expect(css).toContain('@media (max-width:900px)')
    expect(css).toContain('@media (max-width:600px)')
    expect(css).toContain('@media (prefers-reduced-motion: reduce)')
    expect(css).toContain('.workspace-skeleton')
    expect(html).toContain('empty-state')
    expect(css).toContain('grid-template-columns: minmax(0, 1fr)')
    expect(css).toContain('max-width: 100vw')
    expect(app).toContain('state._lastGatewayLive !== true')
  })

  it('uses the same current cache key for the AI stylesheet and application script', () => {
    const stylesheetVersion = html.match(/styles\.css\?v=([0-9a-z]+)/)?.[1]
    const appVersion = html.match(/app\.js\?v=([0-9a-z]+)/)?.[1]
    expect(stylesheetVersion).toBeTruthy()
    expect(appVersion).toBe(stylesheetVersion)
  })
})

describe('route permissions and credential redaction', () => {
  it('requires authentication on every new route and an admin role on global controls', () => {
    for (const path of ['/ai/model-profiles', '/ai/strategies', '/ai/risk-center', '/ai/executions']) {
      expect(routes).toMatch(new RegExp(`router\\.(?:get|post|put|delete)\\('${path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[^']*', authMiddleware`))
    }
    expect(routes).toContain("req.user.role !== 'admin'")
    expect(routes).toContain("error: 'admin_only'")
  })

  it('exposes authenticated strategy, account and subscription CRUD routes', () => {
    for (const route of [
      "router.get('/ai/strategies', authMiddleware",
      "router.post('/ai/strategies', authMiddleware",
      "router.put('/ai/strategies/:id', authMiddleware",
      "router.delete('/ai/strategies/:id', authMiddleware",
      "router.get('/ai/trading-accounts', authMiddleware",
      "router.post('/ai/trading-accounts', authMiddleware",
      "router.put('/ai/trading-accounts/:id', authMiddleware",
      "router.delete('/ai/trading-accounts/:id', authMiddleware",
      "router.post('/ai/subscriptions', authMiddleware",
      "router.put('/ai/subscriptions/:id', authMiddleware",
      "router.delete('/ai/subscriptions/:id', authMiddleware",
    ]) expect(routes).toContain(route)
  })

  it('returns sanitized profiles and never serializes encrypted or plaintext credentials', () => {
    expect(routes).toContain('credential_fields_redacted: true')
    expect(profiles).toContain('delete out.api_key_encrypted')
    expect(profiles).toContain("out.masked_api_key = out.has_api_key ? '****' : null")
    expect(routes).toContain("router.get('/ai/model-source'")
    expect(routes).not.toContain('api_key_encrypted: resolved.model.api_key_encrypted')
  })
})
