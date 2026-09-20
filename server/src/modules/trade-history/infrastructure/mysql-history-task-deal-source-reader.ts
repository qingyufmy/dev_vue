import type { PoolConnection, RowDataPacket } from 'mysql2/promise'
import type { HistoryTaskDealSourceReader } from '../application/history-task-deal-source-reader.js'
import { createMysqlHistoryTaskCoverageReader } from './mysql-history-task-coverage-reader.js'
import { canonicalEvidence, decodeTerminalHistoryPage } from '../domain/terminal-history-projection.js'

function object(input: unknown): Record<string, unknown> {
  const value: unknown = typeof input === 'string' ? JSON.parse(input) : structuredClone(input)
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('invalid')
  return value as Record<string, unknown>
}
interface Row extends RowDataPacket { ticket: string; deal_id: string; fact_json: unknown; fact_hash: string; provenance_json: unknown; provenance_hash: string; occurred_msc: string }
export function createMysqlHistoryTaskDealSourceReader(connection: Pick<PoolConnection, 'execute'>): HistoryTaskDealSourceReader {
  const coverageReader = createMysqlHistoryTaskCoverageReader(connection)
  return { async read(input) {
    const scope = structuredClone(input), r = scope.route
    const id = (v: unknown): v is string => typeof v === 'string' && /^[1-9]\d{0,19}$/.test(v) && BigInt(v) <= 18446744073709551615n
    if (!Array.isArray(scope.dealTickets) || scope.dealTickets.length < 1 || scope.dealTickets.length > 1000
      || !scope.dealTickets.every(id) || new Set(scope.dealTickets).size !== scope.dealTickets.length) throw Error('history_deal_source_scope_invalid')
    if (r.platform !== 'mt5') return {status:'unresolved',reason:'unsupported_platform'}
    const coverage = await coverageReader.read({taskId:scope.taskId,route:r})
    if (coverage.status !== 'provider_asserted') return {status:'unresolved',reason:'coverage_unavailable'}
    const resource = coverage.resources.find(c => c.resource === 'history.deals')
    if (!resource?.historyCoverage) return {status:'unresolved',reason:'coverage_unavailable'}
    if (!resource.pageMembership) return {status:'unresolved',reason:'source_missing'}
    const members = new Set(resource.pageMembership.pages.flatMap(page => page.factHashes.map(hash =>
      JSON.stringify([page.requestId,page.queryMessageId,page.responseMessageId,hash]))))
    const [rows] = await connection.execute<Row[]>(`SELECT d.deal_ticket ticket,d.id deal_id,d.evidence_json fact_json,d.evidence_sha256 fact_hash,
      CAST(TIMESTAMPDIFF(MICROSECOND,'1970-01-01',d.occurred_at_utc) DIV 1000 AS CHAR) occurred_msc,p.provenance_sha256 provenance_hash,
      JSON_OBJECT('version',1,'dealId',p.terminal_history_deal_id,'accountId',CAST(p.trading_account_id AS CHAR),'userId',p.user_id,
        'platform',p.platform,'terminalInstanceId',p.terminal_instance_id,'terminalProfileId',p.terminal_profile_id,
        'brokerServer',p.broker_server,'login',p.account_login,'connectionId',p.connection_id,'connectionEpoch',CAST(p.connection_epoch AS CHAR),
        'ownershipRevision',CAST(p.ownership_revision AS CHAR),'requestId',p.request_id,'queryMessageId',p.query_message_id,
        'responseMessageId',p.response_message_id,'sourceRevision',p.source_revision,'sourceKind',p.source_kind,'factHash',p.fact_sha256,
        'observedAt',CONCAT(LEFT(DATE_FORMAT(p.observed_at_utc,'%Y-%m-%dT%H:%i:%s.%f'),23),'Z')) provenance_json
      FROM terminal_history_deals_v4 d JOIN terminal_history_deal_provenance_v4 p ON p.terminal_history_deal_id=d.id
      WHERE d.trading_account_id=? AND d.platform='mt5' AND d.deal_ticket IN (${scope.dealTickets.map(()=>'?').join(',')})
        AND p.trading_account_id=d.trading_account_id AND p.user_id=? AND p.platform=d.platform
        AND BINARY p.terminal_instance_id=BINARY ? AND BINARY p.terminal_profile_id=BINARY ?
        AND BINARY p.broker_server=BINARY ? AND BINARY p.account_login=BINARY ? AND BINARY p.connection_id=BINARY ?
        AND p.connection_epoch=? AND p.ownership_revision=? AND BINARY p.source_revision=BINARY ? AND p.source_kind=?
        AND d.occurred_at_utc>=? AND d.occurred_at_utc<=? AND p.observed_at_utc>=? AND p.received_at_utc>=p.observed_at_utc
      ORDER BY d.deal_ticket,p.id LIMIT 10001`,[r.accountId,...scope.dealTickets,r.userId,r.terminalInstanceId,r.terminalProfileId,
      r.brokerServer,r.login,r.connectionId,r.connectionEpoch,r.ownershipRevision!,resource.sourceRevision,resource.source,
      new Date(coverage.rangeStartUtcMsc),new Date(coverage.rangeEndUtcMsc),new Date(resource.historyCoverage.collected_at_utc_msc)])
    if (rows.length > 10000) throw Error('history_deal_source_limit_exceeded')
    const found = new Map<string,{ticket:string;dealId:string;factHash:string;provenanceHashes:string[]}>()
    for (const row of rows) {
      try {
        const raw = object(row.fact_json), proof = object(row.provenance_json)
        const fact = decodeTerminalHistoryPage('deals',[raw])[0]
        if (!scope.dealTickets.includes(row.ticket) || canonicalEvidence(raw).hash !== row.fact_hash
          || canonicalEvidence(proof).hash !== row.provenance_hash || proof.factHash !== row.fact_hash || proof.dealId !== row.deal_id
          || !fact || fact.kind !== 'deal' || fact.ticket !== row.ticket || fact.occurredAtUtcMsc !== Number(row.occurred_msc)
          || fact.occurredAtUtcMsc < coverage.rangeStartUtcMsc || fact.occurredAtUtcMsc > coverage.rangeEndUtcMsc) throw Error('invalid')
        if (!members.has(JSON.stringify([proof.requestId,proof.queryMessageId,proof.responseMessageId,row.fact_hash]))) continue
        const previous = found.get(row.ticket)
        if (previous && (previous.dealId !== row.deal_id || previous.factHash !== row.fact_hash)) throw Error('invalid')
        const result = previous ?? {ticket:row.ticket,dealId:row.deal_id,factHash:row.fact_hash,provenanceHashes:[]}
        if (!result.provenanceHashes.includes(row.provenance_hash)) result.provenanceHashes.push(row.provenance_hash)
        found.set(row.ticket,result)
      } catch { throw Error('history_deal_source_corrupt') }
    }
    if (found.size !== scope.dealTickets.length) return {status:'unresolved',reason:'source_missing'}
    return {status:'source_matched',taskId:scope.taskId,receiptId:coverage.receiptId,completionHash:coverage.completionHash,
      deals:scope.dealTickets.map(ticket=>found.get(ticket)!)}
  } }
}
