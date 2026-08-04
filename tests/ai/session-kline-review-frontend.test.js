import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'

const app = readFileSync(new URL('../../public/ai/app.js', import.meta.url), 'utf8')

describe('AI session and stale-data guards', () => {
  it('routes API 401 and browser websocket 4002 through one idempotent invalidation path', () => {
    expect(app).toContain('if (response.status === 401) invalidateSession()')
    expect(app).toContain('if (e.code === 4002) { invalidateSession(); return; }')
    expect(app).toContain('if (_sessionInvalidating) return false')
    expect(app).toContain("pending.reject(new Error('登录状态已失效'))")
    expect(app).toContain('window.AuthSession.clear()')
    expect(app).toContain('window.location.href = "/ai/auth/?mode=login"')
  })

  it('clears K-line candles, volume and position overlays and ignores stale rates responses', () => {
    const blockStart = app.indexOf('async function loadKlineData()')
    const blockEnd = app.indexOf('// Lightweight: fetch only the last bar', blockStart)
    const block = app.slice(blockStart, blockEnd)
    expect(app).toContain('function clearKlineData(status = \'暂无行情\', key = null)')
    expect(app).toContain("_klineSeries?.setData([])")
    expect(app).toContain("_klineVolumeSeries?.setData([])")
    expect(app).toContain("clearKlinePositionEntries()")
    expect(block).toContain('const requestVersion = ++_klineRequestVersion')
    expect(block).toContain('const isCurrentRequest = () => requestVersion === _klineRequestVersion')
    expect(block).toContain("clearKlineData(data?.status === 'success' ? '暂无行情' : '读取失败', requestKey)")
    expect(block).toContain("clearKlineData('读取失败', requestKey)")
    expect(app).toContain('if (!_klineSeries || !_klineDataAvailable || state.marketTradeMode === 0) return;')
  })

  it('keeps period-review detail errors and stale responses scoped to the selected request', () => {
    const start = app.indexOf('async function openPeriodReviewDetail')
    const end = app.indexOf('const memoryCategoryLabels', start)
    const block = app.slice(start, end)
    expect(app).toContain('reviewDetailRequestVersion: 0')
    expect(app).toContain('function periodReviewDetailErrorHtml(error)')
    expect(block).toContain('const requestVersion = ++state.reviewDetailRequestVersion')
    expect(block).toContain('Number(state.selectedReviewId) !== requestedId')
    expect(block).toContain('detail.innerHTML = periodReviewDetailErrorHtml(error)')
    expect(block).toContain('return null')
  })
})
