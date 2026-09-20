/** Uses the caller's existing transaction; never commits or retries independently. */
export interface RiskDecisionExecutionWriter {
  linkOperation(input: {
    riskDecisionId: string
    userId: number
    accountId: string
    expectedRevision: number
    operationId: string
  }): Promise<boolean>
}
