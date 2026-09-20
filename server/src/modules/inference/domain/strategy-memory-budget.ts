import { InferenceError } from './inference.js'

// Preserve the named legacy estimate; this is not a tokenizer or provider usage.
export function strategyMemoryBudget(contentText: string, maxTokens: number) {
  if (!Number.isSafeInteger(maxTokens) || maxTokens < 1 || typeof contentText !== 'string') {
    throw new InferenceError('strategy_memory_budget_invalid', 409)
  }
  const contentBytes = Buffer.byteLength(contentText, 'utf8')
  const estimatedTokens = Math.ceil(contentBytes / 4)
  if (estimatedTokens > maxTokens) throw new InferenceError('strategy_memory_budget_exceeded', 409)
  return { method: 'utf8_bytes_div4_v1', contentBytes, estimatedTokens, maxTokens }
}
