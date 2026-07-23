import express from 'express'
import compression from 'compression'
import cors from 'cors'
import rateLimit from 'express-rate-limit'
import multer from 'multer'
import jwt from 'jsonwebtoken'
import http from 'http'
import { JWT_SECRET, PORT, MAX_UPLOAD_SIZE, JSON_BODY_LIMIT, API_RATE_LIMIT_MAX, AUTH_RATE_LIMIT_MAX, WRITE_RATE_LIMIT_MAX, RATE_LIMIT_WINDOW_MS } from './config.js'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { existsSync, mkdirSync, readFileSync } from 'fs'
import { initDB, queryRun } from './db.js'
import { runMigrations } from './migrations.js'
import { isEncryptionAvailable } from './ai-credential.js'
import { assertModelProfileSchemaReady, migrateLegacyConfigs, recoverStaleModelUsageReservations } from './routes/ai/model-profiles.js'
import { assertAiGovernanceSchemaReady } from './routes/ai/rollout-governance.js'
import { BILIBILI_HEADERS } from './utils.js'
import authRoutes from './routes/auth.js'
import courseRoutes from './routes/courses.js'
import commentRoutes from './routes/comments.js'
import postRoutes from './routes/posts.js'
import userRoutes from './routes/user.js'
import adminRoutes from './routes/admin.js'
import tradeRoutes from './routes/trades.js'
import paymentRoutes from './routes/payment.js'
import videoRoutes from './routes/video.js'
import configRoutes from './routes/config.js'
import aiRoutes from './routes/ai/index.js'
import feedbackRoutes from './routes/feedback.js'
import membershipNotificationRoutes from './routes/membership-notifications.js'
import sentimentRoutes from './routes/sentiment.js'
import { fetchSentiment } from './services/sentiment.js'
import { cacheSetJSON } from './redis.js'
import { initAutoSchedulers, startPeriodReviewWorker } from './routes/ai/index.js'
import { startOrderIntentReconciler } from './routes/ai/order-intents.js'
import { authMiddleware } from './middleware/auth.js'
import { hasActiveMembership } from './membership.js'
import { initBridgeWS } from './bridge-ws.js'
import { startMonitor } from './crypto/monitor.js'
import { initCryptoWallet } from './crypto/wallet.js'
import { startHoldSignalCleanup } from './jobs/hold-signal-cleanup.js'
import { startWeeklySystemFlatten } from './jobs/weekly-system-flatten.js'
import { startMembershipExpiryNotificationWorker } from './membership-expiry-notifications.js'
import { securityHeaders } from './security-headers.js'

const __dirname = dirname(fileURLToPath(import.meta.url))

// .env is loaded by server/config.js via dotenv — no manual parsing needed

// Ensure upload dir
const uploadDir = process.env.UPLOAD_DIR || './uploads'
if (!existsSync(uploadDir)) mkdirSync(uploadDir, { recursive: true })

const upload = multer({ dest: join(__dirname, uploadDir), limits: { fileSize: MAX_UPLOAD_SIZE } })

const app = express()
app.set('trust proxy', 1) // 仅信任第一级反向代理（Nginx等），避免 IP 欺骗

// CORS: restrict to known origins
const ALLOWED_ORIGINS = (process.env.CORS_ORIGINS || 'http://localhost:3000,http://localhost:3001,http://localhost:3005,http://localhost:8080,http://192.168.1.254,https://www.cnfxtrade.com,https://cnfxtrade.com,http://www.cnfxtrade.com,http://cnfxtrade.com').split(',').map(s => s.trim())
app.use(cors({
  origin(origin, cb) {
    if (!origin || ALLOWED_ORIGINS.includes(origin) || ALLOWED_ORIGINS.includes('*')) {
      cb(null, true)
    } else {
      console.error(`[CORS] Rejected origin: "${origin}" — allowed: [${ALLOWED_ORIGINS.join(', ')}]`)
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

// Rate limiting — prevent brute force and DoS
const AUTH_RATE_LIMIT_PATHS = new Set([
  '/api/login',
  '/api/register',
  '/api/send-code',
  '/api/verify-code',
  '/api/reset-password',
  '/api/send-bind-code',
  '/api/bind-phone',
  '/api/bind-email'
])

const apiLimiter = rateLimit({
  windowMs: RATE_LIMIT_WINDOW_MS,
  max: API_RATE_LIMIT_MAX,
  standardHeaders: true,
  legacyHeaders: false,
  // Authentication has its own stricter limiter below. If it also consumes
  // the general API quota, background requests from the trading dashboard can
  // make login and account recovery unavailable for the rest of the window.
  skip: req => AUTH_RATE_LIMIT_PATHS.has(req.originalUrl.split('?')[0]),
  message: { ok: false, error: '请求过于频繁，请稍后再试' }
})
const authLimiter = rateLimit({
  windowMs: RATE_LIMIT_WINDOW_MS,
  max: AUTH_RATE_LIMIT_MAX,
  standardHeaders: true,
  legacyHeaders: false,
  message: { ok: false, error: '操作过于频繁，请稍后再试' }
})
const writeLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: WRITE_RATE_LIMIT_MAX,
  standardHeaders: true,
  legacyHeaders: false,
  message: { ok: false, error: '发布过于频繁，请稍后再试' }
})
app.use('/api', apiLimiter)
app.use('/aurum-api', apiLimiter)
app.use('/api/login', authLimiter)
app.use('/api/auth/bridge-refresh', authLimiter)
app.use('/api/auth/bridge-session', authLimiter)
app.use('/api/auth/bridge-revoke', authLimiter)
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
app.use('/uploads', express.static(join(__dirname, uploadDir), {
  setHeaders: (res) => { res.set('Cache-Control', 'public, max-age=604800') }
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
app.use('/api', noCache, authRoutes)
app.use('/api', courseRoutes)
app.use('/api', commentRoutes)
app.use('/api', postRoutes)
app.use('/api', userRoutes)
app.use('/api', adminRoutes)
app.use('/api', tradeRoutes)
app.use('/api', paymentRoutes)
app.use('/api', videoRoutes)
app.use('/api', configRoutes)
app.use('/api', aiRoutes)
app.use('/api', feedbackRoutes)
app.use('/api', membershipNotificationRoutes)
app.use('/api', sentimentRoutes)
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

// Bridge config download (for EXE update-token feature)
app.get('/ai/bridge/config', (req, res) => {
  const _proto = req.get('x-forwarded-proto') || req.protocol
  const _port = req.get('host')?.split(':')?.[1] || ''
  const _needsPort = _port && !['80', '443'].includes(_port)
  const serverUrl = _needsPort ? `${_proto}://${req.hostname}:${_port}` : `${_proto}://${req.hostname}`
  res.json({ server_url: serverUrl, token: '' })
})

// Bridge script download with embedded auth token
app.get('/ai/bridge/:platform', authMiddleware, async (req, res) => {
  // Only Pro and admin users can download bridge software
  if (!hasActiveMembership(req.user, 'pro')) {
    return res.status(403).json({ ok: false, error: '仅 Pro 会员可下载桥接软件' })
  }
  const platform = req.params.platform
  const token = req.query.token || ''
  const _proto = req.get('x-forwarded-proto') || req.protocol
  const _port = req.get('host')?.split(':')?.[1] || ''
  const _needsPort = _port && !['80', '443'].includes(_port)
  const serverUrl = _needsPort ? `${_proto}://${req.hostname}:${_port}` : `${_proto}://${req.hostname}`

  if (platform === 'setup') {
    // One-click setup: downloads exe + writes config + launches
    const configData = JSON.stringify({ server_url: serverUrl, token })
    const lines = [
      '@echo off',
      'chcp 65001 >nul 2>&1',
      'echo ================================',
      'echo   AURUM MT5 Bridge Setup',
      'echo ================================',
      'echo.',
      '',
      'REM --- Find Python ---',
      'set PYTHON=',
      'where python >nul 2>&1 && set PYTHON=python',
      'if "%PYTHON%"=="" (',
      '  where python3 >nul 2>&1 && set PYTHON=python3',
      ')',
      'if "%PYTHON%"=="" (',
      '  for %%P in (3.13 3.12 3.11 3.10) do (',
      '    if exist "C:\\Python%%P\\python.exe" set PYTHON=C:\\Python%%P\\python.exe',
      '    if exist "%LOCALAPPDATA%\\Programs\\Python\\Python%%P\\python.exe" set PYTHON=%LOCALAPPDATA%\\Programs\\Python\\Python%%P\\python.exe',
      '  )',
      ')',
      'if "%PYTHON%"=="" (',
      '  echo ERROR: Python not found! Install Python 3.10+ first.',
      '  pause',
      '  exit /b 1',
      ')',
      'echo Using Python: %PYTHON%',
      'echo.',
      '',
      'REM --- Install dependencies ---',
      'echo Installing dependencies...',
      '%PYTHON% -m pip install MetaTrader5 requests websocket-client -q',
      'echo.',
      '',
      'REM --- Download EXE ---',
      'echo Downloading AURUM_Bridge.exe...',
      'curl -sL -o "%~dp0AURUM_Bridge.exe" "' + serverUrl + '/ai/bridge/exe-file?token=' + encodeURIComponent(token) + '"',
      'if not exist "%~dp0AURUM_Bridge.exe" (',
      '  echo Download failed! Check network.',
      '  pause',
      '  exit /b 1',
      ')',
      'echo.',
      '',
      'REM --- Write config ---',
      'echo Writing config...',
      'echo ' + Buffer.from(configData).toString('base64') + ' > "%~dp0config.json.b64"',
      'certutil -decode "%~dp0config.json.b64" "%~dp0config.json" >nul',
      'del "%~dp0config.json.b64"',
      '',
      'REM --- Launch ---',
      'echo Starting AURUM Bridge...',
      'start "" "%~dp0AURUM_Bridge.exe"',
    ]
    res.setHeader('Content-Disposition', 'attachment; filename="AURUM_Bridge_Setup.bat"')
    res.setHeader('Content-Type', 'application/octet-stream')
    res.send(lines.join('\r\n'))
  } else if (platform === 'exe' || platform === 'exe-file') {
    // Serve the EXE directly
    const exePath = join(__dirname, '..', 'public', 'ai', 'AURUM_Bridge.exe')
    if (!existsSync(exePath)) {
      return res.status(404).json({ status: 'error', message: 'EXE not found' })
    }
    res.setHeader('Content-Disposition', 'attachment; filename="AURUM_Bridge.exe"')
    res.setHeader('Content-Type', 'application/octet-stream')
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate')
    res.sendFile(exePath)
  } else if (platform === 'mac') {
    let script = readFileSync(join(__dirname, '..', 'public', 'ai', 'AURUM_Bridge_Mac.command'), 'utf-8')
    script = script.replaceAll('{{TOKEN}}', token).replaceAll('{{SERVER_URL}}', serverUrl)
    res.setHeader('Content-Disposition', 'attachment; filename="AURUM_Bridge_Mac.command"')
    res.setHeader('Content-Type', 'application/octet-stream')
    res.send(script)
  } else {
    res.status(400).json({ status: 'error', message: '平台不支持，请使用 win 或 mac' })
  }
})

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
        await queryRun("UPDATE users SET last_seen_at = NOW() WHERE id = ?", [payload.userId])
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
// HTTP timeout settings — prevent reverse proxy / long-poll issues with WebSocket upgrade
server.keepAliveTimeout = 65000
server.headersTimeout = 66000
server.requestTimeout = 0 // No timeout for HTTP requests (WebSocket upgrade needs time)
initBridgeWS(server)

;(async () => {
  await initDB()
  await runMigrations()
  await assertAiGovernanceSchemaReady()
  if (isEncryptionAvailable()) {
    await assertModelProfileSchemaReady()
    await migrateLegacyConfigs()
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
  const modelUsageRecoveryTimer = setInterval(recoverModelUsageReservations, 5 * 60 * 1000)
  modelUsageRecoveryTimer.unref?.()
  await initAutoSchedulers()
  startOrderIntentReconciler()
  startPeriodReviewWorker()
  startHoldSignalCleanup().catch(err => console.error('[HoldSignalCleanup] Startup failed:', err.message))
  startWeeklySystemFlatten()
  startMembershipExpiryNotificationWorker()
  console.log(`[TZ] server=${Intl.DateTimeFormat().resolvedOptions().timeZone} db_session=+08:00 parse=explicit(+08:00)`)
  server.listen(PORT, () => {
    console.log(`Wall Street Skill server running on http://localhost:${PORT}`)
  })
  try {
    await initCryptoWallet()
    await startMonitor()
  } catch (err) {
    console.error('[CryptoMonitor] Failed to start:', err.message)
  }
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
  setInterval(async () => {
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
  }, 30 * 60 * 1000)
})()

// Crash protection — log and restart gracefully
process.on('uncaughtException', (err) => {
  console.error('[FATAL] Uncaught exception:', err.message)
  if (err.code !== 'ECONNRESET' && err.code !== 'EPIPE') {
    console.error(err.stack)
  }
})
process.on('unhandledRejection', (reason) => {
  console.error('[FATAL] Unhandled rejection:', reason?.message || reason)
})
