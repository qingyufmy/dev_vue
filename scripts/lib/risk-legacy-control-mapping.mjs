import { createHash } from 'node:crypto'

const sourceFields = ['id', 'global_kill_switch', 'reason', 'changed_by', 'updated_at']

// Legacy DATETIME is explicitly interpreted as UTC, without host timezone conversion.
export function legacyRiskUtc(value) {
  if (typeof value !== 'string') throw Error('risk_legacy_time_invalid')
  const match = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})(?:\.(\d{1,3}))?Z?$/.exec(value)
  if (!match) throw Error('risk_legacy_time_invalid')
  const iso = `${match[1]}T${match[2]}.${(match[3] ?? '').padEnd(3, '0')}Z`
  const date = new Date(iso)
  if (!Number.isFinite(date.getTime()) || date.toISOString() !== iso || Number(match[1].slice(0, 4)) < 1000) {
    throw Error('risk_legacy_time_invalid')
  }
  return iso
}

function integer(value, minimum, maximum) {
  if (!(typeof value === 'number' || typeof value === 'string') || !/^\d+$/.test(String(value))) {
    throw Error('risk_legacy_integer_invalid')
  }
  const number = Number(value)
  if (!Number.isSafeInteger(number) || number < minimum || number > maximum) throw Error('risk_legacy_integer_invalid')
  return number
}

export function mapLegacyRiskControl(rows, existingUserIds) {
  if (!Array.isArray(rows) || rows.length !== 1) throw Error('risk_legacy_control_cardinality')
  const row = rows[0]
  if (!row || Object.keys(row).sort().join(',') !== [...sourceFields].sort().join(',')) {
    throw Error('risk_legacy_control_columns')
  }
  if (integer(row.id, 1, 2147483647) !== 1) throw Error('risk_legacy_control_id')
  const killSwitch = integer(row.global_kill_switch, 0, 1)
  if (row.reason !== null && (typeof row.reason !== 'string' || [...row.reason].length > 1000)) {
    throw Error('risk_legacy_control_reason')
  }
  const actor = row.changed_by === null ? null : integer(row.changed_by, 0, 2147483647)
  // Actor 0 is retained in the source receipt; it is not a fabricated users row.
  const targetActor = actor === 0 ? null : actor
  if (targetActor !== null && !existingUserIds.has(String(targetActor))) throw Error('risk_legacy_control_actor_missing')
  const updatedAt = legacyRiskUtc(row.updated_at)
  const source = Object.fromEntries(sourceFields.map(field => [field, row[field]]))
  const sourceSha256 = createHash('sha256').update(JSON.stringify(source)).digest('hex')
  return {
    kind: 'risk-legacy-control-mapping/v1', source, sourceSha256,
    target: { id: 1, kill_switch: killSwitch, reason: row.reason, changed_by_user_id: targetActor,
      revision: 1, updated_at_utc: updatedAt.replace('T', ' ').slice(0, -1) },
    actorMapping: actor === 0 ? 'legacy_system_zero_to_null' : 'preserved',
  }
}
