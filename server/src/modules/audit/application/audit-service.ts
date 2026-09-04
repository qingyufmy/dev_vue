import { assertOpaqueId } from '../../trading/domain/trading.js'
import {
  auditActors, auditCategories, auditFilterKey, auditSourceKinds, auditStatuses, decodeAuditCursor, encodeAuditCursor,
  AuditError, type AuditActor, type AuditCategory, type AuditFilter, type AuditSourceKind, type AuditStatus,
} from '../domain/audit.js'
import type { AuditRepository } from './audit-ports.js'

export interface AuditQuery {
  accountId?: string
  category?: string
  status?: string
  actor?: string
  from?: string
  to?: string
  query?: string
  pageSize?: number
  cursor?: string
}

export class AuditService {
  constructor(private readonly repository: AuditRepository, private readonly now: () => Date = () => new Date()) {}

  async events(userId: number, input: AuditQuery) {
    const filter = normalize(input, this.now())
    if (filter.accountId && !await this.repository.ownsAccount(userId, filter.accountId)) throw new AuditError('audit_account_forbidden', 403)
    const page = await this.repository.list(userId, filter)
    const last = page.items.at(-1)
    return {
      ...page,
      capturedEnd: filter.capturedEnd,
      nextCursor: page.hasMore && last ? encodeAuditCursor({
        version: 1, filterKey: auditFilterKey(filter), capturedEnd: filter.capturedEnd,
        occurredAt: last.occurredAt, sourceKind: last.sourceKind, sourceId: last.sourceId,
      }) : null,
    }
  }

  async detail(userId: number, sourceKind: string, sourceId: string) {
    if (!auditSourceKinds.includes(sourceKind as AuditSourceKind)) throw new AuditError('audit_source_kind_invalid', 400)
    const value = await this.repository.find(userId, sourceKind as AuditSourceKind, validId(sourceId, 'audit_source_id'))
    if (!value) throw new AuditError('audit_event_not_found', 404)
    return value
  }
}

function normalize(input: AuditQuery, now: Date): AuditFilter {
  const cursor = input.cursor ? decodeAuditCursor(input.cursor) : null
  const capturedEnd = cursor?.capturedEnd ?? now.toISOString()
  const toUtc = parseUtc(input.to ?? capturedEnd, 'audit_to_invalid')
  const fromUtc = parseUtc(input.from ?? new Date(new Date(toUtc).getTime() - 7 * 86_400_000).toISOString(), 'audit_from_invalid')
  if (fromUtc > toUtc || toUtc > capturedEnd || new Date(toUtc).getTime() - new Date(fromUtc).getTime() > 90 * 86_400_000) {
    throw new AuditError('audit_range_invalid', 400)
  }
  const requestedPageSize = Number.isFinite(input.pageSize) ? Math.trunc(input.pageSize!) : 50
  const filter: AuditFilter = {
    fromUtc, toUtc, capturedEnd, limit: Math.min(Math.max(requestedPageSize, 1), 100), cursor,
  }
  if (input.accountId) filter.accountId = validId(input.accountId, 'audit_account_id')
  if (input.category) filter.category = oneOf(input.category, auditCategories, 'audit_category_invalid') as AuditCategory
  if (input.status) filter.status = oneOf(input.status, auditStatuses, 'audit_status_invalid') as AuditStatus
  if (input.actor) filter.actor = oneOf(input.actor, auditActors, 'audit_actor_invalid') as AuditActor
  if (input.query) {
    const query = input.query.trim()
    if (!query || query.length > 80 || /[\u0000-\u001f\u007f]/.test(query)) throw new AuditError('audit_query_invalid', 400)
    filter.query = query
  }
  if (cursor && cursor.filterKey !== auditFilterKey(filter)) throw new AuditError('audit_cursor_invalid', 400)
  return filter
}

function validId(value: string, field: string) {
  try { return assertOpaqueId(value, field) }
  catch { throw new AuditError(`${field}_invalid`, 400) }
}
function oneOf(value: string, values: readonly string[], code: string) { if (!values.includes(value)) throw new AuditError(code, 400); return value }
function parseUtc(value: string, code: string) {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value) || Number.isNaN(Date.parse(value))) throw new AuditError(code, 400)
  return new Date(value).toISOString()
}
