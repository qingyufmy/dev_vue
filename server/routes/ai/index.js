// ai/index.js — 入口，re-export + Router

import { Router } from 'express'
import { queryOne, queryRun, queryAll } from '../../db.js'
import { authMiddleware } from '../../middleware/auth.js'
import { attachSignalTiming, configPublic, timeframeIntervalMs, STRATEGY_TIMEFRAME_COUNTS, parseTimeframeTags, stripTimeframeTags } from './utils.js'
import { mt5Bridge, calculateMarketData } from './market-data.js'
import { maybeAiSignal } from './llm.js'
import { getActiveConfig, getAnalyzeApiKey, getAutoConfig, getGlobalAutoConfig, saveGlobalAutoConfig, getAutoInferenceConfig, upsertAutoConfig, insertAudit, getAutoPromptTypes, getAutoPromptTypeById, saveAutoPromptType, disableAutoPromptType, getUserAutoConfig, saveUserAutoConfig, getUnifiedAutoInferenceConfig, getAutoSubscribers, getDeliveryExecuteRiskConfig } from './config.js'
import { handleAnalyze, buildStrategyContextFromTags } from './strategy.js'
import { initAutoSchedulers, startAutoScheduler, stopAutoScheduler, isAutoSchedulerRunning, reconcileAutoSchedulers, closeSchedulerState, startSmartCloseScheduler, stopSmartCloseScheduler, runSmartCloseCycle } from './scheduler.js'
import { getBridgeDiagnostics } from '../../bridge-ws.js'

const router = Router()

router.get('/auth/me', authMiddleware, async (req, res) => {
  const user = await queryOne('SELECT id, email, nickname, role, plan, plan_expires_at FROM users WHERE id = ?', [req.user.id])
  if (!user) return res.status(404).json({ ok: false, error: 'User not found' })
  const now = new Date()
  const expiresAt = user.plan_expires_at ? new Date(user.plan_expires_at) : null
  let plan = user.plan
  if (expiresAt && expiresAt <= now && plan !== 'free') {
    plan = 'free'
    await queryRun('UPDATE users SET plan = ? WHERE id = ?', ['free', user.id])
  }
  res.json({ id: user.id, username: user.email, nickname: user.nickname, role: user.role, plan, plan_expires_at: user.plan_expires_at || '', is_active: 1, source: 'wss' })
})

router.get('/bridge/version', (req, res) => {
  res.json({
    version: '2.2.0',
    build_date: '2026-07-04',
    changelog: 'v2.2.0: Nuitka打包+项目清理+晴雨表修复+死代码移除',
    download_url: 'https://qiniu.acadfx.com/AURUM_Bridge_v2.2.0.exe',
    updater_url: 'https://qiniu.acadfx.com/AURUM_Bridge/aurum_updater.exe',
    file_size: 61798912,
    md5: '7439df1d786a93c57869999f5c0a78e6'
  })
})

router.get('/bridge/ws-health', authMiddleware, async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' })
  let recentStatus = []
  try {
    recentStatus = await queryAll(
      'SELECT user_id AS userId, connected, connected_at AS connectedAt, disconnected_at AS disconnectedAt, last_close_code AS lastCloseCode, last_close_reason AS lastCloseReason, last_error AS lastError, client_version AS clientVersion, mt5_collect_timeout_count AS mt5CollectTimeoutCount, updated_at AS updatedAt FROM bridge_connection_status ORDER BY updated_at DESC LIMIT 50'
    )
  } catch (e) {
    console.error('[BridgeWS] ws-health recentStatus query failed:', e.message)
  }
  res.json({
    ok: true,
    serverTime: new Date().toISOString(),
    bridges: getBridgeDiagnostics(),
    recentStatus,
  })
})

export { initAutoSchedulers }

export { executeViaBridge, mt5Bridge } from './market-data.js'
export { isBridgeAlive, getAllBridges, getBridgeTradeMode } from '../../bridge-ws.js'

export { handleAnalyze, buildStrategyContextFromTags } from './strategy.js'

export { maybeAiSignal } from './llm.js'

export { insertAudit, getActiveConfig, getAnalyzeApiKey,
  getAutoConfig, upsertAutoConfig, signalOrderPayload,
  getGlobalAutoConfig, saveGlobalAutoConfig, getAutoInferenceConfig,
  getExecuteRiskConfig, getAutoPromptTypes, getAutoPromptTypeById,
  saveAutoPromptType, disableAutoPromptType, getUserAutoConfig,
  saveUserAutoConfig, getUnifiedAutoInferenceConfig, getAutoSubscribers,
  getDeliveryExecuteRiskConfig, getCloseConfig, saveCloseConfig, getCloseSignalTickets } from './config.js'

export { startAutoScheduler, stopAutoScheduler, isAutoSchedulerRunning,
  reconcileAutoSchedulers, closeSchedulerState, startSmartCloseScheduler, stopSmartCloseScheduler,
  runSmartCloseCycle, syncUserRedisSubscription, rebuildRedisSubscriptions, removeUserRuntimeAutoSubscription,
  getUserAutoRuntimeStatus } from './scheduler.js'

export { STRATEGY_TIMEFRAME_COUNTS, parseTimeframeTags, stripTimeframeTags,
  attachSignalTiming, configPublic, timeframeIntervalMs } from './utils.js'

export default router
