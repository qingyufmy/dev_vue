import { expect, it, vi } from 'vitest'
import { MacroSnapshotService } from '../src/modules/market/application/macro-snapshot-service.js'
import type { ReadableMacroSnapshot } from '../src/modules/market/application/macro-snapshot-reader.js'
import { sha256Canonical } from '../src/shared/canonical-json.js'

const now = '2026-09-09T00:00:00.000Z'
function row(id: string): ReadableMacroSnapshot {
  const payload = { display: { direction: 'uncertain', summary: 'Background', factors: [] } }
  return { record: { id, schemaVersion: 1, revision: '1', businessDate: '2026-09-08', horizon: 'medium_term',
    dataCutoffAt: '2026-09-08T00:00:00.000Z', publishedAt: '2026-09-08T01:00:00.000Z', validUntil: '2026-09-10T00:00:00.000Z',
    status: 'fresh', contentSha256: sha256Canonical(payload), payload }, observations: [{ factorCode: 'internal',
    observationAt: '2026-09-07T00:00:00.000Z', availableAt: '2026-09-07T00:00:00.000Z', ingestedAt: '2026-09-07T00:00:00.000Z', value: '1' }] }
}

it('paginates summaries with a frozen cutoff and current access time', async () => {
  let clock = now
  const reader = { list: vi.fn(async () => [row('b'), row('a')]) }
  const service = new MacroSnapshotService(reader, { list: async () => ({ items: [], has_more: false, next_cursor: null }) }, () => new Date(clock))
  const first = await service.list({ limit: 1 })
  expect(first.items[0]).not.toHaveProperty('factors')
  expect(first.has_more).toBe(true)
  clock = '2026-09-09T12:00:00.000Z'
  reader.list.mockResolvedValueOnce([row('a')])
  await service.list({ cursor: first.next_cursor!, limit: 1 })
  expect(reader.list).toHaveBeenLastCalledWith(expect.objectContaining({ asOf: now, accessAt: clock, after: { publishedAt: row('b').record.publishedAt, id: 'b' } }))
  await expect(service.list({ cursor: 'invalid' })).rejects.toMatchObject({ status: 400 })
  reader.list.mockResolvedValueOnce([row('a'), row('b')])
  await expect(service.list({})).rejects.toMatchObject({ status: 503 })
})

it('distinguishes missing detail/latest from a valid empty overview and propagates dependency failure', async () => {
  const reader = { list: vi.fn(async (): Promise<ReadableMacroSnapshot[]> => []) }
  const calendar = { list: vi.fn(async () => ({ items: [], has_more: false, next_cursor: null })) }
  const service = new MacroSnapshotService(reader, calendar, () => new Date(now))
  await expect(service.find('missing')).rejects.toMatchObject({ status: 404 })
  await expect(service.latest()).rejects.toMatchObject({ status: 404 })
  expect(await service.overview()).toEqual({ snapshot: null, high_impact_events: [] })
  expect(calendar.list).toHaveBeenLastCalledWith({ from: now, to: '2026-09-16T00:00:00.000Z', importance: 'high', limit: 20 })
  reader.list.mockRejectedValueOnce(new Error('offline'))
  await expect(service.overview()).rejects.toThrow('offline')
  reader.list.mockResolvedValueOnce([{ ...row('b'), record: { ...row('b').record, validUntil: now } }])
  await expect(service.latest()).rejects.toMatchObject({ status: 503 })
})
