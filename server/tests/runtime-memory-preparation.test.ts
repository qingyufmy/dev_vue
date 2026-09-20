import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { memoryPreparationForSnapshot } from '../src/modules/inference/application/memory-preparation-for-snapshot.js'
import { contentHash, type AnalysisInputSnapshot } from '../src/modules/inference/domain/inference.js'
import { inferenceSqlTime } from '../src/modules/inference/infrastructure/inference-sql-time.js'

const snapshot = (): AnalysisInputSnapshot => ({ kind: 'analysis', strategy: { id: '1', versionId: '11', promptHash: 'a'.repeat(64), promptText: 'fixture' },
  market: {}, macro: null, capturedAt: '2026-09-09T00:00:00.123Z', strategyMemory: {
    schemaVersion: 1, strategyId: '1', state: 'ready', mode: 'active', status: 'active', libraryId: 'library-1', libraryRevision: '2',
    revisionId: 'revision-1', versionNumber: 1, contentText: 'confirmed', contentHash: createHash('sha256').update('confirmed').digest('hex'),
    maxContextTokens: 800, budget: { method: 'utf8_bytes_div4_v1', contentBytes: 9, estimatedTokens: 3, maxTokens: 800 },
  } })
const input = (value = snapshot()) => ({ userId: 7, runId: 'run-1', snapshotId: 'snapshot-1', snapshotHash: contentHash(value), snapshot: value })

describe('memory preparation snapshot binding', () => {
  it('binds audit identity to the actual input and retains an estimate rather than actual usage', () => {
    expect(memoryPreparationForSnapshot(input())).toMatchObject({ userId: 7, strategyId: '1', runtimeKind: 'analysis', runtimeId: 'run-1',
      inputSnapshotId: 'snapshot-1', libraryRevision: '2', estimatedTokens: 3, contentBytes: 9, occurredAt: '2026-09-09T00:00:00.123Z' })
  })
  it('rejects a digest that does not bind the complete input', () => {
    const value = input(); value.snapshot.market = { changed: true }
    expect(() => memoryPreparationForSnapshot(value)).toThrowError(expect.objectContaining({ code: 'strategy_memory_snapshot_invalid' }))
  })
  it('rejects tampered content, estimates and strategy even with a recomputed outer digest', () => {
    for (const patch of [{ contentText: 'changed' }, { strategyId: '2' }, { budget: { method: 'unknown' } }]) {
      const value = snapshot(); value.strategyMemory = { ...value.strategyMemory, ...patch }
      expect(() => memoryPreparationForSnapshot(input(value))).toThrowError(expect.objectContaining({ code: 'strategy_memory_snapshot_invalid' }))
    }
  })
  it('does not invent preparation records for historical absence or disabled memory', () => {
    const value = snapshot(); delete value.strategyMemory
    expect(memoryPreparationForSnapshot(input(value))).toBeNull()
    value.strategyMemory = { schemaVersion: 1, strategyId: '1', state: 'absent' }
    expect(memoryPreparationForSnapshot(input(value))).toBeNull()
    value.strategyMemory = { schemaVersion: 1, strategyId: '1', state: 'disabled', contentText: null }
    expect(memoryPreparationForSnapshot(input(value))).toBeNull()
    value.strategyMemory.contentText = 'must not be injected'
    expect(() => memoryPreparationForSnapshot(input(value))).toThrow()
  })
})

describe('inference UTC SQL bindings', () => {
  it('preserves UTC clock fields and millisecond precision', () => {
    expect(inferenceSqlTime('2026-09-09T00:00:00.123Z')).toBe('2026-09-09 00:00:00.123')
    expect(inferenceSqlTime('2026-09-09T00:00:00Z')).toBe('2026-09-09 00:00:00.000')
  })
  it('rejects invalid calendar dates, offsets and lossy fractional precision', () => {
    for (const value of ['2026-02-30T00:00:00Z', '2026-09-09T08:00:00+08:00', '2026-09-09T00:00:00.1234Z']) {
      expect(() => inferenceSqlTime(value)).toThrowError(expect.objectContaining({ code: 'inference_time_invalid' }))
    }
  })
})
