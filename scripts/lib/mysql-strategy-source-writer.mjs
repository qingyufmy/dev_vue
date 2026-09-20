import { canonical, hash, exactKeys, requireBackfill as check } from './v4-backfill-contract.mjs'
import { legacyStrategyFields } from './v4-strategy-source-review.mjs'
import { strategyRoleLegacyIdentity } from './strategy-role-legacy-identity.mjs'
import { createStrategyRoleWriter } from './mysql-strategy-role-writer.mjs'

// Caller supplies the existing MysqlBackfillTransaction so source locks, target
// rows and persistent maps share its connection and commit boundary. Run/schema
// admission, receipts and source archives remain the outer coordinator's job.
export function createStrategySourceWriter(entries, { logicalSourceId, runId }) {
  check(typeof logicalSourceId === 'string' && /^[A-Za-z0-9_.:-]{1,128}$/.test(logicalSourceId), 'strategy_source_logical_id')
  check(typeof runId === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(runId), 'strategy_source_run_id')
  entries = structuredClone(entries)
  const expected = new Map(), projections = []
  for (const entry of entries) {
    exactKeys(entry, ['source', 'sourceHash', 'roles'])
    exactKeys(entry.source, legacyStrategyFields)
    check(Object.values(entry.source).every(value => value === null || typeof value === 'string')
      && hash(entry.source) === entry.sourceHash, 'strategy_source_snapshot_invalid')
    exactKeys(entry.roles, ['analysis', 'trader'])
    check(!expected.has(entry.source.id), 'strategy_source_duplicate')
    for (const kind of ['analysis', 'trader']) {
      const identity = strategyRoleLegacyIdentity(entry.source.id, entry.source.version, kind)
      const projection = entry.roles[kind]
      check(projection.strategy.kind === kind && projection.version.version_number === entry.source.version
        && projection.strategy.legacy_source_table === identity.strategy.legacySourceTable
        && projection.strategy.legacy_id === identity.strategy.legacyId
        && projection.version.legacy_source_table === identity.version.legacySourceTable
        && projection.version.legacy_id === identity.version.legacyId, 'strategy_source_role_identity')
      projections.push(projection)
    }
    expected.set(entry.source.id, canonical(entry))
  }
  const writer = createStrategyRoleWriter(projections)
  return { async write(tx, entry, { verifyOnly = false } = {}) {
    entry = structuredClone(entry)
    check(expected.get(entry.source.id) === canonical(entry), 'strategy_source_input_changed')
    const [rows] = await tx.connection.execute(`SELECT ${legacyStrategyFields.map(field => `CAST(\`${field}\` AS CHAR) \`${field}\``).join(',')}
      FROM auto_prompt_types WHERE id=? FOR UPDATE`, [entry.source.id])
    check(rows.length === 1 && hash({ ...rows[0] }) === entry.sourceHash, 'strategy_source_changed')
    const mappings = []
    for (const kind of ['analysis', 'trader']) {
      const identity = strategyRoleLegacyIdentity(entry.source.id, entry.source.version, kind)
      const projection = entry.roles[kind]
      for (const [part, table] of [['strategy', 'strategies'], ['version', 'strategy_versions']]) {
        const mapping = { entityKind: identity[part].entityKind, sourceTable: identity.sourceTable, sourcePk: identity.sourcePk,
          target: { table, pk: [{ type: 'integer', value: projection[part].id }] } }
        const existing = await tx.findMapping(logicalSourceId, mapping)
        if (existing) check(canonical(existing) === canonical({ sourcePk: mapping.sourcePk, target: mapping.target }), 'strategy_source_mapping_conflict')
        else check(!verifyOnly, 'strategy_source_mapping_missing')
        mappings.push({ mapping, exists: Boolean(existing) })
      }
    }
    let inserted = 0
    for (const kind of ['analysis', 'trader']) inserted += (await writer.write(tx.connection, entry.roles[kind], { verifyOnly })).inserted
    for (const { mapping, exists } of mappings) {
      if (!exists) await tx.insertMapping(runId, logicalSourceId, mapping)
      check(canonical(await tx.findMapping(logicalSourceId, mapping)) === canonical({ sourcePk: mapping.sourcePk, target: mapping.target }), 'strategy_source_mapping_readback')
    }
    return { inserted, mappingsInserted: mappings.filter(item => !item.exists).length,
      sourceHash: entry.sourceHash, idMaps: mappings.map(item => item.mapping) }
  } }
}
