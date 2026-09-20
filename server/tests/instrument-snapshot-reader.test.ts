import { expect, it, vi } from 'vitest'
import type { Pool } from 'mysql2/promise'
import { createMysqlInstrumentSnapshotReader } from '../src/modules/trading/infrastructure/mysql-instrument-snapshot-reader.js'

function fixture(rows: unknown[]) {
  const execute = vi.fn().mockResolvedValue([rows, []])
  return { execute, reader: createMysqlInstrumentSnapshotReader({ execute } as unknown as Pool) }
}
it('reads the exact account and symbol without converting decimal text', async () => {
  const { reader, execute } = fixture([{ revision: 4, payload_json: '{"tick_size":"0.000000000000000001","point":"0.01"}' }])
  expect(await reader.read('11', 'XAUUSD.a')).toEqual({ revision: 4, data: { tick_size: '0.000000000000000001', point: '0.01' } })
  expect(execute.mock.calls[0]![1]).toEqual(['XAUUSD.a', '11'])
})
it('returns absent rather than inventing instrument defaults', async () => {
  expect(await fixture([]).reader.read('11', 'XAUUSD')).toBeNull()
})
it.each([{ revision: 0, payload_json: {} }, { revision: 1, payload_json: '[]' },
  { revision: Number.MAX_SAFE_INTEGER + 1, payload_json: {} }, { revision: 1, payload_json: 'null' }])('rejects invalid projection %j', async row => {
  await expect(fixture([row]).reader.read('11', 'XAUUSD')).rejects.toThrow('instrument_snapshot_invalid')
})
