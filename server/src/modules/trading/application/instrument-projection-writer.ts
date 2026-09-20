import type { TrustedBridgeProjectionRoute } from './trading-ports.js'

export interface InstrumentProjectionWrite {
  route: TrustedBridgeProjectionRoute & {
    connectionId: string; installationId: string; credentialGeneration: number; ownershipRevision: string
    brokerServer: string; login: string
  }
  symbol: string
  requestedSymbol?: string
  raw: Record<string, unknown>
  observedAt: string
  sourceRevision: string
  expectedRevision: number
  collectionLease?: { requestId: string; leaseToken: string }
}
export interface InstrumentProjectionWriter {
  write(input: InstrumentProjectionWrite): Promise<{ applied: boolean; revision: number }>
}
