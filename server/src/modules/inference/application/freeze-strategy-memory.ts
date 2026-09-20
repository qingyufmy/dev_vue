import { createHash } from 'node:crypto'
import type { RuntimeStrategyMemoryReader, RuntimeStrategyMemoryScope } from '../../reviews/index.js'
import { InferenceError, type JsonObject } from '../domain/inference.js'
import { strategyMemoryBudget } from '../domain/strategy-memory-budget.js'

// Scope and body are captured once. The caller's persisted input snapshot owns
// the provenance; retries must consume that snapshot rather than reread a library.
export async function freezeStrategyMemory(scope: RuntimeStrategyMemoryScope, reader?: RuntimeStrategyMemoryReader): Promise<JsonObject | undefined> {
  if (!reader) return undefined
  const binding = { ...scope }
  const memory = structuredClone(await reader.read({ ...binding }))
  if (memory.strategyId !== binding.strategyId) throw new InferenceError('strategy_memory_scope_conflict', 409)
  if (memory.state === 'absent') return { schemaVersion: 1, state: 'absent', strategyId: binding.strategyId }
  const ready = memory.state === 'ready'
  if (ready && (memory.mode !== 'active' || memory.status !== 'active' || memory.revisionId === null
    || typeof memory.contentText !== 'string' || createHash('sha256').update(memory.contentText, 'utf8').digest('hex') !== memory.contentHash)) {
    throw new InferenceError('strategy_memory_evidence_invalid', 409)
  }
  return { schemaVersion: 1, state: memory.state, strategyId: memory.strategyId,
    libraryId: memory.libraryId, libraryRevision: memory.libraryRevision, mode: memory.mode, status: memory.status,
    revisionId: memory.revisionId, versionNumber: memory.versionNumber, contentHash: memory.contentHash,
    contentText: ready ? memory.contentText : null, maxContextTokens: memory.maxContextTokens,
    budget: ready ? strategyMemoryBudget(memory.contentText!, memory.maxContextTokens) : null }
}
