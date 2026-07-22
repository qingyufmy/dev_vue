import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'

const html = readFileSync(new URL('../../public/ai/index.html', import.meta.url), 'utf8')
const app = readFileSync(new URL('../../public/ai/app.js', import.meta.url), 'utf8')
const css = readFileSync(new URL('../../public/ai/styles.css', import.meta.url), 'utf8')
const routes = readFileSync(new URL('../../server/routes/ai/index.js', import.meta.url), 'utf8')
const bridgeWs = readFileSync(new URL('../../server/bridge-ws.js', import.meta.url), 'utf8')
const profiles = readFileSync(new URL('../../server/routes/ai/model-profiles.js', import.meta.url), 'utf8')
const scheduler = readFileSync(new URL('../../server/routes/ai/scheduler.js', import.meta.url), 'utf8')
const serverIndex = readFileSync(new URL('../../server/index.js', import.meta.url), 'utf8')

describe('AI governance navigation and DOM contract', () => {
  it('renders automatic inference as an accessible live progress control', () => {
    expect(html).toContain('class="status-badge status-neutral clickable-badge auto-runtime-control"')
    expect(html).toContain('role="progressbar"')
    expect(app).toContain("msg.type === 'auto_progress'")
    expect(app).toContain('activeAutoProgressCycles')
    expect(app).toContain('autoProgressElapsed')
    expect(app).toContain('estimatedAutoProgress')
    expect(app).toContain('displayedAutoProgress')
    expect(css).toContain('.auto-runtime-control.is-progress')
    expect(css).toContain('transition: width 900ms linear')
    expect(css).not.toContain('@keyframes auto-runtime-scan')
    expect(css).toContain('@media (prefers-reduced-motion: reduce)')
  })

  it('shows execution outcome before the independent risk-gate result', () => {
    expect(app).toContain('const executionStatus = row.status || "unknown"')
    expect(app).toContain('const riskStatus = row.decision_status || "unknown"')
    expect(app.indexOf('const executionStatus = row.status || "unknown"')).toBeLessThan(app.indexOf('const riskStatus = row.decision_status || "unknown"'))
    expect(app).toContain('MT5 拒绝挂单：挂单价格无效')
  })

  it('publishes recoverable, ordered progress for every inference stage', () => {
    for (const field of ['progress_percent', 'progress_seq', 'cycle_id', 'cycle_started_at', 'stage_updated_at']) {
      expect(scheduler).toContain(field)
    }
    for (const stage of ['config', 'bridge', 'market', 'ai', 'persist', 'publish', 'delivery', 'verify', 'complete']) {
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
    expect(tickBlock).toContain('mt5BrokerTimeSeconds(quote?.time)')
    expect(tickBlock).not.toContain('Date.now()')
    expect(app).toContain('updateKlineTick(q.bid, q.ask, q)')
    expect(app).toContain('updateKlineTick(data.bid, data.ask, data)')
  })

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
    expect(html.indexOf('data-tab="model-strategy"')).toBeGreaterThan(html.indexOf('data-tab="risk-center"'))
    expect(html.indexOf('data-tab="model-strategy"')).toBeLessThan(html.indexOf('data-tab="review-memory"'))
  })

  it('organizes the administrator operations center around health, actions, users, and releases', () => {
    expect(app).toContain("data-admin-view=\"overview\"")
    expect(app).toContain("data-admin-view=\"users\"")
    expect(app).toContain("data-admin-view=\"release\"")
    expect(app).toContain('adminOperationalSummary')
    expect(app).toContain('renderAdminAttention')
    expect(app).toContain('opsHealthSummary')
    expect(app).toContain('今日模型消耗')
    expect(app).not.toContain('id="adChartSignalType"')
    expect(css).toContain('.ops-health-layout')
    expect(css).toContain('.ops-attention-list')
    expect(css).toContain('.ops-user-table')
    expect(bridgeWs).toContain('AS model_failures_today')
    expect(bridgeWs).toContain('AS reviews_pending')
    expect(bridgeWs).toContain('healthStats: healthStats || {}')
    expect(bridgeWs).toContain('Number(oldStats?.old_today || 0) + Number(delivStats?.deliv_today || 0)')
    expect(bridgeWs).toContain("selectedSymbols.join('、') || null")
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
    expect(html).toContain('id="policyDailyRequests"')
    const stateBlock = app.slice(app.indexOf('const state = {'), app.indexOf('// ===== History Cache'))
    expect(stateBlock).not.toMatch(/^\s*(?:apiKey|api_key|credential)\s*:/mi)
    expect(html).not.toContain('id="apiKey"')
    expect(html).not.toContain('id="autoApiKey"')
    expect(app).not.toContain('$("apiKey")')
    expect(html).toContain('付费配对实验（额外一次调用）')
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
    expect(html).toContain('id="globalKillSwitchBtn"')
    expect(app).toContain('data-kill-switch=')
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
    expect(app).toContain('从当前会员账户在平台注册之日开始。')
    expect(bridgeWs).toContain("DATE_FORMAT(created_at, '%Y-%m-%d') AS account_created_date")
    expect(bridgeWs).toContain('FROM users WHERE id = ? LIMIT 1')
    expect(bridgeWs).not.toContain('AS first_verified_date')
    expect(html).not.toContain('id="filterCloseFrom"')
    expect(html).not.toContain('id="chartDateFrom"')
  })

  it('imports the database helper required by paginated execution decisions', () => {
    expect(routes).toContain("import { queryAll, queryOne, queryRun, withTransaction, beijingNow } from '../../db.js'")
    expect(routes).toContain("queryOne('SELECT COUNT(*) AS total FROM order_intents")
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
    expect(html).toContain('id="strategyScopeField" class="admin-only is-readonly"')
    expect(html).toContain('id="strategyScope" value="platform" readonly')
    expect(html).toContain('你创建的私有策略仅自己可见、可选和执行')
    expect(app).toContain("const canSubscribe = item.scope === 'platform' || Number(item.owner_user_id) === Number(state.user?.id)")
    expect(app).toContain('仅审计可见')
    expect(html).toContain('id="strategyScopeHelp"')
    expect(html).toContain('id="strategyModelHelp"')
    expect(app).toContain('管理员只维护平台策略')
    expect(app).toContain('renderStrategyModelOptions')
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
    expect(html).toContain('<option value="Etc/GMT-3">MT5 服务器时间（UTC+3）</option>')
    expect(html).toContain('北京时间（UTC+8）')
    expect(html).toContain('伦敦时间（UTC+0，夏令时 UTC+1）')
    expect(html).toContain('纽约时间（UTC-5，夏令时 UTC-4）')
    expect(app).toContain('const defaultScheduleTimezone = syncMt5ScheduleTimezoneOption();')
    expect(app).toContain('subscription?.schedule_timezone || defaultScheduleTimezone')
    expect(app).toContain('return "Etc/GMT-3"')
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
    expect(html).toContain('可见状态同时控制策略是否可用于手动和自动分析')
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
    expect(css).toContain('.global-risk-groups { display:flex; flex-direction:column; gap:12px; }')
    expect(css).toContain('.global-risk-group { width:100%;')
    expect(css).toContain('.risk-rollout-list { display:grid; grid-template-columns:repeat(2,minmax(0,1fr))')
    expect(html).toContain('正式拦截')
    expect(html).toContain('仅观察')
    expect(app).toContain('策略与账户归属校验')
    expect(app).toContain('仅观察，不拦截')
    expect(app).not.toContain('>Enforce</option>')
    expect(app).not.toContain('>Shadow</option>')
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

  it('sends model comparison ranges as timezone-qualified MT5 instants', () => {
    expect(html).toContain('开始时间（MT5）')
    expect(html).toContain('结束时间（MT5）')
    expect(app).toContain('function compareWallTimeToUtcIso(value)')
    expect(app).toContain('Number(state.mt5TimezoneOffsetMinutes)')
    expect(app).toContain('const startTime = compareWallTimeToUtcIso')
    expect(app).toContain('const endTime = compareWallTimeToUtcIso')
    expect(app).toContain('timezone_offset_minutes:Number.isFinite(Number(state.mt5TimezoneOffsetMinutes))')
  })

  it('initializes dynamically rendered risk-center icons without requiring a tab switch', () => {
    const start = app.indexOf('async function loadRiskCenter()')
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
    for (const loader of ['loadStatus()', 'loadSymbols()', 'loadAccount()', 'loadPositions()']) {
      expect(handler).toContain(loader)
    }
    expect(handler).toContain('clearAccountContextCaches()')
    expect(handler).toContain('refreshTabData(activeTabId())')
    expect(handler).not.toContain('loadHistory(), loadHistoryChart()')
  })

  it('shows risk units and hides retired observation and AI step settings', () => {
    expect(app).toContain('function riskUnit(meta = {})')
    expect(app).toContain('class="risk-input-with-unit"')
    const groups = app.slice(app.indexOf('const RISK_GROUPS'), app.indexOf('const RISK_SAFETY_LABELS'))
    expect(groups).not.toContain('observation_hours')
    expect(groups).not.toContain('ai_volume_step')
    expect(groups).not.toContain('max_notional_exposure_pct')
    expect(css).toContain('.risk-default-pill')
  })

  it('shows one percentage execution-deviation setting and hides the retired split controls', () => {
    const groups = app.slice(app.indexOf('const RISK_GROUPS'), app.indexOf('const RISK_SAFETY_LABELS'))
    expect(groups).toContain('max_execution_price_deviation_pct')
    expect(groups).not.toContain('pending_price_deviation_pct')
    expect(groups).not.toContain('pending_price_deviation_atr')
    expect(groups).not.toContain('market_signal_drift_atr')
    expect(groups).not.toContain('broker_slippage_points')
  })

  it('removes the retired stop-distance, reward ratio, exposure and margin settings', () => {
    const groups = app.slice(app.indexOf('const RISK_GROUPS'), app.indexOf('const RISK_SAFETY_LABELS'))
    expect(groups).not.toContain('sl_atr_max')
    expect(groups).not.toContain('min_rr')
    expect(groups).not.toContain('max_directional_exposure_lots')
    expect(groups).not.toContain('min_margin_level_pct')
  })

  it('preserves global-risk expansion and draft values across background refreshes', () => {
    expect(app).toContain('function captureGlobalRiskEditorState({ includeDrafts = true } = {})')
    expect(app).toContain('restoreGlobalRiskEditorState(editorState)')
    expect(app).toContain('data-global-risk-group=')
    expect(app).toContain('data-global-risk-key=')
    expect(app).toContain('同时作为继承值的平台上限')
    expect(app).toContain('preserveEditorDrafts = preserveEditorState')
    expect(app).toContain('captureGlobalRiskEditorState({ includeDrafts:preserveEditorDrafts })')
    expect(app).toContain('loadAdminRiskCenter({ preserveEditorState:true, preserveEditorDrafts:false })')
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

  it('shows an explicit AI to risk to MT5 chain without a noisy live region', () => {
    expect(html).toContain('id="signalSafetyChain"')
    expect(html).toContain('id="signalAnnouncement"')
    expect(html).toContain('<div id="latestSignal" class="signal-body">')
    expect(app).toContain('function signalExecutionStages(signal)')
    expect(app).toContain('label:"AI 建议"')
    expect(app).toContain('label:"服务器风控"')
    expect(app).toContain('label:"MT5 结果"')
    expect(app).toContain('signal-monitor-safety')
    expect(app).toContain('analysis-safety-chain')
    expect(css).toContain('.signal-safety-stages')
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
    expect(routes).toContain('res.json({ ok:true, scheduler })')
  })

  it('returns sanitized profiles and never serializes encrypted or plaintext credentials', () => {
    expect(routes).toContain('credential_fields_redacted: true')
    expect(profiles).toContain('delete out.api_key_encrypted')
    expect(profiles).toContain("out.masked_api_key = out.has_api_key ? '****' : null")
    expect(routes).toContain("router.get('/ai/model-source'")
    expect(routes).not.toContain('api_key_encrypted: resolved.model.api_key_encrypted')
  })
})
