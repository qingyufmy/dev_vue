import type { AccountPrincipalReader, ActivePrincipalAccess } from '../../auth/index.js'
import type { ModelUsageLedger, ModelUsageCompletion, RuntimeModelUsageContext } from '../application/model-usage-ledger.js'
import type { Pool, PoolConnection, ResultSetHeader, RowDataPacket } from 'mysql2/promise'
import { InferenceError, type JsonObject } from '../domain/inference.js'

interface UserPolicyRow extends RowDataPacket {
  share_for_manual: number
  share_for_auto: number
  allowed_plans: string | string[] | null
}


export class MysqlModelUsageLedger implements ModelUsageLedger {
  constructor(private readonly pool: Pool, private readonly principals: (connection: PoolConnection) => AccountPrincipalReader,
    private readonly active: (connection: PoolConnection) => ActivePrincipalAccess) {}

  async begin(context: RuntimeModelUsageContext) {
    if (!Number.isSafeInteger(context.userId) || context.userId <= 0) throw new InferenceError('model_usage_user_invalid', 409)
    const connection = await this.pool.getConnection()
    try {
      await connection.beginTransaction()
      if (context.credentialSource === 'platform_shared') await assertPlatformAccess(connection, context, this.principals(connection), this.active(connection))
      const [result] = await connection.execute<ResultSetHeader>(`INSERT INTO ai_model_usage_logs
        (user_id,model_profile_id,credential_source,\`usage\`,strategy_id,request_phase,token_count,request_status,error_code,accounting_status,created_at)
        VALUES (?,?,?,?,?,'request',0,'reserved',NULL,'usage_unknown',NOW())`,
      [context.userId, context.profileId, context.credentialSource, context.usage, context.strategyId])
      await connection.commit()
      return String(result.insertId)
    } catch (error) {
      await connection.rollback()
      throw error
    } finally {
      connection.release()
    }
  }

  async finish(reservationId: string, completion: ModelUsageCompletion) {
    const tokens = usageTokens(completion.usage)
    const [result] = await this.pool.execute<ResultSetHeader>(`UPDATE ai_model_usage_logs SET
      token_count=?,input_tokens=?,output_tokens=?,reasoning_tokens=?,cached_tokens=?,request_status=?,error_code=?,
      provider_request_id=?,accounting_status=?,request_bytes=?,response_bytes=?,duration_ms=?
      WHERE id=? AND request_status='reserved'`, [
      tokens.total, tokens.input, tokens.output, tokens.reasoning, tokens.cached, completion.status,
      bounded(completion.errorCode, 128), bounded(completion.providerRequestId, 191),
      completion.usage ? 'settled' : 'usage_unknown', nonNegative(completion.requestBytes),
      nonNegative(completion.responseBytes), nonNegative(completion.durationMs), reservationId,
    ])
    if (result.affectedRows !== 1) throw new Error('model_usage_reservation_not_pending')
  }

  async recoverAbandoned(before: Date, limit: number) {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) throw new Error('model_usage_recovery_limit_invalid')
    const [result] = await this.pool.execute<ResultSetHeader>(`UPDATE ai_model_usage_logs SET
      request_status='error',error_code='model_usage_reservation_abandoned',accounting_status='usage_unknown',
      duration_ms=GREATEST(0,FLOOR(TIMESTAMPDIFF(MICROSECOND,created_at,UTC_TIMESTAMP(3))/1000))
      WHERE request_status='reserved' AND created_at<? ORDER BY id LIMIT ${limit}`, [before])
    return result.affectedRows
  }
}

async function assertPlatformAccess(connection: PoolConnection, context: RuntimeModelUsageContext, principals: AccountPrincipalReader, active: ActivePrincipalAccess) {
  if (!await active.isActive(context.userId, 'update')) throw new InferenceError('platform_model_sharing_unavailable', 409)
  const principal = (await principals.readMany([context.userId], 'share')).get(context.userId)
  if (!principal) throw new InferenceError('platform_model_sharing_unavailable', 409)
  const [rows] = await connection.execute<UserPolicyRow[]>(`SELECT share_for_manual,share_for_auto,allowed_plans FROM platform_model_usage_policy WHERE id=1 FOR UPDATE`, [])
  const policy = rows[0]
  if (!policy) throw new InferenceError('platform_model_sharing_unavailable', 409)
  const enabled = context.usage === 'manual' ? Boolean(policy.share_for_manual) : Boolean(policy.share_for_auto)
  if (!enabled || !planAllowed(policy.allowed_plans, principal.plan)) throw new InferenceError('platform_model_sharing_unavailable', 409)

}

function usageTokens(usage: JsonObject | null | undefined) {
  const input = nonNegative(usage?.input_tokens ?? usage?.prompt_tokens)
  const output = nonNegative(usage?.output_tokens ?? usage?.completion_tokens)
  const reasoning = nonNegative(usage?.reasoning_tokens)
  const cached = nonNegative(usage?.cached_tokens)
  const total = nonNegative(usage?.total_tokens ?? input + output)
  return { input, output, reasoning, cached, total }
}

function nonNegative(value: unknown) { return Math.max(0, Math.trunc(Number(value) || 0)) }
function bounded(value: unknown, maximum: number) {
  const text = typeof value === 'string' ? value.trim() : ''
  return text ? text.slice(0, maximum) : null
}

function planAllowed(value: UserPolicyRow['allowed_plans'], plan: string) {
  if (value === null) return true
  let parsed: unknown = value
  if (typeof value === 'string') {
    try { parsed = JSON.parse(value) }
    catch { return false }
  }
  return Array.isArray(parsed) && parsed.every(item => typeof item === 'string') && parsed.includes(plan)
}
