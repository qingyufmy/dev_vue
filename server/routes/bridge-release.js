import { Router } from 'express'
import { createHash, createPublicKey, timingSafeEqual, verify } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'

import { adminOnly, authMiddleware } from '../middleware/auth.js'

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

function validInstallationId(value) {
  return typeof value === 'string'
    && /^install_[a-f0-9]{32}$/.test(value)
}

export function isInstallationInRollout(manifest, installationId, channel = 'stable') {
  if (manifest.schema_version !== 2) return true
  if (!validInstallationId(installationId)
    || !['internal', 'stable'].includes(channel)
    || manifest.rollout_channel !== channel) return false
  if (manifest.rollout_percentage >= 100) return true
  const digest = createHash('sha256')
    .update(`${manifest.release_id}:${installationId}`, 'utf8')
    .digest()
  return digest.readUInt32BE(0) % 100 < manifest.rollout_percentage
}

function canonicalPackage(pkg) {
  return `AURUM-PACKAGE-V1\n${pkg.module_id}\n${pkg.version}\n${pkg.url}\n${pkg.size_bytes}\n${pkg.sha256.toLowerCase()}\n${pkg.minimum_core_version || ''}\n${pkg.maximum_core_version || ''}\n`
}

function canonicalManifest(manifest) {
  let value = `AURUM-RELEASE-V2\n2\n${manifest.release_id}\n${manifest.release_version}\n${manifest.generated_at_utc_msc}\n${manifest.published_at_utc_msc}\n${manifest.expires_at_utc_msc}\n${manifest.priority}\n${manifest.minimum_launcher_version}\n${manifest.minimum_idle_seconds}\n${manifest.activation_deadline_utc_msc ?? ''}\n${manifest.rollout_channel}\n${manifest.rollout_percentage}\n`
  for (const pkg of [...manifest.packages].sort((left, right) => left.module_id.localeCompare(right.module_id, 'en'))) {
    value += `${pkg.module_id}|${pkg.version}|${pkg.url}|${pkg.size_bytes}|${pkg.sha256.toLowerCase()}|${pkg.signature}|${pkg.minimum_core_version || ''}|${pkg.maximum_core_version || ''}\n`
  }
  return value
}

export function verifyBridgeReleaseSignatures(manifest, publicKeyPem) {
  if (manifest?.schema_version !== 2 || !publicKeyPem) return false
  try {
    const key = createPublicKey(publicKeyPem)
    if (!manifest.packages.every(pkg => verify('sha256', Buffer.from(canonicalPackage(pkg)), {
      key,
      dsaEncoding:'ieee-p1363',
    }, Buffer.from(pkg.signature, 'base64')))) return false
    return verify('sha256', Buffer.from(canonicalManifest(manifest)), {
      key,
      dsaEncoding:'ieee-p1363',
    }, Buffer.from(manifest.signature, 'base64'))
  } catch {
    return false
  }
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
  authenticate = authMiddleware,
  requireAdmin = adminOnly,
  fileOps = { mkdir, readFile, rename, rm, writeFile },
  publicKeyPath = process.env.BRIDGE_RELEASE_PUBLIC_KEY_PATH,
  releaseToken = process.env.AURUM_BRIDGE_RELEASE_API_TOKEN,
  verifySignatures = verifyBridgeReleaseSignatures,
} = {}) {
  const router = Router()
  const previousPath = manifestPath ? `${manifestPath}.previous` : ''
  const disabledPath = manifestPath ? `${manifestPath}.disabled` : ''
  let mutation = Promise.resolve()

  function authorizeRelease(req, res, next) {
    const provided = String(req.get('Authorization') || '').replace(/^Bearer\s+/i, '')
    if (releaseToken && releaseToken.length >= 32 && provided) {
      const expectedBytes = Buffer.from(releaseToken, 'utf8')
      const providedBytes = Buffer.from(provided, 'utf8')
      if (expectedBytes.length === providedBytes.length && timingSafeEqual(expectedBytes, providedBytes)) return next()
    }
    return authenticate(req, res, () => requireAdmin(req, res, next))
  }

  function serialize(operation) {
    const result = mutation.then(operation, operation)
    mutation = result.catch(() => {})
    return result
  }

  async function atomicWrite(target, content) {
    const directory = path.dirname(target)
    await fileOps.mkdir(directory, { recursive:true })
    const temporary = path.join(directory, `.${path.basename(target)}.${process.pid}.${Date.now()}.tmp`)
    try {
      await fileOps.writeFile(temporary, content, { flag:'wx' })
      await fileOps.rename(temporary, target)
    } finally {
      await fileOps.rm(temporary, { force:true }).catch(() => {})
    }
  }

  async function optionalManifest(target) {
    if (!target) return null
    try {
      const value = JSON.parse((await fileOps.readFile(target)).toString('utf8'))
      return validateBridgeReleaseManifest(value) ? value : null
    } catch (error) {
      if (error?.code === 'ENOENT') return null
      throw error
    }
  }

  async function markerExists(target) {
    if (!target) return false
    try {
      await fileOps.readFile(target)
      return true
    } catch (error) {
      if (error?.code === 'ENOENT') return false
      throw error
    }
  }

  router.get('/bridge/v3/releases/current', async (req, res) => {
    res.set('Cache-Control', 'no-store')
    res.set('X-Content-Type-Options', 'nosniff')
    if (!manifestPath) return res.status(204).end()
    try {
      if (await markerExists(disabledPath)) return res.status(204).end()
      const content = await readManifest(manifestPath)
      const bytes = Buffer.isBuffer(content) ? content : Buffer.from(content)
      if (bytes.length === 0 || bytes.length > MAX_MANIFEST_BYTES) {
        throw new Error('bridge_release_manifest_size_invalid')
      }
      const manifest = JSON.parse(bytes.toString('utf8'))
      if (!validateBridgeReleaseManifest(manifest)) {
        throw new Error('bridge_release_manifest_invalid')
      }
      if (!isInstallationInRollout(
        manifest,
        req.get('X-Aurum-Installation-Id'),
        String(req.get('X-Aurum-Release-Channel') || 'stable').toLowerCase())) {
        return res.status(204).end()
      }
      if (manifest.schema_version === 2) {
        if (!publicKeyPath) throw new Error('bridge_release_signature_verifier_unavailable')
        const publicKey = await fileOps.readFile(publicKeyPath, 'utf8')
        if (!verifySignatures(manifest, publicKey)) throw new Error('bridge_release_signature_invalid')
      }
      return res.json(manifest)
    } catch (error) {
      console.error('[BridgeRelease] manifest unavailable:', error?.message || 'unknown')
      return res.status(503).json({ ok:false, error:'bridge_release_unavailable' })
    }
  })

  router.get('/admin/bridge/v3/releases/status', authorizeRelease, async (req, res) => {
    try {
      const [current, previous, disabled] = await Promise.all([
        optionalManifest(manifestPath),
        optionalManifest(previousPath),
        markerExists(disabledPath),
      ])
      return res.json({
        ok:true,
        enabled:!disabled,
        current,
        previous,
      })
    } catch {
      return res.status(503).json({ ok:false, error:'bridge_release_status_unavailable' })
    }
  })

  router.post('/admin/bridge/v3/releases/publish', authorizeRelease, async (req, res) => {
    if (!manifestPath || !validateBridgeReleaseManifest(req.body?.manifest)) {
      return res.status(400).json({ ok:false, error:'bridge_release_manifest_invalid' })
    }
    try {
      if (!publicKeyPath) {
        return res.status(503).json({ ok:false, error:'bridge_release_signature_verifier_unavailable' })
      }
      const publicKey = await fileOps.readFile(publicKeyPath, 'utf8')
      if (!verifySignatures(req.body.manifest, publicKey)) {
        return res.status(400).json({ ok:false, error:'bridge_release_signature_invalid' })
      }
      await serialize(async () => {
        const current = await optionalManifest(manifestPath)
        if (current) await atomicWrite(previousPath, JSON.stringify(current))
        await atomicWrite(manifestPath, JSON.stringify(req.body.manifest))
        await fileOps.rm(disabledPath, { force:true })
      })
      return res.json({
        ok:true,
        release_id:req.body.manifest.release_id || null,
        release_version:req.body.manifest.release_version,
        rollout_percentage:req.body.manifest.rollout_percentage || 100,
      })
    } catch {
      return res.status(503).json({ ok:false, error:'bridge_release_publish_failed' })
    }
  })

  router.post('/admin/bridge/v3/releases/stop', authorizeRelease, async (req, res) => {
    try {
      const current = await serialize(async () => {
        const value = await optionalManifest(manifestPath)
        if (value) await atomicWrite(disabledPath, JSON.stringify(value))
        return value
      })
      if (!current) return res.status(404).json({ ok:false, error:'bridge_release_not_found' })
      return res.json({ ok:true, stopped_release_id:current.release_id || null })
    } catch {
      return res.status(503).json({ ok:false, error:'bridge_release_stop_failed' })
    }
  })

  router.post('/admin/bridge/v3/releases/rollback', authorizeRelease, async (req, res) => {
    try {
      const previous = await serialize(async () => {
        const value = await optionalManifest(previousPath)
        if (!value) return null
        if (value.schema_version === 2) {
          if (!publicKeyPath) throw new Error('bridge_release_signature_verifier_unavailable')
          const publicKey = await fileOps.readFile(publicKeyPath, 'utf8')
          if (!verifySignatures(value, publicKey)) throw new Error('bridge_release_signature_invalid')
        }
        const current = await optionalManifest(manifestPath)
        await atomicWrite(manifestPath, JSON.stringify(value))
        if (current) await atomicWrite(previousPath, JSON.stringify(current))
        await fileOps.rm(disabledPath, { force:true })
        return value
      })
      if (!previous) return res.status(404).json({ ok:false, error:'bridge_release_previous_not_found' })
      return res.json({
        ok:true,
        release_id:previous.release_id || null,
        release_version:previous.release_version,
      })
    } catch {
      return res.status(503).json({ ok:false, error:'bridge_release_rollback_failed' })
    }
  })
  return router
}

export default createBridgeReleaseRouter()
