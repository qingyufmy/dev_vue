import { access, mkdir, statfs } from 'node:fs/promises'
import { constants as fsConstants } from 'node:fs'
import { queryAll, queryOne, queryRun, withTransaction } from '../db.js'
import { createStorageService } from './storage-service.js'
import { getStorageLocalRoot } from './storage-config.js'

const DEFAULT_BATCH_SIZE = 50
const MAINTENANCE_INTERVAL_MS = 6 * 60 * 60 * 1000
const LOW_FREE_BYTES = 5 * 1024 * 1024 * 1024

function safeInteger(value) {
  const number = Number(value)
  return Number.isSafeInteger(number) && number >= 0 ? number : 0
}

export async function getStorageOperationsSummary({ queryAllImpl = queryAll, localRoot = getStorageLocalRoot(), statfsImpl = statfs, accessImpl = access, mkdirImpl = mkdir } = {}) {
  const queriedRows = await queryAllImpl(`SELECT storage_provider, purpose, status,
    COUNT(*) AS file_count, COALESCE(SUM(size_bytes), 0) AS total_bytes
    FROM stored_files GROUP BY storage_provider, purpose, status
    ORDER BY storage_provider, purpose, status`)
  const rows = Array.isArray(queriedRows) ? queriedRows : []
  const totals = { files:0, bytes:0, uploading:0, failed:0, deleting:0 }
  const groups = rows.map(row => {
    const item = {
      provider:String(row.storage_provider || ''), purpose:String(row.purpose || ''), status:String(row.status || ''),
      file_count:safeInteger(row.file_count), total_bytes:safeInteger(row.total_bytes),
    }
    totals.files += item.file_count
    totals.bytes += item.total_bytes
    if (item.status === 'uploading') totals.uploading += item.file_count
    if (item.status === 'failed') totals.failed += item.file_count
    if (item.status === 'deleting') totals.deleting += item.file_count
    return item
  })
  const checkedAt = new Date().toISOString()
  let local = { ok:false, writable:false, root_configured:true, checked_at:checkedAt, error:'storage_local_unavailable' }
  try {
    await mkdirImpl(localRoot, { recursive:true })
    await accessImpl(localRoot, fsConstants.R_OK | fsConstants.W_OK)
    const info = await statfsImpl(localRoot)
    const blockSize = safeInteger(info.bsize || info.frsize)
    const totalBytes = safeInteger(info.blocks) * blockSize
    const freeBytes = safeInteger(info.bavail) * blockSize
    local = {
      ok:true, writable:true, root_configured:true, checked_at:checkedAt,
      total_bytes:totalBytes, free_bytes:freeBytes,
      free_percent:totalBytes > 0 ? Number((freeBytes / totalBytes * 100).toFixed(1)) : null,
      low_space:totalBytes > 0 && (freeBytes < LOW_FREE_BYTES || freeBytes / totalBytes < 0.1),
    }
  } catch {}
  return { checked_at:checkedAt, totals, groups, local }
}

async function isStoredFileReferenced(storedFileId, { queryOneImpl = queryOne } = {}) {
  const row = await queryOneImpl(`SELECT
    EXISTS(SELECT 1 FROM course_resources WHERE stored_file_id = ?) AS course_resource_ref,
    EXISTS(SELECT 1 FROM post_assets WHERE stored_file_id = ?) AS post_asset_ref,
    EXISTS(SELECT 1 FROM video_streams WHERE stored_file_id = ?) AS video_stream_ref`,
  [storedFileId, storedFileId, storedFileId])
  return Boolean(Number(row?.course_resource_ref) || Number(row?.post_asset_ref) || Number(row?.video_stream_ref))
}

async function deleteTrackedObject(row, { storage, queryRunImpl = queryRun, queryOneImpl = queryOne } = {}) {
  if (!row?.id || !row.object_key || !['local', 'qiniu'].includes(String(row.storage_provider || ''))) return { skipped:true, reason:'invalid_record' }
  if (await isStoredFileReferenced(row.id, { queryOneImpl })) return { skipped:true, reason:'still_referenced' }
  try {
    await storage.delete({ provider:row.storage_provider, objectKey:row.object_key })
    await queryRunImpl("UPDATE stored_files SET status = 'deleted', deleted_at = NOW(), updated_at = NOW() WHERE id = ? AND status = 'deleting'", [row.id])
    return { deleted:true }
  } catch {
    await queryRunImpl("UPDATE stored_files SET status = 'deleting', updated_at = NOW() WHERE id = ?", [row.id]).catch(() => {})
    return { failed:true }
  }
}

export async function runStorageMaintenance({ batchSize = DEFAULT_BATCH_SIZE, queryAllImpl = queryAll, queryOneImpl = queryOne, queryRunImpl = queryRun, withTransactionImpl = withTransaction, storage:providedStorage } = {}) {
  const limit = Math.min(200, Math.max(1, Number(batchSize) || DEFAULT_BATCH_SIZE))
  const storage = providedStorage || await createStorageService()
  const expired = await queryAllImpl(`SELECT s.id AS session_id, s.stored_file_id AS id, sf.storage_provider, sf.object_key
    FROM storage_upload_sessions s INNER JOIN stored_files sf ON sf.id = s.stored_file_id
    WHERE s.status = 'pending' AND s.expires_at < NOW()
    ORDER BY s.expires_at ASC LIMIT ${limit}`)
  const expiredRows = []
  for (const candidate of expired) {
    const claimed = await withTransactionImpl(async run => {
      const [sessions] = await run("SELECT status FROM storage_upload_sessions WHERE id = ? FOR UPDATE", [candidate.session_id])
      if (sessions?.[0]?.status !== 'pending') return false
      await run("UPDATE storage_upload_sessions SET status = 'failed' WHERE id = ? AND status = 'pending'", [candidate.session_id])
      await run("UPDATE stored_files SET status = 'deleting', updated_at = NOW() WHERE id = ? AND status = 'uploading'", [candidate.id])
      return true
    })
    if (claimed) expiredRows.push(candidate)
  }
  const deleting = await queryAllImpl(`SELECT id, storage_provider, object_key FROM stored_files
    WHERE status = 'deleting' ORDER BY updated_at ASC LIMIT ${limit}`)
  const candidates = new Map()
  for (const row of [...expiredRows, ...deleting]) candidates.set(Number(row.id), row)
  const result = { expired_sessions:expiredRows.length, deleted:0, failed:0, still_referenced:0, invalid:0 }
  for (const row of candidates.values()) {
    const outcome = await deleteTrackedObject(row, { storage, queryRunImpl, queryOneImpl })
    if (outcome.deleted) result.deleted += 1
    else if (outcome.failed) result.failed += 1
    else if (outcome.reason === 'still_referenced') result.still_referenced += 1
    else result.invalid += 1
  }
  return result
}

let maintenanceTimer = null

export function startStorageMaintenance({ intervalMs = MAINTENANCE_INTERVAL_MS } = {}) {
  if (maintenanceTimer) return maintenanceTimer
  const run = () => runStorageMaintenance().then(result => {
    if (result.expired_sessions || result.deleted || result.failed) {
      console.log(`[StorageMaintenance] expired=${result.expired_sessions} deleted=${result.deleted} failed=${result.failed} referenced=${result.still_referenced}`)
    }
  }).catch(error => console.error('[StorageMaintenance] Cycle failed:', String(error?.code || error?.message || 'storage_maintenance_failed').slice(0, 120)))
  void run()
  maintenanceTimer = setInterval(run, Math.max(60_000, Number(intervalMs) || MAINTENANCE_INTERVAL_MS))
  maintenanceTimer.unref?.()
  console.log(`[StorageMaintenance] Scheduled every ${Math.round((Number(intervalMs) || MAINTENANCE_INTERVAL_MS) / 60_000)} minutes`)
  return maintenanceTimer
}

export function stopStorageMaintenance() {
  if (maintenanceTimer) clearInterval(maintenanceTimer)
  maintenanceTimer = null
}
