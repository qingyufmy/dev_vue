# Multi-Model Inference Compare Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use compose:subagent (recommended) or compose:execute to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add multi-model inference comparison — send the same market data to multiple models in parallel and compare results side-by-side, plus an admin-only historical comparison page.

**Architecture:** New backend endpoint `/ai/analyze-compare` fetches market data once, runs `maybeAiSignal` in parallel for each model via `Promise.allSettled`, and returns all results. Frontend renders side-by-side cards. Historical comparison uses a separate admin-only page with batch replay.

**Tech Stack:** Node.js (ESM), Express, MySQL, vanilla HTML/CSS/JS, WebSocket (ws)

## Global Constraints

- ESM only — use `import/export`, not `require`
- No comments in code unless explicitly asked
- `beijingNow()` from `db.js` for all timestamps
- Parameterized queries only (never string concatenation)
- Use `authMiddleware` from `middleware/auth.js`
- Dual-table sync for `auto_scheduler` + `user_bridge_settings` if applicable
- Verify each change with `npm run dev` — no `[FATAL]` errors
- Chinese UI text throughout

---

## File Structure

| Action | File | Responsibility |
|--------|------|----------------|
| Modify | `server/routes/ai/strategy.js` | Add `handleAnalyzeCompare()` — market data once, parallel inference |
| Modify | `server/routes/ai/index.js` | Add `POST /ai/analyze-compare` route |
| Modify | `public/ai/index.html` | Multi-select model checkboxes in manualInferenceModal |
| Modify | `public/ai/app.js` | `runAnalysisCompare()`, `CompareResultsModal` renderer |
| Modify | `public/ai/styles.css` | `.compare-*` classes |
| Create | `tests/ai/analyze-compare.test.js` | Unit tests for backend compare logic |
| Create | `tests/ai/analyze-compare-frontend.test.js` | Unit tests for frontend compare logic |

---

### Task 1: Backend — `handleAnalyzeCompare` core logic

**Covers:** [S3]

**Files:**
- Modify: `server/routes/ai/strategy.js:249-388` (reference `handleAnalyze` structure)
- Create: `tests/ai/analyze-compare.test.js`

**Interfaces:**
- Consumes: `getStrategyById`, `parseStrategyPolicy`, `resolveAiTaskModel` (existing)
- Produces: `handleAnalyzeCompare(userId, params)` → `{ ok, results: [...], market_snapshot }`

- [ ] **Step 1: Write failing tests**

```js
// tests/ai/analyze-compare.test.js
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('server/db.js', () => ({
  query: vi.fn(), queryOne: vi.fn(), queryAll: vi.fn(),
  queryRun: vi.fn(), withTransaction: vi.fn(fn => fn(vi.fn())),
  beijingNow: vi.fn(() => '2026-07-18 12:00:00'),
  getDB: vi.fn(() ({ query: vi.fn() })),
}))
vi.mock('server/redis.js', () => ({
  cacheGetJSON: vi.fn(), cacheSetJSON: vi.fn(), cacheDel: vi.fn(),
}))

const mockMarket = {
  current_price: 2400, atr: { h1: 5.2, h4: 8.1 },
  indicators: { rsi: 55, macd: { histogram: 0.5 } },
  trend: 'up', trend_strength: 'medium', data_confidence: 'medium',
  timeframes: { M15: { summary: 'test', klines: [] }, H1: { summary: 'test', klines: [] } },
  klines: [], symbol: 'XAUUSD', timeframe: 'M15',
}

describe('handleAnalyzeCompare', () => {
  it('returns error if model_ids < 2', async () => {
    const { handleAnalyzeCompare } = await import('server/routes/ai/strategy.js')
    const result = await handleAnalyzeCompare(1, { strategy_id: 1, symbol: 'XAUUSD', model_ids: [1] })
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/model_ids/)
  })

  it('returns error if model_ids > 5', async () => {
    const { handleAnalyzeCompare } = await import('server/routes/ai/strategy.js')
    const result = await handleAnalyzeCompare(1, { strategy_id: 1, symbol: 'XAUUSD', model_ids: [1,2,3,4,5,6] })
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/model_ids/)
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- tests/ai/analyze-compare.test.js`
Expected: FAIL — `handleAnalyzeCompare` not exported

- [ ] **Step 3: Implement `handleAnalyzeCompare` in `strategy.js`**

Add the function after `handleAnalyze` (after line 488). Key differences from `handleAnalyze`:
- Accepts `model_ids: number[]` (2-5)
- Resolves market data ONCE (same as `handleAnalyze` lines 254-333)
- For each `model_id`, calls `resolveOwnedModelProfileForRuntime(model_id, userId)` to get profile
- Builds config per model (same structure as `handleAnalyze` lines 259-333, but using resolved model profile)
- `Promise.allSettled()` over all models, each calling `maybeAiSignal(null, config, market)`
- Does NOT persist signals (no `withTransaction`)
- Does NOT execute orders
- Returns `{ ok: true, results: [...], market_snapshot }`

```js
export async function handleAnalyzeCompare(userId, params) {
  const { strategy_id, symbol, model_ids = [] } = params
  if (!symbol || !strategy_id) return { ok: false, error: 'symbol_and_strategy_required' }
  if (!Array.isArray(model_ids) || model_ids.length < 2 || model_ids.length > 5) {
    return { ok: false, error: 'model_ids必须包含2-5个模型' }
  }

  const [userRow] = await query('SELECT id, role FROM users WHERE id = ?', [userId])
  if (!userRow) return { ok: false, error: 'user_not_found' }

  const strategy = await getStrategyById(strategy_id)
  if (!strategy) return { ok: false, error: 'strategy_not_found' }
  if (!strategy.supportedSymbols?.includes(symbol)) {
    return { ok: false, error: `strategy_does_not_support_${symbol}` }
  }

  const policy = parseStrategyPolicy(strategy)
  const primaryTimeframe = policy.timeframes?.[0] || 'M15'
  const klineCount = policy.klineCounts?.[primaryTimeframe] || 100

  const rates = await platformRates(userId, symbol, primaryTimeframe, klineCount)
  if (!rates?.length) return { ok: false, error: 'market_data_unavailable' }

  const market = calculateMarketData(rates, symbol, primaryTimeframe)
  const strategyContext = buildStrategyContextFromTags(policy, rates, market)
  market.strategy_context = strategyContext
  if (policy.use_chan_analysis) market.chan = market.chan || null
  market.atr_anchor = market.atr?.h4 || market.atr?.h1 || null

  const marketSnapshot = buildSharedMarketSnapshot(market)

  const inferenceTasks = model_ids.map(async (mid) => {
    const start = Date.now()
    try {
      const resolved = await resolveOwnedModelProfileForRuntime(mid, userId)
      if (!resolved.model) return { model_id: mid, ok: false, error: resolved.error || 'model_unavailable', latency_ms: Date.now() - start }

      const config = {
        api_key_encrypted: resolved.model.api_key_encrypted,
        api_provider: resolved.model.provider || resolved.model.api_provider,
        api_base_url: resolved.model.api_base_url,
        model_name: resolved.model.model_name,
        temperature: resolved.model.temperature ?? 0.3,
        max_tokens: resolved.model.max_tokens ?? 8000,
        thinking_enabled: resolved.model.thinking_enabled,
        reasoning_effort: resolved.model.reasoning_effort,
        system_prompt: strategy.system_prompt,
        _allowed_entry_methods: policy.allowedEntryMethods,
        _market_data_plan: policy.marketDataPlan,
        _use_chan_analysis: policy.use_chan_analysis,
        _market_only: strategy.scope === 'platform',
        _ai_volume_min: strategy.ai_volume_min,
        _ai_volume_max: strategy.ai_volume_max,
        _userId: userId,
        _model_profile_id: resolved.model_profile_id,
        _credential_source: resolved.credential_source,
        _usage: 'compare',
        _strategyId: strategy_id,
      }

      const signal = await maybeAiSignal(null, config, market)
      const modelInfo = await queryOne('SELECT model_name, provider FROM ai_model_profiles WHERE id = ?', [mid])
      return {
        model_id: mid,
        model_name: modelInfo?.model_name || resolved.model.model_name,
        provider: modelInfo?.provider || config.api_provider,
        ok: true,
        signal,
        latency_ms: Date.now() - start,
      }
    } catch (err) {
      return { model_id: mid, ok: false, error: err.message || 'inference_failed', latency_ms: Date.now() - start }
    }
  })

  const results = await Promise.allSettled(inferenceTasks)
  const resolved = results.map(r => r.status === 'fulfilled' ? r.value : { model_id: null, ok: false, error: r.reason?.message || 'task_rejected' })

  return { ok: true, results: resolved, market_snapshot: marketSnapshot }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- tests/ai/analyze-compare.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add server/routes/ai/strategy.js tests/ai/analyze-compare.test.js
git commit -m "feat: add handleAnalyzeCompare for multi-model parallel inference"
```

---

### Task 2: Backend — `POST /ai/analyze-compare` route

**Covers:** [S3]

**Files:**
- Modify: `server/routes/ai/index.js` (add route after model profile test endpoint, ~line 145)
- Modify: `tests/ai/analyze-compare.test.js` (add route test)

**Interfaces:**
- Consumes: `handleAnalyzeCompare(userId, params)` from Task 1
- Produces: HTTP route `POST /ai/analyze-compare`

- [ ] **Step 1: Write failing test for route**

Add to `tests/ai/analyze-compare.test.js`:

```js
describe('POST /ai/analyze-compare route', () => {
  it('is registered on the router', async () => {
    const router = (await import('server/routes/ai/index.js')).default
    const stack = router.stack || []
    const route = stack.find(r => r.route?.path === '/ai/analyze-compare')
    expect(route).toBeTruthy()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/ai/analyze-compare.test.js`
Expected: FAIL — route not found

- [ ] **Step 3: Add route in `index.js`**

After the model profile test endpoint (around line 145), add:

```js
router.post('/ai/analyze-compare', authMiddleware, async (req, res) => {
  try {
    const result = await handleAnalyzeCompare(req.user.id, req.body)
    res.json(result)
  } catch (error) { reviewError(res, error) }
})
```

Also add the import at the top of `index.js`:
```js
import { handleAnalyzeCompare } from './strategy.js'
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- tests/ai/analyze-compare.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add server/routes/ai/index.js tests/ai/analyze-compare.test.js
git commit -m "feat: add POST /ai/analyze-compare route"
```

---

### Task 3: WebSocket bridge for compare action

**Covers:** [S3]

**Files:**
- Modify: `server/bridge-ws.js` (add `compare` case in command handler, ~line 902)
- Modify: `public/ai/app.js` (add `compare` to `wsApi` dispatch)

**Interfaces:**
- Consumes: `handleAnalyzeCompare(userId, params)` from Task 1
- Produces: WebSocket `compare` command handling

- [ ] **Step 1: Add `compare` case in `bridge-ws.js`**

Find the `case 'analyze':` block (around line 902) and add `compare` right after:

```js
case 'compare':
  result = await ai.handleAnalyzeCompare(userId, params)
  break
```

- [ ] **Step 2: Verify existing analyze still works**

Run: `npm run dev` — check no `[FATAL]` error

- [ ] **Step 3: Commit**

```bash
git add server/bridge-ws.js
git commit -m "feat: add WebSocket compare command bridge"
```

---

### Task 4: Frontend — Multi-select model component in manual inference modal

**Covers:** [S3]

**Files:**
- Modify: `public/ai/index.html:906-924` (add model multi-select to modal)
- Modify: `public/ai/styles.css` (add `.model-compare-select` styles)
- Create: `tests/ai/analyze-compare-frontend.test.js`

**Interfaces:**
- Consumes: existing modal HTML structure
- Produces: `#analyzeModelIds` multi-select container, CSS styles

- [ ] **Step 1: Add model multi-select HTML to modal**

In `index.html`, inside `manual-inference-body` div (after the strategy summary div, around line 914), add:

```html
<div id="modelCompareSection" class="model-compare-section hidden">
  <label><span>对比模型</span></label>
  <div id="modelCompareSelect" class="model-compare-select"></div>
  <small class="field-help">选择 2-5 个模型进行对比推理</small>
</div>
```

- [ ] **Step 2: Add CSS for model compare section**

In `styles.css`, add:

```css
.model-compare-section { margin-top: 12px; }
.model-compare-select {
  display: flex; flex-wrap: wrap; gap: 8px;
  padding: 8px; border: 1px solid var(--border-subtle, rgba(255,255,255,.08));
  border-radius: 8px; background: var(--bg-secondary, rgba(255,255,255,.03));
}
.model-compare-checkbox {
  display: flex; align-items: center; gap: 6px;
  padding: 4px 10px; border-radius: 6px; cursor: pointer;
  font-size: 13px; color: var(--text-primary, #e0e0e0);
  transition: background .15s;
}
.model-compare-checkbox:hover { background: rgba(255,255,255,.06); }
.model-compare-checkbox input[type="checkbox"] { accent-color: var(--accent, #4f9cf7); }
.model-compare-checkbox input[type="checkbox"]:disabled { opacity: .5; }
.compare-badge {
  display: inline-block; padding: 2px 8px; border-radius: 10px;
  font-size: 11px; font-weight: 600; margin-left: auto;
}
.compare-badge.diff { background: rgba(239,68,68,.15); color: #f87171; }
.compare-badge.same { background: rgba(34,197,94,.15); color: #4ade80; }
```

- [ ] **Step 3: Commit**

```bash
git add public/ai/index.html public/ai/styles.css
git commit -m "feat: add model multi-select section to manual inference modal"
```

---

### Task 5: Frontend — Compare modal logic and rendering

**Covers:** [S3]

**Files:**
- Modify: `public/ai/app.js` (add compare functions, ~4300-4400)
- Modify: `public/ai/index.html` (add compare results modal)
- Modify: `public/ai/styles.css` (add compare result card styles)

**Interfaces:**
- Consumes: `wsApi('compare', {...})` WebSocket API
- Produces: `runAnalysisCompare()`, `renderCompareResults()`, `CompareResultsModal`

- [ ] **Step 1: Add compare results modal HTML**

In `index.html`, after the `manualInferenceModal` (after line 924), add:

```html
<div id="compareResultsModal" class="order-confirm-overlay hidden" role="dialog" aria-modal="true" aria-labelledby="compareResultsTitle">
  <div class="order-confirm-dialog compare-results-dialog">
    <div class="order-confirm-head">
      <div><strong id="compareResultsTitle">多模型对比结果</strong><small id="compareResultsSubtitle"></small></div>
      <button id="compareResultsClose" class="icon-btn" type="button" aria-label="关闭"><i data-lucide="x" size="16"></i></button>
    </div>
    <div id="compareMarketSnapshot" class="compare-market-snapshot"></div>
    <div id="compareResultsGrid" class="compare-results-grid"></div>
    <div class="order-confirm-actions">
      <button id="compareResultsCloseBtn" class="btn" type="button">关闭</button>
    </div>
  </div>
</div>
```

- [ ] **Step 2: Add compare result card CSS**

In `styles.css`, add:

```css
.compare-results-dialog { max-width: 1200px; max-height: 90vh; overflow-y: auto; }
.compare-results-grid {
  display: grid; gap: 16px; padding: 16px;
  grid-template-columns: repeat(auto-fill, minmax(320px, 1fr));
}
.compare-result-card {
  background: var(--bg-secondary, rgba(255,255,255,.03));
  border: 1px solid var(--border-subtle, rgba(255,255,255,.08));
  border-radius: 10px; padding: 16px;
  transition: border-color .2s;
}
.compare-result-card.signal-diff { border-color: rgba(239,68,68,.4); }
.compare-result-card .card-header {
  display: flex; justify-content: space-between; align-items: center;
  margin-bottom: 12px; padding-bottom: 8px;
  border-bottom: 1px solid var(--border-subtle, rgba(255,255,255,.06));
}
.compare-result-card .model-name { font-weight: 600; font-size: 14px; }
.compare-result-card .model-provider { font-size: 12px; color: var(--text-secondary, #999); }
.compare-result-card .signal-direction {
  font-size: 20px; font-weight: 700; padding: 4px 12px;
  border-radius: 6px; text-transform: uppercase;
}
.compare-result-card .signal-direction.buy { color: #4ade80; background: rgba(34,197,94,.1); }
.compare-result-card .signal-direction.sell { color: #f87171; background: rgba(239,68,68,.1); }
.compare-result-card .signal-direction.hold { color: #fbbf24; background: rgba(251,191,36,.1); }
.compare-result-card .signal-details { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; font-size: 13px; }
.compare-result-card .detail-label { color: var(--text-secondary, #999); }
.compare-result-card .detail-value { color: var(--text-primary, #e0e0e0); font-weight: 500; }
.compare-result-card .confidence-bar {
  height: 4px; border-radius: 2px; background: rgba(255,255,255,.08); margin-top: 12px; overflow: hidden;
}
.compare-result-card .confidence-fill {
  height: 100%; border-radius: 2px; background: var(--accent, #4f9cf7); transition: width .3s;
}
.compare-result-card .latency { font-size: 11px; color: var(--text-secondary, #999); margin-top: 8px; text-align: right; }
.compare-result-card .error-state {
  color: #f87171; font-size: 13px; padding: 12px; text-align: center;
  background: rgba(239,68,68,.05); border-radius: 6px;
}
.compare-market-snapshot {
  padding: 12px 16px; margin: 0 16px;
  background: var(--bg-secondary, rgba(255,255,255,.03));
  border-radius: 8px; font-size: 13px; color: var(--text-secondary, #999);
}
```

- [ ] **Step 3: Add frontend compare logic in `app.js`**

After the `runAnalysis` function (after line 4351), add:

```js
function populateModelCompareSelect() {
  const container = $("modelCompareSelect")
  if (!container) return
  container.innerHTML = ""
  const profiles = state.modelProfiles || []
  if (profiles.length < 2) {
    $("modelCompareSection")?.classList.add("hidden")
    return
  }
  $("modelCompareSection")?.classList.remove("hidden")
  profiles.forEach(p => {
    const label = document.createElement("label")
    label.className = "model-compare-checkbox"
    label.innerHTML = `<input type="checkbox" value="${p.id}" data-model="${p.model_name}"><span>${p.model_name || p.provider}</span>`
    container.appendChild(label)
  })
}

function getSelectedModelIds() {
  const section = $("modelCompareSection")
  if (section?.classList.contains("hidden")) return []
  return Array.from($$("modelCompareSelect input[type='checkbox']:checked")).map(cb => Number(cb.value))
}

async function runAnalysisCompare() {
  const symbol = $("analyzeSymbol")?.value
  const strategyId = Number($("analyzeStrategy")?.value || 0)
  const modelIds = getSelectedModelIds()
  if (!strategyId) return showToast("请选择策略", "error")
  if (!symbol) return showToast("请选择品种", "error")
  if (modelIds.length < 2) return showToast("请选择至少2个模型进行对比", "error")

  const btn = $("runAnalysisBtn")
  btn.disabled = true
  $("manualInferenceStatus")?.classList.remove("hidden")

  try {
    const result = await wsApi("compare", {
      strategy_id: strategyId, symbol, model_ids: modelIds, _timeout: 180000,
    })
    setManualInferenceModal(false)
    renderCompareResults(result)
  } catch (err) {
    showToast(err.message || "对比推理失败", "error")
  } finally {
    btn.disabled = false
    $("manualInferenceStatus")?.classList.add("hidden")
  }
}

function renderCompareResults(result) {
  const modal = $("compareResultsGrid")
  const subtitle = $("compareResultsSubtitle")
  if (!modal || !result?.results) return

  const results = result.results
  const signals = results.filter(r => r.ok && r.signal?.signal_type).map(r => r.signal.signal_type)
  const hasDiff = new Set(signals).size > 1

  subtitle.textContent = hasDiff ? "模型意见存在分歧" : "模型意见一致"
  modal.innerHTML = ""

  const snapshot = result.market_snapshot
  const snapshotEl = $("compareMarketSnapshot")
  if (snapshotEl && snapshot) {
    snapshotEl.innerHTML = `<span>价格: ${snapshot.current_price || '-'} | ATR(H1): ${snapshot.atr?.h1 || '-'} | 趋势: ${snapshot.trend || '-'}</span>`
  }

  results.forEach(r => {
    const card = document.createElement("div")
    card.className = "compare-result-card"
    if (hasDiff) card.classList.add("signal-diff")

    if (!r.ok || !r.signal) {
      card.innerHTML = `
        <div class="card-header"><span class="model-name">${r.model_name || `Model ${r.model_id}`}</span><span class="model-provider">${r.provider || ''}</span></div>
        <div class="error-state">${r.error || '推理失败'}</div>
        <div class="latency">${r.latency_ms}ms</div>`
    } else {
      const s = r.signal
      const dir = (s.signal_type || 'hold').toLowerCase()
      const conf = Math.round((s.confidence || 0) * 100)
      card.innerHTML = `
        <div class="card-header">
          <div><span class="model-name">${r.model_name || `Model ${r.model_id}`}</span><br><span class="model-provider">${r.provider || ''}</span></div>
          <span class="signal-direction ${dir}">${dir === 'buy' ? '做多' : dir === 'sell' ? '做空' : '观望'}</span>
        </div>
        <div class="signal-details">
          <div><span class="detail-label">入场方式</span><div class="detail-value">${s.entry_method || '-'}</div></div>
          <div><span class="detail-label">入场价</span><div class="detail-value">${s.entry_price || '-'}</div></div>
          <div><span class="detail-label">止损</span><div class="detail-value">${s.stop_loss || '-'}</div></div>
          <div><span class="detail-label">止盈</span><div class="detail-value">${s.take_profit_1 || '-'}</div></div>
          <div><span class="detail-label">置信度</span><div class="detail-value">${conf}%</div></div>
          <div><span class="detail-label">手数</span><div class="detail-value">${s.volume || '-'}</div></div>
        </div>
        <div class="confidence-bar"><div class="confidence-fill" style="width:${conf}%"></div></div>
        <div class="latency">${r.latency_ms}ms</div>`
    }
    modal.appendChild(card)
  })

  $("compareResultsModal")?.classList.remove("hidden")
  document.body.classList.add("modal-open")
}
```

- [ ] **Step 4: Wire up event listeners**

In the existing event listener section (around line 5574), add after the `runAnalysisBtn` listener:

```js
// Compare results modal
$("compareResultsClose")?.addEventListener("click", () => {
  $("compareResultsModal")?.classList.add("hidden")
  document.body.classList.remove("modal-open")
})
$("compareResultsCloseBtn")?.addEventListener("click", () => {
  $("compareResultsModal")?.classList.add("hidden")
  document.body.classList.remove("modal-open")
})
```

- [ ] **Step 5: Update `runAnalysis` to detect compare mode**

Modify `runAnalysis` (around line 4293) to check if ≥ 2 models are selected and redirect to `runAnalysisCompare`:

Add at the top of `runAnalysis`:
```js
const selectedModels = getSelectedModelIds()
if (selectedModels.length >= 2) return runAnalysisCompare()
```

- [ ] **Step 6: Populate model checkboxes when modal opens**

In the strategy change handler (where `#analyzeStrategy` change populates symbols), add a call to `populateModelCompareSelect()` when the strategy changes. Also load model profiles into `state.modelProfiles` on init.

- [ ] **Step 7: Commit**

```bash
git add public/ai/app.js public/ai/index.html public/ai/styles.css
git commit -m "feat: add multi-model compare UI to manual inference modal"
```

---

### Task 6: Backend — Historical compare endpoint (admin only)

**Covers:** [S4]

**Files:**
- Modify: `server/routes/ai/strategy.js` (add `handleHistoryCompare`)
- Modify: `server/routes/ai/index.js` (add route)
- Create: `tests/ai/analyze-compare.test.js` (add historical compare tests)

**Interfaces:**
- Consumes: `resolveOwnedModelProfileForRuntime`, `maybeAiSignal`, `calculateMarketData` (existing)
- Produces: `handleHistoryCompare(userId, params)` + `POST /ai/model-compare/history`

- [ ] **Step 1: Add `handleHistoryCompare` in `strategy.js`**

```js
export async function handleHistoryCompare(userId, params) {
  const { symbol, start_time, end_time, model_ids = [], strategy_id } = params
  if (!symbol || !start_time || !end_time) return { ok: false, error: 'symbol_start_end_required' }
  if (!Array.isArray(model_ids) || model_ids.length < 2 || model_ids.length > 5) {
    return { ok: false, error: 'model_ids必须包含2-5个模型' }
  }

  const [userRow] = await query('SELECT id, role FROM users WHERE id = ?', [userId])
  if (!userRow || userRow.role !== 'admin') return { ok: false, error: 'admin_only' }

  const strategy = strategy_id ? await getStrategyById(strategy_id) : null
  const primaryTimeframe = 'M15'
  const klineCount = 200

  const allRates = await query(
    'SELECT * FROM kline_data WHERE symbol = ? AND timeframe = ? AND open_time >= ? AND open_time <= ? ORDER BY open_time ASC',
    [symbol, primaryTimeframe, start_time, end_time]
  )
  if (!allRates?.length) return { ok: false, error: 'no_kline_data', candle_count: 0 }

  const stepMinutes = { M1: 1, M5: 5, M15: 15, M30: 30, H1: 60, H4: 240, D1: 1440 }
  const interval = stepMinutes[primaryTimeframe] || 15

  const modelResults = await Promise.all(model_ids.map(async (mid) => {
    const signals = []
    const resolved = await resolveOwnedModelProfileForRuntime(mid, userId)
    if (!resolved.model) return { model_id: mid, model_name: null, provider: null, signals: [], simulated_pnl: null, error: resolved.error }

    for (let i = 0; i < allRates.length; i += interval) {
      const slice = allRates.slice(0, i + interval)
      if (slice.length < 20) continue

      const market = calculateMarketData(slice, symbol, primaryTimeframe)
      const config = {
        api_key_encrypted: resolved.model.api_key_encrypted,
        api_provider: resolved.model.provider || resolved.model.api_provider,
        api_base_url: resolved.model.api_base_url,
        model_name: resolved.model.model_name,
        temperature: resolved.model.temperature ?? 0.3,
        max_tokens: resolved.model.max_tokens ?? 8000,
        thinking_enabled: resolved.model.thinking_enabled,
        reasoning_effort: resolved.model.reasoning_effort,
        system_prompt: strategy?.system_prompt,
        _allowed_entry_methods: ['market', 'limit', 'stop'],
        _market_data_plan: strategy ? parseStrategyPolicy(strategy).marketDataPlan : null,
        _use_chan_analysis: strategy ? parseStrategyPolicy(strategy).use_chan_analysis : false,
        _market_only: true,
        _userId: userId,
        _model_profile_id: resolved.model_profile_id,
        _credential_source: resolved.credential_source,
        _usage: 'history_compare',
        _strategyId: strategy_id || null,
      }

      try {
        const signal = await maybeAiSignal(null, config, market)
        if (signal?.signal_type && signal.signal_type !== 'hold') {
          const openTime = slice[slice.length - 1]?.open_time
          const closeCandle = allRates[i + interval]
          const closePrice = closeCandle?.close || market.current_price
          const pnl = signal.signal_type === 'buy'
            ? (closePrice - (signal.entry_price || market.current_price))
            : ((signal.entry_price || market.current_price) - closePrice)
          signals.push({
            time: openTime, signal_type: signal.signal_type,
            entry_method: signal.entry_method, price: signal.entry_price || market.current_price,
            sl: signal.stop_loss, tp: signal.take_profit_1,
            confidence: signal.confidence, pnl,
          })
        }
      } catch {}
    }

    const totalTrades = signals.length
    const winCount = signals.filter(s => s.pnl > 0).length
    const lossCount = totalTrades - winCount
    const netPnl = signals.reduce((sum, s) => sum + s.pnl, 0)

    const modelInfo = await queryOne('SELECT model_name, provider FROM ai_model_profiles WHERE id = ?', [mid])
    return {
      model_id: mid,
      model_name: modelInfo?.model_name || resolved.model.model_name,
      provider: modelInfo?.provider || resolved.model.api_provider,
      signals,
      simulated_pnl: { total_trades: totalTrades, win_count: winCount, loss_count: lossCount, net_pnl: netPnl, win_rate: totalTrades ? +(winCount / totalTrades).toFixed(2) : 0 },
    }
  }))

  return { ok: true, candle_count: allRates.length, results: modelResults }
}
```

- [ ] **Step 2: Add route in `index.js`**

```js
router.post('/ai/model-compare/history', authMiddleware, async (req, res) => {
  try {
    const result = await handleHistoryCompare(req.user.id, req.body)
    res.json(result)
  } catch (error) { reviewError(res, error) }
})
```

- [ ] **Step 3: Add tests**

```js
describe('handleHistoryCompare', () => {
  it('rejects non-admin users', async () => {
    const { queryOne } = await import('server/db.js')
    queryOne.mockResolvedValueOnce({ id: 1, role: 'free' })
    const { handleHistoryCompare } = await import('server/routes/ai/strategy.js')
    const result = await handleHistoryCompare(1, { symbol: 'XAUUSD', start_time: '2026-01-01', end_time: '2026-07-01', model_ids: [1, 2] })
    expect(result.ok).toBe(false)
    expect(result.error).toBe('admin_only')
  })
})
```

- [ ] **Step 4: Run tests**

Run: `npm test -- tests/ai/analyze-compare.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add server/routes/ai/strategy.js server/routes/ai/index.js tests/ai/analyze-compare.test.js
git commit -m "feat: add admin historical compare endpoint"
```

---

### Task 7: Frontend — Admin historical compare page

**Covers:** [S4]

**Files:**
- Create: `public/ai/model-compare.html`
- Modify: `server/routes/ai/index.js` (serve static page)
- Modify: `public/ai/styles.css` (compare page styles)

**Interfaces:**
- Consumes: `POST /ai/model-compare/history` from Task 6
- Produces: Static page at `/ai/model-compare`

- [ ] **Step 1: Create `model-compare.html`**

Create a standalone admin page with:
- Symbol dropdown
- Date range picker (start/end datetime-local inputs)
- Model multi-select checkboxes
- Strategy dropdown (optional)
- Run button + progress bar
- Results area: summary table + signal timeline cards

- [ ] **Step 2: Add route to serve the page**

In `server/routes/ai/index.js`, add:

```js
router.get('/ai/model-compare', authMiddleware, async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'admin_only' })
  res.sendFile(path.join(process.cwd(), 'public', 'ai', 'model-compare.html'))
})
```

Add `import path from 'path'` at top of `index.js` if not present.

- [ ] **Step 3: Add compare page CSS**

In `styles.css`, add styles for the admin compare page layout.

- [ ] **Step 4: Commit**

```bash
git add public/ai/model-compare.html server/routes/ai/index.js public/ai/styles.css
git commit -m "feat: add admin historical model compare page"
```

---

### Task 8: Integration test and verification

**Covers:** [S3, S4]

**Files:**
- Modify: `tests/ai/analyze-compare.test.js` (full integration tests)

- [ ] **Step 1: Run full test suite**

Run: `npm test`
Expected: ALL PASS

- [ ] **Step 2: Run dev server**

Run: `npm run dev`
Expected: No `[FATAL]` error

- [ ] **Step 3: Commit**

```bash
git add -A
git commit -m "test: add integration tests for multi-model compare feature"
```
