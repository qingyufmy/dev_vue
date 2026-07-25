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
})
