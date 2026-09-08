import { describe, expect, it } from 'vitest'
import { compareApiRoutes, documentedOperations } from '../scripts/lib/api-route-coverage.mjs'

const contract = paths => ({ servers: [{ url: '/api/v4' }], paths })
describe('API route coverage', () => {
  it('compares methods and normalized parameter paths in both directions', () => {
    const result = compareApiRoutes(contract({ '/accounts/{id}': { get: { operationId: 'account' }, delete: { operationId: 'remove' } } }), [
      { method: 'GET', path: '/api/v4/accounts/:id' }, { method: 'POST', path: '/api/v4/accounts/:id' },
    ])
    expect(result.matchedCount).toBe(1)
    expect(result.missing.map(item => item.method)).toEqual(['DELETE'])
    expect(result.undocumented.map(item => item.method)).toEqual(['POST'])
  })
  it('reports different parameter names without treating the whole route as missing', () => {
    const result = compareApiRoutes(contract({ '/accounts/{account_id}': { get: { operationId: 'account' } } }), [{ method: 'GET', path: '/api/v4/accounts/:accountId' }])
    expect(result.missing).toEqual([])
    expect(result.parameterNameDifferences).toHaveLength(1)
  })
  it('reports duplicate and missing operation IDs and keeps nonbusiness endpoints visible', () => {
    const result = compareApiRoutes(contract({ '/a': { get: { operationId: 'same' } }, '/b': { get: { operationId: 'same' } }, '/c': { get: {} } }), [{ method: 'GET', path: '/oauth/authorize' }])
    expect(result.duplicateOperationIds).toEqual(['same'])
    expect(result.missingOperationIds).toHaveLength(1)
    expect(result.outsideBusinessPrefix).toHaveLength(1)
  })
  it('honors server overrides and resolves path-item references', () => {
    const document = { ...contract({ '/a': { $ref: '#/components/pathItems/A' } }), components: { pathItems: { A: { get: { operationId: 'a', servers: [{ url: 'https://auth.example.test' }] } } } } }
    expect(documentedOperations(document)[0].path).toBe('/a')
    expect(compareApiRoutes(document, [{ method: 'GET', path: '/a' }]).matchedCount).toBe(1)
    expect(() => documentedOperations(contract({ '/a': { $ref: '#/paths/~1a' } }))).toThrow('cyclic_ref')
  })
  it('does not merge trailing slashes, different static paths or duplicate normalized routes', () => {
    const result = compareApiRoutes(contract({ '/a/': { get: { operationId: 'a' } }, '/b/{id}': { get: { operationId: 'b' } }, '/b/{other}': { get: { operationId: 'c' } } }), [{ method: 'GET', path: '/api/v4/a' }])
    expect(result.matchedCount).toBe(0)
    expect(result.duplicateContractRoutes).toEqual(['GET /api/v4/b/{}'])
  })
})
