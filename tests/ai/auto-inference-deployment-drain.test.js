import { describe, expect, it, vi, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'

vi.mock('../../server/redis.js', () => ({
  getRedis: vi.fn(),
  isRedisAvailable: vi.fn(),
}))

vi.mock('../../server/db.js', () => ({
  queryOne: vi.fn(),
}))

import * as redisModule from '../../server/redis.js'
import * as db from '../../server/db.js'
import {
  AUTO_INFERENCE_DEPLOYMENT_DRAIN_KEY,
  __autoInferenceDeploymentDrainTest,
  beginAutoInferenceDeploymentDrain,
  countActiveAutoInferenceTasks,
  endAutoInferenceDeploymentDrain,
  readAutoInferenceDeploymentDrain,
  waitForAutoInferenceDeploymentDrain,
} from '../../server/routes/ai/auto-inference-deployment-drain.js'
import { __autoInferenceDrainCliTest } from '../../scripts/deploy/auto-inference-drain.mjs'

describe('automatic inference deployment drain', () => {
  let values
  let expiries
  let fakeRedis

  beforeEach(() => {
    vi.clearAllMocks()
    values = new Map()
    expiries = new Map()
    fakeRedis = {
      ping: vi.fn(async () => 'PONG'),
      get: vi.fn(async key => values.get(key) || null),
      ttl: vi.fn(async key => {
        if (!values.has(key)) return -2
        return expiries.get(key) ?? -1
      }),
      set: vi.fn(async (key, value, mode, expiryMode, ttl, nxMode) => {
        if ([mode, expiryMode, ttl, nxMode].includes('NX') && values.has(key)) return null
        values.set(key, String(value))
        expiries.set(key, Number(mode === 'EX' ? expiryMode : ttl))
        return 'OK'
      }),
      eval: vi.fn(async (script, _keyCount, key, token, ttl) => {
        if (script.includes('expire')) {
          if (values.get(key) !== token) return 0
          expiries.set(key, Number(ttl))
          return 1
        }
        if (values.get(key) !== token) return 0
        values.delete(key)
        expiries.delete(key)
        return 1
      }),
    }
    redisModule.getRedis.mockReturnValue(fakeRedis)
    redisModule.isRedisAvailable.mockReturnValue(true)
  })

  it('uses a TTL-backed token lease and prevents a different token from releasing it', async () => {
    const started = await beginAutoInferenceDeploymentDrain({
      redis:fakeRedis, token:'drain-a', ttlSeconds:300, nowMs:1_000,
    })
    expect(started).toMatchObject({ acquired:true, token:'drain-a', ttlSeconds:300 })
    expect(fakeRedis.set).toHaveBeenCalledWith(AUTO_INFERENCE_DEPLOYMENT_DRAIN_KEY, 'drain-a', 'EX', 300, 'NX')

    const conflict = await beginAutoInferenceDeploymentDrain({ redis:fakeRedis, token:'drain-b', ttlSeconds:300 })
    expect(conflict).toMatchObject({ acquired:false })
    await expect(endAutoInferenceDeploymentDrain({ redis:fakeRedis, token:'drain-b' }))
      .resolves.toMatchObject({ released:false, reason:'token_mismatch' })
    await expect(readAutoInferenceDeploymentDrain({ redis:fakeRedis }))
      .resolves.toMatchObject({ active:true, token:'drain-a', ttlSeconds:300 })
    await expect(endAutoInferenceDeploymentDrain({ redis:fakeRedis, token:'drain-a' }))
      .resolves.toMatchObject({ released:true })
    await expect(readAutoInferenceDeploymentDrain({ redis:fakeRedis }))
      .resolves.toMatchObject({ active:false })
  })

  it('fails closed when Redis is unavailable', async () => {
    redisModule.isRedisAvailable.mockReturnValue(false)
    fakeRedis.ping = undefined
    await expect(beginAutoInferenceDeploymentDrain({ redis:fakeRedis })).rejects.toMatchObject({
      code:'auto_inference_drain_redis_unavailable',
    })
    await expect(readAutoInferenceDeploymentDrain({ redis:fakeRedis }))
      .resolves.toMatchObject({ available:false, active:false })
  })

  it('confirms a lazy Redis client with ping before the availability flag catches up', async () => {
    redisModule.isRedisAvailable.mockReturnValue(false)
    const started = await beginAutoInferenceDeploymentDrain({
      redis:fakeRedis, token:'lazy-drain', ttlSeconds:30,
    })
    expect(started).toMatchObject({ acquired:true, token:'lazy-drain' })
    expect(fakeRedis.ping).toHaveBeenCalledTimes(1)
  })

  it('fails closed when the lazy Redis ping cannot connect', async () => {
    redisModule.isRedisAvailable.mockReturnValue(false)
    fakeRedis.ping.mockRejectedValueOnce(new Error('connection refused'))
    await expect(beginAutoInferenceDeploymentDrain({ redis:fakeRedis, token:'no-drain', ttlSeconds:30 }))
      .rejects.toMatchObject({ code:'auto_inference_drain_redis_unavailable' })
    expect(fakeRedis.set).not.toHaveBeenCalled()
  })

  it('counts status_unknown as active and never force-clears it', async () => {
    db.queryOne.mockResolvedValue({ active_count:2 })
    await expect(countActiveAutoInferenceTasks()).resolves.toBe(2)
    expect(db.queryOne.mock.calls[0][0]).toContain("COALESCE(status, '') NOT IN")
    expect(db.queryOne.mock.calls[0][0]).toContain('?, ?, ?, ?, ?')
    expect(db.queryOne.mock.calls[0][1]).toContain('succeeded')
  })

  it('waits for a zero active count while renewing only its own lease', async () => {
    let nowMs = 1_000
    const counts = [2, 1, 0]
    const renew = vi.fn(async ({ token }) => token === 'drain-a')
    const read = vi.fn(async () => ({ available:true, active:true, token:'drain-a', ttlSeconds:300 }))
    const count = vi.fn(async () => counts.shift())
    const sleep = vi.fn(async ms => { nowMs += ms })
    await expect(waitForAutoInferenceDeploymentDrain({
      token:'drain-a', timeoutSeconds:300, pollSeconds:1,
      now:() => nowMs, read, count, sleep, renew,
    })).resolves.toMatchObject({ drained:true, activeCount:0 })
    expect(renew).toHaveBeenCalledTimes(2)
    expect(sleep).toHaveBeenCalled()
  })

  it('keeps drain CLI composable and the wrapper releases on every exit path', () => {
    expect(__autoInferenceDrainCliTest.parseArgs(['begin', '--ttl-seconds', '120']))
      .toMatchObject({ command:'begin', 'ttl-seconds':'120' })
    expect(__autoInferenceDeploymentDrainTest.normalizedTtlSeconds(120)).toBe(120)
    const cli = readFileSync(new URL('../../scripts/deploy/auto-inference-drain.mjs', import.meta.url), 'utf8')
    expect(cli).toContain('await output({ ok:true, command:\'begin\', ...result })')
    expect(cli).toContain('process.exit(code)')
    expect(cli).toContain('process.exit(1)')
    expect(cli).not.toContain('process.exitCode')
    expect(cli).toContain('if (isMainModule())')
    const wrapper = readFileSync(new URL('../../scripts/deploy/auto-inference-drain.sh', import.meta.url), 'utf8')
    expect(wrapper).toContain('trap cleanup_drain EXIT INT TERM')
    expect(wrapper).toContain('node "$DRAIN_CLI" wait')
    expect(wrapper).toContain('node "$DRAIN_CLI" end --token "$DRAIN_TOKEN"')
  })
})
