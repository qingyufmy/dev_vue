import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'
import { loadV4ApiRuntimeConfig, loadV4BaseRuntimeConfig, loadV4BrowserRealtimeConfig, loadV4RuntimeConfig } from '../src/bootstrap/runtime-config.js'

const baseEnv = {
  MYSQL_HOST: '127.0.0.1', MYSQL_USER: 'aurum', MYSQL_PASSWORD: '', MYSQL_DATABASE: 'dev_vue',
  REDIS_HOST: '127.0.0.1', QUEUE_REDIS_HOST: '127.0.0.1',
}

describe('V4 runtime wiring', () => {
  it('requires distinct cache and queue Redis configuration and remains disabled by default', () => {
    expect(() => loadV4RuntimeConfig({ ...baseEnv, QUEUE_REDIS_HOST: undefined })).toThrow('QUEUE_REDIS_HOST_required')
    expect(loadV4BaseRuntimeConfig({ ...baseEnv, QUEUE_REDIS_HOST: undefined }).cacheRedis.db).toBe(0)
    const config = loadV4RuntimeConfig(baseEnv)
    expect(config.enabled).toBe(false)
    expect(config.cacheRedis.db).toBe(0)
    expect(config.queueRedis.db).toBe(1)
  })

  it('keeps BaoTa as one PM2 project with isolated single-instance roles', () => {
    const require = createRequire(import.meta.url)
    const ecosystem = require('../../ecosystem.v4.config.cjs') as { apps: Array<Record<string, unknown>> }
    expect(ecosystem.apps.map(app => app.name)).toEqual([
      'aurum-v4-api', 'aurum-v4-browser-realtime', 'aurum-v4-bridge-gateway',
      'aurum-v4-outbox-dispatcher', 'aurum-v4-worker-execution',
      'aurum-v4-scheduler-analysis', 'aurum-v4-worker-analysis',
      'aurum-v4-worker-trader', 'aurum-v4-worker-risk',
    ])
    expect(ecosystem.apps.every(app => app.instances === 1 && app.exec_mode === 'fork' && app.watch === false)).toBe(true)
  })

  it('keeps API signing configuration out of the browser realtime role', () => {
    const shared = { ...baseEnv, TRADE_ORIGIN: 'https://trade.example.test' }
    expect(loadV4BrowserRealtimeConfig(shared)).toEqual({
      port: 3011, secureCookies: true, tradeOrigin: 'https://trade.example.test',
    })
    expect(() => loadV4ApiRuntimeConfig(shared)).toThrow('AUTH_ORIGIN_required')
    const api = loadV4ApiRuntimeConfig({
      ...shared,
      AUTH_ORIGIN: 'https://auth.example.test', WWW_ORIGIN: 'https://www.example.test', ADMIN_ORIGIN: 'https://admin.example.test',
      AUTH_CSRF_SECRET: 'c'.repeat(32), AUTH_BFF_EXCHANGE_SECRET: 'b'.repeat(32),
      AUTH_ID_TOKEN_PRIVATE_KEY_PEM: 'line1\\nline2', AUTH_ID_TOKEN_KEY_ID: 'key-1', V4_SECURE_COOKIES: 'false',
    })
    expect(api.port).toBe(3010)
    expect(api.secureCookies).toBe(false)
    expect(api.auth.idTokenPrivateKeyPem).toBe('line1\nline2')
  })

  it('writes intent and command wake-ups in the same authoritative transactions', async () => {
    const execution = await readFile(new URL('../src/modules/execution/infrastructure/mysql-execution-repository.ts', import.meta.url), 'utf8')
    const command = await readFile(new URL('../src/modules/execution/infrastructure/mysql-bridge-command-repository.ts', import.meta.url), 'utf8')
    expect(execution).toContain("'execution.intent.prepared'")
    expect(execution).toContain('intent_id: intent.id')
    expect(command).toContain("'bridge.command.queued'")
    expect(command).toContain('command_id: command.id')
    const distribution = await readFile(new URL('../src/modules/execution/infrastructure/mysql-execution-distribution-repository.ts', import.meta.url), 'utf8')
    expect(distribution).toContain("'execution.distribution.target.requested'")
    expect(distribution).toContain('distribution_target_id: target.id')
  })
})
