export interface ExecutedDealOriginScope {
  userId: number
  accountId: string
  terminalInstanceId: string
  brokerServer: string
  login: string
  connectionEpoch: number
  deals: Array<{ ticket: string; orderTicket: string; positionId: string; occurredAtUtcMsc: number }>
}
export interface ExecutedDealOrigin {
  dealTicket: string
  orderTicket: string
  commandId: string
  intentId: string
  action: 'order.place' | 'position.close'
  resultHash: string
  decisionId: string
  riskDecisionId: string
  strategyId: string
  strategyVersionId: string
}
/** Exact successful system-command receipts only; absence is not proof of manual or other-EA origin. */
export interface ExecutedDealOriginReader {
  read(scope: ExecutedDealOriginScope): Promise<ExecutedDealOrigin[]>
}
