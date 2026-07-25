import crypto from 'crypto'
import { queryRun, withTransaction } from './db.js'
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
        verificationPath: '/bridge/pair',
        expiresInSeconds: PAIRING_TTL_MINUTES * 60,
        intervalSeconds: PAIRING_POLL_INTERVAL_SECONDS,
      }
    } catch (error) {
      if (error?.code !== 'ER_DUP_ENTRY' || attempt === 2) throw error
    }
  }
  throw pairingError('bridge_pair_start_failed')
}

export async function approveBridgePairing(user, userCode, { ip = '', run = queryRun } = {}) {
  assertBridgeEligible(user)
  const normalized = normalizeUserCode(userCode)
  if (normalized.length !== 8) throw pairingError('bridge_pair_code_invalid')
  const result = await run(`UPDATE bridge_device_pairings
    SET status = 'approved', user_id = ?, approved_token_version = ?,
      approved_at = NOW(), approved_ip = ?, updated_at = NOW()
    WHERE user_code_hash = ? AND status = 'pending' AND expires_at > NOW()`, [
    user.id, Number(user.token_version || 0), String(ip || '').slice(0, 64), hashToken(normalized),
  ])
  if (transactionChanges(result) !== 1) throw pairingError('bridge_pair_code_invalid')
  return { approved: true }
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
