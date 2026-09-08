import { expect, it } from 'vitest'
import { gzipSync } from 'node:zlib'
import { inspectAccountJson, accountRootSourceReferences } from '../scripts/lib/account-reference-review.mjs'
const inspect = value => inspectAccountJson(JSON.stringify(value), new Set(['1', '2']), new Set(['2']))
it('finds nested and array account references without treating user IDs as accounts', () => {
  const result = inspect({ user: { id: 2 }, account: { id: '2' }, accounts: [{ id: 1 }], nested: { source_trading_account_id: 2, accountId: '9' } })
  expect(result).toMatchObject({ references: 4, sourceMatches: 3, mergedMatches: 2, otherValues: 1 })
})
it('records invalid JSON, unknown scalars and unsafe numeric IDs without guessing', () => {
  expect(inspectAccountJson('bad', new Set(), new Set()).invalidJson).toBe(1)
  expect(inspect({ account_id: null, accountId: 9007199254740992 })).toMatchObject({ references: 2, otherValues: 1, unsafeNumbers: 1 })
})
it('does not reinterpret JSON strings or match values in unrelated prose', () => {
  expect(inspect({ text: '{"account_id":2}', comment: 'account_id=2', terminal_login: 2 }).references).toBe(0)
})
it('inspects the explicit legacy gzip encoding and records damaged encoded data', () => {
  const encoded = 'gzip-base64:' + gzipSync('{"trading_account_id":"2"}').toString('base64')
  expect(inspectAccountJson(encoded, new Set(['2']), new Set(['2']))).toMatchObject({ encodedJson: 1, mergedMatches: 1, invalidJson: 0 })
  expect(inspectAccountJson('gzip-base64:broken', new Set(), new Set())).toMatchObject({ encodedJson: 1, invalidJson: 1 })
})
it('extracts SQL literals and flags interpolation without claiming dynamic resolution', () => {
  const source = 'const a = `SELECT id FROM trading_accounts WHERE id=${id}`; const b = "UPDATE trading_accounts SET id=?"; const c = "trading_accounts"'
  expect(accountRootSourceReferences(source, 'test.ts')).toEqual([{ line: 1, operation: 'SELECT', dynamic: true }, { line: 1, operation: 'UPDATE', dynamic: false }])
})
