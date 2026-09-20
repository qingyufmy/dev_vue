export interface ReviewRecoveryCandidate { jobId: string; fencingToken: string }
export interface ReviewRecoverySource { listDue(afterId: string | null, limit: number): Promise<ReviewRecoveryCandidate[]> }
export interface ReviewRecoveryPublisher { wake(candidate: ReviewRecoveryCandidate): Promise<void> }

/** Bounded keyset sweeps; claiming and fencing remain authoritative in the worker. */
export class ReviewRecovery {
  private cursor: string | null = null
  private pending: Promise<void> | null = null
  private stopped = false
  constructor(private readonly source: ReviewRecoverySource, private readonly publisher: ReviewRecoveryPublisher) {}
  tick(): Promise<void> {
    if (this.stopped) return Promise.resolve()
    if (this.pending) return this.pending
    this.pending = this.sweep().finally(() => { this.pending = null })
    return this.pending
  }
  async stop() { this.stopped = true; await this.pending }
  private async sweep() {
    const rows = await this.source.listDue(this.cursor, 100)
    let firstError: unknown
    for (const row of rows) {
      if (this.stopped) break
      try { await this.publisher.wake(row) } catch (error) { firstError ??= error }
      this.cursor = row.jobId
    }
    if (rows.length < 100) this.cursor = null
    if (firstError) throw firstError
  }
}
