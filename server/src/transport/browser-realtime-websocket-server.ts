import type { IncomingMessage, Server as HttpServer } from 'node:http'
import type { Duplex } from 'node:stream'
import { WebSocket, WebSocketServer, type RawData } from 'ws'
import type { RealtimeTicketClaims } from '../modules/auth/index.js'
import type { BrowserRealtimeSessions, BrowserRealtimeSink } from '../modules/trading/index.js'

const REALTIME_PATH = '/realtime/v4'
const REALTIME_PROTOCOL = 'aurum.realtime.v4'
const MAX_UPSTREAM_FRAME_BYTES = 16 * 1024
const MAX_DOWNSTREAM_FRAME_BYTES = 64 * 1024
const MAX_BUFFERED_BYTES = 1024 * 1024
const MAX_PENDING_MESSAGES = 8
const HEARTBEAT_INTERVAL_MS = 25_000

export interface BrowserRealtimeTicketConsumer {
  consume(rawTicket: string): Promise<RealtimeTicketClaims | null>
}

export class BrowserRealtimeWebSocketServer {
  private readonly expectedHost: string
  private readonly expectedOrigin: string
  private readonly ticketCookieName: string
  private readonly webSockets = new WebSocketServer({
    noServer: true,
    maxPayload: MAX_UPSTREAM_FRAME_BYTES,
    perMessageDeflate: false,
    handleProtocols: protocols => protocols.has(REALTIME_PROTOCOL) ? REALTIME_PROTOCOL : false,
  })
  private accepting = false
  private readonly upgrade = (request: IncomingMessage, socket: Duplex, head: Buffer) => {
    void this.handleUpgrade(request, socket, head)
  }

  constructor(
    private readonly server: HttpServer,
    private readonly tickets: BrowserRealtimeTicketConsumer,
    private readonly sessions: BrowserRealtimeSessions,
    tradeOrigin: string,
    secureCookies = true,
  ) {
    const origin = new URL(tradeOrigin)
    this.expectedOrigin = origin.origin
    this.expectedHost = origin.host.toLowerCase()
    this.ticketCookieName = secureCookies ? '__Secure-Http-realtime_ticket' : 'aurum_dev_realtime_ticket'
  }

  start() {
    if (this.accepting) return
    this.accepting = true
    this.server.on('upgrade', this.upgrade)
  }

  async close() {
    if (!this.accepting) return
    this.accepting = false
    this.server.off('upgrade', this.upgrade)
    for (const socket of this.webSockets.clients) socket.close(1012, 'browser_realtime_restart')
    await new Promise<void>(resolve => {
      const force = setTimeout(() => {
        for (const socket of this.webSockets.clients) socket.terminate()
      }, 1_000)
      force.unref?.()
      this.webSockets.close(() => { clearTimeout(force); resolve() })
    })
  }

  connectionCount() { return this.webSockets.clients.size }

  private async handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer) {
    let url: URL
    try { url = new URL(request.url ?? '/', this.expectedOrigin) }
    catch { return reject(socket, 400, 'realtime_request_invalid') }
    if (!this.accepting || url.pathname !== REALTIME_PATH) return reject(socket, 404, 'not_found')
    if (url.search || url.hash) return reject(socket, 400, 'realtime_query_forbidden')
    if (String(request.headers.host ?? '').toLowerCase() !== this.expectedHost) return reject(socket, 403, 'realtime_host_forbidden')
    if (request.headers.origin !== this.expectedOrigin) return reject(socket, 403, 'realtime_origin_forbidden')
    if (request.headers['sec-websocket-protocol'] !== REALTIME_PROTOCOL) return reject(socket, 400, 'realtime_protocol_required')
    const ticket = cookieValue(request.headers.cookie, this.ticketCookieName)
    if (!ticket || !/^rt_[A-Za-z0-9_-]{43}$/.test(ticket)) return reject(socket, 401, 'realtime_ticket_required')

    socket.pause()
    let claims: RealtimeTicketClaims | null = null
    try { claims = await this.tickets.consume(ticket) }
    catch { return reject(socket, 503, 'realtime_auth_unavailable') }
    if (!claims) return reject(socket, 401, 'realtime_ticket_invalid')
    if (socket.destroyed) return
    this.webSockets.handleUpgrade(request, socket, head, webSocket => {
      this.webSockets.emit('connection', webSocket, request)
      this.bind(webSocket, claims!)
    })
    socket.resume()
  }

  private bind(socket: WebSocket, claims: RealtimeTicketClaims) {
    let pending = 0
    let chain = Promise.resolve()
    let alive = true
    const sink: BrowserRealtimeSink = {
      send: message => {
        if (socket.readyState !== WebSocket.OPEN) return
        const payload = JSON.stringify(message)
        const bytes = Buffer.byteLength(payload)
        if (bytes > MAX_DOWNSTREAM_FRAME_BYTES) return socket.close(1009, 'realtime_message_too_large')
        if (socket.bufferedAmount + bytes > MAX_BUFFERED_BYTES) return socket.close(4008, 'realtime_slow_consumer')
        socket.send(payload)
      },
      close: (code, reason) => socket.close(normalizeCloseCode(code), reason.slice(0, 123)),
    }
    const session = this.sessions.open(claims.userId, sink)
    sink.send({
      v: 4,
      type: 'system.welcome',
      occurred_at: new Date().toISOString(),
      session: { user_id: String(claims.userId), client_id: claims.clientId },
      limits: { upstream_frame_bytes: MAX_UPSTREAM_FRAME_BYTES, downstream_frame_bytes: MAX_DOWNSTREAM_FRAME_BYTES },
    })
    const heartbeat = setInterval(() => {
      if (!alive) return socket.terminate()
      alive = false
      socket.ping()
      sink.send({ v: 4, type: 'system.heartbeat', occurred_at: new Date().toISOString() })
    }, HEARTBEAT_INTERVAL_MS)
    heartbeat.unref?.()
    socket.on('pong', () => { alive = true; void session.heartbeat?.().catch(() => socket.close(1011, 'market_subscription_unavailable')) })
    socket.on('message', (data, isBinary) => {
      if (isBinary || bytes(data) > MAX_UPSTREAM_FRAME_BYTES) return socket.close(1009, 'realtime_message_too_large')
      if (pending >= MAX_PENDING_MESSAGES) return socket.close(4008, 'realtime_slow_consumer')
      pending += 1
      chain = chain.then(async () => session.receive(parseMessage(data)))
        .catch(() => socket.close(4400, 'realtime_message_invalid'))
        .finally(() => { pending -= 1 })
    })
    socket.once('close', () => { clearInterval(heartbeat); session.close() })
    socket.once('error', () => { clearInterval(heartbeat); session.close() })
  }
}

function cookieValue(header: string | undefined, name: string) {
  for (const item of String(header ?? '').split(';')) {
    const index = item.indexOf('=')
    if (index <= 0 || item.slice(0, index).trim() !== name) continue
    try { return decodeURIComponent(item.slice(index + 1).trim()) }
    catch { return null }
  }
  return null
}

function parseMessage(data: RawData): unknown {
  const raw = Buffer.isBuffer(data) ? data.toString('utf8') : Buffer.from(data as ArrayBuffer).toString('utf8')
  return JSON.parse(raw)
}

function bytes(data: RawData) {
  if (Buffer.isBuffer(data)) return data.byteLength
  if (Array.isArray(data)) return data.reduce((total, value) => total + value.byteLength, 0)
  return data.byteLength
}

function normalizeCloseCode(code: number) {
  if (code === 4403) return 4003
  return code >= 4000 && code <= 4999 ? code : 4003
}

function reject(socket: Duplex, status: number, code: string) {
  const statusText = status === 401 ? 'Unauthorized' : status === 403 ? 'Forbidden'
    : status === 404 ? 'Not Found' : status === 503 ? 'Service Unavailable' : 'Bad Request'
  const body = JSON.stringify({ code })
  socket.end(`HTTP/1.1 ${status} ${statusText}\r\nConnection: close\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`)
}
