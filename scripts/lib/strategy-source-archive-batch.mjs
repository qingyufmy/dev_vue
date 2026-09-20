import { canonical, exactKeys, hash, streamIdentity, requireBackfill as check } from './v4-backfill-contract.mjs'
import { legacyStrategyFields, legacySubscriptionFields } from './v4-strategy-source-review.mjs'
import { createFrozenSourceBatch } from './frozen-source-batch.mjs'

const sources = { auto_prompt_types: legacyStrategyFields, strategy_subscriptions: legacySubscriptionFields }
const role = 'source-preservation-v1'

/** Preserves source evidence only; this is not a completed role/subscription conversion. */
export function createStrategySourceArchiveBatch(table, entries, options) {
  options = structuredClone(options)
  check(/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(options?.runId ?? ''), 'strategy_archive_run_invalid')
  check(Object.hasOwn(sources, table), 'strategy_archive_table_invalid')
  const fields = sources[table], streamId = streamIdentity({ sourceTable: table, role })
  return createFrozenSourceBatch(entries, options, {
    sourceTable: table, role, errorPrefix: 'strategy_archive',
    createWriter(values) {
      const expected = new Map()
      for (const entry of values) {
        exactKeys(entry, ['source', 'sourceHash']); exactKeys(entry.source, fields)
        check(Object.values(entry.source).every(value => value === null || typeof value === 'string')
          && /^[1-9]\d{0,19}$/.test(entry.source.id) && BigInt(entry.source.id) <= 18446744073709551615n
          && entry.sourceHash === hash(entry.source), 'strategy_archive_source_invalid')
        check(!expected.has(entry.source.id), 'strategy_archive_source_duplicate')
        expected.set(entry.source.id, canonical(entry))
      }
      return { async write(tx, entry) {
        check(expected.get(entry.source.id) === canonical(entry), 'strategy_archive_input_changed')
        const [rows] = await tx.connection.execute(`SELECT ${fields.map(field => `CAST(\`${field}\` AS CHAR) \`${field}\``).join(',')}
          FROM \`${table}\` WHERE id=? FOR UPDATE`, [entry.source.id])
        check(rows.length === 1 && hash({ ...rows[0] }) === entry.sourceHash, 'strategy_archive_source_changed')
      } }
    },
    projectRow(entry) {
      const pk = [{ type: 'integer', value: entry.source.id }]
      const targets = [{ table: 'data_migration_source_rows', pk: [
        { type: 'text', value: options.runId }, { type: 'text', value: streamId }, { type: 'text', value: hash(pk) },
      ] }]
      return { pk, sourceHash: entry.sourceHash, transformedHash: hash({ stage: 'source_preserved', targets }), targets, source: entry.source }
    },
  })
}
