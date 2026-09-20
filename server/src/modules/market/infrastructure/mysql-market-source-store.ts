import type { Pool, ResultSetHeader, RowDataPacket } from 'mysql2/promise'
import type { MarketSourceStore } from '../application/market-source-ports.js'
import { assertMarketSourceScope, marketPoolKey, type MarketSourceScope, type MarketSourceState } from '../domain/market-source.js'

export class MysqlMarketSourceStore implements MarketSourceStore {
  constructor(private readonly pool: Pick<Pool, 'execute'>) {}
  async read(scope: MarketSourceScope): Promise<MarketSourceState | null> {
    assertMarketSourceScope(scope)
    const [rows] = await this.pool.execute<(RowDataPacket & { revision: string; source_generation: string; state_json: string | MarketSourceState })[]>(
      'SELECT CAST(revision AS CHAR) revision,CAST(source_generation AS CHAR) source_generation,state_json FROM market_source_selections WHERE pool_key=? AND standard_symbol=?',
      [marketPoolKey(scope.pool), scope.symbol])
    if (!rows.length) return null
    const row = rows[0]!
    const state = typeof row.state_json === 'string' ? JSON.parse(row.state_json) as MarketSourceState : row.state_json
    if (!state || !Number.isSafeInteger(state.revision) || state.revision < 1 || String(state.revision) !== row.revision
      || !Number.isSafeInteger(state.generation) || state.generation < 1 || String(state.generation) !== row.source_generation
      || !Number.isSafeInteger(state.lastCheckedAt) || state.lastCheckedAt < 1 || !Number.isSafeInteger(state.failures) || state.failures < 0
      || state.firstFailureAt !== null && (!Number.isSafeInteger(state.firstFailureAt) || state.firstFailureAt < 1)
      || state.source !== null && (!state.source || !/^[1-9][0-9]{0,19}$/.test(state.source.accountId)
        || !Number.isSafeInteger(state.source.ownerUserId) || state.source.ownerUserId < 1 || !state.source.connectionId
        || !Number.isSafeInteger(state.source.connectionEpoch) || state.source.connectionEpoch < 1
        || scope.pool.kind === 'private' && state.source.ownerUserId !== scope.pool.userId)
      || state.source === null && state.resolvedSymbol !== null
      || state.source !== null && (typeof state.resolvedSymbol !== 'string' || !state.resolvedSymbol || state.resolvedSymbol.length > 64)) throw new Error('market_source_state_invalid')
    return state
  }
  async compareAndSet(scope: MarketSourceScope, expected: number | null, next: MarketSourceState) {
    assertMarketSourceScope(scope)
    if (next.revision !== (expected ?? 0) + 1 || !Number.isSafeInteger(next.revision) || !Number.isSafeInteger(next.generation) || next.generation < 1) throw new Error('market_source_transition_invalid')
    const keys = [marketPoolKey(scope.pool), scope.symbol]
    if (expected === null) {
      try {
        await this.pool.execute('INSERT INTO market_source_selections (pool_key,standard_symbol,revision,source_generation,state_json,updated_at_utc) VALUES (?,?,?,?,?,UTC_TIMESTAMP(3))',
          [...keys, next.revision, next.generation, JSON.stringify(next)])
        return true
      } catch (error) {
        if ((error as { code?: string }).code === 'ER_DUP_ENTRY') return false
        throw error
      }
    }
    const [result] = await this.pool.execute<ResultSetHeader>('UPDATE market_source_selections SET revision=?,source_generation=?,state_json=?,updated_at_utc=UTC_TIMESTAMP(3) WHERE pool_key=? AND standard_symbol=? AND revision=?',
      [next.revision, next.generation, JSON.stringify(next), ...keys, expected])
    return result.affectedRows === 1
  }
}
