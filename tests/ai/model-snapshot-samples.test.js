import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockQueryOne = vi.fn()
const mockQueryAll = vi.fn()

vi.mock('../../server/db.js', () => ({
  queryOne:(...args) => mockQueryOne(...args),
  queryAll:(...args) => mockQueryAll(...args),
}))

import { listModelSnapshotSamples, resolveModelSnapshotSelection } from '../../server/routes/ai/model-snapshot-samples.js'

function row(id, overrides = {}) {
  return {
    snapshot_id:id,
    id,
    signal_id:1000 + id,
    strategy_id:7,
    strategy_version:4,
    strategy_name:'缠论策略',
    strategy_scope:'platform',
    standard_symbol:'XAUUSD',
    original_signal_type:'buy_limit',
    original_confidence:0.72,
    original_model_name:'deepseek-v4-pro',
    original_provider:'deepseek',
    output_schema_version:'schema-v4',
    evidence_status:'complete',
    omitted_fields_json:'[]',
    net_profit:12.5,
    closed_volume:0.02,
    trade_count:1,
    signal_created_at:'2026-07-20 10:00:00',
    fully_closed_at:'2026-07-20 12:00:00',
    system_prompt:'system prompt',
    user_prompt:'user prompt',
    prompt_hash:`prompt-${id}`,
    content_hash:`content-${id}`,
    market_snapshot_json:'{"symbol":"XAUUSD","timeframe":"M5"}',
    klines_json:'{"M5":[{"time_utc_msc":1784512800000}]}',
    memory_mode:'shared',
    ...overrides,
  }
}

describe('model comparison historical snapshot samples', () => {
  beforeEach(() => vi.clearAllMocks())

  it('lists only server-authorized closed-trade snapshots with pagination', async () => {
    mockQueryOne.mockResolvedValueOnce({ role:'admin' }).mockResolvedValueOnce({ total:1 })
    mockQueryAll.mockResolvedValueOnce([row(1)])

    const result = await listModelSnapshotSamples(9, {
      strategy_id:7, symbol:'XAUUSD.a', result:'profit', page:1, page_size:10,
    })

    expect(result.pagination).toEqual({ page:1, page_size:10, total:1 })
    expect(result.samples[0]).toMatchObject({
      snapshot_id:1, signal_id:1001, strategy_id:7, strategy_version:4,
      symbol:'XAUUSD', net_profit:12.5, selectable:true,
    })
    expect(mockQueryAll.mock.calls[0][0]).toContain("signal_outcomes")
    expect(mockQueryAll.mock.calls[0][0]).toContain('strategy_row.title AS strategy_name')
    expect(mockQueryAll.mock.calls[0][0]).toContain("status = 'closed'")
    expect(mockQueryAll.mock.calls[0][0]).toContain("evidence_status = 'complete'")
  })

  it('freezes a homogeneous selection and returns exact replay evidence', async () => {
    mockQueryAll.mockResolvedValueOnce([row(1), row(2)])

    const result = await resolveModelSnapshotSelection(9, [2, 1, 2], {
      strategy_id:7, symbol:'XAUUSD',
    })

    expect(result.snapshot_ids).toEqual([1, 2])
    expect(result.strategy_version).toBe(4)
    expect(result.output_schema_version).toBe('schema-v4')
    expect(result.fingerprint).toMatch(/^[a-f0-9]{64}$/)
    expect(result.samples[0]).toMatchObject({
      system_prompt:'system prompt', user_prompt:'user prompt',
      market_snapshot:{ symbol:'XAUUSD', timeframe:'M5' },
    })
  })

  it('rejects mixed strategy versions before any model call can start', async () => {
    mockQueryAll.mockResolvedValueOnce([row(1), row(2, { strategy_version:5 })])
    await expect(resolveModelSnapshotSelection(9, [1, 2], { strategy_id:7, symbol:'XAUUSD' }))
      .rejects.toThrow('snapshot_compare_strategy_version_mismatch')
  })

  it('rejects selections smaller than the reproducible comparison minimum', async () => {
    await expect(resolveModelSnapshotSelection(9, [1], { strategy_id:7 }))
      .rejects.toThrow('snapshot_compare_minimum_not_met')
    expect(mockQueryAll).not.toHaveBeenCalled()
  })
})
