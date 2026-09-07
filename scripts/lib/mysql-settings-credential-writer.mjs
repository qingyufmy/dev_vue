import { canonical, requireBackfill as check } from './v4-backfill-contract.mjs'
import { prepareCredentialSettingsRows } from './v4-settings-credential-rows.mjs'
import { inspectWallClock } from './v4-identity-time.mjs'

export const settingsTargetFields = Object.freeze(['id','namespace','setting_key','value_type','value_text','sensitivity','label','sort_order','created_at_utc','updated_at_utc','revision','origin','migration_run_id','source_sha256','imported_at_utc'])
const integerFields = ['id','sort_order','revision']
const timeFields = ['created_at_utc','updated_at_utc','imported_at_utc']
const sourceProjection = "CAST(id AS CHAR) id,category,`key`,value,label,CAST(sort_order AS CHAR) sort_order,DATE_FORMAT(created_at,'%Y-%m-%d %H:%i:%s.%f') created_at,DATE_FORMAT(updated_at,'%Y-%m-%d %H:%i:%s.%f') updated_at"
const sourceValue = row => ({...row,created_at:inspectWallClock(row.created_at).canonicalWallClock,updated_at:inspectWallClock(row.updated_at).canonicalWallClock})
const projection = settingsTargetFields.map(field => integerFields.includes(field) ? `CAST(${field} AS CHAR) ${field}`
  : timeFields.includes(field) ? `DATE_FORMAT(${field},'%Y-%m-%d %H:%i:%s.%f') ${field}` : field).join(',')

// Caller owns the transaction and migration admission. This primitive neither
// commits nor creates receipts, maps, source evidence, notifications or grants.
export function createCredentialSettingsWriter(rows, options) {
  const prepared = prepareCredentialSettingsRows(rows, options)
  const sourceRows = new Map(rows.map(row => [row.id, canonical(sourceValue(structuredClone(row)))]))
  const expected = new Map(prepared.entries.map(entry => [entry.sourceId, canonical(entry)]))
  return { prepared: structuredClone(prepared), async write(connection, entry, { verifyOnly = false } = {}) {
    check(expected.get(entry.sourceId) === canonical(entry), 'settings_writer_input_changed')
    const [parents] = await connection.execute(`SELECT ${sourceProjection} FROM system_config WHERE id=? FOR UPDATE`, [entry.sourceId])
    check(parents.length === 1 && canonical(sourceValue({ ...parents[0] })) === sourceRows.get(entry.sourceId), 'settings_writer_source_changed')
    const read = async () => {
      const [saved] = await connection.execute(`SELECT ${projection} FROM system_settings WHERE id=? FOR UPDATE`, [entry.target.id])
      check(saved.length <= 1, 'settings_writer_duplicate')
      if (!saved.length) return null
      const value = { ...saved[0] }
      for (const field of timeFields) value[field] = inspectWallClock(value[field]).canonicalWallClock
      return value
    }
    const current = await read()
    if (current) {
      check(canonical(current) === canonical(entry.target), 'settings_writer_target_conflict')
      return { applied: false, targetHash: entry.targetHash }
    }
    check(!verifyOnly, 'settings_writer_not_committed')
    await connection.execute(`INSERT INTO system_settings (${settingsTargetFields.join(',')}) VALUES (${settingsTargetFields.map(() => '?').join(',')})`, settingsTargetFields.map(field => entry.target[field]))
    check(canonical(await read()) === canonical(entry.target), 'settings_writer_readback_mismatch')
    return { applied: true, targetHash: entry.targetHash }
  } }
}
