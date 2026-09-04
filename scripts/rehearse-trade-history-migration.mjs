#!/usr/bin/env node
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { rehearseTradeHistoryMigration } from './lib/trade-history-migration-rehearsal.mjs'

const inputPath = process.argv[2]
if (!inputPath || process.argv.length !== 3) {
  console.error('Usage: node scripts/rehearse-trade-history-migration.mjs <reconciliation-input.json>')
  process.exitCode = 2
} else {
  try {
    const input = JSON.parse(await readFile(resolve(inputPath), 'utf8'))
    const result = rehearseTradeHistoryMigration(input)
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
    if (result.status !== 'pass') process.exitCode = 1
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'trade_history_rehearsal_failed')
    process.exitCode = 2
  }
}
