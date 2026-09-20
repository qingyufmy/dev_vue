import { afterEach, expect, it, vi } from 'vitest'
import { effectScope, ref } from 'vue'

vi.mock('vue', async importOriginal => ({ ...await importOriginal<typeof import('vue')>(),
  onMounted: vi.fn(), onBeforeUnmount: vi.fn() }))
vi.mock('~/features/auth', () => ({ useTradeSession: () => ({ session: ref({ user: { id: 42 }, csrf_token: 'csrf', authenticated_at: 'now' }) }) }))
vi.mock('~/features/trading-context', () => {
  const tradingContext = ref<unknown>(null), tradingAccounts = ref<unknown[]>([])
  return { tradingContext, tradingAccounts, contextCommandState: ref({ intent: null }),
    applyTradingContext: (value: unknown) => { tradingContext.value = value },
    applyTradingAccounts: (value: unknown[]) => { tradingAccounts.value = value },
    recoverContextCommand: vi.fn(), runContextCommand: vi.fn() }
})
vi.mock('../realtime/risk-realtime', () => ({ createRiskRealtime: () => ({ stop: vi.fn() }) }))
vi.mock('../api/risk-api', () => ({ riskApi: {
  getContext: vi.fn(async () => ({ data: { mode: 'full', accountId: '7', readOnly: false } })),
  listAccounts: vi.fn(async () => ({ data: { items: [{ id: '7' }, { id: '8' }] } })),
  getPolicy: vi.fn(async () => ({ data: { revision: 3 } })),
  getSummary: vi.fn(async () => ({ data: { revision: 6 } })),
  getManualRelease: vi.fn(async () => ({ data: { release: null } })),
  listDecisions: vi.fn(async () => ({ data: { items: [] } })),
  getManualReleaseReceipt: vi.fn(async () => ({ data: { state: 'unconfirmed' } })),
  createManualRelease: vi.fn(),
  replacePolicy: vi.fn(),
  getPolicyReceipt: vi.fn(async () => ({ data: { state: 'unconfirmed' } })),
} }))

import { riskApi } from '../api/risk-api'
import { useRiskWorkspace } from '../composables/use-risk-workspace'

afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks() })

function setup() {
  const values = new Map<string, string>()
  vi.stubGlobal('localStorage', { getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value), removeItem: (key: string) => values.delete(key) })
  vi.stubGlobal('navigator', { locks: { request: async (_name: string, work: () => Promise<unknown>) => work() } })
  const scope = effectScope()
  const workspace = scope.run(() => useRiskWorkspace(ref(''), vi.fn()))!
  return { scope, workspace }
}

it('releases busy after a full reload invalidates an in-flight response and retains the original request', async () => {
  const f = setup()
  let finish!: () => void
  vi.mocked(riskApi.createManualRelease).mockImplementationOnce(() => new Promise(resolve => { finish = () => resolve({} as never) }))
  try {
    await f.workspace.load()
    const pending = f.workspace.createManualRelease('确认风险后恢复交易')
    await vi.waitFor(() => expect(riskApi.createManualRelease).toHaveBeenCalledTimes(1))
    await f.workspace.load()
    expect(f.workspace.releasing.value).toBe(true)
    finish()
    expect(await pending).toBe(false)
    expect(f.workspace.releasing.value).toBe(false)
    expect(f.workspace.pendingRelease.value).toMatchObject({ accountId: '7', body: { reason: '确认风险后恢复交易' } })
    await f.workspace.runReleaseRecovery('query')
    expect(riskApi.getManualReleaseReceipt).toHaveBeenCalledTimes(1)
    expect(riskApi.createManualRelease).toHaveBeenCalledTimes(1)
  } finally { f.scope.stop() }
})

it('does not let an old account response clear the new account operation busy flag', async () => {
  const f = setup()
  const finish: Array<() => void> = []
  vi.mocked(riskApi.createManualRelease).mockImplementation(() => new Promise(resolve => { finish.push(() => resolve({} as never)) }))
  try {
    await f.workspace.load()
    const first = f.workspace.createManualRelease('原账户解除风险')
    await vi.waitFor(() => expect(finish).toHaveLength(1))
    f.workspace.activeAccountId.value = '8'
    const second = f.workspace.createManualRelease('新账户解除风险')
    await vi.waitFor(() => expect(finish).toHaveLength(2))
    finish[0]!()
    await first
    expect(f.workspace.releasing.value).toBe(true)
    finish[1]!()
    await second
    expect(f.workspace.releasing.value).toBe(false)
  } finally { f.scope.stop() }
})

it('keeps an uncertain policy save through reload and queries without sending edited policy', async () => {
  const f = setup()
  vi.mocked(riskApi.replacePolicy).mockRejectedValueOnce(Error('lost response'))
  try {
    await f.workspace.load()
    expect(await f.workspace.savePolicy({ patch: { maxRiskPerTradePercent: '0.5' }, reason: '原始修改原因' })).toBe(false)
    const original = f.workspace.pendingPolicy.value
    expect(original).toMatchObject({ revision: 3, accountId: '7', body: { max_risk_per_trade_percent: '0.5', reason: '原始修改原因' } })
    await f.workspace.load()
    expect(await f.workspace.savePolicy({ patch: { accountKillSwitch: true }, reason: '后来编辑原因' })).toBe(false)
    expect(f.workspace.pendingPolicy.value).toEqual(original)
    expect(riskApi.replacePolicy).toHaveBeenCalledTimes(1)
    vi.mocked(riskApi.getPolicyReceipt).mockResolvedValueOnce({ data: { state: 'confirmed' } } as never)
    vi.mocked(riskApi.getPolicy).mockRejectedValueOnce(Error('refresh failed'))
    expect(await f.workspace.runPolicyRecovery('query')).toBe(false)
    expect(f.workspace.pendingPolicy.value).toBeNull()
    expect(f.workspace.policyRecoveryMessage.value).toContain('保存已确认')
    expect(riskApi.replacePolicy).toHaveBeenCalledTimes(1)
  } finally { f.scope.stop() }
})
