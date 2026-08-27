import { describe, it, expect } from 'vitest'
import { __chanTest } from '../../server/routes/ai/market-data.js'
import { getChanWindowPolicy } from '../../server/routes/ai/chan-window-policy.js'

const { calculateMacdSeries, roundMacdEvidence, normalizeBarsForChan, detectFractals, buildBis, normalizeFeatureSequence, buildSegments, buildCenters, detectDivergence, detectDivergenceHistory, detectFormingDivergence, buildFormingSegment, summarizeLatestConfirmedFractal, inspectSegmentCandidateLifecycle, buildLatestChanStructure, summarizeSegment, summarizeCenter, classifyChanTrend, prioritizeLatestChanStructure, detectChanEntryCandidates, computeChan, selectStableChanResult, summarizeTemporalBootstrapEvidence, evaluateCrossWindowBootstrapEvidence, protectBootstrapDependentEvidence, buildChanEvidenceCapabilities } = __chanTest

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

function makeStableChanRates(n, step = 300000, phase = 25) {
  return Array.from({ length: n }, (_, index) => {
    // Keep the terminal phase on a confirmed center/entry boundary for every
    // production policy length so trusted-anchor paths are exercised.
    const phaseIndex = index + phase
    const close = 100 + Math.sin(phaseIndex * 0.02) * 20
      + Math.sin(phaseIndex * 0.06) * 10 + Math.sin(phaseIndex * 0.35) * 3
    return {
      time:`t${index}`,
      time_utc_msc:1784185200000 + index * step,
      open:close, high:close + 1, low:close - 1, close, tick_volume:1,
    }
  })
}

function chanDataQuality() {
  return { platform:'mt5', source_id:9, clock_status:'verified', last_bar_closed:true }
}

function expectHiddenChanEvidence(result) {
  for (const key of ['_confirmed_segments', '_confirmed_centers', '_closed_rate_times_utc_msc']) {
    expect(Object.prototype.hasOwnProperty.call(result, key)).toBe(true)
    expect(Object.prototype.propertyIsEnumerable.call(result, key)).toBe(false)
    expect(Array.isArray(result[key])).toBe(true)
  }
}

describe('Chan v7 window policy', () => {
  it.each([
    ['M5', 1800, [1400, 1600, 1800]],
    ['M15', 2000, [1600, 1800, 2000]],
    ['H1', 1800, [1400, 1600, 1800]],
    ['H4', 1000, [600, 800, 1000]],
  ])('uses the fixed %s target and adjacent validators', (timeframe, target, validators) => {
    expect(getChanWindowPolicy(timeframe)).toMatchObject({
      supported:true, target, maximumHistoryCount:target,
      validators, validationWindowCounts:validators,
      windowPolicyVersion:'chan_window_v7',
    })
  })

  it('does not silently assign a v7 window to an unsupported timeframe', () => {
    expect(getChanWindowPolicy('M30')).toMatchObject({
      supported:false, target:0, validators:[], windowPolicyVersion:'unsupported',
    })
  })

  it('ignores a prefix outside the fixed target window', () => {
    const tail = makeRates(1800)
    const withPrefix = [...makeRates(250, 9000), ...tail]
    const first = computeChan(withPrefix, 'M5', [])
    const second = computeChan(tail, 'M5', [])
    expect(first).toMatchObject({ source_history_count:2050, calculation_window_count:1800, raw_bar_count:1800 })
    expect(second).toMatchObject({ source_history_count:1800, calculation_window_count:1800, raw_bar_count:1800 })
    expect(first.current_segment).toEqual(second.current_segment)
    expect(first.latest_center).toEqual(second.latest_center)
  })

  it('keeps data completeness separate from bi diagnostics and requires an authoritative chain for direction', () => {
    const complete = buildChanEvidenceCapabilities({
      history_sufficient:true, closed_history_sufficient:true,
      cache_internal_gap_unresolved:false, time_location_reliable:true,
      structure_time_key_reliable:true, bi_discontinuity_count:9,
      window_stable:true, authoritative_terminal_chain_confirmed:false,
      segment_count:3, trend_state:{ direction:'up' }, center_count:0,
    })
    expect(complete.data_complete).toBe(true)
    expect(complete.segment_direction_usable).toBe(false)
    expect(complete.center_structure_usable).toBe(false)
    const authoritative = buildChanEvidenceCapabilities({
      history_sufficient:true, closed_history_sufficient:true,
      cache_internal_gap_unresolved:false, time_location_reliable:true,
      structure_time_key_reliable:true, window_stable:true,
      authoritative_terminal_chain_confirmed:true, segment_count:3,
      trend_state:{ direction:'up' }, center_count:0,
    })
    expect(authoritative.segment_direction_usable).toBe(true)
  })

  it('keeps stable segment direction usable when only absolute UTC location is unreliable', () => {
    const result = buildChanEvidenceCapabilities({
      history_sufficient:true, closed_history_sufficient:true,
      cache_internal_gap_unresolved:false, time_location_reliable:false,
      structure_time_key_reliable:true, window_stable:true,
      authoritative_terminal_chain_confirmed:true, segment_count:5,
      trend_state:{ direction:'down' }, center_count:0,
    })
    expect(result).toMatchObject({
      history_complete:true, topology_input_complete:true,
      data_complete:true, absolute_time_location_reliable:false,
      segment_direction_usable:true, center_structure_usable:false,
      entry_structure_usable:false, divergence_usable:false,
    })
    expect(result.reason_codes).toContain('absolute_time_location_unreliable')
  })

  it('fails center, entry and divergence independently', () => {
    const centerOnly = buildChanEvidenceCapabilities({
      history_sufficient:true, closed_history_sufficient:true,
      cache_internal_gap_unresolved:false, structure_time_key_reliable:true,
      time_location_reliable:true, window_stable:true,
      authoritative_terminal_chain_confirmed:true, segment_count:4,
      trend_state:{ direction:'up' }, center_count:1,
      structure_topology_reliable:true,
      latest_center:{ entry_segment_id:null, entry_segment_stable_id:null },
      structure_anchor:{ current_result_usable:false }, closed_bar_count:100,
      divergence:{ reason:'macd_no_divergence' },
    })
    expect(centerOnly.center_structure_usable).toBe(true)
    expect(centerOnly.entry_structure_usable).toBe(false)
    expect(centerOnly.divergence_usable).toBe(false)
  })

  it('将not_after_center视为可评估的确定性无背驰', () => {
    const result = buildChanEvidenceCapabilities({
      history_sufficient:true, closed_history_sufficient:true,
      cache_internal_gap_unresolved:false, structure_time_key_reliable:true,
      time_location_reliable:true, window_stable:true,
      authoritative_terminal_chain_confirmed:true, segment_count:4,
      current_segment:{ dir:'up' }, center_count:1,
      structure_topology_reliable:true,
      latest_center:{ entry_segment_id:2, entry_segment_stable_id:'entry' },
      structure_anchor:{ current_result_usable:true }, closed_bar_count:100,
      divergence:{ type:'none', confirmed:false, reason:'not_after_center' },
    })

    expect(result.divergence_usable).toBe(true)
    expect(result.reason_codes).not.toContain('divergence_evidence_unavailable')
    expect(result.reason_codes).not.toContain('divergence_unusable')
  })

  it('fails the structural direction capability on an unresolved continuity state', () => {
    const result = buildChanEvidenceCapabilities({
      history_sufficient:true, closed_history_sufficient:true,
      continuity_complete:false, continuity_status:'suspicious_gap',
      cache_internal_gap_unresolved:false, structure_time_key_reliable:true,
      time_location_reliable:true, window_stable:true,
      authoritative_terminal_chain_confirmed:true, segment_count:5,
      trend_state:{ direction:'down' }, center_count:0,
    })
    expect(result.continuity_complete).toBe(false)
    expect(result.segment_direction_usable).toBe(false)
    expect(result.reason_codes).toContain('continuity_incomplete')
  })

  it('ignores an unresolved gap whose details are outside the fixed Chan slice', () => {
    const rates = makeRates(2000).map((rate, index) => ({
      ...rate, time_utc_msc:1784185200000 + index * 300000,
    }))
    const result = computeChan(rates, 'M5', [], {
      requestedHistoryCount:1800,
      dataQuality:{
        source_id:1, platform:'mt5', clock_status:'verified', last_bar_closed:true,
        cache_internal_gap_unresolved:true,
        cache_internal_gap_details:[{
          from_utc_msc:rates[0].time_utc_msc,
          to_utc_msc:rates[1].time_utc_msc,
          gap_ms:300000, missing_bar_count:1,
        }],
      },
    })
    expect(result.calculation_window_count).toBe(1800)
    expect(result.cache_internal_gap_unresolved).toBe(false)
    expect(result.evidence_capabilities.data_complete).toBe(true)
  })
})

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

  it('新笔最小间距使用分型极值原始K线索引而不是包含处理后索引', () => {
    const fractals = [
      { idx: 0, raw_start_idx: 0, raw_end_idx: 1, extreme_raw_idx: 0, type: 'bottom', price: 100, high: 105, low: 100, time: 't0' },
      { idx: 2, raw_start_idx: 4, raw_end_idx: 5, extreme_raw_idx: 4, type: 'top', price: 120, high: 120, low: 110, time: 't4' },
    ]
    const { bis } = buildBis(fractals, [])
    expect(bis).toHaveLength(1)
    expect(bis[0]).toMatchObject({ raw_start_idx: 0, raw_end_idx: 4, start_price: 100, end_price: 120 })
  })

  it('isolates a discontinuity into a new bi run without deleting confirmed history', () => {
    const fractals = [
      { idx: 0, raw_idx: 0, type: 'bottom', price: 80, high: 80, low: 80, time: 't0' },
      { idx: 5, raw_idx: 5, type: 'top', price: 100, high: 100, low: 100, time: 't5' },
      { idx: 10, raw_idx: 10, type: 'bottom', price: 110, high: 110, low: 110, time: 't10' },
      { idx: 15, raw_idx: 15, type: 'top', price: 120, high: 120, low: 120, time: 't15' },
      { idx: 20, raw_idx: 20, type: 'bottom', price: 105, high: 105, low: 105, time: 't20' },
    ]
    const { bis, runs, invalidCount, activeRunId, lastDiscontinuity } = buildBis(fractals, [])
    expect(invalidCount).toBe(1)
    expect(bis.map(b => b.dir)).toEqual(['up', 'up', 'down'])
    expect(runs).toHaveLength(2)
    expect(runs[0]).toHaveLength(1)
    expect(runs[0][0]).toMatchObject({ run_id: 1, start_price: 80, end_price: 100 })
    expect(runs[1].map(b => b.dir)).toEqual(['up', 'down'])
    expect(runs[1][0]).toMatchObject({ run_id: 2, start_price: 110, end_price: 120 })
    expect(runs[1][1]).toMatchObject({ run_id: 2, start_price: 120, end_price: 105 })
    expect(activeRunId).toBe(2)
    expect(lastDiscontinuity).toMatchObject({ pivot_index: 2, processed_index: 10, raw_index: 10 })
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

  it('有缺口端点在反向特征序列分型前保持候选，确认后端点不漂移', () => {
    const makeBi = (id, dir, start, end) => ({ id, dir, raw_start_idx:id * 2 - 2,
      raw_end_idx:id * 2 - 1, start_price:start, end_price:end,
      high:Math.max(start, end), low:Math.min(start, end) })
    const waiting = [
      makeBi(1, 'up', 100, 120), makeBi(2, 'down', 120, 110),
      makeBi(3, 'up', 110, 140), makeBi(4, 'down', 140, 130),
      makeBi(5, 'up', 130, 135), makeBi(6, 'down', 135, 100),
      makeBi(7, 'up', 100, 120), makeBi(8, 'down', 120, 110),
    ]
    const before = buildSegments(waiting)
    expect(before.segments).toHaveLength(0)
    expect(before.candidate).toMatchObject({
      confirmation_state:'awaiting_reverse_feature_fractal',
      confirmation_required:'reverse_feature_fractal',
      pending_endpoint_feature_gap:true,
      pending_endpoint_feature_bi_id:4,
      pending_endpoint_segment_bi_id:3,
      pending_endpoint_price:140,
    })

    const after = buildSegments([...waiting, makeBi(9, 'up', 110, 125)])
    expect(after.segments[0]).toMatchObject({
      dir:'up', start_bi_id:1, end_bi_id:3, start_price:100, end_price:140,
      confirmation:'gap_reverse_confirmed',
    })
    expect(after.candidate).toMatchObject({
      dir:'down', start_price:140,
      confirmation_state:'awaiting_reverse_feature_fractal',
    })
  })

  it('缺口后只有价格破坏但无第二特征序列分型时不确认', () => {
    const makeBi = (id, dir, start, end) => ({ id, dir, start_price: start, end_price: end, high: Math.max(start, end), low: Math.min(start, end) })
    const bis = [
      makeBi(1, 'up', 100, 120), makeBi(2, 'down', 120, 110),
      makeBi(3, 'up', 110, 140), makeBi(4, 'down', 140, 130),
      makeBi(5, 'up', 130, 135), makeBi(6, 'down', 135, 100),
    ]
    const result = buildSegments(bis)
    expect(result.segments).toHaveLength(0)
    expect(result.candidate).toMatchObject({
      confirmation_state:'awaiting_reverse_feature_fractal',
      confirmation_required:'reverse_feature_fractal',
    })
  })

  it('等待第二特征序列时原方向创新高会废弃旧端点并迁移到新端点', () => {
    const makeBi = (id, dir, start, end) => ({ id, dir, start_price: start, end_price: end, high: Math.max(start, end), low: Math.min(start, end) })
    const bis = [
      makeBi(1, 'up', 100, 120), makeBi(2, 'down', 120, 110),
      makeBi(3, 'up', 110, 140), makeBi(4, 'down', 140, 130),
      makeBi(5, 'up', 130, 145), makeBi(6, 'down', 145, 100),
      makeBi(7, 'up', 100, 120), makeBi(8, 'down', 120, 110),
      makeBi(9, 'up', 110, 125),
    ]
    const result = buildSegments(bis)
    expect(result.segments).toHaveLength(0)
    expect(result.candidate).toMatchObject({
      confirmation_state:'awaiting_reverse_feature_fractal',
      pending_endpoint_feature_bi_id:6,
      pending_endpoint_segment_bi_id:5,
      pending_endpoint_price:145,
    })
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

  it('候选结构缺少多个独立起点确认时保持不稳定', () => {
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
    expect(result.stable).toBe(false)
    expect(result.segments).toHaveLength(0)
    expect(result.candidate).toBeNull()
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

  it('不会把多个截断起点共同产生的伪边界当成完整历史稳定线段', () => {
    let state = 2
    const random = () => {
      state = (state * 1664525 + 1013904223) >>> 0
      return state / 0x100000000
    }
    let price = 100
    const bis = []
    for (let i = 0; i < 40; i++) {
      const dir = i % 2 === 0 ? 'up' : 'down'
      const distance = 1 + random() * 25
      const end = dir === 'up' ? price + distance : price - distance
      bis.push({ id: i + 1, dir, start_price: price, end_price: end, high: Math.max(price, end), low: Math.min(price, end) })
      price = end
    }

    const trusted = buildSegments(bis)
    const trustedBoundaries = new Set(trusted.segments.map(segment => `${segment.dir}:${segment.start_bi_id}:${segment.end_bi_id}`))
    const rolling = buildSegments(bis.slice(5), { trustedStart: false })

    expect(rolling.segments.every(segment => trustedBoundaries.has(`${segment.dir}:${segment.start_bi_id}:${segment.end_bi_id}`))).toBe(true)
    expect(rolling.segments.some(segment => segment.start_bi_id === 24 && segment.end_bi_id === 34)).toBe(false)
  })

  it('keeps candidate segment direction consistent with its extreme', () => {
    const makeBi = (id, dir, start, end) => ({ id, dir, raw_start_idx:id * 2 - 2, raw_end_idx:id * 2 - 1, start_price: start, end_price: end, high: Math.max(start, end), low: Math.min(start, end) })
    const bis = [
      makeBi(1, 'up', 100, 110),
      makeBi(2, 'down', 110, 95),
      makeBi(3, 'up', 95, 105),
      makeBi(4, 'down', 105, 90),
    ]
    const { candidate } = buildSegments(bis)
    expect(candidate).toMatchObject({ dir: 'up', start_price: 100, end_price: 110, endpoint_raw_idx:1 })
    expect(candidate.end_price).toBeGreaterThan(candidate.start_price)

    const rates = Array.from({ length:8 }, (_, index) => ({ time:`t${index}`, time_utc_msc:1000 + index }))
    const summary = summarizeSegment(buildFormingSegment(candidate, bis, 1), bis, rates)
    expect(summary).toMatchObject({ end_price:110, end_index:1, end_time:'t1', end_time_utc_msc:1001 })
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
    expect(centers).toHaveLength(1)
    expect(centers[0]).toMatchObject({ zl: 105, zh: 118 })
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

  it('中枢显式保存进入段和离开段引用', () => {
    const segments = [
      { id: 1, low: 121, high: 125, start_price: 121, end_price: 125 },
      { id: 2, low: 100, high: 120, start_price: 120, end_price: 100 },
      { id: 3, low: 105, high: 118, start_price: 105, end_price: 118 },
      { id: 4, low: 108, high: 122, start_price: 122, end_price: 108 },
      { id: 5, low: 119, high: 130, start_price: 119, end_price: 130 },
    ]
    const [center] = buildCenters(segments, { componentLevel: 'segment' })
    expect(center).toMatchObject({
      component_level: 'segment', entry_segment_id: 1,
      start_segment_id: 2, end_segment_id: 4,
      departure_segment_id: 5, closed_by_segment_id: 5,
    })
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
    expect(summary).toMatchObject({ id: 2, dir: 'down', start_price: 120, end_price: 90, high: 122, low: 88, bi_count: 3, ended_reason: 'broken', broken: true })
    expect(summarizeSegment(undefined)).toBeNull()
  })

  it('关闭中枢摘要保留固定边界、波动边界和关闭线段', () => {
    const summary = summarizeCenter({ id: 3, zl: 100, zh: 110, fluctuation_high: 118, fluctuation_low: 95, status: 'closed', start_segment_id: 4, end_segment_id: 7, closed_by_segment_id: 8 }, 'H1')
    expect(summary).toMatchObject({ id: 3, zl: 100, zh: 110, gg: 118, dd: 95, status: 'closed', structure_level: 'segment', closed_by_segment_id: 8 })
  })

  it('中枢摘要带有可复现的开始和结束行情时间', () => {
    const segments = [
      { id: 4, dir: 'up', start_price: 100, end_price: 110, bi_ids: [1], raw_start_idx: 2, raw_end_idx: 4 },
      { id: 7, dir: 'down', start_price: 112, end_price: 104, bi_ids: [2], raw_start_idx: 8, raw_end_idx: 10 },
    ]
    const rates = Array.from({ length: 12 }, (_, i) => ({ time: `2026-07-17 ${String(i).padStart(2, '0')}:00:00` }))
    const summary = summarizeCenter({ id: 3, zl: 102, zh: 108, fluctuation_high: 112, fluctuation_low: 98, status: 'closed', start_segment_id: 4, end_segment_id: 7 }, 'H1', segments, [], rates)
    expect(summary).toMatchObject({ start_index: 2, end_index: 10, start_broker_time: '2026-07-17 02:00:00', end_broker_time: '2026-07-17 10:00:00' })
  })
})

describe('detectDivergence', () => {
  it('保留小数值品种的MACD证据，不会在输出层被归零', () => {
    expect(roundMacdEvidence(3.1415926535e-8)).toBe(3.1415927e-8)
    expect(roundMacdEvidence(8.765432109e-6)).toBe(0.0000087654321)
  })

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
    expect(result).toMatchObject({ type:'none', state:'evaluated', confirmed:false })
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
    expect(result).toMatchObject({ type:'none', state:'evaluated', confirmed:false })
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
    expect(result).toMatchObject({ type:'none', state:'evaluated', confirmed:false })
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
    expect(result).toMatchObject({ type: 'none', state: 'unavailable', strength: 'none', reason: 'macd_warmup_overlap' })
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

  it('确认窗口未形成背驰时标记为已评估而非不可用', () => {
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
    const result = detectDivergence(
      segs, bis, [...Array(40).fill(0), ...Array(12).fill(5)],
      [{ status:'confirmed', start_segment_id:3, end_segment_id:3 }],
    )
    expect(result).toMatchObject({ type:'none', state:'evaluated', confirmed:false, reason:'macd_no_divergence' })
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

describe('divergence segment locator', () => {
  function divergenceFixture() {
    const segments = [
      { id: 1, dir: 'down', bi_ids: [1, 2, 3], weak: false, high: 120, low: 90 },
      { id: 2, dir: 'up', bi_ids: [4, 5, 6], weak: false, start_price: 95, end_price: 125, high: 125, low: 95 },
      { id: 3, dir: 'down', bi_ids: [7, 8, 9], weak: false, high: 118, low: 95 },
      { id: 4, dir: 'up', bi_ids: [10, 11, 12], weak: false, start_price: 100, end_price: 130, high: 130, low: 100 },
    ]
    const bis = [
      { id: 4, raw_start_idx: 40, raw_end_idx: 40 }, { id: 5, raw_start_idx: 41, raw_end_idx: 41 }, { id: 6, raw_start_idx: 42, raw_end_idx: 42 },
      { id: 10, raw_start_idx: 46, raw_end_idx: 46, high: 110, low: 100 },
      { id: 11, raw_start_idx: 47, raw_end_idx: 47, high: 122, low: 105 },
      { id: 12, raw_start_idx: 48, raw_end_idx: 48, high: 130, low: 110 },
    ]
    const hist = Array(60).fill(0)
    hist[40] = 5; hist[41] = 5; hist[42] = 5
    hist[46] = 1; hist[47] = 1; hist[48] = 1
    const centers = [{ id: 7, status: 'closed', start_segment_id: 3, end_segment_id: 3 }]
    const rates = Array.from({ length: 60 }, (_, index) => ({
      time: `t${index}`,
      time_utc_msc: 1784185200000 + index * 60000,
    }))
    return { segments, bis, hist, centers, rates }
  }

  it('为确认背驰段返回进入段、离开段和时间范围', () => {
    const { segments, bis, hist, centers, rates } = divergenceFixture()
    const result = detectDivergence(segments, bis, hist, centers, rates)
    expect(result).toMatchObject({
      type: 'top', state: 'confirmed', confirmed: true,
      center_id: 7, entry_segment_id: 2, departure_segment_id: 4,
      entry_segment: {
        start_time: 't40', end_time: 't42',
        start_broker_time: 't40', end_broker_time: 't42',
        start_time_utc_msc: 1784187600000, end_time_utc_msc: 1784187720000,
        stable_id: 'up:1784187600000:1784187720000',
      },
      departure_segment: {
        start_time: 't46', end_time: 't48',
        start_time_utc_msc: 1784187960000, end_time_utc_msc: 1784188080000,
        stable_id: 'up:1784187960000:1784188080000',
      },
    })
    expect(result.divergence_key).toBe('top:up:1784187960000:1784188080000')
  })

  it('历史列表只保留已确认背驰并携带定位信息', () => {
    const { segments, bis, hist, centers, rates } = divergenceFixture()
    const history = detectDivergenceHistory(segments, bis, hist, centers, rates)
    expect(history).toHaveLength(1)
    expect(history[0]).toMatchObject({ type: 'top', state: 'confirmed', departure_segment_id: 4 })
  })

  it('形成中的候选背驰明确标记为未确认', () => {
    const { segments, bis, hist, centers, rates } = divergenceFixture()
    const candidate = { dir: 'up', bi_ids: [10, 11, 12], start_price: 100, end_price: 130 }
    const result = detectFormingDivergence(candidate, segments.slice(0, 3), bis, hist, centers, rates)
    expect(result).toMatchObject({
      type: 'top', state: 'forming', confirmed: false,
      entry_segment_id: 2, departure_segment_id: 4,
      departure_segment: { start_time: 't46', end_time: 't48' },
    })
  })
  it('evaluates a forming segment that provisionally leaves a real segment-level center', () => {
    const segments = [
      { id:1, dir:'up', bi_ids:[1, 2, 3], weak:false, high:125, low:121, start_price:121, end_price:125 },
      { id:2, dir:'down', bi_ids:[4, 5, 6], weak:false, high:120, low:100, start_price:120, end_price:100 },
      { id:3, dir:'up', bi_ids:[7, 8, 9], weak:false, high:118, low:105, start_price:105, end_price:118 },
      { id:4, dir:'down', bi_ids:[10, 11, 12], weak:false, high:122, low:108, start_price:122, end_price:108 },
    ]
    const bis = Array.from({ length:15 }, (_, index) => ({
      id:index + 1,
      raw_start_idx:40 + index,
      raw_end_idx:40 + index,
      high:index >= 12 ? 130 : 125,
      low:index >= 12 ? 119 : 100,
    }))
    const centers = buildCenters(segments)
    const hist = [...Array(40).fill(0), ...Array(3).fill(5), ...Array(9).fill(0), ...Array(3).fill(1)]
    const candidate = { dir:'up', bi_ids:[13, 14, 15], start_price:119, end_price:130 }
    const result = detectFormingDivergence(candidate, segments, bis, hist, centers)

    expect(centers[0]).toMatchObject({ component_level:'segment', status:'confirmed', departure_segment_id:null })
    expect(result).toMatchObject({
      type:'top', state:'forming', confirmed:false,
      entry_segment_id:1, departure_segment_id:5,
    })
    const touchingBis = bis.map(item => item.id >= 13 ? { ...item, low:118 } : item)
    const touching = detectFormingDivergence(
      { ...candidate, start_price:118 }, segments, touchingBis, hist, centers)
    expect(touching).toMatchObject({ type:'top', state:'forming', departure_segment_id:5 })
  })
})

describe('advanced Chan structure evidence', () => {
  const segment = (id, dir, low, high, endPrice = dir === 'up' ? high : low) => ({
    id, dir, low, high, start_price: dir === 'up' ? low : high, end_price: endPrice,
    bi_ids: [id * 3 - 2, id * 3 - 1, id * 3], weak: false,
    raw_start_idx:(id - 1) * 4, raw_end_idx:id * 4 - 1,
  })
  const entryRates = Array.from({ length:40 }, (_, index) => ({
    time:`t${index}`, time_utc_msc:1784185200000 + index * 300000,
  }))
  const stableSegment = value => summarizeSegment(value, [], entryRates)

  it('classifies a confirmed top divergence as upward exhaustion', () => {
    const segments = [segment(1, 'down', 90, 120), segment(2, 'up', 95, 130)]
    const result = classifyChanTrend(segments, [{ id: 7, zl: 100, zh: 110 }], 129, {
      type: 'top', confirmed: true, strength: 'strong', center_id: 7, departure_segment_id: 2,
    }, 'high')
    expect(result).toMatchObject({
      state: 'upward_exhaustion', direction: 'up', phase: 'exhaustion', reversal_bias: 'down', confidence: 'high',
    })
  })

  it('uses separated rising centers as a conservative uptrend', () => {
    const segments = [segment(1, 'up', 90, 110), segment(2, 'down', 100, 115), segment(3, 'up', 105, 125)]
    const centers = [{ id: 1, zl: 95, zh: 100 }, { id: 2, zl: 105, zh: 110 }]
    expect(classifyChanTrend(segments, centers, 123, { type: 'none' }, 'high')).toMatchObject({
      state: 'uptrend', direction: 'up', phase: 'trend', reason: 'centers_rising_without_overlap',
    })
  })

  it('does not label price outside an unclosed old center as consolidation', () => {
    const segments = [segment(1, 'up', 90, 110), segment(2, 'down', 95, 115), segment(3, 'up', 100, 120)]
    const center = [{ id: 1, zl: 100, zh: 110, status: 'extended', closed_by_segment_id: null }]
    expect(classifyChanTrend(segments, center, 82, { type: 'none' }, 'high')).toMatchObject({
      state: 'downward_breakout_pending', direction: 'down', phase: 'breakout_candidate',
      confidence: 'low', reason: 'price_below_unclosed_center',
    })
    expect(classifyChanTrend(segments, center, 128, { type: 'none' }, 'high')).toMatchObject({
      state: 'upward_breakout_pending', direction: 'up', phase: 'breakout_candidate',
      confidence: 'low', reason: 'price_above_unclosed_center',
    })
  })

  it('only labels a closed center as returned when price is actually inside', () => {
    const segments = [segment(1, 'up', 90, 115), segment(2, 'down', 95, 112)]
    const center = [{ id: 1, zl: 100, zh: 110, status: 'closed', closed_by_segment_id: 2 }]

    expect(classifyChanTrend(segments, center, 105, { type:'none' }, 'high')).toMatchObject({
      state:'consolidation', direction:'neutral', reason:'price_returned_to_center',
    })
    expect(classifyChanTrend(segments, center, 125, { type:'none' }, 'high')).toMatchObject({
      state:'upward_breakout_pending', direction:'up', phase:'breakout_candidate', confidence:'low',
      reason:'price_above_closed_center_without_confirmed_rebreakout',
    })
  })

  it('recognizes a confirmed same-direction close and a later confirmed rebreakout', () => {
    const directlyClosed = [segment(1, 'down', 90, 112), segment(2, 'up', 98, 120)]
    const directCenter = [{ id:1, zl:100, zh:110, status:'closed', closed_by_segment_id:2 }]
    expect(classifyChanTrend(directlyClosed, directCenter, 125, { type:'none' }, 'high')).toMatchObject({
      state:'upward_breakout', direction:'up', reason:'price_above_closed_center', segment_id:2,
    })

    const rebroken = [
      segment(1, 'up', 90, 115), segment(2, 'down', 95, 112), segment(3, 'up', 101, 125),
    ]
    const rebrokenCenter = [{ id:1, zl:100, zh:110, status:'closed', closed_by_segment_id:2 }]
    expect(classifyChanTrend(rebroken, rebrokenCenter, 123, { type:'none' }, 'high')).toMatchObject({
      state:'upward_breakout', direction:'up', phase:'breakout',
      reason:'price_above_closed_center_after_confirmed_rebreakout', segment_id:3,
    })
  })

  it('keeps the confirmed direction but exposes an unconfirmed opposite segment transition', () => {
    const segments = [segment(1, 'down', 90, 112), segment(2, 'up', 95, 125)]
    const forming = { id:3, dir:'down', bi_ids:[7, 8, 9] }
    expect(classifyChanTrend(segments, [], 118, { type:'none' }, 'high', forming)).toMatchObject({
      state:'structural_rise_transition', direction:'up', phase:'transition',
      reversal_bias:'down', confidence:'low', reason:'forming_opposite_segment_unconfirmed',
      segment_id:2, candidate_segment_id:3, candidate_direction:'down',
    })
  })

  it('separates a forming segment price extreme from its latest included evidence', () => {
    const rates = Array.from({ length:12 }, (_, index) => ({
      time:`t${index}`, time_utc_msc:1784185200000 + index * 300000,
    }))
    const bis = [
      { id:1, raw_start_idx:0, raw_end_idx:2, high:130, low:118 },
      { id:2, raw_start_idx:2, raw_end_idx:5, high:128, low:120 },
      { id:3, raw_start_idx:5, raw_end_idx:8, high:126, low:121 },
      { id:4, raw_start_idx:8, raw_end_idx:11, high:127, low:122 },
    ]
    const base = {
      dir:'down', bi_ids:[1, 2, 3], start_price:130, end_price:118,
      endpoint_raw_idx:2, confirmation_state:'awaiting_first_feature_fractal',
    }
    const first = summarizeSegment(buildFormingSegment(base, bis, 3), bis, rates)
    const advanced = summarizeSegment(buildFormingSegment({ ...base, bi_ids:[1, 2, 3, 4] }, bis, 3), bis, rates)

    expect(first).toMatchObject({
      confirmed:false, lifecycle_state:'forming_unconfirmed', endpoint_semantics:'directional_extreme',
      end_index:2, observation_end_index:8, last_included_bi_id:3,
    })
    expect(advanced.end_time_utc_msc).toBe(first.end_time_utc_msc)
    expect(advanced.observation_end_time_utc_msc).toBeGreaterThan(first.observation_end_time_utc_msc)
    expect(advanced).toMatchObject({ observation_end_index:11, last_included_bi_id:4 })
  })

  it('emits first-buy evidence but disables it when structure reliability is low', () => {
    const segments = [segment(1, 'up', 95, 125), segment(2, 'down', 85, 118)]
    const centers = [{ id:3, zl:95, zh:105, entry_segment_id:1, departure_segment_id:2 }]
    const candidates = detectChanEntryCandidates(segments, centers, {
      type: 'bottom', confirmed: true, strength: 'strong', center_id: 3,
      departure_segment_id: 2, price_extreme_cur: 85,
      entry_segment:stableSegment(segments[0]), departure_segment:stableSegment(segments[1]),
    }, [], [], entryRates, 'low', true)
    expect(candidates).toHaveLength(1)
    expect(candidates[0]).toMatchObject({
      type: 'first_buy', side: 'buy', state: 'confirmed_candidate', usable_for_entry: false,
      reference_price: 85, invalidation_price: 85, confidence: 'low',
    })
  })

  it('keeps stale entry candidates for observation but not entry use', () => {
    const departure = { ...segment(2, 'down', 85, 118), raw_start_idx: 5, raw_end_idx: 10 }
    const entry = segment(1, 'up', 95, 125)
    const rates = Array.from({ length: 50 }, (_, index) => ({
      time: `t${index}`, time_utc_msc:1784185200000 + index * 300000,
    }))
    const candidates = detectChanEntryCandidates([entry, departure], [{
      id:3, entry_segment_id:1, departure_segment_id:2,
    }], {
      type: 'bottom', confirmed: true, strength: 'strong', departure_segment_id: 2, price_extreme_cur: 85,
      entry_segment:summarizeSegment(entry, [], rates), departure_segment:summarizeSegment(departure, [], rates),
    }, [], [], rates, 'high', true)
    expect(candidates[0]).toMatchObject({
      type: 'first_buy', freshness: 'stale', bars_since_point: 39, max_age_bars: 20, usable_for_entry: false,
    })
  })

  it('recognizes a higher-low second buy and a center-holding third buy', () => {
    const segments = [
      segment(1, 'down', 90, 120), segment(2, 'up', 95, 125), segment(3, 'down', 92, 118),
      segment(4, 'up', 105, 130), segment(5, 'down', 112, 128),
    ]
    const divergences = [{
      type:'bottom', confirmed:true, departure_segment_id:2, center_id:1, price_extreme_cur:90,
      entry_segment:stableSegment(segments[0]), departure_segment:stableSegment(segments[1]),
    }]
    const centers = [
      { id:1, zl:90, zh:100, entry_segment_id:1, departure_segment_id:2 },
      { id:2, zl:100, zh:110, status:'closed', closed_by_segment_id:4 },
    ]
    const candidates = detectChanEntryCandidates(segments, centers, { type:'none' }, divergences, [], entryRates, 'high', true)
    expect(candidates.map(item => item.type)).toEqual(['second_buy', 'third_buy'])
    expect(candidates.every(item => item.usable_for_entry)).toBe(true)
    expect(candidates.find(item => item.type === 'third_buy')?.invalidation_price).toBe(110)
  })

  it('does not promote a divergence from a prior bi run into a current second-buy candidate', () => {
    const segments = [
      segment(1, 'down', 90, 120), segment(2, 'up', 95, 125), segment(3, 'down', 92, 118),
    ]
    const priorRunDivergences = [{
      type:'bottom', confirmed:true, bi_run_id:1,
      departure_segment_id:1, center_id:1, price_extreme_cur:90,
    }]

    const candidates = detectChanEntryCandidates(
      segments, [], { type:'none' }, priorRunDivergences, [], [], 'high', true, 2,
    )

    expect(candidates).toEqual([])
  })

  it('does not bind a historical second-buy divergence to a different center with recycled numeric ids', () => {
    const segments = [
      segment(1, 'down', 90, 120), segment(2, 'up', 95, 125), segment(3, 'down', 92, 118),
      segment(4, 'up', 105, 130), segment(5, 'down', 112, 128),
    ]
    const recycledCenter = {
      id:1, zl:100, zh:110, status:'confirmed',
      entry_segment_id:3, departure_segment_id:4,
    }
    const historical = [{
      type:'bottom', confirmed:true, bi_run_id:2, center_id:1,
      departure_segment_id:2, price_extreme_cur:90,
      entry_segment:stableSegment(segments[0]), departure_segment:stableSegment(segments[1]),
    }]

    const candidates = detectChanEntryCandidates(
      segments, [recycledCenter], { type:'none' }, historical, [], entryRates, 'high', true, 2,
    )

    expect(candidates).toEqual([])
  })
})

describe('latest closed-market Chan structure', () => {
  const rate = (brokerTime, high, low, close = (high + low) / 2) => ({
    time:brokerTime,
    time_utc_msc:Date.parse(`${brokerTime.replace(' ', 'T')}+03:00`),
    open:close, high, low, close, tick_volume:1,
  })

  it('confirms the Aug-19 bottom only after the right-side H1 bar closes', () => {
    const rates = [
      rate('2026-08-19 02:00:00', 4346.51, 4328.92, 4334.74),
      rate('2026-08-19 04:00:00', 4343.78, 4332.76, 4333.82),
      rate('2026-08-19 05:00:00', 4338.44, 4327.25, 4333),
      rate('2026-08-19 06:00:00', 4347.27, 4331.7, 4338.15),
    ]
    const beforeRightBar = normalizeBarsForChan(rates.slice(0, -1))
    expect(detectFractals(beforeRightBar)).toEqual([])

    const normalized = normalizeBarsForChan(rates)
    const fractals = detectFractals(normalized)
    const latest = summarizeLatestConfirmedFractal(fractals, normalized, rates)
    expect(latest).toMatchObject({
      type:'bottom', price:4327.25, time:'2026-08-19 05:00:00',
      confirmed_by_bar_time:'2026-08-19 06:00:00', confirmed:true,
    })
  })

  it('turns the Aug-25 confirmed top into a current down reversal watch, not an old-center up verdict', () => {
    const rates = [
      rate('2026-08-25 05:00:00', 4683.01, 4666.88, 4679.87),
      rate('2026-08-25 06:00:00', 4696.65, 4675.18, 4684.24),
      rate('2026-08-25 07:00:00', 4686.21, 4656.61, 4657.99),
    ]
    const normalized = normalizeBarsForChan(rates)
    const fractals = detectFractals(normalized)
    const latestStructure = buildLatestChanStructure({
      fractals, normalizedBars:normalized, rates,
      currentBi:{ id:9, dir:'up', start_price:4625.19, end_price:4696.65, confirmed:true },
      developingBi:{ dir:'down', start_price:4696.65, end_price:4656.61, confirmed:false },
      currentSegment:{ id:7, dir:'up', confirmed:true, last_included_bi_id:4 },
      candidateSegment:null,
    })
    const result = prioritizeLatestChanStructure({
      state:'upward_breakout', direction:'up', phase:'breakout', reversal_bias:'none',
      confidence:'medium', reason:'price_above_closed_center_after_confirmed_rebreakout',
      center_id:1, segment_id:7,
    }, latestStructure, 'medium')

    expect(result.latest_structure).toMatchObject({
      latest_confirmed_fractal:{ type:'top', price:4696.65 },
      local_state:'reversal_watch', local_bias:'down', background_bias:'up',
      active_segment:null, historical_context_used_for_direction:false,
    })
    expect(result.trend_state).toMatchObject({
      state:'up_reversal_watch', direction:'up', reversal_bias:'down', local_bias:'down',
      background_direction:'up', reason:'latest_confirmed_top_fractal_with_developing_down_bi',
    })
  })

  it('retires a long-lived candidate after its origin is crossed without rewriting short candidates', () => {
    const makeBi = (id, dir, start, end) => ({
      id, dir, start_price:start, end_price:end,
      high:Math.max(start, end), low:Math.min(start, end),
      raw_start_idx:id * 2 - 2, raw_end_idx:id * 2 - 1,
    })
    const shortCandidateBis = [
      makeBi(1, 'up', 100, 110), makeBi(2, 'down', 110, 95),
      makeBi(3, 'up', 95, 105), makeBi(4, 'down', 105, 90),
    ]
    const shortCandidate = { dir:'up', start_price:100, bi_ids:[1, 2, 3, 4] }
    expect(inspectSegmentCandidateLifecycle(shortCandidate, shortCandidateBis).invalidated).toBe(false)
    expect(buildFormingSegment(shortCandidate, shortCandidateBis, 1)).not.toBeNull()

    const staleBis = [
      makeBi(1, 'down', 130, 110), makeBi(2, 'up', 110, 135),
      makeBi(3, 'down', 135, 105), makeBi(4, 'up', 105, 140),
      makeBi(5, 'down', 140, 108), makeBi(6, 'up', 108, 145),
      makeBi(7, 'down', 145, 112),
    ]
    const staleCandidate = { dir:'down', start_price:130, bi_ids:staleBis.map(item => item.id) }
    expect(inspectSegmentCandidateLifecycle(staleCandidate, staleBis)).toMatchObject({
      invalidated:true, reason:'candidate_origin_broken_by_opposite_extreme', invalidatedByBiId:2,
    })
    expect(buildFormingSegment(staleCandidate, staleBis, 1)).toBeNull()
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

  it('marks Chan time locations unreliable when the market clock is unverified', () => {
    const rates = makeRates(50).map((rate, index) => ({
      ...rate,
      time_utc_msc: 1784185200000 + index * 300000,
    }))
    const macdHist = rates.map((_, i) => Math.sin(i * 0.3) * 5)
    const result = computeChan(rates, 'M5', macdHist, {
      requestedHistoryCount: 50,
      dataQuality: { clock_status: 'stale_or_unverified', cache_gap_refilled: true },
    })
    expect(result).toMatchObject({
      clock_status: 'stale_or_unverified',
      time_location_reliable: false,
      cache_gap_refilled: true,
      reliability: 'low',
    })
    expect(result.warnings).toContain('market_clock_unverified')
  })

  it('keeps a stable H1 segment direction usable without a center or anchor', () => {
    const rates = Array.from({ length: 1200 }, (_, index) => {
      const close = 100 + Math.sin(index * 0.19) * 10 + Math.sin(index * 0.037) * 30
      return {
        time:`2026-01-01 ${String(index).padStart(4, '0')}:00:00`,
        time_utc_msc:1784185200000 + index * 3600000,
        open:close, high:close + 3, low:close - 3, close, tick_volume:1,
      }
    })
    const result = computeChan(rates, 'H1', [], {
      maximumHistoryCount:1200,
      validationWindowCounts:[1000, 1100, 1200],
      dataQuality:{
        platform:'mt4', source_id:9, timezone_offset_minutes:180,
        clock_status:'mt4_current_offset', clock_sample_age_ms:0, last_bar_closed:true,
      },
    })
    expect(result).toMatchObject({
      center_count:0,
      trend_state:{ direction:'down' },
      evidence_capabilities:{
        absolute_time_location_reliable:false,
        segment_direction_usable:true,
        center_structure_usable:false,
        entry_structure_usable:false,
        divergence_usable:false,
      },
      structure_anchor:{ bootstrap_state:'unavailable', current_result_usable:false },
    })
    expect(result.warnings).not.toContain('structure_anchor_bootstrap_pending')
  })

  it('reports pending only for a confirmed two-phase anchor candidate', () => {
    const rates = Array.from({ length: 800 }, (_, index) => {
      const close = 100 + Math.sin(index * 0.02) * 20
        + Math.sin(index * 0.06) * 10 + Math.sin(index * 0.35) * 3
      return {
        time:`2026-01-01 ${String(index).padStart(4, '0')}:00:00`,
        time_utc_msc:1784185200000 + index * 300000,
        open:close, high:close + 1, low:close - 1, close, tick_volume:1,
      }
    })
    const result = computeChan(rates, 'M5', [], {
      maximumHistoryCount:800,
      validationWindowCounts:[600, 700, 800],
      dataQuality:{ platform:'mt5', source_id:9, clock_status:'verified', last_bar_closed:true },
    })
    expect(result).toMatchObject({
      center_count:1,
      evidence_capabilities:{ segment_direction_usable:true },
      structure_anchor:{
        bootstrap_state:'confirmed', current_result_usable:false,
        recommended_time_utc_msc:expect.any(Number),
        bootstrap_identity:expect.any(String),
      },
    })
    expect(result.warnings).toContain('structure_anchor_bootstrap_pending')
    expect(result.divergence.reason).toBe('structure_anchor_bootstrap_pending')
    expect(result.entry_candidates).toEqual([])
  })

  it('accepts a fresh MT4 current-offset key only for source-scoped structure identity', () => {
    const rates = makeRates(50).map((rate, index) => ({
      ...rate,
      time_utc_msc: 1784185200000 + index * 300000,
    }))
    const result = computeChan(rates, 'M5', calculateMacdSeries(rates.map(rate => Number(rate.close))).histSeries, {
      requestedHistoryCount: 50,
      dataQuality: {
        platform: 'mt4', source_id: 9, timezone_offset_minutes: 180,
        clock_status: 'mt4_current_offset', clock_sample_age_ms: 0, last_bar_closed: true,
      },
    })
    expect(result).toMatchObject({
      clock_status: 'mt4_current_offset', clock_trust_level: 'derived_unverified_history',
      time_location_reliable: false,
    })
    expect(result).toMatchObject({ structure_time_key_reliable:true, structure_time_key_basis:'mt4_current_offset_source_scoped' })
    expect(result.warnings).toContain('market_clock_unverified')
    expect(result.warnings).toContain('mt4_historical_offset_unverified')
  })

  it('does not claim exact UTC locations for long MT4 history converted with only the current offset', () => {
    const rates = makeRates(60).map((rate, index) => ({
      ...rate,
      time_utc_msc:1784185200000 + index * 24 * 60 * 60 * 1000,
    }))
    const result = computeChan(rates, 'H4', calculateMacdSeries(rates.map(rate => Number(rate.close))).histSeries, {
      requestedHistoryCount:60,
      dataQuality:{
        platform:'mt4', source_id:9, timezone_offset_minutes:180,
        clock_status:'mt4_current_offset', clock_sample_age_ms:0, last_bar_closed:true,
      },
    })
    expect(result).toMatchObject({
      clock_status:'mt4_current_offset',
      clock_trust_level:'derived_unverified_history',
      time_location_reliable:false,
      structure_time_key_reliable:true,
      structure_time_key_basis:'mt4_current_offset_source_scoped',
    })
    expect(result.warnings).toContain('mt4_historical_offset_unverified')
  })

  it.each([
    ['missing source identity', { platform:'mt4', timezone_offset_minutes:180, clock_sample_age_ms:0 }],
    ['stale clock sample', { platform:'mt4', source_id:9, timezone_offset_minutes:180, clock_sample_age_ms:300001 }],
    ['invalid broker offset', { platform:'mt4', source_id:9, timezone_offset_minutes:181, clock_sample_age_ms:0 }],
  ])('fails closed for MT4 structure time when %s', (_label, metadata) => {
    const rates = makeRates(50).map((rate, index) => ({
      ...rate,
      time_utc_msc:1784185200000 + index * 300000,
    }))
    const result = computeChan(rates, 'M5', calculateMacdSeries(rates.map(rate => Number(rate.close))).histSeries, {
      requestedHistoryCount:50,
      dataQuality:{ ...metadata, clock_status:'mt4_current_offset', last_bar_closed:true },
    })
    expect(result).toMatchObject({
      time_location_reliable:false,
      structure_time_key_reliable:false,
      structure_time_key_basis:'untrusted',
    })
  })

  it('reports read-only bi centers separately from execution-grade segment centers', () => {
    const rates = makeRates(50)
    const result = computeChan(rates, 'M5', calculateMacdSeries(rates.map(rate => Number(rate.close))).histSeries)
    expect(result).toMatchObject({ algorithm_version: 'chan_structure_v7', center_level: 'segment' })
    expect(result.bi_center_count).toBeGreaterThan(0)
    expect(result.latest_bi_center).toMatchObject({ structure_level: 'bi' })
    expect(result.center_count).toBe(0)
  })

  it('uses the final bar when market data marks it as completed', () => {
    const rates = makeRates(50).map((rate, index) => ({
      ...rate,
      time_utc_msc: 1784185200000 + index * 300000,
    }))
    const result = computeChan(rates, 'M5', calculateMacdSeries(rates.map(r => Number(r.close))).histSeries, {
      requestedHistoryCount: 50,
      dataQuality: { clock_status: 'verified', last_bar_closed: true },
    })
    expect(result.closed_bar_count).toBe(50)
    expect(result.requested_closed_history_count).toBe(50)
    expect(result.closed_history_sufficient).toBe(true)
  })

  it('downgrades Chan reliability when an internal cache gap remains unresolved', () => {
    const rates = makeRates(50).map((rate, index) => ({
      ...rate,
      time_utc_msc: 1784185200000 + index * 300000,
    }))
    const result = computeChan(rates, 'M5', calculateMacdSeries(rates.map(r => Number(r.close))).histSeries, {
      requestedHistoryCount: 50,
      dataQuality: { clock_status: 'verified', cache_internal_gap_unresolved: true },
    })
    expect(result.cache_internal_gap_unresolved).toBe(true)
    expect(result.reliability).toBe('low')
    expect(result.warnings).toContain('cache_internal_gap_unresolved')
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

  it('多个起点对末端边界达成共识时仍输出完整线段', () => {
    let state = 1
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
    expect(result.closed_bar_count).toBe(299)
    expect(result.window_resynced).toBe(true)
    expect(result.window_stable).toBe(true)
    expect(result.segment_count).toBeGreaterThan(0)
  })

  it('请求历史不足时明确降级并报告数量', () => {
    const rates = makeRates(120)
    const result = computeChan(rates, 'M5', calculateMacdSeries(rates.map(r => Number(r.close))).histSeries, { requestedHistoryCount: 300 })
    expect(result).toMatchObject({ requested_history_count: 300, received_history_count: 120, history_sufficient: false })
    expect(result.warnings).toContain('history_bars_below_requested')
    expect(result.reliability).toBe('low')
  })

  it('不同历史窗口未收敛时不把单窗口分解升级为确认结构', () => {
    const rates = makeRates(300)
    const result = computeChan(rates, 'M5', calculateMacdSeries(rates.map(rate => Number(rate.close))).histSeries)
    expect(result).toMatchObject({
      status: 'segment_history_unresolved', window_selection: 'full_window_unresolved',
      window_stable: false, segment_count: 0, center_count: 0,
      structure_anchor: {
        matched:false, recommended_time_utc_msc:null, last_confirmed_segment_time_utc_msc:null,
      },
    })
    expect(result.warnings).toContain('segment_cross_window_unstable')
  })

  it('keeps every entry-dependent field closed when unanchored history is below 300 bars', () => {
    const rates = makeRates(299).map((rate, index) => ({
      ...rate, time_utc_msc:1784185200000 + index * 300000,
    }))
    const result = computeChan(rates, 'M5', calculateMacdSeries(rates.map(rate => Number(rate.close))).histSeries, {
      requestedHistoryCount:299,
      dataQuality:{ clock_status:'verified', last_bar_closed:true },
    })

    expect(result.window_selection).toBe('full_window_unanchored')
    expect(result.structure_anchor).toMatchObject({
      bootstrap_state:'unavailable', current_result_usable:false, recommended_time_utc_msc:null,
    })
    expect(result.warnings).not.toContain('structure_anchor_bootstrap_pending')
    expect(result.divergence.type).toBe('none')
    expect(result.forming_divergence.type).toBe('none')
    expect(result.recent_divergences).toEqual([])
    expect(result.entry_candidates).toEqual([])
  })

  it('uses one authoritative bounded window when more than the fixed target is supplied', () => {
    const rates = makeRates(2001).map((rate, index) => ({
      ...rate, time_utc_msc:1784185200000 + index * 300000,
    }))
    const result = computeChan(rates, 'M5', calculateMacdSeries(rates.map(rate => Number(rate.close))).histSeries, {
      requestedHistoryCount:2001,
      dataQuality:{ clock_status:'verified', last_bar_closed:true },
    })

    expect(result.source_history_count).toBe(2001)
    expect(result.calculation_window_count).toBe(1800)
    expect(result.raw_bar_count).toBe(1800)
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

describe('computeChan trusted anchor recovery', () => {
  const periods = [
    ['M5', 1800],
    ['M15', 2000],
    ['H1', 1800],
    ['H4', 1000],
  ]

  function trustedAnchorFrom(result) {
    return {
      anchor_time_utc_msc:result.structure_anchor.recommended_time_utc_msc,
      bootstrap_core_stable_id:result.structure_anchor.bootstrap_core_stable_id,
      bootstrap_entry_segment_stable_id:result.structure_anchor.bootstrap_entry_segment_stable_id,
      last_confirmed_segment_time_utc_msc:result.structure_anchor.last_confirmed_segment_time_utc_msc,
    }
  }

  it.each(periods)('skips a %s anchor that is before the closed window and preserves stable structure',
    (timeframe, target) => {
      const rates = makeStableChanRates(target, 300000, timeframe === 'H4' ? 0 : 25)
      const plain = computeChan(rates, timeframe, [], { dataQuality:chanDataQuality() })
      const requestedAnchor = {
        anchor_time_utc_msc:rates[0].time_utc_msc - 300000,
        bootstrap_core_stable_id:'outside-window-core',
        bootstrap_entry_segment_stable_id:'outside-window-entry',
        last_confirmed_segment_time_utc_msc:rates[0].time_utc_msc - 300000,
      }
      const result = computeChan(rates, timeframe, [], {
        dataQuality:chanDataQuality(), trustedStructureAnchor:requestedAnchor,
      })

      expect(result.warnings).toContain('structure_anchor_outside_window')
      expect(result.warnings).not.toContain('structure_anchor_not_found')
      expect(result.structure_anchor).toMatchObject({
        requested_time_utc_msc:requestedAnchor.anchor_time_utc_msc,
        requested_core_stable_id:requestedAnchor.bootstrap_core_stable_id,
        requested_entry_segment_stable_id:requestedAnchor.bootstrap_entry_segment_stable_id,
        requested_last_confirmed_segment_time_utc_msc:requestedAnchor.last_confirmed_segment_time_utc_msc,
        matched:false, time_matched:false, identity_matched:false,
      })
      expect(result.window_stable).toBe(plain.window_stable)
      expect(result.segment_count).toBe(plain.segment_count)
      expect(result.center_count).toBe(plain.center_count)
      expect(result.current_segment?.stable_id).toBe(plain.current_segment?.stable_id)
      expectHiddenChanEvidence(result)
    }, 30000)

  it.each(periods)('keeps the normal %s trusted-anchor path authoritative',
    (timeframe, target) => {
      const rates = makeStableChanRates(target, 300000, timeframe === 'H4' ? 0 : 25)
      const options = { dataQuality:chanDataQuality() }
      const plain = computeChan(rates, timeframe, [], options)
      const requestedAnchor = trustedAnchorFrom(plain)
      expect(requestedAnchor.anchor_time_utc_msc).toBeGreaterThan(rates[0].time_utc_msc)
      const result = computeChan(rates, timeframe, [], {
        ...options, trustedStructureAnchor:requestedAnchor,
      })

      expect(result.structure_anchor).toMatchObject({
        requested_time_utc_msc:requestedAnchor.anchor_time_utc_msc,
        matched:true, time_matched:true, identity_matched:true,
        last_confirmed_segment_not_regressed:true, current_result_usable:true,
      })
      expect(result.current_segment?.stable_id).toBe(plain.current_segment?.stable_id)
      expect(result.latest_center?.core_stable_id).toBe(plain.latest_center?.core_stable_id)
      expect(result.evidence_capabilities.entry_structure_usable).toBe(true)
      expectHiddenChanEvidence(result)
    }, 30000)

  it.each(periods)('reuses the same unanchored evidence after %s anchor identity failures',
    (timeframe, target) => {
      const rates = makeStableChanRates(target, 300000, timeframe === 'H4' ? 0 : 25)
      const options = { dataQuality:chanDataQuality() }
      const plain = computeChan(rates, timeframe, [], options)
      const trustedAnchor = trustedAnchorFrom(plain)
      const cases = [
        {
          warning:'structure_anchor_identity_missing',
          anchor:{ anchor_time_utc_msc:trustedAnchor.anchor_time_utc_msc },
        },
        {
          warning:'structure_anchor_identity_mismatch',
          anchor:{ ...trustedAnchor, bootstrap_core_stable_id:'wrong-core' },
        },
        {
          warning:'structure_anchor_last_segment_regressed',
          anchor:{
            ...trustedAnchor,
            last_confirmed_segment_time_utc_msc:trustedAnchor.last_confirmed_segment_time_utc_msc + 300000,
          },
        },
      ]

      for (const item of cases) {
        const result = computeChan(rates, timeframe, [], {
          ...options, trustedStructureAnchor:item.anchor,
        })
        expect(result.warnings).toContain(item.warning)
        expect(result.structure_anchor.matched).toBe(false)
        expect(result.current_segment?.stable_id).toBe(plain.current_segment?.stable_id)
        expect(result.segment_count).toBe(plain.segment_count)
        expect(result.center_count).toBe(plain.center_count)
        expectHiddenChanEvidence(result)
      }
    }, 120000)

  it.each(periods)('fails closed for a future %s trusted anchor', (timeframe, target) => {
    const rates = makeStableChanRates(target, 300000, timeframe === 'H4' ? 0 : 25)
    const requestedAnchor = {
      anchor_time_utc_msc:rates.at(-1).time_utc_msc + 300000,
      bootstrap_core_stable_id:'future-core',
      bootstrap_entry_segment_stable_id:'future-entry',
      last_confirmed_segment_time_utc_msc:rates.at(-1).time_utc_msc + 300000,
    }
    const result = computeChan(rates, timeframe, [], {
      dataQuality:chanDataQuality(), trustedStructureAnchor:requestedAnchor,
    })

    expect(result.warnings).toContain('structure_anchor_future')
    expect(result.warnings).not.toContain('structure_anchor_outside_window')
    expect(result.structure_anchor).toMatchObject({
      requested_time_utc_msc:requestedAnchor.anchor_time_utc_msc,
      requested_core_stable_id:requestedAnchor.bootstrap_core_stable_id,
      requested_entry_segment_stable_id:requestedAnchor.bootstrap_entry_segment_stable_id,
      matched:false, current_result_usable:false,
    })
    expect(result.evidence_capabilities).toMatchObject({
      segment_direction_usable:false, center_structure_usable:false,
      entry_structure_usable:false, divergence_usable:false,
    })
    expectHiddenChanEvidence(result)
  }, 30000)

  it('distinguishes equal and interior UTC anchors from a before-window anchor', () => {
    const rates = makeStableChanRates(1800)
    for (const anchorTime of [rates[0].time_utc_msc, rates[1].time_utc_msc]) {
      const result = computeChan(rates, 'M5', [], {
        dataQuality:chanDataQuality(),
        trustedStructureAnchor:{ anchor_time_utc_msc:anchorTime },
      })
      expect(result.warnings).not.toContain('structure_anchor_outside_window')
      expect(result.structure_anchor.requested_time_utc_msc).toBe(anchorTime)
    }
  }, 30000)
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
    expect(result.bi_discontinuity_count).toBeGreaterThan(0)
    expect(result.last_bi_discontinuity).toBeTruthy()
    expect(result.warnings).not.toContain('invalid_bi_price_direction')
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
  it('does not treat a near-equal MACD peak as height divergence', () => {
    const segs = [
      { id: 1, dir: 'up', bi_ids: [1, 2, 3], weak: false, high: 125, low: 95 },
      { id: 5, dir: 'up', bi_ids: [4, 5, 6], weak: false, high: 130, low: 100 },
    ]
    const bis = Array.from({ length: 6 }, (_, i) => ({ id: i + 1, raw_start_idx: i + 40, raw_end_idx: i + 40 }))
    const hist = Array(80).fill(0)
    hist[40] = 5; hist[41] = 5; hist[42] = 5
    hist[43] = 4.999999; hist[44] = 4.999999; hist[45] = 4.999999
    const result = detectDivergence(segs, bis, hist, [{ status: 'confirmed', start_segment_id: 2, end_segment_id: 4 }])
    expect(result.type).toBe('none')
    expect(result.reason).toBe('macd_no_divergence')
    expect(result.peak_ratio).toBe(1)
  })

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

describe('persistent Chan structure anchor', () => {
  const consensusSegmentChain = () => [
    { id:1, stable_id:'entry', dir:'up', low:121, high:125, start_price:121, end_price:125, bi_count:3, start_time_utc_msc:100, end_time_utc_msc:200 },
    { id:2, stable_id:'s1', dir:'down', low:100, high:120, start_price:120, end_price:100, bi_count:3, start_time_utc_msc:300, end_time_utc_msc:400 },
    { id:3, stable_id:'p1', dir:'up', low:105, high:118, start_price:105, end_price:118, bi_count:3, start_time_utc_msc:500, end_time_utc_msc:600 },
    { id:4, stable_id:'c1', dir:'down', low:108, high:122, start_price:122, end_price:108, bi_count:3, start_time_utc_msc:700, end_time_utc_msc:800 },
  ]

  it('prefers the terminal structure supported by more independent windows', () => {
    const result = (previous, current, raw, centerCount = 0) => ({
      window_stable: true,
      segment_count: centerCount ? 3 : 2,
      center_count: centerCount,
      raw_bar_count: raw,
      prev_segment: { stable_id: previous },
      current_segment: { stable_id: current },
    })
    const selected = selectStableChanResult([
      result('p1', 'c1', 900), result('p1', 'c1', 800), result('p1', 'c1', 700),
      result('p2', 'c2', 600, 1), result('p2', 'c2', 500, 1),
    ])
    expect(selected.current_segment.stable_id).toBe('c1')
    expect(selected.raw_bar_count).toBe(900)
  })

  it('rejects tied cross-window terminal structures instead of choosing by data richness', () => {
    const result = (previous, current, raw, centerCount = 0) => ({
      window_stable: true,
      segment_count: centerCount ? 3 : 2,
      center_count: centerCount,
      raw_bar_count: raw,
      prev_segment: { stable_id: previous },
      current_segment: { stable_id: current },
    })
    expect(selectStableChanResult([
      result('p1', 'c1', 900), result('p1', 'c1', 800),
      result('p2', 'c2', 700, 1), result('p2', 'c2', 600, 1),
    ])).toBeNull()
  })

  it('does not let suffix windows replace a terminal segment phase absent from the full window', () => {
    const candidate = (previous, current, raw) => ({
      window_stable:true, segment_count:2, center_count:0, raw_bar_count:raw,
      prev_segment:{ stable_id:previous }, current_segment:{ stable_id:current },
    })
    const primary = candidate('full-prev', 'full-current', 1000)
    expect(selectStableChanResult([
      primary,
      candidate('full-prev', 'full-current', 900),
      candidate('suffix-prev', 'suffix-current', 800),
      candidate('suffix-prev', 'suffix-current', 700),
      candidate('suffix-prev', 'suffix-current', 600),
    ], { authoritativeCandidate:primary })).toBeNull()
  })

  it('returns the full-window segment chain after suffix windows confirm its terminal phase', () => {
    const segment = (stable_id, id, start) => ({
      stable_id, id, dir:id % 2 ? 'up' : 'down', low:90 + id, high:110 + id,
      start_price:90 + id, end_price:110 + id,
      start_time_utc_msc:start, end_time_utc_msc:start + 50,
    })
    const chain = [segment('a', 1, 100), segment('b', 2, 300), segment('c', 3, 500), segment('d', 4, 700)]
    const candidate = (segments, raw) => ({
      window_stable:true, segment_count:segments.length, center_count:0, raw_bar_count:raw,
      history_sufficient:true, closed_history_sufficient:true, time_location_reliable:true,
      warnings:[], _confirmed_segments:segments,
      prev_segment:segments.at(-2), current_segment:segments.at(-1),
      divergence:{ type:'none' }, forming_divergence:{ type:'none' }, recent_divergences:[], entry_candidates:[],
    })
    const primary = candidate(chain, 2000)
    Object.defineProperties(primary, {
      _confirmed_segments:{ value:chain, enumerable:false },
      _confirmed_centers:{ value:[], enumerable:false },
      _closed_rate_times_utc_msc:{ value:[100, 300, 500, 700], enumerable:false },
    })
    const selected = selectStableChanResult([
      primary, candidate(chain.slice(-3), 600), candidate(chain.slice(-2), 500),
    ], { authoritativeCandidate:primary })

    expect(selected).not.toBe(primary)
    expect(primary).not.toHaveProperty('cross_window_total_count')
    expectHiddenChanEvidence(selected)
    expect(selected.segment_count).toBe(4)
    expect(selected.current_segment.stable_id).toBe('d')
    expect(selected.authoritative_terminal_chain_confirmed).toBe(true)
  })

  it('counts unresolved historical windows as negative quorum evidence', () => {
    const confirmed = {
      window_stable:true, segment_count:2, center_count:0, raw_bar_count:900,
      prev_segment:{ stable_id:'p1' }, current_segment:{ stable_id:'c1' },
    }
    const unresolved = {
      window_stable:false, segment_count:0, center_count:0, raw_bar_count:600,
      prev_segment:null, current_segment:null,
    }

    expect(selectStableChanResult([confirmed, { ...confirmed, raw_bar_count:800 }, unresolved, unresolved, unresolved])).toBeNull()
  })

  it('does not count suffix windows that start inside the previous terminal segment as negative votes', () => {
    const confirmed = {
      window_stable:true, segment_count:2, center_count:0, raw_bar_count:900,
      window_start_time_utc_msc:100,
      prev_segment:{ stable_id:'p1', start_time_utc_msc:500 },
      current_segment:{ stable_id:'c1', start_time_utc_msc:700 },
    }
    const tooShort = start => ({
      window_stable:false, segment_count:0, center_count:0, raw_bar_count:300,
      window_start_time_utc_msc:start, prev_segment:null, current_segment:null,
    })
    const selected = selectStableChanResult([
      confirmed, { ...confirmed, raw_bar_count:800 }, tooShort(600), tooShort(650), tooShort(690),
    ])
    expect(selected.current_segment.stable_id).toBe('c1')
    expect(selected.cross_window_support_count).toBe(2)
    expect(selected.cross_window_validator_count).toBe(2)
  })

  it('does not assemble a center from adjacent-pair majorities backed by different windows', () => {
    const segment = (stableId, id, dir, low, high, start) => ({
      id, stable_id:stableId, dir, low, high,
      start_price:dir === 'up' ? low : high,
      end_price:dir === 'up' ? high : low,
      start_time_utc_msc:start,
      end_time_utc_msc:start + 50,
    })
    const a = segment('a', 1, 'up', 100, 120, 100)
    const b = segment('b', 2, 'down', 105, 118, 300)
    const c = segment('c', 3, 'up', 108, 122, 500)
    const x = segment('x', 4, 'up', 90, 115, 500)
    const left = (stableId, id) => segment(stableId, id, 'up', 98, 116, 100)
    const candidate = (chain, raw) => ({
      window_stable:true,
      segment_count:chain.length,
      center_count:chain.length >= 3 ? 1 : 0,
      raw_bar_count:raw,
      window_start_time_utc_msc:1,
      history_sufficient:true,
      closed_history_sufficient:true,
      time_location_reliable:true,
      warnings:[],
      _confirmed_segments:chain,
      prev_segment:chain.at(-2),
      current_segment:chain.at(-1),
      divergence:{ type:'none', confirmed:false },
      forming_divergence:{ type:'none' },
      recent_divergences:[],
      trend_state:{ state:'consolidation', direction:'neutral', phase:'range', reversal_bias:'none', reason:'price_returned_to_center' },
      entry_candidates:[],
    })
    const selected = selectStableChanResult([
      candidate([a, b, x], 600),
      candidate([a, b, { ...x, stable_id:'x2', id:5 }], 500),
      candidate([a, b, c], 900),
      candidate([left('left-1', 6), b, c], 800),
      candidate([left('left-2', 7), b, c], 700),
    ])

    expect(selected.segment_count).toBe(2)
    expect(selected.current_segment.stable_id).toBe('c')
    expect(selected.center_count).toBe(0)
    expect(selected.cross_window_segment_pair_support).toEqual([
      expect.objectContaining({ previous_stable_id:'b', current_stable_id:'c', support_count:3, validator_count:5 }),
    ])
  })

  it('does not combine a terminal majority with a different cohort that only contains the chain historically', () => {
    const seg = (stable_id, id, dir, low, high, start) => ({
      stable_id, id, dir, low, high, bi_count:3,
      start_price:dir === 'up' ? low : high,
      end_price:dir === 'up' ? high : low,
      start_time_utc_msc:start, end_time_utc_msc:start + 50,
    })
    const [a, b, p, c, u] = [
      seg('a', 1, 'up', 90, 115, 100), seg('b', 2, 'down', 100, 120, 300),
      seg('p', 3, 'up', 105, 118, 500), seg('c', 4, 'down', 108, 122, 700),
      seg('u', 5, 'up', 125, 135, 900),
    ]
    const other = (name, id, dir, start) => seg(name, id, dir, 80 + id, 100 + id, start)
    const candidate = (chain, raw, forming = { type:'none' }) => ({
      window_stable:true, segment_count:chain.length, center_count:chain.length >= 3 ? 1 : 0,
      raw_bar_count:raw, window_start_time_utc_msc:1,
      history_sufficient:true, closed_history_sufficient:true, time_location_reliable:true,
      warnings:[], _confirmed_segments:chain,
      prev_segment:chain.at(-2), current_segment:chain.at(-1), latest_price:130,
      divergence:{ type:'none', confirmed:false }, forming_divergence:forming,
      recent_divergences:[], entry_candidates:[],
    })
    const selected = selectStableChanResult([
      candidate([a, b, p, c], 900),
      candidate([other('x', 6, 'up', 100), other('y', 7, 'down', 300), p, c], 800),
      candidate([other('q', 8, 'up', 100), other('r', 9, 'down', 300), p, c], 700),
      candidate([a, b, p, c, u], 600, { type:'top', state:'forming', entry_segment:{ stable_id:'wrong' }, departure_segment:{ stable_id:'wrong-dep' } }),
      candidate([a, b, p, c, { ...u, stable_id:'u2', id:10 }], 500),
    ])

    expect(selected.segment_count).toBe(2)
    expect(selected.current_segment.stable_id).toBe('c')
    expect(selected.center_count).toBe(0)
    expect(selected.forming_divergence.type).toBe('none')
  })

  it('does not fabricate a center when the shared segment suffix has no local center-core quorum', () => {
    const seg = (stable_id, id, dir, low, high, start) => ({
      stable_id, id, dir, low, high, bi_count:3,
      start_price:dir === 'up' ? low : high,
      end_price:dir === 'up' ? high : low,
      start_time_utc_msc:start, end_time_utc_msc:start + 50,
    })
    const a = seg('a', 10, 'down', 100, 120, 300)
    const b = seg('b', 11, 'up', 105, 118, 500)
    const c = seg('c', 12, 'down', 108, 122, 700)
    const d = seg('d', 13, 'up', 106, 119, 900)
    const prefix = (stableId, id) => seg(stableId, id, 'up', 98, 116, 100)
    const candidate = (first, raw) => {
      const chain = [first, a, b, c, d]
      const center = {
        id:1, core_stable_id:`${first.stable_id}|a|b`,
        core_segment_stable_ids:[first.stable_id, 'a', 'b'],
        start_segment_stable_id:first.stable_id, end_segment_stable_id:'d', status:'extended',
      }
      return {
        window_stable:true, segment_count:chain.length, center_count:1, raw_bar_count:raw,
        window_start_time_utc_msc:1, history_sufficient:true, closed_history_sufficient:true,
        time_location_reliable:true, warnings:[], _confirmed_segments:chain, _confirmed_centers:[center],
        prev_segment:c, current_segment:d, latest_center:center, latest_price:112,
        divergence:{ type:'none', confirmed:false, reason:'macd_no_divergence' },
        forming_divergence:{ type:'none', reason:'no_forming_segment' },
        recent_divergences:[], entry_candidates:[],
      }
    }

    const selected = selectStableChanResult([
      candidate(prefix('x', 1), 900), candidate(prefix('y', 2), 800), candidate(prefix('z', 3), 700),
    ])

    expect(selected.segment_count).toBe(4)
    expect(selected.center_count).toBe(0)
    expect(selected.latest_center).toBeNull()
    expect(selected.cross_window_center_support_count).toBe(0)
    expect(selected.warnings).toContain('center_cross_window_unstable')
  })

  it('requires center-core support to be a strict majority of every observable window', () => {
    const seg = (stable_id, id, dir, low, high, start) => ({
      stable_id, id, dir, low, high, bi_count:3,
      start_price:dir === 'up' ? low : high, end_price:dir === 'up' ? high : low,
      start_time_utc_msc:start, end_time_utc_msc:start + 50,
    })
    const chain = [
      seg('entry', 1, 'up', 90, 100, 100), seg('s1', 2, 'down', 100, 120, 300),
      seg('p1', 3, 'up', 105, 118, 500), seg('c1', 4, 'down', 108, 122, 700),
    ]
    const center = {
      id:1, core_stable_id:'s1|p1|c1', core_segment_stable_ids:['s1', 'p1', 'c1'],
      start_segment_stable_id:'s1', end_segment_stable_id:'c1', status:'confirmed',
    }
    const agreeing = (raw, withCenter) => ({
      window_stable:true, segment_count:4, center_count:withCenter ? 1 : 0, raw_bar_count:raw,
      window_start_time_utc_msc:1, history_sufficient:true, closed_history_sufficient:true,
      time_location_reliable:true, warnings:[], _confirmed_segments:chain,
      _confirmed_centers:withCenter ? [center] : [], prev_segment:chain.at(-2), current_segment:chain.at(-1),
      latest_center:withCenter ? center : null, divergence:{ type:'none', reason:'macd_no_divergence' },
      forming_divergence:{ type:'none', reason:'no_forming_segment' }, recent_divergences:[], entry_candidates:[],
    })
    const disagreeing = (suffix, raw) => ({
      ...agreeing(raw, false),
      _confirmed_segments:[chain[0], chain[1], { ...chain[2], stable_id:`other-p-${suffix}` }, { ...chain[3], stable_id:`other-c-${suffix}` }],
      prev_segment:{ stable_id:`other-p-${suffix}`, start_time_utc_msc:500 },
      current_segment:{ stable_id:`other-c-${suffix}`, start_time_utc_msc:700 },
    })

    const selected = selectStableChanResult([
      agreeing(900, true), agreeing(800, true), agreeing(700, false),
      disagreeing(1, 600), disagreeing(2, 500),
    ])

    expect(selected.segment_count).toBe(4)
    expect(selected.center_count).toBe(0)
    expect(selected.warnings).toContain('center_cross_window_unstable')
  })

  it('does not combine individually popular centers or let suffix windows replace the full-window phase', () => {
    const seg = (stable_id, id, dir, low, high, start) => ({
      stable_id, id, dir, low, high, bi_count:3,
      start_price:dir === 'up' ? low : high, end_price:dir === 'up' ? high : low,
      start_time_utc_msc:start, end_time_utc_msc:start + 50,
    })
    const chain = [
      seg('entry-a', 1, 'up', 90, 100, 100),
      seg('a1', 2, 'down', 100, 120, 300), seg('a2', 3, 'up', 105, 118, 500),
      seg('a3', 4, 'down', 108, 122, 700), seg('x', 5, 'up', 125, 135, 900),
      seg('b2', 6, 'down', 128, 140, 1100), seg('b3', 7, 'up', 130, 138, 1300),
      seg('tail', 8, 'down', 131, 136, 1500),
    ]
    const centerA = {
      id:1, core_stable_id:'a1|a2|a3', core_segment_stable_ids:['a1', 'a2', 'a3'],
      start_segment_stable_id:'a1', end_segment_stable_id:'a3', departure_segment_stable_id:'x', status:'closed',
    }
    const centerB = {
      id:2, core_stable_id:'x|b2|b3', core_segment_stable_ids:['x', 'b2', 'b3'],
      start_segment_stable_id:'x', end_segment_stable_id:'tail', status:'extended',
    }
    const candidate = (raw, centers) => ({
      window_stable:true, segment_count:chain.length, center_count:centers.length, raw_bar_count:raw,
      window_start_time_utc_msc:1, history_sufficient:true, closed_history_sufficient:true,
      time_location_reliable:true, warnings:[], _confirmed_segments:chain, _confirmed_centers:centers,
      prev_segment:chain.at(-2), current_segment:chain.at(-1), latest_center:centers.at(-1), latest_price:133,
      divergence:{ type:'none', confirmed:false, reason:'macd_no_divergence' },
      forming_divergence:{ type:'none', confirmed:false, reason:'no_forming_segment' },
      recent_divergences:[], entry_candidates:[],
    })

    const selected = selectStableChanResult([
      candidate(900, [centerA]), candidate(800, [centerA]), candidate(700, [centerA, centerB]),
      candidate(600, [centerB]), candidate(500, [centerB]),
    ])

    expect(selected.center_count).toBe(1)
    expect(selected.latest_center.core_stable_id).toBe('a1|a2|a3')
    expect(selected.trend_state.state).not.toMatch(/trend/)
  })

  it('keeps confirmed terminal segments but suppresses conflicting derived structure evidence', () => {
    const result = (suffix, divergenceType, raw) => ({
      window_stable:true,
      segment_count:4,
      center_count:1,
      raw_bar_count:raw,
      history_sufficient:true,
      closed_history_sufficient:true,
      time_location_reliable:true,
      reliability:'high',
      warnings:[],
      prev_segment:{ stable_id:'p1' },
      current_segment:{ stable_id:'c1' },
      latest_center:{
        start_time_utc_msc:1000 + suffix,
        end_time_utc_msc:2000 + suffix,
        zl:100 + suffix,
        zh:110 + suffix,
        status:'closed',
      },
      divergence:divergenceType === 'none'
        ? { type:'none', confirmed:false }
        : { type:divergenceType, confirmed:true, divergence_key:`${divergenceType}-${suffix}` },
      forming_divergence:{ type:'none' },
      recent_divergences:[],
      trend_state:{ state:'consolidation', direction:'neutral', phase:'range', reason:'price_returned_to_center' },
      entry_candidates:[{ candidate_key:`entry-${suffix}`, usable_for_entry:true }],
    })
    const selected = selectStableChanResult([
      result(1, 'top', 900), result(2, 'none', 800), result(3, 'bottom', 700),
      result(4, 'top', 600), result(5, 'none', 500),
    ])

    expect(selected.segment_count).toBe(2)
    expect(selected.current_segment.stable_id).toBe('c1')
    expect(selected.center_count).toBe(0)
    expect(selected.latest_center).toBeNull()
    expect(selected.divergence).toMatchObject({ type:'none', reason:'no_cross_window_center' })
    expect(selected.entry_candidates).toEqual([])
    expect(selected.reliability).toBe('medium')
    expect(selected.warnings).toContain('center_cross_window_unstable')
  })

  it('keeps a center rebuilt from agreed segments but rejects conflicting divergence entry references', () => {
    const result = (entry, raw) => ({
      window_stable:true, segment_count:4, center_count:1, raw_bar_count:raw,
      history_sufficient:true, closed_history_sufficient:true, time_location_reliable:true,
      reliability:'high', warnings:[],
      _confirmed_segments:consensusSegmentChain(),
      prev_segment:{ stable_id:'p1' }, current_segment:{ stable_id:'c1' },
      latest_center:{
        start_time_utc_msc:1000, end_time_utc_msc:2000, zl:100, zh:110, status:'closed',
        entry_segment_id:1, entry_segment_stable_id:entry,
        start_segment_stable_id:'s1', end_segment_stable_id:'s3', departure_segment_stable_id:'c1',
      },
      divergence:{ type:'top', confirmed:true, entry_segment_id:1, entry_segment:{ stable_id:entry }, departure_segment:{ stable_id:'c1' }, strength:'strong', reason:'macd_area_and_height_divergence' },
      forming_divergence:{ type:'none' }, recent_divergences:[],
      trend_state:{ state:'upward_exhaustion', direction:'up', phase:'exhaustion', reversal_bias:'down', reason:'confirmed_top_divergence' },
      entry_candidates:[],
    })
    const selected = selectStableChanResult([
      result('entry-1', 900), result('entry-2', 800), result('entry-3', 700),
      result('entry-4', 600), result('entry-5', 500),
    ])
    expect(selected.segment_count).toBe(4)
    expect(selected.center_count).toBe(1)
    expect(selected.latest_center.entry_segment_stable_id).toBe('entry')
    expect(selected.divergence).toMatchObject({ type:'none' })
  })

  it('remaps voted divergence, trend and entry references onto the rebuilt consensus ids', () => {
    const chain = offset => [
      { id:offset + 1, stable_id:'entry', dir:'up', low:90, high:100, start_price:90, end_price:100, bi_count:3, start_time_utc_msc:100, end_time_utc_msc:200 },
      { id:offset + 2, stable_id:'s1', dir:'down', low:100, high:120, start_price:120, end_price:100, bi_count:3, start_time_utc_msc:300, end_time_utc_msc:400 },
      { id:offset + 3, stable_id:'p1', dir:'up', low:105, high:118, start_price:105, end_price:118, bi_count:3, start_time_utc_msc:500, end_time_utc_msc:600 },
      { id:offset + 4, stable_id:'c1', dir:'down', low:108, high:122, start_price:122, end_price:108, bi_count:3, start_time_utc_msc:700, end_time_utc_msc:800 },
      { id:offset + 5, stable_id:'departure', dir:'up', low:125, high:135, start_price:125, end_price:135, bi_count:3, start_time_utc_msc:900, end_time_utc_msc:1000 },
    ]
    const candidate = (offset, raw, localCenterId) => {
      const segments = chain(offset)
      const center = {
        id:localCenterId, stable_id:'s1|c1', status:'closed',
        core_stable_id:'s1|p1|c1', core_segment_stable_ids:['s1', 'p1', 'c1'],
        entry_segment_stable_id:'entry', start_segment_stable_id:'s1',
        end_segment_stable_id:'c1', departure_segment_stable_id:'departure',
      }
      return {
        window_stable:true, segment_count:5, center_count:1, raw_bar_count:raw,
        window_start_time_utc_msc:1, history_sufficient:true, closed_history_sufficient:true,
        time_location_reliable:true, latest_price:130, warnings:[], _confirmed_segments:segments,
        prev_segment:segments.at(-2), current_segment:segments.at(-1), latest_center:center,
        divergence:{
          type:'top', confirmed:true, strength:'weak', center_id:localCenterId,
          entry_segment_id:9000 + offset, departure_segment_id:9100 + offset,
          entry_segment:{ id:9000 + offset, stable_id:'entry' },
          departure_segment:{ id:9100 + offset, stable_id:'departure' },
          reason:'macd_height_divergence_only',
        },
        forming_divergence:{ type:'none' }, recent_divergences:[],
        entry_candidates:[{
          type:'first_sell', side:'sell', source:'confirmed_top_divergence',
          candidate_key:'first_sell:departure', usable_for_entry:true,
          segment_id:9200 + offset, center_id:localCenterId,
          segment:{ id:9200 + offset, stable_id:'departure' }, center,
          reference_price:135, invalidation_price:136,
        }],
      }
    }
    const selected = selectStableChanResult([
      candidate(10, 900, 7), candidate(20, 800, 8), candidate(30, 700, 9),
    ])

    expect(selected.latest_center).toMatchObject({ id:1, entry_segment_id:11, departure_segment_id:15 })
    expect(selected.divergence).toMatchObject({ center_id:1, entry_segment_id:11, departure_segment_id:15 })
    expect(selected.trend_state).toMatchObject({ center_id:1, segment_id:15 })
    expect(selected.entry_candidates[0]).toMatchObject({ center_id:1, segment_id:15 })
    expect(selected.entry_candidates[0].segment.id).toBe(15)
    expect(selected.entry_candidates[0].center.id).toBe(1)
  })

  it('treats unavailable MACD windows as abstentions instead of outvoting confirmed divergence', () => {
    const chain = [
      { id:1, stable_id:'entry', dir:'up', low:90, high:100, start_price:90, end_price:100, bi_count:3, start_time_utc_msc:100, end_time_utc_msc:200 },
      { id:2, stable_id:'s1', dir:'down', low:100, high:120, start_price:120, end_price:100, bi_count:3, start_time_utc_msc:300, end_time_utc_msc:400 },
      { id:3, stable_id:'p1', dir:'up', low:105, high:118, start_price:105, end_price:118, bi_count:3, start_time_utc_msc:500, end_time_utc_msc:600 },
      { id:4, stable_id:'c1', dir:'down', low:108, high:122, start_price:122, end_price:108, bi_count:3, start_time_utc_msc:700, end_time_utc_msc:800 },
      { id:5, stable_id:'departure', dir:'up', low:125, high:135, start_price:125, end_price:135, bi_count:3, start_time_utc_msc:900, end_time_utc_msc:1000 },
    ]
    const center = {
      id:1, stable_id:'s1|c1', core_stable_id:'s1|p1|c1',
      core_segment_stable_ids:['s1', 'p1', 'c1'], status:'closed',
      entry_segment_stable_id:'entry', start_segment_stable_id:'s1',
      end_segment_stable_id:'c1', departure_segment_stable_id:'departure',
    }
    const candidate = (raw, directional, negativeReason = 'macd_warmup_overlap') => ({
      window_stable:true, segment_count:5, center_count:1, raw_bar_count:raw,
      window_start_time_utc_msc:1, history_sufficient:true, closed_history_sufficient:true,
      time_location_reliable:true, latest_price:130, warnings:[], _confirmed_segments:chain,
      prev_segment:chain.at(-2), current_segment:chain.at(-1), latest_center:center,
      divergence:directional ? {
        type:'top', confirmed:true, strength:'weak', reason:'macd_height_divergence_only',
        entry_segment:{ stable_id:'entry' }, departure_segment:{ stable_id:'departure' },
      } : { type:'none', confirmed:false, reason:negativeReason },
      forming_divergence:{ type:'none', confirmed:false, reason:'no_forming_segment' },
      recent_divergences:[], entry_candidates:[],
    })

    const selected = selectStableChanResult([
      candidate(900, true), candidate(800, true),
      candidate(700, false), candidate(600, false), candidate(500, false),
    ])

    expect(selected.divergence).toMatchObject({ type:'top', confirmed:true })
    expect(selected.cross_window_divergence_support_count).toBe(2)
    expect(selected.cross_window_divergence_validator_count).toBe(2)
    expect(selected.warnings).not.toContain('divergence_cross_window_unstable')

    const wrongReferenceNegative = raw => {
      const value = candidate(raw, false, 'macd_no_divergence')
      return {
        ...value,
        latest_center:{ ...value.latest_center, entry_segment_stable_id:'different-entry' },
      }
    }
    const protectedPositive = selectStableChanResult([
      candidate(900, true), candidate(800, true),
      wrongReferenceNegative(700), wrongReferenceNegative(600), wrongReferenceNegative(500),
    ])
    expect(protectedPositive.divergence).toMatchObject({ type:'top', confirmed:true })
    expect(protectedPositive.cross_window_divergence_support_count).toBe(2)
    expect(protectedPositive.cross_window_divergence_validator_count).toBe(2)

    const conclusiveNegative = selectStableChanResult([
      candidate(900, true), candidate(800, true),
      candidate(700, false, 'macd_no_divergence'),
      candidate(600, false, 'macd_no_divergence'),
      candidate(500, false, 'macd_no_divergence'),
    ])
    expect(conclusiveNegative.divergence).toMatchObject({ type:'none', reason:'macd_no_divergence' })
    expect(conclusiveNegative.cross_window_divergence_support_count).toBe(3)
    expect(conclusiveNegative.cross_window_divergence_validator_count).toBe(5)
  })

  it('treats a consistently open center with no departure as conclusive no divergence', () => {
    const chain = consensusSegmentChain()
    const center = {
      id:1, stable_id:'s1|c1', core_stable_id:'s1|p1|c1',
      core_segment_stable_ids:['s1', 'p1', 'c1'], status:'open',
      entry_segment_stable_id:'entry', start_segment_stable_id:'s1',
      end_segment_stable_id:'c1', departure_segment_stable_id:null,
    }
    const candidate = raw => ({
      window_stable:true, segment_count:4, center_count:1, raw_bar_count:raw,
      window_start_time_utc_msc:1, history_sufficient:true, closed_history_sufficient:true,
      time_location_reliable:true, latest_price:110, warnings:[], _confirmed_segments:chain,
      prev_segment:chain.at(-2), current_segment:chain.at(-1), latest_center:center,
      divergence:{ type:'none', confirmed:false, reason:'not_after_center' },
      forming_divergence:{ type:'none', confirmed:false, reason:'no_forming_segment' },
      recent_divergences:[], entry_candidates:[],
    })
    const selected = selectStableChanResult([
      candidate(900), candidate(800), candidate(700), candidate(600), candidate(500),
    ])
    expect(selected.divergence).toMatchObject({ type:'none', reason:'not_after_center' })
    expect(selected.cross_window_divergence_support_count).toBe(5)
    expect(selected.cross_window_divergence_validator_count).toBe(5)
    expect(selected.warnings).not.toContain('divergence_evidence_unavailable')
  })

  it('keeps long-lived confirmed structure usable while exposing age as diagnostics only', () => {
    const chain = [
      ...consensusSegmentChain(),
      { id:5, stable_id:'extension', dir:'up', low:109, high:121, start_price:109, end_price:121, bi_count:3, start_time_utc_msc:900, end_time_utc_msc:1000 },
    ]
    const center = {
      id:1, stable_id:'s1|c1', core_stable_id:'s1|p1|c1',
      core_segment_stable_ids:['s1', 'p1', 'c1'], status:'open',
      entry_segment_stable_id:'entry', start_segment_stable_id:'s1',
      end_segment_stable_id:'c1', departure_segment_stable_id:null,
      zl:100, zh:110,
    }
    const candidate = raw => ({
      window_stable:true, segment_count:4, center_count:1, raw_bar_count:raw,
      window_start_time_utc_msc:1, history_sufficient:true, closed_history_sufficient:true,
      time_location_reliable:true, structure_time_key_reliable:true,
      cache_internal_gap_unresolved:false, latest_price:130, reliability:'high',
      confirmed_structure_age_bars:191, confirmed_structure_max_age_bars:null,
      confirmed_structure_age_semantics:'diagnostic_only_no_expiry',
      warnings:[], _confirmed_segments:chain,
      prev_segment:chain.at(-2), current_segment:chain.at(-1), latest_center:center,
      divergence:{ type:'none', confirmed:false, reason:'not_after_center' },
      forming_divergence:{ type:'none', confirmed:false, reason:'no_forming_segment' },
      recent_divergences:[], entry_candidates:[{ type:'third_buy', usable_for_entry:false }],
    })
    const selected = selectStableChanResult([
      candidate(900), candidate(800), candidate(700), candidate(600), candidate(500),
    ])

    expect(selected.latest_center).toBeTruthy()
    expect(selected.current_center).toBeTruthy()
    expect(selected.active_center).toBeNull()
    expect(selected.price_vs_center).toBe('above')
    expect(selected.trend_state).toMatchObject({ state:'upward_breakout_pending', phase:'breakout_candidate' })
    expect(selected.entry_candidates).toEqual([])
    expect(selected.structure_topology_reliable).toBe(true)
    expect(selected.confirmed_structure_age_bars).toBe(191)
    expect(selected.confirmed_structure_max_age_bars).toBeNull()
    expect(selected.warnings).not.toContain('confirmed_structure_stale')
  })

  it('intersects historical divergences without discarding an agreed current center', () => {
    const result = (recentKey, raw) => ({
      window_stable:true, segment_count:4, center_count:1, raw_bar_count:raw,
      history_sufficient:true, closed_history_sufficient:true, time_location_reliable:true,
      reliability:'high', warnings:[],
      _confirmed_segments:consensusSegmentChain(),
      prev_segment:{ stable_id:'p1' }, current_segment:{ stable_id:'c1' },
      latest_center:{
        start_time_utc_msc:1000, end_time_utc_msc:2000, zl:100, zh:110, status:'closed',
        entry_segment_stable_id:'entry', start_segment_stable_id:'s1',
        end_segment_stable_id:'s3', departure_segment_stable_id:'c1',
      },
      divergence:{ type:'none', confirmed:false }, forming_divergence:{ type:'none' },
      recent_divergences:[{ type:'top', confirmed:true, departure_segment:{ stable_id:recentKey }, strength:'weak', reason:'macd_height_divergence_only' }],
      trend_state:{ state:'consolidation', direction:'neutral', phase:'range', reversal_bias:'none', reason:'price_returned_to_center' },
      entry_candidates:[],
    })
    const selected = selectStableChanResult([
      result('old-1', 900), result('old-2', 800), result('old-3', 700),
      result('old-4', 600), result('old-5', 500),
    ])
    expect(selected.center_count).toBe(1)
    expect(selected.latest_center).toBeTruthy()
    expect(selected.recent_divergences).toEqual([])
    expect(selected.warnings).not.toContain('center_cross_window_unstable')
  })

  it('treats small MACD ratio drift as the same divergence identity and keeps the conservative strength', () => {
    const result = (ratio, strength, hasDivergence, raw) => {
      const segments = [
        ...consensusSegmentChain(),
        { id:5, stable_id:'departure', dir:'up', low:125, high:135, start_price:125, end_price:135, bi_count:3, start_time_utc_msc:900, end_time_utc_msc:1000 },
      ]
      return ({
      window_stable:true, segment_count:5, center_count:1, raw_bar_count:raw,
      history_sufficient:true, closed_history_sufficient:true, time_location_reliable:true,
      reliability:'high', warnings:[], latest_price:130,
      _confirmed_segments:segments,
      prev_segment:segments.at(-2), current_segment:segments.at(-1),
      latest_center:{
        start_time_utc_msc:1000, end_time_utc_msc:2000, zl:100, zh:110, status:'closed',
        entry_segment_stable_id:'entry', start_segment_stable_id:'s1',
        end_segment_stable_id:'c1', departure_segment_stable_id:'departure',
      },
      divergence:hasDivergence
        ? { type:'top', confirmed:true, entry_segment:{ stable_id:'entry' }, departure_segment:{ stable_id:'departure' }, strength, area_ratio:ratio, peak_ratio:ratio, reason:'macd_height_divergence_only' }
        : { type:'none', confirmed:false },
      forming_divergence:{ type:'none' }, recent_divergences:[], entry_candidates:[],
      trend_state:hasDivergence
        ? { state:'upward_exhaustion', direction:'up', phase:'exhaustion', reversal_bias:'down', reason:'confirmed_top_divergence' }
        : { state:'consolidation', direction:'neutral', phase:'range', reversal_bias:'none', reason:'price_returned_to_center' },
      })
    }
    const selected = selectStableChanResult([
      result(0.781, 'strong', true, 900), result(0.782, 'weak', true, 800), result(0.783, 'strong', true, 700),
      result(null, 'none', false, 600), result(null, 'none', false, 500),
    ])
    expect(selected.divergence).toMatchObject({ type:'top', confirmed:true, strength:'weak', area_ratio:0.782 })
    expect(selected.warnings).not.toContain('divergence_cross_window_unstable')
  })

  it('promotes a bootstrap identity only across three distinct reliable closed-bar snapshots', () => {
    const snapshot = (observation, entry = 'entry', overrides = {}) => ({
      window_stable:true,
      time_location_reliable:true,
      cache_internal_gap_unresolved:false,
      window_end_time_utc_msc:observation,
      latest_center:{
        core_stable_id:'s1|s2|s3',
        entry_segment_stable_id:entry,
        entry_segment_start_time_utc_msc:100,
      },
      ...overrides,
    })

    expect(summarizeTemporalBootstrapEvidence([
      snapshot(1000), snapshot(1100), snapshot(1200),
    ])).toMatchObject({
      temporal_identity_stable:true,
      temporal_closed_bar_support:3,
      temporal_closed_bar_validator_count:3,
      temporal_core_stable_id:'s1|s2|s3',
      temporal_entry_segment_stable_id:'entry',
    })
    expect(summarizeTemporalBootstrapEvidence([
      snapshot(1000), snapshot(1100), snapshot(1200, 'changed-entry'),
    ])).toMatchObject({ temporal_identity_stable:false, temporal_closed_bar_support:2 })
    expect(summarizeTemporalBootstrapEvidence([
      snapshot(1000), snapshot(1100), snapshot(1200, 'entry', { cache_internal_gap_unresolved:true }),
    ])).toMatchObject({ temporal_identity_stable:false, temporal_closed_bar_support:2 })
    expect(summarizeTemporalBootstrapEvidence([
      snapshot(1000), snapshot(1100), snapshot(1200, 'entry', { reliability:'low' }),
    ])).toMatchObject({ temporal_identity_stable:false, temporal_closed_bar_support:2 })
    expect(summarizeTemporalBootstrapEvidence([
      snapshot(1000), snapshot(1100), snapshot(1200, 'entry', { warnings:['confirmed_structure_stale'] }),
    ])).toMatchObject({ temporal_identity_stable:true, temporal_closed_bar_support:3 })
    expect(summarizeTemporalBootstrapEvidence([
      snapshot(1000), snapshot(1000), snapshot(1200),
    ])).toMatchObject({ temporal_identity_stable:false })
  })

  it('requires a strict cross-window vote for the same center core and adjacent entry segment', () => {
    const center = entry => ({
      core_stable_id:'s1|s2|s3', core_segment_stable_ids:['s1', 's2', 's3'],
      entry_segment_stable_id:entry, entry_segment_start_time_utc_msc:100,
    })
    const candidate = (windowStart, entry) => ({
      window_start_time_utc_msc:windowStart,
      latest_center:entry ? center(entry) : null,
      _confirmed_centers:entry ? [center(entry)] : [],
    })
    const authoritative = candidate(1, 'entry')
    const temporal = {
      temporal_identity_stable:true,
      temporal_core_stable_id:'s1|s2|s3',
      temporal_entry_segment_stable_id:'entry',
      temporal_entry_start_time_utc_msc:100,
    }
    expect(evaluateCrossWindowBootstrapEvidence([
      authoritative, candidate(2, 'entry'), candidate(3, 'other-entry'), candidate(150, null),
    ], authoritative, temporal)).toEqual({ stable:true, supportCount:2, validatorCount:3 })
    expect(evaluateCrossWindowBootstrapEvidence([
      authoritative, candidate(2, 'other-entry'), candidate(3, 'other-entry'),
    ], authoritative, temporal)).toEqual({ stable:false, supportCount:1, validatorCount:3 })
  })

  it('fails closed for every entry-dependent field without inventing bootstrap pending', () => {
    const selected = {
      latest_price:100,
      prev_segment:{ dir:'down' }, current_segment:{ dir:'up' }, latest_center:{ zl:95, zh:105 },
      divergence:{ type:'bottom', confirmed:true },
      forming_divergence:{ type:'top', confirmed:false },
      recent_divergences:[{ type:'bottom' }],
      trend_state:{ state:'trend', direction:'up' },
      entry_candidates:[{ type:'first_buy', usable_for_entry:true }],
    }
    const protectedResult = protectBootstrapDependentEvidence(selected, false, 'medium')
    expect(protectedResult.divergence).toMatchObject({ type:'none', reason:'center_entry_unconfirmed' })
    expect(protectedResult.forming_divergence).toMatchObject({ type:'none', reason:'center_entry_unconfirmed' })
    expect(protectedResult.recent_divergences).toEqual([])
    expect(protectedResult.entry_candidates).toEqual([])
  })

  it('uses bootstrap pending only when an explicit confirmed candidate awaits the next round', () => {
    const selected = {
      latest_price:100,
      prev_segment:{ dir:'down' }, current_segment:{ dir:'up' },
      latest_center:{ zl:95, zh:105, entry_segment_id:1, entry_segment_stable_id:'entry' },
    }
    const protectedResult = protectBootstrapDependentEvidence(
      selected, false, 'medium', 'structure_anchor_bootstrap_pending')
    expect(protectedResult.divergence).toMatchObject({
      type:'none', reason:'structure_anchor_bootstrap_pending',
    })
    expect(protectedResult.forming_divergence).toMatchObject({
      type:'none', reason:'structure_anchor_bootstrap_pending',
    })
  })

  it('keeps confirmed segment boundaries after the market window shifts from a supplied stable boundary', () => {
    let state = 21
    const random = () => {
      state = (state * 1664525 + 1013904223) >>> 0
      return state / 0x100000000
    }
    let price = 100
    const vertices = [{ type: 'bottom', price }]
    for (let i = 0; i < 100; i++) {
      const dir = i % 2 === 0 ? 'up' : 'down'
      const distance = 1 + random() * 25
      price = dir === 'up' ? price + distance : price - distance
      vertices.push({ type: dir === 'up' ? 'top' : 'bottom', price })
    }
    const makeFractals = offset => vertices.map((vertex, index) => ({
      idx: index * 4 - offset,
      raw_start_idx: index * 4 - offset,
      raw_end_idx: index * 4 - offset,
      type: vertex.type,
      price: vertex.price,
      high: vertex.price,
      low: vertex.price,
      time: `t${index * 4}`,
    })).filter(item => item.idx >= 0)
    const allRates = Array.from({ length: 502 }, (_, i) => ({
      time: `t${i}`,
      time_utc_msc: 1784185200000 + i * 300000,
      open: 100,
      high: 110,
      low: 90,
      close: 100,
      tick_volume: 1,
    }))
    const firstRates = allRates.slice(0, 500)
    const first = computeChan(firstRates, 'M5', Array(firstRates.length).fill(0), {
      fractalsForTest:makeFractals(0), dataQuality:{ clock_status:'verified', last_bar_closed:true },
    })
    const anchor = first.latest_center?.entry_segment_start_time_utc_msc
    expect(anchor).toBeGreaterThan(0)
    const trustedStructureAnchor = {
      anchor_time_utc_msc:anchor,
      bootstrap_core_stable_id:first.structure_anchor?.bootstrap_core_stable_id,
      bootstrap_entry_segment_stable_id:first.structure_anchor?.bootstrap_entry_segment_stable_id,
      last_confirmed_segment_time_utc_msc:first.structure_anchor?.last_confirmed_segment_time_utc_msc,
    }
    expect(trustedStructureAnchor.bootstrap_core_stable_id).toBeTruthy()
    expect(trustedStructureAnchor.bootstrap_entry_segment_stable_id).toBeTruthy()
    expect(trustedStructureAnchor.last_confirmed_segment_time_utc_msc).toBeGreaterThanOrEqual(anchor)
    const shiftedRates = allRates.slice(2)
    const shifted = computeChan(shiftedRates, 'M5', Array(shiftedRates.length).fill(0), {
      fractalsForTest: makeFractals(2),
      trustedStructureAnchor, dataQuality:{ clock_status:'verified', last_bar_closed:true },
    })
    expect(shifted.structure_anchor).toMatchObject({
      requested_time_utc_msc:anchor, matched:true, current_result_usable:true,
    })
    expect(shifted.window_stable).toBe(true)
    expect(shifted.current_segment?.stable_id).toBe(first.current_segment?.stable_id)
    expect(shifted.prev_segment?.stable_id).toBe(first.prev_segment?.stable_id)

    const timeOnly = computeChan(shiftedRates, 'M5', Array(shiftedRates.length).fill(0), {
      fractalsForTest:makeFractals(2), trustedStructureAnchorUtcMs:anchor,
      dataQuality:{ clock_status:'verified', last_bar_closed:true },
    })
    expect(timeOnly.structure_anchor).toMatchObject({
      matched:false, identity_matched:false, current_result_usable:false,
    })
    expect(timeOnly.warnings).toContain('structure_anchor_identity_missing')

    const wrongCore = computeChan(shiftedRates, 'M5', Array(shiftedRates.length).fill(0), {
      fractalsForTest:makeFractals(2),
      trustedStructureAnchor:{ ...trustedStructureAnchor, bootstrap_core_stable_id:'wrong-core' },
      dataQuality:{ clock_status:'verified', last_bar_closed:true },
    })
    expect(wrongCore.structure_anchor).toMatchObject({ matched:false, identity_matched:false })
    expect(wrongCore.warnings).toContain('structure_anchor_identity_mismatch')
    expect(wrongCore.current_segment?.stable_id).toBe(first.current_segment?.stable_id)

    const regressed = computeChan(shiftedRates, 'M5', Array(shiftedRates.length).fill(0), {
      fractalsForTest:makeFractals(2),
      trustedStructureAnchor:{
        ...trustedStructureAnchor,
        last_confirmed_segment_time_utc_msc:Number(trustedStructureAnchor.last_confirmed_segment_time_utc_msc) + 86400000,
      },
      dataQuality:{ clock_status:'verified', last_bar_closed:true },
    })
    expect(regressed.structure_anchor).toMatchObject({
      matched:false, identity_matched:true, last_confirmed_segment_not_regressed:false,
    })
    expect(regressed.warnings).toContain('structure_anchor_last_segment_regressed')
  })
})
