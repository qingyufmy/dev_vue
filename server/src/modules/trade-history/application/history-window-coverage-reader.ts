import type { HistoryTraversalScope } from './history-traversal-reader.js'
import type { HistoryTaskCoverageResult } from './history-task-coverage-reader.js'

/** Finds one completed task covering the entire requested window. Does not stitch unrelated snapshots. */
export interface HistoryWindowCoverageReader {
  read(scope: HistoryTraversalScope): Promise<HistoryTaskCoverageResult>
}
