import express from 'express'
import http from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'
import { createBridgePairStartLimiter } from '../server/bridge-pair-rate-limit.js'

let activeServer

function request(server) {
  return new Promise((resolve, reject) => {
    const address = server.address()
    const req = http.request({
      hostname: '127.0.0.1',
      port: address.port,
      path: '/api/auth/bridge-pair/start',
      method: 'POST',
    }, res => {
      let body = ''
      res.on('data', chunk => { body += chunk })
      res.on('end', () => resolve({
        status: res.statusCode,
        headers: res.headers,
        body: body ? JSON.parse(body) : null,
      }))
    })
    req.on('error', reject)
    req.end()
  })
}

function listen(app) {
  return new Promise(resolve => {
    const server = app.listen(0, '127.0.0.1', () => resolve(server))
  })
}

afterEach(async () => {
  if (!activeServer) return
  await new Promise(resolve => activeServer.close(resolve))
  activeServer = undefined
})

describe('Bridge pairing launch rate limit', () => {
  it('blocks a short burst and automatically recovers after the window', async () => {
    const app = express()
    app.use('/api/auth/bridge-pair/start', createBridgePairStartLimiter({
      windowMs: 100,
      max: 2,
    }))
    app.post('/api/auth/bridge-pair/start', (_req, res) => res.status(204).end())
    activeServer = await listen(app)

    expect((await request(activeServer)).status).toBe(204)
    expect((await request(activeServer)).status).toBe(204)

    const blocked = await request(activeServer)
    expect(blocked.status).toBe(429)
    expect(blocked.body).toEqual({
      ok: false,
      code: 'bridge_pair_start_rate_limited',
      error: '授权请求过于频繁，请稍后再试',
    })
    expect(blocked.headers['retry-after']).toBeDefined()

    await new Promise(resolve => setTimeout(resolve, 150))
    expect((await request(activeServer)).status).toBe(204)
  })
})
