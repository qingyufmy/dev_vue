import { createHash } from 'node:crypto'
import { RiskError, type AccountRiskPolicyPatch, type EffectiveRiskPolicy } from './risk.js'

export interface RiskPolicyReceiptScope { userId: number; accountId: string; idempotencyKey: string }
export interface RiskPolicyReceipt { requestHash: string; policy: EffectiveRiskPolicy }

export function assertRiskPolicyReceiptKey(key: string) {
  if (!/^[A-Za-z0-9._:-]{16,128}$/.test(key)) throw new RiskError('idempotency_key_invalid', 422)
}

export function policyReceiptHash(value: unknown): string {
  function canonical(item: unknown): string {
    if (item === null || typeof item !== 'object') return JSON.stringify(item)
    if (Array.isArray(item)) return `[${item.map(canonical).join(',')}]`
    const record = item as Record<string, unknown>
    return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${canonical(record[key])}`).join(',')}}`
  }
  return createHash('sha256').update(canonical(value)).digest('hex')
}

export function riskPolicyRequestHash(input: { userId: number; accountId: string; expectedRevision: number; patch: AccountRiskPolicyPatch; reason: string }) {
  return policyReceiptHash({ version: 1, userId: input.userId, accountId: input.accountId,
    expectedRevision: input.expectedRevision, patch: input.patch, reason: input.reason.trim() })
}

export function replayRiskPolicyReceipt(receipt: RiskPolicyReceipt, requestHash: string) {
  if (receipt.requestHash !== requestHash) throw new RiskError('risk_policy_idempotency_conflict', 409)
  return receipt.policy
}
