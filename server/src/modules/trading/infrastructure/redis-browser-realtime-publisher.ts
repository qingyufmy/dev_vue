import type { Redis } from 'ioredis'
import type { BrowserRealtimePublisher, TradingRealtimeEvent } from '../application/trading-ports.js'
import { BROWSER_REALTIME_EVENT_CHANNEL } from './redis-browser-realtime-subscriber.js'

export class RedisBrowserRealtimePublisher implements BrowserRealtimePublisher {
  constructor(
    private readonly redis: Redis,
    private readonly channel = BROWSER_REALTIME_EVENT_CHANNEL,
    private readonly onError: (error: unknown) => void = () => undefined,
  ) {}

  publish(event: TradingRealtimeEvent) {
    // Projection persistence is authoritative. Realtime delivery is recoverable
    // from revisions, so Redis failure must not roll back a committed snapshot.
    void this.redis.publish(this.channel, JSON.stringify(event)).catch(this.onError)
  }
}
