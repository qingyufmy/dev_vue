/** Re-enqueue unfinished qualification/preparation. Command dispatch and uncertain-result reconciliation have their own owners. */
export interface PartialCloseWorkflowRecovery {
  schedule(limit: number): Promise<number>
}
