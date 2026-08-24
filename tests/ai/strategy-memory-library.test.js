import { beforeEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import crypto from 'node:crypto'

const mockQueryOne = vi.fn()
const mockQueryAll = vi.fn()
const mockQueryRun = vi.fn()
const mockWithTransaction = vi.fn()

vi.mock('../../server/db.js', () => ({
  queryOne:(...args) => mockQueryOne(...args),
  queryAll:(...args) => mockQueryAll(...args),
  queryRun:(...args) => mockQueryRun(...args),
  withTransaction:fn => mockWithTransaction(fn),
  beijingNow:() => '2026-08-12 15:30:00',
}))

import {
  STRATEGY_MEMORY_DEFAULT_CAPACITY_CHARS,
  STRATEGY_MEMORY_INJECTION_USAGE_KIND_MAX_LENGTH,
  buildStrategyMemoryConflictKey,
  createStrategyMemoryInjectionLog,
  getStrategyMemoryLibraryForRuntime,
  normalizeStrategyMemoryConflictThreshold,
  normalizeStrategyMemoryInjectionUsageKind,
  sanitizeStrategyMemoryText,
  sanitizeLegacyStrategyMemoryContent,
  sanitizeStrategyMemoryReviewPackaging,
  saveStrategyMemoryLibrary,
  restoreStrategyMemoryLibraryRevision,
  enqueueApprovedStrategyMemoryUpdate,
  recordStrategyMemoryConflictEvidence,
  sanitizeStrategyMemoryPrompt,
  applyStrategyMemoryCompressionJob,
  failStrategyMemoryCompressionJob,
  queueStrategyMemoryCompressionJob,
  getStrategyMemoryCompressionJobStatus,
  getLatestStrategyMemoryCompressionJobStatus,
  strategyMemoryCharCount,
  updateStrategyMemoryInjectionLog,
} from '../../server/routes/ai/strategy-memory-library.js'

const privateStrategy = (overrides = {}) => ({
  id:5, scope:'private', owner_user_id:7, visibility_status:'active', is_active:1,
  title:'私有策略', version:3, system_prompt:'策略正文', ...overrides,
})

const library = (overrides = {}) => ({
  strategy_id:5, strategy_scope:'private', owner_user_id:7, content_text:'旧记忆',
  version_no:2, content_hash:'a'.repeat(64), char_count:3, estimated_token_count:3,
  capacity_chars:STRATEGY_MEMORY_DEFAULT_CAPACITY_CHARS,
  compression_target_ratio:0.6, conflict_alert_threshold:3,
  pending_update_count:0, compression_status:'idle', ...overrides,
})

beforeEach(() => {
  vi.clearAllMocks()
  mockWithTransaction.mockImplementation(async fn => fn(async () => [{ affectedRows:1, insertId:19 }]))
})

describe('unified strategy memory primitives', () => {
  it('ships the complete idempotent schema and queries only real strategy prompt columns', () => {
    const migrations = readFileSync(new URL('../../server/migrations.js', import.meta.url), 'utf8')
    const librarySource = readFileSync(new URL('../../server/routes/ai/strategy-memory-library.js', import.meta.url), 'utf8')
    const compressionSource = readFileSync(new URL('../../server/routes/ai/strategy-memory-compression.js', import.meta.url), 'utf8')
    expect(migrations).toContain("id: '181_unified_strategy_memory_library'")
    expect(migrations).toContain("id: '182_strategy_memory_merge_integrity'")
    expect(migrations).toContain("id: '184_strategy_memory_legacy_applicability_cleanup'")
    expect(migrations).toContain("id: '185_strategy_memory_review_packaging_cleanup'")
    expect(migrations.match(/id: '184_strategy_memory_legacy_applicability_cleanup'/g)).toHaveLength(1)
    const cleanupMigration = migrations.slice(migrations.lastIndexOf("id: '184_strategy_memory_legacy_applicability_cleanup'"))
    expect(cleanupMigration).toContain('INSERT INTO strategy_memory_library_revisions')
    expect(cleanupMigration).toContain("change_reason = 'legacy_import'")
    expect(cleanupMigration).toContain('WHERE strategy_id = ? AND version_no = ? AND content_hash = ?')
    expect(cleanupMigration).not.toContain('strategy_memory_compression_jobs SET status')
    const packagingMigration = migrations.slice(migrations.lastIndexOf("id: '185_strategy_memory_review_packaging_cleanup'"))
    expect(packagingMigration).toContain("change_reason IN ('daily_review_append', 'monthly_review_append')")
    expect(packagingMigration).toContain('review_packaging_cleanup')
    expect(packagingMigration).toContain('INSERT INTO strategy_memory_library_revisions')
    for (const column of ['result_content_hash', 'result_validation_status', 'result_validation_json']) {
      expect(migrations).toContain(column)
    }
    for (const table of ['strategy_memory_libraries', 'strategy_memory_library_revisions',
      'strategy_memory_pending_updates', 'strategy_memory_conflicts',
      'strategy_memory_conflict_occurrences', 'strategy_memory_compression_jobs',
      'strategy_memory_injection_logs']) {
      expect(migrations).toContain(`CREATE TABLE IF NOT EXISTS ${table}`)
    }
    for (const column of ['memory_library_version_no', 'memory_library_content_hash',
      'memory_library_snapshot_text', 'memory_strategy_snapshot_text']) expect(migrations).toContain(column)
    expect(librarySource).not.toMatch(/system_prompt,\s*prompt|prompt,\s*strategy_prompt/)
    expect(compressionSource).not.toMatch(/system_prompt,\s*prompt|prompt,\s*strategy_prompt/)
  })

  it('preserves Markdown and line breaks while removing control characters', () => {
    expect(sanitizeStrategyMemoryText('# 标题\r\n- 经验\u0000\u0085')).toBe('# 标题\n- 经验')
    expect(strategyMemoryCharCount('记忆A')).toBe(3)
  })

  it('keeps the generic defaults and stable conflict keys', () => {
    expect(STRATEGY_MEMORY_DEFAULT_CAPACITY_CHARS).toBe(120000)
    expect(normalizeStrategyMemoryConflictThreshold(undefined)).toBe(3)
    const input = { category:'entry_setup', description:'追涨与策略回调入场冲突', strategy_excerpt:'只允许回调' }
    expect(buildStrategyMemoryConflictKey(input)).toBe(buildStrategyMemoryConflictKey({ ...input }))
    expect(buildStrategyMemoryConflictKey(input)).toMatch(/^[a-f0-9]{64}$/)
  })

  it('normalizes the durable injection usage kind before writing it', async () => {
    mockQueryOne.mockResolvedValue(privateStrategy())
    mockQueryRun.mockResolvedValue({ insertId:41, affectedRows:1 })
    const result = await createStrategyMemoryInjectionLog({
      strategyId:5, actor:{ userId:7, role:'user' }, library:library(),
      injectionKind:'  manual_review_cf_point  ',
    })
    expect(STRATEGY_MEMORY_INJECTION_USAGE_KIND_MAX_LENGTH).toBe(32)
    expect(normalizeStrategyMemoryInjectionUsageKind('  manual_review_cf_point  ')).toBe('manual_review_cf_point')
    expect(mockQueryRun.mock.calls[0][1][5]).toBe('manual_review_cf_point')
    expect(result.usage_kind).toBe('manual_review_cf_point')
  })

  it('normalizes an updated injection usage kind before writing it', async () => {
    mockQueryRun.mockResolvedValue({ affectedRows:1 })
    mockQueryOne.mockResolvedValue({ id:41, usage_kind:'stale' })
    const result = await updateStrategyMemoryInjectionLog({
      logId:41, usageKind:'  manual_review_outcome  ',
    })
    expect(mockQueryRun).toHaveBeenCalledWith(
      expect.stringContaining('UPDATE strategy_memory_injection_logs SET usage_kind = ?'),
      ['manual_review_outcome', 41],
    )
    expect(result.usage_kind).toBe('manual_review_outcome')
  })

  it.each([
    ['create empty', () => createStrategyMemoryInjectionLog({
      strategyId:5, actor:{ userId:7, role:'user' }, library:library(), injectionKind:'   ',
    })],
    ['create overlong', () => createStrategyMemoryInjectionLog({
      strategyId:5, actor:{ userId:7, role:'user' }, library:library(), injectionKind:'x'.repeat(33),
    })],
    ['update empty', () => updateStrategyMemoryInjectionLog({ logId:41, usageKind:'   ' })],
    ['update overlong', () => updateStrategyMemoryInjectionLog({ logId:41, usageKind:'x'.repeat(33) })],
  ])('rejects an invalid injection usage kind before querying: %s', async (_label, operation) => {
    await expect(operation()).rejects.toThrow('strategy_memory_injection_usage_kind_invalid')
    expect(mockQueryOne).not.toHaveBeenCalled()
    expect(mockQueryRun).not.toHaveBeenCalled()
  })

  it('does not echo legacy conditional memory text into a review prompt', () => {
    const result = sanitizeStrategyMemoryPrompt({ content_text:'applicable_when: trend', char_count:20, estimated_token_count:5 })
    expect(result.content_text).toBe('')
    expect(result.char_count).toBe(0)
    expect(result.estimated_token_count).toBe(0)
    expect(result.content_hash).toBeUndefined()
  })

  it('cleans multiple inline legacy fields while retaining the surrounding lesson', () => {
    const result = sanitizeLegacyStrategyMemoryContent(
      '- 回调确认 applicable_when: {"symbols":["XAUUSD"]}; avoid_when: {"market_regimes":["range"]}; 保留结论',
    )
    expect(result.content).toBe('- 回调确认 保留结论')
    expect(result.changed).toBe(true)
    expect(result.removed).toBe(2)
  })

  it('does not remove natural-language applicability wording', () => {
    const source = '仅在适用条件明确时执行；avoid_when is discussed as a field name。'
    expect(sanitizeLegacyStrategyMemoryContent(source)).toMatchObject({ content:source, changed:false, removed:0 })
  })

  it('removes Markdown applicability blocks and keeps later trading rules', () => {
    const result = sanitizeLegacyStrategyMemoryContent(
      '## applicability\n- symbols: ["XAUUSD"]\n- timeframes: ["H1"]\n## 交易规则\n- 突破后等待回踩',
    )
    expect(result.content).toContain('## 交易规则')
    expect(result.content).toContain('突破后等待回踩')
    expect(result.content).not.toMatch(/applicability|symbols|timeframes/i)
  })

  it('preserves non-condition fields in an inline JSON object', () => {
    const result = sanitizeLegacyStrategyMemoryContent(
      '{"lesson":"保留结论","applicable_when":{"symbols":["XAUUSD"]}}',
    )
    expect(result.content).toBe('{"lesson":"保留结论"}')
  })

  it('removes a condition-only JSON object without leaving an empty object', () => {
    const result = sanitizeLegacyStrategyMemoryContent(
      '{"applicable_when":{"symbols":["XAUUSD"]},"avoid_when":{"market_regimes":["range"]}}',
    )
    expect(result.content).toBe('')
    expect(result.changed).toBe(true)
  })

  it('keeps ordinary fields inside a fenced JSON block while removing conditions', () => {
    const result = sanitizeLegacyStrategyMemoryContent(
      '```json\n{"lesson":"保留结论","applicable_when":{"symbols":["XAUUSD"]}}\n```',
    )
    expect(result.content).toContain('{"lesson":"保留结论"}')
    expect(result.content).not.toContain('applicable_when')
  })

  it('removes only known review wrappers and preserves user Markdown/natural language', () => {
    const result = sanitizeStrategyMemoryReviewPackaging([
      '# 策略记忆库',
      '> 以下内容由旧记忆系统中仍有效且归属明确的记录一次性导入。',
      '## 已确认复盘经验',
      '- [general] 等待确认',
      '  - 来源：outcome:1、period_review_case:2',
      '  - 置信度：0.8',
      '## 用户自己的标题',
      '[general] 普通自然语言不应被移除',
      '- 自然 [general] 文字',
      '来源：普通说明',
      '置信度：较高',
    ].join('\n'))
    expect(result.content).toContain('- 等待确认')
    expect(result.content).toContain('## 用户自己的标题')
    expect(result.content).toContain('[general] 普通自然语言不应被移除')
    expect(result.content).toContain('- 自然 [general] 文字')
    expect(result.content).toContain('来源：普通说明')
    expect(result.content).toContain('置信度：较高')
    expect(result.content).not.toContain('outcome:1')
    expect(result.content).not.toContain('置信度：0.8')
  })
})

describe('unified strategy memory access and CAS', () => {
  function configureCompressionQueue({ existing = null, insertResult = { insertId:23, affectedRows:1 }, libraryOverrides = {} } = {}) {
    mockQueryOne.mockResolvedValueOnce(privateStrategy())
    const run = vi.fn(async sql => {
      const text = String(sql)
      if (text.includes('SELECT * FROM strategy_memory_libraries')) return [[library(libraryOverrides)], []]
      if (text.includes('INSERT INTO strategy_memory_compression_jobs')) return [insertResult, []]
      if (text.includes('SELECT id, strategy_id, trigger_type, source_version_no') && text.includes('WHERE id = ?')) {
        return [existing ? [existing] : [], []]
      }
      if (text.includes('SELECT id, strategy_id, trigger_type, source_version_no')) {
        return [existing ? [existing] : [], []]
      }
      if (text.includes('UPDATE strategy_memory_libraries')) return [{ affectedRows:1 }, []]
      throw new Error(`unexpected_sql:${sql}`)
    })
    mockWithTransaction.mockImplementationOnce(fn => fn(run))
    return run
  }

  it('marks a newly created compression request queued and reports created=true', async () => {
    const run = configureCompressionQueue()
    const result = await queueStrategyMemoryCompressionJob({ strategyId:5,
      actor:{ userId:7, role:'user' }, trigger:'manual' })
    expect(result).toMatchObject({ id:23, status:'queued', created:true, replayed:false,
      library_status_updated:true })
    expect(run.mock.calls.filter(([sql]) => String(sql).includes('UPDATE strategy_memory_libraries'))).toHaveLength(1)
  })

  it.each(['succeeded', 'succeeded_noop'])('replays terminal compression status %s without re-queueing the library', async status => {
    const run = configureCompressionQueue({
      existing:{ id:23, strategy_id:5, status, source_version_no:2, source_content_hash:'a'.repeat(64),
        source_set_hash:'b'.repeat(64), target_chars:100, attempt_count:1, max_attempts:3,
        last_error_code:null, next_attempt_at:null },
      insertResult:{ insertId:23, affectedRows:0 },
      libraryOverrides:{ compression_status:'idle' },
    })
    const result = await queueStrategyMemoryCompressionJob({ strategyId:5,
      actor:{ userId:7, role:'user' }, trigger:'manual' })
    expect(result).toMatchObject({ id:23, status, created:false, replayed:true,
      library_status_updated:false })
    expect(run.mock.calls.filter(([sql]) => String(sql).includes('UPDATE strategy_memory_libraries'))).toHaveLength(0)
  })

  it('reuses an active leased compression task without issuing a duplicate queue transition', async () => {
    const run = configureCompressionQueue({
      existing:{ id:23, strategy_id:5, status:'leased', source_version_no:2, source_content_hash:'a'.repeat(64),
        source_set_hash:'b'.repeat(64), target_chars:100, attempt_count:1, max_attempts:3,
        lease_expires_at:'2099-01-01 00:00:00', next_attempt_at:null, last_error_code:null },
      insertResult:{ insertId:23, affectedRows:0 },
    })
    const result = await queueStrategyMemoryCompressionJob({ strategyId:5,
      actor:{ userId:7, role:'user' }, trigger:'manual' })
    expect(result).toMatchObject({ id:23, status:'leased', created:false, replayed:true,
      library_status_updated:false })
    expect(run.mock.calls.filter(([sql]) => String(sql).includes('UPDATE strategy_memory_libraries'))).toHaveLength(0)
  })

  it('only re-queues a failed compression task when its retry window is claimable', async () => {
    const claimableRun = configureCompressionQueue({
      existing:{ id:23, strategy_id:5, status:'failed', source_version_no:2, source_content_hash:'a'.repeat(64),
        source_set_hash:'b'.repeat(64), target_chars:100, attempt_count:1, max_attempts:3,
        next_attempt_at:'2026-08-12 15:00:00', last_error_code:'provider_timeout' },
      insertResult:{ insertId:23, affectedRows:0 },
      libraryOverrides:{ compression_status:'failed' },
    })
    const claimable = await queueStrategyMemoryCompressionJob({ strategyId:5,
      actor:{ userId:7, role:'user' }, trigger:'manual' })
    expect(claimable).toMatchObject({ status:'queued', library_status_updated:true })
    expect(claimableRun.mock.calls.filter(([sql]) => String(sql).includes('UPDATE strategy_memory_libraries'))).toHaveLength(1)

    vi.clearAllMocks()
    const exhaustedRun = configureCompressionQueue({
      existing:{ id:24, strategy_id:5, status:'failed', source_version_no:2, source_content_hash:'a'.repeat(64),
        source_set_hash:'b'.repeat(64), target_chars:100, attempt_count:3, max_attempts:3,
        next_attempt_at:'2026-08-12 15:00:00', last_error_code:'provider_timeout' },
      insertResult:{ insertId:24, affectedRows:0 },
      libraryOverrides:{ compression_status:'failed' },
    })
    const exhausted = await queueStrategyMemoryCompressionJob({ strategyId:5,
      actor:{ userId:7, role:'user' }, trigger:'manual' })
    expect(exhausted).toMatchObject({ status:'failed', library_status_updated:false })
    expect(exhaustedRun.mock.calls.filter(([sql]) => String(sql).includes('UPDATE strategy_memory_libraries'))).toHaveLength(0)
  })

  it('returns an authorized redacted compression-job summary with stage and version evidence', async () => {
    const sourceHash = 'b'.repeat(64)
    mockQueryOne
      .mockResolvedValueOnce(privateStrategy())
      .mockResolvedValueOnce({ id:9, strategy_id:5, status:'leased', source_version_no:2,
        source_content_hash:sourceHash, target_chars:100, result_revision_id:31,
        result_validation_status:'accepted', result_validation_json:'{"result_char_count":4}',
        last_error_code:'provider_status_unknown', model_task_id:'secret-task-id',
        created_at:'2026-08-12 15:00:00', updated_at:'2026-08-12 15:01:00', completed_at:null,
        lease_token:'secret-lease-token', model_response:'secret-prompt' })
      .mockResolvedValueOnce({ status:'applying' })
      .mockResolvedValueOnce({ strategy_id:5, version_no:3, char_count:4, content_hash:'c'.repeat(64) })
      .mockResolvedValueOnce({ id:22, strategy_id:5, version_no:2, char_count:8, content_hash:sourceHash })
      .mockResolvedValueOnce({ id:31, strategy_id:5, version_no:3, char_count:4, content_hash:'c'.repeat(64) })

    const result = await getStrategyMemoryCompressionJobStatus({
      strategyId:5, jobId:9, actor:{ userId:7, role:'user' },
    })
    expect(result).toMatchObject({ id:9, strategy_id:5, status:'running', presentation_stage:'applying',
      source_version_no:2, result_revision_id:31, target_chars:100,
      result_validation_status:'accepted', last_error_code:'provider_status_unknown',
      source:{ revision_id:22, version_no:2, char_count:8 },
      result:{ revision_id:31, version_no:3, char_count:4 },
      current:{ version_no:3, char_count:4 }, source_char_count:8,
      result_char_count:4, current_char_count:4, result_version:3, current_version:3 })
    expect(result).not.toHaveProperty('lease_token')
    expect(result).not.toHaveProperty('model_task_id')
    expect(result).not.toHaveProperty('result_validation_json')
  })

  it('rejects a missing job under an authorized strategy without leaking another strategy job', async () => {
    mockQueryOne.mockResolvedValueOnce(privateStrategy()).mockResolvedValueOnce(null)
    await expect(getStrategyMemoryCompressionJobStatus({ strategyId:5, jobId:99,
      actor:{ userId:7, role:'user' } })).rejects.toThrow('strategy_memory_compression_job_not_found')
    expect(mockQueryOne).toHaveBeenCalledTimes(2)
    expect(String(mockQueryOne.mock.calls[1][0])).toContain('strategy_id = ?')
  })

  it('recovers the latest authorized compression job after a page reload', async () => {
    const sourceHash = 'b'.repeat(64)
    mockQueryOne
      .mockResolvedValueOnce(privateStrategy())
      .mockResolvedValueOnce({ id:9 })
      .mockResolvedValueOnce(privateStrategy())
      .mockResolvedValueOnce({ id:9, strategy_id:5, status:'succeeded_noop', source_version_no:2,
        source_content_hash:sourceHash, target_chars:100, result_revision_id:null,
        result_validation_status:'noop', result_validation_json:'{"result_char_count":8}',
        last_error_code:null, created_at:null, updated_at:null, completed_at:null, model_task_id:null })
      .mockResolvedValueOnce({ strategy_id:5, version_no:2, char_count:8, content_hash:sourceHash })
      .mockResolvedValueOnce({ id:22, strategy_id:5, version_no:2, char_count:8, content_hash:sourceHash })
    const result = await getLatestStrategyMemoryCompressionJobStatus({ strategyId:5,
      actor:{ userId:7, role:'user' } })
    expect(result).toMatchObject({ id:9, strategy_id:5, status:'succeeded_noop', result_char_count:8 })
    expect(String(mockQueryOne.mock.calls[1][0])).toContain('ORDER BY id DESC LIMIT 1')
  })

  it.each([
    ['provider_status_unknown', 'status_unknown'],
    ['provider_status_unknown_after_recovery', 'status_unknown'],
    ['strategy_memory_compression_stale', 'stale'],
    ['strategy_memory_pending_update_stale', 'stale'],
    ['model_task_recovery_stale', 'stale'],
    ['ordinary_failure', 'failed'],
  ])('maps persisted failed job error %s to presentation status %s', async (errorCode, expectedStatus) => {
    const sourceHash = 'd'.repeat(64)
    mockQueryOne
      .mockResolvedValueOnce(privateStrategy())
      .mockResolvedValueOnce({ id:14, strategy_id:5, status:'failed', source_version_no:2,
        source_content_hash:sourceHash, target_chars:100, result_revision_id:null,
        result_validation_status:'rejected', result_validation_json:null,
        last_error_code:errorCode, created_at:null, updated_at:null, completed_at:null,
        model_task_id:null })
      .mockResolvedValueOnce({ strategy_id:5, version_no:2, char_count:8, content_hash:sourceHash })
      .mockResolvedValueOnce({ id:22, strategy_id:5, version_no:2, char_count:8, content_hash:sourceHash })

    const result = await getStrategyMemoryCompressionJobStatus({ strategyId:5, jobId:14,
      actor:{ userId:7, role:'user' } })
    expect(result).toMatchObject({ status:expectedStatus, presentation_stage:expectedStatus,
      last_error_code:errorCode })
  })

  it('does not claim the source version as a succeeded-noop result after the library advances', async () => {
    const sourceHash = 'e'.repeat(64)
    mockQueryOne
      .mockResolvedValueOnce(privateStrategy())
      .mockResolvedValueOnce({ id:15, strategy_id:5, status:'succeeded_noop', source_version_no:2,
        source_content_hash:sourceHash, target_chars:100, result_revision_id:null,
        result_validation_status:'accepted', result_validation_json:'{"result_char_count":4}',
        last_error_code:null, created_at:null, updated_at:null, completed_at:null,
        model_task_id:null })
      .mockResolvedValueOnce({ strategy_id:5, version_no:3, char_count:12, content_hash:'f'.repeat(64) })
      .mockResolvedValueOnce({ id:22, strategy_id:5, version_no:2, char_count:8, content_hash:sourceHash })

    const result = await getStrategyMemoryCompressionJobStatus({ strategyId:5, jobId:15,
      actor:{ userId:7, role:'user' } })
    expect(result).toMatchObject({ status:'succeeded_noop', result_char_count:4, result_version:null,
      result:{ revision_id:null, version_no:null, char_count:4 }, current_version:3 })
  })

  it('keeps updates that arrived after a compression job and queues the next frozen set', async () => {
    const job = { id:9, strategy_id:5, status:'leased', lease_token:'lease-9', trigger_type:'capacity',
      source_version_no:2, source_content_hash:'a'.repeat(64), pending_update_ids_json:'[11]', target_chars:100 }
    mockQueryOne.mockResolvedValueOnce(privateStrategy())
    const run = vi.fn(async (sql) => {
      const text = String(sql)
      if (text.includes('FROM strategy_memory_compression_jobs WHERE id')) return [[job], []]
      if (text.includes('FROM strategy_memory_libraries')) return [[library()], []]
      if (text.includes('FROM strategy_memory_pending_updates') && text.includes('id IN')) {
        return [[{ id:11, strategy_id:5, update_kind:'daily_review', content_text:'新待更新', status:'pending' }], []]
      }
      if (text.includes("WHERE strategy_id = ? AND status = 'pending' ORDER BY id FOR UPDATE")) {
        return [[{ id:12, update_kind:'daily_review' }], []]
      }
      if (text.includes('INSERT INTO strategy_memory_library_revisions')) return [{ insertId:31, affectedRows:1 }, []]
      if (text.includes('INSERT INTO strategy_memory_compression_jobs')) return [{ insertId:44, affectedRows:1 }, []]
      return [{ affectedRows:1, insertId:0 }, []]
    })
    mockWithTransaction.mockImplementationOnce(fn => fn(run))
    const result = await applyStrategyMemoryCompressionJob({ jobId:9, leaseToken:'lease-9', content_text:'压缩结果' })
    expect(result.library).toMatchObject({ pending_update_count:1, compression_status:'queued' })
    expect(result.next_compression_job_id).toBe(44)
    const nextJobCall = run.mock.calls.find(([sql]) => String(sql).includes('INSERT INTO strategy_memory_compression_jobs'))
    expect(nextJobCall?.[1]).toContain(JSON.stringify([12]))
  })

  it('appends a frozen approved update after a model omitted it, never recording false success', async () => {
    const job = { id:10, strategy_id:5, status:'leased', lease_token:'lease-10', trigger_type:'capacity',
      source_version_no:2, source_content_hash:'a'.repeat(64), pending_update_ids_json:'[11]', target_chars:100 }
    mockQueryOne.mockResolvedValueOnce(privateStrategy())
    const run = vi.fn(async sql => {
      const text = String(sql)
      if (text.includes('FROM strategy_memory_compression_jobs WHERE id')) return [[job], []]
      if (text.includes('FROM strategy_memory_libraries')) return [[library()], []]
      if (text.includes('FROM strategy_memory_pending_updates') && text.includes('id IN')) {
        return [[{ id:11, strategy_id:5, update_kind:'monthly_review', content_text:'## 月复盘确认经验\n\n- 等待收盘确认', status:'pending' }], []]
      }
      if (text.includes('FROM strategy_memory_pending_updates') && text.includes('status = \'pending\'')) return [[], []]
      if (text.includes('INSERT INTO strategy_memory_library_revisions')) return [{ insertId:33, affectedRows:1 }, []]
      if (text.includes('UPDATE strategy_memory_pending_updates')) return [{ affectedRows:1 }, []]
      if (text.includes('UPDATE strategy_memory_compression_jobs')) return [{ affectedRows:1 }, []]
      return [{ affectedRows:1, insertId:0 }, []]
    })
    mockWithTransaction.mockImplementationOnce(fn => fn(run))
    const result = await applyStrategyMemoryCompressionJob({ jobId:10, leaseToken:'lease-10', content_text:'压缩后的旧库',
      result_validation:{ semantic_manifest_hash:'a'.repeat(64), source_block_ids:['block-1'],
        coverage_map:[{ source_block_id:'block-1', disposition:'preserved', result_section:'must-not-persist' }],
        unresolved_conflicts:['conflict-1'], removed_redundancies:['redundancy-1'],
        content_text:'must-not-persist' } })
    expect(result).toMatchObject({ status:'succeeded', revision_id:33 })
    const revisionCall = run.mock.calls.find(([sql]) => String(sql).includes('INSERT INTO strategy_memory_library_revisions'))
    expect(String(revisionCall?.[1]?.[5] || '')).toContain('月复盘确认经验')
    expect(String(revisionCall?.[1]?.[5] || '')).toContain('等待收盘确认')
    const jobCall = run.mock.calls.find(([sql]) => String(sql).includes('SET status = ?, result_revision_id'))
    expect(jobCall?.[1]).toContain('accepted')
    const validation = JSON.parse(jobCall?.[1]?.[4] || '{}')
    expect(validation).toMatchObject({ semantic_manifest_hash:'a'.repeat(64), source_block_ids:['block-1'],
      coverage_map:[{ source_block_id:'block-1', disposition:'preserved',
        result_section_hash:crypto.createHash('sha256').update('must-not-persist', 'utf8').digest('hex') }],
      unresolved_conflict_hashes:[crypto.createHash('sha256').update('conflict-1', 'utf8').digest('hex')],
      removed_redundancy_hashes:[crypto.createHash('sha256').update('redundancy-1', 'utf8').digest('hex')],
      validation_status:'accepted' })
    expect(validation).not.toHaveProperty('content_text')
    expect(JSON.stringify(validation)).not.toContain('must-not-persist')
  })

  it('returns succeeded_noop without creating a duplicate revision for an identical result', async () => {
    const sourceText = '旧记忆'
    const sourceHash = crypto.createHash('sha256').update(sourceText, 'utf8').digest('hex')
    const job = { id:12, strategy_id:5, status:'leased', lease_token:'lease-12', trigger_type:'manual',
      source_version_no:4, source_content_hash:sourceHash, pending_update_ids_json:'[]', target_chars:100 }
    mockQueryOne.mockResolvedValueOnce(privateStrategy())
    const current = library({ version_no:4, content_text:sourceText, content_hash:sourceHash, char_count:3 })
    const run = vi.fn(async sql => {
      const text = String(sql)
      if (text.includes('FROM strategy_memory_compression_jobs WHERE id')) return [[job], []]
      if (text.includes('FROM strategy_memory_libraries')) return [[current], []]
      if (text.includes('FROM strategy_memory_pending_updates')) return [[], []]
      if (text.includes('UPDATE strategy_memory_libraries')) return [{ affectedRows:1 }, []]
      if (text.includes('UPDATE strategy_memory_compression_jobs')) return [{ affectedRows:1 }, []]
      if (text.includes('INSERT INTO strategy_memory_library_revisions')) throw new Error('duplicate_revision_should_not_be_created')
      return [{ affectedRows:1 }, []]
    })
    mockWithTransaction.mockImplementationOnce(fn => fn(run))
    const result = await applyStrategyMemoryCompressionJob({ jobId:12, leaseToken:'lease-12', content_text:sourceText })
    expect(result).toMatchObject({ status:'succeeded_noop', revision_id:null, library:{ version_no:4 } })
    expect(run.mock.calls.some(([sql]) => String(sql).includes('INSERT INTO strategy_memory_library_revisions'))).toBe(false)
  })

  it('marks compression failure while preserving the already applied library', async () => {
    mockQueryRun.mockResolvedValue({ affectedRows:1 })
    mockQueryOne.mockResolvedValueOnce({ strategy_id:5, pending_update_ids_json:'[11]' })
    const result = await failStrategyMemoryCompressionJob({
      jobId:10, leaseToken:'lease-10', retryable:false, errorCode:'provider_status_unknown' })
    expect(result).toMatchObject({ status:'failed', memory_preserved:true, error_code:'provider_status_unknown' })
    expect(mockQueryRun.mock.calls.some(([sql]) => String(sql).includes('SET compression_status = ?'))).toBe(true)
    expect(mockQueryRun.mock.calls.some(([sql]) => String(sql).includes('content_text ='))).toBe(false)
  })
  it('allows an active platform strategy to expose its library to runtime without manager authority', async () => {
    mockQueryOne
      .mockResolvedValueOnce(privateStrategy({ id:1, scope:'platform', owner_user_id:0 }))
      .mockResolvedValueOnce(library({ strategy_id:1, strategy_scope:'platform', owner_user_id:0 }))
    await expect(getStrategyMemoryLibraryForRuntime({ strategyId:1, userId:99, role:'user' }))
      .resolves.toMatchObject({ strategy_id:1, strategy_scope:'platform', strategy_text:'策略正文',
        library:{ content_text:'旧记忆', version_no:2 } })
  })

  it('rejects another user reading a private strategy at runtime', async () => {
    mockQueryOne.mockResolvedValueOnce(privateStrategy())
    await expect(getStrategyMemoryLibraryForRuntime({ strategyId:5, userId:8, role:'user' }))
      .rejects.toThrow('strategy_memory_forbidden')
  })

  it('rejects a stale manual edit before writing a new revision', async () => {
    mockQueryOne.mockResolvedValueOnce(privateStrategy())
    const run = vi.fn(async sql => {
      if (String(sql).includes('SELECT * FROM strategy_memory_libraries')) return [[library()], []]
      throw new Error(`unexpected_sql:${sql}`)
    })
    mockWithTransaction.mockImplementationOnce(fn => fn(run))
    await expect(saveStrategyMemoryLibrary({ strategyId:5, actor:{ userId:7, role:'user' },
      expected_version_no:1, content_text:'新记忆' })).rejects.toThrow('strategy_memory_version_conflict')
    expect(run.mock.calls.some(([sql]) => String(sql).includes('INSERT INTO strategy_memory_library_revisions'))).toBe(false)
  })

  it('rejects manual text over the configured storage capacity', async () => {
    mockQueryOne.mockResolvedValueOnce(privateStrategy())
    const run = vi.fn(async sql => {
      if (String(sql).includes('SELECT * FROM strategy_memory_libraries')) return [[library({ capacity_chars:3 })], []]
      throw new Error(`unexpected_sql:${sql}`)
    })
    mockWithTransaction.mockImplementationOnce(fn => fn(run))
    await expect(saveStrategyMemoryLibrary({ strategyId:5, actor:{ userId:7, role:'user' },
      expected_version_no:2, content_text:'四个字符' })).rejects.toThrow('strategy_memory_capacity_exceeded')
  })

  it('queues automatic compression when a manual save reaches capacity', async () => {
    mockQueryOne.mockResolvedValueOnce(privateStrategy())
    const run = vi.fn(async sql => {
      const text = String(sql)
      if (text.includes('SELECT * FROM strategy_memory_libraries')) return [[library({ capacity_chars:4 })], []]
      if (text.includes('INSERT INTO strategy_memory_library_revisions')) return [{ insertId:32, affectedRows:1 }, []]
      if (text.includes('UPDATE strategy_memory_libraries')) return [{ affectedRows:1 }, []]
      if (text.includes('INSERT INTO strategy_memory_compression_jobs')) return [{ insertId:45, affectedRows:1 }, []]
      throw new Error(`unexpected_sql:${sql}`)
    })
    mockWithTransaction.mockImplementationOnce(fn => fn(run))
    const saved = await saveStrategyMemoryLibrary({ strategyId:5, actor:{ userId:7, role:'user' },
      expected_version_no:2, content_text:'四个字符' })
    expect(saved).toMatchObject({ compression_status:'queued', compression_job_id:45 })
    expect(run.mock.calls.some(([sql]) => String(sql).includes('INSERT INTO strategy_memory_compression_jobs'))).toBe(true)
  })

  it('deterministically applies a monthly update even while an older compression is queued', async () => {
    mockQueryOne.mockResolvedValueOnce(privateStrategy())
    const queuedLibrary = library({ content_text:'旧记忆', version_no:4,
      content_hash:'a'.repeat(64), compression_status:'queued' })
    const run = vi.fn(async (sql) => {
      const text = String(sql)
      if (text.includes('FROM period_review_cases cases')) return [[{ id:1201, strategy_id:5,
        period_type:'monthly', status:'approved', current_version_id:39, approved_version_id:39,
        canonical_version_id:39, canonical_version_case_id:1201,
        evidence_json:JSON.stringify({ sources:[{ period_case_id:1101 }, { period_case_id:1102 }] }) }], []]
      if (text.includes('SELECT * FROM strategy_memory_libraries')) return [[queuedLibrary], []]
      if (text.includes('FROM strategy_memory_pending_updates')) return [[], []]
      if (text.includes('INSERT INTO strategy_memory_pending_updates')) return [{ insertId:21, affectedRows:1 }, []]
      if (text.includes('INSERT INTO strategy_memory_library_revisions')) return [{ insertId:22, affectedRows:1 }, []]
      if (text.includes('UPDATE strategy_memory_libraries')) return [{ affectedRows:1 }, []]
      if (text.includes('UPDATE strategy_memory_pending_updates')) return [{ affectedRows:1 }, []]
      if (text.includes('INSERT INTO strategy_memory_compression_jobs')) return [{ insertId:23, affectedRows:1 }, []]
      throw new Error(`unexpected_sql:${sql}`)
    })
    mockWithTransaction.mockImplementationOnce(fn => fn(run))
    const result = await enqueueApprovedStrategyMemoryUpdate({
      strategyId:5, actor:{ serverOwned:true, userId:7 }, serverOwned:true,
      strategyScope:'private', strategyOwnerUserId:7,
      validatedReviewCase:{ strategy_id:5, scope:'private', owner_user_id:7, status:'approved' },
      approved:true, period_review_version_id:39, period_review_case_id:1201,
      update_kind:'monthly_review', content_text:'等待收盘确认',
    })
    expect(result).toMatchObject({ merged:true, pending:false, revision_id:22,
      compression_job_id:23, library:{ compression_status:'queued' } })
    const revisionCall = run.mock.calls.find(([sql]) => String(sql).includes('INSERT INTO strategy_memory_library_revisions'))
    expect(revisionCall?.[1]?.[2]).toBe('monthly_review_append')
    expect(revisionCall?.[1]?.[5]).toBe('旧记忆\n\n等待收盘确认')
    expect(JSON.parse(revisionCall?.[1]?.[10] || '{}').source_refs).toEqual([
      'period_review_case:1201', 'period_review_version:39',
    ])
    const libraryUpdate = run.mock.calls.find(([sql]) => String(sql).includes('UPDATE strategy_memory_libraries'))
    expect(libraryUpdate?.[1]).toContain('queued')
  })

  it('creates a corrective revision before appending a review to a legacy library', async () => {
    mockQueryOne.mockResolvedValueOnce(privateStrategy())
    const legacyText = '## 旧经验\n- 回调确认 applicable_when: {"symbols":["XAUUSD"]}; avoid_when: {"market_regimes":["range"]}'
    const legacyLibrary = library({ content_text:legacyText, version_no:1, content_hash:'a'.repeat(64),
      char_count:legacyText.length })
    const run = vi.fn(async sql => {
      const text = String(sql)
      if (text.includes('FROM period_review_cases cases')) return [[{ id:1201, strategy_id:5,
        period_type:'daily', status:'approved', current_version_id:39, approved_version_id:39,
        canonical_version_id:39, canonical_version_case_id:1201,
        evidence_json:JSON.stringify({ sources:[{ outcome_id:101 }] }) }], []]
      if (text.includes('SELECT * FROM strategy_memory_libraries')) return [[legacyLibrary], []]
      if (text.includes('FROM strategy_memory_pending_updates')) return [[], []]
      if (text.includes('INSERT INTO strategy_memory_pending_updates')) return [{ insertId:31, affectedRows:1 }, []]
      if (text.includes('INSERT INTO strategy_memory_library_revisions')) {
        const count = run.mock.calls.filter(([statement]) => String(statement).includes('INSERT INTO strategy_memory_library_revisions')).length
        return [{ insertId:count === 1 ? 30 : 32, affectedRows:1 }, []]
      }
      if (text.includes('UPDATE strategy_memory_libraries')) return [{ affectedRows:1 }, []]
      if (text.includes('UPDATE strategy_memory_pending_updates')) return [{ affectedRows:1 }, []]
      throw new Error(`unexpected_sql:${sql}`)
    })
    mockWithTransaction.mockImplementationOnce(fn => fn(run))
    const result = await enqueueApprovedStrategyMemoryUpdate({
      strategyId:5, actor:{ serverOwned:true, userId:7 }, serverOwned:true,
      strategyScope:'private', strategyOwnerUserId:7,
      validatedReviewCase:{ strategy_id:5, scope:'private', owner_user_id:7, status:'approved' },
      approved:true, period_review_version_id:39, period_review_case_id:1201,
      update_kind:'daily_review', content_text:'等待收盘确认',
    })
    expect(result).toMatchObject({ merged:true, pending:false, revision_id:32, library:{ version_no:3 } })
    const revisions = run.mock.calls.filter(([statement]) => String(statement).includes('INSERT INTO strategy_memory_library_revisions'))
    expect(revisions).toHaveLength(2)
    expect(revisions[0][1][2]).toBe('legacy_applicability_cleanup')
    expect(revisions[1][1][2]).toBe('daily_review_append')
    expect(revisions[0][1][5]).not.toMatch(/applicable_when|avoid_when/i)
    expect(revisions[1][1][5]).not.toMatch(/applicable_when|avoid_when/i)
  })

  it('cleans a legacy revision at restore boundary and records the cleaned restore', async () => {
    mockQueryOne.mockResolvedValueOnce(privateStrategy())
    const run = vi.fn(async sql => {
      const text = String(sql)
      if (text.includes('SELECT * FROM strategy_memory_libraries')) return [[library({ version_no:2 })], []]
      if (text.includes('FROM strategy_memory_library_revisions')) return [[{
        id:11, strategy_id:5, version_no:1,
        content_text:'## 经验\n- 回调 applicable_when: {"symbols":["XAUUSD"]}',
        source_metadata_json:null,
      }], []]
      if (text.includes('INSERT INTO strategy_memory_library_revisions')) return [{ insertId:33, affectedRows:1 }, []]
      if (text.includes('UPDATE strategy_memory_libraries')) return [{ affectedRows:1 }, []]
      throw new Error(`unexpected_sql:${sql}`)
    })
    mockWithTransaction.mockImplementationOnce(fn => fn(run))
    const result = await restoreStrategyMemoryLibraryRevision({ strategyId:5,
      actor:{ userId:7, role:'user' }, expected_version_no:2, revision_id:11 })
    expect(result).toMatchObject({ revision_id:33, version_no:3 })
    const revision = run.mock.calls.find(([statement]) => String(statement).includes('INSERT INTO strategy_memory_library_revisions'))
    expect(revision?.[1]?.[2]).toBe('restore_legacy_cleaned')
    expect(revision?.[1]?.[5]).not.toMatch(/applicable_when|avoid_when/i)
  })

  it('reloads the approved case/version and rejects forged conflict source references', async () => {
    mockQueryOne.mockResolvedValueOnce(privateStrategy())
    const run = vi.fn(async sql => {
      const text = String(sql)
      if (text.includes('FROM period_review_cases cases')) return [[{ id:1201, strategy_id:5,
        period_type:'daily', status:'approved', current_version_id:39, approved_version_id:39,
        canonical_version_id:39, canonical_version_case_id:1201,
        evidence_json:JSON.stringify({ sources:[{ outcome_id:101 }] }) }], []]
      if (text.includes('SELECT * FROM strategy_memory_libraries')) return [[library()], []]
      if (text.includes('FROM strategy_memory_conflicts')) return [[], []]
      if (text.includes('INSERT INTO strategy_memory_conflicts')) return [{ insertId:77, affectedRows:1 }, []]
      if (text.includes('FROM strategy_memory_conflict_occurrences')) return [[], []]
      if (text.includes('INSERT INTO strategy_memory_conflict_occurrences')) return [{ insertId:88, affectedRows:1 }, []]
      if (text.includes('UPDATE strategy_memory_conflicts')) return [{ affectedRows:1 }, []]
      throw new Error(`unexpected_sql:${sql}`)
    })
    mockWithTransaction.mockImplementationOnce(fn => fn(run))
    await expect(recordStrategyMemoryConflictEvidence({
      strategyId:5, actor:{ serverOwned:true, userId:7 }, serverOwned:true,
      strategyScope:'private', strategyOwnerUserId:7,
      validatedReviewCase:{ id:1201, strategy_id:5, approved_version_id:39, status:'approved' },
      approved:true, period_review_version_id:39, period_review_case_id:1201,
      conflict_key:'conflict-1', description:'结构矛盾', source_refs:['outcome:101', 'unknown:forged'],
    })).rejects.toThrow('strategy_memory_source_ref_invalid')
    expect(run.mock.calls.some(([sql]) => String(sql).includes('INSERT INTO strategy_memory_conflicts'))).toBe(false)
  })

  it('rejects conflict evidence when the durable case is not approved/current', async () => {
    mockQueryOne.mockResolvedValueOnce(privateStrategy())
    const run = vi.fn(async sql => {
      if (String(sql).includes('FROM period_review_cases cases')) return [[], []]
      throw new Error(`unexpected_sql:${sql}`)
    })
    mockWithTransaction.mockImplementationOnce(fn => fn(run))
    await expect(recordStrategyMemoryConflictEvidence({
      strategyId:5, actor:{ serverOwned:true, userId:7 }, serverOwned:true,
      strategyScope:'private', strategyOwnerUserId:7, approved:true,
      period_review_version_id:39, period_review_case_id:1201,
      conflict_key:'conflict-1', description:'结构矛盾', source_refs:['outcome:101'],
    })).rejects.toThrow('strategy_memory_approved_review_not_canonical')
  })

  it('deduplicates conflict evidence by review case even when a regenerated version differs', async () => {
    mockQueryOne.mockResolvedValueOnce(privateStrategy())
    const run = vi.fn(async sql => {
      const text = String(sql)
      if (text.includes('FROM period_review_cases cases')) return [[{ id:1201, strategy_id:5,
        period_type:'daily', status:'approved', current_version_id:39, approved_version_id:39,
        canonical_version_id:39, canonical_version_case_id:1201,
        evidence_json:JSON.stringify({ sources:[{ outcome_id:101 }] }) }], []]
      if (text.includes('SELECT * FROM strategy_memory_libraries')) return [[library()], []]
      if (text.includes('FROM strategy_memory_conflicts')) return [[{
        id:77, strategy_id:5, evidence_count:1, alert_threshold:3, status:'observing',
      }], []]
      if (text.includes('FROM strategy_memory_conflict_bindings')) return [[{ id:66 }], []]
      if (text.includes('INSERT INTO strategy_memory_conflict_bindings')) return [{ affectedRows:1 }, []]
      if (text.includes('FROM strategy_memory_conflict_occurrences')) return [[{
        id:88, conflict_id:77, period_review_case_id:1201, period_review_version_id:38,
      }], []]
      throw new Error(`unexpected_sql:${sql}`)
    })
    mockWithTransaction.mockImplementationOnce(fn => fn(run))
    const result = await recordStrategyMemoryConflictEvidence({
      strategyId:5, actor:{ serverOwned:true, userId:7 }, serverOwned:true,
      strategyScope:'private', strategyOwnerUserId:7,
      validatedReviewCase:{ id:1201, strategy_id:5, approved_version_id:39, status:'approved' },
      approved:true, period_review_version_id:39, period_review_case_id:1201,
      conflict_target:'existing_memory', category:'general', description:'结构矛盾',
      strategy_excerpt:'策略正文', memory_excerpt:'旧记忆', source_refs:['outcome:101'],
    })
    expect(result).toMatchObject({ recorded:false, duplicate:true })
    const occurrenceSelect = run.mock.calls.find(([sql]) => String(sql).includes('FROM strategy_memory_conflict_occurrences'))
    expect(String(occurrenceSelect?.[0])).toContain('period_review_case_id = ?')
    expect(occurrenceSelect?.[1]).toEqual([77, 1201])
    expect(run.mock.calls.some(([sql]) => String(sql).includes('INSERT INTO strategy_memory_conflict_occurrences'))).toBe(false)
  })

  it('recounts distinct review cases before applying the conflict alert threshold', async () => {
    mockQueryOne.mockResolvedValueOnce(privateStrategy())
    const run = vi.fn(async sql => {
      const text = String(sql)
      if (text.includes('FROM period_review_cases cases')) return [[{ id:1201, strategy_id:5,
        period_type:'daily', status:'approved', current_version_id:39, approved_version_id:39,
        canonical_version_id:39, canonical_version_case_id:1201,
        evidence_json:JSON.stringify({ sources:[{ outcome_id:101 }] }) }], []]
      if (text.includes('SELECT * FROM strategy_memory_libraries')) return [[library()], []]
      if (text.includes('FROM strategy_memory_conflicts')) return [[{
        id:77, strategy_id:5, evidence_count:7, alert_threshold:3, status:'observing',
      }], []]
      if (text.includes('FROM strategy_memory_conflict_bindings')) return [[{ id:66 }], []]
      if (text.includes('INSERT INTO strategy_memory_conflict_bindings')) return [{ affectedRows:1 }, []]
      if (text.includes('SELECT * FROM strategy_memory_conflict_occurrences')) return [[], []]
      if (text.includes('INSERT INTO strategy_memory_conflict_occurrences')) return [{ insertId:88, affectedRows:1 }, []]
      if (text.includes('COUNT(DISTINCT period_review_case_id)')) return [[{ evidence_count:3 }], []]
      if (text.includes('UPDATE strategy_memory_conflicts')) return [{ affectedRows:1 }, []]
      throw new Error(`unexpected_sql:${sql}`)
    })
    mockWithTransaction.mockImplementationOnce(fn => fn(run))
    const result = await recordStrategyMemoryConflictEvidence({
      strategyId:5, actor:{ serverOwned:true, userId:7 }, serverOwned:true,
      strategyScope:'private', strategyOwnerUserId:7,
      validatedReviewCase:{ id:1201, strategy_id:5, approved_version_id:39, status:'approved' },
      approved:true, period_review_version_id:39, period_review_case_id:1201,
      conflict_target:'existing_memory', category:'general', description:'结构矛盾',
      strategy_excerpt:'策略正文', memory_excerpt:'旧记忆', source_refs:['outcome:101'],
    })
    expect(result).toMatchObject({
      recorded:true, duplicate:false,
      conflict:{ evidence_count:3, status:'attention_required' },
    })
    const update = run.mock.calls.find(([sql]) => String(sql).includes('UPDATE strategy_memory_conflicts'))
    expect(update?.[1]?.slice(0, 2)).toEqual([3, 'attention_required'])
  })
})
