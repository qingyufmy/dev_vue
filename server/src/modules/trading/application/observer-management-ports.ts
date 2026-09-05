export class ObserverManagementError extends Error {
  constructor(readonly code: string, readonly status: number) { super(code) }
}

export interface ObserverSourceConfig {
  displayName: string
  notes: string | null
  tradingAccountId: string | null
  analysisStrategyId: string | null
  status: 'active' | 'disabled'
}

export interface ObserverChannelConfig {
  displayName: string
  sourceId: string | null
  slug: string
  description: string | null
  audience: 'all' | 'plus' | 'pro' | 'assigned'
  active: boolean
  sortOrder: number
}

export type ObserverManagementCommand =
  | { kind: 'source.create'; config: ObserverSourceConfig }
  | { kind: 'source.update'; id: string; expectedRevision: number; config: ObserverSourceConfig }
  | { kind: 'channel.create'; config: ObserverChannelConfig }
  | { kind: 'channel.update'; id: string; expectedRevision: number; config: ObserverChannelConfig }
  | { kind: 'channel.default'; channelId: string | null; expectedRevision: number }
  | { kind: 'access.set'; channelId: string; userId: number; granted: boolean; expectedRevision: number }

export interface ObserverManagementWrite {
  actorUserId: number
  idempotencyKey: string
  requestHash: string
  command: ObserverManagementCommand
}

export interface ObserverManagementResult {
  operation_id: string
  target_id: string
  revision: number
  registry_revision: number
}

export interface ObserverManagementList {
  kind: 'sources' | 'channels' | 'accesses' | 'operations'
  afterId: string | null
  limit: number
  channelId?: string
}

/** Administrator-only DTOs; never reuse them for the observer publication feed. */
export interface ObserverManagementPage {
  items: Record<string, unknown>[]
  next_cursor: string | null
  registry_revision: number
}

export interface ObserverManagementRepository {
  list(actorUserId: number, input: ObserverManagementList): Promise<ObserverManagementPage>
  execute(input: ObserverManagementWrite): Promise<ObserverManagementResult>
}
