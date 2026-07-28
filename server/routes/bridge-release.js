import { Router } from 'express'
import { createHash, createPublicKey, timingSafeEqual, verify } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'

import { queryAll } from '../db.js'
import { notifyBridgeReleaseAvailable } from '../bridge-v3/release-events.js'
import { adminOnly, authMiddleware } from '../middleware/auth.js'

const MAX_MANIFEST_BYTES = 128 * 1024
const MIN_BOOTSTRAP_VALIDITY_MS = 90 * 24 * 60 * 60 * 1000
const BOOTSTRAP_MODULES = new Set(['core', 'adapter.mt5.python', 'adapter.mt4'])
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

export function summarizeBridgeReleaseHealth({ manifest, sessions = [], events = [], observedAtUtcMsc }) {
  const installations = new Map()
  let legacyTerminalCount = 0
  for (const row of sessions) {
    const installationId = String(row.installation_id || '')
    if (!validInstallationId(installationId)) {
      legacyTerminalCount++
      continue
    }
    const previous = installations.get(installationId)
    if (!previous || Number(row.last_seen_at_utc_msc) > Number(previous.last_seen_at_utc_msc)) {
      installations.set(installationId, row)
    }
  }
  const versionCounts = new Map()
  for (const row of installations.values()) {
    const version = String(row.bridge_version || 'unknown')
    versionCounts.set(version, (versionCounts.get(version) || 0) + 1)
  }
  const versions = Object.fromEntries(versionCounts)
  const latestEvents = new Map()
  for (const event of events) {
    const installationId = String(event.installation_id || '')
    if (!validInstallationId(installationId) || latestEvents.has(installationId)) continue
    latestEvents.set(installationId, event)
  }
  const states = { healthy:0, rolled_back:0, failed:0 }
  const recoveryDurations = []
  for (const event of latestEvents.values()) {
    if (Object.hasOwn(states, event.state)) states[event.state]++
    const started = Number(event.started_at_utc_msc)
    const updated = Number(event.updated_at_utc_msc)
    if (started > 0 && updated >= started) recoveryDurations.push(updated - started)
  }
  const installationCount = installations.size
  const rolloutPercentage = Number(manifest?.rollout_percentage || 100)
  const expectedRolloutInstallations = manifest
    ? Math.ceil(installationCount * rolloutPercentage / 100)
    : 0
  const targetVersion = manifest?.release_version || null
  const targetVersionConnected = targetVersion
    ? Number(versions[targetVersion] || 0)
    : 0
  const pending = Math.max(
    0,
    expectedRolloutInstallations - states.healthy - states.rolled_back - states.failed
  )
  const reasons = []
  if (states.failed > 0) reasons.push('update_failed')
  if (states.rolled_back > 0) reasons.push('client_rolled_back')
  return {
    observed_at_utc_msc:observedAtUtcMsc,
    release:manifest ? {
      release_id:manifest.release_id,
      release_version:manifest.release_version,
      rollout_channel:manifest.rollout_channel || 'stable',
      rollout_percentage:rolloutPercentage,
    } : null,
    connected:{
      terminal_count:sessions.length,
      installation_count:installationCount,
      legacy_terminal_count:legacyTerminalCount,
      versions,
      target_version_connected:targetVersionConnected,
    },
    rollout:{
      expected_installations:expectedRolloutInstallations,
      reporting_installations:latestEvents.size,
      healthy:states.healthy,
      rolled_back:states.rolled_back,
      failed:states.failed,
      pending,
      average_recovery_duration_msc:recoveryDurations.length
        ? Math.round(recoveryDurations.reduce((sum, value) => sum + value, 0) / recoveryDurations.length)
        : null,
    },
    stop_line:{
      recommended:reasons.length > 0,
      reasons,
      externally_audited_checks:[
        'duplicate_order',
        'wrong_account_route',
        'lost_command',
        'maintenance_command_leak',
        'signature_or_path_bypass',
      ],
    },
  }
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
  bootstrapManifestPath = process.env.BRIDGE_BOOTSTRAP_MANIFEST_PATH,
  readManifest = readFile,
  authenticate = authMiddleware,
  requireAdmin = adminOnly,
  fileOps = { mkdir, readFile, rename, rm, writeFile },
  publicKeyPath = process.env.BRIDGE_RELEASE_PUBLIC_KEY_PATH,
  releaseToken = process.env.AURUM_BRIDGE_RELEASE_API_TOKEN,
  verifySignatures = verifyBridgeReleaseSignatures,
  queryAllFn = queryAll,
  notifyReleaseAvailable = notifyBridgeReleaseAvailable,
  now = () => Date.now(),
} = {}) {
  const router = Router()
  const previousPath = manifestPath ? `${manifestPath}.previous` : ''
  const disabledPath = manifestPath ? `${manifestPath}.disabled` : ''
  const bootstrapPreviousPath = bootstrapManifestPath ? `${bootstrapManifestPath}.previous` : ''
  let mutation = Promise.resolve()

  function isBootstrapManifest(manifest, minimumExpiryUtcMsc = now()) {
    const packages = Array.isArray(manifest?.packages) ? manifest.packages : []
    const modules = new Set(packages.map(value => value.module_id))
    return validateBridgeReleaseManifest(manifest, now())
      && manifest.schema_version === 2
      && manifest.priority === 'normal'
      && manifest.activation_deadline_utc_msc === null
      && manifest.rollout_channel === 'stable'
      && manifest.rollout_percentage === 100
      && manifest.expires_at_utc_msc >= minimumExpiryUtcMsc
      && modules.size === BOOTSTRAP_MODULES.size
      && [...BOOTSTRAP_MODULES].every(value => modules.has(value))
  }

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
      return validateBridgeReleaseManifest(value, now()) ? value : null
    } catch (error) {
      if (error?.code === 'ENOENT') return null
      throw error
    }
  }

  function announceRelease(manifest, reason) {
    try {
      notifyReleaseAvailable({
        releaseId:manifest.release_id || null,
        releaseVersion:manifest.release_version,
        rolloutChannel:manifest.rollout_channel || 'stable',
        reason,
      })
    } catch {
      // The WSS notice is only a latency optimization. Publishing the signed
      // HTTPS manifest remains authoritative and must not depend on delivery.
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

  async function servePublicManifest(req, res, target, {
    applyRollout = false,
    requireBootstrap = false,
  } = {}) {
    res.set('Cache-Control', 'no-store')
    res.set('X-Content-Type-Options', 'nosniff')
    if (!target) return res.status(204).end()
    try {
      const content = await readManifest(target)
      const bytes = Buffer.isBuffer(content) ? content : Buffer.from(content)
      if (bytes.length === 0 || bytes.length > MAX_MANIFEST_BYTES) {
        throw new Error('bridge_release_manifest_size_invalid')
      }
      const manifest = JSON.parse(bytes.toString('utf8'))
      if (!validateBridgeReleaseManifest(manifest, now())
        || requireBootstrap && !isBootstrapManifest(manifest)) {
        throw new Error('bridge_release_manifest_invalid')
      }
      if (applyRollout && !isInstallationInRollout(
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
      const etag = `"${createHash('sha256').update(bytes).digest('hex')}"`
      res.set('ETag', etag)
      if (req.fresh) return res.status(304).end()
      return res.json(manifest)
    } catch (error) {
      console.error('[BridgeRelease] manifest unavailable:', error?.message || 'unknown')
      return res.status(503).json({ ok:false, error:'bridge_release_unavailable' })
    }
  }

  router.get('/bridge/v3/releases/current', async (req, res) => {
    res.set('Cache-Control', 'no-store')
    res.set('X-Content-Type-Options', 'nosniff')
    try {
      if (await markerExists(disabledPath)) return res.status(204).end()
      return servePublicManifest(req, res, manifestPath, { applyRollout:true })
    } catch (error) {
      console.error('[BridgeRelease] rollout marker unavailable:', error?.message || 'unknown')
      return res.status(503).json({ ok:false, error:'bridge_release_unavailable' })
    }
  })

  router.get('/bridge/v3/releases/bootstrap', async (req, res) =>
    servePublicManifest(req, res, bootstrapManifestPath, { requireBootstrap:true }))

  router.get('/admin/bridge/v3/releases/status', authorizeRelease, async (req, res) => {
    try {
      const [current, previous, bootstrap, bootstrapPrevious, disabled] = await Promise.all([
        optionalManifest(manifestPath),
        optionalManifest(previousPath),
        optionalManifest(bootstrapManifestPath),
        optionalManifest(bootstrapPreviousPath),
        markerExists(disabledPath),
      ])
      return res.json({
        ok:true,
        enabled:!disabled,
        current,
        previous,
        bootstrap,
        bootstrap_previous:bootstrapPrevious,
      })
    } catch {
      return res.status(503).json({ ok:false, error:'bridge_release_status_unavailable' })
    }
  })

  router.get('/admin/bridge/v3/releases/health', authorizeRelease, async (req, res) => {
    const freshnessSeconds = Number(req.query.freshness_seconds || 90)
    if (!Number.isSafeInteger(freshnessSeconds) || freshnessSeconds < 30 || freshnessSeconds > 600) {
      return res.status(400).json({ ok:false, error:'bridge_release_freshness_invalid' })
    }
    try {
      const observedAtUtcMsc = now()
      const current = await optionalManifest(manifestPath)
      const sessions = await queryAllFn(`SELECT terminal_instance_id, installation_id, bridge_version,
          last_seen_at_utc_msc
        FROM bridge_v3_terminal_sessions
        WHERE connected = 1 AND last_seen_at_utc_msc >= ?`, [
        observedAtUtcMsc - freshnessSeconds * 1000,
      ])
      const events = current?.release_id
        ? await queryAllFn(`SELECT event.installation_id, event.release_id, event.target_version,
            event.state, event.started_at_utc_msc, event.updated_at_utc_msc,
            event.error_code, event.bridge_version
          FROM bridge_update_events event
          WHERE event.release_id = ?
            AND event.id = (
              SELECT latest.id FROM bridge_update_events latest
              WHERE latest.release_id = event.release_id
                AND latest.installation_id = event.installation_id
              ORDER BY latest.updated_at_utc_msc DESC, latest.id DESC
              LIMIT 1
            )
          ORDER BY event.updated_at_utc_msc DESC, event.id DESC`, [current.release_id])
        : []
      return res.json({
        ok:true,
        ...summarizeBridgeReleaseHealth({
          manifest:current,
          sessions,
          events,
          observedAtUtcMsc,
        }),
      })
    } catch (error) {
      console.error('[BridgeRelease] health unavailable:', error?.message || 'unknown')
      return res.status(503).json({ ok:false, error:'bridge_release_health_unavailable' })
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
      announceRelease(req.body.manifest, 'published')
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

  router.post('/admin/bridge/v3/releases/promote-bootstrap', authorizeRelease, async (req, res) => {
    const manifest = req.body?.manifest
    if (!bootstrapManifestPath
      || !isBootstrapManifest(manifest, now() + MIN_BOOTSTRAP_VALIDITY_MS)) {
      return res.status(400).json({ ok:false, error:'bridge_bootstrap_manifest_invalid' })
    }
    try {
      if (!publicKeyPath) {
        return res.status(503).json({ ok:false, error:'bridge_release_signature_verifier_unavailable' })
      }
      const publicKey = await fileOps.readFile(publicKeyPath, 'utf8')
      if (!verifySignatures(manifest, publicKey)) {
        return res.status(400).json({ ok:false, error:'bridge_release_signature_invalid' })
      }
      await serialize(async () => {
        const current = await optionalManifest(bootstrapManifestPath)
        if (current) await atomicWrite(bootstrapPreviousPath, JSON.stringify(current))
        await atomicWrite(bootstrapManifestPath, JSON.stringify(manifest))
      })
      return res.json({
        ok:true,
        release_id:manifest.release_id,
        release_version:manifest.release_version,
      })
    } catch {
      return res.status(503).json({ ok:false, error:'bridge_bootstrap_publish_failed' })
    }
  })

  router.post('/admin/bridge/v3/releases/rollback-bootstrap', authorizeRelease, async (req, res) => {
    try {
      const previous = await serialize(async () => {
        const value = await optionalManifest(bootstrapPreviousPath)
        if (!value || !isBootstrapManifest(value)) return null
        if (!publicKeyPath) throw new Error('bridge_release_signature_verifier_unavailable')
        const publicKey = await fileOps.readFile(publicKeyPath, 'utf8')
        if (!verifySignatures(value, publicKey)) throw new Error('bridge_release_signature_invalid')
        const current = await optionalManifest(bootstrapManifestPath)
        await atomicWrite(bootstrapManifestPath, JSON.stringify(value))
        if (current) await atomicWrite(bootstrapPreviousPath, JSON.stringify(current))
        return value
      })
      if (!previous) return res.status(404).json({ ok:false, error:'bridge_bootstrap_previous_not_found' })
      return res.json({
        ok:true,
        release_id:previous.release_id,
        release_version:previous.release_version,
      })
    } catch {
      return res.status(503).json({ ok:false, error:'bridge_bootstrap_rollback_failed' })
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
      announceRelease(previous, 'rollback')
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
