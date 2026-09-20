import type { PoolConnection, RowDataPacket } from 'mysql2/promise'
import type { OpenPositionLifecycleReader, OpenPositionLifecycleScope } from '../application/open-position-lifecycle-reader.js'
import { reconcileOpenPositionLifecycle } from '../domain/open-position-lifecycle.js'
import { canonicalEvidence, decodeTerminalHistoryPage, type TerminalDealFact } from '../domain/terminal-history-projection.js'

/** No transaction or authorization bypass: assembled only inside the caller's authorized snapshot. */
export function createMysqlOpenPositionLifecycleReader(connection: Pick<PoolConnection, 'execute'>): OpenPositionLifecycleReader {
  return { async read(input: OpenPositionLifecycleScope) {
    const scope = structuredClone(input)
    const id = (value: unknown): value is string => typeof value === 'string' && /^[1-9]\d{0,19}$/.test(value) && BigInt(value) <= 18446744073709551615n
    if (!id(scope.accountId)) throw Error('history_lifecycle_scope_invalid')
    if (scope.positionIdentifier === null) return { status: 'unresolved', reason: 'identifier_missing' }
    if (!id(scope.positionIdentifier) || !Number.isSafeInteger(scope.observedAtUtcMsc) || scope.observedAtUtcMsc <= 0
      || !Number.isFinite(new Date(scope.observedAtUtcMsc).getTime())) throw Error('history_lifecycle_scope_invalid')
    const [rows] = await connection.execute<(RowDataPacket & { deal_ticket: string; occurred_msc: string; evidence_sha256: string; evidence_json: unknown })[]>(
      `SELECT CAST(deal_ticket AS CHAR) deal_ticket,CAST(TIMESTAMPDIFF(MICROSECOND,'1970-01-01 00:00:00',occurred_at_utc) DIV 1000 AS CHAR) occurred_msc,evidence_sha256,evidence_json FROM terminal_history_deals_v4
       WHERE trading_account_id=? AND platform='mt5' AND position_id=? AND occurred_at_utc<=?
       ORDER BY occurred_at_utc,deal_ticket LIMIT 10001`, [scope.accountId, scope.positionIdentifier, new Date(scope.observedAtUtcMsc)])
    if (rows.length > 10000) throw Error('history_lifecycle_limit_exceeded')
    const deals: TerminalDealFact[] = rows.map(row => {
      try {
        const raw: unknown = typeof row.evidence_json === 'string' ? JSON.parse(row.evidence_json) : structuredClone(row.evidence_json)
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)
          || canonicalEvidence(raw as Record<string, unknown>).hash !== row.evidence_sha256) throw Error('invalid')
        const fact = decodeTerminalHistoryPage('deals', [raw as Record<string, unknown>])[0]
        if (!fact || fact.kind !== 'deal' || fact.ticket !== row.deal_ticket || fact.positionId !== scope.positionIdentifier
          || fact.occurredAtUtcMsc !== Number(row.occurred_msc) || fact.occurredAtUtcMsc > scope.observedAtUtcMsc) throw Error('invalid')
        return fact
      } catch { throw Error('history_lifecycle_fact_corrupt') }
    })
    return reconcileOpenPositionLifecycle({ ...scope, deals })
  } }
}
