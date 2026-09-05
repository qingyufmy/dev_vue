import { describe, expect, it } from 'vitest'
import {
  evaluateV4MigrationTarget, V4MigrationTargetPreflightError,
} from '../scripts/lib/v4-migration-target-preflight.mjs'

const v4Columns = [
  ['id', 'char(36)'], ['purpose', "enum('analysis','trader')"], ['user_id', 'int'],
  ['trading_account_id', 'bigint unsigned'], ['strategy_id', 'bigint unsigned'],
  ['strategy_version_id', 'bigint unsigned'], ['payload_sha256', 'char(64)'], ['captured_at_utc', 'datetime(3)'],
].map(([name, type]) => ({ name, type }))

describe('M1 V4 migration target preflight', () => {
  it('accepts a distinct empty target and a compatible partial V4 target', () => {
    expect(evaluateV4MigrationTarget({ currentDatabase: 'dev_vue_next', sourceDatabase: 'dev_vue', tables: [], migrationIds: [], columns: {} }))
      .toEqual({ status: 'pass', mode: 'empty', database: 'dev_vue_next', tableCount: 0, inferenceSnapshots: 'absent' })
    expect(evaluateV4MigrationTarget({
      currentDatabase: 'dev_vue_next', sourceDatabase: 'dev_vue', tables: ['schema_migrations', 'inference_snapshots'],
      migrationIds: ['20260903_004_ai_strategy_and_inference_core'], columns: { inference_snapshots: v4Columns },
    }, 'v4')).toMatchObject({ status: 'pass', mode: 'v4', inferenceSnapshots: 'v4' })
  })

  it('rejects the source database before inspecting its tables', () => {
    expectFailure(
      () => evaluateV4MigrationTarget({ currentDatabase: 'dev_vue', sourceDatabase: 'dev_vue', tables: [], migrationIds: [], columns: {} }),
      'v4_migration_target_is_source',
    )
  })

  it('rejects legacy migration history and a non-empty target in empty mode', () => {
    expectFailure(() => evaluateV4MigrationTarget({
      currentDatabase: 'dev_vue_next', sourceDatabase: 'dev_vue', tables: ['schema_migrations'],
      migrationIds: ['201_risk_reset_baseline_and_semantic_version'], columns: {},
    }), 'v4_migration_legacy_history_detected')
    expectFailure(() => evaluateV4MigrationTarget({
      currentDatabase: 'dev_vue_next', sourceDatabase: 'dev_vue', tables: ['users'], migrationIds: [], columns: {},
    }), 'v4_migration_target_not_empty')
  })

  it('rejects the legacy inference snapshot table instead of trusting IF NOT EXISTS', () => {
    expectFailure(() => evaluateV4MigrationTarget({
      currentDatabase: 'dev_vue_next', sourceDatabase: 'dev_vue', tables: ['inference_snapshots'], migrationIds: [],
      columns: { inference_snapshots: [
        { name: 'id', type: 'bigint' }, { name: 'signal_id', type: 'bigint' },
        { name: 'system_prompt', type: 'longtext' }, { name: 'user_prompt', type: 'longtext' },
      ] },
    }, 'v4'), 'inference_snapshots_schema_conflict')
  })
})

function expectFailure(action, code) {
  try {
    action()
    throw new Error('expected_preflight_failure')
  } catch (error) {
    expect(error).toBeInstanceOf(V4MigrationTargetPreflightError)
    expect(error).toMatchObject({ code })
  }
}
