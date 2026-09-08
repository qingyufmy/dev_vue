import { describe, expect, it } from 'vitest'
import { apiSchemas, compileApiSchemas } from '../scripts/lib/api-schema-compiler.mjs'

const document = schemas => ({ openapi: '3.1.0', components: { schemas } })
const validator = schema => compileApiSchemas(document({ Value: schema })).validators.get('#/components/schemas/Value')

describe('OpenAPI schema compilation', () => {
  it('resolves local references and preserves instance data on rejection', () => {
    const { validators, report } = compileApiSchemas(document({
      Id: { type: 'string', pattern: '^[0-9]+$' },
      Value: { type: 'object', required: ['id'], additionalProperties: false, properties: { id: { $ref: '#/components/schemas/Id' }, enabled: { type: 'boolean', default: true } } },
    }))
    expect(report.failures).toEqual([])
    const validate = validators.get('#/components/schemas/Value')
    const input = { id: '7' }
    expect(validate(input)).toBe(true)
    expect(input).toEqual({ id: '7' })
    const invalid = { id: 7, extra: true }
    expect(validate(invalid)).toBe(false)
    expect(invalid).toEqual({ id: 7, extra: true })
  })

  it('enforces null unions, nullable enums and exactly one matching branch', () => {
    const nullable = validator({ type: ['string', 'null'] })
    expect(nullable(null)).toBe(true)
    expect(nullable(1)).toBe(false)
    const legacyNullableEnum = validator({ type: 'string', nullable: true, enum: ['active'] })
    expect(legacyNullableEnum(null)).toBe(false)
    const union = validator({ oneOf: [{ type: 'number' }, { type: 'integer' }] })
    expect(union(1.5)).toBe(true)
    expect(union(1)).toBe(false)
  })

  it('checks unevaluated properties across allOf and date formats', () => {
    const validate = validator({ type: 'object', allOf: [{ properties: { at: { type: 'string', format: 'date-time', pattern: 'Z$' } }, required: ['at'] }], unevaluatedProperties: false })
    expect(validate({ at: '2026-09-08T01:00:00.000Z' })).toBe(true)
    expect(validate({ at: '2026-02-30T01:00:00Z' })).toBe(false)
    expect(validate({ at: '2026-09-08T01:00:00Z', unknown: 1 })).toBe(false)
  })

  it('reports broken references, schema typos and invalid constraints', () => {
    const { report } = compileApiSchemas(document({
      Broken: { $ref: '#/components/schemas/Absent' },
      Typo: { type: 'string', minLenght: 4 },
      Invalid: { type: 'string', minLength: -1 },
    }))
    expect(report.compiledCount).toBe(0)
    expect(report.failures.map(item => item.location)).toEqual(['#/components/schemas/Broken', '#/components/schemas/Typo', '#/components/schemas/Invalid'])
  })

  it('includes inline inputs, responses and headers but never instance examples', () => {
    const doc = { ...document({ Value: { type: 'object', properties: { schema: { type: 'string' } } } }), paths: {
      '/test': { parameters: [{ schema: { type: 'string' } }], post: {
        requestBody: { content: { 'application/json': { schema: { type: 'boolean' }, example: { schema: { type: 'not-a-type' } } } } },
        responses: { 200: { headers: { ETag: { schema: { type: 'string' } } }, content: { 'application/json': { schema: false } } } },
      } },
    } }
    expect(apiSchemas(doc).size).toBe(5)
    const { validators, report } = compileApiSchemas(doc)
    expect(report.failures).toEqual([])
    expect(validators.get('#/paths/~1test/post/responses/200/content/application~1json/schema')({})).toBe(false)
  })

  it('rejects unsupported dialects and callbacks rather than silently skipping', () => {
    expect(() => apiSchemas({ openapi: '3.0.3' })).toThrow('unsupported_openapi_dialect')
    expect(() => apiSchemas({ ...document({}), paths: { '/test': { post: { callbacks: {} } } } })).toThrow('unsupported_callbacks')
  })

  it('follows structural references and fails on missing or remote response references', () => {
    const doc = { ...document({}), components: { responses: { Result: { content: { 'application/json': { schema: { type: 'integer' } } } } } }, paths: { '/test': { get: { responses: { 200: { $ref: '#/components/responses/Result' } } } } } }
    const { validators } = compileApiSchemas(doc)
    const validate = validators.get('#/paths/~1test/get/responses/200/content/application~1json/schema')
    expect(validate(7)).toBe(true)
    expect(validate('7')).toBe(false)
    doc.paths['/test'].get.responses[200].$ref = '#/components/responses/Absent'
    expect(() => apiSchemas(doc)).toThrow('missing_ref')
    doc.paths['/test'].get.responses[200].$ref = 'https://example.test/response.json'
    expect(() => apiSchemas(doc)).toThrow('unsupported_or_cyclic_ref')
  })
})
