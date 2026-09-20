import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:http'
import { selectRoles, restartAllowed } from './local-v4-roles.mjs'
import { runSupervisor, probe } from './local-v4-supervisor.mjs'

test('default scope includes the complete execution chain; core is explicit; restart storm is bounded', () => {
  for (const id of ['worker-risk','worker-execution','scheduler-execution','bridge-gateway','worker-review']) {
    assert.ok(selectRoles().some(role => role.id === id))
  }
  assert.ok(selectRoles('core').some(role => role.id === 'worker-risk'))
  assert.ok(!selectRoles('core').some(role => role.id === 'worker-execution'))
  assert.ok(!selectRoles('core').some(role => role.id === 'scheduler-execution'))
  assert.ok(selectRoles('full').some(role => role.id === 'worker-execution'))
  assert.throws(() => selectRoles('typo'))
  assert.equal(restartAllowed([100, 110, 120], 130), false)
  assert.equal(restartAllowed([100, 110, 120], 400000), true)
})
test('foreign listener is a conflict and is never stopped', async () => {
  const server = createServer((_req, res) => res.end(JSON.stringify({ role: 'other', ready: true })))
  await new Promise(done => server.listen(0, '127.0.0.1', done))
  const role = { id: 'fixture', label: 'fixture', port: server.address().port }
  const directory = await mkdtemp(join(tmpdir(), 'v4-supervisor-'))
  try {
    assert.equal(await probe(role), 'conflict')
    await assert.rejects(runSupervisor({ root: directory, directory, roles: [role], controlPort: 0, commandFor: () => { throw Error('must not spawn') }, log() {} }), /conflict/)
    assert.equal(server.listening, true)
  } finally { await new Promise(done => server.close(done)); await rm(directory, { recursive: true, force: true }) }
})
test('frontend listening only on IPv6 is reused instead of duplicated', async () => {
  const server = createServer((_req, res) => res.end('frontend'))
  await new Promise((done, reject) => { server.once('error', reject); server.listen(0, '::1', done) })
  try { assert.equal(await probe({ web: true, port: server.address().port }), 'external-web') }
  finally { await new Promise(done => server.close(done)) }
})
test('owned child stops over IPC; unauthorized stop rejected; external service survives', async () => {
  const external = createServer((_req, res) => res.end(JSON.stringify({ role: 'external', ready: true })))
  await new Promise(done => external.listen(0, '127.0.0.1', done))
  const reservation = createServer()
  await new Promise(done => reservation.listen(0, '127.0.0.1', done))
  const port = reservation.address().port; await new Promise(done => reservation.close(done))
  const directory = await mkdtemp(join(tmpdir(), 'v4-supervisor-'))
  const owned = { id: 'owned', label: 'owned', port }
  let supervisor
  try {
    supervisor = await runSupervisor({ root: directory, directory, controlPort: 0,
      roles: [{ id: 'external', label: 'external', port: external.address().port }, owned], log() {},
      commandFor: () => ({ file: process.execPath, args: ['-e', `const s=require('http').createServer((q,r)=>r.end(JSON.stringify({role:'owned',ready:true}))).listen(${port},'127.0.0.1');process.on('message',m=>{if(m==='local-v4-stop')s.close(()=>process.exit(0))})`] }) })
    for (let i = 0; i < 50 && await probe(owned) !== 'ready'; i++) await new Promise(done => setTimeout(done, 50))
    assert.equal(await probe(owned), 'ready')
    const status = await fetch(`http://127.0.0.1:${supervisor.port}/status`, { headers: { authorization: `Bearer ${supervisor.token}` } }).then(r => r.json())
    assert.equal(status.profile, 'custom')
    assert.deepEqual(status.selected, ['external', 'owned'])
    const rejected = await fetch(`http://127.0.0.1:${supervisor.port}/stop`, { method: 'POST' })
    assert.equal(rejected.status, 403)
    await supervisor.stop()
    assert.equal(await probe(owned), 'stopped')
    assert.equal(external.listening, true)
  } finally {
    await supervisor?.stop(); await new Promise(done => external.close(done))
    await rm(directory, { recursive: true, force: true })
  }
})

test('web waits for a slow API; an unavailable API prevents web launch', async () => {
  for (const timeout of [false, true]) {
    const ports = []
    for (let i = 0; i < 2; i++) {
      const server = createServer()
      await new Promise(done => server.listen(0, '127.0.0.1', done))
      ports.push(server.address().port)
      await new Promise(done => server.close(done))
    }
    const directory = await mkdtemp(join(tmpdir(), 'v4-start-order-'))
    const api = { id: 'api-v4', label: 'API', port: ports[0] }
    const web = { id: 'test-web', label: 'Web', web: true, port: ports[1] }
    const launched = []
    let supervisor
    try {
      const start = () => runSupervisor({ root: directory, directory, controlPort: 0,
        roles: [api, web], readinessTimeoutMs: timeout ? 200 : 5000, log() {},
        commandFor(role) {
          launched.push(role.id)
          const body = role.web ? 'page' : JSON.stringify({ role: 'api-v4', ready: true })
          // The web child checks the real API endpoint before listening: bad ordering fails the test.
          const code = `process.on('message',m=>{if(m==='local-v4-stop')process.exit(0)});const http=require('http');async function start(){${role.web ? `const r=await fetch('http://127.0.0.1:${api.port}/health/ready');if(!r.ok)process.exit(2);` : ''}http.createServer((q,r)=>r.end(${JSON.stringify(body)})).listen(${role.port},'127.0.0.1')}setTimeout(()=>start().catch(()=>process.exit(2)),${role.web ? 0 : timeout ? 10000 : 350});`
          return { file: process.execPath, args: ['-e', code] }
        } })
      if (timeout) {
        await assert.rejects(start(), /启动期限/)
        assert.deepEqual(launched, ['api-v4'])
        assert.equal(await probe(api), 'stopped')
      } else {
        supervisor = await start()
        assert.deepEqual(launched, ['api-v4', 'test-web'])
        assert.equal(await probe(web), 'external-web')
      }
    } finally {
      await supervisor?.stop()
      await rm(directory, { recursive: true, force: true })
    }
  }
})
