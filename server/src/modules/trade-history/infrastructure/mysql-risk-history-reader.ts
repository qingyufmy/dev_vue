import type { PoolConnection, RowDataPacket } from 'mysql2/promise'
import { createMysqlCompletedHistoryRouteReader } from './mysql-completed-history-route-reader.js'
import { createMysqlHistoryTaskDealInventoryPageReader } from './mysql-history-task-deal-inventory-reader.js'
import { decodeTerminalHistoryPage, type TerminalDealFact } from '../domain/terminal-history-projection.js'
import { readTradeCostEvidence } from '../domain/trade-cost-evidence.js'

/** Reconstruct a continuous verified archive, replacing overlapping windows with newer complete inventories. */
export function createMysqlRiskHistoryReader(connection: PoolConnection) {
  return { async read(scope: { userId: number; accountId: string }) {
    const routes = createMysqlCompletedHistoryRouteReader(connection)
    const pages = createMysqlHistoryTaskDealInventoryPageReader(connection)
    let through = Date.UTC(2000, 0, 1)
    const facts = new Map<string, TerminalDealFact>()
    let latestRoute: Awaited<ReturnType<typeof routes.read>> = null
    for (let count = 0; count < 64; count++) {
      const [rows] = await connection.execute<RowDataPacket[]>(`SELECT id FROM history_collection_tasks_v4
        WHERE trading_account_id=? AND status='succeeded' AND range_start_utc<=? AND range_end_utc>?
        ORDER BY range_end_utc DESC,completed_at_utc DESC,id DESC LIMIT 1`, [scope.accountId, new Date(through), new Date(through)])
      if (!rows.length) return latestRoute ? { route: latestRoute, through, facts: [...facts.values()] } : null
      const taskId = String(rows[0]!.id), route = await routes.read(taskId, scope)
      if (!route || route.platform !== 'mt5' || (latestRoute && (route.ownershipRevision !== latestRoute.ownershipRevision
        || route.terminalInstanceId !== latestRoute.terminalInstanceId || route.terminalProfileId !== latestRoute.terminalProfileId))) return null
      const window: TerminalDealFact[] = []
      let afterHash: string | null = null, completionHash: string | null = null, start = 0, end = 0
      do {
        const page = await pages.read({ taskId, route, afterHash, completionHash, limit: 1000 })
        if (page.status !== 'inventory_page') return null
        start = page.rangeStartUtcMsc; end = page.rangeEndUtcMsc
        if (start > through || end <= through) return null
        for (const item of page.facts) {
          if (!readTradeCostEvidence(JSON.stringify(item.raw), item.hash).complete) return null
          const fact = decodeTerminalHistoryPage('deals', [item.raw])[0]
          if (!fact || fact.kind !== 'deal' || fact.occurredAtUtcMsc < start || fact.occurredAtUtcMsc > end) return null
          window.push(fact)
        }
        if (window.length > 10000) return null
        afterHash = page.nextHash; completionHash = page.completionHash
      } while (afterHash !== null)
      for (const [ticket, fact] of facts) if (fact.occurredAtUtcMsc >= start && fact.occurredAtUtcMsc <= end) facts.delete(ticket)
      for (const fact of window) {
        if (facts.has(fact.ticket)) return null
        facts.set(fact.ticket, fact)
      }
      if (facts.size > 10000) return null
      through = end; latestRoute = route
    }
    return null
  } }
}
