import type { PoolConnection } from 'mysql2/promise'
import type { BridgeGatewayRoute } from '../modules/bridge/index.js'
import type { ExecutionAccountReader, ExecutionQuoteReader, ExecutionPositionCollectionReader, ExecutionInstrumentReader } from '../modules/trading/index.js'
import { createMysqlExecutionAccountReader,createMysqlExecutionQuoteReader,createMysqlExecutionPositionCollectionReader,
  createMysqlExecutionInstrumentReader,createTransactionTerminalFactRouteGuard } from '../modules/trading/composition.js'
import { createPositionProtectionReviewer, type PositionProtectionRiskContext, type PositionProtectionRiskRequest, type PositionProtectionSummaryReader, type RiskDispatchPolicyReader } from '../modules/risk/index.js'
import { createMysqlPositionProtectionClock,createMysqlPositionProtectionSummaryReader,createTransactionRiskPolicyReader } from '../modules/risk/composition.js'

interface Facts {
  accounts:ExecutionAccountReader;positions:ExecutionPositionCollectionReader;quotes:ExecutionQuoteReader;instruments:ExecutionInstrumentReader
  summaries:PositionProtectionSummaryReader;policies:RiskDispatchPolicyReader
}
export interface PositionProtectionReadLimits { readonly maxAgeMs:number; readonly maxInstrumentAgeMs:number }
export interface PositionManagementContextReader {
  read(scope: Pick<PositionProtectionRiskRequest, 'userId' | 'accountId' | 'target'>): Promise<(PositionProtectionRiskContext & {
    instrument: PositionProtectionRiskContext['instrument'] & { volumeMin?: string; volumeMax?: string; volumeStep?: string }
  }) | null>
}
/** Route was captured before the transaction. Fact ports must all retain locks on the caller connection. */
export function createPositionManagementContextReader(facts:Facts,sourceRoute:BridgeGatewayRoute,limits:PositionProtectionReadLimits):PositionManagementContextReader {
  const route=structuredClone(sourceRoute),bounds=structuredClone(limits)
  if (!Number.isSafeInteger(bounds.maxAgeMs) || bounds.maxAgeMs<1 || bounds.maxAgeMs>60000
    || !Number.isSafeInteger(bounds.maxInstrumentAgeMs) || bounds.maxInstrumentAgeMs<1 || bounds.maxInstrumentAgeMs>300000) throw Error('position_protection_read_limits_invalid')
  return {async read(input){
    const request=structuredClone(input),target=request.target
    if (route.platform!=='mt5' || route.userId!==request.userId || route.accountId!==request.accountId
      || route.terminalInstanceId!==target.terminalInstanceId || route.brokerServer!==target.brokerServer || route.login!==target.login) return null
    const account=await facts.accounts.read({route:structuredClone(route),maxAgeMs:bounds.maxAgeMs})
    if (!account || account.accountId!==request.accountId) return null
    const policy=await facts.policies.getEffectivePolicy(request.userId,request.accountId)
    const positions=await facts.positions.read({route:structuredClone(route),maxAgeMs:Math.min(bounds.maxAgeMs,policy.values.maxRiskSummaryAgeSeconds*1000)})
    if (!positions || positions.accountId!==request.accountId) return null
    const matches=positions.positions.filter(position=>position.ticket===target.ticket || position.positionIdentifier===target.positionIdentifier)
    const position=matches[0]
    if (matches.length!==1 || !position || position.positionIdentifier===null || position.stopLoss===undefined || position.takeProfit===undefined) return null
    const quote=await facts.quotes.read({route:structuredClone(route),symbol:target.symbol,maxAgeMs:Math.min(bounds.maxAgeMs,policy.values.maxQuoteAgeSeconds*1000)})
    const instrument=await facts.instruments.read({route:structuredClone(route),symbol:target.symbol,maxAgeMs:bounds.maxAgeMs,maxInstrumentAgeMs:bounds.maxInstrumentAgeMs})
    if (!quote || quote.accountId!==request.accountId || !instrument || instrument.accountId!==request.accountId) return null
    const summary=await facts.summaries.read(request.userId,request.accountId)
    if (!summary || summary.clockStatus!==account.account.clockStatus || summary.terminalTimezoneOffsetMinutes!==account.account.timezoneOffsetMinutes) return null
    return {userId:route.userId,accountId:route.accountId,authorized:true,connectionPaused:false,tradePermission:account.account.tradePermission,
      accountObservedAt:account.account.observedAt,collectionComplete:true,policy,summary,quote,
      instrument:{symbol:instrument.symbol,point:instrument.point,tickSize:instrument.tickSize,tradeEnabled:instrument.tradeEnabled,
        ...(instrument.volumeMin === undefined ? {} : { volumeMin:instrument.volumeMin }),
        ...(instrument.volumeMax === undefined ? {} : { volumeMax:instrument.volumeMax }),
        ...(instrument.volumeStep === undefined ? {} : { volumeStep:instrument.volumeStep }),
        revision:instrument.revision,observedAt:instrument.observedAt,maxAgeMs:bounds.maxInstrumentAgeMs},
      position:{terminalInstanceId:route.terminalInstanceId,brokerServer:route.brokerServer,login:route.login,
        ticket:position.ticket,positionIdentifier:position.positionIdentifier,symbol:position.symbol,side:position.side,volume:position.volume,
        stopLoss:position.stopLoss,takeProfit:position.takeProfit,revision:positions.revision,observedAt:positions.observedAt},
      revisions:{account:account.account.revision,positions:positions.revision,quote:quote.revision,contract:instrument.revision,risk:summary.revision}}
  }}
}

export const createPositionProtectionContextReader = createPositionManagementContextReader

export function createTransactionPositionManagementContextReader(connection:PoolConnection,route:BridgeGatewayRoute,limits:PositionProtectionReadLimits){
  const guard=createTransactionTerminalFactRouteGuard(connection)
  return createPositionManagementContextReader({accounts:createMysqlExecutionAccountReader(connection,guard),
    positions:createMysqlExecutionPositionCollectionReader(connection,guard),quotes:createMysqlExecutionQuoteReader(connection,guard),
    instruments:createMysqlExecutionInstrumentReader(connection,guard),summaries:createMysqlPositionProtectionSummaryReader(connection),
    policies:createTransactionRiskPolicyReader(connection)},route,limits)
}

export function createTransactionPositionProtectionReviewer(connection:PoolConnection,route:BridgeGatewayRoute,limits:PositionProtectionReadLimits){
  return createPositionProtectionReviewer(createTransactionPositionManagementContextReader(connection,route,limits),createMysqlPositionProtectionClock(connection))
}
