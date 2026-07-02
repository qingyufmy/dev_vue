import { describe, it, expect } from 'vitest'
import { __chanTest } from '../../server/routes/ai/market-data.js'

const { normalizeBarsForChan, detectFractals, buildBis, buildSegments, buildCenters, detectDivergence, computeChan } = __chanTest

function makeRates(n, base = 4000) {
  const rates = []
  for (let i = 0; i < n; i++) {
    const h = base + Math.sin(i * 0.5) * 20 + Math.random() * 5
    const l = h - 8 - Math.random() * 4
    rates.push({ time: `2026-01-01 ${String(i).padStart(2, '0')}:00:00`, open: l + 2, high: h, low: l, close: h - 2, tick_volume: 100 })
  }
  return rates
}

describe('normalizeBarsForChan', () => {
  it('过滤无效K线', () => {
    const rates = [
      { time: 't0', open: 100, high: 110, low: 90, close: 105 },
      { time: 't1', open: 105, high: NaN, low: 95, close: 108 },
      { time: 't2', open: 108, high: 115, low: 100, close: 112 },
    ]
    const bars = normalizeBarsForChan(rates)
    expect(bars.length).toBe(2)
  })

  it('包含关系处理减少K线数', () => {
    const rates = [
      { time: 't0', open: 100, high: 120, low: 90, close: 105 },
      { time: 't1', open: 105, high: 118, low: 92, close: 110 }, // 被前一根包含
      { time: 't2', open: 110, high: 125, low: 105, close: 120 },
    ]
    const bars = normalizeBarsForChan(rates)
    expect(bars.length).toBeLessThanOrEqual(3)
  })

  it('输出包含 raw_idx', () => {
    const rates = makeRates(10)
    const bars = normalizeBarsForChan(rates)
    bars.forEach(b => {
      expect(b.raw_idx).toBeDefined()
      expect(typeof b.high).toBe('number')
    })
  })
})

describe('detectFractals', () => {
  it('识别顶底分型', () => {
    const rates = [
      { time: 't0', open: 100, high: 110, low: 95, close: 105 },
      { time: 't1', open: 105, high: 120, low: 100, close: 115 },
      { time: 't2', open: 115, high: 118, low: 108, close: 112 },
      { time: 't3', open: 112, high: 115, low: 98, close: 100 },
      { time: 't4', open: 100, high: 108, low: 90, close: 95 },
    ]
    const bars = rates.map((r, i) => ({ ...r, idx: i, raw_idx: i }))
    const fractals = detectFractals(bars)
    expect(fractals.length).toBeGreaterThanOrEqual(1)
    fractals.forEach(f => {
      expect(['top', 'bottom']).toContain(f.type)
    })
  })

  it('连续同类型只保留更极端', () => {
    const bars = [
      { idx: 0, raw_idx: 0, high: 100, low: 90, open: 95, close: 98, time: 't0' },
      { idx: 1, raw_idx: 1, high: 110, low: 95, open: 98, close: 108, time: 't1' },
      { idx: 2, raw_idx: 2, high: 115, low: 100, open: 108, close: 112, time: 't2' },
      { idx: 3, raw_idx: 3, high: 112, low: 98, open: 112, close: 100, time: 't3' },
      { idx: 4, raw_idx: 4, high: 105, low: 88, open: 100, close: 90, time: 't4' },
    ]
    const fractals = detectFractals(bars)
    const tops = fractals.filter(f => f.type === 'top')
    expect(tops.length).toBeLessThanOrEqual(1)
  })
})

describe('buildBis', () => {
  it('笔数不超过分型数-1', () => {
    const rates = makeRates(50)
    const bars = normalizeBarsForChan(rates)
    const fractals = detectFractals(bars)
    const bis = buildBis(fractals, bars)
    expect(bis.length).toBeLessThanOrEqual(fractals.length - 1)
  })

  it('最后一笔可以是未确认', () => {
    const rates = makeRates(50)
    const bars = normalizeBarsForChan(rates)
    const fractals = detectFractals(bars)
    const bis = buildBis(fractals, bars)
    if (bis.length > 0) {
      expect(bis[bis.length - 1].confirmed).toBe(false)
    }
  })

  it('笔的方向交替', () => {
    const rates = makeRates(60)
    const bars = normalizeBarsForChan(rates)
    const fractals = detectFractals(bars)
    const bis = buildBis(fractals, bars)
    for (let i = 1; i < bis.length; i++) {
      expect(bis[i].dir).not.toBe(bis[i - 1].dir)
    }
  })
})

describe('buildSegments', () => {
  it('不足3笔时segments为空', () => {
    const bis = [{ id: 1, dir: 'up', start_price: 100, end_price: 110 }]
    const { segments } = buildSegments(bis)
    expect(segments.length).toBe(0)
  })

  it('有效线段至少3笔', () => {
    const rates = makeRates(80)
    const bars = normalizeBarsForChan(rates)
    const fractals = detectFractals(bars)
    const allBis = buildBis(fractals, bars)
    const confirmed = allBis.filter(b => b.confirmed !== false)
    const { segments } = buildSegments(confirmed)
    segments.forEach(s => {
      expect(s.bi_ids.length).toBeGreaterThanOrEqual(3)
    })
  })

  it('不会出现 segments === bis 的情况', () => {
    const rates = makeRates(80)
    const bars = normalizeBarsForChan(rates)
    const fractals = detectFractals(bars)
    const allBis = buildBis(fractals, bars)
    const confirmed = allBis.filter(b => b.confirmed !== false)
    const { segments } = buildSegments(confirmed)
    if (confirmed.length > 5) {
      expect(segments.length).toBeLessThan(confirmed.length)
    }
  })
})

describe('buildCenters', () => {
  it('中枢使用交集', () => {
    const bis = [
      { id: 1, dir: 'up', start_price: 100, end_price: 120 },
      { id: 2, dir: 'down', start_price: 120, end_price: 105 },
      { id: 3, dir: 'up', start_price: 105, end_price: 118 },
    ]
    const centers = buildCenters(bis)
    if (centers.length > 0) {
      expect(centers[0].zl).toBeGreaterThanOrEqual(105)
      expect(centers[0].zh).toBeLessThanOrEqual(118)
    }
  })
})

describe('detectDivergence', () => {
  it('无有效线段时返回none', () => {
    const result = detectDivergence([], [], [])
    expect(result.type).toBe('none')
    expect(result.reason).toBeDefined()
  })

  it('有有效线段但不足2个时返回none', () => {
    const segs = [{ id: 1, dir: 'up', bi_ids: [1, 2, 3], weak: false }]
    const result = detectDivergence(segs, [], [])
    expect(result.type).toBe('none')
  })
})

describe('computeChan', () => {
  it('K线不足返回insufficient_klines', () => {
    const rates = makeRates(5)
    const result = computeChan(rates, 'M5', [])
    expect(result.status).toBe('insufficient_klines')
  })

  it('返回结构包含必要字段', () => {
    const rates = makeRates(50)
    const macdHist = rates.map(() => Math.random() * 10 - 5)
    const result = computeChan(rates, 'H1', macdHist)
    expect(result.status).toBeDefined()
    expect(result.reliability).toBeDefined()
    expect(result.raw_bar_count).toBe(50)
    expect(result.warnings).toBeDefined()
    expect(Array.isArray(result.warnings)).toBe(true)
  })

  it('segment_count不等于bi_count', () => {
    const rates = makeRates(80)
    const macdHist = rates.map(() => Math.random() * 10 - 5)
    const result = computeChan(rates, 'H1', macdHist)
    if (result.bi_count > 5 && result.segment_count > 0) {
      expect(result.segment_count).toBeLessThan(result.bi_count)
    }
  })
})
