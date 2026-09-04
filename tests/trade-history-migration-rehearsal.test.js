import { describe, expect, it } from 'vitest'
import { rehearseTradeHistoryMigration } from '../scripts/lib/trade-history-migration-rehearsal.mjs'

const totals = { gross_profit: '100', commission: '-2', swap: '-1', fee: '0', net_profit: '97' }

describe('trade history migration rehearsal', () => {
  it('passes only when rows and every financial component reconcile exactly', () => {
    const result = rehearseTradeHistoryMigration({ version: 1, partitions: [{ source_table: 'signal_outcomes', source_partition: 'user:7/account:42',
      source_count: 2, migrated_count: 2, reconciled_count: 2, source_totals: totals, target_totals: { ...totals, gross_profit: '100.00000000' } }] })
    expect(result).toMatchObject({ status: 'pass', summary: { passed_count: 1, failed_count: 0 } })
  })

  it('reports count and money mismatches without touching a database', () => {
    const result = rehearseTradeHistoryMigration({ version: 1, partitions: [{ source_table: 'bridge_v3_deals', source_partition: 'account:42',
      source_count: 3, migrated_count: 2, reconciled_count: 1, source_totals: totals, target_totals: { ...totals, fee: '-1', net_profit: '96' } }] })
    expect(result.partitions[0]).toMatchObject({ status: 'fail', reasons: ['row_count_mismatch', 'reconciled_count_mismatch', 'financial_total_mismatch'],
      differences: { fee: '-1', net_profit: '-1' } })
  })
})
