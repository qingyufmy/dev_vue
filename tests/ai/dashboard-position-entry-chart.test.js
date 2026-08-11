import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'

const html = readFileSync(new URL('../../public/ai/index.html', import.meta.url), 'utf8')
const app = readFileSync(new URL('../../public/ai/app.js', import.meta.url), 'utf8')
const css = readFileSync(new URL('../../public/ai/styles.css', import.meta.url), 'utf8')
const responsiveCss = readFileSync(new URL('../../public/ai/responsive.css', import.meta.url), 'utf8')

function positionTableHeaders() {
  return [...html.matchAll(/<table[^>]*position-list-table[^>]*>[\s\S]*?<thead><tr>([\s\S]*?)<\/tr><\/thead>/g)]
    .map(match => [...match[1].matchAll(/<th[^>]*>([\s\S]*?)<\/th>/g)]
      .map(header => header[1].replace(/<[^>]+>/g, '').trim()))
}

describe('dashboard current-position entry markers', () => {
  it('draws current-symbol entries with semantic red/green arrows without persistent price lines', () => {
    const syncStart = app.indexOf('function syncKlinePositionEntries()')
    const syncEnd = app.indexOf('function handleKlinePositionCrosshair', syncStart)
    const syncBlock = app.slice(syncStart, syncEnd)
    expect(app).toContain('function syncKlinePositionEntries()')
    expect(app).toContain('function klinePositionPriceDigits(position = {})')
    expect(app).toContain('klinePositionMatchesSymbol(position, symbol)')
    expect(app).toContain("const KLINE_POSITION_ENTRY_BUY_COLOR = '#ef4444'")
    expect(app).toContain("const KLINE_POSITION_ENTRY_SELL_COLOR = '#10b981'")
    expect(syncBlock).toContain('const side = positionDirectionType(position)')
    expect(syncBlock).toContain('const descriptors = buildKlinePositionDescriptors(symbol)')
    expect(syncBlock).toContain('const structureChanged = desiredKeys.length !== previousKeys.length')
    expect(syncBlock).toContain('existing.position = position')
    expect(syncBlock).toContain('markerTime')
    expect(syncBlock).toContain('if (!side)')
    expect(syncBlock).toContain('lineVisible:false')
    expect(syncBlock).toContain('pointMarkersVisible:false')
    expect(syncBlock).toContain('lastValueVisible:false')
    expect(syncBlock).toContain('if (!start.visible) continue;')
    expect(syncBlock).toContain('series.setData([{ time:markerTime, value:price }])')
    expect(syncBlock).toContain('series.setMarkers([{')
    expect(syncBlock).toContain("position:side === 'buy' ? 'belowBar' : 'aboveBar'")
    expect(syncBlock).not.toContain("position:'inBar'")
    expect(syncBlock).toContain('color:markerColor')
    expect(syncBlock).toContain("shape:side === 'buy' ? 'arrowUp' : 'arrowDown'")
    expect(syncBlock).toContain('size:1.5')
    expect(syncBlock).not.toContain('#d4af37')
    expect(syncBlock).not.toContain('pointMarkersRadius')
    expect(syncBlock).not.toContain('LineStyle.Dashed')
    expect(syncBlock).not.toContain('title:`${direction}入场`')
    expect(app).not.toContain('使用金色箭头')
    expect(app).toContain('syncKlinePositionEntries();')
  })

  it('shows volume details only when the crosshair is close to a visible entry point', () => {
    expect(app).toContain('function handleKlinePositionCrosshair(param)')
    expect(app).toContain('escapeHtml(volumeText(position.volume))')
    expect(app).toContain('timeToCoordinate(item.markerTime)')
    expect(app).toContain('priceToCoordinate(Number(item.position.price_open))')
    expect(app).toContain('Math.abs(param.point.x - timeCoordinate) <= KLINE_POSITION_HIT_RADIUS')
    expect(app).toContain('Math.abs(param.point.y - priceCoordinate) <= KLINE_POSITION_HIT_RADIUS')
    expect(app).not.toContain('param.seriesData.has(item.series)')
    expect(app).toContain("if (entryTime < candles[0].time) return { index:0, visible:false };")
    expect(css).toContain('.kline-position-tooltip')
    expect(css).toContain('pointer-events: none')
    expect(css).toContain('.kline-position-tooltip-row.is-buy strong { color: var(--color-positive); }')
    expect(css).toContain('.kline-position-tooltip-row.is-sell strong { color: var(--color-negative); }')
  })

  it('describes long/short marker colors and leaves unknown directions unmarked', () => {
    expect(app).toContain('function positionDirectionType(position = {})')
    expect(app).toContain("if (value === 'buy') return 'buy'")
    expect(app).toContain("if (value === 'sell') return 'sell'")
    expect(app).toContain('方向未知持仓未绘制入场标记')
    expect(app).toContain('多仓使用红色向上箭头、空仓使用绿色向下箭头')
    expect(app).not.toContain("const buy = String(position.type || '').toLowerCase() === 'buy'")
  })

  it('keeps analyst navigation latest-first while preserving background selection refreshes', () => {
    const navStart = app.lastIndexOf('document.querySelectorAll(".nav-item").forEach((button) => {')
    const navEnd = app.indexOf('document.querySelectorAll("[data-model-strategy-tab]")', navStart)
    const navBlock = app.slice(navStart, navEnd)
    const refreshStart = app.indexOf('async function refreshTabData(tabId, options = {})')
    const refreshEnd = app.indexOf('async function withBusy', refreshStart)
    const refreshBlock = app.slice(refreshStart, refreshEnd)
    expect(navBlock).toContain('button.dataset.tab === "ai-analyze" ? { selectLatest:true } : {}')
    expect(app).toContain('refreshTabData(tabId, options)')
    expect(refreshBlock).toContain('const selectLatest = options.selectLatest === true')
    expect(refreshBlock).toContain('loadSignals(selectLatest')
    expect(refreshBlock).toContain('{ selectLatest:true, loadDashboard:false }')
    expect(refreshBlock).toContain('{ skipResultRender:true, loadDashboard:false }')
    expect(refreshBlock).toContain('historyList.scrollTop = 0')
  })

  it('restarts both dashboard K-line timers and validates the broker volume bar timestamp', () => {
    const refreshStart = app.indexOf('async function refreshTabData(tabId, options = {})')
    const refreshEnd = app.indexOf('async function withBusy', refreshStart)
    const refreshBlock = app.slice(refreshStart, refreshEnd)
    const dashboardStart = refreshBlock.indexOf('} else if (tabId === "dashboard")')
    const dashboardEnd = refreshBlock.indexOf('} else if (tabId === "history")', dashboardStart)
    const dashboardBlock = refreshBlock.slice(dashboardStart, dashboardEnd)
    const volumeStart = app.indexOf('async function refreshKlineVolume()')
    const volumeEnd = app.indexOf('function updateKlineTick', volumeStart)
    const volumeBlock = app.slice(volumeStart, volumeEnd)
    expect(dashboardBlock).toContain('startKlineRefreshTimer()')
    expect(dashboardBlock).toContain('startKlineVolumeRefreshTimer()')
    expect(volumeBlock).toContain('const barTime = mt5BrokerTimeSeconds(b?.time)')
    expect(volumeBlock).toContain('barTime !== Number(_klineLastBar.time)')
    expect(volumeBlock).toContain('_klineVolumeSeries.update({ time: barTime')
    expect(volumeBlock).not.toContain('_klineVolumeSeries.update({ time: _klineLastBar.time')
  })

  it('keeps quote direction arrows in a fixed hidden and visible slot', () => {
    const changeStart = css.indexOf('.quote-change {')
    const changeEnd = css.indexOf('.quote-change.hidden {', changeStart)
    const changeBlock = css.slice(changeStart, changeEnd)
    const hiddenStart = changeEnd
    const hiddenEnd = css.indexOf('.quote-change.up {', hiddenStart)
    const hiddenBlock = css.slice(hiddenStart, hiddenEnd)

    expect(changeBlock).toContain('height: 18px;')
    expect(changeBlock).toContain('line-height: 18px;')
    expect(changeBlock).not.toContain('min-height: 18px;')
    expect(hiddenBlock).toContain('display: block !important;')
    expect(hiddenBlock).toContain('visibility: hidden;')
    expect(html).toMatch(/<span id="quoteBidDir" class="quote-change hidden"><\/span>/)
    expect(html).toMatch(/<span id="quoteAskDir" class="quote-change hidden"><\/span>/)
  })
})

describe('shared current-position table contract', () => {
  it('uses the same eleven headers for dashboard and AI trader tables', () => {
    const expected = ['票号', '品种', '方向', '手数', '开仓价', '现价', '开仓时间（交易平台）', '止损', '止盈', '盈亏', '操作']
    const headers = positionTableHeaders()
    expect(headers).toHaveLength(2)
    expect(headers[0]).toEqual(expected)
    expect(headers[1]).toEqual(expected)
  })

  it('renders one shared row function with permissions and live patching for both tables', () => {
    const renderStart = app.indexOf('const POSITION_COLUMN_COUNT = 11')
    const renderEnd = app.indexOf('function positionPriceDigits', renderStart)
    const renderBlock = app.slice(renderStart, renderEnd)
    expect(renderBlock).toContain('function renderPositionRows(positions = [])')
    expect(renderBlock).toContain('colspan="${POSITION_COLUMN_COUNT}"')
    expect(renderBlock).toContain('data-label="止损"')
    expect(renderBlock).toContain('data-label="止盈"')
    expect(renderBlock).toContain('data-label="盈亏"')
    expect(renderBlock).toContain('data-label="操作"')
    expect(renderBlock).toContain('state.user?.role === "admin" && Number(position.magic) === 234000')
    expect(renderBlock).toContain('data-edit-protection-ticket=')
    expect(renderBlock).toContain('data-close-ticket=')
    expect(app.match(/renderPositionRows\(positions\)/g)).toHaveLength(2)
    expect(app).not.toContain('renderPositionRows(positions,')
    expect(app).toContain("const bodies = [$('positionsBody'), $('dashboardPositionsBody')].filter(Boolean)")
    expect(app).toContain('data-position-live="price"')
    expect(app).toContain('data-position-live="profit"')
  })

  it('keeps dashboard position cards aligned with AI trader cards on mobile', () => {
    expect(html).toContain('class="positions-table-wrap position-list-table-wrap hidden"')
    expect(html).toContain('class="table-wrap position-list-table-wrap"')
    expect(html).toContain('class="positions-table position-list-table"')
    expect(html).toContain('class="data-table position-list-table"')
    expect(responsiveCss).toContain('@media (max-width: 767px)')
    expect(responsiveCss).toContain('.position-list-table tbody')
    expect(responsiveCss).toContain('grid-template-columns: repeat(2, minmax(0, 1fr));')
    expect(responsiveCss).toContain('.position-list-table td[data-label="操作"]')
    expect(responsiveCss).toContain('min-height: 44px;')
  })

  it('keeps all three AI assets on one cache version', () => {
    const stylesheetVersion = html.match(/styles\.css\?v=([0-9a-z._-]+)/i)?.[1]
    const responsiveVersion = html.match(/responsive\.css\?v=([0-9a-z._-]+)/i)?.[1]
    const appVersion = html.match(/app\.js\?v=([0-9a-z._-]+)/i)?.[1]
    expect(stylesheetVersion).toBe('20260811historyperf3')
    expect(responsiveVersion).toBe(stylesheetVersion)
    expect(appVersion).toBe(stylesheetVersion)
  })
})
