import { expect, it } from 'vitest'
import { executionOutcomeReference } from '../src/modules/execution/domain/execution-outcome-reference.js'

it('keeps the pending ticket when a result also contains a position identifier', () => {
  expect(executionOutcomeReference('pending_order', 'succeeded', { position_ticket: '81', order_ticket: '91' }))
    .toEqual({ resourceKind: 'pending_order', ticket: '91' })
  expect(executionOutcomeReference('pending_order', 'succeeded', { position_ticket: '81' }))
    .toEqual({ resourceKind: 'unknown', ticket: null })
})
it('does not promote rejected, failed or uncertain results to resource ownership', () => {
  for (const status of ['rejected', 'failed', 'uncertain'] as const) {
    expect(executionOutcomeReference('pending_order', status, { pending_ticket: '91' }))
      .toEqual({ resourceKind: status === 'uncertain' ? 'unknown' : 'none', ticket: null })
  }
})
it('does not confuse market order IDs and closing position IDs with positions and deals', () => {
  expect(executionOutcomeReference('market_order', 'succeeded', { order: 91 })).toEqual({ resourceKind: 'unknown', ticket: null })
  expect(executionOutcomeReference('market_order', 'succeeded', { order: 91, position: 81 })).toEqual({ resourceKind: 'unknown', ticket: null })
  expect(executionOutcomeReference('market_order', 'succeeded', { order: 91, position_id: 81 })).toEqual({ resourceKind: 'unknown', ticket: null })
  expect(executionOutcomeReference('market_order', 'succeeded', { order: 91, position_ticket: '82', position_id: 81 })).toEqual({ resourceKind: 'position', ticket: '82' })
  expect(executionOutcomeReference('close_position', 'succeeded', { position_ticket: '81', deal: 71 })).toEqual({ resourceKind: 'deal', ticket: '71' })
  expect(executionOutcomeReference('close_position', 'succeeded', { position_ticket: '81' })).toEqual({ resourceKind: 'unknown', ticket: null })
})
it('preserves exact identifiers and rejects rounded or noncanonical tickets', () => {
  expect(executionOutcomeReference('modify_order', 'succeeded', { ticket: '18446744073709551615' })).toEqual({ resourceKind: 'pending_order', ticket: '18446744073709551615' })
  for (const ticket of [0, -1, 1.1, Number.MAX_SAFE_INTEGER + 1, '01', '1e3', '', '18446744073709551616']) {
    expect(executionOutcomeReference('modify_order', 'succeeded', { ticket })).toEqual({ resourceKind: 'unknown', ticket: null })
  }
})
it('uses an active-position ticket only with the current worker query provenance', () => {
  const active = { found: true, complete: true, kind: 'trade', current_state: 'active_position', ticket: '82', position_id: '82' }
  for (const action of ['market_order', 'modify_position']) {
    expect(executionOutcomeReference(action, 'succeeded', active)).toEqual({ resourceKind: 'position', ticket: '82' })
    for (const patch of [{ current_state: 'history_deal' }, { current_state: 'history_order' }, { current_state: undefined },
      { found: false }, { complete: false }, { kind: 'pending' }]) {
      expect(executionOutcomeReference(action, 'succeeded', { ...active, ...patch })).toEqual({ resourceKind: 'unknown', ticket: null })
    }
    expect(executionOutcomeReference(action, 'succeeded', { ticket: '82' })).toEqual({ resourceKind: 'unknown', ticket: null })
  }
})
it('does not expose cancelled orders as live resources', () => {
  expect(executionOutcomeReference('cancel_order', 'succeeded', { ticket: '91' })).toEqual({ resourceKind: 'none', ticket: null })
})
