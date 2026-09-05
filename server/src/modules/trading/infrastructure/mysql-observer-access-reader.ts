import type { ExecuteValues, Pool, PoolConnection, RowDataPacket } from 'mysql2/promise'
import {
  isPositiveDatabaseId, isValidUserId, type AccountAccessRequest, type PublishedAccountAccessEvidence,
} from '../domain/account-access.js'
import { EvidenceAccountAccessPolicy } from '../application/account-access-policy.js'
import {
  OBSERVER_AUTHORIZATION_TTL_MS, type ObserverAccessReader, type ObserverAuthorization,
} from '../application/observer-ports.js'
import type { ObserverChannelSummary } from '../domain/trading.js'

/** The small SQL surface used by the reader also makes transaction rechecks testable. */
export type ObserverSqlExecutor = Pick<Pool, 'execute'> | PoolConnection

interface ObserverAccessRow extends RowDataPacket {
  channel_id: string | number
  display_name: string
  channel_slug: string | null
  source_id: string | number | null
  source_trading_account_id: string | number | null
  source_account_id: string | number | null
  ownership_revision: string | number | null
  channel_active: number | boolean
  channel_revision: string | number | null
  audience: 'all' | 'plus' | 'pro' | 'assigned' | string | null
  source_revision: string | number | null
  source_status: 'active' | 'disabled' | string | null
  source_configuration_status: 'pending' | 'ready' | string | null
  operator_user_id: number | string | null
  operator_deletion_status: string | null
  operator_deleted_at: Date | string | null
  account_deleted_at: Date | string | null
  viewer_deletion_status: string | null
  viewer_deleted_at: Date | string | null
  viewer_plan: string | null
  viewer_plan_expires_at: Date | string | null
  viewer_token_version: number | string | null
  access_granted_at_utc: Date | string | null
  access_revoked_at_utc: Date | string | null
  access_revision: string | number | null
}

const OBSERVER_SELECT = `
  SELECT CAST(c.id AS CHAR) AS channel_id,c.display_name,
         CAST(c.source_id AS CHAR) AS source_id,
         CAST(c.source_trading_account_id AS CHAR) AS source_trading_account_id,
         c.slug AS channel_slug,
         CAST(s.trading_account_id AS CHAR) AS source_account_id,
         CAST(a.ownership_revision AS CHAR) AS ownership_revision,
         c.active AS channel_active,c.audience,CAST(c.revision AS CHAR) AS channel_revision,
         CAST(s.revision AS CHAR) AS source_revision,s.status AS source_status,
         s.configuration_status AS source_configuration_status,
         s.operator_user_id,
         operator_user.deletion_status AS operator_deletion_status,
         operator_user.deleted_at AS operator_deleted_at,
         a.deleted_at_utc AS account_deleted_at,
         viewer.deletion_status AS viewer_deletion_status,
         viewer.deleted_at AS viewer_deleted_at,
         viewer.plan AS viewer_plan,
         viewer.plan_expires_at AS viewer_plan_expires_at,
         viewer.token_version AS viewer_token_version,
         x.granted_at_utc AS access_granted_at_utc,
         x.revoked_at_utc AS access_revoked_at_utc,
         CAST(x.revision AS CHAR) AS access_revision
    FROM observer_channels c
    INNER JOIN observer_sources s
      ON s.id=c.source_id
     AND s.trading_account_id IS NOT NULL
     AND s.trading_account_id=c.source_trading_account_id
    INNER JOIN trading_accounts a
      ON a.id=s.trading_account_id
     AND a.deleted_at_utc IS NULL
    INNER JOIN users operator_user
      ON operator_user.id=s.operator_user_id
     AND operator_user.deletion_status='active'
     AND operator_user.deleted_at IS NULL
    INNER JOIN users viewer
      ON viewer.id=?
     AND viewer.deletion_status='active'
     AND viewer.deleted_at IS NULL
    LEFT JOIN observer_channel_accesses x
      ON x.observer_channel_id=c.id
     AND x.user_id=viewer.id
   WHERE c.active=1
     AND s.status='active'
     AND s.configuration_status='ready'
     AND c.slug IS NOT NULL
     AND c.slug<>''
     AND EXISTS (
     SELECT 1
       FROM trading_account_ownerships owner_grant
       INNER JOIN trading_account_ownership_intervals owner_interval
         ON owner_interval.id=owner_grant.interval_id
        AND owner_interval.user_id=owner_grant.user_id
        AND owner_interval.trading_account_id=owner_grant.trading_account_id
        AND owner_interval.role='owner'
        AND owner_interval.ended_at_utc IS NULL
        AND owner_interval.started_at_utc=owner_grant.granted_at_utc
        AND owner_interval.started_at_utc<=?
      WHERE owner_grant.trading_account_id=a.id
        AND owner_grant.user_id=s.operator_user_id
        AND owner_grant.role='owner'
        AND owner_grant.revoked_at_utc IS NULL
        AND owner_grant.revision=a.ownership_revision
   )`

const LIST_SQL = `${OBSERVER_SELECT}
     AND c.id>?
   ORDER BY c.id
   LIMIT 100`

const AUTHORIZE_SQL = `${OBSERVER_SELECT}
     AND c.id=?`

export class MysqlObserverAccessReader implements ObserverAccessReader {
  private readonly policy = new EvidenceAccountAccessPolicy()

  constructor(
    private readonly executor: ObserverSqlExecutor,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async list(userId: number): Promise<ObserverChannelSummary[]> {
    if (!isValidUserId(userId)) return []
    const observedAt = this.requestNow()
    if (!observedAt) return []
    const proofs = new Map<string, ObserverAuthorization>()
    let cursor = '0'
    while (true) {
      const [rows] = await this.executor.execute<ObserverAccessRow[]>(LIST_SQL, [userId, observedAt.toISOString(), cursor])
      const completedAt = this.requestNow()
      if (!completedAt || completedAt.getTime() >= observedAt.getTime() + OBSERVER_AUTHORIZATION_TTL_MS) return []
      for (const row of rows) {
        const authorization = this.authorizationFromRow(row, userId, observedAt)
        if (authorization && !proofs.has(authorization.channelId)) proofs.set(authorization.channelId, authorization)
      }
      if (rows.length < 100) break
      const next = String(rows[rows.length - 1]?.channel_id ?? '')
      if (!isPositiveDatabaseId(next) || next === cursor) break
      cursor = next
    }
    const completedAt = this.requestNow()
    if (!completedAt || completedAt.getTime() >= observedAt.getTime() + OBSERVER_AUTHORIZATION_TTL_MS) return []
    return [...proofs.values()]
      .filter(authorization => isExpiryAfter(authorization.expiresAtUtc, completedAt))
      .map(authorization => ({
        id: authorization.channelId,
        displayName: authorization.displayName,
        sourceAccountId: authorization.accountId,
        active: true,
      }))
  }

  async authorize(userId: number, channelId: string, accountId?: string): Promise<ObserverAuthorization | null> {
    return this.authorizeWithExecutor(this.executor, userId, channelId, accountId, false)
  }

  /** Used by context writes so authorization is checked on the transaction connection. */
  async authorizeOn(executor: ObserverSqlExecutor, userId: number, channelId: string, accountId?: string): Promise<ObserverAuthorization | null> {
    return this.authorizeWithExecutor(executor, userId, channelId, accountId, true)
  }

  private async authorizeWithExecutor(executor: ObserverSqlExecutor, userId: number, channelId: string, accountId: string | undefined, lock: boolean): Promise<ObserverAuthorization | null> {
    if (!isValidUserId(userId) || !isPositiveDatabaseId(String(channelId))) return null
    if (accountId !== undefined && !isPositiveDatabaseId(String(accountId))) return null
    const observedAt = this.requestNow()
    if (!observedAt) return null
    const params: ExecuteValues[] = [userId, observedAt.toISOString(), channelId]
    let sql = AUTHORIZE_SQL
    if (accountId !== undefined) {
      sql += ' AND c.source_trading_account_id=?'
      params.push(accountId)
    }
    const [rows] = await executor.execute<ObserverAccessRow[]>(lock ? `${sql} FOR SHARE` : sql, params)
    if (rows.length !== 1) return null
    const authorization = this.authorizationFromRow(rows[0]!, userId, observedAt)
    const completedAt = this.requestNow()
    if (!authorization || !completedAt || !isExpiryAfter(authorization.expiresAtUtc, completedAt)) return null
    return authorization
  }

  private requestNow() {
    const value = this.now()
    return value instanceof Date && Number.isFinite(value.getTime()) ? value : null
  }

  private authorizationFromRow(row: ObserverAccessRow, userId: number, observedAt: Date): ObserverAuthorization | null {
    const channelId = String(row.channel_id)
    const sourceId = String(row.source_id ?? '')
    const accountId = String(row.source_account_id ?? '')
    const ownershipRevision = String(row.ownership_revision ?? '')
    const operatorUserId = Number(row.operator_user_id)
    const sourceRevision = String(row.source_revision ?? '')
    const channelRevision = String(row.channel_revision ?? '')
    if (!isPositiveDatabaseId(channelId) || !isPositiveDatabaseId(sourceId) || !isPositiveDatabaseId(accountId)
      || !isValidUserId(operatorUserId) || !isPositiveDatabaseId(sourceRevision) || !isPositiveDatabaseId(channelRevision)
      || !isPositiveDatabaseId(ownershipRevision)
      || String(row.source_trading_account_id ?? '') !== accountId || row.channel_active !== 1 && row.channel_active !== true
      || typeof row.channel_slug !== 'string' || row.channel_slug.length === 0
      || row.source_status !== 'active' || row.source_configuration_status !== 'ready'
      || row.operator_deletion_status !== 'active' || row.operator_deleted_at !== null
      || row.account_deleted_at !== null || row.viewer_deletion_status !== 'active' || row.viewer_deleted_at !== null
      || typeof row.display_name !== 'string' || row.display_name.length === 0) return null

    const accessRevision = row.access_revision == null ? '0' : String(row.access_revision)
    if (!isPositiveDatabaseId(accessRevision) && accessRevision !== '0') return null
    const tokenVersion = Number(row.viewer_token_version)
    if (!Number.isSafeInteger(tokenVersion) || tokenVersion < 0) return null
    const audience = row.audience
    if (audience !== 'all' && audience !== 'plus' && audience !== 'pro' && audience !== 'assigned') return null

    const nowUtc = observedAt.toISOString()
    const membershipExpiry = sqlDate(row.viewer_plan_expires_at)
    const membershipActive = row.viewer_plan_expires_at == null
      || (membershipExpiry !== null && membershipExpiry.getTime() > observedAt.getTime())
    const effectivePlan = membershipActive ? String(row.viewer_plan ?? 'free') : 'free'
    const hasAccessRow = row.access_revision != null || row.access_granted_at_utc !== null || row.access_revoked_at_utc !== null
    let grant: PublishedAccountAccessEvidence['grant'] = null
    if (hasAccessRow) {
      if (row.access_revision == null || !isPositiveDatabaseId(String(row.access_revision))) return null
      const grantedAt = sqlDate(row.access_granted_at_utc)
      const revokedAt = sqlDate(row.access_revoked_at_utc)
      if (!grantedAt || (row.access_revoked_at_utc !== null && !revokedAt)) return null
      grant = { userId, channelId, grantedAtUtc: grantedAt.toISOString(), revokedAtUtc: revokedAt?.toISOString() ?? null }
    }
    const grantIsActive = grant !== null && grant.revokedAtUtc === null && Date.parse(grant.grantedAtUtc) <= observedAt.getTime()
    const expiresAtMs = (audience === 'plus' || audience === 'pro') && !grantIsActive
      ? Math.min(observedAt.getTime() + OBSERVER_AUTHORIZATION_TTL_MS, membershipExpiry?.getTime() ?? Infinity)
      : observedAt.getTime() + OBSERVER_AUTHORIZATION_TTL_MS
    if (!Number.isFinite(expiresAtMs) || expiresAtMs <= observedAt.getTime()) return null
    const expiresAtUtc = new Date(expiresAtMs).toISOString()

    const request: AccountAccessRequest = { userId, active: true, mode: 'observer', accountId, nowUtc }
    const evidence: PublishedAccountAccessEvidence = {
      accountId, channelId, expectedChannelId: channelId, sourceId, expectedSourceId: sourceId,
      sourceRevision, expectedSourceRevision: sourceRevision,
      sourceActive: true, sourceReady: true, channelActive: true, published: true,
      resource: 'account.metrics', audience, effectivePlan,
      authorizationExpiresAtUtc: expiresAtUtc,
      grant,
    }
    if (!this.policy.canObservePublished(request, evidence)) return null
    return {
      userId, channelId, sourceId, sourceRevision, channelRevision, accessRevision,
      userTokenVersion: tokenVersion, accountId, ownershipRevision, operatorUserId,
      displayName: row.display_name, expiresAtUtc,
    }
  }
}

function isExpiryAfter(value: string, reference: Date) {
  const expiry = Date.parse(value)
  return Number.isFinite(expiry) && expiry > reference.getTime()
}

function sqlDate(value: Date | string | null): Date | null {
  if (value === null) return null
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value : null
  if (typeof value !== 'string' || value.length === 0) return null
  const normalized = value.includes('T') ? value : `${value.replace(' ', 'T')}Z`
  const parsed = new Date(normalized)
  return Number.isFinite(parsed.getTime()) ? parsed : null
}
