import express from 'express'
import http from 'node:http'
import { describe, expect, it, vi } from 'vitest'

import { createBridgeMaintenanceRouter } from '../server/routes/bridge-maintenance.js'

function request(router, path, body) {
  const app = express()
  app.use(express.json())
  app.use('/api', router)
  return new Promise((resolve, reject) => {
    const server = app.listen(0, () => {
      const payload = JSON.stringify(body || {})
      const req = http.request({
        hostname:'127.0.0.1',
        port:server.address().port,
        path:`/api${path}`,
        method:'POST',
        headers:{ 'content-type':'application/json', 'content-length':Buffer.byteLength(payload) },
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

function body(overrides = {}) {
  return {
    installation_id:'install_01JROUTE0001',
    target_version:'3.1.0',
    priority:'normal',
    manual_request:true,
    terminal_instance_ids:['terminal_01JROUTE0001'],
    observer_bridge_user_ids:[],
    expected_downtime_seconds:60,
    ...overrides,
  }
}

function auth(user) {
  return (req, res, next) => { req.user = user; next() }
}

describe('bridge update maintenance route', () => {
  it('authorizes an administrator scope only from managed observer identities', async () => {
    const acquireLease = vi.fn().mockResolvedValue({
      acquired:true,
      lease_id:'lease_01JROUTE0001',
      expires_at_utc_msc:1_800_000_090_000,
      terminal_instance_ids:['terminal_01JROUTE0001'],
    })
    const response = await request(createBridgeMaintenanceRouter({
      authenticate:auth({ id:1, role:'admin' }),
      listSources:vi.fn().mockResolvedValue([{ bridge_user_id:42 }]),
      acquireLease,
    }), '/bridge/v3/maintenance-leases', body({ observer_bridge_user_ids:[42] }))

    expect(response).toMatchObject({ status:200, body:{ ok:true, acquired:true } })
    expect(acquireLease).toHaveBeenCalledWith(expect.objectContaining({
      actorUserId:1,
      authorizedUserIds:[1, 42],
    }))
  })

  it('rejects observer scope expansion by ordinary users before gateway access', async () => {
    const acquireLease = vi.fn()
    const response = await request(createBridgeMaintenanceRouter({
      authenticate:auth({ id:7, role:'user' }),
      acquireLease,
    }), '/bridge/v3/maintenance-leases', body({ observer_bridge_user_ids:[42] }))

    expect(response).toMatchObject({
      status:403,
      body:{ ok:false, code:'bridge_maintenance_observer_scope_forbidden' },
    })
    expect(acquireLease).not.toHaveBeenCalled()
  })

  it('returns an explicit retryable reason instead of allowing browser timeouts', async () => {
    const response = await request(createBridgeMaintenanceRouter({
      authenticate:auth({ id:7, role:'user' }),
      acquireLease:vi.fn().mockResolvedValue({
        acquired:false,
        code:'bridge_maintenance_commands_in_flight',
        retry_after_seconds:5,
      }),
    }), '/bridge/v3/maintenance-leases', body())

    expect(response).toMatchObject({
      status:200,
      body:{
        ok:true,
        acquired:false,
        reason_code:'bridge_maintenance_commands_in_flight',
        retry_after_seconds:5,
      },
    })
    expect(response.body.reason).toContain('交易指令')
  })

  it('binds renew and release operations to the authenticated actor', async () => {
    const renewLease = vi.fn().mockReturnValue({
      renewed:true, lease_id:'lease_01JROUTE0001', expires_at_utc_msc:1_800_000_090_000,
    })
    const releaseLease = vi.fn().mockReturnValue({ released:true, lease_id:'lease_01JROUTE0001' })
    const router = createBridgeMaintenanceRouter({
      authenticate:auth({ id:7, role:'user' }), renewLease, releaseLease,
    })

    const renewed = await request(router, '/bridge/v3/maintenance-leases/lease_01JROUTE0001/renew', {})
    const released = await request(router, '/bridge/v3/maintenance-leases/lease_01JROUTE0001/release', {})

    expect(renewed.body.renewed).toBe(true)
    expect(released.body.released).toBe(true)
    expect(renewLease).toHaveBeenCalledWith(7, 'lease_01JROUTE0001')
    expect(releaseLease).toHaveBeenCalledWith(7, 'lease_01JROUTE0001')
  })
})
