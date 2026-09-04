import type { Pool, PoolConnection, ResultSetHeader, RowDataPacket } from 'mysql2/promise'
import { InferenceError, type JsonObject } from '../domain/inference.js'

export type RuntimeModelUsageKind = 'manual' | 'auto'
export type RuntimeCredentialSource = 'user' | 'platform_shared'

export interface RuntimeModelUsageContext {
  userId: number
  profileId: string
  strategyId: string
  credentialSource: RuntimeCredentialSource
  usage: RuntimeModelUsageKind
}

export interface ModelUsageCompletion {
  status: 'success' | 'error'
  errorCode?: string | null
  usage?: JsonObject | null
  providerRequestId?: string | null
  requestBytes: number
  responseBytes: number
  durationMs: number
}

export interface ModelUsageLedger {
  begin(context: RuntimeModelUsageContext): Promise<string>
  finish(reservationId: string, completion: ModelUsageCompletion): Promise<void>
}

interface UserPolicyRow extends RowDataPacket {
  plan: string
  share_for_manual: number
  share_for_auto: number
  allowed_plans: string | string[] | null
  daily_requests_per_user: number
  daily_tokens_per_user: number
}

interface UsageTotalRow extends RowDataPacket { requests: number; tokens: string | number }

export class MysqlModelUsageLedger implements ModelUsageLedger {
  constructor(private readonly pool: Pool) {}

  async begin(context: RuntimeModelUsageContext) {
    if (!Number.isSafeInteger(context.userId) || context.userId <= 0) throw new InferenceError('model_usage_user_invalid', 409)
    const connection = await this.pool.getConnection()
    try {
      await connection.beginTransaction()
      if (context.credentialSource === 'platform_shared') await assertPlatformQuota(connection, context)
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

async function assertPlatformQuota(connection: PoolConnection, context: RuntimeModelUsageContext) {
  const [rows] = await connection.execute<UserPolicyRow[]>(`SELECT u.plan,p.share_for_manual,p.share_for_auto,p.allowed_plans,
      p.daily_requests_per_user,p.daily_tokens_per_user
    FROM users u INNER JOIN platform_model_usage_policy p ON p.id=1
    WHERE u.id=? FOR UPDATE`, [context.userId])
  const policy = rows[0]
  if (!policy) throw new InferenceError('platform_model_sharing_unavailable', 409)
  const enabled = context.usage === 'manual' ? Boolean(policy.share_for_manual) : Boolean(policy.share_for_auto)
  if (!enabled || !planAllowed(policy.allowed_plans, policy.plan)) throw new InferenceError('platform_model_sharing_unavailable', 409)
  const [totals] = await connection.execute<UsageTotalRow[]>(`SELECT COUNT(*) requests,COALESCE(SUM(token_count),0) tokens
    FROM ai_model_usage_logs
    WHERE user_id=? AND credential_source='platform_shared'
      AND (request_phase='request' OR request_phase IS NULL) AND created_at>=CURRENT_DATE()`,
  [context.userId])
  const usage = totals[0]
  if (Number(usage?.requests ?? 0) >= Number(policy.daily_requests_per_user)) throw new InferenceError('daily_request_limit', 429)
  if (Number(usage?.tokens ?? 0) >= Number(policy.daily_tokens_per_user)) throw new InferenceError('daily_token_limit', 429)
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
