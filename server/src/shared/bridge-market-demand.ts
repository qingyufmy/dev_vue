export const BRIDGE_MARKET_DEMAND_CHANNEL = 'aurum:v4:bridge:market-demand:1'
export interface BridgeMarketTarget { accountId: string; symbol: string; timeframe: string | null }
export interface BridgeMarketDemand { v: 1; id: string; userId: number; expiresAt: number; targets: BridgeMarketTarget[] }
export function parseBridgeMarketDemand(value: unknown): BridgeMarketDemand | null {
  if (!value || typeof value !== 'object') return null
  const x = value as BridgeMarketDemand
  if (Object.keys(x).sort().join(',') !== 'expiresAt,id,targets,userId,v' || x.v !== 1
    || typeof x.id !== 'string' || !/^[a-zA-Z0-9_-]{8,64}$/.test(x.id)
    || !Number.isSafeInteger(x.userId) || x.userId < 1 || !Number.isSafeInteger(x.expiresAt) || x.expiresAt < 0
    || !Array.isArray(x.targets) || x.targets.length > 16 || x.targets.some(t => !t || typeof t !== 'object'
      || Object.keys(t).sort().join(',') !== 'accountId,symbol,timeframe'
      || typeof t.accountId !== 'string' || !/^[1-9][0-9]{0,19}$/.test(t.accountId)
      || typeof t.symbol !== 'string' || !/^[A-Za-z0-9._-]{1,64}$/.test(t.symbol)
      || (t.timeframe !== null && !['M1','M5','M15','M30','H1','H4','D1'].includes(t.timeframe)))) return null
  return structuredClone(x)
}
