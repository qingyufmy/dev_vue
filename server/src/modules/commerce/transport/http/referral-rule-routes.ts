import { randomUUID } from 'node:crypto'
import { createHttpContractValidator } from '../../../../transport/http-contract.js'
import { httpRuntimeContracts } from '../../../../transport/generated/http-contracts.js'
import type { FastifyPluginAsync, FastifyReply } from 'fastify'
import { AuthError } from '../../../auth/index.js'
import type { ReferralRuleManagementService, RuleChange } from '../../application/referral-rule-management.js'

export interface ReferralRuleRoutesOptions {
  service: ReferralRuleManagementService
  auth: {
    authenticate(request: { headers: Record<string, unknown> }): Promise<{ userId: number; role: string }>
    assertWrite(request: { headers: Record<string, unknown> }): Promise<{ userId: number; role: string }>
  }
}
const statuses: Record<string, number> = { referral_admin_required: 403, referral_rule_update_invalid: 400,
  referral_rule_missing: 404, referral_rule_revision_conflict: 409, referral_rule_idempotency_conflict: 409,
  referral_rule_commit_unknown: 503, referral_rule_rollback_unknown: 503 }

function changesFromBody(body: unknown): RuleChange[] {
  if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).join(',') !== 'changes') throw Error('referral_rule_update_invalid')
  const changes = (body as { changes: unknown }).changes
  if (!Array.isArray(changes) || !changes.length || changes.length > 4) throw Error('referral_rule_update_invalid')
  return changes.map(row => {
    if (!row || typeof row !== 'object' || Array.isArray(row)
      || Object.keys(row).sort().join(',') !== 'enabled,expected_revision,rate_bps,rule_id'
      || typeof row.rule_id !== 'string' || !/^[1-9]\d{0,9}$/.test(row.rule_id)) throw Error('referral_rule_update_invalid')
    return { id: Number(row.rule_id), expectedRevision: row.expected_revision, rateBps: row.rate_bps, enabled: row.enabled }
  })
}

export const referralRuleRoutes: FastifyPluginAsync<ReferralRuleRoutesOptions> = async (app, options) => {
  const contract = createHttpContractValidator(httpRuntimeContracts, ['listReferralRules', 'updateReferralRules'])
  app.get('/rules', async (request, reply) => {
    reply.header('Cache-Control', 'no-store')
    try {
      const actor = await options.auth.authenticate(request)
      if (Object.keys(request.query as object).length) throw Error('referral_rule_update_invalid')
      contract.request('listReferralRules', request)
      const rules = await options.service.list(actor)
      return contract.response('listReferralRules', { data: { rules: rules.map(rule => ({ rule_id: rule.id, plan: rule.plan, period: rule.period,
        rate_bps: rule.rateBps, enabled: rule.enabled, revision: rule.revision })) },
        meta: { request_id: request.id, generated_at: new Date().toISOString() } })
    } catch (error) {
      return failure(error, request.id, reply, contract, 'listReferralRules')
    }
  })
  app.put<{ Body: unknown }>('/rules', async (request, reply) => {
    reply.header('Cache-Control', 'no-store')
    try {
      const actor = await options.auth.assertWrite(request)
      const key = request.headers['idempotency-key']
      if (typeof key !== 'string' || Object.keys(request.query as object).length) throw Error('referral_rule_update_invalid')
      try { contract.request('updateReferralRules', request) } catch { throw Error('referral_rule_update_invalid') }
      const result = await options.service.update(actor, key, changesFromBody(request.body))
      try { return contract.response('updateReferralRules', { data: { rules: result.rules.map(rule => ({ rule_id: String(rule.id), revision: rule.revision })), replayed: result.replayed },
        meta: { request_id: request.id, generated_at: new Date().toISOString() } }) }
      catch { throw Error('referral_rule_commit_unknown') }
    } catch (error) {
      return failure(error, request.id, reply, contract, 'updateReferralRules')
    }
  })
}

function failure(error: unknown, id: string, reply: FastifyReply,
  contract: ReturnType<typeof createHttpContractValidator>, operation: 'listReferralRules' | 'updateReferralRules') {
  const code = error instanceof AuthError ? error.code : error instanceof Error && Object.hasOwn(statuses, error.message) ? error.message : 'referral_rule_unavailable'
  const status = error instanceof AuthError ? error.status : statuses[code] ?? 503
  const body = { type: `urn:aurum:problem:${code}`, title: '返佣规则请求失败', status, code,
    detail: status === 503 && operation === 'updateReferralRules' ? '暂时无法确认结果，请保留原请求编号和内容。' : '请检查权限、请求内容及规则版本。',
    instance: '/api/v4/admin/referrals/rules', correlation_id: id, retryable: status === 503 }
  try {
    return reply.type('application/problem+json').code(status).send(contract.response(operation, body, status, 'application/problem+json'))
  } catch {
    const fallbackCode = operation === 'updateReferralRules' ? 'referral_rule_commit_unknown' : 'referral_rule_unavailable'
    const fallback = { ...body, type: `urn:aurum:problem:${fallbackCode}`, code: fallbackCode, status: 503,
      detail: '暂时无法确认结果，请保留原请求编号和内容。', correlation_id: randomUUID(), retryable: true }
    return reply.type('application/problem+json').code(503).send(contract.response(operation, fallback, 503, 'application/problem+json'))
  }
}
