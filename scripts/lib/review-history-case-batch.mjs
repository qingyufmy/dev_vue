import assert from 'node:assert/strict'
import { canonical, hash } from './v4-backfill-contract.mjs'
import { createFrozenSourceBatch } from './frozen-source-batch.mjs'
import { readReviewHistoryArchive } from './review-history-archive-reader.mjs'
import { readReviewHistoryBundle, reviewHistoryGraph } from './review-history-bundle.mjs'
import { projectArchivedReviewCase } from './review-history-case-projection.mjs'
import { inspectWallClock } from './v4-identity-time.mjs'

const q = key => { assert.match(key, /^[a-z][a-z0-9_]*$/); return '`' + key + '`' }
const pk = value => [{ type: 'integer', value }]
const ref = (table, value) => ({ table, pk: [{ type: 'text', value }] })
export const reviewProjectionTables = ['review_cases_v4', 'review_case_history_v4', 'review_versions_v4', 'review_version_payloads_v4', 'review_user_states_v4']

export function createReviewHistoryCaseBatch(entry, options) {
  const table = entry.source.table
  assert.ok(Object.hasOwn(reviewHistoryGraph, table))
  assert.equal(entry.sourceHash, hash(entry.source))
  const projection = entry.projection
  return createFrozenSourceBatch([entry], options, { sourceTable: table, role: 'review-history-projection-v1', errorPrefix: 'review_history_case',
    projectRow(value) {
      const targets = [ref('review_cases_v4', projection.caseRow.id), ref('review_case_history_v4', projection.caseRow.id),
        ...projection.versions.flatMap(version => [ref('review_versions_v4', version.row.id), ref('review_version_payloads_v4', version.row.id)]),
        ...projection.userStates.map(row => ({ table: 'review_user_states_v4', pk: [{ type: 'text', value: row.review_case_id }, { type: 'integer', value: row.user_id }] }))]
      return { pk: pk(value.source.id), sourceHash: value.sourceHash, transformedHash: hash(projection), targets, source: value.source }
    },
    createWriter() { return { async write(tx, current, { verifyOnly = false } = {}) {
      assert.equal(canonical(current), canonical(entry))
      const source = await readReviewHistoryArchive(tx.connection, { runId: entry.source.archiveRunId,
        sourceTable: table, sourceId: entry.source.id, expectedBundleHash: entry.source.bundleHash })
      assert.equal(hash(await readReviewHistoryBundle(tx.connection, table, entry.source.id)), entry.source.bundleHash, 'review_history_source_changed')
      const original = source.rows[table][0]
      const accountMapping = { entityKind: 'trading_account', sourceTable: 'trading_accounts', sourcePk: pk(original.trading_account_id) }
      const mapped = await tx.findMapping(options.logicalSourceId, accountMapping)
      assert.ok(mapped && mapped.target.table === 'trading_accounts' && mapped.target.pk.length === 1, 'review_history_account_mapping_missing')
      assert.equal(mapped.target.pk[0].value, projection.caseRow.trading_account_id)
      assert.equal(canonical(projectArchivedReviewCase(source, { archiveRunId: entry.source.archiveRunId, accountId: mapped.target.pk[0].value })), canonical(projection))
      const users = new Set([projection.caseRow.user_id, ...projection.versions.map(v => v.row.created_by_user_id), ...projection.userStates.map(v => v.user_id)].filter(value => value !== null))
      for (const user of users) {
        const [found] = await tx.connection.execute('SELECT id FROM users WHERE id=? FOR SHARE', [user])
        assert.equal(found.length, 1, 'review_history_user_missing')
      }
      const normalized = (key, value) => value === null ? null : key === 'content_json' ? canonical(JSON.parse(value))
        : key.endsWith('_utc') ? inspectWallClock(value).canonicalWallClock : String(value)
      const write = async (name, row, keys, initial = row) => {
        assert.ok(reviewProjectionTables.includes(name))
        const fields = Object.keys(row)
        const [found] = await tx.connection.execute('SELECT ' + fields.map(key => `CAST(${q(key)} AS CHAR) ${q(key)}`).join(',')
          + ' FROM ' + q(name) + ' WHERE ' + keys.map(key => q(key) + '=?').join(' AND ') + ' FOR UPDATE', keys.map(key => row[key]))
        if (found.length) {
          assert.equal(found.length, 1)
          const normalize = value => Object.fromEntries(fields.map(key => [key, normalized(key, value[key])]))
          assert.equal(canonical(normalize(found[0])), canonical(normalize(row)), 'review_history_target_conflict')
          return false
        }
        assert.ok(!verifyOnly, 'review_history_target_missing')
        await tx.connection.execute('INSERT INTO ' + q(name) + ' (' + fields.map(q).join(',') + ') VALUES (' + fields.map(() => '?').join(',') + ')', fields.map(key => initial[key]))
        return true
      }
      const inserted = await write('review_cases_v4', projection.caseRow, ['id'], { ...projection.caseRow, current_version_id: null, confirmed_version_id: null })
      for (const version of projection.versions) {
        await write('review_versions_v4', version.row, ['id']); await write('review_versions_v4', version.row, ['id'])
        await write('review_version_payloads_v4', version.payload, ['review_version_id']); await write('review_version_payloads_v4', version.payload, ['review_version_id'])
      }
      if (inserted) await tx.connection.execute('UPDATE review_cases_v4 SET current_version_id=?,confirmed_version_id=? WHERE id=? AND current_version_id IS NULL AND confirmed_version_id IS NULL',
        [projection.caseRow.current_version_id, projection.caseRow.confirmed_version_id, projection.caseRow.id])
      await write('review_cases_v4', projection.caseRow, ['id'])
      await write('review_case_history_v4', projection.historyRow, ['review_case_id']); await write('review_case_history_v4', projection.historyRow, ['review_case_id'])
      for (const row of projection.userStates) { await write('review_user_states_v4', row, ['review_case_id', 'user_id']); await write('review_user_states_v4', row, ['review_case_id', 'user_id']) }
      const versionTable = reviewHistoryGraph[table][0][0]
      const maps = [{ entityKind: 'review-case', sourceTable: table, sourcePk: pk(entry.source.id), target: ref('review_cases_v4', projection.caseRow.id) },
        ...projection.versions.map(version => ({ entityKind: 'review-version', sourceTable: versionTable,
          sourcePk: pk(JSON.parse(version.payload.content_json).sourceId), target: ref('review_versions_v4', version.row.id) }))]
      for (const mapping of maps) {
        if (!await tx.findMapping(options.logicalSourceId, mapping)) { assert.ok(!verifyOnly); await tx.insertMapping(options.runId, options.logicalSourceId, mapping) }
        assert.equal(canonical(await tx.findMapping(options.logicalSourceId, mapping)), canonical({ sourcePk: mapping.sourcePk, target: mapping.target }))
      }
    } } },
  })
}
