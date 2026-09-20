export interface TerminalMarketReadInput { kind: 'symbols' | 'candles' | 'instrument'; symbol: string | null; timeframe: string | null; before: number | null; limit: number; cursor: string | null }
export interface TerminalMarketReadPage { items: Record<string, unknown>[]; nextCursor: string | null; observedAt: number }
export interface TerminalMarketReader { read(userId: number, accountId: string, input: TerminalMarketReadInput): Promise<TerminalMarketReadPage> }
