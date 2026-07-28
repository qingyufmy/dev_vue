import { Router } from 'express'

import { authMiddleware } from '../middleware/auth.js'
import { listManagedObserverSources } from '../bridge-pairing.js'
import { bridgeUpdateAdmission } from '../bridge-v3/update-admission.js'
import {
  acquireBridgeMaintenanceLease,
  releaseBridgeMaintenanceLease,
  renewBridgeMaintenanceLease,
} from '../bridge-ws.js'

const DENIAL_MESSAGES = Object.freeze({
  bridge_maintenance_commands_in_flight:'仍有交易指令正在处理，系统将在完成后重试。',
  bridge_maintenance_lease_conflict:'该终端正在执行另一项维护操作，请稍后重试。',
  bridge_maintenance_scheduler_in_flight:'相关 AI 分析轮次仍在收尾，完成后将自动重试更新。',
  bridge_maintenance_delivery_in_flight:'该账户的交易建议正在完成交付，完成后将自动重试更新。',
  bridge_maintenance_weekly_task_active:'周末清仓或账户保护任务正在执行，完成后才能更新。',
})

function routeError(code, status = 400) {
  return Object.assign(new Error(code), { code, status })
}

function normalizeObserverIds(value) {
  if (value == null) return []
  if (!Array.isArray(value) || value.length > 32) {
    throw routeError('bridge_maintenance_observer_scope_invalid')
  }
  const ids = value.map(Number)
  if (ids.some(id => !Number.isSafeInteger(id) || id <= 0)
    || new Set(ids).size !== ids.length) {
    throw routeError('bridge_maintenance_observer_scope_invalid')
  }
  return ids
}

async function authorizedUserIds(actor, observerIds, listSources) {
  if (!observerIds.length) return [Number(actor.id)]
  if (String(actor.role || '').toLowerCase() !== 'admin') {
    throw routeError('bridge_maintenance_observer_scope_forbidden', 403)
  }
  const managed = new Set((await listSources(actor)).map(source => Number(source.bridge_user_id)))
  if (observerIds.some(id => !managed.has(id))) {
    throw routeError('bridge_maintenance_observer_scope_forbidden', 403)
  }
  return [Number(actor.id), ...observerIds]
}

function errorResponse(res, error) {
  const code = String(error?.code || 'bridge_maintenance_unavailable')
  const status = Number(error?.status)
    || (code.endsWith('_forbidden') ? 403
      : code.endsWith('_invalid') ? 400
        : code.endsWith('_not_found') ? 404 : 503)
  return res.status(status).json({
    ok:false,
    code,
    error:status === 403
      ? '无权维护请求中的观摩源或终端。'
      : status === 400
        ? '更新维护请求参数无效。'
        : status === 404
          ? '更新维护租约不存在或已经过期。'
          : '暂时无法建立更新维护通道，请稍后重试。',
  })
}

export function createBridgeMaintenanceRouter({
  authenticate = authMiddleware,
  listSources = listManagedObserverSources,
  acquireLease = acquireBridgeMaintenanceLease,
  renewLease = renewBridgeMaintenanceLease,
  releaseLease = releaseBridgeMaintenanceLease,
  admission = bridgeUpdateAdmission,
} = {}) {
  const router = Router()

  router.post('/bridge/v3/maintenance-leases', authenticate, async (req, res) => {
    try {
      const observerIds = normalizeObserverIds(req.body?.observer_bridge_user_ids)
      const allowedUsers = await authorizedUserIds(req.user, observerIds, listSources)
      const prepared = await admission.prepare({
        actor:req.user,
        authorizedUserIds:allowedUsers,
      })
      if (!prepared.allowed) {
        return res.json({
          ok:true,
          acquired:false,
          reason_code:prepared.code,
          reason:DENIAL_MESSAGES[prepared.code] || '当前尚不满足安全更新条件。',
          retry_after_seconds:prepared.retry_after_seconds || 5,
        })
      }

      let result
      try {
        result = await acquireLease({
          actorUserId:Number(req.user.id),
          authorizedUserIds:allowedUsers,
          installationId:req.body?.installation_id,
          targetVersion:req.body?.target_version,
          priority:req.body?.priority,
          manualRequest:req.body?.manual_request,
          terminalInstanceIds:req.body?.terminal_instance_ids,
          expectedDowntimeSeconds:req.body?.expected_downtime_seconds,
        })
      } catch (error) {
        admission.discardFence(prepared.fence_id)
        throw error
      }
      if (!result.acquired) {
        admission.discardFence(prepared.fence_id)
        return res.json({
          ok:true,
          acquired:false,
          reason_code:result.code,
          reason:DENIAL_MESSAGES[result.code] || '当前尚不满足安全更新条件。',
          retry_after_seconds:result.retry_after_seconds || 5,
        })
      }
      if (!admission.bindLease(result.lease_id, prepared.fence_id)) {
        await releaseLease(Number(req.user.id), result.lease_id)
        throw routeError('bridge_maintenance_admission_expired', 503)
      }
      return res.json({ ok:true, ...result })
    } catch (error) {
      return errorResponse(res, error)
    }
  })

  router.post('/bridge/v3/maintenance-leases/:leaseId/renew', authenticate, async (req, res) => {
    try {
      const result = await renewLease(Number(req.user.id), req.params.leaseId)
      if (!admission.renewLease(req.params.leaseId)) {
        await releaseLease(Number(req.user.id), req.params.leaseId)
        throw routeError('bridge_maintenance_admission_expired', 503)
      }
      return res.json({ ok:true, ...result })
    } catch (error) {
      return errorResponse(res, error)
    }
  })

  router.post('/bridge/v3/maintenance-leases/:leaseId/release', authenticate, async (req, res) => {
    try {
      const result = await releaseLease(Number(req.user.id), req.params.leaseId)
      admission.releaseLease(req.params.leaseId)
      return res.json({ ok:true, ...result })
    } catch (error) {
      return errorResponse(res, error)
    }
  })

  return router
}

export default createBridgeMaintenanceRouter()
