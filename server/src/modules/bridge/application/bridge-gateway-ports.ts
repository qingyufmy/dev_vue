import type { BridgeSessionTicketClaims, BridgeSessionTicketStore } from './bridge-credential-ports.js'
import type { BridgeGatewayRoute, BridgeSessionHelloEnvelope } from '../domain/bridge-gateway.js'

export interface BridgeGatewaySink {
  send(message: unknown): Promise<void> | void
  close(code: number, reason: string): void
}

export interface BridgeGatewayRouteRepository {
  authorizeAndOpen(input: {
    claims: BridgeSessionTicketClaims
    hello: BridgeSessionHelloEnvelope
    connectionId: string
    connectedAt: string
  }): Promise<BridgeGatewayRoute>
  activate(route: BridgeGatewayRoute, activatedAt: string): Promise<void>
  touch(route: BridgeGatewayRoute, seenAt: string): Promise<boolean>
  close(route: BridgeGatewayRoute, reason: string, disconnectedAt: string): Promise<void>
}

/** Capacity is counted per live WebSocket/profile, never per trading account. */
export interface BridgeGatewayLeaseStore {
  claim(input: { route: BridgeGatewayRoute; capacity: number; ttlSeconds: number }): Promise<{ replacedConnectionId: string | null }>
  renew(route: BridgeGatewayRoute, ttlSeconds: number): Promise<boolean>
  release(route: BridgeGatewayRoute): Promise<void>
  current(accountId: string): Promise<BridgeGatewayRoute | null>
}

export interface BridgeGatewayCapacityRepository {
  getPurchasedCapacity(userId: number): Promise<number>
}

export interface BridgeGatewayStreamIngestor {
  ingest(route: BridgeGatewayRoute, message: unknown): Promise<unknown>
}

export interface BridgeGatewayDirectory {
  attach(route: BridgeGatewayRoute, sink: BridgeGatewaySink): void
  detach(connectionId: string): void
  get(connectionId: string): BridgeGatewaySink | null
  replace(connectionId: string, code: number, reason: string): void
}

export interface BridgeGatewayQueryReceiver {
  receive(route: BridgeGatewayRoute, message: unknown): unknown
  cancelConnection(connectionId: string, code?: string): void
}

export type { BridgeSessionTicketStore }
