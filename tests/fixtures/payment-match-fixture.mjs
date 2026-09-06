import { hash } from '../../scripts/lib/v4-backfill-contract.mjs'
import { paymentOrderFields } from '../../scripts/lib/v4-payment-order-source.mjs'
export function paymentMatchFixture({ userId = '2', orderTargetId = '10', matchTargetId = '20' } = {}) {
  const order = { ...Object.fromEntries(Object.entries(paymentOrderFields).map(([key, [, nullable]]) => [key, nullable ? null : '0'])),
    id: '1', user_id: userId, order_no: 'old', order_id: 'external', plan: 'plus', status: 'expired', currency: 'USD', amount: '1', amount_confirmed: '1',
    referral_credit_applied: '0', created_at: '2026-09-06 12:00:00', crypto_chain: 'TRON', crypto_address: 'address', crypto_amount: '1',
    crypto_expires_at: '2026-09-06 13:00:00' }
  const watch = { id: '3', order_id: 'external', user_id: userId, chain: 'TRON', address: 'address', expected_amount: '1', status: 'expired',
    tx_hash: null, confirmations: '0', required_confirmations: '19', wallet_index: '0', created_at: '2026-09-06 04:00:05', expires_at: order.crypto_expires_at }
  const run = { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', sourceSnapshotId: 'fixture', registeredAtUtc: '2026-09-07T00:00:00.000Z' }
  const catalog = new Map([['time', 'b'.repeat(64)], ['asset', 'c'.repeat(64)]])
  const options = { orderOptions: { run, userIds: new Set([userId]), idMap: new Map([['1', orderTargetId]]), evidenceCatalog: catalog,
    timeBasis: { version: 'payment-order-time/v1', sourceTable: 'orders', sourceHash: hash([order]), sourceSnapshotId: 'fixture', resolutions: [
      { sourceId: '1', sourceHash: hash(order), field: 'created_at', raw: order.created_at, offsetMinutes: 480, evidenceId: 'time', evidenceSha256: 'b'.repeat(64) }] } },
    run, idMap: new Map([['3', matchTargetId]]), evidenceCatalog: catalog, sessionOffset: '+00:00',
    basis: { version: 'payment-match-basis/v1', sourceHash: hash([watch]), sourceSnapshotId: 'fixture', records: [{ sourceId: '3', sourceHash: hash(watch),
      chain: 'TRON', address: 'address', assetContract: 'fixture-contract', assetCode: 'USDT', assetEvidenceId: 'asset', assetEvidenceSha256: 'c'.repeat(64),
      expiresAtRaw: watch.expires_at, offsetMinutes: 480, timeEvidenceId: 'time', timeEvidenceSha256: 'b'.repeat(64) }] } }
  return { order, watch, options }
}
