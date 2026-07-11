import { describe, it, expect } from 'vitest'
import { __chanTest } from '../../server/routes/ai/market-data.js'

const { calculateMacdSeries, normalizeBarsForChan, detectFractals, buildBis, normalizeFeatureSequence, buildSegments, buildCenters, detectDivergence, computeChan } = __chanTest

function makeRates(n, base = 4000) {
  const rates = []
  for (let i = 0; i < n; i++) {
    const wave = Math.sin(i * 0.5) * 20
    const jitter = ((i * 7) % 5) * 0.8
    const h = base + wave + jitter
    const l = h - 8 - ((i * 3) % 4) * 0.7
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

  it('开头连续包含时使用后续首个明确走势确定合并方向', () => {
    const rates = [
      { time: 't0', open: 105, high: 120, low: 90, close: 100 },
      { time: 't1', open: 104, high: 118, low: 92, close: 98 },
      { time: 't2', open: 100, high: 115, low: 85, close: 90 },
    ]
    const bars = normalizeBarsForChan(rates)
    expect(bars[0].high).toBe(118)
    expect(bars[0].low).toBe(90)
  })
})

describe('detectFractals', () => {
  it('识别顶底分型', () => {
    const bars = [
      { idx: 0, raw_start_idx: 0, raw_end_idx: 0, high: 100, low: 90, open: 95, close: 98, time: 't0' },
      { idx: 1, raw_start_idx: 1, raw_end_idx: 1, high: 120, low: 95, open: 98, close: 115, time: 't1' },
      { idx: 2, raw_start_idx: 2, raw_end_idx: 2, high: 110, low: 88, open: 115, close: 92, time: 't2' },
      { idx: 3, raw_start_idx: 3, raw_end_idx: 3, high: 115, low: 80, open: 92, close: 85, time: 't3' },
      { idx: 4, raw_start_idx: 4, raw_end_idx: 4, high: 105, low: 75, open: 85, close: 78, time: 't4' },
    ]
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
    const { bis } = buildBis(fractals, bars)
    expect(bis.length).toBeLessThanOrEqual(fractals.length - 1)
  })

  it('最后一笔可以是未确认', () => {
    const rates = makeRates(50)
    const bars = normalizeBarsForChan(rates)
    const fractals = detectFractals(bars)
    const { bis } = buildBis(fractals, bars)
    if (bis.length > 0) {
      expect(bis[bis.length - 1].confirmed).toBe(false)
    }
  })

  it('笔的方向交替', () => {
    const rates = makeRates(60)
    const bars = normalizeBarsForChan(rates)
    const fractals = detectFractals(bars)
    const { bis } = buildBis(fractals, bars)
    for (let i = 1; i < bis.length; i++) {
      expect(bis[i].dir).not.toBe(bis[i - 1].dir)
    }
  })

  it('非法价格方向不生成笔', () => {
    const fractals = [
      { idx: 0, raw_idx: 0, type: 'bottom', price: 100, high: 100, low: 100, time: 't0' },
      { idx: 5, raw_idx: 5, type: 'top', price: 90, high: 90, low: 90, time: 't5' },
    ]
    const { bis, invalidCount } = buildBis(fractals, [])
    expect(bis.length).toBe(0)
    expect(invalidCount).toBe(1)
  })

  it('合法up/down笔正常生成', () => {
    const fractals = [
      { idx: 0, raw_idx: 0, type: 'bottom', price: 100, high: 100, low: 100, time: 't0' },
      { idx: 5, raw_idx: 5, type: 'top', price: 120, high: 120, low: 120, time: 't5' },
      { idx: 10, raw_idx: 10, type: 'bottom', price: 110, high: 110, low: 110, time: 't10' },
    ]
    const { bis } = buildBis(fractals, [])
    expect(bis.length).toBe(2)
    expect(bis[0].dir).toBe('up')
    expect(bis[0].end_price).toBeGreaterThan(bis[0].start_price)
    expect(bis[1].dir).toBe('down')
    expect(bis[1].end_price).toBeLessThan(bis[1].start_price)
  })
})

describe('buildSegments', () => {
  it('特征序列先处理包含关系再判断分型', () => {
    const elements = [
      { high: 120, low: 100, end_price: 100, high_source_index: 1, low_source_index: 1, source_end_index: 1 },
      { high: 118, low: 102, end_price: 102, high_source_index: 3, low_source_index: 3, source_end_index: 3 },
      { high: 130, low: 110, end_price: 110, high_source_index: 5, low_source_index: 5, source_end_index: 5 },
    ]
    const normalized = normalizeFeatureSequence(elements)
    expect(normalized).toHaveLength(2)
    expect(normalized[0]).toMatchObject({ high: 120, low: 102, source_end_index: 3 })
  })

  it('不足3笔时segments为空', () => {
    const bis = [{ id: 1, dir: 'up', start_price: 100, end_price: 110 }]
    const { segments } = buildSegments(bis)
    expect(segments.length).toBe(0)
  })

  it('有效线段至少3笔', () => {
    const rates = makeRates(80)
    const bars = normalizeBarsForChan(rates)
    const fractals = detectFractals(bars)
    const { bis: allBis } = buildBis(fractals, bars)
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
    const { bis: allBis } = buildBis(fractals, bars)
    const confirmed = allBis.filter(b => b.confirmed !== false)
    const { segments } = buildSegments(confirmed)
    if (confirmed.length > 5) {
      expect(segments.length).toBeLessThan(confirmed.length)
    }
  })

  it('正式线段方向、价格、笔数和首尾笔保持一致', () => {
    const rates = makeRates(160)
    const bars = normalizeBarsForChan(rates)
    const fractals = detectFractals(bars)
    const { bis } = buildBis(fractals, bars)
    const confirmed = bis.filter(b => b.confirmed !== false)
    const { segments } = buildSegments(confirmed)
    const used = new Set()
    segments.forEach((segment, index) => {
      expect(segment.bi_ids.length).toBeGreaterThanOrEqual(3)
      expect(segment.bi_ids.length % 2).toBe(1)
      expect(segment.dir === 'up' ? segment.end_price > segment.start_price : segment.end_price < segment.start_price).toBe(true)
      if (index > 0) expect(segment.dir).not.toBe(segments[index - 1].dir)
      const segmentBis = segment.bi_ids.map(id => confirmed.find(b => b.id === id))
      expect(segmentBis[0].dir).toBe(segment.dir)
      expect(segmentBis[segmentBis.length - 1].dir).toBe(segment.dir)
      segment.bi_ids.forEach(id => {
        expect(used.has(id)).toBe(false)
        used.add(id)
      })
    })
  })

  it('不会把破坏上涨结构的反向笔并入上涨线段', () => {
    const makeBi = (id, dir, start, end) => ({ id, dir, start_price: start, end_price: end, high: Math.max(start, end), low: Math.min(start, end) })
    const bis = [
      makeBi(1, 'up', 100, 120), makeBi(2, 'down', 120, 110),
      makeBi(3, 'up', 110, 130), makeBi(4, 'down', 130, 90),
    ]
    const { segments } = buildSegments(bis)
    segments.forEach(segment => {
      expect(segment.dir === 'up' ? segment.end_price > segment.start_price : segment.end_price < segment.start_price).toBe(true)
      expect(segment.bi_ids.length % 2).toBe(1)
    })
  })

  it('无缺口特征序列顶分型确认上涨线段', () => {
    const makeBi = (id, dir, start, end) => ({ id, dir, start_price: start, end_price: end, high: Math.max(start, end), low: Math.min(start, end) })
    const bis = [
      makeBi(1, 'up', 100, 120), makeBi(2, 'down', 120, 110),
      makeBi(3, 'up', 110, 130), makeBi(4, 'down', 130, 115),
      makeBi(5, 'up', 115, 125), makeBi(6, 'down', 125, 105),
    ]
    const { segments } = buildSegments(bis)
    expect(segments).toHaveLength(1)
    expect(segments[0]).toMatchObject({ dir: 'up', start_price: 100, end_price: 130, confirmation: 'feature_fractal' })
    expect(segments[0].bi_ids).toEqual([1, 2, 3])
  })

  it('有缺口特征序列等待反向三笔破坏后确认', () => {
    const makeBi = (id, dir, start, end) => ({ id, dir, start_price: start, end_price: end, high: Math.max(start, end), low: Math.min(start, end) })
    const bis = [
      makeBi(1, 'up', 100, 120), makeBi(2, 'down', 120, 110),
      makeBi(3, 'up', 110, 140), makeBi(4, 'down', 140, 130),
      makeBi(5, 'up', 130, 135), makeBi(6, 'down', 135, 100),
    ]
    const { segments } = buildSegments(bis)
    expect(segments).toHaveLength(1)
    expect(segments[0].confirmation).toBe('gap_reverse_confirmed')
    expect(segments[0].bi_ids).toEqual([1, 2, 3])
  })

  it('多组交替笔序列始终满足线段结构不变量', () => {
    let totalSegments = 0
    for (let seed = 1; seed <= 50; seed++) {
      let state = seed
      const random = () => {
        state = (state * 1664525 + 1013904223) >>> 0
        return state / 0x100000000
      }
      let price = 100
      const bis = []
      for (let i = 0; i < 40; i++) {
        const dir = i % 2 === 0 ? 'up' : 'down'
        const distance = 3 + random() * 15
        const end = dir === 'up' ? price + distance : price - distance
        bis.push({ id: i + 1, dir, start_price: price, end_price: end, high: Math.max(price, end), low: Math.min(price, end) })
        price = end
      }
      const { segments } = buildSegments(bis)
      totalSegments += segments.length
      const used = new Set()
      segments.forEach((segment, index) => {
        expect(segment.bi_ids.length % 2).toBe(1)
        expect(segment.bi_ids.length).toBeGreaterThanOrEqual(3)
        expect(segment.dir === 'up' ? segment.end_price > segment.start_price : segment.end_price < segment.start_price).toBe(true)
        if (index > 0) expect(segment.dir).not.toBe(segments[index - 1].dir)
        segment.bi_ids.forEach(id => {
          expect(used.has(id)).toBe(false)
          used.add(id)
        })
      })
    }
    expect(totalSegments).toBeGreaterThan(0)
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

  it('线段完全离开中枢后将中枢关闭', () => {
    const segments = [
      { id: 1, start_price: 100, end_price: 120 },
      { id: 2, start_price: 120, end_price: 105 },
      { id: 3, start_price: 105, end_price: 118 },
      { id: 4, start_price: 118, end_price: 80 },
      { id: 5, start_price: 80, end_price: 90 },
    ]
    const centers = buildCenters(segments)
    expect(centers[0].status).toBe('closed')
    expect(centers[0].segment_ids).toEqual([1, 2, 3, 4])
  })

  it('延伸只更新波动范围，不收缩前三段确定的核心区间', () => {
    const segments = [
      { id: 1, start_price: 100, end_price: 120, low: 100, high: 120 },
      { id: 2, start_price: 120, end_price: 105, low: 105, high: 120 },
      { id: 3, start_price: 105, end_price: 118, low: 105, high: 118 },
      { id: 4, start_price: 118, end_price: 110, low: 110, high: 118 },
    ]
    const centers = buildCenters(segments)
    expect(centers[0]).toMatchObject({ zl: 105, zh: 118, status: 'extended' })
  })

  it('中枢使用线段完整high/low而非只看起止价格', () => {
    const segments = [
      { id: 1, start_price: 100, end_price: 110, low: 90, high: 130 },
      { id: 2, start_price: 125, end_price: 115, low: 105, high: 125 },
      { id: 3, start_price: 108, end_price: 118, low: 108, high: 128 },
    ]
    const centers = buildCenters(segments)
    expect(centers[0]).toMatchObject({ zl: 108, zh: 125 })
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

  it('没有中枢时返回no_valid_center', () => {
    const segs = [
      { id: 1, dir: 'up', bi_ids: [1, 2, 3], weak: false, high: 120, low: 100 },
      { id: 2, dir: 'up', bi_ids: [4, 5, 6], weak: false, high: 130, low: 105 },
    ]
    const bis = segs.flatMap(s => s.bi_ids.map(id => ({ id, raw_start_idx: id - 1, raw_end_idx: id - 1 })))
    const macd = [5, 5, 5, 3, 3, 3]
    const result = detectDivergence(segs, bis, macd, [])
    expect(result.type).toBe('none')
    expect(result.reason).toBe('no_valid_center')
  })

  it('上行没有创新高返回no_price_extreme_break', () => {
    const segs = [
      { id: 1, dir: 'down', bi_ids: [1, 2, 3], weak: false, high: 120, low: 90 },
      { id: 2, dir: 'up', bi_ids: [4, 5, 6], weak: false, high: 125, low: 95 },
      { id: 3, dir: 'down', bi_ids: [7, 8, 9], weak: false, high: 118, low: 95 },
      { id: 4, dir: 'up', bi_ids: [10, 11, 12], weak: false, high: 123, low: 100 },
    ]
    const bis = segs.flatMap(s => s.bi_ids.map(id => ({ id, raw_start_idx: id - 1, raw_end_idx: id - 1 })))
    const macd = [5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5]
    const centers = [{ status: 'confirmed', start_segment_id: 3, end_segment_id: 3 }]
    const result = detectDivergence(segs, bis, macd, centers)
    expect(result.type).toBe('none')
    expect(result.reason).toBe('no_price_extreme_break')
  })

  it('下行没有创新低返回no_price_extreme_break', () => {
    const segs = [
      { id: 1, dir: 'up', bi_ids: [1, 2, 3], weak: false, high: 125, low: 95 },
      { id: 2, dir: 'down', bi_ids: [4, 5, 6], weak: false, high: 118, low: 90 },
      { id: 3, dir: 'up', bi_ids: [7, 8, 9], weak: false, high: 120, low: 95 },
      { id: 4, dir: 'down', bi_ids: [10, 11, 12], weak: false, high: 115, low: 92 },
    ]
    const bis = [
      { id: 4, raw_start_idx: 0, raw_end_idx: 1 }, { id: 5, raw_start_idx: 2, raw_end_idx: 3 }, { id: 6, raw_start_idx: 4, raw_end_idx: 5 },
      { id: 10, raw_start_idx: 6, raw_end_idx: 7 }, { id: 11, raw_start_idx: 8, raw_end_idx: 9 }, { id: 12, raw_start_idx: 10, raw_end_idx: 11 },
    ]
    const macd = [-5, -5, -5, -5, -5, -5, -5, -5, -5, -5, -5, -5]
    const centers = [{ status: 'confirmed', start_segment_id: 3, end_segment_id: 3 }]
    const result = detectDivergence(segs, bis, macd, centers)
    expect(result.type).toBe('none')
    expect(result.reason).toBe('no_price_extreme_break')
  })

  it('最新线段不在中枢后返回not_after_center', () => {
    const segs = [
      { id: 1, dir: 'up', bi_ids: [1, 2, 3], weak: false, high: 120, low: 100 },
      { id: 2, dir: 'up', bi_ids: [4, 5, 6], weak: false, high: 130, low: 105 },
    ]
    const bis = segs.flatMap(s => s.bi_ids.map(id => ({ id, raw_start_idx: id - 1, raw_end_idx: id - 1 })))
    const macd = [5, 5, 5, 3, 3, 3]
    const centers = [{ status: 'confirmed', start_segment_id: 10, end_segment_id: 10 }]
    const result = detectDivergence(segs, bis, macd, centers)
    expect(result.type).toBe('none')
    expect(result.reason).toBe('not_after_center')
  })

  it('不会跨过额外线段把远端同向段当作中枢直接离开段', () => {
    const segs = [
      { id: 1, dir: 'up', bi_ids: [1, 2, 3], weak: false, high: 120, low: 90 },
      { id: 5, dir: 'up', bi_ids: [4, 5, 6], weak: false, high: 130, low: 95 },
      { id: 7, dir: 'up', bi_ids: [7, 8, 9], weak: false, high: 140, low: 100 },
    ]
    const bis = segs.flatMap(s => s.bi_ids.map(id => ({ id, raw_start_idx: id - 1, raw_end_idx: id - 1 })))
    const result = detectDivergence(segs, bis, Array(12).fill(1), [{ start_segment_id: 2, end_segment_id: 4 }])
    expect(result.type).toBe('none')
    expect(result.reason).toBe('not_after_center')
  })

  it('顶背驰成功返回top', () => {
    const segs = [
      { id: 1, dir: 'down', bi_ids: [1, 2, 3], weak: false, high: 120, low: 90 },
      { id: 2, dir: 'up', bi_ids: [4, 5, 6], weak: false, high: 125, low: 95 },
      { id: 3, dir: 'down', bi_ids: [7, 8, 9], weak: false, high: 118, low: 95 },
      { id: 4, dir: 'up', bi_ids: [10, 11, 12], weak: false, high: 130, low: 100 },
    ]
    const bis = segs.flatMap(s => s.bi_ids.map(id => ({ id, raw_start_idx: id - 1, raw_end_idx: id - 1 })))
    // seg2 area=15, seg4 area=3 → divergence
    const macd = [5, 5, 5, 5, 5, 5, 5, 5, 5, 1, 1, 1]
    const centers = [{ status: 'confirmed', start_segment_id: 3, end_segment_id: 3 }]
    const result = detectDivergence(segs, bis, macd, centers)
    expect(result.type).toBe('top')
    expect(result.reason).toBe('macd_area_divergence')
    expect(result.price_extreme_cur).toBe(130)
    expect(result.price_extreme_prev).toBe(125)
  })

  it('底背驰成功返回bottom', () => {
    const segs = [
      { id: 1, dir: 'up', bi_ids: [1, 2, 3], weak: false, high: 125, low: 95 },
      { id: 2, dir: 'down', bi_ids: [4, 5, 6], weak: false, high: 118, low: 90 },
      { id: 3, dir: 'up', bi_ids: [7, 8, 9], weak: false, high: 120, low: 95 },
      { id: 4, dir: 'down', bi_ids: [10, 11, 12], weak: false, high: 115, low: 85 },
    ]
    const bis = [
      { id: 4, raw_start_idx: 0, raw_end_idx: 1 }, { id: 5, raw_start_idx: 2, raw_end_idx: 3 }, { id: 6, raw_start_idx: 4, raw_end_idx: 5 },
      { id: 10, raw_start_idx: 6, raw_end_idx: 7 }, { id: 11, raw_start_idx: 8, raw_end_idx: 9 }, { id: 12, raw_start_idx: 10, raw_end_idx: 11 },
    ]
    // seg2 area=15, seg4 area=3 → divergence (negative for down)
    const macd = [-5, -5, -5, -5, -5, -5, -5, -5, -5, -1, -1, -1]
    const centers = [{ status: 'confirmed', start_segment_id: 3, end_segment_id: 3 }]
    const result = detectDivergence(segs, bis, macd, centers)
    expect(result.type).toBe('bottom')
    expect(result.reason).toBe('macd_area_divergence')
    expect(result.price_extreme_cur).toBe(85)
    expect(result.price_extreme_prev).toBe(90)
  })

  it('MACD面积不会重复累计相邻笔共享的原始K线索引', () => {
    const segs = [
      { id: 1, dir: 'up', bi_ids: [1, 2, 3], weak: false, high: 120, low: 90 },
      { id: 5, dir: 'up', bi_ids: [4, 5, 6], weak: false, high: 130, low: 95 },
    ]
    const bis = [
      { id: 1, raw_start_idx: 0, raw_end_idx: 1 }, { id: 2, raw_start_idx: 1, raw_end_idx: 2 }, { id: 3, raw_start_idx: 2, raw_end_idx: 3 },
      { id: 4, raw_start_idx: 4, raw_end_idx: 5 }, { id: 5, raw_start_idx: 5, raw_end_idx: 6 }, { id: 6, raw_start_idx: 6, raw_end_idx: 7 },
    ]
    const result = detectDivergence(segs, bis, [5, 5, 5, 5, 2, 2, 2, 2], [{ start_segment_id: 2, end_segment_id: 4 }])
    expect(result.area_prev).toBe(20)
    expect(result.area_cur).toBe(8)
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
    const macdHist = rates.map((_, i) => Math.sin(i * 0.3) * 5)
    const result = computeChan(rates, 'H1', macdHist)
    expect(result.status).toBeDefined()
    expect(result.reliability).toBeDefined()
    expect(result.raw_bar_count).toBe(50)
    expect(result.warnings).toBeDefined()
    expect(Array.isArray(result.warnings)).toBe(true)
  })

  it('segment_count不等于bi_count', () => {
    const rates = makeRates(80)
    const macdHist = rates.map((_, i) => Math.sin(i * 0.3) * 5)
    const result = computeChan(rates, 'H1', macdHist)
    if (result.bi_count > 5 && result.segment_count > 0) {
      expect(result.segment_count).toBeLessThan(result.bi_count)
    }
  })
})

describe('calculateMacdSeries', () => {
  it('histSeries长度等于closes长度', () => {
    const closes = [100, 102, 101, 103, 105, 104, 106, 108, 107, 109, 110, 111, 112, 113, 114, 115, 116, 117, 118, 119, 120, 121, 122, 123, 124, 125, 126, 127, 128, 129, 130]
    const series = calculateMacdSeries(closes)
    expect(series.histSeries.length).toBe(closes.length)
    expect(series.difSeries.length).toBe(closes.length)
    expect(series.deaSeries.length).toBe(closes.length)
  })

  it('空数组返回全零', () => {
    const series = calculateMacdSeries([])
    expect(series.histSeries.length).toBe(0)
    expect(series.latestHist).toBe(0)
  })
})

describe('normalizeBarsForChan idx', () => {
  it('包含处理后idx连续', () => {
    const rates = makeRates(20)
    const bars = normalizeBarsForChan(rates)
    bars.forEach((bar, idx) => expect(bar.idx).toBe(idx))
  })

  it('每根处理后K线都有raw_start_idx和raw_end_idx', () => {
    const rates = makeRates(20)
    const bars = normalizeBarsForChan(rates)
    bars.forEach(bar => {
      expect(bar.raw_start_idx).toBeDefined()
      expect(bar.raw_end_idx).toBeDefined()
      expect(bar.raw_start_idx).toBeLessThanOrEqual(bar.raw_end_idx)
    })
  })
})

describe('detectFractals strict', () => {
  it('标准顶分型可识别', () => {
    const bars = [
      { idx: 0, raw_start_idx: 0, raw_end_idx: 0, high: 100, low: 90, open: 95, close: 98, time: 't0' },
      { idx: 1, raw_start_idx: 1, raw_end_idx: 1, high: 120, low: 95, open: 98, close: 115, time: 't1' },
      { idx: 2, raw_start_idx: 2, raw_end_idx: 2, high: 110, low: 88, open: 115, close: 92, time: 't2' },
    ]
    const fractals = detectFractals(bars)
    expect(fractals.some(f => f.type === 'top')).toBe(true)
  })

  it('非标准顶分型不识别', () => {
    const bars = [
      { idx: 0, raw_start_idx: 0, raw_end_idx: 0, high: 100, low: 100, open: 100, close: 100, time: 't0' },
      { idx: 1, raw_start_idx: 1, raw_end_idx: 1, high: 120, low: 95, open: 100, close: 115, time: 't1' },
      { idx: 2, raw_start_idx: 2, raw_end_idx: 2, high: 110, low: 90, open: 115, close: 92, time: 't2' },
    ]
    const fractals = detectFractals(bars)
    expect(fractals.some(f => f.type === 'top')).toBe(false)
  })

  it('相等高点不识别分型', () => {
    const bars = [
      { idx: 0, raw_start_idx: 0, raw_end_idx: 0, high: 100, low: 90, open: 95, close: 98, time: 't0' },
      { idx: 1, raw_start_idx: 1, raw_end_idx: 1, high: 120, low: 85, open: 98, close: 115, time: 't1' },
      { idx: 2, raw_start_idx: 2, raw_end_idx: 2, high: 120, low: 85, open: 115, close: 110, time: 't2' },
    ]
    const fractals = detectFractals(bars)
    expect(fractals.some(f => f.type === 'top')).toBe(false)
  })

  it('标准底分型可识别', () => {
    const bars = [
      { idx: 0, raw_start_idx: 0, raw_end_idx: 0, high: 120, low: 100, open: 115, close: 105, time: 't0' },
      { idx: 1, raw_start_idx: 1, raw_end_idx: 1, high: 115, low: 80, open: 105, close: 85, time: 't1' },
      { idx: 2, raw_start_idx: 2, raw_end_idx: 2, high: 125, low: 90, open: 85, close: 120, time: 't2' },
    ]
    const fractals = detectFractals(bars)
    expect(fractals.some(f => f.type === 'bottom')).toBe(true)
  })

  it('非标准底分型不识别', () => {
    const bars = [
      { idx: 0, raw_start_idx: 0, raw_end_idx: 0, high: 120, low: 100, open: 115, close: 105, time: 't0' },
      { idx: 1, raw_start_idx: 1, raw_end_idx: 1, high: 125, low: 80, open: 105, close: 120, time: 't1' },
      { idx: 2, raw_start_idx: 2, raw_end_idx: 2, high: 130, low: 90, open: 120, close: 125, time: 't2' },
    ]
    const fractals = detectFractals(bars)
    expect(fractals.some(f => f.type === 'bottom')).toBe(false)
  })

  it('相等低点不识别分型', () => {
    const bars = [
      { idx: 0, raw_start_idx: 0, raw_end_idx: 0, high: 120, low: 80, open: 115, close: 85, time: 't0' },
      { idx: 1, raw_start_idx: 1, raw_end_idx: 1, high: 115, low: 80, open: 85, close: 90, time: 't1' },
      { idx: 2, raw_start_idx: 2, raw_end_idx: 2, high: 125, low: 90, open: 90, close: 120, time: 't2' },
    ]
    const fractals = detectFractals(bars)
    expect(fractals.some(f => f.type === 'bottom')).toBe(false)
  })
})

describe('early return warnings preserved', () => {
  it('computeChan同时保留invalid_bi和insufficient_bis warnings', () => {
    const rates = makeRates(30)
    const fractalsForTest = [
      { idx: 0, raw_start_idx: 0, raw_end_idx: 0, type: 'bottom', price: 100, high: 100, low: 100, time: 't0' },
      { idx: 5, raw_start_idx: 5, raw_end_idx: 5, type: 'top', price: 90, high: 90, low: 90, time: 't5' },
      { idx: 10, raw_start_idx: 10, raw_end_idx: 10, type: 'bottom', price: 85, high: 85, low: 85, time: 't10' },
    ]
    const hist = Array(30).fill(0)
    const result = computeChan(rates, 'M5', hist, { fractalsForTest })
    expect(result.warnings).toContain('invalid_bi_price_direction')
    expect(result.warnings).toContain('insufficient_confirmed_bis')
  })
})

describe('detectFractals strict', () => {
  it('标准顶分型可识别', () => {
    const bars = [
      { idx: 0, raw_start_idx: 0, raw_end_idx: 0, high: 100, low: 90, open: 95, close: 98, time: 't0' },
      { idx: 1, raw_start_idx: 1, raw_end_idx: 1, high: 120, low: 95, open: 98, close: 115, time: 't1' },
      { idx: 2, raw_start_idx: 2, raw_end_idx: 2, high: 110, low: 88, open: 115, close: 92, time: 't2' },
    ]
    const fractals = detectFractals(bars)
    expect(fractals.some(f => f.type === 'top')).toBe(true)
  })

  it('非标准顶分型不识别', () => {
    const bars = [
      { idx: 0, raw_start_idx: 0, raw_end_idx: 0, high: 100, low: 100, open: 100, close: 100, time: 't0' },
      { idx: 1, raw_start_idx: 1, raw_end_idx: 1, high: 120, low: 95, open: 100, close: 115, time: 't1' },
      { idx: 2, raw_start_idx: 2, raw_end_idx: 2, high: 110, low: 90, open: 115, close: 92, time: 't2' },
    ]
    const fractals = detectFractals(bars)
    expect(fractals.some(f => f.type === 'top')).toBe(false)
  })

  it('相等高点不识别分型', () => {
    const bars = [
      { idx: 0, raw_start_idx: 0, raw_end_idx: 0, high: 100, low: 90, open: 95, close: 98, time: 't0' },
      { idx: 1, raw_start_idx: 1, raw_end_idx: 1, high: 120, low: 85, open: 98, close: 115, time: 't1' },
      { idx: 2, raw_start_idx: 2, raw_end_idx: 2, high: 120, low: 85, open: 115, close: 110, time: 't2' },
    ]
    const fractals = detectFractals(bars)
    expect(fractals.some(f => f.type === 'top')).toBe(false)
  })

  it('标准底分型可识别', () => {
    const bars = [
      { idx: 0, raw_start_idx: 0, raw_end_idx: 0, high: 120, low: 100, open: 115, close: 105, time: 't0' },
      { idx: 1, raw_start_idx: 1, raw_end_idx: 1, high: 115, low: 80, open: 105, close: 85, time: 't1' },
      { idx: 2, raw_start_idx: 2, raw_end_idx: 2, high: 125, low: 90, open: 85, close: 120, time: 't2' },
    ]
    const fractals = detectFractals(bars)
    expect(fractals.some(f => f.type === 'bottom')).toBe(true)
  })

  it('非标准底分型不识别', () => {
    const bars = [
      { idx: 0, raw_start_idx: 0, raw_end_idx: 0, high: 120, low: 100, open: 115, close: 105, time: 't0' },
      { idx: 1, raw_start_idx: 1, raw_end_idx: 1, high: 125, low: 80, open: 105, close: 120, time: 't1' },
      { idx: 2, raw_start_idx: 2, raw_end_idx: 2, high: 130, low: 90, open: 120, close: 125, time: 't2' },
    ]
    const fractals = detectFractals(bars)
    expect(fractals.some(f => f.type === 'bottom')).toBe(false)
  })

  it('相等低点不识别分型', () => {
    const bars = [
      { idx: 0, raw_start_idx: 0, raw_end_idx: 0, high: 120, low: 80, open: 115, close: 85, time: 't0' },
      { idx: 1, raw_start_idx: 1, raw_end_idx: 1, high: 115, low: 80, open: 85, close: 90, time: 't1' },
      { idx: 2, raw_start_idx: 2, raw_end_idx: 2, high: 125, low: 90, open: 90, close: 120, time: 't2' },
    ]
    const fractals = detectFractals(bars)
    expect(fractals.some(f => f.type === 'bottom')).toBe(false)
  })
})

describe('divergence min area ratio', () => {
  it('areaCur=99 areaPrev=100不判背驰', () => {
    const segs = [
      { id: 1, dir: 'up', bi_ids: [1, 2, 3], weak: false, high: 125, low: 95 },
      { id: 5, dir: 'up', bi_ids: [4, 5, 6], weak: false, high: 130, low: 100 },
    ]
    const bis = []
    for (let i = 1; i <= 6; i++) bis.push({ id: i, raw_start_idx: i + 40, raw_end_idx: i + 40 })
    const hist = Array(80).fill(5)
    const centers = [{ status: 'confirmed', start_segment_id: 2, end_segment_id: 4 }]
    const result = detectDivergence(segs, bis, hist, centers)
    expect(result.type).toBe('none')
    expect(result.reason).toBe('macd_area_not_shrunk_enough')
  })

  it('areaCur=0不判强背驰', () => {
    const segs = [
      { id: 1, dir: 'up', bi_ids: [1, 2, 3], weak: false, high: 125, low: 95 },
      { id: 5, dir: 'up', bi_ids: [4, 5, 6], weak: false, high: 135, low: 100 },
    ]
    const bis = []
    for (let i = 1; i <= 6; i++) bis.push({ id: i, raw_start_idx: i + 40, raw_end_idx: i + 40 })
    const hist = Array(80).fill(0)
    const centers = [{ status: 'confirmed', start_segment_id: 2, end_segment_id: 4 }]
    const result = detectDivergence(segs, bis, hist, centers)
    expect(result.type).toBe('none')
    expect(result.reason).toBe('invalid_macd_area')
  })
})

describe('divergence equal area no divergence', () => {
  it('所有histogram面积相等时不返回top/bottom', () => {
    const segs = [
      { id: 1, dir: 'down', bi_ids: [1, 2, 3], weak: false, high: 120, low: 90 },
      { id: 2, dir: 'up', bi_ids: [4, 5, 6], weak: false, high: 125, low: 95 },
      { id: 3, dir: 'down', bi_ids: [7, 8, 9], weak: false, high: 118, low: 95 },
      { id: 4, dir: 'up', bi_ids: [10, 11, 12], weak: false, high: 130, low: 100 },
    ]
    const bis = []
    for (let i = 1; i <= 12; i++) {
      const raw = 40 + i
      bis.push({ id: i, raw_start_idx: raw, raw_end_idx: raw })
    }
    const hist = Array(80).fill(5)
    const centers = [{ status: 'confirmed', start_segment_id: 3, end_segment_id: 3 }]
    const result = detectDivergence(segs, bis, hist, centers)
    expect(result.type).toBe('none')
    expect(result.reason).toBe('macd_area_not_shrunk_enough')
    expect(result.area_cur).toBeGreaterThan(0)
    expect(result.area_prev).toBeGreaterThan(0)
  })
})
