import type { AuditEventDetail, AuditEventSummary, AuditFilter, AuditSourceKind, AuditSummary } from '../domain/audit.js'

export interface AuditRepositoryPage { items: AuditEventSummary[]; hasMore: boolean; summary: AuditSummary }
export interface AuditRepository {
  ownsAccount(userId: number, accountId: string): Promise<boolean>
  list(userId: number, filter: AuditFilter): Promise<AuditRepositoryPage>
  find(userId: number, sourceKind: AuditSourceKind, sourceId: string): Promise<AuditEventDetail | null>
}
