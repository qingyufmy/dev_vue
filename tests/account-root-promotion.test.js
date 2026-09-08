import { expect, it, vi } from 'vitest'
import { accountRootRenameSql, compactRootSnapshot, executeAccountRootPromotion } from '../scripts/lib/account-root-promotion.mjs'

const before = [{ name: 'old', rows: 4, rowsSha256: 'source', ddlSha256: 'schema-before' }]
const after = [{ name: 'new', rows: 4, rowsSha256: 'source', ddlSha256: 'schema-after' }]
it('renames table identifiers and incoming FK targets simultaneously', () => {
  const result = compactRootSnapshot([
    { name: 'trading_accounts', ddl: 'CREATE TABLE `trading_accounts` (`id` int)', rows: 4, rowsSha256: 'old' },
    { name: 'trading_accounts_v4_build', ddl: 'CREATE TABLE `trading_accounts_v4_build` (`id` bigint)', rows: 3, rowsSha256: 'new' },
  ], true)
  expect(result.map(row => [row.name, row.rows])).toEqual([['trading_accounts', 3], ['trading_accounts_legacy_v3', 4]])
  expect(accountRootRenameSql()).toContain('`trading_accounts` TO `trading_accounts_legacy_v3`')
  expect(accountRootRenameSql(true)).toContain('`trading_accounts_legacy_v3` TO `trading_accounts`')
})
it('detects conflicting destination names', () => {
  expect(() => compactRootSnapshot(['trading_accounts', 'trading_accounts_legacy_v3'].map(name => ({ name, ddl: name, rows: 0, rowsSha256: 'x' })), true)).toThrow('collision')
})
it('defaults to inspection with no DDL', async () => {
  const store = { snapshot: async () => before, rename: vi.fn() }
  expect(await executeAccountRootPromotion(store, { before, after })).toEqual({ status: 'pending', ddlCount: 0 })
  expect(store.rename).not.toHaveBeenCalled()
})
it('reconciles a lost DDL response without issuing the rename again', async () => {
  let actual = before
  const store = { snapshot: async () => actual, rename: vi.fn(async () => { actual = after; throw Error('response lost') }) }
  await expect(executeAccountRootPromotion(store, { before, after }, { apply: true })).rejects.toThrow('outcome_unknown')
  expect(await executeAccountRootPromotion(store, { before, after }, { apply: true })).toEqual({ status: 'already-applied', ddlCount: 0 })
  expect(store.rename).toHaveBeenCalledOnce()
})
it('rejects restore after any new rows or schema change', async () => {
  const store = { snapshot: async () => [{ ...after[0], rows: 5 }], rename: vi.fn() }
  await expect(executeAccountRootPromotion(store, { before: after, after: before }, { apply: true, restore: true })).rejects.toThrow('state_conflict')
  expect(store.rename).not.toHaveBeenCalled()
})
it('rejects a partial or unexpected postcondition', async () => {
  let actual = before
  const store = { snapshot: async () => actual, rename: async () => { actual = [] } }
  await expect(executeAccountRootPromotion(store, { before, after }, { apply: true })).rejects.toThrow('postcondition')
})
it('treats a repeated restore as completed without DDL', async () => {
  const store = { snapshot: async () => before, rename: vi.fn() }
  expect(await executeAccountRootPromotion(store, { before: after, after: before }, { apply: true, restore: true })).toEqual({ status: 'already-applied', ddlCount: 0 })
  expect(store.rename).not.toHaveBeenCalled()
})
