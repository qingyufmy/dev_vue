import { canonical, exactKeys, requireBackfill as check } from './v4-backfill-contract.mjs'
import { inspectWallClock } from './v4-identity-time.mjs'

const columns = {
  strategies: ['id', 'kind', 'scope', 'owner_user_id', 'name', 'description', 'status', 'active_version_id', 'revision',
    'legacy_source_table', 'legacy_id', 'created_at_utc', 'updated_at_utc', 'deleted_at_utc'],
  strategy_versions: ['id', 'strategy_id', 'version_number', 'prompt_text', 'prompt_sha256', 'input_contract_version',
    'output_contract_version', 'config_json', 'created_by_user_id', 'legacy_source_table', 'legacy_id', 'created_at_utc'],
}
const integers = new Set(['id', 'owner_user_id', 'active_version_id', 'revision', 'strategy_id', 'version_number', 'created_by_user_id'])
const normalize = target => Object.fromEntries(Object.entries(target).map(([field, value]) => [field,
  field.endsWith('_at_utc') ? inspectWallClock(value).canonicalWallClock
    : field === 'config_json' && typeof value === 'string' ? JSON.parse(value) : value]))

// Writes only frozen target projections. The outer backfill transaction owns
// source locking, snapshot/hash checks, ID maps, evidence, commit and recovery.
// This layer never commits, retries or overwrites an existing projection.
export function createStrategyRoleWriter(projections) {
  const expected = new Map()
  for (const projection of projections) {
    exactKeys(projection, ['strategy', 'version'])
    exactKeys(projection.strategy, columns.strategies)
    exactKeys(projection.version, columns.strategy_versions)
    for (const row of [projection.strategy, projection.version]) {
      for (const [field, value] of Object.entries(row)) {
        if (integers.has(field) && value !== null) check(typeof value === 'string' && /^[1-9]\d*$/.test(value), 'strategy_role_writer_integer')
      }
    }
    check(projection.version.strategy_id === projection.strategy.id
      && (projection.strategy.active_version_id === null || projection.strategy.active_version_id === projection.version.id), 'strategy_role_writer_relationship')
    check(!expected.has(projection.strategy.id), 'strategy_role_writer_duplicate')
    expected.set(projection.strategy.id, canonical(projection))
  }
  return { async write(connection, projection, { verifyOnly = false } = {}) {
    projection = structuredClone(projection)
    check(expected.get(projection.strategy.id) === canonical(projection), 'strategy_role_writer_input_changed')
    let inserted = 0
    const read = async (table, target) => {
      const fields = columns[table].map(field => integers.has(field) ? `CAST(${field} AS CHAR) ${field}`
        : field.endsWith('_at_utc') ? `DATE_FORMAT(${field},'%Y-%m-%d %H:%i:%s.%f') ${field}` : field)
      const [rows] = await connection.execute(`SELECT ${fields.join(',')} FROM ${table}
        WHERE id=? OR (legacy_source_table=? AND legacy_id=?) FOR UPDATE`, [target.id, target.legacy_source_table, target.legacy_id])
      check(rows.length <= 1, 'strategy_role_writer_identity_conflict')
      return rows.length ? normalize({ ...rows[0] }) : null
    }
    const matches = (row, target) => check(row && canonical(row) === canonical(normalize(target)), 'strategy_role_writer_target_conflict')
    const insert = async (table, target) => {
      check(!verifyOnly, 'strategy_role_writer_not_committed')
      const fields = columns[table]
      await connection.execute(`INSERT INTO ${table} (${fields.join(',')}) VALUES (${fields.map(() => '?').join(',')})`,
        fields.map(field => field === 'config_json' ? JSON.stringify(normalize(target)[field]) : target[field]))
      inserted++
      matches(await read(table, target), target)
    }
    const current = await read('strategies', projection.strategy)
    if (current) matches(current, projection.strategy)
    else await insert('strategies', { ...projection.strategy, active_version_id: null })
    const version = await read('strategy_versions', projection.version)
    if (version) matches(version, projection.version)
    else await insert('strategy_versions', projection.version)
    if (!current && projection.strategy.active_version_id !== null) {
      await connection.execute('UPDATE strategies SET active_version_id=? WHERE id=? AND active_version_id IS NULL',
        [projection.strategy.active_version_id, projection.strategy.id])
    }
    matches(await read('strategies', projection.strategy), projection.strategy)
    return { inserted, strategyId: projection.strategy.id, versionId: projection.version.id }
  } }
}
