import type { Pool, PoolConnection, RowDataPacket } from 'mysql2/promise'
import type {
  AuthRepository,
  AuthUser,
  AuthorizationCodeInput,
  ConsumedAuthorizationCode,
  CreateSessionInput,
  StoredSession,
} from '../application/auth-ports.js'

interface UserRow extends RowDataPacket {
  id: number
  nickname: string | null
  email: string | null
  avatar: string | null
  role: string
  password: string
  token_version: number | null
  deletion_status: string | null
  deleted_at: string | null
}

interface SessionRow extends RowDataPacket {
  id: number | string
  user_id: number
  client_id: StoredSession['clientId']
  parent_session_id: number | string | null
  auth_time_utc: Date
  mfa_level: StoredSession['mfaLevel']
  session_version: number
  idle_expires_at_utc: Date | null
  absolute_expires_at_utc: Date
  revoked_at_utc: Date | null
}

interface AuthorizationCodeRow extends RowDataPacket {
  id: number | string
  code_hash: string
  user_id: number
  auth_session_id: number | string
  client_id: ConsumedAuthorizationCode['clientId']
  redirect_uri: string
  scope: string
  nonce: string
  code_challenge: string
  created_at_utc: Date
  expires_at_utc: Date
  auth_time_utc: Date
  mfa_level: ConsumedAuthorizationCode['mfaLevel']
  session_version: number
}

async function transaction<T>(pool: Pool, work: (connection: PoolConnection) => Promise<T>) {
  const connection = await pool.getConnection()
  try {
    await connection.beginTransaction()
    const result = await work(connection)
    await connection.commit()
    return result
  } catch (error) {
    await connection.rollback()
    throw error
  } finally {
    connection.release()
  }
}

function mapUser(row: UserRow | undefined): AuthUser | null {
  if (!row) return null
  return {
    id: row.id,
    displayName: row.nickname?.trim() || row.email?.trim() || `用户 ${row.id}`,
    avatarUrl: row.avatar?.trim() || null,
    role: row.role,
    passwordHash: row.password,
    sessionVersion: Number(row.token_version ?? 0),
    active: row.deletion_status === 'active' && row.deleted_at === null,
  }
}

// mysql2 intentionally returns BIGINT as strings. Auth's internal session/code ports use safe numbers.
// Normalize here, before issuing tickets or consuming codes; never round an out-of-range database identity.
function authIdentity(value: unknown): number {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) return value
  if (typeof value === 'string' && /^[1-9][0-9]{0,15}$/.test(value)
    && BigInt(value) <= BigInt(Number.MAX_SAFE_INTEGER)) return Number(value)
  throw new Error('auth_storage_identity_invalid')
}

function mapSession(row: SessionRow): StoredSession {
  return {
    id: authIdentity(row.id),
    userId: row.user_id,
    clientId: row.client_id,
    parentSessionId: row.parent_session_id === null ? null : authIdentity(row.parent_session_id),
    authTimeUtc: new Date(row.auth_time_utc),
    mfaLevel: row.mfa_level,
    sessionVersion: row.session_version,
    idleExpiresAtUtc: row.idle_expires_at_utc ? new Date(row.idle_expires_at_utc) : null,
    absoluteExpiresAtUtc: new Date(row.absolute_expires_at_utc),
    revokedAtUtc: row.revoked_at_utc ? new Date(row.revoked_at_utc) : null,
  }
}

export class MysqlAuthRepository implements AuthRepository {
  constructor(private readonly pool: Pool) {}

  async findUserByLogin(login: string) {
    const [rows] = await this.pool.execute<UserRow[]>(`
      SELECT id, nickname, email, avatar, role, password, token_version, deletion_status, deleted_at
      FROM users
      WHERE (LOWER(email) = LOWER(?) OR phone = ?)
      LIMIT 1`, [login, login])
    return mapUser(rows[0])
  }

  async findUserById(userId: number) {
    const [rows] = await this.pool.execute<UserRow[]>(`
      SELECT id, nickname, email, avatar, role, password, token_version, deletion_status, deleted_at
      FROM users WHERE id = ? LIMIT 1`, [userId])
    return mapUser(rows[0])
  }

  async createSession(input: CreateSessionInput) {
    const [result] = await this.pool.execute(`
      INSERT INTO auth_sessions
        (session_hash, user_id, client_id, parent_session_id, auth_time_utc, mfa_level,
         session_version, created_at_utc, last_seen_at_utc, idle_expires_at_utc, absolute_expires_at_utc)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
      input.sessionHash, input.userId, input.clientId, input.parentSessionId,
      input.authTimeUtc, input.mfaLevel, input.sessionVersion, input.createdAtUtc,
      input.lastSeenAtUtc, input.idleExpiresAtUtc, input.absoluteExpiresAtUtc,
    ])
    if (!('insertId' in result) || !result.insertId) throw new Error('auth_session_insert_failed')
    return { ...input, id: authIdentity(result.insertId), revokedAtUtc: null }
  }

  async findActiveSession(sessionHash: string, now: Date) {
    const [rows] = await this.pool.execute<SessionRow[]>(`
      SELECT id, user_id, client_id, parent_session_id, auth_time_utc, mfa_level,
             session_version, idle_expires_at_utc, absolute_expires_at_utc, revoked_at_utc
      FROM auth_sessions
      WHERE session_hash = ? AND revoked_at_utc IS NULL
        AND absolute_expires_at_utc > ?
        AND (idle_expires_at_utc IS NULL OR idle_expires_at_utc > ?)
      LIMIT 1`, [sessionHash, now, now])
    return rows[0] ? mapSession(rows[0]) : null
  }

  async findActiveSessionById(sessionId: number, now: Date) {
    const [rows] = await this.pool.execute<SessionRow[]>(`
      SELECT id, user_id, client_id, parent_session_id, auth_time_utc, mfa_level,
             session_version, idle_expires_at_utc, absolute_expires_at_utc, revoked_at_utc
      FROM auth_sessions
      WHERE id = ? AND revoked_at_utc IS NULL
        AND absolute_expires_at_utc > ?
        AND (idle_expires_at_utc IS NULL OR idle_expires_at_utc > ?)
      LIMIT 1`, [sessionId, now, now])
    return rows[0] ? mapSession(rows[0]) : null
  }

  async touchSession(sessionId: number, now: Date, idleExpiresAtUtc: Date | null, touchBeforeUtc: Date) {
    await this.pool.execute(`
      UPDATE auth_sessions
      SET last_seen_at_utc = ?, idle_expires_at_utc = COALESCE(?, idle_expires_at_utc)
      WHERE id = ? AND revoked_at_utc IS NULL AND last_seen_at_utc < ?`, [now, idleExpiresAtUtc, sessionId, touchBeforeUtc])
  }

  async revokeSession(sessionId: number, reason: string, now: Date) {
    await this.pool.execute(`
      UPDATE auth_sessions SET revoked_at_utc = ?, revocation_reason = ?
      WHERE id = ? AND revoked_at_utc IS NULL`, [now, reason, sessionId])
  }

  async revokeWebSessions(userId: number, reason: string, now: Date) {
    await this.pool.execute(`
      UPDATE auth_sessions SET revoked_at_utc = ?, revocation_reason = ?
      WHERE user_id = ? AND revoked_at_utc IS NULL
        AND client_id IN ('auth', 'www-web', 'trade-web', 'admin-web')`, [now, reason, userId])
  }

  async storeAuthorizationCode(input: AuthorizationCodeInput) {
    await this.pool.execute(`
      INSERT INTO auth_authorization_codes
        (code_hash, user_id, auth_session_id, client_id, redirect_uri, scope, nonce,
         code_challenge, code_challenge_method, created_at_utc, expires_at_utc)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'S256', ?, ?)`, [
      input.codeHash, input.userId, input.authSessionId, input.clientId, input.redirectUri,
      input.scope, input.nonce, input.codeChallenge, input.createdAtUtc, input.expiresAtUtc,
    ])
  }

  async consumeAuthorizationCode(codeHash: string, now: Date) {
    return transaction(this.pool, async connection => {
      const [rows] = await connection.execute<AuthorizationCodeRow[]>(`
        SELECT c.id, c.code_hash, c.user_id, c.auth_session_id, c.client_id, c.redirect_uri,
               c.scope, c.nonce, c.code_challenge, c.created_at_utc, c.expires_at_utc,
               s.auth_time_utc, s.mfa_level, s.session_version
        FROM auth_authorization_codes c
        INNER JOIN auth_sessions s ON s.id = c.auth_session_id
        WHERE c.code_hash = ? AND c.consumed_at_utc IS NULL AND c.expires_at_utc > ?
          AND s.revoked_at_utc IS NULL AND s.absolute_expires_at_utc > ?
        FOR UPDATE`, [codeHash, now, now])
      const row = rows[0]
      if (!row) return null
      const codeId = authIdentity(row.id)
      const authSessionId = authIdentity(row.auth_session_id)
      const [result] = await connection.execute(`
        UPDATE auth_authorization_codes SET consumed_at_utc = ?
        WHERE id = ? AND consumed_at_utc IS NULL`, [now, codeId])
      if (!('affectedRows' in result) || result.affectedRows !== 1) return null
      return {
        id: codeId,
        codeHash: row.code_hash,
        userId: row.user_id,
        authSessionId,
        clientId: row.client_id,
        redirectUri: row.redirect_uri,
        scope: row.scope,
        nonce: row.nonce,
        codeChallenge: row.code_challenge,
        createdAtUtc: new Date(row.created_at_utc),
        expiresAtUtc: new Date(row.expires_at_utc),
        authTimeUtc: new Date(row.auth_time_utc),
        mfaLevel: row.mfa_level,
        sessionVersion: row.session_version,
      }
    })
  }
}
