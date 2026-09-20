import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { createConnection } from 'node:net'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { mkdir, writeFile, readFile, rm, appendFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { restartAllowed } from './local-v4-roles.mjs'

export async function probe(role) {
  const addresses = role.web ? ['127.0.0.1', '::1'] : ['127.0.0.1']
  for (const host of addresses) {
  const occupied = await new Promise(resolveProbe => {
    const socket = createConnection({ host, port: role.port })
    let settled = false
    const done = value => { if (!settled) { settled = true; socket.destroy(); resolveProbe(value) } }
    socket.setTimeout(750, () => done(false))
    socket.on('connect', () => done(true)); socket.on('error', () => done(false))
  })
  if (!occupied) continue
  try {
    const response = await fetch(`http://${host === '::1' ? '[::1]' : host}:${role.port}${role.web ? '/' : '/health/ready'}`, { signal: AbortSignal.timeout(3000) })
    if (role.web) return response.ok ? 'external-web' : 'conflict'
    const data = await response.json()
    if (data.role !== role.id) return 'conflict'
    return response.ok && data.ready && data.dependencies_ready !== false ? (data.lastErrorCode ? 'degraded' : 'ready') : 'unready'
  } catch { return 'conflict' }
  }
  return 'stopped'
}

export async function runSupervisor({ root, directory, roles, profile = 'custom', controlPort = 3040, commandFor, log = console.log, readinessTimeoutMs = 30000 }) {
  await mkdir(directory, { recursive: true })
  const token = randomBytes(32).toString('hex'), statePath = resolve(directory, 'controller.json')
  const children = new Map(), reused = new Set(), failures = new Map(), timers = new Set()
  let stopping = false
  const controller = createServer(async (req, res) => {
    const supplied = Buffer.from(req.headers.authorization || ''), expected = Buffer.from(`Bearer ${token}`)
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) { res.writeHead(403).end(); return }
    if (req.url === '/status' && req.method === 'GET') {
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ root, pid: process.pid, profile, selected: roles.map(role => role.id), owned: [...children.keys()], reused: [...reused], failures: [...failures.keys()] }))
    } else if (req.url === '/stop' && req.method === 'POST') { res.end('stopping'); void stop() }
    else res.writeHead(404).end()
  })
  // Binding is the lock: concurrent starts cannot launch duplicate sets of workers.
  await new Promise((resolveListen, reject) => { controller.once('error', reject); controller.listen(controlPort, '127.0.0.1', resolveListen) })
  const actualPort = controller.address().port
  try { await writeFile(statePath, JSON.stringify({ root, port: actualPort, token }), { mode: 0o600 }) }
  catch (error) { controller.close(); throw error }
  function timer(fn, ms) { const value = setTimeout(() => { timers.delete(value); void fn() }, ms); timers.add(value) }
  function launch(role, exits = []) {
    if (stopping) return
    const command = commandFor(role)
    const child = spawn(command.file, command.args, { cwd: root, env: command.env || process.env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] })
    children.set(role.id, child)
    log(`[${role.label}] 启动 PID ${child.pid ?? '--'}`)
    let writes = Promise.resolve()
    const output = chunk => {
      process.stdout.write(`[${role.id}] ${chunk}`)
      // Each file is append-only within this run; avoid concurrent append reordering.
      writes = writes.then(() => appendFile(resolve(directory, `${role.id}.log`), chunk)).catch(() => log(`[${role.id}] 日志写入失败`))
    }
    child.stdout.on('data', output); child.stderr.on('data', output)
    child.on('error', error => log(`[${role.id}] 启动失败 ${error.code || 'spawn_error'}`))
    child.once('close', code => {
      children.delete(role.id)
      if (stopping) return
      const recent = [...exits.filter(at => Date.now() - at < 300_000), Date.now()]
      log(`[${role.id}] 已退出 code=${code}`)
      if (!restartAllowed(recent)) { failures.set(role.id, true); log(`[${role.id}] 5 分钟内退出 3 次，停止重启，请检查日志`); return }
      timer(async () => {
        if (await probe(role) !== 'stopped') { failures.set(role.id, true); log(`[${role.id}] 端口已占用，停止重启`); return }
        launch(role, recent)
      }, 2000)
    })
  }
  let stopPromise
  function stop() {
    return stopPromise ??= (async () => {
      stopping = true
      for (const value of timers) clearTimeout(value)
      // Only this controller's child objects are addressed; each role drains itself.
      await Promise.all([...children.values()].reverse().map(child => new Promise(resolveStop => {
        if (child.exitCode !== null) { resolveStop(); return }
        const deadline = setTimeout(() => { child.kill(); }, 15000)
        child.once('close', () => { clearTimeout(deadline); resolveStop() })
        if (child.connected) child.send('local-v4-stop', () => {})
        else child.kill()
      })))
      await new Promise(resolveClose => controller.close(resolveClose))
      const state = JSON.parse(await readFile(statePath, 'utf8').catch(() => '{}'))
      if (state.token === token) await rm(statePath, { force: true })
      process.off('SIGINT', onSignal); process.off('SIGTERM', onSignal)
      log('本控制台管理的服务已停止；外部实例未停止。')
    })()
  }
  const onSignal = () => { void stop() }
  process.on('SIGINT', onSignal); process.on('SIGTERM', onSignal)
  async function waitReady(role) {
    const deadline = Date.now() + readinessTimeoutMs
    while (!stopping && Date.now() < deadline) {
      const state = await probe(role)
      if (['ready', 'degraded', 'external-web'].includes(state)) return
      if (failures.has(role.id)) throw new Error(`${role.label} 启动失败，请检查日志`)
      await new Promise(done => setTimeout(done, 100))
    }
    throw new Error(`${role.label} 未在启动期限内就绪，请检查日志`)
  }
  try {
    // Complete preflight before starting anything. Unknown occupied ports fail closed.
    for (const role of roles) {
      const status = await probe(role)
      if (['conflict', 'unready'].includes(status)) throw new Error(`${role.id}: port ${role.port} ${status}`)
      if (status !== 'stopped') { reused.add(role.id); log(`[${role.label}] ${role.port} 外部实例 ${status}，不接管`) }
    }
    const api = roles.find(role => role.id === 'api-v4')
    for (const role of roles) {
      if (reused.has(role.id)) continue
      if (role.web && api) {
        log(`[${role.label}] 等待接口就绪后启动`)
        await waitReady(api)
      }
      launch(role)
    }
    await Promise.all(roles.map(waitReady))
    log(`所选服务已完成启动检查。使用 status 检查健康，stop 优雅停止。控制端口 ${actualPort}。`)
    timer(async function statusTick() {
      if (stopping) return
      const values = await Promise.all(roles.map(async role => {
        const state = await probe(role)
        return `${role.label}=${state === 'stopped' && children.has(role.id) ? '进程运行，端口未就绪' : state}`
      }))
      log(values.join(' | ')); timer(statusTick, 30000)
    }, 3000)
  } catch (error) { await stop(); throw error }
  return { stop, port: actualPort, token }
}
