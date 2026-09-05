import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, open, realpath } from 'node:fs/promises'
import { isAbsolute, parse, resolve, dirname } from 'node:path'

export class BackupArtifactError extends Error {
  constructor(code) { super(code); this.name = 'BackupArtifactError'; this.code = code }
}

export function requireBackup(condition, code) {
  if (!condition) throw new BackupArtifactError(code)
}

const sha256Pattern = /^[a-f0-9]{64}$/
const bytesPattern = /^[1-9][0-9]{0,19}$/

// Only reads an existing local regular file. It never decrypts, restores or executes SQL.
export async function verifyBackupArtifact(filePath, expected, { maxBytes } = {}) {
  requireBackup(typeof filePath === 'string' && isAbsolute(filePath), 'backup_path_invalid')
  requireBackup(typeof expected?.sha256 === 'string' && sha256Pattern.test(expected.sha256)
    && typeof expected?.bytes === 'string' && bytesPattern.test(expected.bytes), 'backup_artifact_expectation_invalid')
  if (maxBytes !== undefined) requireBackup(BigInt(expected.bytes) <= BigInt(maxBytes), 'backup_artifact_too_large')
  let handle
  try {
    const resolved = resolve(filePath)
    // Reject symlink/junction traversal, not merely a final-component symlink.
    let current = resolved
    while (true) {
      const stat = await lstat(current)
      requireBackup(!stat.isSymbolicLink(), 'backup_path_symlink')
      if (current === parse(current).root) break
      current = dirname(current)
    }
    requireBackup(await realpath(resolved) === resolved, 'backup_path_alias')
    handle = await open(resolved, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
    const before = await handle.stat({ bigint: true })
    requireBackup(before.isFile() && before.nlink === 1n, 'backup_artifact_not_regular')
    requireBackup(before.size === BigInt(expected.bytes), 'backup_artifact_size_mismatch')
    const hash = createHash('sha256')
    let bytes = 0n
    for await (const chunk of handle.createReadStream({ autoClose: false, highWaterMark: 256 * 1024 })) {
      bytes += BigInt(chunk.length)
      requireBackup(bytes <= before.size, 'backup_artifact_changed')
      hash.update(chunk)
    }
    const after = await handle.stat({ bigint: true })
    const pathAfter = await lstat(resolved, { bigint: true })
    requireBackup(!pathAfter.isSymbolicLink() && ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs', 'nlink'].every(key => before[key] === after[key] && after[key] === pathAfter[key]), 'backup_artifact_changed')
    requireBackup(bytes === before.size, 'backup_artifact_changed')
    const actualHash = hash.digest('hex')
    requireBackup(actualHash === expected.sha256, 'backup_artifact_hash_mismatch')
    return { status: 'verified', scope: 'file_bytes_only', sha256: actualHash, bytes: bytes.toString(),
      sqlReviewed: false, decryptionVerified: false, restorationVerified: false }
  } catch (error) {
    if (error instanceof BackupArtifactError) throw error
    throw new BackupArtifactError('backup_artifact_read_failed')
  } finally {
    await handle?.close()
  }
}

// Preview only: the later authorized runner must validate paths/permissions and encryption first.
export function buildBackupDumpPlan({ sourceDatabase, mysqlVersion, dumpVersion }) {
  requireBackup(sourceDatabase === 'dev_vue', 'backup_source_invalid')
  requireBackup(/^8\.4\.\d+(?:[-+][a-zA-Z0-9.-]+)?$/.test(mysqlVersion ?? '') && /^8\.4\.\d+(?:[-+][a-zA-Z0-9.-]+)?$/.test(dumpVersion ?? ''), 'backup_version_unsupported')
  return {
    version: 1, kind: 'v4_backup_dump_preview', executable: false, sourceDatabase,
    // Deliberately no --databases, --force, credentials, arbitrary extra flags or output path.
    args: ['--single-transaction', '--quick', '--hex-blob', '--default-character-set=utf8mb4',
      '--tz-utc', '--no-tablespaces', '--set-gtid-purged=OFF', '--routines', '--events', '--triggers',
      '--skip-lock-tables', '--skip-add-drop-table', '--skip-add-locks', '--complete-insert', sourceDatabase],
    requiredGates: ['source_identity_and_objects', 'ddl_freeze_window', 'private_storage_and_capacity',
      'encrypted_backup_and_separate_key', 'exact_restore_target_authorization', 'restore_sql_scope_review'],
  }
}
