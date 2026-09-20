import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'

describe('Stage 12F Bridge command persistence boundaries', () => {
  it('rechecks the active account command gate inside the account-locked create transaction', async () => {
    const source = await readFile(new URL('../src/modules/execution/infrastructure/mysql-bridge-command-repository.ts', import.meta.url), 'utf8')
    const lockIndex = source.indexOf('await lockAccount(connection, command.accountId)')
    const gateIndex = source.indexOf("status IN ('queued','dispatched','accepted','uncertain','reconciling')")
    const insertIndex = source.indexOf('INSERT INTO bridge_commands_v4')
    expect(lockIndex).toBeGreaterThan(-1)
    expect(gateIndex).toBeGreaterThan(lockIndex)
    expect(insertIndex).toBeGreaterThan(gateIndex)
    expect(source).toContain('bridge_account_command_inflight')
  })

  it('adds side-by-side V4 command evidence without rewriting legacy command rows', async () => {
    const migration = await readFile(new URL('../db/migrations/20260903_010_bridge_v4_command_ledger.sql', import.meta.url), 'utf8')
    for (const table of ['bridge_trade_state_snapshots_v4', 'bridge_commands_v4', 'bridge_command_payloads_v4', 'bridge_command_results_v4', 'bridge_command_events_v4']) {
      expect(migration).toContain(`CREATE TABLE IF NOT EXISTS ${table}`)
    }
    expect(migration).toContain('conflict TINYINT(1)')
    expect(migration).toContain("'queued','dispatched','accepted','succeeded','rejected','failed','uncertain','reconciling'")
    expect(migration).toContain('connection_epoch_v4 BIGINT UNSIGNED NULL')
    expect(migration).toContain("ENUM('active','committed','absorbed','released','expired')")
    expect(migration).toContain('DROP INDEX uk_bridge_connection_epoch')
    expect(migration).toContain('UNIQUE KEY uk_bridge_connection_route_epoch (terminal_instance_id, connection_epoch)')
    expect(migration).not.toContain('MODIFY COLUMN connection_epoch')
    expect(migration).not.toMatch(/DROP TABLE|TRUNCATE TABLE|DELETE FROM|UPDATE bridge_v3_command_ledger/i)
  })

  it('keeps every socket call outside the MySQL repository', async () => {
    const source = await readFile(new URL('../src/modules/execution/infrastructure/mysql-bridge-command-repository.ts', import.meta.url), 'utf8')
    expect(source).toContain('bridge_command_results_v4')
    expect(source).toContain('bridge_result_conflict')
    expect(source).toContain('bridge_trade_state_snapshots_v4')
    const actionReader = await readFile(new URL('../src/modules/execution/infrastructure/mysql-command-source-action.ts', import.meta.url), 'utf8')
    expect(actionReader).toContain('action_sha256')
    expect(actionReader).not.toMatch(/WebSocket|\.send\(|fetch\(|axios|OrderSend/i)
    expect(source).toContain('projection_revision')
    expect(source).toContain('connection_epoch_v4')
    expect(source).toMatch(/status=.*active/)
    expect(source).toContain('FOR UPDATE')
    expect(source.indexOf('c.execution_intent_id=? AND c.command_sequence=?')).toBeLessThan(source.indexOf('await lockExactRoute(connection, command)'))
    expect(source).not.toMatch(/WebSocket|\.send\(|fetch\(|axios|OrderSend/i)
  })

  it('persists dispatch before transport and creates result acknowledgement only after persistence', async () => {
    const source = await readFile(new URL('../src/modules/execution/application/bridge-command-service.ts', import.meta.url), 'utf8')
    const send = source.indexOf('transport.send(dispatched.request, dispatched.accountId, commandScope(dispatched))')
    expect(send).toBeGreaterThan(-1)
    expect(source.indexOf('markDispatched')).toBeLessThan(send)
    expect(source.indexOf('persistResult(envelope')).toBeLessThan(source.indexOf('resultAck(persisted.command'))
    expect(source).toContain('bridge_transport_write_uncertain')
    expect(source).toContain('reconcileEnvelope')
  })

  it('does not weaken the prepared intent domain with Bridge transport concerns', async () => {
    const preparation = await readFile(new URL('../src/modules/execution/domain/execution.ts', import.meta.url), 'utf8')
    expect(preparation.toLowerCase()).not.toContain('command.request')
    expect(preparation.toLowerCase()).not.toContain('websocket')
  })
})
