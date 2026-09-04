import { executionCommandSchema, executionDistributionSchema } from '@aurum/contracts'
import type { ExecutionCommandContext, OpenPosition, PendingOrder } from '@aurum/contracts'
import { describe, expect, it } from 'vitest'
import { buildAccountEntryCommand, buildDistributionEntryCommand, buildResourceDestructiveCommand, buildResourceEditCommand } from '../model/trader-command-builder'

const expectedState = {
  account_revision: '11', positions_revision: '12', pending_orders_revision: '13',
  quote_revision: '14', contract_revision: '15', risk_revision: '16',
}

function context(ticket: string | null = null): ExecutionCommandContext {
  return {
    accountId: 'account-1', symbol: 'XAUUSD', ticket, readOnly: false, tradePermission: true,
    expectedState, targetRevision: ticket ? '7' : null,
    quote: { bid: '2300.10', ask: '2300.30', observedAt: '2026-09-04T08:00:00.000Z' },
    instrument: { point: '0.01', tickSize: '0.01', tickValue: '1', volumeMin: '0.01', volumeMax: '10', volumeStep: '0.01', tradeEnabled: true },
  }
}

const position: OpenPosition = {
  ticket: '501', accountId: 'account-1', symbol: 'XAUUSD', side: 'buy', volume: '0.10',
  openPrice: '2298.00', currentPrice: '2300.10', stopLoss: '2290.00', takeProfit: '2320.00',
  floatingProfit: '21.00', openedAt: '2026-09-04T07:00:00.000Z', source: 'manual', signalId: null, revision: 7,
}

const order: PendingOrder = {
  ticket: '601', accountId: 'account-1', symbol: 'XAUUSD', type: 'buy_limit', volume: '0.10',
  price: '2280.00', stopLoss: '2270.00', takeProfit: '2310.00', createdAt: '2026-09-04T07:00:00.000Z',
  expiresAt: null, source: 'manual', signalId: null, revision: 7,
}

describe('trader command builder', () => {
  it('builds schema-valid account and distribution entry commands', () => {
    const draft = { command_type: 'market_order' as const, side: 'buy' as const, symbol: 'XAUUSD', volume: '0.10', stop_loss: '2290.00', reference_price: '2300.30' }
    expect(executionCommandSchema.safeParse(buildAccountEntryCommand(draft, context())).success).toBe(true)
    expect(executionDistributionSchema.safeParse({ strategy_id: 'strategy-1', command: buildDistributionEntryCommand(draft) }).success).toBe(true)
  })

  it('binds resource commands to the exact ticket revision', () => {
    const positionCommand = buildResourceEditCommand(position, { stop_loss: '2295.00' }, context('501'))
    const orderCommand = buildResourceEditCommand(order, { price: '2282.00', remove_take_profit: true }, context('601'))
    const positionWithForeignFields = buildResourceEditCommand(position, { stop_loss: '2295.00', price: '9999.00', remove_expiration: true }, context('501'))
    const closeCommand = buildResourceDestructiveCommand(position, context('501'))
    const cancelCommand = buildResourceDestructiveCommand(order, context('601'))
    for (const command of [positionCommand, orderCommand, closeCommand, cancelCommand]) {
      expect(executionCommandSchema.safeParse(command).success).toBe(true)
      expect(command && 'resource_revision' in command.expected_state ? command.expected_state.resource_revision : null).toBe('7')
    }
    expect(positionWithForeignFields).not.toHaveProperty('price')
    expect(positionWithForeignFields).not.toHaveProperty('remove_expiration')
  })

  it('refuses a stale or mismatched resource context', () => {
    expect(buildResourceEditCommand(position, { stop_loss: '2295.00' }, context('999'))).toBeNull()
    expect(buildResourceDestructiveCommand(order, { ...context('601'), targetRevision: null })).toBeNull()
  })
})
