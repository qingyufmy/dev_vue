import { createDecipheriv } from 'node:crypto'
import type { Pool, RowDataPacket } from 'mysql2/promise'
import type { AnalysisModelGatewayResolver } from '../application/analysis-worker.js'
import type { TraderModelGatewayResolver } from '../application/trader-worker.js'
import { InferenceError } from '../domain/inference.js'
import {
  HttpJsonAnalysisModelGateway, HttpJsonTraderModelGateway, type ModelUsageSettlementErrorHandler, type RuntimeModelProfile,
} from './http-json-model-gateway.js'
import type { ModelUsageLedger, RuntimeModelUsageKind } from './mysql-model-usage-ledger.js'

interface StrategyScopeRow extends RowDataPacket {
  id: string
  active_version_id: string
  scope: 'platform' | 'user'
  owner_user_id: number | null
}

interface ProfileRow extends RowDataPacket {
  id: string
  owner_user_id: number
  scope: 'platform' | 'user'
  provider: string
  model_name: string
  api_base_url: string
  api_key_encrypted: string
  temperature: string | number | null
  max_tokens: number | null
  request_timeout_ms: number | null
  protocol: string | null
  verification_status: string | null
  capability_provider: string | null
  capability_model_name: string | null
  capability_api_base_url: string | null
  supports_structured_output: number | null
}

interface PlatformUsageRow extends RowDataPacket {
  plan: string
  share_for_manual: number
  share_for_auto: number
  allowed_plans: string | string[] | null
}

export interface RuntimeModelResolverOptions {
  allowPrivateEndpoints: boolean
  maxAttempts: number
  defaultTimeoutMs: number
}

export class MysqlRuntimeModelProfileCatalog {
  constructor(
    private readonly pool: Pool,
    private readonly keyring: ReadonlyMap<string, Buffer>,
    private readonly options: RuntimeModelResolverOptions,
  ) {}

  async resolve(input: { userId: number; strategyId: string; strategyVersionId: string; usage: RuntimeModelUsageKind }): Promise<RuntimeModelProfile> {
    const [strategies] = await this.pool.execute<StrategyScopeRow[]>(`SELECT CAST(id AS CHAR) id,CAST(active_version_id AS CHAR) active_version_id,scope,owner_user_id
      FROM strategies WHERE id=? AND active_version_id=? AND status='active' AND deleted_at_utc IS NULL
        AND (scope='platform' OR owner_user_id=?) LIMIT 1`, [input.strategyId, input.strategyVersionId, input.userId])
    const strategy = strategies[0]
    if (!strategy) throw new InferenceError('model_strategy_unavailable', 409)
    const [profiles] = await this.pool.execute<ProfileRow[]>(`${profileSelect}
      INNER JOIN user_model_defaults d ON d.model_profile_id=p.id AND d.user_id=?
      WHERE ((p.scope='user' AND p.owner_user_id=?) OR (p.scope='platform' AND p.owner_user_id=0))
        AND p.status='active' AND p.deleted_at IS NULL LIMIT 1`, [input.userId, input.userId])
    const profile = profiles[0]
    if (!profile) throw new InferenceError('model_profile_unavailable', 409)
    if (profile.scope === 'platform') await this.assertPlatformSharing(input.userId, input.usage)
    return mapProfile(profile, this.keyring, this.options, input)
  }

  private async assertPlatformSharing(userId: number, usage: 'manual' | 'auto') {
    const [rows] = await this.pool.execute<PlatformUsageRow[]>(`SELECT u.plan,p.share_for_manual,p.share_for_auto,p.allowed_plans
      FROM users u INNER JOIN platform_model_usage_policy p ON p.id=1 WHERE u.id=? LIMIT 1`, [userId])
    const row = rows[0]
    const shared = usage === 'manual' ? Boolean(row?.share_for_manual) : Boolean(row?.share_for_auto)
    if (!row || !shared || !planAllowed(row.allowed_plans, row.plan)) throw new InferenceError('platform_model_sharing_unavailable', 409)
  }
}

export class MysqlAnalysisModelGatewayResolver implements AnalysisModelGatewayResolver {
  constructor(
    private readonly profiles: MysqlRuntimeModelProfileCatalog,
    private readonly usage: ModelUsageLedger,
    private readonly onUsageSettlementError?: ModelUsageSettlementErrorHandler,
  ) {}
  async resolve(input: { userId: number; strategyId: string; strategyVersionId: string; trigger: 'manual' | 'scheduled' | 'event' }) {
    return new HttpJsonAnalysisModelGateway(
      await this.profiles.resolve({ ...input, usage: input.trigger === 'manual' ? 'manual' : 'auto' }),
      this.usage,
      fetch,
      this.onUsageSettlementError,
    )
  }
}

export class MysqlTraderModelGatewayResolver implements TraderModelGatewayResolver {
  constructor(
    private readonly profiles: MysqlRuntimeModelProfileCatalog,
    private readonly usage: ModelUsageLedger,
    private readonly onUsageSettlementError?: ModelUsageSettlementErrorHandler,
  ) {}
  async resolve(input: { userId: number; strategyId: string; strategyVersionId: string }) {
    return new HttpJsonTraderModelGateway(
      await this.profiles.resolve({ ...input, usage: 'auto' }), this.usage, fetch, this.onUsageSettlementError,
    )
  }
}

export function loadCredentialKeyring(env: NodeJS.ProcessEnv = process.env) {
  let parsed: unknown
  try { parsed = JSON.parse(env.AI_CREDENTIAL_KEYS_JSON ?? '') }
  catch { throw new Error('ai_credential_keyring_invalid') }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('ai_credential_keyring_invalid')
  const keyring = new Map<string, Buffer>()
  for (const [version, encoded] of Object.entries(parsed)) {
    if (typeof encoded !== 'string') throw new Error('ai_credential_keyring_invalid')
    const key = Buffer.from(encoded, 'base64')
    if (key.length !== 32) throw new Error('ai_credential_keyring_invalid')
    keyring.set(version, key)
  }
  if (keyring.size === 0) throw new Error('ai_credential_keyring_empty')
  return keyring
}

const profileSelect = `SELECT CAST(p.id AS CHAR) id,p.owner_user_id,p.scope,p.provider,p.model_name,p.api_base_url,
  p.api_key_encrypted,p.temperature,p.max_tokens,p.request_timeout_ms,c.protocol,c.verification_status,
  c.provider capability_provider,c.model_name capability_model_name,c.api_base_url capability_api_base_url,
  c.supports_structured_output
  FROM ai_model_profiles p INNER JOIN ai_model_provider_capabilities c ON c.model_profile_id=p.id`

function mapProfile(
  row: ProfileRow,
  keyring: ReadonlyMap<string, Buffer>,
  options: RuntimeModelResolverOptions,
  input: { userId: number; strategyId: string; usage: RuntimeModelUsageKind },
): RuntimeModelProfile {
  if (row.verification_status !== 'verified'
    || row.capability_provider !== row.provider
    || row.capability_model_name !== row.model_name
    || normalizedBase(row.capability_api_base_url) !== normalizedBase(row.api_base_url)) {
    throw new InferenceError('model_profile_not_verified', 409)
  }
  const protocol = row.protocol === 'responses' ? 'responses' : row.protocol === 'chat_completions' ? 'chat_completions' : null
  if (!protocol) throw new InferenceError('model_protocol_unsupported', 409)
  const endpoint = providerEndpoint(row.api_base_url, protocol, options.allowPrivateEndpoints)
  const temperature = Number(row.temperature ?? 0.3)
  const maxTokens = Number(row.max_tokens ?? 2_000)
  const timeoutMs = Number(row.request_timeout_ms ?? options.defaultTimeoutMs)
  if (!Number.isFinite(temperature) || temperature < 0 || temperature > 2) throw new InferenceError('model_temperature_invalid', 409)
  if (!Number.isSafeInteger(maxTokens) || maxTokens < 128 || maxTokens > 393_216) throw new InferenceError('model_max_tokens_invalid', 409)
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 600_000) throw new InferenceError('model_timeout_invalid', 409)
  const apiKey = decryptCredential(row.api_key_encrypted, keyring)
  if (!apiKey.trim() || Buffer.byteLength(apiKey, 'utf8') > 16 * 1024) throw new InferenceError('model_credential_invalid', 409)
  return {
    id: row.id,
    provider: row.provider,
    model: row.model_name,
    protocol,
    endpoint,
    apiKey,
    temperature,
    maxTokens,
    timeoutMs,
    maxAttempts: options.maxAttempts,
    structuredOutput: Boolean(row.supports_structured_output),
    allowPrivateEndpoint: options.allowPrivateEndpoints,
    usage: {
      userId: input.userId, profileId: row.id, strategyId: input.strategyId,
      credentialSource: row.scope === 'platform' ? 'platform_shared' : 'user', usage: input.usage,
    },
  }
}

function decryptCredential(envelope: string, keyring: ReadonlyMap<string, Buffer>) {
  let parsed: unknown
  try { parsed = JSON.parse(envelope) }
  catch { throw new InferenceError('model_credential_not_encrypted', 409) }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new InferenceError('model_credential_not_encrypted', 409)
  const value = parsed as Record<string, unknown>
  if (![value.v, value.iv, value.ct, value.tag].every(item => typeof item === 'string' && item.length > 0)) {
    throw new InferenceError('model_credential_not_encrypted', 409)
  }
  const key = keyring.get(value.v as string)
  if (!key) throw new InferenceError('model_credential_key_unavailable', 409)
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(value.iv as string, 'base64'))
    decipher.setAuthTag(Buffer.from(value.tag as string, 'base64'))
    return Buffer.concat([decipher.update(Buffer.from(value.ct as string, 'base64')), decipher.final()]).toString('utf8')
  } catch { throw new InferenceError('model_credential_decryption_failed', 409) }
}

function providerEndpoint(base: string, protocol: RuntimeModelProfile['protocol'], allowPrivate: boolean) {
  let url: URL
  try { url = new URL(base) }
  catch { throw new InferenceError('model_endpoint_invalid', 409) }
  if (url.username || url.password || url.search || url.hash) throw new InferenceError('model_endpoint_invalid', 409)
  if (url.protocol !== 'https:' && !(allowPrivate && url.protocol === 'http:')) throw new InferenceError('model_endpoint_insecure', 409)
  if (!allowPrivate && privateHostname(url.hostname)) throw new InferenceError('model_endpoint_private_forbidden', 409)
  const suffix = protocol === 'responses' ? '/responses' : '/chat/completions'
  url.pathname = url.pathname.replace(/\/+$/, '')
  if (!url.pathname.endsWith(suffix)) url.pathname += suffix
  return url.toString()
}

function normalizedBase(value: string | null) {
  if (!value) return ''
  try {
    const url = new URL(value)
    url.pathname = url.pathname.replace(/\/+$/, '')
    return url.toString()
  } catch { return value.trim() }
}

function privateHostname(hostname: string) {
  const host = hostname.toLowerCase().replace(/\.$/, '')
  if (host === 'localhost' || host.endsWith('.localhost') || host === '::1' || host === '0.0.0.0') return true
  const match = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/)
  if (!match) return false
  const octets = match.slice(1).map(Number)
  if (octets.some(value => value < 0 || value > 255)) return true
  return octets[0] === 10 || octets[0] === 127 || octets[0] === 0
    || octets[0] === 169 && octets[1] === 254
    || octets[0] === 172 && (octets[1] ?? 0) >= 16 && (octets[1] ?? 0) <= 31
    || octets[0] === 192 && octets[1] === 168
}

function planAllowed(value: PlatformUsageRow['allowed_plans'], plan: string) {
  if (value === null) return true
  let parsed: unknown = value
  if (typeof value === 'string') {
    try { parsed = JSON.parse(value) }
    catch { return false }
  }
  return Array.isArray(parsed) && parsed.every(item => typeof item === 'string') && parsed.includes(plan)
}
