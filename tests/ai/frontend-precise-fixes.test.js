import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'

const aiApp = readFileSync(new URL('../../public/ai/app.js', import.meta.url), 'utf8')
const aiHtml = readFileSync(new URL('../../public/ai/index.html', import.meta.url), 'utf8')
const adminApp = readFileSync(new URL('../../public/admin/app.js', import.meta.url), 'utf8')
const adminHtml = readFileSync(new URL('../../public/admin/index.html', import.meta.url), 'utf8')

function sourceBlock(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker)
  const end = source.indexOf(endMarker, start)
  expect(start).toBeGreaterThanOrEqual(0)
  expect(end).toBeGreaterThan(start)
  return source.slice(start, end)
}

async function runAccountDisplayCases() {
  const loadAccount = sourceBlock(aiApp, 'async function loadAccount()', 'function updateTradingQuotePreview')
  const harness = new Function(`
    let response = null
    let observer = false
    const displayed = {}
    const state = { accountBalance:0, bridgeAccountIdentity:null }
    function setHistoryAccountIdentity(identity) { state.bridgeAccountIdentity = identity }
    function wsApi(action) {
      if (action !== 'account') throw new Error('unexpected action')
      return Promise.resolve(response)
    }
    function isObserverMode() { return observer }
    function setText(id, value) { displayed[id] = value }
    function setPnlValue(id, value) { displayed[id] = value }
    function fmt(value) { return String(value ?? '--') }
    function updatePnlStyle() {}
    const document = { querySelectorAll:() => [] }
    ${loadAccount}
    return (async () => {
      const cases = [
        { observer:true, server:'DooTechnology-Demo' },
        { observer:true, server:'DooTechnology-DemoDemo' },
        { observer:true, server:'DooTechnology-demo' },
        { observer:true, server:'DooTechnology-Demo ' },
        { observer:true, server:'DooTechnology-Demo\\n' },
        { observer:false, server:'DooTechnology-Demo' },
      ]
      const results = []
      for (const item of cases) {
        observer = item.observer
        response = {
          server:item.server, login:'7788', currency:'USD', balance:'100',
          equity:'101', profit:'1', margin:'2', margin_free:'99', leverage:100,
        }
        await loadAccount()
        results.push({
          display:displayed.mt5Server,
          identity:state.bridgeAccountIdentity,
        })
      }
      return results
    })()
  `)
  return harness()
}

async function runAdminUserRequest() {
  const loadUsers = sourceBlock(adminApp, 'async function loadUsers()', 'async function renderUsers')
  const harness = new Function(`
    const state = { page:3, membership:'pro', search:'alice', users:[], pagination:null }
    const requests = []
    const nodes = new Map([
      ['#userListArea', { innerHTML:'' }],
      ['#pageLabel', { textContent:'' }],
      ['#prevPage', { disabled:false }],
      ['#nextPage', { disabled:false }],
    ])
    const document = { querySelector(selector) { return nodes.get(selector) } }
    function api(url) {
      requests.push(url)
      return Promise.resolve({ users:[], pagination:{ page:3, total_pages:4, total:31 } })
    }
    function userRows() { return '' }
    function bindUserOpeners() {}
    ${loadUsers}
    return loadUsers().then(() => requests[0])
  `)
  return harness()
}

function makeInferenceRenderHarness({ legacy = false, structure = null, divergence = false } = {}) {
  const evidenceStart = aiApp.indexOf('const _signalEvidenceCache = new Map()')
  const evidenceEnd = aiApp.indexOf('function inferenceTimeframeMinutes', evidenceStart)
  const renderStart = aiApp.indexOf('function renderInferenceChart(signal, renderVersion)')
  const renderEnd = aiApp.indexOf('function renderSignal(', renderStart)
  expect(evidenceStart).toBeGreaterThanOrEqual(0)
  expect(evidenceEnd).toBeGreaterThan(evidenceStart)
  expect(renderStart).toBeGreaterThanOrEqual(0)
  expect(renderEnd).toBeGreaterThan(renderStart)
  const evidenceSource = aiApp.slice(evidenceStart, evidenceEnd)
  const renderSource = aiApp.slice(renderStart, renderEnd)
  const evidenceRows = structure
    ? [1, 2, 3, 4, 5].map(time => ({ time, open:time, high:time + 1, low:time - 1, close:time + .5 }))
    : [{ time:1, open:1, high:2, low:1, close:2 }]
  const timeframeSummary = structure ? {
    timeframe:'M5',
    last_closed_bar:{ time:5 },
    summary:{ chan:structure, market_data_quality:{ platform:'MT5', last_bar_closed:true } },
  } : null
  return new Function(`
    let _inferenceChart = null
    let _inferenceChartFrame = null
    let _inferenceChartResizeObserver = null
    let _inferenceChartMutationObserver = null
    let _inferenceCandleSeries = null
    const requests = []
    const resultHost = { dataset:{ signalId:'7', renderVersion:'1' } }
    const chartLegend = { innerHTML:'' }
    const chartTable = { innerHTML:'' }
    const chartCursor = { textContent:'' }
    const chartMeta = { textContent:'' }
    const lineCalls = []
    const markerCalls = []
    let chartCreateCount = 0
    let contentAtCreate = null
    const container = {
      offsetWidth:640, offsetHeight:340, clientWidth:640, clientHeight:340,
      _innerHTML:'<div class="inference-chart-loading">正在读取当前周期冻结证据…</div>',
      get innerHTML() { return this._innerHTML },
      set innerHTML(value) { this._innerHTML = value },
    }
    const nodes = {
      analysisResult:resultHost,
      inferenceKlineChart:container,
      inferenceChartEvidenceMeta:chartMeta,
      inferenceChartLegend:chartLegend,
      inferenceKlineTableBody:chartTable,
      inferenceChartCursor:chartCursor,
    }
    function $(id) { return nodes[id] }
    function signalMarketData() { return {} }
    function bridgePlatformLabel(value) { return String(value || 'MT5').toUpperCase() }
    function bindInferenceChartControls() {}
    function chanSummaryForTimeframe() { return {} }
    function inferenceChartTickLabel() { return '' }
    function inferenceChartTimeLabel() { return 'time' }
    function escapeHtml(value) { return String(value ?? '') }
    function fmt(value) { return String(value ?? '') }
    function initIcons() {}
    function removeInferenceChartAttribution() {}
    function signalTakeProfitSelection() { return { price:null } }
    function addInferenceLine(_chart, points, options) { lineCalls.push({ points, options }); return true }
    function inferenceStructureTime(candles, item, edge) {
      const raw = item?.[edge + '_time'] ?? item?.[edge + '_broker_time'] ?? item?.[edge + '_time_utc_msc'] ?? (edge === 'start' ? item?.time : null)
      const value = Number(raw)
      if (!Number.isFinite(value)) return null
      return Math.floor(value > 1e12 ? value / 1000 : value)
    }
    function wsApi(action) {
      requests.push(action)
      throw new Error('unexpected evidence request')
    }
    class ResizeObserver { observe() {} disconnect() {} }
    class MutationObserver { observe() {} disconnect() {} }
    const LightweightCharts = {
      CrosshairMode:{ Normal:0 },
      createChart(target) {
        chartCreateCount += 1
        contentAtCreate = target.innerHTML
        const series = {
          setData() {},
          setMarkers(value) { markerCalls.push(value) },
          createPriceLine() {},
        }
        return {
          addCandlestickSeries() { return series },
          subscribeCrosshairMove() {},
          timeScale() { return { fitContent() {} } },
          remove() {},
        }
      },
    }
    const state = {
      selectedSignal:{ id:7 }, inferenceChartTimeframe:'M5',
      inferenceChartLayers:{ segments:${Boolean(structure)}, bis:${Boolean(structure)}, centers:false, divergence:${Boolean(divergence)}, entries:false, levels:false },
    }
    ${evidenceSource}
    const signal = {
      id:7,
      inference_snapshot:${legacy
        ? `{ id:2, available_timeframes:['M5'], klines:{ M5:[{ time:1, open:1, high:2, low:1, close:2 }] } }`
        : `{ id:2, available_timeframes:['M5'], klines:{} }`},
    }
    ${legacy ? '' : `setSignalCacheEntry(_signalEvidenceCache, inferenceEvidenceCacheKey(7, 'M5', 2), { id:2, timeframe:'M5', source:'cache', klines:${JSON.stringify(evidenceRows)}, timeframe_summary:${JSON.stringify(timeframeSummary)} }, SIGNAL_EVIDENCE_CACHE_LIMIT)`}
    ${renderSource}
    renderInferenceChart(signal, 1)
    return {
      chartCreateCount, contentAtCreate, remainingContent:container.innerHTML,
      requests, evidence:inferenceEvidenceFor(signal, 'M5'),
      lines:lineCalls, markers:markerCalls, legend:chartLegend.innerHTML, meta:chartMeta.textContent,
    }
  `)
}

function runInferenceChartEvidenceMetaCases() {
  const metaSource = sourceBlock(aiApp, 'function inferenceChartEvidenceMeta(context, timeframe)', 'function inferenceRawStructureTime')
  const harness = new Function(`
    function inferenceFrozenPlatformLabel(context, timeframe) {
      return context.timeframeSummaries[String(timeframe).toUpperCase()].summary.market_data_quality.platform
    }
    function inferenceBarClosureLabel(context, timeframe) {
      return context.timeframeSummaries[String(timeframe).toUpperCase()].summary.market_data_quality.last_bar_closed
        ? '最后一根为已收盘 K 线'
        : '最后一根为推理时未收盘 K 线'
    }
    ${metaSource}
    const context = {
      snapshot: {
        market_source: 'platform_market_bridge', evidence_status: 'complete',
        timeframe_counts: { m5: 5, h1: 2 },
      },
      klines: { M5: [1, 2, 3, 4, 5], H1: [1, 2] },
      timeframeSummaries: {
        M5: { summary: { market_data_quality: { platform:'MT5', last_bar_closed:true } } },
        H1: { summary: { market_data_quality: { platform:'MT4', last_bar_closed:false } } },
      },
    }
    return {
      m5: inferenceChartEvidenceMeta(context, 'M5'),
      h1: inferenceChartEvidenceMeta(context, 'H1'),
    }
  `)
  return harness()
}

describe('precise AI/admin frontend fixes', () => {
  it('replaces only an exact trailing Demo in observer display labels', async () => {
    const results = await runAccountDisplayCases()
    expect(results.map(item => item.display)).toEqual([
      'DooTechnology-Live',
      'DooTechnology-DemoLive',
      'DooTechnology-demo',
      'DooTechnology-Demo ',
      'DooTechnology-Demo\n',
      'DooTechnology-Demo',
    ])
    expect(results.every(item => item.identity.brokerServerKey === 'DOOTECHNOLOGY-DEMO' || item.identity.brokerServerKey === 'DOOTECHNOLOGY-DEMODEMO')).toBe(true)
    expect(aiApp).toContain('rawServer.endsWith("Demo")')
  })

  it('requests ten users per page without changing other admin pagination', async () => {
    const url = await runAdminUserRequest()
    expect(new URL(url, 'http://localhost').searchParams.get('page_size')).toBe('10')
    const users = sourceBlock(adminApp, 'async function loadUsers()', 'async function renderUsers')
    const orders = sourceBlock(adminApp, 'async function loadCommercialOrders()', 'async function loadCommercialNotifications')
    expect(users).toContain("page_size:'10'")
    expect(orders).toContain("page_size:'20'")
    expect(adminHtml).toContain('/admin/app.js?v=20260814ema34toggle1')
  })

  it('prefers exact cached evidence over legacy fallback and clears the loading placeholder before chart creation', () => {
    const result = makeInferenceRenderHarness()()
    expect(result.evidence.source).toBe('cache')
    expect(result.chartCreateCount).toBe(1)
    expect(result.contentAtCreate).toBe('')
    expect(result.requests).toEqual([])
    expect(result.remainingContent).toBe('')
  })

  it('still draws an embedded legacy snapshot without requesting evidence', () => {
    const result = makeInferenceRenderHarness({ legacy:true })()
    expect(result.evidence.legacy).toBe(true)
    expect(result.chartCreateCount).toBe(1)
    expect(result.contentAtCreate).toBe('')
    expect(result.requests).toEqual([])
  })

  it('renders the on-demand Chan summary as separate current structure layers', () => {
    const result = makeInferenceRenderHarness({
      structure: {
        current_bi:{ id:2, dir:'down', start_price:104, end_price:100, confirmed:true, start_time:1, end_time:2 },
        recent_bis:[{ id:1, dir:'up', start_price:101, end_price:104, confirmed:true, start_time:1, end_time:2 }],
        prev_segment:{ dir:'up', start_price:101, end_price:104, confirmed:true, start_time:1, end_time:2 },
        current_segment:{ dir:'down', start_price:104, end_price:100, confirmed:true, start_time:2, end_time:3 },
        candidate_segment:{ dir:'up', start_price:100, end_price:103, confirmed:false, active_for_current_state:false, lifecycle_state:'invalidated', start_time:3, end_time:4 },
        historical_candidate_segment:{ dir:'up', start_price:100, end_price:103, confirmed:false, structure_role:'historical_invalidated_candidate', start_time:3, end_time:4 },
          latest_structure:{
          as_of_time_utc_msc:5000,
          active_pivot_state:'origin_breached',
          latest_confirmed_fractal:{ type:'bottom', price:100, time:2, time_utc_msc:2000, confirmed:true, active_for_developing_bi:false },
          developing_bi:{ dir:'up', start_price:100, end_price:103, confirmed:false, start_time:2, end_time:4 },
          continuation_extension:{ start_price:100, end_price:99, confirmed:false, start_time:2, end_time:5 },
        },
      },
    })()

    expect(result.evidence.timeframe_summary.summary.chan.latest_structure).toBeTruthy()
    expect(result.lines.filter(item => item.options.color === '#61a8ff')).toHaveLength(1)
    expect(result.lines.filter(item => item.options.color === '#d7b96a')).toHaveLength(1)
    expect(result.lines.filter(item => item.options.color === '#e8c957' || item.options.color === '#91a4bf').length).toBeGreaterThanOrEqual(2)
    expect(result.lines.some(item => item.points.some(point => point.value === 103) && item.options.color === '#e8c957')).toBe(false)
    expect(result.markers.flat().some(item => item.text.includes('底分型（历史已确认·起点已破坏）'))).toBe(true)
    expect(result.legend).toContain('已确认笔')
    expect(result.legend).toContain('形成中笔（未确认）')
    expect(result.legend).toContain('历史已确认分型（起点已破坏）')
    expect(result.legend).toContain('未确认延伸')
  })

  it('does not claim confirmed divergence from an unrelated fractal marker', () => {
    const result = makeInferenceRenderHarness({
      divergence: true,
      structure: {
        latest_structure: {
          latest_confirmed_fractal: { type:'bottom', price:100, time:2, confirmed:true },
        },
      },
    })()
    expect(result.markers.flat().some(item => item.text === '底分型')).toBe(true)
    expect(result.legend).not.toContain('已确认背驰')
  })

  it('uses drawn structure endpoints, not the Chan calculation cutoff, for coverage lag', () => {
    const result = makeInferenceRenderHarness({
      structure: {
        current_bi: { id:1, dir:'up', start_price:100, end_price:101, confirmed:true, start_time:1, end_time:2 },
        latest_structure: { as_of_time_utc_msc: 9999999999999 },
      },
    })()
    expect(result.legend).toContain('线段为历史确认结构，当前变化请查看笔/分型图层')
  })

  it('regenerates frozen evidence metadata for each selected timeframe', () => {
    const result = runInferenceChartEvidenceMetaCases()
    expect(result.m5).toContain('5 根证据完整')
    expect(result.m5).toContain('冻结 MT5 时间')
    expect(result.m5).toContain('最后一根为已收盘 K 线')
    expect(result.h1).toContain('2 根证据完整')
    expect(result.h1).toContain('冻结 MT4 时间')
    expect(result.h1).toContain('最后一根为推理时未收盘 K 线')
    expect(aiApp).toContain('evidenceMeta.textContent = inferenceChartEvidenceMeta(context, timeframe)')
  })

  it('ships cache-busted app scripts while keeping each asset family on one key', () => {
    expect(aiHtml).toContain('/ai/app.js?v=20260814ema34toggle1&build=signalbandwidth1-notifications1-analysisloading1')
    expect(aiHtml).toContain('/ai/styles.css?v=20260814ema34toggle1')
    expect(aiHtml).toContain('/ai/responsive.css?v=20260814ema34toggle1')
    expect(adminHtml).toContain('/admin/styles.css?v=20260814ema34toggle1')
  })
})
