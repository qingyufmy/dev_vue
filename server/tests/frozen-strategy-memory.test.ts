import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { freezeStrategyMemory } from '../src/modules/inference/application/freeze-strategy-memory.js'
import { AnalysisContextBuilder } from '../src/modules/inference/application/analysis-context-builder.js'
import { contentHash, type AnalysisRun } from '../src/modules/inference/domain/inference.js'
import type { StrategyVersion } from '../src/modules/strategies/index.js'
import type { RuntimeStrategyMemory } from '../src/modules/reviews/index.js'

const scope = { userId: 7, strategyId: '1', strategyKind: 'analysis' as const }
const memory = (): Exclude<RuntimeStrategyMemory, { state: 'absent' }> => ({ state: 'ready', strategyId: '1', libraryId: 'library-1',
  libraryRevision: '2', mode: 'active', status: 'active', revisionId: 'revision-1', versionNumber: 1,
  contentText: 'confirmed', contentHash: createHash('sha256').update('confirmed').digest('hex'), maxContextTokens: 800 })
const now = '2026-09-09T00:00:00.000Z'
const run: AnalysisRun = { id: 'run-1', userId: 7, strategyId: '1', strategyVersionId: '11', symbol: 'XAUUSD',
  marketSourceAccountId: null, trigger: 'manual', scheduleSlot: null, status: 'queued', inputSnapshotId: null,
  modelTaskId: null, marketAnalysisId: null, createdAt: now, updatedAt: now, revision: 1 }
const strategy: StrategyVersion = { id: '11', strategyId: '1', kind: 'analysis', version: 1, promptText: 'fixture',
  promptHash: 'a'.repeat(64), config: {}, inputContractVersion: 'fixture/v1', outputContractVersion: 'fixture/v1' }

describe('frozen strategy memory input', () => {
  it('keeps unavailable wiring distinct from an authorized absent library', async () => {
    expect(await freezeStrategyMemory(scope)).toBeUndefined()
    expect(await freezeStrategyMemory(scope, { async read() { return { state: 'absent', strategyId: '1' } } }))
      .toEqual({ schemaVersion: 1, state: 'absent', strategyId: '1' })
  })
  it('copies current provenance and discards extra or disabled content', async () => {
    const current = { ...memory(), pendingProposal: 'not for inference' }
    const frozen = await freezeStrategyMemory(scope, { async read() { return current } })
    current.contentText = 'later change'
    expect(frozen?.contentText).toBe('confirmed')
    expect(frozen).not.toHaveProperty('pendingProposal')
    expect(await freezeStrategyMemory(scope, { async read() { return { ...memory(), state: 'disabled', mode: 'shadow' } } }))
      .toMatchObject({ contentText: null, mode: 'shadow' })
  })
  it('rejects another strategy, tampered active content and read failures instead of silently continuing', async () => {
    await expect(freezeStrategyMemory(scope, { async read() { return { ...memory(), strategyId: '2' } } }))
      .rejects.toMatchObject({ code: 'strategy_memory_scope_conflict' })
    await expect(freezeStrategyMemory(scope, { async read() { return { ...memory(), contentText: 'tampered' } } }))
      .rejects.toMatchObject({ code: 'strategy_memory_evidence_invalid' })
    await expect(freezeStrategyMemory(scope, { async read() { throw Error('storage unavailable') } })).rejects.toThrow('storage unavailable')
  })
  it('includes the exact frozen content and provenance in the actual analysis input hash', async () => {
    let calls = 0
    const current = memory()
    const builder = new AnalysisContextBuilder({ async read() { return { symbol: 'XAUUSD' } } }, { async latest() { return null } }, {
      async read(input) { expect(input).toEqual(scope); calls++; return current },
    })
    const snapshot = await builder.build(run, strategy, new Date(now)), digest = contentHash(snapshot)
    current.libraryRevision = '3'; current.contentText = 'changed after capture'
    expect(snapshot.strategyMemory).toMatchObject({ libraryRevision: '2', contentText: 'confirmed', revisionId: 'revision-1' })
    expect(contentHash(snapshot)).toBe(digest)
    expect(contentHash({ ...snapshot, strategyMemory: { ...snapshot.strategyMemory, libraryRevision: '3' } })).not.toBe(digest)
    expect(calls).toBe(1)
  })
  it('records the named estimate and rejects over-budget content before producing an input', async () => {
    expect(await freezeStrategyMemory(scope, { async read() { return memory() } })).toMatchObject({
      budget: { method: 'utf8_bytes_div4_v1', contentBytes: 9, estimatedTokens: 3, maxTokens: 800 },
    })
    await expect(freezeStrategyMemory(scope, { async read() { return { ...memory(), maxContextTokens: 1 } } }))
      .rejects.toMatchObject({ code: 'strategy_memory_budget_exceeded' })
  })
})
