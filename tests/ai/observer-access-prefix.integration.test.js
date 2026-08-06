import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import express from 'express'

// Keep the real AI router and its access middleware in this integration test,
// while avoiding a database lookup for the observer-source decoration that is
// unrelated to prefix compatibility.
vi.mock('../../server/routes/ai/observer-channels.js', async () => {
  const actual = await vi.importActual('../../server/routes/ai/observer-channels.js')
  return {
    ...actual,
    resolveObserverSourceForUser: vi.fn().mockResolvedValue(null),
    listObserverChannelsForUser: vi.fn().mockResolvedValue([]),
  }
})

vi.mock('../../server/bridge-ws.js', async () => {
  const actual = await vi.importActual('../../server/bridge-ws.js')
  return { ...actual, isBridgeAlive: vi.fn(userId => Number(userId) === 1004) }
})

import aiRouter from '../../server/routes/ai/index.js'

const IDENTITIES = Object.freeze({
  admin: { id:1001, role:'admin', plan:'plus' },
  plus: { id:1002, role:'user', plan:'plus' },
  proOffline: { id:1003, role:'user', plan:'pro' },
  proOnline: { id:1004, role:'user', plan:'pro' },
  free: { id:1005, role:'user', plan:'free' },
  expired: { id:1006, role:'user', plan:'pro', plan_expires_at:'2020-01-01 00:00:00' },
})

function createApp() {
  const app = express()
  app.use((req, res, next) => {
    const identity = IDENTITIES[String(req.headers['x-test-identity'] || 'plus')]
    req.user = { ...(identity || IDENTITIES.plus) }
    next()
  })

  for (const prefix of ['/api', '/aurum-api']) {
    app.use(prefix, aiRouter)
    // The real router has no non-GET access-context endpoint. This fallback
    // gives full-access identities a common probe after the access middleware,
    // so both prefixes can be compared for every HTTP method without invoking
    // an unrelated write handler.
    app.all(`${prefix}/ai/access-context`, (req, res) => {
      res.json({ ok:true, method:req.method, access:req.aiAccess })
    })
  }
  return app
}

function listen(app) {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, '127.0.0.1', () => resolve(server))
    server.once('error', reject)
  })
}

async function request(baseUrl, method, path, identity) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { 'x-test-identity': identity },
  })
  const text = await response.text()
  let body = text
  try { body = JSON.parse(text) } catch {}
  return { status:response.status, body }
}

describe('AI observer access API prefix integration', () => {
  let server
  let baseUrl

  beforeAll(async () => {
    server = await listen(createApp())
    baseUrl = `http://127.0.0.1:${server.address().port}`
  })

  afterAll(async () => {
    await new Promise(resolve => server.close(resolve))
  })

  it('returns identical access-context responses for both prefixes and all identities/methods', async () => {
    const expectedReadOnly = new Set(['plus', 'proOffline', 'free', 'expired'])
    const methods = ['GET', 'POST', 'PUT', 'DELETE']

    for (const identity of Object.keys(IDENTITIES)) {
      for (const method of methods) {
        const responses = await Promise.all(['/api', '/aurum-api'].map(prefix => request(
          baseUrl, method, `${prefix}/ai/access-context/?probe=${identity}`, identity,
        )))
        expect(responses[1].status, `${identity} ${method} status`).toBe(responses[0].status)
        expect(responses[1].body, `${identity} ${method} body`).toEqual(responses[0].body)

        if (expectedReadOnly.has(identity)) {
          expect(responses[0].status, `${identity} ${method}`).toBe(method === 'GET' ? 200 : 403)
          if (method !== 'GET') expect(responses[0].body).toMatchObject({ ok:false, code:'observer_read_only' })
        } else {
          expect(responses[0].status, `${identity} ${method}`).toBe(200)
          expect(responses[0].body).toMatchObject({ ok:true })
          if (method !== 'GET') expect(responses[0].body.method).toBe(method)
        }
      }
    }
  })

  it('keeps observer allow/deny decisions identical for a second read path', async () => {
    const cases = [
      ['plus', '/ai/observer-channels/', 200],
      ['plus', '/ai/model-profiles/', 403],
      ['proOffline', '/ai/observer-channels/', 200],
      ['proOffline', '/ai/risk-center/', 403],
      ['free', '/ai/observer-channels/', 403],
      ['expired', '/ai/model-profiles/', 403],
    ]
    for (const [identity, path, expectedStatus] of cases) {
      const responses = await Promise.all(['/api', '/aurum-api'].map(prefix => request(
        baseUrl, 'GET', `${prefix}${path}?probe=1`, identity,
      )))
      expect(responses[0].status).toBe(expectedStatus)
      expect(responses[1].status).toBe(expectedStatus)
      expect(responses[1].body).toEqual(responses[0].body)
    }
  })
})
