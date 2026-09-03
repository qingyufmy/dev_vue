import type { BridgeProjectionInput, BridgeStreamProjector } from '../../trading/application/bridge-stream-projector.js'
import type { BridgeGatewayRoute } from '../domain/bridge-gateway.js'
import { BridgeGatewayError } from '../domain/bridge-gateway.js'
import type { BridgeGatewayStreamIngestor } from './bridge-gateway-ports.js'

export interface BridgeStreamEventEnvelope {
  v: 4
  message_id: string
  type: 'stream.event'
  sent_at_utc_msc: number
  correlation_id: string | null
  route: {
    terminal_instance_id: string
    account_ref: { broker_server: string; login: string }
    connection_epoch: number
  }
  payload: {
    subscription_id: string
    stream: 'account' | 'positions' | 'pending_orders' | 'quotes' | 'current_candle' | 'terminal.status' | 'terminal.clock'
    revision: number
    base_revision: number
    full_snapshot: boolean
    observed_at_utc_msc: number
    source_time_msc: number | null
    upserts: Record<string, unknown>[]
    deletes: string[]
  }
}

export interface BridgeProjectionDecoder {
  decode(route: BridgeGatewayRoute, event: BridgeStreamEventEnvelope): Promise<BridgeProjectionInput | null>
}

export class BridgeV4StreamIngestor implements BridgeGatewayStreamIngestor {
  constructor(
    private readonly decoder: BridgeProjectionDecoder,
    private readonly projector: BridgeStreamProjector,
    private readonly now = () => new Date(),
  ) {}

  async ingest(route: BridgeGatewayRoute, message: unknown) {
    const event = assertStreamEvent(message)
    if ((event.payload.stream === 'positions' || event.payload.stream === 'pending_orders') && !event.payload.full_snapshot) {
      return streamAck(event, 'resync_required', this.now())
    }
    const projection = await this.decoder.decode(route, event)
    if (!projection) return streamAck(event, 'resync_required', this.now())
    const applied = await this.projector.ingest(route, projection)
    return streamAck(event, applied ? 'applied' : 'duplicate', this.now())
  }
}

function assertStreamEvent(message: unknown): BridgeStreamEventEnvelope {
  if (!message || typeof message !== 'object') throw new BridgeGatewayError('bridge_stream_event_invalid', 400)
  const event = message as BridgeStreamEventEnvelope
  const payload = event.payload
  if (event.v !== 4 || event.type !== 'stream.event' || !opaque(event.message_id) || !payload
    || !opaque(payload.subscription_id) || !['account', 'positions', 'pending_orders', 'quotes', 'current_candle', 'terminal.status', 'terminal.clock'].includes(payload.stream)
    || !Number.isSafeInteger(payload.revision) || payload.revision < 1
    || !Number.isSafeInteger(payload.base_revision) || payload.base_revision < 0
    || typeof payload.full_snapshot !== 'boolean'
    || !Number.isSafeInteger(payload.observed_at_utc_msc) || payload.observed_at_utc_msc < 1
    || (payload.source_time_msc !== null && (!Number.isSafeInteger(payload.source_time_msc) || payload.source_time_msc < 0))
    || !Array.isArray(payload.upserts) || !Array.isArray(payload.deletes)
    || payload.upserts.length > 10_000 || payload.deletes.length > 10_000
    || payload.upserts.some(item => !item || typeof item !== 'object' || Array.isArray(item))
    || payload.deletes.some(item => typeof item !== 'string' || item.length < 1 || item.length > 64)) {
    throw new BridgeGatewayError('bridge_stream_event_invalid', 400)
  }
  return event
}

function opaque(value: unknown) { return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{7,190}$/.test(value) }

function streamAck(event: BridgeStreamEventEnvelope, status: 'applied' | 'duplicate' | 'resync_required', now: Date) {
  return {
    v: 4, message_id: `stream-ack:${event.message_id}`, type: 'stream.ack', sent_at_utc_msc: now.getTime(), correlation_id: event.message_id,
    route: event.route,
    payload: { subscription_id: event.payload.subscription_id, stream: event.payload.stream, revision: event.payload.revision, status },
  }
}
