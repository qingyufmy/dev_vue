import { expect, it } from 'vitest'
import { canonicalJson, sha256Canonical, CanonicalJsonError } from '../src/shared/canonical-json.js'
import { canonicalJson as executionJson, sha256Canonical as executionHash } from '../src/modules/execution/domain/execution.js'

// Frozen outputs captured from execution's pre-extraction implementation at 84d5b987.
it.each([
  [{ b: 2, a: 1 }, '{"a":1,"b":2}', '43258cff783fe7036d8a43033f830adfc60ec037382473548ac742b888292777'],
  [{ ticket: '1001', volume: '0.10', stop_loss: null, nested: { z: false, a: ['中文', -0, 1e-7] } },
    '{"nested":{"a":["中文",0,1e-7],"z":false},"stop_loss":null,"ticket":"1001","volume":"0.10"}',
    'f7748644d2eaa1255fb5b619d5330ffa66ac40ac0ffe876439f416c69aa251c6'],
])('preserves persisted V4 JSON and hashes for %j', (input, encoded, hash) => {
  expect(canonicalJson(input)).toBe(encoded)
  expect(sha256Canonical(input)).toBe(hash)
  expect(executionJson(input)).toBe(encoded)
  expect(executionHash(input)).toBe(hash)
})

it.each([undefined, NaN, Infinity, 1n, { nested: undefined }, [false, NaN]].map(input => [input]))('preserves execution rejection for unsupported input case %#', input => {
  expect(() => canonicalJson(input)).toThrow(CanonicalJsonError)
  expect(() => executionJson(input)).toThrow(expect.objectContaining({ code: 'execution_action_invalid', status: 422 }))
  expect(() => executionHash(input)).toThrow(expect.objectContaining({ code: 'execution_action_invalid', status: 422 }))
})
