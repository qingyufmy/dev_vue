import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { createMysqlRuntimeStrategyMemoryReader } from '../src/modules/reviews/infrastructure/mysql-runtime-strategy-memory-reader.js'

const scope = { userId: 7, strategyId: '1', strategyKind: 'analysis' as const }
function fixture() {
  const content = '已人工确认的中文经验'
  return { strategy_id: '1', library_id: 'library-1', library_revision: '3', mode: 'active', status: 'active',
    current_revision_id: 'revision-2', revision_id: 'revision-2', version_number: 2,
    content_sha256: createHash('sha256').update(content).digest('hex'), content_text: content,
    content_bytes: Buffer.byteLength(content), max_context_tokens: 800, ownership_valid: 1 }
}
const reader = (rows: unknown[]) => createMysqlRuntimeStrategyMemoryReader({ async execute() { return [rows] } } as never)

describe('runtime strategy memory public reader', () => {
  it('returns the scoped current revision with exact UTF-8 hash and version', async () => {
    const row = fixture(), result = await reader([row]).read(scope)
    expect(result).toMatchObject({ state: 'ready', contentText: row.content_text, contentHash: row.content_sha256, revisionId: 'revision-2', libraryRevision: '3' })
  })
  it('distinguishes an authorized absent library from inaccessible or ambiguous strategies', async () => {
    expect(await reader([{ ...fixture(), library_id: null }]).read(scope)).toEqual({ state: 'absent', strategyId: '1' })
    for (const rows of [[], [fixture(), fixture()], [{ ...fixture(), strategy_id: '2' }]]) {
      await expect(reader(rows).read(scope)).rejects.toMatchObject({ code: 'strategy_memory_unavailable' })
    }
  })
  it('never exposes inactive or shadow content even if a connector returns it', async () => {
    for (const overrides of [{ mode: 'off' }, { mode: 'shadow' }, { status: 'revalidating' }, { status: 'retired' }]) {
      expect(await reader([{ ...fixture(), ...overrides }]).read(scope)).toMatchObject({ state: 'disabled', contentText: null })
    }
  })
  it('rejects broken ownership, revision, mode, hash, byte count and oversized content', async () => {
    for (const overrides of [{ ownership_valid: 0 }, { revision_id: 'other-library-revision' }, { current_revision_id: null },
      { mode: 'enabled' }, { status: 'unknown' }, { library_revision: '0' }, { max_context_tokens: 0 },
      { version_number: 0 }, { content_sha256: 'a'.repeat(64) }, { content_bytes: 1 },
      { content_bytes: 65_537, content_text: null }]) {
      await expect(reader([{ ...fixture(), ...overrides }]).read(scope)).rejects.toMatchObject({ code: 'strategy_memory_evidence_invalid' })
    }
  })
  it('freezes the caller scope and restricts SQL to owned current library content', async () => {
    const input = { ...scope }
    const actual = createMysqlRuntimeStrategyMemoryReader({ async execute(sql: string, args: unknown[]) {
      expect(args).toEqual([7, 65_536, '1', 'analysis', 7])
      expect(sql).toContain('r.library_id=l.id')
      expect(sql).toContain("s.scope='user' AND s.owner_user_id=?")
      expect(sql).toContain("l.mode='active' AND l.status='active'")
      expect(sql).not.toContain('pending_updates')
      input.strategyId = '2'
      return [[fixture()]]
    } } as never)
    expect((await actual.read(input)).strategyId).toBe('1')
  })
  it('rejects invalid scopes before storage access', async () => {
    const actual = createMysqlRuntimeStrategyMemoryReader({ async execute() { throw Error('unexpected SQL') } } as never)
    await expect(actual.read({ ...scope, userId: 0 })).rejects.toMatchObject({ code: 'strategy_memory_scope_invalid' })
    await expect(actual.read({ ...scope, strategyId: '18446744073709551616' })).rejects.toMatchObject({ code: 'strategy_memory_scope_invalid' })
  })
})
