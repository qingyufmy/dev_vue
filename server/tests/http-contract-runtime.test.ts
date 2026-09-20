import { describe, expect, it } from 'vitest'
import { createHttpContractValidator } from '../src/transport/http-contract.js'
import { httpRuntimeContracts } from '../src/transport/generated/http-contracts.js'

describe('generated HTTP contract runtime', () => {
  it('accepts only declared 204 responses with no body', () => {
    const contract = createHttpContractValidator(httpRuntimeContracts, ['logoutAuthCenterSession', 'getApplicationSession'])
    expect(contract.response('logoutAuthCenterSession', undefined, 204)).toBeUndefined()
    for (const body of [null, '', {}, { data: null }]) {
      expect(() => contract.response('logoutAuthCenterSession', body, 204)).toThrow('api_response_invalid')
    }
    expect(() => contract.response('getApplicationSession', undefined, 204)).toThrow('api_response_invalid')
    expect(() => contract.response('logoutAuthCenterSession', undefined, 200)).toThrow('api_response_invalid')
    expect(() => contract.response('notRegistered', undefined, 204)).toThrow('http_contract_not_registered')
  })

  it('checks write headers and strict JSON bodies without coercion', () => {
    const contract = createHttpContractValidator(httpRuntimeContracts, ['setLearningCompletion'])
    const request = { params: { courseId: '12', lessonId: '99' }, headers: {
      'idempotency-key': 'a56a2134-9105-4e93-a806-bb3793f7ad38', 'x-csrf-token': 'valid-csrf-token-at-least-16',
    }, body: { completed: true, expected_revision: '1' } }
    const before = structuredClone(request)
    contract.request('setLearningCompletion', request)
    expect(request).toEqual(before)
    for (const body of [undefined, null, {}, { completed: 'true', expected_revision: '1' },
      { completed: true, expected_revision: 1 }, { ...request.body, user_id: '9' }]) {
      expect(() => contract.request('setLearningCompletion', { ...request, body })).toThrow('api_request_invalid')
    }
    for (const key of [undefined, 'invalid', ['a56a2134-9105-4e93-a806-bb3793f7ad38']]) {
      expect(() => contract.request('setLearningCompletion', { ...request, headers: { ...request.headers, 'idempotency-key': key } })).toThrow('api_request_invalid')
    }
    expect(() => contract.request('listAuditEvents', {})).toThrow('http_contract_not_registered')
  })

  it('selects the declared status and media type and rejects invalid problem responses', () => {
    const contract = createHttpContractValidator(httpRuntimeContracts)
    const problem = { type: 'urn:aurum:problem:api_request_invalid', title: 'Invalid request', status: 400,
      code: 'api_request_invalid', detail: 'api_request_invalid', instance: '/api/v4/audit/events', correlation_id: 'request-1', retryable: false }
    expect(contract.response('listAuditEvents', problem, 400, 'application/problem+json')).toBe(problem)
    expect(() => contract.response('listAuditEvents', problem, 400, 'application/json')).toThrow('api_response_invalid')
    expect(() => contract.response('listAuditEvents', problem, 418, 'application/problem+json')).toThrow('api_response_invalid')
    expect(() => contract.response('listAuditEvents', problem, 503, 'application/problem+json')).toThrow('api_response_invalid')
    expect(() => contract.response('listAuditEvents', { ...problem, raw_sql: 'secret' }, 400, 'application/problem+json')).toThrow('api_response_invalid')
    expect(() => contract.response('listAuditEvents', { ...problem, code: 'invalid machine code' }, 400, 'application/problem+json')).toThrow('api_response_invalid')
  })

  it('checks integer query wire values without mutating the Fastify request', () => {
    const contract = createHttpContractValidator(httpRuntimeContracts)
    const request = { query: { page_size: '2' } }
    contract.request('listAuditEvents', request)
    expect(request.query.page_size).toBe('2')
    for (const page_size of ['2e0', '0x2', ' 2 ', '02', '-1', '9007199254740993', null, ['2', '3']]) {
      expect(() => contract.request('listAuditEvents', { query: { page_size } })).toThrow('api_request_invalid')
    }
  })

  it('requires path values, rejects unknown operations and never repairs response objects', () => {
    const contract = createHttpContractValidator(httpRuntimeContracts)
    expect(() => contract.request('getAuditEvent', { params: { source_kind: 'operation' } })).toThrow('api_request_invalid')
    expect(() => contract.request('notRegistered', {})).toThrow('http_contract_not_registered')
    const body = { data: { internal_secret: true } }
    expect(() => contract.response('getAuditEvent', body)).toThrow('api_response_invalid')
    expect(body).toEqual({ data: { internal_secret: true } })
  })
})
