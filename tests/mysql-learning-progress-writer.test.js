import { expect, it } from 'vitest'
import { learningProgressFixture } from './fixtures/learning-progress-fixture.mjs'
import { createLearningProgressWriter, learningProgressTargetFields } from '../scripts/lib/mysql-learning-progress-writer.mjs'
function fixture() {
  const f = learningProgressFixture(), writer = createLearningProgressWriter([f.source], f.options)
  const entry = writer.prepared.entries[0], state = { source: f.source, lesson: { id: '12', episodeId: '100', sourceHash: 'b'.repeat(64) }, user: '1', target: null, inserts: 0 }
  const connection = { execute: async (sql, params) => {
    if (sql.includes('FROM users')) return [state.user ? [{ id: state.user }] : []]
    if (sql.includes('FROM learning_lessons')) return [[state.lesson]]
    if (sql.includes('FROM progress')) return [[state.source]]
    if (sql.includes('FROM learning_progress')) return [state.target ? [state.target] : []]
    if (sql.startsWith('INSERT')) { state.inserts++; state.target = Object.fromEntries(learningProgressTargetFields.map((field, i) => [field, params[i]])); return [{}] }
    throw Error('unexpected_sql')
  } }
  return { writer, entry, state, connection }
}
it('writes once and verifies the complete target on exact repeats', async () => {
  const f = fixture()
  expect((await f.writer.write(f.connection, f.entry)).applied).toBe(true)
  expect((await f.writer.write(f.connection, f.entry)).applied).toBe(false)
  expect(f.state.inserts).toBe(1)
  expect(f.state.target.watched_ms).toBe('2049000')
})
it('rejects parent remapping, missing users and changed sources before any insert', async () => {
  for (const change of [s => { s.user = null }, s => { s.lesson.episodeId = '101' }, s => { s.lesson.sourceHash = 'c'.repeat(64) }, s => { s.source.completed = '0' }]) {
    const f = fixture(); change(f.state)
    await expect(f.writer.write(f.connection, f.entry)).rejects.toThrow()
    expect(f.state.inserts).toBe(0)
  }
})
it('never overwrites a changed target field', async () => {
  for (const field of learningProgressTargetFields) {
    const f = fixture(); await f.writer.write(f.connection, f.entry)
    f.state.target[field] = field.endsWith('_at_utc') ? '2026-09-08 00:00:00.000' : 'changed'
    await expect(f.writer.write(f.connection, f.entry)).rejects.toThrow()
    expect(f.state.inserts).toBe(1)
  }
})
it('does not insert during verify-only recovery or retry after a lost insert response', async () => {
  const f = fixture()
  await expect(f.writer.write(f.connection, f.entry, { verifyOnly: true })).rejects.toThrow('not_committed')
  expect(f.state.inserts).toBe(0)
  const execute = f.connection.execute
  f.connection.execute = async (sql, params) => { const result = await execute(sql, params); if (sql.startsWith('INSERT')) throw Error('connection_lost'); return result }
  await expect(f.writer.write(f.connection, f.entry)).rejects.toThrow('connection_lost')
  expect(f.state.inserts).toBe(1)
})
