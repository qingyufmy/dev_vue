import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'

const serverSource = readFileSync(new URL('../server/index.js', import.meta.url), 'utf8')
const configSource = readFileSync(new URL('../server/config.js', import.meta.url), 'utf8')

describe('application rate-limit boundaries', () => {
  it('leaves general API traffic to deployment-edge CC protection', () => {
    expect(serverSource).not.toContain('const apiLimiter')
    expect(serverSource).not.toContain("app.use('/api', apiLimiter)")
    expect(serverSource).not.toContain("app.use('/aurum-api', apiLimiter)")
    expect(configSource).not.toContain('API_RATE_LIMIT_MAX')
  })

  it('retains dedicated limits for authentication, Bridge credentials, and content writes', () => {
    expect(serverSource).toContain('const authLimiter = rateLimit({')
    expect(serverSource).toContain('const bridgeAuthLimiter = rateLimit({')
    expect(serverSource).toContain("app.use('/api/login', authLimiter)")
    expect(serverSource).toContain("app.use('/api/send-code', authLimiter)")
    expect(serverSource).toContain("app.use('/api/auth/bridge-refresh', bridgeAuthLimiter)")
    expect(serverSource).toContain("app.use('/api/auth/bridge-pair/token', bridgeAuthLimiter)")
    expect(serverSource).toContain('const writeLimiter = rateLimit({')
    expect(serverSource).toContain("app.use('/api/feedback', writeLimiter)")
    expect(serverSource).toContain("app.use('/api/posts', writeLimiter)")
  })
})
