import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { projectMemoryTransition } from './strategy-memory-transition.mjs'
const sha = text => createHash('sha256').update(text).digest('hex')
function fixture() {
  const text = '原文\n保留空格  \n', time = '2026-09-01 12:34:56'
  const source = { id: '1', library: { strategy_id: '1', strategy_scope: 'platform', owner_user_id: '0',
    content_text: text, content_hash: sha(text), version_no: '7', created_at: time, updated_at: time },
    revisions: [{ id: '12', version_no: '7', strategy_id: '1', content_text: text, content_hash: sha(text), actor_user_id: '3', created_at: time }] }
  const roles = [{ source: { id: '1', scope: 'platform' }, roles: { analysis: { strategy: { id: '41', owner_user_id: null } }, trader: { strategy: { id: '42', owner_user_id: null } } } }]
  return { source, roles }
}
test('keeps exact bytes, UTC and version numbers with deterministic separate role identities', () => {
  const { source, roles } = fixture(), entries = projectMemoryTransition([source], roles, new Set(['3']))
  assert.deepEqual(entries, projectMemoryTransition([source], roles, new Set(['3'])))
  const [analysis, trader] = entries[0].projections
  assert.notEqual(analysis.library.id, trader.library.id)
  for (const projection of entries[0].projections) {
    assert.equal(projection.library.mode, 'shadow'); assert.equal(projection.library.status, 'revalidating')
    assert.equal(projection.library.current_revision_id, projection.revisions[0].id)
    assert.equal(projection.revisions[0].version_number, 7)
    assert.equal(projection.revisions[0].content_text, source.library.content_text)
    assert.equal(projection.revisions[0].created_at_utc, '2026-09-01 12:34:56.000')
  }
})
test('rejects corrupted historical bytes and missing current version or actor', () => {
  let f = fixture(); f.source.revisions[0].content_text += 'changed'
  assert.throws(() => projectMemoryTransition([f.source], f.roles, new Set(['3'])), /memory_current_revision_missing/)
  f = fixture(); f.source.library.version_no = '8'
  assert.throws(() => projectMemoryTransition([f.source], f.roles, new Set(['3'])), /memory_current_revision_missing/)
  f = fixture()
  assert.throws(() => projectMemoryTransition([f.source], f.roles, new Set()), /memory_revision_actor_missing/)
})
test('refuses missing role parent and mismatched ownership', () => {
  const { source, roles } = fixture()
  assert.throws(() => projectMemoryTransition([source], [], new Set(['3'])), /memory_parent_missing/)
  source.library.owner_user_id = '9'
  assert.throws(() => projectMemoryTransition([source], roles, new Set(['3'])))
})
