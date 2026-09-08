import type { PoolConnection, ResultSetHeader, RowDataPacket } from 'mysql2/promise'
import type { BridgeExactTradeState, ProjectionReservationAbsorber } from '../../trading/index.js'
import { projectionProvesCommandResult } from '../domain/projection-absorption.js'

interface ReservationProjectionRow extends RowDataPacket {
  reservation_id: string; reservation_revision: number; command_id: string; action: string
  params_json: string | Record<string, unknown>; expected_state_json: string | Record<string, unknown> | null; result_json: string | Record<string, unknown> | null
  action_json: string | Record<string, unknown>; completed_at_utc: Date
}

export function createProjectionReservationAbsorber(connection: PoolConnection): ProjectionReservationAbsorber {
  return { absorb: input => absorbProjectedReservations(connection, input.accountId, input.entityKind, input.projectionRevision, input.observedAt, input.states, input.now) }
}

function parsePayload<T>(value: string | object): T { return (typeof value === 'string' ? JSON.parse(value) : value) as T }

async function absorbProjectedReservations(connection: PoolConnection, accountId: string, entityKind: 'position' | 'pending_order', projectionRevision: number,
  observedAt: string, states: BridgeExactTradeState[], now: string) {
  const timestamp = new Date(now)
  if (!Number.isFinite(timestamp.getTime())) throw new Error('projection_absorption_time_invalid')
  const [rows] = await connection.execute<ReservationProjectionRow[]>(`SELECT r.id reservation_id,r.revision reservation_revision,c.id command_id,c.action,
      p.params_json,p.expected_state_json,ip.action_json,cr.result_json,cr.completed_at_utc
    FROM risk_reservations_v4 r
    INNER JOIN execution_intents i ON i.id=r.execution_intent_id AND i.status='succeeded'
    INNER JOIN execution_intent_payloads ip ON ip.execution_intent_id=i.id
    INNER JOIN bridge_commands_v4 c ON c.execution_intent_id=i.id AND c.status='succeeded' AND c.result_sha256 IS NOT NULL
    INNER JOIN bridge_command_payloads_v4 p ON p.bridge_command_id=c.id
    INNER JOIN bridge_command_results_v4 cr ON cr.bridge_command_id=c.id AND cr.result_sha256=c.result_sha256 AND cr.conflict=0
    WHERE r.trading_account_id=? AND r.status='committed' ORDER BY r.id FOR UPDATE`, [accountId])
  const byTicket = new Map(states.map(state => [state.ticket, state]))
  const absorbed: string[] = []
  for (const row of rows) {
    const params = parsePayload<Record<string, unknown>>(row.params_json)
    const expectedState = row.expected_state_json ? parsePayload<BridgeExactTradeState>(row.expected_state_json) : null
    const result = row.result_json ? parsePayload<Record<string, unknown>>(row.result_json) : null
    const sourceAction = parsePayload<{ expectedState?: Record<string, unknown> }>(row.action_json)
    const expectedRevision = Number(sourceAction.expectedState?.[entityKind === 'position' ? 'positionsRevision' : 'pendingOrdersRevision'])
    if (!Number.isSafeInteger(expectedRevision) || projectionRevision <= expectedRevision
      || Date.parse(observedAt) < new Date(row.completed_at_utc).getTime()) continue
    if (!projectionProvesCommandResult({ action: row.action, entityKind, params, expectedState, result, states: byTicket })) continue
    const [update] = await connection.execute<ResultSetHeader>(`UPDATE risk_reservations_v4
      SET status='absorbed',released_at_utc=?,release_reason='trusted_projection_absorbed',updated_at_utc=?,revision=revision+1
      WHERE id=? AND status='committed' AND revision=?`, [timestamp, timestamp, row.reservation_id, row.reservation_revision])
    if (update.affectedRows !== 1) continue
    await connection.execute(`INSERT INTO risk_reservation_events_v4
      (risk_reservation_id,event_type,from_status,to_status,reason_code,from_revision,to_revision,occurred_at_utc)
      VALUES (?,'risk.reservation.absorbed','committed','absorbed','trusted_projection_absorbed',?,?,?)`, [
      row.reservation_id, row.reservation_revision, row.reservation_revision + 1, timestamp,
    ])
    absorbed.push(row.reservation_id)
  }
  return absorbed
}
