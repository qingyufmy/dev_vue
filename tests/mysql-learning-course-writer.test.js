import { describe, expect, it } from 'vitest'
import { createLearningCourseWriter } from '../scripts/lib/mysql-learning-course-writer.mjs'
import { learningCourseFixture } from './fixtures/learning-course-fixture.mjs'

function fixture() {
  const { source, options } = learningCourseFixture()
  const writer = createLearningCourseWriter([source], options)
  const entry = writer.prepared.entries[0]
  const tables = new Map(['learning_courses', 'learning_lessons', 'learning_media_references'].map(table => [table, []]))
  const calls = []
  let nextId = 9007199254740993n
  const connection = { async execute(sql, args) {
    calls.push(sql)
    if (sql.includes('FROM courses WHERE')) return [[structuredClone(source)]]
    const table = /(?:FROM|INTO) (learning_\w+)/.exec(sql)?.[1]
    if (!table) throw new Error('unexpected SQL')
    const rows = tables.get(table)
    if (sql.startsWith('INSERT')) {
      const fields = /\(([^)]+)\) VALUES/.exec(sql)[1].split(',')
      const row = Object.fromEntries(fields.map((field, index) => [field, args[index]]))
      if (!row.id) row.id = String(nextId++)
      rows.push(row)
      return [{ insertId: 1 }]
    }
    if (sql.startsWith('SELECT source_kind')) return [rows.filter(row => row.lesson_id === args[0]).map(row => ({ source_kind: row.source_kind }))]
    const keys = sql.slice(sql.indexOf(' WHERE ') + 7, sql.indexOf(' FOR UPDATE')).split(' AND ').map(part => part.split('=')[0])
    return [structuredClone(rows.filter(row => keys.every((key, index) => row[key] === args[index])))]
  } }
  return { source, writer, entry, tables, calls, connection }
}

describe('learning course writer', () => {
  it('writes parents and media once, reads exact generated IDs, and verifies without inserts', async () => {
    const f = fixture()
    const first = await f.writer.write(f.connection, f.entry)
    expect(first).toMatchObject({ inserted: 4, courseId: '12', lessonId: '12' })
    expect(first.media.map(row => row.id)).toEqual(['9007199254740993', '9007199254740994'])
    expect((await f.writer.write(f.connection, f.entry)).inserted).toBe(0)
    expect((await f.writer.write(f.connection, f.entry, { verifyOnly: true })).inserted).toBe(0)
    expect(f.calls.filter(sql => sql.startsWith('INSERT'))).toHaveLength(4)
  })
  it('rejects source drift and caller target mutation before inserting', async () => {
    const f = fixture()
    f.source.description = 'changed'
    await expect(f.writer.write(f.connection, f.entry)).rejects.toThrow('learning_course_writer_source')
    f.entry.targets.course.title = 'changed'
    await expect(f.writer.write(f.connection, f.entry)).rejects.toThrow('learning_course_writer_input')
    expect(f.calls.filter(sql => sql.startsWith('INSERT'))).toHaveLength(0)
  })
  it('does not repair missing rows in verify-only or overwrite conflicts', async () => {
    const f = fixture()
    await expect(f.writer.write(f.connection, f.entry, { verifyOnly: true })).rejects.toThrow('learning_course_writer_not_committed')
    expect(f.calls.filter(sql => sql.startsWith('INSERT'))).toHaveLength(0)
    await f.writer.write(f.connection, f.entry)
    f.tables.get('learning_lessons')[0].public_episode_id = '101'
    await expect(f.writer.write(f.connection, f.entry)).rejects.toThrow('learning_course_writer_conflict')
    expect(f.tables.get('learning_lessons')[0].public_episode_id).toBe('101')
  })
  it('rejects unexpected media without deleting it', async () => {
    const f = fixture()
    await f.writer.write(f.connection, f.entry)
    f.tables.get('learning_media_references').push({ id: '999', lesson_id: '12', source_kind: 'youtube_id' })
    await expect(f.writer.write(f.connection, f.entry)).rejects.toThrow('learning_course_writer_unexpected_media')
    expect(f.tables.get('learning_media_references')).toHaveLength(3)
  })
  it('propagates an unknown insert result without retry or commit', async () => {
    const f = fixture()
    const execute = f.connection.execute
    f.connection.execute = async (sql, args) => {
      const result = await execute(sql, args)
      if (sql.startsWith('INSERT')) throw new Error('lost acknowledgement')
      return result
    }
    await expect(f.writer.write(f.connection, f.entry)).rejects.toThrow('lost acknowledgement')
    expect(f.calls.filter(sql => sql.startsWith('INSERT'))).toHaveLength(1)
  })
})
