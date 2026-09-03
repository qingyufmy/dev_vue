import type { BridgeGatewayDirectory, BridgeGatewaySink } from './bridge-gateway-ports.js'
import type { BridgeGatewayRoute } from '../domain/bridge-gateway.js'

export class InProcessBridgeGatewayDirectory implements BridgeGatewayDirectory {
  private readonly sinks = new Map<string, BridgeGatewaySink>()

  attach(route: BridgeGatewayRoute, sink: BridgeGatewaySink) { this.sinks.set(route.connectionId, sink) }
  detach(connectionId: string) { this.sinks.delete(connectionId) }
  get(connectionId: string) { return this.sinks.get(connectionId) ?? null }
  replace(connectionId: string, code: number, reason: string) {
    const sink = this.sinks.get(connectionId)
    if (!sink) return
    this.sinks.delete(connectionId)
    sink.close(code, reason)
  }
}
