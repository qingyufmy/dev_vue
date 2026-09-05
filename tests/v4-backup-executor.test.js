import { describe, expect, it } from 'vitest'
import { backupExecutionConfig, backupDumpArgs, backupRestoreArgs, backupGpgArgs, compareRestoredDump } from '../scripts/lib/v4-backup-executor.mjs'

const uuid = 'ac423207-6ef3-11f1-b302-000c29fda104'
describe('backup execution scope', () => {
  it('binds one exact new source mirror and private paths', () => {
    const config = backupExecutionConfig({ runId: '20260905-01', serverUuid: uuid, ddlWindowConfirmed: true })
    expect(config.target).toBe('dev_vue_m1_source_20260905_01')
    expect(config.directory).toBe('/www/backup/aurum-v4/m1/20260905-01')
    expect(config.keyDirectory).toBe('/root/.local/share/aurum-v4-backup-keys/m1-20260905-01')
    expect(Object.isFrozen(config)).toBe(true)
  })
  it('rejects missing DDL confirmation, malformed scope and instance', () => {
    expect(() => backupExecutionConfig({ runId: '20260905-01', serverUuid: uuid })).toThrow('backup_ddl_window_required')
    for (const runId of ['../../data', '20260905_01', 'dev_vue', '', '20260905-01;']) {
      expect(() => backupExecutionConfig({ runId, serverUuid: uuid, ddlWindowConfirmed: true })).toThrow()
    }
    expect(() => backupExecutionConfig({ runId: '20260905-01', serverUuid: 'unknown', ddlWindowConfirmed: true })).toThrow()
  })
  it('never permits restoration into original, A/B or arbitrary schemas', () => {
    for (const database of ['dev_vue', 'dev_vue_m1_a', 'dev_vue_m1_b', 'mysql', 'x;DROP DATABASE y']) {
      expect(() => backupRestoreArgs(database)).toThrow('backup_restore_target_invalid')
    }
  })
  it('uses deterministic row dumps and non-replaying binary imports without shell credentials', () => {
    const args = backupDumpArgs('dev_vue')
    expect(args[0]).toBe('--defaults-file=/proc/self/fd/3')
    for (const required of ['--single-transaction', '--order-by-primary', '--skip-extended-insert', '--complete-insert', '--no-autocommit', '--skip-add-drop-table', '--skip-add-locks', '--skip-disable-keys']) expect(args).toContain(required)
    const restore = backupRestoreArgs('dev_vue_m1_source_20260905_01')
    expect(restore).toContain('--binary-mode')
    expect(restore).toContain('--skip-reconnect')
    expect(restore).toContain('--local-infile=0')
    for (const forbidden of ['--force', '--databases', '--all-databases', '--replace', '--insert-ignore']) expect([...args, ...restore]).not.toContain(forbidden)
    expect([...args, ...restore].some(arg => arg.startsWith('--password'))).toBe(false)
  })
  it('uses isolated GPG, an FD passphrase and explicit iterated derivation without ignoring integrity', () => {
    const args = backupGpgArgs('/private/gnupg')
    expect(args).toContain('--no-options')
    expect(args).toContain('--no-autostart')
    expect(args).toContain('--no-symkey-cache')
    expect(args.slice(args.indexOf('--passphrase-fd'), args.indexOf('--passphrase-fd') + 2)).toEqual(['--passphrase-fd', '3'])
    expect(args).toContain('65011712')
    const decrypt = backupGpgArgs('/private/gnupg', true)
    expect(decrypt).toContain('--decrypt')
    expect(decrypt).not.toContain('--ignore-mdc-error')
    expect(args).not.toContain('--passphrase')
  })
})

describe('restored data parity', () => {
  const review = { tables: [{ name: 'a', rows: '9007199254740993', dataSha256: 'a'.repeat(64) }, { name: 'b', rows: '0', dataSha256: 'b'.repeat(64) }] }
  const observation = { tables: [{ name: 'a', rowCount: '9007199254740993' }, { name: 'b', rowCount: '0' }] }
  it('compares every ordered INSERT hash and exact COUNT without Number coercion', () => {
    expect(compareRestoredDump(review, review, observation)).toMatchObject({ matched: true, rows: '9007199254740993', tableCount: 2 })
  })
  it('rejects equal counts with changed contents, missing, duplicate or extra table', () => {
    for (const tables of [
      [review.tables[0]], [review.tables[0], review.tables[0]],
      [{ ...review.tables[0], dataSha256: 'c'.repeat(64) }, review.tables[1]],
      [...review.tables, { name: 'c', rows: '0', dataSha256: 'c'.repeat(64) }],
    ]) expect(() => compareRestoredDump(review, { tables }, observation)).toThrow()
    expect(() => compareRestoredDump(review, review, { tables: [{ name: 'a', rowCount: '1' }, observation.tables[1]] })).toThrow('backup_restore_data_mismatch')
  })
})
