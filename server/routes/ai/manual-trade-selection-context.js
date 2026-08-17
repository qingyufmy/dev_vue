import crypto from 'node:crypto'
import { JWT_SECRET } from '../../config.js'

export const MANUAL_TRADE_SELECTION_CONTEXT_CONTRACT = 'manual-trade-selection-v1'
export const MANUAL_TRADE_SELECTION_CONTEXT_TTL_MSC = 15 * 60 * 1000
const MANUAL_TRADE_SELECTION_CONTEXT_DOMAIN = `${MANUAL_TRADE_SELECTION_CONTEXT_CONTRACT}\0`
const MANUAL_TRADE_SELECTION_CONTEXT_MAX_BYTES = 4096

function text(value, max = 256) {
  return String(value == null ? '' : value).trim().slice(0, max)
}

function safeInteger(value, { min = 0 } = {}) {
  const number = Number(value)
  return Number.isSafeInteger(number) && number >= min ? number : null
}

function base64Url(value) {
  return Buffer.from(value).toString('base64url')
}

function decodeBase64Url(value) {
  return Buffer.from(String(value), 'base64url').toString('utf8')
}

function signingKey() {
  // Derive an independent key for this contract.  A normal login JWT signed
  // with JWT_SECRET must never be accepted as a selection context token.
  return crypto.createHmac('sha256', JWT_SECRET)
    .update(MANUAL_TRADE_SELECTION_CONTEXT_DOMAIN, 'utf8')
    .digest()
}

function signEncodedPayload(encoded) {
  return crypto.createHmac('sha256', signingKey()).update(encoded, 'ascii').digest('base64url')
}

function assertEqualSignature(provided, expected) {
  const left = Buffer.from(String(provided || ''), 'utf8')
  const right = Buffer.from(String(expected || ''), 'utf8')
  if (!left.length || left.length !== right.length || !crypto.timingSafeEqual(left, right)) {
    throw new Error('manual_trade_review_selection_context_invalid')
  }
}

function normalizePayload(input = {}) {
  const contract = text(input.contract, 64)
  const userId = safeInteger(input.user_id)
  const tradingAccountId = safeInteger(input.trading_account_id)
  const platform = text(input.platform, 24).toLowerCase()
  const rangeStart = safeInteger(input.range_start_utc_msc)
  const rangeEnd = safeInteger(input.range_end_utc_msc)
  const historySnapshotId = text(input.history_snapshot_id, 512)
  const issuedAt = safeInteger(input.issued_at_utc_msc)
  const expiresAt = safeInteger(input.expires_at_utc_msc)
  if (contract !== MANUAL_TRADE_SELECTION_CONTEXT_CONTRACT
    || !userId || !tradingAccountId || !platform || !historySnapshotId
    || rangeStart == null || rangeEnd == null || rangeEnd <= rangeStart
    || issuedAt == null || expiresAt == null || expiresAt <= issuedAt) {
    throw new Error('manual_trade_review_selection_context_invalid')
  }
  return {
    contract:MANUAL_TRADE_SELECTION_CONTEXT_CONTRACT,
    user_id:userId,
    trading_account_id:tradingAccountId,
    platform,
    range_start_utc_msc:rangeStart,
    range_end_utc_msc:rangeEnd,
    history_snapshot_id:historySnapshotId,
    issued_at_utc_msc:issuedAt,
    expires_at_utc_msc:expiresAt,
  }
}

function assertNow(payload, nowUtcMsc) {
  const now = safeInteger(nowUtcMsc)
  if (now == null) throw new Error('manual_trade_review_selection_context_invalid')
  if (now < payload.issued_at_utc_msc - 5 * 60 * 1000) {
    throw new Error('manual_trade_review_selection_context_invalid')
  }
  if (now >= payload.expires_at_utc_msc) {
    throw new Error('manual_trade_review_selection_context_expired')
  }
  return now
}

export function createManualTradeSelectionContext({ userId, tradingAccountId, platform,
  rangeStartUtcMsc, rangeEndUtcMsc, historySnapshotId, nowUtcMsc = Date.now(), ttlMsc = MANUAL_TRADE_SELECTION_CONTEXT_TTL_MSC } = {}) {
  const issuedAt = safeInteger(nowUtcMsc)
  const ttl = safeInteger(ttlMsc, { min:1 })
  if (issuedAt == null || ttl == null) throw new Error('manual_trade_review_selection_context_invalid')
  const payload = normalizePayload({ contract:MANUAL_TRADE_SELECTION_CONTEXT_CONTRACT,
    user_id:userId, trading_account_id:tradingAccountId, platform,
    range_start_utc_msc:rangeStartUtcMsc, range_end_utc_msc:rangeEndUtcMsc,
    history_snapshot_id:historySnapshotId, issued_at_utc_msc:issuedAt,
    expires_at_utc_msc:issuedAt + ttl })
  const encoded = base64Url(JSON.stringify(payload))
  const token = `${encoded}.${signEncodedPayload(encoded)}`
  if (Buffer.byteLength(token, 'utf8') > MANUAL_TRADE_SELECTION_CONTEXT_MAX_BYTES) {
    throw new Error('manual_trade_review_selection_context_invalid')
  }
  return token
}

export function verifyManualTradeSelectionContext(token, { userId, tradingAccountId, platform, nowUtcMsc = Date.now() } = {}) {
  if (typeof token !== 'string' || !token.trim()) throw new Error('manual_trade_review_selection_context_required')
  const parts = token.split('.')
  if (parts.length !== 2 || !parts[0] || !parts[1]
    || token.length > MANUAL_TRADE_SELECTION_CONTEXT_MAX_BYTES) {
    throw new Error('manual_trade_review_selection_context_invalid')
  }
  const [encoded, providedSignature] = parts
  let payload
  try { payload = normalizePayload(JSON.parse(decodeBase64Url(encoded))) }
  catch (error) {
    if (error?.message === 'manual_trade_review_selection_context_invalid') throw error
    throw new Error('manual_trade_review_selection_context_invalid')
  }
  assertEqualSignature(providedSignature, signEncodedPayload(encoded))
  assertNow(payload, nowUtcMsc)
  if (payload.user_id !== safeInteger(userId) || payload.trading_account_id !== safeInteger(tradingAccountId)
    || payload.platform !== text(platform, 24).toLowerCase()) {
    throw new Error('manual_trade_review_selection_context_mismatch')
  }
  return payload
}
