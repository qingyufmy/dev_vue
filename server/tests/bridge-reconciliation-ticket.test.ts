import { expect, it } from 'vitest'
import type { BridgeCommand } from '../src/modules/execution/domain/bridge-command.js'
import { bridgeReconciliationTicket } from '../src/modules/execution/domain/bridge-reconciliation-ticket.js'

const command = (action: BridgeCommand['action'], params: object) => ({ action, request: { payload: { params } } }) as BridgeCommand
it('uses a pending order reference even if the result also carries a position and deal', () => {
  expect(bridgeReconciliationTicket(command('order.place', { order_type: 'buy_limit' }),
    { pending_ticket: '11', position_ticket: '22', deal: '33' })).toBe('11')
})
it('uses a position reference for market execution, not an order or deal', () => {
  expect(bridgeReconciliationTicket(command('order.place', { order_type: 'market' }),
    { order: '11', position_id: '22', deal: '33' })).toBe('22')
  expect(bridgeReconciliationTicket(command('order.place', { order_type: 'market' }), { order: '11' })).toBeNull()
})
it.each(['position.close', 'position.protection.set', 'pending_order.modify', 'pending_order.cancel'] as const)(
  '%s retains the original exact target instead of substituting the result resource', action => {
    expect(bridgeReconciliationTicket(command(action, { ticket: '77' }), { order: '11', position_ticket: '22', deal: '33' })).toBe('77')
  })
it('does not pick an arbitrary conflicting alias', () => {
  expect(bridgeReconciliationTicket(command('order.place', { order_type: 'buy_stop' }),
    { order: '11', pending_ticket: '12', ticket: '13' })).toBeNull()
})
it('preserves long text identifiers and rejects unsafe numeric hints', () => {
  const pending = command('order.place', { order_type: 'buy_limit' })
  expect(bridgeReconciliationTicket(pending, { order: '9007199254740993' })).toBe('9007199254740993')
  expect(bridgeReconciliationTicket(pending, { order: Number.MAX_SAFE_INTEGER + 1 })).toBeNull()
  expect(bridgeReconciliationTicket(pending, null)).toBeNull()
})
