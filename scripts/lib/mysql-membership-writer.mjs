import { canonical, requireBackfill as check } from './v4-backfill-contract.mjs'
import { prepareMembershipRows } from './v4-membership-rows.mjs'
import { inspectWallClock } from './v4-identity-time.mjs'

export const membershipTargetFields = Object.freeze(['user_id', 'plan_code', 'billing_period_code', 'source_code', 'expiration_kind',
  'expires_at_utc', 'current_state_observed_at_utc', 'revision', 'origin', 'migration_run_id', 'source_sha256', 'imported_at_utc'])
const integerFields = ['user_id', 'revision']
const timeFields = ['expires_at_utc', 'current_state_observed_at_utc', 'imported_at_utc']
const sourceProjection = "CAST(id AS CHAR) id,role,plan,plan_period,plan_source,DATE_FORMAT(plan_expires_at,'%Y-%m-%d %H:%i:%s.%f') plan_expires_at,DATE_FORMAT(updated_at,'%Y-%m-%d %H:%i:%s.%f') updated_at"
const sourceValue = row => ({ ...row, plan_expires_at: inspectWallClock(row.plan_expires_at).canonicalWallClock,
  updated_at: inspectWallClock(row.updated_at).canonicalWallClock })
const projection = membershipTargetFields.map(field => integerFields.includes(field) ? `CAST(${field} AS CHAR) ${field}`
  : timeFields.includes(field) ? `DATE_FORMAT(${field},'%Y-%m-%d %H:%i:%s.%f') ${field}` : field).join(',')

// Caller owns the transaction and migration admission. This primitive neither
// commits nor creates receipts, maps, source evidence, notifications or grants.
export function createMembershipWriter(rows, options) {
  const prepared = prepareMembershipRows(rows, options)
  const expected = new Map(prepared.entries.map(entry => [entry.sourceId, canonical(entry)]))
  return { prepared: structuredClone(prepared), async write(connection, entry, { verifyOnly = false } = {}) {
    check(expected.get(entry.sourceId) === canonical(entry), 'membership_writer_input_changed')
    const [parents] = await connection.execute(`SELECT ${sourceProjection} FROM users WHERE id=? FOR UPDATE`, [entry.sourceId])
    check(parents.length === 1 && canonical(sourceValue({ ...parents[0] })) === canonical(sourceValue(entry.provenance.source)), 'membership_writer_source_changed')
    const read = async () => {
      const [saved] = await connection.execute(`SELECT ${projection} FROM memberships WHERE user_id=? FOR UPDATE`, [entry.target.user_id])
      check(saved.length <= 1, 'membership_writer_duplicate')
      if (!saved.length) return null
      const value = { ...saved[0] }
      for (const field of timeFields) value[field] = inspectWallClock(value[field]).canonicalWallClock
      return value
    }
    const current = await read()
    if (current) {
      check(canonical(current) === canonical(entry.target), 'membership_writer_target_conflict')
      return { applied: false, targetHash: entry.targetHash }
    }
    check(!verifyOnly, 'membership_writer_not_committed')
    await connection.execute(`INSERT INTO memberships (${membershipTargetFields.join(',')}) VALUES (${membershipTargetFields.map(() => '?').join(',')})`, membershipTargetFields.map(field => entry.target[field]))
    check(canonical(await read()) === canonical(entry.target), 'membership_writer_readback_mismatch')
    return { applied: true, targetHash: entry.targetHash }
  } }
}
