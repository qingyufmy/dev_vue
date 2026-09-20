import type { IncomingMessage, Server as HttpServer } from 'node:http'
import type { Duplex } from 'node:stream'
import { WebSocket, WebSocketServer, type RawData } from 'ws'
import type { BridgeGatewaySink, BridgeSessionHelloEnvelope } from '../modules/bridge/index.js'

interface BridgeGatewaySessionLike {
  receive(message: unknown): Promise<unknown>
  close(reason?: string): Promise<void>
}

export interface BridgeGatewayOpener {
  open(input: { ticket: string; hello: BridgeSessionHelloEnvelope; sink: BridgeGatewaySink }): Promise<BridgeGatewaySessionLike>
}

const MAX_FRAME_BYTES = 512 * 1024
// A market refresh may send multiple candles for each of seven periods at once.
const MAX_PENDING_MESSAGES = 64
const MAX_PENDING_BYTES = 4 * 1024 * 1024
const HELLO_TIMEOUT_MS = 10_000

export class BridgeV4WebSocketServer {
  private readonly webSockets = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME_BYTES, perMessageDeflate: false })
  private accepting = false
  private readonly upgrade = (request: IncomingMessage, socket: Duplex, head: Buffer) => this.handleUpgrade(request, socket, head)

  constructor(private readonly server: HttpServer, private readonly gateway: BridgeGatewayOpener,
    private readonly reportRejection: (code: string, storageCode?: string) => void = () => undefined) {}

  start() {
    if (this.accepting) return
    this.accepting = true
    this.server.on('upgrade', this.upgrade)
  }

  async close() {
    if (!this.accepting) return
    this.accepting = false
    this.server.off('upgrade', this.upgrade)
    for (const socket of this.webSockets.clients) socket.close(1012, 'bridge_gateway_restart')
    await new Promise<void>(resolve => {
      const force = setTimeout(() => {
        for (const socket of this.webSockets.clients) socket.terminate()
      }, 1_000)
      force.unref?.()
      this.webSockets.close(() => { clearTimeout(force); resolve() })
    })
  }

  connectionCount() { return this.webSockets.clients.size }

  private handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer) {
    let url: URL
    try { url = new URL(request.url ?? '/', 'http://bridge.local') }
    catch { return reject(socket, 400, 'invalid_request') }
    if (!this.accepting || url.pathname !== '/bridge/v4/ws') return reject(socket, 404, 'not_found')
    if (url.search !== '') return reject(socket, 400, 'query_credentials_forbidden')
    const ticket = bearer(request.headers.authorization)
    if (!ticket) return reject(socket, 401, 'bridge_session_token_required')
    this.webSockets.handleUpgrade(request, socket, head, webSocket => {
      this.webSockets.emit('connection', webSocket, request)
      this.bind(webSocket, ticket)
    })
  }

  private bind(socket: WebSocket, ticket: string) {
    let session: BridgeGatewaySessionLike | null = null
    let pending = 0
    let pendingBytes = 0
    let chain = Promise.resolve()
    let closed = false
    const helloTimer = setTimeout(() => socket.close(4408, 'bridge_session_hello_timeout'), HELLO_TIMEOUT_MS)
    helloTimer.unref?.()
    const sink: BridgeGatewaySink = {
      send: message => new Promise<void>((resolve, rejectSend) => {
        if (socket.readyState !== WebSocket.OPEN) return rejectSend(new Error('bridge_socket_not_open'))
        socket.send(JSON.stringify(message), error => error ? rejectSend(error) : resolve())
      }),
      close: (code, reason) => socket.close(code, reason.slice(0, 123)),
    }
    const closeSession = async (reason: string) => {
      if (closed) return
      closed = true
      clearTimeout(helloTimer)
      await session?.close(reason).catch(() => undefined)
    }
    socket.on('message', (data, isBinary) => {
      if (closed || socket.readyState !== WebSocket.OPEN) return
      const frameBytes = bytes(data)
      if (isBinary || frameBytes > MAX_FRAME_BYTES || pending >= MAX_PENDING_MESSAGES || pendingBytes + frameBytes > MAX_PENDING_BYTES) {
        const code = isBinary ? 'bridge_binary_unsupported' : 'bridge_message_backpressure'
        this.reportRejection(code)
        socket.close(4400, code)
        return
      }
      pending += 1
      pendingBytes += frameBytes
      chain = chain.then(async () => {
        if (closed || socket.readyState !== WebSocket.OPEN) return
        const message = parseMessage(data)
        if (!session) {
          if (!isHello(message)) throw new Error('bridge_session_hello_required')
          const opened = await this.gateway.open({ ticket, hello: message as BridgeSessionHelloEnvelope, sink })
          if (closed || socket.readyState !== WebSocket.OPEN) {
            await opened.close('bridge_socket_closed_during_open')
            return
          }
          session = opened
          clearTimeout(helloTimer)
          return
        }
        await session.receive(message)
      }).catch(error => {
        if (closed || socket.readyState !== WebSocket.OPEN) return
        const storageCode = error instanceof Error && error.cause && typeof error.cause === 'object'
          && 'code' in error.cause ? String(error.cause.code) : ''
        this.reportRejection(publicCode(error), /^ER_[A-Z0-9_]{1,80}$/.test(storageCode) ? storageCode : undefined)
        socket.close(closeCode(error), publicCode(error))
      }).finally(() => { pending -= 1; pendingBytes -= frameBytes })
    })
    socket.once('close', () => { void closeSession('bridge_socket_closed') })
    socket.once('error', () => { void closeSession('bridge_socket_error') })
  }
}

function bearer(value: string | undefined) {
  if (!value) return null
  const match = /^Bearer ([A-Za-z0-9_-]{40,128})$/.exec(value)
  return match?.[1] ?? null
}

function parseMessage(data: RawData): unknown {
  try { return JSON.parse(Buffer.isBuffer(data) ? data.toString('utf8') : Buffer.from(data as ArrayBuffer).toString('utf8')) }
  catch { throw new Error('bridge_message_json_invalid') }
}

function bytes(data: RawData) {
  if (Buffer.isBuffer(data)) return data.byteLength
  if (Array.isArray(data)) return data.reduce((total, value) => total + value.byteLength, 0)
  return data.byteLength
}

function isHello(value: unknown) {
  return Boolean(value && typeof value === 'object' && (value as { type?: unknown }).type === 'session.hello')
}

function closeCode(error: unknown) {
  const status = typeof error === 'object' && error && 'status' in error ? Number((error as { status: unknown }).status) : 400
  if (status === 401) return 4401
  if (status === 403) return 4403
  if (status === 409) return 4409
  if (status === 429) return 4429
  return status >= 500 ? 4503 : 4400
}

function publicCode(error: unknown) {
  const message = error instanceof Error ? error.message : 'bridge_gateway_error'
  return /^[a-z0-9_]{3,123}$/.test(message) ? message : 'bridge_gateway_error'
}

function reject(socket: Duplex, status: number, code: string) {
  const statusText = status === 401 ? 'Unauthorized' : status === 404 ? 'Not Found' : 'Bad Request'
  const body = JSON.stringify({ code })
  socket.end(`HTTP/1.1 ${status} ${statusText}\r\nConnection: close\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`)
}
