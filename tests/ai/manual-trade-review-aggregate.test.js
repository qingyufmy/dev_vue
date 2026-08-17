import { describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { sha256 } from '../../server/routes/ai/inference-snapshots.js'
import {
  buildManualTradeReviewAggregateStatistics,
  claimManualTradeReviewAggregate,
  createManualTradeReviewAggregate,
  manualTradeReviewAggregateFrozenSourceSetHash,
  manualTradeReviewAggregateModelIdempotencyKey,
  linkManualTradeReviewAggregateModelTask,
  listManualTradeReviewAggregates,
  markManualTradeReviewAggregateFailure,
  manualTradeReviewAggregateModelRuntime,
  manualTradeReviewAggregateSelectionHash,
  normalizeManualTradeReviewAggregateModelOutput,
  normalizeManualTradeReviewAggregateSources,
  retryManualTradeReviewAggregate,
  runManualTradeReviewAggregateOnce,
  saveManualTradeReviewAggregateOutput,
} from '../../server/routes/ai/manual-trade-review-aggregate.js'

function source(caseId, versionId, content = {}) {
  const contentJson = JSON.stringify(content)
  return { case_id:caseId, version_id:versionId, content_hash:sha256(contentJson), contentJson }
}

function pinnedRow(item, { userId = 7, accountId = 11, strategyId = 3, strategyVersion = 4, status = 'approved' } = {}) {
  const strategySnapshotJson = JSON.stringify({ strategy_policy:{ entry:'trend' } })
  return {
    source_case_id:item.case_id, source_user_id:userId, source_trading_account_id:accountId,
    source_strategy_id:strategyId, source_strategy_version:strategyVersion, source_case_status:status,
    approved_version_id:status === 'approved' ? item.version_id : null, source_version_id:item.version_id,
    source_content_hash:item.content_hash, version_content_hash:item.content_hash, content_json:item.contentJson,
    strategy_snapshot_json:strategySnapshotJson, strategy_snapshot_hash:sha256(strategySnapshotJson),
  }
}

function aggregateClaimRows({ id = 901, first, second, status = 'queued', modelTaskId = null } = {}) {
  const rows = [pinnedRow(first), pinnedRow(second)].map((row, index) => ({
    ...row, id:index + 1, aggregate_case_id:id,
  }))
  const selectionHash = manualTradeReviewAggregateSelectionHash([first, second])
  const snapshotJson = JSON.stringify([{ strategy_version:4,
    strategy_snapshot_hash:rows[0].strategy_snapshot_hash,
    strategy_snapshot:{ strategy_policy:{ entry:'trend' } } }])
  const runtimeJson = JSON.stringify({ runtime_version:1, model_profile_id:9, provider:'test', model:'test-model',
    protocol:'chat', credential_source:'test', endpoint_fingerprint:'e'.repeat(64) })
  return {
    row:{ id, user_id:7, trading_account_id:11, strategy_id:3, strategy_versions_json:'[4]', selection_hash:selectionHash,
      status, generation_no:1, attempt_count:0, max_attempts:3, task_deadline_at:'2099-01-01 00:00:00',
      model_task_id:modelTaskId, frozen_source_set_hash:null, frozen_source_set_json:null,
      strategy_snapshot_hash:sha256(snapshotJson), strategy_snapshot_json:snapshotJson, lease_token:null,
      model_runtime_hash:sha256(runtimeJson), model_runtime_json:runtimeJson,
      input_hash:null, prompt_hash:null, output_contract_hash:null },
    rows, selectionHash,
  }
}

function transactionDb({ aggregateRows = [], sourceRows = [], insertId = 901 } = {}) {
  const calls = []
  let sourceIndex = 0
  return {
    calls,
    withTransaction:async callback => callback(async (sql, params = []) => {
      calls.push({ sql, params })
      if (sql.includes('FROM manual_trade_review_aggregate_cases') && sql.trimStart().startsWith('SELECT')) return [aggregateRows, []]
      if (sql.includes('FROM manual_trade_review_cases')) return [[sourceRows[sourceIndex++]], []]
      if (sql.includes('INSERT INTO manual_trade_review_aggregate_cases')) return [{ insertId }, []]
      return [{ affectedRows:1 }, []]
    }),
    queryOne:async () => null,
    queryAll:async () => [],
  }
}

describe('manual trade review aggregate service', () => {
  it('pins 2-20 immutable references and hashes them independently of selection order', () => {
    const first = source(101, 201, { output_contract_version:'manual-trade-review-v3' })
    const second = source(102, 202, { output_contract_version:'manual-trade-review-v3' })
    const normalized = normalizeManualTradeReviewAggregateSources([second, first])
    expect(normalized.map(item => item.case_id)).toEqual([101, 102])
    expect(manualTradeReviewAggregateSelectionHash([first, second]))
      .toBe(manualTradeReviewAggregateSelectionHash([second, first]))
    expect(() => normalizeManualTradeReviewAggregateSources([first])).toThrow('source_count_invalid')
    expect(() => normalizeManualTradeReviewAggregateSources([first, first])).toThrow('source_duplicate')
    expect(() => normalizeManualTradeReviewAggregateSources([
      first, { ...second, case_id:first.case_id, version_id:first.version_id, content_hash:'a'.repeat(64) },
    ])).toThrow('source_version_duplicate')
  })

  it('uses one stable generic model-task idempotency key per aggregate generation', () => {
    expect(manualTradeReviewAggregateModelIdempotencyKey({ aggregateId:901, generationNo:4 }))
      .toBe('manual_trade_review_aggregate:901:4')
    expect(manualTradeReviewAggregateModelIdempotencyKey({ aggregateId:901, generationNo:4 }))
      .toBe(manualTradeReviewAggregateModelIdempotencyKey({ aggregateId:901, generationNo:4 }))
  })

  it('enforces owner/account/strategy and pins the stored content hash in one transaction', async () => {
    const first = source(101, 201, { output_contract_version:'manual-trade-review-v3', evidence_quality:'complete' })
    const second = source(102, 202, { output_contract_version:'manual-trade-review-v3', evidence_quality:'complete' })
    const db = transactionDb({ sourceRows:[pinnedRow(first), pinnedRow(second)] })
    const result = await createManualTradeReviewAggregate({ actor:{ id:7 }, userId:7, tradingAccountId:11, strategyId:3,
      clientRequestId:'aggregate-request-1', sources:[first, second], db })
    expect(result).toMatchObject({ created:true, aggregate_case:{ id:901, status:'queued', generation_no:1 } })
    expect(db.calls.filter(call => call.sql.includes('INSERT INTO manual_trade_review_aggregate_sources'))).toHaveLength(2)
    const insertCase = db.calls.find(call => call.sql.includes('INSERT INTO manual_trade_review_aggregate_cases'))
    expect(insertCase.sql).toContain('frozen_source_set_json')
    expect(insertCase.sql).toContain('strategy_snapshot_json')
    expect(db.calls.some(call => call.sql.includes('FOR UPDATE'))).toBe(true)

    const mismatched = transactionDb({ sourceRows:[pinnedRow(first), pinnedRow(second, { accountId:12 })] })
    await expect(createManualTradeReviewAggregate({ actor:{ id:7 }, userId:7, tradingAccountId:11, strategyId:3,
      clientRequestId:'aggregate-request-2', sources:[first, second], db:mismatched }))
      .rejects.toThrow('source_account_mismatch')

    const badHash = transactionDb({ sourceRows:[pinnedRow(first), pinnedRow(second)] })
    await expect(createManualTradeReviewAggregate({ actor:{ id:7 }, userId:7, tradingAccountId:11, strategyId:3,
      clientRequestId:'aggregate-request-3', sources:[{ ...first, content_hash:'b'.repeat(64) }, second], db:badHash }))
      .rejects.toThrow('source_hash_mismatch')
    await expect(createManualTradeReviewAggregate({ actor:{ id:8 }, userId:7, tradingAccountId:11, strategyId:3,
      clientRequestId:'aggregate-request-forbidden', sources:[first, second], db:transactionDb() }))
      .rejects.toThrow('forbidden')
  })

  it('keeps client request idempotent and rejects a changed selection', async () => {
    const first = source(101, 201)
    const second = source(102, 202)
    const selectionHash = manualTradeReviewAggregateSelectionHash([first, second])
    const existing = { id:901, user_id:7, client_request_id:'same-request', trading_account_id:11,
      strategy_id:3, selection_hash:selectionHash, status:'queued', generation_no:1, max_attempts:3,
      strategy_versions_json:'[4]', progress_stage:'queued' }
    const db = transactionDb({ aggregateRows:[existing], sourceRows:[] })
    const result = await createManualTradeReviewAggregate({ actor:{ id:7 }, userId:7, tradingAccountId:11, strategyId:3,
      clientRequestId:'same-request', sources:[first, second], db })
    expect(result).toMatchObject({ idempotent:true, created:false, aggregate_case:{ id:901 } })

    const conflictDb = transactionDb({ aggregateRows:[{ ...existing, selection_hash:'c'.repeat(64) }] })
    await expect(createManualTradeReviewAggregate({ actor:{ id:7 }, userId:7, tradingAccountId:11, strategyId:3,
      clientRequestId:'same-request', sources:[first, second], db:conflictDb }))
      .rejects.toThrow('idempotency_conflict')
  })

  it('increments generation and resets the durable job only from a terminal failure', async () => {
    const row = { id:901, user_id:7, trading_account_id:11, status:'failed', generation_no:2,
      attempt_count:3, max_attempts:3, last_error_code:'provider_timeout', lease_token:null }
    const db = transactionDb({ aggregateRows:[row] })
    const result = await retryManualTradeReviewAggregate({ actor:{ id:7 }, userId:7, aggregateId:901,
      tradingAccountId:11, db, now:'2026-08-17 18:00:00' })
    expect(result).toMatchObject({ aggregate_case_id:901, status:'queued', generation_no:3, previous_error_code:'provider_timeout' })
    const update = db.calls.find(call => call.sql.includes('UPDATE manual_trade_review_aggregate_cases'))
    expect(update.params).toContain(3)

    const activeDb = transactionDb({ aggregateRows:[{ ...row, status:'generating' }] })
    await expect(retryManualTradeReviewAggregate({ actor:{ id:7 }, userId:7, aggregateId:901,
      tradingAccountId:11, db:activeDb })).rejects.toThrow('retry_not_allowed')
  })

  it('computes deterministic coverage statistics and never upgrades weak evidence', () => {
    const first = source(101, 201, {
      evidence_quality:'complete', actual_direction:'buy',
      counterfactual_summary:{ server_derived_direction_match:'same_direction_entry', protection_quality:'partial' },
      counterfactual_points:[{ candidate_key:'anchor', offset_bars:0, direction_match:'same_direction_entry' }],
      technical_analysis_chain:[{ origin:'strategy_derived', strategy_rule_paths:['strategy_policy.entry'] }],
      rule_comparisons:[{ status:'partial' }],
    })
    const second = source(102, 202, {
      evidence_quality:'insufficient', counterfactual_summary:{ server_derived_direction_match:'hold' },
    })
    const stats = buildManualTradeReviewAggregateStatistics([
      { case_id:first.case_id, version_id:first.version_id, content_hash:first.content_hash, confirmed:true, content_json:first.contentJson },
      { case_id:second.case_id, version_id:second.version_id, content_hash:second.content_hash, confirmed:false, content_json:second.contentJson },
    ], { strategyVersions:[4] })
    expect(stats.source_summary).toMatchObject({ total:2, confirmed:1, evidence_complete:1 })
    expect(stats.direction_match_counts).toMatchObject({ same_direction_entry:1, hold:1 })
    expect(stats.technical_origin_counts).toMatchObject({ strategy_derived:1 })
    expect(stats.candidate_offset_stats['anchor:0']).toMatchObject({ total:1, same_direction_entry:1 })
    expect(stats.coverage_missing.protection_quality).toBe(1)
  })

  it('counts v3 evidence coverage from the frozen core fields without evidence_quality', () => {
    const first = source(201, 301, {
      counterfactual_summary:{ server_derived_direction_match:'hold', protection_quality:'partial' },
      technical_analysis_chain:[{ origin:'manual_logic_inferred' }],
    })
    const second = source(202, 302, {
      counterfactual_summary:{ server_derived_direction_match:'same_direction_observe', protection_quality:'reasonable' },
      technical_analysis_chain:[],
    })
    const stats = buildManualTradeReviewAggregateStatistics([{
      case_id:first.case_id, version_id:first.version_id, content_hash:first.content_hash,
      confirmed:true, content_json:first.contentJson,
    }, {
      case_id:second.case_id, version_id:second.version_id, content_hash:second.content_hash,
      confirmed:false, content_json:second.contentJson,
    }], { strategyVersions:[4] })
    expect(stats.source_summary.evidence_complete).toBe(1)
  })

  it('declares migration 194 as additive aggregate storage with pinning and claim indexes', () => {
    const migration = readFileSync(new URL('../../server/migrations.js', import.meta.url), 'utf8')
    const start = migration.indexOf("id: '194_manual_trade_review_aggregate'")
    expect(start).toBeGreaterThan(migration.indexOf("id: '193_manual_trade_review_counterfactual_points'"))
    const block = migration.slice(start)
    for (const table of ['manual_trade_review_aggregate_cases', 'manual_trade_review_aggregate_sources', 'manual_trade_review_aggregate_versions']) {
      expect(block).toContain(`CREATE TABLE IF NOT EXISTS ${table}`)
    }
    expect(block).toContain('selection_hash CHAR(64) NOT NULL')
    expect(block).toContain('source_content_hash CHAR(64) NOT NULL')
    expect(block).toContain('UNIQUE KEY uk_manual_trade_review_aggregate_client_request (user_id, client_request_id)')
    expect(block).toContain('UNIQUE KEY uk_manual_trade_review_aggregate_source (aggregate_case_id, source_case_id, source_version_id)')
    expect(block).toContain('UNIQUE KEY uk_manual_trade_review_aggregate_version (aggregate_case_id, version_no)')
    expect(block).toContain('idx_manual_trade_review_aggregate_claim')
    expect(block).toContain('information_schema.STATISTICS')
  })

  it('appends migration 195 with only nullable non-sensitive runtime fence columns', () => {
    const migration = readFileSync(new URL('../../server/migrations.js', import.meta.url), 'utf8')
    const start194 = migration.indexOf("id: '194_manual_trade_review_aggregate'")
    const start195 = migration.indexOf("id: '195_manual_trade_review_aggregate_runtime_fence'")
    expect(start195).toBeGreaterThan(start194)
    const block = migration.slice(start195, migration.indexOf('\n  }\n]', start195))
    expect(block).toContain('model_runtime_json MEDIUMTEXT DEFAULT NULL')
    expect(block).toContain('model_runtime_hash CHAR(64) DEFAULT NULL')
    expect(block).toContain('information_schema.COLUMNS')
    expect(block).toContain('if (!existingColumns.has(name))')
    expect(block).not.toMatch(/DROP\s+(?:COLUMN|TABLE)/i)
    expect(block).not.toMatch(/api[_-]?key|authorization|password|secret/i)
  })

  it('commits aggregate business output and model-task success through the same transaction callback', () => {
    const sourceText = readFileSync(new URL('../../server/routes/ai/manual-trade-review-aggregate.js', import.meta.url), 'utf8')
    const saveStart = sourceText.indexOf('export async function saveManualTradeReviewAggregateOutput')
    const heartbeatStart = sourceText.indexOf('function startManualTradeReviewAggregateLeaseHeartbeat', saveStart)
    const saveBlock = sourceText.slice(saveStart, heartbeatStart)
    const workerStart = sourceText.indexOf('export async function runManualTradeReviewAggregateOnce')
    const workerBlock = sourceText.slice(workerStart, sourceText.indexOf('export function requestManualTradeReviewAggregateCycle', workerStart))
    expect(saveBlock).toContain('modelTaskTracker.succeedInTransaction(run')
    expect(saveBlock.indexOf("SET status = 'draft'")).toBeLessThan(saveBlock.indexOf('modelTaskTracker.succeedInTransaction(run'))
    expect(workerBlock).not.toContain('tracker.succeeded(')
  })

  it('hashes a sanitized model runtime without storing endpoint or credential material', () => {
    const result = manualTradeReviewAggregateModelRuntime({
      resolved:{ model_profile_id:9, credential_source:'platform_primary', model:{ id:9, provider:'openai',
        model_name:'gpt-test', api_base_url:'https://secret.example/v1?api_key=do-not-store', temperature:.2,
        thinking_enabled:true, profile_updated_at:'2026-08-17 19:00:00' } },
      endpoint:{ protocol:'chat', url:'https://secret.example/v1/chat/completions?api_key=do-not-store' },
      capabilities:{ context_window_tokens:128000, max_input_tokens:120000, max_output_tokens:4096,
        context_limit_semantics:'shared_context', token_limits_source:'provider', token_limits_status:'confirmed' },
      budget:{ selectedMaxOutputTokens:4096, estimatedInputTokens:512 },
    })
    expect(result.hash).toMatch(/^[a-f0-9]{64}$/)
    expect(result.json).not.toContain('secret.example')
    expect(result.json).not.toContain('api_key')
    expect(result.runtime).toMatchObject({ model_profile_id:9, provider:'openai', model:'gpt-test', protocol:'chat',
      credential_source:'platform_primary', endpoint_fingerprint:expect.stringMatching(/^[a-f0-9]{64}$/) })
  })

  it('filters aggregate history by owner-safe optional strategy id', async () => {
    const calls = []
    const db = { queryAll:async (sql, params) => { calls.push({ sql, params }); return [] } }
    await listManualTradeReviewAggregates({ actor:{ id:7 }, userId:7, tradingAccountId:11, strategyId:3, db })
    expect(calls[0].sql).toContain('trading_account_id = ? AND strategy_id = ?')
    expect(calls[0].params).toEqual([7, 11, 3, 50, 0])
  })

  it('normalizes aggregate model output against pinned sources and downgrades unsupported recommendations', () => {
    const first = source(101, 201)
    const second = source(102, 202)
    const refs = [first, second].map(item => `case:${item.case_id}:version:${item.version_id}:hash:${item.content_hash}`)
    const normalized = normalizeManualTradeReviewAggregateModelOutput({
      output_contract_version:'manual-trade-review-aggregate-v1', recurring_patterns:[], strategy_gaps:[],
      protection_findings:[], version_comparisons:[], limitations:[],
      strategy_optimization_hypotheses:[{ recommendation_state:'ready_for_human_review',
        supporting_review_refs:refs, counterexample_review_refs:[], target_path:'strategy_policy.entry',
        current_rule_summary:'rule', observed_gap:'gap', proposed_change:'change', applicable_when:{},
        risk_if_applied:'risk', validation_needed:'validate', confidence:.8 }],
    }, { sources:[{ case_id:first.case_id, version_id:first.version_id, content_hash:first.content_hash, confirmed:true },
      { case_id:second.case_id, version_id:second.version_id, content_hash:second.content_hash, confirmed:true }],
      strategySnapshot:{ strategy_policy:{ entry:'trend' } } })
    expect(normalized.strategy_optimization_hypotheses[0].recommendation_state).toBe('insufficient_evidence')
  })

  it('freezes the source set and strategy snapshot during claim', async () => {
    const first = source(101, 201)
    const second = source(102, 202)
    const fixture = aggregateClaimRows({ first, second, modelTaskId:'task-existing' })
    fixture.rows.forEach(row => {
      row.source_case_status = 'deferred'
      row.approved_version_id = null
      row.current_strategy_version = 99
      row.current_strategy_snapshot_json = JSON.stringify({ strategy_policy:{ entry:'changed-after-create' } })
      row.current_strategy_snapshot_hash = sha256(row.current_strategy_snapshot_json)
    })
    const calls = []
    const db = {
      calls,
      withTransaction:async callback => callback(async (sql, params = []) => {
        calls.push({ sql, params })
        if (sql.trimStart().startsWith('SELECT') && sql.includes("status = 'queued'") && sql.includes('manual_trade_review_aggregate_cases')) return [[fixture.row], []]
        if (sql.includes('FROM manual_trade_review_aggregate_sources')) return [fixture.rows, []]
        if (sql.includes('UPDATE manual_trade_review_aggregate_cases')) return [{ affectedRows:1 }, []]
        return [[], []]
      }),
    }
    const claimed = await claimManualTradeReviewAggregate({ db, now:'2026-08-17 18:00:00' })
    expect(claimed).toMatchObject({ id:901, status:'generating', frozen_source_set_hash:expect.stringMatching(/^[a-f0-9]{64}$/),
      strategy_snapshot_hash:expect.stringMatching(/^[a-f0-9]{64}$/) })
    expect(calls.find(call => call.sql.includes("SET status = 'generating'"))?.params).toContain(claimed.frozen_source_set_hash)
  })

  it('requires a non-empty business lease for failure and output saves', async () => {
    await expect(markManualTradeReviewAggregateFailure({ aggregateId:901, generationNo:1, leaseToken:'' }))
      .rejects.toThrow('lease_required')
    await expect(saveManualTradeReviewAggregateOutput({ actor:{ id:7 }, userId:7, aggregateId:901,
      generationNo:1, leaseToken:'', modelTaskId:'task-1', sourceSetHash:'a'.repeat(64), output:{} }))
      .rejects.toThrow('lease_required')
  })

  it('fences model-task linking by generation, lease, and frozen source hash', async () => {
    const sourceSetHash = 'a'.repeat(64)
    const calls = []
    const db = {
      withTransaction:async callback => callback(async (sql, params = []) => {
        calls.push({ sql, params })
        if (sql.includes('SELECT id, status, generation_no')) return [[{
          id:901, status:'generating', generation_no:2, lease_token:'lease-2', model_task_id:null,
          frozen_source_set_hash:sourceSetHash,
          model_runtime_json:JSON.stringify({ runtime_version:1 }),
          model_runtime_hash:sha256(JSON.stringify({ runtime_version:1 })), strategy_snapshot_hash:'b'.repeat(64),
        }], []]
        if (sql.includes('UPDATE manual_trade_review_aggregate_cases')) return [{ affectedRows:1 }, []]
        return [[], []]
      }),
    }
    const linked = await linkManualTradeReviewAggregateModelTask({ aggregateId:901, generationNo:2,
      leaseToken:'lease-2', modelTaskId:'task-2', sourceSetHash, inputHash:'b'.repeat(64),
      promptHash:'c'.repeat(64), outputContractHash:'d'.repeat(64), db })
    expect(linked).toMatchObject({ aggregate_case_id:901, generation_no:2, model_task_id:'task-2' })
    expect(calls.at(-1).params).toContain('lease-2')
    await expect(linkManualTradeReviewAggregateModelTask({ aggregateId:901, generationNo:2,
      leaseToken:'stale-lease', modelTaskId:'task-3', sourceSetHash, inputHash:'b'.repeat(64),
      promptHash:'c'.repeat(64), outputContractHash:'d'.repeat(64), db })).rejects.toThrow('lease_lost')
  })

  it('does not submit a duplicate provider request while the linked task is unknown', async () => {
    const first = source(101, 201)
    const second = source(102, 202)
    const fixture = aggregateClaimRows({ first, second, modelTaskId:'task-existing' })
    const requestModel = vi.fn()
    const db = {
      withTransaction:async callback => callback(async (sql, params = []) => {
        if (sql.trimStart().startsWith('SELECT') && sql.includes("status = 'queued'") && sql.includes('manual_trade_review_aggregate_cases')) return [[fixture.row], []]
        if (sql.includes('FROM manual_trade_review_aggregate_sources')) return [fixture.rows, []]
        if (sql.includes("SET status = 'generating'")) return [{ affectedRows:1 }, []]
        return [[], []]
      }),
      queryOne:async sql => sql.includes('ai_model_tasks') ? { task_id:'task-existing', status:'status_unknown' } : null,
      queryRun:async sql => sql.includes("status = 'generating'") ? { affectedRows:1 } : { affectedRows:0 },
    }
    const result = await runManualTradeReviewAggregateOnce({ db, requestModel })
    expect(result).toMatchObject({ status:'status_unknown', aggregate_case_id:901 })
    expect(requestModel).not.toHaveBeenCalled()
  })

  it('rejects final apply when the model-task fence no longer matches', async () => {
    const first = source(101, 201)
    const second = source(102, 202)
    const fixture = aggregateClaimRows({ first, second, status:'generating', modelTaskId:'task-1' })
    const sourceSetHash = manualTradeReviewAggregateFrozenSourceSetHash(fixture.rows)
    fixture.row.frozen_source_set_hash = sourceSetHash
    const inputHash = 'b'.repeat(64)
    const promptHash = 'c'.repeat(64)
    const outputContractHash = 'd'.repeat(64)
    fixture.row.input_hash = inputHash
    fixture.row.prompt_hash = promptHash
    fixture.row.output_contract_hash = outputContractHash
    fixture.row.lease_token = 'lease-1'
    const db = {
      withTransaction:async callback => callback(async sql => {
        if (sql.includes('FROM manual_trade_review_aggregate_cases')) return [[{
          ...fixture.row, frozen_source_set_hash:sourceSetHash,
        }], []]
        if (sql.includes('FROM manual_trade_review_aggregate_sources')) return [fixture.rows, []]
        if (sql.includes('FROM ai_model_tasks')) return [[{
          task_id:'task-1', status:'applying', snapshot_hash:sourceSetHash, input_hash:inputHash,
          prompt_hash:promptHash, output_contract_hash:outputContractHash, frozen_model_profile_id:9,
          frozen_provider:'test', frozen_model:'test-model', frozen_protocol:'chat', frozen_credential_source:'test',
          result_hash:db.modelTaskResultHash,
        }], []]
        if (sql.includes('SELECT MAX(version_no)')) return [[{ version_no:0 }], []]
        if (sql.includes('INSERT INTO manual_trade_review_aggregate_versions')) return [{ insertId:10 }, []]
        if (sql.includes("SET status = 'draft'")) return [{ affectedRows:0 }, []]
        return [[], []]
      }),
    }
    const output = { output_contract_version:'manual-trade-review-aggregate-v1', recurring_patterns:[], strategy_gaps:[],
      protection_findings:[], version_comparisons:[], strategy_optimization_hypotheses:[], limitations:[] }
    const normalizedOutput = normalizeManualTradeReviewAggregateModelOutput(output, {
      sources:fixture.rows.map(row => ({ case_id:row.source_case_id, version_id:row.source_version_id,
        content_hash:row.source_content_hash, confirmed:row.confirmation_status === 'confirmed',
        content_json:row.content_json })), strategySnapshot:{ strategy_policy:{ entry:'trend' } }, strategyVersions:[4],
    })
    const resultHash = sha256(JSON.stringify(normalizedOutput))
    db.modelTaskResultHash = resultHash
    await expect(saveManualTradeReviewAggregateOutput({ actor:{ id:7 }, userId:7, aggregateId:901, generationNo:1,
      leaseToken:'lease-1', modelTaskId:'task-1', sourceSetHash,
      strategySnapshotHash:fixture.row.strategy_snapshot_hash, modelRuntimeHash:fixture.row.model_runtime_hash,
      inputHash, promptHash, outputContractHash, output, strategySnapshot:{ strategy_policy:{ entry:'trend' } },
      modelProfileId:9, db }))
      .rejects.toThrow('lease_lost')
  })
})
