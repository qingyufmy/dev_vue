import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { buildFrozenChanSnapshotDiagnostics } from '../../server/routes/ai/frozen-market-diagnostics.js'

describe('frozen market diagnostics', () => {
  it('produces a deterministic Chan summary from the frozen snapshot only', () => {
    const row = {
      id:7, signal_id:9, strategy_id:1, strategy_version:4, standard_symbol:'XAUUSD',
      content_hash:'a'.repeat(64), klines_json:JSON.stringify({ H1:[{ time_utc_msc:1 }] }),
      market_snapshot_json:JSON.stringify({ strategy_context:{ timeframes:{ H1:{ summary:{ chan:{
        status:'complete', window_stable:true, segment_count:3, trend_state:{ direction:'down' },
        current_segment:{ stable_id:'segment:3' }, center_count:1,
        latest_center:{ core_stable_id:'center:1', entry_segment_stable_id:'segment:2' },
        cross_window_support_count:2, cross_window_validator_count:3,
        evidence_capabilities:{ data_complete:true, center_structure_usable:true },
      } } } } } }),
    }
    const first = buildFrozenChanSnapshotDiagnostics(row)
    const second = buildFrozenChanSnapshotDiagnostics(row)
    expect(first).toEqual(second)
    expect(first.frames.H1).toMatchObject({
      candle_count:1, target_window:1200, validation_windows:[1000, 1100, 1200],
      segment_count:3, segment_direction:'down', segment_stable_id:'segment:3',
      center_core_stable_id:'center:1', center_entry_segment_stable_id:'segment:2',
    })
    expect(first.diagnostic_hash).toMatch(/^[a-f0-9]{64}$/)
  })

  it('keeps both CLI diagnostics read-only', () => {
    for (const file of ['diagnose-chan-frozen-snapshot.mjs', 'audit-market-session-continuity.mjs']) {
      const source = readFileSync(new URL(`../../scripts/${file}`, import.meta.url), 'utf8')
      expect(source).toContain('FROM inference_snapshots')
      expect(source).not.toMatch(/\b(?:INSERT|UPDATE|DELETE|REPLACE|ALTER|DROP|CREATE)\b/i)
    }
  })
})
