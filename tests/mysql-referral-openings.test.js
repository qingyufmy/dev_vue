import { expect, it } from 'vitest'
import { persistOpeningRows } from '../scripts/lib/mysql-referral-openings.mjs'

const opening = { user_id: '1', account_revision: '1', event_kind: 'opening', source_key: 'a'.repeat(64),
  previous_balance: null, delta: null, resulting_balance: '80.00000000', migration_run_id: '11111111-1111-4111-8111-111111111111',
  source_sha256: 'b'.repeat(64), recorded_at_utc: '2026-09-07 00:00:00.000' }
function database() {
  const rows = [], calls = []
  return { rows, calls, query: async sql => {
    expect(sql.endsWith('FOR UPDATE')).toBe(true)
    return [rows.map(row => ({ ...row, recorded_at_utc: row.recorded_at_utc + '000' }))]
  }, execute: async (sql, values) => {
    calls.push(sql)
    const fields = /\(([^)]+)\) VALUES/.exec(sql)[1].split(',')
    rows.push(Object.fromEntries(fields.map((field, i) => [field, values[i]])))
    return [{ affectedRows: 1 }]
  } }
}
it('inserts one opening and treats an exact repeated row as its receipt', async () => {
  const db = database(), prepared = { entries: [opening] }
  expect(await persistOpeningRows(db, prepared)).toMatchObject({ inserted: 1, rows: 1 })
  expect(await persistOpeningRows(db, prepared)).toMatchObject({ inserted: 0, existing: 1 })
  expect(db.calls).toHaveLength(1)
  expect(db.calls[0].startsWith('INSERT INTO referral_credit_ledger ')).toBe(true)
})
it.each(['resulting_balance', 'source_key', 'migration_run_id', 'account_revision'])('rejects existing %s drift before writing', async field => {
  const db = database(); db.rows.push({ ...opening, [field]: 'changed' })
  await expect(persistOpeningRows(db, { entries: [opening] })).rejects.toThrow('referral_opening_ledger_conflict')
  expect(db.calls).toEqual([])
})
it('rejects an unrelated ledger row instead of appending over unknown history', async () => {
  const db = database(); db.rows.push({ ...opening, user_id: '2' })
  await expect(persistOpeningRows(db, { entries: [opening] })).rejects.toThrow('referral_opening_ledger_conflict')
})
it('checks an unknown commit without inserting missing rows', async () => {
  const db = database()
  await expect(persistOpeningRows(db, { entries: [opening] }, { verifyOnly: true })).rejects.toThrow('referral_opening_not_committed')
  expect(db.calls).toEqual([])
})
