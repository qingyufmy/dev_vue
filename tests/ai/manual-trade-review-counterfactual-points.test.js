import { beforeEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'

const mocks = vi.hoisted(() => ({
  queryAll:vi.fn(),
  queryOne:vi.fn(),
  withTransaction:vi.fn(),
}))

vi.mock('../../server/db.js', () => ({
  beijingNow:() => '2026-08-17 12:00:00',
  queryAll:mocks.queryAll,
  queryOne:mocks.queryOne,
  withTransaction:mocks.withTransaction,
}))

import {
  DEFAULT_MANUAL_TRADE_REVIEW_COUNTERFACTUAL_OFFSETS,
  buildManualTradeReviewCounterfactualPoints,
  ensureManualTradeReviewCounterfactualPoints,
  linkManualTradeReviewCounterfactualPointModelTask,
  markManualTradeReviewCounterfactualPointFailed,
  markManualTradeReviewCounterfactualPointUnknown,
  saveManualTradeReviewCounterfactualPointOutput,
} from '../../server/routes/ai/manual-trade-review-counterfactual-points.js'

const HASH_A = 'a'.repeat(64)
const HASH_B = 'b'.repeat(64)

function candles() {
  return [
    { time_utc_msc:1000, close_time_utc_msc:2000 },
    { time_utc_msc:3000, close_time_utc_msc:4000 },
    { time_utc_msc:5000, close_time_utc_msc:6000 },
    { time_utc_msc:7000, close_time_utc_msc:8000 },
    { time_utc_msc:9000, close_time_utc_msc:10000 },
  ]
}

function pointRow({ candidate_key = 'anchor', offset_bars = 0, status = 'pending', output = null } = {}) {
  return {
    id:1, case_id:7, job_id:19, generation_no:2,
    candidate_key, decision_time_utc_msc:6000, offset_bars, status,
    model_task_id:null, market_snapshot_hash:HASH_A, input_hash:HASH_B,
    normalized_output_json:output == null ? null : JSON.stringify(output),
    normalized_output_hash:null, last_error_code:null,
    created_at:'2026-08-17 12:00:00', updated_at:'2026-08-17 12:00:00', completed_at:null,
  }
}

describe('manual trade review counterfactual points', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('uses the real closed-candle sequence rather than natural-minute arithmetic', () => {
    const points = buildManualTradeReviewCounterfactualPoints({
      candles:candles(), entryTimeUtcMsc:6500, timeframeMs:1000,
    })
    expect(DEFAULT_MANUAL_TRADE_REVIEW_COUNTERFACTUAL_OFFSETS).toEqual([-1, 0, 1])
    expect(points).toEqual([
      { candidate_key:'anchor_minus_1', decision_time_utc_msc:4000, offset_bars:-1 },
      { candidate_key:'anchor', decision_time_utc_msc:6000, offset_bars:0 },
      { candidate_key:'anchor_plus_1', decision_time_utc_msc:8000, offset_bars:1 },
    ])

    const gap = buildManualTradeReviewCounterfactualPoints({
      candles:[
        { time_utc_msc:1000, close_time_utc_msc:1100 },
        { time_utc_msc:2000, close_time_utc_msc:2100 },
        { time_utc_msc:9000, close_time_utc_msc:9100 },
        { time_utc_msc:10000, close_time_utc_msc:10100 },
        { time_utc_msc:11000, close_time_utc_msc:11100 },
      ], entryTimeUtcMsc:9500,
    })
    expect(gap.map(point => point.decision_time_utc_msc)).toEqual([2100, 9100, 10100])
  })

  it('rejects duplicate, non-closed, unsorted, unavailable, and over-limit candidates', () => {
    expect(() => buildManualTradeReviewCounterfactualPoints({
      candles:candles(), entryTimeUtcMsc:6500, timeframeMs:1000, offsets:[-1, -1],
    })).toThrow('offset_duplicate')
    expect(() => buildManualTradeReviewCounterfactualPoints({
      candles:candles().map((item, index) => index === 2 ? { ...item, is_closed:false } : item),
      entryTimeUtcMsc:6500, timeframeMs:1000,
    })).toThrow('candle_not_closed')
    expect(() => buildManualTradeReviewCounterfactualPoints({
      candles:[candles()[1], candles()[0], ...candles().slice(2)], entryTimeUtcMsc:6500, timeframeMs:1000,
    })).toThrow('candle_sequence_invalid')
    expect(() => buildManualTradeReviewCounterfactualPoints({
      candles:candles(), entryTimeUtcMsc:6500, timeframeMs:1000, offsets:[-2, -1, 0, 1, 2, 3], maxOffsetBars:3,
    })).toThrow('points_limit')
    expect(() => buildManualTradeReviewCounterfactualPoints({
      candles:candles().slice(0, 2), entryTimeUtcMsc:6500, timeframeMs:1000,
    })).toThrow('candidate_unavailable')
  })

  it('creates the frozen point set only under a live job lease and generation', async () => {
    const calls = []
    const runner = vi.fn(async (sql) => {
      calls.push(sql)
      if (sql.includes('SELECT id, case_id, generation_no')) {
        return [[{ id:19, case_id:7, generation_no:2, lease_token:'lease-1', status:'generating' }], []]
      }
      if (sql.includes('SELECT * FROM manual_trade_review_counterfactual_points')) {
        const selects = calls.filter(item => item.includes('SELECT * FROM manual_trade_review_counterfactual_points')).length
        return [selects === 1 ? [] : [
          pointRow({ candidate_key:'anchor_minus_1', offset_bars:-1 }),
          pointRow({ candidate_key:'anchor', offset_bars:0 }),
          { ...pointRow({ candidate_key:'anchor_plus_1', offset_bars:1 }), decision_time_utc_msc:8000 },
        ], []]
      }
      return [{ affectedRows:1, insertId:1 }, []]
    })
    const result = await ensureManualTradeReviewCounterfactualPoints({
      caseId:7, jobId:19, generationNo:2, leaseToken:'lease-1',
      candidates:[
        { candidate_key:'anchor_minus_1', decision_time_utc_msc:4000, offset_bars:-1, market_snapshot_hash:HASH_A, input_hash:HASH_B },
        { candidate_key:'anchor', decision_time_utc_msc:6000, offset_bars:0, market_snapshot_hash:HASH_A, input_hash:HASH_B },
        { candidate_key:'anchor_plus_1', decision_time_utc_msc:8000, offset_bars:1, market_snapshot_hash:HASH_A, input_hash:HASH_B },
      ], now:'2026-08-17 12:00:00', run:runner,
    })
    expect(result).toHaveLength(3)
    expect(calls.some(sql => sql.includes('FOR UPDATE'))).toBe(true)
    expect(calls.filter(sql => sql.includes('INSERT INTO manual_trade_review_counterfactual_points'))).toHaveLength(3)
    expect(runner.mock.calls.flatMap(([, params]) => params || [])).toContain('lease-1')
  })

  it('links a task with lease/generation fencing and preserves a succeeded output', async () => {
    const runner = vi.fn(async sql => {
      if (sql.includes('UPDATE manual_trade_review_counterfactual_points')) return [{ affectedRows:1 }, []]
      return [[], []]
    })
    await expect(linkManualTradeReviewCounterfactualPointModelTask({
      caseId:7, jobId:19, generationNo:2, candidateKey:'anchor', modelTaskId:'task-1',
      inputHash:HASH_B, leaseToken:'lease-1', run:runner,
    })).resolves.toMatchObject({ linked:true, modelTaskId:'task-1' })
    const [sql, params] = runner.mock.calls[0]
    expect(sql).toContain('jobs.lease_token = ?')
    expect(sql).toContain('jobs.generation_no = points.generation_no')
    expect(sql).toContain('points.model_task_id IS NULL OR points.model_task_id = ?')
    expect(params).toEqual(expect.arrayContaining(['task-1', HASH_B, 19, 2, 'anchor', 'lease-1']))
  })

  it('persists normalized output and rejects credentials/raw provider envelopes', async () => {
    const runner = vi.fn(async sql => {
      if (sql.includes('UPDATE manual_trade_review_counterfactual_points')) return [{ affectedRows:1 }, []]
      return [[], []]
    })
    await expect(saveManualTradeReviewCounterfactualPointOutput({
      caseId:7, jobId:19, generationNo:2, candidateKey:'anchor', leaseToken:'lease-1', run:runner,
      modelTaskId:'task-1', normalizedOutput:{ candidate_key:'anchor', decision:'buy' },
    })).resolves.toMatchObject({ saved:true, status:'succeeded', normalizedOutputHash:expect.stringMatching(/^[a-f0-9]{64}$/) })
    expect(runner.mock.calls[0][0]).toContain('points.normalized_output_json = ?')
    await expect(saveManualTradeReviewCounterfactualPointOutput({
      caseId:7, jobId:19, generationNo:2, candidateKey:'anchor', leaseToken:'lease-1', run:runner,
      normalizedOutput:{ raw_provider_response:{ choices:[] } },
    })).rejects.toThrow('raw_provider_output_forbidden')
  })

  it('records unknown and failed states without overwriting a saved result', async () => {
    const runner = vi.fn(async sql => {
      if (sql.includes('UPDATE manual_trade_review_counterfactual_points')) return [{ affectedRows:1 }, []]
      return [[], []]
    })
    await expect(markManualTradeReviewCounterfactualPointUnknown({
      caseId:7, jobId:19, generationNo:2, candidateKey:'anchor', leaseToken:'lease-1', run:runner,
      errorCode:'provider_status_unknown',
    })).resolves.toMatchObject({ updated:true, status:'status_unknown' })
    await expect(markManualTradeReviewCounterfactualPointFailed({
      caseId:7, jobId:19, generationNo:2, candidateKey:'anchor', leaseToken:'lease-1', run:runner,
      errorCode:'provider_failed',
    })).resolves.toMatchObject({ updated:true, status:'failed' })
    expect(runner.mock.calls[0][0]).toContain('points.normalized_output_json IS NULL')
  })

  it('declares additive migration 193 with required fields, uniqueness and repair indexes', () => {
    const migration = readFileSync(new URL('../../server/migrations.js', import.meta.url), 'utf8')
    const start = migration.indexOf("id: '193_manual_trade_review_counterfactual_points'")
    expect(start).toBeGreaterThan(-1)
    const block = migration.slice(start)
    for (const field of [
      'case_id BIGINT UNSIGNED NOT NULL', 'job_id BIGINT UNSIGNED NOT NULL',
      'generation_no INT UNSIGNED NOT NULL', 'candidate_key VARCHAR(64) NOT NULL',
      'decision_time_utc_msc BIGINT UNSIGNED NOT NULL', 'offset_bars SMALLINT NOT NULL',
      "status VARCHAR(24) NOT NULL DEFAULT 'pending'", 'model_task_id VARCHAR(128) DEFAULT NULL',
      'market_snapshot_hash CHAR(64) DEFAULT NULL', 'input_hash CHAR(64) DEFAULT NULL',
      'normalized_output_json MEDIUMTEXT DEFAULT NULL', 'normalized_output_hash CHAR(64) DEFAULT NULL',
      'last_error_code VARCHAR(128) DEFAULT NULL', 'created_at DATETIME NOT NULL',
      'updated_at DATETIME NOT NULL', 'completed_at DATETIME DEFAULT NULL',
    ]) expect(block).toContain(field)
    expect(block).toContain('UNIQUE KEY uk_manual_trade_review_counterfactual_generation (job_id, generation_no, candidate_key)')
    expect(block).toContain('UNIQUE KEY uk_manual_trade_review_counterfactual_model_task (model_task_id)')
    expect(block).toContain('information_schema.STATISTICS')
    expect(block).not.toContain('FOREIGN KEY')
  })
})

