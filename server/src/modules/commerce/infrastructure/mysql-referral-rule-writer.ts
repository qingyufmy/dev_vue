import type { PoolConnection, RowDataPacket, ResultSetHeader } from 'mysql2/promise'

export interface ReferralRuleUpdate { id: number; expectedRevision: string; rateBps: number; enabled: boolean }
export interface ReferralRuleChangeRequest { requestId: string; actorUserId: number; changes: ReferralRuleUpdate[] }
interface LockedRule extends RowDataPacket { id: string; revision: string; rate_bps: string; enabled: string }

// Caller must authorize the actor, own the transaction and durable request
// idempotency, and roll back on every error. This function never commits.
export async function updateReferralRulesInTransaction(connection: PoolConnection, input: ReferralRuleChangeRequest) {
  const { requestId, actorUserId } = input
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(requestId)
    || !Number.isSafeInteger(actorUserId) || actorUserId < 1 || actorUserId > 2147483647
    || !Array.isArray(input.changes) || input.changes.length < 1 || input.changes.length > 4) throw Error('referral_rule_update_invalid')
  const changes = input.changes.map(change => ({ ...change })).sort((a, b) => a.id - b.id)
  const seen = new Set<number>()
  for (const change of changes) {
    if (!Number.isSafeInteger(change.id) || change.id < 1 || change.id > 2147483647 || seen.has(change.id)
      || !/^[1-9]\d{0,19}$/.test(change.expectedRevision) || BigInt(change.expectedRevision) >= 18446744073709551615n
      || !Number.isInteger(change.rateBps) || change.rateBps < 0 || change.rateBps > 10000
      || typeof change.enabled !== 'boolean') throw Error('referral_rule_update_invalid')
    seen.add(change.id)
  }
  const locked: LockedRule[] = []
  // Lock the complete set in numeric primary-key order, validating every
  // precondition before the first UPDATE or audit INSERT.
  for (const change of changes) {
    const [rows] = await connection.execute<LockedRule[]>(
      'SELECT CAST(id AS CHAR) id,CAST(revision AS CHAR) revision,CAST(rate_bps AS CHAR) rate_bps,CAST(enabled AS CHAR) enabled FROM referral_rules WHERE id=? FOR UPDATE', [change.id])
    const row = rows[0]
    if (rows.length !== 1 || !row || row.id !== String(change.id)) throw Error('referral_rule_missing')
    if (row.revision !== change.expectedRevision) throw Error('referral_rule_revision_conflict')
    if (!/^(0|[1-9]\d*)$/.test(row.rate_bps) || BigInt(row.rate_bps) > 10000n || !['0', '1'].includes(row.enabled)) throw Error('referral_rule_state_invalid')
    locked.push({ ...row })
  }
  const result = []
  for (const [index, change] of changes.entries()) {
    const previous = locked[index]!
    const revision = (BigInt(change.expectedRevision) + 1n).toString()
    const [updated] = await connection.execute<ResultSetHeader>(
      'UPDATE referral_rules SET rate_bps=?,enabled=?,revision=? WHERE id=? AND revision=?',
      [change.rateBps, change.enabled ? 1 : 0, revision, change.id, change.expectedRevision])
    if (updated.affectedRows !== 1) throw Error('referral_rule_revision_conflict')
    await connection.execute(
      'INSERT INTO referral_rule_changes (rule_id,rule_revision,request_id,actor_user_id,previous_rate_bps,rate_bps,previous_enabled,enabled,recorded_at_utc) VALUES (?,?,?,?,?,?,?,?,UTC_TIMESTAMP(3))',
      [change.id, revision, requestId, actorUserId, previous.rate_bps, change.rateBps, previous.enabled, change.enabled ? 1 : 0])
    result.push({ id: change.id, revision })
  }
  return result
}
