import { expect, it, vi } from 'vitest'
import type { PoolConnection } from 'mysql2/promise'
import { createAccountInventorySummaryReader } from '../src/modules/trading/infrastructure/mysql-account-inventory-summary-reader.js'
import { traderTaskMode } from '../src/modules/inference/domain/inference.js'

it('uses literal suffix matching for both inventory kinds while retaining account ownership scope', async () => {
  const execute = vi.fn(async () => [[{ positions_revision: 5, pending_orders_revision: 2, has_positions: 1, has_pending_orders: 0 }]])
  const reader = createAccountInventorySummaryReader({ execute } as unknown as Pick<PoolConnection, 'execute'>)
  const result = await reader.read({ userId: 7, accountId: '9', symbol: 'XAUUSD' })
  const [sql, parameters] = execute.mock.calls[0] as unknown as [string, unknown[]]
  expect(sql.match(/CHAR_LENGTH\(\?\)\)=UPPER\(\?\)/g)).toHaveLength(2)
  expect(sql).toContain("own.role='owner' AND own.revoked_at_utc IS NULL")
  expect(parameters).toEqual(['XAUUSD', 'XAUUSD', 'XAUUSD', 'XAUUSD', 7, '9'])
  expect(traderTaskMode('none', result!.hasPositions, result!.hasPendingOrders)).toBe('manage')
})
