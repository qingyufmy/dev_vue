import { describe, expect, it } from 'vitest'
import { bundleApiContract, serializeApiContract } from '../scripts/lib/api-contract-bundle.mjs'

const base = { openapi: '3.1.0', info: { title: 'Test', version: '1' } }
const source = (name, document) => ({ name, document })

describe('domain API contract aggregation', () => {
  it('produces identical bytes regardless of domain or object key order', () => {
    const a = source('a', { paths: { '/a': { get: { responses: {}, operationId: 'a' } } } })
    const b = source('b', { components: { schemas: { B: { required: ['b', 'a'], type: 'object' } } } })
    const forward = serializeApiContract(bundleApiContract(base, [a, b]))
    expect(serializeApiContract(bundleApiContract(base, [b, a]))).toBe(forward)
    expect(JSON.parse(forward).components.schemas.B.required).toEqual(['b', 'a'])
    expect(serializeApiContract({ b: 2, a: 1 })).toBe(serializeApiContract({ a: 1, b: 2 }))
  })

  it('rejects duplicate paths even when methods differ and components even when identical', () => {
    expect(() => bundleApiContract(base, [source('a', { paths: { '/a': { get: {} } } }), source('b', { paths: { '/a': { post: {} } } })])).toThrow('duplicate_contract:paths//a:a:b')
    const component = { components: { schemas: { Id: { type: 'string' } } } }
    expect(() => bundleApiContract(base, [source('a', component), source('b', component)])).toThrow('duplicate_contract:components/schemas/Id:a:b')
  })

  it('resolves cross-domain references and rejects missing or remote contracts', () => {
    const a = source('a', { components: { schemas: { 'Escaped/name': { type: 'string' }, Alias: { $ref: '#/components/schemas/Escaped~1name' } } } })
    const b = source('b', { components: { schemas: { Consumer: { $ref: '#/components/schemas/Alias' } } } })
    expect(() => bundleApiContract(base, [a, b])).not.toThrow()
    expect(() => bundleApiContract(base, [b])).toThrow('missing_contract_ref')
    expect(() => bundleApiContract(base, [source('a', { components: { schemas: { Remote: { $ref: 'https://example.test/schema' } } } })])).toThrow('unsupported_contract_ref')
  })

  it('preserves instance literals and constrains domain ownership', () => {
    const instance = { components: { schemas: { Literal: { const: { $ref: 'literal data' } } } } }
    expect(bundleApiContract(base, [source('common', instance)]).components.schemas.Literal.const).toEqual({ $ref: 'literal data' })
    expect(() => bundleApiContract(base, [source('common', { paths: { '/business': {} } })])).toThrow('common_cannot_own_routes')
    expect(() => bundleApiContract({ ...base, paths: {} }, [])).toThrow('base_cannot_own_business_contracts')
    expect(() => bundleApiContract(base, [source('a', {}), source('a', {})])).toThrow('duplicate_domain')
    expect(() => bundleApiContract(base, [source('a', { servers: [] })])).toThrow('unsupported_domain_field')
  })
})
