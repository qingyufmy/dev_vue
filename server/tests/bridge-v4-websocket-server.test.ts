import { createServer, type Server } from 'node:http'
import WebSocket from 'ws'
import { afterEach, describe, expect, it } from 'vitest'
import { BridgeV4WebSocketServer } from '../src/transport/bridge-v4-websocket-server.js'

const ticket = 'A'.repeat(48)
let httpServer: Server | null = null
let bridgeServer: BridgeV4WebSocketServer | null = null
const clients: WebSocket[] = []

afterEach(async () => {
  for (const client of clients.splice(0)) client.terminate()
  await bridgeServer?.close()
  bridgeServer = null
  if (httpServer?.listening) await new Promise<void>(resolve => httpServer!.close(() => resolve()))
  httpServer = null
})

describe('BridgeV4WebSocketServer', () => {
  it('accepts only a bearer ticket and requires session.hello before binding the gateway', async () => {
    const opened: unknown[] = []
    httpServer = createServer()
    bridgeServer = new BridgeV4WebSocketServer(httpServer, {
      open: async input => {
        opened.push(input.hello)
        await input.sink.send({ v: 4, type: 'session.welcome' })
        return { receive: async () => undefined, close: async () => undefined }
      },
    })
    bridgeServer.start()
    const port = await listen(httpServer)
    const client = new WebSocket(`ws://127.0.0.1:${port}/bridge/v4/ws`, { headers: { Authorization: `Bearer ${ticket}` } })
    clients.push(client)
    await openedSocket(client)
    client.send(JSON.stringify({ v: 4, type: 'session.hello', payload: {} }))
    await expect(nextMessage(client)).resolves.toMatchObject({ v: 4, type: 'session.welcome' })
    expect(opened).toHaveLength(1)
  })

  it('rejects query credentials before upgrading', async () => {
    httpServer = createServer()
    bridgeServer = new BridgeV4WebSocketServer(httpServer, { open: async () => { throw new Error('must_not_open') } })
    bridgeServer.start()
    const port = await listen(httpServer)
    const status = await rejectedStatus(new WebSocket(`ws://127.0.0.1:${port}/bridge/v4/ws?token=${ticket}`,
      { headers: { Authorization: `Bearer ${ticket}` } }))
    expect(status).toBe(400)
  })

  it('closes a socket that sends business data before session.hello', async () => {
    httpServer = createServer()
    bridgeServer = new BridgeV4WebSocketServer(httpServer, { open: async () => { throw new Error('must_not_open') } })
    bridgeServer.start()
    const port = await listen(httpServer)
    const client = new WebSocket(`ws://127.0.0.1:${port}/bridge/v4/ws`, { headers: { Authorization: `Bearer ${ticket}` } })
    clients.push(client)
    await openedSocket(client)
    client.send(JSON.stringify({ v: 4, type: 'command.result' }))
    await expect(closedSocket(client)).resolves.toMatchObject({ code: 4400, reason: 'bridge_session_hello_required' })
  })

  it('closes a session that finishes opening after the peer has already disconnected', async () => {
    let releaseOpen!: () => void
    const opening = new Promise<void>(resolve => { releaseOpen = resolve })
    let markStarted!: () => void
    const started = new Promise<void>(resolve => { markStarted = resolve })
    let closedReason: string | null = null
    httpServer = createServer()
    bridgeServer = new BridgeV4WebSocketServer(httpServer, {
      open: async () => {
        markStarted()
        await opening
        return { receive: async () => undefined, close: async reason => { closedReason = reason ?? null } }
      },
    })
    bridgeServer.start()
    const port = await listen(httpServer)
    const client = new WebSocket(`ws://127.0.0.1:${port}/bridge/v4/ws`, { headers: { Authorization: `Bearer ${ticket}` } })
    clients.push(client)
    await openedSocket(client)
    client.send(JSON.stringify({ v: 4, type: 'session.hello', payload: {} }))
    await started
    const clientClosed = closedSocket(client)
    client.close()
    await clientClosed
    releaseOpen()
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(closedReason).toBe('bridge_socket_closed_during_open')
  })
})

async function listen(server: Server) {
  await new Promise<void>((resolve, reject) => server.listen(0, '127.0.0.1', resolve).once('error', reject))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('listen_failed')
  return address.port
}
function openedSocket(socket: WebSocket) { return new Promise<void>((resolve, reject) => socket.once('open', resolve).once('error', reject)) }
function nextMessage(socket: WebSocket) { return new Promise<Record<string, unknown>>((resolve, reject) => socket.once('message', data => { try { resolve(JSON.parse(data.toString())) } catch (error) { reject(error) } }).once('error', reject)) }
function closedSocket(socket: WebSocket) { return new Promise<{ code: number; reason: string }>(resolve => socket.once('close', (code, reason) => resolve({ code, reason: reason.toString() }))) }
function rejectedStatus(socket: WebSocket) { return new Promise<number>((resolve, reject) => socket.once('unexpected-response', (_request, response) => { resolve(response.statusCode ?? 0); response.resume() }).once('error', reject)) }
