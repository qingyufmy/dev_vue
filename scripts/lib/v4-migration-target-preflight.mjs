const REQUIRED_INFERENCE_SNAPSHOT_COLUMNS = new Map([
  ['id', 'char(36)'],
  ['purpose', "enum('analysis','trader')"],
  ['user_id', 'int'],
  ['trading_account_id', 'bigint unsigned'],
  ['strategy_id', 'bigint unsigned'],
  ['strategy_version_id', 'bigint unsigned'],
  ['payload_sha256', 'char(64)'],
  ['captured_at_utc', 'datetime(3)'],
])

export class V4MigrationTargetPreflightError extends Error {
  constructor(code, details = {}) {
    super(code)
    this.name = 'V4MigrationTargetPreflightError'
    this.code = code
    this.details = details
  }
}

export function evaluateV4MigrationTarget(snapshot, mode = 'empty') {
  if (!snapshot || typeof snapshot.currentDatabase !== 'string' || !snapshot.currentDatabase) {
    throw new V4MigrationTargetPreflightError('v4_migration_target_database_unknown')
  }
  if (!['empty', 'v4'].includes(mode)) throw new V4MigrationTargetPreflightError('v4_migration_target_mode_invalid')
  if (snapshot.sourceDatabase && snapshot.currentDatabase === snapshot.sourceDatabase) {
    throw new V4MigrationTargetPreflightError('v4_migration_target_is_source', { database: snapshot.currentDatabase })
  }

  const migrations = Array.isArray(snapshot.migrationIds) ? snapshot.migrationIds : []
  const legacyMigrations = migrations.filter(id => typeof id === 'string' && /^\d{3}(?:_|$)/.test(id))
  if (legacyMigrations.length > 0) {
    throw new V4MigrationTargetPreflightError('v4_migration_legacy_history_detected', { migrations: legacyMigrations.slice(0, 10) })
  }

  const tables = Array.isArray(snapshot.tables) ? [...new Set(snapshot.tables.filter(name => typeof name === 'string'))].sort() : []
  const inference = snapshot.columns?.inference_snapshots
  if (tables.includes('inference_snapshots')) assertV4InferenceSnapshotFingerprint(inference)

  const businessTables = tables.filter(name => name !== 'schema_migrations')
  if (mode === 'empty' && businessTables.length > 0) {
    throw new V4MigrationTargetPreflightError('v4_migration_target_not_empty', { tables: businessTables.slice(0, 50) })
  }

  return {
    status: 'pass',
    mode,
    database: snapshot.currentDatabase,
    tableCount: businessTables.length,
    inferenceSnapshots: tables.includes('inference_snapshots') ? 'v4' : 'absent',
  }
}

export function assertV4InferenceSnapshotFingerprint(columns) {
  if (!Array.isArray(columns)) {
    throw new V4MigrationTargetPreflightError('inference_snapshots_schema_conflict', { reason: 'columns_unavailable' })
  }
  const actual = new Map(columns.map(column => [String(column.name).toLowerCase(), normalizeType(column.type)]))
  const mismatches = []
  for (const [name, expectedType] of REQUIRED_INFERENCE_SNAPSHOT_COLUMNS) {
    const actualType = actual.get(name)
    if (actualType !== expectedType) mismatches.push({ name, expectedType, actualType: actualType ?? null })
  }
  const legacyMarkers = ['signal_id', 'system_prompt', 'user_prompt', 'klines_json'].filter(name => actual.has(name))
  if (mismatches.length > 0 || legacyMarkers.length > 0) {
    throw new V4MigrationTargetPreflightError('inference_snapshots_schema_conflict', { mismatches, legacyMarkers })
  }
}

function normalizeType(value) {
  return String(value ?? '').trim().toLowerCase().replace(/\s+/g, ' ')
}
