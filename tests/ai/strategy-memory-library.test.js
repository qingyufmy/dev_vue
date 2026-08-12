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
  buildStrategyMemoryConflictKey,
  getStrategyMemoryLibraryForRuntime,
  normalizeStrategyMemoryConflictThreshold,
  sanitizeStrategyMemoryText,
  saveStrategyMemoryLibrary,
  enqueueApprovedStrategyMemoryUpdate,
  applyStrategyMemoryCompressionJob,
  failStrategyMemoryCompressionJob,
  strategyMemoryCharCount,
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
})

describe('unified strategy memory access and CAS', () => {
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
    const result = await applyStrategyMemoryCompressionJob({ jobId:10, leaseToken:'lease-10', content_text:'压缩后的旧库' })
    expect(result).toMatchObject({ status:'succeeded', revision_id:33 })
    const revisionCall = run.mock.calls.find(([sql]) => String(sql).includes('INSERT INTO strategy_memory_library_revisions'))
    expect(String(revisionCall?.[1]?.[5] || '')).toContain('月复盘确认经验')
    expect(String(revisionCall?.[1]?.[5] || '')).toContain('等待收盘确认')
    const jobCall = run.mock.calls.find(([sql]) => String(sql).includes('SET status = ?, result_revision_id'))
    expect(jobCall?.[1]).toContain('accepted')
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
    const libraryUpdate = run.mock.calls.find(([sql]) => String(sql).includes('UPDATE strategy_memory_libraries'))
    expect(libraryUpdate?.[1]).toContain('queued')
  })
})
