import { test } from 'node:test'
import assert from 'node:assert/strict'
import { compareProtocolRoutes } from './api-protocol-routes.mjs'
const exceptions = [{ method: 'GET', path: '/auth/callback', reason: 'OIDC callback' }]
test('accepts only the exact registered protocol method and path', () => {
  assert.equal(compareProtocolRoutes(exceptions, exceptions).passed, true)
  for (const actual of [[], [{ method: 'POST', path: '/auth/callback' }],
    [...exceptions, { method: 'GET', path: '/debug' }], [...exceptions, ...exceptions]]) {
    assert.equal(compareProtocolRoutes(actual, exceptions).passed, false)
  }
})
test('rejects broad, duplicate and undocumented exceptions', () => {
  for (const rows of [[...exceptions, ...exceptions], [{ ...exceptions[0], path: '/auth/*' }],
    [{ ...exceptions[0], path: '/api/v4/orders' }], [{ ...exceptions[0], reason: '' }]]) {
    assert.throws(() => compareProtocolRoutes([], rows), /api_protocol_exceptions_invalid/)
  }
})
