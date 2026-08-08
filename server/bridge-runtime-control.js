import { queryOne, queryRun } from './db.js'

const waiters = new Map()

function normalizeState(row) {
  return {
    enabled:row?.connection_enabled == null || Number(row.connection_enabled) === 1,
    revision:Math.max(1, Number(row?.connection_control_revision || 1)),
    changed_at:row?.connection_control_changed_at || null,
  }
}

export async function readBridgeRuntimeControl(userId, { queryOneFn = queryOne } = {}) {
  const id = Number(userId)
  if (!Number.isSafeInteger(id) || id <= 0) throw Object.assign(new Error('bridge_runtime_user_invalid'), { code:'bridge_runtime_user_invalid' })
  const row = await queryOneFn(`SELECT connection_enabled, connection_control_revision,
    connection_control_changed_at FROM user_bridge_settings WHERE user_id = ? LIMIT 1`, [id])
  return normalizeState(row)
}

function publishBridgeRuntimeControl(userId, state) {
  const listeners = waiters.get(Number(userId))
  if (!listeners?.size) return 0
  waiters.delete(Number(userId))
  for (const resolve of listeners) resolve(state)
  return listeners.size
}

export async function writeBridgeRuntimeControl(userId, enabled, {
  queryRunFn = queryRun,
  queryOneFn = queryOne,
} = {}) {
  const id = Number(userId)
  if (!Number.isSafeInteger(id) || id <= 0 || typeof enabled !== 'boolean') {
    throw Object.assign(new Error('bridge_runtime_control_invalid'), { code:'bridge_runtime_control_invalid' })
  }
  await queryRunFn(`INSERT INTO user_bridge_settings
    (user_id, connection_enabled, connection_control_revision, connection_control_changed_at, updated_at)
    VALUES (?, ?, 1, NOW(3), NOW())
    ON DUPLICATE KEY UPDATE
      connection_control_revision = IF(connection_enabled = VALUES(connection_enabled),
        connection_control_revision, connection_control_revision + 1),
      connection_control_changed_at = IF(connection_enabled = VALUES(connection_enabled),
        connection_control_changed_at, NOW(3)),
      connection_enabled = VALUES(connection_enabled),
      updated_at = NOW()`, [id, enabled ? 1 : 0])
  const state = await readBridgeRuntimeControl(id, { queryOneFn })
  publishBridgeRuntimeControl(id, state)
  return state
}

export async function waitForBridgeRuntimeControl(userId, afterRevision, {
  timeoutMs = 25_000,
  queryOneFn = queryOne,
  signal = null,
} = {}) {
  const revision = Math.max(0, Number(afterRevision || 0))
  const current = await readBridgeRuntimeControl(userId, { queryOneFn })
  if (revision === 0 || current.revision !== revision || signal?.aborted) return current

  return new Promise(resolve => {
    const id = Number(userId)
    let settled = false
    const finish = state => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener?.('abort', onAbort)
      const listeners = waiters.get(id)
      listeners?.delete(finish)
      if (listeners && listeners.size === 0) waiters.delete(id)
      resolve(state)
    }
    const onAbort = () => finish(current)
    const timer = setTimeout(() => finish(current), Math.max(1_000, Math.min(Number(timeoutMs) || 25_000, 30_000)))
    timer.unref?.()
    if (!waiters.has(id)) waiters.set(id, new Set())
    waiters.get(id).add(finish)
    signal?.addEventListener?.('abort', onAbort, { once:true })
  })
}

export function resetBridgeRuntimeControlWaitersForTests() {
  for (const listeners of waiters.values()) {
    for (const resolve of listeners) resolve({ enabled:true, revision:1, changed_at:null })
  }
  waiters.clear()
}
