import { randomUUID } from 'node:crypto'
import type { Redis } from 'ioredis'
import { MARKET_READ_CHANNEL, MARKET_READ_REPLY, parseMarketRead } from '../../../shared/bridge-market-read.js'
import type { TerminalMarketReader, TerminalMarketReadInput, TerminalMarketReadPage } from '../application/terminal-market-reader.js'
import { TradingAccessError } from '../domain/trading.js'
export class RedisTerminalMarketReader implements TerminalMarketReader {
 private active = 0
 constructor(private readonly redis: Redis) {}
 async read(userId: number, accountId: string, input: TerminalMarketReadInput): Promise<TerminalMarketReadPage> {
  if (this.active >= 32) throw new TradingAccessError('terminal_market_busy', 503)
  const request = parseMarketRead({ ...input, v: 1, id: randomUUID(), userId, accountId, deadline: Date.now() + 20_000 })
  if (!request) throw new TradingAccessError('trading_context_invalid', 400)
  this.active++
  const receiver = this.redis.duplicate({ lazyConnect: true }), key = MARKET_READ_REPLY + request.id
  try {
   await receiver.connect()
   if (!await this.redis.publish(MARKET_READ_CHANNEL, JSON.stringify(request))) throw new TradingAccessError('terminal_market_unavailable', 503)
   const response = await receiver.brpop(key, 21)
   if (!response || response[1].length > 1_048_576) throw new TradingAccessError('terminal_market_timeout', 503)
   const value = JSON.parse(response[1]) as { id?: unknown; error?: unknown; page?: TerminalMarketReadPage }
   if (value.id === request.id && value.error === 'terminal_market_busy') throw new TradingAccessError('terminal_market_busy', 503)
   if (value.id === request.id && value.error === 'terminal_market_symbol_unsupported') throw new TradingAccessError('terminal_market_symbol_unsupported', 503)
   if (value.id !== request.id || value.error || !value.page || !Array.isArray(value.page.items) || value.page.items.length > input.limit
    || value.page.items.some(item => !item || typeof item !== 'object' || Array.isArray(item))
    || !Number.isSafeInteger(value.page.observedAt) || value.page.observedAt < request.deadline - 35_000 || value.page.observedAt > Date.now() + 15_000
    || value.page.nextCursor !== null && (input.kind !== 'symbols' || typeof value.page.nextCursor !== 'string' || !/^[0-9]{1,5}$/.test(value.page.nextCursor))) throw new TradingAccessError('terminal_market_unavailable', 503)
   return value.page
  } finally { receiver.disconnect(); this.active-- }
 }
}
