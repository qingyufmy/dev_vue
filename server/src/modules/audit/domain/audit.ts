import { createHash } from 'node:crypto'

export const auditSourceKinds = [
  'analysis_run', 'trader_run', 'risk_decision', 'operation', 'bridge_command',
  'risk_policy_change', 'risk_manual_release', 'terminal_trade',
] as const
export type AuditSourceKind = typeof auditSourceKinds[number]

export const auditCategories = ['analysis', 'trading', 'risk', 'execution', 'terminal', 'configuration'] as const
export type AuditCategory = typeof auditCategories[number]
export const auditActors = ['ai', 'user', 'system', 'bridge'] as const
export type AuditActor = typeof auditActors[number]
export const auditStatuses = ['queued', 'running', 'succeeded', 'rejected', 'failed', 'uncertain', 'cancelled', 'info'] as const
export type AuditStatus = typeof auditStatuses[number]

export interface AuditCursor {
  version: 1
  filterKey: string
  capturedEnd: string
  occurredAt: string
  sourceKind: AuditSourceKind
  sourceId: string
}

export interface AuditFilter {
  accountId?: string
  category?: AuditCategory
  status?: AuditStatus
  actor?: AuditActor
  query?: string
  fromUtc: string
  toUtc: string
  capturedEnd: string
  limit: number
  cursor: AuditCursor | null
}

export interface AuditEventSummary {
  sourceKind: AuditSourceKind
  sourceId: string
  accountId: string | null
  category: AuditCategory
  actor: AuditActor
  action: string
  status: AuditStatus
  title: string
  summary: string
  reasonCode: string | null
  symbol: string | null
  occurredAt: string
  terminalTimezoneOffsetMinutes: number | null
  correlationId: string | null
}

export interface AuditSummary {
  total: number
  succeeded: number
  rejected: number
  failed: number
  uncertain: number
  active: number
}

export interface AuditTraceNode {
  stage: 'analysis' | 'trader' | 'risk' | 'operation' | 'intent' | 'bridge' | 'terminal'
  status: AuditStatus
  sourceKind: string
  sourceId: string
  title: string
  detail: string
  reasonCode: string | null
  occurredAt: string
}

export interface AuditEvidenceItem { label: string; value: string }
export interface AuditLink { kind: 'analysis' | 'trader' | 'risk' | 'operation' | 'trade'; id: string; label: string }
export interface AuditEventDetail {
  event: AuditEventSummary
  trace: AuditTraceNode[]
  evidence: AuditEvidenceItem[]
  links: AuditLink[]
}

export class AuditError extends Error {
  constructor(readonly code: string, readonly status: number) {
    super(code)
    this.name = 'AuditError'
  }
}

export function encodeAuditCursor(value: AuditCursor) {
  return Buffer.from(JSON.stringify(value)).toString('base64url')
}

export function decodeAuditCursor(value: string): AuditCursor {
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as Partial<AuditCursor>
    if (parsed.version !== 1 || !parsed.filterKey || !parsed.capturedEnd || !parsed.occurredAt
      || !auditSourceKinds.includes(parsed.sourceKind as AuditSourceKind) || !parsed.sourceId) throw new Error('invalid')
    return parsed as AuditCursor
  } catch {
    throw new AuditError('audit_cursor_invalid', 400)
  }
}

export function auditFilterKey(filter: Pick<AuditFilter, 'accountId' | 'category' | 'status' | 'actor' | 'query' | 'fromUtc' | 'toUtc'>) {
  return createHash('sha256').update(JSON.stringify({
    accountId: filter.accountId ?? null, category: filter.category ?? null, status: filter.status ?? null,
    actor: filter.actor ?? null, query: filter.query ?? null, fromUtc: filter.fromUtc, toUtc: filter.toUtc,
  })).digest('hex')
}
