import type { StrategyObserverInventory } from '../../trading/index.js'
import type { ReferencePositionLifecycleReader } from './reference-position-lifecycle.js'

export type ReferencePositionHistoryEvidence =
  | { status: 'unresolved'; reason: string }
  | { status: 'source_matched'; lifecycle: Extract<Awaited<ReturnType<ReferencePositionLifecycleReader['read']>>, { status: 'matches_snapshot' }>;
      taskId: string; receiptId: string; completionHash: string;
      deals: Array<{ ticket: string; dealId: string; factHash: string; provenanceHashes: string[] }> }
/** Consumer-owned port; implementation shares the inventory transaction. */
export interface ReferencePositionEvidenceReader {
  read(inventory: StrategyObserverInventory): Promise<
    | { status: 'unresolved'; reason: 'route_unavailable' | 'unsupported_platform' }
    | { status: 'read'; items: Array<{ ticket: string; history: ReferencePositionHistoryEvidence }> }>
}
