import { readFile } from 'node:fs/promises'
import { expect, it } from 'vitest'
import { strategyWriteActions } from '../src/modules/strategies/application/strategy-write-command.js'

it('keeps the old receipt migration immutable and accepts every action in the latest constraint', async () => {
  const oldSql = await readFile(new URL('../db/migrations/inplace/084_strategy_trader_receipt_action.sql', import.meta.url), 'utf8')
  const latestSql = await readFile(new URL('../db/migrations/inplace/087_strategy_combination_receipt_actions.sql', import.meta.url), 'utf8')
  const oldActions = [...oldSql.matchAll(/'([a-z_]+)'/g)].map(match => match[1])
  const latestActions = [...latestSql.matchAll(/'([a-z_]+)'/g)].map(match => match[1])
  expect(oldActions).toEqual([...strategyWriteActions].slice(0, oldActions.length))
  expect(latestActions).toEqual([...strategyWriteActions])
})
