import { describe, expect, it } from 'vitest'
import { settingsCredentialFixture } from './fixtures/settings-credential-fixture.mjs'
import { createCredentialSettingsWriter, settingsTargetFields } from '../scripts/lib/mysql-settings-credential-writer.mjs'
function fixture() {
  const { row, options } = settingsCredentialFixture(), writer = createCredentialSettingsWriter([row], options)
  const entry = writer.prepared.entries[0]
  let source = { ...row }, target = null, inserts = 0
  const connection = { execute: async (sql, params) => {
    if (sql.includes('FROM system_config')) return [[source], []]
    if (sql.includes('FROM system_settings')) return [target ? [{ ...target }] : [], []]
    if (sql.startsWith('INSERT')) { inserts++; target = Object.fromEntries(settingsTargetFields.map((field, i) => [field, params[i]])); return [{ affectedRows: 1 }, []] }
    throw Error('unexpected_sql')
  } }
  return { writer, entry, connection, inserts: () => inserts, changeSource: value => { source = { ...source, ...value } }, changeTarget: value => { target = { ...target, ...value } } }
}
describe('closed settings import writer', () => {
  it('inserts once, verifies all target fields and treats exact repeats as no-ops', async () => {
    const f = fixture()
    expect((await f.writer.write(f.connection, f.entry)).applied).toBe(true)
    expect((await f.writer.write(f.connection, f.entry)).applied).toBe(false)
    expect(f.inserts()).toBe(1)
  })
  it('rejects source drift or caller-modified sensitivity before insertion', async () => {
    const f = fixture(); f.changeSource({ value: 'true' })
    await expect(f.writer.write(f.connection, f.entry)).rejects.toThrow('source_changed')
    expect(f.inserts()).toBe(0)
    const g = fixture(); g.entry.target.sensitivity = 'public'
    await expect(g.writer.write(g.connection, g.entry)).rejects.toThrow('input_changed')
    expect(g.inserts()).toBe(0)
  })
  it('rejects every conflicting saved field and never overwrites', async () => {
    for (const field of settingsTargetFields) {
      const f = fixture(); await f.writer.write(f.connection, f.entry)
      const replacement = field.endsWith('_at_utc') ? '2026-09-08 00:00:00.000' : 'changed'
      f.changeTarget({ [field]: replacement })
      await expect(f.writer.write(f.connection, f.entry)).rejects.toThrow()
      expect(f.inserts()).toBe(1)
    }
  })
  it('does not create missing data in verify-only recovery', async () => {
    const f = fixture()
    await expect(f.writer.write(f.connection, f.entry, { verifyOnly: true })).rejects.toThrow('not_committed')
    expect(f.inserts()).toBe(0)
  })
  it('rejects a corrupt insert readback and leaves rollback to the transaction owner', async () => {
    const f = fixture(), execute = f.connection.execute
    f.connection.execute = async (sql, params) => {
      const result = await execute(sql, params)
      if (sql.startsWith('INSERT')) f.changeTarget({ revision: '2' })
      return result
    }
    await expect(f.writer.write(f.connection, f.entry)).rejects.toThrow('readback_mismatch')
    expect(f.inserts()).toBe(1)
  })
  it('propagates an uncertain insert response without replaying the insert', async () => {
    const f = fixture(), execute = f.connection.execute
    f.connection.execute = async (sql, params) => {
      const result = await execute(sql, params)
      if (sql.startsWith('INSERT')) throw Error('connection_lost')
      return result
    }
    await expect(f.writer.write(f.connection, f.entry)).rejects.toThrow('connection_lost')
    expect(f.inserts()).toBe(1)
  })
})
