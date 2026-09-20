import { readFile } from 'node:fs/promises'
import { expect, it } from 'vitest'
import { strategyWriteActions } from '../src/modules/strategies/application/strategy-write-command.js'

it('accepts every strategy write action in the upgraded receipt constraint', async () => {
  const sql = await readFile(new URL('../db/migrations/inplace/084_strategy_trader_receipt_action.sql', import.meta.url), 'utf8')
  const actions = [...sql.matchAll(/'([a-z_]+)'/g)].map(match => match[1])
  expect(actions).toEqual([...strategyWriteActions])
})
