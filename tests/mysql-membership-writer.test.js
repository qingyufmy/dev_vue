import { expect, it } from 'vitest'
import { hash } from '../scripts/lib/v4-backfill-contract.mjs'
import { createMembershipWriter } from '../scripts/lib/mysql-membership-writer.mjs'
import { membershipFixture } from './fixtures/membership-fixture.mjs'
function setup() {
  const f = membershipFixture(), writer = createMembershipWriter([f.user], f.options), calls = []
  const db = { source: { ...f.user }, target: null, async execute(sql, values) {
    calls.push(sql)
    if (sql.includes('FROM users')) return [this.source ? [{ ...this.source }] : []]
    if (sql.startsWith('INSERT')) {
      const fields = /\(([^)]+)\) VALUES/.exec(sql)[1].split(',')
      this.target = Object.fromEntries(fields.map((field, i) => [field, values[i]]))
      return [{ affectedRows: 1 }]
    }
    return [this.target ? [{ ...this.target }] : []]
  } }
  return { f, writer, db, calls, entry: writer.prepared.entries[0] }
}
it('locks the current user before inserting and verifies repeat without updates', async () => {
  const { writer, db, calls, entry } = setup()
  expect((await writer.write(db, entry)).applied).toBe(true)
  expect(calls[0]).toContain('FROM users')
  expect(calls[1]).toContain('FROM memberships')
  expect((await writer.write(db, entry, { verifyOnly: true })).applied).toBe(false)
  expect(calls.filter(sql => sql.startsWith('INSERT'))).toHaveLength(1)
  expect(calls.some(sql => /^(UPDATE|DELETE|REPLACE)/.test(sql))).toBe(false)
})
it('refuses missing users or any changed field of the frozen membership source', async () => {
  for (const field of Object.keys(setup().f.user)) {
    const { writer, db, calls, entry } = setup()
    db.source[field] = field === 'id' ? '3' : field.endsWith('_at') ? '2027-01-01 00:00:00' : 'changed'
    await expect(writer.write(db, entry)).rejects.toThrow('membership_writer_source_changed')
    expect(calls).toHaveLength(1)
  }
  const { writer, db, entry } = setup(); db.source = null
  await expect(writer.write(db, entry)).rejects.toThrow('membership_writer_source_changed')
})
it('refuses conflicting targets and missing verify-only rows', async () => {
  const { writer, db, entry } = setup()
  await expect(writer.write(db, entry, { verifyOnly: true })).rejects.toThrow('membership_writer_not_committed')
  await writer.write(db, entry); db.target.revision = '2'
  await expect(writer.write(db, entry)).rejects.toThrow('membership_writer_target_conflict')
})
it('rejects modified input even if a caller recomputes the public target hash', async () => {
  const { writer, db, entry, calls } = setup()
  entry.target.plan_code = 'free'; entry.targetHash = hash(entry.target)
  await expect(writer.write(db, entry)).rejects.toThrow('membership_writer_input_changed')
  expect(calls).toHaveLength(0)
})
