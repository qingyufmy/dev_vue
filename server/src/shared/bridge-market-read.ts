export const MARKET_READ_CHANNEL = 'aurum:v4:bridge:market-read:1'
export const MARKET_READ_REPLY = 'aurum:v4:bridge:market-read:reply:'
export interface MarketReadRequest { v: 1; id: string; userId: number; accountId: string; deadline: number; kind: 'symbols' | 'candles' | 'instrument'; symbol: string | null; timeframe: string | null; before: number | null; limit: number; cursor: string | null }
export function parseMarketRead(value: unknown): MarketReadRequest | null {
 if (!value || typeof value !== 'object') return null
 const x = value as MarketReadRequest
 if (Object.keys(x).sort().join(',') !== 'accountId,before,cursor,deadline,id,kind,limit,symbol,timeframe,userId,v'
  || x.v !== 1 || typeof x.id !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(x.id) || !Number.isSafeInteger(x.userId) || x.userId < 1
  || typeof x.accountId !== 'string' || !/^[1-9][0-9]{0,19}$/.test(x.accountId) || !Number.isSafeInteger(x.deadline) || x.deadline < 1
  || !Number.isInteger(x.limit) || x.limit < 1 || x.limit > 500 || x.cursor !== null && (typeof x.cursor !== 'string' || !/^[0-9]{1,5}$/.test(x.cursor))) return null
 if (x.kind === 'symbols') return x.symbol === null && x.timeframe === null && x.before === null ? structuredClone(x) : null
 if (x.kind === 'instrument') return x.limit === 1 && x.cursor === null && x.timeframe === null && x.before === null
  && typeof x.symbol === 'string' && /^[A-Za-z0-9._-]{1,64}$/.test(x.symbol) ? structuredClone(x) : null
 if (x.kind !== 'candles' || x.limit < 2 || x.cursor !== null || typeof x.symbol !== 'string' || !/^[A-Za-z0-9._-]{1,64}$/.test(x.symbol)
  || !['M1','M5','M15','M30','H1','H4','D1'].includes(x.timeframe ?? '') || !Number.isSafeInteger(x.before) || Number(x.before) < 1) return null
 return structuredClone(x)
}
export const MARKET_MINUTES: Record<string, number> = { M1: 1, M5: 5, M15: 15, M30: 30, H1: 60, H4: 240, D1: 1440 }
