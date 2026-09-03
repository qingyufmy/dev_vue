import { describe, expect, it } from 'vitest'
import { BridgeTradeProjectionDecoder, BridgeV4StreamIngestor, type BridgeGatewayRoute, type BridgeStreamEventEnvelope } from '../src/modules/bridge/index.js'
import { BridgeStreamProjector, type TrustedBridgeProjectionRepository } from '../src/modules/trading/index.js'

const route: BridgeGatewayRoute = {
  userId: 42, accountId: '7', terminalProfileId: 'profile_12345678', terminalInstanceId: 'terminal_12345678',
  brokerServer: 'DPrime-Demo', login: '8950701', connectionEpoch: 2, connectionId: 'connection_12345678', sessionId: 'session_12345678',
}

describe('Stage 12G trusted Bridge stream ingestion', () => {
  it('rejects malformed snapshot items before decoding them', async () => {
    const repository: TrustedBridgeProjectionRepository = { async applyTrustedProjection() { return { applied: true, absorbedReservationIds: [] } } }
    const ingestor = new BridgeV4StreamIngestor(new BridgeTradeProjectionDecoder(), new BridgeStreamProjector(repository, { publish() {} }))
    const value = event(true)
    value.payload.upserts = [null as never]
    await expect(ingestor.ingest(route, value)).rejects.toMatchObject({ code: 'bridge_stream_event_invalid', status: 400 })
  })

  it('requires a full positions snapshot before touching the projection', async () => {
    let decoded = 0; let applied = 0
    const repository: TrustedBridgeProjectionRepository = { async applyTrustedProjection() { applied += 1; return { applied: true, absorbedReservationIds: [] } } }
    const ingestor = new BridgeV4StreamIngestor({ async decode() { decoded += 1; return null } }, new BridgeStreamProjector(repository, { publish() {} }), () => new Date('2026-09-03T09:00:00.000Z'))
    const ack = await ingestor.ingest(route, event(false))
    expect(ack).toMatchObject({ type: 'stream.ack', payload: { status: 'resync_required' } })
    expect(decoded).toBe(0); expect(applied).toBe(0)
  })

  it('ACKs a duplicate only after the trusted repository rejects the old revision', async () => {
    const repository: TrustedBridgeProjectionRepository = { async applyTrustedProjection() { return { applied: false, absorbedReservationIds: [] } } }
    const ingestor = new BridgeV4StreamIngestor({ async decode() { return { resource: 'positions', resourceId: 'open', revision: 9, data: [], tradeStates: [], observedAt: '2026-09-03T09:00:00.000Z' } } },
      new BridgeStreamProjector(repository, { publish() { throw new Error('duplicate_must_not_publish') } }))
    await expect(ingestor.ingest(route, event(true))).resolves.toMatchObject({ payload: { status: 'duplicate', revision: 9 } })
  })

  it('decodes one normalized position into public and exact state without trusting account identity from the payload', async () => {
    const value = event(true)
    value.payload.upserts = [{ ticket: '1001', symbol: 'XAUUSD', direction: 'buy', order_type: 'market', magic: 7,
      volume: '0.10', open_price: '3540.20', current_price: '3541.00', stop_limit_price: null, stop_loss: '3530.00',
      take_profit: '3560.00', expiration_utc_msc: null, profit: '8.00', opened_at_utc_msc: 1_788_423_000_000 }]
    const decoded = await new BridgeTradeProjectionDecoder().decode(route, value)
    expect(decoded).toMatchObject({ resource: 'positions', data: [{ accountId: '7', ticket: '1001' }], tradeStates: [{ magic: 7, open_price: '3540.20' }] })
  })

  it('rejects account identity and unknown fields supplied by the Bridge item', async () => {
    const value = event(true)
    value.payload.upserts = [{ ticket: '1001', symbol: 'XAUUSD', direction: 'buy', order_type: 'market', magic: 7,
      volume: '0.10', open_price: '3540.20', current_price: '3541.00', stop_limit_price: null, stop_loss: null,
      take_profit: null, expiration_utc_msc: null, profit: '8.00', opened_at_utc_msc: 1_788_423_000_000, account_id: '8' }]
    await expect(new BridgeTradeProjectionDecoder().decode(route, value)).rejects.toMatchObject({ code: 'bridge_trade_snapshot_fields_invalid' })
  })
})

function event(fullSnapshot: boolean): BridgeStreamEventEnvelope {
  return { v: 4, message_id: 'stream_12345678', type: 'stream.event', sent_at_utc_msc: 1_788_423_600_000, correlation_id: null,
    route: { terminal_instance_id: route.terminalInstanceId, account_ref: { broker_server: route.brokerServer, login: route.login }, connection_epoch: route.connectionEpoch },
    payload: { subscription_id: 'subscription_12345678', stream: 'positions', revision: 9, base_revision: 0, full_snapshot: fullSnapshot,
      observed_at_utc_msc: 1_788_423_600_000, source_time_msc: null, upserts: [], deletes: [] } }
}
