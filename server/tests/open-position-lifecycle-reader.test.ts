import { expect, it, vi } from 'vitest'
import type { PoolConnection } from 'mysql2/promise'
import { createMysqlOpenPositionLifecycleReader } from '../src/modules/trade-history/infrastructure/mysql-open-position-lifecycle-reader.js'
import { canonicalEvidence } from '../src/modules/trade-history/domain/terminal-history-projection.js'
const scope = { accountId: '5', positionIdentifier: '90', symbol: 'XAUUSD', side: 'buy' as const, volume: '0.5', observedAtUtcMsc: 3000 }
const entry = { ticket: '91', order: '81', position_id: '90', symbol: 'XAUUSD', type: 'buy', entry: 'in', volume: '1', price: '2500', time_msc: 1000 }
const exit = { ticket: '92', order: '82', position_id: '90', symbol: 'XAUUSD', type: 'sell', entry: 'out', volume: '0.5', price: '2510', time_msc: 2000 }
const row = (raw: Record<string, unknown>) => { const evidence = canonicalEvidence(raw); return { deal_ticket: String(raw.ticket), occurred_msc: String(raw.time_msc), evidence_json: evidence.json, evidence_sha256: evidence.hash } }
function fixture() {
  const rows = [row(entry),row(exit)]
  const execute = vi.fn(async () => [rows])
  return { rows, execute, reader: createMysqlOpenPositionLifecycleReader({ execute } as unknown as PoolConnection) }
}
it('reconciles partial closure from verified history without claiming strategy attribution', async () => {
  const f = fixture()
  expect(await f.reader.read(scope)).toEqual({ status: 'matches_snapshot', positionIdentifier: '90', side: 'buy', volume: '0.5', contributingOrderTickets: ['81'], dealTickets: ['91','92'] })
  expect(f.execute).toHaveBeenCalledWith(expect.stringContaining("platform='mt5'"), ['5','90',new Date(3000)])
})
it('keeps unknown stable identity unresolved without guessing from ticket', async () => {
  const f = fixture()
  expect(await f.reader.read({...scope,positionIdentifier:null})).toEqual({status:'unresolved',reason:'identifier_missing'})
  expect(f.execute).not.toHaveBeenCalled()
})
it('does not treat absent facts as a proven empty or matching portfolio', async () => {
  const f = fixture();f.rows.length=0
  expect(await f.reader.read(scope)).toEqual({status:'unresolved',reason:'facts_invalid'})
})
it.each(['hash','json','ticket','position','time'] as const)('rejects corrupted history storage: %s', async kind => {
  const f=fixture()
  if(kind==='hash') f.rows[0]!.evidence_sha256='a'.repeat(64)
  if(kind==='json') f.rows[0]!.evidence_json='{'
  if(kind==='ticket') f.rows[0]!.deal_ticket='999'
  if(kind==='position') f.rows[0]=row({...entry,position_id:'99'})
  if(kind==='time') f.rows[0]!.occurred_msc='999'
  await expect(f.reader.read(scope)).rejects.toThrow('history_lifecycle_fact_corrupt')
})
it('rejects truncation rather than reconciling a partial result', async () => {
  const f=fixture();f.rows.push(...Array.from({length:9999},()=>row(entry)))
  await expect(f.reader.read(scope)).rejects.toThrow('history_lifecycle_limit_exceeded')
})
it('preserves input scope across asynchronous reads', async () => {
  const f=fixture(), input={...scope}
  const pending=f.reader.read(input);input.volume='2';input.accountId='6'
  expect(await pending).toMatchObject({status:'matches_snapshot',volume:'0.5'})
})
it.each([
  { accountId: '0' },
  { accountId: '18446744073709551616' },
  { positionIdentifier: '0' },
  { observedAtUtcMsc: Number.NaN },
  { observedAtUtcMsc: 9007199254740991 },
])('rejects invalid query scope before accessing storage: %j', async change => {
  const f = fixture()
  await expect(f.reader.read({ ...scope, ...change })).rejects.toThrow('history_lifecycle_scope_invalid')
  expect(f.execute).not.toHaveBeenCalled()
})
it('rejects a stored fact beyond the inventory observation time', async () => {
  const f = fixture()
  f.rows[1] = row({ ...exit, time_msc: 3001 })
  await expect(f.reader.read(scope)).rejects.toThrow('history_lifecycle_fact_corrupt')
})
