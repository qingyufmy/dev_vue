import { expect, it } from 'vitest'
import { terminalManualAttribution } from '../src/modules/trade-history/domain/terminal-manual-attribution.js'
import type { TerminalDealFact } from '../src/modules/trade-history/domain/terminal-history-projection.js'
const fact = (ticket: string, entryKind: string, terminalReason: string | null, dealKind = 'trade') =>
  ({ ticket, positionId: '10', entryKind, terminalReason, dealKind }) as TerminalDealFact
it('requires explicit manual origin on every entry and exit', () => {
  expect(terminalManualAttribution([fact('1','in','0'),fact('2','out','DEAL_REASON_MOBILE')]))
    .toMatchObject({ source: 'manual', status: 'exact' })
  for (const reason of [null,'3','4','5','expert','unknown']) expect(terminalManualAttribution([fact('1','in','0'),fact('2','out',reason)]))
    .toMatchObject({ source: 'unknown', status: 'unresolved' })
})
it('does not infer source from client-labelled fees, partial sets or mixed positions', () => {
  for (const facts of [[fact('1','none','0','fee')], [fact('1','in','0')],
    [fact('1','in','0'),fact('2','out','0'),fact('3','none','0','fee')],
    [fact('1','in','0'),{...fact('2','out','0'),positionId:'11'}]]) {
    expect(terminalManualAttribution(facts)).toMatchObject({ source: 'unknown' })
  }
})
