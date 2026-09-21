import { resolveMarketSymbol } from '../domain/market-symbol.js'
import type { TradingService } from './trading-service.js'
import type { TerminalMarketReader } from './terminal-market-reader.js'
import { assertSymbol, TradingAccessError, type MarketCandle, type Timeframe } from '../domain/trading.js'
const minutes: Record<string, number> = { M1: 1, M5: 5, M15: 15, M30: 30, H1: 60, H4: 240, D1: 1440 }
export interface TerminalChanChartCalculator {
 historyTarget(timeframe: string): number
 calculate(input: { accountId: string; platform: 'mt4' | 'mt5'; timeframe: string; candles: readonly MarketCandle[]; referenceTime: string; includeDeveloping: boolean }): unknown
}
export class TerminalMarketService {
 constructor(private readonly accounts: Pick<TradingService, 'ownedAccount'>, private readonly reader: TerminalMarketReader,
  private readonly chanChart?: TerminalChanChartCalculator,
  private readonly wait = (milliseconds: number) => new Promise<void>(resolve => setTimeout(resolve, milliseconds))) {}
 private async read(userId: number, accountId: string, input: Parameters<TerminalMarketReader['read']>[2]) {
  for (let attempt = 0; ; attempt += 1) {
   try { return await this.reader.read(userId, accountId, input) }
   catch (error) {
    if (!(error instanceof TradingAccessError) || error.code !== 'terminal_market_busy' || attempt >= 4) throw error
    await this.wait(150 * (attempt + 1))
   }
  }
 }
 async symbols(userId: number, accountId: string, cursor: string | null) {
  await this.accounts.ownedAccount(userId, accountId)
  if (cursor !== null && !/^[0-9]{1,5}$/.test(cursor)) invalid()
  const pages: Record<string, unknown>[] = []
  let next: string | null = null, observedAt = Date.now()
  const deadline = Date.now() + 20_000
  do {
   const page = await this.read(userId, accountId, { kind: 'symbols', symbol: null, timeframe: null, before: null, limit: 500, cursor: next })
   if (page.nextCursor !== null && page.nextCursor === next || pages.length + page.items.length > 5000 || Date.now() > deadline) invalid()
   pages.push(...page.items); next = page.nextCursor; observedAt = Math.min(observedAt, page.observedAt)
  } while (next !== null)
  const page = { items: pages, nextCursor: null, observedAt }
  const items = page.items.map(row => {
   const symbol = assertSymbol(String(row.symbol ?? ''))
   if (typeof row.selected !== 'boolean' || typeof row.visible !== 'boolean') invalid()
   return { symbol, description: typeof row.description === 'string' ? row.description.slice(0, 256) : '', selected: row.selected, visible: row.visible,
    trade_mode: typeof row.trade_mode === 'number' && Number.isInteger(row.trade_mode) && row.trade_mode >= 0 && row.trade_mode <= 4 ? row.trade_mode : null,
    currency_base: typeof row.currency_base === 'string' ? row.currency_base.slice(0, 16) : null, currency_profit: typeof row.currency_profit === 'string' ? row.currency_profit.slice(0, 16) : null }
  })
  if (new Set(items.map(item => item.symbol)).size !== items.length) invalid()
  await this.accounts.ownedAccount(userId, accountId)
  return { items, next_cursor: page.nextCursor, observed_at: new Date(page.observedAt).toISOString() }
 }
 async candles(userId: number, accountId: string, symbol: string, timeframe: string, before: number, limit: number) {
  await this.accounts.ownedAccount(userId, accountId); symbol = assertSymbol(symbol)
  const directory = await this.symbols(userId, accountId, null)
  const actualSymbol = resolveMarketSymbol(symbol, directory.items)
  if (!actualSymbol) invalid()
  const instrument = await this.read(userId, accountId, { kind: 'instrument', symbol: actualSymbol, timeframe: null, before: null, limit: 1, cursor: null })
  const identity = instrument.items[0]?.symbol ?? instrument.items[0]?.name
  if (instrument.items.length !== 1 || identity !== actualSymbol || instrument.nextCursor !== null) invalid()
  return this.resolvedCandles(userId, accountId, actualSymbol, timeframe, before, limit)
 }
 // Internal callers already hold a selected, instrument-verified broker symbol.
 async resolvedCandles(userId: number, accountId: string, symbol: string, timeframe: string, before: number, limit: number) {
  const account = await this.accounts.ownedAccount(userId, accountId); symbol = assertSymbol(symbol)
  if (!Object.hasOwn(minutes, timeframe) || !Number.isSafeInteger(before) || before <= 0 || before > Date.now() + 15_000 || !Number.isInteger(limit) || limit < 2 || limit > 500) invalid()
  const start = before - minutes[timeframe]! * 60_000 * (limit - 1)
  if (start < 1) invalid()
  const page = await this.read(userId, accountId, { kind: 'candles', symbol, timeframe, before, limit, cursor: null })
  if (page.nextCursor !== null) invalid()
  const items = candleItems(accountId, symbol, timeframe, start, before, page)
  if (new Set(items.map(item => item.openTime)).size !== items.length) invalid()
  await this.accounts.ownedAccount(userId, accountId)
  const structureCandles = account.platform && this.chanChart
   ? await this.loadStructureCandles(userId, accountId, symbol, timeframe, before, items)
   : items
  await this.accounts.ownedAccount(userId, accountId)
  const structure = account.platform && this.chanChart ? this.chanChart.calculate({ accountId, platform: account.platform,
   timeframe, candles: structureCandles, referenceTime: new Date(before).toISOString(), includeDeveloping: Date.now() - before <= 30_000 }) : null
  return { items, before: start, structure }
 }

 private async loadStructureCandles(userId: number, accountId: string, symbol: string, timeframe: string, before: number,
  displayItems: readonly MarketCandle[]) {
  const target = Math.max(0, Math.trunc(this.chanChart?.historyTarget(timeframe) ?? 0))
  if (target < 30 || displayItems.filter(item => item.closed).length >= target) return [...displayItems]
  const duration = minutes[timeframe]! * 60_000
  const collected = new Map(displayItems.map(item => [item.openTime, item]))
  let pageBefore = displayItems.length > 0 ? Date.parse(displayItems[0]!.openTime) : before
  // A target is at most 2,000 today. Twelve bounded pages leave room for
  // weekend/session gaps without changing the Bridge's 500-row contract.
  for (let pageNumber = 0; pageNumber < 12 && [...collected.values()].filter(item => item.closed).length < target; pageNumber += 1) {
   const remaining = target + 1 - collected.size
   const pageLimit = Math.min(500, Math.max(2, remaining))
   const rangeStart = pageBefore - duration * (pageLimit - 1)
   if (rangeStart < 1) break
   const page = await this.read(userId, accountId, { kind: 'candles', symbol, timeframe, before: pageBefore, limit: pageLimit, cursor: null })
   if (page.nextCursor !== null) invalid()
   const olderItems = candleItems(accountId, symbol, timeframe, rangeStart, pageBefore, page)
   for (const item of olderItems) collected.set(item.openTime, item)
   pageBefore = olderItems.length > 0 ? Date.parse(olderItems[0]!.openTime) : rangeStart
  }
  return [...collected.values()].sort((a, b) => a.openTime.localeCompare(b.openTime)).slice(-(target + 1))
 }
}

function candleItems(accountId: string, symbol: string, timeframe: string, start: number, before: number,
 page: { items: Record<string, unknown>[]; observedAt: number }): MarketCandle[] {
 return page.items.map(row => {
  if (row.symbol !== symbol || row.timeframe !== timeframe || !Number.isSafeInteger(row.open_time_utc_msc) || Number(row.open_time_utc_msc) < start || Number(row.open_time_utc_msc) >= before || typeof row.closed !== 'boolean') invalid()
  const open = decimal(row.open), high = decimal(row.high), low = decimal(row.low), close = decimal(row.close)
  if (Number(high) < Math.max(Number(open), Number(close)) || Number(low) > Math.min(Number(open), Number(close)) || !Number.isSafeInteger(row.tick_volume) || Number(row.tick_volume) < 0) invalid()
  return { accountId, symbol, timeframe: timeframe as Timeframe, openTime: new Date(Number(row.open_time_utc_msc)).toISOString(), open, high, low, close, tickVolume: String(row.tick_volume), closed: row.closed, revision: page.observedAt }
 }).sort((a, b) => a.openTime.localeCompare(b.openTime))
}
function decimal(value: unknown): string { const number = Number(value); if ((typeof value !== 'number' && typeof value !== 'string') || !Number.isFinite(number) || number <= 0 || number >= 1e16) invalid(); return number.toFixed(8).replace(/\.?0+$/, '') }
function invalid(): never { throw new TradingAccessError('terminal_market_data_invalid', 503) }
