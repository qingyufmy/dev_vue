import type { OpenPosition, PendingOrder } from '@aurum/contracts'
import { describe, expect, it } from 'vitest'
import { inventoryMatchesOperation } from '../composables/use-trader-workspace'

const position = { ticket: '501' } as OpenPosition
const order = { ticket: '601' } as PendingOrder
const baseline = { positionsRevision: 10, pendingOrdersRevision: 20 }

describe('trader inventory reconciliation', () => {
  it('waits for entry and edit collection revisions to advance', () => {
    expect(inventoryMatchesOperation({ command: 'market_order', ...baseline }, [], [], { positions: 10, pendingOrders: 20 })).toBe(false)
    expect(inventoryMatchesOperation({ command: 'market_order', ...baseline }, [position], [], { positions: 11, pendingOrders: 20 })).toBe(true)
    expect(inventoryMatchesOperation({ command: 'modify_order', ticket: '601', ...baseline }, [], [order], { positions: 10, pendingOrders: 21 })).toBe(true)
  })

  it('waits until the exact closed or cancelled ticket disappears', () => {
    expect(inventoryMatchesOperation({ command: 'close_position', ticket: '501', ...baseline }, [position], [], { positions: 11, pendingOrders: 20 })).toBe(false)
    expect(inventoryMatchesOperation({ command: 'close_position', ticket: '501', ...baseline }, [], [], { positions: 11, pendingOrders: 20 })).toBe(true)
    expect(inventoryMatchesOperation({ command: 'cancel_order', ticket: '601', ...baseline }, [], [order], { positions: 10, pendingOrders: 21 })).toBe(false)
    expect(inventoryMatchesOperation({ command: 'cancel_order', ticket: '601', ...baseline }, [], [], { positions: 10, pendingOrders: 21 })).toBe(true)
  })
})
