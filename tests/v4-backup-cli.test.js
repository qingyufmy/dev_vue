import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

const root = fileURLToPath(new URL('..', import.meta.url))
const folders = []
afterEach(async () => { for (const folder of folders.splice(0)) await rm(folder, { recursive: true }) })
function run(args, env = {}) {
  return spawnSync(process.execPath, ['scripts/verify-v4-backup.mjs', ...args], { cwd: root, encoding: 'utf8',
    env: { ...process.env, V4_BACKUP_DATABASE: '', V4_BACKUP_SERVER_UUID: '', V4_BACKUP_SOCKET_PATH: '', V4_BACKUP_USER: '', ...env }, timeout: 10000 })
}
describe('backup verification CLI', () => {
  it('offers read-only commands without DB credentials', () => {
    const result = run(['help'])
    expect(result.status).toBe(0)
    expect(JSON.parse(result.stdout)).toMatchObject({ writesDatabase: false, exportsData: false, executesSqlFiles: false })
  })
  it('previews dump options but never runs mysqldump', () => {
    const result = run(['dump-plan', '--mysql-version=8.4.8', '--dump-version=8.4.8'])
    expect(result.status).toBe(0)
    expect(JSON.parse(result.stdout).executable).toBe(false)
  })
  it('rejects apply/restore, unknown flags and duplicates before any connection', () => {
    for (const args of [['restore'], ['inspect-source', '--apply'], ['dump-plan', '--mysql-version=8.4.8', '--mysql-version=8.4.8'], ['help', '--password=secret']]) {
      const result = run(args)
      expect(result.status).toBe(1)
      expect(result.stderr).not.toContain('secret')
      expect(result.stderr).not.toContain('Error:')
    }
  })
  it('requires explicit environment and rejects A/B before opening a socket', () => {
    expect(run(['inspect-source']).status).toBe(1)
    const result = run(['inspect-restored'], { V4_BACKUP_DATABASE: 'dev_vue_m1_a', V4_BACKUP_PASSWORD: 'do-not-print' })
    expect(result.status).toBe(1)
    expect(JSON.parse(result.stderr).code).toBe('backup_database_invalid')
    expect(result.stderr).not.toContain('do-not-print')
  })
  it('verifies observation file hashes and propagates mismatch exit status', async () => {
    const folder = await mkdtemp(join(tmpdir(), 'v4-backup-cli-')); folders.push(folder)
    const baseline = { version: 1, kind: 'v4_backup_database_observation', role: 'source', database: 'dev_vue',
      serverUuid: '00000000-0000-0000-0000-000000000001', totalRows: '1', tables: [{ name: 'users', rowCount: '1' }],
      schemaFingerprint: { sha256: '1'.repeat(64), tableCount: 1, tables: [{ name: 'users', sha256: '2'.repeat(64) }] } }
    const actual = { ...baseline, role: 'restored-source', database: 'dev_vue_m1_source_20260905_01', totalRows: '2', tables: [{ name: 'users', rowCount: '2' }] }
    const files = []
    for (const [name, data] of [['baseline', baseline], ['actual', actual]]) {
      const value = JSON.stringify(data), file = join(folder, `${name}.json`)
      await writeFile(file, value)
      files.push(`--${name}=${file}`, `--${name}-sha256=${createHash('sha256').update(value).digest('hex')}`)
    }
    const result = run(['compare-observations', ...files])
    expect(result.status).toBe(1)
    expect(JSON.parse(result.stdout)).toMatchObject({ status: 'different', migrationReady: false })
    const corrupt = run(['compare-observations', ...files.slice(0, 3), `--actual-sha256=${'0'.repeat(64)}`])
    expect(corrupt.status).toBe(1)
    expect(JSON.parse(corrupt.stderr).code).toBe('backup_artifact_hash_mismatch')
  })
})
