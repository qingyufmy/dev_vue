import type { Pool, RowDataPacket } from 'mysql2/promise'
import { normalizeRuleChangeCommand, type RuleChangeCommand, type RuleChangeResult, type ReferralRuleManagementRepository } from '../application/referral-rule-management.js'
import { updateReferralRulesInTransaction } from './mysql-referral-rule-writer.js'
import { listAdminReferralRules } from './mysql-referral-rule-list.js'

interface AuditReceipt extends RowDataPacket { rule_id: string; rule_revision: string; actor_user_id: string; rate_bps: string; enabled: string }

export class MysqlReferralRuleManagement implements ReferralRuleManagementRepository {
  constructor(private readonly pool: Pick<Pool, 'getConnection'>) {}
  list(actorUserId: number) { return listAdminReferralRules(this.pool, actorUserId) }
  async execute(input: RuleChangeCommand): Promise<RuleChangeResult> {
    const command = normalizeRuleChangeCommand(input)
    const connection = await this.pool.getConnection()
    let transactionStarted = false, commitAttempted = false, destroyed = false
    try {
      await connection.query("SET SESSION time_zone='+00:00'")
      await connection.beginTransaction(); transactionStarted = true
      // Serialize this actor's requests and fence role/deletion changes until
      // commit. The same lock is acquired for replays before reading receipts.
      const [actors] = await connection.execute<RowDataPacket[]>(
        "SELECT id FROM users WHERE id=? AND role='admin' AND deletion_status='active' AND deleted_at IS NULL FOR UPDATE", [command.actorUserId])
      if (actors.length !== 1) throw Error('referral_admin_required')
      const [receipts] = await connection.execute<AuditReceipt[]>(
        'SELECT CAST(rule_id AS CHAR) rule_id,CAST(rule_revision AS CHAR) rule_revision,CAST(actor_user_id AS CHAR) actor_user_id,CAST(rate_bps AS CHAR) rate_bps,CAST(enabled AS CHAR) enabled FROM referral_rule_changes WHERE request_id=? AND actor_user_id=? ORDER BY rule_id FOR UPDATE', [command.requestId, command.actorUserId])
      let result: RuleChangeResult
      if (receipts.length) {
        if (receipts.length !== command.changes.length || receipts.some((row, index) => {
          const change = command.changes[index]!
          return row.actor_user_id !== String(command.actorUserId) || row.rule_id !== String(change.id)
            || row.rule_revision !== (BigInt(change.expectedRevision) + 1n).toString()
            || row.rate_bps !== String(change.rateBps) || row.enabled !== (change.enabled ? '1' : '0')
        })) throw Error('referral_rule_idempotency_conflict')
        result = { rules: receipts.map(row => ({ id: Number(row.rule_id), revision: row.rule_revision })), replayed: true }
      } else {
        result = { rules: await updateReferralRulesInTransaction(connection, command), replayed: false }
      }
      commitAttempted = true
      await connection.commit()
      return result
    } catch (error) {
      if (commitAttempted) {
        connection.destroy(); destroyed = true
        throw Error('referral_rule_commit_unknown')
      }
      if (transactionStarted) {
        try { await connection.rollback() } catch { connection.destroy(); destroyed = true; throw Error('referral_rule_rollback_unknown') }
      }
      throw error
    } finally { if (!destroyed) connection.release() }
  }
}
