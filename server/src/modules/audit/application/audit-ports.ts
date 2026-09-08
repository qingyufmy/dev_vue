import type { AuditEventDetail, AuditEventSummary, AuditFilter, AuditSourceKind, AuditSummary } from '../domain/audit.js'

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

export interface AuditPage {
  items: AuditEventSummary[]
  hasMore: boolean
  summary: AuditSummary
  capturedEnd: string
  nextCursor: string | null
}

export interface AuditReadApi {
  events(userId: number, input: AuditQuery): Promise<AuditPage>
  detail(userId: number, sourceKind: string, sourceId: string): Promise<AuditEventDetail>
}

export interface AuditRepositoryPage { items: AuditEventSummary[]; hasMore: boolean; summary: AuditSummary }
export interface AuditRepository {
  ownsAccount(userId: number, accountId: string): Promise<boolean>
  list(userId: number, filter: AuditFilter): Promise<AuditRepositoryPage>
  find(userId: number, sourceKind: AuditSourceKind, sourceId: string): Promise<AuditEventDetail | null>
}
