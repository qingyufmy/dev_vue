const MONEY_FIELDS = ['gross_profit', 'commission', 'swap', 'fee', 'net_profit']

export function rehearseTradeHistoryMigration(input) {
  if (!input || input.version !== 1 || !Array.isArray(input.partitions) || input.partitions.length < 1) {
    throw new Error('trade_history_rehearsal_input_invalid')
  }
  const partitions = input.partitions.map((partition, index) => reconcilePartition(partition, index))
  return {
    version: 1,
    generated_at: new Date().toISOString(),
    status: partitions.every(partition => partition.status === 'pass') ? 'pass' : 'fail',
    partitions,
    summary: {
      partition_count: partitions.length,
      passed_count: partitions.filter(partition => partition.status === 'pass').length,
      failed_count: partitions.filter(partition => partition.status === 'fail').length,
    },
  }
}

function reconcilePartition(value, index) {
  if (!value || typeof value !== 'object') throw new Error(`trade_history_rehearsal_partition_${index}_invalid`)
  const sourceTable = identifier(value.source_table, 64, `trade_history_rehearsal_partition_${index}_source_invalid`)
  const sourcePartition = text(value.source_partition, 191, `trade_history_rehearsal_partition_${index}_partition_invalid`)
  const sourceCount = count(value.source_count, index); const migratedCount = count(value.migrated_count, index); const reconciledCount = count(value.reconciled_count, index)
  const sourceTotals = totals(value.source_totals, index); const targetTotals = totals(value.target_totals, index)
  const differences = {}
  for (const field of MONEY_FIELDS) differences[field] = decimalSubtract(targetTotals[field], sourceTotals[field])
  const reasons = []
  if (sourceCount !== migratedCount) reasons.push('row_count_mismatch')
  if (migratedCount !== reconciledCount) reasons.push('reconciled_count_mismatch')
  if (Object.values(differences).some(value => scaled(value) !== 0n)) reasons.push('financial_total_mismatch')
  return { source_table: sourceTable, source_partition: sourcePartition, status: reasons.length ? 'fail' : 'pass', reasons,
    counts: { source: sourceCount, migrated: migratedCount, reconciled: reconciledCount }, source_totals: sourceTotals, target_totals: targetTotals, differences }
}

function totals(value, index) {
  if (!value || typeof value !== 'object') throw new Error(`trade_history_rehearsal_partition_${index}_totals_invalid`)
  return Object.fromEntries(MONEY_FIELDS.map(field => [field, decimal(value[field], `trade_history_rehearsal_partition_${index}_${field}_invalid`)]))
}
function count(value, index) { if (!Number.isSafeInteger(value) || value < 0) throw new Error(`trade_history_rehearsal_partition_${index}_count_invalid`); return value }
function identifier(value, maximum, code) { const result = text(value, maximum, code); if (!/^[A-Za-z0-9_]+$/.test(result)) throw new Error(code); return result }
function text(value, maximum, code) { if (typeof value !== 'string' || value.length < 1 || value.length > maximum) throw new Error(code); return value }
function decimal(value, code) { if (typeof value !== 'string' || !/^-?\d{1,24}(?:\.\d{1,8})?$/.test(value)) throw new Error(code); return format(scaled(value)) }
function scaled(value) { const [whole, fraction = ''] = value.split('.'); const sign = whole.startsWith('-') ? -1n : 1n; return sign * BigInt(whole.replace('-', '') + fraction.padEnd(8, '0')) }
function format(value) { const sign = value < 0 ? '-' : ''; const digits = (value < 0 ? -value : value).toString().padStart(9, '0'); const fraction = digits.slice(-8).replace(/0+$/, ''); return `${sign}${digits.slice(0, -8)}${fraction ? `.${fraction}` : ''}` }
function decimalSubtract(left, right) { return format(scaled(left) - scaled(right)) }
