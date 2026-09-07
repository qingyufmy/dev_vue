import { readFile } from 'node:fs/promises'
import Ajv from 'ajv'
import { expect, it } from 'vitest'
const doc = JSON.parse(await readFile(new URL('../contracts/openapi-v4.json', import.meta.url), 'utf8'))
const ajv = new Ajv({ strict: false, formats: { 'date-time': true, uri: true } })
const schema = { ...doc.components.schemas.LearningDetailResponse, components: { schemas: { LearningCourse: doc.components.schemas.LearningCourse } } }
const validate = ajv.compile(schema)
const course = { id: '12', title: '课程', description: null, category: null, access_level: 'logged_in', updated_at: '2026-09-07T00:00:00Z', sort_order: 0 }
it('accepts locked metadata but forbids protected lessons and internal columns', () => {
  const response = { data: { course, access: 'login_required', lessons: [], lessons_truncated: false }, meta: { request_id: 'r', generated_at: '2026-09-07T00:00:00Z' } }
  expect(validate(response)).toBe(true)
  expect(validate({ ...response, data: { ...response.data, course: { ...course, source_sha256: 'private' } } })).toBe(false)
  const lesson = { id: '1', title: '内容', duration_ms: '9007199254740993', progress: null, resources: [] }
  expect(validate({ ...response, data: { ...response.data, lessons: [lesson] } })).toBe(false)
  expect(validate({ ...response, data: { ...response.data, access: 'allowed', lessons: [lesson] } })).toBe(true)
})
