import type { AnalysisRun } from '../domain/inference.js'

export interface AnalysisWindowGuard {
  assertAllowed(run: AnalysisRun, now: Date): Promise<void>
}
