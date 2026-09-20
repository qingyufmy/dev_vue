import type { Pool } from 'mysql2/promise'
import { describe, expect, it } from 'vitest'
import { MysqlBridgeCredentialRepository } from '../src/modules/bridge/infrastructure/mysql-bridge-credential-repository.js'

interface Credential {
  id: number; userId: number; tokenHash: string; installationId: string; profileId: string
  generation: number; version: number; revokedAt: string | null
}
const input = { tokenHash: 'a'.repeat(64), installationId: 'install-1', profileId: 'profile-1' }
const first: Credential = { ...input, id: 1, userId: 7, generation: 2, version: 4, revokedAt: null }

/** Transactional SQL substitute: no real database and no lock-scheduling claims. */
class CredentialPool {
  rows: Credential[] = [structuredClone(first)]
  calls: Array<{ sql: string; params: unknown[] }> = []
  transactions: string[] = []
  failAt: 'update' | 'commit' | null = null
  failRollback = false
  zeroUpdate = false
  private pending: Credential[] | null = null
  asPool() { return this as unknown as Pool }
  async getConnection() { return this }
  async beginTransaction() { this.pending = structuredClone(this.rows); this.transactions.push('begin') }
  async commit() {
    if (this.failAt === 'commit') throw new Error('commit failure with secret')
    this.rows = this.pending!; this.pending = null; this.transactions.push('commit')
  }
  async rollback() {
    this.pending = null; this.transactions.push('rollback')
    if (this.failRollback) throw new Error('rollback detail')
  }
  release() { this.transactions.push('release') }
  destroy() { this.pending = null; this.transactions.push('destroy') }
  async execute(sql: string, params: unknown[] = []) {
    this.calls.push({ sql, params })
    if ((sql.match(/\?/g) ?? []).length !== params.length) throw new Error('placeholder mismatch')
    if (!this.pending) throw new Error('missing transaction')
    if (sql.startsWith('SELECT id AS session_id,user_id,')) {
      const [token, installation, profile] = params
      return [this.pending.filter(row => row.tokenHash === token && row.installationId === installation
        && row.profileId === profile && row.version === 4).map(row => ({ session_id: row.id, user_id: row.userId,
        installation_id: row.installationId, profile_id: row.profileId, generation: row.generation, revoked_at: row.revokedAt })), []]
    }
    if (sql.startsWith('UPDATE bridge_refresh_sessions')) {
      if (this.failAt === 'update') throw new Error('write failure with secret')
      const [id, token, installation, profile, generation] = params
      const row = this.pending.find(item => item.id === id && item.tokenHash === token && item.installationId === installation
        && item.profileId === profile && item.generation === generation && item.version === 4 && item.revokedAt === null)
      if (this.zeroUpdate || !row) return [{ affectedRows: 0 }, []]
      row.revokedAt = '2026-09-06T07:00:00.000Z'
      return [{ affectedRows: 1 }, []]
    }
    throw new Error(`unrecognized statement ${sql}`)
  }
}

describe('precise Bridge device revocation (transaction double)', () => {
  it('revokes one matching generation and confirms a lost response without rewriting its time', async () => {
    const pool = new CredentialPool()
    pool.rows.push({ ...first, id: 2, tokenHash: 'b'.repeat(64), profileId: 'profile-2' },
      { ...first, id: 3, tokenHash: 'c'.repeat(64), installationId: 'install-2' })
    const untouched = structuredClone(pool.rows.slice(1))
    const repository = new MysqlBridgeCredentialRepository(pool.asPool())
    const revoked = await repository.revokeDeviceRefresh(input)
    expect(revoked).toEqual({ userId: 7, installationId: 'install-1', profileId: 'profile-1', generation: 2 })
    const originalTime = pool.rows[0]!.revokedAt
    expect(originalTime).not.toBeNull()
    expect(await repository.revokeDeviceRefresh(input)).toEqual(revoked)
    expect(pool.rows[0]!.revokedAt).toBe(originalTime)
    expect(pool.rows.slice(1)).toEqual(untouched)
    expect(pool.calls.filter(call => call.sql.startsWith('UPDATE'))).toHaveLength(1)
    const lookup = pool.calls[0]!.sql
    expect(lookup).toContain('FOR UPDATE')
    expect(lookup).not.toMatch(/JOIN|users|plan|expires_at|revoked_at IS NULL/)
  })

  it('never broadens an old-token request to a later rotated token or a different binding/version', async () => {
    for (const patch of [{ tokenHash: 'd'.repeat(64), generation: 3 }, { installationId: 'install-2' },
      { profileId: 'profile-2' }, { version: 3 }]) {
      const pool = new CredentialPool()
      Object.assign(pool.rows[0]!, patch)
      const before = structuredClone(pool.rows)
      await expect(new MysqlBridgeCredentialRepository(pool.asPool()).revokeDeviceRefresh(input))
        .rejects.toMatchObject({ code: 'bridge_credential_binding_invalid', status: 401 })
      expect(pool.rows).toEqual(before)
      expect(pool.calls).toHaveLength(1)
      expect(pool.transactions).toEqual(['begin', 'rollback', 'release'])
    }
  })

  it('rolls back failed writes but destroys uncertain commits, and permits a later exact retry', async () => {
    for (const failAt of ['update', 'commit'] as const) {
      const pool = new CredentialPool()
      pool.failAt = failAt
      const repository = new MysqlBridgeCredentialRepository(pool.asPool())
      await expect(repository.revokeDeviceRefresh(input)).rejects.toMatchObject({ code: failAt === 'commit' ? 'bridge_credential_commit_unknown' : 'bridge_credential_storage_failed', status: 503, retryable: failAt !== 'commit' })
      expect(pool.rows[0]!.revokedAt).toBeNull()
      expect(pool.transactions).toEqual(failAt === 'commit' ? ['begin', 'destroy'] : ['begin', 'rollback', 'release'])
      pool.failAt = null
      await expect(repository.revokeDeviceRefresh(input)).resolves.toMatchObject({ generation: 2 })
      expect(pool.rows[0]!.revokedAt).not.toBeNull()
    }
  })

  it('does not acknowledge a failed CAS and destroys the connection when rollback fails', async () => {
    const pool = new CredentialPool()
    pool.zeroUpdate = true
    pool.failRollback = true
    await expect(new MysqlBridgeCredentialRepository(pool.asPool()).revokeDeviceRefresh(input))
      .rejects.toMatchObject({ code: 'bridge_credential_storage_failed', status: 503 })
    expect(pool.rows[0]!.revokedAt).toBeNull()
    expect(pool.transactions).toEqual(['begin', 'rollback', 'destroy'])
  })
})
