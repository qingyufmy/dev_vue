import { readFileSync } from 'fs'
import { describe, expect, it } from 'vitest'

const html = readFileSync(new URL('../../public/ai/index.html', import.meta.url), 'utf8')
const app = readFileSync(new URL('../../public/ai/app.js', import.meta.url), 'utf8')

describe('inference workspace V2 contract', () => {
  it('opens manual inference from a dedicated modal', () => {
    expect(html).toContain('id="openManualInferenceBtn"')
    expect(html).toContain('id="manualInferenceModal"')
    expect(html).toContain('id="runAnalysisBtn"')
  })

  it('keeps history as a dedicated navigation rail beside the result', () => {
    expect(html).toContain('<aside class="card analysis-history-panel"')
    expect(html).toContain('历史分析')
    expect(html).toContain('data-analyst-view="records"')
    expect(html).not.toContain('analysis-history-panel quiet-disclosure')
    expect(html.indexOf('history-status-strip')).toBeLessThan(html.indexOf('analysisHistoryBody'))
    expect(app).toContain('const ANALYSIS_HISTORY_PAGE_SIZE = 10')
    expect(app).toContain('nearBottom = list.scrollTop')
    expect(app).toContain('继续向下滚动加载更多')
    expect(app).not.toContain('history-load-more')
  })

  it('does not expose a fake client-side cancellation control', () => {
    expect(html).not.toContain('analysisCancelBtn')
    expect(app).not.toContain('_analysisCancelled')
  })

  it('renders execution advice and separates the AI risk tier from final volume', () => {
    expect(app).toContain('执行建议')
    expect(app).toContain('AI 仓位档位')
    expect(app).toContain('风控最终手数')
    expect(app).not.toContain('当前持仓数 <em class="market-unit">笔</em>')
    expect(html).toContain('<span class="card-title">执行建议</span>')
    expect(app).toContain('市场方向倾向')
    expect(app).toContain('倾向强弱，不代表胜率')
    expect(app).toContain('id="analysisTextContent" class="analysis-text"')
  })

  it('defaults each inference chart to its smallest valid timeframe', () => {
    expect(app).toContain('function inferenceTimeframeMinutes(timeframe)')
    expect(app).toContain('const available = availableInferenceTimeframes(context.klines)')
    expect(app).toContain('state.inferenceChartTimeframe = available[0]')
    expect(app).toContain('state.inferenceChartSignalKey !== signalKey')
  })

  it('locks duplicate execution according to server execution advice', () => {
    expect(app).toContain('advice.executable === true')
    expect(app).toContain('advice.executable !== true')
    expect(app).toContain('activeSignal = { ...previousSelected, ...stillExists }')
    expect(app).toContain("msg.type === 'signal_execution_updated'")
  })

  it('isolates async signal details and chart renders by the active selection', () => {
    expect(app).toContain('const requestVersion = ++_analysisDetailRequestVersion')
    expect(app).toContain('const forceRefresh = options.forceRefresh ?? navigate')
    expect(app).toContain('requestVersion !== _analysisDetailRequestVersion')
    expect(app).toContain('resultHost?.dataset.signalId !== signalKey')
    expect(app).toContain('resultHost?.dataset.renderVersion !== String(renderVersion)')
    expect(app).toContain('cancelAnimationFrame(_inferenceChartFrame)')
    expect(app).toContain('renderAnalysisDetailLoading(signalId)')
    expect(app).toContain('setTab("ai-analyze", { skipRefresh:true, analystView:"detail" })')
    expect(app.match(/setTab = function\(tab, options = \{\}\)/g)).toHaveLength(2)
    expect(app.match(/_origSetTab2?\(tab, options\)/g)).toHaveLength(2)
    expect(app).toContain('!options.append && !options.skipResultRender')
    expect(app).toContain('state.selectedSignal = previousSelected')
  })

  it('only follows a new signal while the user is still following the canonical latest signal', () => {
    expect(app).toContain('analysisSelectionMode: "follow_latest"')
    expect(app).toContain('function shouldAutoFollowNewSignal(previousLatestId)')
    expect(app).toContain('sameSignalId(selectedId, previousLatestId)')
    expect(app).toContain('state.latestSignalId = state.signals[0].id')
    expect(app).toContain('await refreshForNewSignal(latest.id, latest)')
    expect(app).toContain('await refreshForNewSignal(msg.signal_id, msg.signal || null)')
  })

  it('keeps the home monitor on the canonical latest signal and refreshes it in fullscreen', () => {
    expect(app).toContain('dashboardSignal: null')
    expect(app).toContain('async function loadDashboardSignal(signalId, fallbackSignal = null, options = {})')
    expect(app).toContain('announceDashboardSignal:true')
    expect(app).toContain('state.dashboardSignal = signal || null')
    expect(app).toContain('document.fullscreenElement === card')
    expect(app).toContain('await card.requestFullscreen()')
    expect(app).toContain('function renderSignalMonitorDetails(signal)')
    expect(app).toContain('完整分析')
  })

  it('pins signals opened from history or ticket navigation across background refreshes', () => {
    expect(app).toContain('["history", "ticket", "trade"].includes(source)')
    expect(app).toContain("source:'history', forcePinned:true")
    expect(app).toContain('source:"ticket", forcePinned:true')
    expect(app).toContain('preserveSelectionMode:true')
    expect(app).toContain('stillExists || previousSelected || state.signals[0] || null')
  })

  it('keeps revoked platform experience out of the active library and exposes a collapsed archive', () => {
    expect(app).toContain('const currentItems = visibleItems.filter(item => item.status !== "revoked")')
    expect(app).toContain("tab('long', '长期记忆'")
    expect(app).toContain('class="platform-experience-archive"')
    expect(app).toContain('data-platform-experience-action="delete"')
    expect(app).toContain('method:"DELETE"')
  })

  it('renders pending cancellation outcomes in signal details', () => {
    expect(app).toContain('function renderSignalPendingActions(signal)')
    expect(app).toContain('signal?.pending_actions')
    expect(app).toContain('${renderSignalPendingActions(signal)}')
    expect(app).toContain('userVisibleText(action.message')
  })

  it('keeps concrete execution outcomes visible even after the signal expires', () => {
    expect(app.indexOf('if (executionStatus && executionStatus !== "success")')).toBeLessThan(app.indexOf('if (signalIsStale(signal)) return { state:"expired"'))
    expect(app).toContain('opposite_position_exists:"当前账户已有反向持仓，本次不新增仓位"')
    expect(app).toContain('title: rejected ? "风控未放行" : skipped ? "本次未执行"')
  })

  it('shows completed pending cancellation details in the inference result', () => {
    expect(app).toContain('execution?.status === "success" && execution?.reason === "pending_cancelled"')
    expect(app).toContain('title:"旧挂单已取消"')
    expect(app).toContain('Number(action.count || 0)')
  })
})
