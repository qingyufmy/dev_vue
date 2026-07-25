import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const migrations = readFileSync(new URL('../server/migrations.js', import.meta.url), 'utf8')

describe('Bridge v3 schema migration', () => {
  it('creates a durable command ledger with immutable identity and recovery indexes', () => {
    expect(migrations).toContain("id: '140_bridge_v3_command_ledger'")
    expect(migrations).toContain('CREATE TABLE IF NOT EXISTS bridge_v3_command_ledger')
    expect(migrations).toContain('UNIQUE KEY uk_bridge_v3_command_id (command_id)')
    expect(migrations).toContain('payload_hash CHAR(64) NOT NULL')
    expect(migrations).toContain('connection_epoch BIGINT UNSIGNED NOT NULL')
    expect(migrations).toContain('idx_bridge_v3_command_ready (status, deadline_at_utc_msc)')
    expect(migrations).toContain('CREATE TABLE IF NOT EXISTS bridge_v3_command_events')
  })

  it('creates terminal session, revision, account, position and order read models', () => {
    expect(migrations).toContain("id: '141_bridge_v3_incremental_read_model'")
    for (const table of [
      'bridge_v3_terminal_sessions',
      'bridge_v3_stream_revisions',
      'bridge_v3_account_latest',
      'bridge_v3_positions_latest',
      'bridge_v3_orders_latest',
    ]) expect(migrations).toContain(`CREATE TABLE IF NOT EXISTS ${table}`)
    expect(migrations).toContain('PRIMARY KEY (terminal_instance_id, connection_epoch, stream)')
    expect(migrations).toContain('PRIMARY KEY (terminal_instance_id, ticket)')
  })

  it('stores device pairing secrets as hashes with one-time lifecycle fields', () => {
    expect(migrations).toContain("id: '142_bridge_device_pairing'")
    expect(migrations).toContain('CREATE TABLE IF NOT EXISTS bridge_device_pairings')
    expect(migrations).toContain('device_code_hash CHAR(64) NOT NULL')
    expect(migrations).toContain('user_code_hash CHAR(64) NOT NULL')
    expect(migrations).toContain('approved_token_version INT DEFAULT NULL')
    expect(migrations).toContain('consumed_at DATETIME DEFAULT NULL')
  })
})
