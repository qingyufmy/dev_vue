import { randomUUID } from 'node:crypto'
import type { Pool, PoolConnection, RowDataPacket } from 'mysql2/promise'
import type { BridgeInstallationRepository } from '../application/bridge-installation-service.js'
import { BridgeInstallationError, type InstallationStart } from '../domain/bridge-installation.js'

interface RequestRow extends RowDataPacket {
  id: string; installation_id: string; device_name: string; poll_secret_hash: string; installation_token_hash: string
  status: string; revision: number; user_id: number | null; decision_key: string | null
  created_at: string; expires_at: string; unexpired: number; may_poll: number
}
interface IdentityRow extends RowDataPacket {
  id: string; user_id: number; installation_id: string; nickname: string; generation: number; revoked_at_utc: string | null
}
const REQUEST = `SELECT id,installation_id,device_name,poll_secret_hash,installation_token_hash,status,revision,user_id,decision_key,
  DATE_FORMAT(created_at_utc,'%Y-%m-%dT%H:%i:%s.%fZ') created_at,DATE_FORMAT(expires_at_utc,'%Y-%m-%dT%H:%i:%s.%fZ') expires_at,
  (expires_at_utc>UTC_TIMESTAMP(3)) unexpired,(next_poll_at_utc IS NULL OR next_poll_at_utc<=UTC_TIMESTAMP(3)) may_poll FROM bridge_installation_requests`
const ELIGIBLE = `u.deletion_status='active' AND u.deleted_at IS NULL
  `
const identityDto = (r: IdentityRow) => ({ id: r.id, installation_id: r.installation_id, generation: Number(r.generation),
  user: { id: String(r.user_id), display_name: r.nickname || '量见用户' }, authorized: true as const })
// The deadline limits approval of pending requests, not retrieval of a durable decision.
const status = (r: RequestRow) => r.status === 'pending' && !Number(r.unexpired) ? 'expired' : r.status
const fail = (code: string, http: number): never => { throw new BridgeInstallationError(`bridge_installation_${code}`, http) }

export class MysqlBridgeInstallationRepository implements BridgeInstallationRepository {
  constructor(private readonly pool: Pool) {}
  async start(input: InstallationStart, ipHash: string) {
    return this.transaction(async c => {
      await c.execute(`INSERT INTO bridge_installation_request_limits (ip_hash,window_started_at_utc,request_count)
        VALUES (?,UTC_TIMESTAMP(3),0) ON DUPLICATE KEY UPDATE ip_hash=ip_hash`, [ipHash])
      const [limits] = await c.execute<RowDataPacket[]>(`SELECT request_count,(window_started_at_utc>UTC_TIMESTAMP(3)-INTERVAL 10 MINUTE) recent
        FROM bridge_installation_request_limits WHERE ip_hash=? FOR UPDATE`, [ipHash])
      const [existing] = await c.execute<RequestRow[]>(`${REQUEST} WHERE request_key=? FOR UPDATE`, [input.request_key])
      let row = existing[0]
      if (row) {
        if (row.installation_id !== input.installation_id || row.device_name !== input.device_name
          || row.poll_secret_hash !== input.poll_secret_hash || row.installation_token_hash !== input.installation_token_hash) fail('request_conflict', 409)
      } else {
        if (Number(limits[0]?.recent) && Number(limits[0]?.request_count) >= 10) throw new BridgeInstallationError('bridge_installation_rate_limited', 429, 600)
        await c.execute(`UPDATE bridge_installation_request_limits SET request_count=IF(window_started_at_utc>UTC_TIMESTAMP(3)-INTERVAL 10 MINUTE,request_count+1,1),
          window_started_at_utc=IF(window_started_at_utc>UTC_TIMESTAMP(3)-INTERVAL 10 MINUTE,window_started_at_utc,UTC_TIMESTAMP(3)) WHERE ip_hash=?`, [ipHash])
        const id = randomUUID()
        await c.execute(`INSERT INTO bridge_installation_requests
          (id,request_key,installation_id,device_name,poll_secret_hash,installation_token_hash,ip_hash,created_at_utc,expires_at_utc)
          VALUES (?,?,?,?,?,?,?,UTC_TIMESTAMP(3),UTC_TIMESTAMP(3)+INTERVAL 10 MINUTE)`,
        [id, input.request_key, input.installation_id, input.device_name, input.poll_secret_hash, input.installation_token_hash, ipHash])
        const [rows] = await c.execute<RequestRow[]>(`${REQUEST} WHERE id=?`, [id]); row = rows[0]
      }
      if (!row) fail('storage_failed', 503)
      return { authorization_id: row!.id, confirmation_path: `/bridge/authorize?request=${row!.id}`, expires_at: row!.expires_at, poll_interval_seconds: 5 }
    })
  }
  async confirmation(id: string, userId: number) {
    const [rows] = await this.pool.execute<RequestRow[]>(`${REQUEST} WHERE id=?`, [id])
    if (!rows[0]) fail('request_unknown', 404)
    return this.confirmationDto(this.pool, rows[0]!, userId)
  }
  async decide(id: string, userId: number, key: string, decision: 'approved' | 'denied', revision: string) {
    return this.transaction(async c => {
      if (decision === 'approved') await this.lockUser(c, userId)
      else {
        const [users] = await c.execute<RowDataPacket[]>('SELECT id FROM users WHERE id=? AND deletion_status=\'active\' AND deleted_at IS NULL FOR UPDATE', [userId])
        if (!users.length) fail('not_eligible', 403)
      }
      const [rows] = await c.execute<RequestRow[]>(`${REQUEST} WHERE id=? FOR UPDATE`, [id]); const row = rows[0]
      if (!row) fail('request_unknown', 404)
      if (row!.status !== 'pending') {
        if (row!.user_id !== userId || row!.status !== decision || row!.decision_key !== key || String(Number(row!.revision) - 1) !== revision) fail('decision_conflict', 409)
        return this.confirmationDto(c, row!, userId)
      }
      if (!Number(row!.unexpired)) fail('expired', 410)
      if (String(row!.revision) !== revision) fail('revision_conflict', 409)
      if (decision === 'approved') {
        const [conflicts] = await c.execute<RowDataPacket[]>('SELECT id FROM bridge_installation_authorizations WHERE installation_id=? AND revoked_at_utc IS NULL FOR UPDATE', [row!.installation_id])
        if (conflicts.length) fail('identity_conflict', 409)
        await c.execute(`INSERT INTO bridge_installation_authorizations (id,user_id,installation_id,token_hash,device_name,created_at_utc)
          VALUES (?,?,?,?,?,UTC_TIMESTAMP(3))`, [id, userId, row!.installation_id, row!.installation_token_hash, row!.device_name])
      }
      await c.execute('UPDATE bridge_installation_requests SET status=?,revision=revision+1,user_id=?,decision_key=?,decided_at_utc=UTC_TIMESTAMP(3) WHERE id=?', [decision, userId, key, id])
      return this.confirmationDto(c, { ...row!, status: decision, revision: Number(row!.revision) + 1, user_id: userId } as RequestRow, userId)
    })
  }
  async poll(id: string, pollHash: string, tokenHash: string) {
    return this.transaction(async c => {
      const [rows] = await c.execute<RequestRow[]>(`${REQUEST} WHERE id=? AND poll_secret_hash=? AND installation_token_hash=? FOR UPDATE`, [id, pollHash, tokenHash])
      const row = rows[0]; if (!row) fail('poll_invalid', 401)
      if (!Number(row!.may_poll)) throw new BridgeInstallationError('bridge_installation_slow_down', 429, 5)
      await c.execute('UPDATE bridge_installation_requests SET next_poll_at_utc=UTC_TIMESTAMP(3)+INTERVAL 5 SECOND WHERE id=?', [id])
      const current = status(row!)
      if (current !== 'approved') return { status: current, poll_interval_seconds: 5 }
      const identity = await this.readIdentity(c, row!.installation_id, tokenHash)
      return { status: 'approved', poll_interval_seconds: 5, installation_id: identity.installation_id, user: identity.user,
        generation: identity.generation, authorized: true as const }
    })
  }
  authenticate(installationId: string, tokenHash: string) { return this.readIdentity(this.pool, installationId, tokenHash) }
  async registerProfile(installationId: string, tokenHash: string, key: string, refreshHash: string) {
    const owner = await this.authenticate(installationId, tokenHash)
    return this.transaction(async c => {
      await this.lockUser(c, Number(owner.user.id))
      const identity = await this.readIdentity(c, installationId, tokenHash, true)
      const [existing] = await c.execute<RowDataPacket[]>(`SELECT profile_id,generation,token_hash,revoked_at FROM bridge_refresh_sessions
        WHERE installation_authorization_id=? AND installation_request_key=? FOR UPDATE`, [identity.id, key])
      if (existing[0]) {
        if (existing[0].token_hash !== refreshHash || existing[0].revoked_at) fail('profile_conflict', 409)
        return { profile_id: String(existing[0].profile_id), generation: Number(existing[0].generation) }
      }
      const profileId = `profile-${randomUUID()}`
      await c.execute(`INSERT INTO bridge_refresh_sessions (user_id,token_hash,expires_at,created_at,updated_at,credential_version,installation_id,profile_id,generation,installation_authorization_id,installation_request_key)
        VALUES (?,?,'9999-12-31 23:59:59',UTC_TIMESTAMP(3),UTC_TIMESTAMP(3),4,?,?,1,?,?)`, [Number(identity.user.id), refreshHash, installationId, profileId, identity.id, key])
      return { profile_id: profileId, generation: 1 }
    })
  }
  async revoke(installationId: string, tokenHash: string) {
    // Lookup may include a revoked row so retries after lost acknowledgements are safe.
    const [owners] = await this.pool.execute<RowDataPacket[]>('SELECT user_id FROM bridge_installation_authorizations WHERE installation_id=? AND token_hash=?', [installationId, tokenHash])
    if (!owners[0]) fail('credential_invalid', 401)
    await this.transaction(async c => {
      await c.execute('SELECT id FROM users WHERE id=? FOR UPDATE', [owners[0]!.user_id])
      const [rows] = await c.execute<RowDataPacket[]>('SELECT id FROM bridge_installation_authorizations WHERE installation_id=? AND token_hash=? FOR UPDATE', [installationId, tokenHash])
      if (!rows[0]) fail('credential_invalid', 401)
      const id = rows[0]!.id
      await c.execute('UPDATE bridge_installation_authorizations SET revoked_at_utc=COALESCE(revoked_at_utc,UTC_TIMESTAMP(3)) WHERE id=?', [id])
      await c.execute("UPDATE bridge_installation_requests SET status='revoked',revision=revision+1 WHERE id=? AND status<>'revoked'", [id])
      await c.execute('UPDATE bridge_refresh_sessions SET revoked_at=COALESCE(revoked_at,UTC_TIMESTAMP(3)),updated_at=UTC_TIMESTAMP(3) WHERE installation_authorization_id=?', [id])
    })
  }
  private async readIdentity(c: Pick<Pool, 'execute'> | Pick<PoolConnection, 'execute'>, installationId: string, tokenHash: string, lock = false) {
    const [rows] = await c.execute<IdentityRow[]>(`SELECT i.id,i.user_id,i.installation_id,i.generation,i.revoked_at_utc,u.nickname
      FROM bridge_installation_authorizations i INNER JOIN users u ON u.id=i.user_id
      WHERE i.installation_id=? AND i.token_hash=? AND i.revoked_at_utc IS NULL AND ${ELIGIBLE} ${lock ? 'FOR UPDATE' : ''}`, [installationId, tokenHash])
    if (rows.length !== 1) fail('credential_invalid', 401)
    return identityDto(rows[0]!)
  }
  private async lockUser(c: PoolConnection, userId: number) {
    const [rows] = await c.execute<RowDataPacket[]>(`SELECT u.id FROM users u WHERE u.id=? AND ${ELIGIBLE} FOR UPDATE`, [userId])
    if (!rows.length) fail('not_eligible', 403)
  }
  private async confirmationDto(c: Pick<Pool, 'execute'> | Pick<PoolConnection, 'execute'>, row: RequestRow, userId: number) {
    const [users] = await c.execute<RowDataPacket[]>('SELECT id,nickname FROM users WHERE id=? AND deletion_status=\'active\' AND deleted_at IS NULL', [userId])
    if (!users[0]) fail('not_eligible', 403)
    return { authorization_id: row.id, installation_id: row.installation_id, device_name: row.device_name, status: status(row),
      revision: String(row.revision), created_at: row.created_at, expires_at: row.expires_at,
      current_user: { id: String(userId), display_name: String(users[0]!.nickname || '量见用户') } }
  }
  private async transaction<T>(work: (c: PoolConnection) => Promise<T>): Promise<T> {
    const c = await this.pool.getConnection(); let committing = false; let destroyed = false
    try { await c.beginTransaction(); const result = await work(c); committing = true; await c.commit(); return result }
    catch (error) {
      if (committing) { c.destroy(); destroyed = true; throw new BridgeInstallationError('bridge_installation_commit_unknown', 503) }
      try { await c.rollback() } catch { c.destroy(); destroyed = true }
      if (error instanceof BridgeInstallationError) throw error
      throw new BridgeInstallationError('bridge_installation_storage_failed', 503)
    } finally { if (!destroyed) c.release() }
  }
}
