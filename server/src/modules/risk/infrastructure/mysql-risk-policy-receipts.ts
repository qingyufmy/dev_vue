import type { PoolConnection, RowDataPacket } from 'mysql2/promise'
import { riskSqlTime } from './risk-sql-time.js'
import { RiskError, type EffectiveRiskPolicy } from '../domain/risk.js'
import { assertRiskPolicyReceiptKey, policyReceiptHash, type RiskPolicyReceiptScope, type RiskPolicyReceipt } from '../domain/risk-policy-receipt.js'

type Connection = Pick<PoolConnection, 'execute'>
interface ReceiptRow extends RowDataPacket { request_sha256: string; result_json: string | EffectiveRiskPolicy; result_sha256: string }

/** The caller owns the transaction; no connection acquisition, commit or retries here. */
export async function readRiskPolicyReceipt(connection: Connection, scope: RiskPolicyReceiptScope): Promise<RiskPolicyReceipt | null> {
  assertRiskPolicyReceiptKey(scope.idempotencyKey)
  const [owned] = await connection.execute<RowDataPacket[]>(`SELECT 1 FROM trading_account_ownerships WHERE user_id=? AND trading_account_id=? AND role='owner' AND revoked_at_utc IS NULL LIMIT 1`, [scope.userId, scope.accountId])
  if (!owned[0]) throw new RiskError('risk_account_forbidden', 403)
  const [rows] = await connection.execute<ReceiptRow[]>(`SELECT r.request_sha256,r.result_json,r.result_sha256 FROM risk_policy_write_receipts r INNER JOIN trading_account_ownerships o ON o.user_id=r.user_id AND o.trading_account_id=r.trading_account_id AND o.role='owner' AND o.revoked_at_utc IS NULL WHERE r.user_id=? AND r.trading_account_id=? AND r.idempotency_key=? LIMIT 1`, [scope.userId, scope.accountId, scope.idempotencyKey])
  if (!rows[0]) return null
  try {
    const row = rows[0]
    const policy = typeof row.result_json === 'string' ? JSON.parse(row.result_json) as EffectiveRiskPolicy : row.result_json
    if (!policy || policy.userId !== scope.userId || policy.accountId !== scope.accountId
      || policyReceiptHash(policy) !== row.result_sha256 || !/^[a-f0-9]{64}$/.test(row.request_sha256)) throw Error('invalid receipt')
    return { requestHash: row.request_sha256, policy }
  } catch { throw new RiskError('risk_policy_receipt_invalid', 503) }
}

/** Invoke only inside the policy mutation transaction after locking current ownership. */
export async function insertRiskPolicyReceipt(connection: Connection, scope: RiskPolicyReceiptScope, receipt: RiskPolicyReceipt, createdAt: string) {
  assertRiskPolicyReceiptKey(scope.idempotencyKey)
  if (receipt.policy.userId !== scope.userId || receipt.policy.accountId !== scope.accountId
    || !/^[a-f0-9]{64}$/.test(receipt.requestHash)) throw new RiskError('risk_policy_receipt_invalid', 503)
  await connection.execute(`INSERT INTO risk_policy_write_receipts (user_id,trading_account_id,idempotency_key,request_sha256,result_json,result_sha256,created_at_utc) VALUES (?,?,?,?,?,?,?)`,
    [scope.userId, scope.accountId, scope.idempotencyKey, receipt.requestHash, JSON.stringify(receipt.policy), policyReceiptHash(receipt.policy), riskSqlTime(createdAt)])
}
