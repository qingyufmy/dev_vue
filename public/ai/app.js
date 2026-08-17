function getCookie(name) {
  const match = document.cookie.match(new RegExp('(?:^|; )' + name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '=([^;]*)'))
  return match ? decodeURIComponent(match[1]) : ''
}

const state = {
  token: window.AuthSession?.token() || localStorage.getItem("ws_token") || localStorage.getItem("authToken") || getCookie("ws_token") || "",
  user: null,
  aiAccess: null,
  observerChannels: [],
  selectedObserverChannelId: null,
  symbols: [],
  signals: [],
  selectedSignal: null,
  dashboardSignal: null,
  latestSignalId: null,
  analystView: "detail",
  analysisSelectionMode: "follow_latest",
  analysisSelectionSource: "initial",
  _lastGatewayLive: false,
  backgroundSyncTimer: null,
  lastQuote: null,
  lastObserverQuote: null,
  platformMarketSourceActive: false,
  currentConfigHasApiKey: false,
  pendingManualOrder: null,
  adminStrategyDispatchCapabilities: { enabled:false, supported_entry_methods:[] },
  adminStrategyDispatchCapabilitiesLoaded: false,
  adminStrategyDispatchPreview: null,
  adminStrategyDispatchPending: null,
  adminStrategyDispatch: null,
  adminStrategyDispatchPollTimer: null,
  adminStrategyDispatchPollGeneration: 0,
  accountBalance: 0,
  notificationUnread: 0,
  notificationImportantUnacknowledgedCount: 0,
  latestImportant: null,
  notificationSummaryFlight: null,
  notificationSummaryLoaded: false,
  notificationWsReady: false,
  bridgeAccountIdentity: null,
  mt5TimezoneOffsetMinutes: null,
  bridgePlatform: "mt5",
  bridgeRuntimeControl: null,
  historyNetResult: 0,

  signalTableData: [],
  signalTableTotal: 0,
  signalFilters: { direction: "", timeframe: "", page: 1, pageSize: 20 },
  historyFilters: { page: 1, pageSize: 20, closeFrom: "", closeTo: "" },
  historyQueryGeneration: 0,
  historyQueryState: null,
  historyRangeMeta: null,
  historyRangePreferenceKey: null,
  historyRangePreferences: null,
  historyChartDaily: [],
  historyChartSelectedDate: "",
  historyChartFocusIndex: -1,
  auditRows: [],
  auditFilters: { status: "", type: "", page: 1, pageSize: 20 },
  executionFilters: { page: 1, pageSize: 5, total: 0 },
  positionManagementTasks: [],
  positionManagementSettings: null,
  positionManagementFilters: { status: "", page: 1, pageSize: 10, total: 0 },
  selectedPositionManagementId: null,
  positionManagementRealtimeTimer: null,
  signalManagementRealtimeTimer: null,
  positions: [],
  pendingOrders: [],
  positionProtectionPreview: null,
  positionProtectionJob: null,
  positionProtectionPollTimer: null,
  adminStrategyClosePreview: null,
  adminStrategyClosePreviewTicket: null,
  adminStrategyClosePreviewRequestVersion: 0,
  adminStrategyCloseJob: null,
  adminStrategyClosePollTimer: null,
  adminStrategyClosePollGeneration: 0,
  adminStrategyCloseSubmitting: false,
  signalTickets: {},
  closeSignalTickets: {},
  analysisHistoryOffset: 0,
  analysisHistoryHasMore: true,
  analysisHistoryLoading: false,
  analysisHistoryPageLoaded: false,
  modelPurposeBindings: null,
  modelPurposeBindingsError: "",
  modelProfiles: [],
  modelCatalogSearch: "",
  modelCatalogStatus: "all",
  strategyFilter: "all",
  strategyDataCapabilities: null,
  strategyDataCapabilitiesStatus: "idle",
  strategyDataCapabilitiesRequestVersion: 0,
  reviewCases: [],
  reviewOverview: { pending: 0, issues: 0 },
  reviewSummary: { attention:0, unread:0, pending_confirmation:0, generating:0, failed:0, total:0, daily_total:0, monthly_total:0, daily_attention:0, monthly_attention:0 },
  reviewSummaryInitialized: false,
  reviewSummaryTimer: null,
  reviewDetailPollTimer: null,
  reviewDetailJobKey: null,
  reviewDetailRequestVersion: 0,
  reviewFilter: "",
  reviewPeriodFilter: "",
  reviewListOffset: 0,
  reviewListPageSize: 8,
  reviewListHasMore: true,
  reviewListLoading: false,
  reviewListError: "",
  reviewListRequestVersion: 0,
  reviewListObserver: null,
  manualAnalysisJob: null,
  manualAnalysisPollTimer: null,
  manualAnalysisPollGeneration: 0,
  manualAnalysisSubmitting: false,
  manualAnalysisCancelling: false,
  strategyMemoryStrategies: [],
  selectedStrategyMemoryId: null,
  strategyMemoryDetail: null,
  strategyMemoryCompressionJob: null,
  strategyMemoryCompressionJobs: {},
  strategyMemoryCompressionPollTimer: null,
  strategyMemoryCompressionPollKey: null,
  strategyMemoryCompressionPollGeneration: 0,
  strategyMemoryCompressionPollInFlight: false,
  strategyMemoryEditorBaseline: null,
  strategyMemoryEditorStrategyId: null,
  strategyMemoryEditorDirty: false,
  strategyMemoryEditorDraft: null,
  strategyMemoryViewMode: "preview",
  strategyMemoryPreview: null,
  strategyMemoryPreviewError: "",
  strategyMemoryConflictOnly: false,
  strategyMemoryConsistencyJob: null,
  strategyMemoryConsistencyPollTimer: null,
  strategyMemoryConsistencyGeneration: 0,
  strategyMemoryVisibilityBound: false,
  selectedReviewId: null,
  // Manual trade strategy review is deliberately isolated from the periodic
  // review state above.  Its selector uses the Bridge cursor contract while
  // review history continues to use the case list's offset pagination.
  reviewMemoryView: "reviews",
  manualTradeReviewView: "selection",
  manualTradeReviewFilters: { pageSize:20, cursor:null, historySnapshotId:null, rangeStartUtcMsc:null, rangeEndUtcMsc:null, symbol:"", direction:"" },
  manualTradeReviewCursorStack: [null],
  manualTradeReviewCursorIndex: 0,
  manualTradeReviewTrades: [],
  manualTradeReviewSelectedTrades: [],
  manualTradeReviewSelection: [],
  manualTradeReviewNextCursor: null,
  manualTradeReviewHasMore: false,
  manualTradeReviewScannedSourcePages: 0,
  manualTradeReviewSkippedEmptySourcePages: 0,
  manualTradeReviewUnavailable: false,
  manualTradeReviewEvidenceReason: "",
  manualTradeReviewHistoryScopeNote: "",
  manualTradeReviewHistorySourceLimited: false,
  manualTradeReviewLoading: false,
  manualTradeReviewLoaded: false,
  manualTradeReviewError: "",
  manualTradeReviewRequestVersion: 0,
  manualTradeReviewStrategies: [],
  manualTradeReviewStrategyLoading: false,
  manualTradeReviewStrategyId: null,
  manualTradeReviewSubmitting: false,
  manualTradeReviewCases: [],
  manualTradeReviewHistoryLoading: false,
  manualTradeReviewHistoryLoaded: false,
  manualTradeReviewHistoryError: "",
  manualTradeReviewSelectedId: null,
  selectedManualTradeReviewId: null,
  manualTradeReviewDetail: null,
  manualTradeReviewDetailLoading: false,
  manualTradeReviewDetailError: "",
  manualTradeReviewDetailRequestVersion: 0,
  manualTradeReviewPollTimer: null,
  manualTradeReviewPollGeneration: 0,
  manualTradeReviewPollRetryAttempt: 0,
  manualTradeReviewPollWaitingForVisible: false,
  manualTradeReviewPollInFlight: false,
  manualTradeReviewClientRequestId: null,
  manualTradeReviewHistoryOffset: 0,
  manualTradeReviewHistoryPageSize: 20,
  autoProgressCycles: {},
  autoProgressFlash: null,
  autoProgressVisual: {},
  inferenceChartTimeframe: null,
  inferenceChartSignalKey: null,
  inferenceChartLayers: { segments: true, centers: true, divergence: true, entries: true, levels: true },
};

const MANUAL_ANALYSIS_TASK_STORAGE_KEY = "aurum.ai.manual-analysis.task";
const MANUAL_ANALYSIS_POLL_INTERVAL_MS = 3000;
const MANUAL_ANALYSIS_TERMINAL_STATUSES = new Set([
  "succeeded", "failed", "cancelled", "status_unknown", "completed_stale", "expired",
]);

// ===== History Cache =====
let _historyCache = null;      // { filters: string, data: object }
let _historyChartCache = null; // { filters: string, data: object }
let _historyCursorState = {
  key:null, snapshotId:null, rangeStart:null, rangeEnd:null, pageCursors:new Map([[1, null]]),
};
const _historyTableFlights = new Map();
const _historyChartFlights = new Map();
const _historyViewsFlights = new Map();
const _historyCircuitBreakers = new Map();
const _historyErrorNotices = new Map();
const HISTORY_CURSOR_RANGE_INCOMPLETE_CODE = 'history_cursor_range_incomplete';
const HISTORY_RANGE_RETRY_INTERVAL_MS = 3000;
const HISTORY_RANGE_RETRY_MAX_ATTEMPTS = 20;
let _historyRangeRetryState = null;
let _historyDirty = true;
let _historyFreshnessRetry = null;
let _lastHistoryRevision = null;
// A history query is a UI transaction.  The generation is advanced only for
// an explicit range/filter/refresh operation (or when the history tab is
// entered for the first time); status probes, chart drill-down and cursor
// pagination stay inside the same transaction.
let _historyQueryGeneration = 0;
let _historyQueryState = null;
let _historyPrepareRetry = null;
const HISTORY_PREPARE_ACTION = "history_prepare_status_v1";
const HISTORY_PREPARE_UNSUPPORTED_CODE = "history_prepare_status_unsupported";
const HISTORY_PREPARE_RETRY_DELAYS_MS = [200, 400, 800, 1000];
const _historyTicketMapCache = new Map();
const _historyTicketMapFlights = new Map();
const HISTORY_FRESHNESS_RETRY_DELAYS_MS = [1000, 2000, 5000, 10000];
const HISTORY_FRESHNESS_RETRY_MAX_ATTEMPTS = 60;
// MT4 legacy history can return the visible rows before its SQLite summary is
// ready.  Keep this compatibility retry deliberately bounded: the backoff
// covers a slow terminal archive build without becoming a background poller;
// each attempt reuses the frozen range and the normal history-view flight guard
// rather than issuing another forced full-history package.
const HISTORY_LEGACY_SUMMARY_RETRY_DELAYS_MS = [2000, 5000, 10000, 20000, 30000, 60000, 90000];
const HISTORY_LEGACY_SUMMARY_RETRY_MAX_ATTEMPTS = HISTORY_LEGACY_SUMMARY_RETRY_DELAYS_MS.length;
let _historyLegacySummaryRetry = null;
const HISTORY_CIRCUIT_BREAKER_CODES = new Set([
  'bridge_data_request_disconnected',
  'bridge_history_route_required',
  'bridge_history_temporarily_unavailable',
]);
const HISTORY_CIRCUIT_BREAKER_TTL_MS = 5000;
const HISTORY_ABSOLUTE_FLOOR_DATE = "2000-01-01";
const HISTORY_DEFAULT_SCOPE = "platform";
const HISTORY_INVALID_OVERRIDE_CODES = new Set([
  "history_scope_override_invalid",
  "history_scope_start_invalid",
  "history_scope_start_before_floor",
  "history_scope_start_below_query_floor",
  "history_scope_before_query_floor",
  "history_scope_range_invalid",
  "history_scope_start_in_future",
  "history_scope_future",
  "history_range_override_invalid",
  "bridge_history_scope_override_invalid",
  "bridge_history_scope_start_invalid",
  "bridge_history_scope_start_before_floor",
  "bridge_history_scope_start_below_query_floor",
  "bridge_history_scope_start_in_future",
  "bridge_history_before_supported_start",
]);
let _prevPositionCount = 0;
let _sessionInvalidating = false;

function normalizeBridgePlatform(value) {
  return String(value || "").trim().toLowerCase() === "mt4" ? "mt4" : "mt5";
}

function bridgePlatformLabel(value = state.bridgePlatform) {
  return normalizeBridgePlatform(value).toUpperCase();
}

function bridgeAccountConnectPrompt(value = state.bridgePlatform) {
  return `请先连接您的 ${bridgePlatformLabel(value)} 账户`;
}

function normalizeHistoryBroker(value) {
  return String(value || "").trim().toLowerCase();
}

function historyStableAccountKey(identity = state.bridgeAccountIdentity) {
  const platform = normalizeBridgePlatform(identity?.platform || state.bridgePlatform);
  const broker = normalizeHistoryBroker(identity?.brokerServerKey || identity?.broker_server || identity?.server);
  const login = String(identity?.loginAccount ?? identity?.login_account ?? identity?.login ?? "").trim();
  if (!broker || !login) return "";
  return `${platform}|${broker}|${login}`;
}

function validHistoryBusinessDate(value) {
  const text = String(value || "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return false;
  const parsed = new Date(`${text}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime())) return false;
  return parsed.toISOString().slice(0, 10) === text;
}

function prepareHistoryRangePreferenceForIdentity() {
  const key = historyStableAccountKey();
  if (!key) {
    state.historyRangePreferenceKey = null;
    state.historyRangePreferences = null;
    if ($("historyRangeMode")) $("historyRangeMode").value = HISTORY_DEFAULT_SCOPE;
    if ($("historyRangeFrom")) $("historyRangeFrom").value = "";
    if ($("historyRangeTo")) $("historyRangeTo").value = "";
    state.historyRangeMeta = null;
    updateHistoryRangeUI({ pending:true });
    return;
  }
  if (state.historyRangePreferenceKey === key) return;
  state.historyRangePreferenceKey = key;
  // Persistent history starts are owned by the server. Keep only the values
  // confirmed for the active source account in memory so changing browsers,
  // users or observer channels cannot fork the preference.
  state.historyRangePreferences = {
    starts:{ all:"", platform:"", custom:"" },
  };
  const mode = HISTORY_DEFAULT_SCOPE;
  const rangeMode = $("historyRangeMode");
  if (rangeMode) rangeMode.value = mode;
  const savedStart = state.historyRangePreferences.starts?.[mode] || "";
  const from = $("historyRangeFrom");
  const to = $("historyRangeTo");
  if (from) from.value = savedStart;
  if (to) to.value = "";
  state.historyRangeMeta = null;
  state.historyChartSelectedDate = "";
  state.historyChartFocusIndex = -1;
  updateHistoryRangeUI({ pending:true });
}

function historyPreferenceStart(scope) {
  return state.historyRangePreferences?.starts?.[scope]
    && validHistoryBusinessDate(state.historyRangePreferences.starts[scope])
    ? state.historyRangePreferences.starts[scope] : "";
}

function historyRememberServerStart(scope, date) {
  if (!(scope === "all" || scope === "platform")) return false;
  const preferences = state.historyRangePreferences || {
    starts:{ all:"", platform:"", custom:"" },
  };
  preferences.starts = {
    all:"", platform:"", custom:"", ...(preferences.starts || {}),
    [scope]:validHistoryBusinessDate(date) ? String(date) : "",
  };
  state.historyRangePreferences = preferences;
  return true;
}

function historyClearSavedStart(scope) {
  if (!(scope === "all" || scope === "platform")) return false;
  const preferences = state.historyRangePreferences || {
    starts:{ all:"", platform:"", custom:"" },
  };
  preferences.starts = { all:"", platform:"", custom:"", ...(preferences.starts || {}), [scope]:"" };
  state.historyRangePreferences = preferences;
  return true;
}

function renderGatewayConnectionBadge(isLive, usingFallback) {
  const platform = bridgePlatformLabel();
  if (state.bridgeRuntimeControl?.desired_state === "paused") {
    setBadge("gatewayMode", usingFallback || isObserverMode()
      ? "观摩模式 · 桥接已暂停"
      : `${platform} 已暂停`, "warning");
    return;
  }
  if (usingFallback) {
    const reconnecting = state.bridgeRuntimeControl?.actual_state === "reconnecting";
    setBadge("gatewayMode", state.isPlusReadOnly
      ? "观摩模式"
      : reconnecting ? "观摩模式 · 桥接恢复中" : `观摩模式 · 请连接 ${platform}`, "warning");
    return;
  }
  setBadge("gatewayMode", isLive ? `${platform} 已连接` : `${platform} 未连接`, isLive ? "connected" : "neutral");
}

function syncManualOrderPlatformCapabilities() {
  const stopLimitButton = document.querySelector('.order-type-btn[data-type="stop_limit"]');
  if (!stopLimitButton) return;
  const unsupported = state.bridgePlatform === "mt4";
  stopLimitButton.hidden = unsupported;
  stopLimitButton.disabled = unsupported;
  stopLimitButton.setAttribute("aria-hidden", String(unsupported));
  stopLimitButton.title = unsupported ? "MT4 不支持止损限价单" : "";
  if (!unsupported || state.selectedOrderType !== "stop_limit") return;
  state.selectedOrderType = "market";
  document.querySelectorAll(".order-type-btn").forEach((button) => {
    button.classList.toggle("active", button.dataset.type === "market");
    button.setAttribute("aria-pressed", String(button.dataset.type === "market"));
  });
  const pendingRow = $("pendingPriceRow");
  const stopLimitWrap = $("stopLimitPriceWrap");
  if (pendingRow) {
    pendingRow.style.display = "none";
    pendingRow.setAttribute("aria-hidden", "true");
  }
  if (stopLimitWrap) {
    stopLimitWrap.style.display = "none";
    stopLimitWrap.setAttribute("aria-hidden", "true");
  }
}

function updateBridgePlatformUI(value) {
  state.bridgePlatform = normalizeBridgePlatform(value);
  if (state.bridgeAccountIdentity) {
    if (typeof setHistoryAccountIdentity === "function") {
      setHistoryAccountIdentity({ ...state.bridgeAccountIdentity, platform:state.bridgePlatform });
    }
  }
  syncManualOrderPlatformCapabilities();
  const label = bridgePlatformLabel();
  setText("bridgePlatformClockLabel", label);
  setText("bridgePlatformTimeLabel", `${label}服务器时间`);
  document.querySelectorAll("[data-bridge-platform-template]").forEach((node) => {
    node.textContent = String(node.dataset.bridgePlatformTemplate || "").replaceAll("{platform}", label);
  });
  const gateway = $("gatewayMode");
  if (gateway) gateway.title = `打开 ${label} 连接设置`;
}

// ===== Global Symbol Management =====
const SYMBOL_STORAGE_KEY = "aurum_selected_symbol";
const _symSelectors = []; // registered selector IDs

function getGlobalSymbol() {
  return localStorage.getItem(SYMBOL_STORAGE_KEY) || "XAUUSD";
}

function standardMarketSymbol(symbol) {
  return String(symbol || "").trim().replace(/\.(a|s|c|pro|std|z|ecn|m|raw|mini)$/i, "").toUpperCase();
}

function setGlobalSymbol(symbol, options = {}) {
  localStorage.setItem(SYMBOL_STORAGE_KEY, symbol);
  state.platformMarketSourceActive = false;
  state.lastObserverQuote = null;
  for (const id of _symSelectors) {
    const el = document.getElementById(id);
    if (el && el._symSet) el._symSet(symbol);
  }
  wsApi("set_quote_symbol", { symbol }).catch(() => {});
  if (options.refreshData !== false) {
    refreshQuote().catch(() => {});
    loadKlineData().catch(() => {});
  }
}

// ===== Searchable Symbol Selector =====
function createSymbolSelector(inputId, options, opts = {}) {
  const input = document.getElementById(inputId);
  if (!input) return;
  // Check observe mode: disable selector for Plus/Pro-no-bridge
  const isPlusReadOnly = state.aiAccess?.reason === 'plus_plan';
  const isObserveMode = isObserverMode();
  const wrapper = document.createElement("div");
  wrapper.className = "sym-selector";
  input.parentNode.insertBefore(wrapper, input);
  wrapper.appendChild(input);
  input.className = "sym-input";
  input.setAttribute("autocomplete", "off");
  input.setAttribute("placeholder", "搜索品种...");

  // Disable in observe mode
  if (isObserveMode) {
    input.disabled = true;
    input.title = isPlusReadOnly ? 'Plus 会员仅可查看' : bridgeAccountConnectPrompt();
  }

  const dropdown = document.createElement("div");
  dropdown.className = "sym-dropdown";
  wrapper.appendChild(dropdown);

  let currentSymbol = getGlobalSymbol();
  let filtered = [...options];
  let highlightIdx = -1;

  function render(filter) {
    const q = (filter || "").toUpperCase();
    filtered = q ? options.filter(s => s.toUpperCase().includes(q)) : [...options];
    highlightIdx = -1;
    if (!filtered.length) {
      dropdown.innerHTML = `<div class="sym-empty">未找到匹配品种</div>`;
      return;
    }
    dropdown.innerHTML = filtered.map((s, i) =>
      `<div class="sym-option${s === currentSymbol ? " active" : ""}" data-symbol="${s}" data-idx="${i}">${s}</div>`
    ).join("");
  }

  function open() { render(input.value); dropdown.classList.add("open"); }
  function close() { dropdown.classList.remove("open"); }

  input.addEventListener("focus", () => { open(); input.select(); });
  input.addEventListener("input", () => { render(input.value); dropdown.classList.add("open"); });
  input.addEventListener("keydown", (e) => {
    if (e.key === "Escape") { close(); input.blur(); return; }
    if (e.key === "ArrowDown") { e.preventDefault(); highlightIdx = Math.min(highlightIdx + 1, filtered.length - 1); updateHighlight(); }
    if (e.key === "ArrowUp") { e.preventDefault(); highlightIdx = Math.max(highlightIdx - 1, 0); updateHighlight(); }
    if (e.key === "Enter") {
      e.preventDefault();
      if (highlightIdx >= 0 && highlightIdx < filtered.length) selectSymbol(filtered[highlightIdx]);
      else if (filtered.length === 1) selectSymbol(filtered[0]);
    }
  });
  dropdown.addEventListener("mousedown", (e) => {
    const opt = e.target.closest(".sym-option");
    if (opt) selectSymbol(opt.dataset.symbol);
  });
  if (!wrapper._docClickHandler) {
    wrapper._docClickHandler = (e) => { if (!wrapper.contains(e.target)) close(); };
    document.addEventListener("click", wrapper._docClickHandler);
  }

  function updateHighlight() {
    dropdown.querySelectorAll(".sym-option").forEach((el, i) => {
      el.classList.toggle("active", i === highlightIdx);
    });
    if (highlightIdx >= 0) {
      const el = dropdown.children[highlightIdx];
      if (el) el.scrollIntoView({ block: "nearest" });
    }
  }

  function selectSymbol(sym) {
    currentSymbol = sym;
    input.value = sym;
    close();
    if (!opts.noGlobalSync) setGlobalSymbol(sym);
  }

  input.value = currentSymbol;
  input._symSet = (sym) => { currentSymbol = sym; input.value = sym; };
  _symSelectors.push(inputId);
}

const $ = (id) => document.getElementById(id);
let modalReturnFocus = null;

function openFormModal(editor) {
  if (!editor) return;
  document.querySelectorAll(".form-modal:not(.hidden)").forEach(modal => modal.classList.add("hidden"));
  modalReturnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  editor.classList.remove("hidden");
  document.body.classList.add("form-modal-open");
  requestAnimationFrame(() => editor.querySelector(".form-modal-dialog")?.focus());
}

const ANALYSIS_HISTORY_PAGE_SIZE = 10;

function closeFormModal(editor, restoreFocus = true) {
  if (!editor) return;
  editor.classList.add("hidden");
  if (!document.querySelector(".form-modal:not(.hidden)")) document.body.classList.remove("form-modal-open");
  if (restoreFocus && modalReturnFocus?.isConnected) modalReturnFocus.focus();
  modalReturnFocus = null;
}

function strategyEditorSnapshot() {
  const value = id => $(id)?.value ?? "";
  const normalizeText = input => String(input ?? "").replace(/\r\n/g, "\n").trim();
  const symbols = normalizeText(value("strategySymbols"))
    .split(",").map(item => item.trim().toUpperCase()).filter(Boolean).join(",");
  const plan = strategyEditorMarketPlanFromControls();
  return JSON.stringify({
    title: normalizeText(value("strategyTitle")),
    symbols,
    description: normalizeText(value("strategyDescription")),
    prompt: normalizeText(value("strategyPrompt")),
    interval: Number(value("strategyInterval")) || 0,
    scope: normalizeText(value("strategyScope")),
    visibility: normalizeText(value("strategyVisibility")),
    model: value("strategyModelProfile") || "",
    portfolio: Boolean($("strategyIncludePortfolioContext")?.checked),
    chan: Boolean($("strategyUseChanAnalysis")?.checked),
    ema: Boolean($("strategyUseEma34Data")?.checked),
    emaTimeframe: value("strategyEma34Timeframe") || "",
    plan: {
      primary_timeframe: String(plan.primary_timeframe || "").toUpperCase(),
      timeframes: plan.timeframes.map(item => ({ timeframe: String(item.timeframe).toUpperCase(), kline_count: Number(item.kline_count) || 0 })),
    },
    entryMethods: [...document.querySelectorAll("[data-strategy-entry-method]:checked")]
      .map(input => String(input.dataset.strategyEntryMethod || "")).filter(Boolean).sort(),
  });
}

function strategyEditorMinimumReady() {
  const title = $("strategyTitle")?.value.trim();
  const symbols = $("strategySymbols")?.value.split(",").map(value => value.trim()).filter(Boolean);
  const hasTimeframe = strategyEditorMarketPlanFromControls().timeframes.length > 0;
  const hasEntryMethod = document.querySelector("[data-strategy-entry-method]:checked");
  return Boolean(title && symbols?.length && hasTimeframe && hasEntryMethod);
}

function strategyEditorSetStatus(message) {
  const status = $("strategyEditorStatus");
  if (status) status.textContent = message;
}

function strategyEditorUpdateState() {
  const editor = $("strategyEditor");
  if (!editor || editor.classList.contains("hidden")) return false;
  const baseline = editor._strategyEditorBaseline;
  const dirty = Boolean(baseline && strategyEditorSnapshot() !== baseline);
  editor.dataset.dirty = dirty ? "1" : "0";
  if (!editor.dataset.strategySaving) {
    strategyEditorSetStatus(dirty ? "有未保存修改" : "未修改");
  }
  const button = $("saveStrategyBtn");
  if (button && !editor.dataset.strategySaving) {
    button.disabled = !dirty || !strategyEditorMinimumReady();
  }
  return dirty;
}

function strategyEditorAnnounceEscape() {
  const editor = $("strategyEditor");
  if (!editor || editor.classList.contains("hidden") || editor.dataset.escapeAnnounced) return;
  editor.dataset.escapeAnnounced = "1";
  strategyEditorSetStatus("请使用关闭按钮退出策略编辑器");
  setTimeout(() => {
    if (!editor.classList.contains("hidden")) {
      delete editor.dataset.escapeAnnounced;
      strategyEditorUpdateState();
    }
  }, 2400);
}

async function requestCloseStrategyEditor() {
  const editor = $("strategyEditor");
  if (!editor || editor.classList.contains("hidden")) return;
  const active = document.activeElement;
  if (!strategyEditorUpdateState()) {
    closeFormModal(editor);
    return;
  }
  const confirmed = await showConfirm("放弃未保存的修改？", "关闭后当前策略正文和设置不会保存。", { confirmText:"放弃并关闭", cancelText:"继续编辑", danger:true });
  if (confirmed) closeFormModal(editor);
  else if (active?.focus) active.focus();
}

function handleFormModalKeydown(event) {
  const modal = event.target.closest?.(".form-modal");
  if (!modal) return;
  if (event.key === "Escape") {
    event.preventDefault();
    if (modal.dataset.closePolicy === "explicit") {
      strategyEditorAnnounceEscape();
      return;
    }
    if (modal.id === "positionProtectionModal") {
      closePositionProtectionModal();
      return;
    }
    closeFormModal(modal);
    return;
  }
  if (event.key !== "Tab") return;
  const focusable = [...modal.querySelectorAll('button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), summary, [tabindex]:not([tabindex="-1"])')]
    .filter(element => element.offsetParent !== null);
  if (!focusable.length) return;
  const first = focusable[0], last = focusable[focusable.length - 1];
  if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
  else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
}

const REASON_MAP = {
  skipped: "已跳过（未满足执行条件）",
  admin_account_excluded: "与管理员源账户相同，已作为源账户单独执行",
  model_task_status_unknown: "模型服务商状态暂不可确认，正在安全恢复并避免重复请求",
  model_task_active: "上一轮模型任务仍在运行，等待完成",
  model_task_cooldown: "本轮模型任务已完成，等待完整配置周期",
  model_task_completion_unknown: "模型任务完成时间未知，等待恢复确认",
  model_task_gate_failed: "模型任务运行时暂不可用，等待恢复",
  deployment_draining: "系统正在安全排空，等待任务完成",
  deployment_drain_check_failed: "部署排空状态暂不可确认，暂停启动新分析",
  "Request executed": "MT5 已执行",
  "Unsupported filling mode": "MT5 不支持当前成交模式，已自动适配",
  "Invalid price": "MT5 拒绝挂单：挂单价格无效",
  "Invalid stops": "MT5 拒绝挂单：止损或止盈价格无效",
  "AutoTrading disabled by client": "MT5 客户端关闭了自动交易",
  mt5_terminal_autotrading_disabled: "MT5 终端自动交易关闭",
  mt5_account_trade_disabled: "MT5 账户禁止交易",
  mt5_account_expert_trading_disabled: "MT5 账户禁止 EA/脚本交易",
  mt4_trade_not_allowed: "MT4 自动交易或 EA 实时交易权限未开启",
  mt4_terminal_not_connected: "MT4 当前未连接交易服务器",
  mt4_terminal_trade_not_allowed: "MT4 终端的自动交易总开关未开启",
  mt4_program_trade_not_allowed: "MT4 EA 属性中的“允许实时自动交易”未开启",
  mt4_account_trade_not_allowed: "当前 MT4 账户不允许交易，请确认使用交易密码登录且账户状态正常",
  mt4_account_expert_trade_disabled: "MT4 交易服务器已禁止该账户使用 EA 自动交易，请联系经纪商或更换允许 EA 交易的账户",
  mt4_trade_context_busy: "MT4 交易环境正忙，请稍后重试",
  mt4_error_6: "MT4 当前未连接交易服务器",
  mt4_error_133: "MT4 交易服务器已禁止当前账户交易",
  mt4_error_146: "MT4 交易环境正忙，请稍后重试",
  mt4_error_4109: "MT4 EA 未允许实时自动交易，请检查 EA 属性设置",
  mt4_error_4112: "MT4 交易服务器已禁止该账户使用 EA 自动交易，请联系经纪商或更换允许 EA 交易的账户",
  manual_trade_review_mt4_visible_history_incomplete: "MT4 只复盘终端当前可见历史，请在 MT4“账户历史”中选择“全部历史”后刷新；系统不会宣称券商全量历史",
  manual_trade_review_mt4_visible_history_unknown: "当前 MT4 桥接未提供可见历史完整性证明，请升级桥接并在 MT4“账户历史”中选择“全部历史”后刷新",
  manual_trade_review_source_changed: "订单来源或冻结交易历史已发生变化，请刷新后重新选择",
  manual_trade_review_output_evidence_quality_invalid: "模型返回的证据质量与冻结证据不一致，请重试生成",
  manual_trade_review_evidence_quality_invalid: "模型返回的证据质量无效，请重试生成",
  manual_trade_review_job_not_found: "复盘生成任务不存在或已失效，请刷新复盘历史",
  manual_trade_review_retry_exhausted: "复盘生成重试次数已用尽，请重新创建复盘任务",
  market_evidence_unavailable: "行情证据暂不可用，请刷新交易记录后重试",
  chan_evidence_incomplete: "缠论证据未完整返回，本次仅保留证据不足结论",
  market_path_candle_coverage_incomplete: "行情 K 线覆盖不完整，本次仅保留证据不足结论",
  holding_path_bar_boundary_insufficient: "持仓区间缺少完整闭合 K 线，本次仅保留证据不足结论",
  manual_trade_review_generation_deadline_exceeded: "本轮复盘已超过 30 分钟生成期限，请手动重试以创建新一代任务",
  manual_trade_review_model_task_terminal_requires_retry: "本轮模型任务已经终止，请手动重试以创建新一代任务",
  manual_trade_review_approved_locked: "复盘已确认，不能再改写或切换确认版本",
  model_task_not_claimable: "复盘任务正在被其他生成流程处理，请稍后刷新",
  model_task_duplicate_terminal: "上一轮复盘任务已有最终结果，请刷新复盘历史",
  model_task_lease_active: "复盘任务仍在处理中，请稍后刷新",
  history_cursor_range_incomplete: "正在准备所选范围的交易记录，请稍后刷新",
  hold_signal_cannot_execute: "已跳过（观望信号）",
  signal_expired: "已跳过（信号已过期）",
  signal_already_executed_or_pending: "该信号已经执行或已有挂单，不能重复执行",
  kimi_code_model_not_supported: "Kimi Code 模型名称无效，请选择 k3、kimi-for-coding 或 kimi-for-coding-highspeed",
  kimi_code_subscription_or_model_permission_denied: "Kimi Code 订阅或模型权限不足，请检查会员档位、API Key 和模型名称",
  kimi_code_rate_limited: "Kimi Code 订阅额度或五小时频率窗口已用尽，请稍后再试",
  kimi_code_request_rejected: "Kimi Code 拒绝了本次请求，请检查内容与账户状态",
  kimi_code_request_invalid: "Kimi Code 请求参数不兼容，请检查模型与思考设置",
  kimi_code_service_unavailable: "Kimi Code 服务暂时不可用，请稍后再试",
  model_token_limits_invalid: "最大输入和最大输出不能超过上下文窗口，请修改后重试",
  model_token_limits_unconfirmed: "该模型限制尚未确认，请编辑模型并保存验证后再使用、设为默认或绑定策略",
  model_token_limits_stale: "模型身份或限制已变化，请重新编辑并保存验证",
  strategy_memory_version_conflict: "记忆库已被其他操作更新，请刷新后重新编辑",
  strategy_version_conflict: "策略已在其他位置更新，请刷新后对比再保存；当前草稿已保留",
  strategy_data_capabilities_unavailable: "策略数据能力目录暂不可用，请稍后重试",
  strategy_indicator_declaration_invalid: "EMA34 数据声明无效，请检查周期后重试",
  strategy_indicator_advanced_conflict: "当前 EMA34 使用高级配置，简单开关不会覆盖",
  strategy_indicator_advanced_configuration: "当前 EMA34 使用高级配置，简单开关不会覆盖",
  strategy_data_runtime_confirmation_required: "请确认启用 EMA34 数据计算；这不会自动加入交易规则",
  ema34_timeframe_required: "请先选择 EMA34 计算周期",
  ema34_timeframe_not_in_market_plan: "EMA34 周期必须来自当前已启用的行情周期",
  indicator_declarations_invalid: "指标数据声明无效，请检查 EMA34 周期后重试",
  indicator_declaration_unsupported: "当前指标声明不受简单编辑器支持，高级配置已保留",
  indicator_declaration_duplicate: "指标数据声明重复，请刷新后重试",
  ema34_declaration_invalid: "EMA34 数据声明无效，请检查周期后重试",
  strategy_policy_mutation_ambiguous: "高级策略配置无法安全合并，当前草稿已保留",
  strategy_expected_version_invalid: "策略版本信息无效，请刷新策略后重试",
  chan_timeframe_unsupported: "缠论只支持已选行情中的 M5、M15、H1 或 H4 周期",
  strategy_memory_capacity_exceeded: "记忆库已超过容量上限，请先压缩后再保存",
  strategy_memory_compression_output_invalid: "模型返回的压缩结果无效，请重试或人工整理记忆库",
  strategy_memory_compression_stale: "记忆库在压缩期间已更新，本次结果未应用，请重新压缩",
  strategy_memory_compression_job_not_found: "整理任务不存在或已失效，请刷新后重试",
  strategy_memory_library_unavailable: "统一记忆库暂不可用，本次分析已安全取消，请稍后重试",
  strategy_memory_forbidden: "无权访问该策略的记忆库",
  strategy_memory_platform_forbidden: "只有平台内容管理员可以修改平台策略记忆库",
  strategy_memory_strategy_not_active: "该策略当前不可用，无法读取记忆库",
  model_context_window_invalid: "上下文窗口配置无效，请按模型文档修改为正整数",
  model_max_input_tokens_invalid: "最大输入配置无效，请按模型文档修改为正整数",
  model_max_output_tokens_invalid: "最大输出配置无效，请按模型文档修改为正整数",
  model_token_limits_rejected: "当前模型不接受所填限制，请修改上下文窗口、最大输入或最大输出",
  model_input_limit_exceeded: "当前输入超过模型的最大输入限制，请增大配置或减少本次输入",
  model_context_limit_exceeded: "当前请求超过模型上下文窗口，请修改上下文窗口或减少本次输入",
  model_output_limit_exceeded: "当前模型不接受所填最大输出，请按模型文档修改最大输出",
  model_name_invalid: "模型名称不可用，请核对模型名称和接口类型",
  model_protocol_unsupported: "模型调用协议不可用，请核对接口类型和模型服务商",
  model_request_unauthorized: "认证失败，请检查 API Key 或订阅权限",
  model_request_forbidden: "认证失败，请检查 API Key 或订阅权限",
  model_authentication_failed: "认证失败，请检查 API Key 或订阅权限",
  model_rate_limited: "服务商限流，配置尚未完成验证，请稍后再次保存",
  model_request_rate_limited: "服务商限流，配置尚未完成验证，请稍后再次保存",
  model_service_unavailable: "服务暂时不可用，配置尚未完成验证",
  model_connection_unavailable: "服务暂时不可用，配置尚未完成验证",
  model_connection_timeout: "服务暂时不可用，配置尚未完成验证",
  model_dns_failed: "服务暂时不可用，请检查接口地址后再次保存",
  model_output_incomplete: "模型连接成功但验证输出不完整，请检查思考和最大输出配置",
  model_validation_output_incomplete: "模型连接成功但验证输出不完整，请检查思考和最大输出配置",
  model_connection_auth_failed: "认证失败，请检查 API Key 或订阅权限",
  model_connection_invalid_api_key: "认证失败，请检查 API Key 或订阅权限",
  model_connection_rate_limited: "服务商限流，配置尚未完成验证，请稍后再次保存",
  model_connection_model_unavailable: "模型或调用协议不可用，请核对模型名称和接口类型",
  model_connection_request_rejected: "模型服务拒绝了当前请求，请核对模型名称、调用协议和三个 Token 限制",
  model_connection_token_limits_rejected: "当前模型不接受所填限制，请修改上下文窗口、最大输入或最大输出",
  model_connection_output_incomplete: "模型连接成功但验证输出不完整，请检查思考和最大输出配置",
  unsupported_model_provider: "不支持这个模型服务商",
  model_endpoint_invalid_url: "模型接口地址格式不正确",
  model_endpoint_credentials_forbidden: "模型接口地址不能包含用户名或密码",
  model_endpoint_https_required: "模型接口地址必须使用 HTTPS",
  model_endpoint_protocol_forbidden: "模型接口地址协议不受支持",
  model_endpoint_private_network_forbidden: "为保护服务器安全，模型接口不能指向本机或内网地址",
  model_endpoint_dns_failed: "模型接口域名无法解析，请检查地址是否正确",
  model_profile_default_in_use: "该模型仍是默认模型，请先设置另一个默认模型",
  model_profile_in_use: "该模型仍被策略绑定，请先为相关策略更换模型",
  model_profile_delete_confirmation_mismatch: "删除确认信息不匹配，请重新操作",
  no_active_auto_trade_config: "已跳过（自动交易未开启）",
  open_position_exists: "已跳过（当前品种已有持仓）",
  position_check_failed: "已跳过（持仓检查失败）",
  invalid_order_type: "方向无效，已拒绝",
  volume_exceeds_config_limit: "手数超过配置上限，已拒绝",
  max_open_positions_reached: "持仓数量达到上限，已拒绝",
  signal_price_slippage_exceeded: "信号参考价与当前报价偏离过大，已拒绝",
  auto_trade_disabled: "当前订阅没有开启自动执行",
  execution_disabled: "当前订阅没有开启自动执行",
  scheduler_disabled: "自动交易调度未开启",
  symbol_not_subscribed: "当前订阅未包含该交易品种",
  membership_not_eligible: "当前会员套餐不支持自动执行",
  membership_expired: "会员已到期",
  account_not_active: "交易账户当前未激活",
  ownership_unavailable: "交易账户归属尚未确认",
  source_account_not_active: "管理员源账户当前未激活",
  source_ownership_unavailable: "管理员源账户归属尚未确认",
  source_trade_send_disabled: "管理员源账户已关闭交易发送",
  source_bridge_offline: "管理员源账户的交易终端桥接当前未连接",
  source_bridge_trade_disabled: "管理员源账户的交易终端自动交易权限未开启",
  bridge_offline: "用户的交易终端桥接当前未连接",
  bridge_trade_disabled: "交易终端自动交易权限未开启",
  risk_halted: "账户风控已暂停交易",
  user_quote_unavailable: "无法获取用户交易平台的有效报价",
  stop_loss_missing: "AI 信号缺少有效止损价格",
  invalid_stop_loss_direction: "止损价格方向与订单方向不一致",
  take_profit_target_missing: "所选止盈档位没有有效目标价格",
  invalid_take_profit_direction: "止盈价格方向与订单方向不一致",
  pending_list_unavailable: "无法读取当前交易平台挂单列表",
  pending_list_confirm_unavailable: "替换旧挂单后无法复核最新挂单列表",
  pending_list_confirm_failed: "替换旧挂单后的挂单复核失败",
  pending_supersede_incomplete: "同方向旧挂单尚未完全替换",
  pending_limit_reached: "当前品种的挂单数量已达到限制",
  ai_pending_order_disabled: "平台已关闭 AI 挂单",
  ai_pending_cancel_disabled: "平台已关闭 AI 取消挂单",
  subscription_inactive: "策略订阅当前未启用",
  outside_schedule: "当前不在自动推理运行时段内",
  trade_send_disabled: "交易发送已关闭",
  weekly_flatten_window: "周末风险控制处理中",
  system_execution_exception: "系统执行异常，详细信息已记录",
  lock_lost_before_supersede_cancel: "任务执行权已失效，未继续替换旧挂单",
  lock_lost_before_pending_confirm: "任务执行权已失效，未继续复核挂单",
  lock_lost_before_send: "任务执行权已失效，订单未发送到交易平台",
  bridge_upgrade_required_for_incremental_risk: "桥接软件版本过旧，请从源码重启或升级到最新版后重试",
  risk_snapshot_failed: "无法获取完整的交易平台风险快照，已为安全起见阻止交易",
  confirmation_required: "需要人工确认",
  rejected: "风控拒绝",
  success: "成功",
  error: "错误",
};

const HTML_ESCAPE = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#039;",
};

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => HTML_ESCAPE[char]);
}

function userMembershipPresentation(user = {}) {
  const plan = ['pro', 'plus', 'free'].includes(String(user.plan)) ? String(user.plan) : 'free';
  const expired = plan !== 'free' && Boolean(Number(user.membership_expired ?? user.membershipExpired));
  const activeLabels = { pro:'Pro 专业版', plus:'Plus 观摩版', free:'免费用户' };
  const expiredLabels = { pro:'Pro 已过期', plus:'Plus 已过期' };
  return {
    plan,
    expired,
    label:expired ? expiredLabels[plan] : activeLabels[plan],
    className:expired ? 'chip-expired' : `chip-${plan}`,
  };
}

function raw(value) {
  return value === null || value === undefined || value === "" ? "--" : String(value);
}

function fmt(value, digits = 2) {
  const num = Number(value);
  if (!Number.isFinite(num)) return "--";
  return num.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

function formatTime(value) {
  if (!value) return "--";
  const numeric = Number(value);
  if (Number.isFinite(numeric) && numeric > 1_000_000_000) {
    const milliseconds = numeric > 10_000_000_000 ? numeric : numeric * 1000;
    const date = new Date(milliseconds);
    if (!Number.isNaN(date.getTime())) return date.toISOString().replace("T", " ").slice(0, 19);
  }
  return String(value).replace("T", " ").slice(0, 19);
}

function terminalQuoteTimezoneOffsetMinutes(quote) {
  const status = String(quote?.clock_status || '').trim().toLowerCase();
  if (!status || ["unknown", "unavailable", "unverified", "calibrating", "fallback"].includes(status)) return null;
  const rawOffset = quote?.timezone_offset_minutes;
  if (rawOffset === null || rawOffset === undefined || rawOffset === '') return null;
  const offsetMinutes = Number(rawOffset);
  return Number.isInteger(offsetMinutes) && offsetMinutes >= -840 && offsetMinutes <= 840
    ? offsetMinutes : null;
}

function syncTerminalTimezoneOffset(payload) {
  if (!payload || typeof payload !== "object") return null;
  const hasClockEvidence = Object.prototype.hasOwnProperty.call(payload, "timezone_offset_minutes")
    || Object.prototype.hasOwnProperty.call(payload, "clock_status");
  const offset = terminalQuoteTimezoneOffsetMinutes(payload);
  const previousOffset = state.mt5TimezoneOffsetMinutes;
  if (hasClockEvidence && offset !== null) state.mt5TimezoneOffsetMinutes = offset;
  if (previousOffset !== state.mt5TimezoneOffsetMinutes) scheduleTerminalTimeRefresh();
  return offset;
}

function terminalQuoteObservedAtUtcMsc(quote) {
  const observedAt = Number(quote?.observed_at_utc_msc);
  if (Number.isFinite(observedAt) && observedAt > 0) return observedAt;
  const time = String(quote?.time || '').trim();
  if (!/(?:z|[+-]\d{2}:?\d{2})$/i.test(time)) return null;
  const parsed = Date.parse(time);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function formatTerminalQuoteTime(quote) {
  const observedAt = terminalQuoteObservedAtUtcMsc(quote);
  const offsetMinutes = terminalQuoteTimezoneOffsetMinutes(quote);
  if (Number.isFinite(observedAt) && observedAt > 0 && offsetMinutes !== null) {
    return fmtUtc(new Date(observedAt + offsetMinutes * 60_000));
  }
  return formatTime(quote?.time);
}

const fmtUtc = (d) => {
  if (!d || isNaN(d)) return "--";
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`;
};

function validTerminalTimezoneOffsetMinutes(value) {
  if (value === null || value === undefined || value === "") return null;
  const offset = Number(value);
  return Number.isInteger(offset) && offset >= -840 && offset <= 840 ? offset : null;
}

function terminalEventTimezoneOffsetMinutes(record = {}, explicitOffset = null) {
  const candidates = [
    record?.terminal_timezone_offset_minutes,
    record?.mt5_timezone_offset_minutes,
    record?.timezone_offset_minutes,
    explicitOffset,
    state.mt5TimezoneOffsetMinutes,
  ];
  for (const candidate of candidates) {
    const offset = validTerminalTimezoneOffsetMinutes(candidate);
    if (offset !== null) return offset;
  }
  return null;
}

function terminalTimeFromUtcMsc(utcMsc, preferredOffset = null) {
  const timestamp = Number(utcMsc);
  if (!Number.isFinite(timestamp) || timestamp <= 0) return null;
  const offset = validTerminalTimezoneOffsetMinutes(preferredOffset)
    ?? validTerminalTimezoneOffsetMinutes(state.mt5TimezoneOffsetMinutes);
  if (offset === null) return null;
  return fmtUtc(new Date(timestamp + offset * 60_000));
}

function terminalEventTime(record = {}, utcField = "created_at_utc_msc", explicitOffset = null) {
  const offset = terminalEventTimezoneOffsetMinutes(record, explicitOffset);
  return terminalTimeFromUtcMsc(record?.[utcField], offset);
}

let _terminalTimeRefreshQueued = false;
function scheduleTerminalTimeRefresh() {
  if (_terminalTimeRefreshQueued) return;
  _terminalTimeRefreshQueued = true;
  queueMicrotask(() => {
    _terminalTimeRefreshQueued = false;
    if (state.dashboardSignal) updateSignalDisplay(state.dashboardSignal);
    if (state.signals.length) {
      renderAnalysisHistory(state.signals);
      renderSignalRows();
    }
    if (state.auditRows.length) renderAuditRows();
    if (state.positionManagementTasks.length) {
      renderPositionManagementTasks(state.positionManagementTasks, state.positionManagementFilters);
    }
  });
}

const parseDate = (v) => {
  if (!v || v === "None" || v === "0" || v === "0.0") return null;
  const n = Number(v);
  if (n > 1000000000) return fmtUtc(new Date(n * 1000));
  const s = String(v);
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(s)) return s;
  try { return fmtUtc(new Date(v.replace(" ", "T"))); } catch { return null; }
};

function utcToMt5(utcStr, timezoneOffsetMinutes = null) {
  if (!utcStr) return null;
  if (timezoneOffsetMinutes === null || timezoneOffsetMinutes === undefined || timezoneOffsetMinutes === "") return null;
  const offset = Number(timezoneOffsetMinutes);
  if (!Number.isInteger(offset) || offset < -720 || offset > 840) return null;
  const d = new Date(utcStr.replace(" ", "T") + "Z");
  if (isNaN(d.getTime())) return utcStr;
  const shifted = new Date(d.getTime() + offset * 60_000);
  const p = (x) => String(x).padStart(2, "0");
  return `${shifted.getUTCFullYear()}-${p(shifted.getUTCMonth() + 1)}-${p(shifted.getUTCDate())} ${p(shifted.getUTCHours())}:${p(shifted.getUTCMinutes())}:${p(shifted.getUTCSeconds())}`;
}

function parseBeijingServerTime(value) {
  if (!value) return NaN;
  const raw = String(value).trim();
  const normalized = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}/.test(raw) && !/(Z|[+-]\d{2}:?\d{2})$/i.test(raw)
    ? `${raw.replace(" ", "T")}+08:00` : raw;
  return new Date(normalized).getTime();
}

function compactTimeParts(value) {
  const full = formatTime(value);
  if (full === "--") return { time: "--", badge: "" };
  const [date, time = ""] = full.split(" ");
  return {
    time: time.slice(0, 8) || full,
    badge: date ? date.slice(5) : "",
  };
}

function compactTimeText(value) {
  const parts = compactTimeParts(value);
  return parts.badge ? `${parts.badge} ${parts.time}` : parts.time;
}

function compactTimeHtml(value) {
  const parts = compactTimeParts(value);
  if (parts.time === "--") return "--";
  return `<span class="time-cell"><span class="num">${escapeHtml(parts.time)}</span>${parts.badge ? `<span class="date-badge">${escapeHtml(parts.badge)}</span>` : ""}</span>`;
}

function compactTerminalTimeText(record) {
  const value = terminalEventTime(record);
  return value ? compactTimeText(value) : "时间待终端校准";
}

function compactTerminalTimeHtml(record) {
  const value = terminalEventTime(record);
  return value ? compactTimeHtml(value) : '<span class="terminal-time-pending">时间待终端校准</span>';
}

function signalDisplayTime(signal) {
  return terminalEventTime(signal) || "时间待终端校准";
}

function profitClass(value) {
  const num = Number(value);
  if (num > 0) return "pnl-positive";
  if (num < 0) return "pnl-negative";
  return "pnl zero";
}

function priceDisplay(value, digits = 2) {
  const num = Number(value);
  if (!Number.isFinite(num) || num <= 0) return "--";
  return fmt(num, digits);
}

function signalIsStale(signal) {
  if (!signal) return false;
  if (signal.is_executed) return false;
  if (signal.is_stale === true) return true;
  const executionValidUntilUtcMsc = Number(signal.execution_valid_until_utc_msc);
  if (Number.isFinite(executionValidUntilUtcMsc) && executionValidUntilUtcMsc > 0) {
    return Date.now() > executionValidUntilUtcMsc;
  }
  const ttl = Number(signal.ttl_seconds);
  if (!Number.isFinite(ttl)) return !!signal.is_stale;
  const createdAt = parseBeijingServerTime(signal.created_at);
  if (!createdAt || isNaN(createdAt)) return !!signal.is_stale;
  return (Date.now() - createdAt) / 1000 > ttl;
}

function setSignalBadge(signal) {
  const badge = $("signalLiveBadge");
  if (!badge) return;
  let label = "等待";
  let stateClass = "expired";
  const stale = signalIsStale(signal);
  if (signal?.is_executed) {
    label = "已执行";
    stateClass = "executed";
  } else if (signal && !stale) {
    label = "LIVE";
    stateClass = "";
  } else if (stale) {
    label = "已过期";
    stateClass = "expired";
  }
  badge.className = `signal-live-badge ${stateClass}`.trim();
  badge.innerHTML = `<span class="badge-dot"></span>${label}`;
}

function signalType(value) {
  const type = String(value || "hold").toLowerCase();
  if (["buy", "sell", "close"].includes(type)) return type;
  if (type.startsWith("buy")) return "buy";
  if (type.startsWith("sell")) return "sell";
  return "hold";
}

function directionText(value) {
  const type = String(value || "hold").toLowerCase();
  const labels = {
    buy_limit: "买入限价", sell_limit: "卖出限价",
    buy_stop: "买入止损", sell_stop: "卖出止损",
    buy_stop_limit: "买入止损限价", sell_stop_limit: "卖出止损限价",
    buy: "买入", sell: "卖出", hold: "观望", close: "持仓分析"
  };
  return labels[type] || labels[signalType(value)] || "观望";
}

function volumeText(value) {
  const text = String(value ?? "").trim();
  if (!text || text === "--") return "--";
  if (text.includes("手")) return text;
  const num = Number(text);
  if (!Number.isFinite(num) || num <= 0) return "--";
  return `${fmt(num, 2)} 手`;
}

function signedText(value, digits = 2, suffix = "") {
  const num = Number(value);
  if (!Number.isFinite(num)) return "--";
  const abs = Math.abs(num).toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits });
  const sign = num > 0 ? "+" : num < 0 ? "-" : "";
  return `${sign}${abs}${suffix}`;
}

function confidenceClass(value) {
  const pct = confidenceInfo(value).value;
  if (pct >= 70) return "conf-high";
  if (pct < 50) return "conf-low";
  return "conf-mid";
}

function confidenceInfo(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return { value: 0, label: "--" };
  const pct = num <= 1 ? num * 100 : num;
  const rounded = Math.max(0, Math.min(100, Math.round(pct)));
  // Zero is used by the backend as a fail-closed sentinel when a model result
  // cannot be trusted. Presenting it as a measured 0% confidence is misleading.
  if (rounded === 0) return { value: 0, label: "不可用" };
  return { value: rounded, label: `${rounded}%` };
}

function initIcons() {
  requestAnimationFrame(() => {
    if (typeof lucide !== "undefined") lucide.createIcons();
  });
}

function setText(id, value) {
  const el = $(id);
  if (el) el.textContent = raw(value);
}

function setBadge(id, text, type, withDot = true) {
  const el = $(id);
  if (!el) return;
  // Only replace the visual state. Semantic control classes and readonly
  // affordances must survive live status refreshes.
  [...el.classList].filter(className => className.startsWith("status-")).forEach(className => el.classList.remove(className));
  el.classList.add("status-badge", `status-${type}`);
  el.innerHTML = `${withDot ? '<span class="badge-dot" aria-hidden="true"></span>' : ""}${escapeHtml(text)}`;
}

function positionSizeAdvice(signal) {
  const tier = String(signal?.position_size_tier || signal?.decision?.position_size_tier || "").toLowerCase();
  const tiers = {
    observe: { label:"不建仓", factor:0 },
    probe: { label:"试探仓", factor:25 },
    light: { label:"轻仓", factor:50 },
    standard: { label:"标准仓", factor:100 },
  };
  const selected = tiers[tier];
  if (selected) return {
    tier, label:selected.label,
    text:tier === "observe" ? selected.label : `${selected.label} · ${selected.factor}% 风险额度`,
    factor:selected.factor,
    reason:signal?.position_size_reason || signal?.decision?.position_size_reason || "",
  };
  return { tier:"legacy", label:"旧版手数", text:volumeText(signal?.recommended_volume), factor:null, reason:"" };
}

let mobileNavReturnFocus = null;

function closeMobileNav({ restoreFocus = true } = {}) {
  const drawer = $("mobileNavDrawer");
  const trigger = $("mobileNavMoreBtn");
  if (!drawer) return;
  drawer.classList.remove("is-open");
  drawer.setAttribute("aria-hidden", "true");
  trigger?.setAttribute("aria-expanded", "false");
  document.body.classList.remove("mobile-nav-open");
  if (restoreFocus && mobileNavReturnFocus?.isConnected) mobileNavReturnFocus.focus();
  mobileNavReturnFocus = null;
}

function openMobileNav() {
  const drawer = $("mobileNavDrawer");
  const trigger = $("mobileNavMoreBtn");
  const sheet = drawer?.querySelector(".mobile-nav-sheet");
  if (!drawer || !sheet) return;
  mobileNavReturnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : trigger;
  drawer.classList.add("is-open");
  drawer.setAttribute("aria-hidden", "false");
  trigger?.setAttribute("aria-expanded", "true");
  document.body.classList.add("mobile-nav-open");
  requestAnimationFrame(() => sheet.focus());
}

function handleMobileNavKeydown(event) {
  const drawer = $("mobileNavDrawer");
  if (!drawer?.classList.contains("is-open")) return;
  if (event.key === "Escape") {
    event.preventDefault();
    closeMobileNav();
    return;
  }
  if (event.key !== "Tab") return;
  const focusable = [...drawer.querySelectorAll('button:not([disabled]):not([tabindex="-1"]), a[href], [tabindex]:not([tabindex="-1"])')]
    .filter(element => element.offsetParent !== null);
  if (!focusable.length) return;
  const first = focusable[0], last = focusable[focusable.length - 1];
  if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
  else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
}

function timeframeHelp(value) {
  const timeframe = String(value || "").trim().toUpperCase();
  const labels = { M1:"1 分钟", M5:"5 分钟", M15:"15 分钟", M30:"30 分钟", H1:"1 小时", H4:"4 小时", D1:"1 天" };
  return labels[timeframe] ? `${timeframe}：每根 K 线代表 ${labels[timeframe]}` : "策略使用的行情周期";
}

function renderTradePermissionBadge(enabled, { blocked = false, readonly = isObserverMode(), label = "" } = {}) {
  const known = typeof enabled === "boolean";
  const text = label || (known
    ? `交易发送${enabled ? "开启" : "关闭"}${readonly ? " · 只读" : ""}`
    : `交易发送状态未知${readonly ? " · 只读" : ""}`);
  setBadge("tradeMode", text, blocked ? "warning" : enabled ? "trade-active" : "neutral");
  const control = $("tradeMode");
  if (!control) return;
  control.setAttribute("aria-pressed", String(enabled === true));
  control.setAttribute("aria-label", `${text}。${readonly ? "当前为观摩模式，不可修改" : "点击可修改交易发送权限"}`);
}

const AUTO_REASON_LABELS = {
  admin_bridge_offline: '管理员桥接离线',
  user_bridge_offline: '用户桥接离线',
  bridge_offline: '桥接离线',
  market_open: '市场开放',
  market_closed: '休市',
  market_restricted: '交易权限受限',
  market_unknown: '市场状态未知',
  market_unknown_no_tick: '等待行情数据',
  market_stale_tick: '行情停滞',
  redis_unavailable: '缓存服务未连接',
  weekly_flatten_window: '周末清仓处理中',
  lock_busy: '上一轮分析仍在结束，正在等待调度权',
  redis_lock_failed: '调度服务暂时繁忙',
  cooldown_check_failed: '调度等待时间检查失败',
  finalize_failed: '调度收尾状态待恢复',
  lock_lost: '调度执行权已失效，本轮已安全停止',
  ai_failed: '模型分析失败',
  owner_bridge_offline: '策略所属账户桥接离线',
  redis_cooldown_active: '等待下一轮调度',
  no_api_key: '未配置接口密钥',
  strategy_disabled: '策略已停用',
  symbol_not_supported: '品种不支持',
  no_runtime_scheduler: '调度器未运行',
  outside_schedule: '当前不在运行时段',
  no_online_subscribers: '无在线订阅用户',
  no_strategy: '未选择策略',
  no_symbols: '未选择品种',
  rates_failed: '行情获取失败',
  rates_empty: '行情为空',
  private_portfolio_context_unavailable: '持仓或挂单数据不完整',
  model_task_status_unknown: '模型服务商状态暂不可确认，正在安全恢复并避免重复请求',
  model_task_active: '上一轮模型任务仍在运行，等待完成',
  model_task_cooldown: '本轮模型任务已完成，等待完整配置周期',
  model_task_completion_unknown: '模型任务完成时间未知，等待恢复确认',
  model_task_gate_failed: '模型任务运行时暂不可用，等待恢复',
  deployment_draining: '系统正在安全排空，等待任务完成',
  deployment_drain_check_failed: '部署排空状态暂不可确认，暂停启动新分析',
  exception: '运行异常',
  disabled: '已关闭',
  unknown: '未知',
};

function autoReasonText(reason) {
  if (!reason) return '未知';
  return AUTO_REASON_LABELS[reason] || '未知状态';
}

function marketPausePresentation(reason) {
  const presentations = {
    market_closed: { label:'自动分析 · 休市', type:'warning', status:'休市暂停' },
    market_restricted: { label:'自动分析 · 交易受限', type:'warning', status:'交易权限受限' },
    market_stale_tick: { label:'自动分析 · 行情停滞', type:'warning', status:'等待行情恢复' },
    market_unknown_no_tick: { label:'自动分析 · 等待行情', type:'neutral', status:'等待行情数据' },
    market_unknown: { label:'自动分析 · 检测中', type:'neutral', status:'正在检测市场状态' },
  };
  return presentations[reason] || null;
}

// Badge cache to avoid flickering on hover
const _autoBadgeCache = { label: '', type: '', title: '' };
let _autoBadgeHovering = false;

function setAutoBadgeText(el, label) {
  let textSpan = el.querySelector('.badge-text');
  if (!textSpan) {
    el.replaceChildren();
    const dot = document.createElement('span');
    dot.className = 'badge-dot';
    dot.setAttribute('aria-hidden', 'true');
    const copy = document.createElement('span');
    copy.className = 'auto-runtime-copy';
    textSpan = document.createElement('span');
    textSpan.className = 'badge-text';
    const stage = document.createElement('span');
    stage.className = 'auto-runtime-stage';
    copy.append(textSpan, stage);
    const percent = document.createElement('span');
    percent.className = 'auto-runtime-percent';
    percent.setAttribute('aria-hidden', 'true');
    const track = document.createElement('span');
    track.className = 'auto-runtime-track';
    track.setAttribute('role', 'progressbar');
    track.setAttribute('aria-label', '自动分析进度');
    track.setAttribute('aria-valuemin', '0');
    track.setAttribute('aria-valuemax', '100');
    track.setAttribute('aria-valuenow', '0');
    const fill = document.createElement('span');
    fill.className = 'auto-runtime-fill';
    track.appendChild(fill);
    el.append(dot, copy, percent, track);
  }
  if (textSpan.textContent !== label) textSpan.textContent = label;
}

function applyAutoBadge(label, type, title, visual = {}) {
  const el = $('autoAnalyzeMode');
  if (!el) return;

  const modeClass = visual.mode ? ` is-progress is-${visual.mode}` : '';
  const observerClass = isObserverMode() ? ' is-readonly' : ' clickable-badge';
  const newClass = `status-badge status-${type} auto-runtime-control${observerClass}${modeClass}`;
  if (el.className !== newClass) el.className = newClass;
  // Observer clicks are handled explicitly so the user receives a clear
  // read-only explanation instead of an inert native disabled control.
  el.disabled = false;
  el.setAttribute('aria-disabled', String(isObserverMode()));
  setAutoBadgeText(el, label);
  const stage = el.querySelector('.auto-runtime-stage');
  const percent = el.querySelector('.auto-runtime-percent');
  const track = el.querySelector('.auto-runtime-track');
  const progress = Math.max(0, Math.min(100, Math.round(Number(visual.progress || 0))));
  if (stage) stage.textContent = visual.stage || '';
  if (percent) percent.textContent = visual.mode ? `${progress}%` : '';
  if (track) {
    track.setAttribute('aria-valuenow', String(progress));
    track.setAttribute('aria-valuetext', visual.stage ? `${visual.stage}，${progress}%` : `${progress}%`);
  }
  el.style.setProperty('--auto-progress-scale', String(progress / 100));
  const actionHint = isObserverMode() ? observerMessage() : '点击编辑订阅与自动分析设置';
  el.setAttribute('aria-label', `${visual.mode ? `${label}，${visual.stage || ''}，${progress}%` : label}。${actionHint}`);
  title = `${title || label}\n${actionHint}`;

  if (!_autoBadgeHovering) {
    if (el.title !== title) el.title = title;
    _autoBadgeCache.title = title;
  } else {
    _autoBadgeCache.pendingTitle = title;
  }
}

function autoProgressElapsed(startedAt) {
  const started = Date.parse(startedAt || '');
  if (!Number.isFinite(started)) return '';
  const seconds = Math.max(0, Math.floor((Date.now() - started) / 1000));
  const min = Math.floor(seconds / 60);
  const sec = seconds % 60;
  return `${String(min).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
}

const AUTO_PROGRESS_STAGE_LIMITS = {
  starting: 5,
  config: 14,
  bridge: 29,
  market: 44,
  ai: 82,
  persist: 91,
  publish: 95,
  delivery: 97,
  verify: 99,
  complete: 100,
};

function estimatedAutoProgress(cycle) {
  const base = Math.max(0, Math.min(100, Number(cycle?.progress_percent || 0)));
  const stage = cycle?.stage || 'starting';
  if (stage === 'complete') return 100;
  const limit = Math.max(base, Number(AUTO_PROGRESS_STAGE_LIMITS[stage] || base));
  if (limit <= base) return base;
  const updatedAt = Date.parse(cycle?.stage_updated_at || cycle?.received_at || cycle?.started_at || '');
  const elapsedSeconds = Number.isFinite(updatedAt) ? Math.max(0, (Date.now() - updatedAt) / 1000) : 0;
  const timeConstant = stage === 'ai' ? 18 : 5;
  return Math.min(limit, base + (limit - base) * (1 - Math.exp(-elapsedSeconds / timeConstant)));
}

function displayedAutoProgress(cycle, final = false) {
  const key = cycle?.cycle_id || 'runtime-fallback';
  const target = final ? 100 : estimatedAutoProgress(cycle);
  const now = Date.now();
  const current = state.autoProgressVisual[key];
  if (!current || target < current.value) {
    state.autoProgressVisual[key] = { value: target, updatedAt: now };
    return target;
  }
  const elapsedSeconds = Math.max(0.05, (now - current.updatedAt) / 1000);
  const maxStep = (final ? 18 : 3.5) * elapsedSeconds;
  current.value = Math.min(target, current.value + maxStep);
  current.updatedAt = now;
  return current.value;
}

function activeAutoProgressCycles(runtime) {
  const merged = new Map();
  for (const cycle of Array.isArray(runtime?.active_cycles) ? runtime.active_cycles : []) {
    if (cycle?.cycle_id) merged.set(cycle.cycle_id, cycle);
  }
  for (const cycle of Object.values(state.autoProgressCycles || {})) {
    if (cycle?.cycle_id) merged.set(cycle.cycle_id, cycle);
  }
  return [...merged.values()].filter(cycle => cycle && cycle.progress_percent >= 0)
    .sort((a, b) => String(a.symbol || '').localeCompare(String(b.symbol || '')));
}

function renderAutoProgress(cycles, ptName) {
  const count = cycles.length;
  const primary = [...cycles].sort((a, b) => Number(b.progress_seq || 0) - Number(a.progress_seq || 0))[0];
  const progress = Math.round(cycles.reduce((sum, cycle) => sum + displayedAutoProgress(cycle, cycle.stage === 'complete'), 0) / Math.max(1, count));
  const symbols = cycles.map(cycle => cycle.symbol).filter(Boolean);
  const label = count > 1 ? `${count} 个品种分析中` : `${primary?.symbol || '自动分析'} · ${primary?.stage_label || '正在处理'}`;
  const elapsed = autoProgressElapsed(primary?.started_at);
  const stage = count > 1
    ? `${symbols.slice(0, 3).join(' · ')}${symbols.length > 3 ? ` 等 ${symbols.length} 项` : ''}${elapsed ? ` · ${elapsed}` : ''}`
    : `已用时 ${elapsed || '00:00'}`;
  const details = cycles.map(cycle => `${cycle.symbol || '未知品种'}：${cycle.stage_label || '正在处理'} ${Math.round(Number(cycle.progress_percent || 0))}%`).join('\n');
  const title = `策略：${ptName || '未选择'}\n状态：正在分析\n${details}`;
  applyAutoBadge(label, 'running', title, { mode: primary?.stage === 'complete' ? 'complete' : 'running', stage, progress });
}

function autoRuntimeRemainingSeconds(runtime, nowMs = Date.now()) {
  const receivedAtMs = Number(runtime?.receivedAtMs)
  const backendSeconds = Number(runtime?.next_run_in_seconds)
  if (Number.isFinite(receivedAtMs) && receivedAtMs > 0
    && Number.isFinite(backendSeconds) && backendSeconds > 0) {
    return Math.max(0, backendSeconds - Math.floor((nowMs - receivedAtMs) / 1000))
  }

  // Absolute UTC is the recovery path when older responses omit the seconds
  // field (or explicitly report zero). It also keeps the badge accurate when
  // a response arrives without the local receipt timestamp.
  const deadlineMs = Date.parse(String(runtime?.next_run_at_utc || ''))
  if (Number.isFinite(deadlineMs)) return Math.max(0, Math.ceil((deadlineMs - nowMs) / 1000))
  return null
}

function renderAutoAnalyzeBadge(s) {
  if (!s) return;
  const ptName = s.prompt_type_name || '';
  const symbols = s.selected_symbols || [];
  const symbolsStr = symbols.join('、') || '未选择品种';

  // Calculate remaining time from the server's seconds and receipt timestamp;
  // fall back to the absolute UTC deadline for older/degraded responses.
  const remaining = autoRuntimeRemainingSeconds(s);

  let label, type, title;
  const cycles = activeAutoProgressCycles(s);
  if (cycles.length > 0) {
    renderAutoProgress(cycles, ptName);
    return;
  }

  const flash = state.autoProgressFlash;
  if (flash && flash.expiresAt > Date.now()) {
    const success = flash.status === 'success';
    const flashLabel = success ? `${flash.symbol || '自动分析'} · 分析完成` : `${flash.symbol || '自动分析'} · 分析未完成`;
    const flashStage = success ? '信号与执行建议已更新' : autoReasonText(flash.reason || 'exception');
    applyAutoBadge(flashLabel, success ? 'running' : 'danger', flashStage, {
      mode: success ? 'complete' : 'error',
      stage: flashStage,
      progress: success ? displayedAutoProgress({
        cycle_id: flash.cycle_id || 'completed-cycle',
        stage: 'complete',
        progress_percent: Number(flash.progress_percent || 100),
      }, true) : Number(flash.progress_percent || 0),
    });
    return;
  }

  if (!s.enabled) {
    label = '自动分析已关闭';
    type = 'neutral';
    title = '状态：自动分析关闭';
  } else if (s.paused_reason === 'weekly_flatten_window') {
    label = '自动分析 · 周末清仓';
    type = 'warning';
    title = `策略：${ptName || '未选择'}\n品种：${symbolsStr}\n状态：周末清仓期间暂停`;
  } else if (s.in_flight) {
    const stageLabel = s.stage_label || (s.stage === 'running' ? '正在分析' : '调度中');
    renderAutoProgress([{
      cycle_id: 'runtime-fallback', symbol: symbols[0] || '', stage: s.stage || 'running',
      stage_label: stageLabel, progress_percent: Number(s.progress_percent || 46),
      progress_seq: 0, started_at: s.cycle_started_at || '',
    }], ptName);
    return;
  } else if (['model_task_status_unknown', 'model_task_active', 'model_task_completion_unknown', 'model_task_gate_failed', 'deployment_draining', 'deployment_drain_check_failed'].includes(String(s.wait_reason || s.paused_reason || ''))) {
    const reason = String(s.wait_reason || s.paused_reason || '')
    const safeStatus = autoReasonText(reason)
    const countdownText = remaining !== null && remaining > 0
      ? `${String(Math.floor(remaining / 60)).padStart(2, '0')}:${String(remaining % 60).padStart(2, '0')}`
      : ''
    const countdown = countdownText
      ? `，预计 ${countdownText} 后复查`
      : '，等待恢复确认'
    label = countdownText ? `自动分析 · 安全恢复 ${countdownText}` : `自动分析 · ${safeStatus}`
    type = 'warning'
    const safetyNote = reason === 'deployment_draining'
      ? '系统正在排空，排空完成前不会启动新的自动分析'
      : '为避免重复请求，系统不会在恢复确认前重新发起分析'
    title = `策略：${ptName || '未选择'}\n品种：${symbolsStr}\n状态：${safeStatus}${countdown}\n${safetyNote}`
  } else if (s.paused_reason && marketPausePresentation(s.paused_reason)) {
    const presentation = marketPausePresentation(s.paused_reason);
    label = presentation.label;
    type = presentation.type;
    const msState = s.market_state || {};
    title = `策略：${ptName || '未选择'}\n品种：${symbolsStr}\n状态：${presentation.status}`;
    title += `\n市场状态：${autoReasonText(msState.reason || s.paused_reason)}`;
    if (msState.tickAgeMs) title += `\n行情延迟：${msState.tickAgeMs}毫秒`;
    if (msState.mt5TimeStr) title += `\n桥接行情时间：${msState.mt5TimeStr}`;
  } else if (remaining !== null && remaining > 0) {
    const min = Math.floor(remaining / 60);
    const sec = remaining % 60;
    const countdown = `${String(min).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
    label = `自动分析 · ${countdown}`;
    type = 'active';
    title = `策略：${ptName || '未选择'}\n品种：${symbolsStr}\n状态：开启\n下次运行：等待倒计时结束`;
    if (s.paused_reason) title += `\n内部状态：${autoReasonText(s.paused_reason)}`;
    if (s.market_state) title += `\n市场状态：${autoReasonText(s.market_state.reason)}`;
  } else {
    label = '自动分析已开启';
    type = 'active';
    title = `策略：${ptName || '未选择'}\n品种：${symbolsStr}\n状态：开启`;
    if (s.paused_reason) title += `\n内部状态：${autoReasonText(s.paused_reason)}`;
    if (s.market_state) title += `\n市场状态：${autoReasonText(s.market_state.reason)}`;
  }

  applyAutoBadge(label, type, title);
}

function updatePnlStyle(elementId, value) {
  const el = $(elementId);
  if (!el) return;
  el.classList.remove("positive", "negative", "zero");
  const num = Number(value);
  if (num > 0) el.classList.add("positive");
  else if (num < 0) el.classList.add("negative");
  else el.classList.add("zero");
}

function setPnlValue(id, value) {
  setText(id, fmt(value));
  updatePnlStyle(id, value);
}

function flashPrice(elementId, direction) {
  const el = $(elementId);
  if (!el || !direction) return;
  el.classList.remove("price-flash-up", "price-flash-down");
  void el.offsetWidth;
  el.classList.add(direction === "up" ? "price-flash-up" : "price-flash-down");
}

function setQuoteDirection(id, direction) {
  const el = $(id);
  if (!el) return;
  el.className = `quote-change ${direction || ""}`.trim();
  el.classList.toggle("hidden", !direction);
  el.textContent = direction === "up" ? "▲" : direction === "down" ? "▼" : "";
}

function setQuoteChangeUnavailable() {
  const delta = $("quoteDelta");
  const pct = $("quoteDeltaPct");
  if (delta) {
    delta.textContent = "—";
    delta.className = "change-val num muted";
  }
  if (pct) {
    pct.textContent = "涨跌幅暂无";
    pct.className = "change-pct muted";
  }
}

function parseDisplayNumber(id) {
  const text = $(id)?.textContent || "";
  const num = Number(text.replace(/,/g, "").replace(/[^\d.-]/g, ""));
  return Number.isFinite(num) ? num : null;
}

function localizeReason(reason) {
  const text = String(reason || "").trim();
  if (!text) return "";
  if (REASON_MAP[text]) return REASON_MAP[text];
  if (text.startsWith("risk_relaxation_not_allowed:")) return "该设置不能突破平台安全边界；如需更宽松的规则，请联系管理员调整平台值";
  if (text.startsWith("invalid_global_risk_range:")) return "用户允许范围无效，请检查上下限及平台安全边界";
  if (text.startsWith("invalid_global_risk_lock:")) return "平台锁定值必须位于用户允许范围内";
  if (text.startsWith("risk_field_locked:") || text.startsWith("risk_field_not_configurable:")) return "该规则由平台或系统统一管理，当前账号不能修改";
  if (text === "invalid_global_risk_core_limits") return "单笔手数上限和单笔风险上限必须大于 0";
  if (text.startsWith("Invalid live quote for ")) {
    return `${text.replace("Invalid live quote for ", "")} 报价无效，已阻止下单`;
  }
  if (/^(?:R\d|PX\.)[A-Z0-9._-]+$/i.test(text)) return "风控条件未满足";
  if (/[A-Za-z]/.test(text) && !/[\u4e00-\u9fff]/.test(text)) return "系统执行条件未满足，详细信息已记录";
  return text;
}

function userVisibleText(value, fallback = "暂无中文说明") {
  let text = String(value || "").trim();
  if (!text) return fallback;
  const cleanLocalizedText = input => String(input || "")
    .replace(/相关状态尚未确认(?:\s*(?:为|[:：=、，;；和及])\s*相关状态尚未确认)+/g, "相关状态尚未确认")
    .replace(/系统提示的相关状态尚未确认显示/g, "系统提示状态尚未确认");
  const replacements = [
    [/\bstructure_topology_reliable\s*=\s*true\b/gi, "线段与中枢结构拓扑已确认"],
    [/\bstructure_topology_reliable\s*=\s*false\b/gi, "线段与中枢结构拓扑尚未确认"],
    [/\bwindow_stable\s*=\s*false\b/gi, "结构窗口不稳定"],
    [/\btime_location_reliable\s*=\s*false\b/gi, "结构时间定位不可靠"],
    [/\balignment_with_higher\s*=\s*conflict\b/gi, "与高周期方向冲突"],
    [/\bcontext_status\s*=\s*partial\b/gi, "多周期行情证据不完整"],
    [/\bstatus\s*(?:=|为|:|：)\s*segment_history_unresolved\b/gi, "历史窗口尚未收敛，暂不确认线段"],
    [/\bstatus\s*(?:=|为|:|：)\s*unreliable_segments\b/gi, "线段结构尚不可靠"],
    [/\bagreement\s*(?:=|为|:|：)\s*aligned_up\b/gi, "多周期方向一致偏多"],
    [/\bagreement\s*(?:=|为|:|：)\s*aligned_down\b/gi, "多周期方向一致偏空"],
    [/\bagreement\s*(?:=|为|:|：)\s*mixed\b/gi, "多周期方向存在分歧"],
    [/\bagreement\s*(?:=|为|:|：)\s*insufficient\b/gi, "多周期方向证据不足"],
    [/\breliability\s*(?:=|为|:|：)\s*low\b/gi, "结构可靠性较低"],
    [/\breliability\s*(?:=|为|:|：)\s*(?:medium|normal)\b/gi, "结构可靠性一般"],
    [/\breliability\s*(?:=|为|:|：)\s*high\b/gi, "结构可靠性较高"],
    [/\breliability\s*(?:为|:|：)?\s*低/gi, "结构可靠性较低"],
    [/\breliability\s*(?:为|:|：)?\s*(?:中|一般)/gi, "结构可靠性一般"],
    [/\breliability\s*(?:为|:|：)?\s*高/gi, "结构可靠性较高"],
    [/\bunreliable_segments\b/gi, "线段结构尚不可靠"],
    [/\bsegment_history_unresolved\b/gi, "历史窗口尚未收敛，暂不确认线段"],
    [/\bsegment_cross_window_unstable\b/gi, "不同历史窗口的线段边界尚未收敛"],
    [/\bcenter_cross_window_unstable\b/gi, "不同历史窗口对中枢形成核心尚未达成共识"],
    [/\bcenter_entry_unconfirmed\b/gi, "中枢已确认，但进入段缺少跨窗口共识，仅背驰暂不可判"],
    [/\bstructure_anchor_bootstrap_pending\b/gi, "结构锚点正在用连续三根已收盘K线确认，暂不使用依赖进入段的背驰与买卖点"],
    [/\bmt4_historical_offset_unverified\b/gi, "MT4 历史K线的绝对UTC时间为近似定位，不影响同源结构顺序"],
    [/\bdivergence_evidence_unavailable\b/gi, "背驰所需的有效力度证据不足"],
    [/\bdivergence_cross_window_unstable\b/gi, "不同历史窗口的背驰证据尚未收敛"],
    [/\bforming_evidence_unavailable\b/gi, "候选背驰所需的有效证据不足"],
    [/\bforming_cross_window_unstable\b/gi, "不同历史窗口的候选背驰证据尚未收敛"],
    [/\bno_cross_window_center\b/gi, "尚无跨窗口确认的中枢"],
    [/\binsufficient_confirmed_bis\b/gi, "已确认笔数量不足"],
    [/\binsufficient_bis\b/gi, "确认笔数量不足"],
    [/\binsufficient_klines\b/gi, "K线数据不足"],
    [/\bsegments_not_confirmed\b/gi, "线段尚未确认"],
    [/\bno_valid_center\b/gi, "尚未形成有效中枢"],
    [/\bupward_breakout_pending\b/gi, "向上突破仍待结构确认"],
    [/\bdownward_breakout_pending\b/gi, "向下突破仍待结构确认"],
    [/\baligned_up\b/gi, "方向一致偏多"],
    [/\baligned_down\b/gi, "方向一致偏空"],
    [/\bmixed\b/gi, "方向存在分歧"],
    [/\bpartial\b/gi, "结构证据不完整"],
    [/\binsufficient\b/gi, "证据不足"],
    [/\bsystem internal status\b/gi, "当前结构尚未确认"],
    [/系统内部状态/g, "当前结构尚未确认"],
  ];
  for (const [pattern, replacement] of replacements) text = text.replace(pattern, replacement);
  text = text.replace(/\b((?:M|H|D)\d+|\d+H)\s*缠论趋势?为[“"]线段结构尚不可靠[”"]/gi, "$1 尚未形成可靠的确认线段")
    .replace(/\b((?:M|H|D)\d+|\d+H)\s*缠论为[“"]线段结构尚不可靠[”"]/gi, "$1 尚未形成可靠的确认线段")
    .replace(/可靠性低/g, "结构可靠性较低")
    .replace(/\bagreement\s*=\s*[a-z_]+\b/gi, "多周期方向状态尚未确认")
    .replace(/\breliability\s*=\s*[a-z_]+\b/gi, "结构可靠性尚未确认")
    .replace(/\b(?:status|trend_state|context_status|alignment_with_higher|window_stable|time_location_reliable)\s*=\s*[a-z_]+\b/gi, "相关结构状态尚未确认");
  const localized = localizeReason(text);
  if (localized !== text) return cleanLocalizedText(localized);
  const replaced = text.replace(/\b(?:R\d(?:\.[0-9A-Z]+)?_[A-Z0-9._-]+|PX\.[A-Z0-9._-]+|[a-z][a-z0-9]*(?:_[a-z0-9]+)+)\b/gi, token => {
    const translated = REASON_MAP[token] || RISK_DECISION_LABELS[token];
    return translated || "相关状态尚未确认";
  });
  if (/[A-Za-z]/.test(replaced) && !/[\u4e00-\u9fff]/.test(replaced)) return fallback;
  return cleanLocalizedText(replaced);
}

function setSignalFieldClass(id, className = "") {
  const el = $(id);
  if (!el) return;
  el.className = className;
}

function signalCurrentPriceText(signal) {
  if (!signal || !state.lastQuote || state.lastQuote.symbol !== signal.symbol) return "--";
  const dir = signalType(signal.signal_type);
  if (dir === "buy") return priceDisplay(state.lastQuote.ask);
  if (dir === "sell") return priceDisplay(state.lastQuote.bid);
  return `${priceDisplay(state.lastQuote.bid)} / ${priceDisplay(state.lastQuote.ask)}`;
}

function signalTakeProfit(signal) {
  if (!signal) return null;
  return signalTakeProfitSelection(signal).price || signal.take_profit_1_price || signal.take_profit_2_price || signal.take_profit_3_price || null;
}

function signalTakeProfitSelection(signal) {
  let execution = parseJsonField(signal?.execution_result, {});
  const approvedFromDelivery = parseJsonField(signal?.approved_order_json, {});
  const approved = execution?.risk?.approved_order || execution?.approved_order || approvedFromDelivery || {};
  const recommendedTier = [1, 2, 3].includes(Number(signal?.recommended_take_profit_tier)) ? Number(signal.recommended_take_profit_tier) : null;
  const usedTier = [1, 2, 3].includes(Number(approved.tp_tier_used)) ? Number(approved.tp_tier_used) : null;
  const requestedTier = [1, 2, 3].includes(Number(approved.tp_tier_requested)) ? Number(approved.tp_tier_requested) : null;
  const price = Number(approved.tp) > 0 ? approved.tp : null;
  const tier = usedTier || requestedTier || recommendedTier || (Number(signal?.take_profit_1_price) > 0 ? 1 : null);
  const source = approved.tp_selection_source || (price ? "executed" : recommendedTier ? "ai_recommended" : "legacy");
  const labels = {
    ai_recommended: "AI 推荐",
    subscription_preference: "订阅偏好",
    risk_adjusted: "风控调整",
    legacy_tp1_fallback: "旧信号兼容",
    executed: "实际执行",
    legacy: "未记录",
  };
  return { price, tier, recommendedTier, source, sourceLabel: labels[source] || "实际执行" };
}

function updateSignalPriceFields(signal) {
  const dir = signalType(signal?.signal_type);
  const market = signalMarketData(signal);
  const advice = signal ? signalExecutionAdvice(signal) : null;
  setText("sigReferencePrice", priceDisplay(market.latest_price));
  setText("sigCurrentPrice", signalCurrentPriceText(signal));
  setText("sigStopLoss", priceDisplay(signal?.stop_loss_price));
  setText("sigTakeProfit", priceDisplay(signalTakeProfit(signal)));
  setText("sigVolume", positionSizeAdvice(signal).text);
  setText("sigExecutionState", advice?.title || executionStatus(signal) || "暂无信号");
  setText("sigActionHint", advice?.description || "等待策略生成新的推理结果");
  setSignalFieldClass("sigExecutionState", `signal-execution-state ${advice?.state || "empty"}`);
}

function toast(message, type = "info") {
  const host = $("toastHost");
  if (!host) return;
  const node = document.createElement("div");
  node.className = `toast ${type}`;
  node.textContent = message;
  host.appendChild(node);
  setTimeout(() => node.remove(), 3600);
}

function showConfirm(title, message, {
  confirmText = "确认", cancelText = "取消", danger = false,
  requireText = "", requireTextLabel = "输入以下文字以确认",
  requireTextHint = "必须与显示的名称完全一致", detailRows = [],
} = {}) {
  return new Promise((resolve) => {
    const modal = $("genericConfirmModal");
    if (!modal) { resolve(false); return; }
    $("genericConfirmTitle").textContent = title;
    const confirmationId = `destructiveConfirmText-${Date.now()}`;
    const details = detailRows.length ? `<dl class="confirm-impact-list">${detailRows.map(([label, value, tone = ""]) => `<div class="confirm-impact-row ${escapeHtml(tone)}"><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}</dd></div>`).join("")}</dl>` : "";
    const textCheck = requireText ? `<div class="confirm-text-check"><label for="${confirmationId}">${escapeHtml(requireTextLabel)}</label><code>${escapeHtml(requireText)}</code><input id="${confirmationId}" class="form-input" type="text" autocomplete="off" spellcheck="false" aria-describedby="${confirmationId}-hint"><small id="${confirmationId}-hint">${escapeHtml(requireTextHint)}</small></div>` : "";
    $("genericConfirmBody").innerHTML = `<p class="confirm-message">${escapeHtml(message)}</p>${details}${textCheck}`;
    const okBtn = $("genericConfirmOk");
    const cancelBtn = $("genericConfirmCancel");
    const closeBtn = $("genericConfirmClose");
    const textInput = requireText ? $(confirmationId) : null;
    okBtn.textContent = confirmText;
    cancelBtn.textContent = cancelText;
    okBtn.className = danger ? "btn btn-danger" : "btn btn-primary";
    okBtn.disabled = Boolean(requireText);
    modal.classList.remove("hidden");
    const cleanup = (val) => {
      modal.classList.add("hidden");
      okBtn.removeEventListener("click", onOk);
      cancelBtn.removeEventListener("click", onCancel);
      closeBtn?.removeEventListener("click", onCancel);
      modal.removeEventListener("click", onBg);
      document.removeEventListener("keydown", onKeyDown);
      textInput?.removeEventListener("input", onInput);
      resolve(val);
    };
    const onOk = () => cleanup(true);
    const onCancel = () => cleanup(false);
    const onBg = (e) => { if (e.target === modal) cleanup(false); };
    const onKeyDown = (e) => { if (e.key === "Escape") cleanup(false); };
    const onInput = () => { okBtn.disabled = textInput.value !== requireText; };
    okBtn.addEventListener("click", onOk);
    cancelBtn.addEventListener("click", onCancel);
    closeBtn?.addEventListener("click", onCancel);
    modal.addEventListener("click", onBg);
    document.addEventListener("keydown", onKeyDown);
    textInput?.addEventListener("input", onInput);
    requestAnimationFrame(() => (textInput || cancelBtn).focus());
  });
}

function showLoading(container, text = "加载中...", size = "lg") {
  if (!container) return;
  container.innerHTML = `<div class="loading-state ${size === 'lg' ? 'loading-state-lg' : ''}"><div class="loading-spinner ${size === 'sm' ? 'loading-spinner-sm' : ''}"></div><div class="loading-text">${escapeHtml(text)}</div></div>`;
}

function showError(container, message) {
  if (!container) return;
  container.innerHTML = `<div class="loading-state" style="color:var(--accent-danger)"><div class="loading-text">${escapeHtml(message)}</div></div>`;
}

const _notifiedSignalIds = new Set();

function showSignalNotification(signal) {
  if (!signal) return;
  const host = $("toastHost");
  if (!host) return;
  const signalId = signal.id != null ? String(signal.id) : "";
  if (signalId && _notifiedSignalIds.has(signalId)) return;
  if (signalId) {
    _notifiedSignalIds.add(signalId);
    if (_notifiedSignalIds.size > 200) {
      _notifiedSignalIds.delete(_notifiedSignalIds.values().next().value);
    }
  }
  const dir = signalType(signal.signal_type);
  const dirLabel = directionText(signal.signal_type);
  const node = document.createElement("div");
  node.className = "toast signal-notification";
  const conf = typeof signal.confidence === 'number' ? (signal.confidence > 1 ? signal.confidence : signal.confidence * 100) : 0;
  node.innerHTML = `<div class="notif-header">🔔 新信号</div><div class="notif-body"><span class="notif-symbol">${escapeHtml(signal.symbol)}</span> <span class="notif-dir tag ${dir}">${dirLabel}</span> <span class="notif-tf">${escapeHtml(signal.timeframe)}</span> <span class="notif-conf">${conf.toFixed(0)}%</span></div>`;
  node.style.cursor = "pointer";
  node.onclick = () => {
    node.remove();
    openAnalysisFromHistory(signal.id, { source:"notification", followLatest:true });
  };
  host.appendChild(node);
  setTimeout(() => node.remove(), 8000);
}

function renderPager(hostId, page, pageSize, total, kind) {
  const host = $(hostId);
  if (!host) return;
  const pages = Math.max(1, Math.ceil(total / pageSize));
  host.innerHTML = total > pageSize ? `
    <button class="pager-btn" type="button" data-pager="${kind}" data-page="${page - 1}" ${page <= 1 ? "disabled" : ""}>上一页</button>
    <span class="pager-info">${page} / ${pages}</span>
    <button class="pager-btn" type="button" data-pager="${kind}" data-page="${page + 1}" ${page >= pages ? "disabled" : ""}>下一页</button>
  ` : `<span class="pager-info">共 ${total} 条</span>`;
}

function clampPage(page, pageSize, total) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  return Math.min(Math.max(1, Number(page) || 1), pages);
}

const API_ERROR_MESSAGES = {
  bridge_data_request_disconnected: "桥接连接已中断，历史数据读取未完成，请稍后重试",
  browser_websocket_disconnected: "实时连接已中断，请稍后重试",
  bridge_history_route_required: "当前账户路由尚未准备好，请稍后重试",
  bridge_history_temporarily_unavailable: "历史数据正在维护，请稍后再试",
  history_prepare_status_unsupported: "当前桥接不支持轻量历史同步检查",
  history_prepare_range_invalid: "历史范围元数据无效，请重新刷新",
  history_prepare_range_changed: "历史范围在同步期间发生变化，请重新刷新",
  bridge_history_before_supported_start: "交易历史仅支持查询 2000 年 1 月 1 日及之后的数据",
  history_range_preference_scope_invalid: "只有“全部可用历史”和“平台接入后”可以保存开始日期",
  history_range_preference_date_invalid: "开始日期格式无效，请重新选择",
  history_cursor_range_incomplete: "正在准备所选范围的交易记录，请稍后刷新",
  model_task_status_unknown: "模型服务商状态暂不可确认，系统正在安全恢复并避免重复请求",
  model_task_active: "上一轮模型任务仍在运行，请等待完成",
  model_task_cooldown: "本轮模型任务已完成，请等待完整配置周期",
  model_task_completion_unknown: "模型任务完成时间未知，系统正在等待恢复确认",
  model_task_gate_failed: "模型任务运行时暂不可用，系统正在等待恢复",
  deployment_draining: "系统正在安全排空，请等待任务完成",
  deployment_drain_check_failed: "部署排空状态暂不可确认，暂停启动新分析",
  encryption_master_key_missing: "服务器模型凭据加密密钥未正确配置，请联系管理员检查 32 字节 AES 密钥并重启服务",
  no_model_configured: "尚未配置可用模型，请先在“AI策略师 → 模型管理”中添加模型",
  no_platform_model: "平台尚未配置默认模型",
  bound_model_unavailable: "策略绑定的模型已停用或删除，请重新选择模型",
  model_token_limits_invalid: "最大输入和最大输出不能超过上下文窗口，请修改后重试",
  model_token_limits_unconfirmed: "该模型限制尚未确认，请编辑模型并保存验证后再使用、设为默认或绑定策略",
  model_token_limits_stale: "模型身份或限制已变化，请重新编辑并保存验证",
  strategy_memory_version_conflict: "记忆库已被其他操作更新，请刷新后重新编辑",
  strategy_memory_capacity_exceeded: "记忆库已超过容量上限，请先压缩后再保存",
  strategy_memory_compression_output_invalid: "模型返回的压缩结果无效，请重试或人工整理记忆库",
  strategy_memory_compression_stale: "记忆库在压缩期间已更新，本次结果未应用，请重新压缩",
  strategy_memory_compression_job_not_found: "整理任务不存在或已失效，请刷新后重试",
  strategy_memory_library_unavailable: "统一记忆库暂不可用，本次分析已安全取消，请稍后重试",
  strategy_memory_forbidden: "无权访问该策略的记忆库",
  strategy_memory_platform_forbidden: "只有平台内容管理员可以修改平台策略记忆库",
  strategy_memory_strategy_not_active: "该策略当前不可用，无法读取记忆库",
  model_context_window_invalid: "上下文窗口配置无效，请按模型文档修改为正整数",
  model_max_input_tokens_invalid: "最大输入配置无效，请按模型文档修改为正整数",
  model_max_output_tokens_invalid: "最大输出配置无效，请按模型文档修改为正整数",
  model_token_limits_rejected: "当前模型不接受所填限制，请修改上下文窗口、最大输入或最大输出",
  model_input_limit_exceeded: "当前输入超过模型的最大输入限制，请增大配置或减少本次输入",
  model_context_limit_exceeded: "当前请求超过模型上下文窗口，请修改上下文窗口或减少本次输入",
  model_output_limit_exceeded: "当前模型不接受所填最大输出，请按模型文档修改最大输出",
  model_name_invalid: "模型名称不可用，请核对模型名称和接口类型",
  model_protocol_unsupported: "模型调用协议不可用，请核对接口类型和模型服务商",
  model_request_unauthorized: "认证失败，请检查 API Key 或订阅权限",
  model_request_forbidden: "认证失败，请检查 API Key 或订阅权限",
  model_authentication_failed: "认证失败，请检查 API Key 或订阅权限",
  model_rate_limited: "服务商限流，配置尚未完成验证，请稍后再次保存",
  model_request_rate_limited: "服务商限流，配置尚未完成验证，请稍后再次保存",
  model_service_unavailable: "服务暂时不可用，配置尚未完成验证",
  model_connection_unavailable: "服务暂时不可用，配置尚未完成验证",
  model_connection_timeout: "服务暂时不可用，配置尚未完成验证",
  model_dns_failed: "服务暂时不可用，请检查接口地址后再次保存",
  model_output_incomplete: "模型连接成功但验证输出不完整，请检查思考和最大输出配置",
  model_validation_output_incomplete: "模型连接成功但验证输出不完整，请检查思考和最大输出配置",
  model_connection_auth_failed: "认证失败，请检查 API Key 或订阅权限",
  model_connection_invalid_api_key: "认证失败，请检查 API Key 或订阅权限",
  model_connection_rate_limited: "服务商限流，配置尚未完成验证，请稍后再次保存",
  model_connection_model_unavailable: "模型或调用协议不可用，请核对模型名称和接口类型",
  model_connection_request_rejected: "模型服务拒绝了当前请求，请核对模型名称、调用协议和三个 Token 限制",
  model_connection_token_limits_rejected: "当前模型不接受所填限制，请修改上下文窗口、最大输入或最大输出",
  model_connection_output_incomplete: "模型连接成功但验证输出不完整，请检查思考和最大输出配置",
  output_truncated: "模型连接成功但验证输出不完整，请检查思考和最大输出配置",
  ai_response_missing_json_object: "模型连接成功但验证输出不完整，请检查思考和最大输出配置",
  credential_decryption_failed: "模型凭据无法解密，请联系管理员检查密钥版本",
  credential_not_encrypted: "检测到旧版明文凭据，请先完成凭据迁移",
  invalid_schedule_timezone: "运行时区无效",
  invalid_schedule_time: "运行时段格式无效",
  schedule_weekdays_required: "启用运行时段后，请至少选择一个星期",
  schedule_windows_required: "启用运行时段后，请至少添加一个时间段",
  schedule_windows_limit_exceeded: "运行时段最多只能添加 6 个",
  invalid_outside_window_behavior: "时段外行为无效",
  strategy_delete_confirmation_mismatch: "输入的策略名称不一致，未执行删除",
  strategy_delete_version_changed: "策略在确认期间已被修改，请重新检查后再删除",
  strategy_delete_impact_changed: "策略订阅情况在确认期间发生变化，请重新确认影响范围",
  strategy_delete_active_subscriptions_unconfirmed: "仍有运行中的订阅，必须明确确认停止后才能删除",
  private_strategy_limit_reached: "当前 Pro 账户最多只能创建 1 条自定义策略",
  trading_account_not_active: "当前交易账户不是活动账户，请确认桥接已连接且账户允许交易",
  trading_account_identity_immutable: "该交易账户已经完成身份验证，服务器和登录账号不能直接修改；如需更换账户，请删除后重新连接验证",
  ai_internal_error: "服务器处理失败，请稍后重试；如持续出现，请将错误编号提供给管理员",
  manual_trade_review_forbidden: "只有平台内容管理员或观摩源账号可以使用手动交易复盘",
  manual_trade_review_account_unavailable: "当前账号没有可用于复盘的活动交易账户",
  manual_trade_review_bridge_unavailable: "当前交易终端未连接，暂时无法读取手动交易历史",
  manual_trade_review_bridge_route_ambiguous: "当前交易账户对应多个终端连接，暂时无法安全复盘",
  manual_trade_review_evidence_unavailable: "手动交易证据暂不可用，请连接终端并稍后重试",
  manual_trade_review_mt4_visible_history_incomplete: "MT4 只复盘终端当前可见历史，请在 MT4“账户历史”中选择“全部历史”后刷新；系统不会宣称券商全量历史",
  manual_trade_review_mt4_visible_history_unknown: "当前 MT4 桥接未提供可见历史完整性证明，请升级桥接并在 MT4“账户历史”中选择“全部历史”后刷新",
  manual_trade_review_history_range_invalid: "最近 7 天的交易快照已失效，请重新刷新交易记录",
  manual_trade_review_selection_reference_invalid: "所选交易缺少可验证的订单或持仓引用，请刷新交易记录后重新选择",
  manual_trade_review_counterfactual_invalid: "开仓前盲测结果格式无效，请重试生成",
  manual_trade_review_counterfactual_immutable: "开仓前盲测结论已冻结，不能在事后人工改写",
  manual_trade_review_source_changed: "订单来源或冻结交易历史已发生变化，请刷新后重新选择",
  manual_trade_review_output_evidence_quality_invalid: "模型返回的证据质量与冻结证据不一致，请重试生成",
  manual_trade_review_evidence_quality_invalid: "模型返回的证据质量无效，请重试生成",
  manual_trade_review_job_not_found: "复盘生成任务不存在或已失效，请刷新复盘历史",
  manual_trade_review_retry_exhausted: "复盘生成重试次数已用尽，请重新创建复盘任务",
  market_evidence_unavailable: "行情证据暂不可用，请刷新交易记录后重试",
  chan_evidence_incomplete: "缠论证据未完整返回，本次仅保留证据不足结论",
  market_path_candle_coverage_incomplete: "行情 K 线覆盖不完整，本次仅保留证据不足结论",
  holding_path_bar_boundary_insufficient: "持仓区间缺少完整闭合 K 线，本次仅保留证据不足结论",
  manual_trade_review_generation_deadline_exceeded: "本轮复盘已超过 30 分钟生成期限，请手动重试以创建新一代任务",
  manual_trade_review_model_task_terminal_requires_retry: "本轮模型任务已经终止，请手动重试以创建新一代任务",
  manual_trade_review_approved_locked: "复盘已确认，不能再改写或切换确认版本",
  model_task_not_claimable: "复盘任务正在被其他生成流程处理，请稍后刷新",
  model_task_duplicate_terminal: "上一轮复盘任务已有最终结果，请刷新复盘历史",
  model_task_lease_active: "复盘任务仍在处理中，请稍后刷新",
  history_incomplete: "交易历史完整性尚未确认，暂不能安全筛选手动交易",
  clock_untrusted: "交易终端时间尚未校准，暂不能安全筛选手动交易",
  history_evidence_unavailable: "交易历史的成交证据暂不可用，暂不能安全筛选手动交易",
  history_cursor_unavailable: "交易历史游标暂不可用，已停止继续查找",
  history_cursor_repeated: "交易历史游标重复，已停止继续查找以避免循环",
  history_snapshot_changed: "交易历史快照发生变化，已停止继续查找，请刷新后重试",
  history_page_unavailable: "交易历史下一页暂不可用，已停止继续查找",
  system_association_lookup_unavailable: "系统关联证据暂不可用，已停止继续查找",
  positions_unavailable: "当前持仓证据暂不可用，已停止继续查找",
  manual_trade_review_selection_invalid: "请选择 1 笔最近 7 天的盈利未绑定信号订单",
  manual_trade_review_selection_duplicate: "交易来源已变化或重复，请刷新后重新选择",
  manual_trade_review_client_request_id_required: "任务请求编号缺失，请重试",
  manual_trade_review_model_unavailable: "当前没有可用的复盘模型，请先配置平台模型",
  manual_trade_review_retry_not_allowed: "当前复盘状态不支持重试",
  manual_trade_review_not_found: "没有找到这条手动交易复盘",
  manual_trade_review_version_required: "请先选择可确认的复盘版本",
  manual_trade_review_version_conflict: "复盘已被更新，请刷新后再保存",
  manual_trade_review_edit_not_allowed: "当前复盘状态不支持人工编辑",
  manual_trade_review_action_invalid: "复盘确认动作无效",
  manual_trade_review_generation_failed: "复盘模型生成失败，请检查模型配置后重试",
  platform_strategy_required: "请选择一个可管理的 active 平台策略",
  admin_only: "仅管理员可以使用此功能",
  observer_channel_access_denied: "当前账号不能查看这个观摩频道",
  observer_source_offline: "当前观摩频道暂时离线，请稍后重试",
  bridge_user_requires_pro: "观摩源账号必须是管理员或有效的 Pro 账号",
  bridge_user_not_found: "未找到这个观摩源账号",
  trading_account_not_owned_by_source: "所选交易账户不属于这个观摩源账号",
  observer_source_trading_account_required: "请先让该桥接源连接交易终端，再选择它当前的交易账户",
  observer_source_has_channels: "该观摩源仍绑定频道，请先移除相关频道",
  observer_source_strategy_required: "请选择这个观摩源固定运行的平台策略",
  observer_source_strategy_invalid: "所选平台策略不存在或已删除",
  observer_source_strategy_in_use: "该平台策略已绑定其他启用中的观摩源",
  default_observer_channel_cannot_be_deleted: "默认观摩频道不能删除，请先设置另一个默认频道",
  observer_source_email_invalid: "请输入有效的桥接源登录邮箱",
  observer_source_email_exists: "该邮箱已存在，请直接从桥接源账号中选择",
  observer_source_password_invalid: "密码需为 8–128 位，并同时包含字母和数字",
  "symbol required": "请选择交易品种",
  "timeframe required": "请选择 K 线周期",
  "strategy required": "请选择交易策略",
  "start_time and end_time required": "请选择完整的开始和结束时间",
  "model_ids must be an array of 2-5 model profile IDs": "请选择 2 至 5 个模型",
  "model_ids must contain 2-5 unique IDs": "请选择 2 至 5 个不同模型",
  invalid_history_time_range: "历史评估时间范围无效",
  history_compare_end_time_in_future: "结束时间晚于当前交易平台时间，请刷新时间范围后重试",
  history_market_data_unavailable: "历史行情暂不可用，请确认桥接和行情缓存状态",
  period_market_candles_unavailable: "所选区间内没有可用的完整历史 K 线，请调整时间范围后重试",
  period_market_source_unavailable: "历史行情源暂不可用，请检查管理员桥接和行情缓存",
  insufficient_kline_data_for_compare: "所选时间范围内的完整 K 线不足",
  history_compare_range_too_large: "所选范围包含超过 5000 根 K 线，请缩短时间范围或使用更大周期",
  invalid_history_evaluation_mode: "评估方式无效",
  continuous_backtest_range_too_large: "连续回测的实际闭合 K 线超过 120 根，请缩短行情范围或改用快速抽样",
  history_compare_strategy_context_incomplete: "部分决策时点缺少策略要求的多周期历史上下文，请补齐行情缓存或缩短、后移时间范围",
  timeframe_not_supported_by_strategy: "所选周期不在该策略的行情数据方案中",
  symbol_not_supported_by_strategy: "所选品种不在该策略支持范围内",
  history_compare_job_not_created: "历史模型对比任务创建失败",
  history_compare_job_not_found: "历史模型对比任务不存在或已过期",
  history_compare_job_already_running: "已有模型对比任务正在运行，请等待完成或先取消",
  history_compare_interrupted: "服务器重启导致任务中断，请重新发起评估",
  insufficient_available_models: "可用模型不足两个，请检查模型状态和凭据",
  history_compare_failed: "历史模型对比执行失败",
  history_compare_cancelled: "历史模型对比已取消",
  invalid_model_signal_type: "模型返回了无法识别的交易方向",
  model_compare_no_valid_response: "该模型在本次评估中没有产生有效响应",
  snapshot_compare_minimum_not_met: "至少需要选择 2 条历史信号快照",
  snapshot_compare_limit_exceeded: "一次最多选择 30 条历史信号快照",
  snapshot_compare_selection_invalid: "所选快照不存在、无权访问或推理证据不完整",
  snapshot_compare_strategy_mismatch: "所选快照不属于同一交易策略",
  snapshot_compare_strategy_version_mismatch: "所选快照的策略版本不同，请按版本分别评估",
  snapshot_compare_symbol_mismatch: "所选快照的交易品种不同，请按品种分别评估",
  snapshot_compare_schema_mismatch: "所选快照的输出格式版本不同，请分开评估",
  snapshot_compare_decision_time_missing: "快照缺少可靠的历史决策时间",
  snapshot_compare_outcome_candles_incomplete: "部分快照缺少信号产生后的行情，暂时无法评分",
  broker_contract_constraint: "订单不符合交易平台合约约束",
  pending_price_too_close: "挂单价格距离当时报价过近",
  market_order_not_allowed: "该合约不允许市价单",
  limit_order_not_allowed: "该合约不允许限价单",
  stop_order_not_allowed: "该合约不允许止损挂单",
  stop_limit_order_not_allowed: "该合约不允许止损限价单",
  stop_loss_not_allowed: "该合约不允许设置止损",
  take_profit_not_allowed: "该合约不允许设置止盈",
  volume_out_of_range: "下单手数超出合约范围",
  volume_step_mismatch: "下单手数不符合合约步进",
  directional_volume_limit_exceeded: "同方向下单总手数超过合约限制",
  reference_quote_unavailable: "缺少可用于回放的参考报价",
  entry_reference_invalid: "订单入场参考价无效",
  stop_loss_too_close: "止损距离入场价过近",
  take_profit_too_close: "止盈距离入场价过近",
  max_pending_orders_reached: "挂单数量已达模拟上限",
  max_concurrent_positions_reached: "持仓数量已达模拟上限",
  margin_calculation_unavailable: "无法可靠计算所需保证金",
  insufficient_free_margin: "模拟账户可用保证金不足",
  symbol_required: "请选择交易品种",
  pending_price_required: "挂单缺少有效触发价",
  pending_reference_price_unavailable: "当前行情参考价不可用",
  pending_price_direction_invalid: "挂单触发价方向与当前价格不符",
  stop_limit_price_required: "Stop Limit 缺少触发后的限价",
  stop_limit_price_relation_invalid: "Stop Limit 触发价与限价关系无效",
  mt4_stop_limit_unsupported: "MT4 不支持止损限价单，请改用市价、限价或止损挂单",
  invalid_signal_type: "模型返回了不支持的信号类型",
  invalid_entry_method: "模型返回了不支持的入场方式",
  signal_entry_mismatch: "信号类型与入场方式不一致",
  entry_method_not_allowed_by_strategy: "入场方式不在策略允许范围内",
  invalid_stop_loss_direction: "止损价格与交易方向不符",
  invalid_take_profit_direction: "止盈价格与交易方向不符",
  invalid_recommended_take_profit_tier: "AI 推荐的止盈档位无效",
  ai_volume_out_of_platform_range: "订单执行上限不符合交易平台手数规则",
  backtest_instrument_incomplete: "交易品种合约参数不完整",
  backtest_execution_candles_unavailable: "缺少用于订单回放的 M1 历史行情",
  backtest_symbol_snapshot_unavailable: "桥接端未返回交易品种合约参数",
  backtest_data_unavailable: "资金回放所需数据暂不可用",
  margin_calculation_unavailable: "当前品种缺少可靠的保证金计算参数，本笔模拟订单未执行",
};

const OBSERVER_WS_READ_ACTIONS = new Set([
  "health", "account", "symbols", "quote", "positions", "rates",
  "signals_latest_id", "signal_detail", "signal_evidence", "signals", "signal_tickets",
  "close_signal_tickets", "history", "history_chart_data", "history_prepare_status_v1", "pending_list",
  "signal_by_ticket",
]);

function isObserverMode() { return state.aiAccess?.read_only === true; }

function canUseBridgeObserverFallback() {
  return state.user?.role !== "admin" && state.user?.plan === "pro";
}

function bridgeOfflineObserverAccess() {
  return {
    mode:"observer", reason:"bridge_offline", read_only:true, can_download_bridge:true,
    allowed_tabs:["dashboard","model-strategy","ai-analyze","trading","history","feedback"],
    data_source:"platform_admin_account",
  };
}

function observerMessage() {
  if (state.aiAccess?.reason === "membership_expired") return "会员已过期，请续费后继续使用 AI 交易实验室";
  if (state.aiAccess?.reason === "membership_required") return "当前为免费账户，请升级会员后使用 AI 交易实验室";
  return state.aiAccess?.reason === "bridge_offline"
    ? "当前为观摩模式，请连接量见智桥后再操作"
    : "Plus 会员为观摩模式，仅支持查看";
}

function renderObserverSwitchStates({ tradeEnabled, autoEnabled } = {}) {
  const tradeKnown = typeof tradeEnabled === 'boolean';
  const autoKnown = typeof autoEnabled === 'boolean';
  renderTradePermissionBadge(tradeKnown ? tradeEnabled : null, { readonly:true });
  setBadge(
    "autoAnalyzeMode",
    autoKnown ? `自动分析${autoEnabled ? "开启" : "关闭"} · 只读` : "自动分析状态未知 · 只读",
    autoEnabled === true ? "active" : "neutral",
  );
  state.autoEnabled = autoEnabled === true;
}

function canAccessTab(tabId) {
  const allowed = state.aiAccess?.allowed_tabs;
  return !Array.isArray(allowed) || allowed.includes(tabId === "model-management" || tabId === "ai-config" ? "model-strategy" : tabId);
}

function syncAiAccess(access) {
  if (!access) return { changed:false, personalBridgeRestored:false };
  const previousMode = state.aiAccess?.mode;
  const previousReason = state.aiAccess?.reason;
  state.aiAccess = access;
  state.isPlusReadOnly = access.reason === "plus_plan";
  document.body.classList.toggle("ai-observer-mode", access.read_only === true);
  document.body.dataset.aiAccessReason = access.reason || "full";
  const changed = Boolean(previousMode) && (previousMode !== access.mode || previousReason !== access.reason);
  const personalBridgeRestored = previousMode === "observer" && access.mode !== "observer";
  if (!isObserverMode()) {
    state.observerChannels = [];
    state.selectedObserverChannelId = null;
  }
  // Access can change from the 15-second status refresh without reloading the
  // page. Re-render this control immediately so an old observer selector can
  // never remain visible after the user's own bridge becomes active.
  renderObserverChannelControl();
  applyRoleUI();
  if (!canAccessTab(activeTabId())) setTab("dashboard", { skipRefresh:true });
  if (changed) {
    _historyCache = null;
    _historyChartCache = null;
    _historyDirty = true;
    clearHistoryFreshnessRetry();
    cancelHistoryLegacySummaryRetry();
  }
  if (personalBridgeRestored) schedulePersonalBridgeRefresh();
  return { changed, personalBridgeRestored };
}

let _personalBridgeRefreshTimer = null;
let _initialDashboardBootstrapInFlight = false;

function schedulePersonalBridgeRefresh() {
  // The initial dashboard loader already reconciles access, symbols and the
  // active page. Scheduling the legacy global recovery in parallel would
  // duplicate every heavyweight startup request.
  if (_initialDashboardBootstrapInFlight) return;
  if (_personalBridgeRefreshTimer) return;
  _personalBridgeRefreshTimer = setTimeout(() => {
    _personalBridgeRefreshTimer = null;
    state.platformMarketSourceActive = false;
    state.lastObserverQuote = null;
    _historyCache = null;
    _historyChartCache = null;
    refreshAll().then(() => refreshTabData(activeTabId())).catch(error => {
      console.warn('[BridgeAccess] 个人桥接数据自动刷新失败:', error?.message || error);
    });
  }, 0);
}

function notifyObserverChannelSelection() {
  if (!state.selectedObserverChannelId || state.bridgeWs?.readyState !== WebSocket.OPEN) return;
  try {
    state.bridgeWs.send(JSON.stringify({
      type:"hb",
      seq:++state._hbSeq,
      observer_channel_id:state.selectedObserverChannelId,
    }));
  } catch {}
}

async function enterBridgeObserverMode({ paused = false, refresh = true } = {}) {
  // Keep admins in their full management context. Ordinary Pro users switch
  // immediately so a deliberate pause never leaves the page waiting for a
  // WebSocket timeout before the default observer source becomes available.
  if (paused) {
    state.bridgeRuntimeControl = {
      ...(state.bridgeRuntimeControl || {}),
      desired_state:"paused",
      actual_state:"paused",
    };
  }
  if (canUseBridgeObserverFallback()) syncAiAccess(bridgeOfflineObserverAccess());
  if (!isObserverMode()) {
    renderGatewayConnectionBadge(false, false);
    return false;
  }

  state._usingFallback = true;
  state._lastUsingFallback = true;
  state._lastGatewayLive = false;
  state.platformMarketSourceActive = false;
  state.lastObserverQuote = null;
  state.signals = [];
  state.positions = [];
  _historyCache = null;
  _historyChartCache = null;
  _historyDirty = true;
  clearHistoryFreshnessRetry();
  cancelHistoryLegacySummaryRetry();
  setText("quoteTime", "--");
  setText("mt5ServerTime", "--");
  renderPositionRows();
  stopLiveQuoteRefreshTimer();

  // Refresh the server-authoritative access context after the bridge route has
  // been removed. The local transition above remains a safe fallback if this
  // small request happens to fail during a network interruption.
  try {
    const accessRes = await api("/api/ai/access-context");
    syncAiAccess(accessRes.access);
  } catch (error) {
    console.warn("[BridgeAccess] 观摩模式状态同步失败:", error?.message || error);
  }

  if (!isObserverMode()) {
    renderGatewayConnectionBadge(false, false);
    return false;
  }
  await loadObserverChannels().catch(error => {
    console.warn("[BridgeAccess] 观摩源列表加载失败:", error?.message || error);
  });
  notifyObserverChannelSelection();
  renderGatewayConnectionBadge(false, true);
  if (refresh) await refreshAll();
  return true;
}

function apiErrorMessage(code) {
  const raw = String(code || "未知错误");
  if (raw.startsWith('active_subscription_conflict:')) return '已有其他策略启用自动分析，请先关闭原订阅或确认切换';
  if (API_ERROR_MESSAGES[raw]) return API_ERROR_MESSAGES[raw];
  return raw
    .replace(/The operation was aborted due to timeout/gi, "模型请求超时")
    .replace(/request timed out/gi, "模型请求超时")
    .replace(/\btimeout\b/gi, "请求超时");
}

// Ordinary API calls intentionally retain the short 15-second default below.
// A model request is different: the backend may wait up to the configured
// model deadline (30–600 seconds), so the browser must leave a small transport
// margin and never abort before that deadline.
const MODEL_REQUEST_TRANSPORT_MARGIN_MS = 5_000;
const DEFAULT_MODEL_REQUEST_TIMEOUT_MS = 120_000;
function modelRequestTransportTimeoutMs(requestTimeoutMs) {
  const configured = Number(requestTimeoutMs);
  const modelDeadline = Number.isFinite(configured) && configured >= 30_000 && configured <= 600_000
    ? configured
    : DEFAULT_MODEL_REQUEST_TIMEOUT_MS;
  return modelDeadline + MODEL_REQUEST_TRANSPORT_MARGIN_MS;
}

// Keep the legacy WebSocket command wait aligned with the formal single
// provider-attempt safety deadlines in server/routes/ai/model-task-budget.js.
// The extra transport margin prevents the browser from aborting first.
const MODEL_TASK_ATTEMPT_TIMEOUTS_MS = Object.freeze({
  manual_analysis: 15 * 60_000,
  model_compare: 15 * 60_000,
});
function modelTaskAttemptTransportTimeoutMs(taskKind) {
  const attemptMs = MODEL_TASK_ATTEMPT_TIMEOUTS_MS[taskKind];
  if (!Number.isFinite(attemptMs)) throw new Error(`未知模型任务类型：${taskKind}`);
  return attemptMs + MODEL_REQUEST_TRANSPORT_MARGIN_MS;
}

async function api(path, options = {}) {
  const method = String(options.method || "GET").toUpperCase();
  if (isObserverMode() && path.startsWith("/api/ai/") && method !== "GET") {
    throw new Error(observerMessage());
  }
  const headers = { ...(options.headers || {}) };
  if (state.token) headers.Authorization = `Bearer ${state.token}`;
  if (options.body && !headers["Content-Type"]) headers["Content-Type"] = "application/json";
  const body = (options.body && typeof options.body === 'object') ? JSON.stringify(options.body) : options.body;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), options.timeout || 15000);
  try {
    const response = await fetch(path, { ...options, body, headers, signal: controller.signal });
    clearTimeout(timeoutId);
    const text = await response.text();
    let data = {};
    try { data = text ? JSON.parse(text) : {}; } catch { data = { detail: text }; }
    if (!response.ok) {
      const code = data.error || data.code || null;
      const error = new Error(apiErrorMessage(code || data.detail || data.message || `HTTP ${response.status}`));
      error.name = "ApiError";
      error.status = response.status;
      error.code = code;
      error.incidentId = data.incident_id || null;
      if (response.status === 401) invalidateSession();
      throw error;
    }
    if (data?.runtime_sync?.degraded) {
      queueMicrotask(() => toast("设置已保存，但运行时同步仍在重试，请稍后刷新状态", "warning"));
    }
    return data;
  } catch (err) {
    clearTimeout(timeoutId);
    if (err.name === 'AbortError') throw new Error('请求超时');
    throw err;
  }
}

function setHistoryAccountIdentity(identity) {
  const next = identity && typeof identity === "object" ? {
    ...identity,
    platform:normalizeBridgePlatform(identity.platform || state.bridgePlatform),
    brokerServerKey:String(identity.brokerServerKey || identity.broker_server || identity.server || "").trim().toUpperCase(),
    loginAccount:String(identity.loginAccount ?? identity.login_account ?? identity.login ?? "").trim(),
  } : null;
  const previousKey = historyStableAccountKey(state.bridgeAccountIdentity);
  const nextKey = historyStableAccountKey(next);
  if (previousKey !== nextKey) cancelHistoryLegacySummaryRetry();
  if (previousKey && nextKey && previousKey !== nextKey) {
    cancelHistoryPrepareRetry();
    _historyQueryGeneration += 1;
    state.historyQueryGeneration = _historyQueryGeneration;
    _historyQueryState = null;
    state.historyQueryState = null;
    state._accountContextGeneration = Number(state._accountContextGeneration || 0) + 1;
    _historyCache = null;
    _historyChartCache = null;
    _historyDirty = true;
    resetHistoryCursorState(null);
    state.historyRangeMeta = null;
    state.historyChartSelectedDate = "";
    state.historyChartFocusIndex = -1;
    clearHistoryPresentation({ syncing:false });
  }
  state.bridgeAccountIdentity = next;
  if (nextKey !== previousKey) prepareHistoryRangePreferenceForIdentity();
}

function normalizeNotificationSummary(data = {}) {
  const summary = data.summary && typeof data.summary === "object" ? data.summary : data;
  const unreadValue = summary.unreadCount ?? summary.unread_count ?? 0;
  const importantValue = summary.importantUnacknowledgedCount ?? summary.important_unacknowledged_count ?? 0;
  const latestRaw = summary.latestImportant ?? summary.latest_important ?? null;
  const latestImportant = latestRaw && latestRaw.id != null ? {
    id:latestRaw.id,
    title:String(latestRaw.title || "重要通知"),
    priority:String(latestRaw.priority || "important"),
    requiresAck:Boolean(latestRaw.requiresAck ?? latestRaw.requires_ack ?? true),
    ...(latestRaw.message ? { message:String(latestRaw.message) } : {}),
  } : null;
  return {
    unreadCount:Math.max(0,Number(unreadValue) || 0),
    importantUnacknowledgedCount:Math.max(0,Number(importantValue) || 0),
    latestImportant,
  };
}

function updateNotificationSummary(data = {}, { announce=true } = {}) {
  const summary = normalizeNotificationSummary(data);
  const previousLatestId = state.latestImportant?.id == null ? "" : String(state.latestImportant.id);
  const previousImportantCount = Number(state.notificationImportantUnacknowledgedCount || 0);
  state.notificationUnread = summary.unreadCount;
  state.notificationImportantUnacknowledgedCount = summary.importantUnacknowledgedCount;
  state.latestImportant = summary.latestImportant;
  state.notificationSummaryLoaded = true;

  const badge = $("notificationBadge");
  const accountButton = $("accountCenterBtn");
  if (badge) {
    const count = state.notificationUnread;
    badge.textContent = count >= 100 ? "99+" : count > 0 ? String(count) : "";
    badge.hidden = count <= 0;
    badge.setAttribute("aria-hidden", count > 0 ? "false" : "true");
  }
  if (accountButton) {
    const count = state.notificationUnread;
    accountButton.title = count > 0 ? `查看 ${count >= 100 ? "99+" : count} 条未读通知` : "账户、会员与账单";
    accountButton.setAttribute("aria-label", count > 0 ? `账户中心，${count >= 100 ? "99+" : count} 条未读通知` : "打开账户中心");
  }

  const banner = $("notificationBanner");
  const titleNode = $("notificationBannerTitle");
  const messageNode = $("notificationBannerMessage");
  const countNode = $("notificationBannerCount");
  const latest = state.latestImportant;
  const showBanner = state.notificationImportantUnacknowledgedCount > 0 && latest?.id != null;
  if (banner) banner.hidden = !showBanner;
  if (showBanner) {
    if (titleNode) titleNode.textContent = latest.title || "重要通知";
    if (messageNode) messageNode.textContent = latest.message || "请打开通知中心查看详情，并完成确认。";
    if (countNode) countNode.textContent = state.notificationImportantUnacknowledgedCount > 1 ? `另有 ${state.notificationImportantUnacknowledgedCount - 1} 条待确认` : "需要确认";
    if (announce && (String(latest.id) !== previousLatestId || state.notificationImportantUnacknowledgedCount > previousImportantCount)) {
      // role=status + aria-live=polite is intentionally used instead of a
      // forced alert. The same id is not announced twice in this session.
      if (state._notificationAnnouncedId !== String(latest.id)) {
        state._notificationAnnouncedId = String(latest.id);
        banner.dataset.announcement = "new";
      }
    }
  }
  initIcons();
  return summary;
}

function refreshNotificationSummary({ announce=true } = {}) {
  if (!state.token) return Promise.resolve(null);
  if (state.notificationSummaryFlight) return state.notificationSummaryFlight;
  state.notificationSummaryFlight = api("/api/notifications/summary")
    .then(result => updateNotificationSummary(result, { announce }))
    .catch(error => {
      if (Number(error?.status) !== 401) console.warn("[Notifications] 摘要刷新失败:", error?.message || error);
      return null;
    })
    .finally(() => { state.notificationSummaryFlight = null; });
  return state.notificationSummaryFlight;
}

function handleNotificationCreated(message = {}) {
  const summary = message.summary && typeof message.summary === "object" ? message.summary : null;
  if (summary) {
    updateNotificationSummary(summary);
    void refreshNotificationSummary();
    return;
  }
  const unreadCount = message.unreadCount ?? message.unread_count;
  const importantCount = message.importantUnacknowledgedCount ?? message.important_unacknowledged_count;
  const latestImportant = message.latestImportant ?? message.latest_important;
  if (unreadCount != null || importantCount != null || latestImportant) {
    updateNotificationSummary({
      unreadCount:unreadCount ?? state.notificationUnread,
      importantUnacknowledgedCount:importantCount ?? state.notificationImportantUnacknowledgedCount,
      latestImportant:latestImportant ?? state.latestImportant,
    });
  }
  void refreshNotificationSummary();
}

// WebSocket API — primary channel for all MT5/AI data
let _wsCmdId = 0;
const _wsPending = new Map();

function wsApi(action, params = {}, timeoutOverride) {
  return new Promise((resolve, reject) => {
    if (isObserverMode() && !OBSERVER_WS_READ_ACTIONS.has(action)) return reject(new Error(observerMessage()));
    const ws = state.bridgeWs;
    if (!ws || ws.readyState !== 1) return reject(new Error('WebSocket未连接'));
    const cmdId = `ws_${++_wsCmdId}`;
    // analyze/auto-inference may take 60-120s
    const requestParams = { ...params };
    if (isObserverMode() && state.selectedObserverChannelId) {
      requestParams.observer_channel_id = state.selectedObserverChannelId;
    }
    const queuedDataAction = ['history', 'history_chart_data', 'rates'].includes(action);
    const timeout = timeoutOverride || requestParams._timeout || (action === 'analyze' ? 120000 : action === 'signals' || action === 'signal-pending-info' ? 30000 : queuedDataAction ? 45000 : 10000);
    delete requestParams._timeout;
    const timer = setTimeout(() => { _wsPending.delete(cmdId); reject(new Error('请求超时')); }, timeout);
    _wsPending.set(cmdId, { resolve, reject, timer });
    try {
      ws.send(JSON.stringify({ type: 'command', command_id: cmdId, action, params: requestParams }));
    } catch (err) {
      clearTimeout(timer);
      _wsPending.delete(cmdId);
      reject(err);
    }
  });
}

function setAuth(token) {
  state.token = token;
  if (token) localStorage.setItem("authToken", token);
  else localStorage.removeItem("authToken");
}

function showApp(show) {
  $("appView").classList.toggle("hidden", !show);
  initIcons();
}

function activeTabId() {
  return document.querySelector(".tab-panel.active")?.id || "dashboard";
}

function stopRealtimeSync() {
  if (state.backgroundSyncTimer) { clearInterval(state.backgroundSyncTimer); state.backgroundSyncTimer = null; }
}

function clearAccountContextCaches() {
  cancelHistoryPrepareRetry();
  cancelHistoryLegacySummaryRetry();
  _historyQueryGeneration += 1;
  state.historyQueryGeneration = _historyQueryGeneration;
  _historyQueryState = null;
  state.historyQueryState = null;
  _historyCache = null;
  _historyChartCache = null;
  _historyDirty = true;
  _lastHistoryRevision = null;
  clearHistoryFreshnessRetry();
  resetHistoryCursorState(null);
  _historyCircuitBreakers.clear();
  _historyErrorNotices.clear();
  _historyTicketMapCache.clear();
  _historyTicketMapFlights.clear();
  state.historyRangePreferenceKey = null;
  state.historyRangePreferences = null;
  state.historyRangeMeta = null;
  state.historyChartDaily = [];
  state.historyChartSelectedDate = "";
  state.historyChartFocusIndex = -1;
  clearHistoryPresentation({ syncing:false });
  state.lastQuote = null;
  state.bridgeAccountIdentity = null;
  state.mt5TimezoneOffsetMinutes = null;
  state.positions = [];
  state.pendingOrders = [];
  state.tradingAccounts = [];
  state.strategySubscriptions = [];
  state.signals = [];
  state.selectedSignal = null;
  state.latestSignalId = null;
  state.analysisHistoryOffset = 0;
  state.analysisHistoryHasMore = true;
  state.analysisHistoryPageLoaded = false;
  _analysisHistoryLoadPromise = null;
  _prevPositionCount = 0;
  if ($("positionsBody")) $("positionsBody").innerHTML = renderPositionRows([]);
  if ($("dashboardPositionsBody")) $("dashboardPositionsBody").innerHTML = renderPositionRows([]);
}

function invalidateSession() {
  if (_sessionInvalidating) return false;
  _sessionInvalidating = true;

  // Stop every timer that could issue another request or schedule a reconnect
  // after the browser session has been revoked.
  if (state._reconnectTimer) { clearTimeout(state._reconnectTimer); state._reconnectTimer = null; }
  if (state._hbTimer) { clearInterval(state._hbTimer); state._hbTimer = null; }
  if (_personalBridgeRefreshTimer) { clearTimeout(_personalBridgeRefreshTimer); _personalBridgeRefreshTimer = null; }
  if (_bridgeDataRefreshTimer) { clearTimeout(_bridgeDataRefreshTimer); _bridgeDataRefreshTimer = null; }
  if (_bridgeControlRefreshTimer) { clearInterval(_bridgeControlRefreshTimer); _bridgeControlRefreshTimer = null; }
  if (_signalMonitorUpdateTimer) { clearTimeout(_signalMonitorUpdateTimer); _signalMonitorUpdateTimer = null; }
  if (state._posRefreshTimer) { clearTimeout(state._posRefreshTimer); state._posRefreshTimer = null; }
  if (state.positionManagementRealtimeTimer) { clearTimeout(state.positionManagementRealtimeTimer); state.positionManagementRealtimeTimer = null; }
  if (state.signalManagementRealtimeTimer) { clearTimeout(state.signalManagementRealtimeTimer); state.signalManagementRealtimeTimer = null; }
  stopRealtimeSync();
  stopPresenceHeartbeat();
  stopUiTimer();
  stopLiveQuoteRefreshTimer();
  stopKlineRefreshTimers();
  clearKlineData('读取失败');
  stopPositionProtectionPolling();
  stopAdminStrategyClosePolling();
  resetAdminStrategyCloseState();
  stopAdminStrategyDispatchPolling();
  stopManualAnalysisPolling();
  stopReviewDetailPolling();
  stopManualTradeReviewPolling();
  if (state.reviewSummaryTimer) clearInterval(state.reviewSummaryTimer);
  state.reviewSummaryTimer = null;
  state.reviewListRequestVersion += 1;
  state.reviewDetailRequestVersion += 1;
  _bridgeDataRefreshStreams.clear();

  // Reject commands before closing the socket so callers cannot remain
  // pending if the WebSocket close event is delayed by the browser.
  for (const [id, pending] of _wsPending) {
    clearTimeout(pending.timer);
    pending.reject(new Error('登录状态已失效'));
    _wsPending.delete(id);
  }
  const ws = state.bridgeWs;
  state.bridgeWs = null;
  if (ws) { try { ws.close() } catch {} }

  clearAccountContextCaches();
  state.token = "";
  state.user = null;
  state.notificationUnread = 0;
  state.notificationImportantUnacknowledgedCount = 0;
  state.latestImportant = null;
  state._notificationAnnouncedId = "";
  state.notificationSummaryLoaded = false;
  state.notificationWsReady = false;
  updateNotificationSummary({ unreadCount:0, importantUnacknowledgedCount:0, latestImportant:null }, { announce:false });
  state.aiAccess = null;
  state.observerChannels = [];
  state.selectedObserverChannelId = null;
  state.signals = [];
  state.selectedSignal = null;
  state.dashboardSignal = null;
  state.latestSignalId = null;
  state.auditRows = [];
  state.modelProfiles = [];
  state.modelPurposeBindings = null;
  state.modelPurposeBindingsError = "";
  state.adminStrategyDispatchCapabilities = { enabled:false, supported_entry_methods:[] };
  state.adminStrategyDispatchCapabilitiesLoaded = false;
  state.adminStrategyDispatchPreview = null;
  state.adminStrategyDispatchPending = null;
  state.adminStrategyDispatch = null;
  state.adminStrategyClosePreview = null;
  state.adminStrategyClosePreviewTicket = null;
  state.adminStrategyCloseJob = null;
  state.reviewCases = [];
  state.reviewSummary = { pending:0, issues:0, unread:0, pending_confirmation:0, generating:0, failed:0, total:0, daily_total:0, monthly_total:0, daily_attention:0, monthly_attention:0 };
  state.reviewSummaryInitialized = false;
  state.strategyMemoryStrategies = [];
  state.selectedStrategyMemoryId = null;
  state.strategyMemoryDetail = null;
  state.reviewMemoryView = "reviews";
  state.manualTradeReviewView = "selection";
  state.manualTradeReviewFilters = { pageSize:20, cursor:null, historySnapshotId:null, rangeStartUtcMsc:null, rangeEndUtcMsc:null, symbol:"", direction:"" };
  state.manualTradeReviewCursorStack = [null];
  state.manualTradeReviewCursorIndex = 0;
  state.manualTradeReviewTrades = [];
  state.manualTradeReviewSelectedTrades = [];
  state.manualTradeReviewSelection = [];
  state.manualTradeReviewNextCursor = null;
  state.manualTradeReviewHasMore = false;
  state.manualTradeReviewScannedSourcePages = 0;
  state.manualTradeReviewSkippedEmptySourcePages = 0;
  state.manualTradeReviewUnavailable = false;
  state.manualTradeReviewEvidenceReason = "";
  state.manualTradeReviewHistoryScopeNote = "";
  state.manualTradeReviewHistorySourceLimited = false;
  state.manualTradeReviewLoaded = false;
  state.manualTradeReviewStrategies = [];
  state.manualTradeReviewStrategyId = null;
  state.manualTradeReviewCases = [];
  state.manualTradeReviewHistoryLoaded = false;
  state.manualTradeReviewSelectedId = null;
  state.selectedManualTradeReviewId = null;
  state.manualTradeReviewDetail = null;
  state.manualTradeReviewDetailRequestVersion += 1;
  state.manualTradeReviewClientRequestId = null;
  state.manualTradeReviewPollRetryAttempt = 0;
  state.manualTradeReviewPollWaitingForVisible = false;
  state.signalTickets = {};
  state.closeSignalTickets = {};
  clearManualAnalysisTask();
  if (window.AuthSession) window.AuthSession.clear();
  else {
    setAuth("");
    localStorage.removeItem("ws_token");
    localStorage.removeItem("ws_user");
    document.cookie = "ws_token=; Max-Age=0; Path=/; SameSite=Lax";
  }
  showApp(false);
  window.location.href = "/ai/auth/?mode=login";
  return true;
}

async function handleAccountSwitched(msg = {}) {
  if (msg.platform) updateBridgePlatformUI(msg.platform);
  const platform = bridgePlatformLabel(msg.platform || state.bridgePlatform);
  const generation = Number(state._accountContextGeneration || 0) + 1;
  state._accountContextGeneration = generation;
  clearAccountContextCaches();
  const login = msg.account?.login == null ? "" : String(msg.account.login);
  if (!msg.verified) {
    toast(`当前 ${platform} 登录没有交易权限，账户数据可查看，但系统不会接管或执行交易`, "warning");
  } else if (msg.ownership_transferred) {
    toast(`${platform} 账户${login ? ` ${login}` : ""}已切换到当前平台账号`, "success");
  } else if (msg.switched) {
    toast(`已切换到 ${platform} 账户${login ? ` ${login}` : ""}，正在刷新账户数据`, "success");
  }
  const results = await Promise.allSettled([
    loadStatus(), loadSymbols(), loadAccount(), loadPositions(), loadStrategyCatalog(),
  ]);
  if (generation !== state._accountContextGeneration) return;
  const currentAccount = state.tradingAccounts?.find(account => Number(account.is_active) === 1);
  if (currentAccount && !$('subscriptionEditor')?.classList.contains('hidden')) {
    const strategyId = Number($('subscriptionStrategy')?.value || $('subscriptionEditor')?.dataset.strategyId || 0);
    const strategy = selectableSubscriptionStrategies().find(item => Number(item.id) === strategyId);
    if (strategy) hydrateSubscriptionEditor(strategy, subscriptionForStrategyAccount(strategy.id, currentAccount.id));
  }
  // Heavy account data (history, chart, pending orders and risk details) stays
  // demand-driven: refresh only the page the user is currently viewing.
  await refreshTabData(activeTabId()).catch(() => {});
  const rejected = results.find(item => item.status === "rejected");
  if (rejected) console.warn("[AccountSwitch] 部分账户数据刷新失败:", rejected.reason);
}

function signalMarketData(signal) {
  const legacy = signal?.market_data;
  if (legacy && typeof legacy === "object" && Object.keys(legacy).length) return legacy;
  const snapshot = signal?.inference_snapshot?.market_snapshot;
  return snapshot && typeof snapshot === "object" ? snapshot : {};
}

function clearHistoryFreshnessRetry() {
  if (_historyFreshnessRetry?.timer) clearTimeout(_historyFreshnessRetry.timer);
  _historyFreshnessRetry = null;
  cancelHistoryLegacySummaryRetry();
}

function cancelHistoryLegacySummaryRetry() {
  const retry = _historyLegacySummaryRetry;
  if (!retry) return;
  retry.cancelled = true;
  if (retry.timer) clearTimeout(retry.timer);
  _historyLegacySummaryRetry = null;
}

function finishHistoryLegacySummaryRetry(retry, { success = false, exhausted = false } = {}) {
  if (_historyLegacySummaryRetry !== retry) return;
  if (retry.timer) clearTimeout(retry.timer);
  _historyLegacySummaryRetry = null;
  if (!historyQueryIsCurrent(retry.query)) return;
  retry.query.status = success ? "ready" : "unavailable";
  if (success) {
    renderHistorySyncStatus("历史记录已更新，范围统计已完成", { tone:"success", busy:false });
    return;
  }
  const message = exhausted
    ? "范围统计准备时间较长，请稍后点击“刷新”重试"
    : "范围统计自动刷新失败，请稍后点击“刷新”重试";
  renderHistorySyncStatus(message, { tone:"warning", busy:false });
  if (exhausted && !retry.exhaustedNoticeShown) {
    retry.exhaustedNoticeShown = true;
    toast(message, "warning");
  }
}

function scheduleHistoryLegacySummaryRetry(query) {
  if (normalizeBridgePlatform(state.bridgePlatform) !== "mt4" || !historyQueryIsCurrent(query)) return;
  const accountKey = historyStableAccountKey();
  let retry = _historyLegacySummaryRetry;
  if (!retry || retry.query !== query || retry.accountKey !== accountKey
    || retry.platform !== normalizeBridgePlatform(state.bridgePlatform)) {
    cancelHistoryLegacySummaryRetry();
    retry = {
      query,
      generation:Number(query.generation),
      accountKey,
      platform:normalizeBridgePlatform(state.bridgePlatform),
      attempts:0,
      timer:null,
      inFlight:false,
      cancelled:false,
      exhaustedNoticeShown:false,
    };
    _historyLegacySummaryRetry = retry;
  }
  if (retry.attempts >= HISTORY_LEGACY_SUMMARY_RETRY_MAX_ATTEMPTS) {
    finishHistoryLegacySummaryRetry(retry, { exhausted:true });
    return;
  }
  if (retry.timer || retry.inFlight) return;
  renderHistorySyncStatus("交易记录已显示，范围统计仍在准备中，系统将继续自动重试", { tone:"warning", busy:true });
  const delay = HISTORY_LEGACY_SUMMARY_RETRY_DELAYS_MS[
    Math.min(retry.attempts, HISTORY_LEGACY_SUMMARY_RETRY_DELAYS_MS.length - 1)
  ];
  retry.timer = setTimeout(async () => {
    retry.timer = null;
    if (_historyLegacySummaryRetry !== retry || retry.cancelled
      || !historyQueryIsCurrent(retry.query)
      || retry.accountKey !== historyStableAccountKey()
      || retry.platform !== normalizeBridgePlatform(state.bridgePlatform)) {
      if (_historyLegacySummaryRetry === retry) cancelHistoryLegacySummaryRetry();
      return;
    }
    if (retry.attempts >= HISTORY_LEGACY_SUMMARY_RETRY_MAX_ATTEMPTS) {
      finishHistoryLegacySummaryRetry(retry, { exhausted:true });
      return;
    }
    retry.attempts += 1;
    retry.inFlight = true;
    try {
      // historyRetryAttempt keeps the frozen range and asks the compatibility
      // layer for a lightweight continuation.  skipPrepare avoids falling back
      // into the unsupported probe on every attempt; loadHistoryViewsLegacy's
      // flight map still deduplicates a concurrent request for this context.
      const result = await loadHistoryViews({
        forceRefresh:false,
        // The initial fallback may have loaded the account card alongside the
        // table, but a background summary retry must stay history-only.
        includeAccount:false,
        manualRefresh:false,
        historyRetryAttempt:true,
        disableRangeRetry:true,
        disableFreshnessRetry:true,
        skipPrepare:true,
      });
      retry.inFlight = false;
      if (_historyLegacySummaryRetry !== retry || retry.cancelled) return;
      if (!historyQueryIsCurrent(retry.query)
        || retry.accountKey !== historyStableAccountKey()
        || retry.platform !== normalizeBridgePlatform(state.bridgePlatform)) {
        cancelHistoryLegacySummaryRetry();
        return;
      }
      const retrySucceeded = Boolean(result)
        && result.historyPending === false
        && result.summaryPending !== true
        && result.historyStale !== true;
      if (retrySucceeded) {
        finishHistoryLegacySummaryRetry(retry, { success:true });
      } else {
        scheduleHistoryLegacySummaryRetry(retry.query);
      }
    } catch {
      retry.inFlight = false;
      if (_historyLegacySummaryRetry !== retry || retry.cancelled) return;
      if (!historyQueryIsCurrent(retry.query)
        || retry.accountKey !== historyStableAccountKey()
        || retry.platform !== normalizeBridgePlatform(state.bridgePlatform)) {
        cancelHistoryLegacySummaryRetry();
        return;
      }
      // A transient Bridge/SQLite read error consumes one bounded attempt but
      // does not turn a recoverable background refresh into a manual-only
      // failure.  The next delayed attempt remains guarded by the same query.
      scheduleHistoryLegacySummaryRetry(retry.query);
    }
  }, delay);
}

function historySyncMetadata(data) {
  return data?.history_sync && typeof data.history_sync === "object"
    ? data.history_sync : {};
}

function historyRevisionFromData(data) {
  const rawRevision = historySyncMetadata(data).history_revision;
  if (rawRevision == null || (typeof rawRevision === "string" && rawRevision.trim() === "")
      || (typeof rawRevision !== "number" && typeof rawRevision !== "string")) return null;
  const revision = Number(rawRevision);
  return Number.isSafeInteger(revision) && revision >= 0 ? revision : null;
}

async function loadHistoryTicketMapsForData(data) {
  const historyRevision = historyRevisionFromData(data);
  // Pin the current revision before starting either map request. Each request
  // also receives the explicit revision so a concurrent Bridge push cannot
  // change the cache key through `_lastHistoryRevision` while it is loading.
  if (historyRevision !== null) _lastHistoryRevision = historyRevision;
  const loadMap = loader => Promise.resolve()
    .then(() => loader({ historyRevision }))
    .catch(() => {});
  await Promise.all([
    loadMap(loadSignalTickets),
    loadMap(loadCloseSignalTickets),
  ]);
  return historyRevision;
}

function historyPrepareRangeFromResponse(data = {}) {
  const candidates = [data?.history_range, data?.scope_range, data?.range].filter(item => item && typeof item === "object");
  const firstObject = (...values) => values.find(value => value && typeof value === "object") || {};
  const numberFrom = (source, keys) => {
    for (const key of keys) {
      const value = Number(source?.[key]);
      if (Number.isSafeInteger(value) && value > 0) return value;
    }
    return null;
  };
  const source = candidates.find(item => numberFrom(item, ["range_start_utc_msc", "start_utc_msc"]) != null
    || numberFrom(item, ["range_end_utc_msc", "end_utc_msc", "captured_end_utc_msc"]) != null) || {};
  const allowed = firstObject(source.allowed_range, data?.allowed_range);
  const system = firstObject(source.system_range, data?.system_range);
  const effective = firstObject(source.effective_range, data?.effective_range);
  const rangeStart = numberFrom(source, ["range_start_utc_msc", "start_utc_msc"])
    || numberFrom(effective, ["range_start_utc_msc", "start_utc_msc"]);
  const rangeEnd = numberFrom(source, ["range_end_utc_msc", "end_utc_msc"])
    || numberFrom(effective, ["range_end_utc_msc", "end_utc_msc"]);
  const capturedEnd = numberFrom(source, ["captured_end_utc_msc", "captured_range_end_utc_msc"])
    || numberFrom(effective, ["captured_end_utc_msc", "end_utc_msc"])
    || rangeEnd;
  if (!Number.isSafeInteger(rangeStart) || !Number.isSafeInteger(rangeEnd)
    || rangeStart <= 0 || rangeStart >= rangeEnd || !Number.isSafeInteger(capturedEnd)) return null;
  const allowedStart = numberFrom(source, ["allowed_start_utc_msc"])
    || numberFrom(allowed, ["range_start_utc_msc", "start_utc_msc"])
    || numberFrom(data, ["allowed_start_utc_msc"]);
  const systemStart = numberFrom(source, ["system_start_utc_msc"])
    || numberFrom(system, ["range_start_utc_msc", "start_utc_msc"])
    || numberFrom(data, ["system_start_utc_msc"]);
  const effectiveStart = numberFrom(source, ["effective_start_utc_msc"])
    || numberFrom(effective, ["range_start_utc_msc", "start_utc_msc"])
    || rangeStart;
  const allowedRange = {
    ...allowed,
    ...(Number.isSafeInteger(allowedStart) ? { start_utc_msc:allowedStart } : {}),
  };
  const systemRange = {
    ...system,
    ...(Number.isSafeInteger(systemStart) ? { start_utc_msc:systemStart } : {}),
  };
  const effectiveRange = {
    ...effective,
    ...(Number.isSafeInteger(effectiveStart) ? { start_utc_msc:effectiveStart } : {}),
  };
  return {
    ...source,
    range_start_utc_msc:rangeStart,
    range_end_utc_msc:rangeEnd,
    captured_end_utc_msc:capturedEnd,
    allowed_start_utc_msc:Number.isSafeInteger(allowedStart) ? allowedStart : rangeStart,
    system_start_utc_msc:Number.isSafeInteger(systemStart) ? systemStart : rangeStart,
    effective_start_utc_msc:Number.isSafeInteger(effectiveStart) ? effectiveStart : rangeStart,
    // Preserve server-provided allowed/system/effective ends.  In particular,
    // a custom scope may have captured_end_utc_msc beyond its range end; the
    // three frozen metadata objects must not be collapsed to one endpoint.
    allowed_range:allowedRange,
    system_range:systemRange,
    effective_range:effectiveRange,
  };
}

function historyPrepareReady(data = {}) {
  const sync = historySyncMetadata(data);
  // A lightweight prepare response is ready only when both proof fields are
  // explicit.  Missing fields are unknown, not an implicit success; this
  // prevents a malformed/legacy status payload from triggering a full read.
  if (sync.requested_range_complete !== true) return false;
  if (!["ready", "complete"].includes(String(sync.summary_status || "").toLowerCase())) return false;
  const historyRevision = Number(sync.history_revision);
  const summaryRevision = Number(sync.summary_revision);
  if (!Number.isSafeInteger(historyRevision)
    || !Number.isSafeInteger(summaryRevision)
    || historyRevision !== summaryRevision) return false;
  if (sync.clock_status && !["verified", "trusted", "observer_bootstrap"].includes(String(sync.clock_status).toLowerCase())) return false;
  return true;
}

function historyQueryIsCurrent(query) {
  return Boolean(query)
    && Number(state.historyQueryGeneration || 0) === Number(query.generation)
    && Number(_historyQueryGeneration) === Number(query.generation)
    && historyStableAccountKey() === query.accountKey
    && activeTabId() === "history";
}

function historyPrepareMessage(sync = {}) {
  if (sync.clock_status && !["verified", "trusted", "observer_bootstrap"].includes(String(sync.clock_status).toLowerCase())) {
    return "交易终端时间尚未校准，暂不能建立历史快照";
  }
  if (sync.summary_status && !["ready", "complete"].includes(String(sync.summary_status).toLowerCase())) {
    return "正在生成所选范围统计，请稍候…";
  }
  return "正在同步截至终端当前时间的平仓记录，请稍候…";
}

function renderHistorySyncStatus(message, { tone = "info", busy = true } = {}) {
  const host = $("historySyncStatus");
  if (host) {
    host.hidden = !message;
    host.dataset.tone = tone;
    host.textContent = message || "";
    host.setAttribute("aria-busy", String(Boolean(busy)));
  }
  const panel = $("history");
  if (panel) panel.setAttribute("aria-busy", String(Boolean(busy)));
  if (message && $("historyRangeHint")) setText("historyRangeHint", message);
}

function clearHistoryPresentation({ syncing = true } = {}) {
  if (_historyChart) { _historyChart.destroy(); _historyChart = null; }
  state.historyChartDaily = [];
  state.historyChartSelectedDate = "";
  state.historyChartFocusIndex = -1;
  state.historyNetResult = null;
  ["chartTotalTrades", "chartWinRate", "chartProfitFactor", "chartMaxDD",
    "historyProfit", "historyCredit", "historyDeposit", "historyWithdrawal", "historyNetResult"]
    .forEach(id => {
      setText(id, "--");
      const node = $(id);
      if (node) node.className = node.id.startsWith("chart") ? "chart-stat-value" : "num";
    });
  if ($("historyPager")) $("historyPager").innerHTML = "";
  setText("historyFilterCount", "");
  renderHistoryPreparationStatus(syncing ? "正在准备所选范围的交易记录…" : "");
  renderHistorySyncStatus(syncing ? "正在准备所选范围的交易记录…" : "", { busy:syncing });
}

function cancelHistoryPrepareRetry() {
  const retry = _historyPrepareRetry;
  if (!retry) return;
  retry.cancelled = true;
  if (retry.timer) clearTimeout(retry.timer);
  retry.resolve?.(false);
  _historyPrepareRetry = null;
}

function historyPrepareParams(query) {
  const scopeParams = { ...(query.scopeParams || {}) };
  if (!query.frozenRange) return scopeParams;
  // The first probe is scope-only.  Once the server returns a frozen range,
  // every lightweight retry carries the exact flattened boundaries (including
  // captured_end_utc_msc); this prevents a later retry from recapturing Date.now.
  return { ...scopeParams, ...historyQueryRangeParams(query) };
}

function historyQueryRangeParams(query = _historyQueryState) {
  const range = query?.frozenRange;
  if (!range) return {};
  return {
    range_start_utc_msc:Number(range.range_start_utc_msc),
    range_end_utc_msc:Number(range.range_end_utc_msc),
    allowed_start_utc_msc:Number(range.allowed_start_utc_msc),
    system_start_utc_msc:Number(range.system_start_utc_msc),
    effective_start_utc_msc:Number(range.effective_start_utc_msc),
    captured_end_utc_msc:Number(range.captured_end_utc_msc),
    ...(range.scope_start_override
      ? { scope_start_override:String(range.scope_start_override) }
      : {}),
  };
}

function seedHistoryFrozenRange(query) {
  const range = query?.frozenRange;
  if (!range) return false;
  _historyCursorState.rangeStart = Number(range.range_start_utc_msc);
  _historyCursorState.rangeEnd = Number(range.range_end_utc_msc);
  _historyCursorState.snapshotId = null;
  _historyCursorState.pageCursors = new Map([[1, null]]);
  _historyCursorState.preserveRangeOnKeyChange = true;
  return historyCursorRangeIsFixed(_historyCursorState);
}

function beginHistoryQuery(trigger = "enter") {
  cancelHistoryPrepareRetry();
  cancelHistoryRangeRetry();
  clearHistoryFreshnessRetry();
  cancelHistoryLegacySummaryRetry();
  const generation = ++_historyQueryGeneration;
  state.historyQueryGeneration = generation;
  let scopeParams;
  try { scopeParams = getHistoryRangeParams(); }
  catch (error) { throw error; }
  const query = {
    generation,
    trigger:String(trigger || "enter"),
    accountKey:historyStableAccountKey(),
    scopeParams,
    frozenRange:null,
    status:"preparing_time",
    sync:{},
    includeAccount:false,
    fullReadCount:0,
    legacyFallback:false,
    promise:null,
  };
  _historyQueryState = query;
  state.historyQueryState = query;
  state.historyRangeMeta = null;
  _historyCache = null;
  _historyChartCache = null;
  _historyDirty = false;
  _lastHistoryRevision = null;
  resetHistoryCursorState(null);
  clearHistoryPresentation({ syncing:true });
  updateHistoryRangeUI({ pending:true });
  renderHistorySyncStatus("正在确认当前终端时间并准备历史范围…", { busy:true });
  return query;
}

function historyPrepareWait(query, delay) {
  return new Promise(resolve => {
    const retry = { query, timer:null, cancelled:false, resolve };
    _historyPrepareRetry = retry;
    retry.timer = setTimeout(() => {
      if (_historyPrepareRetry === retry) _historyPrepareRetry = null;
      resolve(true);
    }, delay);
  });
}

async function runHistoryPrepare(query) {
  if (query.preparePromise) return query.preparePromise;
  query.preparePromise = (async () => {
    let attempt = 0;
    while (historyQueryIsCurrent(query)) {
      const data = await wsApi(HISTORY_PREPARE_ACTION, historyPrepareParams(query));
      if (!historyQueryIsCurrent(query)) return false;
      if (data?.status !== "success") {
        const error = new Error(data?.message || data?.error || data?.code || "历史范围准备失败");
        error.code = data?.code || data?.error_code || data?.error || null;
        error.data = data;
        throw error;
      }
      const frozen = historyPrepareRangeFromResponse(data);
      if (!frozen) {
        const error = new Error("历史范围元数据无效");
        error.code = "history_prepare_range_invalid";
        error.data = data;
        throw error;
      }
      if (query.frozenRange) {
        const previous = historyPrepareRangeFromResponse({ history_range:query.frozenRange });
        if (previous && (previous.range_start_utc_msc !== frozen.range_start_utc_msc
          || previous.range_end_utc_msc !== frozen.range_end_utc_msc
          || previous.captured_end_utc_msc !== frozen.captured_end_utc_msc)) {
          const error = new Error("历史范围在同步期间发生变化");
          error.code = "history_prepare_range_changed";
          throw error;
        }
      }
      query.frozenRange = frozen;
      query.sync = historySyncMetadata(data);
      state.historyRangeMeta = historyScopeMetaFromResponse(data);
      applyHistoryScopeResponse(data);
      if (historyPrepareReady(data)) {
        query.status = "loading_snapshot";
        seedHistoryFrozenRange(query);
        renderHistorySyncStatus("历史范围已同步，正在读取交易记录…", { busy:true });
        return true;
      }
      query.status = "syncing_tail";
      renderHistorySyncStatus(historyPrepareMessage(query.sync), { busy:true });
      const delay = HISTORY_PREPARE_RETRY_DELAYS_MS[Math.min(attempt, HISTORY_PREPARE_RETRY_DELAYS_MS.length - 1)];
      attempt += 1;
      if (!await historyPrepareWait(query, delay)) return false;
    }
    return false;
  })();
  query.preparePromise.catch(() => {}).finally(() => { query.preparePromise = null; });
  return query.preparePromise;
}

async function runHistoryLegacyFallback(query, options = {}) {
  query.legacyFallback = true;
  query.status = "loading_snapshot";
  query.fullReadCount += 1;
  renderHistorySyncStatus("当前桥接不支持轻量同步检查，正在读取历史记录…", { busy:true });
  const data = await loadHistoryViewsLegacy({
    // Entering the tab and changing a range should read the local Bridge
    // archive immediately. Only the explicit refresh action requests a
    // terminal refresh; otherwise MT4's compatibility fallback can block the
    // whole page while it replays an already persisted account history.
    forceRefresh:options.forceRefresh === true,
    includeAccount:options.includeAccount === true,
    manualRefresh:options.manualRefresh === true,
    disableRangeRetry:true,
    disableFreshnessRetry:true,
    skipPrepare:true,
  });
  if (historyQueryIsCurrent(query)) {
    const historyPending = data?.historyPending === true;
    const summaryPending = data?.summaryPending === true;
    const unavailable = historyPending || summaryPending;
    const autoSummaryRetry = summaryPending && !historyPending
      && normalizeBridgePlatform(state.bridgePlatform) === "mt4";
    query.status = unavailable ? "unavailable" : "ready";
    const message = historyPending
      ? "历史记录仍在准备中，请稍后手动刷新"
      : summaryPending
        ? autoSummaryRetry
          ? "交易记录已显示，范围统计仍在准备中，系统将自动重试"
          : "交易记录已显示，范围统计仍在准备中，请稍后点击刷新"
        : "历史记录已更新";
    renderHistorySyncStatus(message, { tone:unavailable ? "warning" : "success", busy:autoSummaryRetry });
    if (autoSummaryRetry) {
      scheduleHistoryLegacySummaryRetry(query);
    }
  }
  return data;
}

async function runHistoryQuery(query, options = {}) {
  if (query.promise) return query.promise;
  query.includeAccount = options.includeAccount === true;
  query.promise = (async () => {
    try {
      let prepared;
      try {
        prepared = await runHistoryPrepare(query);
      } catch (error) {
        if (historyErrorCode(error) === HISTORY_PREPARE_UNSUPPORTED_CODE) {
          return runHistoryLegacyFallback(query, options);
        }
        if (historyQueryIsCurrent(query)) {
          query.status = "unavailable";
          clearHistoryPresentation({ syncing:false });
          renderHistorySyncStatus(apiErrorMessage(error.code || error.message || "历史范围准备失败"), { tone:"danger", busy:false });
        }
        throw error;
      }
      if (!prepared || !historyQueryIsCurrent(query)) return null;
      let data;
      try {
        query.fullReadCount += 1;
        data = await loadHistoryViewsLegacy({
          forceRefresh:false,
          includeAccount:query.includeAccount,
          manualRefresh:false,
          disableRangeRetry:true,
          disableFreshnessRetry:true,
          skipPrepare:true,
        });
      } catch (error) {
        if (isHistoryCursorRangeIncomplete(error) && historyQueryIsCurrent(query)) {
          // The prepare contract is a point-in-time proof. If the terminal
          // invalidates that proof before the full read, stop after this one
          // bounded read and require an explicit refresh/new generation; do
          // not silently issue a second full history package.
          query.status = "unavailable";
          renderHistorySyncStatus("读取期间历史范围发生变化，请点击“刷新”重新获取。", { tone:"warning", busy:false });
        }
        throw error;
      }
      if (!historyQueryIsCurrent(query)) return null;
      query.status = data?.historyPending ? "unavailable" : "ready";
      renderHistorySyncStatus(data?.historyPending ? "历史记录仍在准备中，请点击刷新重试" : "历史记录已更新", { tone:data?.historyPending ? "warning" : "success", busy:false });
      return data;
    } catch (error) {
      if (historyQueryIsCurrent(query) && query.status !== "unavailable") {
        query.status = "unavailable";
        renderHistorySyncStatus(apiErrorMessage(error.code || error.message || "历史记录读取失败"), { tone:"danger", busy:false });
      }
      throw error;
    } finally {
      if (historyQueryIsCurrent(query)) query.promise = null;
    }
  })();
  return query.promise;
}

function historySummaryReadyForRequestedRange(sync = {}) {
  if (sync.summary_status && sync.summary_status !== "ready") return false;
  if (sync.requested_range_complete !== false) return true;
  // MT4 can only prove completion of the terminal-visible Account History.
  // Preserve that explicit source boundary without presenting a partial MT5
  // head snapshot as full-range statistics.
  return String(state.bridgePlatform || "").toLowerCase() === "mt4"
    && sync.terminal_visible_history_complete === true;
}

function historyCursorRangeIsFixed(cursor = _historyCursorState) {
  return Number.isSafeInteger(cursor?.rangeStart)
    && Number.isSafeInteger(cursor?.rangeEnd)
    && cursor.rangeStart > 0
    && cursor.rangeStart < cursor.rangeEnd;
}

function resetHistorySnapshotState({ preserveRange = true } = {}) {
  const previous = _historyCursorState || {};
  _historyCache = null;
  _historyChartCache = null;
  _historyCursorState = {
    key:preserveRange ? previous.key : null,
    snapshotId:null,
    rangeStart:preserveRange && historyCursorRangeIsFixed(previous) ? previous.rangeStart : null,
    rangeEnd:preserveRange && historyCursorRangeIsFixed(previous) ? previous.rangeEnd : null,
    pageCursors:new Map([[1, null]]),
    preserveRangeOnKeyChange:false,
  };
  if (state.historyFilters) state.historyFilters.page = 1;
}

function markHistoryDirty({ refreshActive = false } = {}) {
  _historyDirty = true;
  // A new close/history revision may extend the visible endpoint.  Reset the
  // whole cursor so the next active-view refresh performs one explicit forced
  // terminal sync and captures a new range that includes the new trade.
  resetHistoryCursorState(null);
  if (!refreshActive || activeTabId() !== "history") return;
  clearHistoryFreshnessRetry();
  _historyFreshnessRetry = {
    attempt:0,
    contextKey:historyRetryContextKey(),
    timer:setTimeout(() => {
      if (activeTabId() !== "history") return;
      loadHistoryViews({ forceRefresh:true }).catch(() => {});
    }, HISTORY_FRESHNESS_RETRY_DELAYS_MS[0]),
  };
}

function scheduleHistoryFreshnessRetry(data) {
  const sync = historySyncMetadata(data);
  const freshnessPending = ['refreshing', 'stale'].includes(String(sync.freshness_state || ''));
  const summaryPending = ['pending', 'rebuilding'].includes(String(sync.summary_status || ''));
  const rangePending = sync.requested_range_complete === false;
  if (!freshnessPending && !summaryPending && !rangePending) {
    clearHistoryFreshnessRetry();
    return;
  }
  if (activeTabId() !== "history") return;
  const contextKey = historyRetryContextKey();
  let retry = _historyFreshnessRetry;
  if (!retry || retry.contextKey !== contextKey) {
    clearHistoryFreshnessRetry();
    retry = { attempt:0, contextKey, timer:null };
    _historyFreshnessRetry = retry;
  }
  if (retry.attempt >= HISTORY_FRESHNESS_RETRY_MAX_ATTEMPTS) return;
  if (retry.timer) return;
  const delay = HISTORY_FRESHNESS_RETRY_DELAYS_MS[
    Math.min(retry.attempt, HISTORY_FRESHNESS_RETRY_DELAYS_MS.length - 1)
  ];
  retry.timer = setTimeout(async () => {
    retry.timer = null;
    if (_historyFreshnessRetry !== retry || activeTabId() !== "history"
      || retry.contextKey !== historyRetryContextKey()) return;
    retry.attempt += 1;
    try {
      await loadHistoryViews({ forceRefresh:false, historyRetryAttempt:true });
    } catch {}
  }, delay);
}

async function handleBridgeReconnected(msg = {}) {
  if (msg.platform) updateBridgePlatformUI(msg.platform);
  // A transport reconnect with the same terminal/account identity does not
  // invalidate history cursors or account-scoped caches.  Refresh only the
  // lightweight live state needed to paint the recovered connection.
  _historyCircuitBreakers.clear();
  _historyErrorNotices.clear();
  await Promise.allSettled([
    loadStatus(), loadAccount(), loadPositions(), loadPendingOrders(), refreshQuote(),
  ]);
}

async function handleAccountTransferred(msg = {}) {
  if (msg.platform) updateBridgePlatformUI(msg.platform);
  state._accountContextGeneration = Number(state._accountContextGeneration || 0) + 1;
  clearAccountContextCaches();
  state.autoEnabled = false;
  toast(`此 ${bridgePlatformLabel(msg.platform || state.bridgePlatform)} 账户已由另一个平台账号重新连接，当前账号的自动分析和交易发送已关闭`, "warning");
  await Promise.allSettled([loadStatus(), loadStrategyCatalog(), refreshTabData(activeTabId())]);
}

function signalManagementTaskAffects(signal, task = {}) {
  if (!signal?.id || !task?.id) return false;
  const actions = Array.isArray(signal.management_actions)
    ? signal.management_actions : (Array.isArray(signal.position_management_actions) ? signal.position_management_actions : []);
  if (actions.some(action => Number(action?.task_id) === Number(task.id))) return true;
  return [task.decision_signal_id, task.origin_signal_id]
    .some(id => id != null && sameSignalId(id, signal.id));
}

function scheduleSignalManagementRefresh(task = {}) {
  const candidates = [state.selectedSignal, state.dashboardSignal].filter(Boolean);
  const signalIds = [...new Set(candidates
    .filter(signal => signalManagementTaskAffects(signal, task))
    .map(signal => String(signal.id)))];
  if (!signalIds.length) return;
  if (state.signalManagementRealtimeTimer) clearTimeout(state.signalManagementRealtimeTimer);
  state.signalManagementRealtimeTimer = setTimeout(() => {
    state.signalManagementRealtimeTimer = null;
    const selectedId = String(state.selectedSignal?.id || "");
    const selectedRefresh = signalIds.includes(selectedId);
    if (selectedRefresh) {
      openAnalysisFromHistory(state.selectedSignal.id, {
        navigate:false, forceRefresh:true, preserveSelectionMode:true,
      }).catch(() => {});
    }
    for (const signalId of signalIds) {
      const dashboard = state.dashboardSignal;
      if (dashboard && String(dashboard.id) === signalId) {
        loadDashboardSignal(dashboard.id, null, { forceRefresh:true }).catch(() => {});
      }
    }
  }, 180);
}

// Real-time bridge status via WebSocket + command channel


function connectBridgeStatusWs(onReady) {
  if (state.bridgeWs && state.bridgeWs.readyState <= 1) {
    if (typeof onReady === 'function') onReady();
    return;
  }
  window.AuthSession?.syncCookie();
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const url = `${proto}//${location.host}/aurum-api/bridge/ws?type=browser`;
  const ws = new WebSocket(url);
  state.bridgeWs = ws;
  let _readyFired = false;
  const _fireReady = () => { if (!_readyFired && typeof onReady === 'function') { _readyFired = true; onReady(); } };
  const sendHeartbeat = () => {
    if (ws.readyState !== WebSocket.OPEN) return;
    try {
      ws.send(JSON.stringify({ type:'hb', seq:++state._hbSeq, observer_channel_id:state.selectedObserverChannelId || null }));
    } catch {}
  };
  ws.onopen = () => {
    const wasNotificationWsReady = state.notificationWsReady;
    state.notificationWsReady = true;
    state._reconnectAttempts = 0; // reset backoff on successful connection

    state._hbSeq = 0;
    if (state._hbTimer) clearInterval(state._hbTimer);
    sendHeartbeat();
    state._hbTimer = setInterval(sendHeartbeat, 30000);
    if (wasNotificationWsReady) void refreshNotificationSummary();
    _fireReady();
  };
  ws.onmessage = (e) => {
    try {
      const msg = JSON.parse(e.data);
      if (msg.type === 'notification_created') {
        handleNotificationCreated(msg);
      } else if (msg.type === 'platform_market_tick') {
        const quote = msg.quote || {};
        if (isObserverMode()) syncTerminalTimezoneOffset(quote);
        const selected = String($("quoteSymbolSelect")?.value || $("tradeSymbolSelect")?.value || getGlobalSymbol()).toUpperCase();
        const brokerSymbol = String(quote.symbol || '').toUpperCase();
        if (brokerSymbol && standardMarketSymbol(brokerSymbol) === standardMarketSymbol(selected) &&
            Number.isFinite(Number(quote.bid)) && Number.isFinite(Number(quote.ask))) {
          state.platformMarketSourceActive = true;
          renderPlatformMarketMeta(quote);
          if (isObserverMode()) {
            const previousQuote = state.lastObserverQuote && state.lastObserverQuote.symbol === brokerSymbol
              ? state.lastObserverQuote : null;
            const bidDirection = previousQuote
              ? Number(quote.bid) > previousQuote.bid ? "up" : Number(quote.bid) < previousQuote.bid ? "down" : ""
              : "";
            const askDirection = previousQuote
              ? Number(quote.ask) > previousQuote.ask ? "up" : Number(quote.ask) < previousQuote.ask ? "down" : ""
              : "";
            setText("quoteBid", priceDisplay(quote.bid));
            setText("quoteAsk", priceDisplay(quote.ask));
            setQuoteDirection("quoteBidDir", bidDirection);
            setQuoteDirection("quoteAskDir", askDirection);
            flashPrice("quoteBid", bidDirection);
            flashPrice("quoteAsk", askDirection);
            state.lastObserverQuote = {
              symbol:brokerSymbol,
              bid:Number(quote.bid),
              ask:Number(quote.ask),
              spread:Number(quote.spread),
              time:quote.time,
            };
            updateTradingQuotePreview(state.lastObserverQuote);
          }
          updateKlineTick(Number(quote.bid), Number(quote.ask), quote);
          updateSignalPriceFields(state.selectedSignal);
        }
        if (isObserverMode()) _maybeRefreshSignal();
      } else if (msg.type === 'data') {
        handleBridgeData(msg);
      } else if (msg.type === 'bridge_data_changed') {
        scheduleBridgeDataRefresh(msg);
      } else if (msg.type === 'hb') {
        handleHeartbeat(msg);
      } else if (msg.type === 'disconnect') {
        handleDisconnect(msg);
      } else if (msg.type === 'bridge_reconnected') {
        handleBridgeReconnected(msg).catch(error => console.warn('[BridgeReconnect] 状态刷新失败:', error.message));
      } else if (msg.type === 'account_switched') {
        handleAccountSwitched(msg).catch(error => console.warn('[AccountSwitch] 刷新失败:', error.message));
      } else if (msg.type === 'account_transferred') {
        handleAccountTransferred(msg).catch(error => console.warn('[AccountTransfer] 刷新失败:', error.message));
      } else if (msg.type === 'position_protection_job_updated') {
        handlePositionProtectionJobUpdate(msg.job);
      } else if (msg.type === 'position_protection_target_updated') {
        handlePositionProtectionTargetUpdate(msg.job_id, msg.target);
      } else if (msg.type === 'auto_state') {
        state.autoEnabled = !!msg.enabled;
        if (!msg.enabled) {
          state.autoProgressCycles = {};
          state.autoProgressFlash = null;
          state.autoProgressVisual = {};
        }
        if (msg.reason === 'user_bridge_offline') {
          if (msg.enabled) {
            toast(`${bridgePlatformLabel()} 桥接断开，等待连接后自动恢复订阅`, 'warning');
          } else {
            toast(`${bridgePlatformLabel()} 桥接断开`, 'warning');
          }
        }
        // Update runtime state with enabled info
        if (state.autoRuntime) {
          state.autoRuntime.enabled = msg.enabled;
          state.autoRuntime.runtime_subscribed = msg.runtime_subscribed;
        }
        renderAutoAnalyzeBadge(state.autoRuntime || { enabled: msg.enabled });
        loadStatus().catch(() => {});
      } else if (msg.type === 'auto_progress_done') {
        const completedCycle = msg.cycle_id ? state.autoProgressCycles[msg.cycle_id] : null;
        if (msg.cycle_id) delete state.autoProgressCycles[msg.cycle_id];
        const remainingCycles = Object.values(state.autoProgressCycles);
        state.autoProgressFlash = remainingCycles.length ? null : {
          status: msg.status,
          reason: msg.reason || '',
          symbol: msg.symbol || '',
          cycle_id: msg.cycle_id || completedCycle?.cycle_id || '',
          progress_percent: msg.progress_percent || 0,
          expiresAt: Date.now() + (msg.status === 'success' ? 2800 : 3200),
        };
        if (state.autoRuntime) {
          state.autoRuntime.active_cycles = remainingCycles;
          state.autoRuntime.in_flight = remainingCycles.length > 0;
          state.autoRuntime.stage = remainingCycles.length ? 'running' : 'idle';
          state.autoRuntime.stage_label = remainingCycles[0]?.stage_label || '';
          if (!remainingCycles.length && (msg.status === 'blocked' || msg.status === 'error')) {
            state.autoRuntime.paused_reason = msg.reason || '';
          } else if (!remainingCycles.length) {
            state.autoRuntime.paused_reason = '';
          }
        }
        renderAutoAnalyzeBadge(state.autoRuntime || { enabled: true });
        window.setTimeout(() => {
          if (msg.cycle_id) delete state.autoProgressVisual[msg.cycle_id];
          if (state.autoProgressFlash?.expiresAt <= Date.now()) state.autoProgressFlash = null;
          loadStatus().catch(error => console.warn('[AutoProgress] 状态刷新失败:', error.message));
        }, msg.status === 'success' ? 2900 : 3300);
      } else if (msg.type === 'auto_progress') {
        const cycleId = msg.cycle_id || `${msg.prompt_type_id || 0}:${msg.symbol || 'unknown'}:running`;
        const existing = state.autoProgressCycles[cycleId];
        if (!existing || Number(msg.seq || 0) > Number(existing.progress_seq || 0)) {
          for (const [id, cycle] of Object.entries(state.autoProgressCycles)) {
            if (id !== cycleId && cycle.prompt_type_id === msg.prompt_type_id && cycle.symbol === msg.symbol) delete state.autoProgressCycles[id];
          }
          state.autoProgressCycles[cycleId] = {
            cycle_id: cycleId,
            prompt_type_id: msg.prompt_type_id,
            symbol: msg.symbol || '',
            stage: msg.stage || 'running',
            stage_label: msg.label || '推理中',
            progress_percent: Number(msg.progress_percent || 0),
            progress_seq: Number(msg.seq || 0),
            started_at: msg.started_at || new Date().toISOString(),
            stage_updated_at: msg.stage_updated_at || (existing?.stage === msg.stage ? existing.stage_updated_at : new Date().toISOString()),
          };
        }
        state.autoProgressFlash = null;
        if (!state.autoRuntime) state.autoRuntime = { enabled: true, selected_symbols: [] };
        state.autoRuntime.in_flight = true;
        state.autoRuntime.stage = msg.stage || 'running';
        state.autoRuntime.stage_label = msg.label || '推理中';
        state.autoRuntime.progress_percent = Number(msg.progress_percent || 0);
        state.autoRuntime.active_cycles = Object.values(state.autoProgressCycles);
        renderAutoAnalyzeBadge(state.autoRuntime);
      } else if (msg.type === 'new_signal') {
        // New signal pushed — refresh status and signal list
        handleNewSignal(msg);
        loadStatus().catch(() => {});
      } else if (msg.type === 'signal_execution_updated') {
        // Execution can complete after the signal itself was pushed. Reload the
        // same signal so pending/executed state disables duplicate submission.
        const isAnalyst = activeTabId() === "ai-analyze";
        const refreshOptions = isAnalyst
          ? { skipResultRender:true, loadDashboard:false }
          : { limit:1, summaryOnly:true, skipResultRender:true };
        loadSignals(refreshOptions).then(() => {
          if (isAnalyst && sameSignalId(state.selectedSignal?.id, msg.signal_id)) {
            return openAnalysisFromHistory(msg.signal_id, { navigate:false, forceRefresh:true, preserveSelectionMode:true });
          }
        }).catch(() => {});
      } else if (msg.type === 'weekly_flatten_state') {
        const noticeKey = `${msg.cycle || ''}:${msg.status || ''}:${msg.reason || ''}`;
        if (state._weeklyFlattenNoticeKey !== noticeKey) {
          state._weeklyFlattenNoticeKey = noticeKey;
          if (msg.status === 'running') {
            toast(`周末风险控制已启动：正在撤销系统挂单并平仓（持仓 ${msg.position_count || 0}，挂单 ${msg.pending_count || 0}）`, 'warning');
          } else if (msg.status === 'completed') {
            toast('周末风险控制已完成：系统持仓和挂单均已清理', 'success');
          } else if (msg.status === 'retrying') {
            toast('周末风险控制尚未完成，系统将在05:00前继续重试', 'warning');
          } else if (msg.status === 'failed') {
            const reason = msg.reason === 'unsupported_netting'
              ? '当前为净持仓账户，无法安全区分系统仓与手工仓'
              : msg.reason === 'deadline_reached'
                ? '05:00任务已结束，仍有未完成项'
                : '自动清仓失败';
            toast(`周末风险控制异常：${reason}`, 'error');
          }
        }
      } else if (msg.type === 'position_management_task_updated' || msg.type === 'position_management_settings_updated') {
        const live = $("positionManagementLive");
        if (live) {
          live.classList.add("live");
          live.innerHTML = `<i></i>刚刚实时更新`;
        }
        if (state.positionManagementRealtimeTimer) clearTimeout(state.positionManagementRealtimeTimer);
        state.positionManagementRealtimeTimer = setTimeout(() => {
          state.positionManagementRealtimeTimer = null;
          const managementVisible = activeTabId() === "trading"
            && document.querySelector('[data-workspace-tab="trading"].active')?.dataset.workspaceTarget === "management";
          if (managementVisible) loadPositionManagement({ quiet:true, preserveSelection:true }).catch(() => {});
        }, 180);
        if (msg.type === 'position_management_task_updated') scheduleSignalManagementRefresh(msg.task || {});
      } else if (msg.type === 'result' && msg.command_id) {
        const pending = _wsPending.get(msg.command_id);
        if (pending) {
          clearTimeout(pending.timer);
          _wsPending.delete(msg.command_id);
          if (msg.status === 'error') {
            const code = msg.code || msg.error_code || msg.message;
            const error = new Error(apiErrorMessage(msg.message || msg.error || code || '操作失败'));
            error.code = code;
            error.history_range = msg.history_range || msg.details?.history_range || null;
            error.details = msg.details || null;
            pending.reject(error);
          } else pending.resolve(msg);
        }
      }
    } catch (e) { console.error('[WS] message handler error:', e) }
  };
  ws.onclose = (e) => {
    if (state._hbTimer) { clearInterval(state._hbTimer); state._hbTimer = null; }
    if (state.bridgeWs === ws) state.bridgeWs = null;
    stopLiveQuoteRefreshTimer();
    for (const [id, p] of _wsPending) {
      clearTimeout(p.timer);
      const error = new Error(apiErrorMessage('browser_websocket_disconnected'));
      error.code = 'browser_websocket_disconnected';
      p.reject(error);
    }
    _wsPending.clear();
    _fireReady(); // ensure bootstrap() doesn't hang when WS fails to connect
    // Auth failure (server closed with 4002) -> don't retry
    if (e.code === 4002) { invalidateSession(); return; }
    if (_sessionInvalidating) return;
    // Prevent duplicate reconnect timers
    if (state._reconnectTimer) clearTimeout(state._reconnectTimer);
    setBadge("gatewayMode", "WebSocket断开-重连中...", "neutral");
    if (state.token) {
      state._reconnectAttempts = (state._reconnectAttempts || 0) + 1;
      // Exponential backoff: 3s → 6s → 12s → ... max 30s, with ±20% jitter
      const delay = Math.min(3000 * Math.pow(2, state._reconnectAttempts - 1), 30000);
      const jitter = delay * (0.8 + Math.random() * 0.4); // 80%-120% of delay
      state._reconnectTimer = setTimeout(() => {
        state._reconnectTimer = null;
        connectBridgeStatusWs();
      }, jitter);
    }
  };
  ws.onerror = () => { _fireReady(); };
}

// Market status display helper
function updateMarketStatus(tradeMode) {
  const dot = document.getElementById('marketStatusDot');
  const text = document.getElementById('marketStatusText');
  if (!dot || !text) return;
  state.marketTradeMode = tradeMode;
  if (tradeMode === -2) {
    dot.className = 'market-dot market-dot-closeonly';
    text.className = 'market-status-text market-status-text-closeonly';
    text.textContent = '行情停滞';
    setBadge('marketStatus', '行情停滞', 'warning');
    const b = document.getElementById('marketStatus');
    if (b) b.title = `市场状态：${bridgePlatformLabel()} 报价暂未更新，系统不会按开市处理`;
    return;
  }
  if (tradeMode < 0) {
    dot.className = 'market-dot market-dot-unknown';
    text.className = 'market-status-text market-status-text-unknown';
    text.textContent = '检测中';
    setBadge('marketStatus', '检测中', 'neutral');
    const b = document.getElementById('marketStatus');
    if (b) b.title = '市场状态：正在检测市场状态';
    return;
  }
  const map = {
    0: ['closed', '休市', 'neutral', '休市 - 该品种已收盘，自动分析已暂停'],
    1: ['closeonly', '仅做多', 'warning', '仅做多 - 当前品种限制为空单不可新开'],
    2: ['closeonly', '仅做空', 'warning', '仅做空 - 当前品种限制为多单不可新开'],
    3: ['closeonly', '仅平仓', 'warning', '仅平仓 - 当前品种不允许新开仓位'],
    4: ['open', '交易中', 'active', '交易中 - 市场正常开放，可双向交易'],
  };
  const [cls, label, badgeType, tip] = map[tradeMode] || ['unknown', '未知', 'neutral', '未知状态'];
  dot.className = 'market-dot market-dot-' + cls;
  text.className = 'market-status-text market-status-text-' + cls;
  text.textContent = label;
  setBadge('marketStatus', label, badgeType);
  const badge = document.getElementById('marketStatus');
  if (badge) badge.title = '\u5E02\u573A\u72B6\u6001\uFF1A' + tip;
}

function updateMarketStatusFromQuote(quote) {
  const explicitState = String(quote?.market_state || '').toLowerCase();
  if (explicitState === 'open') return updateMarketStatus(4);
  if (explicitState === 'closed') return updateMarketStatus(0);
  if (explicitState === 'stale') return updateMarketStatus(-2);
  if (explicitState === 'restricted') {
    const restrictedMode = Number(quote?.symbol_trade_mode);
    return updateMarketStatus([1, 2, 3].includes(restrictedMode) ? restrictedMode : 3);
  }
  const rawTradeMode = quote?.symbol_trade_mode;
  if (rawTradeMode === null || rawTradeMode === undefined || rawTradeMode === '') return;
  const symbolTradeMode = Number(rawTradeMode);
  if (Number.isInteger(symbolTradeMode) && symbolTradeMode >= 0 && symbolTradeMode <= 4) {
    updateMarketStatus(symbolTradeMode);
  }
}

function renderQuoteStatusMeta(quote) {
  setText('quoteSpread', Number.isFinite(Number(quote?.spread)) ? fmt(quote.spread, 2) : '--');
  syncTerminalTimezoneOffset(quote);
  const quoteTime = formatTerminalQuoteTime(quote);
  setText('quoteTime', quoteTime);
  setText('mt5ServerTime', quoteTime === '--' ? '--' : quoteTime.split(' ').pop() || '--');
  updateMarketStatusFromQuote(quote);
}

function renderPlatformMarketMeta(quote) {
  if (isObserverMode()) {
    renderQuoteStatusMeta(quote);
    return;
  }
  const quoteTime = formatTerminalQuoteTime(quote);
  setText('quoteTime', quoteTime);
  setText('mt5ServerTime', quoteTime === '--' ? '--' : quoteTime.split(' ').pop() || '--');
  updateMarketStatusFromQuote(quote);
}

// Handle data push from bridge (account + quote + positions)
function handleBridgeData(msg) {
  // Server-detected market status — update in real-time
  const prevMode = state.marketTradeMode;
  if (typeof msg.trade_mode === 'number') updateMarketStatus(msg.trade_mode);
  // Market status changed → refresh auto badge (e.g. market opened/closed)
  if (prevMode !== state.marketTradeMode && state.autoEnabled) {
    loadStatus().catch(() => {});
  }
  const selectedSymbol = $("quoteSymbolSelect")?.value || $("tradeSymbolSelect")?.value || "XAUUSD";
  // Detect position close → invalidate history cache
  const currPosCount = (msg.positions || []).length;
  if (currPosCount < _prevPositionCount && _prevPositionCount > 0) {
    // The position snapshot can change before the terminal exposes the
    // corresponding deal/order history. Mark the view dirty now, but wait for
    // the Bridge freshness/revision proof instead of creating a stale history
    // snapshot immediately.
    markHistoryDirty({ refreshActive:true });
  }
  _prevPositionCount = currPosCount;

  if (msg.quote) {
    const q = msg.quote;
    syncTerminalTimezoneOffset(q);
    // Only update quote display if the pushed symbol matches the selected symbol
    if (q.symbol && q.symbol === selectedSymbol) {
      const prev = state.lastQuote && state.lastQuote.symbol === q.symbol ? state.lastQuote : null;
      let bidDir = "", askDir = "";
      if (prev) {
        if (Number(q.bid) > prev.bid) bidDir = "up";
        if (Number(q.bid) < prev.bid) bidDir = "down";
        if (Number(q.ask) > prev.ask) askDir = "up";
        if (Number(q.ask) < prev.ask) askDir = "down";
      }
      setText("quoteBid", priceDisplay(q.bid));
      setText("quoteAsk", priceDisplay(q.ask));
      renderQuoteStatusMeta(q);
      setQuoteDirection("quoteBidDir", bidDir);
      setQuoteDirection("quoteAskDir", askDir);
      flashPrice("quoteBid", bidDir);
      flashPrice("quoteAsk", askDir);
      if (Number.isFinite(Number(q.bid)) && Number.isFinite(Number(q.ask))) {
        state.lastQuote = { symbol: q.symbol, bid: Number(q.bid), ask: Number(q.ask), spread: Number(q.spread), time: q.time };
        updateTradingQuotePreview(state.lastQuote);
        updateKlineTick(q.bid, q.ask, q);
      }

    }
  }
  if (msg.account) {
    if (msg.account.server && msg.account.login != null) {
      if (typeof setHistoryAccountIdentity === "function") setHistoryAccountIdentity({
          platform:msg.platform || state.bridgePlatform,
          brokerServerKey: String(msg.account.server).trim().toUpperCase(),
          loginAccount: String(msg.account.login).trim(),
        });
    }
    setText("accountBalance", fmt(msg.account.balance));
    setText("accountEquity", fmt(msg.account.equity));
    setText("accountMargin", fmt(msg.account.margin));
    setText("accountMarginFree", fmt(msg.account.free_margin));
    setText("accountFloatPnl", fmt(msg.account.profit));
    if (msg.account.leverage) setText("accountLeverage", msg.account.leverage);
    setText("tradeAccountBalance", fmt(msg.account.balance));
    setText("tradeAccountEquity", fmt(msg.account.equity));
    setText("tradeAccountProfit", fmt(msg.account.profit));
    setText("tradeAccountFreeMargin", fmt(msg.account.free_margin));
    updatePnlStyle("accountFloatPnl", msg.account.profit);
    updatePnlStyle("tradeAccountProfit", msg.account.profit);
  }
  if (msg.positions) {
    const newTickets = new Set(msg.positions.map(p => String(p.ticket)));
    // Remove rows for positions that no longer exist (closed)
    const existingRows = document.querySelectorAll('#positionsBody tr[data-ticket]');
    for (const row of existingRows) {
      if (!newTickets.has(row.dataset.ticket)) {
        row.classList.add('fade-out');
        setTimeout(() => row.remove(), 300);
        // Account/positions can refresh immediately. History is refreshed by
        // the bounded freshness retry started above after the Archive worker
        // has had a chance to persist the close evidence.
        clearTimeout(state._posRefreshTimer);
        state._posRefreshTimer = setTimeout(() => {
          loadPositions();
          loadAccount();
        }, 500);
      }
    }
    // A bridge push normally contains the complete position snapshot. Patch
    // live fields in both tables when the structure is unchanged; rebuild the
    // shared rows when a position opens, closes, or changes shape.
    const patched = patchPositionLiveCells(msg.positions);
    state.positions = msg.positions;
    if (!patched) renderPositionTables(msg.positions);
  }
  _maybeRefreshSignal();
}

const BRIDGE_DATA_REFRESH_DELAY_MS = 250;
let _bridgeDataRefreshTimer = null;
let _bridgeDataRefreshInFlight = false;
const _bridgeDataRefreshStreams = new Set();

function scheduleBridgeDataRefresh(msg = {}) {
  for (const stream of Array.isArray(msg.streams) ? msg.streams : []) {
    if (stream === 'history') {
      const revision = Number(msg.history_revision ?? msg.revision);
      if (Number.isSafeInteger(revision) && revision > 0) {
        if (Number.isSafeInteger(_lastHistoryRevision) && revision <= _lastHistoryRevision) continue;
        _lastHistoryRevision = revision;
      }
    }
    if (stream === 'account' || stream === 'positions' || stream === 'history') {
      _bridgeDataRefreshStreams.add(stream);
    }
  }
  if (!_bridgeDataRefreshStreams.size || document.hidden
      || _bridgeDataRefreshTimer || _bridgeDataRefreshInFlight) return;
  _bridgeDataRefreshTimer = setTimeout(() => {
    _bridgeDataRefreshTimer = null;
    void flushBridgeDataRefresh();
  }, BRIDGE_DATA_REFRESH_DELAY_MS);
}

async function flushBridgeDataRefresh() {
  if (_bridgeDataRefreshInFlight || document.hidden || !_bridgeDataRefreshStreams.size) return;
  _bridgeDataRefreshInFlight = true;
  const streams = new Set(_bridgeDataRefreshStreams);
  _bridgeDataRefreshStreams.clear();
  try {
    const refreshes = [];
    if (streams.has('account')) refreshes.push(loadAccount());
    if (streams.has('positions')) refreshes.push(loadPositions({ refreshSignalTickets:false, liveOnly:true }));
    if (streams.has('history')) markHistoryDirty({ refreshActive:true });
    await Promise.allSettled(refreshes);
  } finally {
    _bridgeDataRefreshInFlight = false;
    if (_bridgeDataRefreshStreams.size) scheduleBridgeDataRefresh();
  }
}

let _lastSignalRefreshTs = 0;
let _lastSignalId = null;

function sameSignalId(left, right) {
  return left != null && right != null && String(left) === String(right);
}

function setAnalysisSelectionIntent(signalId, options = {}) {
  const source = options.source || "inference-list";
  const forcePinned = options.forcePinned === true || ["history", "ticket", "trade"].includes(source);
  const forceFollow = options.followLatest === true || ["auto-follow", "notification"].includes(source);
  const isLatest = sameSignalId(signalId, state.latestSignalId ?? _lastSignalId);
  state.analysisSelectionMode = forcePinned ? "pinned" : (forceFollow || isLatest ? "follow_latest" : "pinned");
  state.analysisSelectionSource = source;
}

function shouldAutoFollowNewSignal(previousLatestId) {
  if (activeTabId() !== "ai-analyze" || state.analysisSelectionMode !== "follow_latest") return false;
  const selectedId = state.selectedSignal?.id;
  if (selectedId == null && previousLatestId == null) return true;
  return sameSignalId(selectedId, previousLatestId);
}

async function refreshForNewSignal(signalId, signalMeta = null) {
  const previousLatestId = state.latestSignalId ?? _lastSignalId;
  if (sameSignalId(signalId, previousLatestId)) return;
  const autoFollow = shouldAutoFollowNewSignal(previousLatestId);
  const isAnalyst = activeTabId() === "ai-analyze";

  state.latestSignalId = signalId;
  _lastSignalId = signalId;
  const refreshedSignals = await loadSignals(isAnalyst
    ? { skipResultRender:true, loadDashboard:false }
    : activeTabId() === "dashboard"
      ? { limit:1, summaryOnly:true, skipResultRender:true, announceDashboardSignal:true }
      : { limit:1, summaryOnly:true, skipResultRender:true });

  const incoming = (refreshedSignals || []).find(item => sameSignalId(item.id, signalId))
    || state.signals.find(item => sameSignalId(item.id, signalId))
    || signalMeta;
  if (incoming) showSignalNotification(incoming);
  if (!autoFollow || !incoming) {
    highlightActiveAnalysis(state.selectedSignal?.id);
    return;
  }

  setAnalysisSelectionIntent(signalId, { source:"auto-follow", followLatest:true });
  await openAnalysisFromHistory(signalId, { navigate:false, source:"auto-follow", followLatest:true });
  const activeItem = document.querySelector(`[data-analysis-id="${CSS.escape(String(signalId))}"]`);
  if (activeItem) activeItem.scrollIntoView({ behavior:"smooth", block:"nearest" });
}

// UI-only timer: refresh signal timing displays every second (no network calls)
let _statusRefreshCounter = 0;
let _uiTimerInterval = null;

function startUiTimer() {
  if (_uiTimerInterval) return;
  _uiTimerInterval = setInterval(() => {
    const dashboardSignal = state.dashboardSignal;
    if (dashboardSignal) {
      setText("sigValidWindow", signalFreshness(dashboardSignal));
      setSignalBadge(dashboardSignal);
      const stale = signalIsStale(dashboardSignal) && !dashboardSignal.is_executed;
      const signalCard = $("signalCard");
      if (stale && signalCard?.dataset.status !== "expired") {
        signalCard.dataset.status = "expired";
        updateSignalPriceFields(dashboardSignal);
      }
    }
    const selectedSignal = state.selectedSignal;
    if (selectedSignal) {
      setText("signalFreshness", signalFreshness(selectedSignal));
      setText("analysisValidity", signalFreshness(selectedSignal));
      const stale = signalIsStale(selectedSignal) && !selectedSignal.is_executed;
      const btn = $("executeSignalBtn");
      if (btn && stale) btn.disabled = true;
    }
    // Render auto badge with local countdown
    if (state.autoRuntime && state.autoRuntime.enabled) {
      renderAutoAnalyzeBadge(state.autoRuntime);
    }
    if (++_statusRefreshCounter >= 15) {
      _statusRefreshCounter = 0;
      if (state.token) loadStatus().catch(() => {});
    }
  }, 1000);
}

function stopUiTimer() {
  if (_uiTimerInterval) { clearInterval(_uiTimerInterval); _uiTimerInterval = null; }
}

document.addEventListener("visibilitychange", () => {
  if (document.hidden) {
    stopUiTimer();
    stopLiveQuoteRefreshTimer();
    stopKlineRefreshTimers();
  } else {
    void refreshNotificationSummary();
    startUiTimer();
    startLiveQuoteRefreshTimer();
    scheduleBridgeDataRefresh();
    resumeManualTradeReviewPolling();
    if (activeTabId() === "dashboard") {
      loadKlineData().catch(() => {});
      startKlineRefreshTimer();
      startKlineVolumeRefreshTimer();
    }
  }
});

startUiTimer();

async function _maybeRefreshSignal() {
  const now = Date.now();
  if (now - _lastSignalRefreshTs < 5000) return;
  _lastSignalRefreshTs = now;
  try {
    // Lightweight check: only fetch latest signal's ID + minimal fields (~200 bytes)
    const data = await wsApi("signals_latest_id", {});
    const latest = data.signal || null;

    if (!latest) {
      if (_lastSignalId !== null) { updateSignalDisplay(null); _lastSignalId = null; state.latestSignalId = null; state.signals = []; renderAnalysisHistory([]); renderSignalRows(); }
      return;
    }

    // ID unchanged — UI timer handles timing display, nothing to do
    if (sameSignalId(latest.id, state.latestSignalId ?? _lastSignalId)) return;

    // New signal detected — reuse the known-good click handler
    // CLOSE signal → invalidate history cache (new closed order)
    if (latest.signal_type === 'close') {
      _historyCache = null;
      _historyChartCache = null;
    }

    await refreshForNewSignal(latest.id, latest);
  } catch (e) { console.error('[Inference] latest signal refresh failed:', e); }
}

// Handle new signal pushed from server (replaces polling)
async function handleNewSignal(msg) {
  try {
    if (msg.signal_id == null) return;
    await refreshForNewSignal(msg.signal_id, msg.signal || null);
  } catch (e) { console.error('[Inference] pushed signal refresh failed:', e); }
}

let _dashboardSignalRequestVersion = 0;
let _signalMonitorUpdateTimer = null;

async function loadDashboardSignal(signalId, fallbackSignal = null, options = {}) {
  const requestVersion = ++_dashboardSignalRequestVersion;
  if (signalId == null) {
    updateSignalDisplay(null);
    return;
  }

  const current = sameSignalId(state.dashboardSignal?.id, signalId) ? state.dashboardSignal : null;
  let signal = current ? { ...current, ...(fallbackSignal || {}) } : fallbackSignal;
  if (options.forceRefresh || !signal?.detail_loaded) {
    try {
      const loaded = await loadSignalDetail(signalId, { forceRefresh:options.forceRefresh === true });
      if (loaded) {
        signal = loaded;
        const index = state.signals.findIndex(item => sameSignalId(item.id, signalId));
        if (index >= 0) state.signals[index] = { ...state.signals[index], ...signal };
      }
    } catch (error) {
      console.warn("[Dashboard] 最新 AI 建议详情读取失败，使用基础数据:", error.message);
    }
  }
  if (requestVersion !== _dashboardSignalRequestVersion || !signal) return;
  updateSignalDisplay(signal, { announceNew:options.announceNew === true });
}

function flashSignalMonitorUpdate() {
  const card = $("signalCard");
  const sync = $("signalMonitorSync")?.querySelector("span");
  if (!card || document.fullscreenElement !== card) return;
  card.classList.remove("signal-monitor-updated");
  void card.offsetWidth;
  card.classList.add("signal-monitor-updated");
  if (sync) sync.textContent = "新建议已同步";
  clearTimeout(_signalMonitorUpdateTimer);
  _signalMonitorUpdateTimer = setTimeout(() => {
    card.classList.remove("signal-monitor-updated");
    if (sync) sync.textContent = "实时同步";
  }, 2400);
}

// Handle heartbeat reply — MT5 connection status
function handleHeartbeat(msg) {
  const accessTransition = syncAiAccess(msg.access);
  if (msg.platform) updateBridgePlatformUI(msg.platform);
  if (msg.observer_channel?.id) syncSelectedObserverChannel(msg.observer_channel.id);
  if (msg.mt5_time) {
    syncTerminalTimezoneOffset(msg);
    const terminalTime = formatTerminalQuoteTime({
      time:msg.mt5_time,
      observed_at_utc_msc:msg.observed_at_utc_msc,
      timezone_offset_minutes:msg.timezone_offset_minutes,
      clock_status:msg.clock_status,
    });
    setText('quoteTime', terminalTime);
    setText('mt5ServerTime', terminalTime === '--' ? '--' : terminalTime.split(' ').pop() || '--');
  }
  const isLive = msg.mt5_connected && msg.mt5_alive;
  const usingFallback = msg.using_fallback;
  const wasLive = state._lastGatewayLive;
  const wasFallback = state._lastUsingFallback;
  state._usingFallback = usingFallback;

  renderGatewayConnectionBadge(isLive, usingFallback);

  // Update market status from heartbeat
  if (typeof msg.trade_mode === 'number') updateMarketStatus(msg.trade_mode);

  // Update trade badge from heartbeat data (bridge just connected/state changed)
  // Note: tradeMode 1-3 are partial trading modes, not "closed"
  if (typeof msg.trade_enabled === 'boolean') {
    if (isObserverMode()) {
      renderObserverSwitchStates({
        tradeEnabled: msg.trade_enabled,
        autoEnabled: typeof msg.auto_reasoning_enabled === 'boolean' ? msg.auto_reasoning_enabled : state.autoEnabled,
      });
    } else {
      const tradeText = msg.trade_enabled ? "交易已开启" : "交易已关闭";
      renderTradePermissionBadge(msg.trade_enabled, { label:tradeText });
    }
  } else if (!isLive && !usingFallback) {
    setBadge("tradeMode", "请先启动桥接", "neutral");
  }

  // Heartbeats describe bridge connectivity. For full-access users the
  // automatic-analysis switch is owned by strategy subscriptions and is
  // updated only by auto_status / auto_state; otherwise a stale or V3 bridge
  // heartbeat can overwrite an enabled subscription with false.
  if (isObserverMode() && typeof msg.auto_reasoning_enabled === 'boolean') {
    renderObserverSwitchStates({ tradeEnabled: msg.trade_enabled, autoEnabled: msg.auto_reasoning_enabled });
  }

  state._lastGatewayLive = isLive;
  state._lastUsingFallback = usingFallback;
  if (isLive) startLiveQuoteRefreshTimer();
  else {
    stopLiveQuoteRefreshTimer();
  }

  // Bridge state changed → update role-based UI
  if (isLive !== wasLive || usingFallback !== wasFallback) {
    applyRoleUI();
    if (isLive && !accessTransition.personalBridgeRestored && !_initialDashboardBootstrapInFlight) {
      // Clear caches so bridge-dependent data refreshes
      _historyCache = null;
      _historyChartCache = null;
      refreshAll().then(() => {
        refreshTabData(activeTabId()).catch(() => {});
      }).catch(() => {});
    }
    else if (!usingFallback) {
      renderPositionTables([]);
    }
  }
}

// Handle bridge disconnect notification
function handleDisconnect(msg) {
  renderGatewayConnectionBadge(false, false);
  setBadge("tradeMode", "请先启动桥接", "neutral");
  // Bridge connectivity pauses the runtime subscription but does not change
  // the persisted automatic-inference switch.
  if (state.autoRuntime) {
    state.autoRuntime.enabled = !!state.autoEnabled;
    state.autoRuntime.in_flight = false;
    state.autoRuntime.paused_reason = state.autoEnabled ? 'user_bridge_offline' : 'disabled';
    renderAutoAnalyzeBadge(state.autoRuntime);
  } else {
    renderAutoAnalyzeBadge({ enabled: !!state.autoEnabled, paused_reason: state.autoEnabled ? 'user_bridge_offline' : 'disabled' });
  }
  state._lastGatewayLive = false;
  stopLiveQuoteRefreshTimer();
  void enterBridgeObserverMode({
    paused:state.bridgeRuntimeControl?.desired_state === "paused",
  }).catch(error => console.warn("[BridgeAccess] 断线后切换观摩模式失败:", error?.message || error));
  updateMarketStatus(-1);
}



// Navigate to order in positions/history list from close analysis table
async function navigateToOrder(ticket, action) {
  const targetTab = action === 'close' ? 'history' : 'trading';
  setTab(targetTab);
  // Wait for tab data to load, then find and highlight the row
  setTimeout(() => {
    const selector = targetTab === 'trading' ? '#positionsBody' : '#historyBody';
    const row = document.querySelector(`${selector} tr[data-ticket="${ticket}"]`);
    if (row) {
      row.scrollIntoView({ behavior: 'smooth', block: 'center' });
      row.classList.add('order-highlight');
      setTimeout(() => row.classList.remove('order-highlight'), 2500);
    }
  }, 500);
}

function parseJsonField(value, fallback = {}) {
  try { return value ? JSON.parse(value) : fallback; } catch { return fallback; }
}

function isObserverSourceAccount() {
  const role = String(state.user?.role || '').toLowerCase();
  const planSource = String(state.user?.planSource || state.user?.plan_source || '').toLowerCase();
  return role === 'user' && planSource === 'observer_source';
}

function canManagePlatformAiContent() {
  return state.user?.role === 'admin' || isObserverSourceAccount();
}

function profileScopeQuery() {
  return state.user?.role === "admin" ? "?scope=platform" : "";
}

const PROVIDER_PRESETS = {
  deepseek: { models: ['deepseek-chat', 'deepseek-reasoner'], url: 'https://api.deepseek.com' },
  gpt: { models: ['gpt-4o', 'gpt-4o-mini'], url: 'https://api.openai.com/v1' },
  kimi: { models: ['moonshot-v1-8k'], url: 'https://api.moonshot.cn/v1' },
  kimi_code: { models: ['kimi-for-coding', 'k3', 'kimi-for-coding-highspeed'], url: 'https://api.kimi.com/coding/v1' },
  qwen: { models: ['qwen-plus'], url: 'https://dashscope.aliyuncs.com/compatible-mode/v1' },
  zhipu: { models: ['glm-4-flash'], url: 'https://open.bigmodel.cn/api/paas/v4' },
  doubao: { models: ['doubao-1.5-pro-32k'], url: 'https://ark.cn-beijing.volces.com/api/v3' },
  volcengine_agent_plan: { models: ['ark-code-latest'], url: 'https://ark.cn-beijing.volces.com/api/plan/v3' },
  openai_compatible: { models: [], url: '' },
};

const MODEL_PROVIDER_LABELS = {
  deepseek: "DeepSeek", gpt: "OpenAI compatible", kimi: "Kimi 开放平台",
  kimi_code: "Kimi Code 订阅", qwen: "Qwen", zhipu: "智谱",
  doubao: "豆包", volcengine_agent_plan: "火山方舟 Agent Plan",
  openai_compatible: "自定义 OpenAI 兼容",
};

const DEFAULT_MODEL_TOKEN_LIMITS = Object.freeze({
  context_window_tokens: 1048576,
  max_input_tokens: 1048576,
  max_output_tokens: 393216,
});

function modelTokenLimits(profile = {}) {
  const source = profile.token_limits || profile.capabilities || profile.model_capabilities || {};
  const value = key => {
    const raw = profile[key] ?? source[key];
    const number = Number(raw);
    return Number.isInteger(number) && number > 0 ? number : DEFAULT_MODEL_TOKEN_LIMITS[key];
  };
  return {
    context_window_tokens: value("context_window_tokens"),
    max_input_tokens: value("max_input_tokens"),
    max_output_tokens: value("max_output_tokens"),
  };
}

function modelTokenStatus(profile = {}) {
  const source = profile.token_limits || profile.capabilities || profile.model_capabilities || {};
  const raw = String(profile.token_limits_status ?? source.token_limits_status ?? source.status ?? "").toLowerCase();
  if (["confirmed", "manual_confirmed", "verified"].includes(raw)) return { label: "已人工确认", tone: "success" };
  if (["stale", "needs_confirmation"].includes(raw)) return { label: "待重新确认", tone: "warning" };
  return { label: "待人工确认", tone: "warning" };
}

function formatModelTokenCount(value) {
  return Number(value || 0).toLocaleString("zh-CN");
}

function modelProviderLabel(provider) { return MODEL_PROVIDER_LABELS[provider] || provider; }

const MODEL_PURPOSE_LABELS = Object.freeze({
  manual_analysis: "手动分析",
  auto_inference: "自动分析",
  daily_review: "日复盘",
  monthly_review: "月复盘",
  manual_trade_review: "手动交易复盘",
  memory_compression: "记忆整理",
  memory_consistency: "一致性检查",
});
const MODEL_PURPOSE_DESCRIPTIONS = Object.freeze({
  manual_analysis: "实时手动请求",
  auto_inference: "按订阅自动运行",
  daily_review: "每日复盘生成",
  monthly_review: "周期总结与回顾",
  manual_trade_review: "人工选择交易复盘",
  memory_compression: "整理统一策略记忆",
  memory_consistency: "校验记忆与策略一致性",
});
const MODEL_PURPOSE_KEYS = Object.keys(MODEL_PURPOSE_LABELS);

function modelPurposeScope() { return state.user?.role === "admin" ? "platform" : "user"; }

function normalizeModelPurposeBindings(data = {}) {
  const source = Array.isArray(data?.purposes)
    ? data.purposes
    : Array.isArray(data?.bindings)
      ? data.bindings
      : data?.purposes && typeof data.purposes === "object"
        ? Object.entries(data.purposes).map(([purpose, binding]) => ({ purpose, ...(binding || {}) }))
        : data?.bindings && typeof data.bindings === "object"
          ? Object.entries(data.bindings).map(([purpose, binding]) => ({ purpose, ...(binding || {}) }))
          : [];
  const byPurpose = new Map();
  source.forEach(item => {
    const purpose = String(item?.purpose || item?.purpose_key || item?.key || "").trim();
    if (!MODEL_PURPOSE_LABELS[purpose]) return;
    const nested = item?.model_profile || item?.modelProfile || item?.profile || item?.configured_model || null;
    const id = item?.model_profile_id ?? item?.modelProfileId ?? item?.profile_id ?? nested?.id ?? null;
    byPurpose.set(purpose, { ...item, purpose, model_profile_id: id == null ? null : Number(id) });
  });
  return MODEL_PURPOSE_KEYS.map(purpose => byPurpose.get(purpose) || { purpose, model_profile_id: null });
}

function modelPurposeNestedModel(binding = {}) {
  return binding.model_profile || binding.modelProfile || binding.profile || binding.configured_model || binding.effective_model || binding.resolved_model || null;
}

function modelPurposeProfileId(binding = {}) {
  const nested = modelPurposeNestedModel(binding);
  const raw = binding.model_profile_id ?? binding.modelProfileId ?? binding.profile_id ?? nested?.id;
  return raw == null || raw === "" ? null : Number(raw);
}

function modelPurposeText(value) {
  if (value == null) return "";
  if (typeof value === "string") return value.trim();
  if (typeof value === "object") return String(value.label || value.name || value.explanation || value.reason || value.source_label || value.source || value.kind || "").trim();
  return String(value).trim();
}

function modelPurposeSource(binding = {}) {
  const invalid = ["invalid", "blocked", "unavailable", "disabled"].includes(String(binding.binding_status || binding.status || "").toLowerCase());
  const raw = modelPurposeText(invalid ? binding.reason : (binding.source_explanation ?? binding.sourceExplanation ?? binding.inherited_source ?? binding.inherited_from ?? binding.effective_source ?? binding.resolution?.source_explanation ?? binding.resolution?.source_label ?? binding.resolution?.source ?? binding.source_label ?? binding.source ?? binding.reason));
  return ({ legacy_resolver: "未配置用途模型，继承现有模型解析规则", legacy_fallback: "未配置用途模型，继承现有模型解析规则", purpose_binding: "已按用途绑定", purpose_binding_invalid: "用途绑定已失效，请重新选择模型" })[raw] || raw;
}

function modelPurposeActualModel(binding = {}, profiles = []) {
  const nested = modelPurposeNestedModel(binding);
  const direct = binding.effective_model_name ?? binding.resolved_model_name ?? binding.actual_model_name ?? binding.configured_model_name ?? nested?.model_name ?? nested?.name;
  if (direct) return String(direct);
  const id = modelPurposeProfileId(binding);
  return profiles.find(profile => Number(profile.id) === Number(id))?.model_name || "";
}

function modelPurposeProfileMeta(profile = {}) {
  const verification = String(profile.verification_status || profile.provider_verification_status || "").toLowerCase();
  const verificationLabel = verification === "verified" || verification === "confirmed" ? "已验证" : verification === "unverified" ? "待验证" : "";
  const recent = profile.verified_at || profile.last_verified_at || profile.updated_at;
  return `${modelTokenStatus(profile).label}${verificationLabel ? ` · ${verificationLabel}` : ""}${recent ? ` · 最近 ${escapeHtml(String(recent).slice(0, 16))}` : ""}`;
}

function renderModelPurposeBindings() {
  const host = $("modelPurposeBindingsList");
  if (!host) return;
  const scope = modelPurposeScope();
  const profiles = (state.modelProfiles || []).filter(profile => profile.scope === scope && profile.status === "active");
  const error = String(state.modelPurposeBindingsError || "");
  if (error) {
    host.innerHTML = `<div class="model-purpose-load-error" role="alert">用途绑定加载失败：${escapeHtml(error)}<button class="btn btn-secondary btn-sm" type="button" data-retry-model-purposes>重新加载</button></div>`;
    host.querySelector("[data-retry-model-purposes]")?.addEventListener("click", () => loadModelManagement().catch(loadError => toast(loadError.message, "error")));
    return;
  }
  if (!state.modelPurposeBindings) {
    host.innerHTML = '<div class="workspace-skeleton"></div><div class="workspace-skeleton"></div>';
    return;
  }
  const bindings = normalizeModelPurposeBindings(state.modelPurposeBindings);
  host.innerHTML = bindings.map(binding => {
    const purpose = binding.purpose;
    const id = modelPurposeProfileId(binding);
    const profile = profiles.find(item => Number(item.id) === Number(id));
    const unavailable = id != null && !profile;
    const blocked = unavailable || Boolean(binding.blocked || binding.invalid || ["blocked", "invalid", "unavailable", "disabled"].includes(String(binding.status || binding.binding_status || "").toLowerCase()));
    const actual = modelPurposeActualModel(binding, profiles);
    const source = modelPurposeSource(binding);
    const options = `<option value="" ${id == null ? "selected" : ""}>继承现有规则</option>${unavailable ? `<option value="${Number(id)}" selected>当前绑定模型不可用</option>` : ""}${profiles.map(item => `<option value="${Number(item.id)}" ${Number(item.id) === Number(id) && !unavailable ? "selected" : ""}>${escapeHtml(item.model_name || `模型 #${Number(item.id)}`)} · ${escapeHtml(modelProviderLabel(item.provider))} · ${modelPurposeProfileMeta(item)}</option>`).join("")}`;
    const resolution = blocked
      ? `绑定模型不可用，保存前请选择其他${scope === "platform" ? "平台" : "个人"}模型或继承规则`
      : `实际模型：${actual ? escapeHtml(actual) : "由现有规则解析"}${source ? ` · ${escapeHtml(source)}` : ""}`;
    return `<article class="model-purpose-row model-purpose-card ${blocked ? "is-blocked" : ""}" data-model-purpose="${purpose}"><div class="model-purpose-card-head"><div class="model-purpose-copy"><span class="model-purpose-kicker">任务用途</span><strong>${MODEL_PURPOSE_LABELS[purpose]}</strong><small>${escapeHtml(MODEL_PURPOSE_DESCRIPTIONS[purpose] || "按用途解析")}</small></div><span class="model-purpose-key sr-only" aria-hidden="true">${escapeHtml(purpose)}</span></div><label class="model-purpose-select"><span>${MODEL_PURPOSE_LABELS[purpose]}模型</span><select class="select" data-purpose-select aria-describedby="model-purpose-resolution-${purpose}" ${isObserverMode() ? "disabled" : ""}>${options}</select></label><div id="model-purpose-resolution-${purpose}" class="model-purpose-resolution ${blocked ? "is-blocked" : ""}" role="status"><span class="model-purpose-resolution-label">实际解析</span>${resolution}</div><button class="btn btn-secondary btn-sm" data-save-model-purpose type="button" ${isObserverMode() ? "disabled" : ""}>保存用途</button><div class="model-purpose-error" data-purpose-error role="alert" aria-live="polite"></div></article>`;
  }).join("");
}

async function saveModelPurposeBinding(button) {
  const row = button?.closest("[data-model-purpose]");
  const purpose = row?.dataset.modelPurpose;
  const select = row?.querySelector("[data-purpose-select]");
  const errorHost = row?.querySelector("[data-purpose-error]");
  if (!purpose || !select) return;
  const raw = String(select.value || "").trim();
  const modelProfileId = raw ? Number(raw) : null;
  const scope = modelPurposeScope();
  if (raw && (!Number.isInteger(modelProfileId) || !(state.modelProfiles || []).some(profile => profile.scope === scope && profile.status === "active" && Number(profile.id) === modelProfileId))) {
    if (errorHost) errorHost.textContent = `请选择仍可用的${scope === "platform" ? "平台" : "个人"}模型，或改为继承现有规则`;
    return;
  }
  const originalLabel = button.textContent;
  button.disabled = true;
  button.setAttribute("aria-busy", "true");
  button.textContent = "保存中…";
  if (errorHost) errorHost.textContent = "";
  try {
    await api(`/api/ai/model-purpose-bindings/${encodeURIComponent(purpose)}`, { method: "PUT", body: { scope, model_profile_id: modelProfileId } });
    toast(`${MODEL_PURPOSE_LABELS[purpose]}已保存`, "success");
    await loadModelManagement();
  } catch (error) {
    if (errorHost) errorHost.textContent = error.message || "保存失败，请重试";
  } finally {
    button.disabled = false;
    button.removeAttribute("aria-busy");
    button.textContent = originalLabel;
  }
}

function updateModelProviderHelp(provider) {
  const help = $("profileProviderHelp");
  if (!help) return;
  help.textContent = provider === "kimi_code"
    ? "订阅接口支持关闭思考模式；管理员配置为平台模型后，可按用途选择是否共享。"
    : provider === "kimi"
      ? "开放平台按量计费，适合正式自动分析与客户使用。"
      : "";
  if ($("profileTemperature")) $("profileTemperature").disabled = provider === "kimi_code";
  if ($("profileThinkingHelp")) $("profileThinkingHelp").textContent = provider === "kimi_code"
    ? "关闭后响应明显加快；Kimi Code 会忽略 Temperature"
    : "复杂任务更稳，但推理耗时更长";
}

function modelCatalogFilterState() {
  return {
    query: String(state.modelCatalogSearch || "").trim().toLocaleLowerCase("zh-CN"),
    status: String(state.modelCatalogStatus || "all"),
  };
}

function modelCatalogProfiles() {
  const { query, status } = modelCatalogFilterState();
  return (state.modelProfiles || []).filter(profile => {
    const modelName = String(profile.model_name || "").toLocaleLowerCase("zh-CN");
    const provider = `${modelProviderLabel(profile.provider) || ""} ${profile.provider || ""}`.toLocaleLowerCase("zh-CN");
    const matchesQuery = !query || modelName.includes(query) || provider.includes(query);
    const matchesStatus = status === "available"
      ? profile.status === "active"
      : status === "default"
        ? Boolean(profile.is_default)
        : true;
    return matchesQuery && matchesStatus;
  });
}

function renderModelProfiles() {
  const host = $("modelProfilesList");
  if (!host) return;
  const profiles = state.modelProfiles || [];
  const visibleProfiles = modelCatalogProfiles();
  const { query, status } = modelCatalogFilterState();
  const summary = $("modelCatalogSummary");
  const resultCount = $("modelCatalogResultCount");
  const emptyState = $("modelCatalogEmptyState");
  const emptyTitle = $("modelCatalogEmptyTitle");
  const emptyCopy = $("modelCatalogEmptyCopy");
  const clearButton = $("modelCatalogClearBtn");
  const activeProfiles = profiles.filter(profile => profile.status === "active");
  const hasFilters = Boolean(query) || status !== "all";
  if (summary) summary.textContent = hasFilters
    ? `显示 ${visibleProfiles.length} / ${profiles.length} 个模型`
    : `${profiles.length} 个模型 · ${activeProfiles.length} 个可用`;
  if (resultCount) resultCount.textContent = hasFilters
    ? `${visibleProfiles.length} 个结果（共 ${profiles.length} 个）`
    : `${profiles.length} 个结果`;
  setText("modelCountStat", profiles.length);
  setText("modelActiveStat", activeProfiles.length);

  if (!visibleProfiles.length) {
    host.innerHTML = "";
    host.classList.add("hidden");
    emptyState?.classList.remove("hidden");
    if (emptyTitle) emptyTitle.textContent = profiles.length ? "没有符合筛选条件的模型" : state.user?.role === "admin" ? "还没有平台模型" : "还没有可用模型";
    if (emptyCopy) emptyCopy.textContent = profiles.length
      ? "尝试更换模型名、供应商或状态筛选。"
      : state.user?.role === "admin"
        ? "添加平台模型后，可按用途开放共享。"
        : "添加一个自己的模型，或等待管理员开放共享模型。";
    if (clearButton) clearButton.hidden = !hasFilters;
    initIcons();
    return;
  }

  emptyState?.classList.add("hidden");
  host.classList.remove("hidden");
  host.innerHTML = visibleProfiles.map(profile => {
    const limits = modelTokenLimits(profile);
    const tokenStatus = modelTokenStatus(profile);
    const modelName = escapeHtml(profile.model_name || `模型 #${Number(profile.id)}`);
    const providerLabel = escapeHtml(modelProviderLabel(profile.provider) || profile.provider || "未知供应商");
    const isActive = profile.status === "active";
    const credentialLabel = profile.has_api_key ? "凭据已保存" : "需要配置凭据";
    return `
    <article class="workspace-row model-profile-card" data-model-id="${Number(profile.id)}">
      <header class="model-profile-card-header">
        <div class="model-profile-identity"><span class="model-profile-mark" aria-hidden="true"><i data-lucide="cpu" size="18"></i></span><div class="model-profile-identity-copy"><div class="model-profile-name-row"><h3>${modelName}</h3>${profile.is_default ? '<span class="status-chip success">默认模型</span>' : ''}</div><p>${providerLabel}</p></div></div>
        <div class="model-profile-statuses"><span class="status-chip ${isActive ? "info" : "warning"}">${isActive ? "连接可用" : "已停用"}</span>${profile.provider === "kimi_code" ? `<span class="status-chip warning">${state.user?.role === "admin" ? "订阅模型 · 可按用途共享" : "个人订阅"}</span>` : ""}</div>
      </header>
      <div class="model-profile-signals"><div class="model-profile-signal"><span>凭据状态</span><strong class="${profile.has_api_key ? "is-positive" : "is-warning"}">${credentialLabel}</strong></div><div class="model-profile-signal"><span>能力状态</span><strong>${tokenStatus.label}</strong></div><div class="model-profile-signal"><span>思考模式</span><strong>${Number(profile.thinking_enabled) ? "开启" : "关闭"}</strong></div></div>
      <details class="row-details model-profile-details"><summary>查看技术信息</summary><div class="workspace-row-meta"><span>API：${escapeHtml(profile.api_base_url || "使用服务商默认地址")}</span><span>上下文窗口 ${formatModelTokenCount(limits.context_window_tokens)} tokens</span><span>最大输入 ${formatModelTokenCount(limits.max_input_tokens)} tokens</span><span>最大输出 ${formatModelTokenCount(limits.max_output_tokens)} tokens</span><span>能力状态 <em class="status-chip ${tokenStatus.tone}">${tokenStatus.label}</em></span><span>Temperature ${escapeHtml(profile.temperature ?? "--")}</span>${profile.request_timeout_ms ? `<span>模型请求超时 ${Math.round(profile.request_timeout_ms / 1000)}s</span>` : ""}</div></details>
      <footer class="workspace-row-actions model-profile-card-actions"><button class="btn btn-secondary btn-sm" type="button" data-model-action="test">测试连接</button><button class="btn btn-secondary btn-sm" type="button" data-model-action="default" ${profile.is_default ? "disabled" : ""}>设为默认</button><button class="btn btn-secondary btn-sm" type="button" data-model-action="edit">编辑</button><button class="btn btn-danger-ghost btn-sm" type="button" data-model-action="delete" aria-label="删除 ${modelName}"><i data-lucide="trash-2" size="14" aria-hidden="true"></i></button></footer>
    </article>`;
  }).join("");
  initIcons();
}

async function loadModelManagement() {
  const host = $("modelProfilesList");
  if (host) {
    host.classList.remove("hidden");
    host.innerHTML = '<div class="workspace-skeleton"></div><div class="workspace-skeleton"></div>';
  }
  $("modelCatalogEmptyState")?.classList.add("hidden");
  setText("modelCatalogResultCount", "正在加载模型");
  setText("modelEffectiveSource", "正在选择…");
  const notice = $("modelSourceNotice");
  if (notice) notice.innerHTML = '<span><strong>模型来源：</strong>正在向服务端确认当前可用配置…</span>';
  const usage = state.user?.role === "admin" ? "auto_platform" : "manual";
  const purposeScope = modelPurposeScope();
  const [profilesResult, sourceResult, purposeResult] = await Promise.allSettled([
    api(`/api/ai/model-profiles${profileScopeQuery()}`),
    api(`/api/ai/model-source?usage=${usage}`),
    api(`/api/ai/model-purpose-bindings?scope=${encodeURIComponent(purposeScope)}`),
  ]);
  if (profilesResult.status === "fulfilled") {
    state.modelProfiles = profilesResult.value.profiles || [];
    renderModelProfiles();
  } else {
    state.modelProfiles = [];
    $("modelCatalogEmptyState")?.classList.add("hidden");
    setText("modelCountStat", "--");
    setText("modelActiveStat", "--");
    setText("modelCatalogResultCount", "模型目录加载失败");
    if ($("modelCatalogSummary")) $("modelCatalogSummary").textContent = "模型列表加载失败";
    if (host) host.innerHTML = `<div class="workspace-panel model-load-error" role="alert"><span class="model-load-error-icon"><i data-lucide="circle-alert" size="18"></i></span><div><strong>模型列表加载失败</strong><small>${escapeHtml(profilesResult.reason?.message || "请检查网络连接后重试")}</small></div><button class="btn btn-secondary btn-sm" type="button" data-action="retry-model-management">重新加载</button></div>`;
  }

  if (sourceResult.status === "fulfilled") {
    const source = sourceResult.value.source || {};
    const sourceLabel = ({ user:"自有加密凭据", platform_shared:"平台共享凭据", platform_primary:"平台主模型", none:"未配置" })[source.credential_source] || source.credential_source;
    const unavailableReason = apiErrorMessage(source.error || "no_model_configured");
    const sourceText = source.available ? `${source.model_name} · ${sourceLabel}` : `当前任务不可用 · ${unavailableReason}`;
    setText("modelEffectiveSource", source.available ? `${source.model_name} · ${sourceLabel}` : "当前不可用");
    if (notice) notice.innerHTML = `<span><strong>服务端实际解析来源：</strong> ${escapeHtml(sourceText)}</span>`;
    if ($("strategyModelSource")) $("strategyModelSource").textContent = sourceText;
  } else {
    const message = sourceResult.reason?.message || "模型来源解析请求失败";
    setText("modelEffectiveSource", "解析失败");
    if (notice) notice.innerHTML = `<span><strong>模型来源解析失败：</strong> ${escapeHtml(message)}</span><button class="btn btn-secondary btn-sm" type="button" data-action="retry-model-management">重试</button>`;
    if ($("strategyModelSource")) $("strategyModelSource").textContent = "模型来源解析失败";
  }
  if (purposeResult.status === "fulfilled") {
    state.modelPurposeBindings = purposeResult.value;
    state.modelPurposeBindingsError = "";
  } else {
    state.modelPurposeBindings = null;
    state.modelPurposeBindingsError = purposeResult.reason?.message || "用途绑定请求失败";
  }
  renderModelPurposeBindings();
  if (state.user?.role === "admin" && profilesResult.status === "fulfilled") {
    try { await loadPlatformPolicy(); }
    catch (error) { toast(`平台共享设置加载失败：${error.message}`, "warning"); }
  }
  initIcons();
}

function openModelEditor(profile = null) {
  if (isObserverMode()) { toast(observerMessage(), "warning"); return; }
  const editor = $("modelProfileEditor");
  if (!editor) return;
  editor.dataset.modelId = profile?.id || "";
  editor.dataset.expectedUpdatedAt = profile?.updated_at || "";
  $("modelEditorTitle").textContent = profile ? "编辑模型" : "添加模型";
  $("profileProvider").value = profile?.provider || "deepseek";
  $("profileModelName").value = profile?.model_name || "deepseek-chat";
  $("profileBaseUrl").value = profile?.api_base_url || PROVIDER_PRESETS[profile?.provider || "deepseek"]?.url || "";
  $("profileApiKey").value = "";
  $("profileTemperature").value = profile?.temperature ?? 0.3;
  const limits = modelTokenLimits(profile || {});
  $("profileContextWindowTokens").value = limits.context_window_tokens;
  $("profileMaxInputTokens").value = limits.max_input_tokens;
  $("profileMaxOutputTokens").value = limits.max_output_tokens;
  $("profileRequestTimeout").value = profile?.request_timeout_ms ? Math.round(profile.request_timeout_ms / 1000) : "";
  $("profileThinkingEnabled").checked = profile ? Boolean(Number(profile.thinking_enabled)) : true;
  updateModelProviderHelp(profile?.provider || "deepseek");
  openFormModal(editor);
}

async function saveModelProfile() {
  const editor = $("modelProfileEditor");
  const id = Number(editor?.dataset.modelId || 0);
  const button = $("saveModelProfileBtn");
  const body = {
    provider: $("profileProvider").value,
    model_name: $("profileModelName").value.trim(),
    api_base_url: $("profileBaseUrl").value.trim(),
    temperature: Number($("profileTemperature").value),
    context_window_tokens: Number($("profileContextWindowTokens").value),
    max_input_tokens: Number($("profileMaxInputTokens").value),
    max_output_tokens: Number($("profileMaxOutputTokens").value),
    thinking_enabled: $("profileThinkingEnabled").checked,
  };
  const timeoutSec = Number($("profileRequestTimeout").value);
  const requestTimeoutMs = Number.isInteger(timeoutSec) && timeoutSec >= 30 && timeoutSec <= 600
    ? timeoutSec * 1000
    : DEFAULT_MODEL_REQUEST_TIMEOUT_MS;
  if (timeoutSec > 0) body.request_timeout_ms = timeoutSec * 1000;
  if (body.provider === "kimi_code" && body.model_name === "k3" && body.thinking_enabled) body.reasoning_effort = "max";
  const key = $("profileApiKey").value.trim();
  if (key) body.api_key = key;
  if (state.user?.role === "admin") body.scope = "platform";
  if (id && editor?.dataset.expectedUpdatedAt) body.expected_updated_at = editor.dataset.expectedUpdatedAt;
  if (!Object.values({
    context_window_tokens: body.context_window_tokens,
    max_input_tokens: body.max_input_tokens,
    max_output_tokens: body.max_output_tokens,
  }).every(value => Number.isInteger(value) && value > 0)) {
    const error = new Error(apiErrorMessage("model_token_limits_invalid"));
    error.code = "model_token_limits_invalid";
    throw error;
  }
  if (button) {
    button.disabled = true;
    button.setAttribute("aria-busy", "true");
    button.textContent = "正在验证…";
  }
  try {
    await api(id ? `/api/ai/model-profiles/${id}` : "/api/ai/model-profiles", {
      method: id ? "PUT" : "POST",
      body,
      timeout: modelRequestTransportTimeoutMs(requestTimeoutMs),
    });
    $("profileApiKey").value = "";
    closeFormModal(editor, false);
    toast("模型已验证并保存", "success");
    await loadModelManagement();
  } finally {
    if (button) {
      button.disabled = false;
      button.removeAttribute("aria-busy");
      button.textContent = "保存并验证";
    }
  }
}

async function loadPlatformPolicy() {
  const data = await api("/api/ai/platform-model-policy");
  const policy = data.policy || {};
  $("shareForManual").checked = Boolean(policy.share_for_manual);
  $("shareForAuto").checked = Boolean(policy.share_for_auto);
  $("shareForReview").checked = Boolean(policy.share_for_review);
  $("shareForCompression").checked = Boolean(policy.share_for_memory_compression);
  $("policyDailyRequests").value = policy.daily_requests_per_user || 100;
  $("policyDailyTokens").value = policy.daily_tokens_per_user || 500000;
  const controls = [$("shareForManual"), $("shareForAuto"), $("shareForReview"), $("shareForCompression")].filter(Boolean);
  const hasShareableModel = state.modelProfiles.some(profile => profile.status === "active" && profile.has_api_key && profile.share_eligible !== false);
  controls.forEach(control => { control.disabled = !hasShareableModel; });
}

async function savePlatformPolicy() {
  await api("/api/ai/platform-model-policy", { method:"PUT", body:{
    share_for_manual:$("shareForManual").checked,
    share_for_auto:$("shareForAuto").checked,
    share_for_review:$("shareForReview").checked,
    share_for_memory_compression:$("shareForCompression").checked,
    allowed_plans:["pro"],
    daily_requests_per_user:Number($("policyDailyRequests").value),
    daily_tokens_per_user:Number($("policyDailyTokens").value),
  } });
  toast("平台共享策略已保存", "success");
}

async function loadStrategyCatalog() {
  const host = $("strategyCatalog");
  if (!host) return;
  const platformManager = canManagePlatformAiContent();
  const data = await api(`/api/ai/strategies${platformManager ? '?include_inactive=1' : ''}`);
  const items = data.strategies || [];
  const subscriptions = data.subscriptions || [];
  state.strategies = items; state.strategySubscriptions = subscriptions; state.tradingAccounts = data.accounts || [];
  const summary = $("strategyCatalogSummary");
  if (summary) {
    const active = items.filter(item => item.visibility_status === "active" && Number(item.is_active)).length;
    const privateCount = items.filter(item => item.scope === "private").length;
    summary.textContent = `${items.length} 个策略 · ${active} 个可用${privateCount ? ` · ${privateCount} 个私有` : ""}`;
  }
  const addStrategyButton = $("addPrivateStrategyBtn");
  if (addStrategyButton && platformManager) {
    addStrategyButton.disabled = false;
    addStrategyButton.title = "新建平台策略";
    addStrategyButton.innerHTML = '<i data-lucide="plus" size="15"></i>新建平台策略';
  }
  if (addStrategyButton && !platformManager) {
    const ownPrivateCount = items.filter(item => item.scope === "private" && Number(item.owner_user_id) === Number(state.user?.id)).length;
    const reachedLimit = ownPrivateCount >= 1;
    addStrategyButton.disabled = reachedLimit;
    addStrategyButton.title = reachedLimit ? "当前 Pro 账户最多只能创建 1 条自定义策略" : "新建自定义策略";
    addStrategyButton.innerHTML = reachedLimit
      ? '<i data-lucide="check" size="15"></i>已创建 1 条策略'
      : '<i data-lucide="plus" size="15"></i>新建自定义策略';
  }
  const activeCount = items.filter(item => item.visibility_status === "active" && Number(item.is_active)).length;
  const runningCount = subscriptions.filter(item => Number(item.execution_enabled)).length;
  setText("strategyTotalStat", items.length);
  setText("strategyAvailableStat", activeCount);
  setText("strategyRunningStat", runningCount);
  const visibleItems = items.filter(item => {
    if (state.strategyFilter === "platform") return item.scope === "platform";
    if (state.strategyFilter === "private") return item.scope === "private" && Number(item.owner_user_id) === Number(state.user?.id);
    if (state.strategyFilter === "subscribed") return subscriptions.some(sub => Number(sub.strategy_id) === Number(item.id));
    return true;
  });
  host.innerHTML = visibleItems.length ? visibleItems.map(item => {
    const symbols = parseJsonField(item.symbols_json, []);
    const plan = parseJsonField(item.market_data_plan_json, { timeframes:[] });
    const entryMethods = parseJsonField(item.entry_methods_json, ["market","limit","stop","stop_limit"]);
    const planText = (plan.timeframes || []).map(row => `${row.timeframe}×${row.kline_count}`).join(" · ") || "M30×100";
    const entryText = entryMethods.map(method => ({market:"市价",limit:"限价",stop:"突破",stop_limit:"突破限价"}[method] || method)).join("、");
    const emaState = strategyEma34State(item);
    const chanText = Number(item.use_chan_analysis) ? "缠论结构已提供" : "未提供缠论结构";
    const emaText = emaState.advanced
      ? `EMA34 高级配置 · ${emaState.enabled ? "已提供" : "已关闭"}${emaState.capabilityTimeframe ? ` · ${emaState.capabilityTimeframe}` : ""}`
      : emaState.enabled ? `EMA34 · ${escapeHtml(emaState.canonical?.source?.timeframe || "已配置")}` : Number(item?.["use_ema34_filter"] || 0) ? "旧 EMA 状态未生效" : "未提供 EMA34";
    const portfolioText = item.scope === "private"
      ? (Number(item.include_portfolio_context) ? "已提供持仓与挂单" : "不提供持仓与挂单")
      : "策略参考持仓与挂单 · 运行时自动提供（可能为空或不可用）";
    const source = item.model_profile_id ? `绑定模型 #${item.model_profile_id}` : "继承默认模型";
    const memory = item.scope === "private" ? "个人记忆可用" : "使用绑定的平台记忆";
    const linked = subscriptions.filter(sub => Number(sub.strategy_id) === Number(item.id));
    const execution = linked.length ? `${linked.filter(sub => Number(sub.execution_enabled)).length}/${linked.length} 个订阅启用` : "未订阅";
    const memoryMode = linked.some(sub => sub.memory_mode === "off") ? "部分订阅关闭记忆" : memory;
    const canEdit = (item.scope === 'private' && Number(item.owner_user_id) === Number(state.user?.id))
      || (item.scope === 'platform' && canManagePlatformAiContent());
    const subRows = linked.map(sub => `<div class="subscription-row"><div class="subscription-row-info"><strong>账户 #${sub.trading_account_id}</strong><span>订阅 #${sub.id} · ${sub.execution_enabled ? '自动分析已启用' : '自动分析未启用'} · ${escapeHtml(subscriptionTakeProfitModeLabel(sub.take_profit_mode))} · ${escapeHtml(subscriptionScheduleSummary(sub))} · ${escapeHtml(subscriptionMemoryModeLabel(sub.memory_mode))}</span></div><div class="subscription-row-actions"><button class="btn btn-secondary btn-sm" data-subscription-action="edit" data-subscription-id="${sub.id}"><i data-lucide="settings-2" size="14"></i>编辑</button><button class="btn btn-danger-ghost btn-sm" data-subscription-action="delete" data-subscription-id="${sub.id}"><i data-lucide="trash-2" size="14"></i>删除</button></div></div>`).join("");
    const primarySubscription = linked.find(sub => Number(sub.execution_enabled)) || linked[0];
    const subscriptionButton = primarySubscription
      ? `<button class="btn btn-primary btn-sm" data-subscription-action="edit" data-subscription-id="${primarySubscription.id}"><i data-lucide="settings-2" size="14"></i>编辑订阅</button>`
      : '<button class="btn btn-primary btn-sm" data-strategy-action="subscribe"><i data-lucide="play" size="14"></i>订阅与运行</button>';
    const canSubscribe = item.scope === 'platform' || Number(item.owner_user_id) === Number(state.user?.id);
    const visibilityLabel = ({ active:"上线", draft:"草稿", archived:"归档" })[item.visibility_status] || item.visibility_status;
    const subscriptionsBlock = linked.length ? `<section class="strategy-subscriptions"><div class="strategy-subscriptions-head"><span><i data-lucide="radio-tower" size="15"></i>执行订阅</span><small>${linked.length} 个</small></div>${subRows}</section>` : '<div class="quiet-empty">还没有执行订阅</div>';
    const fallbackDescription = item.scope === "private" ? "我的自定义分析策略" : "平台提供的分析策略";
    const description = String(item.description || fallbackDescription)
      .replace(/^\s*>\s?/gm, "")
      .trim() || fallbackDescription;
    return `<article class="strategy-card ${item.scope === 'private' ? 'is-private' : 'is-platform'}" data-strategy-id="${Number(item.id)}"><header class="strategy-card-header"><div><div class="workspace-row-title">${escapeHtml(item.title)} <span class="status-chip ${item.scope === 'private' ? 'info' : ''}">${item.scope === 'private' ? '我的策略' : '平台策略'}</span><span class="status-chip ${item.visibility_status === 'active' ? 'success' : 'warning'}">${escapeHtml(visibilityLabel)}</span></div><p class="strategy-card-description">${escapeHtml(description)}</p></div><div class="strategy-card-actions">${canSubscribe ? subscriptionButton : '<span class="status-chip">仅审计可见</span>'}${canEdit ? '<button class="btn btn-secondary btn-sm" data-strategy-action="edit"><i data-lucide="pencil" size="14"></i>编辑</button><button class="btn btn-danger-ghost btn-sm" data-strategy-action="delete" aria-label="删除策略"><i data-lucide="trash-2" size="14"></i></button>' : ''}</div></header><div class="strategy-essentials"><span><small>支持品种</small><strong>${symbols.slice(0,4).map(escapeHtml).join('、') || '未设置'}${symbols.length > 4 ? ` 等 ${symbols.length} 个` : ''}</strong></span><span><small>主要行情</small><strong>${escapeHtml(plan.primary_timeframe || plan.timeframes?.[0]?.timeframe || 'M30')} · ${Number(plan.timeframes?.find(row => row.timeframe === plan.primary_timeframe)?.kline_count || plan.timeframes?.[0]?.kline_count || 100)} 根</strong></span><span><small>模型</small><strong>${escapeHtml(source)}</strong></span><span class="${linked.some(sub => Number(sub.execution_enabled)) ? 'running' : ''}"><small>自动运行</small><strong>${escapeHtml(execution)}</strong></span></div><details class="strategy-details"><summary><span>查看策略详情与订阅</span><i data-lucide="chevron-down" size="15"></i></summary><div class="strategy-details-body"><div class="strategy-specs"><span><small>完整行情计划</small><strong>${escapeHtml(planText)}</strong></span><span><small>附加数据</small><strong>${escapeHtml(`${chanText} · ${emaText}`)}</strong></span><span><small>允许入场</small><strong>${escapeHtml(entryText)}</strong></span><span><small>账户上下文</small><strong>${escapeHtml(portfolioText)}</strong></span><span><small>记忆方式</small><strong>${escapeHtml(memoryMode)}</strong></span></div>${subscriptionsBlock}</div></details></article>`;
  }).join("") : '<div class="empty-state"><strong>当前筛选下没有策略</strong><span>切换筛选条件，或新建一套自己的交易策略。</span></div>';
  populateManualStrategySelector();
  renderAdminStrategyDispatchStrategyOptions();
  renderAdminStrategyDispatchControls();
  initIcons();
}

const ADMIN_STRATEGY_DISPATCH_STATUS_LABELS = Object.freeze({
  queued:"等待发起", created:"已创建", preview:"预览", draft:"草稿", previewed:"预览完成", confirmed:"已确认", delivering:"分发中", source_pending:"源单等待中", source_sending:"源单发送中",
  source_confirming:"确认源单结果", source_succeeded:"源单已确认", dispatching:"分发中", partial:"部分完成",
  completed:"已完成", succeeded:"已完成", failed:"失败", rejected:"已拒绝", skipped:"已跳过", uncertain:"结果待确认",
  cancelled:"已取消", cancelled_before_send:"已取消", expired:"已过期",
});
const ADMIN_STRATEGY_DISPATCH_TARGET_STATUS_LABELS = Object.freeze({
  success:"成功", succeeded:"成功", completed:"成功", rejected:"拒绝", failed:"拒绝", failed_manual_review:"拒绝（待人工）", skipped:"跳过", uncertain:"结果待确认", pending:"处理中", queued:"等待处理",
});

function isAdminStrategyDispatchUser() {
  return state.user?.role === "admin";
}

function adminStrategyDispatchModeEnabled() {
  return Boolean(isAdminStrategyDispatchUser()
    && state.adminStrategyDispatchCapabilities?.enabled
    && $("adminStrategyDispatchEnabled")?.checked);
}

function adminStrategyDispatchStrategySymbols(strategy) {
  const raw = strategy?.symbols_json ?? strategy?.symbols ?? [];
  const values = Array.isArray(raw) ? raw : parseJsonField(raw, []);
  return values.map(value => String(value || "").trim().toUpperCase()).filter(Boolean);
}

function activePlatformStrategyOptions() {
  return (state.strategies || []).filter(item => item?.scope === "platform"
    && item?.visibility_status === "active" && Number(item?.is_active ?? 1) !== 0);
}

function renderAdminStrategyDispatchStrategyOptions() {
  const select = $("adminStrategyDispatchStrategy");
  if (!select) return;
  const current = String(select.value || state.adminStrategyDispatchPending?.payload?.strategy_id || "");
  const strategies = activePlatformStrategyOptions();
  select.innerHTML = `<option value="">${strategies.length ? "请选择平台策略" : "暂无可用的平台策略"}</option>`
    + strategies.map(item => {
      const symbols = adminStrategyDispatchStrategySymbols(item);
      const symbolText = symbols.length ? ` · ${symbols.slice(0, 4).join("、")}${symbols.length > 4 ? " 等" : ""}` : "";
      return `<option value="${Number(item.id)}">${escapeHtml(item.title || `平台策略 #${Number(item.id)}`)}${escapeHtml(symbolText)}</option>`;
    }).join("");
  if (strategies.some(item => String(item.id) === current)) select.value = current;
  else if (strategies.length === 1) select.value = String(strategies[0].id);
}

function syncAdminStrategyDispatchOrderType() {
  const active = adminStrategyDispatchModeEnabled();
  const selectedType = state.selectedOrderType || "market";
  const buttons = document.querySelectorAll(".order-type-btn");
  buttons.forEach(button => {
    const type = String(button.dataset.type || "");
    if (active && type !== "market") {
      if (!button.hasAttribute("data-admin-dispatch-was-disabled")) button.dataset.adminDispatchWasDisabled = button.disabled ? "1" : "0";
      button.disabled = true;
      button.setAttribute("aria-disabled", "true");
      button.title = "平台策略分发仅支持市价 BUY/SELL";
    } else if (!active && button.hasAttribute("data-admin-dispatch-was-disabled")) {
      button.disabled = button.dataset.adminDispatchWasDisabled === "1";
      button.removeAttribute("data-admin-dispatch-was-disabled");
      button.removeAttribute("aria-disabled");
      button.title = "";
    }
    button.setAttribute("aria-pressed", String(button.dataset.type === (active ? "market" : selectedType)));
  });
  if (active) {
    state.selectedOrderType = "market";
    const marketButton = document.querySelector('.order-type-btn[data-type="market"]');
    buttons.forEach(button => {
      button.classList.toggle("active", button === marketButton);
      button.setAttribute("aria-pressed", String(button === marketButton));
    });
    const pendingRow = $("pendingPriceRow");
    if (pendingRow) {
      pendingRow.style.display = "none";
      pendingRow.setAttribute("aria-hidden", "true");
    }
    const stopLimitWrap = $("stopLimitPriceWrap");
    if (stopLimitWrap) {
      stopLimitWrap.style.display = "none";
      stopLimitWrap.setAttribute("aria-hidden", "true");
    }
  }
  validatePendingPrice();
}

function renderAdminStrategyDispatchControls() {
  const panel = $("adminStrategyDispatchPanel");
  const checkbox = $("adminStrategyDispatchEnabled");
  const fields = $("adminStrategyDispatchFields");
  if (!panel || !checkbox || !fields) return;
  const canUse = isAdminStrategyDispatchUser() && Boolean(state.adminStrategyDispatchCapabilities?.enabled);
  panel.hidden = !canUse;
  if (!canUse) checkbox.checked = false;
  fields.hidden = !canUse || !checkbox.checked;
  checkbox.disabled = !canUse;
  checkbox.setAttribute("aria-expanded", String(canUse && checkbox.checked));
  renderAdminStrategyDispatchStrategyOptions();
  syncAdminStrategyDispatchOrderType();
  renderAdminStrategyDispatchProgress();
}

async function loadAdminStrategyDispatchCapabilities({ force = false } = {}) {
  if (!isAdminStrategyDispatchUser() || !state.token) {
    state.adminStrategyDispatchCapabilities = { enabled:false, supported_entry_methods:[] };
    state.adminStrategyDispatchCapabilitiesLoaded = true;
    renderAdminStrategyDispatchControls();
    return state.adminStrategyDispatchCapabilities;
  }
  if (!force && state.adminStrategyDispatchCapabilitiesLoaded) return state.adminStrategyDispatchCapabilities;
  try {
    const data = await api("/api/admin/strategy-trades/capabilities", { timeout:10000 });
    const methods = Array.isArray(data?.supported_entry_methods) ? data.supported_entry_methods.map(value => String(value).toLowerCase()) : [];
    state.adminStrategyDispatchCapabilities = {
      enabled: Boolean(data?.enabled) && (!methods.length || methods.includes("market")),
      supported_entry_methods: methods,
    };
  } catch (error) {
    state.adminStrategyDispatchCapabilities = { enabled:false, supported_entry_methods:[] };
    console.warn("[AdminStrategyDispatch] capabilities unavailable:", error?.message || error);
  } finally {
    state.adminStrategyDispatchCapabilitiesLoaded = true;
    renderAdminStrategyDispatchControls();
  }
  return state.adminStrategyDispatchCapabilities;
}

async function ensureAdminStrategyDispatchReady() {
  if (!isAdminStrategyDispatchUser() || !state.token) return false;
  const capabilities = await loadAdminStrategyDispatchCapabilities();
  if (!capabilities.enabled) return false;
  if (!activePlatformStrategyOptions().length) await loadStrategyCatalog().catch(error => console.warn("[AdminStrategyDispatch] strategy catalog unavailable:", error?.message || error));
  renderAdminStrategyDispatchControls();
  return true;
}

function stopAdminStrategyDispatchPolling() {
  if (state.adminStrategyDispatchPollTimer) clearTimeout(state.adminStrategyDispatchPollTimer);
  state.adminStrategyDispatchPollTimer = null;
  state.adminStrategyDispatchPollGeneration += 1;
}

function adminStrategyDispatchId(value) {
  const id = value?.id ?? value?.dispatch_id ?? value?.strategy_trade_id ?? value?.trade_id
    ?? value?.dispatch?.id ?? value?.strategy_trade?.id ?? value?.strategyTrade?.id;
  return id == null || id === "" ? "" : String(id);
}

function adminStrategyDispatchRoot(data = {}) {
  return data?.dispatch || data?.strategy_trade || data?.strategyTrade || data?.trade || data?.data?.dispatch || data?.data?.strategy_trade || data;
}

function adminStrategyDispatchPreviewRoot(data = {}) {
  return data?.preview || data?.data?.preview || data?.strategy_trade_preview || data;
}

function adminStrategyDispatchTargets(data = {}) {
  const root = adminStrategyDispatchRoot(data);
  const candidates = data?.targets || data?.target_results || data?.target_statuses || root?.targets || root?.target_results || root?.target_statuses;
  return Array.isArray(candidates) ? candidates : [];
}

function adminStrategyDispatchCounters(data = {}) {
  const root = adminStrategyDispatchRoot(data);
  const source = data?.counters || data?.summary || root?.counters || root?.summary || {};
  const read = (keys) => {
    for (const key of keys) {
      const value = Number(source?.[key] ?? root?.[key] ?? data?.[key]);
      if (Number.isFinite(value)) return value;
    }
    return 0;
  };
  const totalRaw = read(["total", "total_targets", "subscriber_total", "target_total", "target_count", "count"]);
  const targets = data?.targets || root?.targets;
  const sourceIncluded = Boolean(data?.source || root?.source || root?.source_target_id
    || (Array.isArray(targets) && targets.some(target => String(target?.target_role || "").toLowerCase() === "source")));
  return {
    total:sourceIncluded && totalRaw > 0 ? Math.max(0, totalRaw - 1) : totalRaw,
    executable:read(["executable", "executable_targets", "eligible", "eligible_targets", "eligible_target_count"]),
    excluded:read(["excluded", "excluded_targets", "ineligible", "ineligible_targets", "excluded_target_count"]),
    success:read(["success", "succeeded", "successful", "success_count"]),
    rejected:read(["rejected", "rejected_count"]),
    skipped:read(["skipped", "skipped_count"]),
    uncertain:read(["uncertain", "uncertain_count", "unknown"]),
  };
}

function adminStrategyDispatchStatus(value) {
  return String(value || "queued").trim().toLowerCase();
}

function adminStrategyDispatchStatusLabel(value) {
  const status = adminStrategyDispatchStatus(value);
  return ADMIN_STRATEGY_DISPATCH_STATUS_LABELS[status] || userVisibleText(value, "处理中");
}

function adminStrategyDispatchTargetStatus(target = {}) {
  return String(target?.status || target?.outcome || target?.result_status || target?.state || "pending").toLowerCase();
}

function adminStrategyDispatchTargetStatusLabel(value) {
  const status = adminStrategyDispatchTargetStatus({ status:value });
  return ADMIN_STRATEGY_DISPATCH_TARGET_STATUS_LABELS[status] || userVisibleText(value, "处理中");
}

function adminStrategyDispatchTargetReason(target = {}) {
  return localizeReason(target?.reason_code || target?.reason || target?.message || target?.error || target?.exclusion_reason || "");
}

function adminStrategyDispatchTargetLabel(target = {}) {
  const parts = [target?.user_account, target?.user_nickname]
    .map(value => String(value || "").trim())
    .filter(Boolean);
  return [...new Set(parts)].join(" · ") || "订阅目标";
}

function adminStrategyDispatchPreviewTargetRows(preview = {}) {
  const candidates = preview?.targets || preview?.target_results || preview?.target_statuses;
  return Array.isArray(candidates) ? candidates : [];
}

function adminStrategyDispatchPreviewTargetValid(target = {}) {
  const value = target?.valid ?? target?.eligible ?? target?.is_eligible ?? target?.executable ?? target?.is_valid;
  if (value === true || value === 1) return true;
  return ["true", "1", "yes", "eligible", "executable", "allowed"].includes(String(value || "").trim().toLowerCase());
}

function adminStrategyDispatchPreviewTargetIdentity(target = {}) {
  const targetRole = String(target?.target_role || target?.role || "").trim().toLowerCase();
  const subscriptionId = target?.subscription_id ?? target?.subscription?.id;
  if (Number.isFinite(Number(subscriptionId)) && Number(subscriptionId) > 0) return `subscription:${Number(subscriptionId)}`;
  const account = target?.account || target?.snapshot?.account || target?.account_snapshot || {};
  const accountId = target?.trading_account_id ?? target?.account_id ?? account?.id;
  if (Number.isFinite(Number(accountId)) && Number(accountId) > 0) return `${targetRole || "account"}:${Number(accountId)}`;
  const broker = target?.broker_server || target?.broker?.server || account?.broker_server;
  const login = target?.login_account || target?.broker?.login || account?.login_account;
  if (broker || login) return `broker:${String(broker || "").trim().toUpperCase()}|login:${String(login || "").trim()}`;
  const userId = target?.user_id ?? target?.user?.id;
  if (userId != null && String(userId).trim()) return `user:${String(userId).trim()}`;
  return "";
}

function adminStrategyDispatchPreviewUniqueTargets(targets = []) {
  const seen = new Set();
  return targets.filter((target, index) => {
    if (!target || typeof target !== "object") return false;
    const identity = adminStrategyDispatchPreviewTargetIdentity(target) || `row:${index}`;
    if (seen.has(identity)) return false;
    seen.add(identity);
    return true;
  });
}

function adminStrategyDispatchPreviewEligibleTargets(preview = {}) {
  const sourceCandidates = [preview?.source, preview?.source_account]
    .filter(target => target && typeof target === "object")
    .filter(adminStrategyDispatchPreviewTargetValid);
  const targetRows = adminStrategyDispatchPreviewTargetRows(preview)
    .filter(adminStrategyDispatchPreviewTargetValid);
  const explicitRows = ["eligible_targets", "executable_targets", "valid_targets"]
    .flatMap(key => Array.isArray(preview?.[key]) ? preview[key] : []);
  return adminStrategyDispatchPreviewUniqueTargets([...sourceCandidates, ...targetRows, ...explicitRows]);
}

function adminStrategyDispatchPreviewExcludedTargets(preview = {}) {
  const rows = ["exclusions", "excluded", "excluded_targets", "ineligible_targets"]
    .flatMap(key => Array.isArray(preview?.[key]) ? preview[key] : []);
  return adminStrategyDispatchPreviewUniqueTargets(rows);
}

function adminStrategyDispatchPreviewTargetRow(target, { excluded = false } = {}) {
  const targetRole = String(target?.target_role || target?.role || "").toLowerCase();
  const fallbackLabel = targetRole === "source" ? "管理员源账户" : "订阅目标";
  const label = adminStrategyDispatchTargetLabel(target) === "订阅目标" && targetRole === "source"
    ? fallbackLabel : adminStrategyDispatchTargetLabel(target);
  const reason = excluded ? adminStrategyDispatchTargetReason(target) || "未满足执行条件" : "";
  return `<li class="admin-strategy-dispatch-detail-row ${excluded ? "is-excluded" : "is-executable"}"><span><strong>${escapeHtml(label)}</strong>${reason ? `<small>${escapeHtml(reason)}</small>` : ""}</span><em>${excluded ? "排除" : "可执行"}</em></li>`;
}

function renderAdminStrategyDispatchProgress() {
  const panel = $("adminStrategyDispatchProgress");
  const summary = $("adminStrategyDispatchProgressSummary");
  const targetsHost = $("adminStrategyDispatchProgressTargets");
  const retry = $("adminStrategyDispatchRetry");
  if (!panel || !summary || !targetsHost || !retry) return;
  const dispatch = state.adminStrategyDispatch;
  if (!isAdminStrategyDispatchUser() || !state.adminStrategyDispatchCapabilities?.enabled || !dispatch) {
    panel.hidden = true;
    summary.innerHTML = "";
    targetsHost.innerHTML = "";
    retry.hidden = true;
    return;
  }
  panel.hidden = false;
  const root = adminStrategyDispatchRoot(dispatch);
  const status = adminStrategyDispatchStatus(root?.status || root?.phase || root?.dispatch_status);
  const counters = adminStrategyDispatchCounters(dispatch);
  const sourceAccount = root?.source_account || root?.source || dispatch?.source_account || {};
  const sourceSnapshot = sourceAccount?.snapshot || sourceAccount?.account_snapshot || {};
  const sourceText = sourceAccount?.login_account || sourceAccount?.login || sourceAccount?.account || sourceAccount?.name || sourceSnapshot?.account?.login_account || sourceSnapshot?.account?.nickname || root?.source_login || root?.source_account_login || "管理员源账户";
  const targets = adminStrategyDispatchTargets(dispatch);
  const sourceTarget = targets.find(target => String(target?.target_role || "").toLowerCase() === "source");
  const sourceStage = sourceTarget?.status || root?.source_stage || root?.source_order_stage || root?.source_status || root?.phase || status;
  const total = counters.total || counters.executable + counters.excluded || 0;
  summary.innerHTML = `<div class="admin-strategy-dispatch-summary-grid"><span><small>源账户</small><strong>${escapeHtml(sourceText)}</strong></span><span><small>源订单阶段</small><strong>${escapeHtml(adminStrategyDispatchStatusLabel(sourceStage))}</strong></span><span><small>订阅总数</small><strong>${total}</strong></span><span><small>可执行</small><strong>${counters.executable}</strong></span><span><small>成功</small><strong>${counters.success}</strong></span><span><small>拒绝 / 跳过 / 待确认</small><strong>${counters.rejected} / ${counters.skipped} / ${counters.uncertain}</strong></span></div>`;
  targetsHost.innerHTML = targets.length ? targets.map(target => {
    const targetStatus = adminStrategyDispatchTargetStatus(target);
    const label = adminStrategyDispatchTargetLabel(target);
    const reason = adminStrategyDispatchTargetReason(target);
    return `<div class="admin-strategy-dispatch-target-row ${escapeHtml(targetStatus)}"><span><strong>${escapeHtml(label)}</strong><small>${escapeHtml(target?.symbol || root?.symbol || "--")}${target?.volume != null ? ` · ${escapeHtml(volumeText(target.volume))}` : ""}</small></span><span class="status-chip ${targetStatus === "success" || targetStatus === "succeeded" || targetStatus === "completed" ? "success" : targetStatus === "rejected" || targetStatus === "failed" ? "danger" : targetStatus === "uncertain" ? "warning" : "info"}">${escapeHtml(adminStrategyDispatchTargetStatusLabel(targetStatus))}</span>${reason ? `<em title="${escapeHtml(reason)}">${escapeHtml(reason)}</em>` : ""}</div>`;
  }).join("") : `<p class="admin-strategy-dispatch-empty">暂无逐目标结果，刷新以恢复进度。</p>`;
  const failedTargets = targets.filter(target => ["failed", "failed_manual_review", "rejected"].includes(adminStrategyDispatchTargetStatus(target)));
  retry.hidden = !failedTargets.length || ["completed", "succeeded", "cancelled", "cancelled_before_send", "expired"].includes(status);
  retry.disabled = false;
  initIcons();
}

function scheduleAdminStrategyDispatchRefresh() {
  stopAdminStrategyDispatchPolling();
  if (!state.adminStrategyDispatch) return;
  const status = adminStrategyDispatchStatus(adminStrategyDispatchRoot(state.adminStrategyDispatch)?.status || adminStrategyDispatchRoot(state.adminStrategyDispatch)?.phase);
  if (["completed", "succeeded", "failed", "cancelled", "cancelled_before_send", "expired"].includes(status)) return;
  const generation = state.adminStrategyDispatchPollGeneration;
  state.adminStrategyDispatchPollTimer = setTimeout(() => {
    if (generation !== state.adminStrategyDispatchPollGeneration) return;
    refreshAdminStrategyDispatch({ silent:true }).catch(() => {});
  }, 4000);
}

async function refreshAdminStrategyDispatch({ silent = false } = {}) {
  if (!isAdminStrategyDispatchUser()) return null;
  const id = adminStrategyDispatchId(state.adminStrategyDispatch);
  if (!id) return null;
  try {
    const data = await api(`/api/admin/strategy-trades/${encodeURIComponent(id)}`, { timeout:15000 });
    state.adminStrategyDispatch = data;
    renderAdminStrategyDispatchProgress();
    scheduleAdminStrategyDispatchRefresh();
    return state.adminStrategyDispatch;
  } catch (error) {
    const errorHost = $("adminStrategyDispatchProgressError");
    if (errorHost) errorHost.textContent = error.message || "分发状态刷新失败";
    if (!silent) toast(error.message || "分发状态刷新失败", "error");
    return null;
  }
}

async function retryAdminStrategyDispatch() {
  if (!isAdminStrategyDispatchUser()) return;
  const id = adminStrategyDispatchId(state.adminStrategyDispatch);
  if (!id) return;
  const button = $("adminStrategyDispatchRetry");
  if (button) { button.disabled = true; button.setAttribute("aria-busy", "true"); }
  try {
    await api(`/api/admin/strategy-trades/${encodeURIComponent(id)}/retry`, { method:"POST", body:{}, timeout:20000 });
    toast("失败目标已提交重试", "success");
    await refreshAdminStrategyDispatch();
  } catch (error) {
    toast(error.message || "重试失败", "error");
  } finally {
    if (button) { button.disabled = false; button.removeAttribute("aria-busy"); }
  }
}

function strategyDispatchClientRequestId() {
  return globalThis.crypto?.randomUUID?.() || `admin-strategy-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function buildAdminStrategyDispatchPreview(direction) {
  if (!isAdminStrategyDispatchUser() || !state.adminStrategyDispatchCapabilities?.enabled) throw new Error("当前账号不可使用平台策略分发");
  if (!adminStrategyDispatchModeEnabled()) throw new Error("请先开启按平台策略分发");
  if (!["buy", "sell"].includes(String(direction))) throw new Error("平台策略分发仅支持 BUY / SELL");
  if (String(state.selectedOrderType || "market") !== "market") throw new Error("平台策略分发仅支持市价单");
  const symbol = String($("tradeSymbolSelect")?.value || "").trim().toUpperCase();
  const strategyId = Number($("adminStrategyDispatchStrategy")?.value || 0);
  const strategy = activePlatformStrategyOptions().find(item => Number(item.id) === strategyId);
  const sourceAccount = currentSubscriptionAccount();
  const sourceAccountId = Number(sourceAccount?.id ?? sourceAccount?.trading_account_id ?? 0);
  const stopLoss = manualTargetPrice("stopLossPoints", "止损价格");
  const takeProfit = manualTargetPrice("takeProfitPoints", "止盈价格");
  const volume = Number($("tradeVolume")?.value);
  const validMinutes = Number($("adminStrategyDispatchValidMinutes")?.value);
  const reason = String($("adminStrategyDispatchReason")?.value || "").trim();
  if (!strategy) throw new Error("请选择有效的平台策略");
  if (!symbol) throw new Error("请选择交易品种");
  const supportedSymbols = adminStrategyDispatchStrategySymbols(strategy);
  if (supportedSymbols.length && !supportedSymbols.some(value => standardMarketSymbol(value) === standardMarketSymbol(symbol))) throw new Error("当前品种不在所选平台策略支持范围内");
  if (!Number.isSafeInteger(sourceAccountId) || sourceAccountId <= 0) throw new Error("当前没有可用的管理员交易账户");
  if (!Number.isFinite(volume) || volume <= 0) throw new Error("交易手数必须是大于 0 的有效数字");
  if (!Number.isInteger(validMinutes) || validMinutes < 1 || validMinutes > 1440) throw new Error("有效期必须是 1 至 1440 分钟");
  if (reason && reason.length < 2) throw new Error("中文原因填写后至少需要 2 个字");
  const quote = state.lastQuote;
  if (!quote || String(quote.symbol || "").toUpperCase() !== symbol || !Number.isFinite(Number(quote.bid)) || !Number.isFinite(Number(quote.ask))) throw new Error("当前品种报价未就绪，请先刷新报价");
  const clientRequestId = strategyDispatchClientRequestId();
  const validUntil = Date.now() + validMinutes * 60_000;
  const payload = {
    strategy_id:strategyId, trading_account_id:sourceAccountId, symbol, direction:String(direction), entry_method:"market",
    stop_loss:stopLoss, take_profit:takeProfit, take_profit_1:takeProfit, volume,
    valid_minutes:validMinutes,
    valid_until:validUntil, valid_until_utc_msc:validUntil, reason, client_request_id:clientRequestId, idempotency_key:clientRequestId,
  };
  return { payload, meta:{ strategy, sourceAccount, symbol, direction:String(direction), stopLoss, takeProfit, volume, validMinutes, validUntil, reason } };
}

function adminStrategyDispatchProtectionDisplay(value) {
  return value == null ? "未设置" : priceDisplay(value);
}

function renderAdminStrategyDispatchPreview(order, data) {
  const host = $("adminStrategyDispatchPreviewBody");
  if (!host) return;
  const preview = adminStrategyDispatchPreviewRoot(data);
  const counters = adminStrategyDispatchCounters(preview);
  const source = preview?.source_account || preview?.source || {};
  const sourceSnapshot = source?.snapshot || source?.account_snapshot || {};
  const sourceText = source?.login_account || source?.login || source?.account || source?.name || sourceSnapshot?.account?.login_account || sourceSnapshot?.account?.nickname || "管理员源账户";
  const executableRows = adminStrategyDispatchPreviewEligibleTargets(preview);
  const excludedRows = adminStrategyDispatchPreviewExcludedTargets(preview);
  const executableCount = counters.executable || executableRows.length;
  const excludedCount = counters.excluded || excludedRows.length;
  const executableItems = executableRows.length
    ? executableRows.map(target => adminStrategyDispatchPreviewTargetRow(target)).join("")
    : `<li class="admin-strategy-dispatch-detail-empty">${executableCount ? "接口未返回可执行账号明细，请刷新后重试。" : "暂无可执行账号"}</li>`;
  const excludedItems = excludedRows.length
    ? excludedRows.map(target => adminStrategyDispatchPreviewTargetRow(target, { excluded:true })).join("")
    : `<li class="admin-strategy-dispatch-detail-empty">${excludedCount ? "接口未返回排除账号明细，请刷新后重试。" : "暂无排除账号"}</li>`;
  const stopLossText = adminStrategyDispatchProtectionDisplay(order.meta.stopLoss);
  const takeProfitText = adminStrategyDispatchProtectionDisplay(order.meta.takeProfit);
  host.innerHTML = `<div class="admin-strategy-dispatch-preview-banner"><strong>管理员策略指令</strong><span>二次确认后才会创建分发，不会改写普通手动下单。</span></div><div><span>源账户</span><strong>${escapeHtml(sourceText)}</strong></div><div><span>方向 / 品种</span><strong>${escapeHtml(order.meta.direction.toUpperCase())} · ${escapeHtml(order.meta.symbol)}</strong></div><div><span>平台策略</span><strong>${escapeHtml(order.meta.strategy.title || `#${order.meta.strategy.id}`)}</strong></div><div><span>交易手数</span><strong>${escapeHtml(String(order.meta.volume))} 手</strong></div><div><span>止损 / 止盈</span><strong>${escapeHtml(stopLossText)} / ${escapeHtml(takeProfitText)}</strong></div><div><span>订阅总数</span><strong>${counters.total}</strong></div><div><span>可执行 / 排除</span><strong>${counters.executable} / ${counters.excluded}</strong></div><details class="admin-strategy-dispatch-target-details"><summary><span>查看账号明细</span><small>可执行与排除账号</small><i data-lucide="chevron-down" size="15" aria-hidden="true"></i></summary><div class="admin-strategy-dispatch-details-body"><section class="admin-strategy-dispatch-detail-section admin-strategy-dispatch-executable"><div class="admin-strategy-dispatch-detail-heading"><strong>可执行账号</strong><span>${executableCount}</span></div><ul>${executableItems}</ul></section><section class="admin-strategy-dispatch-detail-section admin-strategy-dispatch-exclusion"><div class="admin-strategy-dispatch-detail-heading"><strong>排除账号</strong><span>${excludedCount}</span></div><ul>${excludedItems}</ul></section></div></details><div class="admin-strategy-dispatch-reason"><span>中文原因</span><strong>${escapeHtml(order.meta.reason || "未填写")}</strong></div>`;
  $("adminStrategyDispatchModal")?.classList.remove("hidden");
  document.body.classList.add("modal-open");
  initIcons();
}

function closeAdminStrategyDispatchModal() {
  state.adminStrategyDispatchPreview = null;
  state.adminStrategyDispatchPending = null;
  $("adminStrategyDispatchModal")?.classList.add("hidden");
  if ($("orderConfirmModal")?.classList.contains("hidden") && $("manualInferenceModal")?.classList.contains("hidden")) document.body.classList.remove("modal-open");
}

async function openAdminStrategyDispatch(direction) {
  if (!isAdminStrategyDispatchUser() || !state.adminStrategyDispatchCapabilities?.enabled) return;
  try {
    const order = buildAdminStrategyDispatchPreview(direction);
    const previewResponse = await api("/api/admin/strategy-trades/preview", { method:"POST", body:order.payload, timeout:30000 });
    const preview = adminStrategyDispatchPreviewRoot(previewResponse);
    const previewHash = previewResponse?.preview_hash || preview?.preview_hash || preview?.hash || null;
    if (previewHash) order.payload.preview_hash = previewHash;
    state.adminStrategyDispatchPending = order;
    state.adminStrategyDispatchPreview = previewResponse;
    renderAdminStrategyDispatchPreview(order, previewResponse);
  } catch (error) {
    toast(error.message || "分发预览失败", "error");
  }
}

async function createAdminStrategyDispatch() {
  const order = state.adminStrategyDispatchPending;
  if (!order || !isAdminStrategyDispatchUser()) return;
  const button = $("adminStrategyDispatchModalConfirm");
  if (button) { button.disabled = true; button.setAttribute("aria-busy", "true"); }
  try {
    const preview = adminStrategyDispatchPreviewRoot(state.adminStrategyDispatchPreview || {});
    const body = { ...order.payload, preview_hash:order.payload.preview_hash || preview?.preview_hash, confirm:true };
    const result = await api("/api/admin/strategy-trades", { method:"POST", body, timeout:30000 });
    state.adminStrategyDispatch = result;
    closeAdminStrategyDispatchModal();
    renderAdminStrategyDispatchProgress();
    toast("管理员策略指令已创建，正在跟踪源单与订阅目标", "success");
    await refreshAdminStrategyDispatch({ silent:true });
  } catch (error) {
    toast(error.message || "创建分发失败", "error");
  } finally {
    if (button) { button.disabled = false; button.removeAttribute("aria-busy"); }
  }
}

function strategyDispatchSignalSourceLabel(signal = {}) {
  const raw = String(signal?.source || signal?.source_type || signal?.origin || signal?.execution_source || "").toLowerCase();
  if (raw === "admin_strategy_dispatch" || raw === "admin_strategy_trade" || signal?.admin_strategy_dispatch_id || signal?.strategy_dispatch_id) return "管理员策略指令";
  return "";
}

function strategyMarketPlan(strategy) {
  const fallback = { primary_timeframe:"M30", timeframes:[{ timeframe:"M30", kline_count:100 }] };
  const plan = parseJsonField(strategy?.market_data_plan_json, fallback);
  return Array.isArray(plan?.timeframes) && plan.timeframes.length ? plan : fallback;
}

const STRATEGY_CHAN_TIMEFRAMES = Object.freeze(["M5", "M15", "H1", "H4"]);
const STRATEGY_DATA_CAPABILITY_FALLBACK = Object.freeze({
  version: "local-fallback",
  timeframes: ["M1", "M5", "M15", "M30", "H1", "H4", "D1"],
  base_market_data: { label: "基础行情与技术摘要" },
  chan: { supported_timeframes: [...STRATEGY_CHAN_TIMEFRAMES], label: "缠论结构数据" },
  indicators: { ema34: { kind: "ema", period: 34, field: "close", bar_scope: "closed_only", warmup_target_bars: 60, evidence_window: 5 } },
  portfolio_context: { label: "持仓与挂单", private_only: true },
  user_copy: {
    chan: "为已选的支持周期计算并提供原始结构。不会自动决定方向，也不会强制观望或交易。",
    ema34: "按所选周期的已收盘 K 线计算并提供。不会自动作为开仓过滤条件。",
  },
});

function normalizedStrategyDataCapabilities(value = {}) {
  const source = value?.capabilities && typeof value.capabilities === "object" ? value.capabilities : value;
  const fallback = structuredClone(STRATEGY_DATA_CAPABILITY_FALLBACK);
  const timeframes = Array.isArray(source?.timeframes)
    ? source.timeframes.map(item => String(item?.timeframe || item || "").toUpperCase()).filter(Boolean)
    : fallback.timeframes;
  const chan = source?.chan && typeof source.chan === "object" ? source.chan : {};
  const indicators = source?.indicators && typeof source.indicators === "object" ? source.indicators : {};
  const ema34 = indicators.ema34 && typeof indicators.ema34 === "object" ? indicators.ema34 : {};
  return {
    ...fallback,
    ...source,
    version: String(source?.version || source?.catalog_version || fallback.version),
    timeframes: timeframes.length ? timeframes : fallback.timeframes,
    base_market_data: { ...fallback.base_market_data, ...(source?.base_market_data || source?.baseMarketData || {}) },
    chan: { ...fallback.chan, ...chan, supported_timeframes: Array.isArray(chan.supported_timeframes) ? chan.supported_timeframes.map(value => String(value).toUpperCase()) : fallback.chan.supported_timeframes },
    indicators: { ...fallback.indicators, ...indicators, ema34: { ...fallback.indicators.ema34, ...ema34 } },
    portfolio_context: { ...fallback.portfolio_context, ...(source?.portfolio_context || {}) },
    user_copy: { ...fallback.user_copy, ...(source?.user_copy || source?.copy || {}) },
  };
}

async function loadStrategyDataCapabilities({ force = false, render = true } = {}) {
  if (!force && state.strategyDataCapabilitiesStatus === "ready" && state.strategyDataCapabilities) return state.strategyDataCapabilities;
  if (!force && state.strategyDataCapabilitiesStatus === "loading" && state.strategyDataCapabilitiesRequest) return state.strategyDataCapabilitiesRequest;
  const requestVersion = Number(state.strategyDataCapabilitiesRequestVersion || 0) + 1;
  state.strategyDataCapabilitiesRequestVersion = requestVersion;
  state.strategyDataCapabilitiesStatus = "loading";
  const request = api("/api/ai/strategy-data-capabilities").then(data => {
    if (requestVersion !== Number(state.strategyDataCapabilitiesRequestVersion)) return state.strategyDataCapabilities;
    state.strategyDataCapabilities = normalizedStrategyDataCapabilities(data);
    state.strategyDataCapabilitiesStatus = "ready";
    if (render) syncStrategyDataCapabilityUI();
    return state.strategyDataCapabilities;
  }).catch(error => {
    if (requestVersion === Number(state.strategyDataCapabilitiesRequestVersion)) {
      state.strategyDataCapabilitiesStatus = "error";
      state.strategyDataCapabilitiesError = error;
      syncStrategyDataCapabilityUI();
    }
    throw error;
  }).finally(() => {
    if (requestVersion === Number(state.strategyDataCapabilitiesRequestVersion)) state.strategyDataCapabilitiesRequest = null;
  });
  state.strategyDataCapabilitiesRequest = request;
  return request;
}

function strategyPolicyObject(strategy = {}) {
  const value = parseJsonField(strategy?.strategy_policy_json, strategy?.strategy_policy_json || null);
  return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}

function strategyIndicatorDeclarations(strategy = {}) {
  const direct = parseJsonField(strategy?.indicator_declarations, strategy?.indicator_declarations || null);
  if (Array.isArray(direct)) return structuredClone(direct);
  const policy = strategyPolicyObject(strategy);
  return Array.isArray(policy?.indicators) ? structuredClone(policy.indicators) : [];
}

function strategyIndicatorLooksLikeEma34(declaration = {}) {
  const id = String(declaration?.id || "").toLowerCase();
  const kind = String(declaration?.kind || declaration?.type || "").toLowerCase();
  const period = Number(declaration?.params?.period ?? declaration?.period);
  return id === "ema34" || id === "entry_ema34" || (kind === "ema" && period === 34);
}

function strategyIndicatorIsCanonicalEma34(declaration = {}) {
  const id = String(declaration?.id || "").toLowerCase();
  const kind = String(declaration?.kind || declaration?.type || "").toLowerCase();
  const period = Number(declaration?.params?.period ?? declaration?.period);
  const field = String(declaration?.source?.field || declaration?.field || "close").toLowerCase();
  const barScope = String(declaration?.source?.bar_scope || declaration?.bar_scope || "closed_only").toLowerCase();
  return id === "ema34" && kind === "ema" && period === 34 && field === "close" && barScope === "closed_only";
}

function strategyEma34State(strategy = {}) {
  const policy = strategyPolicyObject(strategy);
  const declarations = strategyIndicatorDeclarations(strategy);
  const candidates = declarations.filter(strategyIndicatorLooksLikeEma34);
  const canonical = candidates.find(strategyIndicatorIsCanonicalEma34) || null;
  const advanced = candidates.some(item => !strategyIndicatorIsCanonicalEma34(item));
  const advancedDeclaration = candidates.find(item => !strategyIndicatorIsCanonicalEma34(item)) || null;
  const legacyEnabled = Boolean(Number(strategy?.["use_ema34_filter"] || 0));
  const capability = strategy?.data_capabilities?.ema34 && typeof strategy.data_capabilities.ema34 === "object" ? strategy.data_capabilities.ema34 : null;
  const capabilityStatus = String(capability?.status || "").toLowerCase();
  return {
    policy,
    declarations,
    canonical: canonical || (capabilityStatus === "managed" ? { id:"ema34", kind:"ema", enabled:capability.enabled !== false, source:{ timeframe:capability.timeframe } } : null),
    advanced: capabilityStatus === "advanced" || advanced,
    advancedDeclaration,
    enabled: capability ? capability.enabled !== false : Boolean((canonical || advancedDeclaration) && (canonical || advancedDeclaration).enabled !== false),
    legacyOnly: capabilityStatus === "legacy_unconfigured" || (legacyEnabled && !canonical && !advanced),
    capabilityStatus,
    capabilityTimeframe: String(capability?.timeframe || advancedDeclaration?.source?.timeframe || canonical?.source?.timeframe || "").toUpperCase(),
    policyMode: String(policy?.mode || "").toLowerCase(),
  };
}

function canonicalEma34Declaration(timeframe) {
  return {
    id: "ema34",
    kind: "ema",
    enabled: true,
    source: { timeframe: String(timeframe || "").toUpperCase(), field: "close", bar_scope: "closed_only" },
    params: { period: 34, minimum_bars: 34, warmup_target_bars: 60, evidence_window: 5 },
  };
}

function strategyEditorMarketPlanFromControls() {
  const timeframes = [...document.querySelectorAll("[data-strategy-timeframe]:checked")].map(input => ({
    timeframe: String(input.dataset.strategyTimeframe || "").toUpperCase(),
    kline_count: Number(document.querySelector(`[data-strategy-kline="${input.dataset.strategyTimeframe}"]`)?.value) || 100,
  })).filter(item => item.timeframe);
  const primary = document.querySelector('input[name="strategyPrimaryTimeframe"]:checked')?.value;
  return { primary_timeframe: timeframes.some(item => item.timeframe === primary) ? primary : timeframes[0]?.timeframe || "", timeframes };
}

function strategyEditorSelectedTimeframes() {
  return strategyEditorMarketPlanFromControls().timeframes.map(item => String(item.timeframe).toUpperCase());
}

function strategyEditorDataError(message = "") {
  const node = $("strategyEditorError");
  if (!node) return;
  const text = String(message || "").trim();
  node.hidden = !text;
  node.textContent = text;
}

function strategyCapabilityStatusText(enabled, label, extra = "") {
  return `${label} · ${enabled ? "已提供" : "未提供"}${extra ? ` · ${extra}` : ""}`;
}

function strategyDataSummaryMarkup({ plan, chanEnabled, chanTimeframes, emaEnabled, emaTimeframe, includePortfolio, portfolioScope = "private", entryMethods, loading = false } = {}) {
  const methodLabels = { market: "市价", limit: "限价挂单", stop: "突破挂单", stop_limit: "突破限价" };
  const rows = plan.timeframes.length
    ? plan.timeframes.map(item => `<li><span>${escapeHtml(item.timeframe)}</span><strong>${Number(item.kline_count || 0)} 根 K 线及基础技术摘要</strong></li>`).join("")
    : "<li><span>基础行情</span><strong>尚未选择行情周期</strong></li>";
  const attachmentRows = [
    chanEnabled ? `<li><span>缠论结构</span><strong>${escapeHtml(chanTimeframes.join("、") || "等待支持周期")}</strong></li>` : "",
    emaEnabled ? `<li><span>EMA34</span><strong>${escapeHtml(emaTimeframe || "等待选择周期")} · 已收盘 K 线</strong></li>` : "",
    `<li><span>持仓与挂单</span><strong>${portfolioScope === "platform" ? "策略参考数据 · 运行时自动提供（可能为空或不可用）" : includePortfolio ? "已提供" : "未提供"}</strong></li>`,
  ].filter(Boolean).join("");
  return `<div class="strategy-data-summary-heading"><strong>本策略将收到</strong><span class="status-chip">${loading ? "正在读取能力" : "实时更新"}</span></div><div class="strategy-data-summary-body"><section><h4>基础行情</h4><ul>${rows}</ul></section><section><h4>附加数据</h4><ul>${attachmentRows}</ul></section><section><h4>输出能力</h4><p>${escapeHtml(entryMethods.map(item => methodLabels[item] || item).join("、") || "尚未选择")}</p></section></div>`;
}

function strategyDataTechnicalMarkup({ plan, chanEnabled, chanTimeframes, emaEnabled, emaTimeframe, emaIndicatorId = "ema34" } = {}) {
  const fields = {
    market_data_plan: plan,
    chan: chanEnabled ? { field: "strategy_context.timeframes.*.summary.chan", timeframes: chanTimeframes } : null,
    ema34: emaEnabled ? { id: emaIndicatorId, field: `strategy_context.indicators.${emaIndicatorId}`, source: { timeframe: emaTimeframe, field: "close", bar_scope: "closed_only" } } : null,
  };
  return JSON.stringify(fields, null, 2);
}

function strategyWritingTemplates({ chanEnabled, chanTimeframes, emaEnabled, emaTimeframe } = {}) {
  const templates = [];
  if (chanEnabled) templates.push({ key: "chan", title: "缠论结构用途", text: `【缠论结构用途】\n- 使用周期：${chanTimeframes.join("、") || "请填写"}\n- 用途：{方向判断 / 入场确认 / 风险参考 / 其他，请填写}\n- 有效结构条件：{请填写}\n- 多周期冲突处理：{请填写}` });
  if (emaEnabled) templates.push({ key: "ema34", title: "EMA34 用途", text: `【EMA34 用途】\n- 使用周期：${emaTimeframe || "请填写"}\n- 用途：{趋势过滤 / 入场确认 / 仅作参考 / 其他，请填写}\n- 多头条件：{请填写}\n- 空头条件：{请填写}\n- 不满足条件时：{请填写}` });
  return templates;
}

function renderStrategyWritingTemplates(model) {
  const host = $("strategyWritingTemplates");
  if (!host) return;
  const templates = strategyWritingTemplates(model);
  host.innerHTML = templates.length ? templates.map(item => `<article class="strategy-writing-template"><div><strong>${escapeHtml(item.title)}</strong><pre>${escapeHtml(item.text)}</pre></div><div class="strategy-writing-template-actions"><button type="button" class="btn btn-secondary btn-sm" data-strategy-template-action="copy" data-strategy-template-key="${escapeHtml(item.key)}">复制写法模板</button><button type="button" class="btn btn-ghost btn-sm" data-strategy-template-action="insert" data-strategy-template-key="${escapeHtml(item.key)}">插入到光标位置</button></div></article>`).join("") : "<p class=\"strategy-writing-empty\">开启缠论或 EMA34 后，这里会显示可主动使用的写法模板。</p>";
  host.dataset.templates = JSON.stringify(Object.fromEntries(templates.map(item => [item.key, item.text])));
}

async function copyStrategyTemplate(text) {
  if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(text);
  else {
    const helper = document.createElement("textarea"); helper.value = text; helper.setAttribute("readonly", ""); helper.style.position = "fixed"; helper.style.opacity = "0"; document.body.appendChild(helper); helper.select(); document.execCommand("copy"); helper.remove();
  }
  toast("写法模板已复制，不会自动修改策略正文", "success");
}

function insertStrategyTemplate(text) {
  const textarea = $("strategyPrompt");
  if (!textarea) return;
  const start = Number.isInteger(textarea.selectionStart) ? textarea.selectionStart : textarea.value.length;
  const end = Number.isInteger(textarea.selectionEnd) ? textarea.selectionEnd : start;
  const prefix = start > 0 && !/[\n\r]$/.test(textarea.value.slice(0, start)) ? "\n\n" : "";
  const insertion = `${prefix}${text}`;
  if (typeof textarea.setRangeText === "function") textarea.setRangeText(insertion, start, end, "end");
  else textarea.value = `${textarea.value.slice(0, start)}${insertion}${textarea.value.slice(end)}`;
  textarea.focus();
  textarea.dispatchEvent(new Event("input", { bubbles: true }));
  toast("模板已插入光标位置，策略正文仍由你决定", "success");
}

function syncStrategyEditorMarketPlanControls() {
  const selected = strategyEditorSelectedTimeframes();
  document.querySelectorAll("[data-strategy-timeframe]").forEach(input => {
    const timeframe = String(input.dataset.strategyTimeframe || "").toUpperCase();
    const checked = input.checked;
    const kline = document.querySelector(`[data-strategy-kline="${input.dataset.strategyTimeframe}"]`);
    const radio = document.querySelector(`input[name="strategyPrimaryTimeframe"][value="${timeframe}"]`);
    if (kline) kline.disabled = !checked;
    if (radio) {
      radio.disabled = !checked;
      if (!checked) radio.checked = false;
    }
  });
  if (!document.querySelector('input[name="strategyPrimaryTimeframe"]:checked')) {
    document.querySelector(`input[name="strategyPrimaryTimeframe"][value="${selected[0]}"]`)?.click();
  }
  return selected;
}

function syncStrategyDataCapabilityUI() {
  const editor = $("strategyEditor");
  if (!editor || editor.classList.contains("hidden")) return;
  const strategy = editor._strategyDraft || {};
  const capabilities = state.strategyDataCapabilities || normalizedStrategyDataCapabilities({});
  const plan = strategyEditorMarketPlanFromControls();
  const selectedTimeframes = plan.timeframes.map(item => String(item.timeframe).toUpperCase());
  const supported = (capabilities.chan?.supported_timeframes || STRATEGY_CHAN_TIMEFRAMES).map(value => String(value).toUpperCase());
  const chanTimeframes = selectedTimeframes.filter(value => supported.includes(value));
  const chan = $("strategyUseChanAnalysis");
  const ema = $("strategyUseEma34Data");
  const emaSelect = $("strategyEma34Timeframe");
  const emaState = strategyEma34State(strategy);
  editor._strategyEmaState = emaState;
  // Read the persisted value only while the editor is being initialized.
  // Subsequent syncs are driven by user events and must preserve that choice.
  if (ema && !editor.dataset.strategyEmaInitialized) ema.checked = emaState.enabled;
  if (chan) {
    // Keep an invalid legacy selection reversible: users must still be able to
    // switch Chan off even when the old plan contains no supported timeframe.
    chan.disabled = !chanTimeframes.length && !chan.checked;
    chan.setAttribute("aria-expanded", String(Boolean($("strategyChanDetails")?.open)));
    if (!chanTimeframes.length && chan.checked) chan.dataset.invalid = "1";
    else delete chan.dataset.invalid;
  }
  if (emaSelect) {
    const configuredTimeframe = emaState.capabilityTimeframe || emaState.canonical?.source?.timeframe || "";
    const emaTimeframes = emaState.advanced && configuredTimeframe && !selectedTimeframes.includes(configuredTimeframe)
      ? [configuredTimeframe, ...selectedTimeframes] : selectedTimeframes;
    const previous = emaSelect.value || configuredTimeframe || selectedTimeframes[0] || "";
    emaSelect.innerHTML = emaTimeframes.map(timeframe => `<option value="${escapeHtml(timeframe)}">${escapeHtml(timeframe)} · 已收盘 K 线</option>`).join("");
    emaSelect.value = emaTimeframes.includes(previous) ? previous : emaTimeframes[0] || "";
    emaSelect.disabled = !ema?.checked || emaState.advanced || !selectedTimeframes.length;
  }
  if (ema) {
    ema.disabled = !selectedTimeframes.length && !emaState.advanced;
    ema.setAttribute("aria-expanded", String(Boolean($("strategyEma34Details")?.open)));
    ema.indeterminate = false;
  }
  const chanStatus = $("strategyChanStatus");
  if (chanStatus) chanStatus.textContent = strategyCapabilityStatusText(Boolean(chan?.checked), "缠论结构数据", chanTimeframes.length ? `周期 ${chanTimeframes.join("、")}` : "没有已选支持周期");
  const emaStatus = $("strategyEma34Status");
  if (emaStatus) {
    emaStatus.textContent = emaState.advanced
      ? `高级配置 · ${ema?.checked ? "已提供" : "已关闭"} · 开关只控制数据提供，不会覆盖高级参数`
      : emaState.legacyOnly
        ? "旧配置未产生 EMA34 数据"
        : strategyCapabilityStatusText(Boolean(ema?.checked), "EMA34 数据", emaSelect?.value ? `周期 ${emaSelect.value}` : "没有可选周期");
  }
  const chanTf = $("strategyChanTimeframes"); if (chanTf) chanTf.textContent = chanTimeframes.join("、") || "未选择支持周期";
  const advanced = $("strategyAdvancedPolicyState");
  if (advanced) {
    advanced.innerHTML = emaState.advanced
      ? `<span class="strategy-state-icon" aria-hidden="true"><i data-lucide="sliders-horizontal" size="15"></i></span><span><strong>高级配置</strong><small>周期和参数保持只读；开关仅控制是否提供 EMA34 数据。关闭后不会修改策略正文，请自行调整正文中的相关逻辑。</small></span>`
      : emaState.legacyOnly
        ? `<span class="strategy-state-icon" aria-hidden="true"><i data-lucide="info" size="15"></i></span><span><strong>旧 EMA 状态</strong><small>旧配置未产生 EMA34 数据；重新开启并保存后才会按新声明提供。</small></span>`
        : state.strategyDataCapabilitiesStatus === "error"
          ? `<span class="strategy-state-icon" aria-hidden="true"><i data-lucide="triangle-alert" size="15"></i></span><span><strong>能力目录暂不可用</strong><small>未知高级配置不会被覆盖。可以取消编辑或稍后重试。</small></span><button type="button" class="btn btn-secondary btn-sm" data-strategy-capability-retry>重试</button>`
          : "";
    advanced.hidden = !advanced.innerHTML;
  }
  const methods = [...document.querySelectorAll("[data-strategy-entry-method]:checked")].map(input => input.dataset.strategyEntryMethod);
  const includePortfolio = Boolean($("strategyIncludePortfolioContext")?.checked);
  const portfolioScope = String(strategy?.scope || (canManagePlatformAiContent() ? "platform" : "private"));
  const summary = $("strategyDataSummary");
  if (summary) summary.innerHTML = strategyDataSummaryMarkup({ plan, chanEnabled:Boolean(chan?.checked), chanTimeframes, emaEnabled:Boolean(ema?.checked), emaTimeframe:emaSelect?.value, includePortfolio, portfolioScope, entryMethods:methods, loading:state.strategyDataCapabilitiesStatus === "loading" });
  const technical = $("strategyDataTechnicalJson");
  if (technical) technical.textContent = strategyDataTechnicalMarkup({ plan, chanEnabled:Boolean(chan?.checked), chanTimeframes, emaEnabled:Boolean(ema?.checked), emaTimeframe:emaSelect?.value, emaIndicatorId:emaState.advancedDeclaration?.id || "ema34" });
  renderStrategyWritingTemplates({ chanEnabled:Boolean(chan?.checked), chanTimeframes, emaEnabled:Boolean(ema?.checked), emaTimeframe:emaSelect?.value });
  if (!editor.dataset.strategyEmaInitialized) editor.dataset.strategyEmaInitialized = "1";
  initIcons();
}

function bindStrategyDataEditorControls() {
  const editor = $("strategyEditor");
  if (!editor || editor.dataset.strategyDataBound === "1") return;
  editor.dataset.strategyDataBound = "1";
  const refresh = () => { syncStrategyEditorMarketPlanControls(); syncStrategyDataCapabilityUI(); };
  editor.addEventListener("change", event => {
    if (event.target.matches("[data-strategy-timeframe], [data-strategy-kline], input[name='strategyPrimaryTimeframe'], [data-strategy-entry-method], #strategyUseChanAnalysis, #strategyUseEma34Data, #strategyEma34Timeframe, #strategyIncludePortfolioContext")) refresh();
    strategyEditorUpdateState();
  });
  editor.addEventListener("input", event => {
    if (event.target.matches("[data-strategy-kline], #strategyTitle, #strategySymbols, #strategyDescription, #strategyPrompt")) syncStrategyDataCapabilityUI();
    strategyEditorUpdateState();
  });
  ["strategyChanDetails", "strategyEma34Details"].forEach(id => $(id)?.addEventListener("toggle", () => syncStrategyDataCapabilityUI()));
  editor.addEventListener("click", async event => {
    const retry = event.target.closest?.("[data-strategy-capability-retry]");
    if (retry) { retry.disabled = true; try { await loadStrategyDataCapabilities({ force:true }); } catch { toast("能力目录读取失败，请稍后重试", "warning"); } finally { retry.disabled = false; } return; }
    const action = event.target.closest?.("[data-strategy-template-action]");
    if (!action) return;
    const templates = parseJsonField($("strategyWritingTemplates")?.dataset.templates, {});
    const text = templates?.[action.dataset.strategyTemplateKey] || "";
    if (!text) return;
    try { if (action.dataset.strategyTemplateAction === "copy") await copyStrategyTemplate(text); else insertStrategyTemplate(text); } catch (error) { toast(localizeReason(error?.message) || "模板操作失败，请重试", "warning"); }
  });
}

function indicatorDeclarationsForStrategyPayload(strategy, enabled, timeframe) {
  const current = strategyIndicatorDeclarations(strategy);
  if (strategyEma34State(strategy).advanced) return current;
  const managed = current.filter(strategyIndicatorLooksLikeEma34);
  const advanced = managed.some(item => !strategyIndicatorIsCanonicalEma34(item));
  if (advanced) return current;
  const retained = current.filter(item => !strategyIndicatorLooksLikeEma34(item));
  if (enabled) retained.push(canonicalEma34Declaration(timeframe));
  return retained;
}

function strategyPolicyNeedsEmaConfirmation(strategy, emaEnabled) {
  const stateInfo = strategyEma34State(strategy);
  return Boolean(!emaEnabled && stateInfo.enabled
    && (stateInfo.advanced || stateInfo.capabilityStatus === "managed"));
}

function populateManualStrategySelector() {
  const select = $("analyzeStrategy");
  if (!select) return;
  const current = Number(select.value || 0);
  const canExecute = item => item.visibility_status === "active" && Number(item.is_active)
    && (item.scope !== "private" || Number(item.owner_user_id) === Number(state.user?.id));
  const available = (state.strategies || []).filter(canExecute);
  select.innerHTML = '<option value="">请选择策略</option>' + available.map(item => `<option value="${Number(item.id)}">${escapeHtml(item.title)} · ${item.scope === "private" ? "私有" : "平台"}</option>`).join("");
  if (available.some(item => Number(item.id) === current)) select.value = String(current);
  else if (available.length === 1) select.value = String(available[0].id);
  updateManualStrategySelection();
}

function updateManualStrategySelection() {
  const strategy = (state.strategies || []).find(item => Number(item.id) === Number($("analyzeStrategy")?.value));
  const symbolSelect = $("analyzeSymbol"), summary = $("manualStrategySummary");
  if (!symbolSelect || !summary) return;
  if (!strategy) {
    symbolSelect.disabled = true; symbolSelect.innerHTML = '<option value="">请先选择策略</option>';
    summary.className = "strategy-run-summary empty"; summary.innerHTML = "<strong>尚未选择策略</strong><span>选择后显示行情周期、K 线数量、入场方式与模型来源。</span>";
    populateModelCompareSelect();
    return;
  }
  const symbols = parseJsonField(strategy.symbols_json, []), previous = symbolSelect.value;
  const resolvedSymbols = symbols.map(symbol => {
    const base = String(symbol).toUpperCase();
    const exact = state.symbols.find(item => String(item.name).toUpperCase() === base);
    const brokerVariant = state.symbols.find(item => String(item.name).toUpperCase().startsWith(base));
    return { strategySymbol:symbol, actualSymbol:(exact || brokerVariant)?.name || symbol };
  });
  symbolSelect.innerHTML = resolvedSymbols.map(item => `<option value="${escapeHtml(item.actualSymbol)}">${escapeHtml(item.actualSymbol)}${item.actualSymbol !== item.strategySymbol ? ` · ${escapeHtml(item.strategySymbol)}` : ""}</option>`).join("");
  symbolSelect.disabled = false;
  if (resolvedSymbols.some(item => item.actualSymbol === previous)) symbolSelect.value = previous;
  const plan = strategyMarketPlan(strategy);
  const methods = parseJsonField(strategy.entry_methods_json, ["market","limit","stop","stop_limit"]);
  const methodLabels = { market:"市价", limit:"限价挂单", stop:"突破挂单", stop_limit:"突破限价" };
  summary.className = "strategy-run-summary";
  summary.innerHTML = `<div><span>行情计划</span><strong>${plan.timeframes.map(item => `${escapeHtml(item.timeframe)} × ${Number(item.kline_count)}`).join(" · ")}</strong></div><div><span>缠论结构数据</span><strong>${Number(strategy.use_chan_analysis) ? "已提供" : "未提供"}</strong></div><div><span>允许入场</span><strong>${methods.map(item => methodLabels[item] || item).map(escapeHtml).join("、")}</strong></div><div><span>模型</span><strong>${strategy.model_profile_id ? `绑定模型 #${Number(strategy.model_profile_id)}` : "按模型管理规则解析"}</strong></div>`;
  populateModelCompareSelect();
}

function renderStrategyModelOptions(scope, selectedId = "") {
  const select = $("strategyModelProfile");
  if (!select) return;
  const platform = scope === "platform";
  const profiles = (state.modelProfiles || []).filter(item => item.status === "active" && item.scope === (platform ? "platform" : "user"));
  const fallback = platform ? "使用平台默认模型" : "使用我的默认模型 / 平台自动共享";
  select.innerHTML = `<option value="">${fallback}</option>` + profiles.map(profile => `<option value="${Number(profile.id)}">${escapeHtml(profile.model_name)}${profile.is_default ? " · 默认" : ""}</option>`).join("");
  select.value = selectedId ? String(selectedId) : "";
  if (selectedId && !select.value) select.insertAdjacentHTML("beforeend", `<option value="${Number(selectedId)}" selected>已绑定模型 #${Number(selectedId)}（当前不可用）</option>`);
  const help = $("strategyModelHelp");
  if (help) help.textContent = platform ? "可绑定一个平台模型用于自动分析；留空时使用平台默认模型。" : "可绑定自己的模型；留空时按模型管理中的默认与共享规则自动选择。";
}

function openStrategyEditor(strategy = null) {
  if (isObserverMode()) { toast(observerMessage(), "warning"); return; }
  const editor = $("strategyEditor"); editor.dataset.strategyId = strategy?.id || ""; editor.dataset.strategyVersion = strategy?.version || ""; editor.dataset.strategyEmaInitialized = ""; editor.dataset.strategySaving = ""; editor.dataset.escapeAnnounced = ""; editor.dataset.closePolicy = "explicit"; editor._strategyDraft = strategy ? structuredClone(strategy) : {};
  strategyEditorDataError("");
  const platformManager = canManagePlatformAiContent();
  $("strategyEditorTitle").textContent = strategy ? "编辑策略" : (platformManager ? "新建平台策略" : "新建自定义策略");
  $("strategyEditorBoundary").textContent = platformManager
    ? (isObserverSourceAccount()
      ? "观摩源账号只能创建和维护平台策略，策略经验统一进入平台记忆。"
      : "平台策略对所有合资格用户可见；他人私有策略只允许审计查看，不能代替用户修改或执行。")
    : "你创建的私有策略仅自己可见、可选和执行。";
  $("strategyTitle").value = strategy?.title || ""; $("strategySymbols").value = parseJsonField(strategy?.symbols_json, []).join(", ");
  $("strategyDescription").value = strategy?.description || "";
  $("strategyPrompt").value = strategy?.system_prompt || ""; $("strategyInterval").value = strategy?.interval_minutes || 5;
  const plan = strategyMarketPlan(strategy);
  document.querySelectorAll("[data-strategy-timeframe]").forEach(input => { input.checked = plan.timeframes.some(item => item.timeframe === input.dataset.strategyTimeframe); });
  document.querySelectorAll("[data-strategy-kline]").forEach(input => { const item = plan.timeframes.find(row => row.timeframe === input.dataset.strategyKline); input.value = item?.kline_count || 100; input.disabled = !item; });
  document.querySelectorAll('input[name="strategyPrimaryTimeframe"]').forEach(input => { input.checked = input.value === plan.primary_timeframe; input.disabled = !plan.timeframes.some(item => item.timeframe === input.value); });
  const entryMethods = new Set(parseJsonField(strategy?.entry_methods_json, ["market","limit","stop","stop_limit"]));
  document.querySelectorAll("[data-strategy-entry-method]").forEach(input => { input.checked = entryMethods.has(input.dataset.strategyEntryMethod); });
  $("strategyUseChanAnalysis").checked = strategy?.data_capabilities?.chan?.enabled != null
    ? Boolean(strategy.data_capabilities.chan.enabled)
    : Boolean(Number(strategy?.use_chan_analysis || 0));
  $("strategyUseEma34Data").checked = false;
  $("strategyUseEma34Data").indeterminate = false;
  $("strategyEma34Timeframe").innerHTML = "";
  $("strategyIncludePortfolioContext").checked = !platformManager && Boolean(Number(strategy?.include_portfolio_context || 0));
  $("strategyPortfolioContextField")?.classList.toggle("hidden", platformManager);
  if (platformManager) {
    $("strategyScope").value = "platform";
    $("strategyScopeField")?.classList.add("is-readonly");
    $("strategyVisibility").value = strategy?.visibility_status || "active";
    $("strategyVisibilityField").style.display = "";
  }
  renderStrategyModelOptions(strategy?.scope || (platformManager ? "platform" : "private"), strategy?.model_profile_id || "");
  bindStrategyDataEditorControls();
  openFormModal(editor);
  syncStrategyEditorMarketPlanControls();
  syncStrategyDataCapabilityUI();
  editor._strategyEditorBaseline = strategyEditorSnapshot();
  strategyEditorUpdateState();
  requestAnimationFrame(() => {
    $(strategy ? "strategyPrompt" : "strategyTitle")?.focus({ preventScroll:true });
    editor.querySelector(".strategy-editor-workbench")?.scrollTo(0, 0);
  });
  loadStrategyDataCapabilities({ render:true }).then(() => {
    if (editor.dataset.dirty !== "1") editor._strategyEditorBaseline = strategyEditorSnapshot();
    strategyEditorUpdateState();
  }).catch(() => {});
}

async function saveStrategyEditor() {
  const editor = $("strategyEditor");
  const button = $("saveStrategyBtn");
  if (!editor || editor.dataset.strategySaving === "1") return;
  const id = Number(editor?.dataset.strategyId || 0);
  const strategy = editor?._strategyDraft || {};
  const fail = message => { const error = new Error(message); error._strategyEditorHandled = true; strategyEditorDataError(message); strategyEditorSetStatus("校验失败，请检查标记字段"); $("strategyTitle")?.focus(); throw error; };
  if (state.strategyDataCapabilitiesStatus !== "ready") return fail(state.strategyDataCapabilitiesStatus === "loading" ? "策略数据能力仍在读取，请稍后再保存" : "策略数据能力目录暂不可用，未知高级配置不会被覆盖；请重试或取消编辑");
  const timeframes = strategyEditorMarketPlanFromControls().timeframes;
  if (!timeframes.length) return fail("请至少启用一个行情周期");
  const primaryTimeframe = strategyEditorMarketPlanFromControls().primary_timeframe || timeframes[0].timeframe;
  const entryMethods = [...document.querySelectorAll("[data-strategy-entry-method]:checked")].map(input => input.dataset.strategyEntryMethod);
  if (!entryMethods.length) return fail("请至少允许一种入场方式");
  const chanEnabled = Boolean($("strategyUseChanAnalysis")?.checked);
  const chanSupported = (state.strategyDataCapabilities?.chan?.supported_timeframes || STRATEGY_CHAN_TIMEFRAMES).map(value => String(value).toUpperCase());
  const selectedChanTimeframes = timeframes.map(item => item.timeframe).filter(timeframe => chanSupported.includes(String(timeframe).toUpperCase()));
  if (chanEnabled && !selectedChanTimeframes.length) return fail("开启缠论结构数据前，请至少选择 M5、M15、H1 或 H4 周期");
  const emaState = strategyEma34State(strategy);
  const emaEnabled = Boolean($("strategyUseEma34Data")?.checked);
  const emaTimeframe = String($("strategyEma34Timeframe")?.value || "").toUpperCase();
  if (emaEnabled && !emaTimeframe) return fail("开启 EMA34 数据前，请选择一个当前行情周期");
  if (emaEnabled && !timeframes.some(item => item.timeframe === emaTimeframe)) return fail("EMA34 周期必须来自当前已启用的行情周期");
  let confirmEnableDataRuntime = false;
  if (strategyPolicyNeedsEmaConfirmation(strategy, emaEnabled)) {
    const message = "关闭后系统不再向模型提供 EMA34 数据，但不会修改策略正文。策略正文中如仍依赖 EMA34，请由你自行删除或调整相关逻辑。是否确认关闭？";
    const confirmed = await showConfirm("确认停止提供 EMA34 数据？", message, { confirmText:"确认关闭", cancelText:"取消" });
    if (!confirmed) return fail("你取消了 EMA34 数据关闭，草稿仍保留");
  } else if (emaEnabled && !emaState.enabled && emaState.policyMode === "off") {
    const message = "当前策略的数据运行模式为关闭。确认后将启用 EMA34 数据计算（不会自动加入交易规则），是否继续？";
    const confirmed = await showConfirm("确认提供 EMA34 数据？", message, { confirmText:"确认启用", cancelText:"取消" });
    if (!confirmed) return fail("你取消了 EMA34 数据启用，草稿仍保留");
    confirmEnableDataRuntime = true;
  }
  const scope = canManagePlatformAiContent() ? "platform" : "private";
  const visibilityStatus = canManagePlatformAiContent() ? $("strategyVisibility").value : "active";
  const body = { title:$("strategyTitle").value.trim(), symbols:$("strategySymbols").value.split(",").map(value => value.trim()).filter(Boolean),
    description:$("strategyDescription").value.trim(), system_prompt:$("strategyPrompt").value.trim(), interval_minutes:Number($("strategyInterval").value) || 5,
    market_data_plan:{ primary_timeframe:primaryTimeframe, timeframes }, entry_methods:entryMethods,
    use_chan_analysis:chanEnabled,
    use_ema34_filter:emaEnabled,
    include_portfolio_context:scope === "private" && $("strategyIncludePortfolioContext").checked,
    is_active:visibilityStatus === "active",
    model_profile_id:$("strategyModelProfile").value ? Number($("strategyModelProfile").value) : null,
    scope,
    visibility_status:visibilityStatus };
  if (!emaState.advanced) body.indicator_declarations = indicatorDeclarationsForStrategyPayload(strategy, emaEnabled, emaTimeframe);
  if (id) body.expected_version = Number(editor.dataset.strategyVersion || strategy.version || 1);
  if (confirmEnableDataRuntime) body.confirm_enable_data_runtime = true;
  strategyEditorDataError("");
  editor.dataset.strategySaving = "1";
  strategyEditorSetStatus("正在保存策略…");
  if (button) { button.disabled = true; button.setAttribute("aria-busy", "true"); button.querySelector(".strategy-save-label")?.replaceChildren(document.createTextNode("正在保存…")); }
  try {
    const saved = await api(id ? `/api/ai/strategies/${id}` : "/api/ai/strategies", { method:id ? "PUT" : "POST", body });
    closeFormModal(editor, false); toast("策略已保存", "success"); await loadStrategyCatalog();
    return saved;
  } catch (error) {
    const message = error?.code === "strategy_version_conflict"
      ? "策略已在其他位置更新。当前草稿已保留，请刷新后对比再保存。"
      : localizeReason(error?.code || error?.message) || "策略保存失败，当前草稿已保留，请修改后重试";
    strategyEditorDataError(message);
    strategyEditorSetStatus(error?.code === "strategy_version_conflict" ? "版本已变化，请处理冲突" : "保存失败，草稿仍保留");
    $("strategyTitle")?.focus();
    error._strategyEditorHandled = true;
    if (error?.code === "strategy_version_conflict") editor.dataset.strategyConflict = "1";
    throw error;
  } finally {
    delete editor.dataset.strategySaving;
    if (button) { button.setAttribute("aria-busy", "false"); button.querySelector(".strategy-save-label")?.replaceChildren(document.createTextNode("保存策略")); }
    strategyEditorUpdateState();
  }
}

function mt5ScheduleTimezone(offsetMinutes = state.mt5TimezoneOffsetMinutes) {
  return "terminal_server";
}

function syncMt5ScheduleTimezoneOption() {
  const select = $("subscriptionScheduleTimezone");
  if (!select) return "terminal_server";
  const timezone = mt5ScheduleTimezone();
  const offset = Number(state.mt5TimezoneOffsetMinutes);
  const offsetLabel = Number.isInteger(offset)
    ? `UTC${offset >= 0 ? "+" : ""}${offset / 60}` : "等待终端校准";
  const option = [...select.options].find(item => item.dataset.mt5Dynamic === "1") || select.options[0];
  option.dataset.mt5Dynamic = "1";
  option.value = "terminal_server";
  option.textContent = `${bridgePlatformLabel()} 服务器时间（${offsetLabel}）`;
  return timezone;
}

function currentSubscriptionAccount() {
  return state.tradingAccounts?.find(account => Number(account.is_active) === 1)
    || state.tradingAccounts?.find(account => account.observe_status === "active")
    || state.tradingAccounts?.[0]
    || null;
}

function selectableSubscriptionStrategies() {
  return (state.strategies || []).filter(item => item.visibility_status === "active" && Number(item.is_active)
    && (item.scope !== "private" || Number(item.owner_user_id) === Number(state.user?.id)));
}

function subscriptionForStrategyAccount(strategyId, accountId) {
  return (state.strategySubscriptions || []).find(item => Number(item.strategy_id) === Number(strategyId)
    && Number(item.trading_account_id) === Number(accountId)) || null;
}

function renderSubscriptionStrategySelector(selectedStrategyId, accountId) {
  const select = $("subscriptionStrategy");
  if (!select) return;
  const strategies = selectableSubscriptionStrategies();
  select.innerHTML = strategies.map(item => {
    const linked = subscriptionForStrategyAccount(item.id, accountId);
    const suffix = Number(linked?.execution_enabled) ? " · 正在运行" : linked ? " · 已订阅" : "";
    return `<option value="${Number(item.id)}">${escapeHtml(item.title)}${suffix}</option>`;
  }).join("");
  select.value = String(selectedStrategyId);
}

function renderSubscriptionStrategySummary(strategy, subscription = null) {
  const host = $("subscriptionStrategySummary");
  if (!host || !strategy) return;
  const plan = strategyMarketPlan(strategy);
  const primary = plan.primary_timeframe || plan.timeframes?.[0]?.timeframe || "M30";
  const symbols = parseJsonField(strategy.symbols_json, []);
  const description = String(strategy.description || (strategy.scope === "private" ? "我的自定义分析策略" : "平台提供的分析策略"))
    .replace(/^\s*>\s?/gm, "").trim();
  host.innerHTML = `<div><span class="status-chip ${strategy.scope === "private" ? "info" : ""}">${strategy.scope === "private" ? "我的策略" : "平台策略"}</span><strong>${escapeHtml(strategy.title)}</strong><p>${escapeHtml(description)}</p></div><dl><div><dt>主要周期</dt><dd>${escapeHtml(primary)}</dd></div><div><dt>支持品种</dt><dd>${symbols.length ? `${symbols.length} 个` : "未设置"}</dd></div></dl>`;
}

function syncSubscriptionEditorActionState() {
  const editor = $("subscriptionEditor");
  const enabled = Boolean($("subscriptionExecutionEnabled")?.checked);
  const hasSubscription = editor?.dataset.hasSubscription === "1";
  const initiallyEnabled = editor?.dataset.initialExecutionEnabled === "1";
  const changed = hasSubscription && enabled !== initiallyEnabled;
  const badge = $("subscriptionStateBadge");
  if (badge) {
    badge.className = `status-chip ${changed ? "warning" : enabled ? "success" : hasSubscription ? "info" : ""}`;
    badge.textContent = changed
      ? enabled ? "待保存 · 将开启" : "待保存 · 将关闭"
      : hasSubscription ? enabled ? "已订阅 · 自动分析开启" : "已订阅 · 自动分析关闭"
      : enabled ? "新订阅 · 保存后开启" : "尚未订阅";
  }
  setText("subscriptionExecutionHelp", enabled
    ? "开启后生成交易建议，并在通过风控后自动执行；同一时间只运行一个策略。"
    : "关闭时只保存订阅，不会自动生成或执行建议。");
  setText("subscriptionSaveHint", enabled
    ? "保存后为当前交易账户开启自动分析"
    : hasSubscription ? "保存后保留订阅，但不自动运行" : "保存后创建订阅，暂不自动运行");
  const saveButton = $("saveSubscriptionBtn");
  if (saveButton && saveButton.getAttribute("aria-busy") !== "true") {
    const label = enabled && (!hasSubscription || !initiallyEnabled) ? "保存并开启自动分析" : hasSubscription ? "保存设置" : "保存订阅";
    saveButton.innerHTML = `<i data-lucide="${enabled ? "play" : "check"}" size="16"></i><span>${label}</span>`;
    initIcons();
  }
}

function hydrateSubscriptionEditor(strategy, subscription = null) {
  const editor = $("subscriptionEditor");
  const currentAccount = currentSubscriptionAccount();
  if (!editor || !currentAccount || !strategy) return false;
  const accountSubscription = subscription && Number(subscription.trading_account_id) === Number(currentAccount.id)
    && Number(subscription.strategy_id) === Number(strategy.id) ? subscription : null;
  editor.dataset.strategyId = String(strategy.id);
  editor.dataset.subscriptionId = accountSubscription?.id || "";
  editor.dataset.hasSubscription = accountSubscription ? "1" : "0";
  editor.dataset.initialExecutionEnabled = Number(accountSubscription?.execution_enabled) === 1 ? "1" : "0";
  renderSubscriptionStrategySelector(strategy.id, currentAccount.id);
  $("subscriptionAccount").value = String(currentAccount.id);
  setText("subscriptionAccountName", `${currentAccount.login_account || currentAccount.nickname || "未识别账户"} · ${currentAccount.broker_server || "未知服务器"}`);
  populateSubscriptionSymbolOptions(strategy, accountSubscription);
  $("subscriptionSymbolsDropdown").open = false;
  const isPrivate = strategy.scope === "private";
  $("subscriptionMemoryModeField")?.classList.toggle("hidden", !isPrivate);
  $("platformMemoryNotice")?.classList.toggle("hidden", isPrivate);
  $("subscriptionMemoryMode").value = isPrivate ? (accountSubscription?.memory_mode || "personal") : "personal";
  $("subscriptionExecutionEnabled").checked = Number(accountSubscription?.execution_enabled) === 1;
  $("subscriptionTakeProfitMode").value = accountSubscription?.take_profit_mode || "ai_recommended";
  $("subscriptionScheduleEnabled").checked = Boolean(Number(accountSubscription?.schedule_enabled || 0));
  const defaultScheduleTimezone = syncMt5ScheduleTimezoneOption();
  $("subscriptionScheduleTimezone").value = defaultScheduleTimezone;
  $("subscriptionOutsideWindowBehavior").value = accountSubscription?.outside_window_behavior || "pause_all";
  const weekdays = new Set(parseJsonField(accountSubscription?.schedule_weekdays_json, [1,2,3,4,5]).map(Number));
  document.querySelectorAll("[data-schedule-weekday]").forEach(input => { input.checked = weekdays.has(Number(input.dataset.scheduleWeekday)); });
  renderSubscriptionScheduleWindows(parseJsonField(accountSubscription?.schedule_windows_json, [{ start:"00:00", end:"23:59" }]));
  renderSubscriptionStrategySummary(strategy, accountSubscription);
  const advanced = $("subscriptionAdvancedSettings");
  if (advanced) advanced.open = Boolean(Number(accountSubscription?.schedule_enabled)
    || (accountSubscription?.take_profit_mode && accountSubscription.take_profit_mode !== "ai_recommended")
    || (isPrivate && accountSubscription?.memory_mode && accountSubscription.memory_mode !== "personal"));
  syncSubscriptionScheduleVisibility();
  syncSubscriptionEditorActionState();
  initIcons();
  return true;
}

function openSubscriptionEditor(strategy, subscription = null) {
  if (isObserverMode()) { toast(observerMessage(), "warning"); return; }
  if (!state.tradingAccounts?.length) { toast(`请先连接 ${bridgePlatformLabel()} 桥接并完成账户登记`, "warning"); return; }
  const selected = selectableSubscriptionStrategies().find(item => Number(item.id) === Number(strategy?.id));
  if (!selected) { toast("当前策略不可订阅，请选择已上线的可用策略", "warning"); return; }
  const account = currentSubscriptionAccount();
  const exactSubscription = subscriptionForStrategyAccount(selected.id, account?.id) || subscription;
  if (!hydrateSubscriptionEditor(selected, exactSubscription)) return;
  openFormModal($("subscriptionEditor"));
}

function handleSubscriptionStrategyChange() {
  const strategyId = Number($("subscriptionStrategy")?.value || 0);
  const strategy = selectableSubscriptionStrategies().find(item => Number(item.id) === strategyId);
  const account = currentSubscriptionAccount();
  if (!strategy || !account) return;
  hydrateSubscriptionEditor(strategy, subscriptionForStrategyAccount(strategy.id, account.id));
}

function subscriptionScheduleSummary(subscription) {
  if (!Number(subscription?.schedule_enabled)) return "跟随市场时间";
  const days = parseJsonField(subscription.schedule_weekdays_json, []).length;
  const windows = parseJsonField(subscription.schedule_windows_json, []);
  return `${days} 天 · ${windows.map(item => `${item.start}–${item.end}`).join("、") || "未设置时段"}`;
}

function subscriptionMemoryModeLabel(mode) {
  return ({
    platform_only: "平台统一经验",
    personal: "使用个人记忆",
    shadow: "仅检索个人记忆，不注入推理",
    off: "关闭记忆",
    disabled: "关闭记忆",
  })[mode] || "未设置记忆方式";
}

function subscriptionTakeProfitModeLabel(mode) {
  return ({
    ai_recommended: "止盈跟随 AI",
    conservative: "固定保守目标 TP1",
    standard: "固定标准目标 TP2",
    trend: "固定趋势目标 TP3",
  })[mode] || "止盈跟随 AI";
}

function renderSubscriptionScheduleWindows(windows) {
  const host = $("subscriptionScheduleWindows");
  if (!host) return;
  const rows = Array.isArray(windows) && windows.length ? windows.slice(0, 6) : [{ start:"00:00", end:"23:59" }];
  host.innerHTML = rows.map((window, index) => `<div class="schedule-window-row" data-schedule-window-row><label><span>开始</span><input type="time" data-schedule-window-start value="${escapeHtml(window.start || "00:00")}"></label><span class="schedule-window-separator">至</span><label><span>结束</span><input type="time" data-schedule-window-end value="${escapeHtml(window.end || "23:59")}"></label><button class="btn btn-danger-ghost btn-sm" type="button" data-remove-schedule-window aria-label="删除第 ${index + 1} 个时段"><i data-lucide="trash-2" size="14"></i></button></div>`).join("");
  initIcons();
}

function selectedSubscriptionScheduleWindows() {
  return [...document.querySelectorAll("[data-schedule-window-row]")].map(row => ({
    start:row.querySelector("[data-schedule-window-start]")?.value || "",
    end:row.querySelector("[data-schedule-window-end]")?.value || "",
  }));
}

function syncSubscriptionScheduleVisibility() {
  const settings = $("subscriptionScheduleSettings");
  const enabled = Boolean($("subscriptionScheduleEnabled")?.checked);
  settings?.classList.toggle("hidden", !enabled);
  $("subscriptionScheduleEnabled")?.setAttribute("aria-expanded", String(enabled));
  if (enabled) requestAnimationFrame(() => settings?.scrollIntoView({
    block:"nearest", behavior:window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth",
  }));
}

function populateSubscriptionSymbolOptions(strategy, subscription = null) {
  const host = $("subscriptionSymbolOptions");
  if (!host) return;
  const supported = parseJsonField(strategy?.symbols_json, []);
  const selected = new Set(parseJsonField(subscription?.symbols_json, []));
  const useAll = selected.size === 0;
  host.innerHTML = `<label class="multi-select-option all-option"><input type="checkbox" data-subscription-symbol-all ${useAll ? "checked" : ""}><span>全部品种 <small>自动跟随策略</small></span></label>`
    + supported.map(symbol => `<label class="multi-select-option"><input type="checkbox" data-subscription-symbol="${escapeHtml(symbol)}" ${selected.has(symbol) ? "checked" : ""}><span>${escapeHtml(symbol)}</span></label>`).join("");
  updateSubscriptionSymbolSummary();
}

function selectedSubscriptionSymbols() {
  if ($("subscriptionSymbolOptions")?.querySelector("[data-subscription-symbol-all]")?.checked) return [];
  return [...document.querySelectorAll("[data-subscription-symbol]:checked")].map(input => input.dataset.subscriptionSymbol);
}

function updateSubscriptionSymbolSummary() {
  const summary = $("subscriptionSymbolsSummary");
  if (!summary) return;
  const all = $("subscriptionSymbolOptions")?.querySelector("[data-subscription-symbol-all]")?.checked;
  const selected = selectedSubscriptionSymbols();
  summary.textContent = all || !selected.length ? "使用策略全部品种" : selected.length <= 3 ? selected.join("、") : `已选择 ${selected.length} 个品种`;
}

async function saveSubscriptionEditor() {
  const editor = $("subscriptionEditor"), id = Number(editor.dataset.subscriptionId || 0);
  const saveButton = $("saveSubscriptionBtn");
  if (saveButton?.disabled) return;
  const strategyId = Number($("subscriptionStrategy")?.value || editor.dataset.strategyId || 0);
  const strategy = selectableSubscriptionStrategies().find(item => Number(item.id) === strategyId);
  if (!strategy) throw new Error("请选择可用的交易策略");
  const executionEnabled = $("subscriptionExecutionEnabled").checked;
  const otherActive = (state.strategySubscriptions || []).find(item => Number(item.execution_enabled) && Number(item.id) !== id);
  let replaceActive = false;
  if (executionEnabled && otherActive) {
    replaceActive = confirm(`当前已有“${otherActive.strategy_title || `订阅 #${otherActive.id}`}”在自动分析。是否关闭原订阅并切换到当前策略？`);
    if (!replaceActive) return;
  }
  const body = { trading_account_id:Number($("subscriptionAccount").value), strategy_id:strategyId,
    symbols:selectedSubscriptionSymbols(), memory_mode:strategy?.scope === "platform" ? "platform_only" : $("subscriptionMemoryMode").value,
    execution_enabled:executionEnabled, replace_active:replaceActive,
    take_profit_mode:$("subscriptionTakeProfitMode").value,
    schedule_enabled:$("subscriptionScheduleEnabled").checked,
    schedule_timezone:$("subscriptionScheduleTimezone").value,
    schedule_weekdays:[...document.querySelectorAll("[data-schedule-weekday]:checked")].map(input => Number(input.dataset.scheduleWeekday)),
    schedule_windows:selectedSubscriptionScheduleWindows(),
    outside_window_behavior:$("subscriptionOutsideWindowBehavior").value };
  const originalButtonHtml = saveButton?.innerHTML || "";
  if (saveButton) {
    saveButton.disabled = true;
    saveButton.setAttribute("aria-busy", "true");
    saveButton.innerHTML = '<i data-lucide="loader-circle" size="16"></i>正在保存';
    saveButton.classList.add("spinning");
    initIcons();
  }
  try {
    await api(id ? `/api/ai/subscriptions/${id}` : "/api/ai/subscriptions", { method:id ? "PUT" : "POST", body });
    closeFormModal(editor, false);
    toast("订阅已保存", "success");
    await loadStrategyCatalog();
    await loadStatus();
  } finally {
    if (saveButton) {
      saveButton.disabled = false;
      saveButton.removeAttribute("aria-busy");
      saveButton.classList.remove("spinning");
      saveButton.innerHTML = originalButtonHtml;
      initIcons();
    }
  }
}

const RISK_LABELS = {
  allowed_symbols:"允许交易品种", require_stop_loss:"强制止损",
  pending_valid_minutes:"挂单有效期",
  max_position_size:"账户单笔最大手数", max_risk_per_trade_pct:"单笔最大风险",
  signal_ttl_seconds:"信号有效期", max_quote_age_seconds:"报价最大年龄", max_spread_points:"最大点差", max_execution_price_deviation_pct:"最大执行价格偏差", weekend_close_minutes:"交易平台周末收盘提前量",
  min_open_interval_seconds:"最小开仓间隔", max_daily_open_count:"每日开仓次数", dedup_window_seconds:"重复订单时间窗", dedup_price_atr:"重复订单价格距离",
  daily_loss_limit_pct:"每日最大亏损", consecutive_loss_limit:"连续亏损次数", loss_cooldown_minutes:"连续亏损冷却", max_drawdown_pct:"最大回撤",
};
const RISK_GROUPS = [
  ["挂单管理", ["pending_valid_minutes"]],
  ["手数与单笔风险", ["max_position_size","max_risk_per_trade_pct"]],
  ["价格与成交质量", ["max_execution_price_deviation_pct","max_spread_points","max_quote_age_seconds","signal_ttl_seconds","weekend_close_minutes"]],
  ["交易频率", ["min_open_interval_seconds","max_daily_open_count"]],
  ["亏损与账户保护", ["daily_loss_limit_pct","consecutive_loss_limit","loss_cooldown_minutes","max_drawdown_pct"]],
];
const RISK_SAFETY_LABELS = {
  lower:"数值越低越严格", higher:"数值越高越严格", subset:"只能缩小允许范围",
  locked:"系统锁定", locked_true:"系统强制开启",
};
const RISK_ROLLOUT_LABELS = {
  ownership:"策略与账户归属校验", entitlement:"会员权限校验",
  kill_switch:"紧急停止开关", data_complete:"风控数据完整性", idempotency:"重复下单幂等保护", volume_bounds:"下单手数硬边界",
  "R1.1_SYMBOL_NOT_ALLOWED":"交易品种白名单", "R1.7_PENDING_DEVIATION":"挂单价格偏离", "R2.2_MIN_OPEN_INTERVAL":"最小开仓间隔",
  "R2.3_DAILY_OPEN_COUNT":"每日开仓次数", "R2.4_PRICE_TIME_DUPLICATE":"重复价格与时间窗口", "R3.1_DAILY_LOSS_LIMIT":"每日亏损上限",
  "R3.2_CONSECUTIVE_LOSS_COOLDOWN":"连续亏损冷却", "R3.2_LOSS_COOLDOWN":"亏损后冷却", "R3.3_MAX_DRAWDOWN":"最大回撤",
  "R4.2_WEEKEND_PROTECTION":"周末保护",
  "R4.3_SIGNAL_EXPIRED":"信号有效期", "R4.4_QUOTE_STALE":"报价时效", "R4.5_SPREAD_TOO_WIDE":"最大点差", "R4.6_EXECUTION_PRICE_DEVIATION":"最大执行价格偏差",
};
function riskRolloutLabel(code) { return RISK_ROLLOUT_LABELS[code] || "未命名风控规则"; }

const RISK_DECISION_LABELS = {
  missing_stop_loss:"系统托管仓位缺少止损",
  invalid_stop_loss_direction:"系统托管仓位止损方向异常",
  "R5_SCHEMA_SYMBOL":"缺少交易品种", "R5_SCHEMA_ORDER_TYPE":"订单方向无效", "R5_SCHEMA_ENTRY_METHOD":"入场方式无效",
  "R5_SCHEMA_AI_REQUIRED":"AI 订单必要字段不完整", "R5_SCHEMA_PENDING_PRICE":"挂单价格无效",
  "R5_SCHEMA_STOP_LIMIT_PRICE":"Stop Limit 触发后限价无效", "R5_SCHEMA_AI_POSITION_SIZE_TIER":"AI 返回的仓位档位无效",
  "R1_INSTRUMENT_DATA_INCOMPLETE":"品种交易参数不完整", "R1_INSTRUMENT_DATA_INCONSISTENT":"交易平台返回的品种风险参数不一致", "R1_SYMBOL_TRADE_DISABLED":"品种当前禁止交易",
  "R1.1_SYMBOL_NOT_ALLOWED":"品种不在允许范围", "R1.2_STOP_LOSS_REQUIRED":"缺少止损",
  "R1.4_STOP_LOSS_TOO_FAR":"止损距离超过上限",
  "R1.5_TAKE_PROFIT_REQUIRED":"缺少止盈", "R1.5_RR_TOO_LOW":"盈亏比低于最低要求",
  "R1.5_TP_TIER_UPGRADED":"改用满足盈亏比要求的更远止盈档位", "R1.6_SL_TP_DIRECTION":"止损或止盈方向错误",
  "R1.7_PENDING_DEVIATION":"挂单价格偏离当前报价过大", "R1.7_PENDING_DIRECTION":"挂单触发价方向与当前价格关系错误",
  "R1.7_PENDING_PRICE_ABNORMAL":"挂单触发价明显异常",
  "R1.7_STOP_LIMIT_RELATION":"Stop Limit 触发价与触发后限价关系错误",
  "R1.8_PENDING_TTL_DEFAULT":"使用默认挂单有效期", "R1.9_AI_VOLUME_OUT_OF_RANGE":"订单执行上限不符合交易平台手数规则",
  "R1.9_BELOW_MINIMUM_AFTER_RISK":"风险调整后手数低于最小可交易手数", "R1.9_VOLUME_INCREASE_FORBIDDEN":"风控禁止超过账户单笔手数上限",
  "R1.9_VOLUME_INVALID":"订单手数无效", "R1.10_RISK_DATA_INVALID":"账户或品种风险数据无效",
  "R1.10_REAL_RISK":"单笔实际风险校验通过", "R4_QUOTE_INVALID":"当前报价无效",
  "R4.2_WEEKEND_PROTECTION":"周末保护时段禁止开仓", "R4.3_SIGNAL_EXPIRED":"推理信号已过期",
  "R4.4_QUOTE_STALE":"交易平台报价已过期或时间异常", "R4.5_SPREAD_TOO_WIDE":"当前点差超过上限",
  "R4.6_MARKET_SIGNAL_DRIFT":"市价偏离推理参考价过大", "R4.6_EXECUTION_PRICE_DEVIATION":"当前价格超出允许执行区间", "R2.1_DIRECTIONAL_EXPOSURE":"同方向持仓敞口超过上限",
  "R2.2_MIN_OPEN_INTERVAL":"距离上次开仓时间过短", "R2.3_DAILY_OPEN_COUNT":"当日开仓次数达到上限",
  "R2.4_PRICE_TIME_DUPLICATE":"检测到重复价格和时间窗口订单", "R3.1_DAILY_LOSS_LIMIT":"达到每日亏损上限",
  "R3.2_CONSECUTIVE_LOSS_COOLDOWN":"连续亏损触发冷却", "R3.2_LOSS_COOLDOWN":"账户仍处于亏损冷却期",
  "R3.3_MAX_DRAWDOWN":"达到最大回撤上限", "R3.4_MARGIN_LEVEL":"保证金水平低于要求",
  "R3.4_MARGIN_DATA_INCOMPLETE":"交易平台无法计算预计保证金", "R3.4_PROJECTED_MARGIN_LEVEL":"下单后的预计保证金水平低于要求",
  "R3.4_NOTIONAL_DATA_INCOMPLETE":"名义敞口数据不完整", "R3.4_NOTIONAL_EXPOSURE":"名义敞口超过上限",
  "R3_ACCOUNT_HALTED":"账户风控已暂停", "R3_RISK_DATA_INCOMPLETE":"账户风险数据不完整",
  "R6_ACCOUNT_NOT_FOUND":"未找到交易账户",
  "R6_ACCOUNT_PAUSED":"交易账户已暂停", "R6_ACCOUNT_TRANSFERRED":"交易账户已切换到其他平台账号",
  "R6_ACCOUNT_TRADE_PERMISSION_REQUIRED":"交易账户没有完整交易权限", "R6_GLOBAL_KILL_SWITCH":"全局紧急停止已开启",
  "R6_USER_KILL_SWITCH":"账户紧急停止已开启", "R6.4_OBSERVATION_BELOW_MINIMUM":"观察期手数低于最小可交易手数",
  portfolio_state_unavailable:"无法读取当前账户的持仓与挂单，本次未执行",
  opposite_position_exists:"当前账户已有反向持仓，本次不新增仓位",
  existing_position_no_add:"当前账户已有同向持仓，策略未建议加仓",
  reference_position_not_matched:"账户实际持仓与平台参考组合不一致，本次不跟随加仓",
  existing_pending_kept:"当前策略的原挂单仍然有效，继续保留",
  reference_pending_not_matched:"账户中未找到平台策略要管理的对应挂单",
  existing_pending_no_replace:"当前策略已有同向挂单，未收到替换指令",
  pending_cancel_failed:"取消当前策略挂单失败，本次未继续执行",
  pending_cancelled:"旧挂单已取消",
  "PX.3_BROKER_SLIPPAGE":"已应用旧版下单价格偏差",
  "PX.3_EXECUTION_PRICE_TOLERANCE":"已按百分比换算交易平台下单偏差",
};

function riskDecisionLabel(code) { return RISK_DECISION_LABELS[code] || localizeReason(code) || "未说明原因"; }
const RISK_DATA_REASON_LABELS = {
  risk_snapshot_incomplete:"Bridge 风控快照不完整",
  deal_cursor_gap:"成交增量游标出现断层，需要补齐缺失区间",
  position_history_unavailable:"部分已平仓持仓明细暂时无法读取",
  legacy_history_incomplete:"旧版历史数据不完整",
};
function riskDataIncompleteText(value) {
  const reasons = String(value || "").split(",").map(item => item.trim()).filter(Boolean);
  if (!reasons.length) return "账户或行情数据尚未完整";
  return reasons.map(reason => {
    if (reason.startsWith("unknown_deal_type:")) return `发现尚未识别的交易平台资金类型（${reason.split(":")[1]}）`;
    if (reason.startsWith("symbol_info_unavailable:")) return `无法读取品种 ${reason.split(":").slice(1).join(":")} 的合约参数`;
    return RISK_DATA_REASON_LABELS[reason] || reason;
  }).join("；");
}
function displayRiskNumber(value, digits = 2) {
  const number = Number(value);
  return Number.isFinite(number) ? number.toFixed(digits).replace(/\.0+$/, "").replace(/(\.\d*?)0+$/, "$1") : "--";
}
function riskRuleDescription(code, details = {}) {
  const label = riskDecisionLabel(code);
  if (code === "R1.5_RR_TOO_LOW") return `${label}：当前 ${displayRiskNumber(details.rr)}，最低要求 ${displayRiskNumber(details.minimum)}`;
  if (code === "R1.5_TP_TIER_UPGRADED") return `${label}：TP${details.from_tier ?? "?"} → TP${details.to_tier ?? "?"}，调整后盈亏比 ${displayRiskNumber(details.rr)}`;
  if (code === "R1.9_BELOW_MINIMUM_AFTER_RISK") {
    if ([details.theoretical_volume, details.risk_cap, details.minimum_lot_risk].every(value => Number.isFinite(Number(value)))) {
      const rounded = details.rounded_volume_candidate ?? details.volume;
      const guard = details.rounding_guard_applied ? "，向上舍入超过风险预算后已安全回退" : "";
      return `${label}：理论手数 ${displayRiskNumber(details.theoretical_volume, 4)}，按 ${displayRiskNumber(details.rounding_step ?? details.step, 3)} 手步进四舍五入候选为 ${displayRiskNumber(rounded, 3)} 手${guard}；最终 ${displayRiskNumber(details.approved_volume ?? details.volume, 3)} 手，本次风险预算 ${displayRiskNumber(details.risk_cap, 2)}，最小 ${displayRiskNumber(details.minimum, 3)} 手预计止损亏损 ${displayRiskNumber(details.minimum_lot_risk, 2)}（均为账户货币），因此未执行`;
    }
    return `${label}：计算结果 ${displayRiskNumber(details.volume)} 手，最低 ${displayRiskNumber(details.minimum)} 手`;
  }
  if (code === "R1_INSTRUMENT_DATA_INCONSISTENT") return `${label}：tick size ${displayRiskNumber(details.tick_size, 8)}，tick value ${displayRiskNumber(details.tick_value, 8)}，来源 ${details.tick_size_source || "未确认"}；已为安全起见阻止下单`;
  if (code === "R4.4_QUOTE_STALE") return `${label}：报价年龄 ${displayRiskNumber(details.quote_age_seconds, 3)} 秒，允许上限 ${displayRiskNumber(details.maximum_seconds)} 秒`;
  if (code === "R1.7_PENDING_DEVIATION") return `${label}：偏离 ${displayRiskNumber(details.deviation)}，允许上限 ${displayRiskNumber(details.maximum)}`;
  if (code === "R4.6_EXECUTION_PRICE_DEVIATION") return `${label}：当前 ${displayRiskNumber(details.current_price)}，允许 ${displayRiskNumber(details.allowed_min)} ～ ${displayRiskNumber(details.allowed_max)}（±${displayRiskNumber(details.maximum_pct, 3)}%）`;
  if (code === "PX.3_EXECUTION_PRICE_TOLERANCE") return `${label}：剩余 ${displayRiskNumber(details.remaining_price, 3)}，发送 ${displayRiskNumber(details.mt5_points, 0)} ${bridgePlatformLabel()} 点`;
  if (code === "R1.9_AI_VOLUME_OUT_OF_RANGE") return `${label}：执行上限 ${displayRiskNumber(details.volume)} 手，允许 ${displayRiskNumber(details.minimum)} ～ ${displayRiskNumber(details.maximum)} 手，步进 ${displayRiskNumber(details.step)} 手`;
  if (code === "R1.7_PENDING_DIRECTION") return `${label}：触发价 ${displayRiskNumber(details.trigger_price)}，当前价 ${displayRiskNumber(details.current_price)}`;
  if (code === "R1.7_STOP_LIMIT_RELATION") return `${label}：触发价 ${displayRiskNumber(details.trigger_price)}，触发后限价 ${displayRiskNumber(details.stop_limit_price)}`;
  if (code === "R4.5_SPREAD_TOO_WIDE") return `${label}：当前点差 ${displayRiskNumber(details.spread_points)} 点`;
  if (code === "R2.2_MIN_OPEN_INTERVAL") return `${label}：还需等待 ${displayRiskNumber(details.remaining_seconds, 0)} 秒`;
  if (code === "R2.3_DAILY_OPEN_COUNT") return `${label}：当前 ${displayRiskNumber(details.count, 0)} 次，上限 ${displayRiskNumber(details.limit, 0)} 次`;
  if (code === "R2.4_PRICE_TIME_DUPLICATE") return `${label}：与执行记录 #${displayRiskNumber(details.prior_intent_id, 0)} 的方向和价格相近`;
  if (code === "R3.1_DAILY_LOSS_LIMIT") return `${label}：当前 ${displayRiskNumber(details.daily_loss_pct)}%，上限 ${displayRiskNumber(details.limit_pct ?? details.daily_loss_limit_pct)}%`;
  if (code === "R3.2_LOSS_COOLDOWN" || code === "R3.2_CONSECUTIVE_LOSS_COOLDOWN") return details.until ? `${label}：冷却至 ${details.until}` : label;
  if (code === "R3.3_MAX_DRAWDOWN") return `${label}：当前 ${displayRiskNumber(details.drawdown_pct)}%，上限 ${displayRiskNumber(details.limit_pct ?? details.max_drawdown_pct)}%`;
  if (code === "invalid_stop_loss_direction") return `${label}：止损 ${displayRiskNumber(details.stop_loss)}，入场参考价 ${displayRiskNumber(details.entry_price)}`;
  if (code === "invalid_take_profit_direction") return `${label}：止盈 ${displayRiskNumber(details.take_profit)}，入场参考价 ${displayRiskNumber(details.entry_price)}`;
  if (code === "pending_supersede_incomplete") return `${label}：仍有 ${displayRiskNumber(details.remaining_same_direction, 0)} 个同向挂单未取消`;
  if (code === "pending_limit_reached") return `${label}：当前 ${displayRiskNumber(details.remaining, 0)} 个，上限 ${displayRiskNumber(details.maximum, 0)} 个`;
  if (code === "opposite_position_exists") return `${label}：检测到 ${displayRiskNumber(details.count, 0)} 个反向持仓`;
  if (code === "existing_position_no_add") return `${label}：当前已有 ${displayRiskNumber(details.count, 0)} 个同向持仓`;
  if (code === "existing_pending_kept") return `${label}：继续保留 ${displayRiskNumber(details.count, 0)} 个当前策略挂单`;
  if (code === "existing_pending_no_replace") return `${label}：当前已有 ${displayRiskNumber(details.count, 0)} 个同向挂单`;
  if (code === "pending_cancelled") return `${label}：已取消 ${displayRiskNumber(details.count, 0)} 个当前策略挂单`;
  if ((code === "R6_GLOBAL_KILL_SWITCH" || code === "R6_USER_KILL_SWITCH") && details.reason) return `${label}：${userVisibleText(details.reason, "未填写补充原因")}`;
  return label;
}
function rejectionRule(rules = [], fallbackCode = "") {
  return rules.find(rule => rule?.outcome === "reject") || (fallbackCode ? { code:fallbackCode, details:{} } : null);
}
function resultRiskReason(result = {}) {
  const rules = Array.isArray(result?.details?.rules) ? result.details.rules
    : Array.isArray(result?.risk?.rule_results) ? result.risk.rule_results
      : Array.isArray(result?.rule_results) ? result.rule_results : [];
  const rule = rejectionRule(rules, result.reject_code || (/^(?:R|PX)[A-Z0-9._-]+$/.test(result.message || "") ? result.message : ""));
  if (rule) return riskRuleDescription(rule.code, rule.details || {});
  if (["preparation_failure", "broker_rejection"].includes(String(result.classification || "")) && result.message) {
    return userVisibleText(result.message, "订单执行未完成，具体原因已记录");
  }
  const reason = String(result.reason || result.reject_code || "").trim();
  return reason ? riskRuleDescription(reason, result.details || {}) : "";
}
function rolloutStatusLabel(value) { return ({ completed:"已完成", succeeded:"成功", failed:"失败", running:"执行中", pending:"等待中" })[value] || value || "未执行"; }
function riskUnit(meta = {}) { return meta.unit_label || ({ percent:"%", lot:"手", minute:"分钟", second:"秒", count:"次/日", point:"点", ATR:"ATR 倍", ratio:"倍", hour:"小时" })[meta.unit] || ""; }
function formatRiskValue(key, value, meta = {}) {
  if (value == null) return "--";
  const unit = riskUnit(meta);
  return `${Number.isFinite(Number(value)) ? Number(value) : value}${unit ? ` ${unit}` : ""}`;
}

function singleTradeRiskLevel(value, maximum = 100) {
  const percentage = Number(value);
  const platformMaximum = Number(maximum);
  if (!Number.isFinite(percentage) || percentage <= 0) return { tone:"invalid", label:"等待设置", description:"请输入有效的风险比例" };
  if (Number.isFinite(platformMaximum) && percentage > platformMaximum) return { tone:"invalid", label:"超出上限", description:`平台允许上限为 ${platformMaximum}%` };
  if (percentage <= 0.5) return { tone:"steady", label:"稳健", description:"优先控制连续亏损带来的账户回撤" };
  if (percentage <= 1) return { tone:"standard", label:"标准（推荐）", description:"适合自动执行的常规风险区间" };
  if (percentage <= 2) return { tone:"elevated", label:"偏高", description:"高于平台推荐值，请确认能够承受连续止损" };
  if (percentage <= 5) return { tone:"high", label:"高风险", description:"显著高于推荐值，连续止损会快速侵蚀账户净值" };
  return { tone:"critical", label:"极高风险", description:"一次止损就可能造成重大损失，接近 100% 时可能损失绝大部分净值" };
}

function riskPercentageText(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return "--";
  return `${Number(number.toFixed(3))}%`;
}

function consecutiveLossDrawdown(value, count = 10) {
  const percentage = Number(value);
  return Number.isFinite(percentage) && percentage > 0
    ? (1 - Math.pow(1 - percentage / 100, count)) * 100
    : 0;
}

function renderRiskPreferencePreview(value, maximum = 100, inherited = false) {
  const percentage = Number(value);
  const level = singleTradeRiskLevel(percentage, maximum);
  const probe = percentage * 0.25, light = percentage * 0.5;
  const warning = ["elevated", "high", "critical"].includes(level.tone)
    ? `连续 10 次标准仓止损，理论回撤约 ${consecutiveLossDrawdown(percentage).toFixed(1)}%；实际损失可能因滑点或跳空更高。`
    : level.description;
  return `<div class="risk-preference-preview ${level.tone}" data-risk-preference-preview role="status" aria-live="polite">
    <div class="risk-preference-heading"><span><strong data-risk-level-label>${escapeHtml(level.label)}</strong><small data-risk-level-description>${escapeHtml(level.description)}</small></span><b data-risk-level-value>${escapeHtml(riskPercentageText(percentage))}${inherited ? " · 继承平台" : ""}</b></div>
    <div class="risk-tier-impact" aria-label="不同仓位档位对应的账户风险"><span><em>试探仓</em><strong data-risk-tier="probe">${escapeHtml(riskPercentageText(probe))}</strong></span><span><em>轻仓</em><strong data-risk-tier="light">${escapeHtml(riskPercentageText(light))}</strong></span><span><em>标准仓</em><strong data-risk-tier="standard">${escapeHtml(riskPercentageText(percentage))}</strong></span></div>
    <p data-risk-level-warning>${escapeHtml(warning)}</p>
  </div>`;
}

function updateUserRiskPreferencePreview(input) {
  if (!input || input.dataset.userRiskField !== "max_risk_per_trade_pct") return;
  const preview = input.closest(".risk-rule-row")?.querySelector("[data-risk-preference-preview]");
  if (!preview) return;
  const inherited = input.value.trim() === "";
  const percentage = Number(inherited ? input.dataset.inheritedRiskValue : input.value);
  const minimum = Number(input.min), maximum = Number(input.max);
  const outsideRange = !Number.isFinite(percentage) || percentage <= 0
    || (Number.isFinite(minimum) && percentage < minimum)
    || (Number.isFinite(maximum) && percentage > maximum);
  const level = outsideRange
    ? { tone:"invalid", label:"超出范围", description:`允许设置 ${riskPercentageText(minimum)}～${riskPercentageText(maximum)}` }
    : singleTradeRiskLevel(percentage, maximum);
  const warning = ["elevated", "high", "critical"].includes(level.tone)
    ? `连续 10 次标准仓止损，理论回撤约 ${consecutiveLossDrawdown(percentage).toFixed(1)}%；实际损失可能因滑点或跳空更高。`
    : level.description;
  preview.className = `risk-preference-preview ${level.tone}`;
  preview.querySelector("[data-risk-level-label]").textContent = level.label;
  preview.querySelector("[data-risk-level-description]").textContent = level.description;
  preview.querySelector("[data-risk-level-value]").textContent = `${riskPercentageText(percentage)}${inherited ? " · 继承平台" : ""}`;
  preview.querySelector('[data-risk-tier="probe"]').textContent = riskPercentageText(percentage * 0.25);
  preview.querySelector('[data-risk-tier="light"]').textContent = riskPercentageText(percentage * 0.5);
  preview.querySelector('[data-risk-tier="standard"]').textContent = riskPercentageText(percentage);
  preview.querySelector("[data-risk-level-warning]").textContent = warning;
  input.setAttribute("aria-invalid", String(outsideRange));
  const groupBadge = input.closest("details.risk-policy-group")?.querySelector(".risk-group-level");
  if (groupBadge) {
    groupBadge.className = `risk-group-level ${level.tone}`;
    groupBadge.textContent = `单笔 ${riskPercentageText(percentage)} · ${level.label}`;
  }
}

function riskBoundaryText(key, control, meta = {}) {
  if (control?.locked_value != null) return `平台锁定：${formatRiskValue(key, control.locked_value, meta)}`;
  if (control?.user_editable === false) return "平台管理，不可修改";
  if (control?.allowed_min != null || control?.allowed_max != null) return `${formatRiskValue(key, control.allowed_min ?? "−∞", meta)} ～ ${formatRiskValue(key, control.allowed_max ?? "+∞", meta)}`;
  return "按平台规则约束";
}

function renderRiskPolicyGroup(title, keys, row, metadata) {
  const policy = row.effective?.policy || {}, accountValues = row.effective?.accountValues || {};
  const platform = row.effective?.platformPolicy || {}, controls = row.effective?.controls || {};
  const visibleKeys = keys.filter(key => metadata[key]?.configurable !== false && metadata[key]?.user_editable !== false);
  if (!visibleKeys.length) return "";
  const groupRisk = visibleKeys.includes("max_risk_per_trade_pct") ? Number(policy.max_risk_per_trade_pct) : null;
  const groupRiskLevel = Number.isFinite(groupRisk) ? singleTradeRiskLevel(groupRisk, controls.max_risk_per_trade_pct?.allowed_max) : null;
  const groupRiskBadge = groupRiskLevel ? `<span class="risk-group-level ${groupRiskLevel.tone}">单笔 ${escapeHtml(riskPercentageText(groupRisk))} · ${escapeHtml(groupRiskLevel.label)}</span>` : "";
  return `<details class="risk-policy-group" data-risk-policy-group="${escapeHtml(title)}"><summary><span><strong>${escapeHtml(title)}</strong><span class="risk-group-summary"><small>${visibleKeys.length} 项可调规则</small>${groupRiskBadge}</span></span><i data-lucide="chevron-down" size="15"></i></summary><div class="risk-rule-table"><div class="risk-rule-row risk-rule-head"><span>规则</span><span>我的设置</span><span>平台边界</span><span>最终生效</span></div>${visibleKeys.map(key => {
    const meta = metadata[key] || {}, control = controls[key] || {}, own = accountValues[key];
    const editable = meta.type === "number" && control.user_editable !== false && control.locked_value == null;
    const unit = riskUnit(meta);
    const isRiskPreference = key === "max_risk_per_trade_pct";
    const inheritedValue = platform[key] ?? policy[key];
    const ownControl = editable
      ? `<span class="risk-input-with-unit"><input type="number" step="any" min="${escapeHtml(control.allowed_min ?? meta.allowed_min ?? '')}" max="${escapeHtml(control.allowed_max ?? meta.allowed_max ?? '')}" data-user-risk-field="${key}" ${isRiskPreference ? `data-original-effective-risk="${escapeHtml(policy[key] ?? '')}" data-inherited-risk-value="${escapeHtml(inheritedValue ?? '')}"` : ""} value="${own == null ? "" : escapeHtml(own)}" placeholder="继承平台值" aria-label="${escapeHtml(RISK_LABELS[key] || key)}的用户设置"><em>${escapeHtml(unit)}</em></span>`
      : `<span class="risk-inherited">${own == null ? "不可修改" : escapeHtml(formatRiskValue(key, own, meta))}</span>`;
    const boundary = meta.locked ? `平台强制：${formatRiskValue(key, platform[key], meta)}` : riskBoundaryText(key, control, meta);
    const preferencePreview = isRiskPreference ? renderRiskPreferencePreview(policy[key], control.allowed_max ?? meta.allowed_max ?? 100, own == null) : "";
    return `<div class="risk-rule-row ${isRiskPreference ? "risk-preference-row" : ""}"><span class="risk-rule-name"><strong>${escapeHtml(RISK_LABELS[key] || meta.label || key)}</strong><small>${escapeHtml(meta.description || "用户只能设置比平台更严格的值")}</small></span><span>${ownControl}</span><span class="risk-boundary">${escapeHtml(boundary)}</span><strong class="risk-effective">${escapeHtml(formatRiskValue(key, policy[key], meta))}</strong>${preferencePreview}</div>`;
  }).join("")}</div></details>`;
}

let _riskCenterLoadSequence = 0;

function captureUserRiskEditorState({ includeDrafts = true } = {}) {
  const host = $("riskAccountsList");
  const fieldKey = input => {
    const accountId = input?.closest("[data-risk-account]")?.dataset.riskAccount;
    const field = input?.dataset?.userRiskField;
    return accountId && field ? `${accountId}:${field}` : "";
  };
  const active = includeDrafts && host?.contains(document.activeElement) ? document.activeElement : null;
  return {
    initialized:Boolean(host?.querySelector("[data-risk-account]")),
    openGroups:new Set([...host?.querySelectorAll("details.risk-policy-group[open]") || []].map(item => {
      const accountId = item.closest("[data-risk-account]")?.dataset.riskAccount;
      return accountId ? `${accountId}:${item.dataset.riskPolicyGroup}` : "";
    }).filter(Boolean)),
    drafts:includeDrafts ? Object.fromEntries([...host?.querySelectorAll("input[data-user-risk-field]") || []].map(input => [fieldKey(input), input.value]).filter(([key]) => key)) : {},
    focusKey:fieldKey(active), selectionStart:active?.selectionStart ?? null, selectionEnd:active?.selectionEnd ?? null,
  };
}

function restoreUserRiskEditorState(snapshot) {
  if (!snapshot?.initialized) return;
  const host = $("riskAccountsList");
  host?.querySelectorAll("details.risk-policy-group").forEach(item => {
    const accountId = item.closest("[data-risk-account]")?.dataset.riskAccount;
    item.open = Boolean(accountId && snapshot.openGroups.has(`${accountId}:${item.dataset.riskPolicyGroup}`));
  });
  host?.querySelectorAll("input[data-user-risk-field]").forEach(input => {
    const accountId = input.closest("[data-risk-account]")?.dataset.riskAccount;
    const key = accountId ? `${accountId}:${input.dataset.userRiskField}` : "";
    if (key && Object.hasOwn(snapshot.drafts, key)) input.value = snapshot.drafts[key];
    updateUserRiskPreferencePreview(input);
    if (key && key === snapshot.focusKey) {
      input.focus({ preventScroll:true });
      if (snapshot.selectionStart != null) input.setSelectionRange(snapshot.selectionStart, snapshot.selectionEnd ?? snapshot.selectionStart);
    }
  });
}

async function loadRiskCenter({ preserveRuleState = true, preserveRuleDrafts = preserveRuleState } = {}) {
  const loadSequence = ++_riskCenterLoadSequence;
  const ruleEditorState = preserveRuleState ? captureUserRiskEditorState({ includeDrafts:preserveRuleDrafts }) : null;
  const filters = state.executionFilters;
  let riskData = await api("/api/ai/risk-center");
  if ((riskData.accounts || []).some(row => row.risk_state?.data_complete === false || Number(row.risk_state?.data_complete) === 0)) {
    const refreshed = await api("/api/ai/risk-center/refresh", { method:"POST", body:{} });
    if (refreshed.refreshed > 0) riskData = await api("/api/ai/risk-center");
  }
  const executionData = await api(`/api/ai/executions?page=${filters.page}&page_size=${filters.pageSize}`);
  if (loadSequence !== _riskCenterLoadSequence) return;
  const host = $("riskAccountsList");
  const rows = riskData.accounts || [];
  const haltedRows = rows.filter(row => row.risk_state?.halt_status !== "active");
  const incompleteRows = rows.filter(row => row.risk_state?.data_complete === false || Number(row.risk_state?.data_complete) === 0);
  const accountRiskPercentages = rows.map(row => Number(row.effective?.policy?.max_risk_per_trade_pct)).filter(Number.isFinite);
  const highestRiskPercentage = accountRiskPercentages.length ? Math.max(...accountRiskPercentages) : null;
  const accountRiskMaximums = rows.map(row => Number(row.effective?.controls?.max_risk_per_trade_pct?.allowed_max)).filter(Number.isFinite);
  const highestRiskMaximum = accountRiskMaximums.length ? Math.max(...accountRiskMaximums) : 100;
  const highestRiskLevel = highestRiskPercentage == null ? null : singleTradeRiskLevel(highestRiskPercentage, highestRiskMaximum);
  const overview = $("riskOverview");
  if (overview) overview.innerHTML = `<div class="insight-item ${haltedRows.length ? 'danger' : 'success'}"><span>现在能否交易</span><strong>${haltedRows.length ? `${haltedRows.length} 个账户暂停` : '可以交易'}</strong><small>${haltedRows.length ? '请查看下方具体原因' : '未发现停止新开仓的条件'}</small></div><div class="insight-item ${incompleteRows.length ? 'warning' : ''}"><span>交易账户</span><strong class="num">${rows.length}</strong><small>${incompleteRows.length ? `${incompleteRows.length} 个账户数据异常` : '账户和行情数据正常'}</small></div><div class="insight-item risk-overview-level ${escapeHtml(highestRiskLevel?.tone || 'standard')}"><span>单笔风险档位</span><strong>${escapeHtml(highestRiskLevel?.label || '等待账户')}</strong><small>${highestRiskPercentage == null ? '连接账户后显示最终生效值' : `最高 ${escapeHtml(riskPercentageText(highestRiskPercentage))} · 平台推荐不超过 1%`}</small></div>`;
  const statusHost = $("riskStatusList");
  if (statusHost) statusHost.innerHTML = rows.length ? rows.map(row => {
    const stateInfo = row.risk_state || {}, active = stateInfo.halt_status === "active", dataComplete = !(stateInfo.data_complete === false || Number(stateInfo.data_complete) === 0);
    const reason = stateInfo.halt_reason === "R3_RISK_DATA_INCOMPLETE"
      ? `风控数据不完整：${riskDataIncompleteText(stateInfo.data_incomplete_reason)}`
      : stateInfo.halt_reason ? riskDecisionLabel(stateInfo.halt_reason) : (!dataComplete ? riskDataIncompleteText(stateInfo.data_incomplete_reason) : "当前没有触发停止交易的条件");
    return `<article class="workspace-panel risk-status-card ${active && dataComplete ? 'is-safe' : 'is-alert'}" data-risk-status-account="${row.account.id}"><div class="risk-status-icon"><i data-lucide="${active && dataComplete ? 'shield-check' : 'shield-alert'}" size="22"></i></div><div class="risk-status-main"><div class="workspace-row-title">${escapeHtml(row.account.nickname || row.account.login_account)} <span class="status-chip ${active && dataComplete ? 'success' : 'danger'}">${active && dataComplete ? '允许交易' : '已暂停新开仓'}</span></div><p>${escapeHtml(reason)}</p><div class="workspace-row-meta"><span>${escapeHtml(row.account.broker_server)}</span><span>数据${dataComplete ? '完整' : '不完整'}</span><span>回撤 ${escapeHtml(stateInfo.drawdown_pct ?? '--')}%</span><span>连亏 ${escapeHtml(stateInfo.consecutive_losses ?? '--')}</span></div></div><div class="workspace-row-actions"><button class="btn btn-secondary btn-sm" type="button" data-open-workspace-tab="risk" data-open-workspace-target="rules">查看规则</button><button class="btn ${stateInfo.user_kill_switch ? 'btn-secondary' : 'btn-danger'} btn-sm" data-kill-switch="${row.account.id}" data-enabled="${stateInfo.user_kill_switch ? '0' : '1'}">${stateInfo.user_kill_switch ? '解除紧急停止' : '紧急停止新开仓'}</button></div></article>`;
  }).join("") : '<div class="workspace-panel empty-state"><strong>没有已登记的交易账户</strong><span>连接 Bridge 后会在这里显示账户交易状态。</span></div>';
  host.innerHTML = rows.length ? rows.map(row => {
    const stateInfo = row.risk_state || {}, killEnabled = Boolean(stateInfo.user_kill_switch);
    const haltText = stateInfo.halt_reason === "R3_RISK_DATA_INCOMPLETE" ? `风控数据不完整：${riskDataIncompleteText(stateInfo.data_incomplete_reason)}` : riskDecisionLabel(stateInfo.halt_reason);
    return `<article class="workspace-panel risk-rule-account" data-risk-account="${row.account.id}"><div class="section-heading"><div><h2>${escapeHtml(row.account.nickname || row.account.login_account)}</h2><p>${escapeHtml(row.account.broker_server)} · 先查看最终有效值，需要调整时再展开对应规则组。</p></div><span class="status-chip ${stateInfo.halt_status === 'active' ? 'success' : 'danger'}">${stateInfo.halt_status === 'active' ? '允许交易' : '已暂停'}</span></div>${stateInfo.halt_reason ? `<div class="source-notice"><span><strong>暂停原因：</strong>${escapeHtml(haltText)}；将在下一次完整风险快照校验通过后解除。</span></div>` : ''}<div class="risk-policy-groups">${RISK_GROUPS.map(([title, keys]) => renderRiskPolicyGroup(title, keys, row, riskData.rule_metadata || {})).join("")}</div><div class="risk-save-bar"><p>留空表示继承平台值。所有修改保存后立即生效，并保留版本与审计记录。</p><button class="btn btn-primary btn-sm" data-risk-save="${row.account.id}">保存并立即生效</button></div></article>`;
  }).join("") : '<div class="workspace-panel empty-state"><strong>没有已登记的交易账户</strong><span>账户通过 Bridge 自动验证后，这里会显示最终有效风控。</span></div>';
  restoreUserRiskEditorState(ruleEditorState);
  renderExecutionDecisions(executionData.executions || [], executionData.pagination || {});
  initIcons();
}

async function loadExecutionDecisions() {
  const filters = state.executionFilters;
  const data = await api(`/api/ai/executions?page=${filters.page}&page_size=${filters.pageSize}`);
  renderExecutionDecisions(data.executions || [], data.pagination || {});
}

function renderExecutionDecisions(rows, pagination = {}) {
  const host = $("executionDecisionList"); if (!host) return;
  state.executionFilters.page = Number(pagination.page || state.executionFilters.page || 1);
  state.executionFilters.total = Number(pagination.total || rows.length);
  host.innerHTML = rows.length ? rows.map(row => {
    const original = parseJsonField(row.original_order_json, {}), approved = parseJsonField(row.approved_order_json, {}), result = parseJsonField(row.result_json, {}), rules = parseJsonField(row.rule_results_json, []);
    const finalVolume = approved.volume ?? approved.lot ?? "--";
    const tierAdvice = positionSizeAdvice(original);
    const refPrice = approved.reference_price ?? original.reference_price ?? original.price ?? "--", actual = result.price ?? result.price_open ?? "--";
    const adjustmentRules = rules.filter(rule => rule.outcome === "adjust" || rule.adjusted);
    const adjustments = adjustmentRules.map(rule => riskRuleDescription(rule.code, rule.details || {})).join("；") || "无";
    const rejectedRule = rejectionRule(rules, row.reject_code || row.error_code || result.reject_code || "");
    const reason = rejectedRule ? riskRuleDescription(rejectedRule.code, rejectedRule.details || {}) : riskDecisionLabel(result.error || result.message || "");
    const riskPass = rules.find(rule => rule.code === "R1.10_REAL_RISK");
    const riskCap = riskPass?.details?.risk_cap ?? approved.risk_volume_cap ?? "--";
    const executionCeiling = riskPass?.details?.position_limit_lots ?? original.volume ?? original.lot ?? "--";
    const executionStatus = row.status || "unknown";
    const riskStatus = row.decision_status || "unknown";
    const decisionText = ({ succeeded:"执行成功", rejected:"执行被拒绝", failed:"执行失败", uncertain:"执行待确认", awaiting_confirmation:"等待确认", preparing:"准备执行", prepared:"等待发送", bridge_sending:"正在发送" })[executionStatus] || "未完成";
    const decisionClass = executionStatus === "succeeded" ? "success" : ["rejected","failed"].includes(executionStatus) ? "danger" : "warning";
    const riskText = ({ pass:"通过", adjust:"调整后通过", reject:"拒绝" })[riskStatus] || "未完成";
    return `<article class="workspace-row"><div class="workspace-row-main"><div class="workspace-row-title">#${row.id} ${escapeHtml(row.symbol || '')} <span class="status-chip ${decisionClass}">${escapeHtml(decisionText)}</span></div>${reason && reason !== "未说明原因" ? `<div class="execution-reason">${escapeHtml(reason)}</div>` : ''}<div class="workspace-row-meta"><span>风控 ${escapeHtml(riskText)}</span><span>仓位档位 ${escapeHtml(tierAdvice.text)}</span><span>账户执行上限 ${escapeHtml(executionCeiling)} 手</span><span>风险额度 ${escapeHtml(riskCap)}</span><span>最终 ${escapeHtml(finalVolume)} 手</span><span>规则调整：${escapeHtml(adjustments)}</span><span>参考价 ${escapeHtml(refPrice)}</span><span>实际价 ${escapeHtml(actual)}</span></div></div></article>`;
  }).join("") : '<div class="empty-state"><strong>暂无执行决策</strong><span>通过风控闸门的下单请求会在这里留下完整对照。</span></div>';
  renderPager("executionDecisionPager", state.executionFilters.page, state.executionFilters.pageSize, state.executionFilters.total, "executions");
}

function reviewStatusLabel(value) { return ({ evidence_pending:"待生成", incomplete:"证据缺失", ready:"待生成", queued:"已进入队列", preparing:"准备证据", model_request:"AI 分析中", validating:"校验结果", repairing:"修复输出", retry_wait:"等待重试", generating:"生成中", draft:"待确认", edited:"已修改", needs_revision:"内容有问题", approved:"已确认", failed:"生成失败", succeeded:"生成完成", deferred:"稍后处理" })[value] || userVisibleText(value, "未知状态"); }

function reviewFieldStatusLabel(value) {
  return ({
    pending:"待确认", accurate:"内容准确", needs_revision:"需要修改", deferred:"稍后处理",
    confirmed:"已确认", approved:"已确认", rejected:"有问题", none:"未发现", found:"已发现",
    confirmed_no_issue:"确认无问题", confirmed_has_issue:"确认有问题", unknown:"待检查",
  })[String(value || "").trim()] || "待检查";
}

function periodReviewEvidenceReasonText(value) {
  const labels = {
    inference_snapshot_incomplete:"推理快照缺少关键内容",
    historical_prompt_missing:"推理时使用的提示词缺失",
    holding_market_path_incomplete:"开仓至平仓的行情路径尚未补齐",
    period_market_incomplete:"当日完整行情与结构证据尚未补齐",
    evidence_rebuild_required:"证据规则已升级，系统正在自动重建",
    execution_deals_missing:"成交明细尚未同步完整",
  };
  const parts = String(value || "").split(",").map(item => item.trim()).filter(Boolean);
  if (!parts.length) return "关键证据尚未完整，系统会自动重试";
  return [...new Set(parts.map(item => labels[item]
    || (/bridge not connected/i.test(item) ? "管理员桥接未连接，暂时无法补齐历史行情" : item)))].join("；");
}
function periodReviewEffectiveStatus(item) {
  if (Number(item.current_version_id || 0) > 0) return item.status || "draft";
  if (item.job_status === "leased") return item.progress_stage || "generating";
  if (item.job_status === "queued" && item.next_attempt_at) return "retry_wait";
  if (item.job_status === "queued") return "queued";
  return item.status;
}

function renderReviewSummary(summary = state.reviewSummary) {
  const badge = $("reviewNavBadge"), failureDot = $("reviewNavFailureDot");
  const attention = Number(summary.attention || 0), failed = Number(summary.failed || 0);
  if (badge) { badge.textContent = attention > 99 ? "99+" : String(attention); badge.classList.toggle("hidden", attention < 1); }
  failureDot?.classList.toggle("hidden", failed < 1);
  const nav = document.querySelector('[data-tab="review-memory"]');
  if (nav) nav.title = `待确认 ${Number(summary.pending_confirmation || 0)} · 未读 ${Number(summary.unread || 0)} · 生成失败 ${failed}`;
  setText("reviewPendingStat", Number(summary.pending_confirmation || 0));
  setText("reviewGeneratingStat", Number(summary.generating || 0));
  setText("reviewFailedStat", failed);
  const jobInsight = $("reviewJobInsight");
  if (jobInsight) {
    jobInsight.classList.toggle("danger", failed > 0);
    jobInsight.classList.toggle("warning", failed === 0 && Number(summary.generating || 0) > 0);
  }
  setText("reviewAllCount", Number(summary.total || 0));
  setText("reviewDailyCount", Number(summary.daily_total || 0));
  setText("reviewMonthlyCount", Number(summary.monthly_total || 0));
}

async function loadReviewSummary({ announce = true } = {}) {
  if (!state.token) return state.reviewSummary;
  const data = await api("/api/ai/period-reviews/summary");
  const next = data.summary || {};
  if (announce && state.reviewSummaryInitialized && Number(next.pending_confirmation || 0) > Number(state.reviewSummary.pending_confirmation || 0)) {
    toast(`有新的复盘等待确认（${Number(next.pending_confirmation || 0)}）`, "success");
  }
  state.reviewSummary = next;
  state.reviewSummaryInitialized = true;
  renderReviewSummary(next);
  return next;
}

function startReviewSummaryPolling() {
  if (state.reviewSummaryTimer) return;
  state.reviewSummaryTimer = setInterval(() => {
    if (document.visibilityState === "hidden" || !state.token) return;
    loadReviewSummary().catch(() => {});
  }, 30000);
}

function stopReviewDetailPolling() {
  if (state.reviewDetailPollTimer) clearTimeout(state.reviewDetailPollTimer);
  state.reviewDetailPollTimer = null;
  state.reviewDetailJobKey = null;
}

function periodReviewListUrl() {
  const params = new URLSearchParams({
    limit:String(state.reviewListPageSize),
    offset:String(state.reviewListOffset),
  });
  if (state.reviewPeriodFilter) params.set("periodType", state.reviewPeriodFilter);
  if (state.reviewFilter) params.set("status", state.reviewFilter);
  return `/api/ai/period-reviews?${params.toString()}`;
}

function disconnectReviewListObserver() {
  state.reviewListObserver?.disconnect();
  state.reviewListObserver = null;
}

function bindReviewListStream() {
  disconnectReviewListObserver();
  const sentinel = document.querySelector("[data-review-stream-sentinel]");
  const loadMore = document.querySelector("[data-review-load-more]");
  const requestNextPage = () => loadReviewCaseStream().catch(error => toast(error.message, "error"));
  loadMore?.addEventListener("click", requestNextPage);
  if (!sentinel || state.reviewListLoading || !state.reviewListHasMore || !("IntersectionObserver" in window)) return;
  state.reviewListObserver = new IntersectionObserver(entries => {
    if (entries.some(entry => entry.isIntersecting)) requestNextPage();
  }, { root:null, rootMargin:"180px 0px" });
  state.reviewListObserver.observe(sentinel);
}

async function loadReviewCaseStream({ reset = false } = {}) {
  if (reset) {
    state.reviewListRequestVersion += 1;
    state.reviewListOffset = 0;
    state.reviewListHasMore = true;
    state.reviewListLoading = false;
    state.reviewListError = "";
    state.reviewCases = [];
    disconnectReviewListObserver();
  }
  if (state.reviewListLoading || !state.reviewListHasMore) return;
  const requestVersion = state.reviewListRequestVersion;
  const requestedOffset = state.reviewListOffset;
  state.reviewListLoading = true;
  state.reviewListError = "";
  renderReviewCases();
  try {
    const data = await api(periodReviewListUrl());
    if (requestVersion !== state.reviewListRequestVersion) return;
    const rows = data.cases || [];
    if (requestedOffset === 0) state.reviewCases = rows;
    else {
      const known = new Set(state.reviewCases.map(item => String(item.id)));
      state.reviewCases = [...state.reviewCases, ...rows.filter(item => !known.has(String(item.id)))];
    }
    state.reviewListOffset = Number(data.pagination?.next_offset ?? requestedOffset + rows.length);
    state.reviewListHasMore = Boolean(data.pagination?.has_more ?? rows.length >= state.reviewListPageSize);
  } catch (error) {
    if (requestVersion === state.reviewListRequestVersion) state.reviewListError = localizeReason(error.message);
    throw error;
  } finally {
    if (requestVersion === state.reviewListRequestVersion) {
      state.reviewListLoading = false;
      renderReviewCases();
    }
  }
}

async function loadReviewMemory() {
  const platformManager = canManagePlatformAiContent();
  const [, memoryData, profileData, featureData] = platformManager
    ? await Promise.all([loadReviewCaseStream({ reset:true }), api("/api/ai/strategy-memories"), Promise.resolve({ profiles:[] }), Promise.resolve({ flags:{ user:{} } })])
    : await Promise.all([loadReviewCaseStream({ reset:true }), api("/api/ai/strategy-memories"), api(`/api/ai/model-profiles${profileScopeQuery()}`), api("/api/ai/feature-flags")]);
  state.strategyMemoryStrategies = memoryData.strategies || [];
  const availableIds = new Set(state.strategyMemoryStrategies.map(item => Number(item.strategy_id)));
  if (!availableIds.has(Number(state.selectedStrategyMemoryId))) state.selectedStrategyMemoryId = Number(state.strategyMemoryStrategies[0]?.strategy_id || 0) || null;
  if (state.selectedStrategyMemoryId) {
    const [detail, latestCompression] = await Promise.all([
      api(`/api/ai/strategy-memories/${state.selectedStrategyMemoryId}`),
      api(`/api/ai/strategy-memories/${state.selectedStrategyMemoryId}/compression-jobs-latest`),
    ]);
    state.strategyMemoryDetail = detail;
    await loadStrategyMemoryPreview(state.selectedStrategyMemoryId);
    state.strategyMemoryCompressionJob = latestCompression.job || null;
    if (latestCompression.job) state.strategyMemoryCompressionJobs[String(state.selectedStrategyMemoryId)] = latestCompression.job;
  } else {
    state.strategyMemoryDetail = null;
    state.strategyMemoryCompressionJob = null;
  }
  setText("memoryActiveStat", state.strategyMemoryStrategies.length
    ? (() => { const count = state.strategyMemoryStrategies.reduce((sum, item) => sum + Number(item.attention_required_count || 0), 0);
      return count ? `${count} 项待核对` : `v${Number(state.strategyMemoryDetail?.library?.version_no || 0)}`; })() : "--");
  await loadReviewSummary({ announce:false });
  $("sharedCredentialNotice")?.classList.toggle("hidden", platformManager || (profileData.profiles || []).some(item => item.is_default && item.has_api_key));
  const userFlags = featureData.flags?.user || {};
  const featureInputs = { userReviewGenerationFlag:"review_generation_enabled" };
  for (const [id,key] of Object.entries(featureInputs)) if ($(id)) {
    $(id).checked = userFlags[key] ?? true;
  }
  renderReviewCases();
  renderStrategyMemoryLibrary();
  if (strategyMemoryCompressionActive(state.strategyMemoryCompressionJob)) {
    startStrategyMemoryCompressionPolling(state.selectedStrategyMemoryId, state.strategyMemoryCompressionJob);
  }
}

// ===== Manual trade strategy review (platform-content managers only) =====
// This workflow intentionally has no relationship to the periodic review
// queue above.  The selector is cursor based, while the review history is the
// small owner-scoped case list returned by the manual-review API.
const MANUAL_TRADE_REVIEW_PAGE_SIZE = 20;
const MANUAL_TRADE_REVIEW_MAX_SELECTION = 1;
const MANUAL_TRADE_REVIEW_POLL_INTERVAL_MS = 3000;
const MANUAL_TRADE_REVIEW_TERMINAL_JOBS = new Set(["succeeded", "failed", "cancelled", "deferred"]);

function manualTradeReviewStatusLabel(value) {
  return ({
    queued:"已进入队列", preparing:"准备证据", generating:"AI 分析中", counterfactual_analysis:"开仓前盲测",
    outcome_review:"事后盈利复盘", validating:"校验结果",
    repairing:"修复输出", retry_wait:"等待重试", completed:"生成完成", succeeded:"生成完成",
    draft:"待确认", edited:"已修改", needs_revision:"需要修改", approved:"已确认",
    failed:"生成失败", deferred:"稍后处理", cancelled:"已取消", status_unknown:"状态暂不可确认", completed_stale:"结果已过期",
    running:"AI 分析中", leased:"AI 分析中", pending:"等待处理", evidence_pending:"等待证据", incomplete:"证据不足", partial:"证据不足",
  })[String(value || "").toLowerCase()] || "状态待确认";
}

function manualTradeReviewValueLabel(value, fallback = "待确认") {
  const normalized = String(value || "").trim().toLowerCase();
  return ({
    complete:"完整", partial:"部分符合", insufficient:"证据不足", insufficient_evidence:"证据不足",
    aligned:"符合", misaligned:"不符合", conflict:"冲突", mixed:"部分符合", unknown:"待确认", pending:"待确认",
    buy:"做多", sell:"做空", long:"做多", short:"做空", acceptable:"可接受", weak:"偏弱",
    same_direction:"同方向", hold:"观望", opposite_direction:"反方向", not_applicable:"不适用",
    strong:"较强", good:"较好", poor:"较差", pass:"通过", fail:"未通过", hypothesis:"待验证假设",
  })[normalized] || (normalized && /[\u4e00-\u9fff]/.test(normalized) ? String(value) : fallback);
}

function manualTradeReviewReasonText(reason, fallback = "行情或历史证据尚未完整") {
  const text = String(reason || "").trim();
  return text ? localizeReason(text) : fallback;
}

function manualTradeReviewStatusTone(value) {
  const status = String(value || "").toLowerCase();
  if (["approved", "succeeded", "completed"].includes(status)) return "success";
  if (["failed", "needs_revision", "incomplete", "cancelled"].includes(status)) return "danger";
  if (["draft", "edited", "queued", "preparing", "generating", "running", "leased", "counterfactual_analysis", "outcome_review", "validating", "retry_wait"].includes(status)) return "warning";
  return "info";
}

function manualTradeReviewDirectionLabel(value) {
  return ({ buy:"做多", sell:"做空", long:"做多", short:"做空" })[String(value || "").toLowerCase()] || userVisibleText(value, "方向未知");
}

function manualTradeReviewFormatTime(value) {
  if (!value) return "时间待确认";
  const date = new Date(typeof value === "number" ? value : String(value).replace(" ", "T") + (String(value).includes("Z") ? "" : "+08:00"));
  return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString("zh-CN", { hour12:false, month:"2-digit", day:"2-digit", hour:"2-digit", minute:"2-digit" });
}

function manualTradeReviewIdentity(trade) {
  return String(trade?.source_identity_hash || trade?.trade_id || "").trim();
}

function manualTradeReviewSelectedMap() {
  const selected = state.manualTradeReviewSelectedTrades?.length ? state.manualTradeReviewSelectedTrades : state.manualTradeReviewSelection;
  return new Map((selected || []).map(item => [manualTradeReviewIdentity(item), item]));
}

function manualTradeReviewHandleForbidden(error) {
  if (Number(error?.status) !== 403 && error?.code !== "manual_trade_review_forbidden") return false;
  state.manualTradeReviewLoaded = false;
  state.manualTradeReviewTrades = [];
  state.manualTradeReviewSelectedTrades = [];
  state.manualTradeReviewSelection = [];
  state.manualTradeReviewCases = [];
  state.manualTradeReviewDetail = null;
  state.manualTradeReviewScannedSourcePages = 0;
  state.manualTradeReviewSkippedEmptySourcePages = 0;
  state.manualTradeReviewUnavailable = false;
  state.manualTradeReviewEvidenceReason = "";
  state.manualTradeReviewHistoryScopeNote = "";
  state.manualTradeReviewHistorySourceLimited = false;
  stopManualTradeReviewPolling();
  applyRoleUI();
  toast("当前账号没有手动交易复盘权限，已清空本地复盘状态", "warning");
  return true;
}

function manualTradeReviewQuery({ forceRefresh = false } = {}) {
  const filter = state.manualTradeReviewFilters || {};
  const params = new URLSearchParams({ page_size:String(filter.pageSize || MANUAL_TRADE_REVIEW_PAGE_SIZE) });
  if (filter.cursor) params.set("cursor", String(filter.cursor));
  if (filter.historySnapshotId) params.set("history_snapshot_id", String(filter.historySnapshotId));
  if (filter.rangeStartUtcMsc) params.set("range_start_utc_msc", String(filter.rangeStartUtcMsc));
  if (filter.rangeEndUtcMsc) params.set("range_end_utc_msc", String(filter.rangeEndUtcMsc));
  if (filter.symbol) params.set("symbol", String(filter.symbol));
  if (filter.direction) params.set("direction", String(filter.direction));
  if (forceRefresh) params.set("force_refresh", "1");
  return `/api/ai/manual-trade-reviews/eligible-trades?${params.toString()}`;
}

function manualTradeReviewResetCursor() {
  state.manualTradeReviewFilters.cursor = null;
  state.manualTradeReviewFilters.historySnapshotId = null;
  state.manualTradeReviewFilters.rangeStartUtcMsc = null;
  state.manualTradeReviewFilters.rangeEndUtcMsc = null;
  state.manualTradeReviewCursorStack = [null];
  state.manualTradeReviewCursorIndex = 0;
  state.manualTradeReviewNextCursor = null;
  state.manualTradeReviewHasMore = false;
}

function manualTradeReviewReadFilters() {
  state.manualTradeReviewFilters.symbol = String($("manualTradeReviewSymbol")?.value || "").trim();
  state.manualTradeReviewFilters.direction = String($("manualTradeReviewDirection")?.value || "").trim();
}

function renderManualTradeReviewSelectionSummary() {
  const selected = state.manualTradeReviewSelectedTrades || [];
  const host = $("manualTradeReviewSelectedSummary");
  if (host) {
    const totalProfit = selected.reduce((sum, item) => sum + (Number(item.net_profit) || 0), 0);
    host.innerHTML = `<div><span><i data-lucide="list-checks" size="15"></i>已选择</span><strong>${selected.length} 笔交易</strong><small>当前账户 · 创建时再次校验订单与信号绑定</small></div><div><span>订单净利润</span><strong class="${totalProfit > 0 ? "positive" : ""}">${fmt(totalProfit)}</strong><small>盈利结果不会泄露给开仓前盲测</small></div>`;
  }
  setText("manualTradeReviewSelectionCount", `已选 ${selected.length} / ${MANUAL_TRADE_REVIEW_MAX_SELECTION}`);
  const next = document.querySelector('[data-manual-review-action="to-strategy"]');
  if (next) next.disabled = selected.length < 1 || selected.length > MANUAL_TRADE_REVIEW_MAX_SELECTION;
  const create = document.querySelector('[data-manual-review-action="create-review"]');
  if (create) create.disabled = selected.length < 1 || !Number(state.manualTradeReviewStrategyId || $("manualTradeReviewStrategy")?.value || 0) || state.manualTradeReviewSubmitting;
  initIcons();
}

function renderManualTradeReviewTrades() {
  const host = $("manualTradeReviewTradeList");
  if (!host) return;
  const selected = manualTradeReviewSelectedMap();
  const historyScopeNotice = state.manualTradeReviewHistorySourceLimited
    ? `<div class="manual-review-source-note" role="status"><i data-lucide="info" size="16"></i><span>${escapeHtml(state.manualTradeReviewHistoryScopeNote || "MT4 只复盘终端当前可见历史；请在 MT4“账户历史”中选择“全部历史”后刷新。系统不会宣称券商全量历史。")}</span></div>`
    : "";
  if (state.manualTradeReviewLoading && !state.manualTradeReviewTrades.length) {
    host.innerHTML = '<div class="workspace-skeleton"></div><div class="workspace-skeleton"></div><div class="workspace-skeleton"></div>';
  } else if (state.manualTradeReviewUnavailable) {
    host.innerHTML = `${historyScopeNotice}<div class="manual-review-empty error" role="alert"><i data-lucide="shield-alert" size="19"></i><div><strong>手动交易证据不可用</strong><span>${escapeHtml(state.manualTradeReviewError || "历史、终端时间或成交证据尚未完整，已停止继续查找。")}</span></div><button class="btn btn-secondary btn-sm" type="button" data-manual-review-action="refresh-trades">重试</button></div>`;
  } else if (state.manualTradeReviewError) {
    host.innerHTML = `${historyScopeNotice}<div class="manual-review-empty error" role="alert"><i data-lucide="circle-alert" size="19"></i><div><strong>手动交易历史读取失败</strong><span>${escapeHtml(state.manualTradeReviewError)}</span></div><button class="btn btn-secondary btn-sm" type="button" data-manual-review-action="refresh-trades">重试</button></div>`;
  } else if (!state.manualTradeReviewTrades.length) {
    const canContinue = state.manualTradeReviewHasMore && state.manualTradeReviewNextCursor;
    const scanned = Number(state.manualTradeReviewScannedSourcePages || 0);
    host.innerHTML = historyScopeNotice + (canContinue
      ? `<div class="manual-review-empty"><i data-lucide="search-check" size="20"></i><div><strong>已检查当前范围，仍有更早记录</strong><span>本次已检查 ${scanned || 1} 个历史页，当前范围没有符合筛选的交易；继续查找会沿同一快照检查更早记录。</span></div></div>`
      : '<div class="manual-review-empty"><i data-lucide="check-check" size="20"></i><div><strong>最近 7 天没有可复盘交易</strong><span>这里只显示盈利、完整平仓且开仓订单未绑定平台信号的记录。</span></div></div>');
  } else {
    host.innerHTML = historyScopeNotice + state.manualTradeReviewTrades.map(trade => {
      const identity = manualTradeReviewIdentity(trade);
      const checked = selected.has(identity);
      const profit = Number(trade.net_profit || 0);
      return `<label class="manual-review-trade-row ${checked ? "is-selected" : ""}" data-manual-trade-row="${escapeHtml(identity)}"><span class="manual-review-trade-check"><input type="radio" name="manual-trade-review-selection" data-manual-trade-select="${escapeHtml(identity)}" ${checked ? "checked" : ""} aria-label="选择 ${escapeHtml(trade.symbol || "交易")} ${manualTradeReviewFormatTime(trade.close_time_utc_msc)}"></span><span class="manual-review-trade-main"><strong>${escapeHtml(trade.symbol || "未知品种")} <span class="status-chip info">${escapeHtml(manualTradeReviewDirectionLabel(trade.direction))}</span></strong><small>${escapeHtml(manualTradeReviewFormatTime(trade.entry_time_utc_msc))} → ${escapeHtml(manualTradeReviewFormatTime(trade.close_time_utc_msc))} · 未绑定平台信号</small><span class="manual-review-trade-meta"><span>订单 ${escapeHtml(trade.entry_order_ticket || trade.position_id || "--")}</span><span>入场 ${escapeHtml(raw(trade.entry_price))}</span><span>平仓 ${escapeHtml(raw(trade.close_price))}</span></span></span><strong class="manual-review-trade-profit positive">+${escapeHtml(fmt(profit))}</strong></label>`;
    }).join("");
  }
  renderManualTradeReviewSelectionSummary();
  initIcons();
}

function renderManualTradeReviewPager() {
  const host = $("manualTradeReviewPager");
  if (!host) return;
  const previousDisabled = state.manualTradeReviewCursorIndex <= 0 || state.manualTradeReviewLoading;
  const nextDisabled = !state.manualTradeReviewHasMore || !state.manualTradeReviewNextCursor || state.manualTradeReviewLoading;
  const continueSearch = !state.manualTradeReviewTrades.length && state.manualTradeReviewHasMore;
  const pageStatus = state.manualTradeReviewHasMore ? (continueSearch ? " · 仍有更早记录" : " · 还有更多") : " · 已检查完当前范围";
  const scanSummary = Number(state.manualTradeReviewScannedSourcePages || 0) > 1 ? ` · 已检查 ${Number(state.manualTradeReviewScannedSourcePages)} 个历史页` : "";
  host.innerHTML = `<button class="pager-btn" type="button" data-manual-review-action="previous-trades" ${previousDisabled ? "disabled" : ""}>上一页</button><span class="pager-info">游标页 ${state.manualTradeReviewCursorIndex + 1}${pageStatus}${scanSummary}</span><button class="pager-btn" type="button" data-manual-review-action="next-trades" ${nextDisabled ? "disabled" : ""}>${continueSearch ? "继续查找" : "下一页"}</button>`;
}

async function loadManualTradeReviewTrades({ reset = false, forceRefresh = false } = {}) {
  if (!canManagePlatformAiContent() || !state.token) return [];
  if (reset) {
    state.manualTradeReviewRequestVersion += 1;
    manualTradeReviewResetCursor();
    state.manualTradeReviewTrades = [];
    state.manualTradeReviewError = "";
    state.manualTradeReviewUnavailable = false;
    state.manualTradeReviewEvidenceReason = "";
    state.manualTradeReviewHistoryScopeNote = "";
    state.manualTradeReviewHistorySourceLimited = false;
    state.manualTradeReviewScannedSourcePages = 0;
    state.manualTradeReviewSkippedEmptySourcePages = 0;
    state.manualTradeReviewLoaded = false;
  }
  if (state.manualTradeReviewLoading && !forceRefresh) return state.manualTradeReviewTrades;
  const requestVersion = state.manualTradeReviewRequestVersion;
  state.manualTradeReviewLoading = true;
  state.manualTradeReviewError = "";
  renderManualTradeReviewTrades();
  renderManualTradeReviewPager();
  try {
    const data = await api(manualTradeReviewQuery({ forceRefresh }));
    if (requestVersion !== state.manualTradeReviewRequestVersion) return state.manualTradeReviewTrades;
    const pagination = data.pagination || {};
    state.manualTradeReviewTrades = Array.isArray(data.trades) ? data.trades : [];
    state.manualTradeReviewFilters.historySnapshotId = pagination.history_snapshot_id || data.history_snapshot_id || state.manualTradeReviewFilters.historySnapshotId || null;
    state.manualTradeReviewFilters.rangeStartUtcMsc = pagination.range_start_utc_msc || data.range_start_utc_msc || state.manualTradeReviewFilters.rangeStartUtcMsc || null;
    state.manualTradeReviewFilters.rangeEndUtcMsc = pagination.range_end_utc_msc || data.range_end_utc_msc || state.manualTradeReviewFilters.rangeEndUtcMsc || null;
    state.manualTradeReviewNextCursor = pagination.next_cursor || data.next_cursor || null;
    state.manualTradeReviewHasMore = Boolean(pagination.has_more ?? data.has_more);
    state.manualTradeReviewScannedSourcePages = Number(pagination.scanned_source_pages ?? data.scanned_source_pages ?? 0) || 0;
    state.manualTradeReviewSkippedEmptySourcePages = Number(pagination.skipped_empty_source_pages ?? data.skipped_empty_source_pages ?? 0) || 0;
    state.manualTradeReviewHistoryScopeNote = String(data.history_scope_note || pagination.history_scope_note || "");
    state.manualTradeReviewHistorySourceLimited = data.history_source_limited === true || pagination.history_source_limited === true;
    state.manualTradeReviewUnavailable = Boolean(data.unavailable || data.evidence_status === "unavailable");
    state.manualTradeReviewEvidenceReason = String(data.evidence_reason || data.error || "");
    if (state.manualTradeReviewUnavailable) state.manualTradeReviewError = localizeReason(state.manualTradeReviewEvidenceReason || "manual_trade_review_evidence_unavailable");
    else state.manualTradeReviewError = "";
    state.manualTradeReviewLoaded = true;
    const selected = manualTradeReviewSelectedMap();
    state.manualTradeReviewSelectedTrades = state.manualTradeReviewSelectedTrades.filter(item => selected.has(manualTradeReviewIdentity(item)));
    state.manualTradeReviewSelection = state.manualTradeReviewSelectedTrades;
    return state.manualTradeReviewTrades;
  } catch (error) {
    if (requestVersion === state.manualTradeReviewRequestVersion) state.manualTradeReviewError = localizeReason(error.code || error.message);
    if (manualTradeReviewHandleForbidden(error)) return [];
    throw error;
  } finally {
    if (requestVersion === state.manualTradeReviewRequestVersion) {
      state.manualTradeReviewLoading = false;
      renderManualTradeReviewTrades();
      renderManualTradeReviewPager();
    }
  }
}

async function moveManualTradeReviewCursor(direction) {
  if (state.manualTradeReviewLoading) return;
  if (direction === "next") {
    if (!state.manualTradeReviewHasMore || !state.manualTradeReviewNextCursor) return;
    state.manualTradeReviewCursorIndex += 1;
    state.manualTradeReviewCursorStack[state.manualTradeReviewCursorIndex] = state.manualTradeReviewNextCursor;
  } else {
    if (state.manualTradeReviewCursorIndex <= 0) return;
    state.manualTradeReviewCursorIndex -= 1;
  }
  state.manualTradeReviewFilters.cursor = state.manualTradeReviewCursorStack[state.manualTradeReviewCursorIndex] || null;
  await loadManualTradeReviewTrades();
}

async function loadManualTradeReviewStrategies() {
  if (!canManagePlatformAiContent() || !state.token) return [];
  if (state.manualTradeReviewStrategyLoading) return state.manualTradeReviewStrategies;
  state.manualTradeReviewStrategyLoading = true;
  const select = $("manualTradeReviewStrategy");
  if (select) { select.disabled = true; select.innerHTML = '<option value="">正在读取可管理的平台策略…</option>'; }
  try {
    const data = await api("/api/ai/manual-trade-reviews/strategies");
    state.manualTradeReviewStrategies = (data.strategies || []).filter(item => item.scope === "platform" && item.visibility_status !== "archived" && Number(item.is_active ?? 1) !== 0);
    if (select) {
      select.innerHTML = '<option value="">请选择平台策略</option>' + state.manualTradeReviewStrategies.map(item => `<option value="${Number(item.id)}">${escapeHtml(item.title || `平台策略 #${item.id}`)} · v${Number(item.version || 1)}</option>`).join("");
      if (state.manualTradeReviewStrategyId && state.manualTradeReviewStrategies.some(item => Number(item.id) === Number(state.manualTradeReviewStrategyId))) select.value = String(state.manualTradeReviewStrategyId);
      select.disabled = false;
    }
    return state.manualTradeReviewStrategies;
  } catch (error) {
    if (select) { select.innerHTML = '<option value="">平台策略读取失败</option>'; select.disabled = true; }
    if (manualTradeReviewHandleForbidden(error)) return [];
    throw error;
  } finally { state.manualTradeReviewStrategyLoading = false; renderManualTradeReviewSelectionSummary(); }
}

function setManualTradeReviewStage(target, { loadData = true } = {}) {
  if (!canManagePlatformAiContent()) {
    if (target === "manual-trades") toast("当前账号没有手动交易复盘权限", "warning");
    return;
  }
  const next = ["selection", "strategy", "result"].includes(target) ? target : "selection";
  state.manualTradeReviewView = next;
  document.querySelectorAll("[data-manual-stage]").forEach(panel => {
    const active = panel.dataset.manualStage === next;
    panel.hidden = !active;
    panel.classList.toggle("active", active);
  });
  const order = ["selection", "strategy", "result"];
  document.querySelectorAll("[data-manual-step]").forEach(step => {
    const index = order.indexOf(step.dataset.manualStep);
    const current = order.indexOf(next);
    step.classList.toggle("active", index === current);
    step.classList.toggle("done", index < current);
  });
  if (next === "strategy" && loadData && !state.manualTradeReviewStrategyLoading && !state.manualTradeReviewStrategies.length) loadManualTradeReviewStrategies().catch(error => toast(localizeReason(error.code || error.message), "error"));
  if (next === "result" && loadData) loadManualTradeReviewHistory({ reset:!state.manualTradeReviewHistoryLoaded }).catch(error => toast(localizeReason(error.code || error.message), "error"));
  renderManualTradeReviewTrades();
  initIcons();
}

async function loadManualTradeReviewWorkspace({ force = false } = {}) {
  if (!canManagePlatformAiContent() || !state.token) return;
  setManualTradeReviewStage(state.manualTradeReviewView || "selection", { loadData:false });
  if (!state.manualTradeReviewLoaded || force) await loadManualTradeReviewTrades({ reset:true, forceRefresh:force });
  if (state.manualTradeReviewView === "strategy" && !state.manualTradeReviewStrategies.length) await loadManualTradeReviewStrategies();
  if (state.manualTradeReviewView === "result" && !state.manualTradeReviewHistoryLoaded) await loadManualTradeReviewHistory({ reset:true });
  if (state.manualTradeReviewView === "result" && state.manualTradeReviewDetail) scheduleManualTradeReviewPolling(state.manualTradeReviewDetail);
}

function manualTradeReviewBuildClientRequestId() {
  try { if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID(); } catch {}
  return `manual-review-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function manualTradeReviewEnsureClientRequestId() {
  if (!state.manualTradeReviewClientRequestId) state.manualTradeReviewClientRequestId = manualTradeReviewBuildClientRequestId();
  return state.manualTradeReviewClientRequestId;
}

function manualTradeReviewResetClientRequestId() {
  state.manualTradeReviewClientRequestId = null;
}

async function createManualTradeReviewTask() {
  if (!canManagePlatformAiContent() || state.manualTradeReviewSubmitting) return;
  const selected = state.manualTradeReviewSelectedTrades || [];
  const strategyId = Number(state.manualTradeReviewStrategyId || $("manualTradeReviewStrategy")?.value || 0);
  if (selected.length < 1 || selected.length > MANUAL_TRADE_REVIEW_MAX_SELECTION) throw new Error("manual_trade_review_selection_invalid");
  if (!strategyId) throw new Error("platform_strategy_required");
  const clientRequestId = manualTradeReviewEnsureClientRequestId();
  state.manualTradeReviewSubmitting = true;
  renderManualTradeReviewSelectionSummary();
  try {
    const data = await api("/api/ai/manual-trade-reviews", { method:"POST", timeout:30_000, body:{
      client_request_id:clientRequestId, strategy_id:strategyId,
      user_thesis_text:String($("manualTradeReviewThesis")?.value || "").trim(),
      trades:selected.map(item => ({ trade_id:item.trade_id, source_identity_hash:item.source_identity_hash, trade_source_hash:item.trade_source_hash,
        position_id:item.position_id || null, entry_order_ticket:item.entry_order_ticket || null })),
    } });
    // A successful response is the only point at which this draft's request
    // token is known to have a durable outcome.  If the request timed out or
    // failed before this line, keep the token so a retry replays safely.
    manualTradeReviewResetClientRequestId();
    const id = Number(data.case?.id || 0);
    state.manualTradeReviewSelectedId = id || null;
    state.selectedManualTradeReviewId = state.manualTradeReviewSelectedId;
    state.manualTradeReviewDetail = null;
    state.manualTradeReviewHistoryLoaded = false;
    setManualTradeReviewStage("result", { loadData:false });
    await loadManualTradeReviewHistory({ reset:true });
    if (id) await openManualTradeReviewDetail(id);
    toast(data.created === false ? "已恢复已有手动交易复盘任务" : "复盘任务已创建，正在生成", "success");
  } finally {
    state.manualTradeReviewSubmitting = false;
    renderManualTradeReviewSelectionSummary();
  }
}

function manualTradeReviewCaseStatus(item) {
  const businessStatus = String(item?.status || "").toLowerCase();
  if (businessStatus && businessStatus !== "queued") return businessStatus;
  return item?.progress_stage || item?.job_status || businessStatus || "queued";
}

function renderManualTradeReviewHistory() {
  const host = $("manualTradeReviewHistoryList");
  if (!host) return;
  const rows = state.manualTradeReviewCases || [];
  setText("manualTradeReviewHistoryCount", `${rows.length} 条`);
  if (state.manualTradeReviewHistoryLoading && !rows.length) host.innerHTML = '<div class="workspace-skeleton"></div><div class="workspace-skeleton"></div>';
  else if (state.manualTradeReviewHistoryError) host.innerHTML = `<div class="manual-review-empty error" role="alert"><i data-lucide="circle-alert" size="17"></i><span>${escapeHtml(state.manualTradeReviewHistoryError)}</span><button class="btn btn-secondary btn-sm" type="button" data-manual-review-action="refresh-history">重试</button></div>`;
  else if (!rows.length) host.innerHTML = '<div class="manual-review-empty compact"><i data-lucide="file-clock" size="18"></i><span>还没有手动交易复盘；从第一阶段创建一条任务。</span></div>';
  else host.innerHTML = rows.map(item => {
    const status = manualTradeReviewCaseStatus(item);
    const active = Number(item.id) === Number(state.manualTradeReviewSelectedId);
    return `<button type="button" class="manual-review-history-row ${active ? "active" : ""}" data-manual-review-action="open-history" data-manual-review-id="${Number(item.id)}"><span class="manual-review-history-icon ${manualTradeReviewStatusTone(status)}"><i data-lucide="${status === "failed" ? "circle-alert" : status === "approved" ? "check-circle-2" : "file-clock"}" size="16"></i></span><span><strong>复盘 #${Number(item.id)} · 策略 v${Number(item.strategy_version || 1)}</strong><small>${escapeHtml(manualTradeReviewStatusLabel(status))} · ${escapeHtml(manualTradeReviewFormatTime(item.updated_at || item.created_at))}</small></span><i data-lucide="chevron-right" size="15"></i></button>`;
  }).join("");
  const pager = $("manualTradeReviewHistoryPager");
  if (pager) pager.innerHTML = `<button class="pager-btn" type="button" data-manual-review-action="previous-history" ${state.manualTradeReviewHistoryOffset <= 0 || state.manualTradeReviewHistoryLoading ? "disabled" : ""}>上一页</button><span class="pager-info">第 ${Math.floor(state.manualTradeReviewHistoryOffset / state.manualTradeReviewHistoryPageSize) + 1} 页</span><button class="pager-btn" type="button" data-manual-review-action="next-history" ${rows.length < state.manualTradeReviewHistoryPageSize || state.manualTradeReviewHistoryLoading ? "disabled" : ""}>下一页</button>`;
  initIcons();
}

async function loadManualTradeReviewHistory({ reset = false } = {}) {
  if (!canManagePlatformAiContent() || !state.token) return [];
  if (reset) state.manualTradeReviewHistoryOffset = 0;
  if (state.manualTradeReviewHistoryLoading) return state.manualTradeReviewCases;
  state.manualTradeReviewHistoryLoading = true;
  state.manualTradeReviewHistoryError = "";
  renderManualTradeReviewHistory();
  try {
    const params = new URLSearchParams({ limit:String(state.manualTradeReviewHistoryPageSize), offset:String(state.manualTradeReviewHistoryOffset) });
    const data = await api(`/api/ai/manual-trade-reviews?${params.toString()}`);
    state.manualTradeReviewCases = Array.isArray(data.cases) ? data.cases : [];
    state.manualTradeReviewHistoryLoaded = true;
    return state.manualTradeReviewCases;
  } catch (error) {
    state.manualTradeReviewHistoryError = localizeReason(error.code || error.message);
    if (manualTradeReviewHandleForbidden(error)) return [];
    throw error;
  } finally { state.manualTradeReviewHistoryLoading = false; renderManualTradeReviewHistory(); }
}

function stopManualTradeReviewPolling() {
  if (state.manualTradeReviewPollTimer) clearTimeout(state.manualTradeReviewPollTimer);
  state.manualTradeReviewPollTimer = null;
  state.manualTradeReviewPollGeneration += 1;
  state.manualTradeReviewPollRetryAttempt = 0;
  state.manualTradeReviewPollWaitingForVisible = false;
  state.manualTradeReviewPollInFlight = false;
}

function manualTradeReviewShouldPoll(detail) {
  if (!detail) return false;
  const jobStatus = String(detail.job_status || "").toLowerCase();
  const caseStatus = String(detail.status || "").toLowerCase();
  if (["draft", "edited", "needs_revision", "approved", "failed", "deferred"].includes(caseStatus)) return false;
  return !MANUAL_TRADE_REVIEW_TERMINAL_JOBS.has(jobStatus);
}

const MANUAL_TRADE_REVIEW_POLL_MAX_RETRY_DELAY_MS = 30_000;
const MANUAL_TRADE_REVIEW_POLL_STOP_ERROR_CODES = new Set([
  "manual_trade_review_not_found", "manual_trade_review_job_not_found", "manual_trade_review_retry_not_allowed",
  "manual_trade_review_generation_failed", "manual_trade_review_source_changed", "manual_trade_review_forbidden",
]);

function manualTradeReviewPollDelayMs({ immediate = false } = {}) {
  if (immediate) return 0;
  const attempt = Number(state.manualTradeReviewPollRetryAttempt || 0);
  if (!attempt) return MANUAL_TRADE_REVIEW_POLL_INTERVAL_MS;
  return Math.min(MANUAL_TRADE_REVIEW_POLL_INTERVAL_MS * (2 ** Math.min(attempt, 4)), MANUAL_TRADE_REVIEW_POLL_MAX_RETRY_DELAY_MS);
}

function manualTradeReviewPollErrorIsTerminal(error) {
  const code = String(error?.code || "").trim();
  return Number(error?.status) === 401 || Number(error?.status) === 403 || MANUAL_TRADE_REVIEW_POLL_STOP_ERROR_CODES.has(code);
}

function manualTradeReviewHandlePollError(error, generation) {
  if (generation !== state.manualTradeReviewPollGeneration) return;
  if (Number(error?.status) === 401) {
    stopManualTradeReviewPolling();
    return;
  }
  if (Number(error?.status) === 403 || error?.code === "manual_trade_review_forbidden") {
    if (!manualTradeReviewHandleForbidden(error)) stopManualTradeReviewPolling();
    return;
  }
  if (manualTradeReviewPollErrorIsTerminal(error)) {
    state.manualTradeReviewDetailError = manualTradeReviewReasonText(error?.code || error?.message, "复盘任务已停止，请刷新复盘历史");
    stopManualTradeReviewPolling();
    renderManualTradeReviewDetail();
    return;
  }
  state.manualTradeReviewPollRetryAttempt = Math.min(Number(state.manualTradeReviewPollRetryAttempt || 0) + 1, 8);
  scheduleManualTradeReviewPolling(state.manualTradeReviewDetail);
}

function scheduleManualTradeReviewPolling(detail, { immediate = false } = {}) {
  if (!manualTradeReviewShouldPoll(detail) || !state.manualTradeReviewSelectedId) return;
  if (state.manualTradeReviewPollTimer) clearTimeout(state.manualTradeReviewPollTimer);
  if (document.visibilityState === "hidden") {
    state.manualTradeReviewPollWaitingForVisible = true;
    state.manualTradeReviewPollTimer = null;
    return;
  }
  state.manualTradeReviewPollWaitingForVisible = false;
  const generation = state.manualTradeReviewPollGeneration;
  const delay = manualTradeReviewPollDelayMs({ immediate });
  state.manualTradeReviewPollTimer = setTimeout(() => {
    state.manualTradeReviewPollTimer = null;
    if (generation !== state.manualTradeReviewPollGeneration || document.visibilityState === "hidden") {
      if (generation === state.manualTradeReviewPollGeneration) state.manualTradeReviewPollWaitingForVisible = true;
      return;
    }
    pollManualTradeReviewJob(Number(state.manualTradeReviewSelectedId), generation).catch(error => manualTradeReviewHandlePollError(error, generation));
  }, delay);
}

function resumeManualTradeReviewPolling() {
  if (document.visibilityState === "hidden") return;
  if (!state.manualTradeReviewSelectedId || !state.manualTradeReviewDetail) return;
  if (!manualTradeReviewShouldPoll(state.manualTradeReviewDetail)) return;
  scheduleManualTradeReviewPolling(state.manualTradeReviewDetail, { immediate:true });
}

async function pollManualTradeReviewJob(caseId, generation = state.manualTradeReviewPollGeneration) {
  if (!caseId || generation !== state.manualTradeReviewPollGeneration || state.manualTradeReviewPollInFlight) return;
  state.manualTradeReviewPollInFlight = true;
  try {
    const data = await api(`/api/ai/manual-trade-reviews/${caseId}/job-status`);
    if (generation !== state.manualTradeReviewPollGeneration || Number(state.manualTradeReviewSelectedId) !== Number(caseId)) return;
    state.manualTradeReviewPollRetryAttempt = 0;
    state.manualTradeReviewDetail = { ...(state.manualTradeReviewDetail || {}),
      job_id:data.job?.id ?? state.manualTradeReviewDetail?.job_id,
      job_status:data.job?.status ?? state.manualTradeReviewDetail?.job_status,
      progress_stage:data.job?.progress_stage ?? state.manualTradeReviewDetail?.progress_stage,
      attempt_count:data.job?.attempt_count ?? state.manualTradeReviewDetail?.attempt_count,
      max_attempts:data.job?.max_attempts ?? state.manualTradeReviewDetail?.max_attempts,
      last_error_code:data.job?.last_error_code ?? state.manualTradeReviewDetail?.last_error_code,
    };
    renderManualTradeReviewDetail();
    if (!manualTradeReviewShouldPoll(state.manualTradeReviewDetail)) {
      await openManualTradeReviewDetail(caseId, { silent:true });
    } else scheduleManualTradeReviewPolling(state.manualTradeReviewDetail);
  } finally {
    state.manualTradeReviewPollInFlight = false;
  }
}

function manualTradeReviewProgressHtml(detail) {
  const current = String(detail?.progress_stage || detail?.job_status || detail?.status || "queued");
  const stages = [["preparing", "准备证据"], ["counterfactual_analysis", "开仓前盲测"], ["outcome_review", "事后复盘"], ["completed", "完成"]];
  const currentIndex = current === "completed" || detail?.status === "draft" ? 3 : Math.max(0, stages.findIndex(item => item[0] === current));
  return `<div class="manual-review-progress" role="status" aria-live="polite"><div class="manual-review-progress-heading"><strong>生成进度</strong><span>${escapeHtml(manualTradeReviewStatusLabel(current))}</span></div><div class="manual-review-progress-track">${stages.map(([key,label], index) => `<div class="${index < currentIndex ? "done" : index === currentIndex ? "active" : ""}"><span>${index < currentIndex ? "✓" : index + 1}</span><small>${label}</small></div>`).join("")}</div></div>`;
}

function renderManualTradeReviewV2Detail({ detail, currentVersion, content, caseStatus, tone, editable, approved, sources }) {
  const host = $("manualTradeReviewDetail");
  detail = { ...detail, evidence_reason: manualTradeReviewReasonText(detail?.evidence_reason) };
  const counterfactual = content.counterfactual_analysis || {};
  const hypotheses = Array.isArray(content.strategy_optimization_hypotheses) ? content.strategy_optimization_hypotheses : [];
  const rules = Array.isArray(content.rule_comparisons) ? content.rule_comparisons : [];
  const source = sources[0]?.normalized_trade || {};
  const evidenceBanner = detail.evidence_status !== "complete" ? `<div class="manual-review-evidence-banner warning" role="status"><i data-lucide="triangle-alert" size="16"></i><span><strong>证据不足</strong>：${escapeHtml(manualTradeReviewReasonText(detail.evidence_reason))}</span></div>` : "";
  const failedBanner = caseStatus === "failed" ? `<div class="manual-review-evidence-banner danger" role="alert"><i data-lucide="circle-alert" size="16"></i><span><strong>生成失败</strong>：${escapeHtml(localizeReason(detail.last_error_code || "manual_trade_review_generation_failed"))}</span><button class="btn btn-secondary btn-sm" type="button" data-manual-review-action="retry-review" data-manual-review-id="${Number(detail.id)}">重试生成</button></div>` : "";
  host.innerHTML = `<header class="manual-review-detail-header"><div><span class="review-section-kicker">复盘 #${Number(detail.id)}</span><h4>${escapeHtml(detail.strategy_snapshot?.title || `平台策略 #${Number(detail.strategy_id || 0)}`)} · v${Number(detail.strategy_version || 1)}</h4><p>${escapeHtml(source.symbol || "订单")} · ${escapeHtml(source.identity?.entry_order_ticket || source.identity?.position_id || "--")} · 未绑定平台信号</p></div><span class="status-chip ${tone}">${escapeHtml(manualTradeReviewStatusLabel(caseStatus))}</span></header>${manualTradeReviewShouldPoll(detail) ? manualTradeReviewProgressHtml(detail) : ""}${evidenceBanner}${failedBanner}<section class="manual-review-conclusion"><div class="manual-review-conclusion-heading"><span class="review-section-kicker">结论</span><span>版本 ${Number(currentVersion.version_no || 1)} · 两阶段冻结</span></div><p>${escapeHtml(content.review_summary || "暂无复盘摘要")}</p><div class="manual-review-conclusion-metrics"><span><small>盲测决策</small><strong>${escapeHtml(manualTradeReviewValueLabel(counterfactual.decision, "证据不足"))}</strong></span><span><small>与实际方向</small><strong>${escapeHtml(manualTradeReviewValueLabel(content.counterfactual_match, "证据不足"))}</strong></span><span><small>策略符合度</small><strong>${escapeHtml(manualTradeReviewValueLabel(content.strategy_alignment))}</strong></span><span><small>决策质量</small><strong>${escapeHtml(manualTradeReviewValueLabel(content.decision_quality, "证据不足"))}</strong></span></div></section><section class="manual-review-result-section"><header><span><i data-lucide="scan-search" size="15"></i><strong>阶段 A · 开仓前盲测</strong></span><small>不含实际盈亏与方向</small></header><p>${escapeHtml(counterfactual.reasoning || "证据不足，无法形成开仓前判断")}</p>${manualTradeReviewListHtml("当时策略信号", counterfactual.strategy_signals, "activity")}${manualTradeReviewListHtml("阻断条件", counterfactual.blocking_rules, "shield-alert")}</section><section class="manual-review-result-section"><header><span><i data-lucide="receipt-text" size="15"></i><strong>阶段 B · 盈利归因</strong></span><small>查看完整结果后</small></header><p><b>为什么盈利：</b>${escapeHtml(content.why_profitable || "暂无说明")}</p><p><b>市场适配：</b>${escapeHtml(content.profit_attribution?.market_fit || "暂无说明")}</p><p><b>入场质量：</b>${escapeHtml(content.profit_attribution?.entry_quality || "暂无说明")}</p><p><b>退出质量：</b>${escapeHtml(content.profit_attribution?.exit_quality || "暂无说明")}</p><p><b>偶然因素：</b>${escapeHtml(content.profit_attribution?.luck_or_uncontrolled_factors || "暂无说明")}</p></section>${manualTradeReviewListHtml("策略规则对照", rules, "git-compare")}${manualTradeReviewListHtml("策略有效点", content.strengths, "badge-check")}${manualTradeReviewListHtml("问题与风险", content.issues, "triangle-alert")}${hypotheses.length ? `<section class="manual-review-result-section"><header><span><i data-lucide="flask-conical" size="15"></i><strong>待验证优化假设</strong></span><small>不自动改策略、不写入记忆</small></header><div class="manual-review-optimization-list">${hypotheses.map(item => `<article><div><strong>${escapeHtml(item.proposed_change || "观察假设")}</strong><span class="status-chip info">${escapeHtml(manualTradeReviewValueLabel(item.state, "待验证假设"))}</span></div><p>目标规则：${escapeHtml(item.target_path || "仅观察")}</p><p>缺口：${escapeHtml(item.observed_gap || "暂无说明")}</p><p class="manual-review-risk">风险：${escapeHtml(item.risk_if_applied || "暂无说明")}</p><small>验证要求：${escapeHtml(item.validation_needed || "需要更多独立样本和人工验证")}</small></article>`).join("")}</div></section>` : ""}${editable ? `<section class="manual-review-editor"><header><span><i data-lucide="pencil" size="15"></i><strong>人工编辑</strong></span><small>保存为新版本，不改变冻结证据</small></header><textarea data-manual-content-editor rows="14" spellcheck="false">${escapeHtml(JSON.stringify(content, null, 2))}</textarea><div class="manual-review-editor-actions"><button class="btn btn-secondary" type="button" data-manual-review-action="save-edit" data-manual-review-id="${Number(detail.id)}" data-manual-version-id="${Number(currentVersion.id)}">保存人工修订</button></div></section>` : ""}<footer class="manual-review-detail-actions"><button class="btn btn-secondary btn-sm" type="button" data-manual-review-action="open-strategy-editor" data-manual-review-id="${Number(detail.id)}">打开策略编辑器</button>${!approved ? `<button class="btn btn-ghost btn-sm" type="button" data-manual-review-action="defer-review" data-manual-review-id="${Number(detail.id)}" data-manual-version-id="${Number(currentVersion.id)}">稍后处理</button><button class="btn btn-secondary btn-sm" type="button" data-manual-review-action="mark-problem" data-manual-review-id="${Number(detail.id)}" data-manual-version-id="${Number(currentVersion.id)}">标记需要修改</button><button class="btn btn-primary btn-sm" type="button" data-manual-review-action="approve-review" data-manual-review-id="${Number(detail.id)}" data-manual-version-id="${Number(currentVersion.id)}">确认复盘</button>` : '<span class="status-chip success">复盘已确认 · 未写入经验或策略</span>'}</footer>`;
}

function manualTradeReviewListHtml(title, items, icon = "list-checks") {
  const rows = Array.isArray(items) ? items.filter(Boolean) : [];
  return `<section class="manual-review-result-section"><header><span><i data-lucide="${icon}" size="15"></i><strong>${escapeHtml(title)}</strong></span><small>${rows.length} 条</small></header>${rows.length ? `<ul>${rows.map(item => `<li>${escapeHtml(typeof item === "string" ? item : item.lesson || item.proposed_change || item.rule_summary || item.summary || "暂无说明")}</li>`).join("")}</ul>` : '<p class="manual-review-muted">暂无记录</p>'}</section>`;
}

function renderManualTradeReviewDetail() {
  const host = $("manualTradeReviewDetail");
  if (!host) return;
  const detail = state.manualTradeReviewDetail;
  if (state.manualTradeReviewDetailLoading && !detail) { host.innerHTML = '<div class="workspace-skeleton"></div><div class="workspace-skeleton"></div>'; return; }
  if (state.manualTradeReviewDetailError) { host.innerHTML = `<div class="manual-review-empty error" role="alert"><i data-lucide="circle-alert" size="19"></i><span>${escapeHtml(state.manualTradeReviewDetailError)}</span><button class="btn btn-secondary btn-sm" type="button" data-manual-review-action="reload-detail">重新加载</button></div>`; return; }
  if (!detail || !detail.id) { host.innerHTML = '<div class="empty-state"><span class="review-empty-icon"><i data-lucide="file-search" size="20"></i></span><strong>选择一条复盘</strong><span>任务创建后会在这里显示冻结证据、反事实判断、盈利归因和策略优化假设。</span></div>'; return; }
  const currentVersion = (detail.versions || []).find(version => Number(version.id) === Number(detail.current_version_id)) || (detail.versions || []).at(-1);
  const content = currentVersion?.content || {};
  const businessCaseStatus = String(detail.status || "").toLowerCase();
  const caseStatus = businessCaseStatus && businessCaseStatus !== "queued"
    ? businessCaseStatus
    : String(detail.job_status || businessCaseStatus || "queued").toLowerCase();
  const tone = manualTradeReviewStatusTone(caseStatus);
  const evidenceComplete = detail.evidence_status === "complete" && content.evidence_quality !== "insufficient";
  const editable = Boolean(currentVersion && content.output_contract_version === "manual-trade-review-v2"
    && ["draft", "edited", "needs_revision"].includes(caseStatus));
  const approved = caseStatus === "approved";
  // Historical v1 rows may contain experience candidates. Keep the old review
  // readable, but never expose those candidates as an actionable UI path.
  const candidates = [];
  const eligibleCandidates = candidates.filter(item => item.eligibility === "eligible");
  const assessments = Array.isArray(content.trade_assessments) ? content.trade_assessments : [];
  const rules = Array.isArray(content.rule_comparisons) ? content.rule_comparisons : [];
  const optimizations = Array.isArray(content.strategy_optimization_candidates) ? content.strategy_optimization_candidates : [];
  const sources = Array.isArray(detail.sources) ? detail.sources : [];
  if (currentVersion && content.output_contract_version === "manual-trade-review-v2") {
    renderManualTradeReviewV2Detail({ detail, currentVersion, content, caseStatus, tone, editable, approved, sources });
    initIcons();
    return;
  }
  host.innerHTML = `<header class="manual-review-detail-header"><div><span class="review-section-kicker">复盘 #${Number(detail.id)}</span><h4>${escapeHtml(detail.strategy_snapshot?.title || `平台策略 #${Number(detail.strategy_id || 0)}`)} · v${Number(detail.strategy_version || detail.strategy_snapshot?.version || 1)}</h4><p>${sources.length || 0} 笔冻结交易 · 创建于 ${escapeHtml(manualTradeReviewFormatTime(detail.created_at))}</p></div><span class="status-chip ${tone}"><i data-lucide="${tone === "success" ? "check-circle-2" : tone === "danger" ? "circle-alert" : "clock-3"}" size="13"></i>${escapeHtml(manualTradeReviewStatusLabel(caseStatus))}</span></header>${manualTradeReviewShouldPoll(detail) ? manualTradeReviewProgressHtml(detail) : ""}${detail.evidence_status !== "complete" ? `<div class="manual-review-evidence-banner warning" role="status"><i data-lucide="triangle-alert" size="16"></i><span><strong>证据不足</strong>：${escapeHtml(detail.evidence_reason || "行情或历史证据尚未完整")}</span></div>` : ""}${caseStatus === "failed" ? `<div class="manual-review-evidence-banner danger" role="alert"><i data-lucide="circle-alert" size="16"></i><span><strong>生成失败</strong>：${escapeHtml(localizeReason(detail.last_error_code || "manual_trade_review_generation_failed"))}</span><button class="btn btn-secondary btn-sm" type="button" data-manual-review-action="retry-review" data-manual-review-id="${Number(detail.id)}">重试生成</button></div>` : ""}${currentVersion ? `<section class="manual-review-conclusion"><div class="manual-review-conclusion-heading"><span class="review-section-kicker">结论优先</span><span>版本 ${Number(currentVersion.version_no || 1)} · ${currentVersion.author_type === "model" ? "模型生成" : "人工修订"}</span></div><p>${escapeHtml(content.review_summary || "暂无复盘摘要")}</p><div class="manual-review-conclusion-metrics"><span><small>证据质量</small><strong>${escapeHtml(content.evidence_quality || (evidenceComplete ? "complete" : "insufficient"))}</strong></span><span><small>行情合理性</small><strong>${escapeHtml(content.market_alignment || "unknown")}</strong></span><span><small>策略符合度</small><strong>${escapeHtml(content.strategy_alignment || "unknown")}</strong></span><span><small>决策质量</small><strong>${escapeHtml(content.decision_quality || "insufficient_evidence")}</strong></span></div></section>${manualTradeReviewListHtml("优势", content.strengths, "badge-check")}${manualTradeReviewListHtml("问题与风险", content.issues, "triangle-alert")}<section class="manual-review-result-section"><header><span><i data-lucide="receipt-text" size="15"></i><strong>逐笔评估</strong></span><small>${assessments.length} 笔</small></header>${assessments.length ? `<div class="manual-review-assessment-list">${assessments.map(item => `<article><div class="manual-review-assessment-head"><strong>${escapeHtml(item.source_identity_hash || "交易来源")}</strong><span class="status-chip ${item.strategy_alignment === "aligned" ? "success" : item.strategy_alignment === "conflict" ? "danger" : "warning"}">${escapeHtml(item.strategy_alignment || "unknown")}</span></div><p><b>行情</b> ${escapeHtml(item.market_reason || "暂无说明")}</p><p><b>策略</b> ${escapeHtml(item.strategy_reason || "暂无说明")}</p><p><b>决策</b> ${escapeHtml(item.decision_reason || "暂无说明")}</p><small>盈亏独立性：${escapeHtml(item.outcome_independence_note || "未说明")}</small></article>`).join("")}</div>` : '<p class="manual-review-muted">暂无逐笔评估</p>'}</section>${manualTradeReviewListHtml("策略规则对照", rules, "git-compare")}${optimizations.length ? `<section class="manual-review-result-section"><header><span><i data-lucide="wand-sparkles" size="15"></i><strong>优化建议与风险</strong></span><small>${optimizations.length} 条 · 不会自动改策略</small></header><div class="manual-review-optimization-list">${optimizations.map(item => `<article><div><strong>${escapeHtml(item.proposed_change || "观察项")}</strong><span class="status-chip ${item.recommendation_state === "ready_for_human_review" ? "warning" : "info"}">${escapeHtml(item.recommendation_state || "observe")}</span></div><p>目标规则：${escapeHtml(item.target_path || "仅观察，不指定规则")}</p><p>适用时机：${escapeHtml(JSON.stringify(item.applicable_when || {}))}</p><p class="manual-review-risk">风险：${escapeHtml(item.risk_if_applied || "暂无说明")}</p></article>`).join("")}</div></section>` : ""}${candidates.length ? `<section class="manual-review-result-section manual-review-candidates"><header><span><i data-lucide="brain-circuit" size="15"></i><strong>平台经验候选</strong></span><small>${eligibleCandidates.length} 条可候选 · 需单独确认</small></header><p class="manual-review-muted">确认复盘不会自动创建候选；只有显式勾选合格内容后才会写入 candidate，仍不会直接发布为 active。</p><div class="manual-review-candidate-list">${candidates.map(item => { const eligible = item.eligibility === "eligible"; return `<label class="manual-review-candidate-row ${eligible ? "" : "is-disabled"}"><input type="checkbox" data-manual-candidate-select="${escapeHtml(item.candidate_id)}" ${eligible && approved ? "" : "disabled"} aria-label="选择经验候选 ${escapeHtml(item.candidate_id)}"><span><strong>${escapeHtml(item.lesson || item.candidate_id || "未命名候选")}</strong><small>${escapeHtml(item.eligibility_reason || (eligible ? "证据完整，可单独创建 candidate" : "证据不足，仅保留观察"))}</small></span><em>${eligible ? "可候选" : "不可候选"}</em></label>`; }).join("")}</div>${approved && eligibleCandidates.length ? '<button class="btn btn-secondary" type="button" data-manual-review-action="create-candidates" data-manual-review-id="' + Number(detail.id) + '"><i data-lucide="plus-circle" size="15"></i>创建已勾选 candidate</button>' : ""}</section>` : ""}${editable ? `<section class="manual-review-editor"><header><span><i data-lucide="pencil" size="15"></i><strong>人工编辑</strong></span><small>保存会创建新版本，不覆盖冻结证据</small></header><textarea data-manual-content-editor rows="14" spellcheck="false">${escapeHtml(JSON.stringify(content, null, 2))}</textarea><div class="manual-review-editor-actions"><button class="btn btn-secondary" type="button" data-manual-review-action="save-edit" data-manual-review-id="${Number(detail.id)}" data-manual-version-id="${Number(currentVersion.id)}">保存人工修订</button></div></section>` : ""}<footer class="manual-review-detail-actions"><button class="btn btn-secondary btn-sm" type="button" data-manual-review-action="open-strategy-editor" data-manual-review-id="${Number(detail.id)}">打开策略编辑器</button>${!approved && currentVersion ? `<button class="btn btn-ghost btn-sm" type="button" data-manual-review-action="defer-review" data-manual-review-id="${Number(detail.id)}" data-manual-version-id="${Number(currentVersion.id)}">稍后处理</button><button class="btn btn-secondary btn-sm" type="button" data-manual-review-action="mark-problem" data-manual-review-id="${Number(detail.id)}" data-manual-version-id="${Number(currentVersion.id)}">标记需要修改</button><button class="btn btn-primary btn-sm" type="button" data-manual-review-action="approve-review" data-manual-review-id="${Number(detail.id)}" data-manual-version-id="${Number(currentVersion.id)}"><i data-lucide="check" size="14"></i>确认复盘</button>` : approved ? '<span class="status-chip success">复盘已确认 · 未自动发布经验</span>' : ""}</footer>` : `<div class="manual-review-empty"><i data-lucide="loader-circle" size="19"></i><span>任务尚未生成可编辑版本，后台会继续轮询。</span></div>`}`;
  initIcons();
}

async function openManualTradeReviewDetail(caseId, { silent = false } = {}) {
  const id = Number(caseId);
  if (!id || !canManagePlatformAiContent()) return null;
  const previousId = Number(state.manualTradeReviewSelectedId || 0);
  const requestVersion = Number(state.manualTradeReviewDetailRequestVersion || 0) + 1;
  state.manualTradeReviewDetailRequestVersion = requestVersion;
  stopManualTradeReviewPolling();
  state.manualTradeReviewSelectedId = id;
  state.selectedManualTradeReviewId = id;
  if (previousId !== id) state.manualTradeReviewDetail = null;
  state.manualTradeReviewDetailLoading = true;
  state.manualTradeReviewDetailError = "";
  if (!silent) renderManualTradeReviewHistory();
  renderManualTradeReviewDetail();
  try {
    const data = await api(`/api/ai/manual-trade-reviews/${id}`);
    if (requestVersion !== state.manualTradeReviewDetailRequestVersion || Number(state.manualTradeReviewSelectedId) !== id) return null;
    state.manualTradeReviewDetail = data.review || null;
    return state.manualTradeReviewDetail;
  } catch (error) {
    if (requestVersion !== state.manualTradeReviewDetailRequestVersion || Number(state.manualTradeReviewSelectedId) !== id) return null;
    state.manualTradeReviewDetailError = localizeReason(error.code || error.message);
    if (manualTradeReviewHandleForbidden(error)) return null;
    throw error;
  } finally {
    if (requestVersion !== state.manualTradeReviewDetailRequestVersion || Number(state.manualTradeReviewSelectedId) !== id) return;
    state.manualTradeReviewDetailLoading = false;
    renderManualTradeReviewHistory();
    renderManualTradeReviewDetail();
    if (state.manualTradeReviewDetail && Number(state.manualTradeReviewSelectedId) === id) scheduleManualTradeReviewPolling(state.manualTradeReviewDetail);
  }
}

async function refreshManualTradeReviewTab() {
  if (state.manualTradeReviewView === "result") {
    await loadManualTradeReviewHistory({ reset:true });
    if (state.manualTradeReviewSelectedId) await openManualTradeReviewDetail(state.manualTradeReviewSelectedId, { silent:true });
  } else if (state.manualTradeReviewView === "strategy") {
    await loadManualTradeReviewStrategies();
  } else {
    await loadManualTradeReviewTrades({ reset:true, forceRefresh:true });
  }
}

async function refreshReviewMemoryTab() {
  if (state.reviewMemoryView === "manual-trades") return refreshManualTradeReviewTab();
  if (state.reviewMemoryView === "memories") {
    await loadReviewMemory();
    return;
  }
  await loadReviewCaseStream({ reset:true });
  await loadReviewSummary({ announce:false });
}

async function openManualReviewStrategyEditor(detail) {
  if (!canManagePlatformAiContent()) return;
  const strategyId = Number(detail?.strategy_id || detail?.strategy_snapshot?.id || 0);
  if (!strategyId) throw new Error("manual_trade_review_strategy_not_found");
  // Load the current strategy through the ordinary strategy catalogue and
  // open that exact record. The review suggestion itself is never copied into
  // editable fields and no save request is issued on behalf of the user.
  setTab("model-strategy", { skipRefresh:true });
  await loadStrategyCatalog();
  const strategy = (state.strategies || []).find(item => Number(item.id) === strategyId && item.scope === "platform");
  if (!strategy) throw new Error("manual_trade_review_strategy_not_found");
  openStrategyEditor(strategy);
  const source = detail?.strategy_snapshot;
  const boundary = $("strategyEditorBoundary");
  if (boundary) boundary.textContent = `复盘来源仅供只读参考：${source?.title || `平台策略 #${Number(detail?.strategy_id || 0)}`} · v${Number(source?.version || detail?.strategy_version || 1)}。编辑器不会自动填充或保存任何复盘建议。`;
}

async function saveUserFeatureFlags() {
  await api("/api/ai/feature-flags", { method:"PUT", body:{ review_generation_enabled:$("userReviewGenerationFlag").checked } });
  toast("个人复盘设置已保存", "success"); await loadReviewMemory();
}

function renderReviewCases() {
  const host = $("reviewCaseList"); if (!host) return;
  const statusClass = status => status === "approved" ? "success" : ["failed", "incomplete", "needs_revision"].includes(status) ? "danger" : "warning";
  const items = state.reviewCases;
  const streamStatus = state.reviewListLoading
    ? `<div class="review-stream-status is-loading" role="status"><i data-lucide="loader-circle" size="15"></i><span>${items.length ? '正在加载更多复盘…' : '正在读取策略复盘…'}</span></div>`
    : state.reviewListError
      ? `<div class="review-stream-status is-error" role="alert"><span>${escapeHtml(state.reviewListError)}</span><button class="text-action" type="button" data-review-load-more>重新加载</button></div>`
      : state.reviewListHasMore
      ? `<div class="review-stream-status" data-review-stream-sentinel><button class="text-action" type="button" data-review-load-more>继续加载</button><span>向下滚动自动加载</span></div>`
      : items.length ? `<div class="review-stream-status is-complete"><i data-lucide="check" size="14"></i><span>已显示全部 ${items.length} 条复盘</span></div>` : "";
  host.innerHTML = items.length ? `${items.map(item => {
    const selected = Number(item.id) === Number(state.selectedReviewId);
    const effectiveStatus = periodReviewEffectiveStatus(item);
    const icon = item.status === "approved" ? "check" : item.status === "needs_revision" ? "triangle-alert" : item.status === "failed" ? "x" : effectiveStatus === "model_request" ? "sparkles" : "clock-3";
    const stats = item.statistics || {};
    const isMonthly = item.period_type === "monthly";
    const profit = Number(stats.net_profit || 0);
    return `<button class="review-case-button ${selected ? 'selected' : ''} ${Number(item.is_unread) ? 'is-unread' : ''}" data-review-id="${Number(item.id)}" aria-pressed="${selected}" aria-label="打开${isMonthly ? '月' : '日'}复盘 ${escapeHtml(item.period_key)}，${escapeHtml(reviewStatusLabel(effectiveStatus))}">
      <span class="review-unread-dot ${Number(item.is_unread) ? '' : 'hidden'}" aria-label="未读复盘"></span>
      <span class="review-case-leading ${statusClass(item.status)}"><i data-lucide="${icon}" size="16"></i></span>
      <span class="review-case-main">
        <span class="review-case-head"><strong>${isMonthly ? '月复盘' : '日复盘'} · ${escapeHtml(item.period_key)}</strong><span class="status-chip ${statusClass(item.status)}">${escapeHtml(reviewStatusLabel(effectiveStatus))}</span></span>
        <span class="review-case-strategy">${escapeHtml(item.strategy_title || `策略 #${item.strategy_id}`)}</span>
        <span class="review-case-metrics"><span><small>${isMonthly ? '交易日' : '交易数量'}</small><strong>${isMonthly ? Number(stats.trading_days || 0) : Number(stats.trade_count || item.source_count || 0)}${isMonthly ? ' 天' : ' 笔'}</strong></span><span><small>净收益</small><strong class="${profit > 0 ? 'positive' : profit < 0 ? 'negative' : ''}">${fmt(profit, 2)}</strong></span></span>
      </span>
      <span class="review-case-arrow" aria-hidden="true"><i data-lucide="chevron-right" size="16"></i></span>
    </button>`;
  }).join("")}${streamStatus}` : state.reviewListLoading
    ? '<div class="review-list-loading" aria-label="正在加载复盘"><div class="workspace-skeleton"></div><div class="workspace-skeleton"></div><div class="workspace-skeleton"></div></div>'
    : state.reviewListError
      ? `<div class="review-list-empty empty-state"><span class="review-empty-icon"><i data-lucide="circle-alert" size="20"></i></span><strong>复盘列表加载失败</strong><span>${escapeHtml(state.reviewListError)}</span><button class="btn btn-secondary btn-sm" type="button" data-review-load-more>重新加载</button></div>`
      : '<div class="review-list-empty empty-state"><span class="review-empty-icon"><i data-lucide="inbox" size="20"></i></span><strong>暂无符合条件的周期复盘</strong><span>系统会在交易日或自然月结束后，按策略汇总完整证据并生成复盘。</span></div>';
  initIcons();
  bindReviewListStream();
}

function syncReviewEditorFromFields() {
  const editor = $("reviewContentEditor");
  if (!editor) return;
  const content = parseJsonField(editor.value, {});
  document.querySelectorAll("[data-review-field]").forEach(input => {
    const key = input.dataset.reviewField;
    if (["strengths","lessons"].includes(key)) content[key] = input.value.split("\n").map(value => value.trim()).filter(Boolean);
    else if (key === "confidence") content[key] = Number(input.value);
    else content[key] = input.value;
  });
  editor.value = JSON.stringify(content, null, 2);
}

async function openReviewDetail(id) {
  state.selectedReviewId = Number(id); renderReviewCases();
  const detail = $("reviewDetail"); detail.innerHTML = '<div class="workspace-skeleton"></div>';
  const data = await api(`/api/ai/reviews/${id}`); const review = data.review;
  const current = (review.versions || []).find(v => Number(v.id) === Number(review.current_version_id)) || review.versions?.at(-1);
  const evidence = review.evidence || {}, outcome = evidence.post_trade?.outcome || {}, snapshot = evidence.inference_time?.snapshot || {};
  const content = current?.content || {};
  const issueSummary = (content.trade_process_issues || []).map(item => userVisibleText(item.description || item.code, "交易流程存在未说明问题")).filter(Boolean);
  const isAdmin = state.user?.role === "admin";
  const lessonHelp = "每行一条；确认后的有效经验会进入对应策略记忆库";
  const approveLabel = "内容准确并沉淀到策略记忆库";
  const netProfit = Number(outcome.net_profit);
  const profitClass = Number.isFinite(netProfit) ? netProfit > 0 ? "positive" : netProfit < 0 ? "negative" : "neutral" : "neutral";
  const confidence = Number(content.confidence);
  const confidencePercent = Number.isFinite(confidence) ? Math.round(Math.max(0, Math.min(1, confidence)) * 100) : 50;
  const pathEvidence = evidence.post_trade?.path_evidence || {};
  const pathMetrics = evidence.post_trade?.path_metrics || {};
  const pathCoverage = Object.entries(pathEvidence.coverage || {});
  const excursion = (value) => Number.isFinite(Number(value)) ? `${fmt(Number(value), 2)}%` : "--";
  detail.innerHTML = `<header class="review-detail-header"><div class="review-detail-title"><span class="review-detail-icon"><i data-lucide="clipboard-check" size="19"></i></span><div><span class="review-section-kicker">复盘详情</span><h2>复盘 #${Number(review.id)}</h2><p>版本 ${escapeHtml(current?.version_no || '--')} · 信号 #${escapeHtml(review.signal_id || '--')}</p></div></div><div class="review-detail-status"><span class="status-chip ${review.status === 'approved' ? 'success' : ['failed','incomplete','needs_revision'].includes(review.status) ? 'danger' : 'warning'}">${escapeHtml(reviewStatusLabel(review.status))}</span>${review.status === 'failed' ? '<button class="btn btn-secondary btn-sm" data-review-action="retry"><i data-lucide="rotate-cw" size="14"></i>重试生成</button>' : ''}</div></header>
    ${review.evidence_status !== 'complete' ? `<div class="source-notice"><span><strong>证据准备中：</strong>${escapeHtml(periodReviewEvidenceReasonText(review.evidence_reason))}</span></div>` : ''}
    <section class="review-outcome-strip" aria-label="交易结果"><div class="review-outcome-main ${profitClass}"><span>净利润</span><strong>${fmt(outcome.net_profit, 2)}</strong><small>账户货币</small></div><div class="review-outcome-metric"><span>成交手数</span><strong>${fmt(outcome.closed_volume, 2)}</strong><small>已平仓</small></div><div class="review-outcome-metric"><span>结论置信度</span><strong>${confidencePercent}%</strong><small>AI 复盘判断</small></div><p><i data-lucide="info" size="14"></i>盈亏是结果，不直接代表当时的决策质量。</p></section>
    <section class="review-path-summary ${pathEvidence.status === 'complete' ? 'is-complete' : 'is-partial'}">
      <header><div><span class="review-section-kicker">持仓路径证据</span><h3>从开仓到平仓的行情表现</h3></div><span class="status-chip ${pathEvidence.status === 'complete' ? 'success' : 'warning'}">${pathEvidence.status === 'complete' ? '证据完整' : '部分可用'}</span></header>
      <div class="review-path-metrics"><div><span>最大有利波动</span><strong>${excursion(pathMetrics.max_favorable_excursion_pct)}</strong></div><div><span>最大不利波动</span><strong>${excursion(pathMetrics.max_adverse_excursion_pct)}</strong></div><div><span>持仓 K 线</span><strong>${Number(pathMetrics.bars_held || 0)} 根</strong></div><div><span>缠论周期</span><strong>${pathCoverage.length || 0} 个</strong></div></div>
      <footer>${pathCoverage.map(([timeframe, item]) => `<span><strong>${escapeHtml(timeframe)}</strong> ${Number(item.candle_count || 0)} 根 · ${item.status === 'complete' ? '结构已计算' : '数据不足'}</span>`).join('') || '<span>暂无可用的持仓行情路径</span>'}</footer>
    </section>
    <div class="review-structured-form">
      <section class="review-form-section review-summary-section"><div class="review-form-heading"><div><span class="review-section-kicker">核心判断</span><h3>复盘结论</h3></div><small>先确认事实与结论是否一致</small></div><label class="review-field"><span class="sr-only">复盘结论</span><textarea data-review-field="summary" rows="4" ${current ? '' : 'disabled'}>${escapeHtml(userVisibleText(content.summary, "暂无复盘结论"))}</textarea></label></section>
      <section class="review-form-section"><div class="review-form-heading"><div><span class="review-section-kicker">质量校对</span><h3>评估与结果说明</h3></div><small>可按实际交易情况修正</small></div><div class="review-assessment-grid"><label class="review-field"><span>决策质量</span><select data-review-field="decision_quality" ${current ? '' : 'disabled'}><option value="good" ${content.decision_quality === 'good' ? 'selected' : ''}>良好</option><option value="mixed" ${content.decision_quality === 'mixed' ? 'selected' : ''}>有得有失</option><option value="poor" ${content.decision_quality === 'poor' ? 'selected' : ''}>需要改进</option><option value="insufficient_evidence" ${content.decision_quality === 'insufficient_evidence' ? 'selected' : ''}>证据不足</option></select></label><label class="review-field review-confidence-field"><span>结论置信度</span><div><input data-review-field="confidence" type="number" min="0" max="1" step="0.05" value="${escapeHtml(content.confidence ?? 0.5)}" ${current ? '' : 'disabled'}><small>填写 0–1</small></div></label><label class="review-field review-outcome-summary"><span>交易结果说明</span><textarea data-review-field="outcome_summary" rows="3" ${current ? '' : 'disabled'}>${escapeHtml(userVisibleText(content.outcome_summary, "暂无交易结果说明"))}</textarea></label></div></section>
      ${issueSummary.length ? `<section class="review-issues"><div><i data-lucide="triangle-alert" size="16"></i><span>发现 ${issueSummary.length} 项流程问题</span></div>${issueSummary.map(item => `<p>${escapeHtml(item)}</p>`).join('')}</section>` : '<section class="review-issues is-clear"><div><i data-lucide="circle-check" size="16"></i><span>交易流程检查</span></div><p>未记录明确的交易流程问题</p></section>'}
      <section class="review-form-section"><div class="review-form-heading"><div><span class="review-section-kicker">经验沉淀</span><h3>保留有效经验</h3></div><small>使用短句，每行只写一个要点</small></div><div class="review-form-columns"><label class="review-field"><span>做得好的地方</span><textarea data-review-field="strengths" rows="4" ${current ? '' : 'disabled'}>${escapeHtml((content.strengths || []).map(value => userVisibleText(value, "模型未提供中文说明")).join('\n'))}</textarea><small>每行一条，记录可复用的正确做法</small></label><label class="review-field"><span>后续经验</span><textarea data-review-field="lessons" rows="4" ${current ? '' : 'disabled'}>${escapeHtml((content.lessons || []).map(value => userVisibleText(value, "模型未提供中文说明")).join('\n'))}</textarea><small>${escapeHtml(lessonHelp)}</small></label></div></section>
    </div>
    <details class="quiet-disclosure review-evidence-disclosure"><summary><span><i data-lucide="file-search" size="15"></i><strong>查看推理证据</strong><small>证据只读，用于核对复盘来源</small></span><i data-lucide="chevron-down" size="15"></i></summary><div class="quiet-disclosure-body"><div class="review-evidence"><div><span>信号 / 策略</span><strong>#${review.signal_id || '--'} / #${snapshot.strategy_id || '--'}</strong></div><div><span>模型来源</span><strong>${escapeHtml(snapshot.model_name || '未记录')}</strong></div><div><span>交易结果</span><strong>净利润 ${escapeHtml(outcome.net_profit ?? '--')} · 手数 ${escapeHtml(outcome.closed_volume ?? '--')}</strong></div><div><span>证据哈希</span><strong>${escapeHtml(snapshot.content_hash || '--')}</strong></div></div><div class="workspace-row-meta"><span>交易流程问题：${escapeHtml(reviewFieldStatusLabel(review.trade_process_issue_status))}</span><span>复盘内容确认：${escapeHtml(reviewFieldStatusLabel(review.review_content_status))}</span></div></div></details>
    <textarea id="reviewContentEditor" hidden>${escapeHtml(JSON.stringify(content))}</textarea>
    ${current ? `<footer class="review-actions"><div class="review-action-context"><i data-lucide="shield-check" size="17"></i><span><strong>确认前请核对结论</strong><small>确认后才会进入经验候选或个人记忆</small></span></div><div class="review-action-buttons"><button class="text-action" data-review-action="defer" data-version-id="${current.id}">稍后处理</button><button class="btn btn-secondary" data-review-action="needs_revision" data-version-id="${current.id}">内容有问题，继续修改</button><button class="btn btn-secondary" data-review-action="save" data-version-id="${current.id}">保存修改</button><button class="btn btn-primary" data-review-action="approve" data-version-id="${current.id}"><i data-lucide="check" size="15"></i>${escapeHtml(approveLabel)}</button></div></footer>` : ''}`;
  initIcons();
}

const periodDecisionLabels = { good:"良好", mixed:"有得有失", poor:"需要改进", insufficient_evidence:"证据不足" };
const chanIssueLabels = { data:"行情数据", calculation:"结构计算", confirmation_lag:"结构确认延迟", ai_interpretation:"AI 解读", strategy_rule:"策略规则", none:"未发现问题", unknown:"暂无法判断" };

function periodReviewArray(value) { return Array.isArray(value) ? value.map(item => userVisibleText(item, "系统未提供中文说明")).filter(Boolean) : []; }
function periodReviewLines(value) { return periodReviewArray(value).join("\n"); }
function periodReviewFailureText(value) {
  const text = String(value || "");
  if (/HTTP 429|rate.?limit/i.test(text)) return "模型服务当前请求过多，请稍后重试";
  if (/response content is empty|repair response content is empty/i.test(text)) return "模型已响应，但没有返回可用的复盘内容";
  if (/daily_review_summary_missing/i.test(text)) return "模型没有返回必填的日复盘总结；系统已加强格式校验，请重新生成";
  if (/monthly_review_summary_missing/i.test(text)) return "模型没有返回必填的月复盘总结；系统已加强格式校验，请重新生成";
  if (/daily_review_trade_coverage_incomplete/i.test(text)) return "模型没有逐笔分析全部交易；系统已要求补齐后再保存";
  if (/daily_review_chan_coverage_incomplete/i.test(text)) return "模型没有逐笔完成缠论结构诊断；系统已要求补齐后再保存";
  if (/monthly_review_daily_coverage_incomplete/i.test(text)) return "模型没有覆盖本月全部日复盘；系统已要求补齐后再保存";
  if (/period_review_model_timeout/i.test(text)) return "模型在限定时间内没有完成复盘，任务已停止；请重新生成";
  if (/invalid_daily_review_|invalid_daily_trade_assessment|invalid_daily_chan/i.test(text)) return "日复盘输出字段或取值不符合要求，系统已自动要求模型修正";
  if (/invalid_monthly_review_|invalid_monthly_daily_assessment|invalid_monthly_memory/i.test(text)) return "月复盘输出字段或取值不符合要求，系统已自动要求模型修正";
  if (/unknown_.*review_field/i.test(text)) return "模型输出包含多余字段，系统已更新兼容规则，请重新生成";
  if (/model.*unavailable|credential|api.?key/i.test(text)) return "复盘模型暂不可用，请检查模型配置";
  if (/LLM HTTP 5\d\d/i.test(text)) return "模型服务暂时异常，系统稍后会自动重试";
  if (/LLM HTTP 4\d\d/i.test(text)) return "模型请求未被服务商接受，请检查模型配置后重试";
  const localized = text ? localizeReason(text) : "";
  return localized && localized !== text ? localized : "复盘生成未完成，请重新生成；详细错误已记录在服务器日志中";
}

function formatReviewEventTime(value, offsetMinutes = null) {
  if (!value) return "--";
  const utcMs = Date.parse(`${String(value).replace(" ", "T")}+08:00`);
  if (!Number.isFinite(utcMs)) return "时间待终端校准";
  const terminalTime = terminalTimeFromUtcMsc(utcMs, offsetMinutes);
  return terminalTime ? terminalTime.slice(5) : "时间待终端校准";
}

function terminalTimezoneLabel(offsetMinutes) {
  if (offsetMinutes === null || offsetMinutes === undefined || offsetMinutes === "") return "等待终端校准";
  const offset = Number(offsetMinutes);
  if (!Number.isInteger(offset) || offset < -720 || offset > 840) return "等待终端校准";
  return `UTC${offset >= 0 ? "+" : ""}${fmt(offset / 60, 1)}`;
}

function periodReviewEventLabel(event) {
  const labels = { queued:"已进入生成队列", preparing:"正在准备复盘证据", model_request:"AI 开始分析", validating:"正在校验模型结果",
    repairing:"正在修复输出格式", retry_wait:"本次生成未完成，等待自动重试", succeeded:"复盘生成完成", failed:"复盘生成失败" };
  return labels[event.stage] || reviewStatusLabel(event.stage);
}

function periodReviewProgressHtml(review) {
  if (!review?.job_id && !review?.job_status) return "";
  // A persisted version is the authoritative completion fact. A stale leased
  // job must not make an already generated review look active again.
  const stage = Number(review.current_version_id || 0) > 0 ? "succeeded" : periodReviewEffectiveStatus(review);
  const stages = ["preparing", "model_request", "validating", "succeeded"];
  const stageIndex = stage === "queued" || stage === "retry_wait" ? 0 : stage === "repairing" ? 2 : Math.max(0, stages.indexOf(stage));
  const terminal = ["succeeded", "failed"].includes(stage) || ["draft", "edited", "approved"].includes(review.status);
  const nextMs = review.next_attempt_at ? Date.parse(String(review.next_attempt_at).replace(" ", "T")) : NaN;
  const retrySeconds = Number.isFinite(nextMs) ? Math.max(0, Math.ceil((nextMs - Date.now()) / 1000)) : null;
  const title = stage === "retry_wait" ? "等待自动重试" : stage === "failed" ? "复盘生成失败" : stage === "succeeded" ? "复盘已生成" : "正在生成复盘";
  const detail = stage === "retry_wait" && retrySeconds != null ? `${retrySeconds} 秒后可再次执行` : reviewStatusLabel(stage);
  const events = (review.job_events || []).slice(0, 8);
  return `<section id="periodReviewProgress" class="period-review-progress is-${escapeHtml(stage)}" aria-live="polite">
    <header><div><span class="review-section-kicker">生成状态</span><h3>${escapeHtml(title)}</h3></div><span class="period-review-attempt">第 ${Number(review.attempt_count || 0)}/${Number(review.max_attempts || 3)} 次尝试</span></header>
    <div class="period-review-stage-track" role="progressbar" aria-label="复盘生成阶段" aria-valuemin="1" aria-valuemax="4" aria-valuenow="${Math.min(4, stageIndex + 1)}">
      ${["准备证据", "AI 分析", "校验结果", "等待确认"].map((label,index) => `<div class="${index < stageIndex || (terminal && stage !== 'failed') ? 'done' : index === stageIndex && !terminal ? 'active' : ''}"><span>${index < stageIndex || (terminal && stage !== 'failed') ? '<i data-lucide="check" size="12"></i>' : index + 1}</span><small>${label}</small></div>`).join("")}
    </div>
    <div class="period-review-live-line ${stage === 'failed' ? 'danger' : ''}"><span class="period-review-live-dot"></span><strong>${escapeHtml(detail)}</strong>${review.stage_updated_at ? `<small>更新于 ${escapeHtml(formatReviewEventTime(review.stage_updated_at, review.timezone_offset_minutes))} ${bridgePlatformLabel()}</small>` : ''}</div>
    ${review.last_error_code && ["retry_wait", "failed"].includes(stage) ? `<div class="period-review-inline-error"><i data-lucide="circle-alert" size="15"></i><span>${escapeHtml(periodReviewFailureText(review.last_error_code))}</span></div>` : ""}
    ${events.length ? `<details class="period-review-log"><summary>生成记录 <span>${events.length}</span></summary><ol>${events.map(event => `<li class="${escapeHtml(event.event_status || 'info')}"><time>${escapeHtml(formatReviewEventTime(event.created_at, review.timezone_offset_minutes))}</time><span>${escapeHtml(periodReviewEventLabel(event))}${event.message_code ? `<small>${escapeHtml(periodReviewFailureText(event.message_code))}</small>` : ''}</span></li>`).join("")}</ol></details>` : ""}
  </section>`;
}

function schedulePeriodReviewDetailPoll(review) {
  stopReviewDetailPolling();
  const generatingReview = review && ["queued", "leased"].includes(review.job_status) && !Number(review.current_version_id || 0);
  const memoryStatus = review?.memory_application_status || review?.derivation_status || "";
  const derivingMemory = review && ["queued", "applying", "compression_queued", "compression_running"].includes(memoryStatus);
  if (!generatingReview && !derivingMemory) return;
  const caseId = Number(review.id), timezoneOffset = review.timezone_offset_minutes != null
    && review.timezone_offset_minutes !== "" && Number.isInteger(Number(review.timezone_offset_minutes))
    ? Number(review.timezone_offset_minutes) : null;
  const requestVersion = state.reviewDetailRequestVersion;
  state.reviewDetailJobKey = `${review.job_status}:${review.progress_stage}:${review.attempt_count}:${review.next_attempt_at || ''}`;
  state.reviewDetailPollTimer = setTimeout(async () => {
    if (requestVersion !== state.reviewDetailRequestVersion
      || Number(state.selectedReviewId) !== caseId || activeTabId() !== "review-memory") return;
    try {
      const data = await api(`/api/ai/period-reviews/${caseId}/job-status`), job = { ...(data.job || {}), timezone_offset_minutes:timezoneOffset };
      const nextKey = `${job.job_status}:${job.progress_stage}:${job.attempt_count}:${job.next_attempt_at || ''}:${job.current_version_id || ''}`;
      if ((generatingReview && (job.current_version_id || ["failed", "succeeded"].includes(job.job_status)))
        || (derivingMemory && !["queued", "applying", "compression_queued", "compression_running"].includes(job.memory_application_status || job.derivation_status))) {
        await loadReviewMemory();
        await openPeriodReviewDetail(caseId, { silent:true });
        if (generatingReview && job.current_version_id) toast(`${job.period_type === 'monthly' ? '月' : '日'}复盘已生成，等待确认`, "success");
        if (derivingMemory && ["applied", "completed", "succeeded"].includes(job.memory_application_status || job.derivation_status)) toast("复盘经验已沉淀完成", "success");
        return;
      }
      const progress = $("periodReviewProgress");
      if (progress) progress.outerHTML = periodReviewProgressHtml(job);
      state.reviewDetailJobKey = nextKey;
      initIcons();
      schedulePeriodReviewDetailPoll(job);
    } catch { schedulePeriodReviewDetailPoll(review); }
  }, 3000);
}

function syncPeriodReviewEditorFromFields() {
  const editor = $("reviewContentEditor");
  if (!editor) return;
  const content = parseJsonField(editor.value, {});
  document.querySelectorAll("[data-period-review-field]").forEach(input => {
    const key = input.dataset.periodReviewField;
    if (input.dataset.fieldType === "lines") content[key] = input.value.split("\n").map(value => value.trim()).filter(Boolean);
    else if (key === "confidence") content[key] = Math.max(0, Math.min(1, Number(input.value)));
    else content[key] = input.value;
  });
  editor.value = JSON.stringify(content, null, 2);
}

function periodReviewListBlock(title, values, icon = "list-checks") {
  const items = periodReviewArray(values);
  return `<section class="period-review-evidence-card"><header><i data-lucide="${icon}" size="15"></i><strong>${escapeHtml(title)}</strong><span>${items.length}</span></header>${items.length ? `<ul>${items.map(item => `<li>${escapeHtml(userVisibleText(item, "系统未提供中文说明"))}</li>`).join("")}</ul>` : '<p>本周期未记录相关问题</p>'}</section>`;
}

function reviewStrategyVersions(review = {}) {
  const raw = review.strategy_versions ?? parseJsonField(review.strategy_versions_json, review.strategy_version ? [review.strategy_version] : []);
  return [...new Set((Array.isArray(raw) ? raw : [raw]).map(Number).filter(Number.isFinite))].sort((a, b) => a - b);
}

function reviewStrategyProvenance(review = {}) {
  const versions = reviewStrategyVersions(review);
  return versions.length > 1 ? `覆盖 ${versions.length} 个兼容策略版本` : "策略配置来源已记录";
}

function periodReviewDetailErrorHtml(error) {
  const message = localizeReason(error?.message || "") || "暂时无法读取该复盘详情，请稍后重试";
  return `<div class="review-empty-state empty-state is-error" role="alert"><span class="review-empty-icon"><i data-lucide="circle-alert" size="20"></i></span><strong>复盘详情读取失败</strong><span>${escapeHtml(message)}</span><button class="btn btn-secondary btn-sm" type="button" data-review-action="reload-detail">重新加载</button></div>`;
}

async function openPeriodReviewDetail(id, { silent = false } = {}) {
  stopReviewDetailPolling();
  const requestedId = Number(id);
  const requestVersion = ++state.reviewDetailRequestVersion;
  state.selectedReviewId = requestedId; renderReviewCases();
  const reviewLayout = document.querySelector(".period-review-layout");
  reviewLayout?.classList.add("has-mobile-detail");
  const detail = $("reviewDetail");
  if (!silent) detail.innerHTML = '<div class="workspace-skeleton"></div>';
  let data;
  try {
    data = await api(`/api/ai/period-reviews/${id}`);
  } catch (error) {
    if (requestVersion !== state.reviewDetailRequestVersion
      || Number(state.selectedReviewId) !== requestedId) return null;
    if (detail) detail.innerHTML = periodReviewDetailErrorHtml(error);
    initIcons();
    throw error;
  }
  if (requestVersion !== state.reviewDetailRequestVersion
    || Number(state.selectedReviewId) !== requestedId) return null;
  const review = data.review || {};
  const current = (review.versions || []).find(item => Number(item.id) === Number(review.current_version_id)) || review.versions?.at(-1);
  const content = current?.content || {};
  const evidence = review.evidence || {};
  const stats = evidence.statistics || {};
  const quality = evidence.source_quality || {};
  const isMonthly = review.period_type === "monthly";
  const statusClass = review.status === "approved" ? "success" : ["failed", "incomplete", "needs_revision"].includes(review.status) ? "danger" : "warning";
  const profit = Number(stats.net_profit || 0);
  const confidence = Number(content.confidence);
  const confidencePercent = Number.isFinite(confidence) ? Math.round(confidence * 100) : 0;
  const editable = Boolean(current) && review.status !== "approved";
  const sourceLabel = review.evidence_status === "complete" ? "证据完整" : "证据待补全";
  const sourceDetail = quality.complete === false ? "部分行情或结构证据不可用" : `已汇总 ${Number(review.source_count || 0)} 个来源`;
  const periodScope = isMonthly
    ? `${bridgePlatformLabel()} 时间 ${review.period_key || '--'} 全月 · 月末结算后生成`
    : `${bridgePlatformLabel()} 时间 ${review.period_key || '--'} 00:00–24:00 · 已结束周期`;
  const nextPeriodHint = isMonthly ? "本月结束后的交易将进入下月复盘" : "本周期结束后的平仓将进入下一份日复盘";
  const strategyProvenance = reviewStrategyProvenance(review);
  const memoryStatus = review.memory_application_status || review.derivation_status || "";
  const derivationLabels = { queued:"记忆等待写入", applying:"正在写入策略记忆库", applied:"经验已写入",
    compression_queued:"经验已写入，等待整理", compression_running:"经验已写入，正在整理",
    compression_failed_memory_preserved:"经验已保存，整理失败", completed:"经验已沉淀",
    paused:"记忆写入已暂停", failed:"记忆写入失败", succeeded:"经验已沉淀" };
  const derivationStatus = memoryStatus;
  const derivationClass = ["applied", "completed", "succeeded"].includes(derivationStatus) ? "complete"
    : ["failed", "compression_failed_memory_preserved"].includes(derivationStatus) ? "warning" : "";
  const derivationDetail = derivationStatus === "paused"
    ? "相关记忆功能当前已关闭，重新启用后会自动继续"
    : derivationStatus === "failed" ? `已确认复盘尚未形成可验证的记忆修订：${periodReviewFailureText(review.derivation_error_code)}`
      : derivationStatus === "compression_failed_memory_preserved" ? "复盘经验已经安全写入；仅后台整理失败，可重试且不会丢失经验"
        : ["applied", "compression_queued", "compression_running"].includes(derivationStatus)
          ? "复盘经验已经写入当前策略记忆库；后台整理不会回滚已保存内容"
          : ["completed", "succeeded"].includes(derivationStatus) ? "已写入对应策略的当前记忆版本"
            : "后台任务会自动完成，无需重复确认";
  const editableGroups = isMonthly
    ? [
      ["recurring_patterns", "重复出现的模式"], ["strengths", "稳定有效的做法"],
      ["risk_observations", "风险观察"], ["chan_issue_summary", "缠论结构问题"], ["next_month_actions", "下月行动"]]
    : [["repeated_issues", "重复出现的问题"], ["strengths", "做得好的地方"], ["daily_lessons", "当日经验"], ["risk_observations", "风险观察"]];
  const assessments = isMonthly ? (content.daily_assessments || []) : (content.trade_assessments || []);
  const diagnostics = isMonthly ? [] : [
    ...(content.period_chan_assessment ? [{ ...content.period_chan_assessment, explanation:`整日结构：${content.period_chan_assessment.explanation || '无补充说明'}` }] : []),
    ...(content.chan_diagnoses || []),
  ];
  if (requestVersion !== state.reviewDetailRequestVersion
    || Number(state.selectedReviewId) !== requestedId) return null;
  detail.innerHTML = `<button class="review-mobile-back" type="button" data-review-action="back-list"><i data-lucide="arrow-left" size="16"></i>返回复盘列表</button><header class="period-review-detail-header">
      <div><span class="period-review-type ${isMonthly ? 'monthly' : 'daily'}"><i data-lucide="${isMonthly ? 'calendar-range' : 'calendar-days'}" size="14"></i>${isMonthly ? '月复盘' : '日复盘'}</span><h2>${escapeHtml(review.period_key || '--')}</h2><p>${escapeHtml(review.strategy_title || `策略 #${review.strategy_id}`)} · ${escapeHtml(strategyProvenance)}</p><p class="period-review-period-scope"><i data-lucide="clock-3" size="13"></i>${escapeHtml(periodScope)}</p></div>
      <div class="period-review-header-state"><span class="status-chip ${statusClass}">${escapeHtml(reviewStatusLabel(review.status))}</span>${review.status === 'failed' ? '<button class="btn btn-secondary btn-sm" data-review-action="retry"><i data-lucide="rotate-cw" size="14"></i>重试生成</button>' : ''}</div>
    </header>
    ${periodReviewProgressHtml(review)}
    <section class="period-review-metrics" aria-label="周期统计">
      <div class="${profit > 0 ? 'positive' : profit < 0 ? 'negative' : ''}"><span>净收益</span><strong>${fmt(profit, 2)}</strong><small>系统成交数据</small></div>
      <div><span>${isMonthly ? '交易日 / 交易' : '交易笔数'}</span><strong>${isMonthly ? `${Number(stats.trading_days || 0)} / ${Number(stats.trade_count || 0)}` : Number(stats.trade_count || review.source_count || 0)}</strong><small>${isMonthly ? '天 / 笔' : `胜 ${Number(stats.wins || 0)} · 负 ${Number(stats.losses || 0)}`}</small></div>
      <div><span>胜率</span><strong>${Number.isFinite(Number(stats.win_rate)) ? `${Math.round(Number(stats.win_rate) * 100)}%` : '--'}</strong><small>只描述结果，不代表决策质量</small></div>
      <div><span>结论置信度</span><strong>${confidencePercent}%</strong><small>AI 对复盘结论的把握</small></div>
    </section>
    <div class="period-review-source ${review.evidence_status === 'complete' ? 'complete' : 'warning'}"><i data-lucide="${review.evidence_status === 'complete' ? 'shield-check' : 'triangle-alert'}" size="16"></i><div><strong>${sourceLabel}</strong><span>${escapeHtml(sourceDetail)}；${escapeHtml(nextPeriodHint)}</span></div></div>
    ${review.status === 'approved' && derivationStatus ? `<div class="period-review-source ${derivationClass}"><i data-lucide="${["applied","completed","succeeded"].includes(derivationStatus) ? 'brain-circuit' : ["failed","compression_failed_memory_preserved"].includes(derivationStatus) ? 'circle-alert' : 'loader-circle'}" size="16"></i><div><strong>${escapeHtml(derivationLabels[derivationStatus] || derivationStatus)}</strong><span>${escapeHtml(derivationDetail)}</span></div>${["failed","compression_failed_memory_preserved"].includes(derivationStatus) ? '<button class="btn btn-secondary btn-sm" data-review-action="retry-derivation">重试经验处理</button>' : ''}</div>` : ''}
    ${current ? `<section class="period-review-editor">
      <div class="period-review-section-heading"><div><span class="review-section-kicker">核心结论</span><h3>${isMonthly ? '本月策略表现' : '当日策略表现'}</h3></div><span>第 ${Number(current.version_no || 1)} 次修订</span></div>
      <label class="review-field"><span>复盘摘要</span><textarea data-period-review-field="period_summary" rows="4" ${editable ? '' : 'disabled'}>${escapeHtml(userVisibleText(content.period_summary, "暂无复盘摘要"))}</textarea></label>
      <div class="period-review-decision-row"><label class="review-field"><span>决策质量</span><select data-period-review-field="decision_quality" ${editable ? '' : 'disabled'}>${Object.entries(periodDecisionLabels).map(([value,label]) => `<option value="${value}" ${content.decision_quality === value ? 'selected' : ''}>${label}</option>`).join('')}</select></label><label class="review-field"><span>结论置信度</span><div class="confidence-input"><input data-period-review-field="confidence" type="number" min="0" max="1" step="0.05" value="${escapeHtml(content.confidence ?? 0.5)}" ${editable ? '' : 'disabled'}><small>0 到 1</small></div></label></div>
      <div class="period-review-edit-grid">${editableGroups.map(([key,label]) => `<label class="review-field"><span>${label}</span><textarea data-period-review-field="${key}" data-field-type="lines" rows="4" ${editable ? '' : 'disabled'}>${escapeHtml(periodReviewLines(content[key]))}</textarea><small>每行一条，保持简短且可执行</small></label>`).join('')}</div>
      <textarea id="reviewContentEditor" hidden>${escapeHtml(JSON.stringify(content))}</textarea>
    </section>` : `<div class="review-empty-state empty-state"><span class="review-empty-icon"><i data-lucide="${review.status === 'failed' ? 'circle-alert' : 'loader-circle'}" size="20"></i></span><strong>${review.status === 'failed' ? '复盘生成失败' : '复盘正在准备'}</strong><span>${escapeHtml(review.status === 'failed' ? periodReviewFailureText(review.last_error_code) : periodReviewEvidenceReasonText(review.evidence_reason))}</span></div>`}
    ${current ? `<section class="period-review-evidence-grid">
      ${periodReviewListBlock(isMonthly ? '跨日模式' : '逐笔判断', assessments.map(item => `${isMonthly ? item.period_case_id : item.outcome_id} · ${periodDecisionLabels[item.decision_quality] || item.decision_quality}：${item.summary || ''}`), isMonthly ? 'calendar-range' : 'receipt-text')}
      ${isMonthly ? periodReviewListBlock('记忆库更新候选', (content.memory_candidates || []).map(item => item.lesson), 'brain-circuit') : periodReviewListBlock('缠论结构诊断', diagnostics.map(item => `${chanIssueLabels[item.issue_source] || item.issue_source}：${item.explanation || '无补充说明'}`), 'git-branch')}
    </section>
    <details class="quiet-disclosure review-evidence-disclosure"><summary><span><i data-lucide="database" size="15"></i><strong>证据来源与系统字段</strong><small>基础统计只读，避免修改后与真实成交数据不一致</small></span><i data-lucide="chevron-down" size="15"></i></summary><div class="quiet-disclosure-body"><div class="review-evidence"><div><span>账户 / 策略</span><strong>#${Number(review.trading_account_id || 0)} / #${Number(review.strategy_id || 0)}</strong></div><div><span>统计时区</span><strong>${escapeHtml(terminalTimezoneLabel(review.timezone_offset_minutes))}</strong></div><div><span>来源策略配置</span><strong>${escapeHtml(reviewStrategyVersions(review).length ? reviewStrategyVersions(review).map(value => `v${value}`).join('、') : '已记录')}</strong></div><div><span>来源数量</span><strong>${Number(review.source_count || 0)}</strong></div><div><span>生成时间</span><strong>${escapeHtml(formatReviewEventTime(current.created_at, review.timezone_offset_minutes))}</strong></div></div></div></details>
    <footer class="review-actions"><div class="review-action-context"><i data-lucide="shield-check" size="17"></i><span><strong>确认后才会更新策略记忆库</strong><small>${isMonthly ? '月复盘会合并跨日模式并触发记忆库压缩' : '日复盘确认后将可靠经验加入对应策略记忆库'}</small></span></div>${editable ? `<div class="review-action-buttons"><button class="text-action" data-review-action="defer" data-version-id="${current.id}">稍后处理</button><button class="btn btn-secondary" data-review-action="needs_revision" data-version-id="${current.id}">标记有问题</button><button class="btn btn-secondary" data-review-action="save" data-version-id="${current.id}">保存修改</button><button class="btn btn-primary" data-review-action="approve" data-version-id="${current.id}"><i data-lucide="check" size="15"></i>确认并沉淀经验</button></div>` : '<span class="status-chip success">内容已锁定</span>'}</footer>` : ''}`;
  initIcons();
  if (current && Number(review.is_unread)) {
    api(`/api/ai/period-reviews/${id}/read`, { method:"POST", body:{ version_id:current.id } }).then(() => {
      if (requestVersion !== state.reviewDetailRequestVersion
        || Number(state.selectedReviewId) !== requestedId) return;
      const item = state.reviewCases.find(row => Number(row.id) === Number(id));
      if (item) item.is_unread = 0;
      renderReviewCases();
      loadReviewSummary({ announce:false }).catch(() => {});
    }).catch(() => {});
  }
  if (requestVersion !== state.reviewDetailRequestVersion
    || Number(state.selectedReviewId) !== requestedId) return null;
  schedulePeriodReviewDetailPoll(review);
  return review;
}

function setTab(tabId, options = {}) {
  const legacySignalsTarget = tabId === "signals";
  if (legacySignalsTarget) tabId = "ai-analyze";
  const modelStrategyTarget = tabId === "model-management" ? "models" : tabId === "ai-config" ? "strategies" : null;
  if (modelStrategyTarget) tabId = "model-strategy";
  if (!canAccessTab(tabId)) {
    if (!options.silent) toast("观摩模式下不可访问该页面", "warning");
    tabId = "dashboard";
  }
  if (tabId !== "history") {
    if (_historyQueryState) {
      cancelHistoryPrepareRetry();
      _historyQueryGeneration += 1;
      state.historyQueryGeneration = _historyQueryGeneration;
      _historyQueryState = null;
      state.historyQueryState = null;
    }
    cancelHistoryRangeRetry();
    clearHistoryFreshnessRetry();
    cancelHistoryLegacySummaryRetry();
  }
  closeMobileNav({ restoreFocus:false });
  if (tabId !== "dashboard") stopKlineRefreshTimers();
  if (tabId !== "review-memory") {
    stopReviewDetailPolling();
    stopManualTradeReviewPolling();
    stopStrategyMemoryConsistencyPolling();
  }
  document.querySelectorAll(".nav-item").forEach((button) => {
    const active = button.dataset.tab === tabId;
    button.classList.toggle("active", active);
    if (button.dataset.tab) {
      if (active) button.setAttribute("aria-current", "page");
      else button.removeAttribute("aria-current");
    }
  });
  const mobileMore = $("mobileNavMoreBtn");
  const mobilePrimaryTabs = new Set(["dashboard", "ai-analyze", "trading", "risk-center"]);
  const mobileMoreActive = !mobilePrimaryTabs.has(tabId);
  mobileMore?.classList.toggle("active", mobileMoreActive);
  if (mobileMoreActive) mobileMore?.setAttribute("aria-current", "page");
  else mobileMore?.removeAttribute("aria-current");
  document.querySelectorAll(".tab-panel").forEach((panel) => {
    panel.classList.toggle("active", panel.id === tabId);
  });
  const main = document.querySelector(".main");
  if (main) main.scrollTop = 0;
  if (tabId === "model-strategy") setModelStrategySubtab(modelStrategyTarget || state.modelStrategySubtab || "strategies");
  if (tabId === "ai-analyze") setAnalystView(
    legacySignalsTarget ? "records" : (options.analystView || "detail"),
    { loadData:false },
  );
  initIcons();
  if (!options.skipRefresh) refreshTabData(tabId, options).catch((error) => toast(error.message, "error"));
}

function setAnalystView(target, options = {}) {
  const next = target === "records" ? "records" : "detail";
  state.analystView = next;
  document.querySelectorAll("[data-analyst-view]").forEach(button => {
    const active = button.dataset.analystView === next;
    button.classList.toggle("active", active);
    button.setAttribute("aria-selected", active ? "true" : "false");
    button.tabIndex = active ? 0 : -1;
  });
  document.querySelectorAll("[data-analyst-panel]").forEach(panel => {
    const active = panel.dataset.analystPanel === next;
    panel.classList.toggle("active", active);
    panel.hidden = !active;
  });
  if (next === "records" && state.token && options.loadData !== false) loadSignalTable().catch(error => toast(error.message, "error"));
  initIcons();
}

function setModelStrategySubtab(target) {
  const next = target === "models" ? "models" : "strategies";
  state.modelStrategySubtab = next;
  document.querySelectorAll("[data-model-strategy-tab]").forEach(button => {
    const active = button.dataset.modelStrategyTab === next;
    button.classList.toggle("active", active);
    button.setAttribute("aria-selected", active ? "true" : "false");
    button.tabIndex = active ? 0 : -1;
  });
  document.querySelectorAll("[data-model-strategy-panel]").forEach(panel => {
    const active = panel.dataset.modelStrategyPanel === next;
    panel.classList.toggle("active", active);
    panel.hidden = !active;
  });
}

function setWorkspaceSubtab(group, target) {
  if (group === "review-memory") {
    if (target === "manual-trades" && !canManagePlatformAiContent()) {
      toast("当前账号没有手动交易复盘权限", "warning");
      target = "reviews";
    }
    if (state.reviewMemoryView === "memories" && target !== "memories") stopStrategyMemoryConsistencyPolling();
    state.reviewMemoryView = target;
  }
  document.querySelectorAll(`[data-workspace-tab="${group}"]`).forEach(button => {
    const active = button.dataset.workspaceTarget === target;
    button.classList.toggle("active", active);
    button.setAttribute("aria-selected", active ? "true" : "false");
    button.tabIndex = active ? 0 : -1;
  });
  document.querySelectorAll(`[data-workspace-panel="${group}"]`).forEach(panel => {
    const active = panel.dataset.workspaceView === target;
    panel.classList.toggle("active", active);
    panel.hidden = !active;
  });
  if (group === "trading" && target === "management" && state.token) {
    loadPositionManagement({ preserveSelection:true }).catch(error => toast(error.message, "error"));
  }
  if (group === "trading" && target === "manual" && state.token && isAdminStrategyDispatchUser()) {
    ensureAdminStrategyDispatchReady().catch(error => console.warn("[AdminStrategyDispatch] manual panel unavailable:", error?.message || error));
  }
  if (group === "review-memory" && target === "manual-trades" && state.token && canManagePlatformAiContent()) {
    loadManualTradeReviewWorkspace().catch(error => toast(localizeReason(error.code || error.message), "error"));
  }
  initIcons();
}

const STRATEGY_MEMORY_COMPRESSION_POLL_INTERVAL_MS = 2_000;
const STRATEGY_MEMORY_COMPRESSION_TERMINAL_STATUSES = new Set(["succeeded", "succeeded_noop", "failed", "stale", "status_unknown"]);

function strategyMemoryCompressionTerminal(job) {
  return STRATEGY_MEMORY_COMPRESSION_TERMINAL_STATUSES.has(String(job?.status || ""));
}

function strategyMemoryCompressionActive(job) {
  return Boolean(job && !strategyMemoryCompressionTerminal(job));
}

function strategyMemoryCompressionStatusLabel(value) {
  return ({ queued:"等待整理", running:"正在整理记忆", leased:"正在整理记忆", validating:"正在校验并保存",
    applying:"正在校验并保存", succeeded:"整理完成", succeeded_noop:"当前内容已足够精炼，无需修改",
    failed:"整理失败，原记忆已保留", stale:"已过期，原记忆已保留", status_unknown:"状态无法确认，原记忆已保留" })[String(value || "")] || "状态待确认";
}

function strategyMemoryStatusLabel(value) {
  return ({ idle:"已保存", queued:"等待整理", leased:"正在整理记忆", succeeded:"整理完成",
    succeeded_noop:"无需修改", failed:"压缩失败，记忆已保留", stale:"已过期，记忆已保留",
    status_unknown:"状态无法确认，记忆已保留" })[String(value || "idle")] || "状态待确认";
}

function strategyMemoryCompressionChars(job, key) {
  const value = Number(job?.[key] ?? job?.[key.replace("_count", "")]);
  return Number.isFinite(value) && value >= 0 ? Math.trunc(value) : null;
}

function strategyMemoryCompressionActivityMarkup(active) {
  if (!active) return '<span class="status-state-mark" aria-hidden="true"></span>';
  const reduced = globalThis.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches;
  return `<span class="${reduced ? "status-state-mark" : "status-spinner"}" aria-hidden="true"></span>`;
}

function strategyMemoryCompressionPresentation(job, fallbackLibrary = null) {
  if (!job) return { status:String(fallbackLibrary?.compression_status || "idle"), text:strategyMemoryStatusLabel(fallbackLibrary?.compression_status || "idle"), active:false };
  const status = String(job.status || "status_unknown");
  const stage = String(job.presentation_stage || status);
  const active = strategyMemoryCompressionActive(job);
  if (status === "succeeded") {
    const source = strategyMemoryCompressionChars(job, "source_char_count");
    const result = strategyMemoryCompressionChars(job, "result_char_count");
    return { status, text:source !== null && result !== null ? `整理完成，${source.toLocaleString("zh-CN")} → ${result.toLocaleString("zh-CN")} 字` : "整理完成", active };
  }
  if (status === "succeeded_noop") return { status, text:"整理完成，当前内容已足够精炼，无需修改", active };
  if (["failed", "stale", "status_unknown"].includes(status)) return { status, text:strategyMemoryCompressionStatusLabel(status), active };
  return { status, text:strategyMemoryCompressionStatusLabel(stage === "running" ? status : stage), active };
}

function renderStrategyMemoryCompressionStatus(job = state.strategyMemoryCompressionJob) {
  const library = state.strategyMemoryDetail?.library || null;
  const presentation = strategyMemoryCompressionPresentation(job, library);
  const statusNode = $("strategyMemoryCompressionStatus");
  if (statusNode) {
    statusNode.dataset.status = presentation.status;
    const tone = presentation.active ? "warning" : ["failed", "stale", "status_unknown"].includes(presentation.status) ? "danger" : ["idle", "succeeded", "succeeded_noop"].includes(presentation.status) ? "success" : "warning";
    statusNode.className = `status-chip strategy-memory-compression-status ${tone} ${presentation.active ? "is-active" : ""}`.trim();
    const dirtyTerminal = !presentation.active && state.strategyMemoryEditorDirty && job;
    statusNode.innerHTML = `${strategyMemoryCompressionActivityMarkup(presentation.active)}<span>${escapeHtml(dirtyTerminal ? "整理完成，刷新前请先处理未保存编辑" : presentation.text)}</span>`;
    statusNode.setAttribute("aria-live", presentation.active ? "polite" : "assertive");
  }
  const compressButton = document.querySelector('[data-strategy-memory-action="compress"]');
  const saveButton = document.querySelector('[data-strategy-memory-action="save"]');
  const active = presentation.active;
  if (compressButton) {
    compressButton.disabled = active;
    compressButton.classList.toggle("is-active", active);
    compressButton.innerHTML = `<i data-lucide="${active ? "loader-circle" : "combine"}" size="15"></i>${active ? "正在整理" : "整理并压缩"}`;
  }
  if (saveButton) saveButton.disabled = active || !state.strategyMemoryEditorDirty;
  document.querySelectorAll("[data-strategy-memory-restore]").forEach(button => { button.disabled = active; });
  initIcons();
}

function stopStrategyMemoryCompressionPolling({ clearJob = true } = {}) {
  clearTimeout(state.strategyMemoryCompressionPollTimer);
  state.strategyMemoryCompressionPollTimer = null;
  state.strategyMemoryCompressionPollKey = null;
  state.strategyMemoryCompressionPollGeneration += 1;
  state.strategyMemoryCompressionPollInFlight = false;
  if (clearJob) state.strategyMemoryCompressionJob = null;
}

function scheduleStrategyMemoryCompressionPoll(strategyId, jobId, generation, delay = STRATEGY_MEMORY_COMPRESSION_POLL_INTERVAL_MS) {
  clearTimeout(state.strategyMemoryCompressionPollTimer);
  state.strategyMemoryCompressionPollTimer = null;
  if (document.hidden || generation !== state.strategyMemoryCompressionPollGeneration
      || Number(state.selectedStrategyMemoryId) !== Number(strategyId)) return;
  state.strategyMemoryCompressionPollTimer = setTimeout(() => {
    state.strategyMemoryCompressionPollTimer = null;
    void pollStrategyMemoryCompressionJob(strategyId, jobId, generation);
  }, Math.max(0, Number(delay) || 0));
}

async function finishStrategyMemoryCompressionPolling(strategyId, generation) {
  if (generation !== state.strategyMemoryCompressionPollGeneration
      || Number(state.selectedStrategyMemoryId) !== Number(strategyId)) return;
  try {
    const detail = await api(`/api/ai/strategy-memories/${strategyId}`);
    if (generation !== state.strategyMemoryCompressionPollGeneration
        || Number(state.selectedStrategyMemoryId) !== Number(strategyId)) return;
    state.strategyMemoryDetail = detail;
    const overview = state.strategyMemoryStrategies.find(item => Number(item.strategy_id) === Number(strategyId));
    if (overview) overview.library = detail.library;
    const textarea = $("strategyMemoryContent");
    const changed = state.strategyMemoryEditorDirty
      || (textarea && state.strategyMemoryEditorBaseline !== null && textarea.value !== state.strategyMemoryEditorBaseline);
    state.strategyMemoryEditorDirty = Boolean(changed);
    if (!changed) {
      state.strategyMemoryEditorBaseline = detail.library?.content_text || "";
      state.strategyMemoryEditorStrategyId = Number(strategyId);
      renderStrategyMemoryLibrary();
    } else {
      renderStrategyMemoryCompressionStatus(state.strategyMemoryCompressionJob);
      toast("整理完成，刷新前请先处理未保存编辑", "warning");
    }
  } catch (error) {
    // The terminal job remains authoritative even if the follow-up detail read
    // is temporarily unavailable; leave its redacted status visible.
    renderStrategyMemoryCompressionStatus(state.strategyMemoryCompressionJob);
    toast(localizeReason(error.message), "warning");
  }
}

async function pollStrategyMemoryCompressionJob(strategyId, jobId, generation) {
  if (generation !== state.strategyMemoryCompressionPollGeneration
      || state.strategyMemoryCompressionPollInFlight || document.hidden
      || Number(state.selectedStrategyMemoryId) !== Number(strategyId)) return;
  state.strategyMemoryCompressionPollInFlight = true;
  let terminal = false;
  try {
    const data = await api(`/api/ai/strategy-memories/${strategyId}/compression-jobs/${jobId}`);
    if (generation !== state.strategyMemoryCompressionPollGeneration
        || Number(state.selectedStrategyMemoryId) !== Number(strategyId)) return;
    const job = data.job || data;
    if (Number(job.id) !== Number(jobId) || Number(job.strategy_id) !== Number(strategyId)) return;
    state.strategyMemoryCompressionJob = job;
    state.strategyMemoryCompressionJobs[String(strategyId)] = job;
    renderStrategyMemoryCompressionStatus(job);
    terminal = strategyMemoryCompressionTerminal(job);
    if (terminal) {
      state.strategyMemoryCompressionPollKey = null;
      await finishStrategyMemoryCompressionPolling(strategyId, generation);
      return;
    }
  } catch (error) {
    if (generation === state.strategyMemoryCompressionPollGeneration && !document.hidden) {
      scheduleStrategyMemoryCompressionPoll(strategyId, jobId, generation);
    }
    return;
  } finally {
    state.strategyMemoryCompressionPollInFlight = false;
  }
  if (!terminal) scheduleStrategyMemoryCompressionPoll(strategyId, jobId, generation);
}

function startStrategyMemoryCompressionPolling(strategyId, job) {
  const jobId = Number(job?.id || job?.job_id || 0);
  if (!Number.isInteger(jobId) || jobId <= 0) throw new Error("strategy_memory_compression_job_not_found");
  stopStrategyMemoryCompressionPolling({ clearJob:true });
  state.strategyMemoryCompressionJob = { ...job, id:jobId, strategy_id:Number(strategyId), status:job.status || "queued" };
  state.strategyMemoryCompressionJobs[String(strategyId)] = state.strategyMemoryCompressionJob;
  state.strategyMemoryCompressionPollKey = `${Number(strategyId)}:${jobId}`;
  const generation = state.strategyMemoryCompressionPollGeneration;
  renderStrategyMemoryCompressionStatus(state.strategyMemoryCompressionJob);
  if (!document.hidden) void pollStrategyMemoryCompressionJob(strategyId, jobId, generation);
}

function resumeStrategyMemoryCompressionPolling() {
  const key = state.strategyMemoryCompressionPollKey;
  const job = state.strategyMemoryCompressionJob;
  if (!key || !job || strategyMemoryCompressionTerminal(job) || document.hidden) return;
  const [strategyId, jobId] = key.split(":").map(Number);
  void pollStrategyMemoryCompressionJob(strategyId, jobId, state.strategyMemoryCompressionPollGeneration);
}

function handleStrategyMemoryVisibilityChange() {
  if (document.hidden) clearTimeout(state.strategyMemoryCompressionPollTimer);
  else {
    resumeStrategyMemoryCompressionPolling();
    resumeStrategyMemoryConsistencyPolling();
  }
}

function strategyMemoryReasonLabel(value) {
  return ({ manual_edit:"人工编辑", restore:"恢复历史版本", daily_review_append:"日复盘沉淀",
    monthly_review_append:"月复盘沉淀", monthly_review_compression:"月复盘压缩",
    capacity_compression:"容量压缩", corrective_memory_merge:"完整性纠正",
    legacy_import:"旧记忆一次性迁移" })[String(value || "")] || "系统更新";
}

const STRATEGY_MEMORY_CONSISTENCY_TERMINAL = new Set(["succeeded", "succeeded_noop", "failed", "stale", "status_unknown"]);
function stopStrategyMemoryConsistencyPolling() {
  clearTimeout(state.strategyMemoryConsistencyPollTimer);
  state.strategyMemoryConsistencyPollTimer = null;
  state.strategyMemoryConsistencyGeneration += 1;
}
function resumeStrategyMemoryConsistencyPolling() {
  const job = state.strategyMemoryConsistencyJob;
  const strategyId = Number(state.selectedStrategyMemoryId || 0);
  if (!document.hidden && strategyId > 0 && job
    && !STRATEGY_MEMORY_CONSISTENCY_TERMINAL.has(String(job.status || ""))) {
    startStrategyMemoryConsistencyPolling(strategyId, job);
  }
}
function strategyMemoryConsistencyLabel(job) {
  if (String(job?.last_error_code || "") === "model_input_limit_exceeded") return "当前模型容量不足，未完成一致性检查";
  return ({ queued:"等待一致性检查", leased:"正在核对策略一致性", succeeded:"一致性检查完成",
    succeeded_noop:"未发现策略冲突", failed:"一致性检查失败，记忆已保留",
    stale:"策略或记忆已变化，结果未应用", status_unknown:"检查状态未知，可重新检查" })[String(job?.status || "")] || "尚未检查一致性";
}
async function loadStrategyMemoryPreview(strategyId) {
  try {
    const data = await api(`/api/ai/strategy-memories/${strategyId}/preview`);
    const library = state.strategyMemoryDetail?.library;
    if (Number(data.library_identity?.strategy_id) !== Number(strategyId)
      || Number(data.library_identity?.version_no) !== Number(library?.version_no)
      || String(data.library_identity?.content_hash || "") !== String(library?.content_hash || "")) {
      throw new Error("strategy_memory_preview_version_mismatch");
    }
    state.strategyMemoryPreview = data;
    state.strategyMemoryPreviewError = "";
    state.strategyMemoryConsistencyJob = data.consistency_check || state.strategyMemoryConsistencyJob;
    return data;
  } catch (error) {
    state.strategyMemoryPreview = null;
    state.strategyMemoryPreviewError = localizeReason(error.message);
    return null;
  }
}
function startStrategyMemoryConsistencyPolling(strategyId, job) {
  const jobId = Number(job?.id || job?.job_id || 0); if (!jobId) return;
  stopStrategyMemoryConsistencyPolling();
  state.strategyMemoryConsistencyJob = { ...job, id:jobId, strategy_id:Number(strategyId) };
  const generation = state.strategyMemoryConsistencyGeneration;
  const poll = async () => {
    if (document.hidden || generation !== state.strategyMemoryConsistencyGeneration) return;
    try {
      const data = await api(`/api/ai/strategy-memories/${strategyId}/consistency-checks/${jobId}`);
      if (generation !== state.strategyMemoryConsistencyGeneration || Number(state.selectedStrategyMemoryId) !== Number(strategyId)) return;
      state.strategyMemoryConsistencyJob = data.job;
      if (STRATEGY_MEMORY_CONSISTENCY_TERMINAL.has(String(data.job?.status || ""))) {
        state.strategyMemoryDetail = await api(`/api/ai/strategy-memories/${strategyId}`);
        await loadStrategyMemoryPreview(strategyId);
        renderStrategyMemoryLibrary(); return;
      }
    } catch { /* retry while the current page/strategy still owns the generation */ }
    if (generation === state.strategyMemoryConsistencyGeneration) state.strategyMemoryConsistencyPollTimer = setTimeout(poll, 2000);
  };
  void poll();
}

function strategyMemoryConflictPresentation(stateName) {
  const key = String(stateName || "").replace(/-/g, "_");
  const labels = {
    attention_required: { icon:"triangle-alert", text:"需要人工检查策略", tone:"danger" },
    observing: { icon:"eye", text:"观察中", tone:"warning" },
    unverified: { icon:"circle-help", text:"检查发现，等待复盘验证", tone:"warning" },
    location_stale: { icon:"map-pin-off", text:"原文位置已变化，待复核", tone:"neutral" },
    resolved: { icon:"circle-check", text:"已处理", tone:"success" },
    dismissed: { icon:"minus", text:"已忽略", tone:"neutral" },
    healthy: { icon:"circle-check", text:"状态正常", tone:"success" },
  };
  return labels[key] ? { ...labels[key], key } : null;
}

function strategyMemoryConflictStatusMarkup(stateName, count = 0, className = "") {
  const presentation = strategyMemoryConflictPresentation(stateName);
  if (!presentation) return "";
  const suffix = Number(count || 0) > 0 ? ` · ${Number(count)} 项` : "";
  return `<span class="strategy-memory-status-badge is-${presentation.key} ${presentation.tone} ${className}" role="status"><span class="strategy-memory-status-icon" aria-hidden="true"><i data-lucide="${presentation.icon}" size="14"></i></span><strong>${presentation.text}${suffix}</strong></span>`;
}

function strategyMemoryPreviewMarkup(preview) {
  if (!preview) return `<div class="strategy-memory-preview-error" role="alert"><strong>预览暂不可用</strong><span>${escapeHtml(state.strategyMemoryPreviewError || "请重试预览，原文仍可查看。")}</span><button class="text-button" type="button" data-strategy-memory-mode="source">编辑原文</button></div>`;
  if (!(preview.blocks || []).length) return '<div class="strategy-memory-preview-empty"><strong>尚无已沉淀经验</strong><span>确认日/月复盘后会形成第一版记忆。</span></div>';
  const blocks = (preview.blocks || []).filter(block => !state.strategyMemoryConflictOnly || block.conflict_ids?.length || block.conflict_state);
  return `<div class="strategy-memory-preview-body">${blocks.map(block => {
    const conflictState = String(block.conflict_state || "").replace(/-/g, "_");
    const tone = conflictState ? ` is-${escapeHtml(conflictState === "location_stale" ? "location-stale" : conflictState)}` : "";
    const marker = strategyMemoryConflictStatusMarkup(conflictState, (block.conflicts || []).length);
    const conflicts = (block.conflicts || []).map(item => `<details class="strategy-memory-inline-conflict"><summary>${escapeHtml(item.summary || "策略冲突候选")} · ${Number(item.evidence_count || 0)}/${Number(item.alert_threshold || 3)}</summary><p>策略原文：${escapeHtml(item.strategy_excerpt || "-")}</p><p>记忆原文：${escapeHtml(item.memory_excerpt || "-")}</p>${item.suggested_change ? `<p>建议核对：${escapeHtml(item.suggested_change)}</p>` : ""}</details>`).join("");
    return `<article class="strategy-memory-preview-block${tone}" data-memory-block-id="${escapeHtml(block.block_id)}">${marker}${block.html}${conflicts}</article>`;
  }).join("") || '<div class="strategy-memory-preview-empty"><span>当前版本没有可定位冲突。</span></div>'}</div>`;
}

function renderStrategyMemoryLibrary() {
  const host = $("memoryItemsList"); if (!host) return;
  const strategies = state.strategyMemoryStrategies || [];
  if (!strategies.length) {
    host.innerHTML = '<div class="strategy-memory-empty empty-state"><span class="review-empty-icon"><i data-lucide="library" size="20"></i></span><strong>还没有可管理的策略</strong><span>创建策略后，系统会为它建立唯一的记忆库。</span></div>';
    initIcons(); return;
  }
  const selectedId = Number(state.selectedStrategyMemoryId || strategies[0].strategy_id);
  const selected = strategies.find(item => Number(item.strategy_id) === selectedId) || strategies[0];
  const detail = state.strategyMemoryDetail || {};
  const library = detail.library || selected.library || { version_no:0, content_text:"", char_count:0, capacity_chars:120000, pending_update_count:0, compression_status:"idle" };
  if (Number(state.strategyMemoryEditorStrategyId) !== Number(selected.strategy_id)
      || state.strategyMemoryEditorBaseline === null) {
    state.strategyMemoryEditorStrategyId = Number(selected.strategy_id);
    state.strategyMemoryEditorBaseline = library.content_text || "";
    state.strategyMemoryEditorDirty = false;
  }
  const compressionJob = Number(state.strategyMemoryCompressionJob?.strategy_id) === Number(selected.strategy_id)
    ? state.strategyMemoryCompressionJob : null;
  const compressionPresentation = strategyMemoryCompressionPresentation(compressionJob, library);
  const revisions = detail.revisions || [];
  const conflicts = detail.conflicts || [];
  const currentLocation = item => String(item.verification_status || "") === "matched"
    && String(item.location_status || "") === "matched";
  const alerts = conflicts.filter(item => item.status === "attention_required" && currentLocation(item));
  const observing = conflicts.filter(item => item.status === "observing" && currentLocation(item));
  const activeConflictIds = new Set([...alerts, ...observing].map(item => Number(item.id)));
  const inactiveConflicts = conflicts.filter(item => !activeConflictIds.has(Number(item.id)));
  const stale = inactiveConflicts.filter(item => String(item.verification_status || "") === "location_stale");
  const usage = Math.min(100, Math.round(Number(library.char_count || 0) / Math.max(1, Number(library.capacity_chars || 120000)) * 100));
  const options = strategies.map(item => `<option value="${Number(item.strategy_id)}" ${Number(item.strategy_id) === Number(selected.strategy_id) ? "selected" : ""}>${escapeHtml(item.title || `策略 #${item.strategy_id}`)} · ${item.strategy_scope === "platform" ? "平台" : "私有"}</option>`).join("");
  const conflictRows = [...alerts, ...observing, ...inactiveConflicts].map(item => {
    const inactive = ["resolved", "dismissed"].includes(String(item.status || ""));
    const staleRow = String(item.verification_status || "") === "location_stale";
    const stateName = staleRow ? "location_stale" : item.status;
    const badge = strategyMemoryConflictStatusMarkup(stateName, stateName === "observing" ? Number(item.evidence_count || 0) : 0);
    const rowClass = stateName === "location_stale" ? "location-stale" : stateName;
    const actionButtons = inactive || staleRow
      ? `<button class="btn btn-secondary btn-sm" type="button" data-strategy-memory-conflict="${Number(item.id)}" data-strategy-memory-conflict-action="reopen">重新打开</button>`
      : `<button class="btn btn-secondary btn-sm" type="button" data-strategy-memory-conflict="${Number(item.id)}" data-strategy-memory-conflict-action="dismiss">忽略</button><button class="btn btn-primary btn-sm" type="button" data-strategy-memory-conflict="${Number(item.id)}" data-strategy-memory-conflict-action="resolve">已处理</button>`;
    return `<article class="strategy-memory-conflict is-${escapeHtml(rowClass)}">
    <div><div class="strategy-memory-conflict-state">${badge}</div><strong>${escapeHtml(item.conflict_summary || "发现记忆与策略可能冲突")}</strong>${item.strategy_excerpt ? `<p>策略原文：${escapeHtml(item.strategy_excerpt)}</p>` : ""}${item.memory_excerpt ? `<p>记忆原文：${escapeHtml(item.memory_excerpt)}</p>` : ""}${item.suggested_change ? `<p>建议核对：${escapeHtml(item.suggested_change)}</p>` : ""}</div>
    <div class="strategy-memory-row-actions">${actionButtons}</div>
  </article>`; }).join("");
  const revisionRows = revisions.slice(0, 20).map(item => { const sourceReview = String(item.source_type || "") === "period_review_version" && Number(item.source_id || 0) > 0 ? ` · 来源复盘版本 #${Number(item.source_id)}` : ""; return `<li><div><strong>版本 ${Number(item.version_no)}</strong><span>${escapeHtml(strategyMemoryReasonLabel(item.change_reason))}${escapeHtml(sourceReview)} · ${escapeHtml(formatTime(item.created_at))}</span></div>${Number(item.version_no) !== Number(library.version_no) ? `<button class="text-button" type="button" data-strategy-memory-restore="${Number(item.id)}">恢复此版本</button>` : '<span class="status-chip success">当前</span>'}</li>`; }).join("");
  const sourceMode = state.strategyMemoryViewMode === "source";
  const consistencyLabel = strategyMemoryConsistencyLabel(state.strategyMemoryConsistencyJob);
  const healthLabel = alerts.length ? `需要人工检查 ${alerts.length} 项` : observing.length ? `观察中 ${observing.length} 项` : "状态正常";
  const healthTone = alerts.length ? "danger" : observing.length ? "warning" : "success";
  const conflictCountRows = `<div class="strategy-memory-side-metrics"><div><span>需人工检查</span><strong>${alerts.length}</strong><small>达到提醒阈值</small></div><div><span>观察中</span><strong>${observing.length}</strong><small>等待更多证据</small></div><div><span>待复核</span><strong>${stale.length}</strong><small>原文位置变化</small></div></div>`;
  host.innerHTML = `<section class="strategy-memory-library strategy-memory-workspace">
    <header class="strategy-memory-toolbar"><label><span>选择策略</span><select id="strategyMemorySelector">${options}</select></label><div class="strategy-memory-summary"><span><strong>v${Number(library.version_no || 0)}</strong> 当前版本</span><span class="strategy-memory-health ${healthTone}"><strong>${escapeHtml(healthLabel)}</strong></span></div></header>
    ${alerts.length ? `<div class="strategy-memory-alert" role="alert"><span class="strategy-memory-status-icon" aria-hidden="true"><i data-lucide="triangle-alert" size="15"></i></span><div><strong>${alerts.length} 项策略冲突已达到提醒阈值</strong><span>系统只做提醒，不会自动修改策略。请核对下方证据后人工决定。</span></div></div>` : ""}
    <div class="strategy-memory-layout"><section class="strategy-memory-document" aria-label="策略记忆 Markdown 文档"><header class="strategy-memory-document-heading"><div><span class="strategy-memory-kicker">唯一完整记忆库</span><h2>策略记忆文档</h2><p>当前版本会完整传入后续分析、日复盘和月复盘。</p></div><span class="strategy-memory-version">v${Number(library.version_no || 0)} · ${Number(library.char_count || 0).toLocaleString("zh-CN")} 字</span></header>
      <div class="strategy-memory-viewbar"><div class="strategy-memory-view-switch" role="tablist" aria-label="记忆库查看模式"><button type="button" role="tab" aria-selected="${!sourceMode}" aria-controls="strategyMemoryDocumentStage" data-strategy-memory-mode="preview" class="${!sourceMode ? 'active' : ''}">阅读预览</button><button type="button" role="tab" aria-selected="${sourceMode}" aria-controls="strategyMemoryDocumentStage" data-strategy-memory-mode="source" class="${sourceMode ? 'active' : ''}">编辑原文</button></div><div class="strategy-memory-view-tools">${!sourceMode ? `<label class="strategy-memory-filter-toggle"><input type="checkbox" data-strategy-memory-conflict-only ${state.strategyMemoryConflictOnly ? 'checked' : ''}><span class="strategy-memory-filter-control" aria-hidden="true"><span></span></span><span class="strategy-memory-filter-label">只看冲突</span></label>` : ""}</div></div>
      ${!sourceMode && state.strategyMemoryEditorDirty ? '<div class="strategy-memory-draft-notice" role="status">当前显示的是已保存版本预览；原文中还有未保存修改。</div>' : ''}
      <div id="strategyMemoryDocumentStage" class="strategy-memory-document-stage">${sourceMode ? `<label class="strategy-memory-editor"><span>编辑完整记忆库原文 <span class="sr-only">完整记忆库原文（Markdown）</span></span><textarea id="strategyMemoryContent" rows="22" spellcheck="false" aria-describedby="strategyMemoryHelp">${escapeHtml(state.strategyMemoryEditorDirty ? (state.strategyMemoryEditorDraft ?? library.content_text ?? "") : (library.content_text || ""))}</textarea><small id="strategyMemoryHelp">这是该策略唯一的完整 Markdown 记忆库。保存会形成可恢复的新版本；不保存不会写入服务端。</small></label>` : strategyMemoryPreviewMarkup(state.strategyMemoryPreview)}</div>
      ${sourceMode ? `<div class="strategy-memory-actions strategy-memory-editor-actions"><button class="btn btn-secondary" type="button" data-strategy-memory-action="cancel">取消编辑</button><button class="btn btn-primary" type="button" data-strategy-memory-action="save" ${!state.strategyMemoryEditorDirty || compressionPresentation.active ? 'disabled' : ''}>保存新版本</button></div>` : ""}
      ${conflictRows ? `<section class="strategy-memory-conflicts"><header><div><h3>策略冲突提醒</h3><p>同一冲突必须在至少 ${Number(library.conflict_alert_threshold || 3)} 次不同且已确认的复盘中出现，才会要求人工检查策略。</p></div><span>${alerts.length} 项需处理 · ${observing.length} 项观察中 · ${stale.length} 项待复核</span></header>${conflictRows}</section>` : ""}
    </section><aside class="strategy-memory-sidebar" aria-label="记忆库维护状态"><section class="strategy-memory-side-card strategy-memory-capacity-card"><header><div><span class="strategy-memory-side-kicker">维护状态</span><h3>容量</h3></div><strong>${usage}%</strong></header><div class="strategy-memory-capacity" aria-label="记忆库容量已使用 ${usage}%"><span style="width:${usage}%"></span></div><p><strong>${Number(library.char_count || 0).toLocaleString("zh-CN")}</strong> / ${Number(library.capacity_chars || 120000).toLocaleString("zh-CN")} 字</p></section><section class="strategy-memory-side-card strategy-memory-task-card"><header><div><span class="strategy-memory-side-kicker">维护任务</span><h3>整理压缩</h3></div><span id="strategyMemoryCompressionStatus" class="status-chip" role="status" aria-live="polite">${escapeHtml(compressionPresentation.text)}</span></header><p>达到容量或月复盘确认时整理，原记忆始终可恢复。</p><button class="btn btn-secondary" type="button" data-strategy-memory-action="compress" ${compressionPresentation.active ? 'disabled' : ''}><i data-lucide="combine" size="15"></i>${compressionPresentation.active ? '正在整理' : '整理并压缩'}</button></section><section class="strategy-memory-side-card strategy-memory-task-card"><header><div><span class="strategy-memory-side-kicker">维护检查</span><h3>一致性</h3></div><span class="strategy-memory-consistency-status" role="status" aria-live="polite">${escapeHtml(consistencyLabel)}</span></header><p>核对策略原文与记忆块的来源和位置，不会自动修改策略。</p><button class="btn btn-secondary" type="button" data-strategy-memory-action="consistency">重新检查</button></section><section class="strategy-memory-side-card strategy-memory-conflict-card"><header><div><span class="strategy-memory-side-kicker">人工处理</span><h3>冲突计数</h3></div>${strategyMemoryConflictStatusMarkup(alerts.length ? "attention_required" : observing.length ? "observing" : "healthy")}</header>${conflictCountRows}</section><details class="strategy-memory-revisions strategy-memory-side-card"><summary><span><i data-lucide="history" size="15"></i><strong>版本历史</strong><small>可恢复版本</small></span><i data-lucide="chevron-down" size="15"></i></summary><ol>${revisionRows || '<li class="strategy-memory-empty-row">尚无历史版本</li>'}</ol></details></aside></div>
  </section>`;
  initIcons();
  $("strategyMemoryContent")?.addEventListener("input", event => {
    state.strategyMemoryEditorDirty = event.currentTarget.value !== state.strategyMemoryEditorBaseline;
    state.strategyMemoryEditorDraft = event.currentTarget.value;
    const saveButton = document.querySelector('[data-strategy-memory-action="save"]');
    if (saveButton) saveButton.disabled = !state.strategyMemoryEditorDirty || strategyMemoryCompressionActive(state.strategyMemoryCompressionJob);
  });
  renderStrategyMemoryCompressionStatus(compressionJob);
  $("strategyMemorySelector")?.addEventListener("change", async event => {
    const previousId = Number(state.selectedStrategyMemoryId || selected.strategy_id);
    const nextId = Number(event.target.value);
    if (state.strategyMemoryEditorDirty) {
      const confirmed = await showConfirm("放弃未保存的记忆原文？", "切换策略会丢弃当前尚未保存的 Markdown 修改。", { confirmText:"放弃并切换", danger:true });
      if (!confirmed) { event.target.value = String(previousId); return; }
    }
    stopStrategyMemoryCompressionPolling({ clearJob:true });
    stopStrategyMemoryConsistencyPolling();
    state.selectedStrategyMemoryId = nextId;
    state.strategyMemoryEditorBaseline = null;
    state.strategyMemoryEditorStrategyId = null;
    state.strategyMemoryEditorDirty = false;
    state.strategyMemoryEditorDraft = null;
    state.strategyMemoryViewMode = "preview";
    state.strategyMemoryPreview = null;
    host.innerHTML = '<div class="workspace-skeleton"></div>';
    try {
      const [detail, latestCompression] = await Promise.all([
        api(`/api/ai/strategy-memories/${state.selectedStrategyMemoryId}`),
        api(`/api/ai/strategy-memories/${state.selectedStrategyMemoryId}/compression-jobs-latest`),
      ]);
      state.strategyMemoryDetail = detail;
      await loadStrategyMemoryPreview(state.selectedStrategyMemoryId);
      const rememberedJob = latestCompression.job || null;
      if (rememberedJob) state.strategyMemoryCompressionJobs[String(state.selectedStrategyMemoryId)] = rememberedJob;
      renderStrategyMemoryLibrary();
      if (rememberedJob && strategyMemoryCompressionActive(rememberedJob)) startStrategyMemoryCompressionPolling(state.selectedStrategyMemoryId, rememberedJob);
      else if (rememberedJob) { state.strategyMemoryCompressionJob = rememberedJob; renderStrategyMemoryCompressionStatus(rememberedJob); }
    }
    catch (error) { toast(localizeReason(error.message), "error"); }
  });
}

async function refreshTabData(tabId, options = {}) {
  if (!state.token) return;
  if (tabId === "trading") {
    await Promise.allSettled([loadAccount(), loadPositions(), loadStatus(), loadPendingOrders(), refreshQuote(), loadPositionManagement({ quiet:true, preserveSelection:true })]);
  } else if (tabId === "dashboard") {
    await Promise.allSettled([
      loadAccount(),
      loadPositions(),
      loadStatus(),
      refreshQuote(),
      loadKlineData(),
      loadSignals({ limit:1, summaryOnly:true, skipResultRender:true }),
    ]);
    startKlineRefreshTimer();
    startKlineVolumeRefreshTimer();
    startLiveQuoteRefreshTimer();
  } else if (tabId === "history") {
    updateHistoryRangeUI();
    // Legacy wording kept here for compatibility audits; the public query
    // entry now adds a generation and prepares one frozen range first.
    // loadHistoryViews({ forceRefresh:false, includeAccount:true })
    if (options.manualRefresh === true) {
      await loadHistoryViews({ newQuery:true, trigger:"refresh", forceRefresh:true, includeAccount:true, manualRefresh:true });
    } else {
      await loadHistoryViews({ forceRefresh:false, includeAccount:true });
    }
  } else if (tabId === "audit") {
    await loadAudit();
  } else if (tabId === "model-strategy") {
    await Promise.allSettled([loadStrategyCatalog(), loadModelManagement()]);
  } else if (tabId === "ai-analyze") {
    if (state.analystView === "records") {
      await loadSignalTable();
      return;
    }
    if (!state.analysisHistoryPageLoaded) renderAnalysisHistoryLoading();
    const selectLatest = options.selectLatest === true;
    const tasks = [loadSignals(selectLatest
      ? { selectLatest:true, loadDashboard:false }
      : { skipResultRender:true, loadDashboard:false })];
    if (!isObserverMode()) tasks.push(loadStrategyCatalog());
    await Promise.allSettled(tasks);
    if (selectLatest) {
      const historyList = $("analysisHistoryBody");
      if (historyList) historyList.scrollTop = 0;
    }
  } else if (tabId === "risk-center") {
    await loadRiskCenter();
  } else if (tabId === "review-memory") {
    if (state.reviewMemoryView === "manual-trades" && canManagePlatformAiContent()) await loadManualTradeReviewWorkspace();
    else await loadReviewMemory();
  }
}

async function withBusy(button, task) {
  if (button) button.classList.add("spinning");
  try {
    return await task();
  } finally {
    if (button) button.classList.remove("spinning");
    initIcons();
  }
}

let accountCenterPreviousFocus = null;

function openAccountCenter(tab = "overview", notificationId = "") {
  const modal = $("accountCenterModal");
  const frame = $("accountCenterFrame");
  if (!modal || !frame) return;
  accountCenterPreviousFocus = document.activeElement;
  const nextSrc = `/account/?embed=ai&tab=${encodeURIComponent(tab)}${notificationId != null && String(notificationId) ? `&notification=${encodeURIComponent(String(notificationId))}` : ""}`;
  // A banner click carries a concrete notification id. Reloading the iframe
  // with that query is deterministic even if a previous tab message raced
  // the iframe's initial load; ordinary account clicks keep the live frame.
  if (notificationId != null && String(notificationId)) frame.src = nextSrc;
  else if (!frame.src || !frame.src.includes("/account/")) frame.src = nextSrc;
  else frame.contentWindow?.postMessage({ type:"account-center-tab", tab, ...(notificationId ? { notificationId:String(notificationId) } : {}) }, window.location.origin);
  modal.classList.remove("hidden");
  modal.setAttribute("aria-hidden", "false");
  document.body.classList.add("account-center-open");
}

function openNotificationCenter(notificationId = "") {
  openAccountCenter("notifications", notificationId);
}

function closeAccountCenter() {
  const modal = $("accountCenterModal");
  if (!modal || modal.classList.contains("hidden")) return;
  modal.classList.add("hidden");
  modal.setAttribute("aria-hidden", "true");
  document.body.classList.remove("account-center-open");
  if (accountCenterPreviousFocus instanceof HTMLElement) accountCenterPreviousFocus.focus();
  accountCenterPreviousFocus = null;
}

function handleAccountCenterMessage(event) {
  if (event.origin !== window.location.origin || event.source !== $("accountCenterFrame")?.contentWindow) return;
  const data = event.data;
  if (!data || typeof data !== "object" || typeof data.type !== "string") return;
  if (data.type === "account-center-close") return closeAccountCenter();
  if (data.type === "account-session-logout") return logout();
  if (data.type === "account-profile-updated" && data.user) {
    state.user = { ...state.user, ...data.user };
  }
  if (data.type === "account-notifications-updated") {
    const latest = data.latestImportant && typeof data.latestImportant === "object" ? {
      id:data.latestImportant.id,
      title:String(data.latestImportant.title || "重要通知"),
      priority:String(data.latestImportant.priority || "important"),
      requiresAck:Boolean(data.latestImportant.requiresAck),
    } : null;
    updateNotificationSummary({
      unreadCount:Number.isFinite(Number(data.unreadCount)) ? Number(data.unreadCount) : state.notificationUnread,
      importantUnacknowledgedCount:Number.isFinite(Number(data.importantUnacknowledgedCount)) ? Number(data.importantUnacknowledgedCount) : state.notificationImportantUnacknowledgedCount,
      latestImportant:latest,
    }, { announce:false });
    // The iframe intentionally sends only a minimal summary. Read the full
    // latest notification in this page so the local banner can retain its
    // short body without placing notification text in postMessage.
    void refreshNotificationSummary({ announce:false });
  }
}

function logout() {
  invalidateSession();
}

// Presence heartbeat — updates last_seen_at for online count
const _presenceInterval = 60000;
let _presenceTimer = null;
let _presenceLastSend = 0;

function startPresenceHeartbeat() {
  if (_presenceTimer) return;
  if (!state.token) return;
  sendPresenceHeartbeat();
  _presenceTimer = setInterval(() => {
    if (document.visibilityState === 'hidden') return;
    if (!state.token) { stopPresenceHeartbeat(); return; }
    sendPresenceHeartbeat();
  }, _presenceInterval);
}

function stopPresenceHeartbeat() {
  if (_presenceTimer) { clearInterval(_presenceTimer); _presenceTimer = null; }
  _presenceLastSend = 0;
}

async function sendPresenceHeartbeat() {
  const now = Date.now();
  if (now - _presenceLastSend < 30000) return;
  _presenceLastSend = now;
  try {
    await api('/api/presence', { method: 'POST', body: JSON.stringify({ view: activeTabId() }), timeout: 5000 });
  } catch {}
}

let membershipExpiryReminderOpen = false;

async function acknowledgeMembershipExpiryReminder(reminderId) {
  try {
    await api(`/api/membership-expiry-reminders/${Number(reminderId)}/read`, {
      method:"POST",
      body:{ surface:"ai" },
    });
  } catch {}
}

function showMembershipExpiryReminder(reminder) {
  if (!reminder || membershipExpiryReminderOpen) return;
  membershipExpiryReminderOpen = true;
  const previousFocus = document.activeElement;
  const overlay = document.createElement("div");
  overlay.className = "membership-expiry-overlay";
  overlay.innerHTML = `
    <section class="membership-expiry-dialog" role="dialog" aria-modal="true" aria-labelledby="aiMembershipExpiryTitle" aria-describedby="aiMembershipExpirySummary">
      <button class="membership-expiry-close" type="button" aria-label="关闭会员到期提醒">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12"/></svg>
      </button>
      <div class="membership-expiry-mark" aria-hidden="true">
        <svg viewBox="0 0 24 24"><path d="M12 7v5l3 2M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z"/></svg>
      </div>
      <p class="membership-expiry-eyebrow">会员到期提醒</p>
      <h2 id="aiMembershipExpiryTitle">${escapeHtml(reminder.title)}</h2>
      <p id="aiMembershipExpirySummary">${escapeHtml(reminder.summary)}</p>
      <div class="membership-expiry-facts">
        <span><small>当前会员</small><strong>${escapeHtml(reminder.plan_label)}</strong></span>
        <span><small>到期日期</small><strong>${escapeHtml(reminder.expiry_date_text)}</strong></span>
      </div>
      <div class="membership-expiry-actions">
        <button class="btn btn-primary membership-expiry-renew" type="button">前往续费</button>
        <button class="btn membership-expiry-later" type="button">稍后处理</button>
      </div>
      <p class="membership-expiry-note">续费成功后会员有效期会自动更新，无需重新连接桥接软件。</p>
    </section>`;
  document.body.appendChild(overlay);
  const dismiss = ({ renew = false } = {}) => {
    if (!membershipExpiryReminderOpen) return;
    membershipExpiryReminderOpen = false;
    overlay.classList.remove("active");
    void acknowledgeMembershipExpiryReminder(reminder.id);
    setTimeout(() => overlay.remove(), 180);
    if (renew) {
      openAccountCenter("subscription");
      accountCenterPreviousFocus = previousFocus instanceof HTMLElement ? previousFocus : null;
    } else if (previousFocus instanceof HTMLElement) previousFocus.focus();
  };
  overlay.querySelector(".membership-expiry-close")?.addEventListener("click", () => dismiss());
  overlay.querySelector(".membership-expiry-later")?.addEventListener("click", () => dismiss());
  overlay.querySelector(".membership-expiry-renew")?.addEventListener("click", () => dismiss({ renew:true }));
  overlay.addEventListener("click", event => { if (event.target === overlay) dismiss(); });
  overlay.addEventListener("keydown", event => {
    if (event.key === "Escape") return dismiss();
    if (event.key !== "Tab") return;
    const focusable = [...overlay.querySelectorAll("button:not([disabled]), a[href]")];
    if (!focusable.length) return;
    const first = focusable[0], last = focusable.at(-1);
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  });
  requestAnimationFrame(() => {
    overlay.classList.add("active");
    overlay.querySelector(".membership-expiry-renew")?.focus();
  });
}

async function checkMembershipExpiryReminder() {
  if (!state.user || !state.token || membershipExpiryReminderOpen) return;
  if (!["plus", "pro"].includes(String(state.user.plan || "").toLowerCase())) return;
  try {
    const result = await api("/api/membership-expiry-reminders?surface=ai");
    if (result?.reminder) showMembershipExpiryReminder(result.reminder);
  } catch {}
}

function membershipPlanLabel(plan) {
  const value = String(plan || 'free').toLowerCase();
  if (value === 'pro') return 'Pro 专业版';
  if (value === 'plus') return 'Plus 会员';
  return '免费版';
}

function formatMembershipExpiry(value) {
  if (!value) return '';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? String(value).slice(0,10) : date.toLocaleDateString('zh-CN');
}

function renderMembershipAccessState(user, access) {
  const gate = $('proOverlay');
  if (!gate) return;
  const expired = access?.reason === 'membership_expired';
  const account = user?.name || user?.email || user?.phone || user?.uid || `用户 #${user?.id || '--'}`;
  const avatar = String(user?.name || user?.email || user?.phone || '用').trim().slice(0,1) || '用';
  const purchasedPlan = membershipPlanLabel(user?.plan);
  const expiresAt = formatMembershipExpiry(user?.planExpiresAt);

  gate.classList.remove('hidden');
  gate.classList.toggle('is-expired', expired);
  gate.classList.toggle('is-free', !expired);
  $('membershipGateStatus').querySelector('span').textContent = expired ? '会员已到期 · 需要续费' : '免费账户 · 需要开通会员';
  $('membershipGateEyebrow').textContent = '当前访问状态';
  $('membershipGateTitle').textContent = expired ? '续费后恢复 AI 交易实验室' : '开通会员后进入 AI 交易实验室';
  $('membershipGateDescription').textContent = expired
    ? `你的 ${purchasedPlan}${expiresAt ? ` 已于 ${expiresAt} 到期` : ' 已到期'}。账户资料仍然保留，续费成功后会自动恢复对应权限。`
    : '当前账户已成功登录，但免费版不包含实验室权限。选择 Plus 进行观摩，或选择 Pro 连接自己的 MT4/MT5。';
  $('membershipGateAccount').textContent = account;
  $('membershipGateAvatar').textContent = avatar;
  $('membershipGatePlan').textContent = expired ? `${purchasedPlan} · 已过期` : '免费版';
  $('membershipGateAccess').textContent = expired ? '已暂停' : '暂未开通';
  $('membershipRetentionNote').querySelector('strong').textContent = expired ? '工作区资料仍然保留' : '账户状态正常';
  $('membershipRetentionNote').querySelector('small').textContent = expired
    ? '账户配置、策略资料和历史记录不会因到期自动删除，续费后可以继续使用。'
    : '开通会员只会增加对应权限，不会改变你的登录账户和主站资料。';
  $('membershipGatePrimary').firstChild.textContent = expired ? '立即续费' : '选择会员方案';
  $('membershipGatePrimary').href = '/account/?tab=subscription';
  const plusPlan = $('membershipPlusPlan');
  const proPlan = $('membershipProPlan');
  plusPlan?.classList.toggle('is-current-plan', expired && String(user?.plan || '').toLowerCase() === 'plus');
  proPlan?.classList.toggle('is-current-plan', expired && String(user?.plan || '').toLowerCase() === 'pro');
  const plusTag = plusPlan?.querySelector('.membership-plan-tag');
  const proTag = proPlan?.querySelector('.membership-plan-tag');
  if (plusTag) plusTag.textContent = plusPlan.classList.contains('is-current-plan') ? '原套餐' : '只读';
  if (proTag) proTag.textContent = proPlan.classList.contains('is-current-plan') ? '原套餐' : '完整功能';
  document.title = `${expired ? '会员已过期' : '升级会员'} · AI交易实验室`;
}

function renderBootstrapError(error) {
  const gate = $('proOverlay');
  if (!gate) {
    showApp(false);
    return;
  }
  showApp(false);
  gate.classList.remove('hidden', 'is-expired', 'is-free');
  const status = $('membershipGateStatus')?.querySelector('span');
  if (status) status.textContent = '服务暂时不可用 · 登录状态已保留';
  setText('membershipGateEyebrow', '连接异常');
  setText('membershipGateTitle', 'AI 交易实验室暂时无法加载');
  setText('membershipGateDescription', `当前登录没有被清除。请稍后重试；如果问题持续存在，可返回主站继续使用其他功能。${error?.incidentId ? ` 错误编号：${error.incidentId}` : ''}`);
  setText('membershipGateAccount', state.user?.name || state.user?.email || state.user?.phone || '当前登录账户');
  setText('membershipGateAvatar', String(state.user?.name || state.user?.email || '用').slice(0, 1));
  setText('membershipGatePlan', membershipPlanLabel(state.user?.plan));
  setText('membershipGateAccess', error?.code === 'observer_source_unavailable' ? '观摩源不可用' : '等待服务恢复');
  const primary = $('membershipGatePrimary');
  if (primary) {
    primary.textContent = '重新加载';
    primary.href = '/ai/';
  }
  document.title = '连接异常 · AI交易实验室';
}

async function bootstrap() {
  try {
    if (!state.token) {
      const cookieToken = getCookie("ws_token");
      if (cookieToken) {
        state.token = cookieToken;
        localStorage.setItem("authToken", cookieToken);
      }
    }
    if (!state.token) {
      window.location.href = "/ai/auth/?mode=login&next=%2Fai%2F";
      return;
    }
    const profileRes = await api("/api/profile");
    state.user = profileRes.user;
    renderAdminStrategyDispatchControls();
    // Membership access is server-authoritative. Free and expired accounts
    // stay signed in and receive a useful access lobby instead of a blank app.
    const accessRes = await api("/api/ai/access-context");
    syncAiAccess(accessRes.access);
    if (accessRes.access?.mode === 'blocked') {
      renderMembershipAccessState(state.user, accessRes.access);
      showApp(false);
      return;
    }
    $('proOverlay')?.classList.add('hidden');
    void loadAdminStrategyDispatchCapabilities();
    await loadObserverChannels();
    showApp(true);
    void refreshNotificationSummary({ announce:false });
    // Manual non-trading analysis jobs survive a closed modal or browser tab.
    // Restore the task id after authentication so a later page load can resume
    // status polling without submitting a second model request.
    void restoreManualAnalysisJob();
    checkChangelog();
    void checkMembershipExpiryReminder();
    // Connect WebSocket FIRST — all data flows through it (with 10s timeout)
    await new Promise((resolve) => {
      const timer = setTimeout(() => {
        resolve();
      }, 10000);
      connectBridgeStatusWs(() => {
        clearTimeout(timer);
        resolve();
      });
    });
    // Render the default tab without requesting terminal data yet. The MT4
    // broker symbol (for example XAUUSD.s) is discovered by the initial
    // dashboard load before any quote or rates request is made.
    setTab('dashboard', { skipRefresh:true });
    startPresenceHeartbeat();
    _initialDashboardBootstrapInFlight = true;
    const marketReady = await loadInitialDashboard();
    _initialDashboardBootstrapInFlight = false;
    if (marketReady) {
      startKlineRefreshTimer();
      startKlineVolumeRefreshTimer();
      startLiveQuoteRefreshTimer();
    }
    if (!isObserverMode()) {
      await loadReviewSummary({ announce:false });
      startReviewSummaryPolling();
    }
  } catch (error) {
    _initialDashboardBootstrapInFlight = false;
    if (error?.name === "ApiError" && Number(error.status) === 401) {
      invalidateSession();
      return;
    }
    console.error("[Bootstrap] AI 实验室初始化失败:", error);
    renderBootstrapError(error);
  }
}

// The first dashboard render intentionally follows a strict dependency order:
// health/access state -> broker symbols -> dashboard data.  Hidden pages stay
// untouched until their tab is opened.  Keep failures non-fatal so an offline
// bridge can still render the signed-in observer shell and recover later.
async function loadInitialDashboard() {
  const results = [];
  results.push(...await Promise.allSettled([loadStatus()]));
  const symbolsResults = await Promise.allSettled([loadSymbolsWhenReady()]);
  results.push(...symbolsResults);

  const dashboardTasks = [
    loadAccount(),
    loadPositions(),
    loadSignals({ limit:1, summaryOnly:true, skipResultRender:true }),
  ];
  // Do not fall back to the generic XAUUSD symbol if terminal discovery
  // failed.  A suffix-only broker (for example XAUUSD.s) must fail closed
  // until its actual symbol list is available.
  if (symbolsResults[0]?.status === "fulfilled") {
    dashboardTasks.push(refreshQuote(), loadKlineData());
  }
  results.push(...await Promise.allSettled(dashboardTasks));

  const rejected = results.find(item => item.status === "rejected");
  if (rejected && state.token) {
    toast(`部分首页数据加载失败：${rejected.reason?.message || rejected.reason}`, "warning");
  }
  return symbolsResults[0]?.status === "fulfilled";
}

let _refreshAllPromise = null;

async function refreshAll() {
  if (_refreshAllPromise) return _refreshAllPromise;
  const button = $("refreshAllBtn");
  _refreshAllPromise = withBusy(button, async () => {
    const results = [];
    results.push(...await Promise.allSettled([loadStatus()]));
    results.push(...await Promise.allSettled([loadSymbolsWhenReady()]));
    const tasks = [
      loadAccount(),
      loadPositions(),
      // This path is reserved for account/Bridge recovery and explicit
      // internal reconciliation.  Keep the full signal table available here
      // without making it part of normal bootstrap or the refresh button.
      loadSignals({ loadTable:true }),
      loadHistoryViews(),
      refreshQuote(),
      loadKlineData(),
    ];
    if (!isObserverMode()) tasks.push(loadStrategyCatalog());
    results.push(...await Promise.allSettled(tasks));
    const rejected = results.find((item) => item.status === "rejected");
    if (rejected && state.token) {
      toast(`部分数据刷新失败：${rejected.reason.message || rejected.reason}`, "warning");
    }
  });
  try {
    return await _refreshAllPromise;
  } finally {
    _refreshAllPromise = null;
  }
}

let _loadStatusGeneration = 0;

async function loadStatus() {
  const requestGeneration = ++_loadStatusGeneration;
  const health = await wsApi("health");
  const gateway = health.gateway || {};
  if (gateway.platform) updateBridgePlatformUI(gateway.platform);
  state.gatewayStatus = gateway;
  if (gateway.connection_desired_state) {
    state.bridgeRuntimeControl = {
      ...(state.bridgeRuntimeControl || {}),
      desired_state: gateway.connection_desired_state,
    };
  }
  syncAiAccess(gateway.access);
  const isLive = gateway.mode === "live";
  const usingFallback = gateway.using_fallback;
  state._usingFallback = usingFallback;

  // Gateway badge — bridge connection status
  renderGatewayConnectionBadge(isLive, usingFallback);

  // Sync role-based UI (observation hint, button states, etc.)
  applyRoleUI();

  state._lastGatewayLive = isLive;

  // Trade mode badge
  const terminalTradeBlocked = isLive
    && gateway.live_trading_enabled
    && (gateway.terminal_trade_allowed === false || gateway.program_trade_allowed === false
      || gateway.account_trade_allowed === false || gateway.account_trade_expert === false);
  const tradeText = !isLive
    ? "请先启动桥接"
    : terminalTradeBlocked ? `${bridgePlatformLabel()} 自动交易关闭`
    : gateway.live_trading_enabled ? "交易已开启" : "交易已关闭";
  renderTradePermissionBadge(Boolean(gateway.live_trading_enabled), { blocked:terminalTradeBlocked, label:tradeText });

  // Update market status from server (server now detects staleness via tick_time)
  if (typeof gateway.trade_mode === 'number') updateMarketStatus(gateway.trade_mode);
  const marketClosed = state.marketTradeMode !== 4;

  if (isObserverMode()) {
    state.autoRuntime = null;
    renderObserverSwitchStates({
      tradeEnabled: gateway.live_trading_enabled,
      autoEnabled: gateway.auto_reasoning_enabled,
    });
    return;
  }

  try {
    const auto = await wsApi('auto_status');
    if (requestGeneration !== _loadStatusGeneration) return;
    const scheduler = auto.scheduler || {};
    if (Array.isArray(scheduler.active_cycles)) {
      state.autoProgressCycles = Object.fromEntries(scheduler.active_cycles
        .filter(cycle => cycle?.cycle_id)
        .map(cycle => [cycle.cycle_id, cycle]));
    } else if (!scheduler.in_flight) {
      state.autoProgressCycles = {};
    }

    // Store runtime state for local countdown
    state.autoRuntime = {
      ...scheduler,
      receivedAtMs: Date.now(),
    };

    // Render badge using unified function
    renderAutoAnalyzeBadge(state.autoRuntime);

    state.autoConfig = {
      enabled: scheduler.enabled,
      prompt_type_id: scheduler.prompt_type_id || null,
      prompt_type_name: scheduler.prompt_type_name || '',
      next_run_in_seconds: scheduler.next_run_in_seconds || 0,
      paused_reason: scheduler.paused_reason || '',
      in_flight: scheduler.in_flight || false,
    };
    state.autoEnabled = scheduler.enabled;
  } catch {
    if (requestGeneration === _loadStatusGeneration) {
      setBadge("autoAnalyzeMode", "自动分析状态未知", "warning");
    }
  }

}

// ============ Bridge control center ============
let _bridgeControlRefreshTimer = null;
let _bridgeControlLoading = false;
let _bridgeModalPreviousFocus = null;

function formatBridgeAge(timestamp) {
  const value = Number(timestamp || 0);
  if (!value) return "--";
  const seconds = Math.max(0, Math.round((Date.now() - value) / 1000));
  if (seconds < 2) return "刚刚";
  if (seconds < 60) return `${seconds} 秒前`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} 分钟前`;
  return `${Math.floor(minutes / 60)} 小时前`;
}

function bridgeControlPresentation(data) {
  const platform = normalizeBridgePlatform(data?.platform || state.bridgePlatform).toUpperCase();
  switch (data?.actual_state) {
    case "connected": return {
      icon:"link", iconClass:"is-connected", title:`${platform} 桥接已连接`,
      description:"账户数据、行情同步和服务器交易指令通道运行正常。",
    };
    case "paused": return {
      icon:"pause", iconClass:"is-paused", title:`${platform} 桥接已暂停`,
      description:"桥接软件保持本地运行，但不会连接业务服务器；MT 与已有订单不受影响。",
    };
    case "reconnecting": return {
      icon:"refresh-cw", iconClass:"is-reconnecting", title:`${platform} 正在恢复连接`,
      description:"启动指令已发送，桥接软件正在重新建立数据与交易指令通道。",
    };
    default: return {
      icon:"unplug", iconClass:"is-offline", title:"桥接客户端未连接",
      description:"请确认量见智桥正在运行并已完成账号授权；尚未安装时可在下方下载。",
    };
  }
}

function renderBridgeControlStatus(data) {
  state.bridgeRuntimeControl = data;
  if (data?.platform) updateBridgePlatformUI(data.platform);
  const presentation = bridgeControlPresentation(data);
  const summary = $("bridgeControlStatusSummary");
  if (summary) summary.dataset.state = String(data?.actual_state || "offline");
  setText("bridgeControlMonitorLabel", "实时监控");
  const icon = $("bridgeControlStatusIcon");
  if (icon) {
    icon.className = `bridge-status-icon ${presentation.iconClass}`;
    icon.innerHTML = `<i data-lucide="${presentation.icon}" size="22"></i>`;
  }
  setText("bridgeControlStateTitle", presentation.title);
  setText("bridgeControlStateDescription", presentation.description);
  const desired = $("bridgeControlDesiredBadge");
  if (desired) {
    const paused = data?.desired_state === "paused";
    desired.textContent = paused ? "用户已暂停" : "允许连接";
    desired.className = `bridge-state-chip ${paused ? "is-paused" : "is-enabled"}`;
  }
  setText("bridgeControlLatency", Number.isFinite(Number(data?.transport_latency_msc))
    ? `${Math.round(Number(data.transport_latency_msc))} ms` : "--");
  setText("bridgeControlFreshness", formatBridgeAge(data?.last_data_at_utc_msc));
  setText("bridgeControlLastSeen", formatBridgeAge(data?.last_seen_at_utc_msc));
  setText("bridgeControlVersion", data?.bridge_version || "--");

  const terminals = Array.isArray(data?.terminals) ? data.terminals : [];
  setText("bridgeControlTerminalCount", terminals.length ? `${terminals.length} 个终端` : "未检测到终端");
  const terminalList = $("bridgeControlTerminals");
  if (terminalList) {
    terminalList.innerHTML = terminals.length ? terminals.map(terminal => `
      <div class="bridge-terminal-row">
        <div class="bridge-terminal-main">
          <span class="bridge-terminal-marker" aria-hidden="true"><i data-lucide="monitor" size="17"></i></span>
          <div class="bridge-terminal-copy">
            <strong>${escapeHtml(String(terminal.platform || "").toUpperCase())} · ${escapeHtml(terminal.login || "账户识别中")}</strong>
            <span>${escapeHtml(terminal.broker_server || "交易服务器识别中")}</span>
          </div>
        </div>
        <span class="bridge-terminal-sync ${terminal.initial_sync_ready ? "" : "is-syncing"}">${terminal.initial_sync_ready ? "数据已同步" : "正在同步"}</span>
      </div>`).join("") : `<div class="bridge-terminal-empty"><i data-lucide="${data?.desired_state === "paused" ? "pause-circle" : "monitor-off"}" size="17"></i><span>${data?.desired_state === "paused"
        ? "桥接已由你暂停，启动后会自动恢复当前终端。"
        : "未发现在线终端。请启动量见智桥，或下载安装最新版。"}</span></div>`;
  }

  const toggle = $("bridgeRuntimeToggle");
  if (toggle) {
    const paused = data?.desired_state === "paused";
    toggle.disabled = _bridgeControlLoading;
    toggle.className = `btn ${paused ? "btn-primary" : "is-pause"}`;
    toggle.innerHTML = `<i data-lucide="${paused ? "play" : "pause"}" size="16"></i><span>${paused ? "启动桥接" : "暂停桥接"}</span>`;
  }
  renderGatewayConnectionBadge(data?.actual_state === "connected", state._usingFallback);
  if (typeof lucide !== "undefined") lucide.createIcons();
}

function renderBridgeControlError(message) {
  const summary = $("bridgeControlStatusSummary");
  if (summary) summary.dataset.state = "error";
  setText("bridgeControlMonitorLabel", "读取失败");
  const icon = $("bridgeControlStatusIcon");
  if (icon) {
    icon.className = "bridge-status-icon is-offline";
    icon.innerHTML = '<i data-lucide="circle-alert" size="22"></i>';
  }
  setText("bridgeControlStateTitle", "桥接状态读取失败");
  setText("bridgeControlStateDescription", message || "请检查网络连接后重新刷新。已有桥接运行不受影响。");
  const toggle = $("bridgeRuntimeToggle");
  if (toggle) { toggle.disabled = true; toggle.querySelector("span").textContent = "暂不可用"; }
  if (typeof lucide !== "undefined") lucide.createIcons();
}

async function loadBridgeControlStatus({ quiet = false } = {}) {
  if (_bridgeControlLoading) return state.bridgeRuntimeControl;
  _bridgeControlLoading = true;
  $("bridgeControlRefresh")?.setAttribute("aria-busy", "true");
  try {
    const data = await api("/api/bridge/runtime-control", { timeout:8000 });
    renderBridgeControlStatus(data);
    return data;
  } catch (error) {
    if (!quiet) renderBridgeControlError(error.message);
    return null;
  } finally {
    _bridgeControlLoading = false;
    $("bridgeControlRefresh")?.removeAttribute("aria-busy");
    if (state.bridgeRuntimeControl) renderBridgeControlStatus(state.bridgeRuntimeControl);
  }
}

function closeBridgeControlModal() {
  const modal = $("mt5BridgeModal");
  if (!modal || modal.classList.contains("hidden")) return;
  modal.classList.add("hidden");
  modal.setAttribute("aria-hidden", "true");
  $("bridgePauseConfirmation")?.classList.add("hidden");
  clearInterval(_bridgeControlRefreshTimer);
  _bridgeControlRefreshTimer = null;
  if (_bridgeModalPreviousFocus instanceof HTMLElement) _bridgeModalPreviousFocus.focus();
  _bridgeModalPreviousFocus = null;
}

async function handleGatewayModeClick() {
  if (isObserverMode() && state.aiAccess?.can_download_bridge !== true) {
    toast("Plus 会员仅支持观摩，不能下载或连接桥接软件", "warning");
    return;
  }
  // Pro without own bridge: allow bridge download modal
  const modal = $("mt5BridgeModal");
  if (!modal) return;
  if (!modal.classList.contains("hidden")) {
    closeBridgeControlModal();
    return;
  }
  _bridgeModalPreviousFocus = document.activeElement;
  modal.classList.remove("hidden");
  modal.setAttribute("aria-hidden", "false");
  requestAnimationFrame(() => $("mt5BridgeClose")?.focus());
  await loadBridgeControlStatus();
  clearInterval(_bridgeControlRefreshTimer);
  _bridgeControlRefreshTimer = setInterval(() => loadBridgeControlStatus({ quiet:true }), 3000);
}

function initBridgeModal() {
  const modal = $("mt5BridgeModal");
  if (!modal) return;

  $("mt5BridgeClose")?.addEventListener("click", closeBridgeControlModal);
  modal.addEventListener("click", (e) => { if (e.target === modal) closeBridgeControlModal(); });
  modal.addEventListener("keydown", (event) => {
    if (event.key !== "Tab") return;
    const focusable = [...modal.querySelectorAll('button:not([disabled]), summary, [href], [tabindex]:not([tabindex="-1"])')]
      .filter(element => !element.closest(".hidden"));
    if (!focusable.length) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  });
  $("bridgeControlRefresh")?.addEventListener("click", () => loadBridgeControlStatus());
  $("bridgeRuntimeToggle")?.addEventListener("click", () => {
    if (state.bridgeRuntimeControl?.desired_state === "paused") {
      updateBridgeRuntimeControl(true);
    } else {
      $("bridgePauseConfirmation")?.classList.remove("hidden");
      requestAnimationFrame(() => $("bridgePauseCancel")?.focus());
    }
  });
  $("bridgePauseCancel")?.addEventListener("click", () => {
    $("bridgePauseConfirmation")?.classList.add("hidden");
    $("bridgeRuntimeToggle")?.focus();
  });
  $("bridgePauseConfirm")?.addEventListener("click", () => updateBridgeRuntimeControl(false));

  $("downloadExe")?.addEventListener("click", async () => {
    try {
      const resp = await fetch("/api/bridge/version");
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const data = await resp.json();
      if (!data.full_url) throw new Error("bridge_download_url_missing");
      const version = data.version ? String(data.version).replace(/^v?/i, "v") : "最新版";
      window._bridgeVersion = version;
      const a = document.createElement("a");
      a.href = data.full_url;
      a.download = data.full_url.split("/").pop();
      a.click();
      toast(`正在下载量见智桥 ${version}`, "success");
    } catch {
      toast("下载信息加载失败，请稍后重试", "error");
    }
  });

}

async function updateBridgeRuntimeControl(enabled) {
  if (_bridgeControlLoading) return;
  const previous = state.bridgeRuntimeControl;
  _bridgeControlLoading = true;
  $("bridgePauseConfirmation")?.classList.add("hidden");
  if (!enabled && previous) {
    renderBridgeControlStatus({ ...previous, desired_state:"paused", actual_state:"paused" });
  }
  const toggle = $("bridgeRuntimeToggle");
  if (toggle) {
    toggle.disabled = true;
    const label = toggle.querySelector("span");
    if (label) label.textContent = enabled ? "正在启动…" : "正在暂停…";
  }
  try {
    const data = await api("/api/bridge/runtime-control", {
      method:"POST",
      body:{ enabled },
      timeout:10000,
    });
    const next = enabled && data.actual_state !== "connected"
      ? { ...data, actual_state:"reconnecting" } : data;
    renderBridgeControlStatus(next);
    if (!enabled) {
      await enterBridgeObserverMode({ paused:true });
    } else {
      // Stay on observer data until a heartbeat confirms that the personal
      // bridge is genuinely online; do not create a blank reconnect window.
      renderGatewayConnectionBadge(false, state._usingFallback === true);
    }
    toast(enabled ? "已启动桥接，正在恢复服务器连接" : "桥接已暂停，MT 与已有订单不受影响", "success");
    setTimeout(() => loadBridgeControlStatus({ quiet:true }), 700);
  } catch (error) {
    if (previous) renderBridgeControlStatus(previous);
    toast(error.message || "桥接控制操作失败，请重试", "error");
  } finally {
    _bridgeControlLoading = false;
    if (state.bridgeRuntimeControl) renderBridgeControlStatus(state.bridgeRuntimeControl);
  }
}

// ============ Trade Mode Badge Click — toggle trade sending ============
async function handleTradeModeClick() {
  if (isObserverMode()) { toast(observerMessage(), "warning"); return; }
  if (state.isPlusReadOnly) { toast("Plus 会员仅可查看", "warning"); return; }
  if (state.user?.role !== 'admin' && state.user?.plan === 'pro' && state._usingFallback) { toast(bridgeAccountConnectPrompt(), "warning"); return; }
  const health = await wsApi("health").catch(() => null);
  if (!health?.gateway) {
    toast(`暂时无法核验 ${bridgePlatformLabel()} 与交易权限，请稍后重试`, "error");
    return;
  }
  const gateway = health?.gateway || {};
  const currentlyEnabled = gateway.live_trading_enabled === true;

  // Turning on requires an active terminal connection.
  if (!currentlyEnabled && gateway.mode !== "live") {
    toast(`请先连接 ${bridgePlatformLabel()} 桥接，再开启真实交易发送`, "warning");
    return;
  }

  const terminalTradeBlocked = gateway.terminal_trade_allowed === false
    || gateway.program_trade_allowed === false
    || gateway.account_trade_allowed === false
    || gateway.account_trade_expert === false;
  if (!currentlyEnabled && terminalTradeBlocked) {
    toast(`${bridgePlatformLabel()} 当前未开放自动交易权限，请检查终端、EA 属性和账户服务器权限`, "warning");
    return;
  }

  const account = state.tradingAccounts?.find(item => item.is_active) || state.tradingAccounts?.[0];
  const subscription = state.strategySubscriptions?.find(item => Number(item.execution_enabled));
  const detailRows = [
    [`${bridgePlatformLabel()} 账户`, account ? `${account.nickname || account.login_account || "当前账户"}${account.broker_server ? ` · ${account.broker_server}` : ""}` : "当前已连接账户"],
    ["自动运行策略", subscription?.strategy_name || subscription?.prompt_type_name || "按当前订阅设置"],
    ["服务器风控", "每笔订单发送前强制校验"],
    [`${bridgePlatformLabel()} 权限`, terminalTradeBlocked ? "未开放" : "已核验"],
  ];
  const confirmed = currentlyEnabled
    ? await showConfirm("关闭交易发送", `关闭后，AI 仍会分析行情，但不会再向 ${bridgePlatformLabel()} 发送新订单。`, { confirmText:"确认关闭", danger:true, detailRows })
    : await showConfirm("开启真实交易发送", `开启后，自动分析或人工复核可以向当前 ${bridgePlatformLabel()} 账户发送真实订单；每笔订单仍须通过服务器风控。`, { confirmText:"确认开启", danger:true, detailRows });
  if (!confirmed) return;

  try {
    await wsApi("toggle_trade", { enable: !currentlyEnabled });
    toast(currentlyEnabled ? "交易发送已关闭" : "交易发送已开启", "success");
    await loadStatus();
  } catch (e) {
    toast("交易发送状态切换失败：" + userVisibleText(apiErrorMessage(e.message), "请稍后重试"), "error");
  }
}

// ============ Automatic-analysis subscription settings entry ============
let _autoSubscriptionEntryLock = false;
async function handleAutoSubscriptionClick() {
  if (_autoSubscriptionEntryLock) return;
  if (isObserverMode()) { toast(observerMessage(), "warning"); return; }
  if (state.isPlusReadOnly) { toast("Plus 会员仅可查看", "warning"); return; }
  _autoSubscriptionEntryLock = true;
  try {
    await loadStrategyCatalog();
    const activeAccount = state.tradingAccounts?.find(account => Number(account.is_active) === 1)
      || state.tradingAccounts?.find(account => account.observe_status === "active")
      || state.tradingAccounts?.[0];
    const subscriptions = (state.strategySubscriptions || []).filter(item => Number(item.trading_account_id) === Number(activeAccount?.id));
    const runtimeStrategyId = Number(state.autoRuntime?.prompt_type_id || state.autoConfig?.prompt_type_id || 0);
    const subscription = subscriptions.find(item => Number(item.execution_enabled) === 1 && Number(item.strategy_id) === runtimeStrategyId)
      || subscriptions.find(item => Number(item.execution_enabled) === 1)
      || subscriptions.find(item => Number(item.strategy_id) === runtimeStrategyId)
      || subscriptions[0]
      || null;
    const strategyId = Number(subscription?.strategy_id || runtimeStrategyId || 0);
    const strategy = selectableSubscriptionStrategies().find(item => Number(item.id) === strategyId)
      || selectableSubscriptionStrategies()[0];
    if (!strategy) {
      setTab("model-strategy");
      setModelStrategySubtab("strategies");
      toast("还没有可用策略，请先创建或选择策略", "warning");
      return;
    }
    setTab("model-strategy", { skipRefresh:true });
    setModelStrategySubtab("strategies");
    openSubscriptionEditor(strategy, subscriptionForStrategyAccount(strategy.id, activeAccount?.id));
  } catch (error) {
    toast(`订阅设置加载失败：${userVisibleText(apiErrorMessage(error.message), "请稍后重试")}`, "error");
  } finally {
    _autoSubscriptionEntryLock = false;
  }
}

async function loadSymbols() {
  const data = await wsApi("symbols");
  state.symbols = Array.isArray(data.symbols) && data.symbols.length
    ? data.symbols
    : [{ name: "XAUUSD", description: "Gold vs US Dollar" }];

  const symbolNames = state.symbols.map(s => s.name);
  const globalSym = getGlobalSymbol();
  const preferred = state.symbols.find((symbol) => String(symbol.name).toUpperCase() === globalSym.toUpperCase())
    || state.symbols.find((symbol) => String(symbol.name).toUpperCase() === "XAUUSD")
    || state.symbols.find((symbol) => String(symbol.name).toUpperCase().startsWith("XAUUSD"))
    || state.symbols.find((symbol) => String(symbol.name).toUpperCase().includes("XAU"))
    || state.symbols[0];

  for (const id of ["quoteSymbolSelect", "tradeSymbolSelect"]) {
    createSymbolSelector(id, symbolNames);
  }

  // Set initial value
  // Initial dashboard loading owns the first quote and chart reads. Keep the
  // server-side stream symbol in sync here without duplicating those reads.
  if (preferred) setGlobalSymbol(preferred.name, { refreshData:false });
  updateManualStrategySelection();
  // Don't call refreshQuote here — tick stream handles it at 1s

}

async function loadAccount() {
  const data = await wsApi("account");
  const rawServer = data.server || data.company || "服务器 --";
  const server = isObserverMode() && typeof rawServer === "string" && rawServer.endsWith("Demo")
    ? `${rawServer.slice(0, -"Demo".length)}Live`
    : rawServer;
  const currency = data.currency || "USD";
  state.accountBalance = parseFloat(data.balance) || 0;
  if (typeof setHistoryAccountIdentity === "function") setHistoryAccountIdentity(data.server && data.login != null ? {
      platform:data.platform || state.bridgePlatform,
      brokerServerKey: String(data.server).trim().toUpperCase(),
      loginAccount: String(data.login).trim(),
    } : null);
  setText("mt5Server", server);
  setText("accountServerName", server);
  setText("accountBalance", fmt(data.balance));
  setText("accountEquity", fmt(data.equity));
  setText("accountFloatPnl", fmt(data.profit));
  setText("accountMargin", fmt(data.margin));
  setText("accountMarginFree", fmt(data.margin_free));
  setText("accountLeverage", data.leverage || "--");
  setText("accountCurrency", currency);
  for (const prefix of ["trade", "history"]) {
    setText(`${prefix}AccountServer`, server);
    setText(`${prefix}AccountBalance`, fmt(data.balance));
    setText(`${prefix}AccountEquity`, fmt(data.equity));
    setPnlValue(`${prefix}AccountProfit`, data.profit);
    setText(`${prefix}AccountFreeMargin`, fmt(data.margin_free));
  }
  document.querySelectorAll(".account-currency-unit").forEach((node) => {
    node.textContent = currency;
  });
  updatePnlStyle("accountFloatPnl", data.profit);
}

function updateTradingQuotePreview(quote) {
  if (!quote) return;
  setText("tradeBidPrice", priceDisplay(quote.bid));
  setText("tradeAskPrice", priceDisplay(quote.ask));
  setText("tradeSpread", Number.isFinite(Number(quote.spread)) ? fmt(quote.spread, 2) : "--");
  setText("buyBtnPrice", `ASK ${priceDisplay(quote.ask)}`);
  setText("sellBtnPrice", `BID ${priceDisplay(quote.bid)}`);
  validatePendingPrice();
}

const LIVE_QUOTE_REFRESH_INTERVAL_MS = 1000;
let _liveQuoteRefreshTimer = null;
let _liveQuoteRefreshInFlight = false;

function stopLiveQuoteRefreshTimer() {
  if (_liveQuoteRefreshTimer) {
    clearInterval(_liveQuoteRefreshTimer);
    _liveQuoteRefreshTimer = null;
  }
}

async function refreshLiveQuote(syncPlatformSource = false) {
  if (_liveQuoteRefreshInFlight
      || document.hidden
      || state._lastGatewayLive !== true
      || state.bridgeWs?.readyState !== WebSocket.OPEN) return;
  _liveQuoteRefreshInFlight = true;
  try {
    await refreshQuote({ syncPlatformSource });
  } catch {
    // A reconnect or terminal switch can invalidate one poll. The next tick
    // retries without surfacing a repeated toast to the user.
  } finally {
    _liveQuoteRefreshInFlight = false;
  }
}

function startLiveQuoteRefreshTimer() {
  stopLiveQuoteRefreshTimer();
  if (document.hidden
      || state._lastGatewayLive !== true
      || state.bridgeWs?.readyState !== WebSocket.OPEN
      || !state.symbols.length) return;
  const selectedSymbol = String($('quoteSymbolSelect')?.value || $('tradeSymbolSelect')?.value || getGlobalSymbol()).toUpperCase();
  const currentQuote = isObserverMode() ? state.lastObserverQuote : state.lastQuote;
  if (!currentQuote || String(currentQuote.symbol || '').toUpperCase() !== selectedSymbol) {
    void refreshLiveQuote(true);
  }
  if (isObserverMode()) return;
  _liveQuoteRefreshTimer = setInterval(() => {
    void refreshLiveQuote(false);
  }, LIVE_QUOTE_REFRESH_INTERVAL_MS);
}

async function syncDefaultPlatformQuote(symbol) {
  if (isObserverMode()) return null;
  const platformQuote = await wsApi("platform_quote", { symbol });
  state.platformMarketSourceActive = platformQuote.available === true;
  if (!state.platformMarketSourceActive) return platformQuote;
  if (platformQuote.online === false) {
    setText('quoteTime', '--');
    setText('mt5ServerTime', '--');
    updateMarketStatus(-2);
    return platformQuote;
  }
  if (Number.isFinite(Number(platformQuote.bid)) && Number.isFinite(Number(platformQuote.ask))) {
    renderPlatformMarketMeta(platformQuote);
    updateKlineTick(Number(platformQuote.bid), Number(platformQuote.ask), platformQuote);
  }
  return platformQuote;
}

async function refreshQuote({ syncPlatformSource = true } = {}) {
  const symbol = $("quoteSymbolSelect")?.value || $("tradeSymbolSelect")?.value || "XAUUSD";
  if (!symbol) return;
  if (syncPlatformSource) await syncDefaultPlatformQuote(symbol).catch(() => {});
  const data = await wsApi("quote", { symbol });
  const bid = Number(data.bid);
  const ask = Number(data.ask);
  const observer = isObserverMode();
  if (observer) state.platformMarketSourceActive = true;
  const quoteState = observer ? state.lastObserverQuote : state.lastQuote;
  const previousQuote = quoteState && quoteState.symbol === symbol ? quoteState : null;
  let bidDirection = "";
  let askDirection = "";

  if (previousQuote) {
    if (Number.isFinite(bid) && bid > previousQuote.bid) bidDirection = "up";
    if (Number.isFinite(bid) && bid < previousQuote.bid) bidDirection = "down";
    if (Number.isFinite(ask) && ask > previousQuote.ask) askDirection = "up";
    if (Number.isFinite(ask) && ask < previousQuote.ask) askDirection = "down";
  }

  setText("quoteBid", priceDisplay(data.bid));
  setText("quoteAsk", priceDisplay(data.ask));
  setText('quoteSpread', Number.isFinite(Number(data.spread)) ? fmt(data.spread, 2) : '--');
  if (observer || !state.platformMarketSourceActive) renderQuoteStatusMeta(data);
  setQuoteDirection("quoteBidDir", bidDirection);
  setQuoteDirection("quoteAskDir", askDirection);
  flashPrice("quoteBid", bidDirection);
  flashPrice("quoteAsk", askDirection);

  if (Number.isFinite(bid) && Number.isFinite(ask)) {
    setQuoteChangeUnavailable();
    const nextQuote = { symbol, bid, ask, spread: Number(data.spread), time:data.time };
    if (observer) state.lastObserverQuote = nextQuote;
    else state.lastQuote = nextQuote;
    updateTradingQuotePreview(nextQuote);
    if (observer || !state.platformMarketSourceActive) updateKlineTick(data.bid, data.ask, data);
  }
  updateSignalPriceFields(state.selectedSignal);
}

/* ---- K-line Chart ---- */
let _klineChart = null;
let _klineSeries = null;
let _klineVolumeSeries = null;
let _klineTimeframe = 'M5';
let _klineLastBar = null;
let _klineCandles = [];
let _klineDataKey = '';
let _klineRequestVersion = 0;
let _klineDataAvailable = false;
let _klinePositionSeries = [];
let _klinePositionTooltip = null;
const KLINE_POSITION_ENTRY_BUY_COLOR = '#ef4444';
const KLINE_POSITION_ENTRY_SELL_COLOR = '#10b981';
const KLINE_POSITION_HIT_RADIUS = 18;
let _klineVolRefreshTimer = null;
let _klineMutationObserver = null;
let _klineResizeObserver = null;
let _klineDeferredObserver = null;
let _klineVisibleRangeSyncing = false;

function mt5BrokerTimeSeconds(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  const parts = value.replace(' ', 'T').split(/[-T:]/).map(Number);
  if (parts.length < 3 || parts.slice(0, 3).some(item => !Number.isFinite(item))) return null;
  const seconds = Math.floor(Date.UTC(parts[0], parts[1] - 1, parts[2], parts[3] || 0, parts[4] || 0, parts[5] || 0) / 1000);
  return Number.isFinite(seconds) ? seconds : null;
}

function klinePositionTimeSeconds(position = {}) {
  const millisecondFields = [
    position.open_time_server_msc, position.entry_time_server_msc,
    position.time_server_msc, position.open_time_utc_msc,
    position.entry_time_utc_msc, position.time_utc_msc, position.time_msc,
  ];
  for (const value of millisecondFields) {
    const number = Number(value);
    if (Number.isFinite(number) && number > 0) return Math.floor(number / 1000);
  }
  for (const value of [position.time, position.open_time, position.entry_time]) {
    const number = Number(value);
    if (Number.isFinite(number) && number > 0) {
      return Math.floor(number > 1e12 ? number / 1000 : number);
    }
    const parsed = mt5BrokerTimeSeconds(value);
    if (parsed != null) return parsed;
  }
  return null;
}

function klineSymbolKey(value) {
  return String(value || '').trim().toUpperCase();
}

function klineSymbolStem(value) {
  return klineSymbolKey(value).split(/[._-]/, 1)[0];
}

function positionDirectionType(position = {}) {
  const value = String(position.type ?? position.direction ?? position.side ?? '').trim().toLowerCase();
  if (value === 'buy') return 'buy';
  if (value === 'sell') return 'sell';
  return '';
}

function klinePositionMatchesSymbol(position, symbol) {
  const positionSymbol = klineSymbolKey(position?.symbol);
  const chartSymbol = klineSymbolKey(symbol);
  if (!positionSymbol || !chartSymbol) return false;
  return positionSymbol === chartSymbol || klineSymbolStem(positionSymbol) === klineSymbolStem(chartSymbol);
}

function klinePositionPriceDigits(position = {}) {
  const digits = Number(position.digits);
  return Number.isFinite(digits) ? Math.min(Math.max(digits, 0), 6) : 2;
}

function clearKlinePositionEntries() {
  if (_klineChart) {
    for (const item of _klinePositionSeries) {
      try { _klineChart.removeSeries(item.series); } catch { /* chart already reset */ }
    }
  }
  _klinePositionSeries = [];
  if (_klinePositionTooltip) {
    _klinePositionTooltip.hidden = true;
    _klinePositionTooltip.setAttribute('aria-hidden', 'true');
  }
}

function klineRequestKey(symbol, timeframe = _klineTimeframe) {
  return `${String(symbol || '').trim().toUpperCase()}::${String(timeframe || '').trim().toUpperCase()}`;
}

function clearKlineData(status = '暂无行情', key = null) {
  _klineDataAvailable = false;
  _klineCandles = [];
  _klineLastBar = null;
  if (key != null) _klineDataKey = key;
  clearKlinePositionEntries();
  try { _klineSeries?.setData([]); } catch { /* chart may not be ready */ }
  try { _klineVolumeSeries?.setData([]); } catch { /* chart may not be ready */ }
  setText('klineLastPrice', '--');
  const sourceBadge = $('klineDataSource');
  if (sourceBadge) {
    sourceBadge.textContent = status;
    sourceBadge.dataset.state = status === '读取失败' ? 'error' : 'empty';
    sourceBadge.classList.remove('is-platform', 'is-fallback');
    sourceBadge.title = status;
  }
}

function klinePositionStartIndex(candles, entryTime) {
  if (!candles.length || !Number.isFinite(entryTime)) return { index:0, visible:false };
  if (entryTime < candles[0].time) return { index:0, visible:false };
  let low = 0, high = candles.length - 1;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (candles[middle].time <= entryTime) low = middle;
    else high = middle - 1;
  }
  const interval = { M1:60, M5:300, M15:900, M30:1800, H1:3600, H4:14400, D1:86400 }[_klineTimeframe] || 300;
  if (entryTime > candles.at(-1).time + interval) return { index:candles.length - 1, visible:false };
  return { index:low, visible:true };
}

function ensureKlinePositionTooltip() {
  const container = document.getElementById('klineChart');
  if (!container) return null;
  if (_klinePositionTooltip?.isConnected) return _klinePositionTooltip;
  _klinePositionTooltip = document.createElement('div');
  _klinePositionTooltip.className = 'kline-position-tooltip';
  _klinePositionTooltip.hidden = true;
  _klinePositionTooltip.setAttribute('aria-hidden', 'true');
  container.appendChild(_klinePositionTooltip);
  return _klinePositionTooltip;
}

function klinePositionEntryStructureKey(position, side, markerTime) {
  return JSON.stringify([
    String(position?.ticket ?? ''),
    klineSymbolKey(position?.symbol),
    side,
    Number(position?.price_open),
    Number.isFinite(Number(markerTime)) ? Number(markerTime) : null,
    klinePositionPriceDigits(position),
    _klineTimeframe,
  ]);
}

function buildKlinePositionDescriptors(symbol) {
  const positions = (state.positions || []).filter(position =>
    klinePositionMatchesSymbol(position, symbol)
      && Number.isFinite(Number(position.price_open))
      && Number(position.price_open) > 0
  );
  return positions.map(position => {
    const side = positionDirectionType(position);
    const entryTime = klinePositionTimeSeconds(position);
    const start = klinePositionStartIndex(_klineCandles, entryTime);
    const markerTime = start.visible ? _klineCandles[start.index].time : null;
    return {
      position,
      side,
      entryTime,
      start,
      markerTime,
      structureKey: side && Number.isFinite(Number(markerTime))
        ? klinePositionEntryStructureKey(position, side, markerTime)
        : null,
    };
  });
}

function syncKlinePositionEntries() {
  if (!_klineChart || !_klineSeries || !_klineCandles.length) {
    clearKlinePositionEntries();
    return;
  }
  const symbol = $('quoteSymbolSelect')?.value || $('tradeSymbolSelect')?.value || 'XAUUSD';
  const descriptors = buildKlinePositionDescriptors(symbol);
  const desiredKeys = descriptors.map(item => item.structureKey).filter(Boolean);
  const previousKeys = _klinePositionSeries.map(item => item.structureKey).filter(Boolean);
  const desiredKeyCounts = new Map();
  const previousKeyCounts = new Map();
  desiredKeys.forEach(key => desiredKeyCounts.set(key, (desiredKeyCounts.get(key) || 0) + 1));
  previousKeys.forEach(key => previousKeyCounts.set(key, (previousKeyCounts.get(key) || 0) + 1));
  const structureChanged = desiredKeys.length !== previousKeys.length
    || [...desiredKeyCounts].some(([key, count]) => previousKeyCounts.get(key) !== count);
  const previousByKey = new Map();
  for (const item of _klinePositionSeries) {
    if (!previousByKey.has(item.structureKey)) previousByKey.set(item.structureKey, []);
    previousByKey.get(item.structureKey).push(item);
  }
  const nextSeries = [];
  if (structureChanged) clearKlinePositionEntries();
  const markerSummary = [];
  const unknownDirectionSummary = [];
  for (const descriptor of descriptors) {
    const { position, start } = descriptor;
    const side = positionDirectionType(position);
    const direction = side === 'buy' ? '多仓' : side === 'sell' ? '空仓' : '方向未知';
    const price = Number(position.price_open);
    const summary = `${direction} ${volumeText(position.volume)}，入场价 ${fmt(price, klinePositionPriceDigits(position))}${start.visible ? '' : '，入场时间在当前图表范围外'}`;
    if (!side) {
      unknownDirectionSummary.push(`${summary}（未绘制标记）`);
      continue;
    }
    markerSummary.push(summary);
    if (!start.visible) continue;
    const markerTime = descriptor.markerTime;
    const structureKey = descriptor.structureKey;
    if (!structureChanged) {
      const existing = previousByKey.get(structureKey)?.shift();
      if (existing) {
        existing.position = position;
        existing.direction = direction;
        existing.side = side;
        existing.markerTime = markerTime;
        nextSeries.push(existing);
        continue;
      }
    }
    const markerColor = side === 'buy' ? KLINE_POSITION_ENTRY_BUY_COLOR : KLINE_POSITION_ENTRY_SELL_COLOR;
    const series = _klineChart.addLineSeries({
      color:markerColor,
      lineVisible:false,
      pointMarkersVisible:false,
      crosshairMarkerVisible:false,
      lastValueVisible:false,
      priceLineVisible:false,
      priceFormat:{ type:'price', precision:klinePositionPriceDigits(position), minMove:10 ** -klinePositionPriceDigits(position) },
    });
    series.setData([{ time:markerTime, value:price }]);
    series.setMarkers([{
      time:markerTime,
      position:side === 'buy' ? 'belowBar' : 'aboveBar',
      color:markerColor,
      shape:side === 'buy' ? 'arrowUp' : 'arrowDown',
      size:1.5,
    }]);
    nextSeries.push({ series, position, direction, side, markerTime, structureKey });
  }
  _klinePositionSeries = nextSeries;
  const container = document.getElementById('klineChart');
  if (container) {
    container.setAttribute('role', 'img');
    const descriptions = [];
    if (markerSummary.length) descriptions.push(`多仓使用红色向上箭头、空仓使用绿色向下箭头：${markerSummary.join('；')}`);
    if (unknownDirectionSummary.length) descriptions.push(`方向未知持仓未绘制入场标记：${unknownDirectionSummary.join('；')}`);
    container.setAttribute('aria-label', descriptions.length
      ? `K 线图；当前品种持仓入场点。${descriptions.join('。')}`
      : 'K 线图；当前品种没有持仓入场标记');
  }
  ensureKlinePositionTooltip();
}

function handleKlinePositionCrosshair(param) {
  const tooltip = ensureKlinePositionTooltip();
  const container = document.getElementById('klineChart');
  if (!tooltip || !container || !param?.point) return hideKlinePositionTooltip();
  const matches = _klinePositionSeries.filter(item => {
    const timeCoordinate = _klineChart?.timeScale().timeToCoordinate(item.markerTime);
    const priceCoordinate = item.series.priceToCoordinate(Number(item.position.price_open));
    return Number.isFinite(timeCoordinate) && Number.isFinite(priceCoordinate)
      && Math.abs(param.point.x - timeCoordinate) <= KLINE_POSITION_HIT_RADIUS
      && Math.abs(param.point.y - priceCoordinate) <= KLINE_POSITION_HIT_RADIUS;
  });
  if (!matches.length || param.point.x < 0 || param.point.y < 0
    || param.point.x > container.clientWidth || param.point.y > container.clientHeight) {
    return hideKlinePositionTooltip();
  }
  tooltip.innerHTML = matches.map(({ position, direction, side }) => {
    const buy = side === 'buy';
    const digits = klinePositionPriceDigits(position);
    return `<div class="kline-position-tooltip-row ${buy ? 'is-buy' : 'is-sell'}">
      <strong>${direction}</strong><span class="num">${escapeHtml(volumeText(position.volume))}</span>
      <small>入场 ${fmt(position.price_open, digits)} · #${escapeHtml(position.ticket || '--')}</small>
    </div>`;
  }).join('');
  tooltip.hidden = false;
  tooltip.setAttribute('aria-hidden', 'false');
  const preferLeft = param.point.x > container.clientWidth - 220;
  tooltip.style.left = `${Math.max(8, param.point.x + (preferLeft ? -8 : 12))}px`;
  tooltip.style.top = `${Math.max(8, Math.min(container.clientHeight - tooltip.offsetHeight - 8, param.point.y + 12))}px`;
  tooltip.style.transform = preferLeft ? 'translateX(-100%)' : 'none';
}

function hideKlinePositionTooltip() {
  if (!_klinePositionTooltip) return;
  _klinePositionTooltip.hidden = true;
  _klinePositionTooltip.setAttribute('aria-hidden', 'true');
}

function disconnectKlineObservers() {
  if (_klineDeferredObserver) { _klineDeferredObserver.disconnect(); _klineDeferredObserver = null; }
  if (_klineMutationObserver) { _klineMutationObserver.disconnect(); _klineMutationObserver = null; }
  if (_klineResizeObserver) { _klineResizeObserver.disconnect(); _klineResizeObserver = null; }
}

function getKlineVisibleLogicalRange() {
  try {
    const timeScale = _klineChart?.timeScale?.();
    return timeScale?.getVisibleLogicalRange?.() || null;
  } catch {
    return null;
  }
}

function normalizeKlineVisibleLogicalRange(range, total) {
  const count = Number(total);
  const from = Number(range?.from);
  const to = Number(range?.to);
  if (!Number.isFinite(count) || count < 1 || !Number.isFinite(from) || !Number.isFinite(to) || from > to) return null;
  const max = count - 1;
  const span = Math.max(0, to - from);
  if (span >= max) return { from:0, to:max };
  let nextFrom = from;
  let nextTo = to;
  if (nextFrom < 0) {
    nextTo = Math.min(max, nextTo - nextFrom);
    nextFrom = 0;
  }
  if (nextTo > max) {
    nextFrom = Math.max(0, nextFrom - (nextTo - max));
    nextTo = max;
  }
  return { from:nextFrom, to:nextTo };
}

function setKlineVisibleLogicalRange(range, total) {
  const next = normalizeKlineVisibleLogicalRange(range, total);
  if (!next || !_klineChart) return false;
  const current = getKlineVisibleLogicalRange();
  if (current && Math.abs(Number(current.from) - next.from) < 0.001
    && Math.abs(Number(current.to) - next.to) < 0.001) return false;
  _klineVisibleRangeSyncing = true;
  try {
    _klineChart.timeScale().setVisibleLogicalRange(next);
  } finally {
    _klineVisibleRangeSyncing = false;
  }
  return true;
}

function initKlineChart() {
  const container = document.getElementById('klineChart');
  if (!container) return;
  if (_klineChart) {
    disconnectKlineObservers();
    return;
  }

  // Defer chart creation if container is hidden (0 size)
  if (container.offsetWidth === 0 || container.offsetHeight === 0) {
    _klineDeferredObserver = new ResizeObserver(() => {
      if (container.offsetWidth > 0 && container.offsetHeight > 0) {
        _klineDeferredObserver.disconnect();
        _klineDeferredObserver = null;
        _createKlineChart(container);
      }
    });
    _klineDeferredObserver.observe(container);
    return;
  }
  _createKlineChart(container);
}

function _createKlineChart(container) {
  _klineChart = LightweightCharts.createChart(container, {
    width: container.clientWidth || 400,
    height: container.clientHeight || 220,
    layout: {
      background: { type: 'solid', color: 'transparent' },
      textColor: '#4a5568',
      fontSize: 10,
    },
    grid: {
      vertLines: { color: 'rgba(255,255,255,0.03)' },
      horzLines: { color: 'rgba(255,255,255,0.03)' },
    },
    crosshair: {
      mode: LightweightCharts.CrosshairMode.Normal,
      vertLine: { color: 'rgba(212,175,55,0.3)', width: 1, style: 2, labelBackgroundColor: '#1c2333' },
      horzLine: { color: 'rgba(212,175,55,0.3)', width: 1, style: 2, labelBackgroundColor: '#1c2333' },
    },
    rightPriceScale: {
      borderColor: 'rgba(255,255,255,0.06)',
      scaleMargins: { top: 0.1, bottom: 0.25 },
    },
    timeScale: {
      borderColor: 'rgba(255,255,255,0.06)',
      timeVisible: true,
      secondsVisible: false,
    },
    handleScroll: { vertTouchDrag: false },
    watermark: { visible: false, text: '', color: 'transparent' },
  });

  _klineSeries = _klineChart.addCandlestickSeries({
    upColor: '#ef4444',
    downColor: '#10b981',
    borderUpColor: '#ef4444',
    borderDownColor: '#10b981',
    wickUpColor: '#ef4444',
    wickDownColor: '#10b981',
  });

  _klineVolumeSeries = _klineChart.addHistogramSeries({
    priceFormat: { type: 'volume' },
    priceScaleId: 'volume',
  });
  _klineChart.priceScale('volume').applyOptions({
    scaleMargins: { top: 0.8, bottom: 0 },
  });
  _klineChart.subscribeCrosshairMove(handleKlinePositionCrosshair);

  // Remove TradingView attribution logo
  const tvLogo = container.querySelector('#tv-attr-logo') || container.querySelector('a[href*="tradingview"]');
  if (tvLogo) tvLogo.remove();
  // Also watch for late-inserted logo
  _klineMutationObserver = new MutationObserver(function(mutations) {
    mutations.forEach(function(m) {
      m.addedNodes.forEach(function(n) {
        if (n.tagName === 'A' && n.href && n.href.indexOf('tradingview') > -1) n.remove();
      });
    });
  });
  _klineMutationObserver.observe(container, { childList: true });

  // Responsive
  _klineResizeObserver = new ResizeObserver(() => {
    if (_klineChart && container.clientWidth > 0) {
      _klineChart.applyOptions({ width: container.clientWidth, height: container.clientHeight });
    }
  });
  _klineResizeObserver.observe(container);

  // Period buttons
  document.querySelectorAll('.kline-period-btn').forEach(btn => {
    btn.addEventListener('click', () => switchKlineTimeframe(btn.dataset.tf));
  });

  // Volume refresh only while the dashboard is visible.
  startKlineVolumeRefreshTimer();

  // Zoom limit: don't allow zooming out beyond all loaded data
  _klineChart.timeScale().subscribeVisibleLogicalRangeChange(range => {
    if (!range || _klineVisibleRangeSyncing) return;
    const total = _klineSeries.data().length;
    if (total < 2) return;
    const span = range.to - range.from;
    if (span < total) return;
    setKlineVisibleLogicalRange(range, total);
  });
}

async function loadKlineData() {
  if (document.hidden || activeTabId() !== 'dashboard') return;
  if (!_klineSeries) return; // Chart not initialized yet (e.g. admin on dashboard tab)
  const symbol = $("quoteSymbolSelect")?.value || $("tradeSymbolSelect")?.value || "XAUUSD";
  const timeframe = _klineTimeframe;
  const requestVersion = ++_klineRequestVersion;
  const requestKey = klineRequestKey(symbol, timeframe);
  const preserveVisibleRange = _klineDataAvailable && _klineDataKey === requestKey;
  const isCurrentRequest = () => requestVersion === _klineRequestVersion
    && requestKey === klineRequestKey(
      $("quoteSymbolSelect")?.value || $("tradeSymbolSelect")?.value || "XAUUSD",
      _klineTimeframe,
    );
  if (_klineDataKey !== requestKey) clearKlineData('暂无行情', requestKey);
  try {
    const data = await wsApi('rates', { symbol, timeframe, count: 200 });
    if (!isCurrentRequest()) return;
    if (!data || data.status !== 'success' || !Array.isArray(data.rates) || !data.rates.length) {
      clearKlineData(data?.status === 'success' ? '暂无行情' : '读取失败', requestKey);
      return;
    }
    const sourceBadge = $('klineDataSource');
    if (sourceBadge) {
      const meta = data.market_meta || {};
      const offset = Number.isFinite(Number(meta.timezone_offset_minutes))
        ? `UTC${Number(meta.timezone_offset_minutes) >= 0 ? '+' : ''}${Number(meta.timezone_offset_minutes) / 60}` : '时区待校验';
      const platform = String(meta.source || '').startsWith('platform_');
      state.platformMarketSourceActive = platform;
      sourceBadge.textContent = `${platform ? '平台行情' : '本人行情'} · ${offset}`;
      sourceBadge.classList.toggle('is-platform', platform);
      sourceBadge.classList.toggle('is-fallback', !platform);
      sourceBadge.title = `品种：${meta.broker_symbol || symbol}；时钟：${meta.clock_status || 'unknown'}；当前 K 线实时获取，不写入缓存`;
    }

    const cleanRows = new Map();
    for (const row of data.rates) {
      const time = mt5BrokerTimeSeconds(row?.time);
      const open = Number(row?.open), high = Number(row?.high), low = Number(row?.low), close = Number(row?.close);
      if (!Number.isFinite(time) || ![open, high, low, close].every(Number.isFinite)) continue;
      if (open <= 0 || high <= 0 || low <= 0 || close <= 0 || high < low) continue;
      cleanRows.set(time, { row, candle: { time, open, high, low, close } });
    }
    const normalized = [...cleanRows.values()].sort((a, b) => a.candle.time - b.candle.time);
    const candles = normalized.map(item => item.candle);
    if (!candles.length) {
      clearKlineData('暂无行情', requestKey);
      return;
    }
    const volumes = normalized.map(({ row, candle }) => ({
      time: candle.time,
      value: Math.max(0, Number(row.tick_volume || row.volume || 0) || 0),
      color: candle.close >= candle.open ? 'rgba(239,68,68,0.3)' : 'rgba(16,185,129,0.3)',
    }));

    const previousRange = preserveVisibleRange ? getKlineVisibleLogicalRange() : null;
    _klineSeries.setData(candles);
    _klineVolumeSeries.setData(volumes);
    _klineCandles = candles;
    _klineLastBar = candles[candles.length - 1];
    _klineDataKey = requestKey;
    _klineDataAvailable = true;
    if (sourceBadge) sourceBadge.dataset.state = 'ready';
    syncKlinePositionEntries();

    // Update last price display
    setText('klineLastPrice', candles.at(-1).close.toFixed(2));

    if (preserveVisibleRange && previousRange) setKlineVisibleLogicalRange(previousRange, candles.length);
    else _klineChart.timeScale().fitContent();
  } catch (e) {
    if (!isCurrentRequest()) return;
    clearKlineData('读取失败', requestKey);
    const bridgeUnavailable = state._lastGatewayLive !== true;
    if (!bridgeUnavailable && !String(e.message || '').includes('WebSocket') && !String(e.message || '').includes('未连接')) {
      console.error('loadKlineData:', e);
    }
  }
}

// Lightweight: fetch only the last bar's volume while the dashboard is visible.
async function refreshKlineVolume() {
  if (document.hidden || activeTabId() !== 'dashboard') return;
  if (state.marketTradeMode === 0 || !_klineVolumeSeries || !_klineLastBar) return;
  const symbol = $("quoteSymbolSelect")?.value || $("tradeSymbolSelect")?.value || "XAUUSD";
  const timeframe = _klineTimeframe;
  const requestVersion = _klineRequestVersion;
  const requestKey = klineRequestKey(symbol, timeframe);
  try {
    const data = await wsApi('rates', { symbol, timeframe, count: 1 });
    if (requestVersion !== _klineRequestVersion || requestKey !== _klineDataKey
      || requestKey !== klineRequestKey(
        $("quoteSymbolSelect")?.value || $("tradeSymbolSelect")?.value || "XAUUSD",
        _klineTimeframe,
      )) return;
    if (!data || data.status !== 'success' || !Array.isArray(data.rates) || !data.rates.length) {
      clearKlineData(data?.status === 'success' ? '暂无行情' : '读取失败', requestKey);
      return;
    }
    const b = data.rates.at(-1);
    const open = Number(b?.open), high = Number(b?.high), low = Number(b?.low), close = Number(b?.close);
    if (![open, high, low, close].every(Number.isFinite) || open <= 0 || high <= 0 || low <= 0 || close <= 0 || high < low) {
      clearKlineData('暂无行情', requestKey);
      return;
    }
    const barTime = mt5BrokerTimeSeconds(b?.time);
    if (!Number.isFinite(barTime) || !Number.isFinite(Number(_klineLastBar.time))
      || barTime !== Number(_klineLastBar.time)) return;
    const vol = Math.max(0, Number(b.tick_volume || b.volume || 0) || 0);
    const color = close >= open ? 'rgba(239,68,68,0.3)' : 'rgba(16,185,129,0.3)';
    _klineVolumeSeries.update({ time: barTime, value: vol, color: color });
  } catch (e) {
    if (requestVersion === _klineRequestVersion && requestKey === _klineDataKey) clearKlineData('读取失败', requestKey);
  }
}

function updateKlineTick(bid, ask, quote = {}) {
  if (!_klineSeries || !_klineDataAvailable || state.marketTradeMode === 0) return;
  const price = Number(bid);
  if (!Number.isFinite(price) || price <= 0) return;
  // Always anchor the live candle to the broker quote timestamp. During a
  // closed market the last quote is stale; using the browser clock would create
  // synthetic weekend candles that never existed in MT5.
  const quoteMt5Sec = mt5BrokerTimeSeconds(formatTerminalQuoteTime(quote));
  if (!Number.isFinite(quoteMt5Sec)) return;
  const tfSeconds = { M1: 60, M5: 300, M15: 900, M30: 1800, H1: 3600, H4: 14400, D1: 86400 }[_klineTimeframe] || 300;
  const barTime = Math.floor(quoteMt5Sec / tfSeconds) * tfSeconds;

  if (!_klineLastBar) {
    _klineLastBar = { time: barTime, open: price, high: price, low: price, close: price };
    _klineSeries.setData([_klineLastBar]);
  } else if (barTime === _klineLastBar.time) {
    _klineLastBar.close = price;
    if (price > _klineLastBar.high) _klineLastBar.high = price;
    if (price < _klineLastBar.low) _klineLastBar.low = price;
    _klineSeries.update(_klineLastBar);
  } else if (barTime > _klineLastBar.time) {
    _klineLastBar = { time: barTime, open: price, high: price, low: price, close: price };
    _klineSeries.update(_klineLastBar);
    // New bar: refresh historical data for correct volume
    setTimeout(loadKlineData, 500);
  }

  setText('klineLastPrice', Number(bid).toFixed(2));
}

// Periodic refresh for higher timeframes (H4/D1 don't change on every M5 bar)
let _klineRefreshTimer = null;
function stopKlineRefreshTimers() {
  if (_klineRefreshTimer) {
    clearInterval(_klineRefreshTimer);
    _klineRefreshTimer = null;
  }
  if (_klineVolRefreshTimer) {
    clearInterval(_klineVolRefreshTimer);
    _klineVolRefreshTimer = null;
  }
}

function isTransientSymbolLoadError(error) {
  const message = String(error?.code || error?.message || error || '').toLowerCase();
  return [
    'symbol_unavailable',
    'bridge_terminal_initializing',
    'bridge_terminal_initial_sync_pending',
    'terminal_data_action_unavailable',
  ].some(code => message.includes(code));
}

async function loadSymbolsWhenReady({ attempts = 4, baseDelayMs = 300 } = {}) {
  let lastError = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await loadSymbols();
    } catch (error) {
      lastError = error;
      const shouldRetry = state._lastGatewayLive === true
        && isTransientSymbolLoadError(error)
        && attempt < attempts;
      if (!shouldRetry) throw error;
      await new Promise(resolve => setTimeout(resolve, baseDelayMs * attempt));
    }
  }
  throw lastError;
}

function startKlineVolumeRefreshTimer() {
  if (_klineVolRefreshTimer) clearInterval(_klineVolRefreshTimer);
  _klineVolRefreshTimer = null;
  if (document.hidden || activeTabId() !== 'dashboard') return;
  _klineVolRefreshTimer = setInterval(refreshKlineVolume, 5000);
}

function startKlineRefreshTimer() {
  if (_klineRefreshTimer) clearInterval(_klineRefreshTimer);
  _klineRefreshTimer = null;
  if (document.hidden || activeTabId() !== 'dashboard') return;
  const intervalMs = { M1: 30000, M5: 30000, M15: 60000, M30: 60000, H1: 120000, H4: 300000, D1: 600000 }[_klineTimeframe] || 60000;
  _klineRefreshTimer = setInterval(() => { loadKlineData().catch(() => {}); }, intervalMs);
}

// Period button click → reload K-line data
function switchKlineTimeframe(tf) {
  _klineTimeframe = tf;
  document.querySelectorAll('.kline-period-btn').forEach(function(b) {
    b.classList.toggle('active', b.dataset.tf === tf);
  });
  loadKlineData();
  startKlineRefreshTimer();
}

const POSITION_COLUMN_COUNT = 11;

function renderPositionRows(positions = []) {
  if (!positions.length) {
    return `<tr class="empty-row"><td colspan="${POSITION_COLUMN_COUNT}">当前无持仓</td></tr>`;
  }
  const tickets = state.signalTickets || {};
  return positions.map((position) => {
    const side = positionDirectionType(position);
    const directionLabel = side === "buy" ? "买入 多" : side === "sell" ? "卖出 空" : "方向未知";
    const directionClass = side === "buy" ? "dir-buy" : side === "sell" ? "dir-sell" : "dir-unknown";
    const priceDigits = positionPriceDigits(position);
    return `
      <tr data-ticket="${escapeHtml(position.ticket)}">
        ${ticketCell(position.ticket, tickets)}
        <td data-label="品种">${escapeHtml(position.symbol)}</td>
        <td data-label="方向"><span class="${directionClass}">${directionLabel}</span></td>
        <td data-label="手数" class="num">${escapeHtml(volumeText(position.volume))}</td>
        <td data-label="开仓价" class="num">${fmt(position.price_open, priceDigits)}</td>
        <td data-label="现价" data-position-live="price" class="num">${fmt(position.price_current, priceDigits)}</td>
        <td data-label="开仓时间" class="num">${escapeHtml(formatTime(position.time))}</td>
        <td data-label="止损" class="num">${Number(position.sl) ? fmt(position.sl, priceDigits) : "--"}</td>
        <td data-label="止盈" class="num">${Number(position.tp) ? fmt(position.tp, priceDigits) : "--"}</td>
        <td data-label="盈亏" data-position-live="profit" class="num ${profitClass(position.profit)}">${fmt(position.profit)}</td>
        <td data-label="操作" class="position-row-actions-cell">
          ${state.user?.role === "admin" && Number(position.magic) === 234000 ? `<button class="btn small position-protection-edit" type="button" data-edit-protection-ticket="${escapeHtml(position.ticket)}"><i data-lucide="pencil" size="13"></i>编辑保护</button>` : ""}
          <button class="btn small" type="button" data-close-ticket="${escapeHtml(position.ticket)}"><i data-lucide="x" size="12"></i>平仓</button>
        </td>
      </tr>
    `;
  }).join("");
}

function positionPriceDigits(position = {}) {
  const digits = Number(position.digits);
  return Number.isFinite(digits) ? Math.min(Math.max(digits, 0), 6) : 2;
}

function positionStructureSignature(position = {}) {
  return JSON.stringify([
    String(position.ticket ?? ""), String(position.symbol ?? ""), String(position.type ?? "").toLowerCase(),
    Number(position.volume), Number(position.price_open), String(position.time ?? ""),
    Number(position.sl), Number(position.tp), Number(position.magic), positionPriceDigits(position),
  ]);
}

function positionStructureMatches(current = [], next = []) {
  return current.length === next.length
    && current.every((position, index) => positionStructureSignature(position) === positionStructureSignature(next[index]));
}

function patchPositionLiveCells(positions = []) {
  const bodies = [$('positionsBody'), $('dashboardPositionsBody')].filter(Boolean);
  if (!bodies.length) return false;
  const rowMaps = bodies.map(body => new Map(
    [...body.querySelectorAll('tr[data-ticket]')].map(row => [String(row.dataset.ticket), row])
  ));
  if (rowMaps.some(rows => rows.size !== positions.length)) return false;
  for (const position of positions) {
    const ticket = String(position.ticket);
    const price = fmt(position.price_current, positionPriceDigits(position));
    const profit = fmt(position.profit);
    const profitClassName = `num ${profitClass(position.profit)}`;
    for (const rows of rowMaps) {
      const row = rows.get(ticket);
      const priceCell = row?.querySelector('[data-position-live="price"]');
      const profitCell = row?.querySelector('[data-position-live="profit"]');
      if (!priceCell || !profitCell) return false;
      if (priceCell.textContent !== price) priceCell.textContent = price;
      if (profitCell.textContent !== profit) profitCell.textContent = profit;
      if (profitCell.className !== profitClassName) profitCell.className = profitClassName;
    }
  }
  return true;
}

function renderPositionTables(positions = [], { liveOnly = false } = {}) {
  const patched = liveOnly && positionStructureMatches(state.positions || [], positions)
    && patchPositionLiveCells(positions);
  state.positions = positions;
  syncKlinePositionEntries();
  $('positionsEmpty').classList.toggle('hidden', positions.length > 0);
  $('dashboardPositionsTable').classList.toggle('hidden', positions.length === 0);
  if (patched) return 'live';
  $('positionsBody').innerHTML = renderPositionRows(positions);
  $('dashboardPositionsBody').innerHTML = renderPositionRows(positions);
  initIcons();
  return 'full';
}

function historyTicketMapKey(kind, historyRevision = _lastHistoryRevision) {
  return `${kind}|${Number(state._accountContextGeneration || 0)}|${historyRevision == null ? "live" : Number(historyRevision)}`;
}

async function loadHistoryTicketMap(kind, { historyRevision = _lastHistoryRevision, forceRefresh = false } = {}) {
  const key = historyTicketMapKey(kind, historyRevision);
  if (!forceRefresh && _historyTicketMapCache.has(key)) {
    const tickets = _historyTicketMapCache.get(key);
    if (kind === "signal") state.signalTickets = tickets;
    else state.closeSignalTickets = tickets;
    return tickets;
  }
  if (!forceRefresh && _historyTicketMapFlights.has(key)) return _historyTicketMapFlights.get(key);
  const action = kind === "signal" ? "signal_tickets" : "close_signal_tickets";
  const run = wsApi(action).then(data => {
    const tickets = data.tickets || {};
    _historyTicketMapCache.set(key, tickets);
    if (kind === "signal") state.signalTickets = tickets;
    else state.closeSignalTickets = tickets;
    return tickets;
  }).catch(() => {
    const empty = {};
    if (kind === "signal") state.signalTickets = empty;
    else state.closeSignalTickets = empty;
    return empty;
  }).finally(() => { if (_historyTicketMapFlights.get(key) === run) _historyTicketMapFlights.delete(key); });
  _historyTicketMapFlights.set(key, run);
  return run;
}

async function loadSignalTickets(options = {}) {
  return loadHistoryTicketMap("signal", options);
}

async function loadCloseSignalTickets(options = {}) {
  return loadHistoryTicketMap("close", options);
}

function ticketCell(ticket, signalTickets) {
  const signalId = signalTickets[String(ticket)];
  if (signalId) {
    return `<td data-label="票号" class="num"><a href="#" class="signal-link" onclick="event.preventDefault(); openAnalysisFromHistory(${signalId}, { source:'history', forcePinned:true })">${escapeHtml(ticket)}</a></td>`;
  }
  return `<td data-label="票号" class="num">${escapeHtml(ticket)}</td>`;
}

async function loadPositions({ refreshSignalTickets = true, liveOnly = false } = {}) {
  const requests = [wsApi("positions", {})];
  if (refreshSignalTickets) requests.push(loadSignalTickets());
  const [data] = await Promise.all(requests);
  const positions = data.positions || [];
  renderPositionTables(positions, { liveOnly });
}

/* ---- Sidebar 观摩提示 ---- */
function showSidebarObserveHint(html) {
  const hint = $("sidebarObserveHint");
  const text = $("sidebarObserveHintText");
  if (!hint || !text) return;
  hint.classList.remove("hidden");
  text.innerHTML = html;
}

function hideSidebarObserveHint() {
  const hint = $("sidebarObserveHint");
  if (hint) hint.classList.add("hidden");
}

function observerChannelStorageKey() {
  return `ai_observer_channel_${state.user?.id || 'guest'}`;
}

function syncSelectedObserverChannel(channelId) {
  const normalizedId = Number(channelId) || null;
  if (!normalizedId) return;
  state.selectedObserverChannelId = normalizedId;
  localStorage.setItem(observerChannelStorageKey(), String(normalizedId));
  renderObserverChannelControl();
}

function setObserverChannelMenuOpen(open, { focusSelected = false } = {}) {
  const trigger = $("observerChannelTrigger");
  const menu = $("observerChannelMenu");
  if (!trigger || !menu) return;
  const shouldOpen = Boolean(open) && !$("observerChannelControl")?.classList.contains("hidden");
  trigger.setAttribute("aria-expanded", String(shouldOpen));
  menu.classList.toggle("hidden", !shouldOpen);
  if (shouldOpen && focusSelected) {
    requestAnimationFrame(() => (menu.querySelector('[aria-selected="true"]') || menu.querySelector('[role="option"]'))?.focus());
  }
}

function renderObserverChannelControl() {
  const control = $("observerChannelControl");
  const current = $("observerChannelCurrent");
  const menu = $("observerChannelMenu");
  const trigger = $("observerChannelTrigger");
  if (!control || !current || !menu || !trigger) return;
  const channels = state.observerChannels || [];
  const visible = isObserverMode() && channels.length >= 2;
  control.classList.toggle("hidden", !visible);
  if (!visible) {
    setObserverChannelMenuOpen(false);
    return;
  }
  const selected = channels.find(channel => Number(channel.id) === Number(state.selectedObserverChannelId)) || channels[0];
  current.textContent = selected?.name || "选择频道";
  trigger.title = selected ? `当前观摩频道：${selected.name}` : "选择观摩频道";
  menu.innerHTML = channels.map(channel => {
    const selectedChannel = Number(channel.id) === Number(selected?.id);
    const online = Boolean(channel.online);
    return `<button type="button" class="observer-channel-option${selectedChannel ? ' is-selected' : ''}" role="option" aria-selected="${selectedChannel}" data-observer-channel-id="${Number(channel.id)}">
      <span class="observer-channel-option-status ${online ? 'is-online' : 'is-offline'}" aria-hidden="true"></span>
      <span class="observer-channel-option-copy"><strong>${escapeHtml(channel.name)}</strong><small>${online ? '在线，可正常观摩' : '离线，暂时无法更新'}</small></span>
      <i class="observer-channel-option-check" data-lucide="check" size="16" aria-hidden="true"></i>
    </button>`;
  }).join('');
  initIcons();
}

const POSITION_PROTECTION_TERMINAL_STATES = new Set(["completed", "partial_failed", "failed"]);
const ADMIN_STRATEGY_CLOSE_TERMINAL_STATES = new Set(["completed", "partial", "partial_failed", "failed", "cancelled", "canceled"]);
const ADMIN_STRATEGY_CLOSE_STATUS_LABELS = {
  queued: "等待执行",
  previewed: "已预览",
  running: "正在平仓",
  reconciling: "等待对账",
  uncertain: "待确认",
  completed: "全部完成",
  partial: "部分完成",
  partial_failed: "部分失败",
  failed: "执行失败",
  cancelled: "已取消",
  canceled: "已取消",
};

function adminStrategyCloseRoot(data = {}) {
  if (!data || typeof data !== "object") return {};
  if (data.__adminStrategyCloseNormalized) return data;
  const candidates = [
    data.preview,
    data.close_preview,
    data.position_close_preview,
    data.data?.preview,
    data.data?.close_preview,
    data.result?.preview,
    data,
  ];
  const selected = candidates.find(item => item && typeof item === "object" && !Array.isArray(item)) || {};
  if (selected === data) return selected;
  const normalized = { ...data, ...selected };
  Object.defineProperty(normalized, "__adminStrategyCloseNormalized", { value:true });
  return normalized;
}

function adminStrategyCloseJobRoot(data = {}) {
  if (!data || typeof data !== "object") return {};
  if (data.__adminStrategyCloseNormalized) return data;
  const candidates = [
    data.job,
    data.close_job,
    data.position_close_job,
    data.dispatch,
    data.data?.job,
    data.result?.job,
    data,
  ];
  const selected = candidates.find(item => item && typeof item === "object" && !Array.isArray(item)) || {};
  if (selected === data) return selected;
  const normalized = { ...data, ...selected };
  Object.defineProperty(normalized, "__adminStrategyCloseNormalized", { value:true });
  return normalized;
}

function adminStrategyCloseValue(root, keys = []) {
  for (const key of keys) {
    if (root && root[key] !== undefined && root[key] !== null) return root[key];
  }
  return undefined;
}

function adminStrategyCloseBoolean(value) {
  if (value === true || value === 1) return true;
  if (typeof value !== "string") return false;
  return ["true", "1", "yes", "confirmed", "unique", "eligible", "allowed"].includes(value.trim().toLowerCase());
}

function adminStrategyCloseDispatchMarker(value) {
  if (typeof value === "string") return value.trim().toLowerCase() === "admin_strategy_dispatch";
  if (!value || typeof value !== "object") return false;
  return [
    value.source,
    value.source_type,
    value.source_kind,
    value.origin,
    value.signal_source,
    value.attribution_source,
    value.dispatch_source,
    value.type,
    value.kind,
    value.source_name,
    value.strategy_source,
  ].some(adminStrategyCloseDispatchMarker);
}

function adminStrategyCloseAttribution(preview = {}) {
  const root = adminStrategyCloseRoot(preview);
  const candidates = [
    root,
    root.source,
    root.source_attribution,
    root.attribution,
    root.linked_source,
    root.linked_dispatch,
    root.dispatch,
    root.strategy_dispatch,
    root.admin_strategy_dispatch,
    root.signal,
  ];
  if (!candidates.some(adminStrategyCloseDispatchMarker)) return false;
  const uniqueKeys = [
    "unique_attribution", "uniqueAttribution", "unique_source_attribution", "uniqueSourceAttribution", "unique_source", "uniqueSource", "is_unique", "isUnique",
    "unique", "source_unique", "sourceUnique", "source_is_unique", "sourceIsUnique", "linked_admin_strategy_dispatch", "linkedAdminStrategyDispatch",
    "can_close_linked_dispatch", "canCloseLinkedDispatch", "linked_close_available", "linkedCloseAvailable", "close_available", "closeAvailable", "can_close", "canClose",
    "eligible", "is_eligible", "isEligible", "allowed",
  ];
  const uniqueOnlyKeys = ["unique_attribution", "uniqueAttribution", "unique_source_attribution", "uniqueSourceAttribution", "unique_source", "uniqueSource", "is_unique", "isUnique", "unique", "source_unique", "sourceUnique", "source_is_unique", "sourceIsUnique"];
  if (candidates.some(item => item && typeof item === "object" && uniqueOnlyKeys.some(key => item[key] === false || item[key] === 0 || String(item[key]).toLowerCase() === "false"))) return false;
  if (candidates.some(item => item && typeof item === "object" && uniqueKeys.some(key => adminStrategyCloseBoolean(item[key])))) return true;
  const scope = candidates
    .map(item => item && typeof item === "object" ? adminStrategyCloseValue(item, ["close_scope", "closeScope", "attribution_scope", "attributionScope", "source_scope", "sourceScope"]) : item)
    .find(Boolean);
  if (typeof scope === "string" && ["admin_strategy_dispatch", "unique_admin_strategy_dispatch"].includes(scope.trim().toLowerCase())) return true;
  return false;
}

function adminStrategyCloseEligible(preview = {}) {
  const root = adminStrategyCloseRoot(preview);
  if (!adminStrategyCloseAttribution(root)) return false;
  const explicitFalse = [
    "can_close", "canClose", "close_available", "closeAvailable", "linked_close_available", "linkedCloseAvailable", "eligible", "is_eligible", "isEligible", "allowed",
  ].some(key => root[key] === false || root[key] === 0 || String(root[key]).toLowerCase() === "false");
  return !explicitFalse;
}

function adminStrategyClosePreviewHash(preview = {}) {
  const root = adminStrategyCloseRoot(preview);
  return adminStrategyCloseValue(root, ["preview_hash", "previewHash", "hash"]) || "";
}

function adminStrategyCloseTargets(data = {}) {
  const root = adminStrategyCloseRoot(data);
  const candidates = [root.targets, root.positions, root.target_positions, root.close_targets, root.results, root.target_progress, root.target_results, root.data?.targets];
  return candidates.find(Array.isArray) || [];
}

function adminStrategyCloseJobTargets(job = {}) {
  const root = adminStrategyCloseJobRoot(job);
  const candidates = [root.targets, root.positions, root.target_positions, root.close_targets, root.results, root.target_progress, root.target_results, root.data?.targets];
  return candidates.find(Array.isArray) || [];
}

function adminStrategyCloseTargetStatus(target = {}) {
  const nestedResult = target.result && typeof target.result === "object" ? target.result : (target.outcome && typeof target.outcome === "object" ? target.outcome : null);
  const value = String(adminStrategyCloseValue(target, ["status", "state", "target_status", "targetStatus"]) || adminStrategyCloseValue(nestedResult, ["status", "state", "outcome"]) || target.result || target.outcome || "queued").trim().toLowerCase();
  if (["success", "succeeded", "completed", "closed", "done"].includes(value)) return "succeeded";
  if (["failed", "error", "rejected"].includes(value)) return "failed";
  if (["skipped", "excluded", "not_applicable"].includes(value)) return "skipped";
  if (["uncertain", "unknown", "timeout", "timed_out"].includes(value)) return "uncertain";
  if (["reconciling", "reconcile", "pending_reconciliation"].includes(value)) return "reconciling";
  if (["running", "closing", "processing"].includes(value)) return "running";
  return "queued";
}

function adminStrategyCloseTargetStatusLabel(value) {
  return ({ succeeded:"成功", failed:"失败", skipped:"跳过", uncertain:"待确认", reconciling:"对账中", running:"执行中", queued:"等待" })[value] || "等待";
}

function adminStrategyCloseTargetReason(target = {}) {
  const nestedResult = target.result && typeof target.result === "object" ? target.result : (target.outcome && typeof target.outcome === "object" ? target.outcome : null);
  return adminStrategyCloseValue(target, ["reason", "error_message", "message", "error", "skip_reason", "exclusion_reason"])
    || adminStrategyCloseValue(nestedResult, ["reason", "error_message", "message", "error"])
    || "";
}

function adminStrategyCloseTargetIsSource(target = {}) {
  const role = String(adminStrategyCloseValue(target, ["target_role", "role", "target_type"]) || "").toLowerCase();
  return Boolean(target.is_source === true || target.is_source === 1 || ["source", "admin", "admin_source", "administrator", "admin_source_account", "source_account"].includes(role));
}

function adminStrategyCloseCounter(root, keys, fallback = 0) {
  const value = adminStrategyCloseValue(root, keys);
  return Number.isFinite(Number(value)) ? Number(value) : fallback;
}

function adminStrategyCloseCounters(data = {}) {
  const root = adminStrategyCloseRoot(data);
  const counters = root.counters || root.summary || root.counts || {};
  const targets = adminStrategyCloseTargets(root);
  const subscriberTargets = targets.filter(target => !adminStrategyCloseTargetIsSource(target));
  const statuses = targets.map(adminStrategyCloseTargetStatus);
  const count = (status) => statuses.filter(item => item === status).length;
  const inferredSubscriberUsers = new Set(subscriberTargets.map(target => target.user_id).filter(value => value != null)).size;
  const subscriberUsers = adminStrategyCloseCounter(root, ["subscriber_users", "subscriber_total", "affected_users", "user_count"], adminStrategyCloseCounter(counters, ["subscriber_users", "subscriber_total", "affected_users", "user_count"], inferredSubscriberUsers));
  const affectedPositions = adminStrategyCloseCounter(root, ["subscriber_positions", "affected_positions", "position_count", "total_positions"], adminStrategyCloseCounter(counters, ["subscriber_positions", "affected_positions", "position_count", "total_positions"], subscriberTargets.length));
  const excluded = Array.isArray(root.exclusions) ? root.exclusions.length : Array.isArray(root.excluded) ? root.excluded.length : adminStrategyCloseCounter(root, ["excluded", "excluded_count", "exclusion_count"], adminStrategyCloseCounter(counters, ["excluded", "excluded_count", "exclusion_count"], 0));
  return {
    subscriberUsers,
    affectedPositions,
    excluded,
    succeeded: adminStrategyCloseCounter(root, ["succeeded", "succeeded_positions", "success", "success_count"], adminStrategyCloseCounter(counters, ["succeeded", "succeeded_positions", "success", "success_count"], count("succeeded"))),
    failed: adminStrategyCloseCounter(root, ["failed", "failed_positions", "failure", "failure_count"], adminStrategyCloseCounter(counters, ["failed", "failed_positions", "failure", "failure_count"], count("failed"))),
    skipped: adminStrategyCloseCounter(root, ["skipped", "skipped_positions", "skip", "skipped_count"], adminStrategyCloseCounter(counters, ["skipped", "skipped_positions", "skip", "skipped_count"], count("skipped"))),
    uncertain: adminStrategyCloseCounter(root, ["uncertain", "uncertain_positions", "uncertain_count"], adminStrategyCloseCounter(counters, ["uncertain", "uncertain_positions", "uncertain_count"], count("uncertain") + count("reconciling"))),
    reconciling: adminStrategyCloseCounter(root, ["reconciling", "reconciling_positions", "reconciling_count"], adminStrategyCloseCounter(counters, ["reconciling", "reconciling_positions", "reconciling_count"], count("reconciling"))),
  };
}

function adminStrategyCloseStatus(job = {}) {
  const root = adminStrategyCloseJobRoot(job);
  return String(adminStrategyCloseValue(root, ["status", "phase", "job_status", "jobStatus", "close_status", "closeStatus"]) || "queued").trim().toLowerCase();
}

function adminStrategyCloseStatusLabel(value) {
  return ADMIN_STRATEGY_CLOSE_STATUS_LABELS[String(value || "").toLowerCase()] || "处理中";
}

function adminStrategyCloseOrderedTargets(targets = []) {
  return [...targets].sort((left, right) => Number(adminStrategyCloseTargetIsSource(left)) - Number(adminStrategyCloseTargetIsSource(right)));
}

function stopAdminStrategyClosePolling() {
  if (state.adminStrategyClosePollTimer) clearTimeout(state.adminStrategyClosePollTimer);
  state.adminStrategyClosePollTimer = null;
  state.adminStrategyClosePollGeneration += 1;
}

function resetAdminStrategyCloseState() {
  stopAdminStrategyClosePolling();
  state.adminStrategyClosePreview = null;
  state.adminStrategyClosePreviewTicket = null;
  state.adminStrategyClosePreviewRequestVersion += 1;
  state.adminStrategyCloseJob = null;
  state.adminStrategyCloseSubmitting = false;
  const section = $("adminStrategyCloseSection");
  section?.classList.add("hidden");
  $("adminStrategyCloseProgressStage")?.classList.add("hidden");
  $("adminStrategyCloseError")?.classList.add("hidden");
  $("adminStrategyCloseProgressError")?.replaceChildren();
  const reason = $("adminStrategyCloseReason");
  if (reason) {
    reason.value = "";
    reason.setAttribute("aria-invalid", "false");
  }
  const confirm = $("adminStrategyCloseConfirm");
  if (confirm) confirm.checked = false;
  const count = $("adminStrategyCloseReasonCount");
  if (count) count.textContent = "0";
  const reasonError = $("adminStrategyCloseReasonError");
  if (reasonError) {
    reasonError.textContent = "";
    reasonError.classList.add("hidden");
  }
  const submit = $("adminStrategyCloseSubmit");
  if (submit) {
    submit.disabled = true;
    submit.setAttribute("aria-busy", "false");
  }
  const previewImpact = $("adminStrategyClosePreviewImpact");
  if (previewImpact) previewImpact.innerHTML = '<div class="workspace-skeleton"></div>';
  const retry = $("adminStrategyCloseRetry");
  if (retry) retry.classList.add("hidden");
  const refresh = $("adminStrategyCloseRefresh");
  if (refresh) refresh.lastChild && (refresh.lastChild.textContent = "重新获取平仓预览");
}

function setAdminStrategyCloseFieldError(message = "") {
  const input = $("adminStrategyCloseReason");
  const error = $("adminStrategyCloseReasonError");
  input?.setAttribute("aria-invalid", message ? "true" : "false");
  if (!error) return;
  error.textContent = message;
  error.classList.toggle("hidden", !message);
}

function renderAdminStrategyCloseFormState({ showErrors = false } = {}) {
  const preview = state.adminStrategyClosePreview;
  const reason = $("adminStrategyCloseReason")?.value.trim() || "";
  const confirmed = Boolean($("adminStrategyCloseConfirm")?.checked);
  const hash = adminStrategyClosePreviewHash(preview || {});
  const reasonError = !reason ? "请填写完整平仓原因" : reason.length < 2 ? "请至少填写 2 个字" : reason.length > 500 ? "原因不能超过 500 个字" : "";
  if ($("adminStrategyCloseReasonCount")) $("adminStrategyCloseReasonCount").textContent = String(reason.length);
  if (showErrors || !reasonError) setAdminStrategyCloseFieldError(showErrors ? reasonError : "");
  const valid = Boolean(preview && adminStrategyCloseEligible(preview) && hash && !reasonError && confirmed);
  const submit = $("adminStrategyCloseSubmit");
  if (submit) submit.disabled = !valid || state.adminStrategyCloseSubmitting;
  return { valid, reason, confirmed, hash, reasonError };
}

function renderAdminStrategyClosePreview(preview, loading = false) {
  const section = $("adminStrategyCloseSection");
  const impact = $("adminStrategyClosePreviewImpact");
  const submit = $("adminStrategyCloseSubmit");
  if (loading || !preview || !adminStrategyCloseEligible(preview)) {
    section?.classList.add("hidden");
    if (submit) submit.disabled = true;
    if (impact && loading) impact.innerHTML = '<div class="workspace-skeleton"></div>';
    return false;
  }
  const root = adminStrategyCloseRoot(preview);
  const counters = adminStrategyCloseCounters(root);
  const exclusions = Array.isArray(root.exclusions) ? root.exclusions : (Array.isArray(root.excluded_targets) ? root.excluded_targets : (Array.isArray(root.excluded) ? root.excluded : []));
  const sourceTicket = adminStrategyCloseValue(root, ["source_ticket", "source_position_ticket", "ticket"]) || $("positionProtectionTicket")?.value || "--";
  const sourceAccount = root.source_account && typeof root.source_account === "object" ? root.source_account : {};
  const sourceLogin = adminStrategyCloseValue(root, ["source_login", "source_account_login", "login_account"]) || sourceAccount.login || sourceAccount.account || "管理员源账户";
  const previewHash = adminStrategyClosePreviewHash(root);
  if (section) section.classList.remove("hidden");
  if (impact) impact.innerHTML = `
    <div><span>订阅用户（先关）</span><strong>${counters.subscriberUsers} 个用户 · ${counters.affectedPositions} 笔持仓</strong></div>
    <div><span>管理员源仓（最后）</span><strong class="num">#${escapeHtml(sourceTicket)} · ${escapeHtml(sourceLogin)}</strong></div>
    <div><span>安全排除</span><strong>${counters.excluded} 项</strong></div>
    <div><span>预览状态</span><strong>${previewHash ? "哈希已锁定" : "等待后端确认"}</strong></div>
    ${exclusions.length ? `<div class="admin-strategy-close-exclusions"><span>排除原因</span><ul>${exclusions.slice(0, 8).map(item => `<li>${escapeHtml(item?.user_label || item?.user_name || (item?.ticket ? `持仓 #${item.ticket}` : "目标持仓"))}：${escapeHtml(adminStrategyCloseTargetReason(item) || "未满足安全条件")}</li>`).join("")}</ul></div>` : ""}`;
  renderAdminStrategyCloseFormState();
  initIcons();
  return true;
}

async function loadAdminStrategyClosePreview(ticket) {
  const ticketValue = String(ticket || "").trim();
  if (!ticketValue || state.user?.role !== "admin") return null;
  resetAdminStrategyCloseState();
  state.adminStrategyClosePreviewTicket = ticketValue;
  const requestVersion = state.adminStrategyClosePreviewRequestVersion;
  renderAdminStrategyClosePreview(null, true);
  try {
    const preview = await fetchAdminStrategyClosePreview(ticketValue);
    if (requestVersion !== state.adminStrategyClosePreviewRequestVersion
      || String($("positionProtectionTicket")?.value || "") !== ticketValue
      || $("positionProtectionModal")?.classList.contains("hidden")) return null;
    state.adminStrategyClosePreview = preview;
    renderAdminStrategyClosePreview(preview);
    return preview;
  } catch (error) {
    if (String($("positionProtectionTicket")?.value || "") === ticketValue) {
      state.adminStrategyClosePreview = null;
      renderAdminStrategyClosePreview(null);
    }
    return null;
  }
}

async function fetchAdminStrategyClosePreview(ticket) {
  const ticketValue = String(ticket || "").trim();
  if (!ticketValue) throw new Error("缺少源仓票号");
  const data = await api(`/api/admin/ai/positions/${encodeURIComponent(ticketValue)}/close-preview`, { timeout:20000 });
  return adminStrategyCloseRoot(data);
}

function renderAdminStrategyCloseJob(job) {
  if (!job) return;
  const previous = state.adminStrategyCloseJob;
  const next = adminStrategyCloseJobRoot(job);
  const sameJob = adminStrategyCloseJobId(previous) && adminStrategyCloseJobId(previous) === adminStrategyCloseJobId(next);
  const merged = {
    ...(sameJob ? previous : {}),
    ...next,
  };
  const targets = adminStrategyCloseJobTargets(merged);
  if (targets.length) merged.targets = targets;
  state.adminStrategyCloseJob = merged;
  const status = adminStrategyCloseStatus(merged);
  const terminal = ADMIN_STRATEGY_CLOSE_TERMINAL_STATES.has(status);
  const counters = adminStrategyCloseCounters(merged);
  const progress = adminStrategyCloseCounter(merged, ["progress_percent", "progressPercent", "progress", "percent"], 0);
  const progressStage = $("adminStrategyCloseProgressStage");
  progressStage?.classList.remove("hidden");
  $("adminStrategyCloseSubmit")?.classList.add("hidden");
  const refresh = $("adminStrategyCloseRefresh");
  if (refresh?.lastChild) refresh.lastChild.textContent = terminal ? "重新获取平仓预览" : "刷新平仓进度";
  const summary = $("adminStrategyCloseProgressSummary");
  if (summary) summary.innerHTML = `<span><small>成功</small><strong>${counters.succeeded}</strong></span><span><small>失败</small><strong>${counters.failed}</strong></span><span><small>跳过</small><strong>${counters.skipped}</strong></span><span><small>待确认 / 对账中</small><strong>${counters.uncertain} / ${counters.reconciling}</strong></span>`;
  const title = $("adminStrategyCloseProgressTitle");
  if (title) title.textContent = adminStrategyCloseStatusLabel(status);
  const text = $("adminStrategyCloseProgressText");
  if (text) text.textContent = `${Math.max(0, Math.min(100, progress))}% · 订阅用户先关，管理员源仓最后${["uncertain", "reconciling"].includes(status) ? " · Bridge ACK 待对账" : ""}`;
  const resultBody = $("adminStrategyCloseResultBody");
  const ordered = adminStrategyCloseOrderedTargets(targets);
  if (resultBody) resultBody.innerHTML = ordered.length ? ordered.map(target => {
    const targetStatus = adminStrategyCloseTargetStatus(target);
    const label = adminStrategyCloseTargetIsSource(target) ? "管理员源仓" : (target.user_label || target.user_name || (target.user_id ? `用户 ${target.user_id}` : "订阅用户"));
    const ticket = adminStrategyCloseValue(target, ["ticket", "position_ticket", "source_ticket"]) || "--";
    const reason = adminStrategyCloseTargetReason(target);
    const tone = targetStatus === "succeeded" ? "success" : targetStatus === "failed" ? "danger" : ["uncertain", "reconciling"].includes(targetStatus) ? "warning" : targetStatus === "skipped" ? "warning" : "info";
    return `<tr><td>${adminStrategyCloseTargetIsSource(target) ? '<span class="status-chip info">最后</span>' : '<span class="status-chip info">先关</span>'}${escapeHtml(label)}</td><td class="num">#${escapeHtml(ticket)}</td><td><span class="position-protection-target-status ${escapeHtml(targetStatus)} ${tone}">${adminStrategyCloseTargetStatusLabel(targetStatus)}</span></td><td>${escapeHtml(reason || (targetStatus === "uncertain" || targetStatus === "reconciling" ? "Bridge ACK 待对账" : "--"))}</td></tr>`;
  }).join("") : '<tr class="empty-row"><td colspan="4">正在准备执行目标…</td></tr>';
  const retryable = ordered.some(target => adminStrategyCloseTargetStatus(target) === "failed");
  const retry = $("adminStrategyCloseRetry");
  if (retry) retry.classList.toggle("hidden", !(terminal && retryable));
  if (terminal) {
    stopAdminStrategyClosePolling();
    if (status === "completed") loadPositions().catch(() => {});
  } else startAdminStrategyClosePolling(adminStrategyCloseJobId(merged));
  initIcons();
}

function adminStrategyCloseJobId(job = {}) {
  const root = adminStrategyCloseJobRoot(job);
  return adminStrategyCloseValue(root, ["id", "job_id", "close_job_id", "position_close_job_id", "operation_id"]);
}

function startAdminStrategyClosePolling(jobId) {
  stopAdminStrategyClosePolling();
  if (!jobId || ADMIN_STRATEGY_CLOSE_TERMINAL_STATES.has(adminStrategyCloseStatus(state.adminStrategyCloseJob))) return;
  const generation = state.adminStrategyClosePollGeneration;
  state.adminStrategyClosePollTimer = setTimeout(async () => {
    if (generation !== state.adminStrategyClosePollGeneration) return;
    if ($("positionProtectionModal")?.classList.contains("hidden")) {
      stopAdminStrategyClosePolling();
      return;
    }
    try { await loadAdminStrategyCloseJob(jobId); } catch {}
    if (generation === state.adminStrategyClosePollGeneration && !ADMIN_STRATEGY_CLOSE_TERMINAL_STATES.has(adminStrategyCloseStatus(state.adminStrategyCloseJob))) startAdminStrategyClosePolling(jobId);
  }, 2000);
}

async function loadAdminStrategyCloseJob(jobId) {
  const data = await api(`/api/admin/ai/position-close-jobs/${encodeURIComponent(jobId)}`);
  const job = adminStrategyCloseJobRoot(data);
  renderAdminStrategyCloseJob(job);
  return job;
}

async function submitAdminStrategyCloseJob() {
  const preview = state.adminStrategyClosePreview;
  const formState = renderAdminStrategyCloseFormState({ showErrors:true });
  if (!preview || !formState.valid || state.adminStrategyCloseSubmitting) return;
  const confirmed = await showConfirm(
    "确认完整平仓",
    "这是管理员策略指令关联持仓的完整平仓，操作不可撤销；订阅用户会先关，管理员源仓最后，Bridge ACK 仍需对账。",
    { confirmText:"确认完整平仓", cancelText:"返回检查", danger:true, requireText:"确认平仓", requireTextLabel:"输入以下文字以完成二次危险确认", requireTextHint:"仅输入“确认平仓”后才能继续" },
  );
  if (!confirmed) return;
  const submit = $("adminStrategyCloseSubmit");
  const errorHost = $("adminStrategyCloseError");
  state.adminStrategyCloseSubmitting = true;
  if (errorHost) errorHost.classList.add("hidden");
  if (submit) {
    submit.disabled = true;
    submit.setAttribute("aria-busy", "true");
  }
  try {
    const sourceTicket = String($("positionProtectionTicket")?.value || "").trim();
    const data = await api("/api/admin/ai/position-close-jobs", {
      method:"POST",
      timeout:30000,
      body:{
        source_ticket:sourceTicket,
        preview_hash:formState.hash,
        reason:formState.reason,
        idempotency_key:globalThis.crypto?.randomUUID?.() || `admin-strategy-close-${Date.now()}-${Math.random().toString(16).slice(2)}`,
      },
    });
    renderAdminStrategyCloseJob(adminStrategyCloseJobRoot(data));
  } catch (error) {
    if (errorHost) {
      errorHost.textContent = error.message || "完整平仓任务创建失败";
      errorHost.classList.remove("hidden");
    }
  } finally {
    state.adminStrategyCloseSubmitting = false;
    submit?.setAttribute("aria-busy", "false");
    renderAdminStrategyCloseFormState();
  }
}

async function retryAdminStrategyCloseJob() {
  const job = state.adminStrategyCloseJob;
  const jobId = adminStrategyCloseJobId(job);
  const retry = $("adminStrategyCloseRetry");
  if (!jobId || !retry) return;
  retry.disabled = true;
  try {
    const sourceTicket = String($("positionProtectionTicket")?.value || job.source_ticket || "").trim();
    const freshPreview = await fetchAdminStrategyClosePreview(sourceTicket);
    if (!adminStrategyCloseEligible(freshPreview)) throw new Error("关联策略指令归因已变化，请重新打开持仓预览");
    state.adminStrategyClosePreview = freshPreview;
    renderAdminStrategyClosePreview(freshPreview);
    const previewHash = adminStrategyClosePreviewHash(freshPreview);
    if (!previewHash) throw new Error("平仓预览哈希缺失，请重新获取预览");
    const data = await api(`/api/admin/ai/position-close-jobs/${encodeURIComponent(jobId)}/retry-failed`, {
      method:"POST",
      body:{ preview_hash:previewHash },
    });
    renderAdminStrategyCloseJob(adminStrategyCloseJobRoot(data));
  } catch (error) {
    const errorHost = $("adminStrategyCloseProgressError");
    if (errorHost) errorHost.textContent = error.message || "失败目标重试失败";
  } finally {
    retry.disabled = false;
  }
}

function closePositionProtectionModal() {
  stopPositionProtectionPolling();
  resetAdminStrategyCloseState();
  closeFormModal($("positionProtectionModal"));
}

function positionProtectionErrorLabel(code, fallback = "") {
  const labels = {
    bridge_offline: "用户桥接离线，请连接交易平台后重试",
    system_position_not_found: "持仓已不存在或已经平仓",
    position_not_system_owned: "该持仓不是系统下单",
    position_magic_mismatch: "持仓归属校验失败",
    management_account_identity_mismatch: "当前桥接账户与目标账户不一致",
    management_account_server_mismatch: "交易平台服务器已变化",
    management_account_login_mismatch: "交易平台登录账号已变化",
    management_symbol_mismatch: "持仓品种已变化",
    management_direction_mismatch: "持仓方向已变化",
    management_volume_mismatch: "持仓手数已变化",
    position_stop_loss_changed: "止损已被其他操作修改，请重新预览",
    position_take_profit_changed: "止盈已被其他操作修改，请重新预览",
    stop_loss_direction_or_distance_invalid: "止损方向错误或距离现价过近",
    take_profit_direction_or_distance_invalid: "止盈方向错误或距离现价过近",
    source_position_update_failed: "发起持仓修改失败，未继续同步",
    multiple_position_sources: "净持仓包含多个来源，已安全跳过",
    position_protection_command_failed: "交易平台未确认修改结果",
  };
  return labels[String(code || "")] || fallback || String(code || "执行失败");
}

function positionProtectionPriceLabel(value) {
  return Number(value) > 0 ? fmt(Number(value), 6) : "未设置";
}

function setPositionProtectionFieldError(inputId, errorId, message = "") {
  const input = $(inputId);
  const error = $(errorId);
  input?.setAttribute("aria-invalid", message ? "true" : "false");
  if (!error) return;
  error.textContent = message;
  error.classList.toggle("hidden", !message);
}

function renderPositionProtectionChangeState({ showErrors = false } = {}) {
  const preview = state.positionProtectionPreview;
  const submit = $("positionProtectionSubmit");
  const summary = $("positionProtectionChangeSummary");
  const submitHint = $("positionProtectionSubmitHint");
  const reason = $("positionProtectionReason")?.value.trim() || "";
  if ($("positionProtectionReasonCount")) $("positionProtectionReasonCount").textContent = String(reason.length);
  if (!preview) {
    if (submit) submit.disabled = true;
    return { valid:false };
  }

  const currentStopLoss = Number(preview.source?.current_stop_loss || 0);
  const currentTakeProfit = Number(preview.source?.current_take_profit || 0);
  const stopLossRaw = $("positionProtectionStopLoss")?.value.trim() || "";
  const takeProfitRaw = $("positionProtectionTakeProfit")?.value.trim() || "";
  const stopLossValue = stopLossRaw === "" ? currentStopLoss : Number(stopLossRaw);
  const takeProfitValue = takeProfitRaw === "" ? currentTakeProfit : Number(takeProfitRaw);
  const stopLossError = stopLossRaw !== "" && (!Number.isFinite(stopLossValue) || stopLossValue <= 0)
    ? "请输入大于 0 的止损价格" : "";
  const takeProfitError = takeProfitRaw !== "" && (!Number.isFinite(takeProfitValue) || takeProfitValue <= 0)
    ? "请输入大于 0 的止盈价格" : "";
  const reasonError = reason.length > 0 && reason.length < 2 ? "请至少填写 2 个字" : "";
  if (showErrors || !stopLossError) setPositionProtectionFieldError("positionProtectionStopLoss", "positionProtectionStopLossError", showErrors ? stopLossError : "");
  if (showErrors || !takeProfitError) setPositionProtectionFieldError("positionProtectionTakeProfit", "positionProtectionTakeProfitError", showErrors ? takeProfitError : "");
  if (showErrors || !reasonError) setPositionProtectionFieldError("positionProtectionReason", "positionProtectionReasonError", showErrors ? (reason ? reasonError : "请填写本次变更原因") : "");

  const stopLossChanged = !stopLossError && Math.abs(stopLossValue - currentStopLoss) > 1e-8;
  const takeProfitChanged = !takeProfitError && Math.abs(takeProfitValue - currentTakeProfit) > 1e-8;
  const changedCount = Number(stopLossChanged) + Number(takeProfitChanged);
  const slState = $("positionProtectionStopLossState");
  const tpState = $("positionProtectionTakeProfitState");
  if (slState) {
    slState.textContent = stopLossChanged ? "将更新" : "原值";
    slState.classList.toggle("is-changed", stopLossChanged);
  }
  if (tpState) {
    tpState.textContent = takeProfitChanged ? "将更新" : "原值";
    tpState.classList.toggle("is-changed", takeProfitChanged);
  }

  const changes = [];
  if (stopLossChanged) changes.push(`止损 ${positionProtectionPriceLabel(currentStopLoss)} → ${positionProtectionPriceLabel(stopLossValue)}`);
  if (takeProfitChanged) changes.push(`止盈 ${positionProtectionPriceLabel(currentTakeProfit)} → ${positionProtectionPriceLabel(takeProfitValue)}`);
  if (summary) {
    summary.classList.toggle("has-changes", changedCount > 0);
    summary.innerHTML = changedCount > 0
      ? `<i data-lucide="shield-check" size="16"></i><span><strong>本次将修改 ${changedCount} 项：</strong>${escapeHtml(changes.join("；"))}</span>`
      : '<i data-lucide="info" size="16"></i><span>修改任一价格后，这里会显示本次变更摘要。</span>';
  }

  const valid = !stopLossError && !takeProfitError && changedCount > 0 && reason.length >= 2;
  if (submit) submit.disabled = !valid;
  if (submitHint) {
    if (stopLossError || takeProfitError) submitHint.textContent = "请先修正价格格式";
    else if (!changedCount) submitHint.textContent = "请至少修改一个保护价";
    else if (reason.length < 2) submitHint.textContent = "请填写至少 2 个字的变更原因";
    else submitHint.textContent = $("positionProtectionSyncScope")?.checked ? "将按同一信号同步并逐笔校验" : "只修改当前这一笔持仓";
  }
  initIcons();
  return { valid, stopLossError, takeProfitError, reasonError, changedCount };
}

function stopPositionProtectionPolling() {
  if (state.positionProtectionPollTimer) clearInterval(state.positionProtectionPollTimer);
  state.positionProtectionPollTimer = null;
}

function startPositionProtectionPolling(jobId) {
  stopPositionProtectionPolling();
  if (!jobId || POSITION_PROTECTION_TERMINAL_STATES.has(state.positionProtectionJob?.status)) return;
  state.positionProtectionPollTimer = setInterval(() => {
    if ($("positionProtectionModal")?.classList.contains("hidden")) {
      stopPositionProtectionPolling();
      return;
    }
    loadPositionProtectionJob(jobId).catch(() => {});
  }, 2000);
}

function renderPositionProtectionPreview(preview, loading = false) {
  const summary = $("positionProtectionSourceSummary");
  const impact = $("positionProtectionImpact");
  const scope = $("positionProtectionSyncScope");
  const submit = $("positionProtectionSubmit");
  if (loading) {
    if (summary) summary.innerHTML = '<div class="workspace-skeleton"></div>';
    if (impact) impact.innerHTML = '<div class="workspace-skeleton"></div>';
    if (submit) submit.disabled = true;
    renderAdminStrategyClosePreview(null, true);
    return;
  }
  if (!preview) return;
  const source = preview.source || {};
  const direction = source.direction === "buy" ? "买入" : "卖出";
  const online = Boolean(source.bridge_connected);
  if (summary) summary.innerHTML = `
    <div class="position-protection-identity">
      <span class="position-protection-direction ${source.direction === "buy" ? "is-buy" : "is-sell"}"><i data-lucide="${source.direction === "buy" ? "trending-up" : "trending-down"}" size="18"></i>${direction}</span>
      <div><strong>${escapeHtml(source.symbol || "--")}</strong><small class="num">持仓 #${escapeHtml(source.ticket || "--")} · 账户 ${escapeHtml(source.login_account || "--")}</small></div>
      <span class="position-protection-connection ${online ? "is-online" : "is-offline"}"><i></i>${online ? "桥接在线" : "桥接离线"}</span>
    </div>
    <div class="position-protection-facts">
      <div><span>持仓手数</span><strong class="num">${Number(source.volume || 0) || "--"}</strong></div>
      <div><span>当前止损</span><strong class="num">${positionProtectionPriceLabel(source.current_stop_loss)}</strong></div>
      <div><span>当前止盈</span><strong class="num">${positionProtectionPriceLabel(source.current_take_profit)}</strong></div>
      <div><span>来源信号</span><strong>${source.signal_id ? `#${escapeHtml(source.signal_id)}` : "无法唯一归因"}</strong></div>
    </div>`;
  if (impact) impact.innerHTML = `
    <div><span>目标账户</span><strong class="num">${Number(preview.affected_users || 0)}</strong></div>
    <div><span>目标持仓</span><strong class="num">${Number(preview.affected_positions || 0)}</strong></div>
    <div><span>桥接在线</span><strong class="num">${Number(preview.online_users || 0)}</strong></div>
    <div><span>安全排除</span><strong class="num">${Number(preview.exclusions?.length || 0)}</strong></div>`;
  if (scope) {
    scope.disabled = !preview.sync_available;
    scope.checked = preview.sync_scope === "signal" && preview.sync_available;
  }
  const scopeHelp = $("positionProtectionScopeHelp");
  if (scopeHelp) scopeHelp.textContent = preview.sync_available
    ? "开启后，仅同步到由同一条信号产生、且当前仍能唯一归因的系统持仓。"
    : "该持仓缺少唯一信号来源，只能修改当前持仓。";
  const scopeBadge = $("positionProtectionScopeBadge");
  if (scopeBadge) scopeBadge.textContent = scope?.checked
    ? `同步 ${Number(preview.affected_positions || 0)} 笔持仓` : "仅当前持仓";
  if (submit) submit.disabled = false;
  renderPositionProtectionChangeState();
}

async function loadPositionProtectionPreview(ticket, syncScope = "source_only") {
  renderPositionProtectionPreview(null, true);
  const data = await api(`/api/admin/ai/positions/${encodeURIComponent(ticket)}/protection-preview?sync_scope=${encodeURIComponent(syncScope)}`, { timeout:20000 });
  state.positionProtectionPreview = data.preview;
  renderPositionProtectionPreview(data.preview);
  // The linked full-close preview is deliberately independent from the
  // ordinary protection-price flow. A missing/denied close preview must not
  // block editing SL/TP for a normal source-only or AI signal position.
  loadAdminStrategyClosePreview(ticket).catch(() => {});
  return data.preview;
}

async function openPositionProtectionModal(ticket) {
  if (state.user?.role !== "admin") return;
  const modal = $("positionProtectionModal");
  if (modal?.parentElement !== document.body) document.body.appendChild(modal);
  const position = state.positions.find(item => String(item.ticket) === String(ticket));
  if (!position || Number(position.magic) !== 234000) {
    toast("该系统持仓已变化，请刷新后重试", "warning");
    return;
  }
  state.positionProtectionPreview = null;
  state.positionProtectionJob = null;
  resetAdminStrategyCloseState();
  stopPositionProtectionPolling();
  $("positionProtectionTicket").value = String(ticket);
  $("positionProtectionStopLoss").value = Number(position.sl) ? String(position.sl) : "";
  $("positionProtectionTakeProfit").value = Number(position.tp) ? String(position.tp) : "";
  $("positionProtectionReason").value = "";
  $("positionProtectionSyncScope").checked = false;
  $("positionProtectionFormStage").classList.remove("hidden");
  $("positionProtectionProgressStage").classList.add("hidden");
  $("positionProtectionError").classList.add("hidden");
  $("positionProtectionRetry").classList.add("hidden");
  $("positionProtectionSubmit").classList.remove("hidden");
  $("positionProtectionCancel").textContent = "取消";
  $("positionProtectionSubmitLabel").textContent = "保存修改";
  $("positionProtectionSubmit").setAttribute("aria-busy", "false");
  openFormModal(modal);
  renderPositionProtectionChangeState();
  try {
    await loadPositionProtectionPreview(ticket, "source_only");
  } catch (error) {
    $("positionProtectionError").textContent = error.message;
    $("positionProtectionError").classList.remove("hidden");
  }
}

function renderPositionProtectionJob(job) {
  if (!job) return;
  const previous = state.positionProtectionJob;
  const mergedJob = {
    ...(Number(previous?.id) === Number(job.id) ? previous : {}),
    ...job,
    targets:Array.isArray(job.targets) ? job.targets : (previous?.targets || []),
  };
  const wasTerminal = Number(previous?.id) === Number(mergedJob.id)
    && POSITION_PROTECTION_TERMINAL_STATES.has(previous?.status);
  state.positionProtectionJob = mergedJob;
  const isTerminal = POSITION_PROTECTION_TERMINAL_STATES.has(mergedJob.status);
  $("positionProtectionFormStage")?.classList.add("hidden");
  $("positionProtectionProgressStage")?.classList.remove("hidden");
  const progress = $("positionProtectionProgress");
  if (progress) {
    progress.value = Number(mergedJob.progress_percent || 0);
    progress.setAttribute("aria-valuenow", String(Number(mergedJob.progress_percent || 0)));
  }
  job = mergedJob;
  const statusLabels = {
    queued:"等待执行", running:"正在同步", completed:"全部完成",
    partial_failed:"部分完成", failed:"执行失败",
  };
  $("positionProtectionProgressTitle").textContent = statusLabels[job.status] || "正在处理";
  $("positionProtectionProgressText").textContent = `${Number(job.progress_percent || 0)}% · 成功 ${Number(job.succeeded_positions || 0)} · 失败 ${Number(job.failed_positions || 0)} · 跳过 ${Number(job.skipped_positions || 0)}`;
  const body = $("positionProtectionResultBody");
  if (body) body.innerHTML = (job.targets || []).map(target => `
    <tr>
      <td>${target.is_source ? '<span class="status-chip info">发起</span>' : ""}${escapeHtml(target.user_label || `用户 ${target.user_id}`)}</td>
      <td class="num">#${escapeHtml(target.ticket)}</td>
      <td><span class="position-protection-target-status ${escapeHtml(target.status)}">${target.status === "succeeded" ? "成功" : target.status === "failed" ? "失败" : target.status === "skipped" ? "跳过" : target.status === "running" ? "执行中" : "等待"}</span></td>
      <td>${target.error_code ? escapeHtml(positionProtectionErrorLabel(target.error_code, target.error_message)) : "--"}</td>
    </tr>`).join("") || '<tr class="empty-row"><td colspan="4">正在准备执行目标…</td></tr>';
  $("positionProtectionSubmit")?.classList.add("hidden");
  if ($("positionProtectionCancel")) $("positionProtectionCancel").textContent = "关闭";
  const retry = $("positionProtectionRetry");
  if (retry) retry.classList.toggle("hidden", !isTerminal || !(Number(job.failed_positions) || Number(job.skipped_positions)));
  if (isTerminal) {
    stopPositionProtectionPolling();
    if (!wasTerminal) {
      if (job.status === "completed") toast(`保护价已同步到 ${job.succeeded_positions} 个持仓`, "success");
      loadPositions().catch(() => {});
    }
  } else startPositionProtectionPolling(job.id);
  initIcons();
}

function handlePositionProtectionJobUpdate(job) {
  if (!job || Number(job.id) !== Number(state.positionProtectionJob?.id)) return;
  renderPositionProtectionJob(job);
}

function handlePositionProtectionTargetUpdate(jobId, target) {
  const job = state.positionProtectionJob;
  if (!job || !target || Number(jobId) !== Number(job.id)) return;
  const targets = (job.targets || []).map(item => Number(item.id) === Number(target.id)
    ? { ...item, ...target } : item);
  renderPositionProtectionJob({ ...job, targets });
}

async function loadPositionProtectionJob(jobId) {
  const data = await api(`/api/admin/ai/position-protection-jobs/${encodeURIComponent(jobId)}`);
  renderPositionProtectionJob(data.job);
  return data.job;
}

async function submitPositionProtectionJob() {
  const preview = state.positionProtectionPreview;
  if (!preview) return;
  const submit = $("positionProtectionSubmit");
  const errorHost = $("positionProtectionError");
  errorHost.classList.add("hidden");
  const formState = renderPositionProtectionChangeState({ showErrors:true });
  if (!formState.valid) return;
  submit.disabled = true;
  submit.setAttribute("aria-busy", "true");
  $("positionProtectionSubmitLabel").textContent = "正在保存…";
  try {
    const currentStopLoss = Number(preview.source?.current_stop_loss || 0);
    const currentTakeProfit = Number(preview.source?.current_take_profit || 0);
    const stopLossInput = $("positionProtectionStopLoss").value.trim();
    const takeProfitInput = $("positionProtectionTakeProfit").value.trim();
    const stopLossValue = stopLossInput === "" ? currentStopLoss : Number(stopLossInput);
    const takeProfitValue = takeProfitInput === "" ? currentTakeProfit : Number(takeProfitInput);
    if (stopLossInput !== "" && (!Number.isFinite(stopLossValue) || stopLossValue <= 0)) {
      throw new Error("止损价格必须大于 0");
    }
    if (takeProfitInput !== "" && (!Number.isFinite(takeProfitValue) || takeProfitValue <= 0)) {
      throw new Error("止盈价格必须大于 0");
    }
    const reason = $("positionProtectionReason").value.trim();
    if (reason.length < 2 || reason.length > 500) {
      throw new Error("请填写 2 至 500 字的变更原因");
    }
    const stopLoss = Number.isFinite(stopLossValue) && Math.abs(stopLossValue - currentStopLoss) > 1e-8
      ? stopLossValue : null;
    const takeProfit = Number.isFinite(takeProfitValue) && Math.abs(takeProfitValue - currentTakeProfit) > 1e-8
      ? takeProfitValue : null;
    if (stopLoss === null && takeProfit === null) {
      throw new Error("请至少修改止损或止盈中的一项");
    }
    const data = await api("/api/admin/ai/position-protection-jobs", {
      method:"POST",
      timeout:30000,
      body:{
        idempotency_key:globalThis.crypto?.randomUUID?.() || `position-protection-${Date.now()}-${Math.random().toString(16).slice(2)}`,
        source_ticket:$("positionProtectionTicket").value,
        stop_loss:stopLoss,
        take_profit:takeProfit,
        sync_scope:$("positionProtectionSyncScope").checked ? "signal" : "source_only",
        reason,
        preview_hash:preview.preview_hash,
      },
    });
    renderPositionProtectionJob(data.job);
  } catch (error) {
    errorHost.textContent = error.message;
    errorHost.classList.remove("hidden");
    if (error.message.includes("止损")) $("positionProtectionStopLoss")?.focus();
    else if (error.message.includes("止盈")) $("positionProtectionTakeProfit")?.focus();
    else $("positionProtectionReason")?.focus();
    if (error.message.includes("重新预览")) {
      await loadPositionProtectionPreview($("positionProtectionTicket").value,
        $("positionProtectionSyncScope").checked ? "signal" : "source_only").catch(() => {});
    }
  } finally {
    submit.setAttribute("aria-busy", "false");
    $("positionProtectionSubmitLabel").textContent = "保存修改";
    renderPositionProtectionChangeState();
  }
}

async function retryPositionProtectionJob() {
  const job = state.positionProtectionJob;
  const jobId = job?.id;
  if (!jobId) return;
  const button = $("positionProtectionRetry");
  button.disabled = true;
  try {
    const preview = await loadPositionProtectionPreview(job.source_ticket, job.sync_scope || "source_only");
    const data = await api(`/api/admin/ai/position-protection-jobs/${encodeURIComponent(jobId)}/retry-failed`, {
      method:"POST",
      body:{ preview_hash:preview.preview_hash },
    });
    renderPositionProtectionJob(data.job);
  } catch (error) { toast(error.message, "error"); }
  finally { button.disabled = false; }
}

async function loadObserverChannels() {
  if (!isObserverMode()) {
    state.observerChannels = [];
    state.selectedObserverChannelId = null;
    renderObserverChannelControl();
    return;
  }
  const data = await api('/api/ai/observer-channels');
  state.observerChannels = Array.isArray(data.channels) ? data.channels : [];
  const savedId = Number(localStorage.getItem(observerChannelStorageKey()));
  const accessId = Number(state.aiAccess?.observer_channel?.id);
  const selected = state.observerChannels.find(channel => Number(channel.id) === savedId)
    || state.observerChannels.find(channel => Number(channel.id) === accessId)
    || state.observerChannels.find(channel => channel.is_default)
    || state.observerChannels[0];
  state.selectedObserverChannelId = selected ? Number(selected.id) : null;
  if (selected) localStorage.setItem(observerChannelStorageKey(), String(selected.id));
  renderObserverChannelControl();
}

async function changeObserverChannel(channelId) {
  const nextId = Number(channelId);
  if (!nextId || nextId === state.selectedObserverChannelId) return;
  syncSelectedObserverChannel(nextId);
  state.platformMarketSourceActive = false;
  state.lastObserverQuote = null;
  setText('quoteTime', '--');
  setText('mt5ServerTime', '--');
  _historyCache = null;
  _historyChartCache = null;
  state.signals = [];
  state.positions = [];
  const accessRes = await api(`/api/ai/access-context?channel_id=${encodeURIComponent(nextId)}`);
  syncAiAccess(accessRes.access);
  notifyObserverChannelSelection();
  await refreshAll();
  const channelName = state.observerChannels.find(channel => Number(channel.id) === nextId)?.name || '观摩频道';
  toast(`已切换至${channelName}`, 'success');
}

function setObserverPanelLock(panel, locked) {
  if (!panel) return;
  panel.classList.toggle('is-readonly', locked);
  panel.querySelectorAll('#buyBtn, #sellBtn').forEach(control => {
    if (locked) {
      if (!control.hasAttribute('data-observer-was-disabled')) {
        control.dataset.observerWasDisabled = control.disabled ? '1' : '0';
        control.dataset.observerTitleBefore = control.title || '';
      }
      control.disabled = true;
      control.title = observerMessage();
      return;
    }
    if (control.hasAttribute('data-observer-was-disabled')) {
      control.disabled = control.dataset.observerWasDisabled === '1';
      delete control.dataset.observerWasDisabled;
      control.title = control.dataset.observerTitleBefore || '';
      delete control.dataset.observerTitleBefore;
    }
  });
}

function applyRoleUI() {
  const isAdmin = state.user?.role === "admin";
  const observerSource = isObserverSourceAccount();
  const platformManager = canManagePlatformAiContent();
  const observer = isObserverMode();
  const allowedTabs = new Set(state.aiAccess?.allowed_tabs || []);

  if (!platformManager) {
    stopManualTradeReviewPolling();
    state.manualTradeReviewTrades = [];
    state.manualTradeReviewSelectedTrades = [];
    state.manualTradeReviewSelection = [];
    state.manualTradeReviewCases = [];
    state.manualTradeReviewDetail = null;
    state.manualTradeReviewLoaded = false;
    state.manualTradeReviewHistoryLoaded = false;
    state.manualTradeReviewSelectedId = null;
    state.selectedManualTradeReviewId = null;
    state.manualTradeReviewScannedSourcePages = 0;
    state.manualTradeReviewSkippedEmptySourcePages = 0;
    state.manualTradeReviewUnavailable = false;
    state.manualTradeReviewEvidenceReason = "";
  }

  document.querySelectorAll('.admin-only').forEach(el => {
    el.style.display = isAdmin || (platformManager && el.classList.contains('platform-content-only')) ? '' : 'none';
  });
  document.querySelectorAll('.user-only').forEach(el => {
    const platformPersonalControl = el.classList.contains('personal-memory-only');
    el.style.display = isAdmin || (platformManager && platformPersonalControl) ? 'none' : '';
  });
  renderAdminStrategyDispatchControls();
  setText("memoryTabLabel", "策略记忆库");
  setText("memoryActiveLabel", "当前记忆版本");
  setText("memoryActiveHelp", "完整传入分析与复盘");
  setText("memorySectionTitle", "策略记忆库");
  setText("memorySectionDescription", platformManager
    ? "每个可管理的平台策略只有一份完整记忆库；保存后直接用于分析、日复盘与月复盘。"
    : "每个策略只有一份完整记忆库；保存后直接用于分析、日复盘与月复盘。");
  if ($("addPrivateStrategyBtn") && !$("addPrivateStrategyBtn").disabled) {
    $("addPrivateStrategyBtn").textContent = platformManager ? "新建平台策略" : "新建自定义策略";
  }
  const privateFilter = document.querySelector('[data-strategy-filter="private"]');
  if (privateFilter) privateFilter.style.display = observerSource ? 'none' : '';

  // Navigation is an explicit capability list in observer mode. Empty groups
  // are removed so the sidebar contains exactly the pages the user can open.
  document.querySelectorAll('.sidebar .nav-item[data-tab], .mobile-bottom-nav .nav-item[data-tab], .mobile-nav-drawer .nav-item[data-tab]').forEach(item => {
    const visible = observer
      ? allowedTabs.has(item.dataset.tab)
      : (!item.classList.contains('admin-only') || isAdmin);
    item.style.display = visible ? '' : 'none';
  });
  const bottomGroup = document.querySelector('.nav-group-bottom');
  if (bottomGroup) bottomGroup.style.display = '';
  document.querySelectorAll('.sidebar > .nav-group:not(.nav-group-bottom)').forEach(group => {
    const visibleItem = [...group.querySelectorAll('.nav-item')].some(item => item.style.display !== 'none');
    group.style.display = visibleItem ? '' : 'none';
  });

  const gatewayBadge = document.getElementById("gatewayMode");
  if (gatewayBadge) {
    const canOpenDownload = !observer || state.aiAccess?.can_download_bridge === true;
    gatewayBadge.classList.toggle("clickable-badge", canOpenDownload);
    gatewayBadge.classList.toggle("is-readonly", !canOpenDownload);
    gatewayBadge.setAttribute("aria-disabled", String(!canOpenDownload));
    gatewayBadge.title = observer && !canOpenDownload ? "Plus 会员仅可观摩" : `打开 ${bridgePlatformLabel()} 连接设置`;
  }

  document.querySelectorAll('.sym-input').forEach(el => {
    el.disabled = observer;
    el.title = observer ? observerMessage() : '';
  });

  for (const id of ["tradeMode", "autoAnalyzeMode"]) {
    const badge = document.getElementById(id);
    if (!badge) continue;
    badge.classList.toggle("clickable-badge", !observer);
    badge.classList.toggle("is-readonly", observer);
    badge.setAttribute('aria-disabled', String(observer));
    if ('disabled' in badge) badge.disabled = false;
    badge.title = observer
      ? observerMessage()
      : id === "autoAnalyzeMode"
        ? (badge.title || "点击编辑订阅与自动分析设置")
        : (badge.title || "查看或切换交易发送权限");
  }

  document.querySelectorAll('.observer-action-panel').forEach(panel => setObserverPanelLock(panel, observer));
  updateHistoryRangeUI();

  if (observer) {
    if (state.aiAccess?.reason === "bridge_offline") {
      showSidebarObserveHint('观摩模式 · <a href="#" id="sidebarBridgeLink">下载并连接量见智桥</a> 后可使用完整功能');
      setTimeout(() => {
        const link = document.getElementById("sidebarBridgeLink");
        if (link) link.onclick = (event) => { event.preventDefault(); handleGatewayModeClick(); };
      }, 0);
    } else {
      showSidebarObserveHint('Plus 观摩模式 · 当前展示平台观摩账户数据');
    }
    return;
  }

  hideSidebarObserveHint();
}

// [disabled] 智能平仓
function updateAnalysisExecutionButton(signal) {
  const button = $("executeSignalBtn");
  if (!button) return;
  if (!signal) {
    button.disabled = true;
    button.title = "暂无可执行信号";
    return;
  }
  const dir = signalType(signal.signal_type);
  const advice = signalExecutionAdvice(signal);
  const executable = advice.executable === true && dir !== "hold" && dir !== "close" && !signal.is_stale;
  button.disabled = !executable;
  button.title = executable
    ? "复核后发送执行请求"
    : dir === "close" ? "持仓分析信号已自动执行"
      : signal.is_stale ? "信号已过期，无法执行"
        : advice.description || (signal.is_executed ? "信号已执行" : "观望信号不执行");
}

function renderSignalMonitorDetails(signal) {
  const host = $("signalMonitorDetails");
  if (!host) return;
  if (!signal) {
    host.innerHTML = `<div class="signal-monitor-empty"><i data-lucide="radio-tower" size="28"></i><strong>等待新的 AI 建议</strong><span>全屏监看会在新信号到达后自动更新</span></div>`;
    initIcons();
    return;
  }

  const decision = signalDecision(signal);
  const takeProfit = signalTakeProfitSelection(signal);
  const execution = parseJsonField(signal.execution_result, {});
  const approved = execution?.risk?.approved_order || execution?.approved_order || parseJsonField(signal.approved_order_json, {});
  const finalVolume = approved?.volume;
  const direction = signalType(signal.signal_type);
  const entryLabels = { market:"市价", limit:"限价", stop:"止损挂单", stop_limit:"止损限价" };
  const entryMethod = entryLabels[signal.entry_method] || (direction === "hold" ? "观望" : "待确认");
  const plannedEntry = direction === "hold" ? null : (signal.limit_price || signalMarketData(signal).latest_price);
  const finalVolumeText = direction === "hold"
    ? "无需计算"
    : finalVolume == null ? "执行时计算" : volumeText(finalVolume);
  const analysis = userVisibleText(decision.modelDecision?.analysis || signal.analysis, "暂无行情分析正文");
  const reasoning = userVisibleText(decision.modelDecision?.reasoning || signal.reasoning, "");
  const strategyLabel = signal.prompt_type_name || signal.strategy_name || signal.strategy_title || "当前交易策略";
  const modelLabel = signal.model_name || signal.model_used || signal.model || "按策略配置";
  const recommendedTierLabel = takeProfit.recommendedTier ? `AI 推荐 TP${takeProfit.recommendedTier}` : "暂无推荐档位";

  host.innerHTML = `
    <div class="signal-monitor-main">
      <section class="signal-monitor-summary monitor-surface">
        <div class="monitor-section-heading"><span><i data-lucide="sparkles" size="16"></i>核心结论</span><small>AI 对当前行情的直接判断</small></div>
        <strong>${escapeHtml(decision.summary)}</strong>
        ${renderDirectionBias(decision)}
      </section>
      <div class="signal-monitor-evidence">
        <section class="monitor-surface"><div class="monitor-section-heading"><span><i data-lucide="check-circle-2" size="16"></i>关键依据</span></div>${renderDecisionList(decision.reasons, "暂无额外依据")}</section>
        <section class="monitor-surface risk"><div class="monitor-section-heading"><span><i data-lucide="triangle-alert" size="16"></i>市场风险</span></div>${renderDecisionList(decision.risks, "未识别到额外市场风险")}</section>
      </div>
      ${(decision.trigger || decision.invalidation) ? `<section class="signal-monitor-conditions monitor-surface">${decision.trigger ? `<div><span>触发条件</span><strong>${escapeHtml(decision.trigger)}</strong></div>` : ""}${decision.invalidation ? `<div><span>失效条件</span><strong>${escapeHtml(decision.invalidation)}</strong></div>` : ""}</section>` : ""}
      <section class="signal-monitor-narrative monitor-surface">
        <div class="monitor-section-heading"><span><i data-lucide="file-text" size="16"></i>完整分析</span><small>向下滚动查看全部内容</small></div>
        <div>${analysis ? `<strong>行情分析</strong><p>${escapeHtml(analysis)}</p>` : `<p class="decision-empty">暂无行情分析正文</p>`}${reasoning ? `<strong>分析依据</strong><p>${escapeHtml(reasoning)}</p>` : ""}</div>
      </section>
    </div>
    <aside class="signal-monitor-rail">
      <section class="monitor-surface signal-monitor-order-card">
        <div class="monitor-section-heading"><span><i data-lucide="list-checks" size="16"></i>执行参数</span><small>最终结果以账户风控为准</small></div>
        <div class="signal-monitor-order-grid">
          <div><span>入场方式</span><strong>${escapeHtml(entryMethod)}</strong></div>
          <div><span>计划入场</span><strong class="num">${escapeHtml(priceDisplay(plannedEntry))}</strong></div>
          <div><span>AI 仓位档位</span><strong>${escapeHtml(positionSizeAdvice(signal).text)}</strong></div>
          <div><span>风控最终手数</span><strong class="num">${escapeHtml(finalVolumeText)}</strong></div>
        </div>
      </section>
      ${renderExecutionValidation(decision.executionValidation)}
      <section class="monitor-surface signal-monitor-targets">
        <div class="monitor-section-heading"><span>止盈候选</span><small>${escapeHtml(recommendedTierLabel)}</small></div>
        <div>${[1, 2, 3].map(tier => `<span class="${takeProfit.tier === tier ? "selected" : ""} ${takeProfit.recommendedTier === tier ? "recommended" : ""}"><small>TP${tier}</small><strong class="num">${escapeHtml(priceDisplay(signal[`take_profit_${tier}_price`]))}</strong></span>`).join("")}</div>
      </section>
      <section class="monitor-surface signal-monitor-meta">
        <div><span>信号编号</span><strong class="num">#${escapeHtml(signal.id)}</strong></div>
        <div><span>推理策略</span><strong>${escapeHtml(strategyLabel)}</strong></div>
        <div><span>分析周期</span><strong class="num">${escapeHtml(signal.timeframe || "--")}</strong></div>
        <div><span>推理模型</span><strong>${escapeHtml(modelLabel)}</strong></div>
      </section>
    </aside>`;
  initIcons();
}

function initSignalMonitor() {
  const card = $("signalCard");
  const enterButton = $("signalMonitorFullscreen");
  const exitButton = $("signalMonitorExit");
  if (!card || !enterButton || !exitButton) return;

  let restoreFocusTarget = null;
  let isolatedElements = [];

  const setBackgroundIsolation = active => {
    if (!active) {
      isolatedElements.forEach(({ element, inert, ariaHidden }) => {
        element.inert = inert;
        if (ariaHidden == null) element.removeAttribute("aria-hidden");
        else element.setAttribute("aria-hidden", ariaHidden);
      });
      isolatedElements = [];
      return;
    }
    if (isolatedElements.length) return;
    let current = card;
    while (current?.parentElement && current.parentElement !== document.body) {
      [...current.parentElement.children].forEach(element => {
        if (element === current || isolatedElements.some(item => item.element === element)) return;
        isolatedElements.push({ element, inert: element.inert, ariaHidden: element.getAttribute("aria-hidden") });
        element.inert = true;
        element.setAttribute("aria-hidden", "true");
      });
      current = current.parentElement;
    }
  };

  const leaveFallbackMode = () => {
    delete card.dataset.monitorFallback;
    document.body.classList.remove("signal-monitor-fallback-active");
  };
  const syncFullscreenState = () => {
    const active = document.fullscreenElement === card || card.dataset.monitorFallback === "true";
    card.classList.toggle("is-signal-monitor", active);
    enterButton.setAttribute("aria-pressed", String(active));
    setBackgroundIsolation(active);
    if (active) {
      card.setAttribute("role", "dialog");
      card.setAttribute("aria-modal", "true");
      card.setAttribute("aria-label", "最新 AI 建议全屏监看");
      setTimeout(() => exitButton.focus({ preventScroll:true }), 50);
    } else {
      card.removeAttribute("role");
      card.removeAttribute("aria-modal");
      card.removeAttribute("aria-label");
      if (restoreFocusTarget?.isConnected) restoreFocusTarget.focus({ preventScroll:true });
      restoreFocusTarget = null;
    }
    if (!active) {
      card.classList.remove("signal-monitor-updated");
      const label = $("signalMonitorSync")?.querySelector("span");
      if (label) label.textContent = "实时同步";
    }
    initIcons();
  };

  enterButton.addEventListener("click", async () => {
    restoreFocusTarget = document.activeElement;
    try {
      if (state.latestSignalId != null && !sameSignalId(state.dashboardSignal?.id, state.latestSignalId)) {
        await loadDashboardSignal(state.latestSignalId, state.signals.find(item => sameSignalId(item.id, state.latestSignalId)) || null);
      }
      if (!document.fullscreenEnabled || typeof card.requestFullscreen !== "function") throw new Error("浏览器未开放全屏权限");
      leaveFallbackMode();
      await card.requestFullscreen();
    } catch (error) {
      card.dataset.monitorFallback = "true";
      document.body.classList.add("signal-monitor-fallback-active");
      syncFullscreenState();
      toast("浏览器未允许真全屏，已切换为窗口内监看；可按 F11 隐藏浏览器工具栏", "info");
    }
  });
  exitButton.addEventListener("click", () => {
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    else {
      leaveFallbackMode();
      syncFullscreenState();
    }
  });
  document.addEventListener("keydown", event => {
    if (event.key === "Escape" && card.dataset.monitorFallback === "true") {
      leaveFallbackMode();
      syncFullscreenState();
    }
  });
  document.addEventListener("fullscreenchange", syncFullscreenState);
  syncFullscreenState();
}

function updateSignalDisplay(signal, options = {}) {
  const previousSignalId = state.dashboardSignal?.id;
  state.dashboardSignal = signal || null;
  const card = $("signalCard");
  if (!card) return;

  if (!signal) {
    setSignalBadge(null);
    card.dataset.direction = "hold";
    card.dataset.status = "empty";
    card.style.setProperty("--signal-border", "var(--color-warning)");
    card.style.setProperty("--signal-glow", "var(--signal-glow-hold)");
    setText("sigSymbol", "--");
    setText("sigTimeframe", "--");
    setText("sigDirectionText", "等待信号");
    $("sigDirectionText").className = "signal-direction-text hold";
    setText("sigConfidence", "--");
    updateSignalPriceFields(null);
    $("sigBar").style.setProperty('--signal-confidence-scale', '0');
    setText("sigTime", "等待新信号");
    setText("sigGeneratedAt", "--");
    setText("sigValidWindow", "--");
    renderSignalMonitorDetails(null);
    return;
  }

  setSignalBadge(signal);
  const dir = signalType(signal.signal_type);
  const confidence = confidenceInfo(signal.confidence);
  const colorMap = {
    buy: { border: "var(--color-positive)", glow: "var(--signal-glow-buy)" },
    sell: { border: "var(--color-negative)", glow: "var(--signal-glow-sell)" },
    hold: { border: "var(--color-warning)", glow: "var(--signal-glow-hold)" },
    close: { border: "var(--color-info)", glow: "var(--color-info-bg)" },
  };

  card.dataset.direction = dir;
  const advice = signalExecutionAdvice(signal);
  card.dataset.status = ["executed", "pending"].includes(advice.state) ? advice.state : signalIsStale(signal) ? "expired" : "live";
  card.style.setProperty("--signal-border", colorMap[dir].border);
  card.style.setProperty("--signal-glow", colorMap[dir].glow);
  setText("sigSymbol", signal.symbol || "--");
  setText("sigTimeframe", signal.timeframe || "--");
  if ($("sigSymbol")) $("sigSymbol").title = "交易品种代码；末尾后缀由经纪商定义";
  if ($("sigTimeframe")) $("sigTimeframe").title = timeframeHelp(signal.timeframe);
  setText("sigDirectionText", directionText(signal.signal_type));
  $("sigDirectionText").className = `signal-direction-text ${dir}`;
  setText("sigConfidence", confidence.label);
  updateSignalPriceFields(signal);
  $("sigBar").style.setProperty('--signal-confidence-scale', String(confidence.value / 100));
  setText("sigTime", signalDisplayTime(signal));
  setText("sigGeneratedAt", signalDisplayTime(signal));
  setText("sigValidWindow", signalFreshness(signal));
  renderSignalMonitorDetails(signal);
  if (options.announceNew && previousSignalId != null && !sameSignalId(previousSignalId, signal.id)) {
    const announcement = $("signalAnnouncement");
    if (announcement) announcement.textContent = `收到新的 AI 建议：${signal.symbol || "当前品种"}，${directionText(signal.signal_type)}，${signalExecutionAdvice(signal).title}`;
    flashSignalMonitorUpdate();
  }
}

function signalFreshness(signal) {
  if (!signal) return "--";
  // Compute age in real-time from created_at, not from stale snapshot
  const ttl = Number(signal.ttl_seconds);
  if (!Number.isFinite(ttl)) return signal.ttl_seconds ? `TTL ${signal.ttl_seconds}s` : "--";
  const canonicalUtcMsc = Number(signal.created_at_utc_msc);
  const createdAt = Number.isFinite(canonicalUtcMsc) && canonicalUtcMsc > 0
    ? canonicalUtcMsc : parseBeijingServerTime(signal.created_at);
  if (!createdAt || isNaN(createdAt)) return "--";
  const age = Math.max(0, Math.floor((Date.now() - createdAt) / 1000));
  const remaining = Math.max(0, Math.ceil(ttl - age));
  if (remaining <= 0) return "已过期";
  if (remaining >= 60) return `${Math.floor(remaining / 60)}分${String(remaining % 60).padStart(2, "0")}秒`;
  return `${remaining}秒`;
}

function executionStatus(signal) {
  const dir = signalType(signal?.signal_type);
  if (!signal) return "--";
  const advice = signalExecutionAdvice(signal);
  if (advice.state === "pending") return "挂单已提交";
  if (advice.state === "executed" || signal.is_executed) return "已执行";
  if (advice.state === "rejected") return "风控未放行";
  if (advice.state === "failed") return "执行未完成";
  if (signal.is_stale) return "已过期";
  if (dir === "hold") return "观望，不执行";
  return "可复核";
}

function renderPendingSignalInfo(signal, market) {
  const em = signal.entry_method || 'market'
  if (em === 'market' || em === 'observe' || !em) return ''
  const entryLabels = { limit: '限价', stop: '止损', stop_limit: '止损限价' }
  const st = String(signal.signal_type || '').toLowerCase()
  const sideLabel = st.startsWith('buy') ? '买入' : st.startsWith('sell') ? '卖出' : ''
  const typeLabel = sideLabel + (entryLabels[em] || em)
  let rows = ''
  rows += `<div><span>订单类型</span><strong>${escapeHtml(typeLabel)}</strong></div>`
  if (signal.limit_price) rows += `<div><span>挂单价</span><strong>${escapeHtml(priceDisplay(signal.limit_price))}</strong></div>`
  if (em === 'stop_limit' && signal.stop_limit_price) rows += `<div><span>限价</span><strong>${escapeHtml(priceDisplay(signal.stop_limit_price))}</strong></div>`
  if (em === 'stop_limit' && Number.isFinite(Number(market.latest_price))) rows += `<div><span>当前市价</span><strong>${escapeHtml(priceDisplay(market.latest_price))}</strong></div>`
  if (signal.pending_valid_until) {
    const validDate = utcToMt5(signal.pending_valid_until, terminalEventTimezoneOffsetMinutes(signal))
    if (validDate) rows += `<div><span>有效期至</span><strong>${escapeHtml(validDate)}</strong></div>`
  }
  return `<div class="signal-pending-info">${rows}</div>`
}

function signalDecision(signal) {
  let stored = signal?.decision || signal?.decision_json || {};
  if (typeof stored === "string") { try { stored = JSON.parse(stored); } catch { stored = {}; } }
  const modelDecision = signal?.model_decision || stored.model_decision || {};
  const dir = signalType(modelDecision.signal_type || signal?.signal_type);
  const sourceReasons = modelDecision.key_reasons || signal?.key_reasons || stored.key_reasons;
  const sourceRisks = modelDecision.risk_factors || signal?.risk_factors || stored.risk_factors;
  const bullish = Number(modelDecision.bullish_score ?? signal?.bullish_score ?? stored.bullish_score);
  const bearish = Number(modelDecision.bearish_score ?? signal?.bearish_score ?? stored.bearish_score);
  const experienceUsage = signal?.experience_usage || stored.experience_usage || {};
  const hasDirectionBias = Number.isFinite(bullish) && Number.isFinite(bearish) && bullish >= 0 && bearish >= 0 && bullish + bearish > 0;
  const total = hasDirectionBias ? bullish + bearish : 0;
  return {
    modelDecision,
    summary: userVisibleText(modelDecision.decision_summary || signal?.decision_summary || stored.decision_summary, dir === "hold" ? "模型建议观望。" : `${dir === "buy" ? "偏多" : "偏空"}机会成立，等待执行校验与风控复核。`),
    trigger: userVisibleText(modelDecision.trigger_condition || signal?.trigger_condition || stored.trigger_condition, ""),
    invalidation: userVisibleText(modelDecision.invalidation_condition || signal?.invalidation_condition || stored.invalidation_condition, ""),
    reasons: Array.isArray(sourceReasons) ? sourceReasons.slice(0, 4).map(item => userVisibleText(item, "系统未提供中文依据")) : [],
    risks: Array.isArray(sourceRisks) ? sourceRisks.slice(0, 4).map(item => userVisibleText(item, "系统未提供中文风险说明")) : [],
    bullishScore: hasDirectionBias ? Math.round(bullish / total * 1000) / 10 : null,
    bearishScore: hasDirectionBias ? Math.round(bearish / total * 1000) / 10 : null,
    candidateEntry: signal?.candidate_entry || stored.candidate_entry || null,
    experienceUsage,
    executionValidation:signal?.execution_validation || stored.execution_validation || null,
  };
}

const EXECUTION_VALIDATION_REASON_LABELS = {
    model_hold:"模型本轮未提出新订单",
    position_action_hold_no_add:"模型建议不新增仓位",
    entry_method_not_allowed_by_strategy:"入场方式不在策略声明范围内",
    pending_price_required:"挂单缺少有效价格",
    pending_reference_price_unavailable:"缺少可核验的当前价格",
    pending_price_direction_invalid:"挂单价格方向不符合订单类型",
    stop_limit_price_required:"止损限价单缺少限价",
    stop_limit_price_relation_invalid:"触发价与限价关系无效",
    execution_reference_price_unavailable:"缺少订单校验参考价",
    stop_loss_missing:"缺少止损价格",
    invalid_stop_loss_direction:"止损价格方向无效",
    take_profit_target_missing:"缺少第一止盈目标",
    invalid_take_profit_direction:"止盈价格方向无效",
    take_profit_order_invalid:"多档止盈顺序无效",
    invalid_recommended_take_profit_tier:"推荐止盈档位不可用",
};

function executionValidationReasonTexts(validation) {
  if (!validation || typeof validation !== "object") return [];
  return [...new Set((Array.isArray(validation.reason_codes) ? validation.reason_codes : [])
    .map(code => EXECUTION_VALIDATION_REASON_LABELS[String(code || "").toLowerCase()]).filter(Boolean))];
}

function executionAdviceDescription(advice, validation) {
  const base = String(advice?.description || "").trim();
  const reasons = validation?.eligible === true && validation?.status === "eligible"
    ? [] : executionValidationReasonTexts(validation);
  if (!reasons.length) return base;
  return `${reasons.join("；")}，因此不会进入下单流程。`;
}

function renderExecutionValidation(validation) {
  if (!validation || typeof validation !== "object") return "";
  const eligible = validation.eligible === true && validation.status === "eligible";
  const reasons = executionValidationReasonTexts(validation);
  return `<section class="execution-validation ${eligible ? "eligible" : "ineligible"}" aria-label="执行校验">
    <div><i data-lucide="${eligible ? "badge-check" : "shield-alert"}" size="17"></i><span><small>执行校验</small><strong>${eligible ? "参数校验通过" : "不会进入下单流程"}</strong></span></div>
    ${reasons.length ? `<ul>${reasons.map(reason => `<li>${escapeHtml(reason)}</li>`).join("")}</ul>` : `<p>${eligible ? "仍需经过账户权限、独立风控与 Bridge 校验。" : "模型结论已保留，可查看原始分析与参数。"}</p>`}
  </section>`;
}

function stopLossDistanceSummary(signal, market = {}) {
  const stored = signal?.stop_loss_diagnostics || signal?.decision?.stop_loss_diagnostics;
  const storedDistance = Number(stored?.distance);
  if (storedDistance > 0) {
    const storedAtrRatio = Number(stored?.distance_atr);
    return `距入场 ${priceDisplay(storedDistance)}${storedAtrRatio > 0 ? ` · ${fmt(storedAtrRatio, 2)} ATR` : ""}`;
  }
  const entryMethod = String(signal?.entry_method || "market").toLowerCase();
  const entry = Number(entryMethod === "market"
    ? market?.latest_price
    : entryMethod === "stop_limit"
      ? (signal?.stop_limit_price || signal?.limit_price)
      : signal?.limit_price);
  const stopLoss = Number(signal?.stop_loss_price);
  if (!(entry > 0) || !(stopLoss > 0)) return "";
  const distance = Math.abs(entry - stopLoss);
  if (!(distance > 0)) return "";
  const atr = Number(market?.atr_anchor);
  const atrText = atr > 0 ? ` · ${fmt(distance / atr, 2)} ATR` : "";
  return `距入场 ${priceDisplay(distance)}${atrText}`;
}

function canViewSignalExperienceUsage(signal, usage = {}) {
  const source = String(usage.source || "").toLowerCase();
  if (source === "platform") return state.user?.role === "admin";
  if (source === "personal") return state.user?.role !== "admin" && Number(signal?.user_id) === Number(state.user?.id);
  return false;
}

function experienceRefLabel(value) {
  const match = String(value || "").match(/^(platform|short|long|summary|item):(\d+)$/);
  if (!match) return "记忆条目";
  const labels = { platform:"平台记忆", short:"短期记忆", long:"长期记忆", summary:"月度摘要", item:"记忆" };
  return `${labels[match[1]] || '记忆'} #${Number(match[2])}`;
}

function renderExperienceUsage(signal, usage = {}) {
  if (!canViewSignalExperienceUsage(signal, usage)) return "";
  const refPattern = /^(?:platform|short|long|summary|item):(\d+)$/;
  const validRefs = value => [...new Set((Array.isArray(value) ? value : [])
    .map(item => String(item || "").trim()).filter(item => refPattern.test(item)))];
  const consideredRefs = validRefs(usage.considered_refs);
  const consideredIds = [...new Set((Array.isArray(usage.considered_ids) ? usage.considered_ids : [])
    .map(Number).filter(id => Number.isInteger(id) && id > 0))];
  const refsById = new Map();
  consideredRefs.forEach(ref => {
    const id = Number(ref.match(refPattern)[1]);
    const refs = refsById.get(id) || [];
    refs.push(ref);
    refsById.set(id, refs);
  });
  const uniqueRefsForIds = ids => (Array.isArray(ids) ? ids : []).flatMap(id => {
    const matches = refsById.get(Number(id)) || [];
    return matches.length === 1 ? matches : [];
  });
  const explicitUsedRefs = validRefs(usage.used_refs).filter(ref => consideredRefs.includes(ref));
  const usedIds = consideredIds.filter(id => (Array.isArray(usage.used_ids) ? usage.used_ids : []).map(Number).includes(id));
  const usedRefs = [...new Set([...explicitUsedRefs, ...uniqueRefsForIds(usedIds)])];
  const used = consideredRefs.length ? usedRefs : usedIds;
  const rejectedIds = consideredIds.filter(id => (Array.isArray(usage.rejected_ids) ? usage.rejected_ids : []).map(Number).includes(id) && !usedIds.includes(id));
  const rejectedRefs = [...new Set([
    ...validRefs(usage.rejected_refs).filter(ref => consideredRefs.includes(ref)),
    ...uniqueRefsForIds(rejectedIds),
  ])].filter(ref => !usedRefs.includes(ref));
  const considered = consideredRefs.length ? consideredRefs : consideredIds;
  if (!considered.length) return "";
  const rejected = consideredRefs.length ? rejectedRefs : rejectedIds;
  const source = usage.source === "platform" ? "平台记忆" : "个人记忆";
  const adopted = (consideredRefs.length ? usedRefs : used.map(id => `item:${Number(id)}`)).map(experienceRefLabel);
  return `<section class="analysis-experience-usage">
    <div class="analysis-section-title"><i data-lucide="brain-circuit" size="15"></i><strong>经验采用情况</strong><span>${escapeHtml(source)}</span></div>
    <div class="experience-usage-stats"><span>系统候选 <strong>${considered.length}</strong></span><span class="used">模型采用 <strong>${used.length}</strong></span><span>未采用 <strong>${rejected.length}</strong></span></div>
    ${adopted.length ? `<div class="experience-used-list"><span>本次采用</span>${adopted.map(label => `<strong>${escapeHtml(label)}</strong>`).join('')}</div>` : ''}
    <p>${escapeHtml(userVisibleText(usage.influence, used.length ? "本次采用了与当前行情匹配的记忆。" : "模型评估后未采用候选记忆。"))}</p>
  </section>`;
}

function renderDirectionBias(decision) {
  if (decision.bullishScore == null || decision.bearishScore == null) return "";
  return `<section class="direction-bias" aria-label="市场方向倾向">
    <div class="direction-bias-head"><strong>市场方向倾向</strong><span>倾向强弱，不代表胜率</span></div>
    <div class="direction-bias-values"><span class="bullish">偏多 ${decision.bullishScore.toFixed(1)}%</span><span class="bearish">偏空 ${decision.bearishScore.toFixed(1)}%</span></div>
    <div class="direction-bias-track" aria-hidden="true"><i class="bullish" style="width:${decision.bullishScore}%"></i><i class="bearish" style="width:${decision.bearishScore}%"></i></div>
  </section>`;
}

function signalExecutionAdvice(signal) {
  const presented = signal?.execution_advice;
  const localizedPresented = presented ? {
    ...presented,
    title:userVisibleText(presented.title, "执行状态待确认"),
    description:userVisibleText(presented.description, "系统未返回具体执行说明"),
  } : null;
  if (localizedPresented?.state === "pending") return { ...localizedPresented, executable:false };
  const execution = parseJsonField(signal?.execution_result, {});
  if (execution?.status === "success" && execution?.reason === "pending_cancelled") return {
    state:"cancelled",
    title:"旧挂单已取消",
    description:userVisibleText(execution?.details?.pending_action_reason || signal?.pending_action_reason || signal?.decision?.pending_action_reason,
      "策略判断原挂单逻辑已经失效，系统已取消当前策略对应的挂单。"),
    executable:false,
  };
  const persistedStatus = String(signal?.execution_status || "").toLowerCase();
  const pending = Boolean(signal?.pending_ticket)
    || ["pending", "submitted", "placed"].includes(persistedStatus)
    || ["pending", "submitted", "placed"].includes(String(execution?.status || "").toLowerCase());
  if (pending) return {
    state:"pending",
    title:"挂单已提交",
    description:signal?.pending_ticket ? `${bridgePlatformLabel()} 挂单 #${signal.pending_ticket} 正在等待触发。` : `挂单已经发送到 ${bridgePlatformLabel()}，正在等待触发。`,
    executable:false,
  };
  if (signal?.is_executed) return { state:"executed", title:"订单已执行", description:`${bridgePlatformLabel()} 已确认订单执行结果。`, executable:false };
  const terminalStatus = ["rejected", "failed", "skipped", "uncertain"].includes(persistedStatus) ? persistedStatus : "";
  const executionStatus = execution?.status || terminalStatus;
  if (executionStatus && executionStatus !== "success") {
    const rejected = executionStatus === "rejected";
    const skipped = executionStatus === "skipped";
    const brokerRejected = execution?.classification === "broker_rejection";
    return {
      state: rejected ? "rejected" : skipped ? "skipped" : "failed",
      title: brokerRejected ? `${bridgePlatformLabel()} 拒绝订单` : rejected ? "风控未放行" : skipped ? "本次未执行" : "执行未完成",
      description: resultRiskReason(execution) || userVisibleText(execution.message || execution.reason || execution.error, "系统未返回具体原因，请查看风控执行记录"),
      executable: false,
    };
  }
  if (signalIsStale(signal)) return { state:"expired", title:"信号已过期", description:"请重新推理后再执行。", executable:false };
  if (localizedPresented) return localizedPresented;
  if (signalType(signal?.signal_type) === "hold") return { state:"observe", title:"暂不执行", description:"等待市场条件改善。", executable:false };
  return { state:"review", title:"建议复核后执行", description:"执行前将获取最新报价并由风控计算最终手数。", executable:true };
}

function renderCandidateEntryReference(candidate) {
  if (!candidate || typeof candidate !== "object") return "";
  const signalTypeValue = String(candidate.signal_type || "").toLowerCase();
  const typeLabels = {
    buy:"做多市价参考", sell:"做空市价参考",
    buy_limit:"买入限价参考", sell_limit:"卖出限价参考",
    buy_stop:"买入止损参考", sell_stop:"卖出止损参考",
    buy_stop_limit:"买入止损限价参考", sell_stop_limit:"卖出止损限价参考",
  };
  const rows = [
    ["候选入场", candidate.entry_price],
    ["候选止损", candidate.stop_loss_price],
    ["候选止盈", candidate.take_profit_1_price],
  ].filter(([, value]) => Number(value) > 0);
  if (!rows.length) return "";
  return `<section class="candidate-entry-reference">
    <div class="candidate-entry-reference-head"><span><i data-lucide="scan-search" size="15"></i>候选入场参考</span><strong>${escapeHtml(typeLabels[signalTypeValue] || "方向参考")}</strong></div>
    <div>${rows.map(([label, value]) => `<span><small>${label}</small><b>${escapeHtml(priceDisplay(value))}</b></span>`).join("")}</div>
    <p>仅作为后续行情观察依据，当前策略明确建议不加仓，不会进入下单流程。</p>
  </section>`;
}

function renderSignalPendingActions(signal) {
  const actions = Array.isArray(signal?.pending_actions) ? signal.pending_actions : [];
  const managementActions = Array.isArray(signal?.management_actions)
    ? signal.management_actions : (Array.isArray(signal?.position_management_actions) ? signal.position_management_actions : []);
  const managedCancelTickets = new Set(managementActions
    .filter(action => action?.action_type === "pending_cancel" || action?.task_type === "pending_cancel")
    .map(action => String(action?.target_ticket || action?.ticket || "").trim())
    .filter(Boolean));
  const hasManagedCancel = managementActions.some(action => action?.action_type === "pending_cancel" || action?.task_type === "pending_cancel");
  const visibleActions = actions.filter(action => {
    const ticket = String(action?.ticket || "").trim();
    if (hasManagedCancel && !ticket && Number(action?.count || 0) > 0) return false;
    return !ticket || !managedCancelTickets.has(ticket);
  });
  if (!visibleActions.length) return "";
  const labels = {
    cancelled: { title:"挂单已取消", icon:"circle-x" },
    superseded: { title:"旧挂单已取消并替换", icon:"replace" },
    failed: { title:"挂单取消失败", icon:"circle-alert" },
  };
  return `<section class="signal-pending-actions">
    <div class="analysis-section-title"><i data-lucide="list-x" size="15"></i><strong>挂单处理</strong><span>共 ${visibleActions.length} 条</span></div>
    <div class="signal-pending-action-list">${visibleActions.map(action => {
      const actionState = labels[action.status] || labels.cancelled;
      const detail = action.status === "failed"
        ? userVisibleText(action.message, "系统未返回具体失败原因")
        : userVisibleText(action.reason, action.status === "superseded" ? "为执行新信号，已取消同方向旧挂单" : "原挂单条件已经失效");
      const countText = !action.ticket && Number(action.count || 0) > 0 ? ` · ${Number(action.count)} 笔` : "";
      return `<article class="signal-pending-action ${escapeHtml(action.status || "cancelled")}">
        <i data-lucide="${actionState.icon}" size="17"></i>
        <div><strong>${actionState.title}${action.ticket ? ` · #${escapeHtml(action.ticket)}` : countText}</strong><p>${escapeHtml(detail)}</p></div>
      </article>`;
    }).join("")}</div>
  </section>`;
}

function renderSignalManagementActions(signal) {
  const actions = Array.isArray(signal?.management_actions)
    ? signal.management_actions : (Array.isArray(signal?.position_management_actions) ? signal.position_management_actions : []);
  if (!actions.length) return "";
  const pendingOutcomes = Array.isArray(signal?.pending_actions) ? signal.pending_actions : [];
  const effectLabel = action => {
    const effect = String(action?.inference_effect || "display_only");
    const required = Math.max(1, Number(action?.required_confirmations || (action?.action_type === "pending_cancel" ? 1 : 2)));
    const count = Math.max(0, Math.min(required, Number(action?.confirmation_count || 0)));
    if (action?.action_type === "pending_cancel") return effect === "first_confirmation"
      ? "本次建议取消，已进入处理" : "本次建议取消";
    if (effect === "first_confirmation") return `本次第 ${count || 1} 次确认（${count || 1}/${required}）`;
    if (effect === "confirmation_completed") return `本次完成连续确认（${required}/${required}）`;
    if (effect === "confirmation_reset") return `本次继续持有并清零（0/${required}）`;
    if (effect === "invalid_reset") return `本次结果无效并清零（0/${required}）`;
    if (action?.action_type === "pending_cancel") return `本次模型单轮判断成立但未进入自动任务（1/${required}）`;
    return `仅展示本轮建议，未进入连续确认（0/${required}）`;
  };
  const effectTone = action => ({
    first_confirmation:action?.action_type === "pending_cancel" ? "confirmed" : "candidate",
    confirmation_completed:"confirmed",
    confirmation_reset:"completed",
    invalid_reset:"failed",
    display_only:"candidate",
  })[String(action?.inference_effect || "display_only")] || "candidate";
  const actionTitle = action => action?.action_type === "pending_cancel"
    ? "建议取消挂单" : action?.action === "hold" ? "继续持有并清零" : "建议平仓";
  const pendingOutcomeFor = action => {
    if (action?.action_type !== "pending_cancel" || !pendingOutcomes.length) return null;
    const ticket = String(action?.target_ticket || action?.ticket || "").trim();
    return pendingOutcomes.find(item => ticket && String(item?.ticket || "").trim() === ticket)
      || (pendingOutcomes.length === 1 ? pendingOutcomes[0] : null);
  };
  const taskLabel = (action, pendingOutcome = null) => {
    const statusCode = typeof action?.task_status === "string" ? action.task_status : action?.task?.status;
    if (!statusCode && pendingOutcome) return ({
      cancelled:"挂单已取消", superseded:"旧挂单已取消并替换", failed:"取消挂单失败",
    })[String(pendingOutcome.status || "")] || "挂单处理结果已记录";
    if (!statusCode) return "仅显示模型建议";
    return positionManagementStatus(statusCode).label || "状态待确认";
  };
  return `<section class="signal-management-actions">
    <div class="analysis-section-title"><i data-lucide="briefcase-business" size="15"></i><strong>持仓与挂单管理</strong><span>本次推理归因</span></div>
    <div class="signal-management-action-list">${actions.map(action => {
      const type = action?.action_type === "pending_cancel" ? "pending-cancel" : "position-exit";
      const ticket = String(action?.target_ticket || action?.ticket || "").trim();
      const reason = userVisibleText(action?.reason, type === "pending-cancel" ? "原挂单条件已经失效" : "本轮继续依据当前持仓判断");
      const taskStatus = typeof action?.task_status === "string" ? action.task_status : action?.task?.status;
      const pendingOutcome = pendingOutcomeFor(action);
      const taskTone = taskStatus ? positionManagementStatus(taskStatus).tone
        : pendingOutcome?.status === "failed" ? "failed" : pendingOutcome ? "confirmed" : "";
      return `<article class="signal-management-action ${type} ${escapeHtml(String(action?.inference_effect || "display_only"))}">
        <div class="signal-management-action-head"><strong>${actionTitle(action)}</strong><span class="management-state ${escapeHtml(effectTone(action))}">${escapeHtml(effectLabel(action))}</span></div>
        <div class="signal-management-action-meta"><span>目标票号</span><b>${ticket ? `#${escapeHtml(ticket)}` : "票号待同步"}</b><span>处理当前状态</span><b class="management-state ${escapeHtml(taskTone)}">${escapeHtml(taskLabel(action, pendingOutcome))}</b></div>
        <p>${escapeHtml(reason)}</p>
      </article>`;
    }).join("")}</div>
  </section>`;
}

function renderDecisionList(items, emptyText) {
  if (!items?.length) return `<p class="decision-empty">${escapeHtml(emptyText)}</p>`;
  return `<ul>${items.map(item => `<li>${escapeHtml(item)}</li>`).join("")}</ul>`;
}

let _inferenceChart = null;
let _inferenceCandleSeries = null;
let _inferenceChartResizeObserver = null;
let _inferenceChartMutationObserver = null;
let _inferenceChartFrame = null;
let _inferenceChartRenderVersion = 0;
const _signalEvidenceCache = new Map();
const _signalEvidenceFlights = new Map();
const _signalDetailCache = new Map();
const _signalDetailFlights = new Map();
const SIGNAL_EVIDENCE_CACHE_LIMIT = 64;
const SIGNAL_DETAIL_CACHE_LIMIT = 128;

// Keep historical browsing bounded while leaving in-flight requests alone.
// Map insertion order supplies a small LRU without a second dependency.
function getSignalCacheEntry(cache, key) {
  if (!cache.has(key)) return null;
  const value = cache.get(key);
  cache.delete(key);
  cache.set(key, value);
  return value;
}

function setSignalCacheEntry(cache, key, value, limit) {
  cache.delete(key);
  cache.set(key, value);
  while (cache.size > limit) {
    const oldestKey = cache.keys().next().value;
    if (oldestKey === undefined) break;
    cache.delete(oldestKey);
  }
  return value;
}

function inferenceEvidenceCacheKey(signalId, timeframe, snapshotId = null) {
  return `${String(signalId ?? "")}:${String(snapshotId ?? "none")}:${String(timeframe || "").trim().toUpperCase()}`;
}

function destroyInferenceChart() {
  if (_inferenceChartFrame !== null) {
    cancelAnimationFrame(_inferenceChartFrame);
    _inferenceChartFrame = null;
  }
  if (_inferenceChartResizeObserver) {
    _inferenceChartResizeObserver.disconnect();
    _inferenceChartResizeObserver = null;
  }
  if (_inferenceChartMutationObserver) {
    _inferenceChartMutationObserver.disconnect();
    _inferenceChartMutationObserver = null;
  }
  if (_inferenceChart) {
    _inferenceChart.remove();
    _inferenceChart = null;
    _inferenceCandleSeries = null;
  }
}

function inferenceSnapshotContext(signal) {
  const snapshot = signal?.inference_snapshot || {};
  const market = snapshot.market_snapshot && typeof snapshot.market_snapshot === "object"
    ? snapshot.market_snapshot
    : signalMarketData(signal);
  const frames = market?.strategy_context?.timeframes || signalMarketData(signal)?.strategy_context?.timeframes || {};
  const klines = { ...(snapshot.klines || {}) };
  for (const [timeframe, value] of Object.entries(frames)) {
    if (!Array.isArray(klines[timeframe]) && Array.isArray(value?.klines)) klines[timeframe] = value.klines;
  }
  const signalKey = String(signal?.id ?? "");
  for (const timeframe of Array.isArray(snapshot.available_timeframes) ? snapshot.available_timeframes : []) {
    const evidence = getSignalCacheEntry(_signalEvidenceCache, inferenceEvidenceCacheKey(signalKey, timeframe, snapshot.id));
    if (evidence && !Array.isArray(klines[timeframe])) {
      klines[timeframe] = Array.isArray(evidence.klines) ? evidence.klines : [];
    }
  }
  return { snapshot, market, frames, klines };
}

function inferenceRateTime(value) {
  if (typeof value === "number" && Number.isFinite(value)) return Math.floor(value > 1e12 ? value / 1000 : value);
  if (typeof value !== "string" || !value.trim()) return null;
  const numeric = Number(value);
  if (Number.isFinite(numeric) && numeric > 0) return Math.floor(numeric > 1e12 ? numeric / 1000 : numeric);
  const parts = value.trim().replace("T", " ").split(/[- :]/).map(Number);
  if (parts.length < 3 || parts.slice(0, 3).some(item => !Number.isFinite(item))) return null;
  const seconds = Math.floor(Date.UTC(parts[0], parts[1] - 1, parts[2], parts[3] || 0, parts[4] || 0, parts[5] || 0) / 1000);
  return Number.isFinite(seconds) ? seconds : null;
}

function normalizeInferenceRates(rows) {
  const unique = new Map();
  for (const [sourceIndex, raw] of (Array.isArray(rows) ? rows : []).entries()) {
    const row = Array.isArray(raw)
      ? { time: raw[0], open: raw[1], high: raw[2], low: raw[3], close: raw[4], tick_volume: raw[5] }
      : raw;
    const time = inferenceRateTime(row?.time);
    const open = Number(row?.open), high = Number(row?.high), low = Number(row?.low), close = Number(row?.close);
    if (!Number.isFinite(time) || ![open, high, low, close].every(Number.isFinite)) continue;
    if (open <= 0 || high <= 0 || low <= 0 || close <= 0 || high < Math.max(open, close) || low > Math.min(open, close)) continue;
    unique.set(time, { time, open, high, low, close, volume: Math.max(0, Number(row?.tick_volume || row?.volume || 0) || 0), sourceIndex });
  }
  return [...unique.values()].sort((a, b) => a.time - b.time).slice(-500);
}

function legacyInferenceEvidence(signal, timeframe) {
  const context = inferenceSnapshotContext(signal);
  const rows = context.klines?.[timeframe];
  return Array.isArray(rows) && rows.length ? { timeframe, klines: rows.slice(-500), legacy:true } : null;
}

function inferenceEvidenceFor(signal, timeframe) {
  const normalized = String(timeframe || "").trim().toUpperCase();
  const cached = getSignalCacheEntry(
    _signalEvidenceCache,
    inferenceEvidenceCacheKey(signal?.id, normalized, signal?.inference_snapshot?.id),
  );
  if (cached) return cached;
  return legacyInferenceEvidence(signal, normalized);
}

async function ensureInferenceEvidence(signal, timeframe, renderVersion) {
  const normalized = String(timeframe || "").trim().toUpperCase();
  const signalId = Number(signal?.id);
  if (!signalId || !normalized) return null;
  const existing = inferenceEvidenceFor(signal, normalized);
  if (existing) return existing;
  const expectedSnapshotId = Number(signal?.inference_snapshot?.id) || null;
  const key = inferenceEvidenceCacheKey(signalId, normalized, expectedSnapshotId);
  if (_signalEvidenceFlights.has(key)) return _signalEvidenceFlights.get(key);
  const flight = wsApi("signal_evidence", {
    signal_id: signalId, timeframe: normalized, ...(expectedSnapshotId ? { snapshot_id: expectedSnapshotId } : {}),
  })
    .then(data => {
      if (data?.status !== "success") throw new Error(data?.message || data?.code || "signal_evidence_failed");
      const evidence = data.evidence || data;
      if (!Array.isArray(evidence?.klines)) throw new Error("signal_evidence_empty");
      if (expectedSnapshotId && Number(evidence.id || evidence.snapshot_id) !== expectedSnapshotId) {
        throw new Error("snapshot_mismatch");
      }
      const cachedEvidence = setSignalCacheEntry(
        _signalEvidenceCache, key, { ...evidence, timeframe: normalized, klines: evidence.klines.slice(-500) },
        SIGNAL_EVIDENCE_CACHE_LIMIT,
      );
      if (
        String(state.selectedSignal?.id ?? "") === String(signalId)
        && state.inferenceChartTimeframe === normalized
        && $("analysisResult")?.dataset.signalId === String(signalId)
        && $("analysisResult")?.dataset.renderVersion === String(renderVersion)
      ) renderInferenceChart(signal, renderVersion);
      return cachedEvidence;
    })
    .catch(error => {
      if (
        String(state.selectedSignal?.id ?? "") === String(signalId)
        && state.inferenceChartTimeframe === normalized
        && $("analysisResult")?.dataset.signalId === String(signalId)
        && $("analysisResult")?.dataset.renderVersion === String(renderVersion)
      ) {
        const host = $("inferenceKlineChart");
        if (host) host.innerHTML = '<div class="inference-chart-error">当前周期证据暂时读取失败，文字详情仍可查看。</div>';
      }
      console.warn("[Inference] evidence load failed:", error?.message || error);
      return null;
    })
    .finally(() => _signalEvidenceFlights.delete(key));
  _signalEvidenceFlights.set(key, flight);
  return flight;
}

function chanSummaryForTimeframe(context, timeframe) {
  return context.frames?.[timeframe]?.summary?.chan
    || context.market?.strategy_context?.timeframes?.[timeframe]?.summary?.chan
    || null;
}

function inferenceTimeframeMinutes(timeframe) {
  const text = String(timeframe || "").trim().toUpperCase();
  const match = text.match(/^(MN|M|H|D|W)(\d+)$/);
  if (!match) return Number.POSITIVE_INFINITY;
  const value = Number(match[2]);
  const multipliers = { M: 1, H: 60, D: 1440, W: 10080, MN: 43200 };
  return value * multipliers[match[1]];
}

function availableInferenceTimeframes(klines) {
  return Object.entries(klines || {})
    .filter(([, rows]) => normalizeInferenceRates(rows).length > 0)
    .map(([timeframe]) => timeframe)
    .sort((left, right) => inferenceTimeframeMinutes(left) - inferenceTimeframeMinutes(right)
      || String(left).localeCompare(String(right)));
}

function inferenceChartShell(signal) {
  const context = inferenceSnapshotContext(signal);
  const snapshotAvailable = Array.isArray(context.snapshot?.available_timeframes)
    ? context.snapshot.available_timeframes.map(item => String(item || "").toUpperCase()).filter(Boolean)
    : [];
  const available = [...new Set([...snapshotAvailable, ...availableInferenceTimeframes(context.klines)])];
  if (!available.length) {
    return `<section class="inference-chart-panel is-empty" aria-labelledby="inferenceChartTitle">
      <div class="inference-chart-empty"><i data-lucide="candlestick-chart" size="20"></i><div><strong id="inferenceChartTitle">K 线与结构证据</strong><span>本次推理没有保存可视化 K 线，无法还原当时行情。</span></div></div>
    </section>`;
  }
  const signalKey = String(signal?.id ?? `${signal?.symbol || ""}:${signal?.created_at || ""}`);
  if (state.inferenceChartSignalKey !== signalKey) {
    state.inferenceChartSignalKey = signalKey;
    state.inferenceChartTimeframe = available[0];
  } else if (!state.inferenceChartTimeframe || !available.includes(state.inferenceChartTimeframe)) {
    state.inferenceChartTimeframe = available[0];
  }
  const snapshotStatus = context.snapshot?.evidence_status;
  const sourceLabel = ["platform_market_bridge", "platform_admin_bridge"].includes(context.snapshot?.market_source)
    ? "平台默认观摩源行情"
    : "推理时行情";
  const visibleCount = Array.isArray(context.klines[state.inferenceChartTimeframe])
    ? context.klines[state.inferenceChartTimeframe].length
    : Number(context.snapshot?.timeframe_counts?.[state.inferenceChartTimeframe] || 0);
  const evidenceLabel = visibleCount
    ? (snapshotStatus === "incomplete" ? `保留最近 ${Math.min(visibleCount, 500)} 根` : `${Math.min(visibleCount, 500)} 根证据完整`)
    : "正在读取当前周期证据";
  const layerButtons = [
    ["segments", "线段"], ["centers", "中枢"], ["divergence", "背驰"], ["entries", "买卖点"], ["levels", "执行价位"],
  ].map(([key, label]) => `<button type="button" class="inference-layer-btn ${state.inferenceChartLayers[key] ? "active" : ""}" data-inference-layer="${key}" aria-pressed="${state.inferenceChartLayers[key]}">${label}</button>`).join("");
  return `<section id="inferenceChartPanel" class="inference-chart-panel" aria-labelledby="inferenceChartTitle">
    <div class="inference-chart-header">
      <div><span class="analysis-section-title"><i data-lucide="candlestick-chart" size="15"></i><strong id="inferenceChartTitle">K 线与结构证据</strong></span><small>${escapeHtml(sourceLabel)} · ${escapeHtml(evidenceLabel)} · 仅展示推理发生时的数据 · ${bridgePlatformLabel()} 时间 · 最后一根为推理时未收盘 K 线</small></div>
      <button id="inferenceChartFullscreen" type="button" class="chart-icon-btn" aria-label="全屏查看 K 线图" title="全屏查看"><i data-lucide="maximize-2" size="15"></i></button>
    </div>
    <div class="inference-chart-toolbar">
      <div class="inference-timeframe-tabs" role="tablist" aria-label="K 线周期">${available.map(timeframe => `<button type="button" role="tab" aria-selected="${timeframe === state.inferenceChartTimeframe}" class="${timeframe === state.inferenceChartTimeframe ? "active" : ""}" data-inference-timeframe="${escapeHtml(timeframe)}">${escapeHtml(timeframe)}</button>`).join("")}</div>
      <div class="inference-layer-tabs" aria-label="图表图层">${layerButtons}</div>
    </div>
    <div class="inference-chart-stage"><div id="inferenceKlineChart" class="inference-kline-chart" role="img" aria-label="${escapeHtml(signal.symbol)} ${escapeHtml(state.inferenceChartTimeframe)} 推理时 K 线和缠论结构图"></div><div id="inferenceChartCursor" class="inference-chart-cursor" aria-live="polite">移动光标查看 OHLC</div></div>
    <div id="inferenceChartLegend" class="inference-chart-legend"></div>
    <details class="inference-chart-table"><summary>查看最近 K 线数据</summary><div class="table-wrap"><table><thead><tr><th>时间</th><th>开</th><th>高</th><th>低</th><th>收</th></tr></thead><tbody id="inferenceKlineTableBody"></tbody></table></div></details>
  </section>`;
}

function chartIndexTime(candles, value) {
  const index = Number(value);
  if (!Number.isInteger(index) || index < 0) return null;
  return candles.find(item => item.sourceIndex === index)?.time ?? null;
}

function inferenceStructureTime(candles, structure, edge, chan = {}) {
  if (!candles.length || !structure) return null;
  const first = candles[0].time, last = candles.at(-1).time;
  const rawTime = structure[`${edge}_broker_time`] ?? structure[`${edge}_time`];
  const structureTime = inferenceRateTime(rawTime);
  if (Number.isFinite(structureTime) && structureTime >= first && structureTime <= last) {
    const exact = candles.find(item => item.time === structureTime);
    if (exact) return exact.time;
    const nearest = candles.reduce((best, item) => Math.abs(item.time - structureTime) < Math.abs(best.time - structureTime) ? item : best, candles[0]);
    const typicalStep = candles.length > 1 ? Math.max(1, candles.at(-1).time - candles.at(-2).time) : 60;
    if (Math.abs(nearest.time - structureTime) <= typicalStep) return nearest.time;
  }
  // Index fallback is safe only when the visualized array is the same source
  // window used by Chan. Compact display windows have a different index base.
  const sourceCount = Number(chan.received_history_count || chan.raw_bar_count);
  if (sourceCount === candles.length || sourceCount === candles.length - 1) return chartIndexTime(candles, structure[`${edge}_index`]);
  return null;
}

function removeInferenceChartAttribution(container) {
  container.querySelectorAll('#tv-attr-logo, a[href*="tradingview"]').forEach(node => node.remove());
}

function addInferenceLine(chart, points, options) {
  const valid = points.filter(point => Number.isFinite(Number(point?.time)) && Number.isFinite(Number(point?.value)));
  if (valid.length < 2 || valid[0].time === valid[1].time) return false;
  const series = chart.addLineSeries({ lineWidth: 2, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false, ...options });
  series.setData(valid);
  return true;
}

function inferenceChartTimeLabel(seconds) {
  const date = new Date(Number(seconds) * 1000);
  if (!Number.isFinite(date.getTime())) return "--";
  const pad = value => String(value).padStart(2, "0");
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())} ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}`;
}

function inferenceChartTickLabel(seconds) {
  const full = inferenceChartTimeLabel(typeof seconds === "object"
    ? Date.UTC(seconds.year, seconds.month - 1, seconds.day) / 1000
    : seconds);
  return full === "--" ? "--" : full.slice(5);
}

function bindInferenceChartControls(signal, renderVersion) {
  document.querySelectorAll("[data-inference-timeframe]").forEach(button => { button.onclick = () => {
    state.inferenceChartTimeframe = button.dataset.inferenceTimeframe;
    document.querySelectorAll("[data-inference-timeframe]").forEach(item => {
      item.classList.toggle("active", item === button);
      item.setAttribute("aria-selected", String(item === button));
    });
    renderInferenceChart(signal, renderVersion);
  }});
  document.querySelectorAll("[data-inference-layer]").forEach(button => { button.onclick = () => {
    const layer = button.dataset.inferenceLayer;
    state.inferenceChartLayers[layer] = !state.inferenceChartLayers[layer];
    button.classList.toggle("active", state.inferenceChartLayers[layer]);
    button.setAttribute("aria-pressed", String(state.inferenceChartLayers[layer]));
    renderInferenceChart(signal, renderVersion);
  }});
  const fullscreenButton = $("inferenceChartFullscreen");
  if (fullscreenButton) fullscreenButton.onclick = async () => {
    const panel = $("inferenceChartPanel");
    if (!panel) return;
    try {
      if (document.fullscreenElement === panel) await document.exitFullscreen();
      else await panel.requestFullscreen();
    } catch (error) { toast(`无法进入全屏：${error.message}`, "warning"); }
  };
}

function renderInferenceChart(signal, renderVersion) {
  const resultHost = $("analysisResult");
  const signalKey = String(signal?.id ?? "");
  if (
    String(state.selectedSignal?.id ?? "") !== signalKey
    || resultHost?.dataset.signalId !== signalKey
    || resultHost?.dataset.renderVersion !== String(renderVersion)
  ) return;
  destroyInferenceChart();
  const container = $("inferenceKlineChart");
  if (!container) return;
  bindInferenceChartControls(signal, renderVersion);
  if (container.offsetWidth === 0 || container.offsetHeight === 0) {
    _inferenceChartResizeObserver = new ResizeObserver(() => {
      if (container.offsetWidth > 0 && container.offsetHeight > 0) renderInferenceChart(signal, renderVersion);
    });
    _inferenceChartResizeObserver.observe(container);
    return;
  }
  const context = inferenceSnapshotContext(signal);
  const timeframe = state.inferenceChartTimeframe;
  const candles = normalizeInferenceRates(context.klines?.[timeframe]);
  if (!candles.length) {
    const available = Array.isArray(context.snapshot?.available_timeframes)
      ? context.snapshot.available_timeframes : [];
    if (available.includes(timeframe)) {
      container.innerHTML = '<div class="inference-chart-loading">正在读取当前周期冻结证据…</div>';
      ensureInferenceEvidence(signal, timeframe, renderVersion);
    } else {
      container.innerHTML = '<div class="inference-chart-error">K 线数据格式无效，无法绘制。</div>';
    }
    return;
  }
  if (typeof LightweightCharts === "undefined") return;
  if (!inferenceEvidenceFor(signal, timeframe)) {
    // A legacy embedded snapshot may have supplied the rows above. New
    // lightweight details fetch only the selected period on demand.
    ensureInferenceEvidence(signal, timeframe, renderVersion);
    return;
  }
  // Evidence is ready: remove the first-pass loading/error placeholder before
  // Lightweight Charts appends its own canvas and controls.
  container.innerHTML = "";
  const chart = LightweightCharts.createChart(container, {
    width: container.clientWidth || 720,
    height: container.clientHeight || 340,
    layout: { background: { type: "solid", color: "transparent" }, textColor: "#8ea0ba", fontSize: 11, attributionLogo: false },
    grid: { vertLines: { color: "rgba(148,163,184,.055)" }, horzLines: { color: "rgba(148,163,184,.055)" } },
    crosshair: { mode: LightweightCharts.CrosshairMode.Normal, vertLine: { color: "rgba(224,190,68,.34)", style: 2 }, horzLine: { color: "rgba(224,190,68,.34)", style: 2 } },
    rightPriceScale: { borderColor: "rgba(148,163,184,.15)", scaleMargins: { top: .08, bottom: .08 } },
    timeScale: { borderColor: "rgba(148,163,184,.15)", timeVisible: true, secondsVisible: false, rightOffset: 4, tickMarkFormatter: inferenceChartTickLabel },
    localization: { locale: "zh-CN", timeFormatter: inferenceChartTickLabel },
    handleScroll: { vertTouchDrag: false },
  });
  const candleSeries = chart.addCandlestickSeries({ upColor: "#ef5b66", downColor: "#20b486", borderUpColor: "#ef5b66", borderDownColor: "#20b486", wickUpColor: "#ef5b66", wickDownColor: "#20b486" });
  candleSeries.setData(candles.map(({ volume, sourceIndex, ...candle }) => candle));
  _inferenceChart = chart;
  _inferenceCandleSeries = candleSeries;

  const chan = chanSummaryForTimeframe(context, timeframe) || {};
  const legend = [];
  let structureOutsideWindow = false;
  if (state.inferenceChartLayers.segments) {
    const segments = [chan.prev_segment, chan.current_segment, chan.candidate_segment].filter(Boolean);
    let segmentLines = 0;
    for (const segment of segments) {
      const start = inferenceStructureTime(candles, segment, "start", chan), end = inferenceStructureTime(candles, segment, "end", chan);
      if (start == null || end == null) { structureOutsideWindow = true; continue; }
      if (addInferenceLine(chart, [{ time: start, value: Number(segment.start_price) }, { time: end, value: Number(segment.end_price) }], { color: segment.confirmed === false ? "#94a3b8" : "#e8c957", lineStyle: segment.confirmed === false ? 2 : 0 })) segmentLines += 1;
    }
    if (segmentLines) legend.push('<span><i class="legend-line segment"></i>线段</span>');
  }
  if (state.inferenceChartLayers.centers) {
    const center = chan.active_center || chan.latest_center || chan.current_center;
    if (center && Number.isFinite(Number(center.zl)) && Number.isFinite(Number(center.zh))) {
      const start = inferenceStructureTime(candles, center, "start", chan);
      const end = inferenceStructureTime(candles, center, "end", chan);
      if (start == null || end == null) {
        // Never draw a center across an arbitrary latest-60-bar window: that
        // visually asserts a duration which the evidence does not support.
        structureOutsideWindow = true;
      } else {
      addInferenceLine(chart, [{ time: start, value: Number(center.zl) }, { time: end, value: Number(center.zl) }], { color: "#7c8da8", lineStyle: 2, lineWidth: 1 });
      addInferenceLine(chart, [{ time: start, value: Number(center.zh) }, { time: end, value: Number(center.zh) }], { color: "#7c8da8", lineStyle: 2, lineWidth: 1 });
      legend.push('<span><i class="legend-box center"></i>当前中枢区间</span>');
      }
    }
  }
  const markers = [];
  if (state.inferenceChartLayers.divergence) {
    for (const divergence of (chan.recent_divergences || []).slice(-3)) {
      const time = inferenceStructureTime(candles, divergence?.departure_segment, "end", chan);
      if (time == null) { structureOutsideWindow = true; continue; }
      const bottom = divergence.type === "bottom";
      markers.push({ time, position: bottom ? "belowBar" : "aboveBar", color: bottom ? "#30c99b" : "#ff6b76", shape: bottom ? "arrowUp" : "arrowDown", text: bottom ? "底背驰" : "顶背驰" });
    }
    if (markers.length) legend.push('<span><i class="legend-dot divergence"></i>已确认背驰</span>');
  }
  if (state.inferenceChartLayers.entries) {
    const entryLabels = { first_buy: "一买", second_buy: "二买", third_buy: "三买", first_sell: "一卖", second_sell: "二卖", third_sell: "三卖" };
    for (const candidate of (chan.entry_candidates || []).filter(item => item.usable_for_entry).slice(-3)) {
      const time = inferenceStructureTime(candles, candidate?.segment, "end", chan);
      if (time == null) { structureOutsideWindow = true; continue; }
      const buy = candidate.side === "buy";
      markers.push({ time, position: buy ? "belowBar" : "aboveBar", color: "#61a8ff", shape: "circle", text: entryLabels[candidate.type] || "候选点" });
    }
    if ((chan.entry_candidates || []).some(item => item.usable_for_entry)) legend.push('<span><i class="legend-dot entry"></i>可用买卖点候选</span>');
  }
  markers.sort((a, b) => a.time - b.time);
  candleSeries.setMarkers(markers);

  if (state.inferenceChartLayers.levels) {
    const takeProfit = signalTakeProfitSelection(signal);
    const levels = [
      [signal.limit_price || context.market?.latest_price, "AI 入场", "#61a8ff", 0],
      [signal.stop_loss_price, "止损", "#ff6b76", 2],
      [takeProfit.price || signal.take_profit_1_price, "止盈", "#30c99b", 2],
    ];
    for (const [price, title, color, lineStyle] of levels) {
      if (!Number.isFinite(Number(price)) || Number(price) <= 0) continue;
      candleSeries.createPriceLine({ price: Number(price), color, lineWidth: 1, lineStyle, axisLabelVisible: true, title });
    }
    legend.push('<span><i class="legend-line levels"></i>AI 入场 / 止损 / 止盈</span>');
  }
  if (structureOutsideWindow) legend.push('<span class="is-warning"><i data-lucide="info" size="12"></i>旧快照未保存完整结构区间，已隐藏无法精确定位的图层</span>');
  $("inferenceChartLegend").innerHTML = legend.join("") || '<span class="muted">当前周期没有可展示的结构图层</span>';
  initIcons();
  $("inferenceKlineTableBody").innerHTML = candles.slice(-10).reverse().map(item => `<tr><td>${escapeHtml(inferenceChartTimeLabel(item.time))}</td><td>${fmt(item.open, 2)}</td><td>${fmt(item.high, 2)}</td><td>${fmt(item.low, 2)}</td><td>${fmt(item.close, 2)}</td></tr>`).join("");
  $("inferenceChartCursor").textContent = `${timeframe} · ${candles.length} 根 · ${inferenceChartTimeLabel(candles[0].time)} → ${inferenceChartTimeLabel(candles.at(-1).time)}`;
  chart.subscribeCrosshairMove(param => {
    const data = param?.seriesData?.get(candleSeries);
    if (!data) return;
    $("inferenceChartCursor").textContent = `开 ${fmt(data.open, 2)} · 高 ${fmt(data.high, 2)} · 低 ${fmt(data.low, 2)} · 收 ${fmt(data.close, 2)}`;
  });
  chart.timeScale().fitContent();
  removeInferenceChartAttribution(container);
  _inferenceChartMutationObserver = new MutationObserver(() => removeInferenceChartAttribution(container));
  _inferenceChartMutationObserver.observe(container, { childList: true, subtree: true });
  _inferenceChartResizeObserver = new ResizeObserver(() => {
    if (_inferenceChart && container.clientWidth > 0 && container.clientHeight > 0) _inferenceChart.applyOptions({ width: container.clientWidth, height: container.clientHeight });
  });
  _inferenceChartResizeObserver.observe(container);

}

function renderSignal(signal, elapsedMs = null, options = {}) {
  if (!signal) {
    destroyInferenceChart();
    _inferenceChartRenderVersion += 1;
    updateAnalysisExecutionButton(null);
    if (!state.dashboardSignal) updateSignalDisplay(null);
    const emptyResult = $("analysisResult");
    emptyResult.className = "analysis-result muted-block";
    emptyResult.removeAttribute("aria-busy");
    delete emptyResult.dataset.signalId;
    emptyResult.dataset.renderVersion = String(_inferenceChartRenderVersion);
    emptyResult.textContent = "暂无推理记录，选择品种和周期后生成信号";
    setText("analysisLatency", "--");
    setText("signalFreshness", "--");
    return;
  }

  updateAnalysisExecutionButton(signal);
  if (!state.dashboardSignal || sameSignalId(signal.id, state.latestSignalId ?? _lastSignalId)) updateSignalDisplay(signal);
  if (elapsedMs !== null && elapsedMs !== undefined) setText("analysisLatency", `${elapsedMs}ms`);
  else if (!options.keepLatency) setText("analysisLatency", "历史记录");
  setText("signalFreshness", signalFreshness(signal));
  const confidence = confidenceInfo(signal.confidence);
  const dir = signalType(signal.signal_type);
  const signalSourceLabel = strategyDispatchSignalSourceLabel(signal);
  const decision = signalDecision(signal);
  const advice = signalExecutionAdvice(signal);
  const adviceDescription = executionAdviceDescription(advice, decision.executionValidation);
  let executionPayload = signal.execution_result || {};
  if (typeof executionPayload === "string") { try { executionPayload = JSON.parse(executionPayload); } catch { executionPayload = {}; } }
  const finalVolume = executionPayload?.risk?.approved_order?.volume ?? executionPayload?.approved_order?.volume ?? null;
  const takeProfitSelection = signalTakeProfitSelection(signal);
  const rawMarket = signalMarketData(signal);
  // CLOSE signals: market data nested in timeframes.X.summary
  const closeSummary = rawMarket.timeframes ? Object.values(rawMarket.timeframes)[0]?.summary || {} : {};
  const market = dir === "close" ? { ...closeSummary, latest_price: rawMarket.latest_price ?? closeSummary.latest_price } : rawMarket;
  const stopLossDistance = stopLossDistanceSummary(signal, market);
  const account = dir === "close" ? (rawMarket.account || {}) : {};
  // CLOSE: positions from closeContext ({total, details}), others from market.positions
  const positions = dir === "close"
    ? { total_positions: rawMarket.positions?.total ?? "--", symbol_positions: rawMarket.positions?.details?.filter(d => d.symbol === signal.symbol).length ?? "--" }
    : (market.positions || {});
  const result = $("analysisResult");
  const freshnessClass = signal.is_stale ? "expired" : signal.is_executed ? "executed" : "live";
  const reasoningText = userVisibleText(decision.modelDecision?.reasoning || signal.reasoning, "");
  // Try to parse structured positions data (CLOSE signals store JSON array)
  let closePositions = null;
  try {
    const raw = String(signal.analysis || "").trim();
    if (raw.startsWith("[")) { const arr = JSON.parse(raw); if (Array.isArray(arr) && arr.length > 0 && arr[0].ticket) closePositions = arr; }
  } catch {}
  let escapedAnalysis = closePositions ? "" : escapeHtml(userVisibleText(decision.modelDecision?.analysis || signal.analysis, "暂无行情分析"));
  // Build analysis block: table for structured data, plain text otherwise
  let analysisBlock = "";
  if (closePositions) {
    const rows = closePositions.map(p => {
      const actionClass = p.action === 'close' ? 'close-action' : 'hold-action';
      const actionLabel = p.action === 'close' ? '🔴 平仓' : '🟢 持有';
      const raw = p.confidence || 0;
      const pct = (raw > 1 ? raw : raw * 100).toFixed(0);
      const confClass = Number(pct) >= 70 ? 'confidence-high' : Number(pct) >= 40 ? 'confidence-mid' : 'confidence-low';
      const ticket = String(p.ticket);
      return `<tr>
        <td class="num"><a href="#" class="close-ticket-link" onclick="event.preventDefault(); navigateToOrder('${escapeHtml(ticket)}', '${escapeHtml(p.action)}')">#${escapeHtml(ticket)}</a></td>
        <td class="action-col"><span class="${actionClass}">${actionLabel}</span></td>
        <td class="confidence-col"><span class="${confClass}">${pct}%</span></td>
        <td>${escapeHtml(userVisibleText(p.reason, "暂无中文说明"))}</td>
      </tr>`;
    }).join("\n");
    analysisBlock = `<strong>持仓分析</strong>\n<table class="close-analysis-table">
  <thead><tr><th>订单号</th><th>动作</th><th>置信度</th><th>分析理由</th></tr></thead>
  <tbody>${rows}</tbody>
</table>`;
  } else {
    analysisBlock = `<strong>行情分析</strong>\n${escapedAnalysis}`;
  }
  const reasoningBlock = reasoningText ? `\n\n<strong>分析依据</strong>\n${escapeHtml(reasoningText)}` : "";
  destroyInferenceChart();
  const renderVersion = ++_inferenceChartRenderVersion;
  result.className = "analysis-result";
  result.removeAttribute("aria-busy");
  result.dataset.signalId = String(signal.id);
  result.dataset.renderVersion = String(renderVersion);
  result.innerHTML = `
    <div class="analysis-summary-head">
      <div class="analysis-summary-title">
        <span class="analysis-symbol">${escapeHtml(signal.symbol)}</span>
        <span class="signal-tf-badge" title="${escapeHtml(timeframeHelp(signal.timeframe))}">${escapeHtml(signal.timeframe)}</span>
        <span class="analysis-direction-badge ${dir}">${directionText(signal.signal_type)}</span>
        ${signalSourceLabel ? `<span class="signal-source-badge admin-strategy-dispatch-source">${escapeHtml(signalSourceLabel)}</span>` : ""}
      </div>
        <span class="analysis-time num">#${escapeHtml(signal.id)} · ${escapeHtml(signalDisplayTime(signal))}</span>
    </div>
    <section class="execution-advice-hero ${escapeHtml(advice.state || "review")}">
      <div class="execution-advice-icon"><i data-lucide="${advice.executable ? "send" : dir === "hold" ? "pause" : "shield-check"}" size="20"></i></div>
      <div><span>执行建议</span><strong>${escapeHtml(advice.title || executionStatus(signal))}</strong><p>${escapeHtml(adviceDescription)}</p></div>
      <span class="analysis-direction-badge ${dir}">${directionText(signal.signal_type)}</span>
    </section>
    ${renderSignalManagementActions(signal)}
    ${renderSignalPendingActions(signal)}
    <div class="decision-summary"><span>一句话结论</span><strong>${escapeHtml(decision.summary)}</strong></div>
    ${renderDirectionBias(decision)}
    ${renderCandidateEntryReference(decision.candidateEntry)}
    <div class="analysis-status-strip">
      <div><span>置信度</span><strong>${confidence.label}</strong></div>
      <div><span>AI 仓位档位</span><strong>${escapeHtml(positionSizeAdvice(signal).text)}</strong></div>
      <div><span>风控最终手数</span><strong>${finalVolume == null ? "待执行时计算" : escapeHtml(volumeText(finalVolume))}</strong></div>
      <div><span>有效期</span><strong id="analysisValidity" class="status-tag ${freshnessClass}">${escapeHtml(signalFreshness(signal))}</strong></div>
      <div><span>执行状态</span><strong class="status-tag ${freshnessClass}">${escapeHtml(executionStatus(signal))}</strong></div>
    </div>
    ${renderPendingSignalInfo(signal, market)}
    <div class="signal-detail-grid execution-prices execution-targets">
      <div class="execution-price-item"><span>${signal.entry_method === "market" ? "参考市价" : "计划入场"}</span><strong>${escapeHtml(signal.limit_price || market.latest_price || "--")}</strong></div>
      <div class="execution-price-item"><span>止损保护</span><strong>${escapeHtml(signal.stop_loss_price || "--")}</strong>${stopLossDistance ? `<small>${escapeHtml(stopLossDistance)}</small>` : ""}</div>
      <div class="execution-target-primary"><span>${takeProfitSelection.price ? "实际执行止盈" : "计划执行止盈"}</span><strong>${escapeHtml(takeProfitSelection.price || (takeProfitSelection.tier ? signal[`take_profit_${takeProfitSelection.tier}_price`] : null) || "--")}</strong><small>${escapeHtml(takeProfitSelection.sourceLabel)}${takeProfitSelection.tier ? ` · TP${takeProfitSelection.tier}` : ""}</small></div>
      <div class="take-profit-candidates"><span class="take-profit-heading">止盈候选 <small><i></i>AI 推荐</small></span><div>${[1,2,3].map(tier => `<span class="take-profit-chip ${takeProfitSelection.tier === tier ? "selected" : ""} ${takeProfitSelection.recommendedTier === tier ? "recommended" : ""}"><b>TP${tier}</b><strong>${escapeHtml(signal[`take_profit_${tier}_price`] || "--")}</strong></span>`).join("")}</div></div>
    </div>
    <div class="decision-evidence-grid">
      <section><div class="analysis-section-title"><i data-lucide="check-circle-2" size="15"></i>关键依据</div>${renderDecisionList(decision.reasons, "详细依据请展开下方分析")}</section>
      <section><div class="analysis-section-title"><i data-lucide="triangle-alert" size="15"></i>市场风险</div>${renderDecisionList(decision.risks, "未识别到额外市场风险")}</section>
    </div>
    ${renderExperienceUsage(signal, decision.experienceUsage)}
    ${(decision.trigger || decision.invalidation) ? `<div class="decision-conditions">${decision.trigger ? `<div><span>触发条件</span><strong>${escapeHtml(decision.trigger)}</strong></div>` : ""}${decision.invalidation ? `<div><span>失效条件</span><strong>${escapeHtml(decision.invalidation)}</strong></div>` : ""}</div>` : ""}
    ${inferenceChartShell(signal)}
    <div class="analysis-section">
      <div class="analysis-section-title"><i data-lucide="file-text" size="14"></i>分析正文</div>
    </div>
    <div id="analysisTextContent" class="analysis-text">${analysisBlock}${reasoningBlock}</div>
    <div class="analysis-expand-row">
      <button class="btn-expand-analysis" type="button" data-action="toggle-analysis-text">收起分析正文</button>
    </div>
  `;
  highlightActiveAnalysis(signal.id);
  initIcons();
  _inferenceChartFrame = requestAnimationFrame(() => {
    _inferenceChartFrame = null;
    renderInferenceChart(signal, renderVersion);
  });
}

function setManualInferenceModal(open) {
  if (open && isObserverMode()) { toast(observerMessage(), "warning"); return; }
  const modal = $("manualInferenceModal");
  if (!modal) return;
  modal.classList.toggle("hidden", !open);
  document.body.classList.toggle("modal-open", open);
  if (open) {
    if (state.manualAnalysisJob && !manualAnalysisJobIsTerminal(state.manualAnalysisJob)) {
      renderManualAnalysisJobStatus(state.manualAnalysisJob);
    }
    setTimeout(() => $("analyzeStrategy")?.focus(), 0);
  }
}

function manualAnalysisJobStatus(job) {
  return String(job?.status || job?.job_status || "queued").trim().toLowerCase();
}

function manualAnalysisJobIsTerminal(job) {
  return MANUAL_ANALYSIS_TERMINAL_STATUSES.has(manualAnalysisJobStatus(job));
}

function manualAnalysisJobMatches(job, { sessionId = "default", strategyId, symbol } = {}) {
  if (!job?.id) return false;
  const jobStrategyId = Number(job.strategy_id ?? job.params?.strategy_id);
  const jobSymbol = String(job.symbol ?? job.params?.symbol ?? "").trim().toUpperCase();
  return String(job.session_id ?? job.params?.session_id ?? "default") === String(sessionId)
    && jobStrategyId === Number(strategyId)
    && jobSymbol === String(symbol || "").trim().toUpperCase();
}

function readManualAnalysisTask() {
  try {
    const raw = localStorage.getItem(MANUAL_ANALYSIS_TASK_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return parsed && parsed.id ? parsed : null;
  } catch {
    return null;
  }
}

function persistManualAnalysisTask(job) {
  if (!job?.id) return;
  try {
    localStorage.setItem(MANUAL_ANALYSIS_TASK_STORAGE_KEY, JSON.stringify({
      id: job.id,
      status: manualAnalysisJobStatus(job),
      session_id: job.session_id ?? job.params?.session_id ?? "default",
      strategy_id: job.strategy_id ?? job.params?.strategy_id ?? null,
      symbol: job.symbol ?? job.params?.symbol ?? null,
      user_id: state.user?.id ?? null,
      updated_at: new Date().toISOString(),
    }));
  } catch {
    // localStorage is an enhancement; a blocked storage context must not stop analysis.
  }
}

function clearManualAnalysisTask() {
  try { localStorage.removeItem(MANUAL_ANALYSIS_TASK_STORAGE_KEY); } catch {}
}

function stopManualAnalysisPolling() {
  if (state.manualAnalysisPollTimer) clearTimeout(state.manualAnalysisPollTimer);
  state.manualAnalysisPollTimer = null;
  state.manualAnalysisPollGeneration += 1;
}

function manualAnalysisResultSignal(job) {
  let result = job?.result;
  if (typeof result === "string") {
    try { result = JSON.parse(result); } catch { result = null; }
  }
  const signal = result?.signal || result?.result?.signal || result?.signal_data || job?.signal;
  if (signal && typeof signal === "object") return signal;
  return result && typeof result === "object" && result.id != null ? result : null;
}

function manualAnalysisErrorMessage(value) {
  if (value === null || value === undefined || value === "") return "";
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return apiErrorMessage(String(value));
  }
  if (typeof value === "object") {
    const nested = value.error && value.error !== value ? value.error : null;
    if (nested) {
      const nestedMessage = manualAnalysisErrorMessage(nested);
      if (nestedMessage) return nestedMessage;
    }
    const code = value.code ?? value.error_code ?? value.reason_code ?? "";
    const message = value.message ?? value.detail ?? value.reason ?? "";
    const combined = [code, message]
      .map(item => typeof item === "string" || typeof item === "number" ? String(item).trim() : "")
      .filter(Boolean)
      .filter((item, index, items) => items.indexOf(item) === index)
      .join("：");
    if (combined) return apiErrorMessage(combined);
  }
  return "后台分析未完成，请重新分析";
}

function manualAnalysisStatusTitle(status) {
  return {
    succeeded: "后台分析已完成",
    failed: "后台分析失败",
    cancelled: "后台分析已取消",
    status_unknown: "后台分析状态未知",
    completed_stale: "后台分析结果已过期",
    expired: "后台分析任务已过期",
  }[status] || "后台分析失败";
}

function manualAnalysisStatusDetail(status, errorMessage = "") {
  if (status === "status_unknown") return "服务商状态暂时无法确认，为避免重复调用未自动重试。";
  if (status === "completed_stale") return "后台分析结果已过期，为避免使用过期建议未自动重试，请重新分析。";
  if (status === "expired") return "后台分析任务已过期，为避免重复调用未自动重试，请重新分析。";
  if (status === "cancelled") return "本次后台分析已取消，没有生成交易建议。";
  if (status === "succeeded") return "交易建议已生成，正在刷新分析结果。";
  return errorMessage || "后台分析未完成，请检查原因后重试。";
}

function renderManualAnalysisJobStatus(job, { errorMessage = "" } = {}) {
  const statusEl = $("manualInferenceStatus");
  if (!statusEl) return;
  const status = manualAnalysisJobStatus(job);
  const terminal = manualAnalysisJobIsTerminal(job);
  const active = !terminal && ["queued", "running"].includes(status);
  const failure = status === "failed" || status === "cancelled" || status === "status_unknown" || status === "completed_stale" || status === "expired";
  const title = active ? "后台分析中" : manualAnalysisStatusTitle(status);
  const detail = active ? "任务已在后台继续执行，可以关闭窗口；关闭窗口不会取消任务。" : manualAnalysisStatusDetail(status, errorMessage);
  statusEl.className = `manual-inference-status ${active ? "is-background" : failure ? "is-error" : "is-complete"}`;
  statusEl.innerHTML = `<span class="${active ? "status-spinner" : "status-state-mark"}" aria-hidden="true"></span><div><strong>${escapeHtml(title)}</strong><small>${escapeHtml(detail)}</small></div>`;
  statusEl.classList.remove("hidden");
  $("manualInferenceAbort")?.classList.toggle("hidden", !active);
  if (active) {
    $("runAnalysisBtn").disabled = true;
    $("manualInferenceClose").disabled = false;
    $("manualInferenceCancel").disabled = false;
  } else if (!state.manualAnalysisSubmitting) {
    $("runAnalysisBtn").disabled = false;
    $("manualInferenceClose").disabled = false;
    $("manualInferenceCancel").disabled = false;
  }
  initIcons();
}

async function applyManualAnalysisSignal(best, elapsedMs = null, { autoExecute = false, announce = true } = {}) {
  if (!best) throw new Error("未返回有效信号");
  if (best.id != null) {
    state.latestSignalId = best.id;
    _lastSignalId = best.id;
    setAnalysisSelectionIntent(best.id, { source:"manual", followLatest:true });
  }
  renderSignal(best, elapsedMs);
  setManualInferenceModal(false);
  showSignalNotification(best);
  await loadSignals({ skipResultRender:true, loadDashboard:false });
  const firstItem = document.querySelector(".analysis-history-item");
  if (firstItem) firstItem.scrollIntoView({ behavior: "smooth", block: "nearest" });
  if (!announce) return;
  const elapsed = Number(elapsedMs);
  if (autoExecute && best.signal_type !== "hold" && !best.auto_executed) toast("信号已生成，但自动执行未完成；请查看风控决策与拒绝原因", "warning");
  else toast(autoExecute && best.auto_executed ? `信号已生成并通过风控执行，耗时 ${(elapsed/1000).toFixed(1)}s` : Number.isFinite(elapsed) ? `信号已生成，耗时 ${(elapsed/1000).toFixed(1)}s` : "信号已生成", "success");
}

async function finishManualAnalysisJob(job, { announce = true } = {}) {
  const status = manualAnalysisJobStatus(job);
  stopManualAnalysisPolling();
  if (status === "succeeded") {
    const best = manualAnalysisResultSignal(job);
    if (!best) {
      const failedJob = { ...job, status:"failed", error:"manual_analysis_result_missing" };
      state.manualAnalysisJob = null;
      clearManualAnalysisTask();
      renderManualAnalysisJobStatus(failedJob, { errorMessage:"任务已结束，但没有返回有效交易建议，请重新分析。" });
      if (announce) toast("后台分析未返回有效交易建议，请重新分析", "error");
      return;
    }
    state.manualAnalysisJob = null;
    clearManualAnalysisTask();
    const elapsedMs = Number(job.elapsed_ms ?? job.duration_ms ?? job.metrics?.elapsed_ms);
    await applyManualAnalysisSignal(best, Number.isFinite(elapsedMs) ? elapsedMs : null, { announce:false });
    if (announce) toast(Number.isFinite(elapsedMs) ? `后台分析完成，耗时 ${(elapsedMs / 1000).toFixed(1)}s` : "后台分析完成，交易建议已生成", "success");
    return;
  }
  const terminalJob = { ...job, status };
  state.manualAnalysisJob = null;
  clearManualAnalysisTask();
  const errorMessage = manualAnalysisErrorMessage(job.error || job.error_code || "");
  renderManualAnalysisJobStatus(terminalJob, { errorMessage });
  if (announce) {
    const statusMessage = manualAnalysisStatusDetail(status, errorMessage);
    toast(status === "cancelled" ? "后台分析已取消" : status === "status_unknown" ? statusMessage : `${manualAnalysisStatusTitle(status)}：${statusMessage}`, status === "cancelled" ? "info" : "error");
  }
}

function scheduleManualAnalysisPoll(job, { announce = true } = {}) {
  if (!job?.id || manualAnalysisJobIsTerminal(job)) {
    if (job?.id && manualAnalysisJobIsTerminal(job)) void finishManualAnalysisJob(job, { announce });
    return;
  }
  stopManualAnalysisPolling();
  state.manualAnalysisJob = job;
  persistManualAnalysisTask(job);
  renderManualAnalysisJobStatus(job);
  const generation = state.manualAnalysisPollGeneration;
  const poll = async () => {
    if (generation !== state.manualAnalysisPollGeneration || !state.manualAnalysisJob?.id) return;
    try {
      const response = await api(`/api/ai/manual-analysis/jobs/${encodeURIComponent(job.id)}`, { timeout:20000 });
      const next = response.job || response;
      if (generation !== state.manualAnalysisPollGeneration) return;
      state.manualAnalysisJob = next;
      if (manualAnalysisJobIsTerminal(next)) {
        await finishManualAnalysisJob(next, { announce });
        return;
      }
      persistManualAnalysisTask(next);
      renderManualAnalysisJobStatus(next);
    } catch (error) {
      if (generation !== state.manualAnalysisPollGeneration) return;
      if (Number(error?.status) === 404) {
        await finishManualAnalysisJob({ ...job, status:"failed", error:"manual_analysis_job_missing" }, { announce });
        return;
      }
      renderManualAnalysisJobStatus(state.manualAnalysisJob || job, { errorMessage:"暂时无法读取任务状态，系统会自动重试。" });
    }
    if (generation === state.manualAnalysisPollGeneration && state.manualAnalysisJob?.id) {
      state.manualAnalysisPollTimer = setTimeout(poll, MANUAL_ANALYSIS_POLL_INTERVAL_MS);
    }
  };
  state.manualAnalysisPollTimer = setTimeout(poll, MANUAL_ANALYSIS_POLL_INTERVAL_MS);
}

async function restoreManualAnalysisJob() {
  const stored = readManualAnalysisTask();
  if (!stored?.id) return;
  if (stored.user_id && state.user?.id && Number(stored.user_id) !== Number(state.user.id)) {
    clearManualAnalysisTask();
    return;
  }
  state.manualAnalysisJob = stored;
  if (manualAnalysisJobIsTerminal(stored)) {
    clearManualAnalysisTask();
    state.manualAnalysisJob = null;
    return;
  }
  scheduleManualAnalysisPoll(stored, { announce:true });
}

async function cancelManualAnalysisJob() {
  const job = state.manualAnalysisJob;
  if (!job?.id || manualAnalysisJobIsTerminal(job) || state.manualAnalysisCancelling) return;
  if (!await showConfirm("确认取消后台分析", "取消后本次任务不会继续调用模型，也不会生成交易建议。", { confirmText:"确认取消", danger:true })) return;
  state.manualAnalysisCancelling = true;
  $("manualInferenceAbort").disabled = true;
  try {
    const response = await api(`/api/ai/manual-analysis/jobs/${encodeURIComponent(job.id)}`, { method:"DELETE", timeout:20000 });
    const cancelled = response.job || { ...job, status:"cancelled" };
    stopManualAnalysisPolling();
    state.manualAnalysisJob = null;
    clearManualAnalysisTask();
    renderManualAnalysisJobStatus({ ...cancelled, status:"cancelled" });
    toast("后台分析已取消", "info");
  } catch (error) {
    toast(error.message, "error");
    renderManualAnalysisJobStatus(job);
  } finally {
    state.manualAnalysisCancelling = false;
    $("manualInferenceAbort")?.removeAttribute("disabled");
  }
}

async function runManualAnalysisAsync({ strategyId, symbol }) {
  if (state.manualAnalysisSubmitting) return;
  const active = state.manualAnalysisJob && !manualAnalysisJobIsTerminal(state.manualAnalysisJob)
    ? state.manualAnalysisJob : null;
  const stored = readManualAnalysisTask();
  const existing = active || (stored && !manualAnalysisJobIsTerminal(stored) ? stored : null);
  if (existing) {
    if (manualAnalysisJobMatches(existing, { strategyId, symbol })) {
      state.manualAnalysisJob = existing;
      scheduleManualAnalysisPoll(existing);
      toast("已有后台分析任务，已继续跟踪", "info");
    } else {
      toast("已有其他后台分析任务正在运行，请等待完成或先取消", "warning");
    }
    return;
  }

  state.manualAnalysisSubmitting = true;
  $("runAnalysisBtn").disabled = true;
  $("executeSignalBtn").disabled = true;
  $("manualInferenceClose").disabled = false;
  $("manualInferenceCancel").disabled = false;
  setText("analysisLatency", "后台分析中");
  setText("signalFreshness", "等待结果");
  renderManualAnalysisJobStatus({ status:"running" });
  // One explicit replay key per intentional UI invocation. Keep it stable for
  // this request even if the inline call waits or the browser disconnects.
  const requestId = globalThis.crypto?.randomUUID?.() || `manual-analysis-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  try {
    const response = await api("/api/ai/manual-analysis/jobs", {
      method:"POST",
      body:{ session_id:"default", strategy_id:strategyId, symbol, include_positions:false, auto_execute:false, request_id:requestId },
      timeout:20000,
    });
    const job = response.job || response;
    if (!job?.id) throw new Error("后台分析任务未返回任务编号");
    state.manualAnalysisJob = job;
    persistManualAnalysisTask(job);
    if (manualAnalysisJobIsTerminal(job)) await finishManualAnalysisJob(job);
    else scheduleManualAnalysisPoll(job);
  } catch (error) {
    state.manualAnalysisJob = null;
    clearManualAnalysisTask();
    setText("analysisLatency", "--");
    setText("signalFreshness", "--");
    renderManualAnalysisJobStatus({ status:"failed" }, { errorMessage:error.message });
    toast(error.message, "error");
  } finally {
    state.manualAnalysisSubmitting = false;
    if (!state.manualAnalysisJob) {
      $("runAnalysisBtn").disabled = false;
      $("manualInferenceAbort")?.classList.add("hidden");
    }
    initIcons();
  }
}

async function runAnalysis() {
  if (getSelectedModelIds().length >= 2) { return runAnalysisCompare(); }
  const symbol = $("analyzeSymbol").value;
  const strategyId = Number($("analyzeStrategy")?.value || 0);
  const autoExecute = Boolean($("manualAutoExecute")?.checked);
  if (!strategyId) {
    toast("请选择交易策略", "warning");
    $("analyzeStrategy")?.focus();
    return;
  }
  if (!symbol) {
    toast("请选择策略支持的品种", "warning");
    return;
  }

  if (state.marketTradeMode === 0) {
    toast("当前市场休市，暂无法推理", "warning");
    return;
  }

  if (autoExecute && !await showConfirm("确认本次自动执行", `策略生成的非观望信号将立即经过风控并尝试下单。\n\n策略：${$("analyzeStrategy").selectedOptions[0]?.textContent || strategyId}\n品种：${symbol}`, { confirmText:"确认推理并自动执行", danger:true })) return;

  if (!autoExecute) return runManualAnalysisAsync({ strategyId, symbol });

  $("runAnalysisBtn").disabled = true;
  $("executeSignalBtn").disabled = true;
  const statusEl = $("manualInferenceStatus");
  statusEl?.classList.remove("hidden");
  $("manualInferenceAbort")?.classList.add("hidden");
  $("manualInferenceClose").disabled = true;
  $("manualInferenceCancel").disabled = true;
  setText("analysisLatency", "推理中");
  setText("signalFreshness", "等待结果");
  const started = performance.now();

  try {
    const result = await wsApi("analyze", {
      session_id: "default", strategy_id:strategyId, symbol,
      include_positions: false, auto_execute:autoExecute, _timeout:modelTaskAttemptTransportTimeoutMs("manual_analysis"),
    });
    const best = result?.signal;
    if (!best) throw new Error("未返回有效信号");
    const elapsed = Math.round(performance.now() - started);
    await applyManualAnalysisSignal(best, elapsed, { autoExecute });
  } catch (error) {
    setText("analysisLatency", "--");
    setText("signalFreshness", "--");
    toast(error.message, "error");
  } finally {
    statusEl?.classList.add("hidden");
    $("manualInferenceClose").disabled = false;
    $("manualInferenceCancel").disabled = false;
    $("runAnalysisBtn").disabled = false;
    initIcons();
  }
}

async function populateModelCompareSelect() {
  const group = $("modelCompareCheckboxGroup");
  const hint = $("modelCompareHint");
  const container = group?.closest(".model-compare-select");
  if (!group) return;
  if (state.user?.role !== "admin") { container?.classList.add("hidden"); return; }
  if (!state.modelProfiles?.length) {
    try {
      const data = await api(`/api/ai/model-profiles${profileScopeQuery()}`);
      state.modelProfiles = data.profiles || [];
    } catch { state.modelProfiles = []; }
  }
  const profiles = (state.modelProfiles || []).filter(p => p.status === "active");
  if (!profiles.length) { container?.classList.add("hidden"); return; }
  group.innerHTML = profiles.map((p, i) => `<label><input type="checkbox" value="${Number(p.id)}" data-compare-model ${i === 0 ? "checked" : ""}><span>${escapeHtml(p.model_name)}</span><small>${escapeHtml(modelProviderLabel(p.provider))}</small></label>`).join("");
  container?.classList.remove("hidden");
  const checkboxes = group.querySelectorAll("[data-compare-model]");
  const updateHint = () => {
    const count = getSelectedModelIds().length;
    if (hint) { hint.textContent = count >= 2 ? `对比模式已激活（${count} 个模型）` : count === 1 ? "再选至少 1 个模型开启对比" : "勾选 ≥2 个模型开启对比推理"; hint.classList.toggle("active", count >= 2); }
  };
  checkboxes.forEach(cb => cb.addEventListener("change", updateHint));
  updateHint();
  initIcons();
}

function getSelectedModelIds() {
  return [...document.querySelectorAll("[data-compare-model]:checked")].map(cb => Number(cb.value)).filter(id => id > 0);
}

function setCompareResultsModal(open) {
  const modal = $("compareResultsModal");
  if (!modal) return;
  modal.classList.toggle("hidden", !open);
  document.body.classList.toggle("modal-open", open);
}

async function runAnalysisCompare() {
  const symbol = $("analyzeSymbol").value;
  const strategyId = Number($("analyzeStrategy")?.value || 0);
  const modelIds = getSelectedModelIds();
  if (!strategyId) { toast("请选择交易策略", "warning"); $("analyzeStrategy")?.focus(); return; }
  if (!symbol) { toast("请选择策略支持的品种", "warning"); return; }
  if (modelIds.length < 2) { toast("对比模式至少需要选择 2 个模型", "warning"); return; }

  $("runAnalysisBtn").disabled = true;
  const statusEl = $("manualInferenceStatus");
  statusEl?.classList.remove("hidden");
  $("manualInferenceClose").disabled = true;
  $("manualInferenceCancel").disabled = true;
  setText("analysisLatency", "对比推理中");
  setText("signalFreshness", "等待结果");
  const started = performance.now();

  try {
    const result = await wsApi("compare", {
      session_id: "default", strategy_id: strategyId, symbol,
      model_ids: modelIds, _timeout:modelTaskAttemptTransportTimeoutMs("model_compare"),
    });
    const elapsed = Math.round(performance.now() - started);
    setManualInferenceModal(false);
    renderCompareResults(result, elapsed);
    setCompareResultsModal(true);
    toast(`对比推理完成，${(result?.results || []).length} 个模型返回结果，耗时 ${(elapsed/1000).toFixed(1)}s`, "success");
  } catch (error) {
    setText("analysisLatency", "--");
    setText("signalFreshness", "--");
    toast(error.message, "error");
  } finally {
    statusEl?.classList.add("hidden");
    $("manualInferenceClose").disabled = false;
    $("manualInferenceCancel").disabled = false;
    $("runAnalysisBtn").disabled = false;
    initIcons();
  }
}

function renderCompareResults(result, elapsedMs) {
  const body = $("compareResultsBody");
  if (!body) return;
  const results = result?.results || [];
  const models = result?.models || {};
  if (!results.length) { body.innerHTML = '<div style="text-align:center;padding:24px;color:var(--text-muted)">所有模型均未返回有效结果</div>'; return; }

  let summaryHtml = `<div class="compare-summary-bar"><strong>共 ${results.length} 个模型</strong>`;
  const dirCounts = {};
  results.filter(r => !r.error && r.status !== "error").forEach(r => {
    const signal = r.signal || r;
    const d = signalType(signal.signal_type);
    dirCounts[d] = (dirCounts[d] || 0) + 1;
  });
  Object.entries(dirCounts).forEach(([dir, count]) => { summaryHtml += `<span>${directionText(dir)} × ${count}</span>`; });
  if (elapsedMs) summaryHtml += `<span>耗时 ${(elapsedMs/1000).toFixed(1)}s</span>`;
  summaryHtml += '</div>';

  const cardsHtml = results.map(r => {
    const signal = r.signal || r;
    const dir = signalType(signal.signal_type);
    const conf = confidenceInfo(signal.confidence);
    const modelName = r.model_name || models[r.model_id]?.model_name || `模型 #${r.model_id}`;
    const provider = r.provider || models[r.model_id]?.provider || "";
    const analysis = escapeHtml(userVisibleText(signal.analysis, "暂无分析"));
    const reasoning = userVisibleText(signal.reasoning, "");
    if (r.error) {
      return `<div class="compare-card"><div class="compare-card-head"><span class="compare-card-model">${escapeHtml(modelName)}</span><span class="compare-card-provider">${escapeHtml(modelProviderLabel(provider))}</span></div><div class="compare-card-error">${escapeHtml(userVisibleText(r.error, "模型分析失败，详细信息已记录"))}</div></div>`;
    }
    return `<div class="compare-card">
      <div class="compare-card-head"><span class="compare-card-model">${escapeHtml(modelName)}</span><span class="compare-card-direction ${dir}">${directionText(signal.signal_type)}</span></div>
      <div class="compare-card-provider">${escapeHtml(modelProviderLabel(provider))}</div>
      <div class="compare-card-row"><span>置信度</span><span>${conf.label}</span></div>
      <div class="compare-card-row"><span>当前价</span><span>${r.latest_price ?? result?.market_snapshot?.latest_price ?? "--"}</span></div>
      <div class="compare-card-analysis"><strong>行情分析</strong>\n${analysis}${reasoning ? `\n\n<strong>分析依据</strong>\n${escapeHtml(reasoning)}` : ""}</div>
    </div>`;
  }).join("");

  body.innerHTML = summaryHtml + `<div class="compare-cards-grid">${cardsHtml}</div>`;
  initIcons();
}

async function executeSignal() {
  if (!state.selectedSignal) return;
  const currentDir = signalType(state.selectedSignal.signal_type);
  const advice = signalExecutionAdvice(state.selectedSignal);
  if (advice.executable !== true || state.selectedSignal.is_stale || state.selectedSignal.is_executed || currentDir === "hold") {
    toast(executionStatus(state.selectedSignal), "warning");
    return;
  }
  const dir = signalType(state.selectedSignal.signal_type).toUpperCase();
  const ok = await showConfirm("复核执行信号", `复核执行 AI 信号 #${state.selectedSignal.id}（${state.selectedSignal.symbol} ${dir}）？后台会重取报价并检查有效期。`, { confirmText: "确认执行" });
  if (!ok) return;

  try {
    const result = await wsApi("execute", { session_id: "default", signal_id: state.selectedSignal.id, confirm: true });
    state.selectedSignal.execution_result = result;
    state.selectedSignal.execution_advice = {
      state: result.status === "success" ? (state.selectedSignal.entry_method === "market" ? "executed" : "pending") : (result.status === "rejected" ? "rejected" : "failed"),
      title: result.status === "success" ? (state.selectedSignal.entry_method === "market" ? "订单已执行" : "挂单已提交") : (result.status === "rejected" ? "风控未放行" : "执行未完成"),
      description: localizeReason(result.message) || (result.status === "success" ? "执行结果已记录。" : "请查看风控中心中的具体原因。"),
      executable: false,
    };
    if (result.status === "success") state.selectedSignal.is_executed = state.selectedSignal.entry_method === "market";
    renderSignal(state.selectedSignal, null, { keepLatency:true });
    toast(localizeReason(result.message) || (result.status === "success" ? "执行请求已处理" : `结果：${result.status}`), result.status === "success" ? "success" : "warning");
    await Promise.allSettled([loadPositions(), loadAccount(), loadSignals({ skipResultRender:true, loadDashboard:false })]);
  } catch (error) {
    toast(localizeReason(error.message), "error");
  }
}

function orderSideLabel(orderType) {
  return orderType === "buy" ? "买入" : "卖出";
}

function inferPointSize(symbol, price) {
  if (String(symbol || "").toUpperCase().includes("XAU")) return 0.01;
  const text = String(price || "");
  const decimals = text.includes(".") ? text.split(".")[1].length : 5;
  return 10 ** -Math.min(Math.max(decimals, 1), 6);
}

function manualTargetPrice(inputId, label) {
  const text = $(inputId)?.value.trim() || "";
  if (!text) return null;
  const price = Number(text);
  if (!Number.isFinite(price) || price <= 0) throw new Error(`${label}必须是有效价格`);
  return price;
}

function targetPriceToPoints(orderType, targetPrice, targetKind, quote) {
  if (targetPrice === null || targetPrice === undefined) return null;
  const entry = orderType === "buy" ? quote.ask : quote.bid;
  const point = inferPointSize(quote.symbol, entry);
  const distance = targetKind === "tp"
    ? orderType === "buy" ? targetPrice - entry : entry - targetPrice
    : orderType === "buy" ? entry - targetPrice : targetPrice - entry;
  if (!Number.isFinite(distance) || distance <= 0) {
    const label = targetKind === "tp" ? "止盈价格" : "止损价格";
    throw new Error(`${label}与${orderSideLabel(orderType)}方向不匹配，请检查价格位置`);
  }
  return Math.max(1, Math.round(distance / point));
}

function inferContractSize(symbol) {
  const text = String(symbol || "").toUpperCase();
  if (text.includes("XAU")) return 100;
  if (text.includes("XAG")) return 5000;
  return 100000;
}

function estimateOrderMargin(symbol, entryPrice, volume) {
  const leverage = parseDisplayNumber("accountLeverage") || 0;
  const price = Number(entryPrice);
  const lots = Number(volume);
  if (!Number.isFinite(price) || !Number.isFinite(lots) || !Number.isFinite(leverage) || leverage <= 0) return null;
  return (price * inferContractSize(symbol) * lots) / leverage;
}

function buildManualOrder(orderType) {
  const symbol = $("tradeSymbolSelect").value;
  const volume = Number($("tradeVolume").value);
  if (!symbol) throw new Error("请选择交易品种");
  if (!Number.isFinite(volume) || volume <= 0) throw new Error("交易手数必须大于 0");
  const quote = state.lastQuote;
  if (!quote || quote.symbol !== symbol || !Number.isFinite(quote.bid) || !Number.isFinite(quote.ask)) {
    throw new Error("当前品种报价未就绪，请先刷新报价");
  }
  const takeProfitPrice = manualTargetPrice("takeProfitPoints", "止盈价格");
  const stopLossPrice = manualTargetPrice("stopLossPoints", "止损价格");
  const takeProfitPoints = targetPriceToPoints(orderType, takeProfitPrice, "tp", quote);
  const stopLossPoints = targetPriceToPoints(orderType, stopLossPrice, "sl", quote);
  const entryPrice = orderType === "buy" ? quote.ask : quote.bid;
  const estimatedMargin = estimateOrderMargin(symbol, entryPrice, volume);
  const freeMargin = parseDisplayNumber("tradeAccountFreeMargin") ?? parseDisplayNumber("accountMarginFree");
  const marginShortfall = Number.isFinite(Number(estimatedMargin)) && Number.isFinite(Number(freeMargin))
    ? Math.max(0, Number(estimatedMargin) - Number(freeMargin))
    : null;

  // Pending order fields
  const entryMethod = state.selectedOrderType || "market";
  if (state.bridgePlatform === "mt4" && entryMethod === "stop_limit") {
    throw new Error("MT4 不支持止损限价单，请改用市价、限价或止损挂单");
  }
  let limitPrice = null;
  let pendingValidMinutes = null;
  if (entryMethod !== "market") {
    const pp = parseFloat($("pendingPrice")?.value);
    if (!pp || pp <= 0) throw new Error("请填写挂单价");
    limitPrice = pp;
    const deviation = Math.abs(limitPrice - entryPrice) / entryPrice;
    if (deviation > 0.05) throw new Error("挂单价偏离当前价超过 5%");
    pendingValidMinutes = parseInt($("pendingValidMinutes")?.value) || 240;
  }
  if (entryMethod === "stop_limit") {
    const slp = parseFloat($("stopLimitPrice")?.value);
    if (!slp || slp <= 0) throw new Error("请填写止损限价");
    limitPrice = slp; // For stop_limit, the actual price field is the limit price
  }

  return {
    payload: {
      symbol,
      order_type: orderType,
      volume,
      take_profit_points: takeProfitPoints,
      stop_loss_points: stopLossPoints,
      confirm: true,
      source: "manual",
      entry_method: entryMethod,
      limit_price: limitPrice,
      pending_valid_minutes: pendingValidMinutes,
      client_request_id: globalThis.crypto?.randomUUID?.() || `manual-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    },
    meta: {
      symbol,
      orderType,
      sideLabel: orderSideLabel(orderType),
      volume,
      entryPrice,
      takeProfitPrice,
      stopLossPrice,
      takeProfitPoints,
      stopLossPoints,
      estimatedMargin,
      freeMargin,
      marginShortfall,
      entryMethod,
      limitPrice,
      pendingValidMinutes,
    },
  };
}

// === Pending Order: Order Type Selector ===
function initOrderTypeSelector() {
  const btns = document.querySelectorAll(".order-type-btn");
  btns.forEach((btn) => {
    btn.addEventListener("click", () => {
      btns.forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      btns.forEach((b) => b.setAttribute("aria-pressed", String(b === btn)));
      const type = btn.dataset.type;
      state.selectedOrderType = type;
      const pendingRow = $("pendingPriceRow");
      const stopLimitWrap = $("stopLimitPriceWrap");
      if (type === "market") {
        pendingRow.style.display = "none";
        pendingRow.setAttribute("aria-hidden", "true");
        stopLimitWrap.style.display = "none";
        stopLimitWrap.setAttribute("aria-hidden", "true");
      } else {
        pendingRow.style.display = "";
        pendingRow.setAttribute("aria-hidden", "false");
        stopLimitWrap.style.display = type === "stop_limit" ? "" : "none";
        stopLimitWrap.setAttribute("aria-hidden", String(type !== "stop_limit"));
      }
      validatePendingPrice();
    });
  });
  $("pendingPrice")?.addEventListener("input", validatePendingPrice);
  $("stopLimitPrice")?.addEventListener("input", validatePendingPrice);
}

function validatePendingPrice() {
  const orderType = state.selectedOrderType || "market";
  const buyBtn = $("buyBtn");
  const sellBtn = $("sellBtn");
  const hint = $("pendingPriceHint");
  if (!buyBtn || !sellBtn) return;

  if (orderType === "market") {
    buyBtn.disabled = false;
    sellBtn.disabled = false;
    if (hint) hint.textContent = "";
    return;
  }

  const quote = state.lastQuote;
  if (!quote || !Number.isFinite(quote.bid) || !Number.isFinite(quote.ask)) return;

  const price = parseFloat($("pendingPrice")?.value);
  if (!price || price <= 0) {
    buyBtn.disabled = false;
    sellBtn.disabled = false;
    if (hint) hint.textContent = "";
    return;
  }

  const { bid, ask } = quote;
  let disableBuy = false;
  let disableSell = false;
  let hintMsg = "";

  switch (orderType) {
    case "limit":
      if (price >= ask) { disableBuy = true; hintMsg = `买入限价需低于 ${priceDisplay(ask)}`; }
      if (price <= bid) { disableSell = true; hintMsg = hintMsg || `卖出限价需高于 ${priceDisplay(bid)}`; }
      break;
    case "stop":
      if (price <= ask) { disableBuy = true; hintMsg = `买入止损需高于 ${priceDisplay(ask)}`; }
      if (price >= bid) { disableSell = true; hintMsg = hintMsg || `卖出止损需低于 ${priceDisplay(bid)}`; }
      break;
    case "stop_limit": {
      const slp = parseFloat($("stopLimitPrice")?.value);
      if (slp > 0 && slp >= ask) { disableBuy = true; hintMsg = `止损限价需低于 ${priceDisplay(ask)}`; }
      if (slp > 0 && slp <= bid) { disableSell = true; hintMsg = hintMsg || `止损限价需高于 ${priceDisplay(bid)}`; }
      break;
    }
  }

  buyBtn.disabled = disableBuy;
  sellBtn.disabled = disableSell;
  if (hint) hint.textContent = hintMsg;
}

// === Pending Order: List & Cancel ===
async function loadPendingOrders() {
  try {
    const data = await wsApi("pending_list", {});
    const orders = data.orders || [];
    state.pendingOrders = orders;
    renderPendingOrders(orders);
  } catch (e) {
    state.pendingOrders = [];
    console.error("loadPendingOrders:", e);
  }
}

const TRADE_STATE_RETRY_DELAYS_MS = [500, 1200, 2500, 4500];
let tradeStateRefreshGeneration = 0;

function tradeMutationReflected({ kind, ticket, expectPresent }) {
  const normalizedTicket = String(ticket || "");
  if (!normalizedTicket) return true;
  const items = kind === "pending" ? state.pendingOrders : state.positions;
  const present = (items || []).some(item =>
    String(item.mt5_ticket ?? item.ticket ?? item.id ?? "") === normalizedTicket);
  return expectPresent ? present : !present;
}

function queueTradeStateRefresh(options) {
  const generation = ++tradeStateRefreshGeneration;
  void (async () => {
    for (const delayMs of TRADE_STATE_RETRY_DELAYS_MS) {
      await new Promise(resolve => setTimeout(resolve, delayMs));
      if (generation !== tradeStateRefreshGeneration) return;
      await Promise.allSettled([loadPositions(), loadPendingOrders(), loadAccount(), loadStatus()]);
      if (tradeMutationReflected(options)) {
        await loadHistoryViews().catch(() => {});
        return;
      }
    }
  })().catch(error => console.warn("trade state refresh failed:", error));
}

function managementExpectedState(item, ticket, kind) {
  const identity = state.bridgeAccountIdentity;
  if (!identity?.brokerServerKey || !identity?.loginAccount) {
    throw new Error(`${bridgePlatformLabel()} 账户身份尚未加载，请刷新账户状态后重试`);
  }
  const directionValue = String(kind === "position"
    ? (item.type || item.side || "")
    : (item.side || item.pending_type || item.order_type || "")).toLowerCase();
  const rawVolume = item.volume ?? item.volume_current ?? item.volume_initial;
  return {
    broker_server_key: identity.brokerServerKey,
    login_account: identity.loginAccount,
    ticket: String(ticket),
    symbol: String(item.symbol || ""),
    magic: Number(item.magic || 0),
    volume: Number(rawVolume || 0),
    direction: directionValue.startsWith("buy") ? "buy" : (directionValue.startsWith("sell") ? "sell" : ""),
  };
}

function renderPendingOrders(orders) {
  const tbody = $("pendingOrdersBody");
  if (!tbody) return;
  if (!orders.length) {
    tbody.innerHTML = `<tr class="empty-row"><td colspan="11">当前无挂单</td></tr>`;
    return;
  }
  const typeLabels = { buy_limit: "买入限价", sell_limit: "卖出限价", buy_stop: "买入止损", sell_stop: "卖出止损", buy_stop_limit: "买入止损限价", sell_stop_limit: "卖出止损限价" };
  const stateLabels = { pending: "等待中", filled: "已成交", expired: "已过期", cancelled: "已取消", superseded: "已取代" };
  tbody.innerHTML = orders.map((o) => {
    const state = o.state || "pending";
    const isPending = state === "pending";
    const validUntil = parseDate(o.valid_until);
    const createdAt = parseDate(o.created_at);
    const ticket = String(o.mt5_ticket || o.ticket || o.id);
    return `<tr>
      <td data-label="订单号" class="num"><a href="#" class="pending-ticket-link" onclick="event.preventDefault(); navigateToSignalByTicket('${escapeHtml(ticket)}')">${escapeHtml(ticket)}</a></td>
      <td data-label="品种">${escapeHtml(o.symbol)}</td>
      <td data-label="类型">${typeLabels[o.pending_type] || o.pending_type || "--"}</td>
      <td data-label="挂单价" class="num">${Number(o.price).toFixed(2)}</td>
      <td data-label="手数" class="num">${Number(o.volume).toFixed(2)}</td>
      <td data-label="止损" class="num">${o.sl ? Number(o.sl).toFixed(2) : "--"}</td>
      <td data-label="止盈" class="num">${o.tp ? Number(o.tp).toFixed(2) : "--"}</td>
      <td data-label="挂单时间" class="num">${createdAt || "--"}</td>
      <td data-label="有效期">${validUntil || "永久有效"}</td>
      <td data-label="状态"><span class="row-status ${isPending ? "warning" : "neutral"}">${stateLabels[state] || state}</span></td>
      <td data-label="操作">${isPending ? `<button class="btn btn-sm btn-outline" onclick="cancelPendingOrder('${escapeHtml(String(o.mt5_ticket || o.ticket || o.id))}')">撤单</button>` : ""}</td>
    </tr>`;
  }).join("");
}

async function navigateToSignalByTicket(ticket) {
  try {
    const data = await wsApi("signal_by_ticket", { ticket });
    if (data.status === "success" && data.signal) {
      const signal = data.signal;
      const existingIndex = state.signals.findIndex(item => sameSignalId(item.id, signal.id));
      if (existingIndex >= 0) state.signals[existingIndex] = { ...state.signals[existingIndex], ...signal };
      else state.signals.unshift(signal);
      await openAnalysisFromHistory(signal.id, { source:"ticket", forcePinned:true });
      toast(`已定位信号 #${signal.id}`, "success");
    } else {
      toast(data.message || "未找到关联信号", "warning");
    }
  } catch (e) {
    toast("查询信号失败: " + e.message, "error");
  }
}

async function cancelPendingOrder(ticket) {
  if (!await showConfirm("取消挂单", `确认取消挂单 ${ticket}？`, { confirmText: "取消挂单", danger: true })) return;
  try {
    const order = state.pendingOrders.find(item =>
      String(item.mt5_ticket ?? item.ticket ?? item.id ?? "") === String(ticket));
    if (!order) {
      toast("挂单状态已变化，请刷新后重试", "warning");
      await loadPendingOrders();
      return;
    }
    const result = await wsApi("cancel_pending", {
      ticket: String(ticket),
      confirm: true,
      expected_state: managementExpectedState(order, ticket, "pending"),
    });
    toast(result.message || "操作完成", result.status === "success" ? "success" : "warning");
    await loadPendingOrders();
    if (result.status === "success") {
      queueTradeStateRefresh({ kind: "pending", ticket, expectPresent: false });
    }
  } catch (e) {
    toast(e.message, "error");
  }
}

function closeManualOrderModal() {
  state.pendingManualOrder = null;
  const submit = $("orderConfirmSubmit");
  if (submit) {
    submit.disabled = false;
    submit.title = "";
  }
  $("orderConfirmModal")?.classList.add("hidden");
}

function renderManualOrderModal(order) {
  const meta = order.meta;
  const title = $("orderConfirmTitle");
  const body = $("orderConfirmBody");
  const submit = $("orderConfirmSubmit");
  if (!title || !body || !submit) return;
  title.textContent = meta.orderType === "buy" ? "↗ 确认买入" : "↘ 确认卖出";
  title.className = meta.orderType === "buy" ? "buy" : "sell";
  submit.textContent = "确认发送";
  submit.disabled = false;
  submit.title = `按填写参数发送到 ${bridgePlatformLabel()}，由交易终端执行最终校验`;
  const marginKnown = Number.isFinite(Number(meta.estimatedMargin)) && Number.isFinite(Number(meta.freeMargin));
  const riskMessage = !marginKnown
    ? "不套用 AI 风控手数调整；保证金数据不完整，由交易终端校验账户状态和可用保证金。"
    : meta.marginShortfall > 0
      ? `不套用 AI 风控手数调整；预估保证金缺口约 ${fmt(meta.marginShortfall)} USD，仍可发送并以交易终端结果为准。`
      : `不套用 AI 风控手数调整；保证金预检通过，最终结果以 ${bridgePlatformLabel()} 返回为准。`;
  const entryMethod = meta.entryMethod || "market";
  const entryMethodLabel = { market: "市价", limit: "限价", stop: "止损", stop_limit: "止损限价" }[entryMethod] || entryMethod;
  const isPending = entryMethod !== "market" && entryMethod !== "observe";
  body.innerHTML = `
    <div><span>品种</span><strong>${escapeHtml(meta.symbol)}</strong></div>
    <div><span>方向</span><strong class="${meta.orderType}">${escapeHtml(meta.sideLabel)}</strong></div>
    <div><span>订单类型</span><strong>${entryMethodLabel}</strong></div>
    ${isPending ? `<div><span>挂单价</span><strong>${priceDisplay(meta.limitPrice)}</strong></div>` : ""}
    ${isPending ? `<div><span>有效期</span><strong>${meta.pendingValidMinutes} 分钟</strong></div>` : ""}
    <div><span>预估入场价</span><strong>${isPending ? priceDisplay(meta.limitPrice) : priceDisplay(meta.entryPrice)}</strong></div>
    <div><span>交易手数</span><strong>${escapeHtml(volumeText(meta.volume))}</strong></div>
    <div><span>止盈价格</span><strong>${meta.takeProfitPrice ? `${priceDisplay(meta.takeProfitPrice)}（约 ${meta.takeProfitPoints} 点）` : "未设置"}</strong></div>
    <div><span>止损价格</span><strong>${meta.stopLossPrice ? `${priceDisplay(meta.stopLossPrice)}（约 ${meta.stopLossPoints} 点）` : "未设置"}</strong></div>
    <section class="confirm-risk-section">
      <span class="confirm-risk-title">手动订单校验</span>
      <div class="confirm-risk-grid">
        <div><span>预估占用</span><strong>${marginKnown ? `${fmt(meta.estimatedMargin)} USD` : "--"}</strong></div>
        <div><span>可用保证金</span><strong>${Number.isFinite(Number(meta.freeMargin)) ? `${fmt(meta.freeMargin)} USD` : "--"}</strong></div>
        <div><span>杠杆</span><strong>1:${escapeHtml(raw(parseDisplayNumber("accountLeverage")))}</strong></div>
      </div>
      <div class="confirm-risk-warning">${escapeHtml(riskMessage)}</div>
    </section>
  `;
  $("orderConfirmModal")?.classList.remove("hidden");
  initIcons();
}

async function openManual(orderType) {
  try {
    const symbol = $("tradeSymbolSelect").value;
    if ($("quoteSymbolSelect") && $("quoteSymbolSelect").value !== symbol) $("quoteSymbolSelect").value = symbol;
    if (!state.lastQuote || state.lastQuote.symbol !== symbol) await refreshQuote();
    const order = buildManualOrder(orderType);
    state.pendingManualOrder = order;
    renderManualOrderModal(order);
  } catch (error) {
    toast(error.message, "error");
  }
}

async function submitManualOrder() {
  const order = state.pendingManualOrder;
  if (!order) return;
  const submit = $("orderConfirmSubmit");
  if (submit) submit.disabled = true;
  try {
    const result = await wsApi("open", order.payload, 30000);
    closeManualOrderModal();
    const resultMessage = localizeReason(result.error) || localizeReason(result.message);
    toast(resultMessage || `结果：${result.status}`, result.status === "success" ? "success" : "warning");
    await Promise.allSettled([loadPositions(), loadAccount(), loadHistoryViews(), loadStatus(), loadPendingOrders()]);
    if (result.status === "success") {
      const isPending = order.meta.entryMethod !== "market" && order.meta.entryMethod !== "observe";
      queueTradeStateRefresh({
        kind: isPending ? "pending" : "position",
        ticket: result.ticket || result.position_id || result.order,
        expectPresent: true,
      });
    }
  } catch (error) {
    toast(error.message, "error");
  } finally {
    if (submit) submit.disabled = false;
  }
}

async function closePosition(ticket) {
  if (!await showConfirm("复核平仓", `复核平仓 ticket ${ticket}？`, { confirmText: "确认平仓", danger: true })) return;
  try {
    const position = state.positions.find(item => String(item.ticket ?? "") === String(ticket));
    if (!position) {
      toast("持仓状态已变化，请刷新后重试", "warning");
      await loadPositions();
      return;
    }
    const result = await wsApi("close", {
      ticket: String(ticket),
      confirm: true,
      expected_state: managementExpectedState(position, ticket, "position"),
    }, 30000);
    const resultMessage = localizeReason(result.error) || localizeReason(result.message);
    toast(resultMessage || `结果：${result.status}`, result.status === "success" ? "success" : "warning");
    await Promise.allSettled([loadPositions(), loadAccount(), loadHistoryViews(), loadStatus()]);
    if (result.status === "success") {
      queueTradeStateRefresh({ kind: "position", ticket, expectPresent: false });
    }
  } catch (error) {
    toast(error.message, "error");
  }
}

function signalStatusLabel(signal) {
  const advice = signalExecutionAdvice(signal);
  if (advice.state === "pending") return "挂单已提交";
  if (advice.state === "executed" || signal.is_executed) return "已执行";
  if (advice.state === "rejected") return "风控未放行";
  if (advice.state === "failed") return "执行未完成";
  if (signal.is_stale) return "已过期";
  if (signalType(signal.signal_type) === "hold") return "观望";
  return "待复核";
}

function renderAnalysisHistory(signals, options = {}) {
  const host = $("analysisHistoryBody");
  if (!host) return;
  host.removeAttribute("aria-busy");
  if (options.append) {
    // Append new items to existing list (remove sentinel first if exists)
    const sentinel = host.querySelector(".history-sentinel");
    if (sentinel) sentinel.remove();
    const limit = options.limit || ANALYSIS_HISTORY_PAGE_SIZE;
    const fragment = signals.slice(-limit).map((signal) => buildHistoryItemHTML(signal)).join("");
    host.insertAdjacentHTML("beforeend", fragment);
  } else {
    // Render all loaded signals (not just first 6)
    host.innerHTML = signals.length ? signals.map((signal) => buildHistoryItemHTML(signal)).join("") : `<div class="history-empty">暂无推理记录</div>`;
  }
  // Add sentinel if more data available
  if (state.analysisHistoryHasMore) {
    const existing = host.querySelector(".history-sentinel");
    if (!existing) {
      host.insertAdjacentHTML("beforeend", `<div class="history-sentinel" aria-live="polite"><span class="history-sentinel-text">继续向下滚动加载更多</span></div>`);
    }
  }
}

function buildHistoryItemHTML(signal) {
  const dir = signalType(signal.signal_type);
  const confidence = confidenceInfo(signal.confidence).label;
  const status = signalStatusLabel(signal);
  const sourceLabel = strategyDispatchSignalSourceLabel(signal);
  return `
      <button class="analysis-history-item" data-analysis-id="${escapeHtml(signal.id)}">
        <span class="history-item-top">
          <span class="history-item-symbol">${escapeHtml(signal.symbol)} · ${escapeHtml(signal.timeframe)}${sourceLabel ? ` · <em class="history-source-label admin-strategy-dispatch-source">${escapeHtml(sourceLabel)}</em>` : ""}</span>
          <span class="history-item-dir ${dir}">${directionText(signal.signal_type)}</span>
        </span>
        <span class="history-item-meta">
          <span>#${escapeHtml(signal.id)}</span>
          <span>${escapeHtml(compactTerminalTimeText(signal))}</span>
          <span>${confidence}</span>
          <span>${escapeHtml(status)}</span>
        </span>
        <span class="history-item-text">${escapeHtml(userVisibleText(signal.analysis || signal.reasoning, "暂无中文分析摘要"))}</span>
      </button>
    `;
}

function highlightActiveAnalysis(signalId) {
  document.querySelectorAll("[data-analysis-id]").forEach((node) => {
    node.classList.toggle("active", String(node.dataset.analysisId) === String(signalId));
  });
}

let _analysisDetailRequestVersion = 0;
let _signalsListRequestVersion = 0;
let _signalSummaryRequestVersion = 0;
let _signalTableRequestVersion = 0;
let _analysisHistoryLoadPromise = null;

function signalSnapshotRevision(signal) {
  const snapshot = signal?.inference_snapshot;
  if (!snapshot) return "none";
  return [snapshot.id, snapshot.revision, snapshot.content_hash, snapshot.created_at].map(value => String(value ?? "")).join(":");
}

function mergeSignalListSummary(detail, summary) {
  if (!detail) return summary || null;
  if (!summary) return detail;
  const merged = { ...detail };
  // The list is the freshest source for execution/pending state. Keep the
  // detail-only snapshot and derived action fields when they are absent there.
  const detailOnlyFields = new Set([
    "market_data", "inference_snapshot", "pending_actions", "management_actions", "detail_loaded",
  ]);
  for (const [key, value] of Object.entries(summary)) {
    if (value !== undefined && !detailOnlyFields.has(key)) merged[key] = value;
  }
  return merged;
}

function clearSignalEvidence(signalId) {
  const prefix = `${String(signalId)}:`;
  for (const key of _signalEvidenceCache.keys()) {
    if (key.startsWith(prefix)) _signalEvidenceCache.delete(key);
  }
}

function renderAnalysisHistoryLoading() {
  const host = $("analysisHistoryBody");
  if (!host) return;
  host.setAttribute("aria-busy", "true");
  host.innerHTML = `<div class="history-empty" role="status" aria-live="polite">正在加载历史分析…</div>`;
}

function mergeSignalDetail(signal, detail) {
  const previous = getSignalCacheEntry(_signalDetailCache, String(detail?.id ?? signal?.id)) || signal;
  if (previous && signalSnapshotRevision(previous) !== signalSnapshotRevision(detail)) {
    clearSignalEvidence(detail?.id ?? signal?.id);
  }
  const merged = { ...(signal || {}), ...(detail || {}), detail_loaded: true };
  setSignalCacheEntry(_signalDetailCache, String(merged.id), merged, SIGNAL_DETAIL_CACHE_LIMIT);
  return merged;
}

async function loadSignalDetail(signalId, { forceRefresh = false } = {}) {
  const key = String(signalId);
  if (_signalDetailFlights.has(key)) return _signalDetailFlights.get(key);
  if (!forceRefresh) {
    const cached = getSignalCacheEntry(_signalDetailCache, key);
    if (cached) return cached;
  }
  const flight = wsApi("signal_detail", { signal_id: Number(signalId) })
    .then(data => data?.status === "success" && data.signal ? mergeSignalDetail(
      getSignalCacheEntry(_signalDetailCache, key) || state.signals.find(item => String(item.id) === key), data.signal,
    ) : null)
    .finally(() => _signalDetailFlights.delete(key));
  _signalDetailFlights.set(key, flight);
  return flight;
}

// The dashboard deliberately keeps only a one-row signal summary.  Entering
// the analyst detail view is the demand boundary at which the first history
// page is fetched.  Keep the in-flight promise shared so a ticket click and a
// concurrent navigation cannot issue duplicate `signals` list requests.
async function ensureAnalysisHistoryPageLoaded() {
  if (state.analysisHistoryPageLoaded) return;
  if (_analysisHistoryLoadPromise) return _analysisHistoryLoadPromise;
  renderAnalysisHistoryLoading();
  _analysisHistoryLoadPromise = loadSignals({
    limit: ANALYSIS_HISTORY_PAGE_SIZE,
    skipResultRender: true,
    loadDashboard: false,
  }).finally(() => {
    _analysisHistoryLoadPromise = null;
  });
  return _analysisHistoryLoadPromise;
}

function renderAnalysisDetailLoading(signalId) {
  destroyInferenceChart();
  const resultHost = $("analysisResult");
  if (!resultHost) return;
  const renderVersion = ++_inferenceChartRenderVersion;
  resultHost.className = "analysis-result is-loading";
  resultHost.dataset.signalId = String(signalId);
  resultHost.dataset.renderVersion = String(renderVersion);
  resultHost.setAttribute("aria-busy", "true");
  resultHost.innerHTML = `
    <div class="analysis-detail-loading" role="status" aria-live="polite">
      <span class="analysis-detail-loading-mark" aria-hidden="true"></span>
      <div>
        <strong>正在读取完整推理快照</strong>
        <span>正在核对信号 #${escapeHtml(signalId)} 的行情、结构与执行数据</span>
      </div>
    </div>
  `;
}

async function openAnalysisFromHistory(signalId, options = {}) {
  const requestedId = String(signalId);
  const requestVersion = ++_analysisDetailRequestVersion;
  const navigate = options.navigate !== false;
  const forceRefresh = options.forceRefresh === true;
  const listSummary = state.signals.find((item) => String(item.id) === requestedId);
  let signal = mergeSignalListSummary(getSignalCacheEntry(_signalDetailCache, requestedId), listSummary);

  if (!options.preserveSelectionMode) setAnalysisSelectionIntent(signalId, options);

  // Select immediately: a late response for the previous signal may update its
  // list cache, but must never reclaim the currently visible detail panel.
  state.selectedSignal = signal || { id: signalId };
  highlightActiveAnalysis(signalId);
  if (navigate) setTab("ai-analyze", { skipRefresh:true, analystView:"detail" });

  if (navigate) {
    try {
      await ensureAnalysisHistoryPageLoaded();
      if (requestVersion !== _analysisDetailRequestVersion) return;
      signal = mergeSignalListSummary(
        signal, state.signals.find(item => String(item.id) === requestedId),
      );
    } catch (error) {
      console.error('[Inference] signal history load failed:', error);
    }
  }

  if (!signal?.detail_loaded || forceRefresh) {
    if (!signal?.detail_loaded) renderAnalysisDetailLoading(signalId);
    try {
      // loadSignalDetail deduplicates the underlying wsApi("signal_detail", …) request.
      const loaded = await loadSignalDetail(signalId, { forceRefresh });
      if (loaded) {
        signal = mergeSignalListSummary(
          loaded, state.signals.find(item => String(item.id) === requestedId),
        );
        const index = state.signals.findIndex(item => String(item.id) === requestedId);
        if (index >= 0) state.signals[index] = signal;
        else state.signals.unshift(signal);
        renderAnalysisHistory(state.signals);
      }
    } catch (error) {
      console.error('[Inference] signal detail load failed:', error);
      if (navigate) toast("推理快照读取失败，已显示基础信号信息", "warning");
    }
  }

  if (
    requestVersion !== _analysisDetailRequestVersion
    || String(state.selectedSignal?.id ?? "") !== requestedId
  ) return;

  if (!signal) {
    toast("未找到对应推理记录", "warning");
    renderSignal(null, null);
    return;
  }
  state.selectedSignal = signal;
  renderSignal(signal, null);
  highlightActiveAnalysis(signalId);
  // Scroll the active item into view
  const activeEl = document.querySelector(`[data-analysis-id="${signalId}"]`);
  if (activeEl) activeEl.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

function renderSignalRows() {
  const body = $("signalsBody");
  if (!body) return;
  const rows = state.signalTableData || [];
  const total = state.signalTableTotal || rows.length;
  setText("signalCount", `显示 ${rows.length} / ${total} 条`);
  body.innerHTML = rows.length ? rows.map((signal) => {
    const dir = signalType(signal.signal_type);
    const confidence = confidenceInfo(signal.confidence);
    const sourceLabel = strategyDispatchSignalSourceLabel(signal);
    const rowStatus = signal.is_executed ? "executed" : signal.is_stale ? "expired" : "live";
    return `
      <tr data-analysis-id="${escapeHtml(signal.id)}">
        <td class="num">${escapeHtml(signal.id)}</td>
        <td>${compactTerminalTimeHtml(signal)}</td>
        <td>${escapeHtml(signal.symbol)}${sourceLabel ? `<small class="signal-source-label admin-strategy-dispatch-source">${escapeHtml(sourceLabel)}</small>` : ""}</td>
        <td><span class="signal-tf-badge ${dir === 'close' ? 'close-badge' : ''}">${dir === 'close' ? '持仓分析' : escapeHtml(signal.timeframe)}</span></td>
        <td><span class="tag ${dir}">${directionText(signal.signal_type)}</span></td>
        <td>
          <div class="conf-mini ${confidenceClass(signal.confidence)}">
            <span class="conf-mini-track"><span class="conf-mini-fill" style="width:${confidence.value}%"></span></span>
            <span class="num">${confidence.label}</span>
          </div>
        </td>
        <td>${escapeHtml(positionSizeAdvice(signal).text)}</td>
        <td><span class="row-status ${rowStatus}">${escapeHtml(signalStatusLabel(signal))}</span></td>
        <td class="num">${escapeHtml(signal.stop_loss_price || "--")}</td>
        <td class="num">${escapeHtml(signal.take_profit_1_price || "--")}</td>
        <td class="num tp-cell">${escapeHtml(signal.take_profit_2_price || "--")} <span class="tp3-val">/ ${escapeHtml(signal.take_profit_3_price || "--")}</span></td>
      </tr>
    `;
  }).join("") : `<tr class="empty-row"><td colspan="12">当前筛选下暂无信号</td></tr>`;
  renderPager("signalPager", state.signalFilters.page, state.signalFilters.pageSize, total, "signals");
  highlightActiveAnalysis(state.selectedSignal?.id);
  initIcons();
}

async function loadSignals(options = {}) {
  const limit = options.limit || ANALYSIS_HISTORY_PAGE_SIZE;
  const offset = options.offset || 0;
  const summaryOnly = options.summaryOnly === true;
  const loadDashboard = options.loadDashboard !== false && !summaryOnly;
  const loadTable = options.loadTable === true;
  const requestVersion = summaryOnly
    ? ++_signalSummaryRequestVersion
    : options.append
      ? _signalsListRequestVersion
      : ++_signalsListRequestVersion;
  const loadedIds = options.append ? state.signals.map(item => Number(item.id)).filter(Number.isFinite) : [];
  const beforeId = loadedIds.length ? Math.min(...loadedIds) : null;
  const data = await wsApi("signals", { limit, offset:beforeId ? 0 : offset, ...(beforeId ? { before_id:beforeId } : {}) });
  const requestIsCurrent = summaryOnly
    ? requestVersion === _signalSummaryRequestVersion
    : requestVersion === _signalsListRequestVersion;
  if (!requestIsCurrent) return [];
  const signals = data.signals || [];
  const hasMore = data.has_more !== undefined ? data.has_more : signals.length >= limit;

  // Dashboard refreshes intentionally fetch only one lightweight row. Keep
  // that summary in its own state so it cannot replace the analyst history
  // list or reset its paging metadata while the user is reading a detail.
  if (summaryOnly) {
    const summarySignal = signals[0] || null;
    state.latestSignalId = summarySignal?.id ?? null;
    _lastSignalId = state.latestSignalId;
    updateSignalDisplay(summarySignal, { announceNew:options.announceDashboardSignal === true });
    return signals;
  }

  if (options.append) {
    const known = new Set(state.signals.map(item => String(item.id)));
    state.signals = state.signals.concat(signals.filter(item => !known.has(String(item.id))));
  } else {
    state.signals = signals;
  }
  state.analysisHistoryOffset = state.signals.length;
  state.analysisHistoryHasMore = hasMore;
  if (!options.append) {
    state.analysisHistoryPageLoaded = limit >= ANALYSIS_HISTORY_PAGE_SIZE;
  }

  // The server-sorted first row is the canonical latest signal. Keep it
  // separate from the selected row because history navigation may inject an
  // older signal at the top of the visible list.
  if (state.signals.length > 0 && !options.append) {
    state.latestSignalId = state.signals[0].id;
    _lastSignalId = state.signals[0].id;
  }
  if (!options.append && state.signals[0] && loadDashboard) {
    await loadDashboardSignal(state.signals[0].id, state.signals[0], { announceNew:options.announceDashboardSignal === true });
  } else if (!options.append && loadDashboard) {
    updateSignalDisplay(null);
  }

  // Preserve selected signal if it still exists, otherwise use latest
  const previousSelected = state.selectedSignal;
  const selectedId = previousSelected?.id;
  const stillExists = selectedId ? state.signals.find(s => String(s.id) === String(selectedId)) : null;
  let activeSignal = options.selectLatest
    ? (state.signals[0] || null)
    : (stillExists || previousSelected || state.signals[0] || null);
  if (stillExists && previousSelected?.detail_loaded && String(activeSignal?.id) === String(selectedId)) {
    // Keep heavyweight detail fields, but let the freshly loaded list row win
    // for user-specific execution state (pending ticket, delivery result, etc.).
    activeSignal = { ...previousSelected, ...stillExists };
    const activeIndex = state.signals.findIndex(item => String(item.id) === String(activeSignal.id));
    if (activeIndex >= 0) state.signals[activeIndex] = activeSignal;
  }

  if (!options.append && !options.skipResultRender) {
    state.selectedSignal = activeSignal;
    if (activeSignal) setText("signalFreshness", signalFreshness(activeSignal));
  } else if (!options.append && previousSelected) {
    // A background/list-only refresh must not steal the detail selection. This
    // is especially important while an older signal is being opened from the
    // history page: changing selectedSignal here invalidates the in-flight
    // detail response and leaves the loading placeholder visible forever.
    state.selectedSignal = previousSelected;
  }
  renderAnalysisHistory(state.signals);
  if (!options.skipResultRender && !options.append && !summaryOnly) {
    if (activeSignal) await openAnalysisFromHistory(activeSignal.id, { navigate:false });
    else renderSignal(null, null);
  }

  // The paginated records table is loaded only by its own view or by an
  // explicit internal reconciliation call. A homepage/analyst history
  // refresh must never pull the second signals endpoint implicitly.
  if (!options.append && loadTable) await loadSignalTable();
  return signals;
}

// Load signal table data (server-side filtering + pagination, 20/page)
async function loadSignalTable() {
  const requestVersion = ++_signalTableRequestVersion;
  const page = state.signalFilters.page;
  const pageSize = state.signalFilters.pageSize;
  const params = { limit: pageSize, offset: (page - 1) * pageSize };
  if (state.signalFilters.direction) params.direction = state.signalFilters.direction;
  if (state.signalFilters.timeframe) params.timeframe = state.signalFilters.timeframe;
  try {
    const data = await wsApi("signals", params);
    if (requestVersion !== _signalTableRequestVersion) return;
    state.signalTableData = data.signals || [];
    state.signalTableTotal = data.total_count || 0;
    renderSignalRows();
  } catch (e) { console.error('[Signals] table load failed:', e); }
}

function setHistoryZeroClass(id, value) {
  const el = $(id);
  if (!el?.parentElement) return;
  const num = Number(value);
  el.parentElement.classList.toggle("zero-value", Number.isFinite(num) && num === 0);
}

function historyRangeNumber(range = {}, kind = "start") {
  const keys = kind === "start"
    ? ["range_start_utc_msc", "rangeStartUtcMsc", "start_utc_msc", "from_utc_msc", "start"]
    : ["range_end_utc_msc", "rangeEndUtcMsc", "end_utc_msc", "captured_end_utc_msc", "capturedEndUtcMsc", "to_utc_msc", "end"];
  for (const key of keys) {
    const value = Number(range?.[key]);
    if (Number.isSafeInteger(value) && value > 0) return value;
  }
  return null;
}

function historyRangeDate(range = {}, kind = "start", offsetMinutes = null) {
  const keys = kind === "start"
    ? ["start_date", "from_date", "range_start_date", "effective_start_date", "system_start_date", "allowed_start_date", "query_floor_date", "start_terminal_date", "start_business_date", "close_from", "date_from", "start"]
    : ["end_date", "to_date", "range_end_date", "effective_end_date", "system_end_date", "allowed_end_date", "captured_end_date", "end_terminal_date", "end_business_date", "close_to", "date_to", "end"];
  for (const key of keys) {
    const value = range?.[key];
    if (validHistoryBusinessDate(value)) return String(value);
  }
  const numeric = historyRangeNumber(range, kind);
  if (!Number.isSafeInteger(numeric)) return "";
  const offset = Number.isFinite(Number(offsetMinutes)) ? Number(offsetMinutes) : 0;
  const date = new Date(numeric + offset * 60_000);
  return Number.isNaN(date.getTime()) ? "" : date.toISOString().slice(0, 10);
}

function historyRangeCandidate(data = {}, keys = []) {
  for (const key of keys) {
    if (data?.[key] && typeof data[key] === "object") return data[key];
  }
  return {};
}

function historyScopeMetaFromResponse(data = {}) {
  const root = historyRangeCandidate(data, ["history_range", "scope_range", "range"]);
  const preference = data?.preference && typeof data.preference === "object" ? data.preference : {};
  const allowed = Object.keys(historyRangeCandidate(data, ["allowed_range", "allowedRange"])).length
    ? historyRangeCandidate(data, ["allowed_range", "allowedRange"])
    : historyRangeCandidate(root, ["allowed_range", "allowedRange"]);
  const system = Object.keys(historyRangeCandidate(data, ["system_range", "systemRange"])).length
    ? historyRangeCandidate(data, ["system_range", "systemRange"])
    : historyRangeCandidate(root, ["system_range", "systemRange"]);
  const effective = Object.keys(historyRangeCandidate(data, ["effective_range", "effectiveRange", "scope_effective_range"])).length
    ? historyRangeCandidate(data, ["effective_range", "effectiveRange", "scope_effective_range"])
    : historyRangeCandidate(root, ["effective_range", "effectiveRange", "scope_effective_range"]);
  const offset = data?.timezone_offset_minutes
    ?? data?.close_timezone_offset_minutes
    ?? data?.history_sync?.timezone_offset_minutes
    ?? root?.timezone_offset_minutes
    ?? root?.timezoneOffsetMinutes
    ?? state.mt5TimezoneOffsetMinutes;
  const effectiveRange = Object.keys(effective).length ? effective : root;
  const allowedStartDate = historyRangeDate(allowed, "start", offset)
    || (validHistoryBusinessDate(data?.query_floor_date) ? String(data.query_floor_date) : "")
    || historyRangeDate({ query_floor:data?.query_floor }, "start", offset)
    || historyRangeDate(root, "start", offset);
  const systemStartDate = historyRangeDate(system, "start", offset)
    || (validHistoryBusinessDate(data?.system_start_date) ? String(data.system_start_date) : "")
    || historyRangeDate({ system_start:data?.system_start }, "start", offset)
    || historyRangeDate(root, "start", offset);
  const effectiveStartDate = historyRangeDate(effectiveRange, "start", offset)
    || (validHistoryBusinessDate(data?.effective_start_date) ? String(data.effective_start_date) : "")
    || systemStartDate;
  const effectiveEndDate = historyRangeDate(effectiveRange, "end", offset)
    || (validHistoryBusinessDate(data?.captured_end_date) ? String(data.captured_end_date) : "")
    || historyRangeDate(root, "end", offset);
  const platformStartDate = validHistoryBusinessDate(root?.platform_start_date)
    ? String(root.platform_start_date)
    : historyRangeDate({ start:root?.platform_start_utc_msc }, "start", offset)
      || (validHistoryBusinessDate(data?.platform_start_date) ? String(data.platform_start_date) : "");
  const rangeStartUtcMsc = historyRangeNumber(effectiveRange, "start") || historyRangeNumber(root, "start");
  const rangeEndUtcMsc = historyRangeNumber(effectiveRange, "end") || historyRangeNumber(root, "end");
  const capturedEndUtcMsc = historyRangeNumber({
    captured_end_utc_msc:data?.captured_end_utc_msc ?? root?.captured_end_utc_msc ?? effectiveRange?.captured_end_utc_msc,
  }, "end") || rangeEndUtcMsc;
  const allowedStartUtcMsc = historyRangeNumber(allowed, "start") || Number(data?.query_floor_utc_msc) || null;
  const systemStartUtcMsc = historyRangeNumber(system, "start") || Number(data?.system_start_utc_msc) || null;
  const explicitOverrideApplied = [
    data?.override_applied,
    data?.scope_start_override_applied,
    root?.override_applied,
    root?.scope_start_override_applied,
  ].find(value => typeof value === "boolean");
  const overrideApplied = typeof explicitOverrideApplied === "boolean"
    ? explicitOverrideApplied
    : Boolean(effectiveStartDate && systemStartDate && effectiveStartDate !== systemStartDate);
  const preferenceKnown = [data, root].some(source => source
    && (Object.prototype.hasOwnProperty.call(source, "saved_start_date")
      || Object.prototype.hasOwnProperty.call(source, "preference_start_date")))
    || Object.prototype.hasOwnProperty.call(preference, "start_date");
  const savedStartValue = preference.start_date
    ?? data?.saved_start_date ?? data?.preference_start_date
    ?? root?.saved_start_date ?? root?.preference_start_date ?? null;
  const savedStartDate = validHistoryBusinessDate(savedStartValue) ? String(savedStartValue) : "";
  return {
    scope:String(root?.scope || data?.history_scope || data?.scope || $("historyRangeMode")?.value || HISTORY_DEFAULT_SCOPE).trim().toLowerCase(),
    allowedStartDate:allowedStartDate || HISTORY_ABSOLUTE_FLOOR_DATE,
    systemStartDate:systemStartDate || allowedStartDate || HISTORY_ABSOLUTE_FLOOR_DATE,
    effectiveStartDate:effectiveStartDate || systemStartDate || allowedStartDate || "",
    actualStartDate:effectiveStartDate || systemStartDate || allowedStartDate || "",
    actualEndDate:effectiveEndDate || "",
    platformStartDate:platformStartDate || "",
    rangeStartUtcMsc,
    rangeEndUtcMsc,
    capturedEndUtcMsc,
    allowedStartUtcMsc:Number.isSafeInteger(allowedStartUtcMsc) ? allowedStartUtcMsc : null,
    systemStartUtcMsc:Number.isSafeInteger(systemStartUtcMsc) ? systemStartUtcMsc : null,
    timezoneOffsetMinutes:Number.isFinite(Number(offset)) ? Number(offset) : null,
    overrideApplied:Boolean(overrideApplied),
    preferenceKnown,
    savedStartDate,
    preferenceSource:String(data?.preference_source || root?.preference_source || preference?.source || ""),
    pending:Boolean(data?.pending || data?.history_pending || data?.history_sync?.requested_range_complete === false),
    raw:data,
  };
}

function applyHistoryScopeResponse(data = {}) {
  const scope = $("historyRangeMode")?.value || HISTORY_DEFAULT_SCOPE;
  const meta = historyScopeMetaFromResponse(data);
  if ((scope === "all" || scope === "platform") && meta.preferenceKnown) {
    historyRememberServerStart(scope, meta.savedStartDate);
  }
  state.historyRangeMeta = meta;
  const from = $("historyRangeFrom");
  const to = $("historyRangeTo");
  const effectiveStart = meta.actualStartDate || meta.effectiveStartDate;
  if (from && effectiveStart) from.value = effectiveStart;
  if (to && meta.actualEndDate) to.value = meta.actualEndDate;
  if (from && meta.allowedStartDate) from.min = meta.allowedStartDate;
  if (to && meta.allowedStartDate) to.min = meta.allowedStartDate;
  if (from && meta.actualEndDate) from.max = meta.actualEndDate;
  if (to && meta.actualEndDate) to.max = meta.actualEndDate;
  updateHistoryRangeUI({ pending:false });
  renderHistoryRangeMeta(meta, scope);
  return meta;
}

function renderHistoryRangeMeta(meta = state.historyRangeMeta, scope = $("historyRangeMode")?.value || HISTORY_DEFAULT_SCOPE) {
  if (!meta) {
    setText("historyRangeActual", "正在确认范围");
    setText("historyRangeHint", "正在确认当前终端的权威历史范围…");
    return;
  }
  const start = meta.actualStartDate || "--";
  const end = meta.actualEndDate || "--";
  setText("historyRangeActual", `${start} ～ ${end}`);
  const system = meta.systemStartDate || start;
  const allowed = meta.allowedStartDate || HISTORY_ABSOLUTE_FLOOR_DATE;
  let message = `${scope === "custom" ? "当前自定义范围" : "服务端确认范围"}：${start} ～ ${end}`;
  if ((scope === "platform" || scope === "all") && start < system) {
    message += ` · 已扩展至平台接入前：${start}`;
  } else if ((scope === "platform" || scope === "all") && start !== system) {
    message += " · 已使用保存的开始日期";
  }
  if (scope === "platform" && meta.platformStartDate && start < meta.platformStartDate) {
    message += ` · 平台接入时间：${meta.platformStartDate}`;
  }
  message += ` · 可查询起点：${allowed}`;
  if (isObserverMode() && (scope === "platform" || scope === "all")) {
    message += " · 开始日期由观摩源账户设置";
  }
  setText("historyRangeHint", message);
}

function historyRangeContextMatches(requestContextKey, generation, { includeTableFilters = true } = {}) {
  return Number(state._accountContextGeneration || 0) === Number(generation || 0)
    && requestContextKey === historyRefreshContextKey({ forceRefresh:false, includeTableFilters });
}

function getHistoryRangeParams() {
  const selectedScope = $("historyRangeMode")?.value;
  const scope = ["all", "platform", "custom"].includes(selectedScope)
    ? selectedScope : HISTORY_DEFAULT_SCOPE;
  const params = { history_scope: scope };
  const from = $("historyRangeFrom")?.value || "";
  const to = $("historyRangeTo")?.value || "";
  if (scope === "custom") {
    if (!from) throw new Error("请选择自定义历史开始日期");
    if (!validHistoryBusinessDate(from)) throw new Error("历史开始日期格式无效");
    if (from < HISTORY_ABSOLUTE_FLOOR_DATE) throw new Error(`开始日期不能早于 ${HISTORY_ABSOLUTE_FLOOR_DATE}`);
    const customAllowed = state.historyRangeMeta?.allowedStartDate;
    if (customAllowed && from < customAllowed) throw new Error(`开始日期不能早于可查询起点 ${customAllowed}`);
    if (to && (!validHistoryBusinessDate(to) || from > to)) throw new Error("历史开始日期不能晚于结束日期");
    params.close_from = from;
    if (to) params.close_to = to;
  } else {
    const meta = state.historyRangeMeta || {};
    if (!from) return params;
    if (!validHistoryBusinessDate(from)) throw new Error("历史开始日期格式无效");
    const allowed = meta.allowedStartDate || HISTORY_ABSOLUTE_FLOOR_DATE;
    const end = meta.actualEndDate || to || "";
    if (from < HISTORY_ABSOLUTE_FLOOR_DATE || from < allowed) {
      throw new Error(`开始日期不能早于可查询起点 ${allowed}`);
    }
    if (end && from > end) throw new Error("开始日期不能晚于服务端结束日期");
    const system = meta.systemStartDate || "";
    // The displayed start is the request source of truth. If it already
    // equals the server-confirmed system start, sending it again as a date
    // override is redundant and can shift across the terminal timezone at
    // the absolute floor (for example 2000-01-01 in UTC+3).
    const usesSystemStart = Boolean(system && from === system);
    const usesAllAllowedFloor = scope === "all" && from === allowed;
    const usesSavedServerStart = Boolean(historyPreferenceStart(scope)
      && from === historyPreferenceStart(scope));
    if (!usesSystemStart && !usesAllAllowedFloor && !usesSavedServerStart) {
      params.scope_start_override = from;
    }
  }
  return params;
}

function historyPreparationMessage() {
  return "正在准备所选范围的交易记录，完成后将自动刷新";
}

function renderHistoryPreparationStatus(message = historyPreparationMessage()) {
  const body = $("historyBody");
  if (!body) return;
  body.innerHTML = `<tr class="empty-row history-preparing-row"><td colspan="13">${escapeHtml(message)}</td></tr>`;
  setText("historyFilterCount", "");
}

function clearHistoryPreparationStatus() {
  const body = $("historyBody");
  if (!body?.querySelector(".history-preparing-row")) return;
  body.innerHTML = "";
  setText("historyFilterCount", "");
}

function cancelHistoryRangeRetry({ clearStatus = true } = {}) {
  const retry = _historyRangeRetryState;
  if (retry) {
    retry.cancelled = true;
    if (retry.timer) clearTimeout(retry.timer);
  }
  _historyRangeRetryState = null;
  if (clearStatus) clearHistoryPreparationStatus();
}

function historyRangeFromError(error) {
  // Keep this helper self-contained: a few static/browser tests evaluate the
  // retry parser without the rest of the application helpers loaded.
  const rangeNumber = (range, kind) => {
    const keys = kind === "start"
      ? ["range_start_utc_msc", "rangeStartUtcMsc", "start_utc_msc", "from_utc_msc", "start"]
      : ["range_end_utc_msc", "rangeEndUtcMsc", "end_utc_msc", "to_utc_msc", "end"];
    for (const key of keys) {
      const value = Number(range?.[key]);
      if (Number.isSafeInteger(value) && value > 0) return value;
    }
    return null;
  };
  const candidates = [
    error?.history_range,
    error?.effective_range,
    error?.details?.effective_range,
    error?.data?.effective_range,
    error?.details?.history_range,
    error?.data?.history_range,
    error?.payload?.history_range,
  ];
  for (const range of candidates) {
    if (!range || typeof range !== "object") continue;
    const rangeStart = rangeNumber(range, "start");
    const rangeEnd = rangeNumber(range, "end");
    if (Number.isSafeInteger(rangeStart) && Number.isSafeInteger(rangeEnd)
      && rangeStart > 0 && rangeStart < rangeEnd) {
      return { rangeStart, rangeEnd };
    }
  }
  return null;
}

function historyRetryContextKey() {
  return historyRefreshContextKey({ forceRefresh:false });
}

function isHistoryCursorRangeIncomplete(error) {
  return historyErrorCode(error) === HISTORY_CURSOR_RANGE_INCOMPLETE_CODE;
}

function finishHistoryRangeRetry(retry, { exhausted = false } = {}) {
  if (_historyRangeRetryState !== retry) return;
  if (retry.timer) clearTimeout(retry.timer);
  _historyRangeRetryState = null;
  if (exhausted && activeTabId() === "history") {
    const message = "历史记录准备时间较长，请稍后点击“刷新”重试";
    renderHistoryPreparationStatus(message);
    if (!retry.exhaustedNoticeShown) {
      retry.exhaustedNoticeShown = true;
      toast(message, "warning");
    }
  }
}

function scheduleHistoryRangeRetry({ contextKey = historyRetryContextKey() } = {}) {
  if (activeTabId() !== "history" || !contextKey || contextKey !== historyRetryContextKey()) return;
  let retry = _historyRangeRetryState;
  if (!retry || retry.contextKey !== contextKey || retry.cancelled) {
    cancelHistoryRangeRetry();
    retry = {
      contextKey,
      attempts:0,
      timer:null,
      inFlight:false,
      cancelled:false,
      exhaustedNoticeShown:false,
    };
    _historyRangeRetryState = retry;
  }
  renderHistoryPreparationStatus();
  if (retry.attempts >= HISTORY_RANGE_RETRY_MAX_ATTEMPTS) {
    finishHistoryRangeRetry(retry, { exhausted:true });
    return;
  }
  if (retry.timer || retry.inFlight) return;
  retry.timer = setTimeout(async () => {
    retry.timer = null;
    if (_historyRangeRetryState !== retry || retry.cancelled
      || activeTabId() !== "history" || contextKey !== historyRetryContextKey()) {
      if (_historyRangeRetryState === retry) cancelHistoryRangeRetry();
      return;
    }
    if (retry.attempts >= HISTORY_RANGE_RETRY_MAX_ATTEMPTS) {
      finishHistoryRangeRetry(retry, { exhausted:true });
      return;
    }
    retry.attempts += 1;
    retry.inFlight = true;
    try {
      const result = await loadHistoryViews({
        forceRefresh:false,
        includeAccount:false,
        manualRefresh:false,
        historyRetryAttempt:true,
      });
      retry.inFlight = false;
      if (_historyRangeRetryState !== retry || retry.cancelled) return;
      if (result?.historyPending === true) {
        scheduleHistoryRangeRetry({ contextKey });
      } else {
        finishHistoryRangeRetry(retry);
      }
    } catch (error) {
      retry.inFlight = false;
      if (_historyRangeRetryState !== retry || retry.cancelled) return;
      if (isHistoryCursorRangeIncomplete(error)) {
        scheduleHistoryRangeRetry({ contextKey });
      } else {
        finishHistoryRangeRetry(retry);
      }
    }
  }, HISTORY_RANGE_RETRY_INTERVAL_MS);
}

function resetHistoryCursorState(key = null, { preserveRange = false } = {}) {
  cancelHistoryRangeRetry();
  const previous = _historyCursorState || {};
  const keepRange = preserveRange && historyCursorRangeIsFixed(previous);
  _historyCursorState = {
    key,
    snapshotId:null,
    rangeStart:keepRange ? previous.rangeStart : null,
    rangeEnd:keepRange ? previous.rangeEnd : null,
    pageCursors:new Map([[1, null]]),
    // A filter change has already selected a new snapshot boundary.  Keep the
    // frozen scope range when loadHistory switches to the new filter-bound
    // cursor key, then consume this one-shot handoff in that request.
    preserveRangeOnKeyChange:Boolean(keepRange && key == null),
  };
}

function updateHistoryRangeUI({ pending = false } = {}) {
  const scope = ["all", "platform", "custom"].includes($("historyRangeMode")?.value)
    ? $("historyRangeMode").value : HISTORY_DEFAULT_SCOPE;
  const custom = scope === "custom";
  $("historyRangeDates")?.classList.remove("hidden");
  const from = $("historyRangeFrom");
  const to = $("historyRangeTo");
  if (from) {
    from.disabled = Boolean(pending);
    if (!from.min) from.min = HISTORY_ABSOLUTE_FLOOR_DATE;
  }
  if (to) {
    to.disabled = Boolean(pending || !custom);
    if (!to.min) to.min = HISTORY_ABSOLUTE_FLOOR_DATE;
  }
  const save = $("historyRangeSave");
  const restore = $("historyRangeRestore");
  const apply = $("historyRangeApply");
  const observer = isObserverMode();
  if (apply) apply.disabled = Boolean(pending);
  if (save) save.hidden = custom || observer;
  if (restore) restore.hidden = custom || observer;
  if (save) save.disabled = Boolean(pending);
  if (restore) restore.disabled = Boolean(pending);
  if (pending || !state.historyRangeMeta) {
    setText("historyRangeActual", "正在确认范围");
    setText("historyRangeHint", "正在确认当前终端的权威历史范围…");
    return;
  }
  renderHistoryRangeMeta(state.historyRangeMeta, scope);
  const mt4RangeWarning = bridgePlatformLabel() === "MT4"
    ? " MT4 历史范围取决于终端“账户历史”页已加载的时间范围；需要完整历史时，请先在 MT4 中选择“全部历史记录”。"
    : "";
  if (mt4RangeWarning) setText("historyRangeHint", `${$("historyRangeHint")?.textContent || ""}${mt4RangeWarning}`);
}

function historyRefreshContextKey({ forceRefresh = false, includeTableFilters = true } = {}) {
  let range;
  try {
    range = getHistoryRangeParams();
  } catch {
    range = { history_scope: $("historyRangeMode")?.value || HISTORY_DEFAULT_SCOPE };
  }
  const filters = state.historyFilters || {};
  return JSON.stringify({
    generation:Number(state._accountContextGeneration || 0),
    history_query_generation:Number(state.historyQueryGeneration || 0),
    account:state.bridgeAccountIdentity || null,
    platform:state.bridgePlatform || "mt5",
    range,
    filters:includeTableFilters ? {
      // Forced refreshes always share the first-page flight, even when a
      // stale pagination state still points at a later page.
      page:forceRefresh ? 1 : Number(filters.page || 1),
      pageSize:Number(filters.pageSize || 20),
      entry_from:$("filterEntryFrom")?.value || "",
      entry_to:$("filterEntryTo")?.value || "",
      close_from:$("filterCloseFrom")?.value || "",
      close_to:$("filterCloseTo")?.value || "",
      direction:$("filterDirection")?.value || "",
      profit_filter:$("filterProfit")?.value || "",
    } : null,
  });
}

function historyErrorCode(error) {
  return String(error?.code || error?.error_code || error?.message || "").trim();
}

function historyCircuitError(code) {
  const error = new Error(apiErrorMessage(code));
  error.code = code;
  return error;
}

function historyCircuitAllows(key, { manualRefresh = false } = {}) {
  const current = _historyCircuitBreakers.get(key);
  if (!current) return true;
  if (current.expiresAt <= Date.now()) {
    _historyCircuitBreakers.delete(key);
    return true;
  }
  if (manualRefresh && !current.manualRetried) {
    current.manualRetried = true;
    return true;
  }
  throw historyCircuitError(current.code);
}

function rememberHistoryFailure(key, error) {
  const code = historyErrorCode(error);
  if (!HISTORY_CIRCUIT_BREAKER_CODES.has(code)) return;
  const previous = _historyCircuitBreakers.get(key);
  _historyCircuitBreakers.set(key, {
    code,
    generation:Number(state._accountContextGeneration || 0),
    expiresAt:Date.now() + HISTORY_CIRCUIT_BREAKER_TTL_MS,
    manualRetried:previous?.code === code && previous.expiresAt > Date.now()
      ? previous.manualRetried : false,
  });
}

function clearHistoryCircuit(key) {
  _historyCircuitBreakers.delete(key);
  for (const [noticeKey, noticeFlightKey] of _historyErrorNotices.entries()) {
    if (noticeFlightKey === key) _historyErrorNotices.delete(noticeKey);
  }
}

function notifyHistoryFailure(key, error) {
  const code = historyErrorCode(error);
  if (!code) return;
  const noticeKey = `${Number(state._accountContextGeneration || 0)}:${code}`;
  if (_historyErrorNotices.has(noticeKey)) return;
  _historyErrorNotices.set(noticeKey, key);
  toast(apiErrorMessage(code || error.message || "历史数据读取失败"), "error");
}

function historyFlightKey(kind, options = {}) {
  return `${kind}:${historyRefreshContextKey(options)}`;
}

function clearInvalidHistoryRangePreference(error) {
  const code = historyErrorCode(error);
  const looksLikeInvalidRange = /history.*(scope|range).*(floor|future|override|start|invalid)/i.test(code);
  if (!HISTORY_INVALID_OVERRIDE_CODES.has(code) && !looksLikeInvalidRange) return false;
  const scope = $("historyRangeMode")?.value || HISTORY_DEFAULT_SCOPE;
  if (!(scope === "all" || scope === "platform")) return false;
  const input = $("historyRangeFrom")?.value || "";
  const saved = historyPreferenceStart(scope);
  if (!saved || saved !== input) return false;
  historyClearSavedStart(scope);
  const payload = error?.data || error?.details || error?.payload || error;
  const meta = historyScopeMetaFromResponse(payload);
  state.historyRangeMeta = meta;
  if ($("historyRangeFrom") && meta.systemStartDate) $("historyRangeFrom").value = meta.systemStartDate;
  setText("historyRangeHint", `已保存的开始日期不可用，已恢复系统起点${meta.systemStartDate ? `：${meta.systemStartDate}` : ""}`);
  toast("已保存的开始日期已超出当前可查询范围，已恢复系统起点", "warning");
  return true;
}

function loadHistory(forceRefresh, options = {}) {
  const key = historyFlightKey("table", { forceRefresh:Boolean(forceRefresh) });
  const existing = _historyTableFlights.get(key);
  if (existing) return existing;
  const manualRefresh = options.manualRefresh === true;
  let requestCursorKey = null;
  const run = (async () => {
  try {
    const filters = state.historyFilters;
    const entryFrom = document.getElementById('filterEntryFrom')?.value || '';
    const entryTo = document.getElementById('filterEntryTo')?.value || '';
    const closeFrom = document.getElementById('filterCloseFrom')?.value || '';
    const closeTo = document.getElementById('filterCloseTo')?.value || '';
    const direction = document.getElementById('filterDirection')?.value || '';
    const profit = document.getElementById('filterProfit')?.value || '';
    const filterParams = getHistoryRangeParams();
    if (entryFrom) filterParams.entry_from = entryFrom;
    if (entryTo) filterParams.entry_to = entryTo;
    if (closeFrom) filterParams.filter_close_from = closeFrom;
    if (closeTo) filterParams.filter_close_to = closeTo;
    if (direction) filterParams.direction = direction;
    if (profit) filterParams.profit_filter = profit;

    const cursorKey = JSON.stringify({
      ...filterParams,
      pageSize:filters.pageSize,
      platform:state.bridgePlatform,
      account:state.bridgeAccountIdentity,
    });
    requestCursorKey = cursorKey;
    if (forceRefresh || _historyCursorState.key !== cursorKey) {
      filters.page = 1;
      const preserveFrozenRange = !forceRefresh
        && _historyCursorState.preserveRangeOnKeyChange === true;
      resetHistoryCursorState(cursorKey, { preserveRange:preserveFrozenRange });
    }
    if (filters.page > 1 && !_historyCursorState.pageCursors.has(filters.page)) {
      filters.page = 1;
      resetHistoryCursorState(cursorKey, {
        preserveRange:historyCursorRangeIsFixed(_historyCursorState),
      });
    }
    const requestContextKey = historyRefreshContextKey({ forceRefresh:false });
    const requestGeneration = Number(state._accountContextGeneration || 0);

    // Cache check
    const filterKey = JSON.stringify({ ...filterParams, page: filters.page, pageSize: filters.pageSize,
      snapshot:_historyCursorState.snapshotId });
    if (!forceRefresh && _historyCache && _historyCache.filters === filterKey) {
      if (!historyRangeContextMatches(requestContextKey, requestGeneration)) return null;
      const cachedData = _historyCache.data;
      applyHistoryScopeResponse(cachedData);
      await loadHistoryTicketMapsForData(cachedData);
      if (!historyRangeContextMatches(requestContextKey, requestGeneration)) return null;
      _applyHistoryData(cachedData, { tableOnly:options.tableOnly === true });
      return cachedData;
    }

    historyCircuitAllows(key, { manualRefresh });
    const cursor = _historyCursorState.pageCursors.get(filters.page) || null;
    const frozenRangeParams = typeof historyQueryRangeParams === "function"
      ? historyQueryRangeParams(_historyQueryState) : {};
    const rangeParams = Number.isSafeInteger(_historyCursorState.rangeStart)
      && Number.isSafeInteger(_historyCursorState.rangeEnd)
      && _historyCursorState.rangeStart > 0
      && _historyCursorState.rangeStart < _historyCursorState.rangeEnd
      ? {
          range_start_utc_msc:_historyCursorState.rangeStart,
          range_end_utc_msc:_historyCursorState.rangeEnd,
          ...frozenRangeParams,
        }
      : {};
    const data = await wsApi("history", {
      page:filters.page,
      page_size:filters.pageSize,
      force_refresh:Boolean(forceRefresh),
      ...filterParams,
      ...(Object.keys(rangeParams).length
        ? {
            ...(filters.page > 1 && _historyCursorState.snapshotId
              ? { history_snapshot_id:_historyCursorState.snapshotId }
              : {}),
            ...rangeParams,
          } : {}),
      ...(cursor ? { cursor } : {}),
    });
    if (!historyRangeContextMatches(requestContextKey, requestGeneration)) return null;
    if (data?.status !== 'success') {
      const error = new Error(data?.message || data?.error || '历史数据读取失败');
      error.code = data?.code || data?.error_code || data?.error || null;
      error.history_range = data?.history_range || null;
      error.data = data;
      throw error;
    }
    const responseRange = historyRangeFromError(data);
    applyHistoryScopeResponse(data);
    // MT4 currently reaches this path through the legacy compatibility read
    // because it does not implement history_prepare_status_v1. Every
    // successful page-one read is therefore authoritative for both its opaque
    // snapshot and its captured/allowed/system/effective boundaries. Re-pin
    // the range when page one is read again so a newer snapshot is never paired
    // with metadata from an earlier snapshot on Next.
    if (_historyQueryState?.legacyFallback === true
      && filters.page === 1
      && historyQueryIsCurrent(_historyQueryState)) {
      const legacyFrozenRange = historyPrepareRangeFromResponse(data);
      if (legacyFrozenRange) _historyQueryState.frozenRange = legacyFrozenRange;
    }
    const snapshotId = data.history_snapshot_id ? String(data.history_snapshot_id) : null;
    if (snapshotId && !responseRange) {
      throw new Error('历史快照范围无效，请重新读取第一页');
    }
    if (responseRange) {
      if (historyCursorRangeIsFixed(_historyCursorState)
        && (_historyCursorState.rangeStart !== responseRange.rangeStart
          || _historyCursorState.rangeEnd !== responseRange.rangeEnd)) {
        throw new Error('历史范围已变化，请重新读取第一页');
      }
      _historyCursorState.rangeStart = responseRange.rangeStart;
      _historyCursorState.rangeEnd = responseRange.rangeEnd;
    }
    if (snapshotId) {
      if (_historyCursorState.snapshotId && _historyCursorState.snapshotId !== snapshotId) {
        throw new Error('历史快照已变化，请重新读取第一页');
      }
      _historyCursorState.snapshotId = snapshotId;
      if (data.has_more === true && data.next_cursor) {
        _historyCursorState.pageCursors.set(filters.page + 1, String(data.next_cursor));
      } else {
        _historyCursorState.pageCursors.delete(filters.page + 1);
      }
    }
    const resolvedFilterKey = JSON.stringify({ ...filterParams, page:filters.page,
      pageSize:filters.pageSize, snapshot:_historyCursorState.snapshotId });
    _historyCache = { filters:resolvedFilterKey, data };
    await loadHistoryTicketMapsForData(data);
    if (!historyRangeContextMatches(requestContextKey, requestGeneration)) return null;
    _applyHistoryData(data, { tableOnly:options.tableOnly === true });
    clearHistoryCircuit(key);
    return data;
  } catch (e) {
    const incomplete = isHistoryCursorRangeIncomplete(e);
    if (typeof clearInvalidHistoryRangePreference === "function") clearInvalidHistoryRangePreference(e);
    const pendingRange = incomplete ? historyRangeFromError(e) : null;
    if (_historyCursorState.snapshotId && !incomplete) {
      resetHistoryCursorState(_historyCursorState.key, {
        preserveRange:historyCursorRangeIsFixed(_historyCursorState),
      });
    }
    if (_historyCursorState.snapshotId && incomplete) {
      _historyCursorState.snapshotId = null;
      _historyCursorState.pageCursors = new Map([[1, null]]);
    }
    if (pendingRange && requestCursorKey && _historyCursorState.key === requestCursorKey) {
      _historyCursorState.rangeStart = pendingRange.rangeStart;
      _historyCursorState.rangeEnd = pendingRange.rangeEnd;
    }
    if (!incomplete) console.error("loadHistory:", e);
    rememberHistoryFailure(key, e);
    if (!incomplete) notifyHistoryFailure(key, e);
    throw e;
  }
  })();
  _historyTableFlights.set(key, run);
  run.finally(() => {
    if (_historyTableFlights.get(key) === run) _historyTableFlights.delete(key);
  }).catch(() => {});
  return run;
}

function _applyHistoryData(data) {
  if (!data) return;
  const tableOnly = arguments[1]?.tableOnly === true;
  const sync = historySyncMetadata(data);
  const summaryReady = historySummaryReadyForRequestedRange(sync);
  const stats = summaryReady && data.statistics && typeof data.statistics === "object"
    ? data.statistics : null;
  if (stats && !tableOnly) {
    state.historyNetResult = Number.isFinite(Number(stats.net_result))
      ? Number(stats.net_result) : null;
    setText("historyProfit", fmt(stats.total_profit));
    setText("historyCredit", fmt(stats.credit));
    setText("historyDeposit", fmt(stats.deposit));
    setText("historyWithdrawal", fmt(stats.withdrawal));
    setText("historyNetResult", fmt(stats.net_result));
    $("historyProfit").className = `num ${profitClass(stats.total_profit)}`;
    $("historyNetResult").className = `num ${profitClass(stats.net_result)}`;
    ["historyCredit", "historyDeposit", "historyWithdrawal"].forEach((id) => {
      const key = id.replace("history", "").toLowerCase();
      setHistoryZeroClass(id, stats[key]);
    });
  } else if (!tableOnly) {
    state.historyNetResult = null;
    ["historyProfit", "historyCredit", "historyDeposit", "historyWithdrawal", "historyNetResult"]
      .forEach(id => setText(id, "--"));
  }
  const rows = data.orders || [];
  const tickets = state.signalTickets || {};
  const closeTickets = state.closeSignalTickets || {};
  _renderHistoryRows(rows, tickets, closeTickets);
  const pg = data.pagination || {};
  const totalCount = Number(pg.total_count);
  if (Number.isSafeInteger(totalCount) && totalCount >= 0 && summaryReady) {
    renderPager("historyPager", pg.current_page || 1, pg.page_size || 20, totalCount, "history");
    setText("historyFilterCount", `${totalCount} 笔`);
  } else {
    if ($("historyPager")) $("historyPager").innerHTML = "";
    setText("historyFilterCount", `已显示 ${rows.length} 笔 · 全量统计准备中`);
  }
}

// Chart and summary use the same explicit history scope as the table.
function loadHistoryChart(forceRefresh, options = {}) {
  const key = historyFlightKey("chart", { forceRefresh:Boolean(forceRefresh), includeTableFilters:false });
  const existing = _historyChartFlights.get(key);
  if (existing) return existing;
  const manualRefresh = options.manualRefresh === true;
  const run = (async () => {
  try {
    const requestContextKey = historyRefreshContextKey({ forceRefresh:false, includeTableFilters:false });
    const requestGeneration = Number(state._accountContextGeneration || 0);
    const params = getHistoryRangeParams();
    const frozenRangeParams = typeof historyQueryRangeParams === "function"
      ? historyQueryRangeParams(_historyQueryState) : {};
    const rangeParams = Number.isSafeInteger(_historyCursorState.rangeStart)
      && Number.isSafeInteger(_historyCursorState.rangeEnd)
      && _historyCursorState.rangeStart > 0
      && _historyCursorState.rangeStart < _historyCursorState.rangeEnd
      ? {
          range_start_utc_msc:_historyCursorState.rangeStart,
          range_end_utc_msc:_historyCursorState.rangeEnd,
          ...frozenRangeParams,
        }
      : {};
    const requestParams = { ...params, ...rangeParams };

    const filterKey = JSON.stringify({ scope:requestParams, account:historyStableAccountKey() });
    if (!forceRefresh && _historyChartCache && _historyChartCache.filters === filterKey) {
      if (!historyRangeContextMatches(requestContextKey, requestGeneration, { includeTableFilters:false })) return null;
      _renderHistoryChart(_historyChartCache.data);
      return;
    }

    historyCircuitAllows(key, { manualRefresh });
    const data = await wsApi("history_chart_data", { ...requestParams, force_refresh:Boolean(forceRefresh) });
    if (!historyRangeContextMatches(requestContextKey, requestGeneration, { includeTableFilters:false })) return null;
    if (data?.status !== 'success') {
      const error = new Error(data?.message || data?.error || '历史图表读取失败');
      error.code = data?.code || data?.error_code || data?.error || null;
      error.history_range = data?.history_range || null;
      error.data = data;
      throw error;
    }
    applyHistoryScopeResponse(data);
    _historyChartCache = { filters: filterKey, data };
    await ensureChartJs();
    _renderHistoryChart(data);
    clearHistoryCircuit(key);
  } catch (e) {
    if (typeof clearInvalidHistoryRangePreference === "function") clearInvalidHistoryRangePreference(e);
    if (!isHistoryCursorRangeIncomplete(e)) console.error("loadHistoryChart:", e);
    rememberHistoryFailure(key, e);
    if (!isHistoryCursorRangeIncomplete(e)) notifyHistoryFailure(key, e);
    throw e;
  }
  })();
  _historyChartFlights.set(key, run);
  run.finally(() => {
    if (_historyChartFlights.get(key) === run) _historyChartFlights.delete(key);
  }).catch(() => {});
  return run;
}

function loadHistoryViewsLegacy({ forceRefresh = false, includeAccount = false, manualRefresh = false, historyRetryAttempt = false, tableOnly = false, disableRangeRetry = false, disableFreshnessRetry = false } = {}) {
  if (manualRefresh) {
    cancelHistoryRangeRetry();
    cancelHistoryLegacySummaryRetry();
  }
  const currentRetryContext = historyRetryContextKey();
  if (_historyRangeRetryState
    && (activeTabId() !== "history" || _historyRangeRetryState.contextKey !== currentRetryContext)) {
    cancelHistoryRangeRetry();
  }
  // Freshness/summary retries are read-only continuation requests.  They
  // must not inherit `_historyDirty`'s first-page force refresh because that
  // would drop the pinned range and make the server capture a new endpoint.
  const automaticRetry = historyRetryAttempt === true && manualRefresh !== true;
  const effectiveForceRefresh = Boolean(!tableOnly && !automaticRetry && (forceRefresh || _historyDirty));
  const key = `${historyFlightKey("views", { forceRefresh:effectiveForceRefresh })}:${tableOnly ? "table-only" : "full"}`;
  const existing = _historyViewsFlights.get(key);
  if (existing) return existing;
  const effectiveManualRefresh = manualRefresh;
  const refresh = (async () => {
    if (automaticRetry) {
      // Drop the old snapshot/cursors so the bridge reads the newest sync and
      // summary state, while retaining the cursor key and exact range chosen
      // by the successful first request.
      resetHistorySnapshotState({ preserveRange:true });
    } else if (effectiveForceRefresh) {
      _historyCache = null;
      _historyChartCache = null;
    }
    if (includeAccount) await loadAccount();
    const requestContextKey = historyRetryContextKey();
    let tableData = null;
    try {
      tableData = await loadHistory(effectiveForceRefresh, { manualRefresh:effectiveManualRefresh, tableOnly });
    } catch (error) {
      if (isHistoryCursorRangeIncomplete(error)) {
        if (disableRangeRetry) throw error;
        if (activeTabId() !== "history" || requestContextKey !== historyRetryContextKey()) {
          return { historyPending:false, historyStale:true };
        }
        renderHistoryPreparationStatus();
        if (!historyRetryAttempt && !disableRangeRetry) scheduleHistoryRangeRetry({ contextKey:requestContextKey });
        return { historyPending:true };
      }
      throw error;
    }
    if (!tableData) return { historyPending:false, historyStale:true };
    if (tableOnly) return { historyPending:false, tableOnly:true };
    if (_historyRangeRetryState?.contextKey === requestContextKey) {
      finishHistoryRangeRetry(_historyRangeRetryState);
    }
    const sync = historySyncMetadata(tableData);
    // loadHistory pins the response revision before loading ticket maps and
    // keeps it stable through the table render; do not overwrite it here
    // after asynchronous map work has completed.
    if (sync.freshness_state === "fresh") _historyDirty = false;
    else if (sync.freshness_state) _historyDirty = true;
    if (!disableFreshnessRetry) scheduleHistoryFreshnessRetry(tableData);
    if (!historySummaryReadyForRequestedRange(sync)) {
      return { historyPending:false, historyStale:_historyDirty, summaryPending:true };
    }
    const embeddedChart = tableData?.chart_data && typeof tableData.chart_data === "object"
      ? tableData.chart_data : null;
    if (embeddedChart) {
      await ensureChartJs();
      _renderHistoryChart(embeddedChart);
      _historyChartCache = {
        filters:`embedded:${historyRefreshContextKey({ forceRefresh:false, includeTableFilters:false })}`,
        data:embeddedChart,
      };
      return { historyPending:false, embeddedChart:true };
    }
    // Cursor continuations intentionally omit the already rendered chart to
    // keep every later page minimal.
    if (Number(state.historyFilters?.page || 1) > 1 && _historyChartCache) {
      return { historyPending:false, embeddedChart:true };
    }
    // The table owns the single forced terminal sync. The chart then reads the
    // refreshed Bridge archive only as a compatibility fallback.
    try {
      await loadHistoryChart(false, { manualRefresh:effectiveManualRefresh });
    } catch (error) {
      if (!isHistoryCursorRangeIncomplete(error)) throw error;
      if (disableRangeRetry) throw error;
      const pendingRange = historyRangeFromError(error);
      if (pendingRange && requestContextKey === historyRetryContextKey() && _historyCursorState.key) {
        _historyCursorState.rangeStart = pendingRange.rangeStart;
        _historyCursorState.rangeEnd = pendingRange.rangeEnd;
      }
      renderHistoryPreparationStatus();
      if (!historyRetryAttempt && !disableRangeRetry) scheduleHistoryRangeRetry({ contextKey:requestContextKey });
      return { historyPending:true };
    }
    return { historyPending:false };
  })();
  _historyViewsFlights.set(key, refresh);
  refresh.finally(() => {
    if (_historyViewsFlights.get(key) === refresh) _historyViewsFlights.delete(key);
  }).catch(() => {
  });
  return refresh;
}

function loadHistoryViews(options = {}) {
  // The compatibility implementation below remains in
  // loadHistoryViewsLegacy. Keep these invariants close to the public entry
  // point for code readers and static contract checks:
  // if (manualRefresh) cancelHistoryRangeRetry()
  // if (sync.freshness_state === "fresh") _historyDirty = false
  // const automaticRetry = historyRetryAttempt === true && manualRefresh !== true
  // const effectiveForceRefresh = Boolean(!tableOnly && !automaticRetry && (forceRefresh || _historyDirty))
  // resetHistorySnapshotState({ preserveRange:true })
  // finishHistoryRangeRetry(_historyRangeRetryState)
  // scheduleHistoryFreshnessRetry(tableData)
  // _historyRangeRetryState.contextKey !== currentRetryContext
  // tableData?.chart_data
  // loadHistory(effectiveForceRefresh, { manualRefresh:effectiveManualRefresh, tableOnly })
  // await loadHistory(effectiveForceRefresh, { manualRefresh:effectiveManualRefresh, tableOnly })
  // return { historyPending:true }
  // _renderHistoryChart(embeddedChart)
  // Number(state.historyFilters?.page || 1) > 1 && _historyChartCache
  // await loadHistoryChart(false, { manualRefresh:effectiveManualRefresh })
  // loadHistoryChart(false, { manualRefresh:effectiveManualRefresh })
  // Explicit enter equivalent: loadHistoryViews({ newQuery:true, trigger:"enter" })
  // const key = `${historyFlightKey("views", { forceRefresh:effectiveForceRefresh })}:${tableOnly ? "table-only" : "full"}`
  const {
    newQuery = false,
    trigger = options.manualRefresh === true ? "refresh" : "enter",
    tableOnly = false,
    historyRetryAttempt = false,
    skipPrepare = false,
  } = options;
  const continuation = tableOnly || historyRetryAttempt || skipPrepare;
  if (newQuery === true || (!continuation && activeTabId() === "history"
    && (["enter", "refresh"].includes(trigger) || !state.historyQueryState))) {
    const query = beginHistoryQuery(trigger);
    return runHistoryQuery(query, options);
  }
  if (!continuation && state.historyQueryState
    && ["preparing_time", "syncing_tail", "loading_snapshot"].includes(state.historyQueryState.status)) {
    return runHistoryQuery(state.historyQueryState, options);
  }
  return loadHistoryViewsLegacy(options);
}

function historyProtectionCell(row, field) {
  const isStopLoss = field === "stop_loss";
  const displayValue = row?.[isStopLoss ? "display_stop_loss" : "display_take_profit"]
    ?? row?.[field];
  if (!(Number(displayValue) > 0)) return "--";
  const source = row?.[isStopLoss ? "stop_loss_source" : "take_profit_source"];
  const entryValue = row?.[isStopLoss ? "mt5_entry_stop_loss" : "mt5_entry_take_profit"]
    ?? row?.[field];
  const verified = source === "verified_platform_protection";
  const label = isStopLoss ? "止损" : "止盈";
  const entryText = Number(entryValue) > 0 ? raw(entryValue) : "--";
  const title = verified
    ? `${label}显示平台最后一次已验证修改值；MT5 开仓历史订单值为 ${entryText}`
    : `${label}来自 MT5 开仓历史订单；平仓历史不会返回后续未纳管的人工修改`;
  return `<span class="history-protection-value" title="${escapeHtml(title)}">${escapeHtml(raw(displayValue))}${verified ? '<small>已更新</small>' : ''}</span>`;
}

function _renderHistoryRows(rows, tickets, closeTickets) {
  $("historyBody").innerHTML = rows.length ? rows.map((row) => {
    const dir = signalType(row.type);
    const comment = row.comment || "";
    const ticket = row.order || row.ticket;
    const exitPrice = row.exit_price ?? row.price;
    const closeInfo = closeTickets[String(ticket)];
    const exitPriceCell = closeInfo
      ? `<td data-label="平仓价" class="num"><a href="#" class="signal-link close-price-link" onclick="event.preventDefault(); openAnalysisFromHistory(${closeInfo.signalId}, { source:'history', forcePinned:true })" title="点击查看平仓分析">${escapeHtml(raw(closeInfo.price ?? exitPrice))}</a></td>`
      : `<td data-label="平仓价" class="num">${escapeHtml(raw(exitPrice))}</td>`;
    return `
    <tr data-ticket="${escapeHtml(String(ticket))}">
      <td data-label="开仓时间" class="num">${escapeHtml(formatTime(row.entry_time))}</td>
      <td data-label="品种">${escapeHtml(row.symbol)}</td>
      ${ticketCell(ticket, tickets)}
      <td data-label="方向"><span class="tag ${dir}">${directionText(row.type || dir)}</span></td>
      <td data-label="手数" class="num">${escapeHtml(volumeText(row.volume))}</td>
      <td data-label="入场价" class="num">${escapeHtml(raw(row.entry_price))}</td>
      <td data-label="止损" class="num">${historyProtectionCell(row, "stop_loss")}</td>
      <td data-label="止盈" class="num">${historyProtectionCell(row, "take_profit")}</td>
      <td data-label="平仓时间" class="num">${escapeHtml(formatTime(row.close_time || row.time))}</td>
      ${exitPriceCell}
      <td data-label="盈亏" class="${profitClass(row.profit)}">${fmt(row.profit)}</td>
      <td data-label="收益率" class="${profitClass(row.profit || 0)}">${row.profit != null && row.entry_price && row.volume ? (row.profit / (row.volume * row.entry_price * (row.contract_size || 100)) * 100).toFixed(2) + '%' : '--'}</td>
      <td data-label="备注" class="comment-cell">${closeInfo ? `<span class="close-remark-tag" title="智能平仓">tp ${escapeHtml(raw(closeInfo.takeProfit ?? closeInfo.price ?? exitPrice))}</span>` : `<span class="comment-ellipsis" title="${escapeHtml(comment || "--")}">${escapeHtml(comment || "--")}</span>`}</td>
    </tr>  `;
  }).join("") : '<tr class="empty-row"><td colspan="13">暂无成交记录</td></tr>';
}

let _historyChart = null;

/* ---- History Profit Chart ---- */

/* ---- Chart date range state ---- */

/* ---- Data labels plugin (show values on bars when few points) ---- */
const barLabelPlugin = {
  id: 'barLabels',
  afterDatasetsDraw(chart) {
    const meta = chart.getDatasetMeta(0);
    if (meta.data.length > 15) return; // too many bars
    const ctx = chart.ctx;
    ctx.save();
    ctx.font = '9px sans-serif';
    ctx.textAlign = 'center';
    const dataset = chart.data.datasets[0];
    meta.data.forEach((bar) => {
      const idx = bar.index; // Chart.js 内部数据索引，避免 forEach 循环索引错位
      const val = dataset.data[idx];
      if (val === undefined) return;
      ctx.fillStyle = val >= 0 ? '#ef4444' : '#10b981';
      ctx.fillText((val >= 0 ? '+' : '') + val.toFixed(2), bar.x, bar.y - 5);
    });
    ctx.restore();
  }
};

/* ---- Zero line plugin ---- */
const zeroLinePlugin = {
  id: 'zeroLine',
  beforeDraw(chart) {
    const yScale = chart.scales.y;
    if (!yScale) return;
    const y = yScale.getPixelForValue(0);
    const ctx = chart.ctx;
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(chart.chartArea.left, y);
    ctx.lineTo(chart.chartArea.right, y);
    ctx.strokeStyle = 'rgba(255,255,255,0.15)';
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 4]);
    ctx.stroke();
    ctx.restore();
  }
};


function normalizeHistoryChartData(data = {}) {
  const source = data?.chart_data && typeof data.chart_data === "object"
    ? data.chart_data : data;
  let daily = Array.isArray(source?.daily) ? source.daily : Array.isArray(source?.days) ? source.days : [];
  let cumulative = Array.isArray(source?.cumulative) ? source.cumulative : [];
  let drawdown = Array.isArray(source?.drawdown) ? source.drawdown : [];
  daily = daily.map(item => ({
    ...item,
    date:String(item?.date || item?.business_date || item?.close_business_date || "").slice(0, 10),
    profit:Number(item?.profit ?? item?.net_profit ?? item?.total_profit ?? 0),
  })).filter(item => validHistoryBusinessDate(item.date));
  if (!cumulative.length || cumulative.length !== daily.length) {
    let running = 0;
    cumulative = daily.map(item => { running += Number(item.profit) || 0; return running; });
  } else cumulative = cumulative.slice(-daily.length).map(value => Number(value) || 0);
  if (!drawdown.length || drawdown.length !== daily.length) {
    let peak = 0;
    drawdown = cumulative.map(value => {
      peak = Math.max(peak, value);
      return peak > 0 ? Number(((peak - value) / peak * 100).toFixed(2)) : 0;
    });
  } else drawdown = drawdown.slice(-daily.length).map(value => Number(value) || 0);
  const stats = source?.stats || source?.statistics || data?.chart_statistics || {};
  return { daily, cumulative, drawdown, stats:stats && typeof stats === "object" ? stats : {}, source };
}

function historyChartDayAt(index) {
  const dayIndex = Number(index);
  return Number.isInteger(dayIndex) && dayIndex >= 0 && dayIndex < state.historyChartDaily.length
    ? state.historyChartDaily[dayIndex] : null;
}

function applyHistoryChartDrilldown(index) {
  const day = historyChartDayAt(index);
  if (!day?.date) return false;
  state.historyChartFocusIndex = Number(index);
  state.historyChartSelectedDate = day.date;
  const from = $("filterCloseFrom");
  const to = $("filterCloseTo");
  if (from) from.value = day.date;
  if (to) to.value = day.date;
  state.historyFilters.page = 1;
  state.historyFilters.closeFrom = day.date;
  state.historyFilters.closeTo = day.date;
  resetHistoryCursorState(null, { preserveRange:true });
  _historyCache = null;
  setText("historyChartDrilldownStatus", `明细正在显示 ${day.date} 的平仓记录`);
  if (_historyChart) {
    _historyChart.data.datasets[0].borderColor = state.historyChartDaily.map(item => item.date === day.date ? "#d4af37" : (Number(item.profit) >= 0 ? "rgba(239,68,68,0.8)" : "rgba(16,185,129,0.8)"));
    _historyChart.data.datasets[0].backgroundColor = state.historyChartDaily.map(item => item.date === day.date ? "rgba(212,175,55,0.68)" : (Number(item.profit) >= 0 ? "rgba(239,68,68,0.5)" : "rgba(16,185,129,0.5)"));
    _historyChart.update("none");
  }
  loadHistoryViews({ tableOnly:true }).catch(() => {});
  return true;
}

function bindHistoryChartKeyboard(canvas) {
  if (!canvas || canvas.dataset.historyKeyboardBound === "1") return;
  canvas.dataset.historyKeyboardBound = "1";
  canvas.addEventListener("keydown", event => {
    const total = state.historyChartDaily.length;
    if (!total) return;
    if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
      event.preventDefault();
      const current = state.historyChartFocusIndex >= 0
        ? state.historyChartFocusIndex
        : Math.max(0, state.historyChartDaily.findIndex(item => item.date === state.historyChartSelectedDate));
      const next = Math.min(total - 1, Math.max(0, current + (event.key === "ArrowLeft" ? -1 : 1)));
      state.historyChartFocusIndex = next;
      const day = historyChartDayAt(next);
      setText("historyChartDrilldownStatus", `已聚焦 ${day?.date || "--"}，按 Enter 或空格应用平仓筛选`);
      return;
    }
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      applyHistoryChartDrilldown(state.historyChartFocusIndex >= 0 ? state.historyChartFocusIndex : 0);
    }
  });
}

function _renderHistoryChart(data) {
  const normalized = normalizeHistoryChartData(data);
  const { daily = [], cumulative = [], drawdown = [], stats = {} } = normalized;
  const chartSync = data?.history_sync && typeof data.history_sync === "object"
    ? historySyncMetadata(data) : null;
  const chartStatsReady = !chartSync || historySummaryReadyForRequestedRange(chartSync);
  const visibleStats = chartStatsReady ? stats : {};
  state.historyChartDaily = daily;
  if (state.historyChartSelectedDate && !daily.some(item => item.date === state.historyChartSelectedDate)) {
    state.historyChartSelectedDate = "";
  }
  const el = id => document.getElementById(id);
  if (el('chartTotalTrades')) el('chartTotalTrades').textContent = Number.isFinite(Number(visibleStats.total_trades)) ? String(visibleStats.total_trades) : '--';
  if (el('chartWinRate')) el('chartWinRate').textContent = Number.isFinite(Number(visibleStats.win_rate)) ? Number(visibleStats.win_rate).toFixed(1) + '%' : '--';
  if (el('chartWinRate')) el('chartWinRate').className = 'chart-stat-value ' + (Number(visibleStats.win_rate) >= 50 ? 'positive' : Number.isFinite(Number(visibleStats.win_rate)) ? 'negative' : '');
  if (el('chartProfitFactor')) el('chartProfitFactor').textContent = Number(visibleStats.profit_factor) >= 999 ? '∞' : Number.isFinite(Number(visibleStats.profit_factor)) ? Number(visibleStats.profit_factor).toFixed(2) : '--';
  if (el('chartProfitFactor')) el('chartProfitFactor').className = 'chart-stat-value ' + (Number(visibleStats.profit_factor) >= 1 ? 'positive' : Number.isFinite(Number(visibleStats.profit_factor)) ? 'negative' : '');
  if (el('chartMaxDD')) el('chartMaxDD').textContent = Number.isFinite(Number(visibleStats.max_drawdown)) ? Number(visibleStats.max_drawdown).toFixed(2) + '%' : '--';
  if (el('chartMaxDD')) el('chartMaxDD').className = 'chart-stat-value ' + (Number(visibleStats.max_drawdown) > 10 ? 'negative' : '');
  const statLabels = {
    chartTotalTrades:"总交易",
    chartWinRate:"胜率",
    chartProfitFactor:"盈亏比",
    chartMaxDD:"最大回撤",
  };
  Object.entries(statLabels).forEach(([id, label]) => {
    const node = el(id);
    if (node) node.setAttribute("aria-label", `${label}${node.textContent || "暂无数据"}`);
  });
  setText("historyChartDrilldownStatus", state.historyChartSelectedDate
    ? `明细正在显示 ${state.historyChartSelectedDate} 的平仓记录`
    : "点击柱状图或使用键盘选择某个平仓日查看明细");

  if (!daily.length) {
    if (_historyChart) { _historyChart.destroy(); _historyChart = null; }
    return;
  }

  const labels = daily.map(d => d.date.slice(5));
  const dailyProfits = daily.map(d => d.profit);
  const lastCum = cumulative[cumulative.length - 1] || 0;
  const lineColor = lastCum >= 0 ? '#ef4444' : '#10b981';
  const fillColor = lastCum >= 0 ? 'rgba(239,68,68,0.12)' : 'rgba(16,185,129,0.12)';
  const selectedDate = state.historyChartSelectedDate;
  const barBorders = daily.map((item, index) => item.date === selectedDate
    ? '#d4af37' : (dailyProfits[index] >= 0 ? 'rgba(239,68,68,0.8)' : 'rgba(16,185,129,0.8)'));
  const barBorderWidths = daily.map(item => item.date === selectedDate ? 2 : 1);
  const barBackgrounds = daily.map((item, index) => item.date === selectedDate
    ? 'rgba(212,175,55,0.68)' : (dailyProfits[index] >= 0 ? 'rgba(239,68,68,0.5)' : 'rgba(16,185,129,0.5)'));

  const canvas = document.getElementById('historyChart');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');

  if (_historyChart) _historyChart.destroy();
  _historyChart = new Chart(ctx, {
    type: 'bar',
    plugins: [zeroLinePlugin, barLabelPlugin],
    data: {
      labels,
      datasets: [
        {
          type: 'bar',
          label: '每日盈亏',
          data: dailyProfits,
          backgroundColor: barBackgrounds,
          borderColor: barBorders,
          borderWidth: barBorderWidths,
          borderRadius: 3,
          yAxisID: 'y',
          order: 2,
        },
        {
          type: 'line',
          label: '累计收益',
          data: cumulative,
          borderColor: lineColor,
          backgroundColor: fillColor,
          borderWidth: 2,
          pointRadius: 3,
          pointHoverRadius: 6,
          pointBackgroundColor: lineColor,
          pointBorderColor: 'transparent',
          tension: 0.35,
          fill: true,
          yAxisID: 'y2',
          order: 1,
        },
        {
          type: 'line',
          label: '回撤 %',
          data: drawdown,
          borderColor: 'rgba(251,191,36,0.5)',
          backgroundColor: 'rgba(251,191,36,0.06)',
          borderWidth: 1,
          pointRadius: 0,
          pointHoverRadius: 3,
          tension: 0.35,
          fill: true,
          yAxisID: 'y3',
          order: 3,
        }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'nearest', intersect: true },
      onClick: (e, elements) => {
        if (!elements.length || elements[0].datasetIndex !== 0) return;
        const idx = elements[0].index;
        applyHistoryChartDrilldown(idx);
      },
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: 'rgba(17,24,39,0.95)',
          borderColor: 'rgba(212,175,55,0.3)',
          borderWidth: 1,
          titleFont: { size: 11 },
          bodyFont: { size: 11 },
          callbacks: {
            label: ctx => ctx.dataset.label + ': ' + (ctx.parsed.y >= 0 ? '+' : '') + ctx.parsed.y.toFixed(2)
          }
        }
      },
      scales: {
        x: {
          grid: { color: 'rgba(255,255,255,0.03)' },
          ticks: { color: '#4a5568', font: { size: 10 } }
        },
        y: {
          position: 'left',
          grid: { color: 'rgba(255,255,255,0.03)' },
          ticks: { color: '#4a5568', font: { size: 10 }, callback: v => v.toFixed(0) },
          title: { display: true, text: '每日盈亏', color: '#4a5568', font: { size: 10 } }
        },
        y2: {
          position: 'right',
          grid: { display: false },
          ticks: { color: lineColor, font: { size: 10 }, callback: v => v.toFixed(0) },
          title: { display: true, text: '累计收益', color: lineColor, font: { size: 10 } }
        },
        y3: {
          position: 'right',
          display: false,
          grid: { drawOnChartArea: false },
          reverse: true,
          ticks: { color: '#4a5568', font: { size: 10 }, callback: v => v + '%' },
        }
      }
    }
  });
  bindHistoryChartKeyboard(canvas);
}


const POSITION_MANAGEMENT_STATUS = {
  CANDIDATE: { label:"等待下一轮确认", tone:"candidate" },
  EVIDENCE_CONFIRMED: { label:"连续确认已完成", tone:"confirmed" },
  PRECONDITIONS_LOCKED: { label:"执行条件已锁定", tone:"confirmed" },
  PENDING_CANCEL_INTENT: { label:"已创建取消意图", tone:"candidate" },
  PENDING_CANCEL_SENT: { label:"取消命令已发送", tone:"candidate" },
  PENDING_RECONCILING: { label:"正在核对挂单终态", tone:"candidate" },
  PENDING_CANCEL_CONFIRMED: { label:"挂单取消已确认", tone:"completed" },
  PENDING_FILLED_DURING_CANCEL: { label:"取消时已经成交", tone:"failed" },
  PENDING_UNCERTAIN: { label:"挂单终态待确认", tone:"candidate" },
  CLOSE_INTENT_CREATED: { label:"已创建平仓意图", tone:"candidate" },
  CLOSE_SENT: { label:"平仓命令已发送", tone:"candidate" },
  CLOSE_RECONCILING: { label:"正在核对持仓终态", tone:"candidate" },
  CLOSE_CONFIRMED: { label:"持仓平仓已确认", tone:"completed" },
  CLOSE_PARTIAL: { label:"持仓仅部分平仓", tone:"failed" },
  CLOSE_UNCERTAIN: { label:"平仓终态待确认", tone:"candidate" },
  MANUAL_REVIEW: { label:"需要人工复核", tone:"failed" },
  HELD: { label:"继续持有", tone:"completed" },
  COMPLETED: { label:"已完成", tone:"completed" },
  EXIT_ONLY_COMPLETED: { label:"平仓已完成", tone:"completed" },
  REJECTED: { label:"已拒绝", tone:"failed" },
  FAILED: { label:"异常", tone:"failed" },
  EXPIRED: { label:"已过期", tone:"expired" },
};

function positionManagementStatus(status) {
  return POSITION_MANAGEMENT_STATUS[String(status || "").toUpperCase()]
    || { label:String(status || "未知状态"), tone:"" };
}

function positionManagementMode(mode) {
  return ({ display:"关闭", shadow:"关闭", auto_exit:"自动平仓", auto_reverse:"自动平仓" })[mode] || "关闭";
}

function positionManagementTaskLabel(type) {
  return type === "pending_cancel" ? "挂单管理" : "持仓平仓";
}

function positionManagementTaskMode(task = {}) {
  return task.task_type === "pending_cancel" ? "自动撤单" : positionManagementMode(task.execution_mode);
}

function positionManagementActionLabel(action) {
  return ({ exit:"建议平仓", cancel:"建议取消", hold:"继续持有", keep:"继续保留" })[action] || raw(action);
}

const POSITION_MANAGEMENT_DECISION_REASONS = Object.freeze({
  current_thesis_invalidated:"当前行情已使本轮持仓逻辑失效",
  trend_reversal:"当前趋势或结构已经反转",
  risk_reduction:"基于当前风险状态建议降低风险",
  model_judgment:"模型依据本轮综合证据作出判断",
  expired:"交易终端已确认挂单过期",
  thesis_invalidated:"当前行情已使挂单逻辑失效",
});

function positionManagementDecisionReason(model = {}) {
  const code = String(model.exit_reason_code || model.cancel_reason_code || "").toLowerCase();
  return POSITION_MANAGEMENT_DECISION_REASONS[code] || "";
}

function positionManagementBarTime(task) {
  const timestamp = Number(task?.closed_bar_time_utc_ms);
  if (!Number.isFinite(timestamp) || timestamp <= 0) return "--";
  const offset = state.mt5TimezoneOffsetMinutes == null ? Number.NaN : Number(state.mt5TimezoneOffsetMinutes);
  if (!Number.isInteger(offset)) return "时间待终端校准";
  return fmtUtc(new Date(timestamp + offset * 60_000));
}

function positionManagementDecisionTime(task) {
  const timestamp = parseBeijingServerTime(task?.updated_at || task?.created_at);
  if (!Number.isFinite(timestamp)) return positionManagementBarTime(task);
  const offset = state.mt5TimezoneOffsetMinutes == null ? Number.NaN : Number(state.mt5TimezoneOffsetMinutes);
  if (!Number.isInteger(offset)) return "时间待终端校准";
  return fmtUtc(new Date(timestamp + offset * 60_000));
}

function positionManagementEventTime(event) {
  const timestamp = parseBeijingServerTime(event?.created_at);
  if (!Number.isFinite(timestamp)) return "--";
  const offset = state.mt5TimezoneOffsetMinutes == null ? Number.NaN : Number(state.mt5TimezoneOffsetMinutes);
  if (!Number.isInteger(offset)) return "时间待终端校准";
  return fmtUtc(new Date(timestamp + offset * 60_000));
}

const POSITION_MANAGEMENT_EVENT_REASONS = Object.freeze({
  position_attribution_incomplete:"成交归属尚未完成，系统无法确认完整开仓手数",
  bridge_generation_mismatch:"Bridge 已重新连接，任务创建时的连接已失效",
  account_ownership_generation_mismatch:"账户归属已变化，系统已停止执行",
  position_already_absent:"目标持仓已不在 MT5 当前持仓中",
  full_position_volume_required:"系统无法确认当前持仓仍是完整开仓手数",
  position_ticket_missing:"缺少可核对的 MT5 持仓票号",
  position_symbol_mismatch:"MT5 当前持仓品种与任务不一致",
  position_direction_mismatch:"MT5 当前持仓方向与任务不一致",
  position_magic_mismatch:"持仓不再满足系统订单标识",
  position_volume_mismatch:"MT5 当前手数与系统记录不一致",
  position_missing_stop_loss:"目标持仓缺少有效止损",
  position_invalid_stop_loss_direction:"目标持仓止损方向异常",
  pending_order_absent:"目标挂单已不在 MT5 当前挂单中",
});

function positionManagementEventSummary(event = {}) {
  const summary = event.summary || event.event_type || "状态已更新";
  const details = parseJsonField(event.details_json, {});
  const reasonCode = String(details.code || details.reason_code || "");
  const reason = POSITION_MANAGEMENT_EVENT_REASONS[reasonCode];
  return reason && !String(summary).includes(reason) ? `${summary}；${reason}` : summary;
}

function positionManagementDirection(direction) {
  const value = String(direction || "").toLowerCase();
  return value === "buy" ? "买入" : value === "sell" ? "卖出" : "--";
}

function positionManagementConfirmationMeta(task = {}, evidence = {}) {
  if (task.task_type === "pending_cancel") {
    if (task.status === "EXPIRED") return { label:"旧撤单复核已结束", tone:"expired", count:0, required:1 };
    return evidence.status === "confirmed" || task.status !== "CANDIDATE"
      ? { label:"撤单判断已确认", tone:"confirmed", count:1, required:1 }
      : { label:"等待撤单执行", tone:"candidate", count:0, required:1 };
  }
  const required = Math.max(1, Number(task.required_confirmations || evidence.required_confirmations || 2));
  const count = Math.max(0, Math.min(required, Number(task.confirmation_count ?? evidence.confirmation_count ?? 0)));
  if (evidence.status === "reset") return { label:"连续确认已清零", tone:"completed", count:0, required };
  if (evidence.status === "expired" || task.status === "EXPIRED") return { label:"目标持仓已结束", tone:"expired", count:0, required };
  if (count >= required || evidence.status === "confirmed") return { label:`连续确认 ${required}/${required}`, tone:"confirmed", count:required, required };
  return { label:`平仓确认 ${count || 1}/${required}`, tone:"candidate", count:count || 1, required };
}

function positionManagementEvidenceSource(source) {
  return ({
    automatic_inference_consecutive:"连续自动推理判断",
    automatic_inference_hold:"自动推理改为继续持有",
    invalid_inference_output:"自动推理结果校验失败",
    position_no_longer_active:"目标持仓已经结束",
    pending_cancel_first_confirmation:"首次撤单判断",
    two_closed_bar_pending_confirmations:"连续撤单判断已确认",
    single_inference_pending_cancel:"单轮自动推理撤单判断",
  })[source] || "自动推理记录";
}

function positionManagementConditionText(condition = {}) {
  if (condition.description) return condition.description;
  const threshold = Number(condition.threshold);
  if (condition.type === "protective_stop" && Number.isFinite(threshold)) {
    return `${condition.timeframe || "决策周期"}收盘价触及保护价 ${priceDisplay(threshold)}`;
  }
  return "本轮AI引用了原交易论点中的失效条件";
}

function renderPositionManagementOverview(tasks = [], settings = {}, pagination = {}) {
  const host = $("positionManagementOverview");
  if (!host) return;
  const confirmed = tasks.filter(task => task.status === "EVIDENCE_CONFIRMED").length;
  const waiting = tasks.filter(task => task.status === "CANDIDATE").length;
  const mode = settings.effective_mode || "display";
  const platformAutoCloseEnabled = ["auto_exit", "auto_reverse"].includes(settings.platform?.maximum_mode);
  const pendingOrderEnabled = Number(settings.platform?.ai_pending_order_enabled ?? 0) === 1;
  const pendingCancelEnabled = Number(settings.platform?.ai_pending_cancel_enabled ?? 0) === 1;
  const kicker = $("positionManagementModeKicker");
  if (kicker) kicker.textContent = `统一推理 · ${positionManagementMode(mode)}`;
  const description = $("positionManagementModeDescription");
  if (description) description.textContent = mode === "auto_exit"
    ? `自动平仓已生效；同一持仓连续两轮自动推理均建议平仓后，系统才会提交平仓。AI 取消挂单${pendingCancelEnabled ? "已开启" : "已由平台关闭"}。`
    : `自动平仓已关闭；AI 取消挂单${pendingCancelEnabled ? "仍独立运行" : "也已由平台关闭"}。`;
  host.innerHTML = `
    <article class="insight-item primary"><span>当前运行方式</span><strong>${escapeHtml(positionManagementMode(mode))}</strong><small>平台总闸：${platformAutoCloseEnabled ? "已开启" : "已关闭"}</small></article>
    <article class="insight-item"><span>管理任务</span><strong class="num">${Number(pagination.total || 0)}</strong><small>全部可追踪记录</small></article>
    <article class="insight-item success"><span>连续确认完成</span><strong class="num">${confirmed}</strong><small>当前页已达到 2/2</small></article>
    <article class="insight-item warning"><span>等待下一轮</span><strong class="num">${waiting}</strong><small>当前页仍处于 1/2</small></article>`;
  const note = $("positionManagementSafetyNote");
  if (note) note.innerHTML = `<i data-lucide="shield-check" size="14"></i>平台能力：自动平仓 ${platformAutoCloseEnabled ? "开启" : "关闭"} · AI 挂单 ${pendingOrderEnabled ? "开启" : "关闭"} · AI 取消挂单 ${pendingCancelEnabled ? "开启" : "关闭"}`;
  initIcons();
}

function renderPositionManagementSettings(settings = {}) {
  const host = $("positionManagementSettingsPanel");
  if (!host) return;
  const user = settings.user || {};
  host.innerHTML = `<div class="management-settings-copy"><strong>自动平仓</strong><small>默认开启；同一持仓连续两轮有效自动推理都建议平仓才会执行，任意一轮继续持有或输出无效都会清零。AI 挂单和 AI 取消挂单由平台独立控制；你的个人选择不会被平台总闸改写。</small></div><form id="positionManagementSettingsForm" class="management-settings-form"><label><span>运行状态</span><select id="positionManagementModeInput"><option value="display" ${!["auto_exit", "auto_reverse"].includes(user.execution_mode) ? "selected" : ""}>关闭</option><option value="auto_exit" ${["auto_exit", "auto_reverse"].includes(user.execution_mode) ? "selected" : ""}>自动平仓</option></select></label><button class="btn btn-primary btn-sm" type="submit">保存设置</button></form>`;
  $("positionManagementSettingsForm")?.addEventListener("submit", async event => {
    event.preventDefault();
    const button = event.submitter;
    const executionMode = $("positionManagementModeInput").value;
    if (executionMode === "auto_exit" && !await showConfirm("开启自动平仓？", `开启后，同一持仓连续两轮有效自动推理都建议平仓时，系统会核对具体 ${bridgePlatformLabel()} 票号并执行。任意一轮继续持有或输出无效都会清零；净持仓账户仍须通过同品种独占仓位与唯一归属校验。AI 挂单和 AI 取消挂单使用独立的平台开关。`, { confirmText:"确认开启", danger:true })) return;
    button.disabled = true;
    try {
      await api("/api/ai/position-management/settings", { method:"PUT", body:JSON.stringify({
        execution_mode:executionMode,
      }) });
      toast("自动平仓设置已保存", "success");
      await loadPositionManagement({ quiet:true, preserveSelection:true });
    } catch (error) {
      const message = error?.message === "position_management_mode_invalid" ? "运行方式无效，请重新选择。" : error.message;
      toast(message, "error");
      button.disabled = false;
    }
  });
}

function renderPositionManagementTasks(tasks = [], pagination = {}) {
  const body = $("positionManagementBody");
  if (!body) return;
  if (!tasks.length) {
    body.innerHTML = `<tr class="empty-row"><td colspan="7">暂无管理任务。只有冻结交易论点命中平仓或取消条件后，才会生成记录。</td></tr>`;
  } else {
    body.innerHTML = tasks.map(task => {
      const status = positionManagementStatus(task.status);
      const evidence = parseJsonField(task.evidence_validation_json, {});
      const evidenceMeta = positionManagementConfirmationMeta(task, evidence);
      const selected = Number(state.selectedPositionManagementId) === Number(task.id);
      const ticket = task.target_position_id || task.target_pending_ticket;
      const targetMeta = [ticket ? `#${ticket}` : "票号待同步", positionManagementDirection(task.target_direction), Number(task.target_volume) > 0 ? `${Number(task.target_volume)}手` : ""].filter(Boolean).join(" · ");
      return `<tr class="${selected ? "selected" : ""}" data-position-management-row="${Number(task.id)}">
        <td><span class="management-group-cell"><strong>${escapeHtml(task.standard_symbol || task.original_symbol || "--")}</strong><small title="${escapeHtml(targetMeta)}">${escapeHtml(targetMeta)}</small></span></td>
        <td><span class="management-state ${escapeHtml(status.tone)}">${escapeHtml(positionManagementTaskLabel(task.task_type))}</span></td>
        <td><span class="management-action ${escapeHtml(task.candidate_action || "")}">${escapeHtml(positionManagementActionLabel(task.candidate_action))}</span></td>
        <td><span class="management-state ${evidenceMeta.tone}">${escapeHtml(evidenceMeta.label)}</span></td>
        <td><span class="management-mode ${escapeHtml(task.execution_mode || "display")}">${escapeHtml(positionManagementTaskMode(task))}</span></td>
        <td class="num" title="最近一次判断时间（${bridgePlatformLabel()}）">${escapeHtml(compactTimeText(positionManagementDecisionTime(task)))}</td>
        <td><button class="management-detail-btn" type="button" data-position-management-id="${Number(task.id)}" aria-label="查看 ${escapeHtml(task.standard_symbol || task.original_symbol || "任务")} 管理详情">查看</button></td>
      </tr>`;
    }).join("");
  }
  renderPager("positionManagementPager", Number(pagination.page || 1), Number(pagination.page_size || 10), Number(pagination.total || 0), "position-management");
}

function renderPositionManagementUnavailable(message) {
  const body = $("positionManagementBody");
  if (body) body.innerHTML = `<tr class="empty-row"><td colspan="7">${escapeHtml(message)}</td></tr>`;
  const overview = $("positionManagementOverview");
  if (overview) overview.innerHTML = `<article class="insight-item"><span>AI持仓管理</span><strong>当前不可用</strong><small>${escapeHtml(message)}</small></article>`;
  const settings = $("positionManagementSettingsPanel");
  if (settings) settings.innerHTML = `<div class="position-management-empty"><strong>运行设置暂不可用</strong><span>${escapeHtml(message)}</span></div>`;
  $("positionManagementPager")?.replaceChildren();
}

async function loadPositionManagement(options = {}) {
  if (isObserverMode()) {
    renderPositionManagementUnavailable("观摩模式仅展示行情与公开分析，不显示个人账户的持仓管理任务。");
    return;
  }
  const filters = state.positionManagementFilters;
  const query = new URLSearchParams({ page:String(filters.page), page_size:String(filters.pageSize) });
  if (filters.status) query.set("status", filters.status);
  if (!options.quiet && $("positionManagementBody")) {
    $("positionManagementBody").innerHTML = `<tr class="empty-row"><td colspan="7">正在读取管理任务…</td></tr>`;
  }
  try {
    const [list, settings] = await Promise.all([
      api(`/api/ai/position-management?${query}`),
      api("/api/ai/position-management/settings"),
    ]);
    state.positionManagementTasks = list.tasks || [];
    state.positionManagementSettings = settings;
    state.positionManagementFilters.page = Number(list.pagination?.page || 1);
    state.positionManagementFilters.total = Number(list.pagination?.total || 0);
    renderPositionManagementOverview(state.positionManagementTasks, settings, list.pagination || {});
    renderPositionManagementSettings(settings);
    renderPositionManagementTasks(state.positionManagementTasks, list.pagination || {});
    const live = $("positionManagementLive");
    if (live) { live.classList.add("live"); live.innerHTML = `<i></i>实时通道已连接`; }
    if (options.preserveSelection && state.selectedPositionManagementId) {
      await loadPositionManagementDetail(state.selectedPositionManagementId, { quiet:true });
    }
  } catch (error) {
    renderPositionManagementUnavailable(`读取失败：${error.message}`);
    throw error;
  }
}

async function loadPositionManagementDetail(taskId, options = {}) {
  const id = Number(taskId);
  if (!id) return;
  state.selectedPositionManagementId = id;
  document.querySelectorAll("[data-position-management-row]").forEach(row => row.classList.toggle("selected", Number(row.dataset.positionManagementRow) === id));
  const host = $("positionManagementDetail");
  if (!host) return;
  if (!options.quiet) host.innerHTML = `<div class="position-management-empty"><span class="status-spinner" aria-hidden="true"></span><strong>正在读取任务详情</strong></div>`;
  try {
    const result = await api(`/api/ai/position-management/${id}`);
    if (state.selectedPositionManagementId !== id) return;
    const task = result.task || {};
    const evaluation = parseJsonField(task.model_evaluation_json, {});
    const evidence = parseJsonField(task.evidence_validation_json, {});
    const status = positionManagementStatus(task.status);
    const confirmation = positionManagementConfirmationMeta(task, evidence);
    const conditions = parseJsonField(task.invalidation_conditions_json, []);
    const snapshot = parseJsonField(task.target_snapshot_json, {});
    const evaluations = Array.isArray(result.evaluations) ? result.evaluations.map(item => ({
      ...item,
      model:parseJsonField(item.model_evaluation_json, {}),
    })) : [];
    const events = Array.isArray(result.events) ? result.events : [];
    const commands = Array.isArray(result.commands) ? result.commands : [];
    const pendingCancelTask = task.task_type === "pending_cancel";
    const ticket = task.target_position_id || task.target_pending_ticket || "--";
    const targetActive = pendingCancelTask
      ? String(task.target_attribution_status || "").toLowerCase() === "pending" && Boolean(task.target_pending_ticket)
      : ["open", "closing"].includes(String(task.target_status || "").toLowerCase());
    const targetKind = pendingCancelTask ? `${bridgePlatformLabel()} 挂单` : `${bridgePlatformLabel()} 持仓`;
    const targetStateLabel = pendingCancelTask
      ? (targetActive ? "挂单有效" : "挂单已结束")
      : (targetActive ? "持仓中" : "持仓已结束");
    const volume = Number(snapshot.volume ?? snapshot.volume_current ?? task.target_expected_volume ?? 0);
    const stopLoss = Number(snapshot.sl ?? snapshot.stop_loss ?? task.target_actual_stop_loss ?? 0);
    const takeProfit = Number(snapshot.tp ?? snapshot.take_profit ?? task.target_actual_take_profit ?? 0);
    const currentPrice = Number(snapshot.price_current ?? snapshot.current_price ?? 0);
    const entryPrice = Number(snapshot.price_open ?? snapshot.open_price ?? 0);
    const evaluationRows = evaluations.length ? evaluations.map((item, index) => {
      const model = item.model || {};
      const condition = conditions.find(row => row.condition_id === model.matched_condition_id);
      const currentReason = positionManagementDecisionReason(model);
      const valid = item.validation_status === "valid";
      const action = valid ? positionManagementActionLabel(item.action) : "结果无效";
      const evidenceSummary = currentReason || (condition ? positionManagementConditionText(condition) : "");
      return `<li class="management-confirmation-row ${escapeHtml(valid ? item.action : "invalid")}"><span class="management-confirmation-index">${index + 1}</span><div><header><strong>${escapeHtml(action)}</strong><time>${escapeHtml(compactTimeText(positionManagementDecisionTime(item)))}</time></header><p>${escapeHtml(item.reason || model.reason || "本轮没有可用说明")}</p>${evidenceSummary ? `<small>${escapeHtml(evidenceSummary)}</small>` : ""}</div></li>`;
    }).join("") : pendingCancelTask
      ? `<li class="management-confirmation-row cancel"><span class="management-confirmation-index">1</span><div><header><strong>建议撤单</strong><time>${escapeHtml(compactTimeText(positionManagementDecisionTime(task)))}</time></header><p>${escapeHtml(evaluation.reason || "AI 明确建议取消该策略挂单")}</p><small>单轮有效判断已完成，下一步仅执行挂单身份与状态校验。</small></div></li>`
      : `<li class="management-confirmation-empty">旧任务没有逐轮判断记录。</li>`;
    const targetDetails = pendingCancelTask
      ? `<div><span>挂单票号</span><strong>#${escapeHtml(ticket)}</strong></div><div><span>执行前校验</span><strong>策略归属 · 系统 Magic</strong></div>`
      : `<div><span>入场 / 当前价</span><strong>${entryPrice > 0 ? priceDisplay(entryPrice) : "--"} / ${currentPrice > 0 ? priceDisplay(currentPrice) : "--"}</strong></div><div><span>当前止损 / 当前止盈</span><strong>${stopLoss > 0 ? priceDisplay(stopLoss) : "--"} / ${takeProfit > 0 ? priceDisplay(takeProfit) : "--"}</strong></div>`;
    const confirmationTitle = pendingCancelTask ? "自动推理撤单判断" : "连续自动推理确认";
    const confirmationDescription = pendingCancelTask
      ? "一轮有效判断明确建议撤单后，立即进入挂单身份与状态校验。"
      : "只有连续两轮有效判断都建议平仓，才会进入执行。";
    const executionDescription = commands.length
      ? "已创建精确票号的持久化命令，请结合状态时间线核对最终结果。"
      : confirmation.count >= confirmation.required
        ? (pendingCancelTask
            ? "撤单判断已确认，系统正在核对挂单票号、策略归属和当前状态。"
            : "连续确认已经完成，系统正在核对持仓票号和当前状态。")
        : (pendingCancelTask
            ? "旧的两轮撤单复核任务已经停止，不会创建撤单命令。"
            : `尚未达到连续确认次数，不会创建 ${bridgePlatformLabel()} 平仓命令。`);
    host.innerHTML = `
      <header class="management-detail-head"><div><span class="section-kicker">任务 #${id}</span><h3>${escapeHtml(task.standard_symbol || task.original_symbol || "管理任务")} · #${escapeHtml(ticket)}</h3><p>${escapeHtml(positionManagementDirection(task.target_direction))}${volume > 0 ? ` · ${escapeHtml(String(volume))}手` : ""} · ${escapeHtml(positionManagementTaskLabel(task.task_type))}</p></div><span class="management-state ${escapeHtml(status.tone)}">${escapeHtml(status.label)}</span></header>
      <section class="management-target-summary"><header><div><span>执行对象</span><strong>${targetKind} #${escapeHtml(ticket)}</strong></div><span class="management-state ${targetActive ? "confirmed" : "expired"}">${targetStateLabel}</span></header><div class="management-detail-grid"><div><span>方向 / 手数</span><strong>${escapeHtml(positionManagementDirection(task.target_direction))}${volume > 0 ? ` · ${escapeHtml(String(volume))}手` : ""}</strong></div><div><span>账户</span><strong>${escapeHtml(task.login_account || "--")}</strong></div>${targetDetails}</div></section>
      <section class="management-detail-section"><header><div><h4>${confirmationTitle}</h4><p>${confirmationDescription}</p></div><span class="management-state ${escapeHtml(confirmation.tone)}">${escapeHtml(confirmation.label)}</span></header><div class="management-confirmation-meter" role="progressbar" aria-valuemin="0" aria-valuemax="${confirmation.required}" aria-valuenow="${confirmation.count}"><i style="--confirmation-progress:${(confirmation.count / confirmation.required) * 100}%"></i></div><ol class="management-confirmation-list">${evaluationRows}</ol></section>
      <section class="management-detail-section"><header><h4>当前结论</h4><span class="management-action ${escapeHtml(task.candidate_action || "")}">${escapeHtml(positionManagementActionLabel(task.candidate_action))}</span></header><p>${escapeHtml(evaluation.reason || "暂无模型说明。")}</p><small>${escapeHtml(positionManagementEvidenceSource(evidence.source))}</small></section>
      <section class="management-detail-section"><header><h4>执行状态</h4><span>${commands.length} 条 ${bridgePlatformLabel()} 命令</span></header><p>${executionDescription}</p></section>
      <section class="management-detail-section"><header><h4>状态时间线</h4><span>${events.length} 条 · ${escapeHtml(bridgePlatformLabel())} 时间</span></header>${events.length ? `<ol class="management-timeline">${events.map(event => `<li><time title="${escapeHtml(`${bridgePlatformLabel()} 服务器时间`)}"><span>${escapeHtml(bridgePlatformLabel())}</span>${escapeHtml(compactTimeText(positionManagementEventTime(event)))}</time><span><strong>${escapeHtml(positionManagementStatus(event.to_status).label)}</strong><br>${escapeHtml(positionManagementEventSummary(event))}</span></li>`).join("")}</ol>` : `<p>暂无状态记录。</p>`}</section>`;
    initIcons();
  } catch (error) {
    if (state.selectedPositionManagementId === id) host.innerHTML = `<div class="position-management-empty"><i data-lucide="triangle-alert" size="22"></i><strong>详情读取失败</strong><span>${escapeHtml(error.message)}</span></div>`;
    initIcons();
  }
}

async function refreshTradingPage() {
  await Promise.allSettled([loadStatus(), loadAccount(), refreshQuote(), loadPositions(), loadPendingOrders(), loadPositionManagement({ quiet:true, preserveSelection:true })]);
}

async function refreshHistoryPage() {
  await loadHistoryViews({ forceRefresh:true, includeAccount:true, manualRefresh:true });
}

async function exportHistory() {
  const adminOnly = state.user?.role === 'admin';
  if (!adminOnly) { toast('仅管理员可操作', 'error'); return; }
  // Lazy-load xlsx library (only admins need it)
  if (typeof XLSX === 'undefined') {
    await new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = '/ai/js/xlsx.full.min.js';
      script.onload = resolve;
      script.onerror = () => reject(new Error('xlsx 库加载失败'));
      document.head.appendChild(script);
    });
  }
  try {
    // Gather current filters
    const filterParams = getHistoryRangeParams();
    const entryFrom = document.getElementById('filterEntryFrom')?.value || '';
    const entryTo = document.getElementById('filterEntryTo')?.value || '';
    const closeFrom = document.getElementById('filterCloseFrom')?.value || '';
    const closeTo = document.getElementById('filterCloseTo')?.value || '';
    const direction = document.getElementById('filterDirection')?.value || '';
    const profit = document.getElementById('filterProfit')?.value || '';
    if (entryFrom) filterParams.entry_from = entryFrom;
    if (entryTo) filterParams.entry_to = entryTo;
    if (closeFrom) filterParams.filter_close_from = closeFrom;
    if (closeTo) filterParams.filter_close_to = closeTo;
    if (direction) filterParams.direction = direction;
    if (profit) filterParams.profit_filter = profit;

    toast('正在导出数据...', 'info');
    const data = await wsApi('export_history', filterParams, 60000);
    if (data.status !== 'success') { toast(data.message || '导出失败', 'error'); return; }
    const rows = data.rows || [];
    if (rows.length === 0) { toast('没有可导出的数据', 'warning'); return; }

    // Build XLSX workbook with 2 sheets
    const wb = XLSX.utils.book_new();

    // Sheet 1: 交易记录 (order fields)
    const headers = [
      '订单号', '品种', '方向', '手数',
      '入场价', '开仓时间', '平仓价', '平仓时间',
      '止损', '止盈', '盈亏', '盈亏%', '备注',
      '信号ID', '信号类型', '信号置信度', '信号建议手数',
      '信号分析', '信号推理',
      '信号止损', '信号止盈1', '信号止盈2', '信号止盈3',
      '信号已执行', '信号时间'
    ];
    const sheetData = [headers];
    for (const r of rows) {
      sheetData.push([
        r.ticket || '', r.symbol || '', r.direction || '', r.volume || '',
        r.entry_price ?? '', r.entry_time || '', r.exit_price ?? '', r.close_time || '',
        r.stop_loss ?? '', r.take_profit ?? '', r.profit ?? '', (r.profit != null && r.entry_price && r.volume ? (r.profit / (r.volume * r.entry_price * (r.contract_size || 100)) * 100).toFixed(2) + '%' : ''), r.comment || '',
        r.signal_id || '', r.signal_type || '', r.signal_confidence ?? '', r.signal_volume ?? '',
        r.signal_analysis || '', r.signal_reasoning || '',
        r.signal_stop_loss ?? '', r.signal_tp1 ?? '', r.signal_tp2 ?? '', r.signal_tp3 ?? '',
        r.signal_executed || '', r.signal_created || ''
      ]);
    }
    const ws1 = XLSX.utils.aoa_to_sheet(sheetData);

    // Set column widths
    const colWidths = headers.map(h => ({ wch: Math.max(h.length * 2, 12) }));
    // Make analysis/reasoning columns wider
    colWidths[18].wch = 40; // 信号分析
    colWidths[19].wch = 40; // 信号推理
    ws1['!cols'] = colWidths;

    XLSX.utils.book_append_sheet(wb, ws1, '交易记录');

    // Sheet 2: 统计汇总
    const totalCount = rows.length;
    const winCount = rows.filter(r => (r.profit ?? 0) > 0).length;
    const lossCount = rows.filter(r => (r.profit ?? 0) < 0).length;
    const totalProfit = rows.reduce((s, r) => s + (Number(r.profit) || 0), 0);
    const withSignal = rows.filter(r => r.signal_id).length;
    const buyCount = rows.filter(r => r.direction === 'BUY').length;
    const sellCount = rows.filter(r => r.direction === 'SELL').length;

    const summaryData = [
      ['统计项', '数值'],
      ['导出时间', new Date().toLocaleString('zh-CN')],
      ['总交易数', totalCount],
      ['盈利笔数', winCount],
      ['亏损笔数', lossCount],
      ['胜率', totalCount > 0 ? ((winCount / totalCount) * 100).toFixed(1) + '%' : 'N/A'],
      ['总盈亏', totalProfit.toFixed(2)],
      ['平均盈亏', totalCount > 0 ? (totalProfit / totalCount).toFixed(2) : 'N/A'],
      ['买入笔数', buyCount],
      ['卖出笔数', sellCount],
      ['有推理信号', withSignal],
      ['筛选条件', Object.entries(filterParams).map(([k, v]) => `${k}=${v}`).join(', ') || '无（全部）'],
    ];
    const ws2 = XLSX.utils.aoa_to_sheet(summaryData);
    ws2['!cols'] = [{ wch: 16 }, { wch: 30 }];
    XLSX.utils.book_append_sheet(wb, ws2, '统计汇总');

    // Generate filename and download
    const now = new Date();
    const dateStr = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')}`;
    const filename = `AURUM_交易历史_${dateStr}.xlsx`;
    XLSX.writeFile(wb, filename);
    toast(`导出完成: ${totalCount} 笔交易`, 'success');
  } catch (e) {
    console.error('exportHistory:', e);
    toast('导出失败: ' + (e.message || '未知错误'), 'error');
  }
}

function auditStatusCode(row) {
  return String(row?.status_code || row?.status || "unknown").trim().toLowerCase();
}

function auditStatusText(row) {
  const code = auditStatusCode(row);
  const fallback = {
    success: "成功", skipped: "已跳过", rejected: "风控拒绝", error: "错误",
    failed: "失败", needs_confirmation: "需要确认", warning: "警告", info: "信息",
    started: "进行中", superseded: "已被替代", unknown: "未知状态",
  }[code] || "未知状态";
  return userVisibleText(row?.status, fallback);
}

function auditStatusTone(row) {
  const code = auditStatusCode(row);
  if (["error", "failed"].includes(code)) return "error";
  if (code === "rejected") return "rejected";
  if (code === "success") return "success";
  if (code === "needs_confirmation") return "needs_confirmation";
  return "skipped";
}

function auditActionType(row) {
  const code = String(row?.action_code || "").toLowerCase();
  const label = String(row?.action || "").toLowerCase();
  return code.startsWith("ai_") || label.includes("ai") ? "ai" : "manual";
}

function auditActionText(row) {
  const action = userVisibleText(row?.action, userVisibleText(row?.action_code, "系统审计操作"));
  const repeatCount = Number(row?.repeat_count || 0);
  return repeatCount > 1 ? `${action} · 合并 ${repeatCount} 条` : action;
}

function auditReasonText(row) {
  const result = row?.result || {};
  const riskReason = resultRiskReason(result);
  const raw = riskReason || result.reason || result.message || result.status || "";
  return userVisibleText(localizeReason(raw), "未记录原因");
}

function auditResultText(row) {
  const result = row?.result || {};
  const reason = auditReasonText(row);
  const retcode = result.retcode || result.mt5_result?.retcode;
  const platformHint = String(result.platform || result.source || row?.platform
    || result.error || result.message || "").toLowerCase();
  const returnPlatform = platformHint.includes("mt4")
    ? "MT4"
    : platformHint.includes("mt5") || result.mt5_result
      ? "MT5"
      : bridgePlatformLabel();
  const quote = result.quote?.bid !== undefined && result.quote?.ask !== undefined
    ? `报价 ${result.quote.bid} / ${result.quote.ask}`
    : "";
  return [reason, retcode ? `${returnPlatform} 返回码 ${retcode}` : "", quote].filter(Boolean).join(" · ");
}

function renderAuditRows() {
  const body = $("auditBody");
  if (!body) return;
  const rows = Array.isArray(state.auditRows) ? state.auditRows : [];
  const filters = state.auditFilters;
  const filtered = rows.filter(row => {
    const status = auditStatusCode(row);
    const type = auditActionType(row);
    return (!filters.status || status === filters.status) && (!filters.type || type === filters.type);
  });
  filters.page = clampPage(filters.page, filters.pageSize, filtered.length);
  const start = (filters.page - 1) * filters.pageSize;
  const pageRows = filtered.slice(start, start + filters.pageSize);
  const success = rows.filter(row => auditStatusCode(row) === "success").length;
  const rejected = rows.filter(row => auditStatusCode(row) === "rejected").length;
  const exceptions = rows.filter(row => ["error", "failed", "needs_confirmation", "warning"].includes(auditStatusCode(row))).length;
  setText("auditTotalStat", rows.length);
  setText("auditSuccessStat", success);
  setText("auditRejectedStat", rejected);
  setText("auditExceptionStat", exceptions);
  setText("auditCount", `筛选 ${filtered.length} / 共 ${rows.length} 条`);
  body.innerHTML = pageRows.length ? pageRows.map(row => {
    const statusTone = auditStatusTone(row);
    const actionType = auditActionType(row);
    const resultText = auditResultText(row);
    const reasonText = auditReasonText(row);
    return `<tr class="audit-row row-${statusTone}">
      <td data-label="时间（${bridgePlatformLabel()}）">${compactTerminalTimeHtml(row)}</td>
      <td data-label="动作"><span class="action-badge ${actionType}">${escapeHtml(auditActionText(row))}</span></td>
      <td data-label="品种"><strong class="num">${escapeHtml(row?.symbol || "--")}</strong></td>
      <td data-label="状态"><span class="audit-status ${statusTone}">${escapeHtml(auditStatusText(row))}</span></td>
      <td data-label="中文结果" class="audit-result-cell"><button class="audit-result-text" type="button" title="${escapeHtml(resultText)}" aria-expanded="false" data-audit-result>${escapeHtml(resultText)}</button></td>
      <td data-label="原始原因" title="${escapeHtml(reasonText)}">${escapeHtml(reasonText)}</td>
    </tr>`;
  }).join("") : `<tr class="empty-row"><td colspan="6">当前筛选下暂无审计记录</td></tr>`;
  renderPager("auditPager", filters.page, filters.pageSize, filtered.length, "audit");
}

async function loadAudit() {
  const body = $("auditBody");
  if (body && !state.auditRows.length) body.innerHTML = '<tr class="empty-row"><td colspan="6">正在通过实时通道读取审计记录…</td></tr>';
  try {
    const data = await wsApi("audit_logs");
    state.auditRows = data.logs || [];
    renderAuditRows();
  } catch (error) {
    if (body) body.innerHTML = '<tr class="empty-row"><td colspan="6">审计记录加载失败，请检查实时连接后重试</td></tr>';
    throw error;
  }
}

function bindEvents() {
  if (!state.strategyMemoryVisibilityBound) {
    document.addEventListener("visibilitychange", handleStrategyMemoryVisibilityChange);
    state.strategyMemoryVisibilityBound = true;
  }
  $("logoutBtn").addEventListener("click", logout);
  $("membershipGateLogoutBtn")?.addEventListener("click", logout);
  $("accountCenterBtn")?.addEventListener("click", () => openAccountCenter(state.notificationUnread > 0 ? "notifications" : "overview"));
  $("notificationBannerOpen")?.addEventListener("click", () => openNotificationCenter(state.latestImportant?.id || ""));
  $("accountCenterModal")?.querySelectorAll("[data-close-account-center]").forEach(node => node.addEventListener("click", closeAccountCenter));
  window.addEventListener("message", handleAccountCenterMessage);
  window.addEventListener("storage", event => {
    if ([window.AuthSession?.eventKey, "ws_token", "authToken"].includes(event.key) && !window.AuthSession?.token()) logout();
  });
  window.addEventListener("keydown", event => {
    if (event.key === "Escape" && !$("accountCenterModal")?.classList.contains("hidden")) closeAccountCenter();
    if (event.key === "Escape" && !$("mt5BridgeModal")?.classList.contains("hidden")) closeBridgeControlModal();
  });
  $("refreshAllBtn").addEventListener("click", () => {
    const tabId = activeTabId();
    if (tabId === "history") {
      _historyCache = null;
      _historyChartCache = null;
    }
    withBusy($("refreshAllBtn"), () => refreshTabData(tabId, { manualRefresh:true }))
      .catch(error => toast(error.message, "error"));
  });
  $("gatewayMode")?.addEventListener("click", handleGatewayModeClick);
  $("analyzeStrategy")?.addEventListener("change", updateManualStrategySelection);
  $("subscriptionSymbolOptions")?.addEventListener("change", event => {
    const target = event.target;
    if (!(target instanceof HTMLInputElement)) return;
    const allInput = $("subscriptionSymbolOptions").querySelector("[data-subscription-symbol-all]");
    const symbolInputs = [...$("subscriptionSymbolOptions").querySelectorAll("[data-subscription-symbol]")];
    if (target.hasAttribute("data-subscription-symbol-all") && target.checked) {
      symbolInputs.forEach(input => { input.checked = false; });
    } else if (target.hasAttribute("data-subscription-symbol")) {
      allInput.checked = false;
      if (!symbolInputs.some(input => input.checked)) allInput.checked = true;
    }
    updateSubscriptionSymbolSummary();
  });
  $("manualAutoExecute")?.addEventListener("change", event => {
    $("manualAutoExecuteNotice")?.classList.toggle("hidden", !event.target.checked);
  });
  $("openManualInferenceBtn")?.addEventListener("click", () => setManualInferenceModal(true));
  $("manualInferenceClose")?.addEventListener("click", () => setManualInferenceModal(false));
  $("manualInferenceCancel")?.addEventListener("click", () => setManualInferenceModal(false));
  $("manualInferenceAbort")?.addEventListener("click", () => cancelManualAnalysisJob());
  $("manualInferenceModal")?.addEventListener("click", event => {
    const asyncActive = state.manualAnalysisSubmitting || (state.manualAnalysisJob && !manualAnalysisJobIsTerminal(state.manualAnalysisJob));
    if (event.target === $("manualInferenceModal") && (asyncActive || !$("runAnalysisBtn")?.disabled)) setManualInferenceModal(false);
  });
  $("compareResultsClose")?.addEventListener("click", () => setCompareResultsModal(false));
  $("compareResultsCloseBtn")?.addEventListener("click", () => setCompareResultsModal(false));
  $("compareResultsModal")?.addEventListener("click", event => {
    if (event.target === $("compareResultsModal")) setCompareResultsModal(false);
  });

  document.querySelectorAll("[data-strategy-timeframe]").forEach(input => input.addEventListener("change", () => {
    const tf = input.dataset.strategyTimeframe;
    const countInput = document.querySelector(`[data-strategy-kline="${tf}"]`);
    const primaryInput = document.querySelector(`input[name="strategyPrimaryTimeframe"][value="${tf}"]`);
    if (countInput) countInput.disabled = !input.checked;
    if (primaryInput) primaryInput.disabled = !input.checked;
    if (!input.checked && primaryInput?.checked) {
      const next = document.querySelector("[data-strategy-timeframe]:checked");
      const nextPrimary = next && document.querySelector(`input[name="strategyPrimaryTimeframe"][value="${next.dataset.strategyTimeframe}"]`);
      if (nextPrimary) nextPrimary.checked = true;
    }
  }));
  $("runAnalysisBtn").addEventListener("click", runAnalysis);
  $("executeSignalBtn").addEventListener("click", executeSignal);
  $("buyBtn").addEventListener("click", () => adminStrategyDispatchModeEnabled() ? openAdminStrategyDispatch("buy") : openManual("buy"));
  $("sellBtn").addEventListener("click", () => adminStrategyDispatchModeEnabled() ? openAdminStrategyDispatch("sell") : openManual("sell"));
  $("adminStrategyDispatchEnabled")?.addEventListener("change", event => {
    if (!isAdminStrategyDispatchUser() || !state.adminStrategyDispatchCapabilities?.enabled) {
      event.target.checked = false;
      return renderAdminStrategyDispatchControls();
    }
    if (event.target.checked) state.selectedOrderType = "market";
    renderAdminStrategyDispatchControls();
  });
  $("adminStrategyDispatchRefresh")?.addEventListener("click", () => refreshAdminStrategyDispatch().catch(error => toast(error.message, "error")));
  $("adminStrategyDispatchRetry")?.addEventListener("click", () => retryAdminStrategyDispatch().catch(error => toast(error.message, "error")));
  $("adminStrategyDispatchModalClose")?.addEventListener("click", closeAdminStrategyDispatchModal);
  $("adminStrategyDispatchModalCancel")?.addEventListener("click", closeAdminStrategyDispatchModal);
  $("adminStrategyDispatchModalConfirm")?.addEventListener("click", createAdminStrategyDispatch);
  $("adminStrategyDispatchModal")?.addEventListener("click", event => {
    if (event.target === $("adminStrategyDispatchModal")) closeAdminStrategyDispatchModal();
  });
  $("orderConfirmCancel")?.addEventListener("click", closeManualOrderModal);
  $("orderConfirmClose")?.addEventListener("click", closeManualOrderModal);
  $("orderConfirmSubmit")?.addEventListener("click", submitManualOrder);
  $("orderConfirmModal")?.addEventListener("click", (event) => {
    if (event.target === $("orderConfirmModal")) closeManualOrderModal();
  });
  initOrderTypeSelector();
  // Refresh pending orders
  document.querySelector('[data-action="refresh-pending"]')?.addEventListener("click", () => loadPendingOrders());
  // Symbol change is handled by searchable selector + setGlobalSymbol
  $("signalFilterDirection")?.addEventListener("change", (event) => {
    state.signalFilters.direction = event.target.value;
    state.signalFilters.page = 1;
    loadSignalTable();
  });
  $("signalFilterTimeframe")?.addEventListener("change", (event) => {
    state.signalFilters.timeframe = event.target.value;
    state.signalFilters.page = 1;
    loadSignalTable();
  });
  $("auditFilterStatus")?.addEventListener("change", (event) => {
    state.auditFilters.status = event.target.value;
    state.auditFilters.page = 1;
    renderAuditRows();
  });
  $("auditFilterType")?.addEventListener("change", (event) => {
    state.auditFilters.type = event.target.value;
    state.auditFilters.page = 1;
    renderAuditRows();
  });
  $("positionManagementStatusFilter")?.addEventListener("change", event => {
    state.positionManagementFilters.status = event.target.value;
    state.positionManagementFilters.page = 1;
    state.selectedPositionManagementId = null;
    loadPositionManagement().catch(error => toast(error.message, "error"));
  });

  // Gateway badge click — toggle trade sending
  $("tradeMode")?.addEventListener("click", handleTradeModeClick);
  $("observerChannelTrigger")?.addEventListener("click", () => {
    const trigger = $("observerChannelTrigger");
    setObserverChannelMenuOpen(trigger?.getAttribute("aria-expanded") !== "true");
  });
  $("observerChannelTrigger")?.addEventListener("keydown", event => {
    if (!["ArrowDown", "Enter", " "].includes(event.key)) return;
    event.preventDefault();
    setObserverChannelMenuOpen(true, { focusSelected: true });
  });
  $("observerChannelMenu")?.addEventListener("click", event => {
    const option = event.target.closest("[data-observer-channel-id]");
    if (!option) return;
    const trigger = $("observerChannelTrigger");
    trigger.disabled = true;
    setObserverChannelMenuOpen(false);
    changeObserverChannel(option.dataset.observerChannelId)
      .catch(error => {
        renderObserverChannelControl();
        toast(localizeReason(error.message), "error");
      })
      .finally(() => {
        trigger.disabled = false;
        trigger.focus();
      });
  });
  $("observerChannelMenu")?.addEventListener("keydown", event => {
    const options = [...event.currentTarget.querySelectorAll('[role="option"]')];
    const index = options.indexOf(document.activeElement);
    if (event.key === "Escape") {
      event.preventDefault();
      setObserverChannelMenuOpen(false);
      $("observerChannelTrigger")?.focus();
    } else if (["ArrowDown", "ArrowUp"].includes(event.key) && options.length) {
      event.preventDefault();
      options[(index + (event.key === "ArrowDown" ? 1 : -1) + options.length) % options.length].focus();
    }
  });
  document.addEventListener("click", event => {
    if (!event.target.closest("#observerChannelControl")) setObserverChannelMenuOpen(false);
  });

  // Auto analyze badge — open the current subscription settings.
  $("autoAnalyzeMode")?.addEventListener("click", handleAutoSubscriptionClick);

  // Auto badge hover — prevent title flicker during countdown
  const autoMode = $('autoAnalyzeMode');
  if (autoMode) {
    autoMode.addEventListener('mouseenter', () => { _autoBadgeHovering = true; });
    autoMode.addEventListener('mouseleave', () => {
      _autoBadgeHovering = false;
      if (_autoBadgeCache.pendingTitle) {
        autoMode.title = _autoBadgeCache.pendingTitle;
        _autoBadgeCache.title = _autoBadgeCache.pendingTitle;
        delete _autoBadgeCache.pendingTitle;
      }
    });
  }

  $("addPrivateStrategyBtn")?.addEventListener("click", () => openStrategyEditor());
  $("cancelStrategyEditorBtn")?.addEventListener("click", () => requestCloseStrategyEditor());
  $("saveStrategyBtn")?.addEventListener("click", () => saveStrategyEditor().catch(error => { if (!error?._strategyEditorHandled) toast(localizeReason(error?.code || error?.message) || "策略保存失败", "error"); }));
  $("cancelSubscriptionEditorBtn")?.addEventListener("click", () => closeFormModal($("subscriptionEditor")));
  $("saveSubscriptionBtn")?.addEventListener("click", () => saveSubscriptionEditor().catch(error => toast(error.message, "error")));
  $("subscriptionStrategy")?.addEventListener("change", handleSubscriptionStrategyChange);
  $("subscriptionExecutionEnabled")?.addEventListener("change", syncSubscriptionEditorActionState);
  $("subscriptionScheduleEnabled")?.addEventListener("change", syncSubscriptionScheduleVisibility);
  $("addSubscriptionScheduleWindow")?.addEventListener("click", () => {
    const windows = selectedSubscriptionScheduleWindows();
    if (windows.length >= 6) { toast("最多添加 6 个运行时段", "warning"); return; }
    renderSubscriptionScheduleWindows([...windows, { start:"09:00", end:"17:00" }]);
  });
  $("subscriptionScheduleWindows")?.addEventListener("click", event => {
    const button = event.target.closest("[data-remove-schedule-window]");
    if (!button) return;
    const rows = selectedSubscriptionScheduleWindows();
    const row = button.closest("[data-schedule-window-row]");
    const allRows = [...$("subscriptionScheduleWindows").querySelectorAll("[data-schedule-window-row]")];
    const index = allRows.indexOf(row);
    rows.splice(index, 1);
    renderSubscriptionScheduleWindows(rows);
  });
  $("addModelProfileBtn")?.addEventListener("click", () => openModelEditor());
  $("modelCatalogSearch")?.addEventListener("input", event => {
    state.modelCatalogSearch = event.target.value || "";
    renderModelProfiles();
  });
  $("modelCatalogStatus")?.addEventListener("change", event => {
    state.modelCatalogStatus = event.target.value || "all";
    renderModelProfiles();
  });
  $("modelCatalogEmptyState")?.addEventListener("click", event => {
    if (!event.target.closest("[data-model-catalog-clear]")) return;
    state.modelCatalogSearch = "";
    state.modelCatalogStatus = "all";
    const search = $("modelCatalogSearch");
    const status = $("modelCatalogStatus");
    if (search) search.value = "";
    if (status) status.value = "all";
    renderModelProfiles();
    search?.focus();
  });
  $("modelPurposeBindingsList")?.addEventListener("click", event => {
    const button = event.target.closest("[data-save-model-purpose]");
    if (button) saveModelPurposeBinding(button).catch(error => toast(error.message || "保存失败，请重试", "error"));
  });
  $("cancelModelProfileBtn")?.addEventListener("click", () => closeFormModal($("modelProfileEditor")));
  $("saveModelProfileBtn")?.addEventListener("click", () => saveModelProfile().catch(error => toast(localizeReason(error.message), "error")));
  $("savePlatformPolicyBtn")?.addEventListener("click", () => savePlatformPolicy().catch(error => toast(error.message, "error")));
  $("saveUserFeatureFlagsBtn")?.addEventListener("click", () => saveUserFeatureFlags().catch(error => toast(error.message, "error")));
  $("positionProtectionClose")?.addEventListener("click", closePositionProtectionModal);
  $("positionProtectionCancel")?.addEventListener("click", closePositionProtectionModal);
  $("positionProtectionSubmit")?.addEventListener("click", submitPositionProtectionJob);
  $("positionProtectionRetry")?.addEventListener("click", retryPositionProtectionJob);
  $("adminStrategyCloseSubmit")?.addEventListener("click", submitAdminStrategyCloseJob);
  $("adminStrategyCloseRetry")?.addEventListener("click", retryAdminStrategyCloseJob);
  $("adminStrategyCloseRefresh")?.addEventListener("click", () => {
    const ticket = $("positionProtectionTicket")?.value;
    const jobId = adminStrategyCloseJobId(state.adminStrategyCloseJob || {});
    if (jobId && !ADMIN_STRATEGY_CLOSE_TERMINAL_STATES.has(adminStrategyCloseStatus(state.adminStrategyCloseJob))) {
      loadAdminStrategyCloseJob(jobId).catch(() => {});
    } else if (ticket) loadAdminStrategyClosePreview(ticket).catch(() => {});
  });
  $("adminStrategyCloseReason")?.addEventListener("input", () => renderAdminStrategyCloseFormState());
  $("adminStrategyCloseReason")?.addEventListener("blur", () => renderAdminStrategyCloseFormState({ showErrors:true }));
  $("adminStrategyCloseConfirm")?.addEventListener("change", () => renderAdminStrategyCloseFormState());
  ["positionProtectionStopLoss", "positionProtectionTakeProfit", "positionProtectionReason"].forEach(id => {
    $(id)?.addEventListener("input", () => renderPositionProtectionChangeState());
    $(id)?.addEventListener("blur", () => renderPositionProtectionChangeState({ showErrors:true }));
  });
  $("positionProtectionSyncScope")?.addEventListener("change", async event => {
    const ticket = $("positionProtectionTicket")?.value;
    if (!ticket) return;
    event.target.disabled = true;
    try { await loadPositionProtectionPreview(ticket, event.target.checked ? "signal" : "source_only"); }
    catch (error) {
      event.target.checked = !event.target.checked;
      toast(error.message, "error");
    } finally {
      event.target.disabled = !state.positionProtectionPreview?.sync_available;
      renderPositionProtectionChangeState();
    }
  });
  $("profileProvider")?.addEventListener("change", event => {
    const preset = PROVIDER_PRESETS[event.target.value]; if (!preset) return;
    $("profileBaseUrl").value = preset.url; if (preset.models?.[0]) $("profileModelName").value = preset.models[0];
    updateModelProviderHelp(event.target.value);
  });
  document.querySelectorAll(".form-modal").forEach(modal => {
    modal.addEventListener("keydown", handleFormModalKeydown);
    modal.addEventListener("click", event => {
      if (event.target !== modal) return;
      if (modal.dataset.closePolicy === "explicit") return;
      if (modal.id === "positionProtectionModal") closePositionProtectionModal();
      else closeFormModal(modal);
    });
  });
  document.querySelectorAll("[data-review-filter]").forEach(button => button.addEventListener("click", () => {
    document.querySelectorAll("[data-review-filter]").forEach(item => {
      const selected = item === button;
      item.classList.toggle("active", selected);
      item.setAttribute("aria-selected", String(selected));
      item.tabIndex = selected ? 0 : -1;
    });
    state.reviewFilter = button.dataset.reviewFilter;
    state.selectedReviewId = null;
    loadReviewCaseStream({ reset:true }).catch(error => toast(error.message,"error"));
  }));
  document.querySelectorAll("[data-review-period]").forEach(button => button.addEventListener("click", () => {
    document.querySelectorAll("[data-review-period]").forEach(item => {
      const selected = item === button;
      item.classList.toggle("active", selected);
      item.setAttribute("aria-selected", String(selected));
      item.tabIndex = selected ? 0 : -1;
    });
    state.reviewPeriodFilter = button.dataset.reviewPeriod; state.selectedReviewId = null;
    loadReviewCaseStream({ reset:true }).catch(error => toast(error.message,"error"));
  }));
  ["[data-review-filter]", "[data-review-period]"].forEach(selector => {
    document.querySelectorAll(selector).forEach(button => button.addEventListener("keydown", event => {
      if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
      event.preventDefault();
      const tabs = [...document.querySelectorAll(selector)];
      const current = tabs.indexOf(button);
      const targetIndex = event.key === "Home"
        ? 0
        : event.key === "End"
          ? tabs.length - 1
          : (current + (event.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length;
      tabs[targetIndex].click();
      tabs[targetIndex].focus();
    }));
  });
  document.querySelectorAll("[data-strategy-filter]").forEach(button => button.addEventListener("click", () => {
    state.strategyFilter = button.dataset.strategyFilter || "all";
    document.querySelectorAll("[data-strategy-filter]").forEach(item => item.classList.toggle("active", item === button));
    loadStrategyCatalog().catch(error => toast(error.message, "error"));
  }));
  document.querySelectorAll("[data-workspace-tab]").forEach(button => {
    button.addEventListener("click", () => setWorkspaceSubtab(button.dataset.workspaceTab, button.dataset.workspaceTarget));
    button.addEventListener("keydown", event => {
      if (!["ArrowLeft","ArrowRight","Home","End"].includes(event.key)) return;
      event.preventDefault();
      const tabs = [...document.querySelectorAll(`[data-workspace-tab="${button.dataset.workspaceTab}"]`)];
      const current = tabs.indexOf(button);
      const index = event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1 : (current + (event.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length;
      setWorkspaceSubtab(tabs[index].dataset.workspaceTab, tabs[index].dataset.workspaceTarget);
      tabs[index].focus();
    });
  });
  document.body.addEventListener("input", event => {
    if (event.target.closest("[data-review-field]")) syncReviewEditorFromFields();
    const userRiskInput = event.target.closest("[data-user-risk-field]");
    if (userRiskInput) updateUserRiskPreferencePreview(userRiskInput);
    if (event.target.id === "manualTradeReviewThesis") renderManualTradeReviewSelectionSummary();
  });
  document.body.addEventListener("change", event => {
    const tradeInput = event.target.closest("[data-manual-trade-select]");
    if (tradeInput) {
      const identity = String(tradeInput.dataset.manualTradeSelect || "");
      const current = manualTradeReviewSelectedMap();
      const previousIdentity = manualTradeReviewIdentity(state.manualTradeReviewSelectedTrades?.[0] || state.manualTradeReviewSelection?.[0]);
      if (previousIdentity !== identity) manualTradeReviewResetClientRequestId();
      const trade = state.manualTradeReviewTrades.find(item => manualTradeReviewIdentity(item) === identity);
      if (tradeInput.checked && trade) {
        current.clear();
        current.set(identity, trade);
      } else current.delete(identity);
      state.manualTradeReviewSelectedTrades = [...current.values()];
      state.manualTradeReviewSelection = state.manualTradeReviewSelectedTrades;
      document.querySelectorAll("[data-manual-trade-row]").forEach(row => row.classList.toggle("is-selected", current.has(String(row.dataset.manualTradeRow || ""))));
      renderManualTradeReviewSelectionSummary();
      renderManualTradeReviewTrades();
      return;
    }
    if (event.target.id === "manualTradeReviewStrategy") {
      const nextStrategyId = Number(event.target.value || 0) || null;
      if (Number(state.manualTradeReviewStrategyId || 0) !== nextStrategyId) manualTradeReviewResetClientRequestId();
      state.manualTradeReviewStrategyId = nextStrategyId;
      renderManualTradeReviewSelectionSummary();
    }
  });
  // Timeframe checkbox change → update confirm text
  // (removed old modal handlers)

  document.querySelectorAll(".nav-item").forEach((button) => {
    if (button.dataset.tab) {
      button.addEventListener("click", () => setTab(
        button.dataset.tab,
        button.dataset.tab === "ai-analyze" ? { selectLatest:true } : {},
      ));
    }
  });

  document.querySelectorAll("[data-model-strategy-tab]").forEach(button => {
    button.addEventListener("click", () => setModelStrategySubtab(button.dataset.modelStrategyTab));
    button.addEventListener("keydown", event => {
      if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
      event.preventDefault();
      const tabs = [...document.querySelectorAll("[data-model-strategy-tab]")];
      const current = tabs.indexOf(button);
      const target = event.key === "Home" ? 0
        : event.key === "End" ? tabs.length - 1
          : (current + (event.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length;
      setModelStrategySubtab(tabs[target].dataset.modelStrategyTab);
      tabs[target].focus();
    });
  });

  $("mobileNavMoreBtn")?.addEventListener("click", openMobileNav);
  $("mobileNavDrawer")?.addEventListener("keydown", handleMobileNavKeydown);
  document.querySelectorAll("[data-mobile-nav-close]").forEach(button => button.addEventListener("click", () => closeMobileNav()));
  window.matchMedia("(min-width: 768px)").addEventListener("change", event => {
    if (event.matches) closeMobileNav({ restoreFocus:false });
  });

  document.querySelectorAll("[data-analyst-view]").forEach(button => {
    button.addEventListener("click", () => setAnalystView(button.dataset.analystView));
    button.addEventListener("keydown", event => {
      if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
      event.preventDefault();
      const tabs = [...document.querySelectorAll("[data-analyst-view]")];
      const current = tabs.indexOf(button);
      const target = event.key === "Home" ? 0
        : event.key === "End" ? tabs.length - 1
          : (current + (event.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length;
      setAnalystView(tabs[target].dataset.analystView);
      tabs[target].focus();
    });
  });

  document.body.addEventListener("click", async (event) => {
    const actionButton = event.target.closest("[data-action]");
    const tabButton = event.target.closest("[data-tab-jump]");
    const closeButton = event.target.closest("[data-close-ticket]");
    const editProtectionButton = event.target.closest("[data-edit-protection-ticket]");
    const auditResult = event.target.closest("[data-audit-result]");
    const pagerButton = event.target.closest("[data-pager]");
    const modelAction = event.target.closest("[data-model-action]");
    const reviewCase = event.target.closest("[data-review-id]");
    const reviewAction = event.target.closest("[data-review-action]");
    const strategyMemoryAction = event.target.closest("[data-strategy-memory-action]");
    const strategyMemoryRestore = event.target.closest("[data-strategy-memory-restore]");
    const strategyMemoryConflict = event.target.closest("[data-strategy-memory-conflict]");
    const strategyMemoryMode = event.target.closest("[data-strategy-memory-mode]");
    const strategyMemoryConflictOnly = event.target.closest("[data-strategy-memory-conflict-only]");
    const manualReviewAction = event.target.closest("[data-manual-review-action]");
    const riskSave = event.target.closest("[data-risk-save]");
    const killSwitch = event.target.closest("[data-kill-switch]");
    const strategyAction = event.target.closest("[data-strategy-action]");
    const subscriptionAction = event.target.closest("[data-subscription-action]");
    const openWorkspaceTab = event.target.closest("[data-open-workspace-tab]");
    const positionManagementDetail = event.target.closest("[data-position-management-id]");

    if (strategyMemoryMode) {
      const nextMode = strategyMemoryMode.dataset.strategyMemoryMode === "source" ? "source" : "preview";
      if (nextMode === "source" && !state.strategyMemoryEditorDirty) state.strategyMemoryEditorDraft = state.strategyMemoryDetail?.library?.content_text || "";
      state.strategyMemoryViewMode = nextMode; renderStrategyMemoryLibrary(); return;
    }
    if (strategyMemoryConflictOnly) {
      state.strategyMemoryConflictOnly = Boolean(strategyMemoryConflictOnly.checked); renderStrategyMemoryLibrary(); return;
    }
    if (strategyMemoryAction) {
      const strategyId = Number(state.selectedStrategyMemoryId || 0);
      const library = state.strategyMemoryDetail?.library;
      if (!strategyId || !library) return;
      if (strategyMemoryAction.dataset.strategyMemoryAction === "cancel") {
        if (state.strategyMemoryEditorDirty) {
          const confirmed = await showConfirm("放弃未保存的记忆原文？", "取消编辑会丢弃当前草稿并返回已保存的阅读预览。", { confirmText:"放弃编辑", danger:true });
          if (!confirmed) return;
        }
        state.strategyMemoryEditorDirty = false;
        state.strategyMemoryEditorDraft = null;
        state.strategyMemoryViewMode = "preview";
        renderStrategyMemoryLibrary();
        return;
      }
      if (strategyMemoryCompressionActive(state.strategyMemoryCompressionJob)
        && strategyMemoryAction.dataset.strategyMemoryAction !== "consistency") {
        renderStrategyMemoryCompressionStatus(state.strategyMemoryCompressionJob);
        return;
      }
      strategyMemoryAction.disabled = true;
      try {
        if (strategyMemoryAction.dataset.strategyMemoryAction === "consistency") {
          const queued = await api(`/api/ai/strategy-memories/${strategyId}/consistency-checks`, { method:"POST", body:{
            expected_version_no:Number(library.version_no), trigger_type:"manual_check",
            force_new:["stale", "status_unknown", "failed"].includes(String(state.strategyMemoryConsistencyJob?.status || "")),
          } });
          startStrategyMemoryConsistencyPolling(strategyId, queued.job);
          toast("一致性检查已进入队列", "success");
        } else if (strategyMemoryAction.dataset.strategyMemoryAction === "save") {
          const content = $("strategyMemoryContent")?.value ?? "";
          const data = await api(`/api/ai/strategy-memories/${strategyId}`, { method:"PUT", body:{
            content_text:content, expected_version_no:Number(library.version_no),
            capacity_chars:Number(library.capacity_chars),
            compression_target_ratio:Number(library.compression_target_ratio),
            conflict_alert_threshold:Number(library.conflict_alert_threshold),
          } });
          toast(`记忆库已保存为版本 ${Number(data.library?.version_no || 0)}`, "success");
          state.strategyMemoryEditorDirty = false;
          state.strategyMemoryEditorBaseline = data.library?.content_text || content;
          state.strategyMemoryEditorDraft = null;
          state.strategyMemoryViewMode = "preview";
          state.strategyMemoryEditorStrategyId = strategyId;
          state.strategyMemoryDetail = await api(`/api/ai/strategy-memories/${strategyId}`);
          await loadStrategyMemoryPreview(strategyId);
          const overview = state.strategyMemoryStrategies.find(item => Number(item.strategy_id) === strategyId);
          if (overview) overview.library = state.strategyMemoryDetail.library;
          renderStrategyMemoryLibrary();
          const autoJobId = Number(data.compression_job_id || data.library?.compression_job_id || 0);
          if (autoJobId > 0) startStrategyMemoryCompressionPolling(strategyId, { id:autoJobId, status:"queued" });
          if (Number(data.consistency_job_id || 0) > 0) startStrategyMemoryConsistencyPolling(strategyId, { id:Number(data.consistency_job_id), status:"queued" });
        } else {
          const queued = await api(`/api/ai/strategy-memories/${strategyId}/compress`, { method:"POST" });
          const job = queued.job || queued;
          startStrategyMemoryCompressionPolling(strategyId, job);
          toast("压缩任务已进入队列", "success");
        }
      } catch (error) {
        toast(localizeReason(error.message), "error");
        strategyMemoryAction.disabled = false;
        renderStrategyMemoryCompressionStatus(state.strategyMemoryCompressionJob);
      }
      return;
    }
    if (strategyMemoryRestore) {
      const strategyId = Number(state.selectedStrategyMemoryId || 0);
      const revisionId = Number(strategyMemoryRestore.dataset.strategyMemoryRestore);
      const library = state.strategyMemoryDetail?.library;
      if (!strategyId || !revisionId || !library) return;
      if (strategyMemoryCompressionActive(state.strategyMemoryCompressionJob)) return;
      const confirmed = await showConfirm("恢复记忆库历史版本", "当前内容不会被删除，而是保留在版本历史中；恢复操作会创建一个新的当前版本。", { confirmText:"恢复为新版本" });
      if (!confirmed) return;
      try {
        await api(`/api/ai/strategy-memories/${strategyId}/revisions/${revisionId}/restore`, { method:"POST", body:{ expected_version_no:Number(library.version_no) } });
        toast("历史内容已恢复为新版本", "success");
        state.strategyMemoryDetail = await api(`/api/ai/strategy-memories/${strategyId}`);
        state.strategyMemoryViewMode = "preview";
        state.strategyMemoryEditorDirty = false;
        state.strategyMemoryEditorDraft = null;
        await loadStrategyMemoryPreview(strategyId);
        renderStrategyMemoryLibrary();
      } catch (error) { toast(localizeReason(error.message), "error"); }
      return;
    }
    if (strategyMemoryConflict) {
      const conflictId = Number(strategyMemoryConflict.dataset.strategyMemoryConflict);
      const action = strategyMemoryConflict.dataset.strategyMemoryConflictAction;
      try {
        const current = (state.strategyMemoryDetail?.conflicts || []).find(item => Number(item.id) === conflictId);
        await api(`/api/ai/strategy-memory-conflicts/${conflictId}/${action}`, { method:"POST", body:{ expected_updated_at:current?.updated_at } });
        toast(action === "resolve" ? "冲突已标记为人工处理" : action === "reopen" ? "冲突已重新打开" : "冲突提醒已忽略", "success");
        state.strategyMemoryDetail = await api(`/api/ai/strategy-memories/${Number(state.selectedStrategyMemoryId)}`);
        await loadStrategyMemoryPreview(Number(state.selectedStrategyMemoryId));
        renderStrategyMemoryLibrary();
      } catch (error) { toast(localizeReason(error.message), "error"); }
      return;
    }

    if (editProtectionButton) {
      openPositionProtectionModal(editProtectionButton.dataset.editProtectionTicket);
      return;
    }

    if (positionManagementDetail) {
      loadPositionManagementDetail(positionManagementDetail.dataset.positionManagementId).catch(error => toast(error.message, "error"));
      return;
    }

    if (auditResult) {
      const expanded = auditResult.classList.toggle("expanded");
      auditResult.setAttribute("aria-expanded", String(expanded));
      return;
    }


    if (openWorkspaceTab) {
      setWorkspaceSubtab(openWorkspaceTab.dataset.openWorkspaceTab, openWorkspaceTab.dataset.openWorkspaceTarget);
      return;
    }

    if (strategyAction) {
      const row = strategyAction.closest("[data-strategy-id]"), strategy = (state.strategies || []).find(item => Number(item.id) === Number(row?.dataset.strategyId));
      if (!strategy) return;
      try {
        if (strategyAction.dataset.strategyAction === "edit") openStrategyEditor(strategy);
        else if (strategyAction.dataset.strategyAction === "subscribe") openSubscriptionEditor(strategy);
        else if (strategyAction.dataset.strategyAction === "delete") {
          const { preview } = await api(`/api/ai/strategies/${strategy.id}/delete-preview`);
          const confirmed = await showConfirm(
            "删除策略",
            "删除后，策略将从可用列表移除，所有关联订阅都会停止执行。此操作只能由管理员通过数据恢复。",
            {
              confirmText:"删除策略", danger:true, requireText:preview.title,
              requireTextLabel:"请输入策略名称，确认你删除的是正确策略",
              detailRows:[
                ["策略范围", preview.scope === "platform" ? "平台策略" : "我的策略"],
                ["关联订阅", `${preview.subscription_count} 个`],
                ["正在运行", `${preview.active_subscription_count} 个`, preview.active_subscription_count ? "danger" : ""],
                ["受影响用户", `${preview.affected_user_count} 人`],
              ],
            }
          );
          if (!confirmed) return;
          await api(`/api/ai/strategies/${strategy.id}`, { method:"DELETE", body:{
            confirm_title:preview.title,
            confirm_version:preview.version,
            expected_active_subscriptions:preview.active_subscription_count,
            confirm_stop_subscriptions:true,
          } });
          toast("策略已删除，关联订阅已停止", "success");
          await Promise.all([loadStrategyCatalog(), loadStatus()]);
        }
      } catch (error) { toast(error.message, "error"); }
      return;
    }
    if (subscriptionAction) {
      const subscription = (state.strategySubscriptions || []).find(item => Number(item.id) === Number(subscriptionAction.dataset.subscriptionId));
      const strategy = (state.strategies || []).find(item => Number(item.id) === Number(subscription?.strategy_id));
      if (!subscription) return;
      try {
        if (subscriptionAction.dataset.subscriptionAction === "edit") openSubscriptionEditor(strategy || { id:subscription.strategy_id, scope:subscription.strategy_scope }, subscription);
        else if (subscriptionAction.dataset.subscriptionAction === "delete" && confirm("确认删除这个订阅？如果这是最后一个有效订阅，自动分析会同步关闭。")) {
          const deleted = await api(`/api/ai/subscriptions/${subscription.id}`, { method:"DELETE" });
          if (deleted.scheduler) {
            state.autoEnabled = Boolean(deleted.scheduler.enabled);
            state.autoRuntime = deleted.scheduler;
            renderAutoAnalyzeBadge(deleted.scheduler);
          }
          toast("订阅已删除", "success");
          await Promise.all([loadStrategyCatalog(), loadStatus()]);
        }
      } catch (error) { toast(error.message, "error"); }
      return;
    }

    if (modelAction) {
      const row = modelAction.closest("[data-model-id]"); const id = Number(row?.dataset.modelId); const profile = state.modelProfiles.find(item => Number(item.id) === id); const scope = state.user?.role === "admin" ? "platform" : "user";
      try {
        if (modelAction.dataset.modelAction === "edit") openModelEditor(profile);
        else if (modelAction.dataset.modelAction === "test") { modelAction.disabled = true; modelAction.setAttribute("aria-busy", "true"); modelAction.textContent = "测试中…"; const data = await api(`/api/ai/model-profiles/${id}/test`, { method:"POST", body:{ scope }, timeout:modelRequestTransportTimeoutMs(profile?.request_timeout_ms) }); toast(`连接成功 · ${data.latency_ms} ms`, "success"); }
        else if (modelAction.dataset.modelAction === "default") { await api(`/api/ai/model-profiles/${id}/default`, { method:"POST", body:{ scope } }); toast("默认模型已更新", "success"); await loadModelManagement(); }
        else if (modelAction.dataset.modelAction === "delete") {
          modelAction.disabled = true;
          const { impact } = await api(`/api/ai/model-profiles/${id}/delete-impact?scope=${scope}`);
          if (!impact.can_delete) {
            const strategyNames = (impact.strategies || []).map(item => item.title).filter(Boolean);
            const purposeLabels = (impact.purpose_bindings || []).map(item => MODEL_PURPOSE_LABELS[item.purpose_key] || item.purpose_key).filter(Boolean);
            const reason = impact.is_default
              ? "该模型当前是默认模型，请先设置另一个默认模型。"
              : purposeLabels.length
                ? `该模型仍被以下用途使用：${purposeLabels.join("、")}。请先更换用途模型或改为继承规则。`
                : `该模型仍被 ${strategyNames.length} 个策略绑定，请先在策略中更换模型。`;
            await showConfirm("暂时无法删除模型", reason, {
              confirmText:"知道了", cancelText:"关闭",
              detailRows:[
                ["模型", impact.model_name || `#${impact.id}`],
                ["默认模型", impact.is_default ? "是" : "否", impact.is_default ? "danger" : ""],
                ["绑定策略", strategyNames.length ? strategyNames.join("、") : "无", strategyNames.length ? "danger" : ""],
                ["用途分配", purposeLabels.length ? purposeLabels.join("、") : "无", purposeLabels.length ? "danger" : ""],
              ],
            });
            return;
          }
          const confirmed = await showConfirm("永久删除模型", "删除后将无法恢复，已保存的接口凭据也会停止使用。", {
            confirmText:"永久删除", danger:true,
            requireText:impact.model_name,
            requireTextLabel:"输入模型名称以确认",
            requireTextHint:"必须与模型名称完全一致",
            detailRows:[["模型", impact.model_name], ["模型编号", `#${impact.id}`], ["绑定策略", "无"]],
          });
          if (!confirmed) return;
          await api(`/api/ai/model-profiles/${id}?scope=${scope}`, {
            method:"DELETE", body:{ confirm_name:impact.model_name, confirm_id:impact.id },
          });
          toast("模型已删除", "success");
          await loadModelManagement();
        }
      } catch (error) { toast(localizeReason(error.message),"error"); } finally { if (modelAction.dataset.modelAction === "test") { modelAction.textContent = "测试连接"; modelAction.removeAttribute("aria-busy"); } modelAction.disabled = false; }
      return;
    }
    if (manualReviewAction) {
      const action = manualReviewAction.dataset.manualReviewAction;
      const caseId = Number(manualReviewAction.dataset.manualReviewId || state.manualTradeReviewSelectedId || 0);
      try {
        if (action === "apply-filters") {
          manualTradeReviewReadFilters();
          loadManualTradeReviewTrades({ reset:true }).catch(error => toast(localizeReason(error.code || error.message), "error"));
        } else if (action === "reset-filters") {
          ["manualTradeReviewSymbol", "manualTradeReviewDirection"].forEach(id => { const node = $(id); if (node) node.value = ""; });
          manualTradeReviewReadFilters();
          loadManualTradeReviewTrades({ reset:true }).catch(error => toast(localizeReason(error.code || error.message), "error"));
        } else if (action === "refresh-trades") {
          manualTradeReviewReadFilters();
          loadManualTradeReviewTrades({ reset:true, forceRefresh:true }).catch(error => toast(localizeReason(error.code || error.message), "error"));
        } else if (action === "next-trades") moveManualTradeReviewCursor("next").catch(error => toast(localizeReason(error.code || error.message), "error"));
        else if (action === "previous-trades") moveManualTradeReviewCursor("previous").catch(error => toast(localizeReason(error.code || error.message), "error"));
        else if (action === "to-strategy") setManualTradeReviewStage("strategy");
        else if (action === "back-selection") setManualTradeReviewStage("selection");
        else if (action === "view-history") setManualTradeReviewStage("result");
        else if (action === "create-review") createManualTradeReviewTask().catch(error => toast(localizeReason(error.code || error.message), "error"));
        else if (action === "new-review") {
          stopManualTradeReviewPolling();
          manualTradeReviewResetClientRequestId();
          state.manualTradeReviewSelectedId = null;
          state.selectedManualTradeReviewId = null;
          state.manualTradeReviewDetail = null;
          state.manualTradeReviewSelectedTrades = [];
          state.manualTradeReviewSelection = [];
          state.manualTradeReviewStrategyId = null;
          if ($("manualTradeReviewStrategy")) $("manualTradeReviewStrategy").value = "";
          if ($("manualTradeReviewThesis")) $("manualTradeReviewThesis").value = "";
          setManualTradeReviewStage("selection", { loadData:false });
          loadManualTradeReviewTrades({ reset:true }).catch(error => toast(localizeReason(error.code || error.message), "error"));
        } else if (action === "refresh-history") loadManualTradeReviewHistory({ reset:true }).then(() => state.manualTradeReviewSelectedId ? openManualTradeReviewDetail(state.manualTradeReviewSelectedId, { silent:true }) : null).catch(error => toast(localizeReason(error.code || error.message), "error"));
        else if (action === "previous-history" || action === "next-history") {
          const delta = action === "next-history" ? state.manualTradeReviewHistoryPageSize : -state.manualTradeReviewHistoryPageSize;
          state.manualTradeReviewHistoryOffset = Math.max(0, state.manualTradeReviewHistoryOffset + delta);
          loadManualTradeReviewHistory().catch(error => toast(localizeReason(error.code || error.message), "error"));
        } else if (action === "open-history") openManualTradeReviewDetail(caseId).catch(error => toast(localizeReason(error.code || error.message), "error"));
        else if (action === "reload-detail") openManualTradeReviewDetail(caseId).catch(error => toast(localizeReason(error.code || error.message), "error"));
        else if (action === "retry-review") {
          manualReviewAction.disabled = true;
          api(`/api/ai/manual-trade-reviews/${caseId}/retry`, { method:"POST" }).then(() => openManualTradeReviewDetail(caseId)).then(() => loadManualTradeReviewHistory()).then(() => toast("已重新进入生成队列", "success")).catch(error => toast(localizeReason(error.code || error.message), "error")).finally(() => { manualReviewAction.disabled = false; });
        } else if (["approve-review", "mark-problem", "defer-review"].includes(action)) {
          const reviewAction = action === "approve-review" ? "approve" : action === "mark-problem" ? "mark_problem" : "defer";
          manualReviewAction.disabled = true;
          api(`/api/ai/manual-trade-reviews/${caseId}/confirm`, { method:"POST", body:{ version_id:Number(manualReviewAction.dataset.manualVersionId || 0), action:reviewAction } }).then(() => openManualTradeReviewDetail(caseId)).then(() => loadManualTradeReviewHistory()).then(() => toast(reviewAction === "approve" ? "复盘已确认；未写入记忆或策略" : "复盘状态已更新", "success")).catch(error => toast(localizeReason(error.code || error.message), "error")).finally(() => { manualReviewAction.disabled = false; });
        } else if (action === "save-edit") {
          const editor = document.querySelector("[data-manual-content-editor]");
          let content;
          try { content = JSON.parse(editor?.value || "{}"); } catch { throw new Error("人工编辑内容不是有效 JSON"); }
          manualReviewAction.disabled = true;
          api(`/api/ai/manual-trade-reviews/${caseId}/edit`, { method:"POST", body:{ content, expected_version_id:Number(manualReviewAction.dataset.manualVersionId || 0), change_note:"用户在手动交易复盘页面修改" } }).then(() => openManualTradeReviewDetail(caseId)).then(() => loadManualTradeReviewHistory()).then(() => toast("人工修订已保存为新版本", "success")).catch(error => toast(localizeReason(error.code || error.message), "error")).finally(() => { manualReviewAction.disabled = false; });
        } else if (action === "open-strategy-editor") await openManualReviewStrategyEditor(state.manualTradeReviewDetail);
      } catch (error) { toast(localizeReason(error.code || error.message), "error"); }
      return;
    }
    if (reviewCase) { openPeriodReviewDetail(Number(reviewCase.dataset.reviewId)).catch(error => toast(error.message,"error")); return; }
    if (reviewAction) {
      const caseId = state.selectedReviewId, versionId = Number(reviewAction.dataset.versionId || 0), action = reviewAction.dataset.reviewAction;
      if (action === "back-list") {
        stopReviewDetailPolling();
        state.reviewDetailRequestVersion += 1;
        state.selectedReviewId = null;
        renderReviewCases();
        const reviewLayout = document.querySelector(".period-review-layout");
        reviewLayout?.classList.remove("has-mobile-detail");
        document.querySelector(".review-queue")?.scrollIntoView({ behavior:"smooth", block:"start" });
        return;
      }
      try {
        if (action === "reload-detail") {
          await openPeriodReviewDetail(caseId);
        }
        else if (action === "retry") {
          reviewAction.disabled = true;
          reviewAction.innerHTML = '<i data-lucide="loader-circle" size="14"></i>正在进入队列';
          await api(`/api/ai/period-reviews/${caseId}/retry`, { method:"POST" });
          toast("已进入生成队列，后台将立即开始处理", "success");
        }
        else if (action === "retry-derivation") {
          reviewAction.disabled = true;
          await api(`/api/ai/period-reviews/${caseId}/derivation/retry`, { method:"POST" });
          toast("经验处理已重新进入队列", "success");
        }
        else if (action === "save") { syncPeriodReviewEditorFromFields(); const content = JSON.parse($("reviewContentEditor").value); const saved = await api(`/api/ai/period-reviews/${caseId}/edit`, { method:"POST", body:{ content, expected_version_id:versionId, change_note:"用户在周期复盘页面修改" } }); toast(`已保存为新版本 #${saved.versionNo}`,"success"); }
        else {
          const confirmed = await api(`/api/ai/period-reviews/${caseId}/confirm`, { method:"POST", body:{ version_id:versionId, action } });
          if (confirmed.post_action_error) toast(`复盘已确认，但经验处理未完成：${localizeReason(confirmed.post_action_error)}`, "warning");
        }
        await loadReviewMemory(); await openPeriodReviewDetail(caseId);
      } catch (error) { toast(error.message,"error"); }
      finally { reviewAction.disabled = false; }
      return;
    }
    if (killSwitch) {
      const enabled = killSwitch.dataset.enabled === "1";
      const reason = prompt(enabled ? "请输入紧急停止新开仓的原因" : "请输入解除紧急停止的原因"); if (!reason) return;
      try { await api(`/api/ai/risk-center/${Number(killSwitch.dataset.killSwitch)}/kill-switch`, { method:"POST", body:{ enabled, reason } }); toast("账户 Kill Switch 已更新", "success"); await loadRiskCenter(); }
      catch (error) { toast(error.message,"error"); } return;
    }
    if (riskSave) {
      const panel = riskSave.closest("[data-risk-account]"), changes = {};
      panel?.querySelectorAll("[data-user-risk-field]").forEach(input => {
        changes[input.dataset.userRiskField] = input.value.trim() === "" ? null : Number(input.value);
      });
      const riskInput = panel?.querySelector('[data-user-risk-field="max_risk_per_trade_pct"]');
      if (riskInput) {
        const nextRisk = Number(riskInput.value.trim() === "" ? riskInput.dataset.inheritedRiskValue : riskInput.value);
        const originalRisk = Number(riskInput.dataset.originalEffectiveRisk);
        const minimumRisk = Number(riskInput.min), maximumRisk = Number(riskInput.max);
        if (!Number.isFinite(nextRisk) || nextRisk < minimumRisk || nextRisk > maximumRisk) {
          updateUserRiskPreferencePreview(riskInput);
          riskInput.focus({ preventScroll:true });
          toast(`单笔最大风险必须在 ${riskPercentageText(minimumRisk)}～${riskPercentageText(maximumRisk)} 之间`, "error");
          return;
        }
        if (nextRisk > 1 && (!Number.isFinite(originalRisk) || originalRisk <= 1)) {
          const level = singleTradeRiskLevel(nextRisk, maximumRisk);
          const confirmed = await showConfirm("确认提高单笔风险", "该设置高于平台推荐区间。标准仓止损时会使用完整风险额度，实际损失还可能因滑点或跳空增加。", {
            confirmText:"确认并保存", cancelText:"返回调整", danger:true,
            detailRows:[
              ["风险档位", level.label, level.tone === "high" ? "risk-high" : "warning"],
              ["单笔最大风险", riskPercentageText(nextRisk), level.tone === "high" ? "risk-high" : "warning"],
              ["试探仓 / 轻仓", `${riskPercentageText(nextRisk * 0.25)} / ${riskPercentageText(nextRisk * 0.5)}`],
              ["连续 10 次标准仓止损", `理论回撤约 ${consecutiveLossDrawdown(nextRisk).toFixed(1)}%`, "risk-high"],
            ],
          });
          if (!confirmed) return;
        }
      }
      riskSave.disabled = true;
      try { await api(`/api/ai/risk-center/${Number(riskSave.dataset.riskSave)}`, { method:"PUT", body:{ changes, reason:"用户从风控中心更新" } }); toast("用户风控已立即生效", "success"); await loadRiskCenter({ preserveRuleState:true, preserveRuleDrafts:false }); }
      catch (error) { toast(error.message,"error"); }
      finally { riskSave.disabled = false; }
      return;
    }

    if (pagerButton && !pagerButton.disabled) {
      const page = Number(pagerButton.dataset.page);
      if (pagerButton.dataset.pager === "signals") {
        state.signalFilters.page = page;
        loadSignalTable();
      } else if (pagerButton.dataset.pager === "history") {
        const previousPage = Number(state.historyFilters.page || 1);
        state.historyFilters.page = page;
        if (page === 1 && previousPage > 1) {
          // Page one deliberately starts a new opaque snapshot. Keep the frozen
          // query range, but discard the prior snapshot and its page cursors.
          _historyCache = null;
          _historyCursorState.snapshotId = null;
          _historyCursorState.pageCursors = new Map([[1, null]]);
        }
        loadHistoryViews({ tableOnly:true }).catch(() => {});
      } else if (pagerButton.dataset.pager === "audit") {
        state.auditFilters.page = page;
        renderAuditRows();
      } else if (pagerButton.dataset.pager === "executions") {
        state.executionFilters.page = page;
        loadExecutionDecisions().catch(error => toast(error.message, "error"));
      } else if (pagerButton.dataset.pager === "position-management") {
        state.positionManagementFilters.page = page;
        state.selectedPositionManagementId = null;
        loadPositionManagement().catch(error => toast(error.message, "error"));
      }
      return;
    }

    if (actionButton) {
      const action = actionButton.dataset.action;
      if (action === "toggle-analysis-text") {
        const text = $("analysisTextContent");
        const expanded = text?.classList.toggle("collapsed") === false;
        actionButton.textContent = expanded ? "收起分析正文" : "展开完整分析";
        return;
      }
      const tasks = {
        "refresh-account": loadAccount,
        "refresh-positions": loadPositions,
        "refresh-quote": refreshQuote,
        "refresh-signals": () => state.analystView === "records"
          ? loadSignalTable()
          : loadSignals({ skipResultRender:true, loadDashboard:false }),
        "refresh-analysis-history": () => loadSignals({ skipResultRender:true, loadDashboard:false }),
         "refresh-history": () => loadHistoryViews({ forceRefresh:true, manualRefresh:true }),
        "refresh-trading-page": refreshTradingPage,
        "refresh-history-page": refreshHistoryPage,
        "refresh-audit": loadAudit,
        "export-history": exportHistory,
        "refresh-risk-center": loadRiskCenter,
        "refresh-review-memory": refreshReviewMemoryTab,
        "retry-model-management": loadModelManagement,
        "refresh-position-management": () => loadPositionManagement({ preserveSelection:true }),
      };
      if (tasks[action]) {
        withBusy(actionButton, tasks[action]).catch((error) => toast(error.message, "error"));
      }
    }

    if (tabButton) setTab(tabButton.dataset.tabJump, tabButton.dataset.tabJump === "ai-analyze" ? { analystView:"detail" } : {});
    const analysisButton = event.target.closest("[data-analysis-id]");
    if (analysisButton) openAnalysisFromHistory(analysisButton.dataset.analysisId);
    if (closeButton) closePosition(closeButton.dataset.closeTicket);
  });

  // History scope drives the table, summary and chart together.
  document.getElementById('historyRangeMode')?.addEventListener('change', () => {
    cancelHistoryRangeRetry();
    const scope = $("historyRangeMode")?.value || HISTORY_DEFAULT_SCOPE;
    const savedStart = historyPreferenceStart(scope);
    if ($("historyRangeFrom")) $("historyRangeFrom").value = savedStart;
    if ($("historyRangeTo")) $("historyRangeTo").value = "";
    state.historyRangeMeta = null;
    state.historyChartSelectedDate = "";
    state.historyChartFocusIndex = -1;
    // A scope selection is itself an explicit query.  Confirm the new frozen
    // endpoint immediately so the date fields never remain in the provisional
    // “正在确认范围” state waiting for a first Apply click.  A later date edit
    // still uses the Apply button and starts its own generation once.
    loadHistoryViews({ newQuery:true, trigger:"scope", forceRefresh:false }).catch(() => {});
  });
  document.getElementById('historyRangeApply')?.addEventListener('click', () => {
    try {
      getHistoryRangeParams();
    }
    catch (error) { toast(error.message, 'error'); return; }
    state.historyFilters.page = 1;
    _historyCache = null;
    _historyChartCache = null;
    state.historyChartSelectedDate = "";
    state.historyChartFocusIndex = -1;
    loadHistoryViews({ newQuery:true, trigger:"apply", forceRefresh:false }).catch(() => {});
  });
  document.getElementById('historyRangeSave')?.addEventListener('click', async () => {
    if (isObserverMode()) { toast(observerMessage(), 'warning'); return; }
    const scope = $("historyRangeMode")?.value || HISTORY_DEFAULT_SCOPE;
    if (!(scope === "all" || scope === "platform")) return;
    const from = $("historyRangeFrom")?.value || "";
    try { getHistoryRangeParams(); }
    catch (error) { toast(error.message, 'error'); return; }
    const button = $("historyRangeSave");
    if (button) button.disabled = true;
    try {
      const result = await wsApi("history_range_preference_set", {
        history_scope:scope,
        start_date:from,
      });
      historyRememberServerStart(scope, result?.preference?.start_date || result?.saved_start_date || from);
      state.historyFilters.page = 1;
      _historyCache = null;
      _historyChartCache = null;
      await loadHistoryViews({ newQuery:true, trigger:"save", forceRefresh:false });
      toast("开始日期已保存到当前交易账户", "success");
    } catch (error) {
      toast(apiErrorMessage(error?.message || "开始日期保存失败，请稍后重试"), "error");
    } finally {
      updateHistoryRangeUI();
    }
  });
  document.getElementById('historyRangeRestore')?.addEventListener('click', async () => {
    if (isObserverMode()) { toast(observerMessage(), 'warning'); return; }
    const scope = $("historyRangeMode")?.value || HISTORY_DEFAULT_SCOPE;
    if (!(scope === "all" || scope === "platform")) return;
    const button = $("historyRangeRestore");
    if (button) button.disabled = true;
    try {
      await wsApi("history_range_preference_set", {
        history_scope:scope,
        start_date:null,
      });
      historyClearSavedStart(scope);
      const systemStart = state.historyRangeMeta?.systemStartDate || "";
      if ($("historyRangeFrom")) $("historyRangeFrom").value = systemStart;
      if ($("historyRangeTo")) $("historyRangeTo").value = "";
      state.historyFilters.page = 1;
      _historyCache = null;
      _historyChartCache = null;
      await loadHistoryViews({ newQuery:true, trigger:"reset", forceRefresh:false });
      toast("已恢复当前交易账户的系统起点", "success");
    } catch (error) {
      toast(apiErrorMessage(error?.message || "恢复系统起点失败，请稍后重试"), "error");
    } finally {
      updateHistoryRangeUI();
    }
   });
   updateHistoryRangeUI();
   // Legacy bind-time shape retained for static contract readers:
   // loadHistoryViews({ forceRefresh:false }).catch(() => {})
   // Table filters further narrow trade rows inside the selected history scope.
  document.getElementById('historyFilterApply')?.addEventListener('click', () => {
    try {
      const ranges = [["filterEntryFrom", "filterEntryTo"], ["filterCloseFrom", "filterCloseTo"]];
      for (const [fromId, toId] of ranges) {
        const from = $(fromId)?.value || "";
        const to = $(toId)?.value || "";
        if (from && !validHistoryBusinessDate(from) || to && !validHistoryBusinessDate(to)) throw new Error("筛选日期格式无效");
        if (from && to && from > to) throw new Error("筛选开始日期不能晚于结束日期");
      }
    } catch (error) { toast(error.message, "error"); return; }
    state.historyFilters.page = 1;
    loadHistoryViews({ newQuery:true, trigger:"filter", forceRefresh:false }).catch(() => {});
  });
  document.getElementById('historyFilterReset')?.addEventListener('click', () => {
    ['filterEntryFrom','filterEntryTo','filterCloseFrom','filterCloseTo'].forEach(id => { const el = document.getElementById(id); if (el) el.value = ''; });
    ['filterDirection','filterProfit'].forEach(id => { const el = document.getElementById(id); if (el) el.selectedIndex = 0; });
    state.historyFilters.page = 1;
    state.historyFilters.closeFrom = "";
    state.historyFilters.closeTo = "";
    state.historyChartSelectedDate = "";
    state.historyChartFocusIndex = -1;
    setText("historyChartDrilldownStatus", "点击柱状图或使用键盘选择某个平仓日查看明细");
    loadHistoryViews({ newQuery:true, trigger:"reset", forceRefresh:false }).catch(() => {});
  });
}

document.addEventListener("DOMContentLoaded", () => {
  bindEvents();
  updateSignalDisplay(null);
  initSignalMonitor();
  initIcons();
  initBridgeModal();
  initKlineChart();
  if (state.token) bootstrap();
  else showApp(false);
});

window.addEventListener("beforeunload", event => {
  if (!state.strategyMemoryEditorDirty) return;
  event.preventDefault();
  event.returnValue = "策略记忆原文有未保存的修改。";
});

// --- Changelog Modal ---
async function checkChangelog() {
  try {
    const [current, status] = await Promise.all([
      api('/api/changelog/current'),
      api('/api/changelog-status')
    ]);
    if (current.ok && status.ok && current.version > (status.seenVersion || 0) && current.content) {
      // The API returns content after the dedicated server-side release-note
      // sanitizer. Keep the existing HTML contract without re-sanitizing or
      // executing the administrator's raw input in this client.
      document.getElementById('changelogContent').innerHTML = String(current.content);
      const modal = document.getElementById('changelogModal');
      modal.style.display = 'flex';
      modal.classList.add('active');
      window._changelogVersion = current.version;
    }
  } catch (e) { /* ignore */ }
}

function closeChangelogModal() {
  const modal = document.getElementById('changelogModal');
  modal.classList.remove('active');
  setTimeout(() => { modal.style.display = 'none'; }, 300);
  if (window._changelogVersion) {
    api('/api/changelog-ack', { method: 'POST', body: { version: window._changelogVersion } }).catch(() => {});
    window._changelogVersion = null;
  }
}

// --- feedback logic ---
let _feedbackSubmitting = false;

function showFeedbackPanel() {
  loadFeedbackHistory();
}

function showFieldError(id) {
  document.getElementById(id).classList.add('visible');
}
function hideFieldError(id) {
  document.getElementById(id).classList.remove('visible');
}
function clearFieldErrors() {
  ['errType', 'errTitle', 'errDesc'].forEach(hideFieldError);
}

async function submitFeedback(e) {
  e.preventDefault();
  if (_feedbackSubmitting) return;
  clearFieldErrors();

  const form = document.getElementById('feedbackForm');
  const type = form.querySelector('input[name="feedbackType"]:checked')?.value;
  const title = document.getElementById('feedbackTitle').value.trim();
  const description = document.getElementById('feedbackDesc').value.trim();
  const contact = document.getElementById('feedbackContact').value.trim();

  if (!type) return showFieldError('errType');
  if (!title) return showFieldError('errTitle');
  if (!description) return showFieldError('errDesc');

  _feedbackSubmitting = true;
  const submitBtn = form.querySelector('.feedback-submit-btn');
  submitBtn.disabled = true;
  submitBtn.innerHTML = '<i data-lucide="loader" size="16"></i>提交中…';

  try {
    const resp = await fetch('/api/feedback', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${state.token}` },
      body: JSON.stringify({ type, title, description, contact }),
    });
    const data = await resp.json();

    const successBox = document.getElementById('feedbackSuccess');
    const successMsg = document.getElementById('feedbackSuccessMsg');
    if (data.ok) {
      successBox.classList.remove('hidden');
      successMsg.textContent = data.message;
      // Reset form
      document.getElementById('feedbackTitle').value = '';
      document.getElementById('feedbackDesc').value = '';
      document.getElementById('feedbackContact').value = '';
      form.querySelector('input[name="feedbackType"][value="feature"]').checked = true;
      lucide.createIcons();
      loadFeedbackHistory();
      // Auto-hide success after 6s
      setTimeout(() => { successBox.classList.add('hidden'); }, 6000);
    } else {
      toast(data.error || '提交失败', 'error');
    }
  } catch (err) {
    toast('网络错误，请稍后重试', 'error');
  } finally {
    _feedbackSubmitting = false;
    submitBtn.disabled = false;
    submitBtn.innerHTML = '<i data-lucide="send" size="16"></i>提交反馈';
    lucide.createIcons();
  }
}

async function loadFeedbackHistory() {
  const list = document.getElementById('feedbackHistoryList');
  try {
    const resp = await fetch('/api/feedback/history', {
      headers: { Authorization: `Bearer ${state.token}` },
    });
    const data = await resp.json();
    if (!data.ok || !data.items.length) {
      list.innerHTML = '<div class="empty-state">暂无提交记录</div>';
      return;
    }

    const typeLabels = { feature: '功能建议', bug: 'Bug反馈', trading: '交易需求', course: '课程建议', other: '其他' };
    list.innerHTML = data.items.map(item => `
      <div class="feedback-history-item">
        <div class="fh-meta">
          <span class="fh-type ${escapeHtml(item.type)}">${typeLabels[item.type] || item.type}</span>
          <span>#${item.id}</span>
          <span>${new Date(item.created_at).toLocaleString('zh-CN')}</span>
        </div>
        <div class="fh-title">${escapeHtml(item.title)}</div>
        <div class="fh-desc">${escapeHtml(item.description)}</div>
      </div>
    `).join('');
  } catch (err) {
    list.innerHTML = '<div class="empty-state">加载失败</div>';
  }
}

// Hook into existing setTab
const _origSetTab = setTab;
setTab = function(tab, options = {}) {
  _origSetTab(tab, options);
  if (tab === 'feedback') showFeedbackPanel();
  if (tab === 'ai-analyze') initAnalysisHistoryScroll();
};

// Bind refresh button
document.addEventListener('click', function(e) {
  if (e.target.closest('#refreshFeedbackHistory')) {
    loadFeedbackHistory();
  }
});

if (!window._feedbackInitDone) {
  window._feedbackInitDone = true;
  document.addEventListener('submit', function(e) {
    if (e.target.id === 'feedbackForm') submitFeedback(e);
  });
  // clear inline errors when user starts typing / selecting
  document.addEventListener('input', function(e) {
    if (e.target.id === 'feedbackTitle') hideFieldError('errTitle');
    if (e.target.id === 'feedbackDesc') hideFieldError('errDesc');
  });
  document.addEventListener('change', function(e) {
    if (e.target.name === 'feedbackType') hideFieldError('errType');
  });
}

// ============ Analysis History Infinite Scroll ============
function initAnalysisHistoryScroll() {
  const list = $("analysisHistoryBody");
  if (!list || list._scrollBound) return;
  list._scrollBound = true;

  const loadMore = () => {
    if (!state.analysisHistoryHasMore || state.analysisHistoryLoading) return;
    state.analysisHistoryLoading = true;
    const sentinelEl = list.querySelector(".history-sentinel-text");
    if (sentinelEl) sentinelEl.textContent = "加载中...";
    loadSignals({ append: true, offset: state.analysisHistoryOffset, limit: ANALYSIS_HISTORY_PAGE_SIZE }).finally(() => {
      state.analysisHistoryLoading = false;
      if (!state.analysisHistoryHasMore) {
        const sentinel = list.querySelector(".history-sentinel");
        if (sentinel) sentinel.remove();
      }
    });
  };

  list.addEventListener("scroll", function() {
    const nearBottom = list.scrollTop + list.clientHeight >= list.scrollHeight - 80;
    if (nearBottom) loadMore();
  }, { passive: true });
}
