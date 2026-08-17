import { beforeEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'

const mocks = vi.hoisted(() => ({
  queryAll:vi.fn(),
  queryOne:vi.fn(),
  queryRun:vi.fn(),
  withTransaction:vi.fn(),
}))

vi.mock('../../server/db.js', () => ({
  beijingNow:() => '2026-08-17 12:00:00',
  queryAll:mocks.queryAll,
  queryOne:mocks.queryOne,
  queryRun:mocks.queryRun,
  withTransaction:mocks.withTransaction,
}))

import {
  MANUAL_TRADE_REVIEW_STAGES,
  buildFrozenRuntime,
  buildManualTradeReviewStageInputHash,
  ensureManualTradeReviewStageRuns,
  hashManualTradeReviewValue,
  linkManualTradeReviewStageModelTask,
  normalizeManualTradeReviewStageOutput,
  parseAndValidateFrozenRuntime,
  saveManualTradeReviewStageOutput,
  validateManualTradeReviewStageRuns,
} from '../../server/routes/ai/manual-trade-review-stage-runs.js'

const HASH_A = 'a'.repeat(64)
const HASH_B = 'b'.repeat(64)

function runtimeInput(overrides = {}) {
  return {
    caseId:7,
    jobId:19,
    generationNo:2,
    taskDeadlineAt:'2026-08-17 12:30:00',
    strategySnapshotHash:HASH_A,
    evidenceHash:HASH_B,
    outputContractHash:HASH_A,
    selectionContractVersion:'manual-trade-selection-v1',
    memory:{ libraryId:3, versionNo:8, revisionId:11, contentHash:HASH_B, content:'冻结记忆正文' },
    model:{ profileId:5, provider:'openai', model:'model-a', protocol:'chat_completions', credentialSource:'platform', configFingerprint:HASH_A },
    ...overrides,
  }
}

function stageRows(runtime, { status = 'pending', modelTaskId = null } = {}) {
  const serialized = JSON.stringify(runtime.frozenRuntime)
  return MANUAL_TRADE_REVIEW_STAGES.map((stage, index) => ({
    id:index + 1,
    case_id:7,
    job_id:19,
    generation_no:2,
    stage,
    status,
    model_task_id:modelTaskId,
    frozen_runtime_json:serialized,
    frozen_runtime_hash:runtime.frozenRuntimeHash,
    input_hash:null,
    normalized_output_json:null,
    normalized_output_hash:null,
    last_error_code:null,
    created_at:'2026-08-17 12:00:00',
    updated_at:'2026-08-17 12:00:00',
    completed_at:null,
  }))
}

describe('manual trade review durable stage runs', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('builds a deterministic frozen runtime without persisting credentials', () => {
    const first = buildFrozenRuntime(runtimeInput({
      api_key:'do-not-store',
      headers:{ authorization:'Bearer secret' },
      model:{
        profileId:5, provider:'openai', model:'model-a', protocol:'chat_completions',
        credentialSource:'platform', configFingerprint:HASH_A, api_key:'also-do-not-store',
      },
    }))
    const second = buildFrozenRuntime(runtimeInput({
      model:{
        configFingerprint:HASH_A, protocol:'chat_completions', model:'model-a',
        provider:'openai', profileId:5, credentialSource:'platform',
      },
    }))
    expect(first.frozenRuntimeHash).toBe(second.frozenRuntimeHash)
    expect(JSON.stringify(first.frozenRuntime)).not.toMatch(/api[_-]?key|authorization|secret|password/i)
    expect(first.frozenRuntime.model).toEqual(second.frozenRuntime.model)
    expect(first.frozenRuntime.memory).toMatchObject({ char_count:Array.from('冻结记忆正文').length, estimated_token_count:expect.any(Number) })
  })

  it('hashes canonical values and rejects a tampered persisted runtime', () => {
    const built = buildFrozenRuntime(runtimeInput())
    expect(hashManualTradeReviewValue({ b:2, a:1 })).toBe(hashManualTradeReviewValue({ a:1, b:2 }))
    expect(parseAndValidateFrozenRuntime(JSON.stringify(built.frozenRuntime), built.frozenRuntimeHash).runtimeHash)
      .toBe(built.frozenRuntimeHash)
    expect(() => parseAndValidateFrozenRuntime(JSON.stringify({ ...built.frozenRuntime, job_id:99 }), built.frozenRuntimeHash))
      .toThrow('manual_trade_review_frozen_runtime_hash_mismatch')
    expect(() => parseAndValidateFrozenRuntime(JSON.stringify({ ...built.frozenRuntime, model:{ api_key:'bad' } })))
      .toThrow('manual_trade_review_runtime_credential_field')
  })

  it('requires both stages to share the exact runtime hash and identity', () => {
    const built = buildFrozenRuntime(runtimeInput())
    const rows = stageRows(built)
    expect(validateManualTradeReviewStageRuns(rows, { caseId:7, jobId:19, generationNo:2 }))
      .toMatchObject({ runtimeHash:built.frozenRuntimeHash, stageRuns:expect.any(Array) })
    const changed = buildFrozenRuntime(runtimeInput({ evidenceHash:HASH_A }))
    rows[1].frozen_runtime_json = JSON.stringify(changed.frozenRuntime)
    rows[1].frozen_runtime_hash = changed.frozenRuntimeHash
    expect(() => validateManualTradeReviewStageRuns(rows)).toThrow('manual_trade_review_shared_runtime_hash_mismatch')
  })

  it('ensures the two rows in one transaction and refuses a changed runtime', async () => {
    const built = buildFrozenRuntime(runtimeInput())
    const calls = []
    const runner = vi.fn(async (sql) => {
      calls.push(sql)
      if (sql.includes('SELECT * FROM manual_trade_review_stage_runs')) {
        if (calls.filter(item => item.includes('SELECT * FROM manual_trade_review_stage_runs')).length === 1) return [[], []]
        return [stageRows(built), []]
      }
      return [{ affectedRows:1, insertId:1 }, []]
    })
    const result = await ensureManualTradeReviewStageRuns({ ...runtimeInput(), now:'2026-08-17 12:00:00', run:runner })
    expect(result.stageRuns).toHaveLength(2)
    expect(runner.mock.calls.filter(([sql]) => sql.includes('INSERT INTO manual_trade_review_stage_runs'))).toHaveLength(2)
    expect(calls.some(sql => sql.includes('FOR UPDATE'))).toBe(true)
  })

  it('links a model task only with the business lease, generation and status fence', async () => {
    const runner = vi.fn(async sql => {
      if (sql.includes('UPDATE manual_trade_review_stage_runs')) return [{ affectedRows:1 }, []]
      return [[], []]
    })
    await expect(linkManualTradeReviewStageModelTask({
      jobId:19, caseId:7, generationNo:2, stage:'counterfactual', modelTaskId:'task-1',
      inputHash:HASH_B, leaseToken:'lease-1', run:runner,
    })).resolves.toMatchObject({ linked:true, modelTaskId:'task-1' })
    const [sql, params] = runner.mock.calls[0]
    expect(sql).toContain('jobs.lease_token = ?')
    expect(sql).toContain('jobs.generation_no = stages.generation_no')
    expect(sql).toContain('jobs.status IN')
    expect(sql).toContain('stages.input_hash = COALESCE')
    expect(params).toEqual(expect.arrayContaining(['task-1', HASH_B, 19, 2, 'counterfactual', 'lease-1', 'leased']))
  })

  it('saves only a normalized output while retaining the same lease/generation fence', async () => {
    const runner = vi.fn(async sql => {
      if (sql.includes('UPDATE manual_trade_review_stage_runs')) return [{ affectedRows:1 }, []]
      return [[], []]
    })
    await expect(saveManualTradeReviewStageOutput({
      jobId:19, caseId:7, generationNo:2, stage:'outcome_review', leaseToken:'lease-1', run:runner,
      normalizedOutput:{ schema_version:2, review_summary:'已完成', evidence_quality:'complete' },
    })).resolves.toMatchObject({ saved:true, status:'succeeded', normalizedOutputHash:expect.stringMatching(/^[a-f0-9]{64}$/) })
    const [sql, params] = runner.mock.calls[0]
    expect(sql).toContain('jobs.lease_token = ?')
    expect(sql).toContain('stages.generation_no = ?')
    expect(sql).toContain('stages.model_task_id IS NOT NULL')
    expect(params).toContain('lease-1')
  })

  it('rejects raw provider envelopes and credentials before any database write', async () => {
    expect(() => normalizeManualTradeReviewStageOutput({ raw_provider_response:{ choices:[] } }))
      .toThrow('manual_trade_review_raw_provider_output_forbidden')
    expect(() => normalizeManualTradeReviewStageOutput({ result:'ok', api_key:'bad' }))
      .toThrow('manual_trade_review_runtime_credential_field')
    const runner = vi.fn()
    await expect(saveManualTradeReviewStageOutput({
      jobId:19, caseId:7, generationNo:2, stage:'counterfactual', leaseToken:'lease-1', run:runner,
      normalizedOutput:{ raw:{ value:'provider stream' } },
    })).rejects.toThrow('manual_trade_review_raw_provider_output_forbidden')
    expect(runner).not.toHaveBeenCalled()
  })

  it('includes the stage, frozen runtime and parent output hash in the task identity', () => {
    const result = buildManualTradeReviewStageInputHash({
      stage:'outcome_review', frozenRuntimeHash:HASH_A, outputContractHash:HASH_B,
      parentOutputHash:HASH_A, messages:{ user:'frozen message' },
    })
    expect(result).toMatch(/^[a-f0-9]{64}$/)
    expect(result).not.toBe(buildManualTradeReviewStageInputHash({
      stage:'counterfactual', frozenRuntimeHash:HASH_A, outputContractHash:HASH_B,
      parentOutputHash:HASH_A, messages:{ user:'frozen message' },
    }))
  })

  it('declares additive migration 192 with the required uniqueness and indexes', () => {
    const migration = readFileSync(new URL('../../server/migrations.js', import.meta.url), 'utf8')
    const start = migration.indexOf("id: '192_manual_trade_review_durable_stage_runs'")
    expect(start).toBeGreaterThan(-1)
    const block = migration.slice(start)
    expect(block).toContain('CREATE TABLE IF NOT EXISTS manual_trade_review_stage_runs')
    expect(block).toContain('UNIQUE KEY uk_manual_trade_review_stage_generation (job_id, generation_no, stage)')
    expect(block).toContain('UNIQUE KEY uk_manual_trade_review_stage_model_task (model_task_id)')
    expect(block).toContain('KEY idx_manual_trade_review_stage_status (status, updated_at)')
    expect(block).toContain('KEY idx_manual_trade_review_stage_case_generation (case_id, generation_no)')
    expect(block).toContain('frozen_runtime_hash CHAR(64) NOT NULL')
    expect(block).toContain('normalized_output_hash CHAR(64) DEFAULT NULL')
  })
})
