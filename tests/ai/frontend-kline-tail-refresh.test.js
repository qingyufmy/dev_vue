import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'

const app = readFileSync(new URL('../../public/ai/app.js', import.meta.url), 'utf8')
const index = readFileSync(new URL('../../public/ai/index.html', import.meta.url), 'utf8')
const implementationStart = app.indexOf('function klineSourceMetaKey')
const implementationEnd = app.indexOf('// Lightweight: fetch only the last bar', implementationStart)
expect(implementationStart).toBeGreaterThanOrEqual(0)
expect(implementationEnd).toBeGreaterThan(implementationStart)
const implementation = app.slice(implementationStart, implementationEnd)

const sourceMeta = {
  source:'platform_admin_bridge', source_id:7, source_key:'mt5|demo|42', platform:'mt5',
  broker_server:'Demo', account_login:'42', timezone_offset_minutes:180,
  clock_status:'verified', broker_symbol:'XAUUSD', continuity_status:'reliable',
  expected_closures:[],
}

function rate(time, close = 2000, volume = 10) {
  return { time, open:close - 1, high:close + 1, low:close - 2, close, tick_volume:volume }
}

function fullRates(start = 1, count = 200, close = 2000) {
  return Array.from({ length:count }, (_, index) => rate((start + index) * 300, close + index))
}

function makeHarness() {
  return new Function(`
    const requests = []
    const responses = []
    const nodes = {
      quoteSymbolSelect:{ value:'XAUUSD' }, tradeSymbolSelect:{ value:'XAUUSD' },
      klineLastPrice:{ textContent:'' },
      klineDataSource:{ textContent:'', dataset:{}, classList:{ toggle(){} }, title:'' },
    }
    const state = {
      _accountContextGeneration:0, selectedObserverChannelId:null, aiAccess:null,
      platformMarketSourceActive:false, _lastGatewayLive:true,
    }
    let hidden = false
    let symbol = 'XAUUSD'
    let timeframe = 'M5'
    let _klineChart = {
      timeScale:() => ({ fitContent(){}, getVisibleLogicalRange:() => ({ from:10, to:190 }), setVisibleLogicalRange(){} }),
    }
    let _klineSeries = {
      data:[], setCalls:[], updateCalls:[],
      setData(value){ this.data = value.slice(); this.setCalls.push(value.slice()) },
      update(value){ this.data = [...this.data.filter(item => item.time !== value.time), value].sort((a,b) => a.time - b.time); this.updateCalls.push(value) },
    }
    let _klineVolumeSeries = {
      data:[], setCalls:[], updateCalls:[],
      setData(value){ this.data = value.slice(); this.setCalls.push(value.slice()) },
      update(value){ this.data = [...this.data.filter(item => item.time !== value.time), value].sort((a,b) => a.time - b.time); this.updateCalls.push(value) },
    }
    let _klineTimeframe = timeframe
    let _klineLastBar = null
    let _klineCandles = []
    let _klineDataKey = ''
    let _klineDataContextKey = ''
    let _klineRequestVersion = 0
    let _klineDataAvailable = false
    let _klineFullRefreshFlight = null
    let _klineFullRefreshContextKey = ''
    let _klineTailRefreshFlight = null
    let _klineTailRefreshContextKey = ''
    let _klineVolumeByTime = new Map()
    let _klineSourceMeta = null
    const KLINE_FULL_COUNT = 200
    const KLINE_TAIL_COUNT = 3
    const KLINE_MAX_CANDLES = 200

    function $(id){ return nodes[id] || null }
    function isObserverMode(){ return state.aiAccess?.read_only === true }
    function activeTabId(){ return 'dashboard' }
    const document = { get hidden(){ return hidden } }
    function selectedKlineSymbol(){ return symbol }
    function klineRequestKey(nextSymbol, nextTimeframe){ return String(nextSymbol).toUpperCase() + '::' + String(nextTimeframe).toUpperCase() }
    function klineTimeframeSeconds(){ return 300 }
    function klineContextKey(nextSymbol = selectedKlineSymbol(), nextTimeframe = _klineTimeframe){
      return JSON.stringify({ request_key:klineRequestKey(nextSymbol, nextTimeframe), account_context_generation:state._accountContextGeneration, observer_mode:isObserverMode(), observer_channel_id:isObserverMode() ? state.selectedObserverChannelId : null })
    }
    function klineSymbolKey(value){ return String(value || '').trim().toUpperCase() }
    function mt5BrokerTimeSeconds(value){
      if (typeof value === 'number' && Number.isFinite(value)) return Math.floor(value)
      return null
    }
    function clearKlineData(status, key){
      _klineDataAvailable = false; _klineCandles = []; _klineLastBar = null
      _klineVolumeByTime = new Map(); _klineSourceMeta = null
      _klineDataContextKey = ''; if (key != null) _klineDataKey = key
    }
    function getKlineVisibleLogicalRange(){ return { from:10, to:190 } }
    function setKlineVisibleLogicalRange(range, total){ return true }
    function setText(id, value){ if (nodes[id]) nodes[id].textContent = String(value) }
    function syncKlinePositionEntries(){}
    function wsApi(action, params){
      requests.push({ action, params:{ ...params } })
      return Promise.resolve(responses.shift())
    }
    function invalidateKlineRequestContext(){ _klineRequestVersion += 1 }
    function setSymbol(next){ symbol = next; nodes.quoteSymbolSelect.value = next; nodes.tradeSymbolSelect.value = next; invalidateKlineRequestContext() }
    function setAccountGeneration(next){ state._accountContextGeneration = next; invalidateKlineRequestContext() }
    function pushResponse(response){ responses.push(response) }
    function setHidden(next){ hidden = next }
    ${implementation}
    return {
      loadKlineData, refreshKlineTail, pushResponse, setSymbol, setAccountGeneration, setHidden,
      requests, series:_klineSeries, volumeSeries:_klineVolumeSeries,
      get candles(){ return _klineCandles },
      get sourceMeta(){ return _klineSourceMeta },
      get lastBar(){ return _klineLastBar },
      get requestVersion(){ return _klineRequestVersion },
    }
  `)()
}

function successful(rates, meta = sourceMeta, symbol = 'XAUUSD') {
  return { status:'success', symbol, rates, market_meta:{ ...meta } }
}

async function loadInitial(harness) {
  harness.pushResponse(successful(fullRates()))
  await harness.loadKlineData()
}

describe('AI dashboard K-line tail refresh', () => {
  it('keeps the first request as a complete 200-bar load', async () => {
    const harness = makeHarness()
    await loadInitial(harness)

    expect(harness.requests).toEqual([{ action:'rates', params:{ symbol:'XAUUSD', timeframe:'M5', count:200 } }])
    expect(harness.candles).toHaveLength(200)
    expect(harness.sourceMeta).toMatchObject(sourceMeta)
  })

  it('updates the existing tail bar with at most three rows and keeps the window bounded', async () => {
    const harness = makeHarness()
    await loadInitial(harness)
    const tail = [rate(198 * 300, 2197), rate(199 * 300, 2198), rate(200 * 300, 2300, 99)]
    harness.pushResponse(successful(tail))
    await harness.refreshKlineTail()

    expect(harness.requests.at(-1)).toEqual({ action:'rates', params:{ symbol:'XAUUSD', timeframe:'M5', count:3 } })
    expect(harness.candles).toHaveLength(200)
    expect(harness.lastBar).toMatchObject({ time:60000, close:2300 })
    expect(harness.volumeSeries.updateCalls.at(-1)).toMatchObject({ time:60000, value:99 })
  })

  it('appends a new broker-time candle and trims only the oldest candle', async () => {
    const harness = makeHarness()
    await loadInitial(harness)
    harness.pushResponse(successful([rate(199 * 300, 2199), rate(200 * 300, 2200), rate(201 * 300, 2201)]))
    await harness.refreshKlineTail()

    expect(harness.candles).toHaveLength(200)
    expect(harness.candles[0].time).toBe(2 * 300)
    expect(harness.lastBar.time).toBe(201 * 300)
  })

  it.each([
    ['duplicate timestamps', [rate(198 * 300), rate(199 * 300), rate(199 * 300, 2500)]],
    ['reverse order', [rate(200 * 300), rate(199 * 300), rate(198 * 300)]],
    ['a missing candle inside the tail', [rate(200 * 300), rate(202 * 300), rate(203 * 300)]],
  ])('fails closed to one full reload for %s', async (_name, invalidTail) => {
    const harness = makeHarness()
    await loadInitial(harness)
    harness.pushResponse(successful(invalidTail))
    harness.pushResponse(successful(fullRates(2, 200, 3000)))
    await harness.refreshKlineTail()

    expect(harness.requests.map(request => request.params.count)).toEqual([200, 3, 200])
    expect(harness.candles).toHaveLength(200)
    expect(harness.lastBar.close).toBe(3199)
  })

  it('accepts an expected market closure expressed in UTC without a full reload', async () => {
    const harness = makeHarness()
    await loadInitial(harness)
    const gapStart = 200 * 300
    const gapEnd = gapStart + 49 * 60 * 60
    const closureMeta = {
      ...sourceMeta,
      expected_closures:[{
        from_utc_msc:(gapStart - 3 * 60 * 60) * 1000,
        to_utc_msc:(gapEnd - 3 * 60 * 60) * 1000,
        gap_ms:(gapEnd - gapStart) * 1000,
      }],
    }
    harness.pushResponse(successful([
      rate(199 * 300), rate(gapStart), rate(gapEnd),
    ], closureMeta))
    await harness.refreshKlineTail()

    expect(harness.requests.map(request => request.params.count)).toEqual([200, 3])
    expect(harness.lastBar.time).toBe(gapEnd)
  })

  it('rejects a changed source and does not merge the old source window', async () => {
    const harness = makeHarness()
    await loadInitial(harness)
    const changedMeta = { ...sourceMeta, source_id:8, source_key:'mt5|demo|99', account_login:'99' }
    harness.pushResponse(successful([rate(198 * 300), rate(199 * 300), rate(200 * 300)], changedMeta))
    harness.pushResponse(successful(fullRates(2, 200, 3000), changedMeta))
    await harness.refreshKlineTail()

    expect(harness.requests.map(request => request.params.count)).toEqual([200, 3, 200])
    expect(harness.sourceMeta).toMatchObject(changedMeta)
  })

  it('invalidates late full and tail responses after a symbol/account context change', async () => {
    const harness = makeHarness()
    let resolveLateFull
    const lateFull = new Promise(resolve => { resolveLateFull = resolve })
    harness.pushResponse(lateFull)
    // The first call is intentionally superseded before its response settles.
    const oldFull = harness.loadKlineData()
    harness.setSymbol('EURUSD')
    harness.pushResponse(successful(fullRates(2, 200, 3000), sourceMeta, 'EURUSD'))
    const currentFull = harness.loadKlineData()
    await currentFull
    resolveLateFull(successful(fullRates()))
    await oldFull

    expect(harness.requests.map(request => request.params.symbol)).toEqual(['XAUUSD', 'EURUSD'])
    expect(harness.candles[0].time).toBe(2 * 300)

    harness.setAccountGeneration(1)
    harness.pushResponse(successful(fullRates(3, 200, 4000), sourceMeta, 'EURUSD'))
    await harness.loadKlineData()
    expect(harness.requests.at(-1).params.count).toBe(200)
  })

  it('keeps a failed tail request for the next periodic retry without a request storm', async () => {
    const harness = makeHarness()
    await loadInitial(harness)
    harness.pushResponse(Promise.reject(new Error('WebSocket未连接')))
    await harness.refreshKlineTail()
    harness.pushResponse(successful([rate(199 * 300), rate(200 * 300), rate(201 * 300)]))
    await harness.refreshKlineTail()

    expect(harness.requests.map(request => request.params.count)).toEqual([200, 3, 3])
    expect(harness.candles).toHaveLength(200)
  })

  it('guards periodic, visibility and timeframe wiring at the source contract', () => {
    const timerStart = app.indexOf('function startKlineRefreshTimer()')
    const timerEnd = app.indexOf('// Period button click', timerStart)
    const timer = app.slice(timerStart, timerEnd)
    expect(timer).toContain('refreshKlineTail().catch(() => {})')
    expect(timer).not.toContain('setInterval(() => { loadKlineData()')
    expect(app).toContain('document.hidden) return;')
    expect(app).toContain('if (changed) invalidateKlineRequestContext();')
    expect(app).toContain('const requestContextKey = klineContextKey(symbol, timeframe)')
    expect(app).toContain('const requestVersion = ++_klineRequestVersion')
    expect(index).toContain('chan-lifecycle-v8-kline-tail1"></script>')
  })
})
