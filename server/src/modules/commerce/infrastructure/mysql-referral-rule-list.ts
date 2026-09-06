import type { Pool, RowDataPacket } from 'mysql2/promise'
import type { RuleConfiguration } from '../application/referral-rule-management.js'

interface RuleRow extends RowDataPacket { id: string; plan: string; period: string; rate_bps: string; enabled: string; revision: string }

export async function listAdminReferralRules(pool: Pick<Pool, 'getConnection'>, actorUserId: number): Promise<RuleConfiguration[]> {
  if (!Number.isSafeInteger(actorUserId) || actorUserId < 1 || actorUserId > 2147483647) throw Error('referral_admin_required')
  const c = await pool.getConnection()
  let started = false, destroyed = false
  try {
    await c.beginTransaction(); started = true
    const [actors] = await c.execute<RowDataPacket[]>("SELECT id FROM users WHERE id=? AND role='admin' AND deletion_status='active' AND deleted_at IS NULL FOR SHARE", [actorUserId])
    if (actors.length !== 1) throw Error('referral_admin_required')
    const [rows] = await c.query<RuleRow[]>(
      'SELECT CAST(id AS CHAR) id,plan,period,CAST(rate_bps AS CHAR) rate_bps,CAST(enabled AS CHAR) enabled,CAST(revision AS CHAR) revision FROM referral_rules ORDER BY referral_rules.id LIMIT 5')
    if (rows.length > 4) throw Error('referral_rule_state_invalid')
    const scopes = new Set<string>(), ids = new Set<string>()
    const result = rows.map(row => {
      if (!['plus', 'pro'].includes(row.plan) || !['monthly', 'yearly'].includes(row.period)
        || !/^[1-9]\d{0,9}$/.test(row.id) || BigInt(row.id) > 2147483647n || ids.has(row.id)
        || !/^(0|[1-9]\d{0,4})$/.test(row.rate_bps) || BigInt(row.rate_bps) > 10000n || !['0', '1'].includes(row.enabled)
        || !/^[1-9]\d{0,19}$/.test(row.revision) || BigInt(row.revision) > 18446744073709551615n
        || scopes.has(`${row.plan}:${row.period}`)) throw Error('referral_rule_state_invalid')
      ids.add(row.id); scopes.add(`${row.plan}:${row.period}`)
      return { id: row.id, plan: row.plan as RuleConfiguration['plan'], period: row.period as RuleConfiguration['period'],
        rateBps: Number(row.rate_bps), enabled: row.enabled === '1', revision: row.revision }
    })
    await c.rollback(); started = false
    return result
  } catch (error) {
    if (started) try { await c.rollback() } catch { c.destroy(); destroyed = true }
    throw error
  } finally { if (!destroyed) c.release() }
}
