import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { queryAll } from '../db.js'
import { systemConfigRowsToMap } from '../system-config-secrets.js'
import { normalizeStorageProvider, STORAGE_PROVIDERS, STORAGE_PURPOSES } from './storage-policy.js'

export const STORAGE_CONFIG_CATEGORY = 'media_storage'
export const QINIU_CONFIG_CATEGORY = 'qiniu'
export const STORAGE_CONFIG_CACHE_TTL_MS = Math.max(1000, Number(process.env.MEDIA_STORAGE_CONFIG_CACHE_TTL_MS || 30000))
export const STORAGE_TEST_TTL_MS = Math.max(60 * 1000, Number(process.env.MEDIA_STORAGE_TEST_TTL_MS || 24 * 60 * 60 * 1000))
export const STORAGE_TEST_MAX_FUTURE_SKEW_MS = Math.max(0, Number(process.env.MEDIA_STORAGE_TEST_MAX_FUTURE_SKEW_MS || 5 * 60 * 1000))

const DEFAULT_STORAGE_LOCAL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'private-uploads', 'media-storage')

const MEDIA_DEFAULTS = Object.freeze({
  default_provider: 'local',
  video_provider: 'inherit',
  attachment_provider: 'inherit',
  image_provider: 'inherit',
  resource_provider: 'inherit',
  local_root: '',
  qiniu_connection_test_version: '',
  qiniu_connection_test_status: 'not_tested',
  qiniu_connection_test_stage: '',
  qiniu_connection_tested_at: '',
  qiniu_connection_test_error: '',
  qiniu_connection_test_cleanup_pending: 'false',
})

const QINIU_DEFAULTS = Object.freeze({
  access_key: '',
  secret_key: '',
  bucket: '',
  domain: '',
  region: 'z0',
  private_bucket: 'true',
})

const PROVIDER_KEYS = Object.freeze({
  video: 'video_provider',
  attachment: 'attachment_provider',
  image: 'image_provider',
  resource: 'resource_provider',
})

let cachedConfig = null

function valueMap(rows, category) {
  return systemConfigRowsToMap((rows || []).filter(row => row.category === category))
}

function configVersionPayload(media, qiniu) {
  return {
    // The proof binds only to the qiniu connection facts. Selecting which
    // purpose uses qiniu is a routing decision and must not invalidate an
    // already successful connection test.
    qiniu: {
      access_key: qiniu.access_key,
      secret_key: qiniu.secret_key,
      bucket: qiniu.bucket,
      domain: qiniu.domain,
      region: qiniu.region,
      private_bucket: qiniu.private_bucket,
    },
  }
}

export function getStorageLocalRoot() {
  const configured = process.env.MEDIA_STORAGE_LOCAL_ROOT || DEFAULT_STORAGE_LOCAL_ROOT
  return path.resolve(String(configured))
}

export function storageConfigVersion(media, qiniu) {
  const canonical = JSON.stringify(configVersionPayload(media, qiniu))
  return createHash('sha256').update(canonical, 'utf8').digest('hex')
}

function normalizeMediaValues(raw) {
  const media = { ...MEDIA_DEFAULTS }
  for (const key of Object.keys(media)) {
    if (raw[key] !== undefined && raw[key] !== null) media[key] = String(raw[key])
  }
  media.local_root = getStorageLocalRoot()
  if (!STORAGE_PROVIDERS.includes(media.default_provider)) media.default_provider = MEDIA_DEFAULTS.default_provider
  for (const purpose of STORAGE_PURPOSES) {
    const key = PROVIDER_KEYS[purpose]
    if (media[key] !== 'inherit' && !STORAGE_PROVIDERS.includes(media[key])) media[key] = 'inherit'
  }
  return media
}

function normalizeQiniuValues(raw) {
  const qiniu = { ...QINIU_DEFAULTS }
  for (const key of Object.keys(qiniu)) {
    if (raw[key] !== undefined && raw[key] !== null) qiniu[key] = String(raw[key])
  }
  qiniu.private_bucket = 'true'
  return qiniu
}

function parseStoredTestTime(value) {
  const text = String(value || '').trim()
  if (!text) return NaN
  // Test timestamps are written as UTC SQL DATETIME values by the route. A
  // DATETIME string has no timezone marker, so parse it explicitly as UTC
  // instead of letting the host's local timezone shift the TTL boundary.
  const normalized = text.includes('T') ? text : text.replace(' ', 'T')
  return Date.parse(/[zZ]|[+-]\d{2}:?\d{2}$/.test(normalized) ? normalized : `${normalized}Z`)
}

function testResult(media, version, now = Date.now()) {
  const status = String(media.qiniu_connection_test_status || 'not_tested')
  const testedAt = parseStoredTestTime(media.qiniu_connection_tested_at)
  const versionMatches = Boolean(media.qiniu_connection_test_version) && media.qiniu_connection_test_version === version
  const notExpired = Number.isFinite(testedAt)
    && testedAt <= now + STORAGE_TEST_MAX_FUTURE_SKEW_MS
    && testedAt + STORAGE_TEST_TTL_MS > now
  const cleanupPending = media.qiniu_connection_test_cleanup_pending === 'true'
  const valid = status === 'succeeded' && versionMatches && notExpired && !cleanupPending
  return {
    // A previously successful result is no longer a current proof once the
    // configuration changed, the TTL elapsed, or cleanup is pending. Keep
    // that distinction visible to the admin instead of showing a stale green
    // success badge.
    status: valid ? 'succeeded' : status === 'succeeded' ? 'stale' : status,
    stage: media.qiniu_connection_test_stage || '',
    testedAt: media.qiniu_connection_tested_at || null,
    configVersion: media.qiniu_connection_test_version || null,
    error: media.qiniu_connection_test_error || '',
    cleanupPending,
    valid,
    expired: status === 'succeeded' && versionMatches && !notExpired,
  }
}

export function readStorageConfigFromRows(rows = [], { now = Date.now() } = {}) {
  const media = normalizeMediaValues(valueMap(rows, STORAGE_CONFIG_CATEGORY))
  const qiniu = normalizeQiniuValues(valueMap(rows, QINIU_CONFIG_CATEGORY))
  const configVersion = storageConfigVersion(media, qiniu)
  const qiniuTest = testResult(media, configVersion, now)
  const effectiveProviders = Object.fromEntries(STORAGE_PURPOSES.map(purpose => [purpose, resolveConfiguredProvider(purpose, media)]))
  return { media, qiniu, configVersion, qiniuTest, effectiveProviders, loadedAt: now }
}

export async function loadStorageConfig({ force = false } = {}) {
  if (!force && cachedConfig && Date.now() - cachedConfig.loadedAt < STORAGE_CONFIG_CACHE_TTL_MS) return cachedConfig
  const rows = await queryAll('SELECT category, `key`, `value` FROM system_config WHERE category IN (?, ?) ORDER BY category, sort_order, id', [STORAGE_CONFIG_CATEGORY, QINIU_CONFIG_CATEGORY])
  cachedConfig = readStorageConfigFromRows(rows)
  return cachedConfig
}

export function invalidateStorageConfigCache() {
  cachedConfig = null
}

export function resolveConfiguredProvider(purpose, media) {
  const key = PROVIDER_KEYS[String(purpose || '').toLowerCase()]
  if (!key) throw new Error('storage_purpose_invalid')
  const selected = String(media?.[key] || 'inherit')
  if (selected === 'inherit') return normalizeStorageProvider(media?.default_provider || 'local')
  return normalizeStorageProvider(selected)
}

export function isQiniuConfigured(qiniu) {
  if (!qiniu || qiniu.private_bucket !== 'true') return false
  if (![qiniu.access_key, qiniu.secret_key, qiniu.bucket, qiniu.domain].every(value => String(value || '').trim())) return false
  try {
    const domain = new URL(qiniu.domain)
    return domain.protocol === 'https:' && !domain.username && !domain.password && domain.pathname === '/' && !domain.search && !domain.hash
  } catch {
    return false
  }
}

export function getStorageConfigSummary(config) {
  return {
    config_version: config.configVersion,
    local_root: config.media.local_root,
    effective_provider: config.effectiveProviders,
    qiniu: {
      configured: isQiniuConfigured(config.qiniu),
      private_bucket: true,
      test: {
        status: config.qiniuTest.status,
        stage: config.qiniuTest.stage,
        tested_at: config.qiniuTest.testedAt,
        config_version: config.qiniuTest.configVersion,
        expired: config.qiniuTest.expired,
        error: config.qiniuTest.error,
        cleanup_pending: config.qiniuTest.cleanupPending,
      },
    },
  }
}

export function assertQiniuReady(config) {
  if (!isQiniuConfigured(config.qiniu)) {
    const error = new Error('storage_qiniu_configuration_invalid')
    error.code = 'storage_qiniu_configuration_invalid'
    throw error
  }
  if (!config.qiniuTest.valid || config.qiniuTest.configVersion !== config.configVersion) {
    const error = new Error('storage_qiniu_connection_test_required')
    error.code = 'storage_qiniu_connection_test_required'
    throw error
  }
  return config
}

export function getStorageConfigDefaults() {
  return { media: { ...MEDIA_DEFAULTS, local_root: getStorageLocalRoot() }, qiniu: { ...QINIU_DEFAULTS } }
}
