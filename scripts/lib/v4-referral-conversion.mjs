import { exactKeys, hash, requireBackfill as check } from './v4-backfill-contract.mjs'
import { representIdentityValue as represent } from './v4-identity-values.mjs'
import { inspectWallClock } from './v4-identity-time.mjs'

export const referralSourceFields = Object.freeze(['id', 'referral_code', 'referred_by', 'referral_credit', 'created_at', 'updated_at'])
const targetFields = ['user_id', 'referral_code', 'referred_by_code', 'referral_credit', 'revision', 'updated_at_utc']
const amount = value => represent(value, 'decimal(20,8)', false)
const units = value => BigInt(amount(value).replace('.', ''))
const sorted = rows => [...rows].sort((a, b) => BigInt(a.id) < BigInt(b.id) ? -1 : 1)

function sourceRows(rows) {
  check(Array.isArray(rows) && rows.length <= 100000, 'referral_scope_invalid')
  const ids = new Set()
  for (const row of rows) {
    exactKeys(row, referralSourceFields)
    represent(row.id, 'int', false)
    check(BigInt(row.id) > 0n && !ids.has(row.id), 'referral_source_identity_invalid')
    ids.add(row.id)
    represent(row.referral_code, 'varchar(50)', true)
    represent(row.referred_by, 'varchar(50)', true)
    amount(row.referral_credit)
    // Preserve these source clocks as evidence; no UTC conversion is inferred.
    inspectWallClock(row.created_at)
    inspectWallClock(row.updated_at)
  }
  return sorted(rows)
}

function registrationTime(value) {
  check(typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value), 'referral_registration_time_invalid')
  return inspectWallClock(value.replace('T', ' ').slice(0, -1)).canonicalWallClock
}

// One row per source user, including zero balances and deleted/anonymized users.
// The caller freezes registeredAtUtc in its run manifest before the first write.
export function convertReferralAccounts(rows, registeredAtUtc) {
  const updatedAt = registrationTime(registeredAtUtc)
  const sources = sourceRows(rows)
  const entries = sources.map(source => ({ sourceHash: hash(source), source: { ...source }, target: {
    user_id: source.id, referral_code: source.referral_code, referred_by_code: source.referred_by,
    referral_credit: amount(source.referral_credit), revision: '1', updated_at_utc: updatedAt,
  } }))
  return { version: 'referral-conversion/v1', registeredAtUtc, sourceHash: hash(sources), entries,
    sourceCount: sources.length, totalCreditUnits: sources.reduce((sum, row) => sum + units(row.referral_credit), 0n).toString(),
    businessWritesEnabled: false }
}

// Independently read target rows are compared with source facts, not writer output.
// Equal global totals cannot hide money transferred between users.
export function reconcileReferralAccounts(rows, actual, registeredAtUtc) {
  const sources = sourceRows(rows), updatedAt = registrationTime(registeredAtUtc)
  check(Array.isArray(actual), 'referral_target_invalid')
  const targets = new Map(), differences = []
  let total = 0n
  for (const row of actual) {
    exactKeys(row, targetFields)
    represent(row.user_id, 'int', false)
    check(BigInt(row.user_id) > 0n && !targets.has(row.user_id), 'referral_target_identity_invalid')
    represent(row.referral_code, 'varchar(50)', true)
    represent(row.referred_by_code, 'varchar(50)', true)
    represent(row.revision, 'bigint unsigned', false)
    const time = inspectWallClock(row.updated_at_utc).canonicalWallClock
    check(time !== null, 'referral_target_time_invalid')
    total += units(row.referral_credit)
    targets.set(row.user_id, { ...row, referral_credit: amount(row.referral_credit), updated_at_utc: time })
  }
  for (const source of sources) {
    const target = targets.get(source.id)
    if (!target) { differences.push({ userId: source.id, field: 'row', code: 'missing' }); continue }
    const facts = { referral_code: source.referral_code, referred_by_code: source.referred_by,
      referral_credit: amount(source.referral_credit), revision: '1', updated_at_utc: updatedAt }
    for (const [field, value] of Object.entries(facts)) {
      if (target[field] !== value) differences.push({ userId: source.id, field, code: 'value_mismatch' })
    }
    targets.delete(source.id)
  }
  for (const id of targets.keys()) differences.push({ userId: id, field: 'row', code: 'unexpected' })
  const sourceTotal = sources.reduce((sum, row) => sum + units(row.referral_credit), 0n)
  return { sourceCount: sources.length, targetCount: actual.length, sourceTotalCreditUnits: sourceTotal.toString(),
    targetTotalCreditUnits: total.toString(), totalMatches: sourceTotal === total,
    rowsMatch: differences.length === 0, differences, businessWritesEnabled: false }
}
