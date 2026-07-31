import express from 'express'
import http from 'node:http'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  readBridgeRuntimeControl,
  resetBridgeRuntimeControlWaitersForTests,
  waitForBridgeRuntimeControl,
  writeBridgeRuntimeControl,
} from '../server/bridge-runtime-control.js'
import { createBridgeRuntimeControlRouter } from '../server/routes/bridge-runtime-control.js'

function request(router, { method = 'GET', path = '/bridge/runtime-control', body = null } = {}) {
  const app = express()
  app.use(express.json())
  app.use('/api', router)
  return new Promise((resolve, reject) => {
    const server = app.listen(0, () => {
      const payload = body == null ? '' : JSON.stringify(body)
      const req = http.request({
        hostname:'127.0.0.1',
        port:server.address().port,
        path:`/api${path}`,
        method,
        headers:payload ? {
          'content-type':'application/json',
          'content-length':Buffer.byteLength(payload),
        } : {},
      }, res => {
        let content = ''
        res.on('data', chunk => { content += chunk })
        res.on('end', () => {
          server.close()
          resolve({ status:res.statusCode, body:JSON.parse(content) })
        })
      })
      req.on('error', error => { server.close(); reject(error) })
      req.end(payload)
    })
  })
}

function authenticate(userId = 7101) {
  return (req, _res, next) => { req.user = { id:userId, role:'user' }; next() }
}

afterEach(() => resetBridgeRuntimeControlWaitersForTests())

describe('bridge runtime control state', () => {
  it('defaults an existing user without a settings row to enabled', async () => {
    await expect(readBridgeRuntimeControl(7, { queryOneFn:vi.fn().mockResolvedValue(null) }))
      .resolves.toEqual({ enabled:true, revision:1, changed_at:null })
  })

  it('publishes a changed revision to a waiting native bridge immediately', async () => {
    let row = {
      connection_enabled:1,
      connection_control_revision:2,
      connection_control_changed_at:'2026-07-31 12:00:00.000',
    }
    const queryOneFn = vi.fn(async () => row)
    const queryRunFn = vi.fn(async (_sql, params) => {
      row = {
        connection_enabled:Number(params[1]),
        connection_control_revision:3,
        connection_control_changed_at:'2026-07-31 12:00:01.000',
      }
    })
    const waiting = waitForBridgeRuntimeControl(7, 2, { queryOneFn, timeoutMs:5_000 })
    await Promise.resolve()
    const written = await writeBridgeRuntimeControl(7, false, { queryOneFn, queryRunFn })

    await expect(waiting).resolves.toMatchObject({ enabled:false, revision:3 })
    expect(written).toMatchObject({ enabled:false, revision:3 })
    expect(queryRunFn.mock.calls[0][0]).toContain('connection_control_revision + 1')
  })
})

describe('bridge runtime control routes', () => {
  it('returns desired state, real connection state and transport latency', async () => {
    const router = createBridgeRuntimeControlRouter({
      authenticate:authenticate(7102),
      readControl:vi.fn().mockResolvedValue({ enabled:true, revision:4, changed_at:null }),
      diagnostics:vi.fn().mockReturnValue({
        connected:true,
        transport_latency_msc:18,
        bridge_version:'3.0.0',
        terminals:[{ terminal_instance_id:'terminal-1', platform:'MT4' }],
      }),
    })
    const response = await request(router)
    expect(response).toMatchObject({
      status:200,
      body:{
        ok:true,
        desired_state:'enabled',
        actual_state:'connected',
        transport_latency_msc:18,
        bridge_version:'3.0.0',
      },
    })
  })

  it('persists pause before disconnecting the active server session', async () => {
    const events = []
    const writeControl = vi.fn(async () => {
      events.push('persisted')
      return { enabled:false, revision:8, changed_at:'2026-07-31 12:00:02.000' }
    })
    const disconnect = vi.fn(() => events.push('disconnected'))
    const audit = vi.fn().mockResolvedValue(undefined)
    const router = createBridgeRuntimeControlRouter({
      authenticate:authenticate(7103),
      writeControl,
      disconnect,
      audit,
      diagnostics:vi.fn().mockReturnValue({ connected:false, terminals:[] }),
      now:() => 2_000,
    })
    const response = await request(router, { method:'POST', body:{ enabled:false } })

    expect(response).toMatchObject({
      status:200,
      body:{ desired_state:'paused', actual_state:'paused', revision:8 },
    })
    expect(events).toEqual(['persisted', 'disconnected'])
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ action:'bridge_connection_paused' }))
  })

  it('returns the changed control state even when audit logging fails afterward', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const router = createBridgeRuntimeControlRouter({
      authenticate:authenticate(7105),
      writeControl:vi.fn().mockResolvedValue({
        enabled:true,
        revision:9,
        changed_at:'2026-07-31 12:00:03.000',
      }),
      audit:vi.fn().mockRejectedValue(new Error('audit_unavailable')),
      diagnostics:vi.fn().mockReturnValue({ connected:false, terminals:[] }),
      now:() => 3_000,
    })

    const response = await request(router, { method:'POST', body:{ enabled:true } })

    expect(response).toMatchObject({
      status:200,
      body:{ desired_state:'enabled', actual_state:'offline', revision:9 },
    })
    expect(warn).toHaveBeenCalledOnce()
    warn.mockRestore()
  })

  it('authenticates native long-poll control without touching the durable login session', async () => {
    const useRefresh = vi.fn().mockResolvedValue({ user:{ id:7104 } })
    const waitControl = vi.fn().mockResolvedValue({ enabled:true, revision:11 })
    const router = createBridgeRuntimeControlRouter({
      useRefresh,
      waitControl,
      now:() => 1_800_000_000_000,
    })
    const response = await request(router, {
      method:'POST',
      path:'/auth/bridge-runtime-control/wait',
      body:{ refreshToken:'r'.repeat(64), afterRevision:10 },
    })

    expect(response).toMatchObject({
      status:200,
      body:{ ok:true, enabled:true, revision:11, observedAtUtcMsc:1_800_000_000_000 },
    })
    expect(useRefresh).toHaveBeenCalledWith('r'.repeat(64), expect.objectContaining({ touch:false }))
    expect(waitControl).toHaveBeenCalledWith(7104, 10, expect.objectContaining({ signal:expect.any(AbortSignal) }))
  })
})
