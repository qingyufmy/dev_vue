import { describe, expect, it, vi } from 'vitest'

const db = vi.hoisted(() => ({
  beijingNow:vi.fn(() => '2026-08-10 12:00:00'), queryAll:vi.fn(), queryOne:vi.fn(), queryRun:vi.fn(), withTransaction:vi.fn(),
}))
vi.mock('../../server/db.js', () => db)
vi.mock('../../server/config.js', () => ({ JWT_SECRET:'manual-review-test-secret' }))
vi.mock('../../server/routes/ai/platform-content-access.js', () => ({ canManagePlatformAiContent:() => true }))
vi.mock('../../server/routes/ai/llm.js', () => ({ requestJsonObject:vi.fn() }))
vi.mock('../../server/routes/ai/model-providers.js', () => ({ MODEL_PROVIDER_DEFAULTS:{}, modelProviderProtocol:() => 'chat' }))
vi.mock('../../server/routes/ai/model-profiles.js', () => ({ resolveAiTaskModel:vi.fn() }))
vi.mock('../../server/routes/ai/inference-snapshots.js', () => ({ sha256:value => `hash:${String(value)}` }))
vi.mock('../../server/routes/ai/strategy-memory-library.js', () => ({
  getStrategyMemoryLibraryForRuntime:vi.fn(), createStrategyMemoryInjectionLog:vi.fn(),
}))
vi.mock('../../server/routes/ai/manual-trade-evidence.js', () => ({
  MANUAL_TRADE_SELECTION_MAX:1,
  getCurrentManualReviewAccount:vi.fn(), listEligibleManualTrades:vi.fn(), readManualTradeEvidence:vi.fn(),
  normalizedTradeHash:value => `hash:${String(value)}`,
}))

import { __manualTradeReviewTest, confirmManualTradeReview, createManualTradeReview, manualTradeReviewOutputContract, validateCounterfactualAnalysis,
  validateManualTradeReviewContent, validateManualTradeSelection, recoverAbandonedManualTradeReviewJobs,
  retryManualTradeReview } from '../../server/routes/ai/manual-trade-review.js'
import { createManualTradeSelectionContext } from '../../server/routes/ai/manual-trade-selection-context.js'

const source = { source_identity_hash:'trade-a', normalized_trade_json:JSON.stringify({
  symbol:'EURUSD', direction:'buy', entry_time_utc_msc:1_000, close_time_utc_msc:2_000, net_profit:10,
}) }
const identityHash = 'A'.repeat(64)
const sourceHash = 'B'.repeat(64)
const counterfactual = { decision:'buy', reasoning:'strategy allowed long', strategy_signals:['trend'], blocking_rules:[],
  evidence_refs:['trade:trade-a'], confidence:.7 }
const frozenStrategy = { version:4, strategy_policy:{ entry:{ mode:'trend' } }, market_data_plan:{ primary_timeframe:'M15' },
  entry_methods:[], symbols:['EURUSD'], use_chan_analysis:false }
const frozenEvidence = { market_data:{ trades:{ 'trade-a':{
  pre_entry:{ timeframes:{ M15:{ status:'complete' } } },
  outcome_path:{ timeframes:{ M15:{ status:'complete' } } },
} } } }

function validContent(overrides = {}) {
  return {
    counterfactual_analysis:counterfactual, evidence_quality:'complete', review_summary:'review',
    strategy_alignment:'partial', decision_quality:'mixed', counterfactual_match:'same_direction',
    why_profitable:'trend continuation', profit_attribution:{ market_fit:'fit', entry_quality:'timely',
      exit_quality:'captured move', luck_or_uncontrolled_factors:'normal market noise' },
    outcome_independence_note:'outcome was evaluated only after the frozen decision',
    rule_comparisons:[{ rule_path:'strategy_policy.entry', rule_summary:'follow trend', observed_evidence:'trend continued',
      status:'aligned', evidence_refs:['trade:trade-a'] }], strengths:['followed trend'], issues:[], confidence:.8,
    strategy_optimization_hypotheses:[{ hypothesis_id:'h1', supporting_trade_refs:['trade-a'],
      state:'hypothesis', target_path:'strategy_policy.entry', current_rule_summary:'follow trend',
      observed_gap:'pullback definition is broad', proposed_change:'observe pullback', counter_evidence:[], applicable_when:{ symbol:'EURUSD' },
      risk_if_applied:'may filter valid entries', confidence:.6, validation_needed:'validate on more closed trades' }],
    ...overrides,
  }
}

describe('manual profitable trade counterfactual review contract', () => {
  it('uses the v2 two-stage contract and only hypothesis-level optimization', () => {
    expect(manualTradeReviewOutputContract(1)).toMatchObject({
      output_contract_version:'manual-trade-review-v2', strategy_optimization_state:'hypothesis|insufficient_evidence',
    })
    expect(validateCounterfactualAnalysis(counterfactual)).toMatchObject({
      output_contract_version:'manual-trade-counterfactual-v1', decision:'buy', confidence:.7,
    })
  })

  it('normalizes one frozen source and never emits experience candidates', () => {
    const content = validateManualTradeReviewContent(validContent({ review_summary:'  user text\u0000 ' }), [source], frozenStrategy,
      { evidenceStatus:'complete', evidence:frozenEvidence })
    expect(content.review_summary).toBe('user text')
    expect(content.counterfactual_analysis.decision).toBe('buy')
    expect(content.strategy_optimization_hypotheses[0]).toMatchObject({ state:'hypothesis', target_path:'strategy_policy.entry' })
    expect(content).not.toHaveProperty('experience_candidates')
  })

  it('requires exactly one source and one selected trade', () => {
    expect(() => validateManualTradeSelection([])).toThrow('manual_trade_review_selection_invalid')
    expect(() => validateManualTradeSelection([
      { source_identity_hash:'a', trade_source_hash:'h1' }, { source_identity_hash:'b', trade_source_hash:'h2' },
    ])).toThrow('manual_trade_review_selection_invalid')
    expect(() => validateManualTradeReviewContent(validContent(), [source, { source_identity_hash:'trade-b' }], frozenStrategy,
      { evidenceStatus:'complete', evidence:frozenEvidence }))
      .toThrow('manual_trade_review_selection_invalid')
  })

  it('rebuilds a canonical position selection and uses trade_id only as an identity fallback', () => {
    expect(validateManualTradeSelection([{
      trade_id:identityHash, trade_source_hash:sourceHash, position_id:'000123', entry_order_ticket:null,
      symbol:'EURUSD', net_profit:99,
    }])).toEqual([{
      trade_id:identityHash.toLowerCase(), source_identity_hash:identityHash.toLowerCase(),
      trade_source_hash:sourceHash.toLowerCase(), position_id:'000123', entry_order_ticket:null,
    }])
  })

  it('accepts an order-only selection and rejects malformed or empty references', () => {
    expect(validateManualTradeSelection([{
      source_identity_hash:identityHash, trade_source_hash:sourceHash, entry_order_ticket:'987654',
    }])[0]).toMatchObject({ position_id:null, entry_order_ticket:'987654' })
    for (const value of ['0', '000', '-1', '1.2', '1e3', '1'.repeat(33), 'ticket', '', 123, 1e3]) {
      expect(() => validateManualTradeSelection([{
        source_identity_hash:identityHash, trade_source_hash:sourceHash, position_id:value,
      }])).toThrow('manual_trade_review_selection_reference_invalid')
    }
    expect(() => validateManualTradeSelection([{
      source_identity_hash:identityHash, trade_source_hash:sourceHash,
    }])).toThrow('manual_trade_review_selection_reference_invalid')
    expect(() => validateManualTradeSelection([{
      source_identity_hash:'not-a-sha256', trade_source_hash:sourceHash, position_id:'1',
    }])).toThrow('manual_trade_review_selection_invalid')
  })

  it('rejects unknown references, rule paths, and enum drift', () => {
    expect(() => validateManualTradeReviewContent(validContent({ strategy_optimization_hypotheses:[{
      supporting_trade_refs:['other'], state:'hypothesis', proposed_change:'x',
    }] }), [source], frozenStrategy, { evidenceStatus:'complete', evidence:frozenEvidence })).toThrow('manual_trade_review_output_reference_invalid')
    expect(() => validateManualTradeReviewContent(validContent({ rule_comparisons:[{ rule_path:'system_prompt', status:'conflict' }] }),
      [source], frozenStrategy, { evidenceStatus:'complete', evidence:frozenEvidence })).toThrow('manual_trade_review_output_rule_path_invalid')
    expect(() => validateManualTradeReviewContent(validContent({ counterfactual_match:'invented' }),
      [source], frozenStrategy, { evidenceStatus:'complete', evidence:frozenEvidence })).toThrow('manual_trade_review_output_enum_invalid')
  })

  it('downgrades optimization hypotheses when frozen evidence is incomplete', () => {
    const content = validateManualTradeReviewContent(validContent({ evidence_quality:'insufficient' }), [source], frozenStrategy,
      { evidenceStatus:'partial', evidence:frozenEvidence })
    expect(content.strategy_optimization_hypotheses[0]).toMatchObject({ state:'insufficient_evidence' })
  })

  it('rejects empty required fields and invented evidence references', () => {
    expect(() => validateManualTradeReviewContent(validContent({ review_summary:'  ' }), [source], frozenStrategy,
      { evidenceStatus:'complete', evidence:frozenEvidence })).toThrow('manual_trade_review_output_review_summary_required')
    expect(() => validateManualTradeReviewContent(validContent({ rule_comparisons:[{
      rule_path:'strategy_policy.entry', rule_summary:'follow trend', observed_evidence:'trend continued',
      status:'aligned', evidence_refs:['market:trade-a:outcome:H4'],
    }] }), [source], frozenStrategy, { evidenceStatus:'complete', evidence:frozenEvidence }))
      .toThrow('manual_trade_review_output_reference_invalid')
  })

  it('locks approval to the current version and keeps repeated approval idempotent', async () => {
    db.withTransaction.mockImplementationOnce(async callback => callback(async sql => {
      if (sql.includes('SELECT * FROM manual_trade_review_cases')) return [[{
        id:19, user_id:7, status:'approved', current_version_id:41, approved_version_id:41,
      }], []]
      throw new Error('unexpected_sql')
    }))
    await expect(confirmManualTradeReview({ caseId:19, actor:{ id:7 }, versionId:41, action:'approve' }))
      .resolves.toEqual({ case_id:19, status:'approved', version_id:41 })

    db.withTransaction.mockImplementationOnce(async callback => callback(async sql => {
      if (sql.includes('SELECT * FROM manual_trade_review_cases')) return [[{
        id:19, user_id:7, status:'draft', current_version_id:42, approved_version_id:null,
      }], []]
      throw new Error('unexpected_sql')
    }))
    await expect(confirmManualTradeReview({ caseId:19, actor:{ id:7 }, versionId:41, action:'approve' }))
      .rejects.toThrow('manual_trade_review_version_conflict')
  })

  it('keeps future outcome and user thesis out of the counterfactual prompt', () => {
    const reviewCase = {
      strategy_snapshot_json:JSON.stringify({ id:3, version:2 }), user_thesis_text:'I knew it would profit',
      evidence_json:JSON.stringify({ market_data:{ trades:{ 'trade-a':{
        pre_entry:{ status:'complete', timeframes:{ M15:{ candles:[{ time_utc_msc:900 }] } } },
        outcome_path:{ status:'complete', metrics:{ exit_price:1.2 } },
      } } } }),
    }
    const messages = __manualTradeReviewTest.counterfactualPrompt(reviewCase, [source], {
      version_no:8, content_hash:'memory-hash', content_text:'等待结构确认',
    })
    expect(messages[1].content).toContain('pre_entry_market_data')
    expect(messages[1].content).not.toContain('I knew it would profit')
    expect(messages[1].content).not.toContain('exit_price')
    expect(messages[1].content).not.toContain('"direction":"buy"')
    expect(messages[1].content).not.toContain('net_profit')
    expect(messages[1].content).toContain('strategy_memory_library')
    expect(messages[1].content).toContain('等待结构确认')
  })

  it('freezes stage A into the outcome prompt together with actual outcome evidence', () => {
    const messages = __manualTradeReviewTest.outcomeReviewPrompt({
      strategy_snapshot_json:'{}', user_thesis_text:'my thesis', evidence_status:'complete',
      evidence_json:JSON.stringify({ market_data:{ hash:'market-hash', trades:{ 'trade-a':{ outcome_path:{ metrics:{ exit_price:1.2 } } } } } }),
    }, [source], validateCounterfactualAnalysis(counterfactual), {
      version_no:8, content_hash:'memory-hash', content_text:'等待结构确认',
    })
    expect(messages[1].content).toContain('frozen_counterfactual')
    expect(messages[1].content).toContain('exit_price')
    expect(messages[1].content).toContain('my thesis')
    expect(messages[1].content).toContain('等待结构确认')
  })

  it('requires an explicit retry for a legacy in-flight generation without a durable stage ledger', async () => {
    db.queryAll.mockResolvedValueOnce([{ id:19, case_id:23, attempt_count:1, max_attempts:3, progress_stage:'counterfactual_analysis' }])
    db.queryRun.mockResolvedValue({ changes:1 })
    const result = await recoverAbandonedManualTradeReviewJobs({ now:'2026-08-10 12:00:00', limit:10 })
    expect(result).toMatchObject({ scanned:1, requeued:0, failed:1, manual_retry_required:1 })
    expect(db.queryRun.mock.calls[0][1]).toContain('manual_trade_review_generation_expired_manual_retry_required')
  })

  it('keys the generic model task by job generation, never by outer attempt', () => {
    expect(__manualTradeReviewTest.manualTradeReviewModelIdempotencyKey({ id:19, case_id:23, generation_no:4, attempt_count:99 }))
      .toBe('manual_trade_review:19:4')
    expect(__manualTradeReviewTest.manualTradeReviewModelIdempotencyKey({ id:19, case_id:23, generation_no:4, attempt_count:1 }))
      .toBe('manual_trade_review:19:4')
  })

  it('defers a valid queued-task lease without consuming the manual job attempt', () => {
    const wait = __manualTradeReviewTest.manualTradeReviewModelTaskWaitError({
      status:'retry_wait', scheduled_at_utc_msc:0, lease_expires_at_utc_msc:2_000_000,
    }, 1_000_000)
    expect(wait).toMatchObject({ code:'manual_trade_review_model_task_lease_wait' })
    expect(wait.manualTradeReviewDeferUntilUtcMs).toBe(2_000_000)
    expect(__manualTradeReviewTest.manualTradeReviewModelTaskWaitError({
      status:'provider_running', scheduled_at_utc_msc:0, lease_expires_at_utc_msc:2_000_000,
    }, 1_000_000)).toMatchObject({ code:'manual_trade_review_model_task_lease_wait' })
    expect(__manualTradeReviewTest.manualTradeReviewModelTaskWaitError({
      status:'retry_wait', scheduled_at_utc_msc:0, lease_expires_at_utc_msc:999_999,
    }, 1_000_000)).toBeNull()
  })

  it('does not reuse a terminal generic task inside the same generation', () => {
    const error = __manualTradeReviewTest.manualTradeReviewModelTaskTerminalError({ status:'failed_terminal' })
    expect(error).toMatchObject({ code:'manual_trade_review_model_task_terminal_requires_retry', manualTradeReviewTerminalTask:true })
    expect(__manualTradeReviewTest.manualTradeReviewModelTaskTerminalError({ status:'retry_wait' })).toBeNull()
  })

  it('computes one frozen generation deadline from the v3 candidate count', () => {
    const evidence = count => ({ review_contract_version:'manual-trade-review-v3', market_data:{ trades:{
      trade:{ counterfactual_points:Array.from({ length:count }, (_, index) => ({ candidate_key:`point-${index}` })) },
    } } })
    expect(__manualTradeReviewTest.manualTradeReviewDeadlineMs({})).toBe(30 * 60_000)
    expect(__manualTradeReviewTest.manualTradeReviewDeadlineMs(evidence(3))).toBe(75 * 60_000)
    expect(__manualTradeReviewTest.manualTradeReviewDeadlineMs(evidence(5))).toBe(105 * 60_000)
  })

  it('holds a status-unknown stage without consuming the business retry budget', async () => {
    const hold = __manualTradeReviewTest.manualTradeReviewStageTaskError('counterfactual', 'task_status_unknown',
      { terminal:false, hold:true })
    hold.manualTradeReviewDeferUntilUtcMs = Date.now() + 30_000
    expect(hold).toMatchObject({ manualTradeReviewHold:true })
    expect(hold.manualTradeReviewTerminalTask).toBeUndefined()
    db.queryRun.mockReset()
    db.queryRun.mockResolvedValueOnce({ affectedRows:1 }).mockResolvedValueOnce({ affectedRows:1 })
    const result = await __manualTradeReviewTest.deferManualTradeReviewForModelTaskLease({
      id:19, case_id:23, generation_no:4, lease_token:'lease-4', task_deadline_at:'2099-08-10 12:30:00',
    }, hold)
    expect(result).toMatchObject({ status:'queued', error_code:'manual_trade_review_counterfactual_task_status_unknown' })
    const [sql, params] = db.queryRun.mock.calls[0]
    expect(sql).toContain('attempt_count = GREATEST(0, attempt_count - 1)')
    expect(params.slice(0, 3)).toEqual(['queued', 'status_unknown', 'manual_trade_review_counterfactual_task_status_unknown'])
  })

  it('recovers a succeeded generic task only when its business version was already committed', () => {
    expect(__manualTradeReviewTest.manualTradeReviewCanRecoverCompletedTask({ status:'succeeded' }, {
      status:'draft', current_version_id:41,
    })).toBe(true)
    expect(__manualTradeReviewTest.manualTradeReviewCanRecoverCompletedTask({ status:'succeeded' }, {
      status:'generating', current_version_id:null,
    })).toBe(false)
    expect(__manualTradeReviewTest.manualTradeReviewCanRecoverCompletedTask({ status:'failed_terminal' }, {
      status:'draft', current_version_id:41,
    })).toBe(false)
  })

  it('persists a missing historical deadline only on the first manual job claim', async () => {
    const sqlCalls = []
    db.withTransaction.mockImplementationOnce(async callback => callback(async (sql, params) => {
      sqlCalls.push({ sql, params })
      if (sql.includes('SELECT jobs.*, cases.user_id')) return [[{
        id:31, case_id:19, status:'queued', attempt_count:0, task_deadline_at:null,
      }], []]
      return [{ affectedRows:1 }, []]
    }))
    const first = await __manualTradeReviewTest.claimManualTradeReviewJob()
    expect(first.task_deadline_at).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/)
    const claimUpdate = sqlCalls.find(call => call.sql.includes("SET status = 'leased'"))
    expect(claimUpdate?.sql).toContain('task_deadline_at = COALESCE(task_deadline_at, ?)')
    expect(claimUpdate?.params[0]).toBe(first.task_deadline_at)

    db.withTransaction.mockImplementationOnce(async callback => callback(async (sql, params) => {
      sqlCalls.push({ sql, params })
      if (sql.includes('SELECT jobs.*, cases.user_id')) return [[{
        id:31, case_id:19, status:'queued', attempt_count:1, task_deadline_at:'2026-08-10 12:30:00',
      }], []]
      return [{ affectedRows:1 }, []]
    }))
    const second = await __manualTradeReviewTest.claimManualTradeReviewJob()
    expect(second.task_deadline_at).toBe('2026-08-10 12:30:00')
  })

  it('creates generation one with a persisted business deadline in the job INSERT', async () => {
    vi.stubGlobal('setImmediate', vi.fn())
    const sqlCalls = []
    db.queryOne.mockReset()
    db.queryOne.mockResolvedValueOnce(null).mockResolvedValueOnce({
      id:19, user_id:7, trading_account_id:3, strategy_id:5, strategy_version:2, strategy_scope:'platform',
      evidence_status:'complete', status:'queued', generation_no:1, task_deadline_at:'2026-08-10 12:30:00',
    })
    db.withTransaction.mockImplementationOnce(async callback => callback(async (sql, params) => {
      sqlCalls.push({ sql, params })
      if (sql.includes('SELECT * FROM manual_trade_review_cases')) return [[], []]
      if (sql.includes('INSERT INTO manual_trade_review_cases')) return [{ insertId:19 }, []]
      return [{ affectedRows:1, insertId:1 }, []]
    }))
    const identity = 'a'.repeat(64)
    const sourceHashValue = 'b'.repeat(64)
    const result = await createManualTradeReview({ id:7 }, {
      client_request_id:'req-generation-1', trading_account_id:3, strategy_id:5,
      selection_context_token:createManualTradeSelectionContext({ userId:7, tradingAccountId:3, platform:'mt5',
        rangeStartUtcMsc:0, rangeEndUtcMsc:10_000_000_000_000, historySnapshotId:'snapshot-1' }),
      trades:[{ source_identity_hash:identity, trade_source_hash:sourceHashValue, position_id:'123' }],
    }, {
      account:{ id:3, user_id:7, platform:'mt5', terminal_instance_id:'terminal-1', broker_server:'Broker-Demo', login_account:'1001' },
      strategy:{ snapshot:{ id:5, version:2 }, hash:'strategy-hash' },
      evidence:{ evidence_status:'complete', market_data:{ status:'complete' },
        trades:[{ identity:{ identity_hash:identity, position_id:'123' }, symbol:'EURUSD', entry_time_utc_msc:1, close_time_utc_msc:2 }],
        trade_source_hashes:[{ source_identity_hash:identity, trade_source_hash:sourceHashValue }] },
    })
    vi.unstubAllGlobals()
    expect(result.created).toBe(true)
    const jobInsert = sqlCalls.find(call => call.sql.includes('INSERT INTO manual_trade_review_jobs'))
    expect(jobInsert?.sql).toContain('generation_no')
    expect(jobInsert?.sql).toContain('task_deadline_at')
    expect(jobInsert?.sql).toContain("VALUES (?, ?, 1, 'queued'")
    expect(jobInsert?.params[2]).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/)
  })

  it('replays an existing client request without requiring an expired selection context', async () => {
    db.queryOne.mockReset()
    db.queryOne.mockResolvedValueOnce({ id:19, user_id:7, trading_account_id:3, strategy_id:5,
      strategy_version:2, strategy_scope:'platform', evidence_status:'complete', status:'queued',
      current_version_id:null, approved_version_id:null, created_at:'2026-08-10 12:00:00', updated_at:'2026-08-10 12:00:00',
      generation_no:1, job_status:'queued', progress_stage:'queued', attempt_count:0, last_error_code:null })
    const result = await createManualTradeReview({ id:7 }, {
      client_request_id:'req-already-created',
      trades:[{ source_identity_hash:identityHash, trade_source_hash:sourceHash, position_id:'123' }],
      selection_context_token:'expired-or-missing-is-irrelevant-for-replay',
    })
    expect(result).toMatchObject({ created:false, case:{ id:19, status:'queued' } })
  })

  it('retries in one transaction with generation increment and a fresh deadline', async () => {
    vi.stubGlobal('setImmediate', vi.fn())
    const sqlCalls = []
    db.withTransaction.mockImplementationOnce(async callback => callback(async (sql, params) => {
      sqlCalls.push({ sql, params })
      if (sql.includes('SELECT cases.id AS case_id')) return [[{
        case_id:19, case_status:'failed', job_id:31, generation_no:1, job_status:'failed',
      }], []]
      return [{ affectedRows:1 }, []]
    }))
    const result = await retryManualTradeReview(19, { id:7 })
    vi.unstubAllGlobals()
    expect(result).toMatchObject({ queued:true, case_id:19, generation_no:2 })
    const jobUpdate = sqlCalls.find(call => call.sql.includes('UPDATE manual_trade_review_jobs'))
    expect(jobUpdate?.sql).toContain('generation_no = ?')
    expect(jobUpdate?.sql).toContain('model_task_id = NULL')
    expect(jobUpdate?.sql).toContain('task_deadline_at = ?')
    expect(jobUpdate?.sql).toContain('attempt_count = 0')
    expect(jobUpdate?.params[0]).toBe(2)
    expect(jobUpdate?.params[1]).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/)
    expect(sqlCalls.findIndex(call => call.sql.includes('UPDATE manual_trade_review_jobs')))
      .toBeLessThan(sqlCalls.findIndex(call => call.sql.includes('UPDATE manual_trade_review_cases')))
  })
})
