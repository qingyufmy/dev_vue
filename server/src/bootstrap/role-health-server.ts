import { createServer, type Server } from 'node:http'

export interface RoleHealthSnapshot {
  role: string
  accepting: boolean
  ready: boolean
  startedAt: string
  lastWorkAt: string | null
  lastErrorCode: string | null
}

export class RoleHealth {
  private accepting = false
  private ready = false
  private readonly startedAt = new Date().toISOString()
  private lastWorkAt: string | null = null
  private lastErrorCode: string | null = null

  constructor(readonly role: string) {}

  setAccepting(value: boolean) { this.accepting = value }
  setReady(value: boolean) { this.ready = value }
  workSucceeded(now = new Date()) { this.lastWorkAt = now.toISOString(); this.lastErrorCode = null }
  workFailed(code: string) { this.lastErrorCode = code }
  snapshot(): RoleHealthSnapshot {
    return { role: this.role, accepting: this.accepting, ready: this.ready, startedAt: this.startedAt,
      lastWorkAt: this.lastWorkAt, lastErrorCode: this.lastErrorCode }
  }
}

export async function startRoleHealthServer(input: {
  host: string
  port: number
  health: RoleHealth
  dependencyReady: () => Promise<boolean>
}) {
  const server = createServer(async (request, response) => {
    if (request.method !== 'GET' || (request.url !== '/health/live' && request.url !== '/health/ready')) {
      response.writeHead(404, { 'content-type': 'application/json' }).end('{"status":"not_found"}')
      return
    }
    const live = request.url === '/health/live'
    const dependencyReady = live ? true : await input.dependencyReady().catch(() => false)
    const snapshot = input.health.snapshot()
    const ok = live || snapshot.accepting && snapshot.ready && dependencyReady
    response.writeHead(ok ? 200 : 503, { 'content-type': 'application/json', 'cache-control': 'no-store' })
      .end(JSON.stringify({ status: ok ? 'ok' : 'not_ready', ...snapshot, dependencies_ready: dependencyReady }))
  })
  await listen(server, input.port, input.host)
  return server
}

export async function closeHttpServer(server: Server | null) {
  if (!server?.listening) return
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
}

function listen(server: Server, port: number, host: string) {
  return new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => { server.off('listening', onListening); reject(error) }
    const onListening = () => { server.off('error', onError); resolve() }
    server.once('error', onError)
    server.once('listening', onListening)
    server.listen(port, host)
  })
}
