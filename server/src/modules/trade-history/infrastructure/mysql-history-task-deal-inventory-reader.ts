import type { PoolConnection, RowDataPacket } from 'mysql2/promise'
import type { HistoryTaskCoverageReader } from '../application/history-task-coverage-reader.js'
import type { HistoryTaskDealSourceReader } from '../application/history-task-deal-source-reader.js'
import type { HistoryTaskDealInventoryReader, HistoryTaskDealInventoryPageReader } from '../application/history-task-deal-inventory-reader.js'
import { canonicalEvidence, decodeTerminalHistoryPage } from '../domain/terminal-history-projection.js'
import { createMysqlHistoryTaskCoverageReader } from './mysql-history-task-coverage-reader.js'
import { createMysqlHistoryTaskDealSourceReader } from './mysql-history-task-deal-source-reader.js'

interface FactRow extends RowDataPacket { id: string; ticket: string; hash: string; raw: unknown }
type Dependencies = { coverage: HistoryTaskCoverageReader; sources: HistoryTaskDealSourceReader }
export function createMysqlHistoryTaskDealInventoryReader(connection: Pick<PoolConnection,'execute'>, dependencies?:Dependencies):HistoryTaskDealInventoryReader {
  const pages=createMysqlHistoryTaskDealInventoryPageReader(connection,dependencies)
  return { async read(input) {
    const page=await pages.read({...input,afterHash:null,completionHash:null,limit:1000})
    if(page.status!=='inventory_page')return page
    if(page.nextHash!==null)return {status:'unresolved',reason:'inventory_limit'}
    const {nextHash:_,...result}=page
    return {...result,status:'inventory_matched'}
  } }
}
export function createMysqlHistoryTaskDealInventoryPageReader(connection: Pick<PoolConnection,'execute'>,
  dependencies:Dependencies={coverage:createMysqlHistoryTaskCoverageReader(connection),sources:createMysqlHistoryTaskDealSourceReader(connection)}):HistoryTaskDealInventoryPageReader {
  return { async read(input) {
    const scope = structuredClone(input)
    if (!Number.isInteger(scope.limit) || scope.limit < 1 || scope.limit > 1000
      || (scope.afterHash !== null && !/^[a-f0-9]{64}$/.test(scope.afterHash))
      || (scope.completionHash !== null && !/^[a-f0-9]{64}$/.test(scope.completionHash))
      || (scope.afterHash !== null && scope.completionHash === null)) throw Error('history_inventory_cursor_invalid')
    if (scope.route.platform !== 'mt5') return { status: 'unresolved', reason: 'unsupported_platform' }
    const coverage = await dependencies.coverage.read(scope)
    if (coverage.status !== 'provider_asserted') return { status: 'unresolved', reason: 'coverage_unavailable' }
    const resource = coverage.resources.find(item => item.resource === 'history.deals')
    if (!resource?.pageMembership || !resource.historyCoverage) return { status: 'unresolved', reason: 'coverage_unavailable' }
    const allHashes = [...new Set(resource.pageMembership.pages.flatMap(page => page.factHashes))].sort()
    if (allHashes.some(hash => !/^[a-f0-9]{64}$/.test(hash))) throw Error('history_inventory_corrupt')
    if ((scope.completionHash !== null && scope.completionHash !== coverage.completionHash)
      || (scope.afterHash !== null && !allHashes.includes(scope.afterHash))) throw Error('history_inventory_cursor_changed')
    const offset=scope.afterHash === null ? 0 : allHashes.indexOf(scope.afterHash)+1
    const hashes=allHashes.slice(offset,offset+scope.limit),nextHash=offset+hashes.length<allHashes.length?hashes.at(-1)!:null
    const base = { taskId: coverage.taskId, receiptId: coverage.receiptId, completionHash: coverage.completionHash,
      rangeStartUtcMsc: coverage.rangeStartUtcMsc, rangeEndUtcMsc: coverage.rangeEndUtcMsc }
    if (!hashes.length) return { status: 'inventory_page', ...base, facts: [], nextHash }
    const [rows] = await connection.execute<FactRow[]>(`SELECT id,deal_ticket ticket,evidence_sha256 hash,evidence_json raw
      FROM terminal_history_deals_v4 WHERE trading_account_id=? AND platform='mt5'
        AND evidence_sha256 IN (${hashes.map(() => '?').join(',')}) ORDER BY id LIMIT 1001`, [scope.route.accountId, ...hashes])
    if (rows.length !== hashes.length || new Set(rows.map(row => row.hash)).size !== hashes.length
      || new Set(rows.map(row => row.ticket)).size !== rows.length) return { status: 'unresolved', reason: 'inventory_missing' }
    const facts = rows.map(row => {
      try {
        const raw: unknown = typeof row.raw === 'string' ? JSON.parse(row.raw) : row.raw
        if (!raw || typeof raw !== 'object' || Array.isArray(raw) || !hashes.includes(row.hash)
          || canonicalEvidence(raw as Record<string, unknown>).hash !== row.hash) throw Error('invalid')
        const decoded = decodeTerminalHistoryPage('deals', [raw as Record<string, unknown>])[0]
        if (!decoded || decoded.kind !== 'deal' || decoded.ticket !== row.ticket) throw Error('invalid')
        return { id: row.id, ticket: row.ticket, hash: row.hash, raw: raw as Record<string, unknown> }
      } catch { throw Error('history_inventory_corrupt') }
    })
    const sources = await dependencies.sources.read({ ...scope, dealTickets: facts.map(fact => fact.ticket) })
    if (sources.status !== 'source_matched' || sources.taskId !== base.taskId || sources.receiptId !== base.receiptId
      || sources.completionHash !== base.completionHash || sources.deals.length !== facts.length) return { status: 'unresolved', reason: 'inventory_missing' }
    const matched = facts.map(fact => {
      const proof = sources.deals.find(deal => deal.dealId === fact.id && deal.ticket === fact.ticket && deal.factHash === fact.hash)
      if (!proof?.provenanceHashes.length) throw Error('history_inventory_corrupt')
      return { ...fact, provenanceHashes: [...proof.provenanceHashes] }
    })
    return { status: 'inventory_page', ...base, facts: matched, nextHash }
  } }
}
