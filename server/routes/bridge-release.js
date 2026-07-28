import { Router } from 'express'
import { readFile } from 'node:fs/promises'

const MAX_MANIFEST_BYTES = 128 * 1024
const ALLOWED_MODULES = new Set([
  'core',
  'adapter.mt5.python',
  'adapter.mt4',
  'data.symbol-map',
])

function validVersion(value) {
  return typeof value === 'string' && /^\d+\.\d+(?:\.\d+){0,2}$/.test(value)
}

function validPackage(pkg) {
  if (!pkg || typeof pkg !== 'object' || Array.isArray(pkg)
    || !ALLOWED_MODULES.has(pkg.module_id)
    || !validVersion(pkg.version)
    || !Number.isSafeInteger(pkg.size_bytes) || pkg.size_bytes <= 0
    || typeof pkg.sha256 !== 'string' || !/^[a-fA-F0-9]{64}$/.test(pkg.sha256)
    || typeof pkg.signature !== 'string' || pkg.signature.length < 1 || pkg.signature.length > 1024
    || !/^[A-Za-z0-9+/]+={0,2}$/.test(pkg.signature)) return false
  try {
    const url = new URL(pkg.url)
    const localHttp = url.protocol === 'http:' && ['127.0.0.1', '::1', 'localhost'].includes(url.hostname)
    if (url.protocol !== 'https:' && !localHttp || url.username || url.password) return false
  } catch {
    return false
  }
  return (pkg.minimum_core_version == null || validVersion(pkg.minimum_core_version))
    && (pkg.maximum_core_version == null || validVersion(pkg.maximum_core_version))
}

function validReleaseId(value) {
  return typeof value === 'string'
    && value.length >= 8 && value.length <= 128
    && /^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value)
}

export function validateBridgeReleaseManifest(manifest, nowUtcMsc = Date.now()) {
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)
    || ![1, 2].includes(manifest.schema_version)
    || !validVersion(manifest.release_version)
    || !Number.isSafeInteger(manifest.generated_at_utc_msc) || manifest.generated_at_utc_msc <= 0
    || !validVersion(manifest.minimum_launcher_version)
    || typeof manifest.signature !== 'string' || !manifest.signature
    || !Array.isArray(manifest.packages) || manifest.packages.length < 1 || manifest.packages.length > 16) return false
  if (manifest.schema_version === 2
    && (!validReleaseId(manifest.release_id)
      || !['normal', 'urgent'].includes(manifest.priority)
      || !Number.isSafeInteger(manifest.published_at_utc_msc) || manifest.published_at_utc_msc <= 0
      || !Number.isSafeInteger(manifest.expires_at_utc_msc)
      || manifest.expires_at_utc_msc <= manifest.published_at_utc_msc
      || manifest.expires_at_utc_msc <= nowUtcMsc
      || manifest.generated_at_utc_msc > manifest.expires_at_utc_msc
      || !Number.isSafeInteger(manifest.minimum_idle_seconds)
      || manifest.minimum_idle_seconds < 30 || manifest.minimum_idle_seconds > 3600
      || manifest.activation_deadline_utc_msc != null
        && (!Number.isSafeInteger(manifest.activation_deadline_utc_msc)
          || manifest.activation_deadline_utc_msc <= manifest.published_at_utc_msc
          || manifest.activation_deadline_utc_msc > manifest.expires_at_utc_msc)
      || !['internal', 'stable'].includes(manifest.rollout_channel)
      || !Number.isSafeInteger(manifest.rollout_percentage)
      || manifest.rollout_percentage < 1 || manifest.rollout_percentage > 100)) return false
  const modules = new Set()
  return manifest.packages.every(pkg => validPackage(pkg) && !modules.has(pkg.module_id) && modules.add(pkg.module_id))
}

export function createBridgeReleaseRouter({
  manifestPath = process.env.BRIDGE_RELEASE_MANIFEST_PATH,
  readManifest = readFile,
} = {}) {
  const router = Router()
  router.get('/bridge/v3/releases/current', async (req, res) => {
    res.set('Cache-Control', 'no-store')
    res.set('X-Content-Type-Options', 'nosniff')
    if (!manifestPath) return res.status(204).end()
    try {
      const content = await readManifest(manifestPath)
      const bytes = Buffer.isBuffer(content) ? content : Buffer.from(content)
      if (bytes.length === 0 || bytes.length > MAX_MANIFEST_BYTES) {
        throw new Error('bridge_release_manifest_size_invalid')
      }
      const manifest = JSON.parse(bytes.toString('utf8'))
      if (!validateBridgeReleaseManifest(manifest)) {
        throw new Error('bridge_release_manifest_invalid')
      }
      return res.json(manifest)
    } catch (error) {
      console.error('[BridgeRelease] manifest unavailable:', error?.message || 'unknown')
      return res.status(503).json({ ok:false, error:'bridge_release_unavailable' })
    }
  })
  return router
}

export default createBridgeReleaseRouter()
