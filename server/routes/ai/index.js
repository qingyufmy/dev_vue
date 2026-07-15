// ai/index.js — 入口，re-export + Router

import { Router } from 'express'
import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import { queryAll } from '../../db.js'
import { authMiddleware } from '../../middleware/auth.js'
import { attachSignalTiming, configPublic, timeframeIntervalMs, STRATEGY_TIMEFRAME_COUNTS, parseTimeframeTags, stripTimeframeTags } from './utils.js'
import { mt5Bridge, calculateMarketData } from './market-data.js'
import { maybeAiSignal } from './llm.js'
import { getActiveConfig, getAnalyzeApiKey, getAutoConfig, getGlobalAutoConfig, saveGlobalAutoConfig, upsertAutoConfig, insertAudit, getAutoPromptTypes, getAutoPromptTypeById, saveAutoPromptType, disableAutoPromptType, getUserAutoConfig, saveUserAutoConfig, getUnifiedAutoInferenceConfig, getAutoSubscribers, getDeliveryExecuteRiskConfig } from './config.js'
import { handleAnalyze, buildStrategyContextFromTags } from './strategy.js'
import { initAutoSchedulers, startAutoScheduler, stopAutoScheduler, isAutoSchedulerRunning, reconcileAutoSchedulers, closeSchedulerState, startSmartCloseScheduler, stopSmartCloseScheduler, runSmartCloseCycle } from './scheduler.js'
import { getBridgeDiagnostics } from '../../bridge-ws.js'

const router = Router()

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const BRIDGE_VERSION = readFileSync(join(__dirname, '../../../VERSION'), 'utf-8').trim()

router.get('/bridge/version', (req, res) => {
  res.json({
    version: BRIDGE_VERSION,
    build_date: new Date().toISOString().slice(0, 10),
    changelog: `${BRIDGE_VERSION}: 安装包+配置目录+接口统一`,
    updater_url: `https://qiniu.acadfx.com/AURUM_Bridge/AURUM_Bridge_Setup_${BRIDGE_VERSION}.exe`,
    full_url: `https://qiniu.acadfx.com/AURUM_Bridge/AURUM_Bridge_Setup_${BRIDGE_VERSION}.exe`,
    file_size: 0,
    md5: ''
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

export { mt5Bridge } from './market-data.js'
export { isBridgeAlive, getAllBridges, getBridgeTradeMode } from '../../bridge-ws.js'

export { handleAnalyze } from './strategy.js'

export { maybeAiSignal } from './llm.js'

export { insertAudit, getActiveConfig, getAnalyzeApiKey,
  getAutoConfig, upsertAutoConfig, signalOrderPayload,
  getGlobalAutoConfig, saveGlobalAutoConfig,
  getExecuteRiskConfig, getAutoPromptTypes, getAutoPromptTypeById,
  saveAutoPromptType, disableAutoPromptType, getUserAutoConfig,
  saveUserAutoConfig, getUnifiedAutoInferenceConfig,
  getCloseConfig, saveCloseConfig, getCloseSignalTickets } from './config.js'

export { resolveAiTaskModel, logModelUsage, beginModelUsage, finishModelUsage, checkPlatformQuota,
  assertModelProfileSchemaReady,
  createModelProfile, getModelProfileById, getUserModelProfiles,
  updateModelProfile, deleteModelProfile, setDefaultModelProfile,
  getUserModelDefault, setUserModelDefault,
  getPlatformUsagePolicy, updatePlatformUsagePolicy,
  migrateLegacyConfigs } from './model-profiles.js'

export { startAutoScheduler, stopAutoScheduler, isAutoSchedulerRunning,
  reconcileAutoSchedulers, closeSchedulerState, startSmartCloseScheduler, stopSmartCloseScheduler,
  runSmartCloseCycle, syncUserRedisSubscription, removeUserRuntimeAutoSubscription,
  getUserAutoRuntimeStatus } from './scheduler.js'

export { listStrategies, getStrategyById, createStrategy, updateStrategy, deleteStrategy,
  listTradingAccounts, getTradingAccountById, createTradingAccount, updateTradingAccount, deleteTradingAccount,
  listSubscriptions, createSubscription, updateSubscription, deleteSubscription,
  adminListUserStrategies, adminListUserSubscriptions, getSubscriptionWithContext } from './strategy-ownership.js'

export { STRATEGY_TIMEFRAME_COUNTS, parseTimeframeTags, stripTimeframeTags,
  attachSignalTiming, configPublic, timeframeIntervalMs } from './utils.js'

export default router
