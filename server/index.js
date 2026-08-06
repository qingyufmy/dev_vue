import express from 'express'
import compression from 'compression'
import cors from 'cors'
import rateLimit from 'express-rate-limit'
import jwt from 'jsonwebtoken'
import http from 'http'
import { JWT_SECRET, PORT, JSON_BODY_LIMIT, PUBLIC_UPLOAD_DIR, AUTH_RATE_LIMIT_MAX, BRIDGE_AUTH_RATE_LIMIT_MAX, BRIDGE_PAIR_START_RATE_LIMIT_WINDOW_MS, BRIDGE_PAIR_START_RATE_LIMIT_MAX, WRITE_RATE_LIMIT_MAX, RATE_LIMIT_WINDOW_MS, CORS_ORIGINS, isCorsOriginAllowed } from './config.js'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { existsSync, mkdirSync } from 'fs'
import { initDB, getDB, queryOne, queryRun } from './db.js'
import { runMigrations } from './migrations.js'
import { isEncryptionAvailable } from './ai-credential.js'
import { assertModelProfileSchemaReady, migrateLegacyConfigs, recoverStaleModelUsageReservations } from './routes/ai/model-profiles.js'
import { migrateLegacySystemConfigSecrets } from './system-config-secrets.js'
import { assertAiGovernanceSchemaReady } from './routes/ai/rollout-governance.js'
import { BILIBILI_HEADERS } from './utils.js'
import authRoutes from './routes/auth.js'
import courseRoutes from './routes/courses.js'
import commentRoutes from './routes/comments.js'
import postRoutes from './routes/posts.js'
import userRoutes from './routes/user.js'
import adminRoutes from './routes/admin.js'
import adminConsoleRoutes from './routes/admin-console.js'
import adminPositionProtectionRoutes, { startAdminPositionProtectionWorker } from './routes/admin-position-protection.js'
import tradeRoutes from './routes/trades.js'
import paymentRoutes from './routes/payment.js'
import videoRoutes from './routes/video.js'
import configRoutes from './routes/config.js'
import aiRoutes from './routes/ai/index.js'
import feedbackRoutes from './routes/feedback.js'
import membershipNotificationRoutes from './routes/membership-notifications.js'
import sentimentRoutes from './routes/sentiment.js'
import bridgeReleaseRoutes from './routes/bridge-release.js'
import bridgeMaintenanceRoutes from './routes/bridge-maintenance.js'
import bridgeRuntimeControlRoutes from './routes/bridge-runtime-control.js'
import { fetchSentiment } from './services/sentiment.js'
import { cacheSetJSON, getRedis } from './redis.js'
import { initAutoSchedulers, startPeriodReviewWorker, startMemoryCompressionWorker, startManualAnalysisJobs,
  startHistoryCompareRecoveryWorker } from './routes/ai/index.js'
import { recoverAbandonedAutoInferenceTasks } from './routes/ai/model-task-runtime.js'
import { recoverAbandonedPeriodReviewModelTasks } from './routes/ai/period-review.js'
import { recoverAbandonedMemoryCompressionModelTasks } from './routes/ai/memory-system.js'
import { startOrderIntentReconciler, stopOrderIntentReconciler } from './routes/ai/order-intents.js'
import { stopAutoSchedulers, stopPendingReconciler } from './routes/ai/scheduler.js'
import { startPositionManagementWorker } from './routes/ai/position-management-worker.js'
import { tokenVersionMatches } from './middleware/auth.js'
import { initBridgeWS } from './bridge-ws.js'
import { startMonitor } from './crypto/monitor.js'
import { initCryptoWallet } from './crypto/wallet.js'
import { startHoldSignalCleanup } from './jobs/hold-signal-cleanup.js'
import { startWeeklySystemFlatten } from './jobs/weekly-system-flatten.js'
import { startMembershipExpiryNotificationWorker } from './membership-expiry-notifications.js'
import { startPaymentOrderCleanup } from './jobs/payment-order-cleanup.js'
import { startPaymentSideEffectWorker } from './jobs/payment-side-effects.js'
import { securityHeaders } from './security-headers.js'
import { blockPrivateVideoStatic } from './video-access.js'
import { installFatalProcessHandlers, listenHttpServer } from './runtime-lifecycle.js'
import { createBridgePairStartLimiter } from './bridge-pair-rate-limit.js'
import { pruneFinalizedCommands } from './bridge-v3/command-ledger.js'
import { createAutoInferenceRecoveryLogDeduper } from './ai-recovery-log.js'

const __dirname = dirname(fileURLToPath(import.meta.url))

// .env is loaded by server/config.js via dotenv — no manual parsing needed

// Ensure upload dir
if (!existsSync(PUBLIC_UPLOAD_DIR)) mkdirSync(PUBLIC_UPLOAD_DIR, { recursive: true })

const app = express()
app.set('trust proxy', 1) // 仅信任第一级反向代理（Nginx等），避免 IP 欺骗

// CORS: restrict to known origins
app.use(cors({
  origin(origin, cb) {
    if (!origin || isCorsOriginAllowed(origin, CORS_ORIGINS)) {
      cb(null, true)
    } else {
      console.error(`[CORS] Rejected origin: "${origin}" — allowed: [${CORS_ORIGINS.join(', ')}]`)
      cb(new Error('CORS not allowed'))
    }
  },
  credentials: true,
  maxAge: 86400
}))
app.use(express.json({ limit: JSON_BODY_LIMIT }))
app.use(express.urlencoded({ extended: true }))

// Security headers (embedding restrictions intentionally disabled).
app.use(securityHeaders)
// Compress text assets and JSON responses. Large AI frontend bundles otherwise
// consume unnecessary bandwidth on every cold load.
app.use(compression({ threshold: 1024 }))

// Application-side rate limiting is intentionally limited to abuse-sensitive
// operations. General dashboard traffic is protected at Nginx/WAF; applying a
// second per-IP quota here breaks polling and Bridge reconnects behind one NAT.
const authLimiter = rateLimit({
  windowMs: RATE_LIMIT_WINDOW_MS,
  max: AUTH_RATE_LIMIT_MAX,
  standardHeaders: true,
  legacyHeaders: false,
  message: { ok: false, code:'bridge_api_rate_limited', error: '操作过于频繁，请稍后再试' }
})
const bridgeAuthLimiter = rateLimit({
  windowMs: RATE_LIMIT_WINDOW_MS,
  max: BRIDGE_AUTH_RATE_LIMIT_MAX,
  standardHeaders: true,
  legacyHeaders: false,
  message: { ok: false, code:'bridge_api_rate_limited', error: '操作过于频繁，请稍后再试' }
})
const bridgePairStartLimiter = createBridgePairStartLimiter({
  windowMs: BRIDGE_PAIR_START_RATE_LIMIT_WINDOW_MS,
  max: BRIDGE_PAIR_START_RATE_LIMIT_MAX,
})
const writeLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: WRITE_RATE_LIMIT_MAX,
  standardHeaders: true,
  legacyHeaders: false,
  message: { ok: false, error: '发布过于频繁，请稍后再试' }
})
app.use('/api/login', authLimiter)
app.use('/api/auth/bridge-refresh', bridgeAuthLimiter)
app.use('/api/auth/bridge-pair/start', bridgePairStartLimiter)
app.use('/api/auth/bridge-pair/token', bridgeAuthLimiter)
app.use('/api/auth/bridge-pair/approve', authLimiter)
app.use('/api/auth/bridge-observer-session', bridgeAuthLimiter)
app.use('/api/register', authLimiter)
app.use('/api/send-code', authLimiter)
app.use('/api/verify-code', authLimiter)
app.use('/api/reset-password', authLimiter)
app.use('/api/send-bind-code', authLimiter)
app.use('/api/bind-phone', authLimiter)
app.use('/api/bind-email', authLimiter)
app.use('/api/feedback', writeLimiter)
app.use('/api/comments', writeLimiter)
app.use('/api/posts', writeLimiter)
app.use('/api/post-replies', writeLimiter)

// Serve uploaded files
app.use('/uploads/videos', blockPrivateVideoStatic)
app.use('/uploads', express.static(PUBLIC_UPLOAD_DIR, {
  setHeaders: (res) => {
    res.set('Cache-Control', 'public, max-age=604800')
    res.set('Content-Security-Policy', "default-src 'none'; sandbox")
    res.set('Cross-Origin-Resource-Policy', 'same-origin')
    res.set('X-Content-Type-Options', 'nosniff')
  }
}))

// Bilibili CDN image proxy — bypasses Referer anti-leech
import https from 'https'
app.get('/api/bilibili-proxy', (req, res) => {
  const imageUrl = req.query.url
  // 严格校验: 必须是 https 协议且 hostname 属于 hdslb.com（防 SSRF）
  try {
    const u = new URL(imageUrl)
    if (u.protocol !== 'https:' || (!u.hostname.endsWith('.hdslb.com') && u.hostname !== 'hdslb.com')) {
      return res.status(400).end()
    }
  } catch {
    return res.status(400).end()
  }
  // Try multiple CDN nodes: original → i0 → i1 → i2
  const nodes = [imageUrl]
  const m = imageUrl.match(/^https:\/\/(i\d)\.hdslb\.com\/(.+)$/)
  if (m) {
    for (const n of ['i0', 'i1', 'i2']) {
      if (n !== m[1]) nodes.push(`https://${n}.hdslb.com/${m[2]}`)
    }
  }
  let tried = 0
  let responded = false
  function tryNext() {
    if (responded || res.headersSent) return
    if (tried >= nodes.length) { responded = true; return res.status(502).end() }
    const url = nodes[tried++]
    const proxyReq = https.get(url, {
      headers: BILIBILI_HEADERS,
      timeout: 8000
    }, (proxyRes) => {
      if (proxyRes.statusCode !== 200) return tryNext()
      responded = true
      res.setHeader('Content-Type', proxyRes.headers['content-type'] || 'image/jpeg')
      res.setHeader('Cache-Control', 'public, max-age=86400')
      proxyRes.pipe(res)
    })
    proxyReq.on('error', () => tryNext())
    proxyReq.on('timeout', () => { proxyReq.destroy(); tryNext() })
  }
  tryNext()
})



// Serve frontend static files
const publicDir = join(__dirname, '..', 'public')
app.get('/legacy-admin', (req, res) => res.redirect(308, '/admin/'))
app.use(express.static(publicDir, {
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('.html')) {
      res.set('Cache-Control', 'no-cache')
    } else {
      res.set('Cache-Control', 'public, max-age=604800')
    }
  }
}))

// API routes — no-cache to prevent stale responses across user sessions
const noCache = (req, res, next) => { res.set('Cache-Control', 'no-store, no-cache, must-revalidate'); res.set('Pragma', 'no-cache'); next() }
app.get('/bridge/pair', noCache, (req, res) => {
  const code = String(req.query?.code || '').trim()
  res.redirect(308, `/ai/bridge/pair${code ? `?code=${encodeURIComponent(code)}` : ''}`)
})
app.get('/ai/bridge/pair', noCache, (req, res) => {
  res.sendFile(join(publicDir, 'ai', 'bridge-pair.html'))
})
app.use('/api', noCache, authRoutes)
app.use('/api', courseRoutes)
app.use('/api', commentRoutes)
app.use('/api', postRoutes)
app.use('/api', userRoutes)
app.use('/api', adminRoutes)
app.use('/api', adminConsoleRoutes)
app.use('/api', adminPositionProtectionRoutes)
app.use('/api', tradeRoutes)
app.use('/api', paymentRoutes)
app.use('/api', videoRoutes)
app.use('/api', configRoutes)
app.use('/api', aiRoutes)
app.use('/api', feedbackRoutes)
app.use('/api', membershipNotificationRoutes)
app.use('/api', sentimentRoutes)
app.use('/api', bridgeReleaseRoutes)
app.use('/api', bridgeMaintenanceRoutes)
app.use('/api', bridgeRuntimeControlRoutes)
app.use('/aurum-api', noCache, aiRoutes)




// Serve AURUM AI static files at /ai
// Serve AURUM AI static files — allow browser caching for assets, no-cache for HTML
app.use('/ai', express.static(join(__dirname, '..', 'public', 'ai'), {
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('.html')) {
      res.set('Cache-Control', 'no-cache')  // HTML: revalidate each time
    } else {
      res.set('Cache-Control', 'public, max-age=604800')  // JS/CSS/images: cache 7 days
    }
  }
}))

app.get('/ai', noCache, (req, res) => {
  res.sendFile(join(__dirname, '..', 'public', 'ai', 'index.html'))
})

// Presence heartbeat
app.post('/api/presence', async (req, res) => {
  try {
    const auth = req.headers.authorization
    if (auth && auth.startsWith('Bearer ')) {
      const token = auth.slice(7)
      const payload = jwt.verify(token, JWT_SECRET)
      if (payload && payload.userId) {
        const sessionUser = await queryOne('SELECT token_version FROM users WHERE id = ?', [payload.userId])
        if (sessionUser && tokenVersionMatches(payload, sessionUser)) {
          await queryRun("UPDATE users SET last_seen_at = NOW() WHERE id = ?", [payload.userId])
        }
      }
    }
  } catch (e) { console.warn('[Presence] Failed to update last_seen_at:', e.message) }
  res.json({ ok: true })
})

// Health check endpoint
app.get('/health', async (req, res) => {
  const health = { status: 'ok', timestamp: new Date().toISOString() }
  try {
    const { getDB } = await import('./db.js')
    const db = getDB()
    const conn = await db.getConnection()
    await conn.ping()
    conn.release()
    health.database = 'connected'
  } catch (e) {
    health.status = 'degraded'
    health.database = 'disconnected'
  }
  try {
    const { isRedisAvailable } = await import('./redis.js')
    health.redis = isRedisAvailable() ? 'connected' : 'unavailable'
  } catch {
    health.redis = 'unavailable'
  }
  const statusCode = health.status === 'ok' ? 200 : 503
  res.status(statusCode).json(health)
})

// Fallback: serve index.html for SPA routing
app.get('*', (req, res) => {
  res.sendFile(join(publicDir, 'index.html'))
})

// Start MT5 Bridge (use venv Python with MetaTrader5 package)
// Init DB and start
const server = http.createServer(app)
const autoInferenceRecoveryLogDeduper = createAutoInferenceRecoveryLogDeduper()
const shutdownTimers = new Set()
const SHUTDOWN_TIMEOUT_MS = 15_000
let shutdownPromise = null
let shutdownSignalHandled = false

function trackShutdownTimer(timer) {
  if (timer) shutdownTimers.add(timer)
  return timer
}

function clearShutdownTimers() {
  for (const timer of shutdownTimers) {
    clearTimeout(timer)
    clearInterval(timer)
  }
  shutdownTimers.clear()
}

async function waitForShutdownTask(promise, label, timeoutMs) {
  if (!promise || typeof promise.then !== 'function') return { label, settled:true }
  const timeout = Math.max(0, Number(timeoutMs) || SHUTDOWN_TIMEOUT_MS)
  const result = await Promise.race([
    Promise.resolve(promise).then(() => ({ label, settled:true }), error => ({ label, settled:true, error })),
    new Promise(resolve => setTimeout(() => resolve({ label, settled:false, timedOut:true }), timeout)),
  ])
  if (result.timedOut) console.error(`[Shutdown] ${label} did not settle within ${timeout}ms`)
  if (result.error) console.error(`[Shutdown] ${label} failed:`, result.error.message)
  return result
}

async function closeHttpServer(timeoutMs) {
  if (!server.listening) return { closed:false, reason:'not_listening' }
  const closePromise = new Promise(resolve => {
    server.close(error => resolve({ closed:!error, error }))
  })
  const result = await waitForShutdownTask(closePromise, 'HTTP server', timeoutMs)
  if (result.error && result.error.code !== 'ERR_SERVER_NOT_RUNNING') {
    console.error('[Shutdown] HTTP server close failed:', result.error.message)
  }
  return result
}

async function closeRedisAndDatabase() {
  const redis = getRedis()
  if (redis && typeof redis.quit === 'function') {
    try {
      await waitForShutdownTask(redis.quit(), 'Redis client', SHUTDOWN_TIMEOUT_MS)
      console.log('[Shutdown] Redis client closed')
    } catch (error) {
      console.error('[Shutdown] Redis close failed:', error.message)
    }
  } else {
    console.warn('[Shutdown] Redis client has no safe quit capability; leaving it untouched')
  }

  // mysql2's pool.end() is the existing pool-safe close operation.  Do not
  // destroy active sockets or issue a forced connection kill here.
  const db = getDB()
  if (db && typeof db.end === 'function') {
    try {
      await waitForShutdownTask(db.end(), 'MySQL pool', SHUTDOWN_TIMEOUT_MS)
      console.log('[Shutdown] MySQL pool closed')
    } catch (error) {
      console.error('[Shutdown] MySQL pool close failed:', error.message)
    }
  } else {
    console.warn('[Shutdown] MySQL pool has no safe end capability; leaving it untouched')
  }
}

export function gracefulShutdown({ signal = 'manual', timeoutMs = SHUTDOWN_TIMEOUT_MS } = {}) {
  if (shutdownPromise) return shutdownPromise
  shutdownPromise = (async () => {
    const timeout = Math.max(0, Number(timeoutMs) || SHUTDOWN_TIMEOUT_MS)
    console.log(`[Shutdown] ${signal}: stopping new scheduler rounds`)

    // First reject new scheduler/reconciler rounds and clear their timers.
    // Their returned Promises are retained so the next phase can wait on the
    // work already admitted before shutdown began.
    const autoStop = stopAutoSchedulers({ timeoutMs:timeout })
    const pendingStop = stopPendingReconciler()
    const orderIntentStop = stopOrderIntentReconciler()
    clearShutdownTimers()

    await Promise.all([
      waitForShutdownTask(autoStop, 'automatic schedulers', timeout),
      waitForShutdownTask(pendingStop, 'pending reconciler', timeout),
      waitForShutdownTask(orderIntentStop, 'order-intent reconciler', timeout),
    ])

    // Stop accepting HTTP work only after scheduler rounds have been fenced;
    // then close the network and the existing Redis/MySQL client resources.
    await closeHttpServer(timeout)
    await closeRedisAndDatabase()
    console.log('[Shutdown] graceful shutdown complete')
    return { ok:true, signal }
  })()
  return shutdownPromise
}

function installGracefulShutdownHandlers() {
  const handleSignal = signal => {
    if (shutdownSignalHandled) return
    shutdownSignalHandled = true
    void gracefulShutdown({ signal }).then(
      () => process.exit(0),
      error => {
        console.error('[Shutdown] graceful shutdown failed:', error?.stack || error)
        process.exit(1)
      }
    )
  }
  process.once('SIGTERM', () => handleSignal('SIGTERM'))
  process.once('SIGINT', () => handleSignal('SIGINT'))
}

// HTTP timeout settings — prevent reverse proxy / long-poll issues with WebSocket upgrade
server.keepAliveTimeout = 5000
server.headersTimeout = 15000
server.requestTimeout = 120000
initBridgeWS(server)
installFatalProcessHandlers()
installGracefulShutdownHandlers()

;(async () => {
  await initDB()
  await runMigrations()
  await assertAiGovernanceSchemaReady()
  if (isEncryptionAvailable()) {
    await assertModelProfileSchemaReady()
    await migrateLegacyConfigs()
    const systemCredentialMigration = await migrateLegacySystemConfigSecrets()
    if (systemCredentialMigration.migrated > 0) console.log(`[Config] Encrypted ${systemCredentialMigration.migrated} legacy system credentials`)
  } else {
    console.warn('[AI] Credential master key is unavailable; model calls and key updates are disabled')
  }
  const recoverModelUsageReservations = async () => {
    try {
      const recovered = await recoverStaleModelUsageReservations(30)
      if (recovered > 0) console.warn(`[AI] Recovered ${recovered} abandoned model usage reservations`)
    } catch (error) {
      console.error('[AI] Model usage reservation recovery failed:', error.message)
    }
  }
  await recoverModelUsageReservations()
  await listenHttpServer(server, PORT)
  console.log(`Wall Street Skill server running on http://localhost:${PORT}`)

  const pruneBridgeCommandHistory = async () => {
    try {
      let total = 0
      while (total < 10_000) {
        const { changes } = await pruneFinalizedCommands()
        total += changes
        if (changes < 500) break
      }
      if (total > 0) console.log(`[BridgeV3] Pruned ${total} finalized command ledger rows`)
    } catch (error) {
      console.error('[BridgeV3] Command ledger pruning failed:', error.message)
    }
  }
  await pruneBridgeCommandHistory()
  const bridgeCommandPruneTimer = trackShutdownTimer(setInterval(pruneBridgeCommandHistory, 24 * 60 * 60 * 1000))
  bridgeCommandPruneTimer.unref?.()

  await startHistoryCompareRecoveryWorker()
  const modelUsageRecoveryTimer = trackShutdownTimer(setInterval(recoverModelUsageReservations, 5 * 60 * 1000))
  modelUsageRecoveryTimer.unref?.()
  const recoverAutoInferenceTasks = async () => {
    try {
      const recovered = await recoverAbandonedAutoInferenceTasks()
      if (autoInferenceRecoveryLogDeduper.shouldLog(recovered)) {
        console.warn('[AI] Reconciled abandoned auto inference tasks:', recovered)
      }
    } catch (error) {
      console.error('[AI] Auto inference task recovery failed:', error.message)
    }
  }
  await recoverAutoInferenceTasks()
  const autoInferenceRecoveryTimer = trackShutdownTimer(setInterval(recoverAutoInferenceTasks, 30_000))
  autoInferenceRecoveryTimer.unref?.()
  const recoverBackgroundModelTasks = async () => {
    try {
      const [periodReview, memoryCompression] = await Promise.all([
        recoverAbandonedPeriodReviewModelTasks(), recoverAbandonedMemoryCompressionModelTasks(),
      ])
      if (periodReview.succeeded || periodReview.requeued || periodReview.statusUnknown || periodReview.stale
        || memoryCompression.succeeded || memoryCompression.requeued || memoryCompression.statusUnknown || memoryCompression.stale) {
        console.warn('[AI] Reconciled abandoned period/memory model tasks:', { periodReview, memoryCompression })
      }
    } catch (error) {
      console.error('[AI] Period/memory model task recovery failed:', error.message)
    }
  }
  await recoverBackgroundModelTasks()
  await initAutoSchedulers()
  startOrderIntentReconciler()
  startPositionManagementWorker()
  startAdminPositionProtectionWorker()
  startPeriodReviewWorker()
  startMemoryCompressionWorker()
  startManualAnalysisJobs()
  startHoldSignalCleanup().catch(err => console.error('[HoldSignalCleanup] Startup failed:', err.message))
  startWeeklySystemFlatten()
  startMembershipExpiryNotificationWorker()
  console.log(`[TZ] server=${Intl.DateTimeFormat().resolvedOptions().timeZone} db_session=+08:00 parse=explicit(+08:00)`)
  try {
    await initCryptoWallet()
    await startMonitor()
  } catch (err) {
    console.error('[CryptoMonitor] Failed to start:', err.message)
  }
  startPaymentOrderCleanup()
  startPaymentSideEffectWorker()
  // Sentiment data: non-blocking initial fetch + 30-min refresh
  fetchSentiment().then(data => {
    const hasValid = data.some(d => d.longPct !== null)
    if (hasValid) {
      cacheSetJSON('sentiment:data', { data, updatedAt: new Date().toISOString() }, 2100)
      console.log('[Sentiment] Initial data loaded')
    } else {
      console.log('[Sentiment] Initial fetch returned no valid data, keeping existing cache')
    }
  }).catch(e => console.error('[Sentiment] Initial fetch failed:', e.message))
  trackShutdownTimer(setInterval(async () => {
    try {
      const data = await fetchSentiment()
      const hasValid = data.some(d => d.longPct !== null)
      if (hasValid) {
        await cacheSetJSON('sentiment:data', { data, updatedAt: new Date().toISOString() }, 2100)
        console.log('[Sentiment] 30min refresh done')
      } else {
        console.log('[Sentiment] Refresh returned no valid data, keeping existing cache')
      }
    } catch (e) { console.error('[Sentiment] Refresh failed:', e.message) }
  }, 30 * 60 * 1000))
})().catch((error) => {
  console.error('[Startup] Fatal initialization error:', error?.stack || error)
  process.exit(1)
})
