import { readFile } from 'node:fs/promises'
import Ajv from 'ajv'
import { expect, it } from 'vitest'
import { normalizeLearningCompletion } from '../server/src/modules/learning/domain/learning-completion.js'
const doc = JSON.parse(await readFile(new URL('../contracts/openapi-v4.json', import.meta.url)))
const ajv = new Ajv({ strict: false, formats: { 'date-time': true } })
const request = ajv.compile(doc.components.schemas.LearningCompletionRequest)
const response = ajv.compile({ ...doc.components.schemas.LearningCompletionResponse, components: { schemas: doc.components.schemas } })
it('agrees with the producer on exact revision boundaries and rejects foreign identity fields', () => {
  for (const value of ['0','1','9007199254740993','18446744073709551614','18446744073709551615','18446744073709551616','20000000000000000000','01','-1','1\n']) {
    let accepted = true
    try { normalizeLearningCompletion({ userId: 7, courseId: '12', lessonId: '99', requestId: 'a56a2134-9105-4e93-a806-bb3793f7ad38', completed: true, expectedRevision: value }) } catch { accepted = false }
    expect(request({ completed: true, expected_revision: value }), value).toBe(accepted)
  }
  expect(request({ completed: true, expected_revision: '1', user_id: '8' })).toBe(false)
  expect(request({ completed: 'true', expected_revision: '1' })).toBe(false)
})
it('accepts exact completion receipts and rejects numeric revisions and client wall clocks', () => {
  const value = { data: { lesson_id: '99', completed: true, revision: '9007199254740994', updated_at: '2026-09-08T00:00:00.123Z', replayed: false },
    meta: { request_id: 'r', generated_at: '2026-09-08T00:00:00.123Z' } }
  expect(response(value)).toBe(true)
  expect(response({ ...value, data: { ...value.data, revision: 123 } })).toBe(false)
  expect(response({ ...value, data: { ...value.data, updated_at: '2026-09-08 08:00:00' } })).toBe(false)
})
