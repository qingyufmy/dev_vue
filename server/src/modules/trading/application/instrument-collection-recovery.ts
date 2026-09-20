/** Re-enqueue stale durable requests; never performs terminal I/O or changes a lease. */
export interface InstrumentCollectionRecovery {
  schedule(limit: number): Promise<number>
}
