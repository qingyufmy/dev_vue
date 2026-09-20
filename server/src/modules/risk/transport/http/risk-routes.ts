import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify'
import { AuthError } from '../../../auth/index.js'
import { createHttpContractValidator, HttpContractError } from '../../../../transport/http-contract.js'
import { httpRuntimeContracts } from '../../../../transport/generated/http-contracts.js'
import type { RiskService } from '../../application/risk-service.js'
import type { RiskDecisionDetail, RiskDecisionSummary } from '../../application/risk-ports.js'
import type { ManualReleaseState, ManualRiskRelease } from '../../domain/manual-risk-release.js'
import { RiskError, type AccountRiskPolicyPatch, type AccountRiskSummary, type EffectiveRiskPolicy } from '../../domain/risk.js'

export interface RiskRequestAuthenticator {
  authenticate(request: { headers: Record<string, unknown> }): Promise<{ userId: number }>
  assertWrite(request: { headers: Record<string, unknown> }): Promise<{ userId: number }>
}

export interface RiskRoutesOptions { service: RiskService; auth: RiskRequestAuthenticator }

const response = (requestId: string, data: unknown) => ({ data, meta: { request_id: requestId, generated_at: new Date().toISOString() } })
const decimal = (value: number) => String(value)

function policyDto(value: EffectiveRiskPolicy) {
  const policy = value.values
  return {
    account_id: value.accountId, platform_policy_version_id: value.platformPolicyVersionId,
    account_policy_version_id: value.accountPolicyVersionId,
    global_kill_switch: value.globalKillSwitch,
    allowed_symbols: policy.allowedSymbols, fail_closed_on_incomplete_data: policy.failClosedOnIncompleteData,
    max_quote_age_seconds: policy.maxQuoteAgeSeconds, max_risk_summary_age_seconds: policy.maxRiskSummaryAgeSeconds,
    max_decision_age_seconds: policy.maxDecisionAgeSeconds, max_price_deviation_percent: decimal(policy.maxPriceDeviationPercent),
    manual_release_enabled: policy.manualReleaseEnabled,
    manual_release_max_daily_loss_percent: decimal(policy.manualReleaseMaxDailyLossPercent),
    manual_release_max_drawdown_percent: decimal(policy.manualReleaseMaxDrawdownPercent),
    manual_release_max_daily_open_count: policy.manualReleaseMaxDailyOpenCount,
    manual_release_consecutive_loss_limit: policy.manualReleaseConsecutiveLossLimit,
    max_risk_per_trade_percent: decimal(policy.maxRiskPerTradePercent), max_daily_loss_percent: decimal(policy.maxDailyLossPercent),
    max_drawdown_percent: decimal(policy.maxDrawdownPercent), max_open_positions: policy.maxOpenPositions,
    max_pending_orders: policy.maxPendingOrders, max_total_volume: decimal(policy.maxTotalVolume), ...(Object.hasOwn(policy, 'maxOrderVolume') ? { max_order_volume: decimal(policy.maxOrderVolume) } : {}),
    max_spread_points: decimal(policy.maxSpreadPoints), min_open_interval_seconds: policy.minOpenIntervalSeconds,
    max_daily_open_count: policy.maxDailyOpenCount, consecutive_loss_limit: policy.consecutiveLossLimit,
    loss_cooldown_minutes: policy.lossCooldownMinutes, pending_valid_minutes: policy.pendingValidMinutes,
    pending_dedup_atr_multiplier: decimal(policy.pendingDedupAtrMultiplier),
    weekend_close_minutes: policy.weekendCloseMinutes, trade_send_enabled: policy.tradeSendEnabled,
    account_kill_switch: policy.accountKillSwitch, require_stop_loss: true,
    numeric_controls: Object.fromEntries(Object.entries(value.numericControls ?? {}).map(([key, control]) => [snake(key), { allowed_min: decimal(control!.allowedMin), allowed_max: decimal(control!.allowedMax), locked_value: control!.lockedValue === null ? null : decimal(control!.lockedValue), user_editable: control!.userEditable }])),
    editable_fields: value.editableFields.map(field => snake(field)), revision: String(value.policySetRevision), updated_at: value.updatedAt,
  }
}

function summaryDto(value: AccountRiskSummary) {
  return {
    account_id: value.accountId, business_date: value.businessDate, equity: value.equity, free_margin: value.freeMargin,
    margin_level_percent: value.marginLevelPercent === null ? null : decimal(value.marginLevelPercent),
    daily_loss_percent: decimal(value.dailyLossPercent), drawdown_percent: decimal(value.drawdownPercent),
    open_positions: value.openPositions, pending_orders: value.pendingOrders, total_volume: value.totalVolume,
    daily_open_count: value.dailyOpenCount, consecutive_losses: value.consecutiveLosses,
    terminal_timezone_offset_minutes: value.terminalTimezoneOffsetMinutes, clock_status: value.clockStatus,
    last_successful_open_at: value.lastSuccessfulOpenAt, cooldown_until: value.cooldownUntil,
    data_complete: value.dataComplete, incomplete_reasons: value.incompleteReasons,
    observed_at: value.observedAt, revision: String(value.revision),
  }
}

function decisionDto(value: RiskDecisionSummary) {
  return {
    risk_decision_id: value.id, trade_decision_id: value.tradeDecisionId, account_id: value.accountId,
    status: value.status, reject_code: value.rejectCode, platform_policy_version_id: value.platformPolicyVersionId,
    account_policy_version_id: value.accountPolicyVersionId, account_risk_revision: String(value.accountRiskRevision),
    manual_release_id: value.manualReleaseId,
    created_at: value.createdAt, revision: String(value.revision),
  }
}

function manualReleaseDto(value: ManualRiskRelease | null) {
  if (!value) return null
  return {
    manual_release_id: value.id, account_id: value.accountId,
    platform_policy_version_id: value.platformPolicyVersionId, account_policy_version_id: value.accountPolicyVersionId,
    policy_set_revision: String(value.policySetRevision), status: value.status,
    released_rules: value.releasedRules, baseline: {
      business_date: value.baseline.businessDate, daily_loss_percent: decimal(value.baseline.dailyLossPercent),
      drawdown_percent: decimal(value.baseline.drawdownPercent), daily_open_count: value.baseline.dailyOpenCount,
      consecutive_losses: value.baseline.consecutiveLosses, cooldown_until: value.baseline.cooldownUntil,
    },
    risk_state_revision: String(value.riskStateRevision), reason: value.reason, expires_at: value.expiresAt,
    created_at: value.createdAt, invalidated_at: value.invalidatedAt, invalidation_reason: value.invalidationReason,
    revision: String(value.revision),
  }
}

function manualReleaseStateDto(value: ManualReleaseState) {
  return {
    release: manualReleaseDto(value.release),
    availability: {
      available: value.availability.available,
      code: value.availability.code,
      rules: value.availability.rules,
      expires_at: value.availability.expiresAt,
      policy_set_revision: String(value.availability.policySetRevision),
      risk_state_revision: value.availability.riskStateRevision === null ? null : String(value.availability.riskStateRevision),
    },
  }
}

function detailDto(value: RiskDecisionDetail) {
  return { summary: decisionDto(value), rules: value.evaluation.rules.map(rule => ({ code: rule.code, outcome: rule.outcome, action_id: rule.actionId, details: rule.details })), approved_actions: value.evaluation.approvedActions.map(action => ({ action_id: action.actionId, kind: action.kind, parameters: action.parameters, expected_state: action.expectedState })), evaluated_at: value.evaluation.evaluatedAt, policy_hash: value.evaluation.policyHash }
}

function policyPatch(body: Record<string, unknown>): AccountRiskPolicyPatch {
  const map: Record<string, keyof AccountRiskPolicyPatch> = {
    max_risk_per_trade_percent: 'maxRiskPerTradePercent', max_daily_loss_percent: 'maxDailyLossPercent',
    max_drawdown_percent: 'maxDrawdownPercent', max_open_positions: 'maxOpenPositions', max_pending_orders: 'maxPendingOrders',
    max_total_volume: 'maxTotalVolume', max_order_volume: 'maxOrderVolume', max_spread_points: 'maxSpreadPoints', min_open_interval_seconds: 'minOpenIntervalSeconds',
    max_daily_open_count: 'maxDailyOpenCount', consecutive_loss_limit: 'consecutiveLossLimit', loss_cooldown_minutes: 'lossCooldownMinutes',
    pending_valid_minutes: 'pendingValidMinutes', weekend_close_minutes: 'weekendCloseMinutes',
    account_kill_switch: 'accountKillSwitch',
  }
  const result: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(body)) {
    if (key === 'reason' || key === 'trade_send_enabled') continue
    const target = map[key]
    if (!target) { result[key] = value; continue }
    result[target] = typeof value === 'string' && target !== 'accountKillSwitch' ? Number(value) : value
  }
  return result as AccountRiskPolicyPatch
}

function expectedRevision(header: unknown) {
  const value = String(header ?? '').trim().replace(/^W\//, '').replace(/^"|"$/g, '')
  if (!/^\d+$/.test(value)) throw new RiskError('if_match_required', 428)
  return Number(value)
}

export const riskRoutes: FastifyPluginAsync<RiskRoutesOptions> = async (fastify, options) => {
  const contract = createHttpContractValidator(httpRuntimeContracts,
    ['getRiskPolicy', 'getRiskPolicyReceipt', 'replaceRiskPolicy', 'getAccountRiskSummary', 'getManualRiskRelease', 'getManualRiskReleaseReceipt', 'createManualRiskRelease', 'listRiskDecisions', 'getRiskDecision'])
  const contractProblem = (operation: string, error: unknown, request: FastifyRequest, reply: FastifyReply) => {
    const known = error instanceof RiskError || error instanceof AuthError || error instanceof HttpContractError
      ? error : new RiskError('risk_unavailable', 503)
    const body = { type: `urn:aurum:problem:${known.code}`, title: 'Risk request failed', status: known.status,
      code: known.code, detail: known.code, instance: request.url, correlation_id: request.id, retryable: known.status >= 500 }
    return reply.type('application/problem+json').code(known.status)
      .send(contract.response(operation, body, known.status, 'application/problem+json'))
  }
  const read = async (operation: string, request: FastifyRequest, reply: FastifyReply, load: (userId: number) => Promise<unknown>) => {
    reply.header('Cache-Control', 'no-store')
    try {
      const { userId } = await options.auth.authenticate(request)
      contract.request(operation, request)
      return contract.response(operation, response(request.id, await load(userId)))
    } catch (error) {
      return contractProblem(operation, error, request, reply)
    }
  }
  fastify.get<{ Params: { account_id: string } }>('/risk-accounts/:account_id/policy', async (request, reply) => {
    return read('getRiskPolicy', request, reply, async userId => {
      const policy = await options.service.policy(userId, request.params.account_id)
      reply.header('ETag', `"${policy.policySetRevision}"`)
      return policyDto(policy)
    })
  })
  fastify.put<{ Params: { account_id: string }; Body: Record<string, unknown> & { reason?: string } }>('/risk-accounts/:account_id/policy', async (request, reply) => {
    reply.header('Cache-Control', 'no-store')
    try {
      const { userId } = await options.auth.assertWrite(request)
      const revision = expectedRevision(request.headers['if-match'])
      contract.request('replaceRiskPolicy', request)
      const policy = await options.service.replacePolicy(userId, request.params.account_id, revision, policyPatch(request.body), String(request.body.reason ?? ''), String(request.headers['idempotency-key'] ?? ''))
      const result = contract.response('replaceRiskPolicy', response(request.id, policyDto(policy)))
      return reply.header('ETag', `"${policy.policySetRevision}"`).send(result)
    } catch (error) { return contractProblem('replaceRiskPolicy', error, request, reply) }
  })
  fastify.get<{ Params: { account_id: string }; Querystring: { idempotency_key: string } }>('/risk-accounts/:account_id/policy-receipt', async (request, reply) => {
    return read('getRiskPolicyReceipt', request, reply, async userId => {
      const receipt = await options.service.policyReceipt(userId, request.params.account_id, request.query.idempotency_key)
      return { state: receipt.state, policy: receipt.policy ? policyDto(receipt.policy) : null }
    })
  })
  fastify.get<{ Params: { account_id: string } }>('/risk-accounts/:account_id/summary', async (request, reply) => {
    return read('getAccountRiskSummary', request, reply, async userId => summaryDto(await options.service.summary(userId, request.params.account_id)))
  })
  fastify.get<{ Params: { account_id: string } }>('/risk-accounts/:account_id/manual-release', async (request, reply) => {
    return read('getManualRiskRelease', request, reply, async userId => manualReleaseStateDto(await options.service.manualReleaseState(userId, request.params.account_id)))
  })
  fastify.post<{ Params: { account_id: string }; Body: { acknowledge_risk?: boolean; reason?: string } }>('/risk-accounts/:account_id/manual-release', async (request, reply) => {
    reply.header('Cache-Control', 'no-store')
    try {
      const { userId } = await options.auth.assertWrite(request)
      const revision = expectedRevision(request.headers['if-match'])
      contract.request('createManualRiskRelease', request)
      const body = request.body ?? {}
      const release = await options.service.createManualRelease({
        userId, accountId: request.params.account_id, expectedSummaryRevision: revision,
        idempotencyKey: String(request.headers['idempotency-key'] ?? ''), acknowledgeRisk: body.acknowledge_risk === true,
        reason: String(body.reason ?? ''),
      })
      const result = contract.response('createManualRiskRelease', response(request.id, manualReleaseDto(release)), 201)
      return reply.code(201).header('ETag', `"${release.revision}"`).send(result)
    } catch (error) { return contractProblem('createManualRiskRelease', error, request, reply) }
  })
  fastify.get<{ Params: { account_id: string }; Querystring: { idempotency_key: string } }>('/risk-accounts/:account_id/manual-release-receipt', async (request, reply) => {
    return read('getManualRiskReleaseReceipt', request, reply, async userId => {
      const receipt = await options.service.manualReleaseReceipt(userId, request.params.account_id, request.query.idempotency_key)
      return { state: receipt.state, release: manualReleaseDto(receipt.release) }
    })
  })
  fastify.get<{ Querystring: { account_id: string; page_size?: string } }>('/risk-decisions', async (request, reply) => {
    return read('listRiskDecisions', request, reply, async userId => ({ items: (await options.service.decisions(userId, request.query.account_id, Number(request.query.page_size ?? 50))).map(decisionDto) }))
  })
  fastify.get<{ Params: { risk_decision_id: string } }>('/risk-decisions/:risk_decision_id', async (request, reply) => {
    return read('getRiskDecision', request, reply, async userId => detailDto(await options.service.decision(userId, request.params.risk_decision_id)))
  })
}

function snake(value: string) { return value.replace(/[A-Z]/g, letter => `_${letter.toLowerCase()}`) }
