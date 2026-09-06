import { exactKeys, hash, requireBackfill as check } from './v4-backfill-contract.mjs'
import { representIdentityValue as represent } from './v4-identity-values.mjs'
import { inspectWallClock } from './v4-identity-time.mjs'

export const accountSourceFields = Object.freeze(['id', 'user_id', 'broker_server', 'login_account', 'nickname', 'margin_mode',
  'review_status', 'observe_status', 'is_deleted', 'created_at', 'updated_at', 'observed_until', 'identity_verified_at', 'first_verified_at', 'anomaly_code'])
const timeFields = ['created_at', 'updated_at', 'observed_until', 'identity_verified_at', 'first_verified_at']
const numeric = (a, b) => BigInt(a) < BigInt(b) ? -1 : BigInt(a) > BigInt(b) ? 1 : 0
const positive = (value, type) => { represent(value, type, false); check(BigInt(value) > 0n, 'account_conversion_id_invalid') }

// Inspect the complete frozen account set. No timezone is assumed and no SQL is run.
export function inspectAccountConversion(rows, plan, userIds) {
  check(Array.isArray(rows) && rows.length <= 100000 && userIds instanceof Set, 'account_conversion_scope_invalid')
  check(plan?.version === 'account-id-map-v1' && Array.isArray(plan.entities) && Array.isArray(plan.settings)
    && plan.mappingHash === hash({ entities: plan.entities, mappings: plan.mappings, settings: plan.settings }), 'account_conversion_plan_invalid')
  const sources = new Map(), settingsKeys = new Set(), entityIds = new Set(), covered = new Set(), entries = [], entities = []
  const settingsBySource = new Map(), mappingsBySource = new Map()
  for (const setting of plan.settings) {
    check(!settingsBySource.has(setting.sourceAccountId), 'account_conversion_settings_mapping_invalid')
    settingsBySource.set(setting.sourceAccountId, setting)
  }
  for (const mapping of plan.mappings) {
    const id = mapping.sourcePk?.[0]?.value
    check(typeof id === 'string' && !mappingsBySource.has(id), 'account_conversion_mapping_mismatch')
    mappingsBySource.set(id, mapping)
  }
  for (const row of rows) {
    exactKeys(row, accountSourceFields)
    positive(row.id, 'int'); positive(row.user_id, 'int')
    check(!sources.has(row.id) && userIds.has(row.user_id), 'account_conversion_source_identity_invalid')
    for (const [name, size, nullable] of [['broker_server', 100, false], ['login_account', 50, false], ['nickname', 100, true],
      ['margin_mode', 20, false], ['review_status', 20, false], ['observe_status', 20, false], ['anomaly_code', 64, true]]) {
      represent(row[name], `varchar(${size})`, nullable)
    }
    check(['0', '1'].includes(row.is_deleted), 'account_conversion_deleted_invalid')
    const times = Object.fromEntries(timeFields.map(name => [name, inspectWallClock(row[name]).canonicalWallClock]))
    check(times.created_at !== null && times.updated_at !== null && times.updated_at >= times.created_at, 'account_conversion_time_invalid')
    sources.set(row.id, row)
  }
  for (const entity of plan.entities) {
    positive(entity.targetAccountId, 'bigint unsigned')
    check(!entityIds.has(entity.targetAccountId) && entity.sourceAccountIds.length > 0, 'account_conversion_target_collision')
    entityIds.add(entity.targetAccountId)
    check(['mt4', 'mt5'].includes(entity.platform) && /^[\x21-\x7e]{1,12}$/.test(entity.currency), 'account_conversion_public_facts_invalid')
    represent(entity.brokerServer, 'varchar(191)', false)
    check(/^[\x21-\x7e]{1,64}$/.test(entity.accountLogin), 'account_conversion_login_invalid')
    const members = entity.sourceAccountIds.map(id => {
      const row = sources.get(id)
      check(row && !covered.has(id), 'account_conversion_source_coverage_invalid'); covered.add(id)
      check(row.broker_server.toUpperCase() === entity.brokerServerKey && entity.brokerServer.toUpperCase() === entity.brokerServerKey
        && row.login_account === entity.accountLogin, 'account_conversion_mapping_mismatch')
      const setting = settingsBySource.get(id)
      check(setting && setting.userId === row.user_id && setting.targetAccountId === entity.targetAccountId,
        'account_conversion_settings_mapping_invalid')
      const key = `${row.user_id}:${entity.targetAccountId}`
      check(!settingsKeys.has(key), 'account_conversion_settings_collision'); settingsKeys.add(key)
      entries.push({ sourceId: id, targetAccountId: entity.targetAccountId, sourceHash: hash(row), source: { ...row } })
      return row
    })
    check(new Set(members.map(row => row.margin_mode)).size === 1, 'account_conversion_margin_conflict')
    entities.push({ ...entity, marginMode: members[0].margin_mode })
  }
  check(covered.size === sources.size && plan.settings.length === rows.length && plan.mappings.length === rows.length,
    'account_conversion_source_coverage_invalid')
  for (const entry of entries) {
    const mapping = mappingsBySource.get(entry.sourceId)
    check(mapping && mapping.entityKind === 'trading_account' && mapping.sourceTable === 'trading_accounts'
      && mapping.sourcePk.length === 1 && mapping.sourcePk[0].type === 'integer'
      && mapping.target?.table === 'trading_accounts' && mapping.target.pk.length === 1
      && mapping.target.pk[0].type === 'integer' && mapping.target.pk[0].value === entry.targetAccountId,
      'account_conversion_mapping_mismatch')
  }
  entries.sort((a, b) => numeric(a.sourceId, b.sourceId)); entities.sort((a, b) => numeric(a.targetAccountId, b.targetAccountId))
  return { entries, entities, mappingHash: plan.mappingHash, sourceHash: hash(entries.map(entry => entry.source)),
    coveredFields: [...accountSourceFields], timeBasisConfirmed: false, readyForBusinessWrite: false }
}

function utc(raw, basis) {
  if (raw === null) return null
  const wall = inspectWallClock(raw).canonicalWallClock
  const value = new Date(Date.parse(wall.replace(' ', 'T') + 'Z') - basis.offsetMinutes * 60000).toISOString()
  check(/^\d{4}-/.test(value) && value.slice(0, 4) >= '1000' && value.slice(0, 4) <= '9999', 'account_conversion_time_out_of_range')
  return value.replace('T', ' ').replace('Z', '')
}

export function convertAccountRows(rows, plan, { userIds, timeBasis }) {
  const inspected = inspectAccountConversion(rows, plan, userIds)
  check(timeBasis?.sourceTable === 'trading_accounts' && Number.isInteger(timeBasis.offsetMinutes)
    && Math.abs(timeBasis.offsetMinutes) <= 840 && /^[A-Za-z0-9_.:-]{1,128}$/.test(timeBasis.evidenceId ?? ''), 'account_conversion_time_basis_required')
  const settings = inspected.entries.map(({ source, sourceId, targetAccountId, sourceHash }) => {
    const target = { user_id: source.user_id, trading_account_id: targetAccountId, nickname: source.nickname,
      review_status: source.review_status, observe_status: source.observe_status, anomaly_code: source.anomaly_code,
      hidden: source.is_deleted, legacy_is_deleted: source.is_deleted, connection_paused: '0',
      observed_until_utc: utc(source.observed_until, timeBasis), identity_verified_at_utc: utc(source.identity_verified_at, timeBasis),
      first_verified_at_utc: utc(source.first_verified_at, timeBasis), revision: '1', updated_at_utc: utc(source.updated_at, timeBasis) }
    return { sourceId, sourceHash, target, targetHash: hash(target), provenance: { source: { ...source }, timeBasisHash: hash(timeBasis) } }
  })
  const entriesByTarget = new Map()
  for (const entry of inspected.entries) {
    const members = entriesByTarget.get(entry.targetAccountId) ?? []
    members.push(entry); entriesByTarget.set(entry.targetAccountId, members)
  }
  const entities = inspected.entities.map(entity => {
    const members = entriesByTarget.get(entity.targetAccountId)
    const target = { id: entity.targetAccountId, platform: entity.platform, broker_server: entity.brokerServer,
      account_login: entity.accountLogin, currency: entity.currency, margin_mode: entity.marginMode,
      created_at_utc: members.map(entry => utc(entry.source.created_at, timeBasis)).sort()[0],
      updated_at_utc: members.map(entry => utc(entry.source.updated_at, timeBasis)).sort().at(-1),
      deleted_at_utc: null, ownership_revision: '1' }
    return { sourceIds: [...entity.sourceAccountIds].sort(numeric), target, targetHash: hash(target) }
  })
  return { entities, settings, sourceHash: inspected.sourceHash, mappingHash: plan.mappingHash,
    transformHash: hash({ entities, settings, timeBasis }), businessWritesPerformed: false,
    readyForBusinessWrite: false, remainingChecks: ['ownership_and_permission_reconciliation', 'transactional_receipts_and_id_reservation'] }
}
