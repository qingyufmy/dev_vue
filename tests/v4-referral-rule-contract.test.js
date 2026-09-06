import { readFile } from 'node:fs/promises'
import Ajv from 'ajv'
import { describe, expect, it } from 'vitest'
const contract = JSON.parse(await readFile(new URL('../contracts/openapi-v4.json', import.meta.url), 'utf8'))
const operation = contract.paths['/admin/referrals/rules'].put
const ajv = new Ajv({ strict: false, formats: { 'date-time': true } })
describe('referral rule HTTP contract examples', () => {
  it('publishes current-rule reads with all editable values and exact revisions', () => {
    const get = contract.paths['/admin/referrals/rules'].get
    const validate = ajv.compile(get.responses['200'].content['application/json'].schema)
    expect(validate({ data: { rules: [{ rule_id: '2', plan: 'plus', period: 'monthly', rate_bps: 0, enabled: false, revision: '9007199254740993' }] },
      meta: { request_id: 'req-1', generated_at: '2026-09-07T00:00:00.000Z' } })).toBe(true)
    expect(get.responses['200'].headers['Cache-Control'].schema.const).toBe('no-store')
  })
  it('accepts exact integer basis points and string revisions, rejecting coercion and extra fields', () => {
    const validate = ajv.compile(operation.requestBody.content['application/json'].schema)
    const change = { rule_id: '2', expected_revision: '9007199254740993', rate_bps: 0, enabled: false }
    expect(validate({ changes: [change] })).toBe(true)
    for (const body of [{ changes: [] }, { changes: [change], actor_user_id: 1 },
      { changes: [{ ...change, expected_revision: 1 }] }, { changes: [{ ...change, rate_bps: 0.5 }] },
      { changes: [{ ...change, enabled: 'false' }] }]) expect(validate(body)).toBe(false)
  })
  it('publishes the response shape and lowercase UUID idempotency key used by the route', () => {
    const validate = ajv.compile(operation.responses['200'].content['application/json'].schema)
    expect(validate({ data: { rules: [{ rule_id: '2', revision: '9007199254740994' }], replayed: true },
      meta: { request_id: 'req-1', generated_at: '2026-09-07T00:00:00.000Z' } })).toBe(true)
    const header = ajv.compile(operation.parameters.find(item => item.name === 'Idempotency-Key').schema)
    expect(header('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa')).toBe(true)
    expect(header('ordinary-key')).toBe(false)
  })
})
