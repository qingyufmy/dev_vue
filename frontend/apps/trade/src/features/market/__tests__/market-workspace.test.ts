import { expect, it, vi } from 'vitest'
import { createMarketWorkspace } from '../model/market-workspace'
import type { createApiClient } from '@aurum/api-client'

type Api = ReturnType<typeof createApiClient>
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (reason: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
const empty = { data: { snapshot: null, high_impact_events: [] }, meta: { request_id: 'r', generated_at: '2026-09-09T00:00:00.000Z' } }

it('accepts valid empty data and permits retry after failure without showing raw errors', async () => {
  const getMacroMarketOverview = vi.fn<Api['getMacroMarketOverview']>().mockRejectedValueOnce(Error('SQL password')).mockResolvedValue(empty)
  const workspace = createMarketWorkspace({ getMacroMarketOverview, getMacroSnapshot: vi.fn() })
  await workspace.refresh()
  expect(workspace.overview.value).toMatchObject({ status: 'error', data: null })
  expect(workspace.overview.value.error).not.toContain('SQL')
  await workspace.refresh()
  expect(workspace.overview.value).toMatchObject({ status: 'ready', data: empty.data, error: '' })
})

it('aborts replaced reads and ignores late failure even when the transport ignores abort', async () => {
  const old = deferred<Awaited<ReturnType<Api['getMacroMarketOverview']>>>()
  const getMacroMarketOverview = vi.fn<Api['getMacroMarketOverview']>().mockReturnValueOnce(old.promise).mockResolvedValue(empty)
  const workspace = createMarketWorkspace({ getMacroMarketOverview, getMacroSnapshot: vi.fn() })
  const first = workspace.refresh(), signal = getMacroMarketOverview.mock.calls[0]![0]
  await workspace.refresh()
  expect(signal?.aborted).toBe(true)
  old.reject(Error('late failure')); await first
  expect(workspace.overview.value.status).toBe('ready')
})

it('clears session data and prevents outstanding responses from restoring it', async () => {
  const pending = deferred<Awaited<ReturnType<Api['getMacroMarketOverview']>>>()
  const getMacroMarketOverview = vi.fn<Api['getMacroMarketOverview']>().mockReturnValueOnce(pending.promise).mockResolvedValue(empty)
  const workspace = createMarketWorkspace({ getMacroMarketOverview, getMacroSnapshot: vi.fn() })
  const loading = workspace.refresh()
  workspace.reset(); pending.resolve(empty); await loading
  expect(workspace.overview.value).toEqual({ status: 'idle', data: null, error: '' })
  await workspace.refresh(); expect(workspace.overview.value.status).toBe('ready')
  workspace.dispose(); await workspace.refresh()
  expect(getMacroMarketOverview).toHaveBeenCalledTimes(2)
  expect(workspace.overview.value.data).toBeNull()
})

it('closing or switching detail invalidates the previous selection and rejects a mismatched result', async () => {
  const pending = deferred<Awaited<ReturnType<Api['getMacroSnapshot']>>>()
  const getMacroSnapshot = vi.fn<Api['getMacroSnapshot']>().mockReturnValueOnce(pending.promise)
  const workspace = createMarketWorkspace({ getMacroMarketOverview: vi.fn(), getMacroSnapshot })
  const loading = workspace.selectSnapshot('first')
  workspace.closeDetail()
  pending.reject(Error('late')); await loading
  expect(workspace.detail.value.status).toBe('idle')
  // The boundary test deliberately returns a validly shaped type with the wrong scope.
  getMacroSnapshot.mockResolvedValueOnce({ ...empty, data: { id: 'wrong' } } as Awaited<ReturnType<Api['getMacroSnapshot']>>)
  await workspace.selectSnapshot('second')
  expect(workspace.detail.value).toMatchObject({ status: 'error', data: null })
})
