import { describe, expect, it } from 'vitest'
import { createHttpContractValidator } from '../src/transport/http-contract.js'
import { httpRuntimeContracts } from '../src/transport/generated/http-contracts.js'

describe('generated HTTP contract runtime', () => {
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
