import { assertMarketSourceScope, sameMarketSource, type MarketSourceScope, type MarketSourceState } from '../domain/market-source.js'
import type { MarketSourceCandidates, MarketSourceStore } from './market-source-ports.js'

export class MarketSourceSelector {
  constructor(private readonly store: MarketSourceStore, private readonly candidates: MarketSourceCandidates,
    private readonly now: () => number = Date.now) {}

  async select(scope: MarketSourceScope): Promise<MarketSourceState> {
    assertMarketSourceScope(scope)
    const startedAt = this.now()
    // Retrying a lost CAS rereads the shared winner; it never publishes its own loser.
    for (let attempt = 0; attempt < 4; attempt++) {
      if (this.now() - startedAt >= 20_000) throw new Error('market_source_selection_timeout')
      const previous = await this.store.read(scope)
      const candidates = await this.candidates.list(scope)
      if (candidates.length > 100) throw new Error('market_source_inventory_limit')
      for (const candidate of candidates) {
        if (!/^[1-9][0-9]{0,19}$/.test(candidate.accountId) || !Number.isSafeInteger(candidate.ownerUserId) || candidate.ownerUserId < 1
          || !candidate.connectionId || !Number.isSafeInteger(candidate.connectionEpoch) || candidate.connectionEpoch < 1
          || scope.pool.kind === 'private' && candidate.ownerUserId !== scope.pool.userId) throw new Error('market_source_candidate_invalid')
      }
      if (new Set(candidates.map(c => c.accountId)).size !== candidates.length) throw new Error('market_source_candidates_duplicated')
      candidates.sort((a, b) => BigInt(a.accountId) < BigInt(b.accountId) ? -1 : BigInt(a.accountId) > BigInt(b.accountId) ? 1 : 0)
      const current = previous?.source && candidates.find(c => sameMarketSource(c, previous.source))
      const checkedAt = this.now()
      // Coalesce health checks, but only after validating that the exact route is still eligible.
      if (current && previous && checkedAt >= previous.lastCheckedAt && checkedAt - previous.lastCheckedAt < 5000) return previous
      let source = null as MarketSourceState['source'], resolvedSymbol: string | null = null
      let failures = 0, firstFailureAt: number | null = null
      let marketState: MarketSourceState['marketState'] = null
      if (current && previous) {
        const probe = await this.candidates.probe(scope, current)
        if (probe.status === 'ready' || probe.status === 'busy') {
          source = current; resolvedSymbol = probe.status === 'ready' ? probe.resolvedSymbol : previous.resolvedSymbol
          marketState = probe.status === 'ready' ? probe.marketState ?? null : previous.marketState ?? null
          if (probe.status === 'busy') { failures = previous.failures; firstFailureAt = previous.firstFailureAt }
        } else if (probe.status === 'temporary_failure') {
          failures = previous.failures + 1; firstFailureAt = previous.firstFailureAt ?? checkedAt
          if (failures < 3 || checkedAt - firstFailureAt < 15_000) { source = current; resolvedSymbol = previous.resolvedSymbol }
        }
      }
      if (!source) {
        failures = 0; firstFailureAt = null
        // A reconnected previous account is preferred, but a recovered former source never preempts a live winner.
        const alternatives = candidates.filter(c => !sameMarketSource(c, current || null))
        const reconnect = alternatives.findIndex(c => c.accountId === previous?.source?.accountId)
        if (reconnect > 0) alternatives.unshift(...alternatives.splice(reconnect, 1))
        for (const candidate of alternatives) {
          if (this.now() - startedAt >= 20_000) throw new Error('market_source_selection_timeout')
          const probe = await this.candidates.probe(scope, candidate)
          if (probe.status === 'ready') { source = candidate; resolvedSymbol = probe.resolvedSymbol; marketState = probe.marketState ?? null; break }
        }
      }
      if (source && (!resolvedSymbol || resolvedSymbol.length > 64 || /[\u0000-\u001f]/.test(resolvedSymbol))) throw new Error('market_resolved_symbol_invalid')
      if (source && !(await this.candidates.list(scope)).some(c => sameMarketSource(c, source))) continue
      const changed = !previous || !sameMarketSource(source, previous.source) || resolvedSymbol !== previous.resolvedSymbol
      const next: MarketSourceState = { revision: (previous?.revision ?? 0) + 1,
        generation: (previous?.generation ?? 0) + (changed ? 1 : 0), source, resolvedSymbol, failures, firstFailureAt, lastCheckedAt: checkedAt, marketState }
      if (!Number.isSafeInteger(next.revision) || !Number.isSafeInteger(next.generation)) throw new Error('market_source_revision_exhausted')
      if (await this.store.compareAndSet(scope, previous?.revision ?? null, next)) return next
    }
    throw new Error('market_source_selection_busy')
  }

  async isCurrent(scope: MarketSourceScope, captured: MarketSourceState) {
    assertMarketSourceScope(scope)
    const current = await this.store.read(scope)
    return !!captured.source && !!current && current.generation === captured.generation
      && sameMarketSource(current.source, captured.source) && current.resolvedSymbol === captured.resolvedSymbol
      && (await this.candidates.list(scope)).some(c => sameMarketSource(c, captured.source))
  }
}
