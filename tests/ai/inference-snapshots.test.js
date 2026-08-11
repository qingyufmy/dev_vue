import { describe, expect, it, vi } from 'vitest'
import {
  buildSharedMarketSnapshot,
  inferenceVisualizationSnapshot,
  inferenceSnapshotSummary,
  inferenceSnapshotEvidence,
  normalizeInferenceEvidenceTimeframe,
  encodeSnapshotJson,
  parseSnapshotJson,
  prepareInferenceSnapshot,
  persistInferenceSnapshotTx,
  sanitizeInferenceEvidence,
} from '../../server/routes/ai/inference-snapshots.js'

describe('shared market inference boundary', () => {
  it('is invariant to administrator account and inventory changes', () => {
    const base = {
      symbol: 'XAUUSD.a', timeframe: 'M5', latest_price: 2400, atr_14: 12,
      chan: { divergence: { type: 'top' } },
      strategy_context: { timeframes: { M5: { klines: [[1, 2, 3, 1, 2, 8]], summary: { pending_orders: [{ ticket: 1 }], rsi_14: 50, chan: { divergence: { type: 'top' } } } } } },
    }
    const first = buildSharedMarketSnapshot({ ...base, account: { balance: 1 }, positions: { total_positions: 8 }, pending_orders: [{ ticket: 1 }] }, { volumeMin: 0.01, volumeMax: 0.05, volumeStep:0.01 })
    const second = buildSharedMarketSnapshot({ ...base, account: { balance: 999999 }, positions: { total_positions: 0 }, pending_orders: [] }, { volumeMin: 0.01, volumeMax: 0.05, volumeStep:0.01 })
    expect(first).toEqual(second)
    expect(first.standard_symbol).toBe('XAUUSD')
    expect(first).not.toHaveProperty('account')
    expect(first).not.toHaveProperty('positions')
    expect(first).not.toHaveProperty('pending_orders')
    expect(first).not.toHaveProperty('chan')
    expect(first).not.toHaveProperty('ai_volume_range')
    expect(first.strategy_context.timeframes.M5.summary).toEqual({ rsi_14: 50, chan: { divergence: { type: 'top' } } })
  })

  it('carries snapshot-only visualization bars without adding them to normal JSON payloads', () => {
    const strategyContext = { timeframes: {} }
    Object.defineProperty(strategyContext, 'visualization_klines', { value: { M5: [{ time: 't1' }] }, enumerable: false })
    const result = buildSharedMarketSnapshot({ symbol: 'XAUUSD', strategy_context: strategyContext })
    expect(result.strategy_context.visualization_klines.M5).toHaveLength(1)
    expect(JSON.stringify(result)).not.toContain('visualization_klines')
    const snapshot = prepareInferenceSnapshot({ marketSnapshot: result })
    expect(snapshot.klines.M5).toHaveLength(1)
  })
})

describe('inference snapshot evidence', () => {
  it('freezes the Chan v6 policy, capabilities and continuity metadata', () => {
    const result = prepareInferenceSnapshot({
      systemPrompt:'system', userPrompt:'payload',
      marketSnapshot:{ strategy_context:{ timeframes:{ M5:{ summary:{ chan:{
        algorithm_version:'chan_structure_v6', history_sufficient:true,
        closed_history_sufficient:true, cache_internal_gap_unresolved:false,
        evidence_capabilities:{ data_complete:true, segment_direction_usable:true,
          center_structure_usable:false, entry_structure_usable:false, divergence_usable:false,
          reason_codes:['no_confirmed_center'] },
        continuity_calendar_version:'xauusd-fixed-holiday-v1',
        expected_closures:[{ classification:'holiday_closure', reason:'christmas_closure' }],
      } } } } } },
    })
    expect(result.marketSnapshot.strategy_context.timeframes.M5.summary.chan).toMatchObject({
      window_policy_version:'chan_window_v6', maximum_history_count:800,
      validation_window_counts:[600, 700, 800],
      evidence_capabilities:{ data_complete:true, center_structure_usable:false },
      continuity:{
        calendar_version:'xauusd-fixed-holiday-v1',
        expected_closures:[expect.objectContaining({ classification:'holiday_closure' })],
        cache_internal_gap_unresolved:false,
      },
    })
  })

  it('compresses large K-line JSON and reads both compressed and legacy rows', () => {
    const value = { M5: Array.from({ length: 500 }, (_, index) => ({ time:index, open:4000, high:4002, low:3998, close:4001 })) }
    const encoded = encodeSnapshotJson(value)
    expect(encoded.startsWith('gzip-base64:')).toBe(true)
    expect(parseSnapshotJson(encoded)).toEqual(value)
    expect(parseSnapshotJson(JSON.stringify(value))).toEqual(value)
    expect(Buffer.byteLength(encoded)).toBeLessThan(Buffer.byteLength(JSON.stringify(value)) * 0.4)
  })
  it('builds a chart-safe client snapshot without prompts', () => {
    const result = inferenceVisualizationSnapshot({
      id: 8,
      strategy_id: 3,
      standard_symbol: 'XAUUSD',
      market_source: 'platform_market_bridge',
      evidence_status: 'complete',
      omitted_fields_json: '[]',
      klines_json: JSON.stringify({ M5: [{ time: '2026-07-17 09:00:00', open: 1, high: 2, low: 0.5, close: 1.5 }] }),
      market_snapshot_json: JSON.stringify({ strategy_context: { timeframes: { M5: { klines: [{ time: 1 }], summary: { chan: { status: 'ok' } } } } } }),
      system_prompt: 'must not leak',
      user_prompt: 'must not leak either',
      created_at: '2026-07-17 09:01:00',
    })
    expect(result).toMatchObject({ id: 8, strategy_id: 3, standard_symbol: 'XAUUSD', evidence_status: 'complete' })
    expect(result.klines.M5).toHaveLength(1)
    expect(result.market_snapshot.strategy_context.timeframes.M5.summary.chan.status).toBe('ok')
    expect(result.market_snapshot.strategy_context.timeframes.M5).not.toHaveProperty('klines')
    expect(result).not.toHaveProperty('system_prompt')
    expect(result).not.toHaveProperty('user_prompt')
  })

  it('returns lightweight snapshot metadata without K-lines', () => {
    const rows = Object.fromEntries(['M5', 'M15', 'H1', 'H4'].map(timeframe => [timeframe,
      Array.from({ length: 2000 }, (_, index) => ({ time: index, open: 1, high: 2, low: 0.5, close: 1.5 }))]))
    const summary = inferenceSnapshotSummary({
      id: 18, signal_id: 9, strategy_id: 3, standard_symbol: 'XAUUSD', market_source: 'platform_market_bridge',
      evidence_status: 'complete', omitted_fields_json: '[]', klines_json: encodeSnapshotJson(rows),
      market_snapshot_json: JSON.stringify({ strategy_context: { timeframes: { M5: { summary: { chan: { status: 'ok' } } } } } }),
      strategy_runtime_json: JSON.stringify({ mode: 'policy' }), content_hash: 'a'.repeat(64), byte_size: 1234,
      created_at: '2026-07-17 09:01:00',
    })
    expect(summary.available_timeframes).toEqual(['M5', 'M15', 'H1', 'H4'])
    expect(summary.timeframe_counts).toEqual({ M5: 2000, M15: 2000, H1: 2000, H4: 2000 })
    expect(summary).not.toHaveProperty('klines')
    expect(Buffer.byteLength(JSON.stringify(summary))).toBeLessThan(50 * 1024)
  })

  it('returns only the latest 500 bars from the same compressed frozen snapshot', () => {
    const rows = { M5: Array.from({ length: 2000 }, (_, index) => ({ time: index, open: 1, high: 2, low: 0.5, close: 1.5 })) }
    const evidence = inferenceSnapshotEvidence({
      id: 19, signal_id: 10, standard_symbol: 'XAUUSD', market_source: 'platform_market_bridge', evidence_status: 'complete',
      klines_json: encodeSnapshotJson(rows), market_snapshot_json: JSON.stringify({ strategy_context: { timeframes: {} } }),
      created_at: '2026-07-17 09:01:00',
    }, 'M5')
    expect(evidence.klines).toHaveLength(500)
    expect(evidence.klines[0].time).toBe(1500)
    expect(evidence.klines.at(-1).time).toBe(1999)
    expect(Buffer.byteLength(JSON.stringify(evidence))).toBeLessThan(150 * 1024)
    expect(() => normalizeInferenceEvidenceTimeframe('W2')).toThrow('invalid_timeframe')
  })

  it('recursively strips credentials and Authorization headers', () => {
    const clean = sanitizeInferenceEvidence({ api_key: 'x', nested: { Authorization: 'Bearer y', price: 1 }, access_token: 'z' })
    expect(clean).toEqual({ nested: { price: 1 } })
  })

  it('marks oversized evidence incomplete with explicit omissions and stable hashes', () => {
    const input = {
      systemPrompt: 'system', userPrompt: 'x'.repeat(5000), marketSnapshot: { strategy_context: { timeframes: { M5: { klines: Array.from({ length: 200 }, (_, i) => [i, 1, 2, 0, 1, 3]) } } } },
      strategyId: 1, strategyScope: 'platform', standardSymbol: 'XAUUSD', marketSource: 'platform_market_bridge', outputSchemaVersion: 'a'.repeat(64), credentialSource: 'platform_primary',
    }
    const result = prepareInferenceSnapshot(input, 1800)
    expect(result.evidenceStatus).toBe('incomplete')
    expect(result.omittedFields.length).toBeGreaterThan(0)
    expect(result.contentHash).toMatch(/^[a-f0-9]{64}$/)
    expect(result.byteSize).toBeLessThanOrEqual(1800)
  })

  it('stores full Chan visualization bars once without duplicating visible model bars', () => {
    const chartBars = Array.from({ length: 300 }, (_, i) => ({ time: `t${i}`, open: 1, high: 2, low: 0.5, close: 1.5 }))
    const visibleBars = chartBars.slice(-80)
    const result = prepareInferenceSnapshot({
      systemPrompt: 'system', userPrompt: 'payload',
      marketSnapshot: { strategy_context: { visualization_klines: { H1: chartBars }, timeframes: { H1: { klines: visibleBars, summary: { chan: { status: 'ok' } } } } } },
    })
    expect(result.klines.H1).toHaveLength(300)
    expect(result.marketSnapshot.strategy_context).not.toHaveProperty('visualization_klines')
    expect(result.marketSnapshot.strategy_context.timeframes.H1).not.toHaveProperty('klines')
    expect(result.marketSnapshot.strategy_context.timeframes.H1.summary.chan.status).toBe('ok')
    expect(result.evidenceStatus).toBe('complete')
  })

  it('keeps the full balanced K-line window when its compressed storage fits the budget', () => {
    const bars = timeframe => Array.from({ length: 1000 }, (_, index) => ({
      time: `2026-07-${String(Math.floor(index / 100) + 1).padStart(2, '0')} ${String(index % 24).padStart(2, '0')}:00:00`,
      open: 3900 + index / 10, high: 3902 + index / 10, low: 3898 + index / 10,
      close: 3901 + index / 10, tick_volume: index, timeframe,
    }))
    const visualization = { M5: bars('M5'), M15: bars('M15'), H1: bars('H1'), H4: bars('H4') }
    const result = prepareInferenceSnapshot({
      systemPrompt: 'system', userPrompt: 'market payload '.repeat(8000),
      marketSnapshot: { strategy_context: { visualization_klines: visualization, timeframes: {} } },
    }, 300 * 1024)
    const retained = Object.values(result.klines).map(rows => rows.length)
    expect(retained).toEqual([1000, 1000, 1000, 1000])
    expect(result.omittedFields).not.toContain('klines_before_retained_window')
    expect(result.evidenceStatus).toBe('complete')
    expect(result.byteSize).toBeLessThanOrEqual(300 * 1024)
  })

  it('marks a snapshot incomplete when even compressed K-lines must lose their prefix', () => {
    const bars = timeframe => Array.from({ length:1000 }, (_, index) => ({
      time:`${timeframe}-${index}-${(index * 7919) % 104729}`,
      time_utc_msc:1784185200000 + index * 300000,
      open:3900 + index / 17,
      high:3902 + index / 13,
      low:3898 + index / 19,
      close:3901 + index / 23,
      tick_volume:(index * 3571) % 65521,
    }))
    const result = prepareInferenceSnapshot({
      systemPrompt:'system', userPrompt:'payload',
      klines:{ M5:bars('M5'), M15:bars('M15'), H1:bars('H1'), H4:bars('H4') },
      marketSnapshot:{ strategy_context:{ timeframes:{} } },
    }, 24 * 1024)
    expect(Object.values(result.klines).every(rows => rows.length < 1000)).toBe(true)
    expect(result.omittedFields).toContain('klines_before_retained_window')
    expect(result.evidenceStatus).toBe('incomplete')
    expect(result.byteSize).toBeLessThanOrEqual(24 * 1024)
  })

  it('persists metadata without any model secret column or value', async () => {
    const run = vi.fn().mockResolvedValue([{ insertId: 7 }])
    const id = await persistInferenceSnapshotTx(run, {
      signalId: 2, strategyId: 3, strategyVersion: 4, strategyScope: 'private', ownerUserId: 9,
      standardSymbol: 'EURUSD', marketSource: 'owner_mt5_bridge', systemPrompt: 's', userPrompt: 'u',
      outputSchemaVersion: 'b'.repeat(64), marketSnapshot: { price: 1 }, modelProfileId: 5,
      provider: 'deepseek', modelName: 'chat', credentialSource: 'user', memoryMode: 'off',
    })
    expect(id).toBe(7)
    expect(run.mock.calls[0][0]).not.toMatch(/api_key|authorization/i)
    expect(JSON.stringify(run.mock.calls[0][1])).not.toContain('Bearer')
  })

  it('persists large K-line evidence in compressed form', async () => {
    const run = vi.fn().mockResolvedValue([{ insertId: 8 }])
    await persistInferenceSnapshotTx(run, {
      signalId:2, strategyId:3, strategyScope:'platform', standardSymbol:'XAUUSD', marketSource:'platform_market_bridge',
      systemPrompt:'s', userPrompt:'u', outputSchemaVersion:'v1', credentialSource:'platform_primary',
      klines:{ M5:Array.from({ length:300 }, (_, index) => ({ time:index, open:1, high:2, low:0, close:1 })) },
    })
    expect(run.mock.calls[0][1][15]).toMatch(/^gzip-base64:/)
  })
})
