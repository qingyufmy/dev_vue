import type { PoolConnection, RowDataPacket } from 'mysql2/promise'

export interface ReferralRule {
  id: string
  plan: 'plus' | 'pro'
  period: 'monthly' | 'yearly'
  rateBps: number
  enabled: boolean
  revision: string
}

export type ReferralRuleLookup = { status: 'missing' } | { status: 'found' | 'disabled'; rule: ReferralRule }
interface RuleRow extends RowDataPacket {
  id: string
  plan: string
  period: string
  rate_bps: string
  enabled: string
  revision: string
}

// Cut over only after revision has been installed and the legacy writer retired.
// A lookup never chooses the commission policy for missing or disabled rules.
export async function readReferralRule(connection: Pick<PoolConnection, 'execute'>,
  plan: ReferralRule['plan'], period: ReferralRule['period']): Promise<ReferralRuleLookup> {
  if (!['plus', 'pro'].includes(plan) || !['monthly', 'yearly'].includes(period)) throw new Error('referral_rule_scope_invalid')
  const [rows] = await connection.execute<RuleRow[]>(
    `SELECT CAST(id AS CHAR) id,plan,period,CAST(rate_bps AS CHAR) rate_bps,
       CAST(enabled AS CHAR) enabled,CAST(revision AS CHAR) revision
     FROM referral_rules WHERE plan=? AND period=?`, [plan, period])
  if (rows.length === 0) return { status: 'missing' }
  const row = rows[0]
  if (rows.length !== 1 || !row || row.plan !== plan || row.period !== period
    || !/^[1-9]\d*$/.test(row.id) || BigInt(row.id) > 2147483647n
    || !/^(0|[1-9]\d*)$/.test(row.rate_bps) || BigInt(row.rate_bps) > 10000n
    || !['0', '1'].includes(row.enabled)
    || !/^[1-9]\d*$/.test(row.revision) || BigInt(row.revision) > 18446744073709551615n) throw new Error('referral_rule_state_invalid')
  const rule: ReferralRule = { id: row.id, plan, period, rateBps: Number(row.rate_bps), enabled: row.enabled === '1', revision: row.revision }
  return { status: rule.enabled ? 'found' : 'disabled', rule }
}
