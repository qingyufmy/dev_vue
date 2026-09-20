import { ref, type Ref } from 'vue'
import type { createApiClient } from '@aurum/api-client'
import type { MarketCandle, TerminalMarketSymbol, Timeframe } from '@aurum/contracts'
export function preferredGoldSymbol(items: TerminalMarketSymbol[]) {
 const gold = items.filter(item => item.trade_mode !== 0 && ((item.currency_base === 'XAU' && item.currency_profit === 'USD') || (!item.currency_profit || item.currency_profit === 'USD') && (/^XAUUSD/i.test(item.symbol) || /^GOLD/i.test(item.symbol))))
 return gold.find(item => item.symbol.toUpperCase() === 'XAUUSD')?.symbol ?? gold.find(item => item.visible)?.symbol ?? gold.find(item => item.selected)?.symbol ?? gold[0]?.symbol ?? null
}
export function createTerminalMarketWorkspace(input: { client: ReturnType<typeof createApiClient>; accountId: Ref<string | null>; symbol: Ref<string>; timeframe: Ref<Timeframe>; candles: Ref<MarketCandle[]>; historyVersion: Ref<number>; owned: () => boolean }) {
 const busy = ref(false), notice = ref(''), directoryNotice = ref('')
 let generation = 0, oldestBoundary: number | null = null, previousScope = ''
 const scope = () => `${input.accountId.value}:${input.symbol.value}:${input.timeframe.value}`
 async function directory(accountId: string) {
  const captured = input.accountId.value
  try { const result = await input.client.getTerminalMarketSymbols(accountId)
   if (captured !== input.accountId.value || accountId !== input.accountId.value || !input.owned()) return null
   directoryNotice.value = ''; return result.data.items
  } catch { if (accountId === input.accountId.value) directoryNotice.value = '暂时无法同步终端品种，可刷新重试'; return null }
 }
 async function window(older = false) {
  if (!input.owned() || !input.accountId.value || !input.symbol.value) return
  const captured = scope()
  if (captured !== previousScope) { previousScope = captured; oldestBoundary = null; generation++; busy.value = false }
  if (busy.value || older && input.candles.value.length >= 2000) return
  const version = ++generation
  const before = older ? oldestBoundary ?? (input.candles.value[0] ? Date.parse(input.candles.value[0].openTime) : Date.now()) : Date.now()
  busy.value = true; notice.value = ''
  try {
   const result = await input.client.getTerminalMarketWindow(input.accountId.value, input.symbol.value, input.timeframe.value, before, 200)
   if (captured !== scope() || version !== generation) return
   const merged = new Map(input.candles.value.map(c => [c.openTime, c]))
   for (const candle of result.data.items) {
    if (candle.accountId !== input.accountId.value || candle.symbol !== input.symbol.value || candle.timeframe !== input.timeframe.value) throw Error('market_scope_changed')
    const existing = merged.get(candle.openTime)
    if (!existing || existing.revision <= candle.revision) merged.set(candle.openTime, candle)
   }
   input.candles.value = [...merged.values()].sort((a,b) => a.openTime.localeCompare(b.openTime)).slice(-2000)
   input.historyVersion.value++
   oldestBoundary = older || oldestBoundary === null ? Number(result.data.before) : oldestBoundary
   if (!result.data.items.length) notice.value = '本时段没有 K 线，可继续向前加载'
  } catch { if (captured === scope() && version === generation) notice.value = '历史行情暂时无法读取，实时行情会继续更新' }
  finally { if (version === generation) busy.value = false }
 }
 function reset() { generation++; previousScope = ''; oldestBoundary = null; busy.value = false; notice.value = ''; directoryNotice.value = '' }
 return { busy, notice, directoryNotice, directory, window, reset }
}
