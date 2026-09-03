export class AsyncPollLoop {
  private stopped = true
  private timer: NodeJS.Timeout | null = null
  private current: Promise<void> | null = null

  constructor(private readonly work: () => Promise<void>, private readonly intervalMs: number) {
    if (!Number.isSafeInteger(intervalMs) || intervalMs < 10) throw new Error('poll_interval_invalid')
  }

  start() {
    if (!this.stopped) return
    this.stopped = false
    this.schedule(0)
  }

  async stop() {
    this.stopped = true
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    await this.current
  }

  private schedule(delay: number) {
    if (this.stopped) return
    this.timer = setTimeout(() => {
      this.current = this.work().finally(() => {
        this.current = null
        this.schedule(this.intervalMs)
      })
    }, delay)
    this.timer.unref?.()
  }
}
