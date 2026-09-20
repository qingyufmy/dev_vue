export interface MarketDemandTarget { accountId: string; symbol: string; timeframe: string | null }
export interface MarketDemandLease { renew(): Promise<void>; close(): void }
export interface MarketDemandPublisher { create(userId: number, targets: MarketDemandTarget[]): MarketDemandLease }
