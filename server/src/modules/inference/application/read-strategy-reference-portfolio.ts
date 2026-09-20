import { projectReferenceEntryEvidence } from './reference-entry-evidence.js'
import type { ReferencePositionEntryAnalyses } from './reference-position-entry-analyses.js'
import { matchesMarketSymbol } from '../../trading/index.js'
import type { StrategyObserverInventory } from '../../trading/index.js'
import type { AnalysisSource } from './analysis-source-reader.js'
import type { readReferencePendingCreation } from './reference-pending-creation.js'
import type { readReferencePositionCreation } from './reference-position-creation.js'
import type { ReferencePositionEvidenceReader } from './reference-position-evidence.js'
import type { StrategyReferencePortfolio, StrategyReferencePortfolioReader, StrategyReferenceScope } from './strategy-reference-portfolio.js'
import { contentHash, InferenceError } from '../domain/inference.js'

export interface StrategyReferenceEvidence {
  positionEntryAnalyses?: ReferencePositionEntryAnalyses | null
  source: AnalysisSource
  inventory: StrategyObserverInventory
  pendingOrigins: Awaited<ReturnType<typeof readReferencePendingCreation>> | null
  positionOrigins: Awaited<ReturnType<typeof readReferencePositionCreation>> | null
  positionEvidence: Awaited<ReturnType<ReferencePositionEvidenceReader['read']>> | null
}
export interface StrategyReferenceEvidenceReader { read(scope: StrategyReferenceScope): Promise<StrategyReferenceEvidence> }

export class ReadStrategyReferencePortfolio implements StrategyReferencePortfolioReader {
  constructor(private readonly evidence: StrategyReferenceEvidenceReader, private readonly now: () => Date = () => new Date()) {}
  async read(input: StrategyReferenceScope): Promise<StrategyReferencePortfolio> {
    const scope = structuredClone(input), data = structuredClone(await this.evidence.read(structuredClone(scope)))
    const fail = (): never => { throw new InferenceError('strategy_reference_portfolio_unavailable',409) }
    const { inventory: inventory, source, pendingOrigins, positionOrigins, positionEvidence } = data
    const current = this.now().getTime(), observed = Date.parse(inventory.observedAt), asOf = Date.parse(scope.asOf)
    if (source.analysisId !== scope.analysisId || source.sourceAccountId !== inventory.route.accountId
      || inventory.analysisStrategyId !== scope.analysisStrategyId || inventory.authorization.userId !== scope.userId
      || inventory.authorization.accountId !== source.sourceAccountId || inventory.route.userId !== inventory.authorization.operatorUserId
      || !Number.isFinite(current) || !Number.isFinite(asOf) || !Number.isFinite(observed)
      || current < asOf || observed > asOf || current - observed > 30000
      || !Number.isFinite(Date.parse(inventory.authorization.expiresAtUtc)) || Date.parse(inventory.authorization.expiresAtUtc) <= current
      || !pendingOrigins || positionOrigins?.status !== 'read' || positionEvidence?.status !== 'read') return fail()
    const exact = <T extends {ticket:string}>(items: T[], tickets: string[]) => {
      if (items.length !== tickets.length || new Set(tickets).size !== tickets.length
        || new Set(items.map(item=>item.ticket)).size !== tickets.length || items.some(item=>!tickets.includes(item.ticket))) return fail()
      return new Map(items.map(item=>[item.ticket,item]))
    }
    const positionsByTicket = exact(positionOrigins.items,inventory.positions.items.map(p=>p.ticket))
    const historyByTicket = exact(positionEvidence.items,inventory.positions.items.map(p=>p.ticket))
    const entriesByTicket = data.positionEntryAnalyses ? exact(data.positionEntryAnalyses,inventory.positions.items.map(p=>p.ticket)) : null
    const pendingByTicket = exact(pendingOrigins,inventory.pendingOrders.items.map(p=>p.ticket))
    const referenceId = (kind:string,ticket:string) => `${kind}:${contentHash({sourceAccountId:source.sourceAccountId,
      platform:inventory.route.platform,ticket,analysisStrategyId:scope.analysisStrategyId,traderStrategyId:scope.traderStrategyId})}`
    const positions = inventory.positions.items.filter(p=>matchesMarketSymbol(p.symbol,scope.symbol)).flatMap(p=>{
      const origin = positionsByTicket.get(p.ticket)!, history = historyByTicket.get(p.ticket)!.history
      if (origin.status !== 'creation_strategy_matched' || history.status !== 'source_matched') return fail()
      if (history.lifecycle.positionIdentifier !== p.positionIdentifier || history.lifecycle.side !== p.side || history.lifecycle.volume !== p.volume
        || contentHash([...origin.orderTickets].sort()) !== contentHash([...history.lifecycle.contributingOrderTickets].sort())) return fail()
      if (origin.strategyId !== scope.traderStrategyId) return []
      const id = referenceId('position',p.ticket)
      const entryEvidence = projectReferenceEntryEvidence({ referenceId:id,userId:inventory.authorization.operatorUserId,
        accountId:source.sourceAccountId,strategyId:origin.strategyId,symbol:p.symbol,asOf:scope.asOf,
        creationDecisions:origin.creationDecisions,evidence:entriesByTicket?.get(p.ticket) })
      return [{referenceId:id,side:p.side,volume:p.volume,entryPrice:p.openPrice,stopLoss:p.stopLoss,takeProfit:p.takeProfit,entryEvidence}]
    })
    const pendingOrders = inventory.pendingOrders.items.filter(p=>matchesMarketSymbol(p.symbol,scope.symbol)).flatMap(p=>{
      const origin = pendingByTicket.get(p.ticket)!
      if (origin.status !== 'strategy' || origin.userId !== inventory.authorization.operatorUserId || origin.accountId !== source.sourceAccountId) return fail()
      if (origin.strategyId !== scope.traderStrategyId) return []
      return [{referenceId:referenceId('pending',p.ticket),side:p.type.startsWith('buy')?'buy' as const:'sell' as const,
        volume:p.volume,entryPrice:p.price,stopLoss:p.stopLoss,takeProfit:p.takeProfit,orderType:p.type,validUntil:p.expiresAt}]
    })
    return {state:'ready',scope,sourceAccountId:source.sourceAccountId,observedAt:inventory.observedAt,
      positionsRevision:inventory.positions.revision,pendingOrdersRevision:inventory.pendingOrders.revision,positions,pendingOrders}
  }
}
