import { beforeEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'

const db = vi.hoisted(() => ({
  queryAll: vi.fn(), queryOne: vi.fn(), queryRun: vi.fn(),
  beijingNow: vi.fn(() => '2026-07-16 12:00:00'),
}))
vi.mock('../../server/db.js', () => db)
vi.mock('../../server/routes/ai/memory-system.js', () => ({
  sanitizeMemoryText: (value, max = 4000) => String(value || '').replace(/[<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, max),
  classifyMemoryText: () => 'market_regime',
}))
vi.mock('../../server/routes/ai/inference-snapshots.js', () => ({ sha256: value => `hash:${value}` }))

import { buildPlatformExperienceRetrievalContext, createPlatformExperienceCandidateFromApprovedPeriodReview,
  createPlatformExperienceCandidateFromApprovedReview, getPlatformExperienceEvaluation,
  deleteRevokedPlatformExperienceItem, platformExperienceApplicability, retrievePlatformExperience,
  sanitizePlatformExperienceText } from '../../server/routes/ai/platform-experience.js'

describe('platform strategy experience boundary', () => {
  beforeEach(() => vi.clearAllMocks())

  it('removes account, position and lot-specific lessons while preserving market lessons', () => {
    const value = sanitizePlatformExperienceText('H1 突破后等待回踩确认。账户余额不足，应减少手数。震荡区间不要追价。')
    expect(value).toContain('H1 突破后等待回踩确认')
    expect(value).toContain('震荡区间不要追价')
    expect(value).not.toContain('账户余额')
    expect(value).not.toContain('手数')
  })

  it('creates a candidate only for an approved platform-strategy review', async () => {
    db.queryOne
      .mockResolvedValueOnce({ id: 7, status: 'approved', approved_version_id: 9,
        evidence_json: JSON.stringify({ inference_time:{ snapshot:{ strategy_id:3 }, signal:{ timeframe:'H1', signal_type:'buy' } }, post_trade:{ outcome:{ symbol:'XAUUSD' } } }) })
      .mockResolvedValueOnce({ id: 9, content_json: JSON.stringify({ lessons:['等待 H1 回踩确认'], strengths:[] }) })
      .mockResolvedValueOnce({ id: 3 })
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: 11, status: 'candidate' })
    db.queryRun.mockResolvedValue({ insertId: 11, changes: 1 })
    await expect(createPlatformExperienceCandidateFromApprovedReview(7, 1)).resolves.toMatchObject({ id: 11, status:'candidate' })
    expect(db.queryRun.mock.calls[0][0]).toContain('platform_strategy_experience_items')
  })

  it('maps observer-source platform reviews to the shared platform memory tier', async () => {
    db.queryOne
      .mockResolvedValueOnce({ id:21, user_id:29, strategy_scope:'platform', strategy_id:3,
        strategy_version:2, period_type:'monthly', period_key:'2026-07', status:'approved', approved_version_id:31 })
      .mockResolvedValueOnce({ id:1, role:'admin', plan_source:'internal' })
      .mockResolvedValueOnce({ id:31, content_json:JSON.stringify({ period_summary:'月度趋势等待确认', memory_candidates:[{
        lesson:'趋势回调确认后再入场', memory_category:'entry_setup', supporting_period_case_ids:[1, 2],
        applicability:{ applicable_when:{ symbols:['xauusd'], timeframes:['h1'] }, avoid_when:{} },
      }] }) })
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id:3 })
      .mockResolvedValueOnce({ id:41, memory_tier:'long' })
    db.queryRun.mockResolvedValue({ insertId:41, changes:1 })
    await expect(createPlatformExperienceCandidateFromApprovedPeriodReview(21, 1))
      .resolves.toMatchObject({ memory_tier:'long' })
    expect(db.queryOne.mock.calls[0][1]).toEqual([21])
    expect(db.queryOne.mock.calls[1][1]).toEqual([1])
    const insert = db.queryRun.mock.calls.find(([sql]) => sql.includes('INSERT IGNORE INTO platform_strategy_experience_items'))
    expect(insert[0]).toContain('memory_tier')
    expect(insert[1]).toContain('long')
  })

  it('deletes only an already revoked platform experience record', async () => {
    db.queryOne.mockResolvedValueOnce({ id:11, status:'active' })
    await expect(deleteRevokedPlatformExperienceItem(11)).rejects.toThrow('platform_experience_must_be_revoked_before_delete')
    db.queryOne.mockResolvedValueOnce({ id:12, status:'revoked' })
    db.queryRun.mockResolvedValueOnce({ changes:1 })
    await expect(deleteRevokedPlatformExperienceItem(12)).resolves.toEqual({ deleted:true, id:12 })
    expect(db.queryRun.mock.calls.at(-1)[0]).toContain("status = 'revoked'")
  })

  it('shadow mode records selections but never injects them', async () => {
    db.queryOne.mockResolvedValue({ mode:'shadow', max_items:5, runtime_token_budget:800, policy_version:2 })
    db.queryAll.mockResolvedValue([{ id:4, lesson_text:'等待确认', platform_version:1,
      applicability_json:JSON.stringify({ applicable_when:{ symbols:['xauusd'], timeframes:['h1'] } }) }])
    db.queryRun.mockResolvedValue({ changes:1 })
    const result = await retrievePlatformExperience({ strategyId:3, symbol:'XAUUSD', timeframe:'H1' })
    expect(result.mode).toBe('shadow')
    expect(result.promptBlock).toBe('')
    expect(result.selectedItemIds).toEqual([4])
    expect(db.queryAll.mock.calls[0][0]).not.toContain('strategy_version = ?')
  })

  it('injects only experiences that pass deterministic market and entry-method matching', async () => {
    db.queryOne.mockResolvedValue({ mode:'active', max_items:5, runtime_token_budget:800, policy_version:3 })
    db.queryAll.mockResolvedValue([
      { id:4, lesson_text:'下跌趋势底背驰后等待确认', platform_version:2,
        context_json:JSON.stringify({ market_regime:'downward_exhaustion', trend_direction:'down', chan_divergence:'bottom', entry_methods:['limit'] }) },
      { id:5, lesson_text:'上涨趋势突破追多', platform_version:3,
        context_json:JSON.stringify({ market_regime:'uptrend', trend_direction:'up', chan_divergence:'top', entry_methods:['stop'] }) },
    ])
    const market = { strategy_score:{ momentum_alignment:-1, trend_strength:0.8 }, sma_distance_pct:-0.5, volatility_pct:0.4,
      chan:{ trend_state:{ state:'downward_exhaustion', direction:'down' }, current_segment:{ dir:'down' },
        divergence:{ confirmed:true, type:'bottom' }, reliability:'high' } }
    const result = await retrievePlatformExperience({ strategyId:3, symbol:'XAUUSD', timeframe:'H1', market, allowedEntryMethods:['limit'] })
    expect(result.selectedItemIds).toEqual([4])
    expect(result.selectionDetails[0]).toMatchObject({ id:4, score:96 })
    expect(result.promptBlock).toContain('[短期记忆 #4 | 匹配度 96]')
    expect(result.promptBlock).not.toContain('上涨趋势突破追多')
    expect(result.retrievalContext).toMatchObject({ market_regime:'downward_exhaustion', trend_direction:'down', chan_divergence:'bottom' })
  })

  it('records bounded candidate exclusion reasons without changing selected ids', async () => {
    db.queryOne.mockResolvedValue({ mode:'active', max_items:1, runtime_token_budget:800, policy_version:4 })
    db.queryAll.mockResolvedValue([
      { id:4, lesson_text:'等待确认', platform_version:2,
        applicability_json:JSON.stringify({ applicable_when:{ symbols:['xauusd'], timeframes:['h1'] } }) },
      { id:5, lesson_text:'第二条经验', platform_version:1,
        applicability_json:JSON.stringify({ applicable_when:{ symbols:['xauusd'], timeframes:['h1'] } }) },
      { id:6, lesson_text:'其他品种经验', platform_version:3,
        applicability_json:JSON.stringify({ applicable_when:{ symbols:['eurusd'], timeframes:['h1'] } }) },
    ])
    db.queryRun.mockResolvedValue({ insertId:22, changes:1 })
    const result = await retrievePlatformExperience({ strategyId:3, symbol:'XAUUSD', timeframe:'H1' })
    expect(result.selectedItemIds).toEqual([4])
    expect(result.selectionDetails).toEqual(expect.arrayContaining([
      expect.objectContaining({ id:4, eligible:true, selected:true, exclusion_reason:'selected' }),
      expect.objectContaining({ id:5, eligible:true, selected:false, exclusion_reason:'max_items_reached' }),
      expect.objectContaining({ id:6, eligible:false, selected:false, exclusion_reason:'context_not_eligible' }),
    ]))
    const details = JSON.parse(db.queryRun.mock.calls.at(-1)[1][7])
    expect(details).toHaveLength(3)
    expect(details[0]).toHaveProperty('reasons')
    expect(details[0]).not.toHaveProperty('lesson_text')
  })

  it('records budget exclusions separately from context mismatches', async () => {
    db.queryOne.mockResolvedValue({ mode:'shadow', max_items:5, runtime_token_budget:1, policy_version:4 })
    db.queryAll.mockResolvedValue([{ id:4, lesson_text:'这条经验必须因令牌预算被淘汰', platform_version:2,
      applicability_json:JSON.stringify({ applicable_when:{ symbols:['xauusd'], timeframes:['h1'] } }) }])
    db.queryRun.mockResolvedValue({ insertId:23, changes:1 })
    const result = await retrievePlatformExperience({ strategyId:3, symbol:'XAUUSD', timeframe:'H1' })
    expect(result.selectedItemIds).toEqual([])
    expect(result.selectionDetails[0]).toMatchObject({ id:4, eligible:true, selected:false, exclusion_reason:'token_budget_exceeded' })
  })

  it('keeps selected candidates in bounded details even when they follow twenty unselected rows', async () => {
    db.queryOne.mockResolvedValue({ mode:'shadow', max_items:1, runtime_token_budget:800, policy_version:4 })
    const unselected = Array.from({ length:20 }, (_, index) => ({
      id:index + 1, lesson_text:`其他品种经验 ${index + 1}`, platform_version:1,
      applicability_json:JSON.stringify({ applicable_when:{ symbols:['EURUSD'], timeframes:['H1'] } }),
    }))
    db.queryAll.mockResolvedValue([...unselected, { id:99, lesson_text:'当前品种经验', platform_version:1,
      applicability_json:JSON.stringify({ applicable_when:{ symbols:['XAUUSD'], timeframes:['H1'] } }) }])
    db.queryRun.mockResolvedValue({ insertId:24, changes:1 })
    const result = await retrievePlatformExperience({ strategyId:3, symbol:'XAUUSD', timeframe:'H1' })
    expect(result.selectedItemIds).toEqual([99])
    expect(result.selectionDetails.length).toBeLessThanOrEqual(20)
    expect(result.selectionDetails.find(detail => detail.id === 99)).toMatchObject({ selected:true, exclusion_reason:'selected' })
    const details = JSON.parse(db.queryRun.mock.calls.at(-1)[1][7])
    expect(details.length).toBeLessThanOrEqual(20)
    expect(details.find(detail => detail.id === 99)).toMatchObject({ selected:true })
  })

  it('derives a stable pre-inference retrieval context without another model call', () => {
    expect(buildPlatformExperienceRetrievalContext({ symbol:'XAUUSD', timeframe:'M15', allowedEntryMethods:['market'],
      market:{ strategy_score:{ momentum_alignment:1, trend_strength:0.7 }, sma_distance_pct:0.2, volatility_pct:0.2 } }))
      .toMatchObject({ symbol:'XAUUSD', timeframe:'M15', trend_direction:'up', market_regime:'uptrend', volatility_bucket:'normal' })
  })

  it('does not partition experience by strategy version, but still requires contextual applicability', () => {
    const result = platformExperienceApplicability({ strategy_id:3, context_json:JSON.stringify({ strategy_version:2 }),
      applicability_json:JSON.stringify({ applicable_when:{ symbols:['xauusd'], timeframes:['m5'] } }) },
      buildPlatformExperienceRetrievalContext({ strategyVersion:3, symbol:'XAUUSD', timeframe:'M5' }))
    expect(result.eligible).toBe(true)
    expect(result.reasons).toEqual(expect.arrayContaining(['symbols_match', 'timeframes_match']))
  })

  it('requires an explicit strategy binding before platform memory retrieval', async () => {
    const result = await retrievePlatformExperience({ strategyId:null, symbol:'XAUUSD', timeframe:'H1' })
    expect(result).toMatchObject({ disabled:true, reason:'strategy_required', selectedItemIds:[] })
    expect(db.queryOne).not.toHaveBeenCalled()
    expect(db.queryAll).not.toHaveBeenCalled()
  })

  it('summarizes shadow retrieval hits without claiming profitability', async () => {
    db.queryAll
      .mockResolvedValueOnce([
        { id:3, strategy_id:1, strategy_title:'趋势策略', policy_mode:'shadow', selected_item_ids_json:'[7]', token_count:20, symbol:'XAUUSD', timeframe:'H1', created_at:'2026-07-17 12:00:00' },
        { id:2, strategy_id:1, strategy_title:'趋势策略', policy_mode:'shadow', selected_item_ids_json:'[]', token_count:0, symbol:'XAUUSD', timeframe:'H1', created_at:'2026-07-17 11:00:00' },
      ])
      .mockResolvedValueOnce([{ id:7, strategy_id:1, strategy_title:'趋势策略', lesson_text:'等待结构确认', status:'active', platform_version:1, published_at:'2026-07-17 10:00:00' }])
    const result = await getPlatformExperienceEvaluation({ days:30 })
    expect(result.retrieval).toMatchObject({ observed_total:2, shadow_total:2, shadow_hits:1, shadow_hit_rate:0.5 })
    expect(result.items[0].hit_count).toBe(1)
    expect(result).not.toHaveProperty('paired')
  })

  it('keeps platform experience separate from personal memory in runtime code', () => {
    const llm = readFileSync(new URL('../../server/routes/ai/llm.js', import.meta.url), 'utf8')
    const scheduler = readFileSync(new URL('../../server/routes/ai/scheduler.js', import.meta.url), 'utf8')
    const migration = readFileSync(new URL('../../server/migrations.js', import.meta.url), 'utf8')
    expect(llm).toContain("config._market_only && typeof config._platformExperienceContext === 'string'")
    expect(scheduler).toContain('retrievePlatformExperience')
    expect(scheduler).toContain('const snapshotId = await persistInferenceSnapshotTx(run, {')
    expect(scheduler).toContain('return { signalId:insertedSignalId, snapshotId }')
    expect(scheduler).toContain('attachPlatformExperienceSignal(memory.logId, signalId, snapshotId)')
    expect(migration).toContain('077_platform_strategy_experience')
    expect(migration).toContain("ss.memory_mode = 'platform_only'")
  })
})
