import { Router } from 'express'

import { useBridgeRefreshSession } from '../bridge-auth-session.js'
import { disconnectUserBridgeConnections, getBridgeRuntimeDiagnostics } from '../bridge-ws.js'
import { logAudit } from '../db.js'
import { authMiddleware } from '../middleware/auth.js'
import {
  readBridgeRuntimeControl,
  waitForBridgeRuntimeControl,
  writeBridgeRuntimeControl,
} from '../bridge-runtime-control.js'

const mutationTimes = new Map()
const MUTATION_COOLDOWN_MS = 750

function runtimeError(res, error) {
  const code = String(error?.code || 'bridge_runtime_control_unavailable')
  const status = code === 'bridge_runtime_control_invalid' || code === 'bridge_runtime_revision_invalid'
    ? 400
    : code === 'bridge_membership_required' ? 403
      : code === 'bridge_refresh_invalid' || code === 'bridge_refresh_revoked' ? 401 : 503
  return res.status(status).json({
    ok:false,
    code,
    error:status === 400
      ? '桥接控制请求参数无效。'
      : status === 401
        ? '桥接授权已失效，请重新连接账号。'
        : status === 403
          ? '当前账号不能使用桥接软件。'
          : '桥接控制服务暂时不可用，请稍后重试。',
  })
}

function browserPayload(control, diagnostics) {
  const connected = diagnostics.connected === true
  const state = !control.enabled ? 'paused'
    : connected ? 'connected'
      : diagnostics.last_seen_at_utc_msc ? 'reconnecting' : 'offline'
  return {
    ok:true,
    desired_state:control.enabled ? 'enabled' : 'paused',
    actual_state:state,
    revision:control.revision,
    changed_at:control.changed_at,
    ...diagnostics,
  }
}

export function createBridgeRuntimeControlRouter({
  authenticate = authMiddleware,
  useRefresh = useBridgeRefreshSession,
  readControl = readBridgeRuntimeControl,
  waitControl = waitForBridgeRuntimeControl,
  writeControl = writeBridgeRuntimeControl,
  diagnostics = getBridgeRuntimeDiagnostics,
  disconnect = disconnectUserBridgeConnections,
  audit = logAudit,
  now = () => Date.now(),
} = {}) {
  const router = Router()

  router.post('/auth/bridge-runtime-control/wait', async (req, res) => {
    try {
      const revision = Number(req.body?.afterRevision || 0)
      if (!Number.isSafeInteger(revision) || revision < 0) {
        throw Object.assign(new Error('bridge_runtime_revision_invalid'), { code:'bridge_runtime_revision_invalid' })
      }
      const session = await useRefresh(req.body?.refreshToken, {
        userAgent:req.get('user-agent'), ip:req.ip, touch:false,
      })
      const abort = new AbortController()
      res.once('close', () => { if (!res.writableEnded) abort.abort() })
      const control = await waitControl(Number(session.user.id), revision, { signal:abort.signal })
      if (res.headersSent || res.destroyed) return
      return res.json({
        ok:true,
        enabled:control.enabled,
        revision:control.revision,
        observedAtUtcMsc:now(),
      })
    } catch (error) {
      if (!res.headersSent && !res.destroyed) return runtimeError(res, error)
    }
  })

  router.get('/bridge/runtime-control', authenticate, async (req, res) => {
    try {
      const [control, current] = await Promise.all([
        readControl(Number(req.user.id)),
        Promise.resolve(diagnostics(Number(req.user.id))),
      ])
      return res.json(browserPayload(control, current))
    } catch (error) {
      return runtimeError(res, error)
    }
  })

  router.post('/bridge/runtime-control', authenticate, async (req, res) => {
    try {
      if (typeof req.body?.enabled !== 'boolean') {
        throw Object.assign(new Error('bridge_runtime_control_invalid'), { code:'bridge_runtime_control_invalid' })
      }
      const userId = Number(req.user.id)
      const previousMutation = Number(mutationTimes.get(userId) || 0)
      if (now() - previousMutation < MUTATION_COOLDOWN_MS) {
        return res.status(429).json({ ok:false, code:'bridge_runtime_control_rate_limited', error:'操作过于频繁，请稍后再试。' })
      }
      mutationTimes.set(userId, now())
      const control = await writeControl(userId, req.body.enabled)
      if (!control.enabled) disconnect(userId, 'bridge_runtime_paused')
      await Promise.resolve(audit({
        userId,
        action:control.enabled ? 'bridge_connection_resumed' : 'bridge_connection_paused',
        targetType:'bridge_runtime',
        targetId:userId,
        detail:JSON.stringify({ revision:control.revision }),
        ip:req.ip,
        userAgent:req.get('user-agent'),
      })).catch(error => {
        console.warn('[Bridge Runtime] audit failed after control state changed:', error?.message || error)
      })
      const current = diagnostics(userId)
      return res.json(browserPayload(control, current))
    } catch (error) {
      return runtimeError(res, error)
    }
  })

  return router
}

export default createBridgeRuntimeControlRouter()
