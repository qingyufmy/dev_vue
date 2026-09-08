import type { BridgeGatewayRoute, BridgeHistoryResource, BridgeQueryResponseEnvelope } from '../../bridge/index.js'

export interface TradeHistoryCollectionWindow { rangeStartUtcMsc: number; rangeEndUtcMsc: number }

export interface TradeHistoryCollectorRepository {
  begin(route: BridgeGatewayRoute, now: Date): Promise<TradeHistoryCollectionWindow>
  persistPage(route: BridgeGatewayRoute, resource: BridgeHistoryResource, response: BridgeQueryResponseEnvelope, now: Date): Promise<void>
  complete(route: BridgeGatewayRoute, freshThroughUtcMsc: number, now: Date): Promise<void>
  fail(route: BridgeGatewayRoute, code: string, now: Date): Promise<void>
}

export interface TradeHistoryScheduleRepository {
  scheduleDue(limit: number, now: Date): Promise<string[]>
}
