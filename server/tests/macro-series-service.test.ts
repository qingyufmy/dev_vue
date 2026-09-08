import { expect, it, vi } from 'vitest'
import { MacroSeriesService } from '../src/modules/market/application/macro-series-service.js'
import type { MacroSeriesObservation } from '../src/modules/market/application/macro-series-reader.js'

const point = (day: string): MacroSeriesObservation => ({ code: 'DFII10', observationAt: `2026-09-${day}T00:00:00.000Z`,
  availableAt: `2026-09-${day}T12:00:00.000Z`, value: '1.1234567890', unit: '%', valueKind: 'decimal',
  calendar: 'source-calendar-v1', freshnessLimitSeconds: 259200, status: 'enabled' })

it('freezes vintage time and freshness across pages but checks display permission at current time', async () => {
  let now = new Date('2026-09-09T00:00:00.000Z')
  const reader = { list: vi.fn(async () => [point('07'), point('08')]) }
  const freshness = { evaluate: vi.fn(() => 'fresh' as const) }
  const service = new MacroSeriesService(reader, freshness, () => now)
  const page = await service.list({ code: 'DFII10', limit: 1 })
  expect(page.items[0]).toMatchObject({ value: '1.1234567890', freshness: 'fresh' })
  expect(page.has_more).toBe(true)
  now = new Date('2026-09-10T00:00:00.000Z')
  reader.list.mockResolvedValueOnce([point('08')])
  await service.list({ code: 'DFII10', limit: 1, cursor: page.next_cursor! })
  expect(reader.list).toHaveBeenLastCalledWith(expect.objectContaining({ asOf: '2026-09-09T00:00:00.000Z',
    accessAt: now.toISOString(), after: point('07').observationAt }))
  expect(freshness.evaluate).toHaveBeenLastCalledWith(point('08'), '2026-09-09T00:00:00.000Z')
  await expect(service.list({ code: 'OTHER', cursor: page.next_cursor! })).rejects.toMatchObject({ code: 'macro_series_cursor_invalid' })
  await expect(service.list({ code: 'DFII10', from: point('07').observationAt, cursor: page.next_cursor! })).rejects.toMatchObject({ status: 400 })
})

it('rejects malformed queries and future cursors before reading', async () => {
  const reader = { list: vi.fn(async () => []) }
  const service = new MacroSeriesService(reader, { evaluate: () => 'fresh' }, () => new Date('2026-09-09T00:00:00.000Z'))
  for (const input of [{ code: '' }, { code: 'DFII10', limit: 0 }, { code: 'DFII10', from: '2026-02-30T00:00:00.000Z' },
    { code: 'DFII10', from: point('08').observationAt, to: point('07').observationAt },
    { code: 'DFII10', cursor: Buffer.from(JSON.stringify({ scope: JSON.stringify(['DFII10', null, null]),
      asOf: '2026-09-10T00:00:00.000Z', after: point('07').observationAt })).toString('base64url') }]) {
    await expect(service.list(input)).rejects.toMatchObject({ status: 400 })
  }
  expect(reader.list).not.toHaveBeenCalled()
})

it('fails on corrupt projections and does not fabricate values or freshness for nonnumeric or disabled data', async () => {
  const reader = { list: vi.fn(async () => [point('07')]) }
  const evaluate = vi.fn(() => 'stale' as const)
  const service = new MacroSeriesService(reader, { evaluate }, () => new Date('2026-09-09T00:00:00.000Z'))
  for (const rows of [[point('08'), point('07')], [point('07'), point('07')], [{ ...point('07'), code: 'OTHER' }], [point('10')]]) {
    reader.list.mockResolvedValueOnce(rows)
    await expect(service.list({ code: 'DFII10' })).rejects.toMatchObject({ status: 503 })
  }
  reader.list.mockResolvedValueOnce([{ ...point('07'), valueKind: 'text', value: null }])
  expect((await service.list({ code: 'DFII10' })).items[0]).toMatchObject({ value: null, freshness: 'invalid' })
  reader.list.mockResolvedValueOnce([{ ...point('07'), status: 'disabled' }])
  expect((await service.list({ code: 'DFII10' })).items[0]?.freshness).toBe('disabled')
  expect(evaluate).not.toHaveBeenCalled()
  reader.list.mockRejectedValueOnce(new Error('database offline'))
  await expect(service.list({ code: 'DFII10' })).rejects.toThrow('database offline')
})
