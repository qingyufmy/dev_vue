import { createHash } from 'node:crypto'
import { ReviewError } from '../domain/review.js'

export const reviewWriteActions = ['create_manual_case', 'request_generation', 'create_version',
  'confirm_version', 'return_case', 'decide_memory_update'] as const
export interface ReviewWriteCommand {
  actorUserId: number
  idempotencyKey: string
  action: typeof reviewWriteActions[number]
  targetId: string | null
  expectedRevision: number | null
  requestHash: string
}
export function reviewWriteHash(value: string): string { return createHash('sha256').update(value).digest('hex') }

export function reviewWriteJson(value: unknown): string {
  const parents = new Set<object>()
  const encode = (item: unknown, depth: number): string => {
    if (depth > 64) throw new ReviewError('review_command_invalid', 422)
    if (item === null || typeof item === 'string' || typeof item === 'boolean') return JSON.stringify(item)
    if (typeof item === 'number' && Number.isFinite(item)) return JSON.stringify(item)
    if (typeof item !== 'object' || item === null || parents.has(item)) throw new ReviewError('review_command_invalid', 422)
    parents.add(item)
    try {
      if (Array.isArray(item)) {
        if (Object.keys(item).length !== item.length || Object.getOwnPropertySymbols(item).length
          || Array.from({ length: item.length }, (_, index) => index).some(index => !Object.hasOwn(item, index))) throw new ReviewError('review_command_invalid', 422)
        return '[' + item.map(child => encode(child, depth + 1)).join(',') + ']'
      }
      if (Object.getPrototypeOf(item) !== Object.prototype && Object.getPrototypeOf(item) !== null) throw new ReviewError('review_command_invalid', 422)
      if (Object.getOwnPropertySymbols(item).length) throw new ReviewError('review_command_invalid', 422)
      return '{' + Object.keys(item).sort().map(key => JSON.stringify(key) + ':' + encode((item as Record<string, unknown>)[key], depth + 1)).join(',') + '}'
    } finally { parents.delete(item) }
  }
  return encode(value, 0)
}

export function createReviewWriteCommand(input: Omit<ReviewWriteCommand, 'requestHash'>, originalBody: unknown): ReviewWriteCommand {
  if (!Number.isSafeInteger(input.actorUserId) || input.actorUserId < 1
    || !/^[A-Za-z0-9._:-]{16,128}$/.test(input.idempotencyKey)
    || !reviewWriteActions.includes(input.action)
    || (input.targetId !== null && !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,190}$/.test(input.targetId))
    || (input.expectedRevision !== null && (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 1))) {
    throw new ReviewError('review_command_invalid', 422)
  }
  const creating = input.action === 'create_manual_case'
  if (creating !== (input.targetId === null) || creating !== (input.expectedRevision === null)) throw new ReviewError('review_command_invalid', 422)
  return Object.freeze({ ...input, requestHash: reviewWriteHash(reviewWriteJson({
    action: input.action, target: input.targetId, expected_revision: input.expectedRevision, body: originalBody,
  })) })
}
