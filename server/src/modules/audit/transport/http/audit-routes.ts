import type { FastifyPluginAsync } from 'fastify'
import type { AuditReadApi } from '../../application/audit-ports.js'
import { AuditError, type AuditEventDetail, type AuditEventSummary, type AuditTraceNode } from '../../domain/audit.js'

export interface AuditRequestAuthenticator { authenticate(request: { headers: Record<string, unknown> }): Promise<{ userId: number }> }
export interface AuditRoutesOptions { service: AuditReadApi; auth: AuditRequestAuthenticator }
const response = (requestId: string, data: unknown) => ({ data, meta: { request_id: requestId, generated_at: new Date().toISOString() } })

export const auditRoutes: FastifyPluginAsync<AuditRoutesOptions> = async (fastify, options) => {
  fastify.get<{ Querystring: { account_id?: string; category?: string; status?: string; actor?: string; from?: string; to?: string; q?: string; page_size?: string; cursor?: string } }>('/audit/events', async (request, reply) => {
    try {
      const { userId } = await options.auth.authenticate(request)
      const result = await options.service.events(userId, {
        ...(request.query.account_id ? { accountId: request.query.account_id } : {}),
        ...(request.query.category ? { category: request.query.category } : {}),
        ...(request.query.status ? { status: request.query.status } : {}),
        ...(request.query.actor ? { actor: request.query.actor } : {}),
        ...(request.query.from ? { from: request.query.from } : {}),
        ...(request.query.to ? { to: request.query.to } : {}),
        ...(request.query.q ? { query: request.query.q } : {}),
        ...(request.query.cursor ? { cursor: request.query.cursor } : {}),
        pageSize: Number(request.query.page_size ?? 50),
      })
      return response(request.id, {
        captured_end: result.capturedEnd, items: result.items.map(eventDto), next_cursor: result.nextCursor,
        has_more: result.hasMore, summary: { total: result.summary.total, succeeded: result.summary.succeeded,
          rejected: result.summary.rejected, failed: result.summary.failed, uncertain: result.summary.uncertain, active: result.summary.active },
      })
    } catch (error) { return problem(error, request, reply) }
  })

  fastify.get<{ Params: { source_kind: string; source_id: string } }>('/audit/events/:source_kind/:source_id', async (request, reply) => {
    try {
      const { userId } = await options.auth.authenticate(request)
      return response(request.id, detailDto(await options.service.detail(userId, request.params.source_kind, request.params.source_id)))
    } catch (error) { return problem(error, request, reply) }
  })
}

function eventDto(value: AuditEventSummary) {
  return { source_kind: value.sourceKind, source_id: value.sourceId, account_id: value.accountId, category: value.category,
    actor: value.actor, action: value.action, status: value.status, title: value.title, summary: value.summary,
    reason_code: value.reasonCode, symbol: value.symbol, occurred_at: value.occurredAt,
    terminal_timezone_offset_minutes: value.terminalTimezoneOffsetMinutes, correlation_id: value.correlationId }
}
function traceDto(value: AuditTraceNode) { return { stage: value.stage, status: value.status, source_kind: value.sourceKind,
  source_id: value.sourceId, title: value.title, detail: value.detail, reason_code: value.reasonCode, occurred_at: value.occurredAt } }
function detailDto(value: AuditEventDetail) { return { event: eventDto(value.event), trace: value.trace.map(traceDto),
  evidence: value.evidence, links: value.links } }
function problem(error: unknown, request: { id: string; url: string }, reply: { code(status: number): { send(body: unknown): unknown } }) {
  const known = error instanceof AuditError ? error : new AuditError('audit_unavailable', 503)
  return reply.code(known.status).send({ type: `urn:aurum:problem:${known.code}`, title: 'Audit request failed', status: known.status,
    code: known.code, detail: known.code, instance: request.url, correlation_id: request.id, retryable: known.status >= 500 })
}
