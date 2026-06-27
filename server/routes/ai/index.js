// ai/index.js — 入口，re-export + Router

import { Router } from 'express'
import { queryOne, queryRun } from '../../db.js'
import { authMiddleware } from '../../middleware/auth.js'
import { attachSignalTiming, configPublic, timeframeIntervalMs, STRATEGY_TIMEFRAME_COUNTS, parseTimeframeTags, stripTimeframeTags } from './utils.js'
import { mt5Bridge, calculateMarketData } from './market-data.js'
import { maybeAiSignal } from './llm.js'
import { getActiveConfig, getAnalyzeApiKey, getAutoConfig, getGlobalAutoConfig, saveGlobalAutoConfig, getAutoInferenceConfig, upsertAutoConfig, insertAudit } from './config.js'
import { handleAnalyze, buildStrategyContextFromTags } from './strategy.js'
import { initAutoSchedulers, startAutoScheduler, stopAutoScheduler, isAutoSchedulerRunning, closeSchedulerState, startSmartCloseScheduler, stopSmartCloseScheduler } from './scheduler.js'

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
    version: '2.1.0',
    build_date: '2026-06-27',
    changelog: 'v2.1.0: 自动执行风控检查 + bridge存活检查 + 休市检测优化',
    download_url: 'https://qiniu.acadfx.com/AURUM_Bridge_v2.1.0.exe',
    updater_url: 'https://qiniu.acadfx.com/AURUM_Bridge/aurum_updater.exe',
    file_size: 0,
    md5: ''
  })
})

export { initAutoSchedulers }

export { executeViaBridge, mt5Bridge } from './market-data.js'
export { isBridgeAlive, getBridgeStatus, getAllBridges, getBridgeTradeMode, getOwnBridgeTradeMode } from '../../bridge-ws.js'

export { handleAnalyze, buildStrategyContextFromTags } from './strategy.js'

export { maybeAiSignal } from './llm.js'

export { insertAudit, getActiveConfig, getAnalyzeApiKey,
  getAutoConfig, upsertAutoConfig, signalOrderPayload,
  getGlobalAutoConfig, saveGlobalAutoConfig, getAutoInferenceConfig,
  getExecuteRiskConfig } from './config.js'

export { startAutoScheduler, stopAutoScheduler, isAutoSchedulerRunning,
  runAutoCycle, closeSchedulerState, startSmartCloseScheduler, stopSmartCloseScheduler } from './scheduler.js'

export { STRATEGY_TIMEFRAME_COUNTS, parseTimeframeTags, stripTimeframeTags,
  attachSignalTiming, configPublic, timeframeIntervalMs } from './utils.js'

export default router
