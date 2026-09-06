import { readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadMigrationPlan } from './lib/v4-migration-plan.mjs'
import { digest, matrixRows, plannedColumns, validateUpgradeReview } from './lib/v4-upgrade-review.mjs'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const read = path => readFile(resolve(root, path), 'utf8')
const json = async path => JSON.parse(await read(path))
const artifact = 'docs/migration/public-upgrade-u1-review-20260906.json'
const frozenPath = 'docs/migration/m1-b2-identity-field-manifest-20260905.json'
const [inventory, observation, frozen, matrix, plan] = await Promise.all([
  json('docs/migration/m1-source-target-inventory-20260905.json'),
  json('docs/migration/m1-b2-identity-observation-20260905.json'),
  json(frozenPath), read('docs/database-table-migration-matrix.md'), loadMigrationPlan({ rootDirectory: root }),
])
const catalog = plannedColumns(plan)
const rows = matrixRows(matrix)
const identity = structuredClone(frozen)
identity.revision = 2
identity.supersedes = frozenPath
identity.gaps.push(
  { id: 'G-INSTALL', summary: 'Source SQL exists; actual target installation and constraints require a separate observed schema check.' },
  { id: 'G-TRANSFORM', summary: 'Executable versioned transforms, whole-row relationships and persisted reconciliation receipts are not yet implemented.' },
)
const updates = {
  users: {
    email_verified: 'users.email_verified', phone_verified: 'users.phone_verified', auth_method: 'users.auth_method',
    plan_period: 'users.plan_period', plan_source: 'users.plan_source', last_seen_at: 'users.last_seen_at_utc', changelog_seen_version: 'users.changelog_seen_version',
    referral_code: 'user_referral_accounts.referral_code', referred_by: 'user_referral_accounts.referred_by_code', referral_credit: 'user_referral_accounts.referral_credit',
  },
  trading_accounts: {
    user_id: 'user_trading_account_settings.user_id', margin_mode: 'trading_accounts.margin_mode',
    ...Object.fromEntries(['nickname', 'review_status', 'observe_status', 'anomaly_code'].map(c => [c, 'user_trading_account_settings.' + c])),
    is_deleted: 'user_trading_account_settings.legacy_is_deleted',
    ...Object.fromEntries(['observed_until', 'identity_verified_at', 'first_verified_at'].map(c => [c, 'user_trading_account_settings.' + c + '_utc'])),
  },
  mt5_account_ownership_history: {
    user_id: 'trading_account_ownership_intervals.user_id', trading_account_id: 'trading_account_ownership_intervals.trading_account_id',
    started_at: 'trading_account_ownership_intervals.started_at_utc', ended_at: 'trading_account_ownership_intervals.ended_at_utc', end_reason: 'trading_account_ownership_intervals.end_reason',
  },
  ai_observer_sources: {
    id: 'observer_sources.id', name: 'observer_sources.display_name', bridge_user_id: 'observer_sources.operator_user_id',
    trading_account_id: 'observer_sources.trading_account_id', strategy_id: 'observer_sources.analysis_strategy_id', status: 'observer_sources.status', notes: 'observer_sources.notes',
    created_by_user_id: 'observer_sources.created_by_user_id', created_at: 'observer_sources.created_at_utc', updated_at: 'observer_sources.updated_at_utc',
  },
  ai_observer_channels: {
    source_id: 'observer_channels.source_id', slug: 'observer_channels.slug', description: 'observer_channels.description',
    audience: 'observer_channels.audience', is_default: 'observer_channels.is_default', sort_order: 'observer_channels.sort_order',
    created_at: 'observer_channels.created_at_utc', updated_at: 'observer_channels.updated_at_utc',
  },
  ai_observer_channel_assignments: { created_by_user_id: 'observer_channel_accesses.granted_by_user_id' },
}
const evidenceByTable = {
  users: 'docs/stage-m1-b2-p1-user-state-schema-report.md',
  trading_accounts: 'docs/stage-m1-b2-p2-account-ownership-report.md',
  mt5_account_ownership_history: 'docs/stage-m1-b2-p2-account-ownership-report.md',
  ai_observer_sources: 'docs/stage-m1-b2-p4a-observer-read-authorization-report.md',
  ai_observer_channels: 'docs/stage-m1-b2-p4a-observer-read-authorization-report.md',
  ai_observer_channel_assignments: 'docs/stage-m1-b2-p4a-observer-read-authorization-report.md',
}
const gapReview = {
  'G-USER': '018 supplies active non-Telegram user fields; retired Telegram remains controlled history; transform and runtime gates remain.',
  'G-MEMBER': '018 supplies source/period/referral columns; amount, lifecycle, time and commercial ledger reconciliation remain.',
  'G-IDENTITY': '019 supplies account settings; exact legacy identity map and collision/merge decisions remain.',
  'G-OWNERSHIP': '019 supplies interval storage; interval IDs, source receipts, UTC evidence and overlap reconciliation remain.',
  'G-OFFLINE': 'P3 supplies offline reads; migrated owner/settings coherence and actual account visibility remain unverified.',
  'G-OBSERVER': '021/022 and P4 supply source/audience management; legacy strategy/source IDs and values require transformations and reconciliation.',
}
for (const gap of identity.gaps) if (gapReview[gap.id]) gap.summary = gapReview[gap.id]
for (const table of identity.tables) for (const field of table.fields) {
  const previousTarget = field.target
  field.target = updates[table.sourceTable]?.[field.sourceColumn] ?? field.target
  if (table.sourceTable === 'users' && field.sourceColumn.startsWith('telegram_')) {
    field.target = 'history-proposal:users.' + field.sourceColumn
    field.disposition = 'history'
    field.transformId = 'b2.history'
    field.blockers = field.blockers.filter(b => b !== 'G-USER')
    field.blockers.push('G-EVIDENCE')
    field.relationRule = 'Retired by explicit product decision; preserve original snapshot facts and controlled history locator; do not re-enable Telegram or replay notifications.'
    field.evidence.push('docs/stage-m1-b2-identity-target-contract-plan.md#3.2')
  }
  if (table.sourceTable === 'trading_accounts' && field.sourceColumn === 'user_id') field.relationRule = 'Preserve source user/account association in private settings; this is not sufficient evidence to create current owner grants. Freeze exact account ID mapping separately.'
  if (table.sourceTable === 'ai_observer_channels' && field.sourceColumn === 'source_id') field.relationRule = 'Map legacy source ID to observer_sources.id, not to a trading account ID; derive source_trading_account_id only through the validated source/account relationship.'
  field.blockers = [...new Set([...field.blockers, 'G-INSTALL', 'G-TRANSFORM'])]
  field.reviewStatus = 'blocked'
  const [name, column] = (field.target ?? '').split('.')
  const declaration = catalog[name]?.[column] ?? null
  const declaredType = declaration?.declaration.match(/^([A-Z]+(?:\([^)]*\))?(?: UNSIGNED)?)/i)?.[1].toLowerCase() ?? null
  const declaredNullable = declaration ? !/\bNOT NULL\b/i.test(declaration.declaration) : null
  const declaredDefault = declaration?.declaration.match(/\bDEFAULT\s+(NULL|'(?:''|[^'])*'|[^ ,]+)/i)?.[1] ?? null
  const declaredCollation = declaration && /^(?:char|varchar|text|longtext|mediumtext|enum)/i.test(declaredType)
    ? declaration.declaration.match(/\bCOLLATE\s+(\w+)/i)?.[1] ?? declaration.tableDefaults.collation : null
  field.review = {
    previousTarget, targetDeclaration: declaration,
    sourceToPlan: { sourceType: field.sourceType, declaredType, sourceNullable: field.sourceNullable, declaredNullable,
      sourceDefault: field.sourceDefault, declaredDefaultSql: declaredDefault, sourceCollation: field.sourceCollation, declaredCollation,
      flags: declaration ? [
        ...(field.sourceType !== declaredType ? ['type-or-precision-changed'] : []),
        ...(field.sourceNullable && !declaredNullable ? ['nullable-to-required'] : []),
        ...(field.sourceCollation !== declaredCollation ? ['collation-changed'] : []),
        'default-must-not-substitute-source-value',
      ] : ['target-not-declared'] },
    structuralStatus: declaration ? 'declared-in-source-plan' : 'historical-or-unresolved-target',
    remainingChecks: [
      'Validate actual installed target type, precision, NULL/default, collation and complete constraints; source declaration is not live evidence.',
      'Preserve NULL/empty/zero separately; reject truncation, collision, enum/state ambiguity and whole-row relationship mismatch.',
      'Bind executable transform and receipts to this immutable source snapshot before any backfill.',
      ...(/^datetime/i.test(field.sourceType) ? ['Historical DATETIME timezone remains unknown; no fixed-offset conversion.'] : []),
    ],
  }
  if (previousTarget !== field.target && evidenceByTable[table.sourceTable]) field.evidence.push(evidenceByTable[table.sourceTable])
}
const coverage = inventory.source_tables.map(source => {
  const row = rows.get(source.name)
  if (!row) throw new Error('upgrade_matrix_table_missing:' + source.name)
  const firstWave = identity.tables.find(t => t.sourceTable === source.name)
  const physical = firstWave?.fields.map(f => f.target).filter(t => t && !t.includes(':')).map(t => t.split('.')[0])
  const candidates = [...new Set(physical?.length ? physical : row.candidateTargets)]
  return { sourceTable: source.name, sourceColumns: source.columns, domain: row.domain,
    action: row.action, rule: row.rule, legacyMatrixCandidates: row.candidateTargets,
    targets: candidates.map(name => ({ name, existsInPlan: Boolean(catalog[name]) })),
    status: 'blocked', fieldReview: firstWave ? 'first-wave-reviewed-not-executable' : 'pending',
    blockers: firstWave ? ['field-level-blockers', 'target-installation-unverified', 'backfill-unimplemented'] : ['field-contract-pending', 'runtime-feature-and-target-contract-review-pending'],
    evidence: ['docs/database-table-migration-matrix.md', ...(firstWave ? [frozenPath] : [])],
  }
})
const bundle = { schemaVersion: 1, stage: 'U1', executable: false, frozenSource: frozen.source,
  provenance: { frozenManifestSha256: digest(await read(frozenPath)), inventorySha256: digest(await read('docs/migration/m1-source-target-inventory-20260905.json')),
    plan: plan.map(m => ({ id: m.id, file: m.file, checksum: m.checksum })), targetEvidence: 'source SQL only; no database connection', sourceEvidence: 'frozen 20260905 snapshot; public structure equivalence checked separately on 20260906' },
  coverage, identity,
}
const result = validateUpgradeReview(bundle, inventory, observation, catalog)
if (!result.ok) throw new Error(JSON.stringify(result.errors))
const args = process.argv.slice(2)
if (args.length > 1 || (args.length && args[0] !== '--write')) throw new Error('upgrade_review_argument_invalid')
if (args[0] === '--write') await writeFile(resolve(root, artifact), JSON.stringify(bundle, null, 2) + '\n')
else if (digest(await json(artifact)) !== digest(bundle)) throw new Error('upgrade_review_artifact_stale')
console.log(JSON.stringify({ ok: true, executable: false, tables: coverage.length, sourceColumns: coverage.reduce((n,t) => n + t.sourceColumns.length, 0), firstWaveTables: identity.tables.length,
  firstWaveFields: identity.tables.reduce((n,t) => n + t.fields.length, 0), remappedFields: identity.tables.flatMap(t => t.fields).filter(f => f.target !== f.review.previousTarget).length,
  declaredFields: identity.tables.flatMap(t => t.fields).filter(f => f.review.targetDeclaration).length }))
