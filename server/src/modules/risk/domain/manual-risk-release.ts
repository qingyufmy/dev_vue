import { createHash } from 'node:crypto'
import type { AccountRiskSummary, EffectiveRiskPolicy } from './risk-state.js'

export const MANUAL_RELEASE_RULES = [
  'RISK_DAILY_LOSS_LIMIT',
  'RISK_DRAWDOWN_LIMIT',
  'RISK_DAILY_OPEN_LIMIT',
  'RISK_CONSECUTIVE_LOSS_LIMIT',
  'RISK_COOLDOWN_ACTIVE',
] as const

export type ManualReleaseRuleCode = typeof MANUAL_RELEASE_RULES[number]
export type ManualRiskReleaseStatus = 'active' | 'superseded' | 'expired' | 'revoked'

export interface ManualRiskReleaseBaseline {
  businessDate: string
  dailyLossPercent: number
  drawdownPercent: number
  dailyOpenCount: number
  consecutiveLosses: number
  cooldownUntil: string | null
}

export interface ManualRiskRelease {
  id: string
  userId: number
  accountId: string
  platformPolicyVersionId: string
  accountPolicyVersionId: string | null
  policySetRevision: number
  status: ManualRiskReleaseStatus
  releasedRules: ManualReleaseRuleCode[]
  baseline: ManualRiskReleaseBaseline
  riskStateRevision: number
  breachFingerprint: string
  reason: string
  expiresAt: string
  createdAt: string
  invalidatedAt: string | null
  invalidationReason: string | null
  revision: number
}

/**
 * Safe read-model projection for the browser.  The breach fingerprint and
 * assessment baseline stay server-side; the client only needs to know whether
 * a release may be requested and which current rules would be released.
 */
export interface ManualReleaseAvailability {
  available: boolean
  code: string | null
  rules: ManualReleaseRuleCode[]
  expiresAt: string | null
  policySetRevision: number
  riskStateRevision: number | null
}

export interface ManualReleaseState {
  release: ManualRiskRelease | null
  availability: ManualReleaseAvailability
}

export type ManualReleaseAssessment =
  | { available: true; rules: ManualReleaseRuleCode[]; baseline: ManualRiskReleaseBaseline; breachFingerprint: string; expiresAt: string }
  | { available: false; code: string }

export function assessManualRelease(policy: EffectiveRiskPolicy, summary: AccountRiskSummary, now: Date): ManualReleaseAssessment {
  if (!policy.values.manualReleaseEnabled) return { available: false, code: 'risk_manual_release_disabled' }
  if (policy.globalKillSwitch) return { available: false, code: 'risk_manual_release_global_control' }
  if (policy.values.accountKillSwitch) return { available: false, code: 'risk_manual_release_account_kill_switch' }
  if (!policy.values.tradeSendEnabled) return { available: false, code: 'risk_manual_release_trade_send_disabled' }
  if (!summary.dataComplete) return { available: false, code: 'risk_manual_release_data_incomplete' }
  if (!summary.businessDate || summary.clockStatus !== 'calibrated' || summary.terminalTimezoneOffsetMinutes === null) return { available: false, code: 'risk_manual_release_clock_unverified' }
  if (!validBusinessDate(summary.businessDate)) return { available: false, code: 'risk_manual_release_business_date_invalid' }
  if (summary.dailyLossPercent >= policy.values.manualReleaseMaxDailyLossPercent
    || summary.drawdownPercent >= policy.values.manualReleaseMaxDrawdownPercent
    || summary.dailyOpenCount >= policy.values.manualReleaseMaxDailyOpenCount
    || summary.consecutiveLosses >= policy.values.manualReleaseConsecutiveLossLimit) return { available: false, code: 'risk_manual_release_platform_limit' }

  const rules: ManualReleaseRuleCode[] = []
  if (summary.dailyLossPercent >= policy.values.maxDailyLossPercent) rules.push('RISK_DAILY_LOSS_LIMIT')
  if (summary.drawdownPercent >= policy.values.maxDrawdownPercent) rules.push('RISK_DRAWDOWN_LIMIT')
  if (summary.dailyOpenCount >= policy.values.maxDailyOpenCount) rules.push('RISK_DAILY_OPEN_LIMIT')
  if (summary.consecutiveLosses >= policy.values.consecutiveLossLimit) rules.push('RISK_CONSECUTIVE_LOSS_LIMIT')
  if (summary.cooldownUntil && Date.parse(summary.cooldownUntil) > now.getTime()) rules.push('RISK_COOLDOWN_ACTIVE')
  if (rules.length === 0) return { available: false, code: 'risk_manual_release_no_active_block' }

  const baseline: ManualRiskReleaseBaseline = {
    businessDate: summary.businessDate,
    dailyLossPercent: summary.dailyLossPercent,
    drawdownPercent: summary.drawdownPercent,
    dailyOpenCount: summary.dailyOpenCount,
    consecutiveLosses: summary.consecutiveLosses,
    cooldownUntil: summary.cooldownUntil,
  }
  return {
    available: true,
    rules,
    baseline,
    breachFingerprint: fingerprint({ accountId: summary.accountId, rules, baseline }),
    expiresAt: nextBusinessDay(summary.businessDate, summary.terminalTimezoneOffsetMinutes).toISOString(),
  }
}

export function manualReleaseApplies(release: ManualRiskRelease | null | undefined, rule: ManualReleaseRuleCode, policy: EffectiveRiskPolicy, summary: AccountRiskSummary, now: Date) {
  return Boolean(release
    && release.platformPolicyVersionId === policy.platformPolicyVersionId
    && release.accountPolicyVersionId === policy.accountPolicyVersionId
    && release.policySetRevision === policy.policySetRevision
    && release.releasedRules.includes(rule)
    && manualReleaseStillValid(release, summary, now))
}

export function manualReleaseStillValid(release: ManualRiskRelease, summary: AccountRiskSummary, now: Date) {
  if (release.status !== 'active' || release.accountId !== summary.accountId || release.userId !== summary.userId) return false
  if (Date.parse(release.expiresAt) <= now.getTime() || release.baseline.businessDate !== summary.businessDate) return false
  for (const rule of release.releasedRules) {
    if (rule === 'RISK_DAILY_LOSS_LIMIT' && summary.dailyLossPercent > release.baseline.dailyLossPercent) return false
    if (rule === 'RISK_DRAWDOWN_LIMIT' && summary.drawdownPercent > release.baseline.drawdownPercent) return false
    if (rule === 'RISK_DAILY_OPEN_LIMIT' && summary.dailyOpenCount > release.baseline.dailyOpenCount) return false
    if (rule === 'RISK_CONSECUTIVE_LOSS_LIMIT' && summary.consecutiveLosses > release.baseline.consecutiveLosses) return false
    if (rule === 'RISK_COOLDOWN_ACTIVE' && later(summary.cooldownUntil, release.baseline.cooldownUntil)) return false
  }
  return true
}

function later(current: string | null, baseline: string | null) {
  if (!current) return false
  if (!baseline) return true
  return Date.parse(current) > Date.parse(baseline)
}

function nextBusinessDay(businessDate: string, offsetMinutes: number) {
  const localMidnight = Date.parse(`${businessDate}T00:00:00.000Z`)
  return new Date(localMidnight + 86_400_000 - offsetMinutes * 60_000)
}

function validBusinessDate(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const parsed = new Date(`${value}T00:00:00.000Z`)
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value
}

function fingerprint(value: unknown) {
  return createHash('sha256').update(canonical(value)).digest('hex')
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  const record = value as Record<string, unknown>
  return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${canonical(record[key])}`).join(',')}}`
}
