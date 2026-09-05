import type { Pool, PoolConnection, ResultSetHeader, RowDataPacket } from 'mysql2/promise'
import type { ClaimedOutboxEvent, OutboxRepository } from '../application/outbox-ports.js'

interface OutboxRow extends RowDataPacket {
  id: string | number
  event_id: string
  event_type: ClaimedOutboxEvent['eventType']
  created_at_utc: Date
  payload_json: string | Record<string, unknown>
  attempts: number
}

const supported = "'analysis.requested','analysis.running','analysis.failed','market_analysis.created','trader.requested','trader.running','trader.failed','trade_decision.created','risk.policy.changed','risk.summary.changed','risk.decision.created','risk.manual_release.changed','operation.changed','execution.intent.prepared','execution.distribution.target.requested','bridge.command.queued','trade.history.requested','trade.history.changed','observer.authorization.changed'"

export class MysqlOutboxRepository implements OutboxRepository {
  constructor(private readonly pool: Pool) {}

  async claim(owner: string, limit: number, leaseSeconds: number, now: Date) {
    return transaction(this.pool, async connection => {
      await connection.execute(`UPDATE outbox_events SET status='pending',lease_owner=NULL,lease_expires_at_utc=NULL
        WHERE status='dispatching' AND lease_expires_at_utc<=? AND event_type IN (${supported})`, [now])
      const [rows] = await connection.execute<OutboxRow[]>(`SELECT id,event_id,event_type,payload_json,attempts,created_at_utc
        FROM outbox_events WHERE status='pending' AND available_at_utc<=? AND event_type IN (${supported})
        ORDER BY id LIMIT ${limit} FOR UPDATE SKIP LOCKED`, [now])
      if (rows.length === 0) return []
      const ids = rows.map(row => String(row.id))
      const placeholders = ids.map(() => '?').join(',')
      await connection.execute(`UPDATE outbox_events SET status='dispatching',attempts=attempts+1,
        lease_owner=?,lease_expires_at_utc=DATE_ADD(?,INTERVAL ? SECOND) WHERE id IN (${placeholders})`, [
        owner, now, leaseSeconds, ...ids,
      ])
      return rows.map(row => ({
        id: String(row.id), eventId: row.event_id, eventType: row.event_type, occurredAt: new Date(row.created_at_utc).toISOString(),
        payload: parsePayload(row.payload_json), attempts: Number(row.attempts) + 1,
      }))
    })
  }

  async markDispatched(id: string, owner: string, now: Date) {
    const [result] = await this.pool.execute<ResultSetHeader>(`UPDATE outbox_events
      SET status='dispatched',dispatched_at_utc=?,lease_owner=NULL,lease_expires_at_utc=NULL
      WHERE id=? AND status='dispatching' AND lease_owner=?`, [now, id, owner])
    return result.affectedRows === 1
  }

  async retry(id: string, owner: string, availableAt: Date, dead: boolean) {
    const [result] = await this.pool.execute<ResultSetHeader>(`UPDATE outbox_events
      SET status=?,available_at_utc=?,lease_owner=NULL,lease_expires_at_utc=NULL
      WHERE id=? AND status='dispatching' AND lease_owner=?`, [dead ? 'dead' : 'pending', availableAt, id, owner])
    return result.affectedRows === 1
  }
}

function parsePayload(value: string | Record<string, unknown>) {
  const payload = typeof value === 'string' ? JSON.parse(value) as unknown : value
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('outbox_payload_invalid')
  return payload as Record<string, unknown>
}

async function transaction<T>(pool: Pool, work: (connection: PoolConnection) => Promise<T>) {
  const connection = await pool.getConnection()
  try {
    await connection.beginTransaction()
    const result = await work(connection)
    await connection.commit()
    return result
  } catch (error) {
    await connection.rollback()
    throw error
  } finally {
    connection.release()
  }
}
