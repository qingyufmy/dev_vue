import { hash } from './v4-backfill-contract.mjs'
import { createStrategySourceWriter } from './mysql-strategy-source-writer.mjs'
import { createFrozenSourceBatch } from './frozen-source-batch.mjs'

// Preserve strategy-roles-v1 stream and request hashes across the shared-ledger extraction.
export function createStrategySourceBatch(entries, options) {
  return createFrozenSourceBatch(entries, options, {
    sourceTable: 'auto_prompt_types', role: 'strategy-roles-v1', errorPrefix: 'strategy', createWriter: createStrategySourceWriter,
    projectRow(entry) {
      const targets = ['analysis', 'trader'].flatMap(kind => ['strategy', 'version'].map(part => ({
        table: part === 'strategy' ? 'strategies' : 'strategy_versions', pk: [{ type: 'integer', value: entry.roles[kind][part].id }] })))
      return { pk: [{ type: 'integer', value: entry.source.id }], sourceHash: entry.sourceHash,
        transformedHash: hash({ roles: entry.roles, targets }), targets, source: entry.source }
    },
  })
}
