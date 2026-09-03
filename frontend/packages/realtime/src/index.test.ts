import { describe, expect, it, vi } from 'vitest'
import { connectRealtime } from './index'

class FakeWebSocket extends EventTarget {
  static last: FakeWebSocket
  sent: string[] = []
  constructor(readonly url: string, readonly protocol: string) { super(); FakeWebSocket.last = this }
  send(value: string) { this.sent.push(value) }
  close(code = 1000, reason = '') { this.dispatchEvent(new CloseEvent('close', { code, reason })) }
}

describe('connectRealtime', () => {
  it('owns WebSocket creation and parses messages outside application packages', () => {
    const onMessage = vi.fn(); const onOpen = vi.fn()
    connectRealtime({ url: 'ws://localhost/realtime/v4', protocol: 'aurum.realtime.v4', WebSocketImpl: FakeWebSocket as unknown as typeof WebSocket, onOpen, onMessage, onClose() {} })
    FakeWebSocket.last.dispatchEvent(new Event('open'))
    FakeWebSocket.last.dispatchEvent(new MessageEvent('message', { data: '{"v":4}' }))
    expect(onOpen).toHaveBeenCalledOnce(); expect(onMessage).toHaveBeenCalledWith({ v: 4 })
  })
})
