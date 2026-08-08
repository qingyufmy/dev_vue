import { randomBytes } from 'crypto'
import { basename, dirname, extname, join, resolve, sep } from 'path'
import { fileURLToPath } from 'url'
import { existsSync, mkdirSync, rmSync, unlinkSync, writeFileSync } from 'fs'

const __dirname = dirname(fileURLToPath(import.meta.url))

export const COURSE_ATTACHMENT_MAX_BYTES = 20 * 1024 * 1024
export const COURSE_ATTACHMENT_ACCEPT = '.pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.csv,.txt,.md,.zip,.rar,.7z'

const allowedExtensions = new Set(COURSE_ATTACHMENT_ACCEPT.split(','))
const attachmentRoot = resolve(
  process.env.COURSE_ATTACHMENT_DIR || join(__dirname, 'private-uploads', 'course-attachments'),
)

function ensureDirectory(path) {
  if (!existsSync(path)) mkdirSync(path, { recursive:true })
}

function safeEpisodeId(value) {
  const id = Number(value)
  if (!Number.isInteger(id) || id <= 0) throw new Error('invalid_course_id')
  return id
}

function cleanOriginalName(value) {
  return basename(String(value || '').trim()).replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 240)
}

export function validateCourseAttachmentFile(file = {}) {
  const metadata = validateCourseAttachmentMetadata(file)
  if (!metadata.ok) return metadata
  if (!file.buffer) return { ok:false, error:'附件内容为空' }
  return metadata
}

// Browser direct-upload sessions have no multipart buffer yet. Validate the
// same name/extension/size contract before issuing a qiniu token, then let the
// confirm phase verify the remote object size and MIME metadata.
export function validateCourseAttachmentMetadata(file = {}) {
  const originalName = cleanOriginalName(file.originalname)
  const extension = extname(originalName).toLowerCase()
  const size = Number(file.size || file.buffer?.length || 0)
  if (!originalName || !extension || !allowedExtensions.has(extension)) {
    return { ok:false, error:'仅支持 PDF、Office 文档、表格、文本和压缩包' }
  }
  if (size <= 0) return { ok:false, error:'附件内容为空' }
  if (size > COURSE_ATTACHMENT_MAX_BYTES) return { ok:false, error:'单个附件不能超过 20 MB' }
  return {
    ok:true,
    originalName,
    extension,
    size,
    mimeType:String(file.mimetype || 'application/octet-stream').slice(0, 120),
  }
}

export function storeCourseAttachmentFile(episodeValue, file) {
  const episodeId = safeEpisodeId(episodeValue)
  const validation = validateCourseAttachmentFile(file)
  if (!validation.ok) throw new Error(validation.error)
  const episodeDirectory = resolve(attachmentRoot, `ep${episodeId}`)
  ensureDirectory(episodeDirectory)
  const storedName = `${Date.now()}_${randomBytes(8).toString('hex')}${validation.extension}`
  const filePath = resolve(episodeDirectory, storedName)
  if (!filePath.startsWith(`${episodeDirectory}${sep}`)) throw new Error('invalid_attachment_path')
  writeFileSync(filePath, file.buffer)
  const uploadedAt = new Date().toISOString()
  return {
    episodeId,
    title:validation.originalName,
    uri:`course-attachment://ep${episodeId}/${storedName}`,
    filePath,
    metadata:{
      original_name:validation.originalName,
      mime_type:validation.mimeType,
      file_size:validation.size,
      extension:validation.extension,
      uploaded_at:uploadedAt,
    },
  }
}

export function parseCourseAttachmentMetadata(row = {}) {
  let metadata = {}
  try { metadata = JSON.parse(row.structure || '{}') || {} } catch {}
  const fileName = cleanOriginalName(row.original_name || metadata.original_name || row.title || '课程附件') || '课程附件'
  const extension = String(row.extension || metadata.extension || extname(fileName) || '').toLowerCase()
  return {
    fileName,
    extension,
    mimeType:String(row.mime_type || metadata.mime_type || 'application/octet-stream'),
    fileSize:Math.max(0, Number(row.size_bytes ?? metadata.file_size ?? 0)),
    uploadedAt:metadata.uploaded_at || row.created_at || null,
  }
}

export function serializeCourseAttachment(row = {}) {
  const metadata = parseCourseAttachmentMetadata(row)
  const episodeId = Number(row.episode_id || 0)
  const id = Number(row.id || 0)
  return {
    id,
    episode_id:episodeId,
    title:row.title || metadata.fileName,
    file_name:metadata.fileName,
    file_size:metadata.fileSize,
    mime_type:metadata.mimeType,
    extension:metadata.extension,
    uploaded_at:metadata.uploadedAt,
    storage_provider:row.storage_provider || 'legacy',
    stored_file_id:row.stored_file_id ? Number(row.stored_file_id) : null,
    sort_order:Number(row.sort_order || 0),
    download_url:`/api/course-items/${episodeId}/attachments/${id}/download`,
  }
}

export function resolveCourseAttachmentPath(row = {}) {
  const uri = String(row.url || '')
  const match = uri.match(/^course-attachment:\/\/ep(\d+)\/([a-zA-Z0-9_-]+\.[a-zA-Z0-9]+)$/)
  if (!match || Number(match[1]) !== Number(row.episode_id)) return null
  const episodeDirectory = resolve(attachmentRoot, `ep${Number(match[1])}`)
  const filePath = resolve(episodeDirectory, match[2])
  return filePath.startsWith(`${episodeDirectory}${sep}`) ? filePath : null
}

export function deleteCourseAttachmentFile(row = {}) {
  const filePath = resolveCourseAttachmentPath(row)
  if (!filePath || !existsSync(filePath)) return false
  unlinkSync(filePath)
  return true
}

export function deleteCourseAttachmentDirectory(episodeValue) {
  const episodeId = safeEpisodeId(episodeValue)
  const episodeDirectory = resolve(attachmentRoot, `ep${episodeId}`)
  if (!episodeDirectory.startsWith(`${attachmentRoot}${sep}`)) throw new Error('invalid_attachment_path')
  if (!existsSync(episodeDirectory)) return false
  rmSync(episodeDirectory, { recursive:true, force:true })
  return true
}

export function courseAttachmentRootForTests() {
  return attachmentRoot
}
