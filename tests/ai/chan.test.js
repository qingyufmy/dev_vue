import { describe, it, expect } from 'vitest'
import { __chanTest } from '../../server/routes/ai/market-data.js'

const { calculateMacdSeries, normalizeBarsForChan, detectFractals, buildBis, normalizeFeatureSequence, buildSegments, buildCenters, detectDivergence, summarizeSegment, summarizeCenter, computeChan } = __chanTest

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

  it('由两个已确认分型构成的最后一笔也是确认笔', () => {
    const rates = makeRates(50)
    const bars = normalizeBarsForChan(rates)
    const fractals = detectFractals(bars)
    const { bis } = buildBis(fractals, bars)
    if (bis.length > 0) {
      expect(bis[bis.length - 1].confirmed).toBe(true)
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

  it('resets the confirmed bi chain after an invalid price relation', () => {
    const fractals = [
      { idx: 0, raw_idx: 0, type: 'bottom', price: 80, high: 80, low: 80, time: 't0' },
      { idx: 5, raw_idx: 5, type: 'top', price: 100, high: 100, low: 100, time: 't5' },
      { idx: 10, raw_idx: 10, type: 'bottom', price: 110, high: 110, low: 110, time: 't10' },
      { idx: 15, raw_idx: 15, type: 'top', price: 120, high: 120, low: 120, time: 't15' },
      { idx: 20, raw_idx: 20, type: 'bottom', price: 105, high: 105, low: 105, time: 't20' },
    ]
    const { bis, invalidCount } = buildBis(fractals, [])
    expect(invalidCount).toBe(1)
    expect(bis.map(b => b.dir)).toEqual(['up', 'down'])
    expect(bis[0]).toMatchObject({ start_price: 110, end_price: 120 })
    expect(bis[1]).toMatchObject({ start_price: 120, end_price: 105 })
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

  it('有缺口特征序列等待第二特征序列分型后确认', () => {
    const makeBi = (id, dir, start, end) => ({ id, dir, start_price: start, end_price: end, high: Math.max(start, end), low: Math.min(start, end) })
    const bis = [
      makeBi(1, 'up', 100, 120), makeBi(2, 'down', 120, 110),
      makeBi(3, 'up', 110, 140), makeBi(4, 'down', 140, 130),
      makeBi(5, 'up', 130, 135), makeBi(6, 'down', 135, 100),
      makeBi(7, 'up', 100, 120), makeBi(8, 'down', 120, 110),
      makeBi(9, 'up', 110, 125),
    ]
    const { segments } = buildSegments(bis)
    expect(segments).toHaveLength(1)
    expect(segments[0].confirmation).toBe('gap_reverse_confirmed')
    expect(segments[0].bi_ids).toEqual([1, 2, 3])
  })

  it('缺口后只有价格破坏但无第二特征序列分型时不确认', () => {
    const makeBi = (id, dir, start, end) => ({ id, dir, start_price: start, end_price: end, high: Math.max(start, end), low: Math.min(start, end) })
    const bis = [
      makeBi(1, 'up', 100, 120), makeBi(2, 'down', 120, 110),
      makeBi(3, 'up', 110, 140), makeBi(4, 'down', 140, 130),
      makeBi(5, 'up', 130, 135), makeBi(6, 'down', 135, 100),
    ]
    expect(buildSegments(bis).segments).toHaveLength(0)
  })

  it('等待第二特征序列时原上涨方向创新高会使候选失效', () => {
    const makeBi = (id, dir, start, end) => ({ id, dir, start_price: start, end_price: end, high: Math.max(start, end), low: Math.min(start, end) })
    const bis = [
      makeBi(1, 'up', 100, 120), makeBi(2, 'down', 120, 110),
      makeBi(3, 'up', 110, 140), makeBi(4, 'down', 140, 130),
      makeBi(5, 'up', 130, 145), makeBi(6, 'down', 145, 100),
      makeBi(7, 'up', 100, 120), makeBi(8, 'down', 120, 110),
      makeBi(9, 'up', 110, 125),
    ]
    expect(buildSegments(bis).segments).toHaveLength(0)
  })

  it('无缺口特征序列底分型对称确认下跌线段', () => {
    const makeBi = (id, dir, start, end) => ({ id, dir, start_price: start, end_price: end, high: Math.max(start, end), low: Math.min(start, end) })
    const bis = [
      makeBi(1, 'down', 140, 120), makeBi(2, 'up', 120, 130),
      makeBi(3, 'down', 130, 110), makeBi(4, 'up', 110, 125),
      makeBi(5, 'down', 125, 115), makeBi(6, 'up', 115, 135),
    ]
    const { segments } = buildSegments(bis)
    expect(segments).toHaveLength(1)
    expect(segments[0]).toMatchObject({ dir: 'down', start_price: 140, end_price: 110, confirmation: 'feature_fractal' })
    expect(segments[0].bi_ids).toEqual([1, 2, 3])
  })

  it('滚动窗口只输出完整窗口和内部后缀一致的候选结构', () => {
    const makeBi = (id, dir, start, end) => ({ id, dir, start_price: start, end_price: end, high: Math.max(start, end), low: Math.min(start, end) })
    const bis = [
      makeBi(1, 'up', 100, 120), makeBi(2, 'down', 120, 110),
      makeBi(3, 'up', 110, 130), makeBi(4, 'down', 130, 115),
      makeBi(5, 'up', 115, 125), makeBi(6, 'down', 125, 105),
      makeBi(7, 'up', 105, 120), makeBi(8, 'down', 120, 110),
      makeBi(9, 'up', 110, 128), makeBi(10, 'down', 128, 100),
    ]
    const result = buildSegments(bis, { trustedStart: false })
    expect(result.resynced).toBe(true)
    expect(result.stable).toBe(true)
    expect(result.segments).toHaveLength(0)
    expect(result.candidate).toMatchObject({ dir: 'up', bi_ids: [7, 8, 9, 10], start_price: 105, end_price: 128 })
  })

  it('滚动窗口尚未找到重同步端点时不输出候选线段', () => {
    const makeBi = (id, dir, start, end) => ({ id, dir, start_price: start, end_price: end, high: Math.max(start, end), low: Math.min(start, end) })
    const bis = [
      makeBi(1, 'up', 100, 110),
      makeBi(2, 'down', 110, 105),
      makeBi(3, 'up', 105, 115),
      makeBi(4, 'down', 115, 108),
    ]
    const result = buildSegments(bis, { trustedStart: false })
    expect(result).toMatchObject({ segments: [], candidate: null, resynced: false, stable: false })
  })

  it('完整窗口和内部后缀末端边界不一致时抑制全部线段结构', () => {
    let state = 3
    const random = () => {
      state = (state * 1664525 + 1013904223) >>> 0
      return state / 0x100000000
    }
    let price = 100
    const bis = []
    for (let i = 0; i < 60; i++) {
      const dir = i % 2 === 0 ? 'up' : 'down'
      const distance = 1 + random() * 25
      const end = dir === 'up' ? price + distance : price - distance
      bis.push({ id: i + 1, dir, start_price: price, end_price: end, high: Math.max(price, end), low: Math.min(price, end) })
      price = end
    }
    const result = buildSegments(bis, { trustedStart: false })
    expect(result).toMatchObject({ segments: [], candidate: null, resynced: true, stable: false })
  })

  it('keeps candidate segment direction consistent with its extreme', () => {
    const makeBi = (id, dir, start, end) => ({ id, dir, start_price: start, end_price: end, high: Math.max(start, end), low: Math.min(start, end) })
    const bis = [
      makeBi(1, 'up', 100, 110),
      makeBi(2, 'down', 110, 95),
      makeBi(3, 'up', 95, 105),
      makeBi(4, 'down', 105, 90),
    ]
    const { candidate } = buildSegments(bis)
    expect(candidate).toMatchObject({ dir: 'up', start_price: 100, end_price: 110 })
    expect(candidate.end_price).toBeGreaterThan(candidate.start_price)
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
    expect(centers[0].closed_by_segment_id).toBe(5)
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

describe('Chan payload summaries', () => {
  it('线段摘要包含比较三类买卖点所需字段', () => {
    const summary = summarizeSegment({ id: 2, dir: 'down', start_price: 120, end_price: 90, high: 122, low: 88, bi_ids: [4, 5, 6], ended_reason: 'broken', broken: true })
    expect(summary).toEqual({ id: 2, dir: 'down', start_price: 120, end_price: 90, high: 122, low: 88, bi_count: 3, ended_reason: 'broken', broken: true })
    expect(summarizeSegment(undefined)).toBeNull()
  })

  it('关闭中枢摘要保留固定边界、波动边界和关闭线段', () => {
    const summary = summarizeCenter({ id: 3, zl: 100, zh: 110, fluctuation_high: 118, fluctuation_low: 95, status: 'closed', start_segment_id: 4, end_segment_id: 7, closed_by_segment_id: 8 }, 'H1')
    expect(summary).toMatchObject({ id: 3, zl: 100, zh: 110, gg: 118, dd: 95, status: 'closed', structure_level: 'segment', closed_by_segment_id: 8 })
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
    const bis = [
      { id: 4, raw_start_idx: 40, raw_end_idx: 41 }, { id: 5, raw_start_idx: 42, raw_end_idx: 43 }, { id: 6, raw_start_idx: 44, raw_end_idx: 45 },
      { id: 10, raw_start_idx: 46, raw_end_idx: 47 }, { id: 11, raw_start_idx: 48, raw_end_idx: 49 }, { id: 12, raw_start_idx: 50, raw_end_idx: 51 },
    ]
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
    const bis = segs.flatMap(s => s.bi_ids.map(id => ({ id, raw_start_idx: 40 + id, raw_end_idx: 40 + id })))
    const macd = [...Array(41).fill(0), ...Array(12).fill(5)]
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
      { id: 4, raw_start_idx: 40, raw_end_idx: 41 }, { id: 5, raw_start_idx: 42, raw_end_idx: 43 }, { id: 6, raw_start_idx: 44, raw_end_idx: 45 },
      { id: 10, raw_start_idx: 46, raw_end_idx: 47 }, { id: 11, raw_start_idx: 48, raw_end_idx: 49 }, { id: 12, raw_start_idx: 50, raw_end_idx: 51 },
    ]
    const macd = [...Array(40).fill(0), ...Array(12).fill(-5)]
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
    const bis = segs.flatMap(s => s.bi_ids.map(id => ({ id, raw_start_idx: 40 + id, raw_end_idx: 40 + id })))
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
    const bis = [
      { id: 4, raw_start_idx: 40, raw_end_idx: 41 }, { id: 5, raw_start_idx: 42, raw_end_idx: 43 }, { id: 6, raw_start_idx: 44, raw_end_idx: 45 },
      { id: 10, raw_start_idx: 46, raw_end_idx: 47 }, { id: 11, raw_start_idx: 48, raw_end_idx: 49 }, { id: 12, raw_start_idx: 50, raw_end_idx: 51 },
    ]
    // seg2 area=30, seg4 area=6 -> area and height divergence
    const macd = [...Array(40).fill(0), 5, 5, 5, 5, 5, 5, 1, 1, 1, 1, 1, 1]
    const centers = [{ status: 'confirmed', start_segment_id: 3, end_segment_id: 3 }]
    const result = detectDivergence(segs, bis, macd, centers)
    expect(result.type).toBe('top')
    expect(result.category).toBe('center_departure')
    expect(result.trend_confirmed).toBe(false)
    expect(result.reason).toBe('macd_area_and_height_divergence')
    expect(result.strength).toBe('strong')
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
      { id: 4, raw_start_idx: 40, raw_end_idx: 41 }, { id: 5, raw_start_idx: 42, raw_end_idx: 43 }, { id: 6, raw_start_idx: 44, raw_end_idx: 45 },
      { id: 10, raw_start_idx: 46, raw_end_idx: 47 }, { id: 11, raw_start_idx: 48, raw_end_idx: 49 }, { id: 12, raw_start_idx: 50, raw_end_idx: 51 },
    ]
    // seg2 area=15, seg4 area=3 → divergence (negative for down)
    const macd = [...Array(40).fill(0), -5, -5, -5, -5, -5, -5, -1, -1, -1, -1, -1, -1]
    const centers = [{ status: 'confirmed', start_segment_id: 3, end_segment_id: 3 }]
    const result = detectDivergence(segs, bis, macd, centers)
    expect(result.type).toBe('bottom')
    expect(result.category).toBe('center_departure')
    expect(result.trend_confirmed).toBe(false)
    expect(result.reason).toBe('macd_area_and_height_divergence')
    expect(result.strength).toBe('strong')
    expect(result.price_extreme_cur).toBe(85)
    expect(result.price_extreme_prev).toBe(90)
  })

  it('MACD面积不会重复累计相邻笔共享的原始K线索引', () => {
    const segs = [
      { id: 1, dir: 'up', bi_ids: [1, 2, 3], weak: false, high: 120, low: 90 },
      { id: 5, dir: 'up', bi_ids: [4, 5, 6], weak: false, high: 130, low: 95 },
    ]
    const bis = [
      { id: 1, raw_start_idx: 40, raw_end_idx: 41 }, { id: 2, raw_start_idx: 41, raw_end_idx: 42 }, { id: 3, raw_start_idx: 42, raw_end_idx: 43 },
      { id: 4, raw_start_idx: 44, raw_end_idx: 45 }, { id: 5, raw_start_idx: 45, raw_end_idx: 46 }, { id: 6, raw_start_idx: 46, raw_end_idx: 47 },
    ]
    const result = detectDivergence(segs, bis, [...Array(40).fill(0), 5, 5, 5, 5, 2, 2, 2, 2], [{ start_segment_id: 2, end_segment_id: 4 }])
    expect(result.area_prev).toBe(20)
    expect(result.area_cur).toBe(8)
  })

  it('使用buildCenters生成的真实三线段中枢检测离开段力度衰减', () => {
    const segs = [
      { id: 1, dir: 'up', bi_ids: [1, 2, 3], weak: false, high: 125, low: 121, start_price: 121, end_price: 125 },
      { id: 2, dir: 'down', bi_ids: [4, 5, 6], weak: false, high: 120, low: 100, start_price: 120, end_price: 100 },
      { id: 3, dir: 'up', bi_ids: [7, 8, 9], weak: false, high: 118, low: 105, start_price: 105, end_price: 118 },
      { id: 4, dir: 'down', bi_ids: [10, 11, 12], weak: false, high: 122, low: 108, start_price: 122, end_price: 108 },
      { id: 5, dir: 'up', bi_ids: [13, 14, 15], weak: false, high: 130, low: 119, start_price: 119, end_price: 130 },
    ]
    const centers = buildCenters(segs)
    expect(centers).toHaveLength(1)
    expect(centers[0]).toMatchObject({ start_segment_id: 2, end_segment_id: 4, segment_ids: [2, 3, 4], status: 'closed' })
    const bis = Array.from({ length: 15 }, (_, i) => ({ id: i + 1, raw_start_idx: 40 + i, raw_end_idx: 40 + i }))
    const hist = [...Array(40).fill(0), ...Array(3).fill(5), ...Array(9).fill(2), ...Array(3).fill(1)]
    const result = detectDivergence(segs, bis, hist, centers)
    expect(result).toMatchObject({ type: 'top', category: 'center_departure', trend_confirmed: false, strength: 'strong' })
  })

  it('任一比较线段进入MACD暖机区时不判定背驰', () => {
    const segs = [
      { id: 1, dir: 'up', bi_ids: [1, 2, 3], weak: false, high: 120, low: 100 },
      { id: 5, dir: 'up', bi_ids: [4, 5, 6], weak: false, high: 130, low: 105 },
    ]
    const bis = Array.from({ length: 6 }, (_, i) => ({ id: i + 1, raw_start_idx: 10 + i, raw_end_idx: 10 + i }))
    const result = detectDivergence(segs, bis, Array(80).fill(2), [{ start_segment_id: 2, end_segment_id: 4 }])
    expect(result).toMatchObject({ type: 'none', strength: 'none', reason: 'macd_warmup_overlap' })
  })

  it('仅高度缩小时返回弱背驰', () => {
    const segs = [
      { id: 1, dir: 'up', bi_ids: [1, 2, 3], weak: false, high: 120, low: 100 },
      { id: 5, dir: 'up', bi_ids: [4, 5, 6], weak: false, high: 130, low: 105 },
    ]
    const bis = Array.from({ length: 6 }, (_, i) => ({ id: i + 1, raw_start_idx: 40 + i, raw_end_idx: 40 + i }))
    const hist = [...Array(40).fill(0), 6, 1, 1, 4, 4, 4]
    const result = detectDivergence(segs, bis, hist, [{ start_segment_id: 2, end_segment_id: 4 }])
    expect(result).toMatchObject({ type: 'top', strength: 'weak', reason: 'macd_height_divergence_only', peak_prev: 6, peak_cur: 4 })
  })

  it('仅面积缩小时返回弱背驰', () => {
    const segs = [
      { id: 1, dir: 'up', bi_ids: [1, 2, 3], weak: false, high: 120, low: 100 },
      { id: 5, dir: 'up', bi_ids: [4, 5, 6], weak: false, high: 130, low: 105 },
    ]
    const bis = Array.from({ length: 6 }, (_, i) => ({ id: i + 1, raw_start_idx: 40 + i, raw_end_idx: 40 + i }))
    const hist = [...Array(40).fill(0), 5, 5, 5, 5, 1, 1]
    const result = detectDivergence(segs, bis, hist, [{ start_segment_id: 2, end_segment_id: 4 }])
    expect(result).toMatchObject({ type: 'top', strength: 'weak', reason: 'macd_area_divergence_only', peak_prev: 5, peak_cur: 5 })
  })
})

describe('computeChan', () => {
  it('K线不足返回insufficient_klines', () => {
    const rates = makeRates(5)
    const result = computeChan(rates, 'M5', [])
    expect(result.status).toBe('insufficient_klines')
    expect(result).toMatchObject({
      current_bi: null,
      recent_bis: [],
      current_segment: null,
      current_center: null,
      active_center: null,
      latest_center: null,
      price_vs_center: 'none',
      divergence: { type: 'none', reason: 'insufficient_klines' },
    })
  })

  it('返回结构包含必要字段', () => {
    const rates = makeRates(50)
    const macdHist = rates.map((_, i) => Math.sin(i * 0.3) * 5)
    const result = computeChan(rates, 'H1', macdHist)
    expect(result.status).toBeDefined()
    expect(result.reliability).toBeDefined()
    expect(result.raw_bar_count).toBe(50)
    expect(result.closed_bar_count).toBe(49)
    expect(typeof result.window_stable).toBe('boolean')
    expect(result.warnings).toBeDefined()
    expect(Array.isArray(result.warnings)).toBe(true)
    expect(result.recent_bis).toHaveLength(6)
  })

  it('当前未收盘K线变化不影响确认结构', () => {
    const rates = makeRates(120)
    const changed = rates.map(rate => ({ ...rate }))
    changed[changed.length - 1] = { ...changed[changed.length - 1], high: 9999, low: 1, close: 8000 }
    const first = computeChan(rates, 'M5', calculateMacdSeries(rates.map(r => Number(r.close))).histSeries)
    const second = computeChan(changed, 'M5', calculateMacdSeries(changed.map(r => Number(r.close))).histSeries)
    expect(second.fractal_count).toBe(first.fractal_count)
    expect(second.bi_count).toBe(first.bi_count)
    expect(second.segment_count).toBe(first.segment_count)
    expect(second.center_count).toBe(first.center_count)
    expect(second.developing_bi).not.toEqual(first.developing_bi)
  })

  it('uses all post-fractal bars for the developing bi extreme', () => {
    const rates = Array.from({ length: 31 }, (_, i) => ({ time: `t${i}`, open: 105, high: 110, low: 100, close: 105, tick_volume: 1 }))
    rates[20] = { ...rates[20], low: 80, close: 90 }
    rates[30] = { ...rates[30], low: 90, close: 95 }
    const fractal = (idx, type, price) => ({ idx, raw_start_idx: idx, raw_end_idx: idx, type, price, high: price, low: price, time: `t${idx}` })
    const fractals = [
      fractal(0, 'bottom', 100),
      fractal(4, 'top', 120),
      fractal(8, 'bottom', 110),
      fractal(12, 'top', 130),
    ]
    const result = computeChan(rates, 'M5', Array(rates.length).fill(0), { fractalsForTest: fractals })
    expect(result.developing_bi).toMatchObject({ dir: 'down', start_price: 130, end_price: 80, confirmed: false })
  })

  it('anchors the developing bi to the last pivot accepted by bi construction', () => {
    const rates = Array.from({ length: 31 }, (_, i) => ({ time: `t${i}`, open: 115, high: 120, low: 110, close: 115, tick_volume: 1 }))
    rates[20] = { ...rates[20], high: 140, low: 120, close: 130 }
    const fractal = (idx, type, price) => ({ idx, raw_start_idx: idx, raw_end_idx: idx, type, price, high: price, low: price, time: `t${idx}` })
    const fractals = [
      fractal(0, 'bottom', 100),
      fractal(4, 'top', 120),
      fractal(8, 'bottom', 110),
      fractal(12, 'top', 130),
      fractal(14, 'bottom', 115), // Rejected: fewer than five processed bars from the accepted top.
    ]
    const result = computeChan(rates, 'M5', Array(rates.length).fill(0), { fractalsForTest: fractals })
    expect(result.developing_bi).toMatchObject({ dir: 'down', start_price: 130, end_price: 110, confirmed: false })
  })

  it('returns a developing bi even when fewer than three confirmed bis exist', () => {
    const rates = Array.from({ length: 31 }, (_, i) => ({ time: `t${i}`, open: 115, high: 120, low: 110, close: 115, tick_volume: 1 }))
    rates[20] = { ...rates[20], high: 140, close: 135 }
    const fractal = (idx, type, price) => ({ idx, raw_start_idx: idx, raw_end_idx: idx, type, price, high: price, low: price, time: `t${idx}` })
    const fractals = [
      fractal(0, 'bottom', 100),
      fractal(4, 'top', 120),
      fractal(8, 'bottom', 110),
    ]
    const result = computeChan(rates, 'M5', Array(rates.length).fill(0), { fractalsForTest: fractals })
    expect(result.status).toBe('insufficient_bis')
    expect(result.bi_count).toBe(2)
    expect(result.developing_bi).toMatchObject({ dir: 'up', start_price: 110, end_price: 140, confirmed: false })
  })

  it('末端线段边界不稳定时组装层禁止中枢和背驰输出', () => {
    let state = 3
    const random = () => {
      state = (state * 1664525 + 1013904223) >>> 0
      return state / 0x100000000
    }
    let price = 100
    const vertices = [{ type: 'bottom', price }]
    for (let i = 0; i < 60; i++) {
      const dir = i % 2 === 0 ? 'up' : 'down'
      const distance = 1 + random() * 25
      price = dir === 'up' ? price + distance : price - distance
      vertices.push({ type: dir === 'up' ? 'top' : 'bottom', price })
    }
    const fractals = vertices.map((vertex, index) => ({
      idx: index * 4,
      raw_start_idx: index * 4,
      raw_end_idx: index * 4,
      type: vertex.type,
      price: vertex.price,
      high: vertex.price,
      low: vertex.price,
      time: `t${index * 4}`,
    }))
    const rates = Array.from({ length: 300 }, (_, i) => ({ time: `t${i}`, open: 100, high: 110, low: 90, close: 100, tick_volume: 1 }))
    const result = computeChan(rates, 'M5', Array(rates.length).fill(0), { fractalsForTest: fractals })
    expect(result).toMatchObject({ window_resynced: true, window_stable: false, segment_count: 0, center_count: 0 })
    expect(result.candidate_segment).toBeNull()
    expect(result.current_center).toBeNull()
    expect(result.divergence.type).toBe('none')
    expect(result.warnings).toContain('segment_window_unstable')
  })

  it('扩展历史在首段重同步后仍能输出后续完整线段', () => {
    const rates = makeRates(300)
    const result = computeChan(rates, 'M5', calculateMacdSeries(rates.map(r => Number(r.close))).histSeries)
    expect(result.closed_bar_count).toBe(299)
    expect(result.window_resynced).toBe(true)
    expect(result.warnings).not.toContain('segment_window_resynced')
    expect(result.segment_count).toBeGreaterThan(0)
  })

  it('请求历史不足时明确降级并报告数量', () => {
    const rates = makeRates(120)
    const result = computeChan(rates, 'M5', calculateMacdSeries(rates.map(r => Number(r.close))).histSeries, { requestedHistoryCount: 300 })
    expect(result).toMatchObject({ requested_history_count: 300, received_history_count: 120, history_sufficient: false })
    expect(result.warnings).toContain('history_bars_below_requested')
    expect(result.reliability).toBe('low')
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
    const rates = makeRates(31)
    const fractalsForTest = [
      { idx: 0, raw_start_idx: 0, raw_end_idx: 0, type: 'bottom', price: 100, high: 100, low: 100, time: 't0' },
      { idx: 5, raw_start_idx: 5, raw_end_idx: 5, type: 'top', price: 90, high: 90, low: 90, time: 't5' },
      { idx: 10, raw_start_idx: 10, raw_end_idx: 10, type: 'bottom', price: 85, high: 85, low: 85, time: 't10' },
    ]
    const hist = Array(31).fill(0)
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
    expect(result.reason).toBe('macd_no_divergence')
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
    expect(result.reason).toBe('macd_no_divergence')
    expect(result.area_cur).toBeGreaterThan(0)
    expect(result.area_prev).toBeGreaterThan(0)
  })
})
