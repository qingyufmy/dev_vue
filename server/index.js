import express from 'express'
import cors from 'cors'
import multer from 'multer'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { existsSync, mkdirSync } from 'fs'
import { initDB } from './db.js'
import authRoutes from './routes/auth.js'
import courseRoutes from './routes/courses.js'
import commentRoutes from './routes/comments.js'
import postRoutes from './routes/posts.js'
import userRoutes from './routes/user.js'
import adminRoutes from './routes/admin.js'
import tradeRoutes from './routes/trades.js'
import paymentRoutes from './routes/payment.js'
import videoRoutes from './routes/video.js'
import { authMiddleware } from './middleware/auth.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const PORT = process.env.PORT || 3000

// Load .env
import { readFileSync } from 'fs'
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

// Presence heartbeat (no auth needed)
app.post('/api/presence', (req, res) => {
  res.json({ ok: true })
})

// Fallback: serve index.html for SPA routing
app.get('*', (req, res) => {
  res.sendFile(join(publicDir, 'index.html'))
})

// Init DB and start
initDB()
app.listen(PORT, () => {
  console.log(`Wall Street Skill server running on http://localhost:${PORT}`)
})
