import { readonly, shallowRef } from 'vue'
import type { createApiClient } from '@aurum/api-client'
import type { MacroMarketOverview, MacroSnapshotDetail } from '@aurum/contracts'

type MarketReader = Pick<ReturnType<typeof createApiClient>, 'getMacroMarketOverview' | 'getMacroSnapshot'>
interface Resource<T> { status: 'idle' | 'loading' | 'ready' | 'error'; data: T | null; error: string }

// Per-view state. Reset on session changes; never share cached facts across users.
function resource<T>(read: (signal: AbortSignal) => Promise<T>, errorText: string) {
  const state = shallowRef<Resource<T>>({ status: 'idle', data: null, error: '' })
  let generation = 0, controller: AbortController | undefined, disposed = false
  function clear() {
    generation += 1
    controller?.abort(); controller = undefined
    state.value = { status: 'idle', data: null, error: '' }
  }
  async function load() {
    if (disposed) return
    controller?.abort()
    const current = ++generation, request = new AbortController()
    controller = request
    // Do not present an old result as current while the next read is unresolved.
    state.value = { status: 'loading', data: null, error: '' }
    try {
      const data = await read(request.signal)
      if (!disposed && current === generation) state.value = { status: 'ready', data, error: '' }
    } catch {
      if (!disposed && current === generation) state.value = { status: 'error', data: null, error: errorText }
    } finally { if (current === generation) controller = undefined }
  }
  return { state: readonly(state), load, clear, dispose() { disposed = true; clear() } }
}

export function createMarketWorkspace(api: MarketReader) {
  let selectedId: string | null = null
  const overview = resource<MacroMarketOverview>(async signal => (await api.getMacroMarketOverview(signal)).data, '市场数据暂时无法加载，请重试。')
  const detail = resource<MacroSnapshotDetail>(async signal => {
    const id = selectedId
    if (!id) throw Error('snapshot_selection_required')
    const response = await api.getMacroSnapshot(id, signal)
    if (response.data.id !== id) throw Error('snapshot_response_mismatch')
    return response.data
  }, '这份研究暂时无法查看，请重新加载。')
  return {
    overview: overview.state, detail: detail.state,
    refresh: overview.load,
    selectSnapshot(id: string) { selectedId = id; return detail.load() },
    retryDetail: detail.load,
    closeDetail() { selectedId = null; detail.clear() },
    reset() { selectedId = null; overview.clear(); detail.clear() },
    dispose() { selectedId = null; overview.dispose(); detail.dispose() },
  }
}
