import { canonical, hash, exactKeys, requireBackfill as check } from './v4-backfill-contract.mjs'
import { legacyStrategyFields, legacySubscriptionFields } from './v4-strategy-source-review.mjs'
import { convertSubscriptionSymbols } from './v4-subscription-symbol-conversion.mjs'
import { strategyRoleLegacyIdentity } from './strategy-role-legacy-identity.mjs'
import { subscriptionLegacyIdentity } from './subscription-legacy-identity.mjs'
import { createSubscriptionBuildWriter } from './mysql-subscription-build-writer.mjs'
import { convertSubscriptionExecutionPreferences } from './v4-subscription-preferences-conversion.mjs'
import { inspectWallClock } from './v4-identity-time.mjs'

// Pre-promotion source names only. The owning coordinator admits schema, source
// snapshot, ownership/config conversion, receipts and archives in the same transaction.
export function createSubscriptionSourceWriter(entries, { logicalSourceId, runId, namespace = 'build' }) {
  check(typeof logicalSourceId === 'string' && /^[A-Za-z0-9_.:-]{1,128}$/.test(logicalSourceId), 'subscription_source_logical_id')
  check(typeof runId === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(runId), 'subscription_source_run_id')
  entries = structuredClone(entries)
  const expected = new Map(), projections = [], entityKinds = new Map()
  for (const entry of entries) {
    exactKeys(entry, ['source', 'sourceHash', 'strategySource', 'strategySourceHash', 'projections'])
    for (const [key, fields] of [['source', legacySubscriptionFields], ['strategySource', legacyStrategyFields]]) {
      exactKeys(entry[key], fields)
      check(Object.values(entry[key]).every(value => value === null || typeof value === 'string')
        && hash(entry[key]) === entry[key === 'source' ? 'sourceHash' : 'strategySourceHash'], 'subscription_source_snapshot_invalid')
    }
    check(entry.source.strategy_id === entry.strategySource.id && !expected.has(entry.source.id), 'subscription_source_identity')
    const symbols = convertSubscriptionSymbols(entry.source.symbols_json, entry.strategySource.symbols_json)
    const preferences = convertSubscriptionExecutionPreferences(entry.source)
    check(preferences.status === 'converted', 'subscription_source_preferences_unresolved')
    check(symbols.status === 'converted' && symbols.symbols.length > 0 && Array.isArray(entry.projections)
      && canonical(entry.projections.map(item => item.subscription.standard_symbol).sort()) === canonical(symbols.symbols),
      'subscription_source_symbols_unresolved')
    for (const projection of entry.projections) {
      const row = projection.subscription, identity = subscriptionLegacyIdentity(entry.source.id, row.standard_symbol)
      check(row.user_id === entry.source.user_id && row.legacy_source_table === identity.sourceTable && row.legacy_id === identity.legacyId,
        'subscription_source_target_identity')
      check(canonical({ ...projection.preferences,
        created_at_utc: inspectWallClock(projection.preferences.created_at_utc).canonicalWallClock,
        updated_at_utc: inspectWallClock(projection.preferences.updated_at_utc).canonicalWallClock,
      }) === canonical({ subscription_id: row.id, ...preferences.candidate }), 'subscription_source_preferences_conflict')
      check(!entityKinds.has(identity.entityKind) || entityKinds.get(identity.entityKind) === row.standard_symbol, 'subscription_source_symbol_hash_collision')
      entityKinds.set(identity.entityKind, row.standard_symbol)
      projections.push(projection)
    }
    expected.set(entry.source.id, canonical(entry))
  }
  const writer = createSubscriptionBuildWriter(projections, { namespace })
  return { async write(tx, entry, { verifyOnly = false } = {}) {
    entry = structuredClone(entry)
    check(expected.get(entry.source.id) === canonical(entry), 'subscription_source_input_changed')
    for (const [table, fields, source, expectedHash] of [
      [namespace === 'canonical' ? 'strategy_subscriptions_legacy_v3' : 'strategy_subscriptions', legacySubscriptionFields, entry.source, entry.sourceHash],
      ['auto_prompt_types', legacyStrategyFields, entry.strategySource, entry.strategySourceHash],
    ]) {
      const [rows] = await tx.connection.execute(`SELECT ${fields.map(field => `CAST(\`${field}\` AS CHAR) \`${field}\``).join(',')}
        FROM ${table} WHERE id=? FOR UPDATE`, [source.id])
      check(rows.length === 1 && hash({ ...rows[0] }) === expectedHash, 'subscription_source_changed')
    }
    const requiredMap = async (mapping) => {
      const actual = await tx.findMapping(logicalSourceId, mapping)
      check(actual && canonical(actual) === canonical({ sourcePk: mapping.sourcePk, target: mapping.target }), 'subscription_source_parent_mapping_conflict')
    }
    const mappings = []
    for (const projection of entry.projections) {
      const row = projection.subscription
      await requiredMap({ entityKind: 'trading_account', sourceTable: 'trading_accounts',
        sourcePk: [{ type: 'integer', value: entry.source.trading_account_id }],
        target: { table: 'trading_accounts', pk: [{ type: 'integer', value: row.trading_account_id }] } })
      for (const kind of ['analysis', 'trader']) {
        if (kind === 'trader' && row.trader_strategy_id === null) continue
        const parent = strategyRoleLegacyIdentity(entry.strategySource.id, entry.strategySource.version, kind)
        for (const [part, table, field] of [['strategy', 'strategies', `${kind}_strategy_id`], ['version', 'strategy_versions', `${kind}_strategy_version_id`]]) {
          await requiredMap({ entityKind: parent[part].entityKind, sourceTable: parent.sourceTable, sourcePk: parent.sourcePk,
            target: { table, pk: [{ type: 'integer', value: row[field] }] } })
        }
      }
      const identity = subscriptionLegacyIdentity(entry.source.id, row.standard_symbol)
      // Persistent maps use the final logical name, like the existing account migration.
      const mapping = { entityKind: identity.entityKind, sourceTable: identity.sourceTable, sourcePk: identity.sourcePk,
        target: { table: 'strategy_subscriptions', pk: [{ type: 'integer', value: row.id }] } }
      const actual = await tx.findMapping(logicalSourceId, mapping)
      if (actual) check(canonical(actual) === canonical({ sourcePk: mapping.sourcePk, target: mapping.target }), 'subscription_source_mapping_conflict')
      else check(!verifyOnly, 'subscription_source_mapping_missing')
      mappings.push({ mapping, exists: Boolean(actual) })
    }
    let inserted = 0
    for (const projection of entry.projections) inserted += (await writer.write(tx.connection, projection, { verifyOnly })).inserted
    for (const { mapping, exists } of mappings) {
      if (!exists) await tx.insertMapping(runId, logicalSourceId, mapping)
      check(canonical(await tx.findMapping(logicalSourceId, mapping)) === canonical({ sourcePk: mapping.sourcePk, target: mapping.target }),
        'subscription_source_mapping_readback')
    }
    return { inserted, mappingsInserted: mappings.filter(item => !item.exists).length, sourceHash: entry.sourceHash,
      strategySourceHash: entry.strategySourceHash, idMaps: mappings.map(item => item.mapping) }
  } }
}
