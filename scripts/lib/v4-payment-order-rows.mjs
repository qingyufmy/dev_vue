import { exactKeys, hash, requireBackfill as check } from './v4-backfill-contract.mjs'
import { representIdentityValue as represent } from './v4-identity-values.mjs'
import { inspectWallClock } from './v4-identity-time.mjs'
import { inspectPaymentOrderSources } from './v4-payment-order-source.mjs'
import { inspectOrderCreditConversion, orderCreditFields } from './v4-order-credit-conversion.mjs'

const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value)
const sha = value => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value)

function resolveTimes(inspected, basis, snapshotId, evidenceCatalog) {
  exactKeys(basis, ['version', 'sourceTable', 'sourceHash', 'sourceSnapshotId', 'resolutions'])
  check(basis.version === 'payment-order-time/v1' && basis.sourceTable === 'orders' && basis.sourceHash === inspected.sourceHash
    && basis.sourceSnapshotId === snapshotId && Array.isArray(basis.resolutions) && evidenceCatalog instanceof Map, 'payment_order_time_scope')
  const entries = new Map(inspected.entries.map(e => [e.sourceId, e])), times = new Map()
  for (const resolution of basis.resolutions) {
    exactKeys(resolution, ['sourceId', 'sourceHash', 'field', 'raw', 'offsetMinutes', 'evidenceId', 'evidenceSha256'])
    const entry = entries.get(resolution.sourceId), key = `${resolution.sourceId}:${resolution.field}`
    check(entry && ['created_at', 'paid_at'].includes(resolution.field) && !times.has(key)
      && resolution.sourceHash === entry.sourceHash && resolution.raw !== null && resolution.raw === entry.source[resolution.field], 'payment_order_time_binding')
    check(Number.isInteger(resolution.offsetMinutes) && Math.abs(resolution.offsetMinutes) <= 840
      && typeof resolution.evidenceId === 'string' && /^[A-Za-z0-9_.:-]{1,128}$/.test(resolution.evidenceId)
      && sha(resolution.evidenceSha256) && evidenceCatalog.get(resolution.evidenceId) === resolution.evidenceSha256, 'payment_order_time_evidence')
    const wall = inspectWallClock(resolution.raw).canonicalWallClock
    const utc = new Date(Date.parse(wall.replace(' ', 'T') + 'Z') - resolution.offsetMinutes * 60000).toISOString()
    check(/^\d{4}-/.test(utc) && utc.slice(0, 4) >= '1000' && utc.slice(0, 4) <= '9999', 'payment_order_time_range')
    times.set(key, utc.replace('T', ' ').replace('Z', ''))
  }
  for (const entry of inspected.entries) for (const field of ['created_at', 'paid_at']) {
    if (entry.source[field] !== null) check(times.has(`${entry.sourceId}:${field}`), 'payment_order_time_missing')
  }
  return times
}

// Pure preparation. The calling writer must verify the reviewed evidence files,
// run journal, actual parents, ID maps and all payment-domain gates before DML.
export function preparePaymentOrderRows(rows, { userIds, idMap, run, timeBasis, evidenceCatalog }) {
  exactKeys(run, ['id', 'sourceSnapshotId', 'registeredAtUtc'])
  check(uuid(run.id) && typeof run.sourceSnapshotId === 'string' && run.sourceSnapshotId.length > 0
    && typeof run.registeredAtUtc === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(run.registeredAtUtc), 'payment_order_run_invalid')
  const registered = inspectWallClock(run.registeredAtUtc.replace('T', ' ').slice(0, -1)).canonicalWallClock
  const inspected = inspectPaymentOrderSources(rows, userIds)
  check(inspected.blockers.every(b => b.code === 'historical_time_basis_required'), 'payment_order_source_blocked')
  const credit = inspectOrderCreditConversion(rows.map(row => Object.fromEntries(orderCreditFields.map(key => [key, row[key]]))), userIds)
  check(idMap instanceof Map && idMap.size === rows.length, 'payment_order_id_map_invalid')
  const times = resolveTimes(inspected, timeBasis, run.sourceSnapshotId, evidenceCatalog), targetIds = new Set()
  const entries = inspected.entries.map(entry => {
    const v = entry.exactValues, id = idMap.get(entry.sourceId)
    represent(id, 'bigint unsigned', false)
    check(BigInt(id) > 0n && !targetIds.has(id), 'payment_order_target_id_invalid'); targetIds.add(id)
    const created = times.get(`${entry.sourceId}:created_at`), paid = times.get(`${entry.sourceId}:paid_at`) ?? null
    check(created && (v.status !== 'paid' || paid !== null), 'payment_order_required_time_missing')
    const target = { id, user_id: v.user_id, order_number: v.order_no, external_order_id: v.order_id,
      product_code: v.plan, product_label: v.plan_label, billing_period_code: v.period, billing_period_label: v.period_label,
      order_amount: v.amount, legacy_amount_confirmed: v.amount_confirmed, referral_credit_applied: v.referral_credit_applied,
      currency_code: v.currency, status: v.status, status_label: v.status_label, payment_method_code: v.payment_method,
      created_at_utc: created, paid_at_utc: paid, revision: '1', origin: 'legacy_import', legacy_order_id: v.id,
      migration_run_id: run.id, source_sha256: entry.sourceHash, imported_at_utc: registered }
    return { sourceId: entry.sourceId, sourceHash: entry.sourceHash, target, targetHash: hash(target),
      provenance: { source: entry.source, timeBasisHash: hash(timeBasis) } }
  })
  return { version: 'payment-order-rows/v1', sourceHash: inspected.sourceHash, entries, transformHash: hash(entries),
    unresolvedDependencies: ['payment_matching_and_crypto_fields', 'currency_basis', 'entitlement_reconciliation'],
    creditBlockers: credit.blockers, balanceDeltaOnImport: '0.00000000', businessWritesEnabled: false, fullPaymentConverted: false }
}
