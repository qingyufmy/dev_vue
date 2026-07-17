import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'

const html = readFileSync(new URL('../../public/ai/index.html', import.meta.url), 'utf8')
const app = readFileSync(new URL('../../public/ai/app.js', import.meta.url), 'utf8')
const css = readFileSync(new URL('../../public/ai/styles.css', import.meta.url), 'utf8')
const routes = readFileSync(new URL('../../server/routes/ai/index.js', import.meta.url), 'utf8')
const bridgeWs = readFileSync(new URL('../../server/bridge-ws.js', import.meta.url), 'utf8')
const profiles = readFileSync(new URL('../../server/routes/ai/model-profiles.js', import.meta.url), 'utf8')
const scheduler = readFileSync(new URL('../../server/routes/ai/scheduler.js', import.meta.url), 'utf8')

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
    expect(platformTickBranch).not.toContain('state.lastQuote =')
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

  it('separates Kimi production API from personal Code subscription credentials', () => {
    expect(html).toContain('<option value="kimi">Kimi 开放平台</option>')
    expect(html).toContain('<option value="kimi_code">Kimi Code 订阅（个人）</option>')
    expect(html).toContain('id="platformSharingProviderNotice"')
    expect(app).toContain("kimi_code: { models: ['kimi-for-coding', 'k3', 'kimi-for-coding-highspeed']")
    expect(app).toContain('profile.share_eligible !== false')
  })

  it('shows user-editable price controls and separates AI, cap and final execution volume', () => {
    expect(app).toContain('pending_price_deviation_pct')
    expect(app).toContain('market_signal_drift_atr')
    expect(app).toContain('AI 建议')
    expect(app).toContain('风险上限')
    expect(app).toContain('最终')
    expect(html).toContain('id="executionDecisionPager"')
    expect(app).toContain('executionFilters: { page: 1, pageSize: 5')
    expect(app).toContain('R1.5_RR_TOO_LOW":"盈亏比低于最低要求')
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

  it('uses a distinct subscription action area and server-confirmed scheduler state after deletion', () => {
    expect(app).toContain('class="subscription-row-actions"')
    expect(app).toContain('data-subscription-action="edit"')
    expect(app).toContain('data-subscription-action="delete"')
    expect(app).toContain('>编辑订阅</button>')
    expect(app).toContain('platform_only: "平台统一经验"')
    expect(app).toContain('if (deleted.scheduler)')
    expect(app).toContain('renderAutoAnalyzeBadge(deleted.scheduler)')
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
    expect(app).toContain('subscription?.schedule_timezone || "Etc/GMT-3"')
  })

  it('uses one strategy control plane and removes the legacy manual preference editor', () => {
    expect(routes).toContain("router.get('/ai/inference-preferences', authMiddleware")
    expect(routes).toContain("router.put('/ai/inference-preferences', authMiddleware")
    expect(html).toContain('id="analyzeStrategy"')
    expect(html).toContain('id="manualAutoExecute"')
    expect(html).toContain('data-tab="ai-analyze" data-title="推理"')
    expect(html).not.toContain('id="strategyEnabled"')
    expect(html).toContain('可见状态同时控制策略是否可用于手动和自动推理')
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
    expect(html).toContain('只显示当前可用于推理的策略')
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

  it('initializes dynamically rendered risk-center icons without requiring a tab switch', () => {
    const start = app.indexOf('async function loadRiskCenter()')
    const end = app.indexOf('async function loadExecutionDecisions()', start)
    const loadRiskCenter = app.slice(start, end)
    expect(loadRiskCenter).toContain('class="risk-status-icon"')
    expect(loadRiskCenter).toContain('renderExecutionDecisions(')
    expect(loadRiskCenter).toContain('initIcons();')
    expect(loadRiskCenter.indexOf('initIcons();')).toBeGreaterThan(loadRiskCenter.indexOf('class="risk-status-icon"'))
  })

  it('keeps the overview signal card focused on the current decision and execution summary', () => {
    const start = html.indexOf('id="signalCard"')
    const end = html.indexOf('class="card grid-area-positions"', start)
    const signalCard = html.slice(start, end)
    expect(signalCard).toContain('最新推理信号')
    expect(signalCard).toContain('data-tab-jump="ai-analyze"')
    expect(signalCard).toContain('class="signal-decision-panel"')
    expect(signalCard).toContain('class="signal-execution-strip"')
    expect(signalCard).toContain('id="sigActionHint"')
    expect(signalCard).not.toContain('上次信号摘要')
    expect(signalCard).not.toContain('data-tab-jump="signals"')
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
