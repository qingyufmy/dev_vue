import type { BrowserRealtimeEvent } from './trading-ports.js'
import type { ObserverInvalidation } from './observer-invalidation.js'

export interface BrowserRealtimeSink {
  send(message: unknown): void
  close(code: number, reason: string): void
}

export interface BrowserRealtimeConnection {
  receive(message: unknown): Promise<void>
  heartbeat?(): Promise<void>
  close(): void
}

export interface BrowserRealtimeSessions {
  open(userId: number, sink: BrowserRealtimeSink): BrowserRealtimeConnection
}

export interface BrowserRealtimePublication {
  publish(event: BrowserRealtimeEvent): void
  invalidateObserverAuthorization(control: ObserverInvalidation): void
}
