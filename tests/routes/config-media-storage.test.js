import { beforeEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import http from 'node:http'

const { queryAll, queryOne, queryRun, transactionRunner, testStorageConnection } = vi.hoisted(() => ({
  queryAll:vi.fn(), queryOne:vi.fn(), queryRun:vi.fn(), transactionRunner:vi.fn(), testStorageConnection:vi.fn(),
}))
vi.mock('../../server/db.js', () => ({
  queryAll, queryOne, queryRun, withTransaction:vi.fn(async callback => callback(transactionRunner)), logAudit:vi.fn(),
}))
vi.mock('../../server/middleware/auth.js', () => ({
  authMiddleware:(req, res, next) => { req.user={ id:1, role:'admin' }; next() },
  adminOnly:(req, res, next) => next(),
}))
vi.mock('../../server/crypto/fixed-address.js', () => ({ resetFixedAddressCache:vi.fn() }))
vi.mock('../../server/sms.js', () => ({ resetSmsConfigCache:vi.fn(), loadSmsConfig:vi.fn(), sendSms:vi.fn() }))
vi.mock('../../server/storage/storage-service.js', () => ({ testStorageConnection }))

import { logAudit } from '../../server/db.js'
import configRouter from '../../server/routes/config.js'
import { invalidateStorageConfigCache, readStorageConfigFromRows } from '../../server/storage/storage-config.js'

function makeApp() {
  const app=express(); app.use(express.json()); app.use('/api', configRouter); return app
}
function request(app, method, path, body) {
  return new Promise((resolve, reject) => {
    const server=app.listen(0, () => {
      const req=http.request({ hostname:'127.0.0.1', port:server.address().port, path, method, headers:{'Content-Type':'application/json'} }, res => {
        let text=''; res.on('data', chunk => { text+=chunk }); res.on('end', () => { server.close(); resolve({ status:res.statusCode, body:JSON.parse(text) }) })
      })
      req.on('error', reject); if(body) req.write(JSON.stringify(body)); req.end()
    })
  })
}
const baseRows = ({ provider='local', testStatus='not_tested', testVersion='', testedAt='' } = {}) => [
  { category:'media_storage', key:'default_provider', value:'local' },
  { category:'media_storage', key:'video_provider', value:provider==='qiniu'?'qiniu':'inherit' },
  { category:'media_storage', key:'attachment_provider', value:'inherit' },
  { category:'media_storage', key:'image_provider', value:'inherit' },
  { category:'media_storage', key:'resource_provider', value:'inherit' },
  { category:'media_storage', key:'qiniu_connection_test_status', value:testStatus },
  { category:'media_storage', key:'qiniu_connection_test_version', value:testVersion },
  { category:'media_storage', key:'qiniu_connection_tested_at', value:testedAt },
  { category:'qiniu', key:'access_key', value:'access' },
  { category:'qiniu', key:'secret_key', value:'secret' },
  { category:'qiniu', key:'bucket', value:'bucket' },
  { category:'qiniu', key:'domain', value:'https://cdn.example.test' },
  { category:'qiniu', key:'region', value:'z0' },
  { category:'qiniu', key:'private_bucket', value:'true' },
]

describe('media storage system configuration', () => {
  beforeEach(() => {
    queryAll.mockReset(); queryOne.mockReset(); queryRun.mockReset(); transactionRunner.mockReset(); logAudit.mockReset(); testStorageConnection.mockReset(); invalidateStorageConfigCache()
    transactionRunner.mockImplementation(async sql => {
      if(String(sql).includes('SELECT category')) return [baseRows(), []]
      return [{ affectedRows:1, insertId:1 }, []]
    })
  })

  it('exposes qiniu/media categories while redacting credentials', async () => {
    queryAll.mockResolvedValueOnce(baseRows())
    const result=await request(makeApp(), 'GET', '/api/system-config')
    expect(result.status).toBe(200)
    expect(result.body.config.qiniu).toBeTruthy()
    expect(result.body.config.media_storage).toBeTruthy()
    expect(result.body.config.qiniu.find(item => item.key==='secret_key').value).toBe('***REDACTED***')
    expect(result.body.storage.effective_provider.video).toBe('local')
    expect(result.body.config.qiniu.find(item => item.key==='secret_key').value).not.toContain('access')
    expect(result.body.config.qiniu.find(item => item.key==='secret_key').value).not.toContain('secret')
  })

  it('rejects enabling qiniu until the current config version has passed a test', async () => {
    transactionRunner.mockImplementation(async sql => {
      if(String(sql).includes('SELECT category')) return [baseRows(), []]
      throw new Error('must not write')
    })
    const result=await request(makeApp(), 'PUT', '/api/system-config/media_storage', { items:[{ key:'video_provider', value:'qiniu' }] })
    expect(result.status).toBe(400)
    expect(result.body.error).toContain('测试当前')
    expect(transactionRunner).toHaveBeenCalledTimes(1)
  })

  it('allows routing a purpose to qiniu after its connection proof, without retesting the route choice', async () => {
    const rows=baseRows()
    const fingerprint=readStorageConfigFromRows(rows).configVersion
    const testedRows=baseRows({ testStatus:'succeeded', testVersion:fingerprint, testedAt:new Date(Date.now() - 60_000).toISOString().replace('T',' ').slice(0,19) })
    transactionRunner.mockImplementation(async sql => {
      if(String(sql).includes('SELECT category')) return [testedRows, []]
      return [{ affectedRows:1, insertId:1 }, []]
    })
    const result=await request(makeApp(), 'PUT', '/api/system-config/media_storage', { items:[{ key:'video_provider', value:'qiniu' }] })
    expect(result.status).toBe(200)
    expect(transactionRunner).toHaveBeenCalled()
  })

  it('locks qiniu bucket changes while ready cloud files are still owned', async () => {
    const rows=baseRows()
    transactionRunner.mockImplementation(async sql => {
      const text=String(sql)
      if(text.includes('SELECT category')) return [rows, []]
      if(text.includes('SELECT id FROM stored_files')) return [[{ id:77 }], []]
      throw new Error('must not write')
    })
    const result=await request(makeApp(), 'PUT', '/api/system-config/qiniu', { items:[{ key:'bucket', value:'new-bucket' }] })
    expect(result.status).toBe(400)
    expect(result.body.error).toContain('不可切换存储空间')
  })

  it('runs a closed-loop test and stores only status, stage and config hash', async () => {
    const rows=baseRows()
    queryAll.mockResolvedValueOnce(rows)
    testStorageConnection.mockResolvedValueOnce({ ok:true, stage:'completed' })
    transactionRunner.mockImplementation(async sql => {
      if(String(sql).includes('SELECT category')) return [rows, []]
      return [{ affectedRows:1, insertId:1 }, []]
    })
    const result=await request(makeApp(), 'POST', '/api/system-config/media_storage/test', {})
    expect(result.status).toBe(200)
    expect(result.body.test).toMatchObject({ status:'succeeded', stage:'completed' })
    expect(result.body).not.toHaveProperty('token')
    expect(result.body).not.toHaveProperty('signed_url')
    expect(JSON.stringify(result.body)).not.toContain('secret')
    expect(logAudit).toHaveBeenCalledWith(expect.objectContaining({ action:'system_config_storage_tested' }))
  })

  it('reports safe failure stage and does not expose provider response text', async () => {
    const rows=baseRows(); queryAll.mockResolvedValueOnce(rows)
    testStorageConnection.mockRejectedValueOnce(Object.assign(new Error('AK=secret-token response body'), { code:'storage_qiniu_upload_failed', stage:'object_upload' }))
    transactionRunner.mockImplementation(async sql => {
      if(String(sql).includes('SELECT category')) return [rows, []]
      return [{ affectedRows:1, insertId:1 }, []]
    })
    const result=await request(makeApp(), 'POST', '/api/system-config/media_storage/test', {})
    expect(result.status).toBe(400)
    expect(result.body).toMatchObject({ ok:false, code:'storage_qiniu_upload_failed' })
    expect(result.body.error).not.toContain('secret-token')
    expect(result.body.test.stage).toBe('object_upload')
  })
})
