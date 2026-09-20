import type { PoolConnection, RowDataPacket, ResultSetHeader } from 'mysql2/promise'
import { contentHash, InferenceError, type TraderDecisionResult, type TraderInputSnapshot } from '../domain/inference.js'
import { resolveEntryEventClaims, type EntryEventClaim } from '../domain/entry-event-claims.js'

type Connection = Pick<PoolConnection, 'execute'>
export interface EntryClaimScope { userId: number; accountId: string; strategyId: string }

/** Read the committed trader input again; never trust a caller-supplied catalogue during registration. */
export async function loadEntryEventClaims(db: Connection, scope: EntryClaimScope & { snapshotId: string; strategyVersionId: string }, result: TraderDecisionResult) {
  if (!result.actions.some(action => ['market_order', 'pending_order'].includes(action.kind) || Object.hasOwn(action.parameters, 'entry_event_id'))) return []
  const [rows] = await db.execute<(RowDataPacket & { payload_json: string | TraderInputSnapshot; payload_sha256: string })[]>(
    `SELECT p.payload_json,s.payload_sha256 FROM inference_snapshots s
      INNER JOIN inference_snapshot_payloads p ON p.snapshot_id=s.id AND p.encoding='json'
      WHERE s.id=? AND s.user_id=? AND s.trading_account_id=? AND s.strategy_id=? AND s.strategy_version_id=? AND s.purpose='trader' LIMIT 2`,
    [scope.snapshotId, scope.userId, scope.accountId, scope.strategyId, scope.strategyVersionId])
  if (rows.length !== 1) throw new InferenceError('entry_event_snapshot_missing', 409)
  let snapshot: TraderInputSnapshot
  try { snapshot = typeof rows[0]!.payload_json === 'string' ? JSON.parse(rows[0]!.payload_json) : rows[0]!.payload_json }
  catch { throw new InferenceError('entry_event_snapshot_invalid', 409) }
  if (!snapshot || contentHash(snapshot) !== rows[0]!.payload_sha256 || snapshot.kind !== 'trader'
    || snapshot.account?.id !== scope.accountId || snapshot.strategy?.id !== scope.strategyId || snapshot.strategy.versionId !== scope.strategyVersionId) {
    throw new InferenceError('entry_event_snapshot_invalid', 409)
  }
  const claims = resolveEntryEventClaims(result, snapshot)
  if (claims.length) {
    const coverage = await readEntryEventCoverage(db)
    if (claims.some(claim => Date.parse(claim.confirmedAt) <= Date.parse(coverage))) throw new InferenceError('entry_event_history_unavailable', 422)
  }
  return claims
}

/** Caller already owns the account lock. Reserved and consumed both block a second decision. */
export async function entryEventsOccupied(db: Connection, scope: EntryClaimScope, claims: readonly EntryEventClaim[]) {
  if (!claims.length) return false
  const [rows] = await db.execute<RowDataPacket[]>(`SELECT active_event_id FROM inference_entry_event_claims_v4
    WHERE user_id=? AND trading_account_id=? AND strategy_id=? AND active_event_id IN (${claims.map(() => '?').join(',')}) FOR UPDATE`,
  [scope.userId, scope.accountId, scope.strategyId, ...claims.map(claim => claim.eventId)])
  return rows.length > 0
}

/** Same transaction as the proposed decision and outbox. The unique key is the final backstop. */
export async function reserveEntryEvents(db: Connection, scope: EntryClaimScope, decisionId: string, claims: readonly EntryEventClaim[]) {
  for (const claim of [...claims].sort((a, b) => a.eventId.localeCompare(b.eventId))) {
    await db.execute(`INSERT INTO inference_entry_event_claims_v4
      (decision_id,action_id,user_id,trading_account_id,strategy_id,event_id,active_event_id,state,created_at_utc,updated_at_utc)
      VALUES (?,?,?,?,?,?,?,'reserved',UTC_TIMESTAMP(3),UTC_TIMESTAMP(3))`,
    [decisionId, claim.actionId, scope.userId, scope.accountId, scope.strategyId, claim.eventId, claim.eventId])
  }
}

/** Risk rejection releases only an unexecuted reservation. All later terminal states retain consumed identity. */
export async function settleEntryEvents(db: Connection, input: { decisionId: string; userId: number; accountId: string; riskDecisionId: string; outcome: 'approved' | 'rejected' }) {
  const [decisions] = await db.execute<(RowDataPacket & { payload_json: string | TraderDecisionResult; content_sha256: string })[]>(
    `SELECT p.payload_json,d.content_sha256 FROM trade_decisions d INNER JOIN trade_decision_payloads p ON p.trade_decision_id=d.id
      WHERE d.id=? AND d.user_id=? AND d.trading_account_id=? LIMIT 1`, [input.decisionId, input.userId, input.accountId])
  if (decisions.length !== 1) throw new InferenceError('entry_event_decision_missing', 409)
  const row = decisions[0]!, result: TraderDecisionResult = typeof row.payload_json === 'string' ? JSON.parse(row.payload_json) : row.payload_json
  if (contentHash(result) !== row.content_sha256) throw new InferenceError('entry_event_decision_invalid', 409)
  const expected = result.actions.filter(action => Object.hasOwn(action.parameters, 'entry_event_id'))
  if (!expected.length) return
  const [claims] = await db.execute<(RowDataPacket & { action_id: string; event_id: string; state: string })[]>(
    `SELECT action_id,event_id,state FROM inference_entry_event_claims_v4 WHERE decision_id=? AND user_id=? AND trading_account_id=? FOR UPDATE`,
    [input.decisionId, input.userId, input.accountId])
  if (claims.length !== expected.length || claims.some(claim => claim.state !== 'reserved'
    || !expected.some(action => action.actionId === claim.action_id && action.parameters.entry_event_id === claim.event_id))) {
    throw new InferenceError('entry_event_reservation_conflict', 409)
  }
  const [updated] = await db.execute<ResultSetHeader>(`UPDATE inference_entry_event_claims_v4 SET state=?,
    active_event_id=${input.outcome === 'approved' ? 'event_id' : 'NULL'},risk_decision_id=?,updated_at_utc=UTC_TIMESTAMP(3)
    WHERE decision_id=? AND user_id=? AND trading_account_id=? AND state='reserved'`,
  [input.outcome === 'approved' ? 'consumed' : 'released', input.riskDecisionId, input.decisionId, input.userId, input.accountId])
  if (updated.affectedRows !== expected.length) throw new InferenceError('entry_event_reservation_conflict', 409)
}

/** Before this cutover, no claim row is not proof of an unused historical event. */
export async function readEntryEventCoverage(db: Connection): Promise<string> {
  const [rows] = await db.execute<(RowDataPacket & { completed_at: string })[]>(`SELECT DATE_FORMAT(completed_at_utc,'%Y-%m-%dT%H:%i:%s.%fZ') completed_at
    FROM database_upgrade_steps_v4 WHERE id='inplace_079_01_entry_event_claims' AND status='completed' LIMIT 1`)
  const value = rows[0]?.completed_at?.replace(/(\.\d{3})000Z$/, '$1Z')
  if (rows.length !== 1 || !value || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) {
    throw new InferenceError('entry_event_coverage_unavailable', 409)
  }
  return value
}
