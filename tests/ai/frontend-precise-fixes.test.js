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

function makeInferenceRenderHarness({ legacy = false } = {}) {
  const evidenceStart = aiApp.indexOf('const _signalEvidenceCache = new Map()')
  const evidenceEnd = aiApp.indexOf('function chanSummaryForTimeframe', evidenceStart)
  const renderStart = aiApp.indexOf('function renderInferenceChart(signal, renderVersion)')
  const renderEnd = aiApp.indexOf('function renderSignal(', renderStart)
  expect(evidenceStart).toBeGreaterThanOrEqual(0)
  expect(evidenceEnd).toBeGreaterThan(evidenceStart)
  expect(renderStart).toBeGreaterThanOrEqual(0)
  expect(renderEnd).toBeGreaterThan(renderStart)
  const evidenceSource = aiApp.slice(evidenceStart, evidenceEnd)
  const renderSource = aiApp.slice(renderStart, renderEnd)
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
      inferenceChartLegend:chartLegend,
      inferenceKlineTableBody:chartTable,
      inferenceChartCursor:chartCursor,
    }
    function $(id) { return nodes[id] }
    function signalMarketData() { return {} }
    function bindInferenceChartControls() {}
    function chanSummaryForTimeframe() { return {} }
    function inferenceChartTickLabel() { return '' }
    function inferenceChartTimeLabel() { return 'time' }
    function escapeHtml(value) { return String(value ?? '') }
    function fmt(value) { return String(value ?? '') }
    function initIcons() {}
    function removeInferenceChartAttribution() {}
    function signalTakeProfitSelection() { return { price:null } }
    function addInferenceLine() { return false }
    function inferenceStructureTime() { return null }
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
          setData() {}, setMarkers() {}, createPriceLine() {},
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
      inferenceChartLayers:{ segments:false, centers:false, divergence:false, entries:false, levels:false },
    }
    ${evidenceSource}
    const signal = {
      id:7,
      inference_snapshot:${legacy
        ? `{ id:2, available_timeframes:['M5'], klines:{ M5:[{ time:1, open:1, high:2, low:1, close:2 }] } }`
        : `{ id:2, available_timeframes:['M5'], klines:{} }`},
    }
    ${legacy ? '' : `setSignalCacheEntry(_signalEvidenceCache, inferenceEvidenceCacheKey(7, 'M5', 2), { id:2, timeframe:'M5', source:'cache', klines:[{ time:1, open:1, high:2, low:1, close:2 }] }, SIGNAL_EVIDENCE_CACHE_LIMIT)`}
    ${renderSource}
    renderInferenceChart(signal, 1)
    return {
      chartCreateCount, contentAtCreate, remainingContent:container.innerHTML,
      requests, evidence:inferenceEvidenceFor(signal, 'M5'),
    }
  `)
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
    expect(adminHtml).toContain('/admin/app.js?v=20260810userpage10fix2')
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

  it('ships cache-busted app scripts while keeping each asset family on one key', () => {
    expect(aiHtml).toContain('/ai/app.js?v=20260811historyscope1&build=signalbandwidth1-notifications1')
    expect(aiHtml).toContain('/ai/styles.css?v=20260811historyscope1')
    expect(aiHtml).toContain('/ai/responsive.css?v=20260811historyscope1')
    expect(adminHtml).toContain('/admin/styles.css?v=20260810userpage10fix2')
  })
})
