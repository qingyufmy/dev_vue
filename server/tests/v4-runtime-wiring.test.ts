import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'
import { loadV4RuntimeConfig } from '../src/bootstrap/runtime-config.js'

const baseEnv = {
  MYSQL_HOST: '127.0.0.1', MYSQL_USER: 'aurum', MYSQL_PASSWORD: '', MYSQL_DATABASE: 'dev_vue',
  REDIS_HOST: '127.0.0.1', QUEUE_REDIS_HOST: '127.0.0.1',
}

describe('V4 runtime wiring', () => {
  it('requires distinct cache and queue Redis configuration and remains disabled by default', () => {
    expect(() => loadV4RuntimeConfig({ ...baseEnv, QUEUE_REDIS_HOST: undefined })).toThrow('QUEUE_REDIS_HOST_required')
    const config = loadV4RuntimeConfig(baseEnv)
    expect(config.enabled).toBe(false)
    expect(config.cacheRedis.db).toBe(0)
    expect(config.queueRedis.db).toBe(1)
  })

  it('keeps BaoTa as one PM2 project with isolated single-instance roles', () => {
    const require = createRequire(import.meta.url)
    const ecosystem = require('../../ecosystem.v4.config.cjs') as { apps: Array<Record<string, unknown>> }
    expect(ecosystem.apps.map(app => app.name)).toEqual([
      'aurum-v4-bridge-gateway', 'aurum-v4-outbox-dispatcher', 'aurum-v4-worker-execution',
    ])
    expect(ecosystem.apps.every(app => app.instances === 1 && app.exec_mode === 'fork' && app.watch === false)).toBe(true)
  })

  it('writes intent and command wake-ups in the same authoritative transactions', async () => {
    const execution = await readFile(new URL('../src/modules/execution/infrastructure/mysql-execution-repository.ts', import.meta.url), 'utf8')
    const command = await readFile(new URL('../src/modules/execution/infrastructure/mysql-bridge-command-repository.ts', import.meta.url), 'utf8')
    expect(execution).toContain("'execution.intent.prepared'")
    expect(execution).toContain('intent_id: intent.id')
    expect(command).toContain("'bridge.command.queued'")
    expect(command).toContain('command_id: command.id')
  })
})
