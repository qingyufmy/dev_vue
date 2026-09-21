import { modelThinkingOptions } from './model-thinking-options.js'
import { analysisContract, traderContract } from '../domain/model-context-contract.js'
import { independentAnalysisContract, independentTraderContract } from '../domain/independent-model-contract.js'
import { lookup } from 'node:dns/promises'
import { analysisModelSnapshot } from '../application/analysis-model-snapshot.js'
import { isIP } from 'node:net'
import type { AnalysisModelGateway } from '../application/analysis-worker.js'
import { ModelInvocationError } from '../application/analysis-worker.js'
import type { TraderModelGateway as TraderGateway } from '../application/trader-worker.js'
import type { AnalysisInputSnapshot, JsonObject, MarketAnalysisResult, TraderDecisionResult, TraderInputSnapshot } from '../domain/inference.js'
import type { ModelUsageLedger, RuntimeModelUsageContext } from '../application/model-usage-ledger.js'

export interface RuntimeModelProfile {
  id: string
  provider: string
  model: string
  protocol: 'chat_completions' | 'responses'
  endpoint: string
  apiKey: string
  thinkingEnabled?: boolean | undefined
  reasoningEffort?: string | null | undefined
  contextWindowTokens?: number | null | undefined
  maxInputTokens?: number | null | undefined
  maxOutputTokens?: number | null | undefined
  temperature: number
  maxTokens: number
  timeoutMs: number
  maxAttempts: number
  structuredOutput: boolean
  allowPrivateEndpoint: boolean
  usage: RuntimeModelUsageContext
}

type Fetch = typeof fetch
export type ModelUsageSettlementErrorHandler = (error: unknown) => void

export class HttpJsonAnalysisModelGateway implements AnalysisModelGateway {
  readonly profileId: string
  readonly provider: string
  readonly model: string
  readonly timeoutMs: number
  readonly maxAttempts: number

  constructor(
    private readonly profile: RuntimeModelProfile,
    private readonly usageLedger: ModelUsageLedger,
    private readonly request: Fetch = fetch,
    private readonly onUsageSettlementError: ModelUsageSettlementErrorHandler = logUsageSettlementError,
  ) {
    this.profileId = profile.id
    this.provider = profile.provider
    this.model = profile.model
    this.timeoutMs = profile.timeoutMs
    this.maxAttempts = profile.maxAttempts
  }

  async analyze(input: { taskId: string; attemptId: string; snapshot: AnalysisInputSnapshot; signal: AbortSignal }) {
    const output = await requestJson(this.profile, this.usageLedger, this.request, input.signal, [
      { role: 'system', content: input.snapshot.strategy.promptText },
      ...(input.snapshot.responsibilityMode === 'independent_roles_v2' ? [{ role: 'system' as const, content: independentAnalysisContract }] : []),
      { role: 'system', content: analysisContract },
      { role: 'user', content: JSON.stringify(snapshotWithoutPrompt(input.snapshot)) },
    ], this.onUsageSettlementError)
    return { result: output.value as unknown as MarketAnalysisResult, usage: output.usage }
  }
}

export class HttpJsonTraderModelGateway implements TraderGateway {
  readonly profileId: string
  readonly provider: string
  readonly model: string
  readonly timeoutMs: number
  readonly maxAttempts: number

  constructor(
    private readonly profile: RuntimeModelProfile,
    private readonly usageLedger: ModelUsageLedger,
    private readonly request: Fetch = fetch,
    private readonly onUsageSettlementError: ModelUsageSettlementErrorHandler = logUsageSettlementError,
  ) {
    this.profileId = profile.id
    this.provider = profile.provider
    this.model = profile.model
    this.timeoutMs = profile.timeoutMs
    this.maxAttempts = profile.maxAttempts
  }

  async decide(input: { taskId: string; attemptId: string; snapshot: TraderInputSnapshot; signal: AbortSignal }) {
    const output = await requestJson(this.profile, this.usageLedger, this.request, input.signal, [
      { role: 'system', content: input.snapshot.strategy.promptText },
      ...(input.snapshot.responsibilityMode === 'independent_roles_v2' ? [{ role: 'system' as const, content: independentTraderContract }] : []),
      { role: 'system', content: traderContract },
      { role: 'user', content: JSON.stringify(snapshotWithoutPrompt(input.snapshot)) },
    ], this.onUsageSettlementError)
    return { result: output.value as unknown as TraderDecisionResult, usage: output.usage }
  }
}

/** Generic structured-output gateway for bounded domains such as reviews. */
export class HttpJsonObjectModelGateway {
  readonly profileId: string
  readonly provider: string
  readonly model: string
  readonly timeoutMs: number
  readonly maxAttempts: number

  constructor(
    private readonly profile: RuntimeModelProfile,
    private readonly usageLedger: ModelUsageLedger,
    private readonly request: Fetch = fetch,
    private readonly onUsageSettlementError: ModelUsageSettlementErrorHandler = logUsageSettlementError,
  ) {
    this.profileId = profile.id
    this.provider = profile.provider
    this.model = profile.model
    this.timeoutMs = profile.timeoutMs
    this.maxAttempts = profile.maxAttempts
  }

  invoke(messages: Array<{ role: 'system' | 'user'; content: string }>, signal: AbortSignal) {
    return requestJson(this.profile, this.usageLedger, this.request, signal, messages, this.onUsageSettlementError)
  }
}

async function requestJson(
  profile: RuntimeModelProfile,
  usageLedger: ModelUsageLedger,
  request: Fetch,
  signal: AbortSignal,
  messages: Array<{ role: 'system' | 'user'; content: string }>,
  onUsageSettlementError: ModelUsageSettlementErrorHandler,
) {
  const body = profile.protocol === 'responses'
    ? responsesBody(profile, messages)
    : chatBody(profile, messages)
  const requestBody = JSON.stringify(body)
  if (Buffer.byteLength(requestBody) > 16 * 1024 * 1024) throw new ModelInvocationError('model_request_too_large', 'contract_invalid', false)
  // Conservative UTF-8 byte bound avoids submitting requests beyond configured capacity.
  await assertSafeEndpoint(profile)
  const requestBytes = Buffer.byteLength(requestBody)
  const startedAt = Date.now()
  const reservationId = await usageLedger.begin(profile.usage)
  let providerRequestId: string | null = null
  let responseBytes = 0
  let usage: JsonObject | null = null
  let completionError: ModelInvocationError | null = null
  let response: Response
  try {
    response = await request(profile.endpoint, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${profile.apiKey}`,
        'content-type': 'application/json',
      },
      body: requestBody,
      signal,
      redirect: 'error',
    })
  } catch (error) {
    completionError = error instanceof DOMException && (error.name === 'AbortError' || error.name === 'TimeoutError')
      ? new ModelInvocationError('model_timeout', 'timed_out', true)
      : new ModelInvocationError('model_transport_failed', 'failed', true)
    await settleUsage(usageLedger, reservationId, {
      status: 'error', errorCode: completionError.code, usage: null, providerRequestId: null,
      requestBytes, responseBytes: 0, durationMs: Date.now() - startedAt,
    }, onUsageSettlementError)
    throw completionError
  }
  try {
    providerRequestId = response.headers.get('x-request-id') || response.headers.get('request-id')
    if (!response.ok) {
      const retryable = response.status === 408 || response.status === 409 || response.status === 429 || response.status >= 500
      await response.body?.cancel('model_http_error')
      throw new ModelInvocationError(`model_http_${response.status}`, 'failed', retryable)
    }
    let responseText: string
    try { responseText = await boundedResponseText(response, 4 * 1024 * 1024) }
    catch (error) {
      const code = error instanceof Error && error.message === 'model_response_too_large' ? error.message : 'model_response_json_invalid'
      throw new ModelInvocationError(code, 'contract_invalid', false)
    }
    responseBytes = Buffer.byteLength(responseText)
    let data: unknown
    try { data = JSON.parse(responseText) }
    catch { throw new ModelInvocationError('model_response_json_invalid', 'contract_invalid', false) }
    const content = extractContent(data, profile.protocol)
    if (!content) throw new ModelInvocationError('model_response_content_missing', 'contract_invalid', false)
    let value: unknown
    try { value = JSON.parse(stripFence(content)) }
    catch { throw new ModelInvocationError('model_output_json_invalid', 'contract_invalid', false) }
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ModelInvocationError('model_output_object_required', 'contract_invalid', false)
    usage = extractUsage(data)
    return { value: value as JsonObject, usage }
  } catch (error) {
    completionError = error instanceof ModelInvocationError ? error : new ModelInvocationError('model_response_failed', 'failed', true)
    throw completionError
  } finally {
    await settleUsage(usageLedger, reservationId, {
      status: completionError ? 'error' : 'success', errorCode: completionError?.code ?? null, usage, providerRequestId,
      requestBytes, responseBytes, durationMs: Date.now() - startedAt,
    }, onUsageSettlementError)
  }
}

export async function assertSafeEndpoint(profile: Pick<RuntimeModelProfile, 'allowPrivateEndpoint' | 'endpoint'>) {
  if (profile.allowPrivateEndpoint) return
  const url = new URL(profile.endpoint)
  let addresses: Array<{ address: string }>
  try { addresses = await lookup(url.hostname, { all: true, verbatim: true }) }
  catch { throw new ModelInvocationError('model_endpoint_dns_failed', 'failed', true) }
  if (addresses.length === 0 || addresses.some(item => privateAddress(item.address))) {
    throw new ModelInvocationError('model_endpoint_private_forbidden', 'contract_invalid', false)
  }
}

function privateAddress(address: string): boolean {
  const normalized = address.toLowerCase()
  if (isIP(normalized) === 4) {
    const [first = 0, second = 0] = normalized.split('.').map(Number)
    return first === 0 || first === 10 || first === 127 || first >= 224
      || first === 169 && second === 254
      || first === 172 && second >= 16 && second <= 31
      || first === 192 && second === 168
      || first === 100 && second >= 64 && second <= 127
  }
  if (isIP(normalized) !== 6) return true
  if (normalized === '::' || normalized === '::1' || normalized.startsWith('fc') || normalized.startsWith('fd') || /^fe[89ab]/.test(normalized)) return true
  const mapped = normalized.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/)
  return mapped ? privateAddress(mapped[1] ?? '') : false
}

async function settleUsage(
  ledger: ModelUsageLedger,
  reservationId: string,
  completion: Parameters<ModelUsageLedger['finish']>[1],
  onError: ModelUsageSettlementErrorHandler,
) {
  try { await ledger.finish(reservationId, completion) }
  catch (error) {
    try { onError(error) }
    catch (handlerError) { logUsageSettlementError(handlerError) }
  }
}

function logUsageSettlementError(error: unknown) {
  console.error('[model-usage] settlement failed', error instanceof Error ? error.message : 'model_usage_settlement_failed')
}

export async function boundedResponseText(response: Response, maximumBytes: number) {
  const declared = Number(response.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > maximumBytes) throw new Error('model_response_too_large')
  if (!response.body) return ''
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let bytes = 0
  while (true) {
    const next = await reader.read()
    if (next.done) break
    bytes += next.value.byteLength
    if (bytes > maximumBytes) {
      await reader.cancel('model_response_too_large')
      throw new Error('model_response_too_large')
    }
    chunks.push(next.value)
  }
  return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))
}

function chatBody(profile: RuntimeModelProfile, messages: Array<{ role: string; content: string }>) {
  return {
    model: profile.model,
    messages,
    temperature: profile.temperature,
    ...modelThinkingOptions(profile.provider,profile.protocol,profile.thinkingEnabled,profile.reasoningEffort),
    max_tokens: profile.maxTokens,
    stream: false,
    ...(profile.structuredOutput && profile.provider === 'deepseek' ? { response_format: { type: 'json_object' } } : {}),
  }
}

function responsesBody(profile: RuntimeModelProfile, messages: Array<{ role: string; content: string }>) {
  return {
    model: profile.model,
    input: messages,
    temperature: profile.temperature,
    ...modelThinkingOptions(profile.provider,profile.protocol,profile.thinkingEnabled,profile.reasoningEffort),
    max_output_tokens: profile.maxTokens,
    stream: false,
    ...(profile.structuredOutput && profile.provider === 'volcengine_agent_plan' ? { text: { format: { type: 'json_object' } } } : {}),
  }
}

function extractContent(data: unknown, protocol: RuntimeModelProfile['protocol']) {
  if (!data || typeof data !== 'object') return null
  const record = data as Record<string, unknown>
  if (protocol === 'chat_completions') {
    const choices = Array.isArray(record.choices) ? record.choices : []
    const message = choices[0] && typeof choices[0] === 'object' ? (choices[0] as Record<string, unknown>).message : null
    return message && typeof message === 'object' && typeof (message as Record<string, unknown>).content === 'string'
      ? (message as Record<string, unknown>).content as string
      : null
  }
  if (typeof record.output_text === 'string') return record.output_text
  const output = Array.isArray(record.output) ? record.output : []
  for (const item of output) {
    if (!item || typeof item !== 'object') continue
    const content = Array.isArray((item as Record<string, unknown>).content) ? (item as Record<string, unknown>).content as unknown[] : []
    for (const part of content) {
      if (!part || typeof part !== 'object') continue
      const text = (part as Record<string, unknown>).text
      if (typeof text === 'string') return text
    }
  }
  return null
}

function extractUsage(data: unknown): JsonObject | null {
  if (!data || typeof data !== 'object') return null
  const usage = (data as Record<string, unknown>).usage
  if (!usage || typeof usage !== 'object' || Array.isArray(usage)) return null
  return JSON.parse(JSON.stringify(usage)) as JsonObject
}

function stripFence(value: string) {
  const trimmed = value.trim()
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i)
  return fenced?.[1] ?? trimmed
}

function snapshotWithoutPrompt<T extends AnalysisInputSnapshot | TraderInputSnapshot>(snapshot: T) {
  const visible = snapshot.kind === 'analysis' ? analysisModelSnapshot(snapshot) : snapshot
  return { ...visible, strategy: { ...visible.strategy, promptText: undefined } }
}
