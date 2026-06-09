import express from 'express'
import cors from 'cors'
import multer from 'multer'
import jwt from 'jsonwebtoken'
import http from 'http'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { existsSync, mkdirSync, readFileSync } from 'fs'
import { spawn } from 'child_process'
import { initDB, getDB } from './db.js'
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
import { initAutoSchedulers } from './routes/ai.js'
import { authMiddleware } from './middleware/auth.js'

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
  }
} catch {}

// Ensure upload dir
const uploadDir = process.env.UPLOAD_DIR || './uploads'
if (!existsSync(uploadDir)) mkdirSync(uploadDir, { recursive: true })

const upload = multer({ dest: join(__dirname, uploadDir), limits: { fileSize: 10 * 1024 * 1024 } })

const app = express()

// Debug: log all requests
app.use((req, res, next) => {
  if (req.method !== 'GET') console.log(`[${new Date().toISOString()}] ${req.method} ${req.url} content-type=${req.headers['content-type']}`)
  next()
})

app.use(cors())
app.use(express.json({ limit: '10mb' }))
app.use(express.urlencoded({ extended: true }))

// Serve uploaded files
app.use('/uploads', express.static(join(__dirname, uploadDir)))

// Serve frontend static files
const publicDir = join(__dirname, '..', 'public')
app.use(express.static(publicDir))

// API routes
app.use('/api', authRoutes)
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
app.use('/aurum-api', aiRoutes)

// Root-level health check (frontend calls /health directly)
app.get('/health', async (req, res) => {
  try {
    const http = await import('http')
    const result = await new Promise((resolve) => {
      const options = {
        hostname: '127.0.0.1',
        port: 8766,
        path: '/status',
        method: 'GET',
        headers: { 'Content-Type': 'application/json' },
        timeout: 5000
      }
      const request = http.default.request(options, (response) => {
        let data = ''
        response.on('data', chunk => data += chunk)
        response.on('end', () => {
          try { resolve(JSON.parse(data)) } catch { resolve({ mode: 'mock', mt5_package_available: false }) }
        })
      })
      request.on('error', () => resolve({ mode: 'mock', mt5_package_available: false }))
      request.on('timeout', () => { request.destroy(); resolve({ mode: 'mock', mt5_package_available: false }) })
      request.end()
    })
    res.json({ status: 'healthy', service: 'AURUM AI', gateway: result })
  } catch {
    res.json({ status: 'healthy', service: 'AURUM AI', gateway: { mode: 'mock', mt5_package_available: false } })
  }
})



// Serve AURUM AI static files at /ai
app.use('/ai', express.static(join(__dirname, '..', 'public', 'ai')))

// Bridge script download with embedded auth token
app.get('/ai/bridge/:platform', (req, res) => {
  const platform = req.params.platform
  const token = req.query.token || ''
  const serverUrl = `${req.protocol}://${req.get('host')}`

  if (platform === 'win') {
    let vbs = readFileSync(join(__dirname, '..', 'public', 'ai', 'AURUM_Bridge_Win.vbs'), 'utf-8')
    vbs = vbs.replaceAll('{{TOKEN}}', token).replaceAll('{{SERVER_URL}}', serverUrl)
    res.setHeader('Content-Disposition', 'attachment; filename="AURUM_Bridge_Win.vbs"')
    res.setHeader('Content-Type', 'application/octet-stream')
    res.send(vbs)
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
app.get('/ai', (req, res) => {
  res.sendFile(join(__dirname, '..', 'public', 'ai', 'index.html'))
})

// Presence heartbeat
app.post('/api/presence', (req, res) => {
  try {
    const auth = req.headers.authorization
    if (auth && auth.startsWith('Bearer ')) {
      const token = auth.slice(7)
      const payload = jwt.verify(token, 'wall-street-skill-secret')
      if (payload && payload.userId) {
        const db = getDB()
        db.prepare("UPDATE users SET last_seen_at = datetime('now') WHERE id = ?").run(payload.userId)
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
let bridgeProcess = null
function startBridge() {
  const bridgePath = join(__dirname, 'mt5_bridge.py')
  const venvPython = 'C:\\Users\\Administrator\\Desktop\\黄金AI分析\\.venv\\Scripts\\python.exe'
  const pythonCmd = existsSync(venvPython) ? venvPython : 'python'
  bridgeProcess = spawn(pythonCmd, [bridgePath], {
    cwd: __dirname,
    stdio: 'pipe',
    env: { ...process.env, ALLOW_LIVE_TRADING: 'true' }
  })
  bridgeProcess.stdout?.on('data', d => { const s = d.toString().trim(); if (s) console.log(`[Bridge] ${s}`) })
  bridgeProcess.stderr?.on('data', d => { const s = d.toString().trim(); if (s) console.log(`[Bridge] ${s}`) })
  bridgeProcess.on('exit', code => {
    console.log(`[Bridge] Exited with code ${code}, restarting in 3s...`)
    setTimeout(startBridge, 3000)
  })
  console.log(`[Bridge] MT5 Bridge starting (python=${pythonCmd})...`)
}
startBridge()

// Init DB and start
initDB()
initAutoSchedulers()
app.listen(PORT, () => {
  console.log(`Wall Street Skill server running on http://localhost:${PORT}`)
})
