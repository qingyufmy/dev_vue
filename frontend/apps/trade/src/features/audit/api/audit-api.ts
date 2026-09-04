import { createApiClient } from '@aurum/api-client'
import type { AuditCategory, AuditEventDetail, AuditEventPageResponse, AuditActor, AuditSourceKind, AuditStatus } from '@aurum/contracts'

export type AuditListFilter = {
  accountId?: string
  category?: AuditCategory
  status?: AuditStatus
  actor?: AuditActor
  from?: string
  to?: string
  query?: string
  pageSize?: number
  cursor?: string | null
}

type AuditApiClient = ReturnType<typeof createApiClient> & {
  listAuditEvents: (filter: AuditListFilter) => Promise<AuditEventPageResponse>
  getAuditEvent: (sourceKind: AuditSourceKind, sourceId: string) => Promise<{ data: AuditEventDetail }>
}

const client = createApiClient() as AuditApiClient

export const auditApi = {
  getContext: () => client.getTradingContext(),
  listAccounts: () => client.listTradingAccounts(),
  list: (filter: AuditListFilter) => client.listAuditEvents(filter),
  detail: (sourceKind: AuditSourceKind, sourceId: string) => client.getAuditEvent(sourceKind, sourceId),
}
