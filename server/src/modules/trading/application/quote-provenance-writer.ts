import type { TrustedBridgeProjectionRoute, TradingProjectionWrite } from './trading-ports.js'

export interface QuoteProvenanceWrite {
  readonly route: TrustedBridgeProjectionRoute
  readonly projection: Extract<TradingProjectionWrite, { resource: 'market.quote' }>
  readonly ownership: { readonly intervalId: string; readonly ownershipRevision: string }
}
export interface QuoteProvenanceWriter {
  /** Caller already holds route and projection locks; quote/revision/provenance commit or roll back together. */
  write(input: QuoteProvenanceWrite): Promise<void>
}
