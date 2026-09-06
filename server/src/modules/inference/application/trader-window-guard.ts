import type { TraderRun } from '../domain/inference.js'

export interface TraderWindowGuard {
  assertAllowed(run: TraderRun, now: Date): Promise<string>
}
