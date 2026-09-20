import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { hash, canonical } from './v4-backfill-contract.mjs'
import { inspectWallClock } from './v4-identity-time.mjs'
import { createFrozenSourceBatch } from './frozen-source-batch.mjs'

export const memoryTables = ['strategy_memory_libraries_v4', 'strategy_memory_library_revisions_v4']
const sha = text => createHash('sha256').update(text, 'utf8').digest('hex')
const uuid = value => { const h = hash(value); return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}` }
const utc = value => inspectWallClock(value).canonicalWallClock
const quote = name => { assert.match(name, /^[a-z][a-z0-9_]*$/); return `\`${name}\`` }
export async function readMemorySources(db, lock = false) {
  const source = []
  for (const table of ['strategy_memory_libraries', 'strategy_memory_library_revisions']) {
    const [columns] = await db.execute('SELECT COLUMN_NAME name FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=? ORDER BY ORDINAL_POSITION', [table])
    assert.ok(columns.length > 0)
    const [rows] = await db.query(`SELECT ${columns.map(({ name }) => `CAST(${quote(name)} AS CHAR) ${quote(name)}`).join(',')} FROM ${table} ORDER BY strategy_id${table.endsWith('_revisions') ? ',version_no' : ''} LIMIT 1001${lock ? ' FOR SHARE' : ''}`)
    assert.ok(rows.length <= 1000)
    source.push(rows.map(row => ({ ...row })))
  }
  const [libraries, revisions] = source
  assert.ok(revisions.every(row => libraries.some(library => library.strategy_id === row.strategy_id)))
  return libraries.map(library => ({ id: library.strategy_id, library, revisions: revisions.filter(row => row.strategy_id === library.strategy_id) }))
}

export function projectMemoryTransition(sources, roles, userIds) {
  return sources.map(source => {
    const parent = roles.find(row => row.source.id === source.id)
    assert.ok(parent, 'memory_parent_missing')
    const lib = source.library
    assert.equal(lib.content_hash, sha(lib.content_text), 'memory_current_hash_invalid')
    const current = source.revisions.find(row => row.version_no === lib.version_no)
    assert.ok(current && current.content_text === lib.content_text && current.content_hash === lib.content_hash, 'memory_current_revision_missing')
    const projections = ['analysis', 'trader'].map(kind => {
      const strategy = parent.roles[kind].strategy
      assert.equal(lib.strategy_scope, parent.source.scope)
      assert.equal(lib.owner_user_id, strategy.owner_user_id ?? '0')
      const libraryId = uuid(['memory-library-v1', source.id, kind])
      const revisions = source.revisions.map(row => {
        assert.equal(row.content_hash, sha(row.content_text), 'memory_revision_hash_invalid')
        assert.ok(/^[1-9]\d*$/.test(row.version_no) && BigInt(row.version_no) <= 4294967295n)
        assert.ok(row.actor_user_id === null || userIds.has(row.actor_user_id), 'memory_revision_actor_missing')
        assert.ok(Buffer.byteLength(row.content_text, 'utf8') <= 16777215)
        return { id: uuid(['memory-revision-v1', row.id, kind]), library_id: libraryId, version_number: Number(row.version_no),
          content_text: row.content_text, content_json: null, content_sha256: row.content_hash, source_kind: 'migration',
          source_metadata_json: { legacyTable: 'strategy_memory_library_revisions', legacyId: row.id, sourceHash: hash(row), role: kind },
          created_by_user_id: row.actor_user_id === null ? null : Number(row.actor_user_id), created_at_utc: utc(row.created_at) }
      })
      return { kind, strategyId: strategy.id, library: { id: libraryId, strategy_id: strategy.id,
        owner_user_id: strategy.owner_user_id === null ? null : Number(strategy.owner_user_id), mode: 'shadow', status: 'revalidating',
        current_revision_id: revisions.find(row => row.version_number === Number(lib.version_no)).id,
        max_context_tokens: 800, revision: '1', legacy_source_table: 'strategy_memory_libraries', legacy_id: `${source.id}:${kind}`,
        created_at_utc: utc(lib.created_at), updated_at_utc: utc(lib.updated_at) }, revisions }
    })
    return { source, sourceHash: hash(source), projections }
  })
}

export function createMemoryTransitionBatch(entries, options) {
  return createFrozenSourceBatch(entries, options, {
    sourceTable: 'strategy_memory_libraries', role: 'role-memory-history-v1', errorPrefix: 'memory',
    projectRow(entry) { const targets = entry.projections.flatMap(p => [
      { table: memoryTables[0], pk: [{ type: 'text', value: p.library.id }] },
      ...p.revisions.map(row => ({ table: memoryTables[1], pk: [{ type: 'text', value: row.id }] })),
    ]); return { pk: [{ type: 'integer', value: entry.source.id }], source: entry.source, sourceHash: entry.sourceHash, targets, transformedHash: hash(entry.projections) } },
    createWriter(frozen, { runId, logicalSourceId }) {
      return { async write(tx, entry, { verifyOnly = false } = {}) {
        assert.ok(frozen.some(row => canonical(row) === canonical(entry)))
        const current = (await readMemorySources(tx.connection, true)).find(row => row.id === entry.source.id)
        assert.equal(hash(current), entry.sourceHash, 'memory_source_changed')
        const rowWrite = async (table, row, initial = row) => {
          const keys = Object.keys(row)
          const [found] = await tx.connection.execute(`SELECT ${keys.map(key => key === 'strategy_id' || key === 'revision' ? `CAST(${quote(key)} AS CHAR) ${quote(key)}` : quote(key)).join(',')} FROM ${table} WHERE id=? FOR UPDATE`, [row.id])
          const normalize = value => Object.fromEntries(Object.entries(value).map(([key, item]) => [key, key.endsWith('_at_utc') ? utc(item) : key.endsWith('_json') && typeof item === 'string' ? JSON.parse(item) : item]))
          if (found.length) { assert.equal(canonical(normalize({ ...found[0] })), canonical(row), 'memory_target_conflict'); return false }
          assert.ok(!verifyOnly, 'memory_target_missing')
          await tx.connection.execute(`INSERT INTO ${table} (${keys.map(quote).join(',')}) VALUES (${keys.map(() => '?').join(',')})`, keys.map(key => key.endsWith('_json') && initial[key] !== null ? canonical(initial[key]) : initial[key]))
          return true
        }
        for (const p of entry.projections) {
          const parent = { entityKind: `strategy-${p.kind}`, sourceTable: 'auto_prompt_types', sourcePk: [{ type: 'integer', value: entry.source.id }], target: { table: 'strategies', pk: [{ type: 'integer', value: p.strategyId }] } }
          assert.equal(canonical(await tx.findMapping(logicalSourceId, parent)), canonical({ sourcePk: parent.sourcePk, target: parent.target }), 'memory_parent_mapping_changed')
          const inserted = await rowWrite(memoryTables[0], p.library, { ...p.library, current_revision_id: null })
          for (const row of p.revisions) await rowWrite(memoryTables[1], row)
          if (inserted) await tx.connection.execute(`UPDATE ${memoryTables[0]} SET current_revision_id=? WHERE id=? AND current_revision_id IS NULL`, [p.library.current_revision_id, p.library.id])
          await rowWrite(memoryTables[0], p.library)
          const mappings = [{ entityKind: `memory-library-${p.kind}`, sourceTable: 'strategy_memory_libraries', sourcePk: [{ type: 'integer', value: entry.source.id }], target: { table: memoryTables[0], pk: [{ type: 'text', value: p.library.id }] } },
            ...p.revisions.map(row => ({ entityKind: `memory-revision-${p.kind}`, sourceTable: 'strategy_memory_library_revisions', sourcePk: [{ type: 'integer', value: row.source_metadata_json.legacyId }], target: { table: memoryTables[1], pk: [{ type: 'text', value: row.id }] } }))]
          for (const mapping of mappings) {
            const saved = await tx.findMapping(logicalSourceId, mapping)
            if (!saved) { assert.ok(!verifyOnly); await tx.insertMapping(runId, logicalSourceId, mapping) }
            assert.equal(canonical(await tx.findMapping(logicalSourceId, mapping)), canonical({ sourcePk: mapping.sourcePk, target: mapping.target }))
          }
        }
      } }
    },
  })
}
