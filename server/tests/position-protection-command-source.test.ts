import { describe, expect, it, vi } from 'vitest'
import type { Pool } from 'mysql2/promise'
import { MysqlExecutionCommandSource } from '../src/modules/execution/infrastructure/mysql-execution-command-source.js'
import { sha256Canonical } from '../src/modules/execution/index.js'

describe('protection command candidate snapshot versions', () => {
  const state = { ticket: '101', symbol: 'XAUUSD', volume: '0.02' }
  function source(sourceType: string, revision: number, hash = sha256Canonical(state)) {
    const action = { kind: 'modify_position', parameters: { ticket: '101', stop_loss: '2450' }, expectedState: { positionsRevision: 6 } }
    const execute = vi.fn().mockResolvedValueOnce([[{
      intent_id: 'intent', user_id: 7, trading_account_id: '5', action_kind: action.kind,
      expires_at_utc: new Date('2026-09-10T01:00:00Z'), source_type: sourceType,
      action_json: action, action_sha256: sha256Canonical(action), terminal_profile_id: 'profile-1',
      terminal_instance_id: 'terminal-1', broker_server: 'Broker', account_login: '42', connection_epoch_v4: 1,
    }]]).mockResolvedValueOnce([[{ state_json: state, state_sha256: hash, projection_revision: revision }]])
    return new MysqlExecutionCommandSource({ execute } as unknown as Pool, { magic: 0, deviation: 0 })
  }
  it('allows a newer workflow hint for transaction re-review', async () => {
    const result = await source('position_workflow', 7).loadPrepared('intent', '2026-09-10T00:00:00Z')
    expect(result?.command.expectedState).toEqual(state)
  })
  it.each([5, 0, 6.5, Number.MAX_SAFE_INTEGER + 1])('rejects regressed or invalid workflow version %s', async revision => {
    await expect(source('position_workflow', revision).loadPrepared('intent', '2026-09-10T00:00:00Z')).rejects.toThrow('bridge_command_expected_state_stale')
  })
  it('preserves exact versions for ordinary commands', async () => {
    await expect(source('user_command', 7).loadPrepared('intent', '2026-09-10T00:00:00Z')).rejects.toThrow('bridge_command_expected_state_stale')
    await expect(source('user_command', 6).loadPrepared('intent', '2026-09-10T00:00:00Z')).resolves.toBeTruthy()
  })
  it('rejects corrupted newer snapshot content', async () => {
    await expect(source('position_workflow', 7, 'bad').loadPrepared('intent', '2026-09-10T00:00:00Z')).rejects.toThrow('bridge_command_expected_state_stale')
  })
})
