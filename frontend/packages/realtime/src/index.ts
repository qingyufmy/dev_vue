export interface RealtimeConnectionOptions {
  url: string
  protocol: string
  WebSocketImpl?: typeof WebSocket
  onOpen(socket: WebSocket): void
  onMessage(value: unknown): void
  onClose(event: CloseEvent): void
  onError?(): void
}

export function connectRealtime(options: RealtimeConnectionOptions) {
  const Socket = options.WebSocketImpl ?? globalThis.WebSocket
  const socket = new Socket(options.url, options.protocol)
  socket.addEventListener('open', () => options.onOpen(socket))
  socket.addEventListener('message', (event) => {
    try { options.onMessage(JSON.parse(String(event.data)) as unknown) }
    catch { options.onError?.() }
  })
  socket.addEventListener('close', options.onClose)
  socket.addEventListener('error', () => options.onError?.())
  return { socket, close: (code = 1000, reason = 'client_closed') => socket.close(code, reason) }
}
