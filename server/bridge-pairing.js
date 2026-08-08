import crypto from 'crypto'
import { queryAll, queryOne, queryRun, withTransaction } from './db.js'
import { assertBridgeEligible, createBridgeRefreshSession } from './bridge-auth-session.js'

const PAIRING_TTL_MINUTES = 10
const PAIRING_POLL_INTERVAL_SECONDS = 2
const USER_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'

const hashToken = token => crypto.createHash('sha256').update(String(token || '')).digest('hex')

function transactionRows(result) {
  if (Array.isArray(result) && Array.isArray(result[0])) return result[0]
  return Array.isArray(result) ? result : []
}

function transactionChanges(result) {
  const value = Array.isArray(result) ? result[0] : result
  return Number(value?.affectedRows ?? value?.changes ?? 0)
}

function pairingError(code) {
  const error = new Error(code)
  error.code = code
  return error
}

function normalizeUserCode(value) {
  return String(value || '').toUpperCase().replace(/[^A-Z0-9]/g, '')
}

function generateUserCode() {
  let value = ''
  for (let index = 0; index < 8; index++) {
    value += USER_CODE_ALPHABET[crypto.randomInt(USER_CODE_ALPHABET.length)]
  }
  return `${value.slice(0, 4)}-${value.slice(4)}`
}

export async function startBridgePairing({ deviceName = '', ip = '', run = queryRun } = {}) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const deviceCode = crypto.randomBytes(32).toString('base64url')
    const userCode = generateUserCode()
    try {
      await run(`INSERT INTO bridge_device_pairings
        (device_code_hash, user_code_hash, status, device_name, created_ip,
         expires_at, created_at, updated_at)
        VALUES (?, ?, 'pending', ?, ?, DATE_ADD(NOW(), INTERVAL ? MINUTE), NOW(), NOW())`, [
        hashToken(deviceCode), hashToken(normalizeUserCode(userCode)),
        String(deviceName || '').trim().slice(0, 120), String(ip || '').slice(0, 64),
        PAIRING_TTL_MINUTES,
      ])
      try {
        await run(`DELETE FROM bridge_device_pairings
          WHERE expires_at < DATE_SUB(NOW(), INTERVAL 1 DAY)`, [])
      } catch {
        // Expired-row cleanup must not invalidate a pairing that was already created.
      }
      return {
        deviceCode,
        userCode,
        verificationPath: '/ai/bridge/pair',
        expiresInSeconds: PAIRING_TTL_MINUTES * 60,
        intervalSeconds: PAIRING_POLL_INTERVAL_SECONDS,
      }
    } catch (error) {
      if (error?.code !== 'ER_DUP_ENTRY' || attempt === 2) throw error
    }
  }
  throw pairingError('bridge_pair_start_failed')
}

async function resolvePairingUser(actor, bridgeUserId, query = queryOne) {
  const targetId = Number(bridgeUserId || 0)
  if (!targetId || targetId === Number(actor?.id)) return actor
  if (String(actor?.role || '').toLowerCase() !== 'admin') throw pairingError('bridge_pair_source_forbidden')
  const target = await query(`SELECT users.* FROM users
    WHERE users.id = ? AND users.deletion_status = 'active' AND users.deleted_at IS NULL
      AND (users.plan_source = 'observer_source' OR EXISTS (
        SELECT 1 FROM ai_observer_sources sources WHERE sources.bridge_user_id = users.id
      )) LIMIT 1`, [targetId])
  if (!target) throw pairingError('bridge_pair_source_invalid')
  return target
}

function assertObserverManager(actor) {
  if (String(actor?.role || '').toLowerCase() !== 'admin') {
    throw pairingError('bridge_observer_management_forbidden')
  }
}

async function resolveManagedObserverUser(actor, bridgeUserId, query = queryOne) {
  assertObserverManager(actor)
  const targetId = Number(bridgeUserId || 0)
  if (!Number.isInteger(targetId) || targetId <= 0 || targetId === Number(actor?.id)) {
    throw pairingError('bridge_pair_source_invalid')
  }
  const target = await query(`SELECT users.* FROM users
    WHERE users.id = ? AND users.deletion_status = 'active' AND users.deleted_at IS NULL
      AND users.plan_source = 'observer_source'
    LIMIT 1`, [targetId])
  if (!target) throw pairingError('bridge_pair_source_invalid')
  return target
}

export async function listManagedObserverSources(
  actor,
  { query = queryAll } = {},
) {
  assertObserverManager(actor)
  return query(`SELECT users.id AS bridge_user_id, users.email, users.nickname,
      sources.id AS source_id, sources.name AS source_name, sources.status AS source_status,
      sources.trading_account_id, accounts.login_account, accounts.broker_server
    FROM users
    LEFT JOIN ai_observer_sources sources ON sources.bridge_user_id = users.id
    LEFT JOIN trading_accounts accounts ON accounts.id = sources.trading_account_id
      AND accounts.user_id = users.id AND accounts.is_deleted = 0
    WHERE users.plan_source = 'observer_source'
      AND users.deletion_status = 'active' AND users.deleted_at IS NULL
      AND users.plan = 'pro' AND (users.plan_expires_at IS NULL OR users.plan_expires_at >= NOW())
    ORDER BY sources.status = 'active' DESC, sources.name, users.nickname, users.id`)
}

export async function createManagedObserverSession(
  actor,
  bridgeUserId,
  {
    terminalInstanceId = '', userAgent = '', ip = '', query = queryOne,
    run = null, transact = withTransaction,
  } = {},
) {
  const target = await resolveManagedObserverUser(actor, bridgeUserId, query)
  assertBridgeEligible(target)
  const terminalId = String(terminalInstanceId || '').trim()
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/.test(terminalId)) {
    throw pairingError('bridge_observer_terminal_invalid')
  }
  const create = async execute => {
    const existingRows = transactionRows(await execute(`SELECT sessions.*,
      accounts.login_account AS expected_login_account,
      accounts.broker_server AS expected_broker_server
    FROM bridge_v3_terminal_sessions sessions
    LEFT JOIN ai_observer_sources sources ON sources.bridge_user_id = ? AND sources.status = 'active'
    LEFT JOIN trading_accounts accounts ON accounts.id = sources.trading_account_id
      AND accounts.user_id = ? AND accounts.is_deleted = 0
    WHERE sessions.terminal_instance_id = ?
      FOR UPDATE`, [target.id, target.id, terminalId]))
    const existing = existingRows[0]
    if (existing) {
      const expectedLogin = String(existing.expected_login_account || '').trim()
      const expectedBroker = String(existing.expected_broker_server || '').trim().toLowerCase()
      if ((expectedLogin && expectedLogin !== String(existing.login_account || '').trim())
        || (expectedBroker && expectedBroker !== String(existing.broker_server || '').trim().toLowerCase())) {
        throw pairingError('observer_source_account_mismatch')
      }
      await execute('DELETE FROM bridge_v3_stream_revisions WHERE terminal_instance_id = ?', [terminalId])
      await execute('DELETE FROM bridge_v3_account_latest WHERE terminal_instance_id = ?', [terminalId])
      await execute('DELETE FROM bridge_v3_positions_latest WHERE terminal_instance_id = ?', [terminalId])
      await execute('DELETE FROM bridge_v3_orders_latest WHERE terminal_instance_id = ?', [terminalId])
      await execute('UPDATE bridge_v3_deals SET user_id = ? WHERE terminal_instance_id = ?', [target.id, terminalId])
      await execute('DELETE FROM bridge_v3_terminal_sessions WHERE terminal_instance_id = ?', [terminalId])
    }
    const session = await createBridgeRefreshSession(target, {
      userAgent:String(userAgent || '').slice(0, 255),
      ip:String(ip || '').slice(0, 64),
      run:execute,
    })
    return {
      bridgeUserId:Number(target.id),
      terminalInstanceId:terminalId,
      refreshToken:session.refreshToken,
      refreshExpiresInSeconds:session.expiresInSeconds,
    }
  }
  return run ? create(run) : transact(create)
}

export async function approveBridgePairing(user, userCode, {
  ip = '', bridgeUserId = null, run = queryRun, query = queryOne,
} = {}) {
  const pairingUser = await resolvePairingUser(user, bridgeUserId, query)
  assertBridgeEligible(pairingUser)
  const normalized = normalizeUserCode(userCode)
  if (normalized.length !== 8) throw pairingError('bridge_pair_code_invalid')
  const result = await run(`UPDATE bridge_device_pairings
    SET status = 'approved', user_id = ?, approved_token_version = ?,
      approved_at = NOW(), approved_ip = ?, updated_at = NOW()
    WHERE user_code_hash = ? AND status = 'pending' AND expires_at > NOW()`, [
    pairingUser.id, Number(pairingUser.token_version || 0), String(ip || '').slice(0, 64), hashToken(normalized),
  ])
  if (transactionChanges(result) !== 1) throw pairingError('bridge_pair_code_invalid')
  return {
    approved:true,
    bridgeUserId:Number(pairingUser.id),
    bridgeRole:String(pairingUser.role || 'user'),
    bridgePlanSource:String(pairingUser.plan_source || ''),
  }
}

export async function consumeBridgePairing(
  deviceCode,
  { userAgent = '', ip = '', transact = withTransaction } = {},
) {
  if (!deviceCode || String(deviceCode).length < 40) {
    throw pairingError('bridge_pair_device_code_invalid')
  }
  return transact(async run => {
    const rows = transactionRows(await run(`SELECT pairings.id AS pairing_id,
        pairings.status AS pairing_status,
        pairings.approved_token_version AS pairing_token_version,
        (pairings.expires_at <= NOW()) AS pairing_expired,
        users.*
      FROM bridge_device_pairings pairings
      LEFT JOIN users ON users.id = pairings.user_id
        AND users.deletion_status = 'active' AND users.deleted_at IS NULL
      WHERE pairings.device_code_hash = ?
      FOR UPDATE`, [hashToken(deviceCode)]))
    const pairing = rows[0]
    if (!pairing) throw pairingError('bridge_pair_device_code_invalid')
    if (Number(pairing.pairing_expired) === 1) {
      await run(`UPDATE bridge_device_pairings
        SET status = 'expired', updated_at = NOW()
        WHERE id = ? AND status IN ('pending', 'approved')`, [pairing.pairing_id])
      return { status: 'expired' }
    }
    if (pairing.pairing_status === 'pending') return { status: 'pending' }
    if (pairing.pairing_status !== 'approved'
      || !pairing.id
      || Number(pairing.pairing_token_version || 0) !== Number(pairing.token_version || 0)) {
      throw pairingError('bridge_pair_device_code_consumed')
    }

    const session = await createBridgeRefreshSession(pairing, {
      userAgent: String(userAgent || '').slice(0, 255),
      ip: String(ip || '').slice(0, 64),
      run,
    })
    const consumed = await run(`UPDATE bridge_device_pairings
      SET status = 'consumed', consumed_at = NOW(), updated_at = NOW()
      WHERE id = ? AND status = 'approved'`, [pairing.pairing_id])
    if (transactionChanges(consumed) !== 1) {
      throw pairingError('bridge_pair_device_code_consumed')
    }
    return {
      status: 'approved',
      refreshToken: session.refreshToken,
      refreshExpiresInSeconds: session.expiresInSeconds,
    }
  })
}
