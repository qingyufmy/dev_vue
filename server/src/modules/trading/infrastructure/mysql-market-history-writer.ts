import type { Pool } from 'mysql2/promise'
import type { MarketCandle } from '../domain/trading.js'
import type { TerminalFactRoute } from '../application/terminal-fact-route-guard.js'
import { assertTerminalFactRoute } from './mysql-trading-repository.js'

export class MysqlMarketHistoryWriter {
  constructor(private readonly pool: Pool) {}
  async write(route: TerminalFactRoute, items: MarketCandle[]) {
    if (items.some(item => item.accountId !== route.accountId || !item.closed)) throw new Error('market_history_scope_invalid')
    // History never overwrites a newer live candle or creates a live-stream revision.
    for (let offset = 0; offset < items.length; offset += 100) {
      const batch = items.slice(offset, offset + 100)
      const connection = await this.pool.getConnection()
      try {
        await connection.beginTransaction()
        await assertTerminalFactRoute(connection, route)
        await connection.execute(`INSERT INTO market_candles
          (trading_account_id,symbol,timeframe,open_time_utc,open_price,high_price,low_price,close_price,tick_volume,closed,revision)
          VALUES ${batch.map(() => '(?,?,?,?,?,?,?,?,?,?,?)').join(',')}
          ON DUPLICATE KEY UPDATE
          open_price=IF(revision<VALUES(revision),VALUES(open_price),open_price),
          high_price=IF(revision<VALUES(revision),VALUES(high_price),high_price),
          low_price=IF(revision<VALUES(revision),VALUES(low_price),low_price),
          close_price=IF(revision<VALUES(revision),VALUES(close_price),close_price),
          tick_volume=IF(revision<VALUES(revision),VALUES(tick_volume),tick_volume),
          closed=IF(revision<VALUES(revision),VALUES(closed),closed),revision=GREATEST(revision,VALUES(revision))`,
        batch.flatMap(item => [item.accountId, item.symbol, item.timeframe, new Date(item.openTime), item.open,
          item.high, item.low, item.close, item.tickVolume, 1, item.revision]))
        await connection.commit()
      } catch (error) { await connection.rollback(); throw error }
      finally { connection.release() }
    }
  }
}
