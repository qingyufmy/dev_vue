import { expect, it } from 'vitest'
import { createReviewWriteCommand, reviewWriteJson } from '../src/modules/reviews/application/review-write-command.js'

const input = { actorUserId: 7, action: 'return_case' as const, targetId: 'case-1', expectedRevision: 1, idempotencyKey: 'review-command-0001' }
it('hashes original command data without depending on object order or mutable bodies', () => {
  const body = { reason: ' original ', nested: { b: 2, a: 1 } }
  const command = createReviewWriteCommand(input, body)
  expect(command.requestHash).toBe(createReviewWriteCommand(input, { nested: { a: 1, b: 2 }, reason: ' original ' }).requestHash)
  body.reason = 'changed'
  expect(command.requestHash).not.toBe(createReviewWriteCommand(input, body).requestHash)
  expect(Object.isFrozen(command)).toBe(true)
  for (const altered of [{}, { reason: null }, { reason: 'original' }, { reason: ['a', 'b'] }, { reason: ['b', 'a'] }]) {
    expect(createReviewWriteCommand(input, altered).requestHash).not.toBe(command.requestHash)
  }
  expect(createReviewWriteCommand(input, {}).requestHash).not.toBe(createReviewWriteCommand(input, { reason: null }).requestHash)
  expect(createReviewWriteCommand({ ...input, expectedRevision: 2 }, body).requestHash).not.toBe(createReviewWriteCommand(input, body).requestHash)
  expect(createReviewWriteCommand({ ...input, targetId: 'case-2' }, body).requestHash).not.toBe(createReviewWriteCommand(input, body).requestHash)
  expect(JSON.stringify(command)).not.toContain('original')
})
it.each([undefined, NaN, Infinity, 1n, new Date(), { x: undefined }, [undefined], Array(2), new Map()])('rejects non-JSON command data %#', value => {
  expect(() => reviewWriteJson(value)).toThrow('review_command_invalid')
})
it('rejects cycles while permitting repeated noncyclic objects', () => {
  const value: Record<string, unknown> = {}; value.self = value
  expect(() => reviewWriteJson(value)).toThrow('review_command_invalid')
  const common = { x: 1 }
  expect(reviewWriteJson([common, common])).toBe('[{"x":1},{"x":1}]')
})
it('requires a creation without target/CAS and an update with both', () => {
  expect(() => createReviewWriteCommand({ ...input, targetId: null }, {})).toThrow('review_command_invalid')
  expect(() => createReviewWriteCommand({ ...input, action: 'create_manual_case' }, {})).toThrow('review_command_invalid')
  expect(createReviewWriteCommand({ ...input, action: 'create_manual_case', targetId: null, expectedRevision: null }, {}).requestHash).toHaveLength(64)
})

it('rejects arrays that hide a hole using an extra named property', () => {
  const value = Array(1) as unknown[] & { extra?: number }
  value.extra = 1
  expect(() => reviewWriteJson(value)).toThrow('review_command_invalid')
})
