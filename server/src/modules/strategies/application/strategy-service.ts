import { strategyRuntimeSettings } from '../domain/strategy-runtime-settings.js'
import type { TraderControlInput } from './trader-control.js'
import { evaluateSubscriptionWindow } from '../domain/subscription-window.js'
import { parseEntryEventPolicy } from '../domain/entry-event-policy.js'
import { parsePriceActionEvidencePlan } from '../domain/price-action-evidence.js'
import { parseChanEvidencePlan } from '../domain/chan-evidence.js'
import { parseEma34Plan } from '../domain/ema34-evidence.js'
import { createHash } from 'node:crypto'
import type {
  CreateStrategyInput, CreateStrategySubscriptionInput, CreateStrategyVersionInput, PublishStrategyVersionInput,
  RetireStrategyInput, StrategyCompileIssue, StrategyCompileResult, StrategyDetail, StrategyKind, StrategySubscription,
  StrategySummary, StrategyVersion, UpdateStrategyMetadataInput, UpdateStrategySubscriptionInput,
} from '../domain/strategy.js'
import { StrategyAccessError } from '../domain/strategy.js'
import { parseStrategyMarketDataPlan } from '../domain/strategy-market-plan.js'
import { parseStrategyEntryMethods } from '../domain/strategy-entry-methods.js'
import { parseStrategyReferenceRequirement } from '../domain/strategy-reference-requirement.js'
import { parseStrategyRiskBudget } from '../domain/strategy-risk-budget.js'

export interface StrategyCatalog {
  listAvailable(userId: number, kind?: StrategyKind): Promise<StrategySummary[]>
  findActiveVersion(userId: number, strategyId: string): Promise<StrategyVersion | null>
}

export interface StrategyManagementRepository {
  setAccountTrader?(input: TraderControlInput): Promise<{ enabled: boolean }>
  findDetail(userId: number, strategyId: string): Promise<StrategyDetail | null>
  create(input: CreateStrategyInput, prepare: () => PreparedStrategyDraft): Promise<StrategyDetail>
  updateMetadata(input: UpdateStrategyMetadataInput, prepare: () => Pick<UpdateStrategyMetadataInput, 'name' | 'description'>): Promise<StrategyDetail>
  createVersion(input: CreateStrategyVersionInput, prepare: (kind: StrategyKind) => StrategyCompileResult): Promise<StrategyDetail>
  publishVersion(input: PublishStrategyVersionInput): Promise<StrategyDetail>
  retire(input: RetireStrategyInput): Promise<StrategyDetail>
  findSubscription(userId: number, subscriptionId: string): Promise<StrategySubscription | null>
  listSubscriptions(userId: number, tradingAccountId?: string): Promise<StrategySubscription[]>
  createSubscription(input: CreateStrategySubscriptionInput, prepare: () => PreparedSubscriptionCreate): Promise<StrategySubscription>
  updateSubscription(input: UpdateStrategySubscriptionInput, prepare: (current: StrategySubscription) => PreparedSubscriptionUpdate): Promise<StrategySubscription>
}

export type StrategyRepository = StrategyCatalog & StrategyManagementRepository

export interface PreparedStrategyDraft {
  name: string
  description: string
  promptText: string
  compiled: StrategyCompileResult
}

export interface PreparedSubscriptionCreate {
  receiveWindow: Record<string, unknown>
  receiveTimezone: string
  standardSymbol: string
  traderStrategyId: string | null
  analysisEnabled: boolean
  traderEnabled: boolean
  tradeSendEnabled: boolean
  status: 'active' | 'paused'
  nextDueAt: string | null
}

export type PreparedSubscriptionUpdate = Omit<PreparedSubscriptionCreate, 'status'> & {
  analysisStrategyId: string
  status: StrategySubscription['status']
}

const DEFAULT_ANALYSIS_TIMEFRAMES = ['M5', 'M15', 'H1', 'H4'] as const
const ALLOWED_TIMEFRAMES = new Set(['M1', 'M5', 'M15', 'M30', 'H1', 'H4', 'D1'])
const MACRO_EVIDENCE_MIN_AGE_SECONDS = 3_600
const MACRO_EVIDENCE_MAX_AGE_SECONDS = 604_800
const DANGEROUS_CONFIG_KEYS = new Set([
  'script', 'scripts', 'network', 'sql', 'file', 'files', 'filesystem', 'shell', 'exec', 'executable',
  'command', 'commands', 'tool', 'tools', 'bridge', 'tradingtools', 'tradeapi', 'brokercommand',
])
const DANGEROUS_CONFIG_STEMS = ['script', 'network', 'sql', 'file', 'filesystem', 'shell', 'exec', 'command', 'tool', 'bridge', 'tradeapi', 'brokercommand']

export function compileStrategy(kind: StrategyKind, promptText: unknown, config: unknown): StrategyCompileResult {
  const issues: StrategyCompileIssue[] = []
  const prompt = typeof promptText === 'string' ? promptText.trim() : ''
  if (!prompt) issues.push(issue('error', 'prompt_required', '请填写策略提示词', 'prompt_text'))
  else if (prompt.length > 100_000) issues.push(issue('error', 'prompt_too_long', '策略提示词不能超过 100000 个字符', 'prompt_text'))

  const parsedConfig = plainObject(config)
  if (!parsedConfig) issues.push(issue('error', 'config_object_required', '策略配置必须是 JSON 对象', 'config'))
  const normalizedConfig = parsedConfig ? normalizeConfig(kind, parsedConfig, issues) : {}
  if (parsedConfig && JSON.stringify(normalizedConfig).length > 32_768) {
    issues.push(issue('error', 'config_too_large', '策略配置不能超过 32 KB', 'config'))
  }
  if (parsedConfig) scanDangerousKeys(parsedConfig, 'config', issues)

  const inputContractVersion = kind === 'analysis' ? 'market-analysis-input/v1' : 'account-trader-input/v1'
  const outputContractVersion = kind === 'analysis' ? 'market-analysis/v1' : 'trade-decision/v1'
  return {
    valid: !issues.some(item => item.level === 'error'), kind,
    promptHash: createHash('sha256').update(prompt).digest('hex'), normalizedConfig,
    inputContractVersion, outputContractVersion, issues,
  }
}

function issue(level: StrategyCompileIssue['level'], code: string, message: string, path: string | null): StrategyCompileIssue {
  return { level, code, message, path }
}

function plainObject(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  return value as Record<string, unknown>
}

function normalizeConfig(kind: StrategyKind, config: Record<string, unknown>, issues: StrategyCompileIssue[]) {
  let common = {}
  try { common = strategyRuntimeSettings(config) }
  catch { issues.push(issue('error', 'strategy_runtime_settings_invalid', '请检查支持品种和使用模型', 'config')) }
  if (kind === 'trader') {
    try { parseEntryEventPolicy(config.entry_event_policy) }
    catch { issues.push(issue('error', 'entry_event_policy_invalid', '请检查入场事件约束和周期', 'config.entry_event_policy')) }
    try { parseStrategyRiskBudget(config.risk_budget) }
    catch { issues.push(issue('error', 'strategy_risk_budget_invalid', '策略单笔风险上限必须为大于0且不超过100的十进制百分数字符串', 'config.risk_budget')) }
    try { parseStrategyReferenceRequirement(config.strategy_reference_portfolio) }
    catch { issues.push(issue('error', 'strategy_reference_requirement_invalid', '策略参考组合配置无效', 'config.strategy_reference_portfolio')) }
    if (config.entry_methods !== undefined) {
      try { parseStrategyEntryMethods(config.entry_methods) }
      catch { issues.push(issue('error', 'strategy_entry_methods_invalid', '请选择有效且不重复的入场方式', 'config.entry_methods')) }
    }
    try { return canonicalClone(config) }
    catch { issues.push(issue('error', 'config_json_invalid', '策略配置必须是可序列化的 JSON 对象', 'config')); return {} }
  }
  const allowed = new Set(['symbols', 'model_profile_id', 'interval_minutes', 'timeframes', 'candle_limit', 'macro_evidence', 'market_data_plan', 'ema34_evidence', 'chan_evidence', 'price_action_evidence'])
  for (const key of Object.keys(config)) {
    if (!allowed.has(key)) issues.push(issue('error', 'config_field_unknown', `不支持的配置字段：${key}`, `config.${key}`))
  }
  let indicators = common
  if (config.interval_minutes !== undefined) {
    const minutes = config.interval_minutes
    if (typeof minutes !== 'number' || !Number.isSafeInteger(minutes) || minutes < 1 || minutes > 1440) issues.push(issue('error', 'interval_minutes_invalid', '运行间隔须为 1 至 1440 分钟的整数', 'config.interval_minutes'))
    else indicators = { ...indicators, interval_minutes: minutes }
  }
  if (config.ema34_evidence !== undefined) {
    try { indicators = { ...indicators, ema34_evidence: parseEma34Plan(config.ema34_evidence) } }
    catch { issues.push(issue('error', 'ema34_plan_invalid', '请检查 EMA34 证据版本和周期', 'config.ema34_evidence')) }
  }
  if (config.price_action_evidence !== undefined) {
    try { indicators = { ...indicators, price_action_evidence: parsePriceActionEvidencePlan(config.price_action_evidence) } }
    catch { issues.push(issue('error', 'price_action_plan_invalid', '请检查价格事件证据版本和开关', 'config.price_action_evidence')) }
  }
  if (config.chan_evidence !== undefined) {
    try { indicators = { ...indicators, chan_evidence: parseChanEvidencePlan(config.chan_evidence) } }
    catch { issues.push(issue('error', 'chan_plan_invalid', '请检查缠论证据版本和开关', 'config.chan_evidence')) }
  }
  if (config.ema34_evidence !== undefined) {
    const ema = config.ema34_evidence as { timeframe?: unknown }
    const selected = config.market_data_plan as { timeframes?: Array<{ timeframe: string }> } | undefined
    const periods = Array.isArray(selected?.timeframes) ? selected.timeframes.map(row => row?.timeframe) : config.timeframes ?? [...DEFAULT_ANALYSIS_TIMEFRAMES]
    if (Array.isArray(periods) && !periods.includes(ema?.timeframe)) issues.push(issue('error', 'ema34_timeframe_not_in_market_plan', 'EMA34 周期必须包含在行情数据范围中', 'config.ema34_evidence'))
  }
  if (config.market_data_plan !== undefined) {
    if (config.timeframes !== undefined || config.candle_limit !== undefined) issues.push(issue('error', 'market_data_plan_conflict', '市场数据计划不能同时使用统一周期或数量配置', 'config.market_data_plan'))
    try { return { ...indicators, market_data_plan: parseStrategyMarketDataPlan(config.market_data_plan), macro_evidence: normalizeMacroEvidence(config.macro_evidence, issues) } }
    catch { issues.push(issue('error', 'strategy_market_data_plan_invalid', '请检查主周期及各周期的 K 线数量', 'config.market_data_plan')); return {} }
  }
  let timeframes = [...DEFAULT_ANALYSIS_TIMEFRAMES]
  if (config.timeframes !== undefined) {
    if (!Array.isArray(config.timeframes) || config.timeframes.length < 1 || config.timeframes.length > 7
      || config.timeframes.some(value => typeof value !== 'string' || !ALLOWED_TIMEFRAMES.has(value))) {
      issues.push(issue('error', 'timeframes_invalid', '分析周期必须是 M1、M5、M15、M30、H1、H4、D1 中的一个或多个', 'config.timeframes'))
    } else {
      const unique = [...new Set(config.timeframes)]
      if (unique.length !== config.timeframes.length) issues.push(issue('error', 'timeframes_duplicate', '分析周期不能重复', 'config.timeframes'))
      timeframes = unique
    }
  }
  let candleLimit = 300
  if (config.candle_limit !== undefined) {
    const value = config.candle_limit
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 50 || value > 1000) {
      issues.push(issue('error', 'candle_limit_invalid', 'K 线数量必须是 50 到 1000 之间的整数', 'config.candle_limit'))
    } else candleLimit = value
  }
  return { ...indicators, timeframes, candle_limit: candleLimit, macro_evidence: normalizeMacroEvidence(config.macro_evidence, issues) }
}

function normalizeMacroEvidence(value: unknown, issues: StrategyCompileIssue[]) {
  if (value === undefined) return { mode: 'off' }
  const evidence = plainObject(value)
  if (!evidence) {
    issues.push(issue('error', 'macro_evidence_object_required', '宏观证据配置必须是 JSON 对象', 'config.macro_evidence'))
    return { mode: 'off' }
  }
  const allowed = new Set(['mode', 'accepted_schema_versions', 'max_age_seconds'])
  for (const key of Object.keys(evidence)) {
    if (!allowed.has(key)) issues.push(issue('error', 'macro_evidence_field_unknown', `不支持的宏观证据字段：${key}`, `config.macro_evidence.${key}`))
  }
  if (evidence.mode === undefined || evidence.mode === 'off') {
    if (evidence.accepted_schema_versions !== undefined || evidence.max_age_seconds !== undefined) {
      issues.push(issue('error', 'macro_evidence_off_fields_forbidden', '关闭宏观证据时不能配置 schema 版本或最大陈旧时间', 'config.macro_evidence'))
    }
    return { mode: 'off' }
  }
  if (evidence.mode !== 'context') {
    issues.push(issue('error', 'macro_evidence_mode_invalid', '宏观证据首版只支持 off 或 context', 'config.macro_evidence.mode'))
    return { mode: 'off' }
  }
  const versions = evidence.accepted_schema_versions
  if (!Array.isArray(versions) || versions.length < 1 || versions.length > 8
    || versions.some(version => !Number.isSafeInteger(version) || Number(version) <= 0)
    || new Set(versions).size !== versions.length) {
    issues.push(issue('error', 'macro_evidence_schema_versions_invalid', '宏观证据 schema 版本必须是 1 到 8 个不重复正整数', 'config.macro_evidence.accepted_schema_versions'))
  }
  const maxAge = evidence.max_age_seconds
  if (!Number.isSafeInteger(maxAge) || Number(maxAge) < MACRO_EVIDENCE_MIN_AGE_SECONDS || Number(maxAge) > MACRO_EVIDENCE_MAX_AGE_SECONDS) {
    issues.push(issue('error', 'macro_evidence_max_age_invalid', '宏观证据最大陈旧时间必须是 3600 到 604800 秒的整数', 'config.macro_evidence.max_age_seconds'))
  }
  return {
    mode: 'context',
    accepted_schema_versions: Array.isArray(versions) ? versions.filter(version => Number.isSafeInteger(version) && Number(version) > 0).map(Number) : [],
    max_age_seconds: Number.isSafeInteger(maxAge) ? Number(maxAge) : 0,
  }
}

function canonicalClone(value: unknown): Record<string, unknown> {
  const source = plainObject(value) ?? {}
  return JSON.parse(canonicalJson(source)) as Record<string, unknown>
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.keys(value as Record<string, unknown>).sort().map(key => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`).join(',')}}`
  }
  return JSON.stringify(value)
}

function scanDangerousKeys(value: unknown, path: string, issues: StrategyCompileIssue[]) {
  if (Array.isArray(value)) { value.forEach((item, index) => scanDangerousKeys(item, `${path}[${index}]`, issues)); return }
  if (!value || typeof value !== 'object') return
  for (const [key, child] of Object.entries(value)) {
    const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, '')
    const modelReference = path === 'config' && key === 'model_profile_id' && (child === null || typeof child === 'string' && /^[1-9]\d{0,19}$/.test(child))
    if (!modelReference && (DANGEROUS_CONFIG_KEYS.has(normalized) || DANGEROUS_CONFIG_STEMS.some(stem => normalized.includes(stem)))) issues.push(issue('error', 'dangerous_capability_forbidden', `配置字段不允许声明执行、网络、文件或 SQL 能力：${key}`, `${path}.${key}`))
    scanDangerousKeys(child, `${path}.${key}`, issues)
  }
}

function management(repository: StrategyCatalog): StrategyManagementRepository {
  const candidate = repository as Partial<StrategyManagementRepository>
  if (typeof candidate.findDetail !== 'function' || typeof candidate.create !== 'function'
    || typeof candidate.updateMetadata !== 'function' || typeof candidate.createVersion !== 'function'
    || typeof candidate.publishVersion !== 'function' || typeof candidate.retire !== 'function'
    || typeof candidate.findSubscription !== 'function'
    || typeof candidate.listSubscriptions !== 'function' || typeof candidate.createSubscription !== 'function'
    || typeof candidate.updateSubscription !== 'function') {
    throw new StrategyAccessError('strategy_management_unavailable', 503)
  }
  return candidate as StrategyManagementRepository
}

export class StrategyService {
  constructor(private readonly catalog: StrategyCatalog, private readonly now: () => Date = () => new Date()) {}

  async setAccountTrader(input: TraderControlInput) {
    const repository = management(this.catalog)
    if (!repository.setAccountTrader) throw new StrategyAccessError('strategy_management_unavailable', 503)
    return repository.setAccountTrader(input)
  }

  list(userId: number, kind?: StrategyKind) {
    return this.catalog.listAvailable(userId, kind)
  }

  async requireActiveVersion(userId: number, strategyId: string, kind: StrategyKind) {
    const version = await this.catalog.findActiveVersion(userId, strategyId)
    if (!version) throw new StrategyAccessError('strategy_not_found', 404)
    if (version.kind !== kind) throw new StrategyAccessError('strategy_kind_mismatch', 422)
    return version
  }

  compile(kind: StrategyKind, promptText: unknown, config: unknown) {
    return compileStrategy(kind, promptText, config)
  }

  detail(userId: number, strategyId: string) { return management(this.catalog).findDetail(userId, strategyId) }

  async create(userId: number, input: Omit<CreateStrategyInput, 'userId'>) {
    // Preparation runs only for a new request, after the durable replay lookup.
    return management(this.catalog).create({ ...input, userId }, () => {
      if ((input.kind !== 'analysis' && input.kind !== 'trader') || typeof input.name !== 'string'
        || input.name.trim().length < 1 || input.name.trim().length > 191
        || typeof input.description !== 'string' || input.description.trim().length > 2000) {
        throw new StrategyAccessError('request_field_invalid', 422)
      }
      const compiled = compileStrategy(input.kind, input.promptText, input.config)
      if (!compiled.valid) throw new StrategyAccessError('strategy_compile_invalid', 422, compiled.issues)
      return { name: input.name.trim(), description: input.description.trim(), promptText: input.promptText.trim(), compiled }
    })
  }

  async updateMetadata(input: Omit<UpdateStrategyMetadataInput, 'userId'> & { userId: number }) {
    return management(this.catalog).updateMetadata(input, () => {
      if (typeof input.name !== 'string' || input.name.trim().length < 1 || input.name.trim().length > 191
        || typeof input.description !== 'string' || input.description.trim().length > 2000) {
        throw new StrategyAccessError('request_field_invalid', 422)
      }
      return { name: input.name.trim(), description: input.description.trim() }
    })
  }

  async createVersion(input: CreateStrategyVersionInput) {
    return management(this.catalog).createVersion(input, kind => {
      const compiled = compileStrategy(kind, input.promptText, input.config)
      if (!compiled.valid) throw new StrategyAccessError('strategy_compile_invalid', 422, compiled.issues)
      return compiled
    })
  }

  publishVersion(input: PublishStrategyVersionInput) { return management(this.catalog).publishVersion(input) }
  retire(input: RetireStrategyInput) { return management(this.catalog).retire(input) }

  listSubscriptions(userId: number, tradingAccountId?: string) { return management(this.catalog).listSubscriptions(userId, tradingAccountId) }

  async createSubscription(userId: number, input: Omit<CreateStrategySubscriptionInput, 'userId'>) {
    return management(this.catalog).createSubscription({ ...input, userId }, () => {
      const status = input.status ?? 'active'
      if (status !== 'active' && status !== 'paused') throw new StrategyAccessError('subscription_status_invalid', 422)
      for (const value of [input.analysisEnabled, input.traderEnabled, input.tradeSendEnabled]) {
        if (value !== undefined && typeof value !== 'boolean') throw new StrategyAccessError('request_field_invalid', 422)
      }
      const analysisEnabled = input.analysisEnabled ?? true, traderEnabled = input.traderEnabled ?? false
      const tradeSendEnabled = traderEnabled, traderStrategyId = input.traderStrategyId ?? null
      if (!analysisEnabled && traderEnabled) throw new StrategyAccessError('subscription_analysis_required', 422)
      if (traderEnabled && !traderStrategyId) throw new StrategyAccessError('subscription_trader_required', 422)
      const standardSymbol = typeof input.standardSymbol === 'string' ? input.standardSymbol.trim().toUpperCase() : ''
      if (!/^[A-Z0-9._-]{1,64}$/.test(standardSymbol) || /[^A-Z0-9._-]/.test(standardSymbol)) throw new StrategyAccessError('request_field_invalid', 422)
      return { ...prepareTimeWindow(input.receiveWindow ?? { enabled: false }), standardSymbol, traderStrategyId, analysisEnabled, traderEnabled, tradeSendEnabled, status,
        nextDueAt: status === 'active' && analysisEnabled ? nextScheduleDue(this.now(), 300) : null }
    })
  }

  async updateSubscription(input: UpdateStrategySubscriptionInput) {
    return management(this.catalog).updateSubscription(input, current => {
      if (current.status === 'ended') throw new StrategyAccessError('strategy_subscription_ended', 409)
      const analysisStrategyId = input.analysisStrategyId ?? current.analysisStrategyId
      const traderStrategyId = input.traderStrategyId === undefined ? current.traderStrategyId : input.traderStrategyId
      for (const value of [input.analysisEnabled, input.traderEnabled, input.tradeSendEnabled]) {
        if (value !== undefined && typeof value !== 'boolean') throw new StrategyAccessError('request_field_invalid', 422)
      }
      const analysisEnabled = input.analysisEnabled ?? current.analysisEnabled
      const traderEnabled = input.traderEnabled ?? current.traderEnabled
      const tradeSendEnabled = traderEnabled
      if (!analysisEnabled && traderEnabled) throw new StrategyAccessError('subscription_analysis_required', 422)
      if (traderEnabled && !traderStrategyId) throw new StrategyAccessError('subscription_trader_required', 422)
      const status = input.status ?? current.status
      if (!['active', 'paused', 'ended'].includes(status)) throw new StrategyAccessError('subscription_status_invalid', 422)
      const standardSymbol = input.standardSymbol === undefined ? current.standardSymbol : input.standardSymbol.trim().toUpperCase()
      if (!/^[A-Z0-9._-]{1,64}$/.test(standardSymbol) || /[^A-Z0-9._-]/.test(standardSymbol)) throw new StrategyAccessError('request_field_invalid', 422)
      return { ...prepareTimeWindow(input.receiveWindow ?? current.schedule.receiveWindow), analysisStrategyId, traderStrategyId, analysisEnabled, traderEnabled, tradeSendEnabled, status, standardSymbol,
        nextDueAt: status !== 'active' || !analysisEnabled ? null : input.receiveWindow !== undefined || analysisEnabled !== current.analysisEnabled || status !== current.status || analysisStrategyId !== current.analysisStrategyId
          ? nextScheduleDue(this.now(), current.schedule.cadenceSeconds) : current.schedule.nextDueAt }
    })
  }
}

function nextScheduleDue(now: Date, cadenceSeconds: number) {
  const cadence = Math.max(60, Math.trunc(cadenceSeconds)) * 1000
  return new Date(Math.floor(now.getTime() / cadence) * cadence + cadence).toISOString()
}

function prepareTimeWindow(raw: Record<string, unknown>) {
  const receiveWindow = structuredClone(raw), receiveTimezone = receiveWindow.enabled ? 'terminal_server' : 'UTC'
  try { evaluateSubscriptionWindow(receiveWindow, receiveWindow.version === 1 ? 'terminal_server' : receiveTimezone, new Date(), null) }
  catch { throw new StrategyAccessError('subscription_window_invalid', 422) }
  return { receiveWindow, receiveTimezone: receiveWindow.version === 1 ? 'terminal_server' : receiveTimezone }
}
