import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'

const app = readFileSync(new URL('../../public/ai/app.js', import.meta.url), 'utf8')
const css = readFileSync(new URL('../../public/ai/styles.css', import.meta.url), 'utf8')

describe('dashboard current-position entry markers', () => {
  it('draws current-symbol positions at their entry price and entry candle', () => {
    expect(app).toContain('function syncKlinePositionEntries()')
    expect(app).toContain('function klinePositionPriceDigits(position = {})')
    expect(app).toContain('klinePositionMatchesSymbol(position, symbol)')
    expect(app).toContain("title:`${direction}入场`")
    expect(app).toContain("shape:buy ? 'arrowUp' : 'arrowDown'")
    expect(app).toContain("series.setData(_klineCandles.slice(start.index)")
    expect(app).toContain('syncKlinePositionEntries();')
  })

  it('shows volume details on crosshair hover without misplacing older entries', () => {
    expect(app).toContain('function handleKlinePositionCrosshair(param)')
    expect(app).toContain('escapeHtml(volumeText(position.volume))')
    expect(app).toContain("entryVisible ? '' : ' · 早于图表范围'")
    expect(app).toContain("if (entryTime < candles[0].time) return { index:0, visible:false };")
    expect(css).toContain('.kline-position-tooltip')
    expect(css).toContain('pointer-events: none')
  })

  it('adds a readable non-canvas description for the current position markers', () => {
    expect(app).toContain("container.setAttribute('role', 'img')")
    expect(app).toContain("container.setAttribute('aria-label', markerSummary.length")
  })
})
