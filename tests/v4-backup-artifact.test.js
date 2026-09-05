import { createHash } from 'node:crypto'
import { mkdtemp, writeFile, rm, mkdir, symlink, link } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { buildBackupDumpPlan, verifyBackupArtifact } from '../scripts/lib/v4-backup-artifact.mjs'

const folders = []
const payload = Buffer.from('仅供离线测试\u0000\xffSQL not executed', 'utf8')
const expected = { sha256: createHash('sha256').update(payload).digest('hex'), bytes: String(payload.length) }
async function fixture() {
  const folder = await mkdtemp(join(tmpdir(), 'v4-backup-test-'))
  folders.push(folder)
  const file = join(folder, 'fixture.bin')
  await writeFile(file, payload)
  return { folder, file }
}
afterEach(async () => { for (const folder of folders.splice(0)) await rm(folder, { recursive: true }) })

describe('backup file integrity gate', () => {
  it('hashes original bytes without exposing payload or claiming restore', async () => {
    const { file } = await fixture()
    const result = await verifyBackupArtifact(file, expected)
    expect(result).toMatchObject({ ...expected, status: 'verified', scope: 'file_bytes_only', restorationVerified: false, sqlReviewed: false })
    expect(JSON.stringify(result)).not.toContain('SQL not executed')
  })
  it('rejects wrong size/hash, relative paths, unsafe expected counts and missing files', async () => {
    const { file, folder } = await fixture()
    await expect(verifyBackupArtifact(file, { ...expected, bytes: '1' })).rejects.toThrow('backup_artifact_size_mismatch')
    await expect(verifyBackupArtifact(file, { ...expected, sha256: '0'.repeat(64) })).rejects.toThrow('backup_artifact_hash_mismatch')
    await expect(verifyBackupArtifact('relative.sql', expected)).rejects.toThrow('backup_path_invalid')
    await expect(verifyBackupArtifact(file, { ...expected, bytes: '-1' })).rejects.toThrow('backup_artifact_expectation_invalid')
    await expect(verifyBackupArtifact(file, { ...expected, bytes: '01' })).rejects.toThrow('backup_artifact_expectation_invalid')
    await expect(verifyBackupArtifact(join(folder, 'missing-secret'), expected)).rejects.toThrow('backup_artifact_read_failed')
    await expect(verifyBackupArtifact(file, expected, { maxBytes: 1 })).rejects.toThrow('backup_artifact_too_large')
  })
  it('rejects directories, hardlinks and junction traversal', async () => {
    const { file, folder } = await fixture()
    await expect(verifyBackupArtifact(folder, expected)).rejects.toThrow()
    const second = join(folder, 'hardlink.bin')
    await link(file, second)
    await expect(verifyBackupArtifact(second, expected)).rejects.toThrow('backup_artifact_not_regular')
    const actual = join(folder, 'actual')
    await mkdir(actual)
    await writeFile(join(actual, 'file.bin'), payload)
    const alias = join(folder, 'alias')
    await symlink(actual, alias, process.platform === 'win32' ? 'junction' : 'dir')
    await expect(verifyBackupArtifact(join(alias, 'file.bin'), expected)).rejects.toThrow('backup_path_symlink')
  })
  it('streams a multi-chunk artifact', async () => {
    const { file } = await fixture()
    const large = Buffer.alloc(2 * 1024 * 1024, 0xa5)
    await writeFile(file, large)
    expect(await verifyBackupArtifact(file, { sha256: createHash('sha256').update(large).digest('hex'), bytes: String(large.length) })).toMatchObject({ bytes: String(large.length) })
  })
})

describe('backup dump option preview', () => {
  it('does not execute or silently include write/global scope flags', () => {
    const result = buildBackupDumpPlan({ sourceDatabase: 'dev_vue', mysqlVersion: '8.4.8', dumpVersion: '8.4.8' })
    expect(result.executable).toBe(false)
    expect(result.args).toContain('--set-gtid-purged=OFF')
    expect(result.args.at(-1)).toBe('dev_vue')
    expect(result.args).not.toContain('--databases')
    expect(result.args).not.toContain('--force')
    expect(result.args).toContain('--skip-add-drop-table')
    expect(result.args).toContain('--skip-add-locks')
    expect(result.requiredGates).toContain('encrypted_backup_and_separate_key')
  })
  it('rejects another source or unverified client/server versions', () => {
    for (const options of [{ sourceDatabase: 'mysql', mysqlVersion: '8.4.8', dumpVersion: '8.4.8' },
      { sourceDatabase: 'dev_vue', mysqlVersion: '5.7.44', dumpVersion: '8.4.8' },
      { sourceDatabase: 'dev_vue', mysqlVersion: '8.4.8', dumpVersion: '9.0.0' }]) {
      expect(() => buildBackupDumpPlan(options)).toThrow()
    }
  })
})
