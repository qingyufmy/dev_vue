import { createHash } from 'node:crypto'
import type { RuntimeMemoryPreparation } from '../../reviews/index.js'
import { contentHash, InferenceError, type AnalysisInputSnapshot, type TraderInputSnapshot } from '../domain/inference.js'
import { strategyMemoryBudget } from '../domain/strategy-memory-budget.js'

export function memoryPreparationForSnapshot(input: {
  userId: number; runId: string; snapshotId: string; snapshotHash: string; snapshot: AnalysisInputSnapshot | TraderInputSnapshot
}): RuntimeMemoryPreparation | null {
  const { snapshot } = input, memory = snapshot.strategyMemory
  if (memory === undefined) return null
  const fail = (): never => { throw new InferenceError('strategy_memory_snapshot_invalid', 409) }
  if (!memory || memory.schemaVersion !== 1 || memory.strategyId !== snapshot.strategy.id || contentHash(snapshot) !== input.snapshotHash) return fail()
  if (memory.state === 'absent') {
    if (memory.contentText !== undefined && memory.contentText !== null) return fail()
    return null
  }
  if (memory.state === 'disabled') {
    if (memory.contentText !== null) return fail()
    return null
  }
  if (memory.state !== 'ready' || memory.mode !== 'active' || memory.status !== 'active' || typeof memory.contentText !== 'string'
    || createHash('sha256').update(memory.contentText, 'utf8').digest('hex') !== memory.contentHash || typeof memory.maxContextTokens !== 'number') return fail()
  const budget = strategyMemoryBudget(memory.contentText, memory.maxContextTokens), supplied = memory.budget
  if (!supplied || typeof supplied !== 'object' || Array.isArray(supplied)
    || supplied.method !== budget.method || supplied.contentBytes !== budget.contentBytes || supplied.estimatedTokens !== budget.estimatedTokens
    || supplied.maxTokens !== budget.maxTokens) return fail()
  const text = (field: string) => typeof memory[field] === 'string' ? memory[field] as string : fail()
  if (typeof memory.versionNumber !== 'number') return fail()
  return { userId: input.userId, strategyId: snapshot.strategy.id, runtimeKind: snapshot.kind, runtimeId: input.runId,
    inputSnapshotId: input.snapshotId, inputSnapshotHash: input.snapshotHash, libraryId: text('libraryId'),
    libraryRevision: text('libraryRevision'), revisionId: text('revisionId'), versionNumber: memory.versionNumber,
    contentHash: text('contentHash'), contentBytes: budget.contentBytes, estimatedTokens: budget.estimatedTokens,
    maxContextTokens: budget.maxTokens, estimateMethod: 'utf8_bytes_div4_v1', occurredAt: snapshot.capturedAt }
}
