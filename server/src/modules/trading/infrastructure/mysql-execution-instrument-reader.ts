import type { PoolConnection, RowDataPacket } from 'mysql2/promise'
import type { ExecutionInstrumentReader } from '../application/execution-instrument-reader.js'
import type { TerminalFactRouteGuard } from '../application/terminal-fact-route-guard.js'
import { normalizeInstrumentProjection } from '../domain/instrument-projection.js'
import { executionSourceAvailable } from './mysql-execution-source-evidence.js'
import { sha256Canonical } from '../../../shared/canonical-json.js'

export function createMysqlExecutionInstrumentReader(connection: PoolConnection, guard: TerminalFactRouteGuard): ExecutionInstrumentReader {
  return { async read(input) {
    const scope=structuredClone(input),route=scope.route
    if (!/^[A-Za-z0-9._-]{1,64}$/.test(scope.symbol) || !Number.isSafeInteger(scope.maxInstrumentAgeMs)
      || scope.maxInstrumentAgeMs < 1 || scope.maxInstrumentAgeMs > 300000) return null
    if (!await executionSourceAvailable(connection,guard,route,scope.maxAgeMs)) return null
    const [rows]=await connection.execute<RowDataPacket[]>(`SELECT payload_json,revision,
      DATE_FORMAT(observed_at_utc,'%Y-%m-%dT%H:%i:%s.%fZ') observed_at,
      TIMESTAMPDIFF(MICROSECOND,observed_at_utc,UTC_TIMESTAMP(3)) age_us
      FROM market_instrument_snapshots WHERE trading_account_id=? AND symbol=? LIMIT 2 FOR SHARE`,[route.accountId,scope.symbol])
    const row=rows[0]
    if (rows.length !== 1 || !row || !Number.isSafeInteger(Number(row.revision)) || Number(row.revision) < 1
      || !(typeof row.age_us === 'number' || typeof row.age_us === 'string' && /^-?[0-9]+$/.test(row.age_us))
      || !Number.isSafeInteger(Number(row.age_us)) || Number(row.age_us)<0 || Number(row.age_us)>scope.maxInstrumentAgeMs*1000
      || typeof row.observed_at !== 'string' || !/\.\d{3}000Z$/.test(row.observed_at)) return null
    const observedAt=row.observed_at.replace(/(\.\d{3})000Z$/, '$1Z')
    if (!Number.isFinite(Date.parse(observedAt)) || new Date(observedAt).toISOString() !== observedAt) return null
    let value: unknown=row.payload_json
    try {if(typeof value==='string')value=JSON.parse(value)}catch{return null}
    if (!value || typeof value!=='object' || Array.isArray(value)) return null
    const data=value as Record<string,unknown>,source=data.sourceEvidence
    if (!source || typeof source!=='object' || Array.isArray(source)) return null
    const evidence=source as Record<string,unknown>
    if (evidence.userId!==route.userId || evidence.ownershipRevision!==route.ownershipRevision
      || evidence.terminalProfileId!==route.terminalProfileId || evidence.terminalInstanceId!==route.terminalInstanceId
      || evidence.connectionEpoch!==route.connectionEpoch || evidence.observedAt!==observedAt
      || typeof evidence.sourceRevision!=='string' || evidence.sourceRevision.length<1 || evidence.sourceRevision.length>191) return null
    if (!data.raw || typeof data.raw!=='object' || Array.isArray(data.raw)) return null
    let normalized
    try {normalized=normalizeInstrumentProjection(data.raw as Record<string,unknown>,scope.symbol)}catch{return null}
    // A normalized price cannot silently disagree with its terminal raw fact.
    if (Object.entries(normalized).some(([key,value])=>data[key]===undefined || sha256Canonical(data[key])!==sha256Canonical(value))) return null
    return {accountId:route.accountId,symbol:scope.symbol,point:normalized.point,tickSize:normalized.tickSize,
      volumeMin:normalized.volumeMin,volumeMax:normalized.volumeMax,volumeStep:normalized.volumeStep,
      tradeEnabled:normalized.tradeEnabled,revision:Number(row.revision),observedAt}
  } }
}
