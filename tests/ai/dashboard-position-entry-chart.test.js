import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'

const app = readFileSync(new URL('../../public/ai/app.js', import.meta.url), 'utf8')
const css = readFileSync(new URL('../../public/ai/styles.css', import.meta.url), 'utf8')

describe('dashboard current-position entry markers', () => {
  it('draws current-symbol entries as explicit gold arrows without persistent price lines or labels', () => {
    const syncStart = app.indexOf('function syncKlinePositionEntries()')
    const syncEnd = app.indexOf('function handleKlinePositionCrosshair', syncStart)
    const syncBlock = app.slice(syncStart, syncEnd)
    expect(app).toContain('function syncKlinePositionEntries()')
    expect(app).toContain('function klinePositionPriceDigits(position = {})')
    expect(app).toContain('klinePositionMatchesSymbol(position, symbol)')
    expect(app).toContain("const KLINE_POSITION_ENTRY_COLOR = '#d4af37'")
    expect(syncBlock).toContain('lineVisible:false')
    expect(syncBlock).toContain('pointMarkersVisible:false')
    expect(syncBlock).toContain('lastValueVisible:false')
    expect(syncBlock).toContain('if (!start.visible) continue;')
    expect(syncBlock).toContain('series.setData([{ time:markerTime, value:price }])')
    expect(syncBlock).toContain('series.setMarkers([{')
    expect(syncBlock).toContain("position:'inBar'")
    expect(syncBlock).toContain('color:KLINE_POSITION_ENTRY_COLOR')
    expect(syncBlock).toContain("shape:buy ? 'arrowUp' : 'arrowDown'")
    expect(syncBlock).toContain('size:1.5')
    expect(syncBlock).not.toContain('pointMarkersRadius')
    expect(syncBlock).not.toContain('LineStyle.Dashed')
    expect(syncBlock).not.toContain('title:`${direction}入场`')
    expect(app).toContain('syncKlinePositionEntries();')
  })

  it('shows volume details only when the crosshair is close to a visible entry point', () => {
    expect(app).toContain('function handleKlinePositionCrosshair(param)')
    expect(app).toContain('escapeHtml(volumeText(position.volume))')
    expect(app).toContain('Math.abs(param.point.y - coordinate) <= 12')
    expect(app).toContain("if (entryTime < candles[0].time) return { index:0, visible:false };")
    expect(css).toContain('.kline-position-tooltip')
    expect(css).toContain('pointer-events: none')
  })

  it('adds a readable non-canvas description for the current position markers', () => {
    expect(app).toContain("container.setAttribute('role', 'img')")
    expect(app).toContain("container.setAttribute('aria-label', markerSummary.length")
  })
})
