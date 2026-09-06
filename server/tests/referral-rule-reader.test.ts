import { describe, expect, it } from 'vitest'
import type { PoolConnection } from 'mysql2/promise'
import { readReferralRule } from '../src/modules/commerce/infrastructure/mysql-referral-rule-reader.js'

const rule = { id: '1', plan: 'plus', period: 'monthly', rate_bps: '0', enabled: '1', revision: '9007199254740993' }
const connection = (rows: unknown[]) => ({ execute: async () => [rows, []] }) as unknown as Pick<PoolConnection, 'execute'>
describe('normalized referral rule reads', () => {
  it('distinguishes missing and disabled from an enabled zero-rate rule', async () => {
    expect(await readReferralRule(connection([]), 'plus', 'monthly')).toEqual({ status: 'missing' })
    const found = await readReferralRule(connection([rule]), 'plus', 'monthly')
    expect(found).toMatchObject({ status: 'found', rule: { rateBps: 0, revision: '9007199254740993' } })
    expect(await readReferralRule(connection([{ ...rule, enabled: '0' }]), 'plus', 'monthly'))
      .toMatchObject({ status: 'disabled', rule: { enabled: false, rateBps: 0 } })
  })
  it('rejects collation aliases, duplicate results and corrupt numeric values', async () => {
    for (const rows of [[rule, rule], [{ ...rule, plan: 'PLUS' }], [{ ...rule, rate_bps: '10001' }],
      [{ ...rule, rate_bps: '-1' }], [{ ...rule, enabled: '2' }], [{ ...rule, revision: '0' }],
      [{ ...rule, revision: '18446744073709551616' }]])
      await expect(readReferralRule(connection(rows), 'plus', 'monthly')).rejects.toThrow('referral_rule_state_invalid')
  })
})
