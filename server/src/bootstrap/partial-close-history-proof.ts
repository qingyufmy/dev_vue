import { partialCloseVolumeEquals } from '../modules/execution/index.js'
import type { PoolConnection } from 'mysql2/promise'
import type { BridgeGatewayRoute } from '../modules/bridge/index.js'
import type { PartialCloseHistoryProofReader, PartialCloseReceiptReader } from '../modules/execution/index.js'
import type { ClosedOrderHistoryReader } from '../modules/trade-history/index.js'
import { createMysqlPartialCloseReceiptReader } from '../modules/execution/composition.js'
import { createMysqlClosedOrderHistoryReader } from '../modules/trade-history/composition.js'
import { createTransactionTerminalFactRouteGuard } from '../modules/trading/composition.js'
import { TradingAccessError } from '../modules/trading/index.js'
import { sha256Canonical } from '../shared/canonical-json.js'

export function createPartialCloseHistoryProofReader(receipts:PartialCloseReceiptReader,history:ClosedOrderHistoryReader,
  sourceRoute:BridgeGatewayRoute):PartialCloseHistoryProofReader {
  const route=structuredClone(sourceRoute)
  return {async read(input){
    const plan=structuredClone(input),target=plan.target
    if(route.platform!=='mt5'||String(route.userId)!==target.userId||route.accountId!==target.accountId
      ||route.terminalInstanceId!==target.terminalInstanceId||route.brokerServer!==target.brokerServer||route.login!==target.login)return null
    const receipt=await receipts.read(plan)
    if(!receipt)return null
    if(receipt.parentIntentId!==plan.parentIntentId||receipt.parentCommandId!==plan.parentCommandId
      ||sha256Canonical(receipt.target)!==sha256Canonical(target)||receipt.connectionEpoch>route.connectionEpoch)throw Error('partial_close_history_receipt_mismatch')
    const facts=await history.read({route:structuredClone(route),orderTicket:receipt.orderTicket,receiptDealTickets:[...receipt.dealTickets],
      positionIdentifier:target.positionIdentifier,symbol:target.symbol,positionSide:target.side,expectedVolume:plan.closeVolume,
      issuedAtUtcMsc:receipt.issuedAt,completedAtUtcMsc:receipt.completedAt})
    if(facts.status!=='matched')return null
    if(!partialCloseVolumeEquals(facts.closedVolume,plan.closeVolume)||facts.orderTicket!==receipt.orderTicket||facts.positionIdentifier!==target.positionIdentifier
      ||facts.lastDealAtUtcMsc<receipt.issuedAt||facts.lastDealAtUtcMsc>receipt.completedAt
      ||receipt.dealTickets.some(ticket=>!facts.deals.some(deal=>deal.ticket===ticket)))throw Error('partial_close_history_facts_mismatch')
    const evidence={resultHash:receipt.resultHash,orderTicket:facts.orderTicket,taskId:facts.taskId,receiptId:facts.receiptId,
      completionHash:facts.completionHash,deals:structuredClone(facts.deals)}
    return {parentIntentId:plan.parentIntentId,parentCommandId:plan.parentCommandId,target:{...target},closedVolume:facts.closedVolume,
      completedAt:receipt.completedAt,evidence,evidenceHash:sha256Canonical(evidence)}
  }}
}

/** Caller retains this authorized transaction through eligibility/current-risk evaluation; no external I/O here. */
export function createTransactionPartialCloseHistoryProofReader(connection:PoolConnection,sourceRoute:BridgeGatewayRoute):PartialCloseHistoryProofReader {
  const route=structuredClone(sourceRoute),guard=createTransactionTerminalFactRouteGuard(connection)
  const reader=createPartialCloseHistoryProofReader(createMysqlPartialCloseReceiptReader(connection),createMysqlClosedOrderHistoryReader(connection),route)
  return {async read(plan){
    try{await guard.assert(route)}catch(error){
      if(error instanceof TradingAccessError&&error.code==='trading_context_invalid'&&error.status===403)return null
      throw error
    }
    return reader.read(plan)
  }}
}
