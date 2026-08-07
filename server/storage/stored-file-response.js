import { basename } from 'node:path'
import { loadStoredFile } from './stored-file-service.js'

function safeDownloadName(value) {
  return basename(String(value || '文件').replace(/[\u0000-\u001f\u007f]/g, '')).slice(0, 200) || '文件'
}

// Streams local private files and redirects qiniu files to a fresh short-lived
// signature. No signed URL is ever persisted in a business row.
export async function sendStoredFile({ res, storage, row, download = false }) {
  if (!row || !storage) return false
  const provider = storage.providerNamed(row.storage_provider, row)
  res.set('X-Content-Type-Options', 'nosniff')
  res.set('Cache-Control', row.visibility === 'public' ? 'public, max-age=300' : 'private, no-store')
  if (row.mime_type) res.type(row.mime_type)
  if (download) res.set('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(safeDownloadName(row.original_name))}`)
  if (row.storage_provider === 'qiniu') {
    const url = await storage.createReadUrl({ provider: row.storage_provider, objectKey: row.object_key, purpose: row.purpose }, { ttlSeconds: 300 })
    return res.redirect(302, url)
  }
  if (typeof provider.read !== 'function') return false
  try {
    const info = await provider.stat({ objectKey: row.object_key })
    if (!info.exists) return false
    res.set('Content-Length', String(info.sizeBytes))
    provider.read({ objectKey: row.object_key }).on('error', () => { if (!res.headersSent) res.status(404).end() }).pipe(res)
    return true
  } catch {
    return false
  }
}

export async function loadAndSendStoredFile({ res, storage, storedFileId, download = false }) {
  const row = await loadStoredFile(storedFileId)
  if (!row) return false
  return sendStoredFile({ res, storage, row, download })
}
