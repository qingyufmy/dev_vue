import express from 'express'
import cors from 'cors'
import rateLimit from 'express-rate-limit'
import multer from 'multer'
import jwt from 'jsonwebtoken'
import http from 'http'
import { JWT_SECRET } from './config.js'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { existsSync, mkdirSync, readFileSync } from 'fs'
import { initDB, queryRun } from './db.js'
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
import aiRoutes from './routes/ai.js'
import feedbackRoutes from './routes/feedback.js'
import { initAutoSchedulers } from './routes/ai.js'
import { authMiddleware } from './middleware/auth.js'
import { initBridgeWS } from './bridge-ws.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const PORT = process.env.PORT || 3000

// Load .env
try {
  const envPath = join(__dirname, '.env')
  if (existsSync(envPath)) {
    readFileSync(envPath, 'utf-8').split('\n').forEach(line => {
      const [key, ...val] = line.split('=')
      if (key && val.length) process.env[key.trim()] = val.join('=').trim()
    })
  } else {
    console.warn('[ENV] .env not found at:', envPath)
  }
} catch (e) { console.error('[ENV] Error:', e.message) }

// Ensure upload dir
const uploadDir = process.env.UPLOAD_DIR || './uploads'
if (!existsSync(uploadDir)) mkdirSync(uploadDir, { recursive: true })

const upload = multer({ dest: join(__dirname, uploadDir), limits: { fileSize: 10 * 1024 * 1024 } })

const app = express()
app.set('trust proxy', 1) // 仅信任第一级反向代理（Nginx等），避免 IP 欺骗

// CORS: restrict to known origins
const ALLOWED_ORIGINS = (process.env.CORS_ORIGINS || 'http://localhost:3000,http://localhost:8080,https://www.cnfxtrade.com,https://cnfxtrade.com').split(',').map(s => s.trim())
app.use(cors({
  origin(origin, cb) {
    if (!origin || ALLOWED_ORIGINS.includes(origin) || ALLOWED_ORIGINS.includes('*')) {
      cb(null, true)
    } else {
      cb(new Error('CORS not allowed'))
    }
  },
  credentials: true,
  maxAge: 86400
}))
app.use(express.json({ limit: '10mb' }))
app.use(express.urlencoded({ extended: true }))

// Rate limiting — prevent brute force and DoS
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 200, // per IP
  standardHeaders: true,
  legacyHeaders: false,
  message: { ok: false, error: '请求过于频繁，请稍后再试' }
})
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20, // stricter for login/register
  standardHeaders: true,
  legacyHeaders: false,
  message: { ok: false, error: '操作过于频繁，请稍后再试' }
})
app.use('/api', apiLimiter)
app.use('/api/login', authLimiter)
app.use('/api/register', authLimiter)
app.use('/api/send-code', authLimiter)
app.use('/api/verify-code', authLimiter)
app.use('/api/reset-password', authLimiter)

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
  function tryNext() {
    if (tried >= nodes.length) return res.status(502).end()
    const url = nodes[tried++]
    const proxyReq = https.get(url, {
      headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://www.bilibili.com/' },
      timeout: 8000
    }, (proxyRes) => {
      if (proxyRes.statusCode !== 200) return tryNext()
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
  const serverUrl = `${req.protocol}://${req.get('host')}`
  res.json({ server_url: serverUrl, token: '' })
})

// Bridge script download with embedded auth token
app.get('/ai/bridge/:platform', async (req, res) => {
  const platform = req.params.platform
  const token = req.query.token || ''
  const serverUrl = `${req.protocol}://${req.get('host')}`

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
  } catch {}
  res.json({ ok: true })
})

// Fallback: serve index.html for SPA routing
app.get('*', (req, res) => {
  res.sendFile(join(publicDir, 'index.html'))
})

// Start MT5 Bridge (use venv Python with MetaTrader5 package)
// Init DB and start
initAutoSchedulers()
const server = http.createServer(app)
initBridgeWS(server)

;(async () => {
  await initDB()
  server.listen(PORT, () => {
    console.log(`Wall Street Skill server running on http://localhost:${PORT}`)
  })
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
