import { canonical, exactKeys, requireBackfill as check } from './v4-backfill-contract.mjs'
import { inspectWallClock } from './v4-identity-time.mjs'

const definitions = Object.freeze({
  subscription: { table: 'strategy_subscriptions_v4_build', key: 'id', fields: ['id', 'user_id', 'trading_account_id',
    'standard_symbol', 'analysis_strategy_id', 'analysis_strategy_version_id', 'trader_strategy_id', 'trader_strategy_version_id',
    'analysis_enabled', 'trader_enabled', 'trade_send_enabled', 'status', 'revision', 'legacy_source_table', 'legacy_id', 'created_at_utc', 'updated_at_utc'] },
  schedule: { table: 'subscription_schedules_v4_build', key: 'subscription_id', fields: ['subscription_id', 'cadence_seconds',
    'receive_timezone', 'receive_window_json', 'next_due_at_utc', 'revision', 'updated_at_utc'] },
  preferences: { table: 'subscription_execution_preferences_v4_build', key: 'subscription_id', fields: ['subscription_id',
    'contract_version', 'take_profit_mode', 'revision', 'created_at_utc', 'updated_at_utc'] },
})
const ids = new Set(['id', 'user_id', 'trading_account_id', 'analysis_strategy_id', 'analysis_strategy_version_id',
  'trader_strategy_id', 'trader_strategy_version_id', 'subscription_id', 'revision'])
const normalize = row => Object.fromEntries(Object.entries(row).map(([field, value]) => [field,
  field.endsWith('_at_utc') ? inspectWallClock(value).canonicalWallClock
    : field === 'receive_window_json' && typeof value === 'string' ? JSON.parse(value) : value]))

function validate(projection) {
  exactKeys(projection, Object.keys(definitions))
  for (const [kind, definition] of Object.entries(definitions)) {
    const row = projection[kind]
    exactKeys(row, definition.fields)
    for (const [field, value] of Object.entries(row)) {
      if (ids.has(field) && value !== null) check(typeof value === 'string' && /^[1-9]\d{0,19}$/.test(value)
        && BigInt(value) <= (field === 'user_id' ? 2147483647n : 18446744073709551615n), 'subscription_build_writer_integer')
      if (field.endsWith('_at_utc')) {
        check(value === null && field === 'next_due_at_utc' || typeof value === 'string', 'subscription_build_writer_time')
        inspectWallClock(value)
      }
    }
  }
  const { subscription: row, schedule, preferences } = projection
  for (const field of ['id', 'user_id', 'trading_account_id', 'analysis_strategy_id', 'analysis_strategy_version_id', 'revision']) {
    check(row[field] !== null, 'subscription_build_writer_required_id')
  }
  check(schedule.subscription_id === row.id && preferences.subscription_id === row.id
    && schedule.revision !== null && preferences.revision !== null, 'subscription_build_writer_relationship')
  check((row.trader_strategy_id === null) === (row.trader_strategy_version_id === null), 'subscription_build_writer_trader_pair')
  check(typeof row.standard_symbol === 'string' && /^[A-Z0-9][A-Z0-9._-]{0,63}$/.test(row.standard_symbol), 'subscription_build_writer_symbol')
  check(['active', 'paused', 'ended'].includes(row.status), 'subscription_build_writer_status')
  for (const field of ['analysis_enabled', 'trader_enabled', 'trade_send_enabled']) check(row[field] === 0 || row[field] === 1, 'subscription_build_writer_flag')
  check((row.trade_send_enabled === 0 || row.trader_enabled === 1)
    && (row.trader_enabled === 0 || row.trader_strategy_id !== null), 'subscription_build_writer_execution_pair')
  check(row.legacy_source_table === 'strategy_subscriptions' && typeof row.legacy_id === 'string'
    && /^[\x21-\x7e]{1,191}$/.test(row.legacy_id), 'subscription_build_writer_legacy_identity')
  check(Number.isSafeInteger(schedule.cadence_seconds) && schedule.cadence_seconds >= 60 && schedule.cadence_seconds <= 4294967295,
    'subscription_build_writer_cadence')
  check(typeof schedule.receive_timezone === 'string' && schedule.receive_timezone.length > 0 && schedule.receive_timezone.length <= 64,
    'subscription_build_writer_timezone')
  const window = normalize(schedule).receive_window_json
  check(window !== null && typeof window === 'object' && !Array.isArray(window), 'subscription_build_writer_window')
  check(preferences.contract_version === 1 && ['ai_recommended', 'conservative', 'standard', 'trend'].includes(preferences.take_profit_mode),
    'subscription_build_writer_preferences')
}

// Prepared namespace only. The caller owns source evidence, role/config approval,
// ID maps, transaction commit, batch receipts and eventual namespace promotion.
// Never updates an existing row or fills a partially committed projection on replay.
export function createSubscriptionBuildWriter(projections, { namespace = 'build' } = {}) {
  check(['build', 'canonical'].includes(namespace), 'subscription_writer_namespace')
  const targetName = table => namespace === 'build' ? table : ({
    strategy_subscriptions_v4_build: 'strategy_subscriptions',
    subscription_schedules_v4_build: 'subscription_schedules',
    subscription_execution_preferences_v4_build: 'subscription_execution_preferences',
  })[table]
  const expected = new Map(), identities = new Set(), legacy = new Set()
  for (const projection of projections) {
    validate(projection)
    const row = projection.subscription
    const identity = canonical([row.user_id, row.trading_account_id, row.analysis_strategy_id, row.standard_symbol])
    check(!expected.has(row.id) && !identities.has(identity) && !legacy.has(row.legacy_id), 'subscription_build_writer_duplicate')
    expected.set(row.id, canonical(projection)); identities.add(identity); legacy.add(row.legacy_id)
  }
  return { async write(connection, projection, { verifyOnly = false } = {}) {
    projection = structuredClone(projection)
    check(expected.get(projection.subscription.id) === canonical(projection), 'subscription_build_writer_input_changed')
    const read = async (kind) => {
      const { table, key, fields } = definitions[kind], target = projection[kind]
      const select = fields.map(field => ids.has(field) ? `CAST(${field} AS CHAR) ${field}`
        : field.endsWith('_at_utc') ? `DATE_FORMAT(${field},'%Y-%m-%d %H:%i:%s.%f') ${field}` : field)
      const where = kind === 'subscription' ? 'id=? OR (legacy_source_table=? AND legacy_id=?) OR (user_id=? AND trading_account_id=? AND analysis_strategy_id=? AND standard_symbol=?)' : `${key}=?`
      const args = kind === 'subscription' ? [target.id, target.legacy_source_table, target.legacy_id, target.user_id,
        target.trading_account_id, target.analysis_strategy_id, target.standard_symbol] : [target[key]]
      const [rows] = await connection.execute(`SELECT ${select.join(',')} FROM ${targetName(table)} WHERE ${where} FOR UPDATE`, args)
      check(rows.length <= 1, 'subscription_build_writer_identity_conflict')
      return rows.length ? normalize({ ...rows[0] }) : null
    }
    const matches = (actual, target) => check(actual && canonical(actual) === canonical(normalize(target)), 'subscription_build_writer_target_conflict')
    const found = {}
    for (const kind of Object.keys(definitions)) found[kind] = await read(kind)
    const count = Object.values(found).filter(Boolean).length
    if (count > 0) {
      for (const kind of Object.keys(definitions)) if (found[kind]) matches(found[kind], projection[kind])
      check(count === 3, 'subscription_build_writer_partial_projection')
      return { inserted: 0, subscriptionId: projection.subscription.id }
    }
    check(!verifyOnly, 'subscription_build_writer_not_committed')
    for (const [kind, { table, fields }] of Object.entries(definitions)) {
      const target = normalize(projection[kind])
      await connection.execute(`INSERT INTO ${targetName(table)} (${fields.join(',')}) VALUES (${fields.map(() => '?').join(',')})`,
        fields.map(field => field === 'receive_window_json' ? JSON.stringify(target[field]) : projection[kind][field]))
      matches(await read(kind), projection[kind])
    }
    return { inserted: 3, subscriptionId: projection.subscription.id }
  } }
}
