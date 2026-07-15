import { beijingNow, queryAll, queryOne, queryRun, withTransaction } from '../../db.js'

export const AI_FEATURE_KEYS = [
  'review_generation_enabled',
  'experience_memory_enabled',
  'memory_compression_enabled',
  'retrieval_shadow_enabled',
  'paired_experiment_enabled',
]

export const FORCED_ENFORCE_RULES = new Set([
  'ownership', 'entitlement', 'account_review', 'kill_switch', 'data_complete', 'idempotency', 'volume_bounds',
])

const FORCED_RUNTIME_PATTERNS = [
  /^R5_/, /^R6_ACCOUNT_NOT_FOUND$/, /^R6_ACCOUNT_REVIEW_REQUIRED$/, /^R6_ACCOUNT_PAUSED$/,
  /^R6_(GLOBAL|USER)_KILL_SWITCH$/, /^R3_RISK_DATA_INCOMPLETE$/,
  /^R3_ACCOUNT_HALTED$/,
  /^R3\.4_NOTIONAL_DATA_INCOMPLETE$/, /^R1_INSTRUMENT_DATA_INCOMPLETE$/,
  /^R1\.2_/, /^R1\.6_/, /^R1_ATR_REQUIRED$/, /^R1\.9_/,
  /^R1\.10_RISK_DATA_INVALID$/, /^R4_QUOTE_INVALID$/, /^R6\.4_OBSERVATION_BELOW_MINIMUM$/,
]

const REQUIRED_MIGRATIONS = [
  '056_model_profiles_tables', '057_strategy_ownership', '058_order_intent_gateway', '059_core_risk_policy',
  '060_stateful_risk_governance', '061_inference_snapshots', '062_signal_outcomes',
  '063_trade_review_workflow', '064_personal_experience_memory', '065_ai_rollout_governance',
  '066_paired_inference_evidence', '067_manual_inference_snapshots',
]

const REQUIRED_TABLES = [
  'ai_model_profiles', 'user_model_defaults', 'platform_model_usage_policy', 'ai_model_usage_logs',
  'trading_accounts', 'strategy_subscriptions', 'order_intents', 'risk_reservations', 'risk_policy_sets',
  'risk_policy_versions', 'risk_decisions', 'risk_account_state', 'inference_snapshots', 'signal_outcomes',
  'trade_review_cases', 'trade_review_jobs', 'experience_memory_items', 'memory_compression_jobs',
  'memory_injection_logs', 'ai_feature_flags', 'risk_rule_rollouts', 'credential_migration_runs',
  'ai_paired_inference_runs',
]

const REQUIRED_COLUMNS = {
  ai_model_profiles: ['owner_user_id','scope','api_key_encrypted','key_version','deleted_at'],
  auto_prompt_types: ['scope','owner_user_id','model_profile_id','visibility_status','version'],
  order_intents: ['idempotency_key','status','lease_token','bridge_command_ref'],
  risk_decisions: ['order_intent_id','decision_status','reject_code','rule_results_json'],
  inference_snapshots: ['strategy_id','system_prompt','user_prompt','content_hash','evidence_status'],
  signal_outcomes: ['attribution_status','review_eligible_at','net_profit'],
  trade_review_cases: ['evidence_json','current_version_id','approved_version_id'],
  experience_memory_items: ['review_version_id','content_hash','status','token_count'],
  users: ['deletion_status','deleted_at'],
}

const REQUIRED_INDEXES = [
  ['ai_model_profiles','idx_model_profiles_owner'], ['order_intents','uk_order_intent_idempotency'],
  ['order_intents','idx_order_intent_lease'], ['risk_decisions','uk_risk_decision_intent'],
  ['trade_review_jobs','idx_trade_review_job_claim'], ['memory_compression_jobs','idx_memory_compression_claim'],
  ['memory_injection_logs','idx_memory_injection_user'], ['users','idx_users_deletion_status'],
  ['ai_paired_inference_runs','idx_paired_inference_status'],
]

export async function assertAiGovernanceSchemaReady() {
  const applied = await queryAll(`SELECT id FROM schema_migrations WHERE id IN (${REQUIRED_MIGRATIONS.map(() => '?').join(',')})`, REQUIRED_MIGRATIONS)
  const actual = new Set(applied.map(row => row.id))
  const missingMigrations = REQUIRED_MIGRATIONS.filter(id => !actual.has(id))
  if (missingMigrations.length) throw new Error(`ai_schema_migrations_missing:${missingMigrations.join(',')}`)
  for (const table of REQUIRED_TABLES) await queryOne(`SELECT 1 AS ok FROM ${table} LIMIT 1`)
  for (const [table, columns] of Object.entries(REQUIRED_COLUMNS)) {
    const row = await queryOne(`SELECT COUNT(*) AS count FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME IN (${columns.map(() => '?').join(',')})`, [table, ...columns])
    if (Number(row?.count) !== columns.length) throw new Error(`ai_schema_columns_missing:${table}`)
  }
  for (const [table, index] of REQUIRED_INDEXES) {
    const row = await queryOne(`SELECT COUNT(*) AS count FROM information_schema.STATISTICS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND INDEX_NAME = ?`, [table, index])
    if (!Number(row?.count)) throw new Error(`ai_schema_index_missing:${table}:${index}`)
  }
  return { ready: true, migrations: REQUIRED_MIGRATIONS.length, tables: REQUIRED_TABLES.length,
    column_groups: Object.keys(REQUIRED_COLUMNS).length, indexes: REQUIRED_INDEXES.length }
}

function normalizeFlags(row = {}) {
  return Object.fromEntries(AI_FEATURE_KEYS.map(key => [key, row[key] == null ? null : Boolean(row[key])]))
}

export async function getEffectiveFeatureFlags(userId = null) {
  const globalRow = await queryOne("SELECT * FROM ai_feature_flags WHERE scope = 'global' AND user_id = 0") || {}
  const userRow = userId ? await queryOne("SELECT * FROM ai_feature_flags WHERE scope = 'user' AND user_id = ?", [userId]) : null
  const flags = {}
  for (const key of AI_FEATURE_KEYS) {
    const globalEnabled = Boolean(globalRow[key])
    flags[key] = userRow?.[key] == null ? globalEnabled : globalEnabled && Boolean(userRow[key])
  }
  return { ...flags, global: normalizeFlags(globalRow), user: normalizeFlags(userRow || {}) }
}

export async function isAiFeatureEnabled(key, userId = null) {
  if (!AI_FEATURE_KEYS.includes(key)) throw new Error(`unknown_ai_feature:${key}`)
  return Boolean((await getEffectiveFeatureFlags(userId))[key])
}

export async function updateAiFeatureFlags({ actorId, actorRole, targetUserId = null, flags = {} }) {
  const scope = targetUserId ? 'user' : 'global'
  if (scope === 'global' && actorRole !== 'admin') throw new Error('admin_required')
  if (actorRole !== 'admin' && Number(targetUserId) !== Number(actorId)) throw new Error('access_denied')
  const values = {}
  for (const key of AI_FEATURE_KEYS) {
    if (!(key in flags)) continue
    values[key] = flags[key] == null && scope === 'user' ? null : flags[key] ? 1 : 0
  }
  if (!Object.keys(values).length) throw new Error('feature_flags_required')
  const columns = Object.keys(values)
  const now = beijingNow()
  await queryRun(`INSERT INTO ai_feature_flags (scope, user_id, ${columns.join(', ')}, updated_by, updated_at)
    VALUES (?, ?, ${columns.map(() => '?').join(', ')}, ?, ?)
    ON DUPLICATE KEY UPDATE ${columns.map(key => `${key} = VALUES(${key})`).join(', ')}, updated_by = VALUES(updated_by), updated_at = VALUES(updated_at)`,
  [scope, targetUserId || 0, ...columns.map(key => values[key]), actorId, now])
  return getEffectiveFeatureFlags(targetUserId || null)
}

export async function updateRiskRuleRollout({ actorId, actorRole, ruleCode, mode }) {
  if (actorRole !== 'admin') throw new Error('admin_required')
  if (!['shadow', 'enforce'].includes(mode)) throw new Error('invalid_rollout_mode')
  ruleCode = String(ruleCode || '').trim()
  if (!ruleCode || ruleCode.length > 80) throw new Error('invalid_rule_code')
  if (FORCED_ENFORCE_RULES.has(ruleCode) && mode !== 'enforce') throw new Error(`forced_rule_must_enforce:${ruleCode}`)
  await queryRun(`INSERT INTO risk_rule_rollouts (rule_code, mode, forced_enforce, updated_by, updated_at)
    VALUES (?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE mode = VALUES(mode),
    forced_enforce = VALUES(forced_enforce), updated_by = VALUES(updated_by), updated_at = VALUES(updated_at)`,
  [ruleCode, mode, FORCED_ENFORCE_RULES.has(ruleCode) ? 1 : 0, actorId, beijingNow()])
  return queryOne('SELECT * FROM risk_rule_rollouts WHERE rule_code = ?', [ruleCode])
}

export async function getRiskRuleRolloutModes() {
  const rows = await queryAll('SELECT rule_code, mode, forced_enforce FROM risk_rule_rollouts')
  return Object.fromEntries(rows.map(row => [String(row.rule_code), {
    mode: row.mode === 'shadow' ? 'shadow' : 'enforce', forced: Boolean(row.forced_enforce),
  }]))
}

export function riskRuleIsEnforced(ruleCode, modes = {}) {
  const code = String(ruleCode || '')
  if (!code || FORCED_RUNTIME_PATTERNS.some(pattern => pattern.test(code))) return true
  const family = code.includes('_') ? code.slice(0, code.indexOf('_')) : code
  const configured = modes[code] || modes[family]
  if (!configured || configured.forced) return true
  return configured.mode !== 'shadow'
}

async function metric(sql, params = []) {
  try { return await queryAll(sql, params) } catch (error) { return [{ metric_error: String(error?.code || error?.message || 'metric_failed').slice(0, 128) }] }
}

export async function getAiRolloutHealth() {
  const [modelUsage, intents, uncertain, rejects, outcomes, reviews, compression, memory, cost, paired, flags, riskRules, credentialRun] = await Promise.all([
    metric(`SELECT credential_source, request_status, COALESCE(error_code, '') AS error_code, COUNT(*) AS count,
      SUM(token_count) AS tokens FROM ai_model_usage_logs WHERE created_at >= DATE_SUB(NOW(), INTERVAL 24 HOUR)
      GROUP BY credential_source, request_status, COALESCE(error_code, '')`),
    metric(`SELECT status, COUNT(*) AS count FROM order_intents WHERE created_at >= DATE_SUB(NOW(), INTERVAL 24 HOUR) GROUP BY status`),
    metric(`SELECT COUNT(*) AS count, COALESCE(MAX(TIMESTAMPDIFF(SECOND, updated_at, NOW())), 0) AS oldest_seconds
      FROM order_intents WHERE status = 'uncertain'`),
    metric(`SELECT COALESCE(reject_code, 'unspecified') AS reject_code, COUNT(*) AS count FROM risk_decisions
      WHERE decision_status = 'reject' AND created_at >= DATE_SUB(NOW(), INTERVAL 24 HOUR) GROUP BY reject_code`),
    metric(`SELECT COUNT(*) AS backlog, COALESCE(MAX(TIMESTAMPDIFF(SECOND, updated_at, NOW())), 0) AS oldest_seconds
      FROM signal_outcomes WHERE status IN ('open','pending')`),
    metric(`SELECT status, COUNT(*) AS count FROM trade_review_jobs WHERE status IN ('queued','leased','failed') GROUP BY status`),
    metric(`SELECT status, COUNT(*) AS count, COALESCE(MAX(TIMESTAMPDIFF(SECOND, updated_at, NOW())), 0) AS oldest_seconds
      FROM memory_compression_jobs WHERE status IN ('queued','leased','failed') GROUP BY status`),
    metric(`SELECT status, COUNT(*) AS count, COALESCE(SUM(token_count), 0) AS tokens FROM experience_memory_items GROUP BY status`),
    metric(`SELECT credential_source, COUNT(*) AS requests, COALESCE(SUM(token_count), 0) AS tokens FROM ai_model_usage_logs
      WHERE created_at >= DATE_SUB(NOW(), INTERVAL 24 HOUR) GROUP BY credential_source`),
    metric(`SELECT status, COUNT(*) AS count FROM ai_paired_inference_runs
      WHERE created_at >= DATE_SUB(NOW(), INTERVAL 24 HOUR) GROUP BY status`),
    queryAll('SELECT * FROM ai_feature_flags ORDER BY scope, user_id'),
    queryAll('SELECT * FROM risk_rule_rollouts ORDER BY forced_enforce DESC, rule_code'),
    queryOne('SELECT * FROM credential_migration_runs ORDER BY id DESC LIMIT 1'),
  ])
  const alerts = []
  const uncertainState = uncertain[0] || {}
  if (Number(uncertainState.count) > 0 && Number(uncertainState.oldest_seconds) > 300) alerts.push({ severity:'critical', code:'uncertain_order_age', value:Number(uncertainState.oldest_seconds) })
  const failedReviews = reviews.find(row => row.status === 'failed')
  if (Number(failedReviews?.count || 0) > 0) alerts.push({ severity:'warning', code:'review_jobs_failed', value:Number(failedReviews.count) })
  const staleCompression = compression.find(row => ['queued','leased'].includes(row.status) && Number(row.oldest_seconds) > 3600)
  if (staleCompression) alerts.push({ severity:'warning', code:'memory_compression_stale', value:Number(staleCompression.oldest_seconds) })
  if (credentialRun?.status === 'failed') alerts.push({ severity:'critical', code:'credential_migration_failed' })
  return { generated_at: beijingNow(), alerts, metrics: { model_usage:modelUsage, order_intents:intents, uncertain:uncertainState,
    risk_rejects:rejects, outcome_backlog:outcomes[0] || {}, review_queue:reviews, compression_queue:compression,
    memory_tokens:memory, platform_cost:cost, paired_inference:paired }, feature_flags:flags.map(row => ({ ...normalizeFlags(row), scope:row.scope, user_id:row.user_id, updated_at:row.updated_at })),
    risk_rule_rollouts:riskRules, credential_migration:credentialRun || null }
}

export async function recordCredentialMigration(runInfo, task) {
  const started = beijingNow()
  const insert = await queryRun(`INSERT INTO credential_migration_runs
    (status, migrated_count, rotated_count, failed_count, legacy_cleared, started_at)
    VALUES ('running', 0, 0, 0, 0, ?)`, [started])
  try {
    const result = await withTransaction(async run => task(run))
    await queryRun(`UPDATE credential_migration_runs SET status = 'succeeded', migrated_count = ?, rotated_count = ?,
      failed_count = 0, legacy_cleared = ?, completed_at = ? WHERE id = ?`,
    [Number(result.migratedCount || 0), Number(result.rotatedCount || 0), result.legacyCleared ? 1 : 0, beijingNow(), insert.insertId])
    return { runId: insert.insertId, ...result }
  } catch (error) {
    await queryRun(`UPDATE credential_migration_runs SET status = 'failed', failed_count = 1, error_code = ?, completed_at = ? WHERE id = ?`,
    [String(error?.message || 'credential_migration_failed').slice(0, 128), beijingNow(), insert.insertId])
    throw error
  }
}
