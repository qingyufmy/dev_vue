import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'

const html = readFileSync(new URL('../../public/ai/index.html', import.meta.url), 'utf8')
const app = readFileSync(new URL('../../public/ai/app.js', import.meta.url), 'utf8')
const css = readFileSync(new URL('../../public/ai/styles.css', import.meta.url), 'utf8')
const responsiveCss = readFileSync(new URL('../../public/ai/responsive.css', import.meta.url), 'utf8')
const routes = readFileSync(new URL('../../server/routes/ai/index.js', import.meta.url), 'utf8')
const bridgeWs = readFileSync(new URL('../../server/bridge-ws.js', import.meta.url), 'utf8')
const profiles = readFileSync(new URL('../../server/routes/ai/model-profiles.js', import.meta.url), 'utf8')
const scheduler = readFileSync(new URL('../../server/routes/ai/scheduler.js', import.meta.url), 'utf8')
const serverIndex = readFileSync(new URL('../../server/index.js', import.meta.url), 'utf8')
const adminHtml = readFileSync(new URL('../../public/admin/index.html', import.meta.url), 'utf8')
const adminApp = readFileSync(new URL('../../public/admin/app.js', import.meta.url), 'utf8')
const adminCss = readFileSync(new URL('../../public/admin/styles.css', import.meta.url), 'utf8')
const adminRoutes = readFileSync(new URL('../../server/routes/admin-console.js', import.meta.url), 'utf8')

function loadTerminalClockFormatter() {
  const start = app.indexOf('function formatTime(value)')
  const end = app.indexOf('const parseDate =', start)
  const source = app.slice(start, end)
  return new Function(`${source}\nreturn { formatTerminalQuoteTime };`)()
}

function loadUserVisibleText() {
  const start = app.indexOf('function userVisibleText(value')
  const end = app.indexOf('\nfunction setSignalFieldClass', start)
  const source = app.slice(start, end)
  return new Function('localizeReason', 'REASON_MAP', 'RISK_DECISION_LABELS', `${source}\nreturn userVisibleText;`)(
    value => value,
    {},
    {},
  )
}

describe('AI governance navigation and DOM contract', () => {
  it('does not present unknown internal tokens as an unreliable Chan segment', () => {
    const userVisibleText = loadUserVisibleText()

    expect(userVisibleText('unknown_status为unknown_reason')).toBe('相关状态尚未确认')
    expect(userVisibleText('系统提示的unknown_status显示')).toBe('系统提示状态尚未确认')
    expect(userVisibleText('status=unreliable_segments')).toBe('线段结构尚不可靠')
    expect(userVisibleText('status=segment_history_unresolved')).toBe('历史窗口尚未收敛，暂不确认线段')
    expect(userVisibleText('center_entry_unconfirmed')).toBe('中枢已确认，但进入段缺少跨窗口共识，仅背驰暂不可判')
    expect(userVisibleText('structure_anchor_bootstrap_pending')).toBe('结构锚点正在用连续三根已收盘K线确认，暂不使用依赖进入段的背驰与买卖点')
    expect(userVisibleText('center_cross_window_unstable')).toBe('不同历史窗口对中枢形成核心尚未达成共识')
  })

  it('renders the same broker time for heartbeat and quote clock payloads', () => {
    const { formatTerminalQuoteTime } = loadTerminalClockFormatter()
    const observedAtUtcMsc = Date.UTC(2026, 6, 27, 6, 12, 34)

    expect(formatTerminalQuoteTime({
      time:'2026-07-27T06:12:34.000Z', timezone_offset_minutes:180,
    })).toBe('2026-07-27 09:12:34')
    expect(formatTerminalQuoteTime({
      observed_at_utc_msc:observedAtUtcMsc, timezone_offset_minutes:180,
    })).toBe('2026-07-27 09:12:34')
  })

  it('does not double-apply the offset to legacy unzoned broker time strings', () => {
    const { formatTerminalQuoteTime } = loadTerminalClockFormatter()
    expect(formatTerminalQuoteTime({
      time:'2026-07-27 09:12:34', timezone_offset_minutes:180,
    })).toBe('2026-07-27 09:12:34')
  })

  it('keeps quote metadata consistent across push and refresh paths', () => {
    expect(app).toContain("function renderQuoteStatusMeta(quote)")
    expect(app).toContain("fmt(quote.spread, 2)")
    expect(app).toContain("setText('mt5ServerTime'")
    expect(app).toContain('observedAt + offsetMinutes * 60_000')
    expect(app).toContain('function terminalQuoteObservedAtUtcMsc(quote)')
    expect(app).toContain('observed_at_utc_msc:msg.observed_at_utc_msc')
    expect(bridgeWs).toContain('const heartbeatClock = buildBrowserHeartbeatClock(')
    expect(bridgeWs).toContain('observed_at_utc_msc:Number.isFinite(observedAtValue)')
    expect(app).toContain("updateMarketStatusFromQuote(quote)")
    expect(app).toContain("loadStatus(), refreshQuote(), loadKlineData()")
    expect(app).toContain('const LIVE_QUOTE_REFRESH_INTERVAL_MS = 1000')
    expect(app).toContain('void refreshLiveQuote(true);')
    expect(app).toContain('if (isObserverMode()) return;')
    expect(app).toContain('void refreshLiveQuote(false);')
    expect(app).toContain('}, LIVE_QUOTE_REFRESH_INTERVAL_MS)')
    expect(app).toContain('setText("quoteBid", priceDisplay(q.bid))')
    expect(app).toContain('setText("quoteAsk", priceDisplay(q.ask))')
    expect(app).toContain('setText("quoteBid", priceDisplay(data.bid))')
    expect(app).toContain('setText("quoteAsk", priceDisplay(data.ask))')
    expect(html).toContain('/ai/app.js?v=20260731subscription1')
    expect(app).toContain('wsApi("platform_quote", { symbol })')
    expect(app).toContain('state.platformMarketSourceActive = platformQuote.available === true')
    expect(app).toContain('state.lastObserverQuote = {')
    expect(bridgeWs).toContain('observerQuoteFeeds.subscribe(ws')
    expect(bridgeWs).toContain('browser_market_view:canUseDefaultPlatformMarketSource(user)')
    expect(app).toContain('sendHeartbeat();')
  })

  it('uses an icon included in the local Lucide bundle for position protection editing', () => {
    expect(app).toContain('data-lucide="pencil" size="13"')
    expect(app).not.toContain('data-lucide="shield-pen"')
  })

  it('uses the connected bridge platform in status and terminal-time labels', () => {
    expect(html).toContain('id="bridgePlatformClockLabel"')
    expect(html).toContain('id="bridgePlatformTimeLabel"')
    expect(app).toContain('function updateBridgePlatformUI(value)')
    expect(app).toContain('[data-bridge-platform-template]')
    expect(html).toContain('data-bridge-platform-template="生成时间（{platform}）"')
    expect(html).toContain('data-bridge-platform-template="实时读取 {platform}"')
    expect(html).toContain('data-bridge-platform-template="开仓时间（{platform}）"')
    expect(html).toContain('data-bridge-platform-template="时间（{platform}）"')
    expect(html).toContain('data-bridge-platform-template="最近判断（{platform}）"')
    expect(html).toContain('data-bridge-platform-template="按 {platform} 时间追踪 AI 与手动操作、风控结果和原始原因。"')
    expect(html).toContain('下载桥接客户端，双击运行后选择 MT4 或 MT5。')
    expect(app).toContain('if (msg.platform) updateBridgePlatformUI(msg.platform)')
    expect(app).toContain('if (gateway.platform) updateBridgePlatformUI(gateway.platform)')
    expect(app).toContain('`${platform} 已连接`')
    expect(bridgeWs).toContain('terminal_instance_id:dataRoute?.terminal_instance_id || null')
    expect(bridgeWs).toContain('trading_account_id:Number(channel.trading_account_id) || null')
    expect(app).toContain('function syncManualOrderPlatformCapabilities()')
    expect(app).toContain('state.bridgePlatform === "mt4"')
    expect(css).toContain('.order-type-btn[hidden]')
  })

  it('renders automatic inference as an accessible live progress control', () => {
    expect(html).toContain('class="status-badge status-neutral clickable-badge auto-runtime-control"')
    expect(html).toContain('role="progressbar"')
    expect(app).toContain("msg.type === 'auto_progress'")
    expect(app).toContain('activeAutoProgressCycles')
    expect(app).toContain('autoProgressElapsed')
    expect(app).toContain('estimatedAutoProgress')
    expect(app).toContain('displayedAutoProgress')
    expect(css).toContain('.auto-runtime-control.is-progress')
    expect(css).toContain('transition: transform 900ms linear')
    expect(css).not.toContain('@keyframes auto-runtime-scan')
    expect(css).toContain('@media (prefers-reduced-motion: reduce)')
  })

  it('shows execution outcome before the independent risk-gate result', () => {
    expect(app).toContain('const executionStatus = row.status || "unknown"')
    expect(app).toContain('const riskStatus = row.decision_status || "unknown"')
    expect(app.indexOf('const executionStatus = row.status || "unknown"')).toBeLessThan(app.indexOf('const riskStatus = row.decision_status || "unknown"'))
    expect(app).toContain('MT5 拒绝挂单：挂单价格无效')
  })

  it('binds manual close and cancel commands to the state the user reviewed', () => {
    expect(app).toContain('pendingOrders: []')
    expect(app).toContain('function managementExpectedState(item, ticket, kind)')
    expect(app).toContain('broker_server_key: identity.brokerServerKey')
    expect(app).toContain('login_account: identity.loginAccount')
    expect(app).toContain('账户身份尚未加载，请刷新账户状态后重试')
    expect(app).toContain('expected_state: managementExpectedState(order, ticket, "pending")')
    expect(app).toContain('confirm: true')
    expect(app).toContain('expected_state: managementExpectedState(position, ticket, "position")')
    expect(app).toContain('挂单状态已变化，请刷新后重试')
    expect(app).toContain('持仓状态已变化，请刷新后重试')
    expect(bridgeWs).toContain("const cancelParams = { ticket, expected_state: params.expected_state }")
    expect(bridgeWs).toContain('expected_state:params.expected_state')
    expect(bridgeWs).toContain("'manual_cancel_pending'")
    expect(bridgeWs).toContain("message:'manual_confirmation_required'")
  })

  it('publishes recoverable, ordered progress for every inference stage', () => {
    for (const field of ['progress_percent', 'progress_seq', 'cycle_id', 'cycle_started_at', 'stage_updated_at']) {
      expect(scheduler).toContain(field)
    }
    for (const stage of ['config', 'bridge', 'market', 'ai', 'persist', 'publish', 'delivery', 'complete']) {
      expect(scheduler).toContain(`stage: '${stage}'`)
    }
    expect(scheduler).toContain('active_cycles: activeCycles')
    expect(scheduler).toContain("type: 'auto_progress_done'")
  })
  it('keeps platform chart ticks separate from private account quote state', () => {
    expect(bridgeWs).toContain("type: 'platform_market_tick'")
    expect(app).toContain("msg.type === 'platform_market_tick'")
    const platformTickBranch = app.slice(app.indexOf("msg.type === 'platform_market_tick'"), app.indexOf("msg.type === 'data'"))
    expect(platformTickBranch).toContain('updateKlineTick')
    expect(platformTickBranch).toContain('Number(quote.ask), quote')
    expect(platformTickBranch).not.toContain('state.lastQuote =')
  })

  it('updates the active bridge entry before synchronizing account identity', () => {
    expect(bridgeWs).toContain('const currentBridge = bridges.get(userId)')
    expect(bridgeWs).toContain('currentBridge.brokerServer = account.server')
    expect(bridgeWs).toContain('syncTradingAccountIdentity(userId, account)')
  })

  it('anchors overview live candles to MT5 quote time instead of creating weekend bars from the browser clock', () => {
    const tickStart = app.indexOf('function updateKlineTick')
    const tickEnd = app.indexOf('// Periodic refresh for higher timeframes', tickStart)
    const tickBlock = app.slice(tickStart, tickEnd)
    expect(tickBlock).toContain('mt5BrokerTimeSeconds(formatTerminalQuoteTime(quote))')
    expect(tickBlock).not.toContain('Date.now()')
    expect(app).toContain('updateKlineTick(q.bid, q.ask, q)')
    expect(app).toContain('updateKlineTick(data.bid, data.ask, data)')
  })

  it('provides the unified user and administrator information architecture', () => {
    for (const tab of ['model-strategy', 'trading', 'risk-center', 'history', 'audit', 'review-memory']) {
      expect(html).toContain(`data-tab="${tab}"`)
      expect(html).toContain(`id="${tab}"`)
    }
    expect(html).toContain('data-model-strategy-tab="strategies"')
    expect(html).toContain('data-model-strategy-tab="models"')
    expect(html).toContain('data-model-strategy-panel="strategies"')
    expect(html).toContain('data-model-strategy-panel="models"')
    expect(html).not.toContain('data-tab="model-management"')
    expect(html).not.toContain('data-tab="ai-config"')
    for (const tab of ['global-risk', 'model-compare', 'admin-dashboard']) {
      expect(html).not.toContain(`id="${tab}"`)
    }
    expect(html).toContain('href="/admin/?view=ai-operations"')
    expect(adminHtml).toContain('data-view="ai-operations"')
    expect(adminHtml).toContain('data-view="risk-audit"')
    expect(adminHtml).toContain('data-view="users"')
    expect(adminHtml).toContain('data-view="content-operations"')
    expect(adminHtml).toContain('data-view="system-settings"')
    expect(app).not.toContain('navGroupManage')
    expect(html).not.toContain('data-tab="account-review"')
    expect(html.indexOf('data-tab="model-strategy"')).toBeGreaterThan(html.indexOf('data-tab="risk-center"'))
    expect(html.indexOf('data-tab="model-strategy"')).toBeLessThan(html.indexOf('data-tab="review-memory"'))
  })

  it('restores the dedicated user-scoped system audit workspace', () => {
    expect(html.match(/data-tab="audit"/g)).toHaveLength(2)
    expect(html).toContain('<section id="audit" class="tab-panel">')
    expect(html).toContain('data-bridge-platform-template="时间（{platform}）"')
    expect(html).toContain('风控与执行记录')
    expect(app).toContain('wsApi("audit_logs")')
    expect(app).toContain('row?.created_at_mt5 || row?.created_at')
    expect(app).toContain('pagerButton.dataset.pager === "audit"')
    expect(bridgeWs).toContain("trade_audit_logs WHERE user_id = ?")
  })

  it('organizes the administrator operations center around health, actions, users, and releases', () => {
    expect(adminApp).toContain('统一运营视图')
    expect(adminApp).toContain('<h1>AI 运营</h1>')
    expect(adminApp).toContain('loadCommercialNotifications')
    expect(adminApp).toContain('/api/admin/membership-expiry-notifications?')
    expect(adminHtml).toContain('用户运营档案')
    expect(adminApp).toContain('saveUserProfile')
    expect(adminApp).toContain("method:'PATCH'")
    expect(adminCss).toContain('.admin-workspace')
    expect(adminCss).toContain('.user-table')
    expect(adminCss).toContain('.workspace-modal')
    expect(adminCss).toContain('@media (max-width:760px)')
    expect(app).not.toContain('renderAdminDashboard')
    expect(app).not.toContain('loadAdminMembershipNotifications')
    expect(bridgeWs).toContain('AS membership_expired')
    expect(bridgeWs).toContain('AS model_failures_today')
    expect(bridgeWs).toContain('AS reviews_pending')
    expect(bridgeWs).toContain('healthStats: healthStats || {}')
    expect(app).toContain("accessRes.access?.mode === 'blocked'")
    expect(app).toContain('renderMembershipAccessState')
    expect(bridgeWs).toContain('Number(oldStats?.old_today || 0) + Number(delivStats?.deliv_today || 0)')
    expect(bridgeWs).toContain("selectedSymbols.join('、') || null")
  })

  it('does not accept session credentials through the page URL', () => {
    const earlyAuth = html.slice(html.indexOf('(function()'), html.indexOf('</script>'))
    expect(earlyAuth).not.toContain("new URLSearchParams(window.location.search).get('token')")
    expect(app).not.toContain('searchParams.get("token")')
  })

  it('marks administrator controls and keeps private review and memory pages user-scoped', () => {
    expect(html).not.toContain('id="global-risk"')
    expect(adminHtml).toContain('data-view="risk-audit"')
    expect(adminApp).toContain('/api/admin/risk-audit/overview?')
    expect(html).not.toContain('id="account-review"')
    expect(app).toContain('api(`/api/ai/period-reviews${query}`)')
    expect(app).toContain('api("/api/ai/period-reviews/summary")')
    expect(app).toContain('/job-status`')
    expect(app).toContain('periodReviewProgressHtml')
    expect(html).toContain('id="reviewNavBadge"')
    expect(html).toContain('id="reviewNavFailureDot"')
    expect(app).toContain('api("/api/ai/memory")')
    expect(routes).toContain("WHERE id = ? AND user_id = ?")
    expect(app).toContain('Number(summary.daily_total || 0)')
    expect(app).toContain('Number(summary.monthly_total || 0)')
    expect(app).toContain('function periodReviewEvidenceReasonText(value)')
    expect(app).toContain('覆盖 ${versions.length} 个兼容策略版本')
    expect(app).not.toContain('当天策略升级，按版本分别复盘')
    expect(app).not.toContain('策略版本变化时不会跨版本注入')
    expect(app).toContain('class="review-case-metrics"')
    expect(css).toContain('#review-memory .review-case-button {')
    expect(css).toContain('.review-case-metrics {')
    expect(app).toContain('function memoryApplicabilityView(item = {})')
    expect(app).toContain('按当前品种、周期、方向、行情与缠论结构精确匹配')
    expect(app).toContain('renderCachedMemoryWorkspace();')
    expect(css).toContain('.memory-context-chip.avoid')
    expect(css).toContain('.personal-memory-archive')
  })

  it('uses cursor pagination and request versions to prevent stale inference list data', () => {
    expect(bridgeWs).toContain("params.before_id")
    expect(bridgeWs).toContain("WHERE t.id < ?")
    expect(app).toContain("_signalsListRequestVersion")
    expect(app).toContain("before_id:beforeId")
    expect(app).toContain("signals.filter(item => !known.has(String(item.id)))")
    expect(app).toContain("requestVersion !== _signalTableRequestVersion")
  })

  it('exposes explicit model source, shared credential and quota copy without storing a key in state', () => {
    expect(html).toContain('id="modelSourceNotice"')
    expect(html).toContain('id="sharedCredentialNotice"')
    expect(adminApp).toContain('id="platformDailyRequests"')
    expect(adminApp).toContain('id="platformDailyTokens"')
    expect(html).toContain('id="policyDailyRequests"')
    expect(app).toContain('async function savePlatformPolicy()')
    const stateBlock = app.slice(app.indexOf('const state = {'), app.indexOf('// ===== History Cache'))
    expect(stateBlock).not.toMatch(/^\s*(?:apiKey|api_key|credential)\s*:/mi)
    expect(html).not.toContain('id="apiKey"')
    expect(html).not.toContain('id="autoApiKey"')
    expect(app).not.toContain('$("apiKey")')
    expect(html).not.toContain('付费配对实验')
    expect(html).not.toContain('userPairedExperimentFlag')
    expect(app).not.toContain('paired_experiment_enabled')
  })

  it('keeps existing model providers editable while supporting custom compatible endpoints', () => {
    expect(html).toContain('<option value="kimi">Kimi 开放平台</option>')
    expect(html).toContain('<option value="kimi_code">Kimi Code 订阅</option>')
    expect(html).toContain('id="profileThinkingEnabled"')
    expect(html).toContain('<option value="openai_compatible">自定义 OpenAI 兼容</option>')
    expect(app).toContain("kimi_code: { models: ['kimi-for-coding', 'k3', 'kimi-for-coding-highspeed']")
    expect(app).not.toContain('Kimi Code 订阅也遵循相同设置')
    expect(html).not.toContain('platformSharingProviderNotice')
    expect(app).toContain('订阅模型 · 可按用途共享')
    expect(app).not.toContain('个人订阅 · 不共享')
    expect(app).toContain('thinking_enabled: $("profileThinkingEnabled").checked')
    expect(app).toContain("openai_compatible: { models: [], url: '' }")
  })

  it('shows user-editable price controls and separates AI, cap and final execution volume', () => {
    expect(app).toContain('max_execution_price_deviation_pct')
    expect(app).toContain('AI 建议')
    expect(app).toContain('风险上限')
    expect(app).toContain('最终')
    expect(html).toContain('id="executionDecisionPager"')
    expect(app).toContain('executionFilters: { page: 1, pageSize: 5')
    expect(app).toContain('pagerButton.dataset.pager === "executions"')
    expect(routes).toContain('page_size, 10) || 5')
  })

  it('states that user risk parameters take effect immediately without a cooldown queue', () => {
    expect(html).toContain('保存后立即生效')
    expect(app).toContain('所有修改保存后立即生效，并保留版本与审计记录。')
    expect(app).toContain('用户风控已立即生效')
    expect(app).not.toContain('放宽需经过冷却期')
    expect(app).not.toContain('放宽设置等待冷却生效')
    expect(routes).not.toContain("rpci.status = 'pending'")
  })

  it('provides account and platform kill switches without a recovery approval workflow', () => {
    expect(app).toContain('data-kill-switch=')
    expect(adminApp).toContain('data-global-stop')
    expect(adminApp).toContain("api('/api/admin/risk-audit/global-stop'")
    expect(adminRoutes).toContain("router.post('/admin/risk-audit/global-stop'")
    expect(html).not.toContain('id="globalKillSwitchBtn"')
    expect(html).not.toContain('id="adminRecoveryList"')
    expect(app).not.toContain('data-risk-recovery=')
    expect(app).not.toContain('data-recovery-review=')
    expect(routes).not.toContain("'/ai/admin/recoveries/:id/review'")
    expect(routes).not.toContain("'/ai/risk-center/:accountId/recovery'")
    expect(routes).toContain("'/ai/admin/risk-center/kill-switch'")
  })

  it('uses an explicit shared history scope and keeps the platform start server-owned', () => {
    expect(html).toContain('id="historyRangeMode"')
    expect(html).toContain('<option value="all">全账户历史</option>')
    expect(html).toContain('<option value="platform" selected>平台接入后</option>')
    expect(html).toContain('<option value="custom">自定义日期</option>')
    expect(app).toContain('history_scope: scope')
    expect(app.match(/\?\.value \|\| "platform"/g)?.length).toBeGreaterThanOrEqual(2)
    expect(app).toContain('从当前 ${bridgePlatformLabel()} 账户本次接入平台之日开始。')
    expect(app).toContain('MT4 历史范围取决于终端“账户历史”页已加载的时间范围')
    expect(app).toContain('} else if (tabId === "history") {\n    updateHistoryRangeUI();')
    expect(bridgeWs).toContain("AS platform_connected_date")
    expect(bridgeWs).toContain('FROM trading_accounts ta')
    expect(bridgeWs).toContain('ownership.started_at')
    expect(bridgeWs).not.toContain("DATE_FORMAT(created_at, '%Y-%m-%d') AS account_created_date")
    expect(html).not.toContain('id="filterCloseFrom"')
    expect(html).not.toContain('id="chartDateFrom"')
  })

  it('imports the database helper required by paginated execution decisions', () => {
    expect(routes).toContain("import { queryAll, queryOne, queryRun, withTransaction, beijingNow, logAudit } from '../../db.js'")
    expect(routes).toContain("queryOne('SELECT COUNT(*) AS total FROM order_intents")
  })

  it('lets administrators operate adjustable rule rollouts while forced rules stay disabled', () => {
    expect(adminApp).toContain('data-rollout-rule=')
    expect(adminApp).toContain('/api/ai/admin/risk-rule-rollouts/')
    expect(adminApp).toContain("Number(item.forced_enforce)?'disabled':''")
    expect(adminApp).toContain('正式执行')
    expect(adminApp).toContain('仅影子评估')
    expect(html).not.toContain('id="riskRuleRolloutList"')
  })

  it('uses exact review language and separates process issue from content confirmation', () => {
    expect(app).toContain('内容准确并加入记忆')
    expect(app).toContain('内容有问题，继续修改')
    expect(app).toContain('交易流程问题')
    expect(app).toContain('复盘内容确认')
  })

  it('separates strategy visibility, editing and execution permissions in the UI', () => {
    expect(html).toContain('你创建的私有策略仅自己可见、可选和执行')
    expect(app).toContain("const canSubscribe = item.scope === 'platform' || Number(item.owner_user_id) === Number(state.user?.id)")
    expect(app).toContain('仅审计可见')
    expect(html).toContain('id="strategyModelHelp"')
    expect(html).toContain('id="strategyScopeField"')
    expect(app).toContain('新建平台策略')
    expect(app).toContain("|| (item.scope === 'platform' && canManagePlatformAiContent())")
    expect(adminApp).not.toContain('data-ai-tab="strategies"')
    expect(adminApp).toContain('id="platformStrategyVisibility"')
    expect(adminApp).toContain("scope:'platform'")
    expect(adminRoutes).toContain("router.post('/admin/ai/strategies'")
    expect(app).toContain('renderStrategyModelOptions')
  })

  it('keeps platform strategy, model, review and memory management inside the AI lab', () => {
    expect(app).not.toContain('平台模型已迁移到统一管理后台')
    expect(app).not.toContain('平台复盘已迁移')
    expect(app).not.toContain('统一管理平台复盘与记忆')
    expect(app).toContain('api(`/api/ai/model-profiles${profileScopeQuery()}`)')
    expect(app).toContain('if (state.user?.role === "admin") body.scope = "platform"')
    expect(app).toContain('api("/api/ai/admin/platform-experience")')
    expect(app).toContain('renderPlatformExperience(state.memoryItems')
    expect(app).toContain('function isObserverSourceAccount()')
    expect(app).toContain('function canManagePlatformAiContent()')
    expect(html).toContain('id="platformExperiencePolicies"')
    expect(html).toContain('id="platformExperienceEvaluation"')
  })

  it('lets private strategy owners explicitly opt into position and pending-order context', () => {
    expect(html).toContain('id="strategyIncludePortfolioContext"')
    expect(html).toContain('仅适用于你的私有策略')
    expect(app).toContain('include_portfolio_context:scope === "private"')
    expect(app).toContain('item.include_portfolio_context')
  })

  it('settles model list and source requests independently with retryable errors', () => {
    expect(app).toContain('Promise.allSettled([')
    expect(app).toContain('data-action="retry-model-management"')
    expect(app).toContain('模型来源解析失败')
  })

  it('uses a distinct subscription action area and server-confirmed scheduler state after deletion', () => {
    expect(app).toContain('class="subscription-row-actions"')
    expect(app).toContain('data-subscription-action="edit"')
    expect(app).toContain('data-subscription-action="delete"')
    expect(app).toContain('>编辑订阅</button>')
    expect(app).toContain('platform_only: "平台统一经验"')
    expect(app).toContain('if (deleted.scheduler)')
    expect(app).toContain('renderAutoAnalyzeBadge(deleted.scheduler)')
  })

  it('limits inference experience usage to platform admins or private-strategy owners', () => {
    expect(app).toContain('if (source === "platform") return state.user?.role === "admin"')
    expect(app).toContain('state.user?.role !== "admin" && Number(signal?.user_id) === Number(state.user?.id)')
    expect(bridgeWs).toContain('restrictSignalExperienceUsage')
  })

  it('keeps checkbox labels inline and exposes subscription runtime scheduling', () => {
    for (const id of ['subscriptionExecutionEnabled','subscriptionScheduleEnabled','subscriptionScheduleTimezone','subscriptionOutsideWindowBehavior','subscriptionScheduleWindows']) {
      expect(html).toContain(`id="${id}"`)
    }
    expect(css).toContain('.check-row{display:flex;flex-direction:row')
    expect(css).toContain('.settings-grid label.check-row,.settings-grid label.multi-select-option{flex-direction:row')
    expect(css).toContain('.inline-check-card,.inline-check { display:flex; flex-direction:row')
    expect(app).toContain('replace_active:replaceActive')
    expect(app).toContain('selectedSubscriptionScheduleWindows()')
    expect(html).toContain('<option value="Etc/GMT-3">交易平台服务器时间（UTC+3）</option>')
    expect(html).toContain('北京时间（UTC+8）')
    expect(html).toContain('伦敦时间（UTC+0，夏令时 UTC+1）')
    expect(html).toContain('纽约时间（UTC-5，夏令时 UTC-4）')
    expect(app).toContain('const defaultScheduleTimezone = syncMt5ScheduleTimezoneOption();')
    expect(app).toContain('accountSubscription?.schedule_timezone || defaultScheduleTimezone')
    expect(app).toContain('return "Etc/GMT-3"')
  })

  it('uses platform-neutral account errors for MT4 and MT5 subscriptions', () => {
    expect(app).toContain('trading_account_not_active: "当前交易账户不是活动账户')
    expect(app).not.toContain('当前 MT5 账户不是活动账户')
  })

  it('uses one strategy control plane and removes the legacy manual preference editor', () => {
    expect(routes).toContain("router.get('/ai/inference-preferences', authMiddleware")
    expect(routes).toContain("router.put('/ai/inference-preferences', authMiddleware")
    expect(html).toContain('id="analyzeStrategy"')
    expect(html).toContain('id="manualAutoExecute"')
    expect(html).toContain('data-tab="ai-analyze" data-title="AI分析师"')
    expect(html).not.toContain('data-tab="signals"')
    expect(html).toContain('data-analyst-view="detail"')
    expect(html).toContain('data-analyst-view="records"')
    expect(html.match(/id="signalsBody"/g)).toHaveLength(1)
    expect(app).toContain('const legacySignalsTarget = tabId === "signals"')
    expect(app).toContain('function setAnalystView(target)')
    expect(html).not.toContain('id="strategyEnabled"')
    expect(adminApp).toContain('可见状态')
    expect(adminApp).toContain('不会进入运行链路')
    expect(html).toContain('id="subscriptionSymbolsDropdown"')
    expect(html).toContain('id="subscriptionSymbolOptions"')
    expect(html).not.toContain('id="subscriptionSymbols"')
    expect(html).toContain('data-strategy-entry-method="stop_limit"')
    expect(html).toContain('id="strategyUseChanAnalysis"')
    expect(html).toContain('启用缠论指标')
    expect(app).toContain('use_chan_analysis:$("strategyUseChanAnalysis").checked')
    expect(app).toContain('strategy_id:strategyId')
    expect(app).not.toContain('/api/ai/inference-preferences')
    expect(html).not.toContain('id="systemPrompt"')
    expect(html).not.toContain('id="klineCount"')
    expect(html).not.toContain('id="auto-config"')
    expect(html).not.toContain('id="promptTypeModal"')
    expect(app).not.toContain("wsApi('get_auto_config')")
    expect(app).not.toContain('wsApi("save_config"')
    expect(app).not.toContain('initAutoSymbolsSelector')
    expect(app).toContain('selectedSubscriptionSymbols()')
    expect(app).toContain('const available = (state.strategies || []).filter(canExecute)')
    expect(html).toContain('只显示当前可用于分析的策略')
  })

  it('opens strategy, subscription and model forms as accessible responsive modals', () => {
    for (const id of ['modelProfileEditor', 'strategyEditor', 'subscriptionEditor']) {
      expect(html).toContain(`id="${id}" class="form-modal hidden" role="dialog" aria-modal="true"`)
    }
    expect(css).toContain('.form-modal { position:fixed;')
    expect(css).toContain('.form-modal-dialog { width:min(100%,760px);')
    expect(css).toContain('max-height:100dvh; min-height:100dvh;')
    expect(app).toContain('function handleFormModalKeydown(event)')
    expect(app).toContain('if (event.key === "Escape")')
  })

  it('requires an authoritative impact preview and typed confirmation before deleting a strategy', () => {
    expect(html).toContain('id="genericConfirmClose"')
    expect(app).toContain('/delete-preview`')
    expect(app).toContain('requireText:preview.title')
    expect(app).toContain('confirm_title:preview.title')
    expect(app).toContain('confirm_version:preview.version')
    expect(app).toContain('expected_active_subscriptions:preview.active_subscription_count')
    expect(app).toContain('confirm_stop_subscriptions:true')
    expect(routes).toContain("router.get('/ai/strategies/:id/delete-preview', authMiddleware")
  })

  it('uses compact responsive risk layouts and Chinese rollout terminology', () => {
    expect(css).toContain('.strategy-editor-sections { display:grid; grid-template-columns:repeat(2,minmax(0,1fr))')
    expect(adminCss).toContain('.risk-policy-groups { display:grid; gap:10px; }')
    expect(adminCss).toContain('.risk-policy-toolbar { display:grid;')
    expect(adminCss).toContain('.risk-policy-toolbar { grid-template-columns:1fr; }')
    expect(adminApp).toContain('正式执行')
    expect(adminApp).toContain('仅影子评估')
    expect(adminApp).not.toContain('>Enforce</option>')
    expect(adminApp).not.toContain('>Shadow</option>')
    expect(html).not.toContain('id="globalRiskEditor"')
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

  it('runs administrator model comparison from immutable signal snapshots', () => {
    expect(adminApp).toContain('data-ai-tab="model-compare"')
    expect(adminApp).toContain("data_source:'snapshots'")
    expect(adminApp).toContain('snapshot_ids:[...compare.selected.keys()]')
    expect(adminApp).toContain('timezone_offset_minutes:180')
    expect(adminApp).toContain("api('/api/admin/ai/model-compare/jobs'")
    expect(html).not.toContain('id="modelCompareWorkspace"')
  })

  it('initializes dynamically rendered risk-center icons without requiring a tab switch', () => {
    const start = app.indexOf('async function loadRiskCenter(')
    const end = app.indexOf('async function loadExecutionDecisions()', start)
    const loadRiskCenter = app.slice(start, end)
    expect(loadRiskCenter).toContain('class="risk-status-icon"')
    expect(loadRiskCenter).toContain('renderExecutionDecisions(')
    expect(loadRiskCenter).toContain('initIcons();')
    expect(loadRiskCenter.indexOf('initIcons();')).toBeGreaterThan(loadRiskCenter.indexOf('class="risk-status-icon"'))
  })

  it('refreshes every account-scoped view after a live MT5 account switch', () => {
    expect(app).toContain("msg.type === 'account_switched'")
    expect(app).toContain("msg.type === 'account_transferred'")
    expect(bridgeWs).toContain("type: 'account_switched'")
    expect(bridgeWs).toContain("type: 'account_transferred'")
    expect(bridgeWs).toContain("previousBridge.ws.close(4004")
    const start = app.indexOf('async function handleAccountSwitched')
    const end = app.indexOf('async function handleAccountTransferred', start)
    const handler = app.slice(start, end)
    for (const loader of ['loadStatus()', 'loadSymbols()', 'loadAccount()', 'loadPositions()', 'loadStrategyCatalog()']) {
      expect(handler).toContain(loader)
    }
    expect(handler).toContain('clearAccountContextCaches()')
    expect(handler).toContain('refreshTabData(activeTabId())')
    expect(handler).not.toContain('loadHistory(), loadHistoryChart()')
  })

  it('opens subscription settings from the automatic-analysis status instead of toggling it directly', () => {
    expect(app).toContain('async function handleAutoSubscriptionClick()')
    expect(app).toContain('addEventListener("click", handleAutoSubscriptionClick)')
    expect(app).toContain('const subscriptions = (state.strategySubscriptions || []).filter(item => Number(item.trading_account_id) === Number(activeAccount?.id))')
    expect(app).toContain('state.autoRuntime?.prompt_type_id || state.autoConfig?.prompt_type_id')
    expect(app).toContain('openSubscriptionEditor(strategy, subscriptionForStrategyAccount(strategy.id, activeAccount?.id))')
    expect(app).toContain('setTab("model-strategy", { skipRefresh:true })')
    const handler = app.slice(app.indexOf('async function handleAutoSubscriptionClick()'), app.indexOf('async function loadSymbols()'))
    expect(handler).not.toContain("wsApi('toggle_auto')")
    expect(handler).not.toContain('请先连接您的 MT5 账户')
  })

  it('keeps strategy switching explicit and loads the matching account subscription', () => {
    expect(html).toContain('id="subscriptionStrategy"')
    expect(html).toContain('id="subscriptionStrategySummary"')
    expect(html).toContain('切换后会载入该策略在当前账户上的订阅配置。')
    expect(app).toContain('function handleSubscriptionStrategyChange()')
    expect(app).toContain('subscriptionForStrategyAccount(strategy.id, account.id)')
    expect(app).toContain('addEventListener("change", handleSubscriptionStrategyChange)')
    expect(app).toContain('strategy_id:strategyId')
  })

  it('refreshes personal data and removes the observer selector when a user bridge reconnects', () => {
    const start = app.indexOf('function syncAiAccess(access)')
    const end = app.indexOf('function apiErrorMessage', start)
    const accessSync = app.slice(start, end)
    expect(accessSync).toContain('previousMode === "observer" && access.mode !== "observer"')
    expect(accessSync).toContain('state.observerChannels = []')
    expect(accessSync).toContain('state.selectedObserverChannelId = null')
    expect(accessSync).toContain('renderObserverChannelControl()')
    expect(accessSync).toContain('schedulePersonalBridgeRefresh()')
    expect(accessSync).toContain('refreshAll().then(() => refreshTabData(activeTabId()))')
  })

  it('formats numeric MT terminal timestamps instead of exposing raw epoch values', () => {
    expect(app).toContain('const milliseconds = numeric > 10_000_000_000 ? numeric : numeric * 1000')
    expect(app).toContain('date.toISOString().replace("T", " ").slice(0, 19)')
  })

  it('binds subscriptions to the current bridge account instead of a historical account choice', () => {
    expect(html).toContain('<span>当前桥接账户</span>')
    expect(html).toContain('id="subscriptionAccount" disabled')
    expect(html).toContain('账户切换由桥接软件同步，无需在这里重复选择。')
    const accountResolver = app.slice(app.indexOf('function currentSubscriptionAccount'), app.indexOf('function selectableSubscriptionStrategies'))
    expect(accountResolver).toContain('Number(account.is_active) === 1')
    const editor = app.slice(app.indexOf('function hydrateSubscriptionEditor'), app.indexOf('function openSubscriptionEditor'))
    expect(editor).toContain('Number(subscription.trading_account_id) === Number(currentAccount.id)')
    expect(editor).toContain('String(currentAccount.id)')
    expect(editor).not.toContain('subscription?.trading_account_id ||')
  })

  it('waits for transient terminal symbol discovery before loading quotes and charts', () => {
    const bootstrapStart = app.indexOf('async function bootstrap()')
    const bootstrapEnd = app.indexOf('async function refreshAll()', bootstrapStart)
    const bootstrap = app.slice(bootstrapStart, bootstrapEnd)
    expect(bootstrap).toContain("setTab('dashboard', { skipRefresh:true })")
    expect(bootstrap.indexOf("setTab('dashboard', { skipRefresh:true })")).toBeLessThan(bootstrap.indexOf('await refreshAll()'))

    const refreshStart = app.indexOf('async function refreshAll()')
    const refreshEnd = app.indexOf('async function loadStatus()', refreshStart)
    const refresh = app.slice(refreshStart, refreshEnd)
    expect(refresh).toContain('if (_refreshAllPromise) return _refreshAllPromise')
    expect(refresh).toContain('_refreshAllPromise = withBusy(button')
    expect(refresh).toContain('_refreshAllPromise = null')
    expect(refresh.indexOf('loadStatus()')).toBeLessThan(refresh.indexOf('loadSymbolsWhenReady()'))
    expect(refresh.indexOf('loadSymbolsWhenReady()')).toBeLessThan(refresh.indexOf('refreshQuote()'))
    expect(refresh.indexOf('loadSymbolsWhenReady()')).toBeLessThan(refresh.indexOf('loadKlineData()'))

    const retryStart = app.indexOf('async function loadSymbolsWhenReady(')
    const retryEnd = app.indexOf('function startKlineVolumeRefreshTimer()', retryStart)
    const retry = app.slice(retryStart, retryEnd)
    expect(retry).toContain('attempts = 4')
    expect(retry).toContain('isTransientSymbolLoadError(error)')
    expect(retry).toContain('state._lastGatewayLive === true')
    expect(retry).toContain('setTimeout(resolve, baseDelayMs * attempt)')
  })

  it('shows risk units and hides retired observation and AI step settings', () => {
    expect(app).toContain('function riskUnit(meta = {})')
    expect(app).toContain('class="risk-input-with-unit"')
    const groups = app.slice(app.indexOf('const RISK_GROUPS'), app.indexOf('const RISK_SAFETY_LABELS'))
    expect(groups).not.toContain('observation_hours')
    expect(groups).not.toContain('ai_volume_step')
    expect(groups).not.toContain('max_notional_exposure_pct')
    expect(adminApp).toContain('平台值')
    expect(adminApp).toContain('用户最大值')
    expect(adminCss).toContain('.risk-policy-row')
  })

  it('shows one percentage execution-deviation setting and hides the retired split controls', () => {
    const groups = app.slice(app.indexOf('const RISK_GROUPS'), app.indexOf('const RISK_SAFETY_LABELS'))
    expect(groups).toContain('max_execution_price_deviation_pct')
    expect(groups).not.toContain('pending_price_deviation_pct')
    expect(groups).not.toContain('pending_price_deviation_atr')
    expect(groups).not.toContain('market_signal_drift_atr')
    expect(groups).not.toContain('broker_slippage_points')
  })

  it('carries a concrete pending-order cancellation reason through persistence and execution', () => {
    expect(app).toContain('execution?.details?.pending_action_reason || signal?.pending_action_reason')
    expect(scheduler).toContain("pending_action_reason:pendingActionReason")
    expect(scheduler).toContain("'ai_cancel_pending', symbol")
    expect(bridgeWs).toContain('execution.details?.pending_action_reason')
  })

  it('explains a below-minimum risk rejection with theoretical volume and account-currency loss', () => {
    expect(app).toContain('details.theoretical_volume')
    expect(app).toContain('最小 ${displayRiskNumber(details.minimum, 3)} 手预计止损亏损')
    expect(app).toContain('（均为账户货币），因此未执行')
  })

  it('removes the retired stop-distance, reward ratio, exposure and margin settings', () => {
    const groups = app.slice(app.indexOf('const RISK_GROUPS'), app.indexOf('const RISK_SAFETY_LABELS'))
    expect(groups).not.toContain('sl_atr_max')
    expect(groups).not.toContain('min_rr')
    expect(groups).not.toContain('max_directional_exposure_lots')
    expect(groups).not.toContain('min_margin_level_pct')
  })

  it('uses one searchable platform-risk matrix and protects unsaved changes', () => {
    expect(adminApp).not.toContain("riskOpenGroup:'account'")
    expect(adminApp).not.toContain('data-risk-policy-group=')
    expect(adminApp).toContain('riskPolicySearch')
    expect(adminApp).toContain('riskPolicyHasChanges')
    expect(adminApp).toContain('risk-policy-matrix')
    expect(adminCss).toContain('.risk-policy-console')
    expect(adminApp).toContain('保存后立即生效')
    expect(app).not.toContain('captureGlobalRiskEditorState')
  })

  it('preserves personal-risk expansion and drafts while refreshing, then reloads saved values', () => {
    expect(app).toContain('function captureUserRiskEditorState({ includeDrafts = true } = {})')
    expect(app).toContain('restoreUserRiskEditorState(ruleEditorState)')
    expect(app).toContain('data-risk-policy-group=')
    expect(app).toContain('preserveRuleDrafts = preserveRuleState')
    expect(app).toContain('captureUserRiskEditorState({ includeDrafts:preserveRuleDrafts })')
    expect(app).toContain('loadRiskCenter({ preserveRuleState:true, preserveRuleDrafts:false })')
    expect(app).toContain('updateUserRiskPreferencePreview(input)')
  })

  it('explains personal single-trade risk levels and confirms the first move above recommendation', () => {
    expect(app).toContain('function singleTradeRiskLevel(value, maximum = 100)')
    expect(app).toContain('标准（推荐）')
    expect(app).toContain('data-risk-preference-preview')
    expect(app).toContain('试探仓')
    expect(app).toContain('轻仓')
    expect(app).toContain('连续 10 次标准仓止损')
    expect(app).toContain('data-original-effective-risk')
    expect(app).toContain('originalRisk <= 1')
    expect(app).toContain('showConfirm("确认提高单笔风险"')
    expect(css).toContain('.risk-preference-preview')
    expect(css).toContain('.risk-group-level.high')
    expect(css).toContain('.risk-group-level.critical')
    expect(responsiveCss).toContain('.risk-tier-impact')
  })

  it('keeps the overview signal card focused on the current decision and execution summary', () => {
    const start = html.indexOf('id="signalCard"')
    const end = html.indexOf('class="card grid-area-positions"', start)
    const signalCard = html.slice(start, end)
    expect(signalCard).toContain('最新AI建议')
    expect(signalCard).toContain('data-tab-jump="ai-analyze"')
    expect(signalCard).toContain('class="signal-decision-panel"')
    expect(signalCard).toContain('class="signal-execution-strip"')
    expect(signalCard).toContain('id="sigActionHint"')
    expect(signalCard).toContain('id="signalMonitorFullscreen"')
    expect(signalCard).toContain('id="signalMonitorExit"')
    expect(signalCard).toContain('id="signalMonitorDetails"')
    expect(signalCard).toContain('实时同步')
    expect(signalCard).not.toContain('上次信号摘要')
    expect(signalCard).not.toContain('data-tab-jump="signals"')
    expect(css).toContain('.card-signal:is(:fullscreen, .is-signal-monitor) .signal-monitor-details')
    expect(app).toContain('AI 对当前行情的直接判断')
    expect(app).toContain('class="monitor-surface signal-monitor-order-card"')
    expect(app).toContain('最终结果以账户风控为准')
    expect(app).toContain('direction === "hold" ? null')
    expect(app).toContain('? "无需计算"')
    expect(app).toContain('"暂无推荐档位"')
    expect(app).toContain('setBackgroundIsolation(active)')
    expect(app).toContain('card.setAttribute("aria-modal", "true")')
    expect(app).toContain('Math.ceil(ttl - age)')
    expect(app).toContain('reliability\\s*(?:=|为|:|：)\\s*low')
    expect(app).toContain('reliability\\s*(?:为|:|：)?\\s*低')
    expect(app).not.toContain('相关条件尚未确认为相关条件尚未确认')
    expect(app).not.toContain('class="monitor-surface signal-monitor-execution')
    expect(css).toContain('grid-template-columns: minmax(0, 1.6fr) minmax(320px, .7fr)')
    expect(css).toContain('scrollbar-gutter: stable')
    expect(css).toContain('.signal-monitor-fallback-active .main')
    expect(css).toContain('overflow-y: auto')
    expect(css).toContain('.signal-monitor-narrative > div:last-child {\n  max-height: none;')
    expect(css).toContain('.grid-area-signal {\n  grid-area: signal;\n  align-self: start;')
    expect(css).toContain('@media (min-width: 1181px) {\n  .grid-area-signal {\n    align-self: stretch;')
    expect(css).toContain('flex: 0 0 clamp(208px, 20vh, 224px)')
    expect(css).toContain('height: clamp(208px, 20vh, 224px)')
    expect(css).not.toContain('.signal-generated-meta {\n  display: flex;\n  align-items: center;\n  justify-content: space-between;')
    expect(css).not.toContain('margin-top: auto;\n  padding-top: var(--space-2);')
    expect(css).toContain('@media (prefers-reduced-motion: reduce)')
  })

  it('prioritizes essential runtime state and beginner actions on the trading home page', () => {
    expect(html).toContain('class="topbar-primary-status" aria-label="核心运行状态"')
    expect(html).toContain('class="topbar-context-status" aria-label="行情环境"')
    expect(html.indexOf('id="gatewayMode"')).toBeLessThan(html.indexOf('id="autoAnalyzeMode"'))
    expect(html.indexOf('id="autoAnalyzeMode"')).toBeLessThan(html.indexOf('id="tradeMode"'))
    expect(html).toContain('class="dashboard-intro calm-page-header"')
    expect(html).toContain('账户安全与当前行动')
    expect(html).toContain('data-tab-jump="trading"')
    expect(css).toContain('.topbar-context-status .status-badge')
  })

  it('makes live-trading permission explicit, confirmed and keyboard accessible', () => {
    expect(html).toContain('<button id="gatewayMode" type="button"')
    expect(html).toContain('<button id="tradeMode" type="button"')
    expect(html).toContain('aria-pressed="false"')
    expect(app).toContain('function renderTradePermissionBadge(')
    expect(app).toContain('await showConfirm("开启真实交易发送"')
    expect(app).toContain('await showConfirm("关闭交易发送"')
    expect(app).toContain('["服务器风控", "每笔订单发送前强制校验"]')
    expect(css).toContain('.trade-permission-control.status-trade-active')
    expect(css).toContain('font-family: var(--font-ui)')
    expect(css).toContain('flex: 1 1 320px')
    expect(css).toContain('height: clamp(280px, 34vh, 380px)')
    expect(app).toContain('多周期方向证据不足')
    expect(app).toContain('线段结构尚不可靠')
    expect(app).not.toContain('return translated || "系统内部状态"')
  })

  it('keeps execution state concise without duplicating the internal safety chain', () => {
    expect(html).not.toContain('id="signalSafetyChain"')
    expect(html).toContain('id="signalAnnouncement"')
    expect(html).toContain('<div id="latestSignal" class="signal-body">')
    expect(app).not.toContain('function signalExecutionStages(signal)')
    expect(app).not.toContain('renderSignalSafetyChain(')
    expect(app).not.toContain('signal-monitor-safety')
    expect(app).not.toContain('analysis-safety-chain')
    expect(css).not.toContain('.signal-safety-stages')
  })

  it('uses progressive disclosure for secondary account data and uncommon chart periods', () => {
    expect(html).toContain('class="account-stats-row account-primary-stats"')
    expect(html).toContain('class="account-more-details"')
    expect(html).toContain('<summary>查看账户详情</summary>')
    expect(html).toContain('class="kline-more-periods"')
    expect(html).toContain('<summary>更多周期</summary>')
    expect(html).not.toContain('card card-gold grid-area-quote')
  })

  it('separates order management from manual trading and keeps the active strategy summary focused', () => {
    expect(html).toContain('data-workspace-tab="trading" data-workspace-target="orders"')
    expect(html).toContain('data-workspace-tab="trading" data-workspace-target="manual"')
    expect(html.match(/data-workspace-panel="trading" data-workspace-view="orders"/g)).toHaveLength(2)
    expect(html).toContain('class="card observer-action-panel workspace-subpanel trading-manual-panel"')
    expect(html).toContain('正在自动运行')
    expect(html).toContain('class="strategy-count-pair"')
    expect(css).toContain('.trading-workspace .trading-grid > .card[hidden]')
  })

  it('frames risk and review workspaces around the decisions users need to make', () => {
    expect(html).toContain('data-workspace-target="status"><i data-lucide="shield-check" size="15"></i>能否交易')
    expect(html).toContain('data-workspace-target="rules"><i data-lucide="sliders-horizontal" size="15"></i>我的限制')
    expect(html).toContain('data-workspace-target="decisions"><i data-lucide="list-checks" size="15"></i>风控记录')
    expect(html).toContain('class="insight-strip review-insight-strip"')
    expect(html).toContain('id="reviewJobInsight"')
    expect(html).toContain('进行中 / 失败')
    expect(html).toContain('data-workspace-target="reviews"><i data-lucide="calendar-check-2" size="15"></i>待处理复盘')
    expect(app).toContain('jobInsight.classList.toggle("danger", failed > 0)')
    expect(css).toContain('.review-insight-strip')
  })

  it('renders inference charts from the selected inference snapshot on demand', () => {
    expect(app).toContain('signal?.inference_snapshot')
    expect(app).toContain('仅展示推理发生时的数据')
    expect(app).toContain('data-inference-timeframe')
    for (const layer of ['segments', 'centers', 'divergence', 'entries', 'levels']) {
      expect(app).toContain(`["${layer}"`)
    }
    expect(app).toContain('signal_detail')
    expect(app).toContain('detail_loaded: true')
    expect(css).toContain('.inference-chart-panel:fullscreen')
    expect(css).toContain('.inference-chart-table')
    expect(css).toContain('.inference-kline-chart #tv-attr-logo')
    expect(app).toContain('attributionLogo: false')
    expect(app).toContain('inferenceStructureTime')
    expect(app).toContain('structure[`${edge}_broker_time`]')
    expect(bridgeWs).toContain('getInferenceVisualizationSnapshot(signalId)')
  })

  it('provides keyboard-operable landmarks, tabs and labelled form controls', () => {
    expect(html).toContain('class="skip-link" href="#aiMainContent"')
    expect(html).toContain('<main id="aiMainContent" class="main" tabindex="-1">')
    expect(html.match(/<main\b/g)).toHaveLength(1)
    expect(html).toContain('role="tab" aria-selected="true" tabindex="0" data-review-period=""')
    expect(html).toContain('role="tab" aria-selected="true" tabindex="0" data-review-filter=""')
    expect(html).toContain('aria-label="开仓开始日期"')
    expect(html).toContain('aria-label="交易方向"')
    expect(html).toContain('for="feedbackTitle"')
    expect(html).toContain('for="feedbackDesc"')
    expect(app).toContain('["ArrowLeft", "ArrowRight", "Home", "End"]')
    expect(app).toContain('button.tabIndex = active ? 0 : -1')
    expect(css).toContain('.skip-link:focus')
  })

  it('compresses large responses and suspends dashboard K-line polling off screen', () => {
    expect(serverIndex).toContain("import compression from 'compression'")
    expect(serverIndex).toContain('app.use(compression({ threshold: 1024 }))')
    expect(app).toContain('function stopKlineRefreshTimers()')
    expect(app).toContain("if (tabId !== \"dashboard\") stopKlineRefreshTimers()")
    expect(app).toContain("if (document.hidden || activeTabId() !== 'dashboard') return;")
    expect(app).toContain('startKlineVolumeRefreshTimer()')
  })

  it('keeps tablet status controls readable and mobile controls touchable', () => {
    expect(html).toContain('viewport-fit=cover')
    expect(css).toContain('@media (min-width: 761px) and (max-width: 1180px)')
    expect(css).toContain('grid-template-rows: 92px 1fr')
    expect(css).toContain('.topbar-badges .status-badge')
    expect(css).toContain('@media (pointer: coarse)')
    expect(css).toContain('min-height: 44px')
    expect(css).toContain('.auto-runtime-control.is-progress {\n    min-height: 44px;')
    expect(css).toContain('.kline-period-btn {\n    min-width: 44px;')
    expect(css).toContain('.account-card details > summary')
    expect(css).toContain('env(safe-area-inset-top)')
    expect(responsiveCss).toContain('background: color-mix(in srgb, var(--bg-input) 82%, transparent)')
    expect(css).toContain('--status-trading: #7dd3fc')
    expect(css).toContain('border-color: var(--status-trading-border)')
    expect(responsiveCss).toContain('var(--status-trading-bg) 72%')
    expect(responsiveCss).toContain('word-break: keep-all')
    expect(responsiveCss).toContain('writing-mode: horizontal-tb')
  })

  it('uses adaptive navigation instead of horizontally scrolling the desktop sidebar on phones', () => {
    expect(html).toContain('class="mobile-bottom-nav" aria-label="手机主导航"')
    expect(html).toContain('id="mobileNavMoreBtn"')
    expect(html).toContain('id="mobileNavDrawer"')
    expect(app).toContain('function openMobileNav()')
    expect(app).toContain('function closeMobileNav(')
    expect(app).toContain('handleMobileNavKeydown')
    expect(app).toContain('const mobilePrimaryTabs = new Set(["dashboard", "ai-analyze", "trading", "risk-center"])')
    expect(app).toMatch(/function setTab[\s\S]*?mobileMoreActive[\s\S]*?document\.querySelectorAll\("\.tab-panel"\)/)
    expect(app).not.toMatch(/function setObserverPanelLock[\s\S]*?mobileMoreActive/)
    expect(responsiveCss).toContain('@media (max-width: 767px)')
    expect(responsiveCss).toContain('grid-template-columns: repeat(auto-fit, minmax(56px, 1fr))')
    expect(responsiveCss).toContain('padding-bottom: var(--safe-bottom)')
    expect(responsiveCss).toContain('min-height: 100dvh')
  })

  it('keeps the latest decision first and removes nested scrolling on narrow screens', () => {
    expect(responsiveCss).toContain('grid-template-areas:\n      "signal"\n      "account"\n      "quote"\n      "positions"')
    expect(responsiveCss).toContain('grid-template-columns: minmax(0, 1fr) 64px minmax(0, 1fr)')
    expect(responsiveCss).toContain('.analysis-history-panel .analysis-history-list {\n    max-height: none;\n    overflow: visible;')
    expect(responsiveCss).toContain('height: 100dvh')
    expect(responsiveCss).toContain('env(safe-area-inset-bottom)')
    expect(responsiveCss).toContain('.analyst-records-card .data-table {\n    min-width: 860px;')
  })

  it('turns complex trading and review flows into mobile-native views', () => {
    expect(app).toContain('data-label="浮动盈亏"')
    expect(app).toContain('data-label="挂单价"')
    expect(app).toContain('data-review-action="back-list"')
    expect(app).toContain('reviewLayout?.classList.add("has-mobile-detail")')
    expect(app).toContain('reviewLayout?.classList.remove("has-mobile-detail")')
    expect(responsiveCss).toContain('#trading [data-workspace-view="orders"] .data-table tr {')
    expect(responsiveCss).toContain('content: attr(data-label)')
    expect(responsiveCss).toContain('.period-review-layout.has-mobile-detail .review-queue')
    expect(responsiveCss).toContain('.period-review-layout:not(.has-mobile-detail) .review-detail')
    expect(responsiveCss).toContain('bottom: calc(var(--mobile-nav-height) + var(--safe-bottom))')
  })

  it('keeps data-heavy history and the unified administrator workbench usable on phones', () => {
    expect(app).toContain('data-label="收益率"')
    expect(responsiveCss).toContain('#history .data-table tr:not(.empty-row)')
    expect(adminCss).toContain('@media (max-width:760px)')
    expect(adminCss).toContain('.user-modal { width:100%; max-height:100dvh; height:100dvh;')
    expect(adminCss).toContain('.workspace-modal { width:100%; max-height:100dvh; height:100dvh;')
    expect(adminCss).toContain('.compare-workspace { grid-template-columns:1fr; }')
    expect(adminCss).toContain('.observer-source-row { align-items:flex-start; flex-direction:column; }')
    expect(css).toContain('.audit-table { min-width: 860px; }')
  })

  it('uses a readable product type scale across the core AI workspaces', () => {
    for (const token of ['--type-caption', '--type-body', '--type-section', '--type-page']) {
      expect(css).toContain(token)
    }
    expect(css).toContain('.topbar-time span:last-child')
    expect(css).toContain('#review-memory .review-case-metrics strong')
    expect(css).toContain('#model-compare .compare-method-note p')
    expect(css).toContain('max-width: 72ch')
  })

  it('uses restrained branded scrollbars, removes decorative side strips and keeps progress transform-based', () => {
    expect(css).toContain('--scrollbar-thumb: #334155')
    expect(css).toContain('*::-webkit-scrollbar {')
    expect(css).toContain('scrollbar-color: var(--scrollbar-thumb) var(--scrollbar-track)')
    expect(css).toContain('*::-webkit-scrollbar-thumb:hover')
    expect(css).toContain('.strategy-card::before {\n  display: none;')
    expect(css).toContain("transform: scaleX(var(--auto-progress-scale))")
    expect(css).not.toContain("transform:scaleX(var(--compare-progress-scale,0))")
    expect(adminCss).toContain('.job-progress')
    expect(app).toContain(".replace(/^\\s*>\\s?/gm, \"\")")
    expect(app).toContain("--signal-confidence-scale")
  })
})

describe('take-profit execution clarity', () => {
  it('exposes subscription exit preference and separates the executed target from AI candidates', () => {
    expect(html).toContain('id="subscriptionTakeProfitMode"')
    expect(html).toContain('value="ai_recommended"')
    expect(app).toContain('signalTakeProfitSelection')
    expect(app).toContain('实际执行止盈')
    expect(app).toContain('止盈候选')
  })
})

describe('subscription schedule modal layout', () => {
  it('keeps long schedule content inside the viewport with sticky actions', () => {
    expect(css).toContain('.subscription-editor-dialog {')
    expect(css).toContain('overflow-y:auto')
    expect(css).not.toContain('.subscription-editor-dialog { width:min(100%,680px); overflow:visible; }')
    expect(css).toContain('.form-modal-actions { position:sticky')
    expect(app).toContain('scrollIntoView({')
    expect(app).toContain('prefers-reduced-motion: reduce')
  })
})

describe('route permissions and credential redaction', () => {
  it('uses an accessible custom observer channel switcher instead of a native select', () => {
    expect(html).toContain('id="observerChannelTrigger"')
    expect(html).toContain('id="observerChannelMenu"')
    expect(html).toContain('aria-haspopup="listbox"')
    expect(html).toContain('role="listbox"')
    expect(html).not.toContain('id="observerChannelSelect"')
    expect(css).toContain('.observer-channel-trigger {')
    expect(css).toContain('.observer-channel-menu {')
    expect(css).toContain('.observer-channel-option.is-selected')
    expect(app).toContain('setObserverChannelMenuOpen')
    expect(app).toContain('data-observer-channel-id')
    expect(app).toContain('aria-selected=')
    expect(responsiveCss).toContain('grid-row: 3')
    expect(responsiveCss).toContain('.observer-channel-trigger {')
    expect(responsiveCss).toContain('min-height: 48px')
  })

  it('gives administrators a responsive observer source and channel workspace', () => {
    expect(adminApp).toContain('data-ai-tab="observer"')
    expect(adminApp).toContain("api('/api/admin/ai/observer-candidates')")
    expect(adminApp).toContain("api('/api/admin/ai/observer-source-accounts'")
    expect(adminApp).toContain('id="observerSourceEditor"')
    expect(adminApp).toContain('id="observerChannelEditor"')
    expect(adminApp).toContain('id="observerSourceAccountEditor"')
    expect(adminCss).toContain('.observer-admin-grid')
    expect(adminCss).toContain('.observer-admin-grid { grid-template-columns:1fr; }')
    expect(adminRoutes).toContain("router.get('/admin/ai/observer-candidates'")
    expect(adminRoutes).toContain("router.post('/admin/ai/observer-source-accounts'")
    expect(html).not.toContain('id="observerSourceAccountEditor"')
  })

  it('lets administrators control observer-source inference and trade sending independently', () => {
    expect(adminApp).toContain('data-source-toggle="auto"')
    expect(adminApp).toContain('data-source-toggle="trade"')
    expect(adminApp).toContain('自动分析')
    expect(adminApp).toContain('交易发送')
    expect(adminApp).toContain("/runtime`, { method:'PATCH'")
    expect(adminRoutes).toContain("router.patch('/admin/ai/observer-sources/:id/runtime'")
    expect(scheduler).toContain('observer_source.status = \'active\'')
    expect(scheduler).toContain('COALESCE(observer_scheduler.enabled, 0) = 0')
  })

  it('presents observer routing as a progressive and responsive administration workflow', () => {
    expect(adminApp).toContain('管理来源账号、固定策略和运行控制。')
    expect(adminApp).toContain('管理默认频道、开放范围与对应来源。')
    expect(adminApp).toContain('data-new-observer-source')
    expect(adminApp).toContain('data-new-observer-channel')
    expect(adminApp).toContain('data-create-observer-account')
    expect(adminCss).toContain('@media (max-width:420px)')
    expect(adminCss).toContain('.observer-source-row { align-items:flex-start; flex-direction:column; }')
  })

  it('returns the account metrics rendered by the risk-center status card', () => {
    const start = routes.indexOf("router.get('/ai/risk-center', authMiddleware")
    const end = routes.indexOf("router.post('/ai/risk-center/refresh'", start)
    const route = routes.slice(start, end)
    expect(route).toContain('drawdown_pct')
    expect(route).toContain('consecutive_losses')
  })

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

  it('keeps automatic inference status user-owned and clears runtime state after the final subscription', () => {
    const autoStatus = bridgeWs.slice(bridgeWs.indexOf("case 'auto_status':"), bridgeWs.indexOf("case 'toggle_auto':"))
    expect(autoStatus).toContain('getUserAutoRuntimeStatus(userId)')
    expect(autoStatus).not.toContain('getAdminUserId')
    expect(routes).toContain('if (!scheduler.enabled) await removeUserRuntimeAutoSubscription(req.user.id)')
    expect(routes).toContain('res.json({ ok:true, scheduler, runtime_sync })')
  })

  it('uses subscription state for the automatic-analysis badge and bypasses AI risk for manual orders', () => {
    const manualOpen = bridgeWs.slice(bridgeWs.indexOf("case 'open':"), bridgeWs.indexOf("case 'close':"))
    expect(manualOpen).toContain('executeManualOrderCore')
    expect(manualOpen).not.toContain('executeOrderCore')
    expect(routes).toContain('executeOrderCore, executeManualOrderCore')
    expect(bridgeWs).toContain("return { ...data, type:'result', command_id:commandId }")
    expect(app).toContain('await wsApi("open", order.payload, 30000)')
    expect(app).toContain('mt4_error_4112: "MT4 交易服务器已禁止该账户使用 EA 自动交易')
    expect(app).toContain('gateway.program_trade_allowed === false')
    expect(app).toContain('`${returnPlatform} 返回码 ${retcode}`')
    expect(app).not.toContain('`MT5 返回码 ${retcode}`')
    expect(app).toContain('localizeReason(result.error) || localizeReason(result.message)')
    expect(bridgeWs).toContain('activeSubscriptions.length === 0')
    expect(bridgeWs).toContain('await readAutomaticAnalysisEnabled(userId)')
    const heartbeatHandler = app.slice(app.indexOf('function handleHeartbeat(msg)'), app.indexOf('function handleDisconnect(msg)'))
    expect(heartbeatHandler).not.toContain('state.autoEnabled = msg.auto_reasoning_enabled')
    expect(app).toContain('if (requestGeneration !== _loadStatusGeneration) return;')
    expect(app).toContain('Number(subscription?.execution_enabled) === 1')
    expect(app).not.toContain('volume > 0.05')
    expect(app).not.toContain('submit.disabled = Number(meta.marginShortfall)')
    expect(html).not.toContain('id="tradeVolume" class="num" type="number" value="0.01" min="0.01" max="0.05"')
    expect(app).toContain('const TRADE_STATE_RETRY_DELAYS_MS = [500, 1200, 2500, 4500]')
    expect(app).toContain('function queueTradeStateRefresh(options)')
    expect(app).toContain('queueTradeStateRefresh({ kind: "pending", ticket, expectPresent: false })')
    expect(app).toContain('queueTradeStateRefresh({ kind: "position", ticket, expectPresent: false })')
  })

  it('preserves merged position-protection progress in visual and accessible state', () => {
    expect(app).toContain('progress.value = Number(mergedJob.progress_percent || 0)')
    expect(app).toContain('progress.setAttribute("aria-valuenow", String(Number(mergedJob.progress_percent || 0)))')
  })

  it('refreshes incomplete risk snapshots on bridge identity recovery and labels historical accounts', () => {
    expect(bridgeWs).toContain('queueIncompleteRiskSnapshotRefresh(userId, ai)')
    expect(routes).toContain("export { refreshIncompleteRiskAccounts } from './risk-snapshot-refresh.js'")
    expect(adminApp).toContain("transferred:{ label:'已转移'")
    expect(adminApp).toContain("switched:{ label:'已切换'")
    expect(adminApp).toContain("String(account.observe_status || '').toLowerCase()")
  })

  it('fails closed when no observer channel is authorized and scopes signals to the bound strategy', () => {
    expect(bridgeWs).toContain('return { bridgeUserId:null, channel:null }')
    expect(bridgeWs).not.toContain('return { bridgeUserId:await getActivePlatformBridgeUserId(), channel:null }')
    expect(bridgeWs).toContain('const observerStrategyId = access.mode === \'observer\'')
    expect(bridgeWs).toContain("observerStrategyId ? 'AND d.prompt_type_id = ?' : ''")
    expect(routes).toContain('strategy_id:Number(observerSource.strategy_id)')
    expect(bridgeWs).not.toContain('_admin_override')
    expect(bridgeWs).not.toContain('Fallback: try admin bridge')
    expect(bridgeWs).not.toContain('Fall back to admin bridge for read operations')
  })

  it('keeps transient bootstrap failures signed in and removes browser JWTs from websocket URLs', () => {
    expect(app).toContain('error?.name === "ApiError" && Number(error.status) === 401')
    expect(app).toContain('renderBootstrapError(error)')
    expect(app).toContain('/aurum-api/bridge/ws?type=browser`')
    expect(app).not.toContain('type=browser&token=')
    expect(app).toContain('window.AuthSession?.syncCookie()')
    expect(bridgeWs).toContain("readCookie(req, 'ws_token')")
    expect(bridgeWs).toContain('Browser websocket auth failed: ws_token cookie missing')
  })

  it('maps unexpected API failures to a generic incident instead of returning raw errors', () => {
    expect(routes).toContain("error:'ai_internal_error', incident_id:incidentId")
    expect(routes).not.toContain("return res.status(status).json({ ok: false, error: String(error?.message")
  })

  it('returns sanitized profiles and never serializes encrypted or plaintext credentials', () => {
    expect(routes).toContain('credential_fields_redacted: true')
    expect(profiles).toContain('delete out.api_key_encrypted')
    expect(profiles).toContain("out.masked_api_key = out.has_api_key ? '****' : null")
    expect(routes).toContain("router.get('/ai/model-source'")
    expect(routes).not.toContain('api_key_encrypted: resolved.model.api_key_encrypted')
  })

  it('audits sensitive AI control-plane mutations without recording model secrets', () => {
    for (const action of [
      'observer_source_created', 'ai_model_profile_created', 'ai_model_profile_updated',
      'ai_strategy_created', 'trading_account_updated', 'ai_strategy_subscription_updated',
    ]) expect(routes).toContain(action)
    expect(routes).toContain('credential_rotated:Boolean(req.body?.api_key)')
    expect(routes).not.toContain('detail:JSON.stringify(req.body)')
  })
})
