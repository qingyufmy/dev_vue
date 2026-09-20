import { expect, it } from 'vitest'
import type { Pool } from 'mysql2/promise'
import { unchangedUserCommandTradeState } from '../src/modules/execution/infrastructure/mysql-user-command-trade-state.js'
const state = { ticket: '1', symbol: 'XAUUSD.s', volume: '1', sl: '4250', tp: '4330', side: 'buy' }
const db = (request: unknown) => ({ execute: async () => [[{ request_json: request }], []] }) as unknown as Pick<Pool, 'execute'>
it('matches only the frozen exact terminal state', async () => {
  expect(await unchangedUserCommandTradeState(db({ bridgeExpectedState: state }), 'intent-1', { ...state })).toBe(true)
})
it.each([{ volume: '2' }, { sl: '4240' }, { tp: '4350' }, { ticket: '2' }])('rejects resource changes %j', async change => {
  expect(await unchangedUserCommandTradeState(db({ bridgeExpectedState: state }), 'intent-1', { ...state, ...change })).toBe(false)
})
it('does not invent evidence for historical commands', async () => {
  expect(await unchangedUserCommandTradeState(db({}), 'intent-1', state)).toBe(false)
})
