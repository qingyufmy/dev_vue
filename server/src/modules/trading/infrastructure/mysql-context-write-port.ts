import type { Pool } from 'mysql2/promise'
import type { ContextWritePort } from '../application/context-write-port.js'
import { normalizeContextWrite } from '../domain/context-write.js'
import { TradingAccessError } from '../domain/trading.js'
import { MysqlContextCommands } from './mysql-context-commands.js'
import { prepareMysqlContextTarget } from './mysql-context-target.js'

type GatewayLeases = Parameters<typeof prepareMysqlContextTarget>[1]

export function createMysqlContextWritePort(pool: Pool, leases: GatewayLeases): ContextWritePort {
  // A historical replay must not need the old account, channel or external route to still exist.
  // Re-enter the transaction to recheck the active user and digest under the user lock.
  const replay = new MysqlContextCommands(pool, async () => {
    throw new TradingAccessError('trading_context_write_failed', 503)
  })
  return {
    async execute(input) {
      const command = Object.freeze(normalizeContextWrite(input))
      try {
        if (await replay.receipt(command.userId, command.requestId)) return await replay.execute(command)
        const resolve = await prepareMysqlContextTarget(pool, leases, command)
        return await new MysqlContextCommands(pool, resolve).execute(command)
      } catch (error) {
        if (error instanceof TradingAccessError) throw error
        throw new TradingAccessError('trading_context_write_failed', 503)
      }
    },
    async receipt(userId, requestId) {
      try { return await replay.receipt(userId, requestId) }
      catch (error) {
        if (error instanceof TradingAccessError) throw error
        throw new TradingAccessError('trading_context_receipt_unavailable', 503)
      }
    },
  }
}
