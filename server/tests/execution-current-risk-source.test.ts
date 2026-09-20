import { expect, it } from 'vitest'
import type { Pool } from 'mysql2/promise'
import { MysqlExecutionRepository } from '../src/modules/execution/composition.js'

it.each([null, 'replacement-risk'])('does not use an approval that is no longer current: %s', async active => {
  const pool = { execute: async () => [[{ id: 'old-risk', active_risk_decision_id: active,
    decision_status: 'approved', reject_code: null, trade_status: 'accepted', owned: 1,
    evaluation_json: 'must-not-read-old-payload' }]] } as unknown as Pool
  const unused = () => { throw Error('unexpected capability') }
  const repository = new MysqlExecutionRepository(pool, unused, unused)
  expect(await repository.loadApprovedRiskSource(7, 'old-risk')).toBeNull()
})

it('checks the current approval before reading its executable payload', async () => {
  const pool = { execute: async () => [[{ id: 'current-risk', active_risk_decision_id: 'current-risk',
    decision_status: 'approved', reject_code: null, trade_status: 'accepted', owned: 1,
    evaluation_json: '{invalid' }]] } as unknown as Pool
  const unused = () => { throw Error('unexpected capability') }
  const repository = new MysqlExecutionRepository(pool, unused, unused)
  await expect(repository.loadApprovedRiskSource(7, 'current-risk')).rejects.toThrow()
})
