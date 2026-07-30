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
  accountBalance: 0,
  bridgeAccountIdentity: null,
  bridgePlatform: "mt5",
  historyNetResult: 0,

  signalTableData: [],
  signalTableTotal: 0,
  signalFilters: { direction: "", timeframe: "", page: 1, pageSize: 20 },
  historyFilters: { page: 1, pageSize: 20 },
  auditRows: [],
  auditFilters: { status: "", type: "", page: 1, pageSize: 20 },
  executionFilters: { page: 1, pageSize: 5, total: 0 },
  positionManagementTasks: [],
  positionManagementSettings: null,
  positionManagementFilters: { status: "", page: 1, pageSize: 10, total: 0 },
  selectedPositionManagementId: null,
  positionManagementRealtimeTimer: null,
  positions: [],
  pendingOrders: [],
  positionProtectionPreview: null,
  positionProtectionJob: null,
  positionProtectionPollTimer: null,
  signalTickets: {},
  closeSignalTickets: {},
  analysisHistoryOffset: 0,
  analysisHistoryHasMore: true,
  analysisHistoryLoading: false,
  modelProfiles: [],
  strategyFilter: "all",
  reviewCases: [],
  reviewOverview: { pending: 0, issues: 0 },
  reviewSummary: { attention:0, unread:0, pending_confirmation:0, generating:0, failed:0, total:0, daily_total:0, monthly_total:0, daily_attention:0, monthly_attention:0 },
  reviewSummaryInitialized: false,
  reviewSummaryTimer: null,
  reviewDetailPollTimer: null,
  reviewDetailJobKey: null,
  reviewFilter: "",
  reviewPeriodFilter: "",
  memoryTierFilter: "all",
  memoryItems: [],
  memorySummaries: [],
  memorySettings: {},
  platformMemoryPolicies: [],
  platformMemoryEvaluation: {},
  selectedReviewId: null,
  autoProgressCycles: {},
  autoProgressFlash: null,
  autoProgressVisual: {},
  inferenceChartTimeframe: null,
  inferenceChartSignalKey: null,
  inferenceChartLayers: { segments: true, centers: true, divergence: true, entries: true, levels: true },
};

// ===== History Cache =====
let _historyCache = null;      // { filters: string, data: object }
let _historyChartCache = null; // { filters: string, data: object }
let _prevPositionCount = 0;

function normalizeBridgePlatform(value) {
  return String(value || "").trim().toLowerCase() === "mt4" ? "mt4" : "mt5";
}

function bridgePlatformLabel(value = state.bridgePlatform) {
  return normalizeBridgePlatform(value).toUpperCase();
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
  });
  const pendingRow = $("pendingPriceRow");
  const stopLimitWrap = $("stopLimitPriceWrap");
  if (pendingRow) pendingRow.style.display = "none";
  if (stopLimitWrap) stopLimitWrap.style.display = "none";
}

function updateBridgePlatformUI(value) {
  state.bridgePlatform = normalizeBridgePlatform(value);
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

function setGlobalSymbol(symbol) {
  localStorage.setItem(SYMBOL_STORAGE_KEY, symbol);
  state.platformMarketSourceActive = false;
  state.lastObserverQuote = null;
  for (const id of _symSelectors) {
    const el = document.getElementById(id);
    if (el && el._symSet) el._symSet(symbol);
  }
  wsApi("set_quote_symbol", { symbol }).catch(() => {});
  refreshQuote().catch(() => {});
  loadKlineData().catch(() => {});
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
    input.title = isPlusReadOnly ? 'Plus 会员仅可查看' : '请先连接您的 MT5 账户';
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

function handleFormModalKeydown(event) {
  const modal = event.target.closest?.(".form-modal");
  if (!modal) return;
  if (event.key === "Escape") {
    event.preventDefault();
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
  hold_signal_cannot_execute: "已跳过（观望信号）",
  signal_expired: "已跳过（信号已过期）",
  signal_already_executed_or_pending: "该信号已经执行或已有挂单，不能重复执行",
  kimi_code_model_not_supported: "Kimi Code 模型名称无效，请选择 k3、kimi-for-coding 或 kimi-for-coding-highspeed",
  kimi_code_subscription_or_model_permission_denied: "Kimi Code 订阅或模型权限不足，请检查会员档位、API Key 和模型名称",
  kimi_code_rate_limited: "Kimi Code 订阅额度或五小时频率窗口已用尽，请稍后再试",
  kimi_code_request_rejected: "Kimi Code 拒绝了本次请求，请检查内容与账户状态",
  kimi_code_request_invalid: "Kimi Code 请求参数不兼容，请检查模型与思考设置",
  kimi_code_service_unavailable: "Kimi Code 服务暂时不可用，请稍后再试",
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
  bridge_offline: "用户的交易终端桥接当前未连接",
  user_quote_unavailable: "无法获取用户 MT5 的有效报价",
  stop_loss_missing: "AI 信号缺少有效止损价格",
  invalid_stop_loss_direction: "止损价格方向与订单方向不一致",
  take_profit_target_missing: "所选止盈档位没有有效目标价格",
  invalid_take_profit_direction: "止盈价格方向与订单方向不一致",
  pending_list_unavailable: "无法读取当前 MT5 挂单列表",
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
  lock_lost_before_send: "任务执行权已失效，订单未发送到 MT5",
  bridge_upgrade_required_for_incremental_risk: "桥接软件版本过旧，请从源码重启或升级到最新版后重试",
  risk_snapshot_failed: "无法获取完整的 MT5 风险快照，已为安全起见阻止交易",
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
  const rawOffset = quote?.timezone_offset_minutes;
  if (rawOffset === null || rawOffset === undefined || rawOffset === '') return null;
  const offsetMinutes = Number(rawOffset);
  return Number.isFinite(offsetMinutes) && offsetMinutes >= -840 && offsetMinutes <= 840
    ? offsetMinutes : null;
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

const parseDate = (v) => {
  if (!v || v === "None" || v === "0" || v === "0.0") return null;
  const n = Number(v);
  if (n > 1000000000) return fmtUtc(new Date(n * 1000));
  const s = String(v);
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(s)) return s;
  try { return fmtUtc(new Date(v.replace(" ", "T"))); } catch { return null; }
};

function utcToMt5(utcStr, timezoneOffsetMinutes = 180) {
  if (!utcStr) return null;
  const d = new Date(utcStr.replace(" ", "T") + "Z");
  if (isNaN(d.getTime())) return utcStr;
  const shifted = new Date(d.getTime() + Number(timezoneOffsetMinutes || 0) * 60_000);
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

function signalDisplayTime(signal) {
  return formatTime(signal?.created_at_mt5 || signal?.created_at);
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
  exception: '运行异常',
  disabled: '已关闭',
  unknown: '未知',
};

function autoReasonText(reason) {
  if (!reason) return '未知';
  return AUTO_REASON_LABELS[reason] || '未知状态';
}

function isMarketClosedReason(reason) {
  return ['market_closed', 'market_restricted', 'market_stale_tick', 'market_unknown_no_tick', 'market_unknown'].includes(reason);
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
  el.setAttribute('aria-label', visual.mode ? `${label}，${visual.stage || ''}，${progress}%` : label);

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
  const title = `策略：${ptName || '未选择'}\n状态：正在分析\n${details}\n点击可停止后续自动分析`;
  applyAutoBadge(label, 'running', title, { mode: primary?.stage === 'complete' ? 'complete' : 'running', stage, progress });
}

function renderAutoAnalyzeBadge(s) {
  if (!s) return;
  const ptName = s.prompt_type_name || '';
  const symbols = s.selected_symbols || [];
  const symbolsStr = symbols.join('、') || '未选择品种';

  // Calculate remaining time
  let remaining = null;
  if (s.receivedAtMs && s.next_run_in_seconds) {
    remaining = Math.max(0, s.next_run_in_seconds - Math.floor((Date.now() - s.receivedAtMs) / 1000));
  }

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
  } else if (s.paused_reason && isMarketClosedReason(s.paused_reason)) {
    label = '自动分析 · 休市';
    type = 'warning';
    const msState = s.market_state || {};
    title = `策略：${ptName || '未选择'}\n品种：${symbolsStr}\n状态：休市暂停`;
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
    .replace(/相关条件尚未确认为相关条件尚未确认/g, "线段结构尚不可靠")
    .replace(/系统提示的相关条件尚未确认显示/g, "系统提示的多周期状态显示");
  const replacements = [
    [/\bwindow_stable\s*=\s*false\b/gi, "结构窗口不稳定"],
    [/\btime_location_reliable\s*=\s*false\b/gi, "结构时间定位不可靠"],
    [/\balignment_with_higher\s*=\s*conflict\b/gi, "与高周期方向冲突"],
    [/\bcontext_status\s*=\s*partial\b/gi, "多周期行情证据不完整"],
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
    return translated || "相关条件尚未确认";
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
  const market = signal?.market_data || {};
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
  encryption_master_key_missing: "服务器模型凭据加密密钥未正确配置，请联系管理员检查 32 字节 AES 密钥并重启服务",
  no_model_configured: "尚未配置可用模型，请先在“AI策略师 → 模型管理”中添加模型",
  no_platform_model: "平台尚未配置默认模型",
  bound_model_unavailable: "策略绑定的模型已停用或删除，请重新选择模型",
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
  history_compare_end_time_in_future: "结束时间晚于当前 MT5 时间，请刷新时间范围后重试",
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
  broker_contract_constraint: "订单不符合 MT5 合约约束",
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
  ai_volume_out_of_platform_range: "订单执行上限不符合 MT5 手数规则",
  confidence_below_risk_threshold: "置信度低于策略风险阈值",
  atr_anchor_unavailable_hold: "缺少可靠 ATR 锚点",
  sl_widen_min_lot_hold: "扩大止损后所需手数低于最小值",
  sl_too_far_hold: "止损距离超出允许范围",
  backtest_instrument_incomplete: "交易品种合约参数不完整",
  backtest_execution_candles_unavailable: "缺少用于订单回放的 M1 历史行情",
  backtest_symbol_snapshot_unavailable: "桥接端未返回交易品种合约参数",
  backtest_data_unavailable: "资金回放所需数据暂不可用",
  margin_calculation_unavailable: "当前品种缺少可靠的保证金计算参数，本笔模拟订单未执行",
};

const OBSERVER_WS_READ_ACTIONS = new Set([
  "health", "account", "symbols", "quote", "positions", "rates",
  "signals_latest_id", "signal_detail", "signals", "signal_tickets",
  "close_signal_tickets", "history", "history_chart_data", "pending_list",
  "signal_by_ticket",
]);

function isObserverMode() { return state.aiAccess?.read_only === true; }

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
  if (!access) return;
  const previousMode = state.aiAccess?.mode;
  const previousReason = state.aiAccess?.reason;
  state.aiAccess = access;
  state.isPlusReadOnly = access.reason === "plus_plan";
  document.body.classList.toggle("ai-observer-mode", access.read_only === true);
  document.body.dataset.aiAccessReason = access.reason || "full";
  applyRoleUI();
  if (!canAccessTab(activeTabId())) setTab("dashboard", { skipRefresh:true });
  if (previousMode && (previousMode !== access.mode || previousReason !== access.reason)) {
    _historyCache = null;
    _historyChartCache = null;
  }
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
  _historyCache = null;
  _historyChartCache = null;
  state.lastQuote = null;
  state.bridgeAccountIdentity = null;
  state.positions = [];
  state.pendingOrders = [];
  state.tradingAccounts = [];
  state.strategySubscriptions = [];
  _prevPositionCount = 0;
  if ($("positionsBody")) $("positionsBody").innerHTML = renderPositionRows([], true);
  if ($("dashboardPositionsBody")) $("dashboardPositionsBody").innerHTML = renderPositionRows([], false);
}

async function handleAccountSwitched(msg = {}) {
  const generation = Number(state._accountContextGeneration || 0) + 1;
  state._accountContextGeneration = generation;
  clearAccountContextCaches();
  const login = msg.account?.login == null ? "" : String(msg.account.login);
  if (!msg.verified) {
    toast("当前 MT5 登录没有交易权限，账户数据可查看，但系统不会接管或执行交易", "warning");
  } else if (msg.ownership_transferred) {
    toast(`MT5 账户${login ? ` ${login}` : ""}已切换到当前平台账号`, "success");
  } else if (msg.switched) {
    toast(`已切换到 MT5 账户${login ? ` ${login}` : ""}，正在刷新账户数据`, "success");
  }
  const results = await Promise.allSettled([
    loadStatus(), loadSymbols(), loadAccount(), loadPositions(), loadStrategyCatalog(),
  ]);
  if (generation !== state._accountContextGeneration) return;
  const currentAccount = state.tradingAccounts?.find(account => Number(account.is_active) === 1);
  if (currentAccount && !$('subscriptionEditor')?.classList.contains('hidden')) {
    $('subscriptionAccount').value = String(currentAccount.id);
  }
  // Heavy account data (history, chart, pending orders and risk details) stays
  // demand-driven: refresh only the page the user is currently viewing.
  await refreshTabData(activeTabId()).catch(() => {});
  const rejected = results.find(item => item.status === "rejected");
  if (rejected) console.warn("[AccountSwitch] 部分账户数据刷新失败:", rejected.reason);
}

async function handleAccountTransferred(msg = {}) {
  state._accountContextGeneration = Number(state._accountContextGeneration || 0) + 1;
  clearAccountContextCaches();
  state.autoEnabled = false;
  toast("此 MT5 账户已由另一个平台账号重新连接，当前账号的自动分析和交易发送已关闭", "warning");
  await Promise.allSettled([loadStatus(), loadStrategyCatalog(), refreshTabData(activeTabId())]);
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
    state._reconnectAttempts = 0; // reset backoff on successful connection

    state._hbSeq = 0;
    if (state._hbTimer) clearInterval(state._hbTimer);
    sendHeartbeat();
    state._hbTimer = setInterval(sendHeartbeat, 30000);
    _fireReady();
  };
  ws.onmessage = (e) => {
    try {
      const msg = JSON.parse(e.data);
      if (msg.type === 'platform_market_tick') {
        const quote = msg.quote || {};
        const timezoneOffsetMinutes = terminalQuoteTimezoneOffsetMinutes(quote);
        if (timezoneOffsetMinutes !== null) state.mt5TimezoneOffsetMinutes = timezoneOffsetMinutes;
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
      } else if (msg.type === 'hb') {
        handleHeartbeat(msg);
      } else if (msg.type === 'disconnect') {
        handleDisconnect(msg);
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
            toast('MT5桥接断开，等待连接后自动恢复订阅', 'warning');
          } else {
            toast('MT5桥接断开', 'warning');
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
        loadSignals({ skipResultRender:true }).then(() => {
          if (sameSignalId(state.selectedSignal?.id, msg.signal_id)) {
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
      } else if (msg.type === 'result' && msg.command_id) {
        const pending = _wsPending.get(msg.command_id);
        if (pending) {
          clearTimeout(pending.timer);
          _wsPending.delete(msg.command_id);
          if (msg.status === 'error') pending.reject(new Error(msg.message || 'Command failed'));
          else pending.resolve(msg);
        }
      }
    } catch (e) { console.error('[WS] message handler error:', e) }
  };
  ws.onclose = (e) => {
    if (state._hbTimer) { clearInterval(state._hbTimer); state._hbTimer = null; }
    if (state.bridgeWs === ws) state.bridgeWs = null;
    stopLiveQuoteRefreshTimer();
    for (const [id, p] of _wsPending) { clearTimeout(p.timer); p.reject(new Error('WebSocket断开')); }
    _wsPending.clear();
    _fireReady(); // ensure bootstrap() doesn't hang when WS fails to connect
    // Auth failure (server closed with 4002) -> don't retry
    if (e.code === 4002) { setBadge("gatewayMode", "认证失败，请重新登录", "danger"); return; }
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
    if (b) b.title = '市场状态：MT5 报价暂未更新，系统不会按开市处理';
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
  const timezoneOffsetMinutes = terminalQuoteTimezoneOffsetMinutes(quote);
  if (timezoneOffsetMinutes !== null) state.mt5TimezoneOffsetMinutes = timezoneOffsetMinutes;
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
  const timezoneOffsetMinutes = terminalQuoteTimezoneOffsetMinutes(quote);
  if (timezoneOffsetMinutes !== null) state.mt5TimezoneOffsetMinutes = timezoneOffsetMinutes;
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
    _historyCache = null;
    _historyChartCache = null;
  }
  _prevPositionCount = currPosCount;

  if (msg.quote) {
    const q = msg.quote;
    const timezoneOffsetMinutes = terminalQuoteTimezoneOffsetMinutes(q);
    if (timezoneOffsetMinutes !== null) state.mt5TimezoneOffsetMinutes = timezoneOffsetMinutes;
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
      state.bridgeAccountIdentity = {
        brokerServerKey: String(msg.account.server).trim().toUpperCase(),
        loginAccount: String(msg.account.login).trim(),
      };
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
        // Also trigger a full refresh to update account/history
        clearTimeout(state._posRefreshTimer);
        state._posRefreshTimer = setTimeout(() => {
          loadPositions();
          loadAccount();
          loadHistory();
          loadHistoryChart();
        }, 500);
      }
    }
    // Update existing rows
    for (const pos of msg.positions) {
      const closeBtn = document.querySelector(`[data-close-ticket="${pos.ticket}"]`);
      if (closeBtn) {
        const row = closeBtn.closest('tr');
        if (row) {
          row.setAttribute('data-ticket', pos.ticket);
          const cells = row.querySelectorAll('td');
          if (cells[5]) cells[5].textContent = fmt(pos.price_current);
          if (cells[9]) {
            cells[9].textContent = fmt(pos.profit);
            cells[9].className = `num ${profitClass(pos.profit)}`;
          }
        }
      }
      const dashRows = document.querySelectorAll('#dashboardPositionsBody tr');
      for (const row of dashRows) {
        const ticketCell = row.querySelector('td:first-child');
        if (ticketCell && ticketCell.textContent.trim() === String(pos.ticket)) {
          const cells = row.querySelectorAll('td');
          if (cells[5]) cells[5].textContent = fmt(pos.price_current);
          if (cells[7]) {
            cells[7].textContent = fmt(pos.profit);
            cells[7].className = `num ${profitClass(pos.profit)}`;
          }
        }
      }
    }
  }
  _maybeRefreshSignal();
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

  state.latestSignalId = signalId;
  _lastSignalId = signalId;
  await loadSignals({ skipResultRender:true, announceDashboardSignal:true });

  const incoming = state.signals.find(item => sameSignalId(item.id, signalId)) || signalMeta;
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
    startUiTimer();
    startLiveQuoteRefreshTimer();
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
  if (!signal?.detail_loaded) {
    try {
      const data = await wsApi("signal_detail", { signal_id:Number(signalId) });
      if (data.status === "success" && data.signal) signal = { ...(signal || {}), ...data.signal, detail_loaded:true };
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
  syncAiAccess(msg.access);
  if (msg.platform) updateBridgePlatformUI(msg.platform);
  if (msg.observer_channel?.id) syncSelectedObserverChannel(msg.observer_channel.id);
  if (msg.mt5_time) {
    const timezoneOffsetMinutes = terminalQuoteTimezoneOffsetMinutes(msg);
    if (timezoneOffsetMinutes !== null) state.mt5TimezoneOffsetMinutes = timezoneOffsetMinutes;
    const terminalTime = formatTerminalQuoteTime({
      time:msg.mt5_time,
      observed_at_utc_msc:msg.observed_at_utc_msc,
      timezone_offset_minutes:msg.timezone_offset_minutes,
    });
    setText('quoteTime', terminalTime);
    setText('mt5ServerTime', terminalTime === '--' ? '--' : terminalTime.split(' ').pop() || '--');
  }
  const isLive = msg.mt5_connected && msg.mt5_alive;
  const usingFallback = msg.using_fallback;
  const wasLive = state._lastGatewayLive;
  const wasFallback = state._lastUsingFallback;
  state._usingFallback = usingFallback;

  if (usingFallback) {
    if (state.isPlusReadOnly) {
      setBadge("gatewayMode", "观摩模式", "warning");
    } else {
      setBadge("gatewayMode", "观摩模式-请连接您的MT5", "warning");
    }
  } else {
    const platform = bridgePlatformLabel();
    setBadge("gatewayMode", isLive ? `${platform} 已连接` : `${platform} 未连接`, isLive ? "connected" : "neutral");
  }

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

  // Update auto badge from heartbeat data
  if (isObserverMode() && typeof msg.auto_reasoning_enabled === 'boolean') {
    renderObserverSwitchStates({ tradeEnabled: msg.trade_enabled, autoEnabled: msg.auto_reasoning_enabled });
  } else if (!isObserverMode() && typeof msg.auto_reasoning_enabled === 'boolean') {
    state.autoEnabled = msg.auto_reasoning_enabled;
    // Use renderAutoAnalyzeBadge for consistent display
    if (state.autoRuntime) {
      state.autoRuntime.enabled = msg.auto_reasoning_enabled;
      renderAutoAnalyzeBadge(state.autoRuntime);
    } else if (!msg.auto_reasoning_enabled) {
      setBadge("autoAnalyzeMode", "自动分析关闭", "neutral");
    }
  }

  state._lastGatewayLive = isLive;
  state._lastUsingFallback = usingFallback;
  if (isLive) startLiveQuoteRefreshTimer();
  else stopLiveQuoteRefreshTimer();

  // Bridge state changed → update role-based UI
  if (isLive !== wasLive || usingFallback !== wasFallback) {
    applyRoleUI();
    if (isLive) {
      // Clear caches so bridge-dependent data refreshes
      _historyCache = null;
      _historyChartCache = null;
      refreshAll().then(() => {
        refreshTabData(activeTabId()).catch(() => {});
      }).catch(() => {});
    }
    else if (!usingFallback) {
      state.positions = [];
      renderPositionRows();
    }
  }
}

// Handle bridge disconnect notification
function handleDisconnect(msg) {
  setBadge("gatewayMode", `${bridgePlatformLabel()} 未连接`, "neutral");
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
  if (state.user?.role !== "admin" && state.user?.plan === "pro") {
    state._usingFallback = true;
    setBadge("gatewayMode", "观摩模式-请连接您的MT5", "warning");
    syncAiAccess({
      mode:"observer", reason:"bridge_offline", read_only:true, can_download_bridge:true,
      allowed_tabs:["dashboard","model-strategy","ai-analyze","trading","history"],
      data_source:"platform_admin_account",
    });
    _historyCache = null;
    _historyChartCache = null;
    refreshAll().catch(() => {});
  }
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

function modelProviderLabel(provider) { return MODEL_PROVIDER_LABELS[provider] || provider; }

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

function renderModelProfiles() {
  const host = $("modelProfilesList");
  if (!host) return;
  const summary = $("modelCatalogSummary");
  const activeProfiles = state.modelProfiles.filter(profile => profile.status === "active");
  if (summary) summary.textContent = `${state.modelProfiles.length} 个模型 · ${activeProfiles.length} 个可用`;
  setText("modelCountStat", state.modelProfiles.length);
  setText("modelActiveStat", activeProfiles.length);
  if (!state.modelProfiles.length) {
    host.innerHTML = state.user?.role === "admin"
      ? '<div class="workspace-panel empty-state"><strong>还没有平台模型</strong><span>添加平台模型后，可按手动分析、自动分析、复盘和记忆压缩分别开放共享。</span></div>'
      : '<div class="workspace-panel empty-state"><strong>还没有可用模型</strong><span>添加一个自己的模型；若管理员已开放共享，也可由系统按用途自动选用平台模型。</span></div>';
    return;
  }
  host.innerHTML = state.modelProfiles.map(profile => `
    <article class="workspace-row model-profile-card" data-model-id="${Number(profile.id)}">
      <div class="workspace-row-main"><div class="workspace-row-title">${escapeHtml(profile.model_name)} ${profile.is_default ? '<span class="status-chip success">默认模型</span>' : ''}<span class="status-chip ${profile.status === 'active' ? 'info' : 'warning'}">${profile.status === 'active' ? '连接可用' : '已停用'}</span>${profile.provider === 'kimi_code' ? `<span class="status-chip warning">${state.user?.role === 'admin' ? '订阅模型 · 可按用途共享' : '个人订阅'}</span>` : ''}</div><div class="workspace-row-meta model-primary-meta"><span>${escapeHtml(modelProviderLabel(profile.provider))}</span><span>${profile.has_api_key ? '凭据已安全保存' : '需要配置凭据'}</span></div><details class="row-details"><summary>查看技术信息</summary><div class="workspace-row-meta"><span>API：${escapeHtml(profile.api_base_url || '使用服务商默认地址')}</span><span>最大输出 ${Number(profile.max_tokens || 0)} tokens</span><span>思考模式 ${Number(profile.thinking_enabled) ? '开启' : '关闭'}</span><span>Temperature ${escapeHtml(profile.temperature ?? '--')}</span>${profile.request_timeout_ms ? `<span>超时 ${Math.round(profile.request_timeout_ms / 1000)}s</span>` : ''}</div></details></div>
      <div class="workspace-row-actions"><button class="btn btn-secondary btn-sm" data-model-action="test">测试连接</button><button class="btn btn-secondary btn-sm" data-model-action="default" ${profile.is_default ? 'disabled' : ''}>设为默认</button><button class="btn btn-secondary btn-sm" data-model-action="edit">编辑</button><button class="btn btn-danger-ghost btn-sm" data-model-action="delete" aria-label="删除 ${escapeHtml(profile.model_name)}"><i data-lucide="trash-2" size="14"></i></button></div>
    </article>`).join("");
  initIcons();
}

async function loadModelManagement() {
  const host = $("modelProfilesList");
  if (host) host.innerHTML = '<div class="workspace-skeleton"></div><div class="workspace-skeleton"></div>';
  setText("modelEffectiveSource", "正在选择…");
  const notice = $("modelSourceNotice");
  if (notice) notice.innerHTML = '<span><strong>模型来源：</strong>正在向服务端确认当前可用配置…</span>';
  const usage = state.user?.role === "admin" ? "auto_platform" : "manual";
  const [profilesResult, sourceResult] = await Promise.allSettled([
    api(`/api/ai/model-profiles${profileScopeQuery()}`),
    api(`/api/ai/model-source?usage=${usage}`),
  ]);
  if (profilesResult.status === "fulfilled") {
    state.modelProfiles = profilesResult.value.profiles || [];
    renderModelProfiles();
  } else {
    state.modelProfiles = [];
    setText("modelCountStat", "--");
    setText("modelActiveStat", "--");
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
  $("modelEditorTitle").textContent = profile ? "编辑模型" : "添加模型";
  $("profileProvider").value = profile?.provider || "deepseek";
  $("profileModelName").value = profile?.model_name || "deepseek-chat";
  $("profileBaseUrl").value = profile?.api_base_url || PROVIDER_PRESETS[profile?.provider || "deepseek"]?.url || "";
  $("profileApiKey").value = "";
  $("profileTemperature").value = profile?.temperature ?? 0.3;
  $("profileMaxTokens").value = profile?.max_tokens ?? 2000;
  $("profileRequestTimeout").value = profile?.request_timeout_ms ? Math.round(profile.request_timeout_ms / 1000) : "";
  $("profileThinkingEnabled").checked = profile ? Boolean(Number(profile.thinking_enabled)) : true;
  updateModelProviderHelp(profile?.provider || "deepseek");
  openFormModal(editor);
}

async function saveModelProfile() {
  const editor = $("modelProfileEditor");
  const id = Number(editor?.dataset.modelId || 0);
  const body = { provider: $("profileProvider").value, model_name: $("profileModelName").value.trim(), api_base_url: $("profileBaseUrl").value.trim(), temperature: Number($("profileTemperature").value), max_tokens: Number($("profileMaxTokens").value), thinking_enabled: $("profileThinkingEnabled").checked };
  const timeoutSec = Number($("profileRequestTimeout").value);
  if (timeoutSec > 0) body.request_timeout_ms = timeoutSec * 1000;
  if (body.provider === "kimi_code" && body.model_name === "k3" && body.thinking_enabled) body.reasoning_effort = "max";
  const key = $("profileApiKey").value.trim();
  if (key) body.api_key = key;
  if (state.user?.role === "admin") body.scope = "platform";
  await api(id ? `/api/ai/model-profiles/${id}` : "/api/ai/model-profiles", { method: id ? "PUT" : "POST", body });
  $("profileApiKey").value = "";
  closeFormModal(editor, false);
  toast("模型已保存", "success");
  await loadModelManagement();
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
    const chanText = Number(item.use_chan_analysis) ? "缠论已启用" : "常规行情指标";
    const portfolioText = item.scope === "private"
      ? (Number(item.include_portfolio_context) ? "已提供持仓与挂单" : "不提供持仓与挂单")
      : "平台行情专用";
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
    return `<article class="strategy-card ${item.scope === 'private' ? 'is-private' : 'is-platform'}" data-strategy-id="${Number(item.id)}"><header class="strategy-card-header"><div><div class="workspace-row-title">${escapeHtml(item.title)} <span class="status-chip ${item.scope === 'private' ? 'info' : ''}">${item.scope === 'private' ? '我的策略' : '平台策略'}</span><span class="status-chip ${item.visibility_status === 'active' ? 'success' : 'warning'}">${escapeHtml(visibilityLabel)}</span></div><p class="strategy-card-description">${escapeHtml(description)}</p></div><div class="strategy-card-actions">${canSubscribe ? subscriptionButton : '<span class="status-chip">仅审计可见</span>'}${canEdit ? '<button class="btn btn-secondary btn-sm" data-strategy-action="edit"><i data-lucide="pencil" size="14"></i>编辑</button><button class="btn btn-danger-ghost btn-sm" data-strategy-action="delete" aria-label="删除策略"><i data-lucide="trash-2" size="14"></i></button>' : ''}</div></header><div class="strategy-essentials"><span><small>支持品种</small><strong>${symbols.slice(0,4).map(escapeHtml).join('、') || '未设置'}${symbols.length > 4 ? ` 等 ${symbols.length} 个` : ''}</strong></span><span><small>主要行情</small><strong>${escapeHtml(plan.primary_timeframe || plan.timeframes?.[0]?.timeframe || 'M30')} · ${Number(plan.timeframes?.find(row => row.timeframe === plan.primary_timeframe)?.kline_count || plan.timeframes?.[0]?.kline_count || 100)} 根</strong></span><span><small>模型</small><strong>${escapeHtml(source)}</strong></span><span class="${linked.some(sub => Number(sub.execution_enabled)) ? 'running' : ''}"><small>自动运行</small><strong>${escapeHtml(execution)}</strong></span></div><details class="strategy-details"><summary><span>查看策略详情与订阅</span><i data-lucide="chevron-down" size="15"></i></summary><div class="strategy-details-body"><div class="strategy-specs"><span><small>完整行情计划</small><strong>${escapeHtml(planText)}</strong></span><span><small>技术分析</small><strong>${escapeHtml(chanText)}</strong></span><span><small>允许入场</small><strong>${escapeHtml(entryText)}</strong></span><span><small>账户上下文</small><strong>${escapeHtml(portfolioText)}</strong></span><span><small>记忆方式</small><strong>${escapeHtml(memoryMode)}</strong></span></div>${subscriptionsBlock}</div></details></article>`;
  }).join("") : '<div class="empty-state"><strong>当前筛选下没有策略</strong><span>切换筛选条件，或新建一套自己的交易策略。</span></div>';
  populateManualStrategySelector();
  initIcons();
}

function strategyMarketPlan(strategy) {
  const fallback = { primary_timeframe:"M30", timeframes:[{ timeframe:"M30", kline_count:100 }] };
  const plan = parseJsonField(strategy?.market_data_plan_json, fallback);
  return Array.isArray(plan?.timeframes) && plan.timeframes.length ? plan : fallback;
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
  summary.innerHTML = `<div><span>行情计划</span><strong>${plan.timeframes.map(item => `${escapeHtml(item.timeframe)} × ${Number(item.kline_count)}`).join(" · ")}</strong></div><div><span>缠论指标</span><strong>${Number(strategy.use_chan_analysis) ? "已启用" : "未启用"}</strong></div><div><span>允许入场</span><strong>${methods.map(item => methodLabels[item] || item).map(escapeHtml).join("、")}</strong></div><div><span>模型</span><strong>${strategy.model_profile_id ? `绑定模型 #${Number(strategy.model_profile_id)}` : "按模型管理规则解析"}</strong></div>`;
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
  const editor = $("strategyEditor"); editor.dataset.strategyId = strategy?.id || "";
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
  $("strategyUseChanAnalysis").checked = Boolean(Number(strategy?.use_chan_analysis || 0));
  $("strategyIncludePortfolioContext").checked = !platformManager && Boolean(Number(strategy?.include_portfolio_context || 0));
  $("strategyPortfolioContextField")?.classList.toggle("hidden", platformManager);
  if (platformManager) {
    $("strategyScope").value = "platform";
    $("strategyScopeField")?.classList.add("is-readonly");
    $("strategyVisibility").value = strategy?.visibility_status || "active";
    $("strategyVisibilityField").style.display = "";
  }
  renderStrategyModelOptions(strategy?.scope || (platformManager ? "platform" : "private"), strategy?.model_profile_id || "");
  openFormModal(editor);
}

async function saveStrategyEditor() {
  const id = Number($("strategyEditor").dataset.strategyId || 0);
  const timeframes = [...document.querySelectorAll("[data-strategy-timeframe]:checked")].map(input => ({ timeframe:input.dataset.strategyTimeframe, kline_count:Number(document.querySelector(`[data-strategy-kline="${input.dataset.strategyTimeframe}"]`)?.value) || 100 }));
  if (!timeframes.length) throw new Error("请至少启用一个行情周期");
  const primary = document.querySelector('input[name="strategyPrimaryTimeframe"]:checked')?.value;
  const primaryTimeframe = timeframes.some(item => item.timeframe === primary) ? primary : timeframes[0].timeframe;
  const entryMethods = [...document.querySelectorAll("[data-strategy-entry-method]:checked")].map(input => input.dataset.strategyEntryMethod);
  if (!entryMethods.length) throw new Error("请至少允许一种入场方式");
  const scope = canManagePlatformAiContent() ? "platform" : "private";
  const visibilityStatus = canManagePlatformAiContent() ? $("strategyVisibility").value : "active";
  const body = { title:$("strategyTitle").value.trim(), symbols:$("strategySymbols").value.split(",").map(value => value.trim()).filter(Boolean),
    description:$("strategyDescription").value.trim(), system_prompt:$("strategyPrompt").value.trim(), interval_minutes:Number($("strategyInterval").value) || 5,
    market_data_plan:{ primary_timeframe:primaryTimeframe, timeframes }, entry_methods:entryMethods,
    use_chan_analysis:$("strategyUseChanAnalysis").checked,
    include_portfolio_context:scope === "private" && $("strategyIncludePortfolioContext").checked,
    is_active:visibilityStatus === "active",
    model_profile_id:$("strategyModelProfile").value ? Number($("strategyModelProfile").value) : null,
    scope,
    visibility_status:visibilityStatus };
  await api(id ? `/api/ai/strategies/${id}` : "/api/ai/strategies", { method:id ? "PUT" : "POST", body });
  closeFormModal($("strategyEditor"), false); toast("策略已保存", "success"); await loadStrategyCatalog();
}

function mt5ScheduleTimezone(offsetMinutes = state.mt5TimezoneOffsetMinutes) {
  const offsetHours = Number(offsetMinutes) / 60;
  if (!Number.isInteger(offsetHours) || offsetHours < -14 || offsetHours > 12) return "Etc/GMT-3";
  if (offsetHours === 0) return "UTC";
  return `Etc/GMT${offsetHours > 0 ? "-" : "+"}${Math.abs(offsetHours)}`;
}

function syncMt5ScheduleTimezoneOption() {
  const select = $("subscriptionScheduleTimezone");
  if (!select) return "Etc/GMT-3";
  const timezone = mt5ScheduleTimezone();
  const offset = Number.isFinite(Number(state.mt5TimezoneOffsetMinutes)) ? Number(state.mt5TimezoneOffsetMinutes) : 180;
  const offsetLabel = `UTC${offset >= 0 ? "+" : ""}${offset / 60}`;
  const option = [...select.options].find(item => item.dataset.mt5Dynamic === "1") || select.options[0];
  option.dataset.mt5Dynamic = "1";
  option.value = timezone;
  option.textContent = `MT5 服务器时间（${offsetLabel}）`;
  return timezone;
}

function openSubscriptionEditor(strategy, subscription = null) {
  if (isObserverMode()) { toast(observerMessage(), "warning"); return; }
  if (!state.tradingAccounts?.length) { toast("请先连接交易桥并完成账户登记", "warning"); return; }
  const editor = $("subscriptionEditor"); editor.dataset.strategyId = strategy.id; editor.dataset.subscriptionId = subscription?.id || "";
  const currentAccount = state.tradingAccounts.find(account => Number(account.is_active) === 1)
    || state.tradingAccounts.find(account => account.observe_status === "active")
    || state.tradingAccounts[0];
  $("subscriptionAccount").innerHTML = `<option value="${Number(currentAccount.id)}">${escapeHtml(currentAccount.nickname || currentAccount.login_account)} · ${escapeHtml(currentAccount.broker_server)}</option>`;
  $("subscriptionAccount").value = String(currentAccount.id);
  populateSubscriptionSymbolOptions(strategy, subscription);
  $("subscriptionSymbolsDropdown").open = false;
  const isPrivate = strategy.scope === "private";
  $("subscriptionMemoryModeField")?.classList.toggle("hidden", !isPrivate);
  $("platformMemoryNotice")?.classList.toggle("hidden", isPrivate);
  $("subscriptionMemoryMode").value = isPrivate ? (subscription?.memory_mode || "personal") : "personal";
  $("subscriptionExecutionEnabled").checked = Number(subscription?.execution_enabled) === 1;
  $("subscriptionTakeProfitMode").value = subscription?.take_profit_mode || "ai_recommended";
  $("subscriptionScheduleEnabled").checked = Boolean(Number(subscription?.schedule_enabled || 0));
  const defaultScheduleTimezone = syncMt5ScheduleTimezoneOption();
  $("subscriptionScheduleTimezone").value = subscription?.schedule_timezone || defaultScheduleTimezone;
  $("subscriptionOutsideWindowBehavior").value = subscription?.outside_window_behavior || "pause_all";
  const weekdays = new Set(parseJsonField(subscription?.schedule_weekdays_json, [1,2,3,4,5]).map(Number));
  document.querySelectorAll("[data-schedule-weekday]").forEach(input => { input.checked = weekdays.has(Number(input.dataset.scheduleWeekday)); });
  renderSubscriptionScheduleWindows(parseJsonField(subscription?.schedule_windows_json, [{ start:"00:00", end:"23:59" }]));
  syncSubscriptionScheduleVisibility();
  openFormModal(editor);
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
  const executionEnabled = $("subscriptionExecutionEnabled").checked;
  const otherActive = (state.strategySubscriptions || []).find(item => Number(item.execution_enabled) && Number(item.id) !== id);
  let replaceActive = false;
  if (executionEnabled && otherActive) {
    replaceActive = confirm(`当前已有“${otherActive.strategy_title || `订阅 #${otherActive.id}`}”在自动分析。是否关闭原订阅并切换到当前策略？`);
    if (!replaceActive) return;
  }
  const strategy = (state.strategies || []).find(item => Number(item.id) === Number(editor.dataset.strategyId));
  const body = { trading_account_id:Number($("subscriptionAccount").value), strategy_id:Number(editor.dataset.strategyId),
    symbols:selectedSubscriptionSymbols(), memory_mode:strategy?.scope === "platform" ? "platform_only" : $("subscriptionMemoryMode").value,
    execution_enabled:executionEnabled, replace_active:replaceActive,
    take_profit_mode:$("subscriptionTakeProfitMode").value,
    schedule_enabled:$("subscriptionScheduleEnabled").checked,
    schedule_timezone:$("subscriptionScheduleTimezone").value,
    schedule_weekdays:[...document.querySelectorAll("[data-schedule-weekday]:checked")].map(input => Number(input.dataset.scheduleWeekday)),
    schedule_windows:selectedSubscriptionScheduleWindows(),
    outside_window_behavior:$("subscriptionOutsideWindowBehavior").value };
  await api(id ? `/api/ai/subscriptions/${id}` : "/api/ai/subscriptions", { method:id ? "PUT" : "POST", body });
  closeFormModal(editor, false); toast("订阅已保存", "success"); await loadStrategyCatalog(); await loadStatus();
}

const RISK_LABELS = {
  allowed_symbols:"允许交易品种", require_stop_loss:"强制止损",
  pending_valid_minutes:"挂单有效期",
  max_position_size:"账户单笔最大手数", max_risk_per_trade_pct:"单笔最大风险",
  signal_ttl_seconds:"信号有效期", max_quote_age_seconds:"报价最大年龄", max_spread_points:"最大点差", max_execution_price_deviation_pct:"最大执行价格偏差", weekend_close_minutes:"MT5周末收盘提前量",
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
  "R1_INSTRUMENT_DATA_INCOMPLETE":"品种交易参数不完整", "R1_SYMBOL_TRADE_DISABLED":"品种当前禁止交易",
  "R1.1_SYMBOL_NOT_ALLOWED":"品种不在允许范围", "R1.2_STOP_LOSS_REQUIRED":"缺少止损",
  "R1.3_SL_WIDEN_VOLUME_DOWN":"扩大止损并同步降低手数", "R1.4_STOP_LOSS_TOO_FAR":"止损距离超过上限",
  "R1.5_TAKE_PROFIT_REQUIRED":"缺少止盈", "R1.5_RR_TOO_LOW":"盈亏比低于最低要求",
  "R1.5_TP_TIER_UPGRADED":"改用满足盈亏比要求的更远止盈档位", "R1.6_SL_TP_DIRECTION":"止损或止盈方向错误",
  "R1.7_PENDING_DEVIATION":"挂单价格偏离当前报价过大", "R1.7_PENDING_DIRECTION":"挂单触发价方向与当前价格关系错误",
  "R1.7_PENDING_PRICE_ABNORMAL":"挂单触发价明显异常",
  "R1.7_STOP_LIMIT_RELATION":"Stop Limit 触发价与触发后限价关系错误",
  "R1.8_PENDING_TTL_DEFAULT":"使用默认挂单有效期", "R1.9_AI_VOLUME_OUT_OF_RANGE":"订单执行上限不符合 MT5 手数规则",
  "R1.9_BELOW_MINIMUM_AFTER_RISK":"风险调整后手数低于最小可交易手数", "R1.9_VOLUME_INCREASE_FORBIDDEN":"风控禁止超过账户单笔手数上限",
  "R1.9_VOLUME_INVALID":"订单手数无效", "R1.10_RISK_DATA_INVALID":"账户或品种风险数据无效",
  "R1.10_REAL_RISK":"单笔实际风险校验通过", "R4_QUOTE_INVALID":"当前报价无效",
  "R4.2_WEEKEND_PROTECTION":"周末保护时段禁止开仓", "R4.3_SIGNAL_EXPIRED":"推理信号已过期",
  "R4.4_QUOTE_STALE":"MT5 报价已过期或时间异常", "R4.5_SPREAD_TOO_WIDE":"当前点差超过上限",
  "R4.6_MARKET_SIGNAL_DRIFT":"市价偏离推理参考价过大", "R4.6_EXECUTION_PRICE_DEVIATION":"当前价格超出允许执行区间", "R2.1_DIRECTIONAL_EXPOSURE":"同方向持仓敞口超过上限",
  "R2.2_MIN_OPEN_INTERVAL":"距离上次开仓时间过短", "R2.3_DAILY_OPEN_COUNT":"当日开仓次数达到上限",
  "R2.4_PRICE_TIME_DUPLICATE":"检测到重复价格和时间窗口订单", "R3.1_DAILY_LOSS_LIMIT":"达到每日亏损上限",
  "R3.2_CONSECUTIVE_LOSS_COOLDOWN":"连续亏损触发冷却", "R3.2_LOSS_COOLDOWN":"账户仍处于亏损冷却期",
  "R3.3_MAX_DRAWDOWN":"达到最大回撤上限", "R3.4_MARGIN_LEVEL":"保证金水平低于要求",
  "R3.4_MARGIN_DATA_INCOMPLETE":"MT5 无法计算预计保证金", "R3.4_PROJECTED_MARGIN_LEVEL":"下单后的预计保证金水平低于要求",
  "R3.4_NOTIONAL_DATA_INCOMPLETE":"名义敞口数据不完整", "R3.4_NOTIONAL_EXPOSURE":"名义敞口超过上限",
  "R3_ACCOUNT_HALTED":"账户风控已暂停", "R3_RISK_DATA_INCOMPLETE":"账户风险数据不完整",
  "R6_ACCOUNT_NOT_FOUND":"未找到交易账户",
  "R6_ACCOUNT_PAUSED":"交易账户已暂停", "R6_ACCOUNT_TRANSFERRED":"MT5账户已切换到其他平台账号",
  "R6_ACCOUNT_TRADE_PERMISSION_REQUIRED":"MT5账户没有完整交易权限", "R6_GLOBAL_KILL_SWITCH":"全局紧急停止已开启",
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
  "PX.3_EXECUTION_PRICE_TOLERANCE":"已按百分比换算 MT5 下单偏差",
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
    if (reason.startsWith("unknown_deal_type:")) return `发现尚未识别的 MT5 资金类型（${reason.split(":")[1]}）`;
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
      return `${label}：理论手数 ${displayRiskNumber(details.theoretical_volume, 4)}，按 ${displayRiskNumber(details.step, 3)} 手步进向下取整后为 ${displayRiskNumber(details.volume, 3)} 手；本次风险预算 ${displayRiskNumber(details.risk_cap, 2)}，最小 ${displayRiskNumber(details.minimum, 3)} 手预计止损亏损 ${displayRiskNumber(details.minimum_lot_risk, 2)}（均为账户货币），因此未执行`;
    }
    return `${label}：计算结果 ${displayRiskNumber(details.volume)} 手，最低 ${displayRiskNumber(details.minimum)} 手`;
  }
  if (code === "R4.4_QUOTE_STALE") return `${label}：报价年龄 ${displayRiskNumber(details.quote_age_seconds, 3)} 秒，允许上限 ${displayRiskNumber(details.maximum_seconds)} 秒`;
  if (code === "R1.7_PENDING_DEVIATION") return `${label}：偏离 ${displayRiskNumber(details.deviation)}，允许上限 ${displayRiskNumber(details.maximum)}`;
  if (code === "R4.6_EXECUTION_PRICE_DEVIATION") return `${label}：当前 ${displayRiskNumber(details.current_price)}，允许 ${displayRiskNumber(details.allowed_min)} ～ ${displayRiskNumber(details.allowed_max)}（±${displayRiskNumber(details.maximum_pct, 3)}%）`;
  if (code === "PX.3_EXECUTION_PRICE_TOLERANCE") return `${label}：剩余 ${displayRiskNumber(details.remaining_price, 3)}，发送 ${displayRiskNumber(details.mt5_points, 0)} MT5 点`;
  if (code === "R1.3_SL_WIDEN_VOLUME_DOWN") return `${label}：止损 ${displayRiskNumber(details.from_sl)} → ${displayRiskNumber(details.to_sl)}，手数 ${displayRiskNumber(details.from_volume)} → ${displayRiskNumber(details.to_volume)}`;
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

async function loadReviewMemory() {
  const query = state.reviewPeriodFilter ? `?periodType=${encodeURIComponent(state.reviewPeriodFilter)}` : "";
  const platformManager = canManagePlatformAiContent();
  const [reviewData, memoryData, profileData, featureData] = platformManager
    ? await Promise.all([api(`/api/ai/period-reviews${query}`), api("/api/ai/admin/platform-experience"), Promise.resolve({ profiles:[] }), Promise.resolve({ flags:{ user:{} } })])
    : await Promise.all([api(`/api/ai/period-reviews${query}`), api("/api/ai/memory"), api(`/api/ai/model-profiles${profileScopeQuery()}`), api("/api/ai/feature-flags")]);
  state.reviewCases = reviewData.cases || [];
  state.memoryItems = memoryData.items || [];
  state.memorySummaries = memoryData.summaries || [];
  state.memorySettings = memoryData.settings || {};
  state.platformMemoryPolicies = memoryData.policies || [];
  state.platformMemoryEvaluation = memoryData.evaluation || {};
  await loadReviewSummary({ announce:false });
  $("sharedCredentialNotice")?.classList.toggle("hidden", platformManager || (profileData.profiles || []).some(item => item.is_default && item.has_api_key));
  const userFlags = featureData.flags?.user || {};
  const featureInputs = { userReviewGenerationFlag:"review_generation_enabled", userExperienceMemoryFlag:"experience_memory_enabled", userMemoryCompressionFlag:"memory_compression_enabled", userRetrievalShadowFlag:"retrieval_shadow_enabled" };
  for (const [id,key] of Object.entries(featureInputs)) if ($(id)) {
    $(id).checked = userFlags[key] ?? true;
  }
  renderReviewCases();
  renderCachedMemoryWorkspace();
}

function renderCachedMemoryWorkspace() {
  if (canManagePlatformAiContent()) renderPlatformExperience(state.memoryItems, state.platformMemoryPolicies, state.platformMemoryEvaluation);
  else renderMemoryItems(state.memoryItems, state.memorySettings, state.memorySummaries);
}

async function saveUserFeatureFlags() {
  await api("/api/ai/feature-flags", { method:"PUT", body:{ review_generation_enabled:$("userReviewGenerationFlag").checked,
    experience_memory_enabled:$("userExperienceMemoryFlag").checked, memory_compression_enabled:$("userMemoryCompressionFlag").checked,
    retrieval_shadow_enabled:$("userRetrievalShadowFlag").checked } });
  toast("个人复盘与记忆设置已保存", "success"); await loadReviewMemory();
}

function renderReviewCases() {
  const host = $("reviewCaseList"); if (!host) return;
  const statusClass = status => status === "approved" ? "success" : ["failed", "incomplete", "needs_revision"].includes(status) ? "danger" : "warning";
  const pending = new Set(["evidence_pending", "incomplete", "ready", "generating", "failed"]);
  const items = state.reviewCases.filter(item => !state.reviewFilter || (state.reviewFilter === "pending" ? pending.has(item.status) : item.status === state.reviewFilter));
  host.innerHTML = items.length ? items.map(item => {
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
  }).join("") : '<div class="review-list-empty empty-state"><span class="review-empty-icon"><i data-lucide="inbox" size="20"></i></span><strong>暂无符合条件的周期复盘</strong><span>系统会在交易日或自然月结束后，按策略汇总完整证据并生成复盘。</span></div>';
  initIcons();
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
  const lessonHelp = isAdmin ? "每行一条；确认后先进入平台记忆候选区，发布后才用于绑定策略" : "每行一条，将用于生成个人记忆";
  const approveLabel = isAdmin ? "内容准确并加入平台记忆候选" : "内容准确并加入记忆";
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

function formatReviewEventTime(value, offsetMinutes = 180) {
  if (!value) return "--";
  const utcMs = Date.parse(`${String(value).replace(" ", "T")}+08:00`);
  if (!Number.isFinite(utcMs)) return formatTime(value);
  return new Date(utcMs + Number(offsetMinutes || 0) * 60000).toISOString().slice(5, 19).replace("T", " ");
}

function periodReviewEventLabel(event) {
  const labels = { queued:"已进入生成队列", preparing:"正在准备复盘证据", model_request:"AI 开始分析", validating:"正在校验模型结果",
    repairing:"正在修复输出格式", retry_wait:"本次生成未完成，等待自动重试", succeeded:"复盘生成完成", failed:"复盘生成失败" };
  return labels[event.stage] || reviewStatusLabel(event.stage);
}

function periodReviewProgressHtml(review) {
  if (!review?.job_id && !review?.job_status) return "";
  const stage = periodReviewEffectiveStatus(review);
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
    <div class="period-review-live-line ${stage === 'failed' ? 'danger' : ''}"><span class="period-review-live-dot"></span><strong>${escapeHtml(detail)}</strong>${review.stage_updated_at ? `<small>更新于 ${escapeHtml(formatReviewEventTime(review.stage_updated_at, review.timezone_offset_minutes))} MT5</small>` : ''}</div>
    ${review.last_error_code && ["retry_wait", "failed"].includes(stage) ? `<div class="period-review-inline-error"><i data-lucide="circle-alert" size="15"></i><span>${escapeHtml(periodReviewFailureText(review.last_error_code))}</span></div>` : ""}
    ${events.length ? `<details class="period-review-log"><summary>生成记录 <span>${events.length}</span></summary><ol>${events.map(event => `<li class="${escapeHtml(event.event_status || 'info')}"><time>${escapeHtml(formatReviewEventTime(event.created_at, review.timezone_offset_minutes))}</time><span>${escapeHtml(periodReviewEventLabel(event))}${event.message_code ? `<small>${escapeHtml(periodReviewFailureText(event.message_code))}</small>` : ''}</span></li>`).join("")}</ol></details>` : ""}
  </section>`;
}

function schedulePeriodReviewDetailPoll(review) {
  stopReviewDetailPolling();
  const generatingReview = review && ["queued", "leased"].includes(review.job_status) && !Number(review.current_version_id || 0);
  const derivingMemory = review && ["queued", "leased"].includes(review.derivation_status);
  if (!generatingReview && !derivingMemory) return;
  const caseId = Number(review.id), timezoneOffset = Number(review.timezone_offset_minutes || 180);
  state.reviewDetailJobKey = `${review.job_status}:${review.progress_stage}:${review.attempt_count}:${review.next_attempt_at || ''}`;
  state.reviewDetailPollTimer = setTimeout(async () => {
    if (Number(state.selectedReviewId) !== caseId || activeTabId() !== "review-memory") return;
    try {
      const data = await api(`/api/ai/period-reviews/${caseId}/job-status`), job = { ...(data.job || {}), timezone_offset_minutes:timezoneOffset };
      const nextKey = `${job.job_status}:${job.progress_stage}:${job.attempt_count}:${job.next_attempt_at || ''}:${job.current_version_id || ''}`;
      if ((generatingReview && (job.current_version_id || ["failed", "succeeded"].includes(job.job_status)))
        || (derivingMemory && !["queued", "leased"].includes(job.derivation_status))) {
        await loadReviewMemory();
        await openPeriodReviewDetail(caseId, { silent:true });
        if (generatingReview && job.current_version_id) toast(`${job.period_type === 'monthly' ? '月' : '日'}复盘已生成，等待确认`, "success");
        if (derivingMemory && job.derivation_status === "succeeded") toast("复盘经验已沉淀完成", "success");
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

async function openPeriodReviewDetail(id, { silent = false } = {}) {
  stopReviewDetailPolling();
  state.selectedReviewId = Number(id); renderReviewCases();
  const reviewLayout = document.querySelector(".period-review-layout");
  reviewLayout?.classList.add("has-mobile-detail");
  const detail = $("reviewDetail");
  if (!silent) detail.innerHTML = '<div class="workspace-skeleton"></div>';
  let data;
  try {
    data = await api(`/api/ai/period-reviews/${id}`);
  } catch (error) {
    reviewLayout?.classList.remove("has-mobile-detail");
    throw error;
  }
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
    ? `MT5 时间 ${review.period_key || '--'} 全月 · 月末结算后生成`
    : `MT5 时间 ${review.period_key || '--'} 00:00–24:00 · 已结束周期`;
  const nextPeriodHint = isMonthly ? "本月结束后的交易将进入下月复盘" : "本周期结束后的平仓将进入下一份日复盘";
  const strategyProvenance = reviewStrategyProvenance(review);
  const derivationLabels = { queued:"经验等待处理", leased:"正在沉淀经验", paused:"经验处理已暂停", failed:"经验处理失败", succeeded:"经验已沉淀" };
  const derivationStatus = review.derivation_status || "";
  const derivationClass = derivationStatus === "succeeded" ? "complete" : derivationStatus === "failed" ? "warning" : "";
  const derivationDetail = derivationStatus === "paused"
    ? "相关记忆功能当前已关闭，重新启用后会自动继续"
    : derivationStatus === "failed" ? periodReviewFailureText(review.derivation_error_code)
      : derivationStatus === "succeeded" ? (state.user?.role === "admin" ? "已生成平台记忆候选" : "已写入个人记忆体系")
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
    ${review.status === 'approved' && derivationStatus ? `<div class="period-review-source ${derivationClass}"><i data-lucide="${derivationStatus === 'succeeded' ? 'brain-circuit' : derivationStatus === 'failed' ? 'circle-alert' : 'loader-circle'}" size="16"></i><div><strong>${escapeHtml(derivationLabels[derivationStatus] || derivationStatus)}</strong><span>${escapeHtml(derivationDetail)}</span></div>${derivationStatus === 'failed' ? '<button class="btn btn-secondary btn-sm" data-review-action="retry-derivation">重试经验处理</button>' : ''}</div>` : ''}
    ${current ? `<section class="period-review-editor">
      <div class="period-review-section-heading"><div><span class="review-section-kicker">核心结论</span><h3>${isMonthly ? '本月策略表现' : '当日策略表现'}</h3></div><span>第 ${Number(current.version_no || 1)} 次修订</span></div>
      <label class="review-field"><span>复盘摘要</span><textarea data-period-review-field="period_summary" rows="4" ${editable ? '' : 'disabled'}>${escapeHtml(userVisibleText(content.period_summary, "暂无复盘摘要"))}</textarea></label>
      <div class="period-review-decision-row"><label class="review-field"><span>决策质量</span><select data-period-review-field="decision_quality" ${editable ? '' : 'disabled'}>${Object.entries(periodDecisionLabels).map(([value,label]) => `<option value="${value}" ${content.decision_quality === value ? 'selected' : ''}>${label}</option>`).join('')}</select></label><label class="review-field"><span>结论置信度</span><div class="confidence-input"><input data-period-review-field="confidence" type="number" min="0" max="1" step="0.05" value="${escapeHtml(content.confidence ?? 0.5)}" ${editable ? '' : 'disabled'}><small>0 到 1</small></div></label></div>
      <div class="period-review-edit-grid">${editableGroups.map(([key,label]) => `<label class="review-field"><span>${label}</span><textarea data-period-review-field="${key}" data-field-type="lines" rows="4" ${editable ? '' : 'disabled'}>${escapeHtml(periodReviewLines(content[key]))}</textarea><small>每行一条，保持简短且可执行</small></label>`).join('')}</div>
      <textarea id="reviewContentEditor" hidden>${escapeHtml(JSON.stringify(content))}</textarea>
    </section>` : `<div class="review-empty-state empty-state"><span class="review-empty-icon"><i data-lucide="${review.status === 'failed' ? 'circle-alert' : 'loader-circle'}" size="20"></i></span><strong>${review.status === 'failed' ? '复盘生成失败' : '复盘正在准备'}</strong><span>${escapeHtml(review.status === 'failed' ? periodReviewFailureText(review.last_error_code) : periodReviewEvidenceReasonText(review.evidence_reason))}</span></div>`}
    ${current ? `<section class="period-review-evidence-grid">
      ${periodReviewListBlock(isMonthly ? '跨日模式' : '逐笔判断', assessments.map(item => `${isMonthly ? item.period_case_id : item.outcome_id} · ${periodDecisionLabels[item.decision_quality] || item.decision_quality}：${item.summary || ''}`), isMonthly ? 'calendar-range' : 'receipt-text')}
      ${isMonthly ? periodReviewListBlock('长期记忆候选', (content.memory_candidates || []).map(item => item.lesson), 'brain-circuit') : periodReviewListBlock('缠论结构诊断', diagnostics.map(item => `${chanIssueLabels[item.issue_source] || item.issue_source}：${item.explanation || '无补充说明'}`), 'git-branch')}
    </section>
    <details class="quiet-disclosure review-evidence-disclosure"><summary><span><i data-lucide="database" size="15"></i><strong>证据来源与系统字段</strong><small>基础统计只读，避免修改后与真实成交数据不一致</small></span><i data-lucide="chevron-down" size="15"></i></summary><div class="quiet-disclosure-body"><div class="review-evidence"><div><span>账户 / 策略</span><strong>#${Number(review.trading_account_id || 0)} / #${Number(review.strategy_id || 0)}</strong></div><div><span>统计时区</span><strong>UTC${Number(review.timezone_offset_minutes || 0) >= 0 ? '+' : ''}${fmt(Number(review.timezone_offset_minutes || 0) / 60, 1)}</strong></div><div><span>来源策略配置</span><strong>${escapeHtml(reviewStrategyVersions(review).length ? reviewStrategyVersions(review).map(value => `v${value}`).join('、') : '已记录')}</strong></div><div><span>来源数量</span><strong>${Number(review.source_count || 0)}</strong></div><div><span>生成时间</span><strong>${escapeHtml(current.created_at || '--')}</strong></div></div></div></details>
    <footer class="review-actions"><div class="review-action-context"><i data-lucide="shield-check" size="17"></i><span><strong>确认后才会进入记忆体系</strong><small>${isMonthly ? '月复盘负责压缩跨日模式并产生长期记忆候选' : '日复盘先形成短期策略记忆，月底再统一压缩'}</small></span></div>${editable ? `<div class="review-action-buttons"><button class="text-action" data-review-action="defer" data-version-id="${current.id}">稍后处理</button><button class="btn btn-secondary" data-review-action="needs_revision" data-version-id="${current.id}">标记有问题</button><button class="btn btn-secondary" data-review-action="save" data-version-id="${current.id}">保存修改</button><button class="btn btn-primary" data-review-action="approve" data-version-id="${current.id}"><i data-lucide="check" size="15"></i>确认并沉淀经验</button></div>` : '<span class="status-chip success">内容已锁定</span>'}</footer>` : ''}`;
  initIcons();
  if (current && Number(review.is_unread)) {
    api(`/api/ai/period-reviews/${id}/read`, { method:"POST", body:{ version_id:current.id } }).then(() => {
      const item = state.reviewCases.find(row => Number(row.id) === Number(id));
      if (item) item.is_unread = 0;
      renderReviewCases();
      loadReviewSummary({ announce:false }).catch(() => {});
    }).catch(() => {});
  }
  schedulePeriodReviewDetailPoll(review);
}

const memoryCategoryLabels = {
  general:"通用原则", market_regime:"行情状态", entry_setup:"入场条件", chan_structure:"缠论结构", risk_execution:"风控执行",
};

const memoryContextFieldLabels = {
  symbols:"品种", timeframes:"周期", directions:"方向", trend_direction:"方向", entry_methods:"入场方式",
  market_regimes:"行情", volatility_buckets:"波动", chan_reliabilities:"缠论可信度", chan_trend_states:"缠论趋势",
  chan_segment_directions:"线段方向", chan_divergences:"背驰", chan_center_states:"中枢",
};

function memoryContextValues(value) {
  return [...new Set((Array.isArray(value) ? value : value == null || value === "" ? [] : [value]).map(item => String(item).trim()).filter(Boolean))];
}

function memoryContextValueLabel(field, value) {
  const normalized = String(value || "").trim().toLowerCase();
  const labels = {
    buy:"做多", long:"做多", bullish:"偏多", up:"向上", sell:"做空", short:"做空", bearish:"偏空", down:"向下", hold:"观望",
    market:"市价", limit:"限价", stop:"止损挂单", stop_limit:"止损限价",
    trend:"趋势", trending:"趋势", range:"震荡", ranging:"震荡", sideways:"横盘", breakout:"突破", reversal:"反转", mixed:"混合行情",
    low:"低", medium:"中", normal:"正常", high:"高", reliable:"可靠", unreliable:"不可靠", none:"无", confirmed:"已确认", forming:"形成中",
  };
  if (field === "symbols" || field === "timeframes") return String(value).toUpperCase();
  return labels[normalized] || userVisibleText(value, "未说明");
}

function memoryApplicabilityView(item = {}) {
  const stored = parseJsonField(item.applicability_json, null);
  const fallback = parseJsonField(item.conditions_json, parseJsonField(item.context_json, {})) || {};
  const source = stored && typeof stored === "object" ? stored : fallback;
  const applicable = source.applicable_when && typeof source.applicable_when === "object" ? source.applicable_when : source;
  const avoid = parseJsonField(item.avoid_when_json, null) || (source.avoid_when && typeof source.avoid_when === "object" ? source.avoid_when : {});
  const aliases = {
    symbols:["symbols","symbol"], timeframes:["timeframes","timeframe"], directions:["directions","direction","trend_direction"],
    entry_methods:["entry_methods","entry_method","allowed_entry_methods"], market_regimes:["market_regimes","market_regime"],
    volatility_buckets:["volatility_buckets","volatility_bucket"], chan_reliabilities:["chan_reliabilities","chan_reliability"],
    chan_trend_states:["chan_trend_states","chan_trend_state"], chan_segment_directions:["chan_segment_directions","chan_segment_direction"],
    chan_divergences:["chan_divergences","chan_divergence"], chan_center_states:["chan_center_states","chan_center_state"],
  };
  const entries = (record) => Object.entries(aliases).flatMap(([field, keys]) => {
    const value = keys.map(key => record?.[key]).find(candidate => candidate != null);
    const values = memoryContextValues(value);
    return values.length ? [{ field, label:memoryContextFieldLabels[field], values:values.map(itemValue => memoryContextValueLabel(field, itemValue)) }] : [];
  });
  return { universal:Boolean(applicable?.universal), applicable:entries(applicable), avoid:entries(avoid) };
}

function memoryContextHtml(item = {}) {
  const category = memoryCategoryLabels[String(item.memory_category || "general").toLowerCase()] || "通用原则";
  const context = memoryApplicabilityView(item);
  const applicable = context.universal && !context.applicable.length
    ? '<span class="memory-context-chip universal">适用于该策略的通用原则</span>'
    : context.applicable.map(entry => `<span class="memory-context-chip"><strong>${escapeHtml(entry.label)}</strong>${escapeHtml(entry.values.join('、'))}</span>`).join("");
  const avoid = context.avoid.map(entry => `<span class="memory-context-chip avoid"><strong>避开${escapeHtml(entry.label)}</strong>${escapeHtml(entry.values.join('、'))}</span>`).join("");
  return `<div class="memory-context"><div class="memory-context-heading"><span class="memory-category-chip">${escapeHtml(category)}</span><span>${context.universal ? '通用规则' : '按当前分析环境精确匹配'}</span></div><div class="memory-context-chips">${applicable || '<span class="memory-context-chip pending">适用条件待补充</span>'}${avoid}</div></div>`;
}

function memoryTierTabsHtml({ includeSummary = false, shortCount = 0, summaryCount = 0, longCount = 0 } = {}) {
  const tab = (value, label, count) => `<button type="button" role="tab" aria-selected="${state.memoryTierFilter === value}" class="${state.memoryTierFilter === value ? 'active' : ''}" data-memory-tier="${value}">${label}${count == null ? '' : ` ${Number(count)}`}</button>`;
  return `<div class="memory-tier-tabs" role="tablist" aria-label="记忆层级筛选">${tab('all', '全部', null)}${tab('short', '短期记忆', shortCount)}${includeSummary ? tab('summary', '月度摘要', summaryCount) : ''}${tab('long', '长期记忆', longCount)}</div>`;
}

function renderMemoryItems(items, settings, summaries = []) {
  const memoryEnabled = settings.enabled !== false;
  if ($("memoryEnabled")) $("memoryEnabled").checked = memoryEnabled;
  const shortItems = items.filter(item => item.memory_tier !== "long");
  const longItems = items.filter(item => item.memory_tier === "long");
  const activeShort = shortItems.filter(item => item.status === "active").length;
  const activeLong = longItems.filter(item => item.status === "active").length;
  const activeSummaries = summaries.filter(item => item.status === "active").length;
  const longCandidates = longItems.filter(item => item.status === "candidate").length;
  setText("memoryActiveStat", activeShort + activeLong + activeSummaries);
  const host = $("memoryItemsList"); if (!host) return;
  const statusLabels = { active:"正在使用", candidate:"待确认长期使用", duplicate_candidate:"待确认重复经验", revoked:"已撤销", stale:"待更新", expired:"已到期", revalidation:"待重新验证", archival:"已归档" };
  const visibleItems = (state.memoryTierFilter === "all" ? items : items.filter(item => item.memory_tier === state.memoryTierFilter));
  const archivedItems = visibleItems.filter(item => ["revoked","expired","archival"].includes(item.status));
  const currentItems = visibleItems.filter(item => !["revoked","expired","archival"].includes(item.status));
  const cards = currentItems.map(item => {
    const isLong = item.memory_tier === "long";
    const statusClass = item.status === "active" ? "success" : "warning";
    const icon = isLong ? "book-marked" : item.status === "active" ? "zap" : "circle-help";
    const content = isLong ? (item.summary_text || item.lesson_text) : item.lesson_text;
    const scope = `策略 #${Number(item.strategy_id || 0)} · ${item.symbol || "通用品种"} · ${item.timeframe || "全周期"}`;
    const lifecycle = isLong
      ? `${Number(item.support_count || 0)} 次复盘支持 · 已匹配 ${Number(item.match_count || 0)} 次`
      : `${item.expires_at ? `有效至 ${item.expires_at}` : "持续有效"} · 已匹配 ${Number(item.match_count || 0)} 次`;
    const actions = isLong
      ? `${item.status === "candidate" ? `<button class="btn btn-primary btn-sm" data-memory-action="confirm-long" data-memory-id="${item.id}"><i data-lucide="check" size="14"></i>确认长期使用</button>` : ""}${!['revoked'].includes(item.status) ? `<button class="btn btn-secondary btn-sm" data-memory-action="revoke-long" data-memory-id="${item.id}">撤销</button>` : ""}`
      : `${item.status === "duplicate_candidate" ? `<button class="btn btn-primary btn-sm" data-memory-action="activate" data-memory-id="${item.id}">确认使用</button>` : ""}${!['revoked','expired'].includes(item.status) ? `<button class="btn btn-secondary btn-sm" data-memory-action="revoke" data-memory-id="${item.id}">撤销</button>` : ""}`;
    return `<article class="personal-memory-card memory-tier-${isLong ? 'long' : 'short'} is-${escapeHtml(item.status)}">
      <header><span class="personal-memory-icon ${statusClass}"><i data-lucide="${icon}" size="17"></i></span><div><strong>${isLong ? "长期记忆" : "短期记忆"} #${Number(item.id)}</strong><span>${escapeHtml(scope)}</span></div><span class="status-chip ${statusClass}">${escapeHtml(statusLabels[item.status] || '状态待确认')}</span></header>
      <div class="personal-memory-lesson"><span>${isLong ? "稳定经验" : "近期复盘经验"}</span><p>${escapeHtml(content || "暂无内容")}</p>${item.candidate_reason ? `<small>${escapeHtml(userVisibleText(item.candidate_reason, "等待进一步验证"))}</small>` : ""}</div>
      ${memoryContextHtml(item)}
      <footer><div class="personal-memory-meta"><span><i data-lucide="clock-3" size="13"></i>${escapeHtml(lifecycle)}</span><span><i data-lucide="braces" size="13"></i>约 ${Number(item.token_count || 0)} 个上下文词元</span><span><i data-lucide="git-branch" size="13"></i>来源配置 v${Number(item.strategy_version || 1)}</span></div><div class="personal-memory-actions">${actions}</div></footer>
    </article>`;
  }).join("");
  const visibleSummaries = (state.memoryTierFilter === "all" || state.memoryTierFilter === "summary") ? summaries : [];
  const archivedSummaries = visibleSummaries.filter(item => ["stale","revoked","archival"].includes(item.status));
  const summaryCards = visibleSummaries.filter(item => !["stale","revoked","archival"].includes(item.status)).map(item => `<article class="personal-memory-card memory-tier-summary is-${escapeHtml(item.status)}">
    <header><span class="personal-memory-icon ${item.status === 'active' ? 'success' : 'warning'}"><i data-lucide="file-stack" size="17"></i></span><div><strong>月度记忆摘要 · ${escapeHtml(item.period_key || `第 ${item.version_no} 次压缩`)}</strong><span>策略 #${Number(item.strategy_id || 0)} · 摘要 #${Number(item.id)}</span></div><span class="status-chip ${item.status === 'active' ? 'success' : 'warning'}">${item.status === 'active' ? '正在使用' : '状态待确认'}</span></header>
    <div class="personal-memory-lesson"><span>分类压缩结论</span><p>${escapeHtml(item.summary_text || '暂无内容')}</p></div>${memoryContextHtml(item)}<footer><div class="personal-memory-meta"><span><i data-lucide="calendar-range" size="13"></i>${escapeHtml(item.period_key || '自动压缩')}</span><span><i data-lucide="braces" size="13"></i>约 ${Number(item.token_count || 0)} 个上下文词元</span></div></footer>
  </article>`).join("");
  const archived = [...archivedItems.map(item => ({ ...item, display_text:item.summary_text || item.lesson_text, display_type:item.memory_tier === 'long' ? '长期记忆' : '短期记忆' })),
    ...archivedSummaries.map(item => ({ ...item, display_text:item.summary_text, display_type:'月度摘要' }))];
  const archiveHtml = archived.length ? `<details class="personal-memory-archive"><summary><span><i data-lucide="archive" size="15"></i><strong>已失效与已撤销记录</strong><small>${archived.length} 条，仅用于追溯</small></span><i data-lucide="chevron-down" size="15"></i></summary><div>${archived.map(item => `<article class="personal-memory-archive-row"><div><strong>${escapeHtml(item.display_type)} #${Number(item.id)}</strong><span>${escapeHtml(statusLabels[item.status] || '已归档')}</span><p>${escapeHtml(item.display_text || '暂无内容')}</p></div></article>`).join('')}</div></details>` : '';
  host.innerHTML = `<section class="personal-memory-section ${memoryEnabled ? "" : "is-disabled"}">
    <header class="personal-memory-header"><div class="personal-memory-title"><span class="personal-memory-main-icon"><i data-lucide="brain-circuit" size="19"></i></span><div><span class="review-section-kicker">分层经验</span><h3>我的策略记忆</h3><p>短期、长期和月度摘要都绑定策略，并按当前品种、周期、方向、行情与缠论结构精确匹配。</p></div></div><div class="personal-memory-stats"><span><strong>${activeLong}</strong> 长期有效</span><span><strong>${activeShort}</strong> 短期有效</span><span><strong>${activeSummaries}</strong> 摘要有效</span><span><strong>${longCandidates}</strong> 待确认</span></div></header>
    <div class="personal-memory-state ${memoryEnabled ? "is-on" : "is-off"}"><i data-lucide="${memoryEnabled ? 'shield-check' : 'shield-off'}" size="15"></i><span><strong>个人记忆${memoryEnabled ? '已启用' : '已关闭'}</strong> · 系统按当前分析环境精确匹配，不会因为策略正常升级而自动失效。</span></div>
    ${memoryTierTabsHtml({ includeSummary:true, shortCount:shortItems.filter(item => !['revoked','expired','archival'].includes(item.status)).length, summaryCount:summaries.filter(item => !['stale','revoked','archival'].includes(item.status)).length, longCount:longItems.filter(item => !['revoked','expired','archival'].includes(item.status)).length })}
    <div class="personal-memory-grid">${summaryCards}${cards}${!summaryCards && !cards ? '<div class="personal-memory-empty empty-state"><span class="review-empty-icon"><i data-lucide="brain" size="20"></i></span><strong>当前层级还没有可用记忆</strong><span>日复盘确认后形成短期记忆，月复盘确认后形成分类摘要与长期候选。</span></div>' : ''}</div>${archiveHtml}
  </section>`;
  initIcons();
}

function renderPlatformExperience(items = [], policies = [], evaluation = {}) {
  const activeItems = items.filter(item => item.status === "active");
  const candidateItems = items.filter(item => item.status === "candidate");
  setText("memoryActiveStat", activeItems.length);

  const policyHost = $("platformExperiencePolicies");
  if (policyHost) {
    const modeLabels = { off:"已关闭", shadow:"影子评估", active:"正式使用" };
    policyHost.innerHTML = `<section class="platform-governance-card">
      <header class="platform-governance-head"><div><span class="review-section-kicker">策略绑定</span><h3>平台记忆运行模式</h3><p>每条记忆只参与对应策略；影子评估只记录匹配，不注入正式推理。</p></div><div class="platform-memory-summary"><span><strong>${policies.filter(item => item.mode === "active").length}</strong> 正式使用</span><span><strong>${policies.filter(item => item.mode === "shadow").length}</strong> 影子评估</span></div></header>
      <div class="platform-policy-list">${policies.length ? policies.map(policy => `<article class="platform-policy-row" data-platform-policy-strategy="${Number(policy.strategy_id)}">
        <div class="platform-policy-name"><strong>${escapeHtml(policy.strategy_title || `策略 #${policy.strategy_id}`)}</strong><small>策略 #${Number(policy.strategy_id)} · 修订 ${Number(policy.policy_version || 1)} · ${escapeHtml(modeLabels[policy.mode] || "状态待确认")}</small></div>
        <label><span>运行模式</span><select data-platform-policy-mode><option value="off" ${policy.mode === "off" ? "selected" : ""}>关闭</option><option value="shadow" ${policy.mode === "shadow" ? "selected" : ""}>影子评估</option><option value="active" ${policy.mode === "active" ? "selected" : ""}>正式使用</option></select></label>
        <label><span>最多命中</span><input data-platform-policy-items type="number" min="1" max="10" value="${Number(policy.max_items || 5)}"></label>
        <label><span>令牌预算</span><input data-platform-policy-budget type="number" min="100" max="1600" step="100" value="${Number(policy.runtime_token_budget || 800)}"></label>
        <button class="btn btn-secondary btn-sm" data-platform-policy-save><i data-lucide="save" size="14"></i>保存</button>
      </article>`).join("") : '<div class="empty-state"><strong>暂无平台策略</strong><span>创建平台策略后，可以在这里配置记忆运行模式。</span></div>'}</div>
    </section>`;
  }

  const evaluationHost = $("platformExperienceEvaluation");
  if (evaluationHost) {
    const retrieval = evaluation.retrieval || {};
    const rate = `${Math.round(Number(retrieval.shadow_hit_rate || 0) * 100)}%`;
    evaluationHost.innerHTML = `<section class="platform-governance-card">
      <header class="platform-governance-head"><div><span class="review-section-kicker">效果评估</span><h3>最近 ${Number(evaluation.window_days || 30)} 天</h3><p>命中率只衡量匹配效果，不代表收益提升。</p></div></header>
      <div class="platform-evaluation-metrics"><div><span>影子检索</span><strong>${Number(retrieval.shadow_total || 0)}</strong></div><div><span>命中次数</span><strong>${Number(retrieval.shadow_hits || 0)}</strong></div><div><span>影子命中率</span><strong>${rate}</strong></div></div>
      <div class="platform-strategy-evaluation">${(evaluation.strategies || []).slice(0, 8).map(row => `<div><span>${escapeHtml(row.strategy_title || `策略 #${row.strategy_id}`)}</span><strong>${Number(row.shadow_hits || 0)} / ${Number(row.shadow_retrievals || 0)}</strong></div>`).join("") || '<div class="empty-inline">尚无可评估的检索记录</div>'}</div>
    </section>`;
  }

  const host = $("memoryItemsList");
  if (!host) return;
  const tierOf = item => item.memory_tier === "long" ? "long" : "short";
  const visible = state.memoryTierFilter === "all" ? items : items.filter(item => tierOf(item) === state.memoryTierFilter);
  const current = visible.filter(item => item.status !== "revoked");
  const archived = visible.filter(item => item.status === "revoked");
  const statusLabels = { candidate:"待发布", active:"已发布", revoked:"已撤销" };
  const card = item => `<article class="platform-memory-card is-${escapeHtml(item.status)}" data-platform-memory-id="${Number(item.id)}">
    <header><div><span class="memory-tier-mark ${tierOf(item)}">${tierOf(item) === "long" ? "长期" : "短期"}</span><strong>${escapeHtml(item.strategy_title || `策略 #${item.strategy_id}`)}</strong></div><span class="status-chip ${item.status === "active" ? "success" : "warning"}">${escapeHtml(statusLabels[item.status] || "状态待确认")}</span></header>
    <p>${escapeHtml(item.lesson_text || "暂无记忆内容")}</p>${memoryContextHtml(item)}
    <footer><span>记忆 #${Number(item.id)} · 来源复盘修订 #${escapeHtml(item.period_review_version_id || item.review_version_id || "--")}${item.platform_version ? ` · 发布批次 ${Number(item.platform_version)}` : ""}</span><div>${item.status === "candidate" ? `<button class="btn btn-primary btn-sm" data-platform-experience-action="publish" data-platform-experience-id="${Number(item.id)}">发布</button>` : ""}${item.status === "active" ? `<button class="btn btn-secondary btn-sm" data-platform-experience-action="revoke" data-platform-experience-id="${Number(item.id)}">撤销</button>` : ""}</div></footer>
  </article>`;
  host.innerHTML = `<section class="platform-memory-library">
    <header class="platform-governance-head"><div><span class="review-section-kicker">审核发布</span><h3>平台记忆库</h3><p>日复盘形成短期记忆，月复盘形成长期记忆；发布后才可被策略读取。</p></div><div class="platform-memory-summary"><span><strong>${candidateItems.length}</strong> 待发布</span><span><strong>${activeItems.length}</strong> 已发布</span></div></header>
    ${memoryTierTabsHtml({ shortCount:items.filter(item => tierOf(item) === "short" && item.status !== "revoked").length, longCount:items.filter(item => tierOf(item) === "long" && item.status !== "revoked").length })}
    <div class="platform-memory-grid">${current.map(card).join("") || '<div class="empty-state"><strong>当前层级暂无平台记忆</strong><span>确认平台策略复盘后，记忆会先进入待发布区。</span></div>'}</div>
    ${archived.length ? `<details class="platform-memory-archive"><summary>已撤销归档 <span>${archived.length} 条</span></summary><div>${archived.map(item => `<article><div><strong>${escapeHtml(item.strategy_title || `策略 #${item.strategy_id}`)} · 记忆 #${Number(item.id)}</strong><p>${escapeHtml(item.lesson_text || "暂无内容")}</p></div><button class="btn btn-danger-ghost btn-sm" data-platform-experience-action="delete" data-platform-experience-id="${Number(item.id)}">永久删除</button></article>`).join("")}</div></details>` : ""}
  </section>`;
  initIcons();
}

let _adminRiskLoadSequence = 0;

function setTab(tabId, options = {}) {
  const legacySignalsTarget = tabId === "signals";
  if (legacySignalsTarget) tabId = "ai-analyze";
  const modelStrategyTarget = tabId === "model-management" ? "models" : tabId === "ai-config" ? "strategies" : null;
  if (modelStrategyTarget) tabId = "model-strategy";
  if (!canAccessTab(tabId)) {
    if (!options.silent) toast("观摩模式下不可访问该页面", "warning");
    tabId = "dashboard";
  }
  closeMobileNav({ restoreFocus:false });
  if (tabId !== "dashboard") stopKlineRefreshTimers();
  if (tabId !== "review-memory") stopReviewDetailPolling();
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
  if (tabId === "ai-analyze") setAnalystView(legacySignalsTarget ? "records" : (options.analystView || "detail"));
  initIcons();
  if (!options.skipRefresh) refreshTabData(tabId).catch((error) => toast(error.message, "error"));
}

function setAnalystView(target) {
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
  if (next === "records" && state.token) loadSignalTable().catch(error => toast(error.message, "error"));
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
  initIcons();
}

async function refreshTabData(tabId) {
  if (!state.token) return;
  if (tabId === "trading") {
    await Promise.allSettled([loadAccount(), loadPositions(), loadStatus(), loadPendingOrders(), refreshQuote(), loadPositionManagement({ quiet:true, preserveSelection:true })]);
  } else if (tabId === "dashboard") {
    await Promise.allSettled([loadAccount(), loadPositions(), loadStatus(), refreshQuote(), loadKlineData()]);
    startKlineRefreshTimer();
  } else if (tabId === "history") {
    updateHistoryRangeUI();
    await Promise.allSettled([loadAccount(), loadHistory(), loadHistoryChart()]);
  } else if (tabId === "audit") {
    await loadAudit();
  } else if (tabId === "model-strategy") {
    await Promise.allSettled([loadStrategyCatalog(), loadModelManagement()]);
  } else if (tabId === "ai-analyze") {
    const tasks = [loadSignals({ skipResultRender:true })];
    if (!isObserverMode()) tasks.push(loadStrategyCatalog());
    await Promise.allSettled(tasks);
  } else if (tabId === "risk-center") {
    await loadRiskCenter();
  } else if (tabId === "review-memory") {
    await loadReviewMemory();
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

function openAccountCenter(tab = "overview") {
  const modal = $("accountCenterModal");
  const frame = $("accountCenterFrame");
  if (!modal || !frame) return;
  accountCenterPreviousFocus = document.activeElement;
  const nextSrc = `/account/?embed=ai&tab=${encodeURIComponent(tab)}`;
  if (!frame.src || !frame.src.includes("/account/")) frame.src = nextSrc;
  else frame.contentWindow?.postMessage({ type:"account-center-tab", tab }, window.location.origin);
  modal.classList.remove("hidden");
  modal.setAttribute("aria-hidden", "false");
  document.body.classList.add("account-center-open");
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
  if (event.data?.type === "account-center-close") return closeAccountCenter();
  if (event.data?.type === "account-session-logout") return logout();
  if (event.data?.type === "account-profile-updated" && event.data.user) {
    state.user = { ...state.user, ...event.data.user };
  }
}

function logout() {
  if (state.bridgeWs) { try { state.bridgeWs.close() } catch {} state.bridgeWs = null; }
  stopRealtimeSync();
  stopPresenceHeartbeat();
  stopReviewDetailPolling();
  if (state.reviewSummaryTimer) clearInterval(state.reviewSummaryTimer);
  state.reviewSummaryTimer = null;
  state.user = null;
  state.selectedSignal = null;
  if (window.AuthSession) window.AuthSession.clear();
  else {
    setAuth("");
    localStorage.removeItem("ws_token");
    localStorage.removeItem("ws_user");
    document.cookie = "ws_token=; Max-Age=0; Path=/; SameSite=Lax";
  }
  showApp(false);
  window.location.href = "/ai/auth/?mode=login";
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
    : '当前账户已成功登录，但免费版不包含实验室权限。选择 Plus 进行观摩，或选择 Pro 连接自己的 MT5。';
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
    await loadObserverChannels();
    showApp(true);
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
    // broker symbol (for example XAUUSD.s) is discovered by refreshAll first;
    // requesting rates here with the generic XAUUSD fallback is invalid on
    // suffix-only brokers and produces rates_params_invalid.
    setTab('dashboard', { skipRefresh:true });
    startPresenceHeartbeat();
    await refreshAll();
    startLiveQuoteRefreshTimer();
    if (!isObserverMode()) {
      await loadReviewSummary({ announce:false });
      startReviewSummaryPolling();
    }
    // Data loads on-demand: tab switch + manual refresh + bridge data push
    refreshTabData(activeTabId());
  } catch (error) {
    if (error?.name === "ApiError" && Number(error.status) === 401) {
      logout();
      return;
    }
    console.error("[Bootstrap] AI 实验室初始化失败:", error);
    renderBootstrapError(error);
  }
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
      loadSignals(),
      loadHistory(),
      loadHistoryChart(),
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

async function loadStatus() {
  const health = await wsApi("health");
  const gateway = health.gateway || {};
  if (gateway.platform) updateBridgePlatformUI(gateway.platform);
  state.gatewayStatus = gateway;
  syncAiAccess(gateway.access);
  const isLive = gateway.mode === "live";
  const usingFallback = gateway.using_fallback;
  state._usingFallback = usingFallback;

  // Gateway badge — bridge connection status
  if (usingFallback) {
    if (state.isPlusReadOnly) {
      setBadge("gatewayMode", "观摩模式", "warning");
    } else {
      setBadge("gatewayMode", "观摩模式-请连接您的MT5", "warning");
    }
  } else {
    const platform = bridgePlatformLabel();
    setBadge("gatewayMode", isLive ? `${platform} 已连接` : `${platform} 未连接`, isLive ? "connected" : "neutral");
  }

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
    setBadge("autoAnalyzeMode", "自动分析状态未知", "warning");
  }

}

// ============ Gateway Badge Click ============
// ============ Gateway Badge Click — MT5 connect/disconnect ============
async function handleGatewayModeClick() {
  if (isObserverMode() && state.aiAccess?.can_download_bridge !== true) {
    toast("Plus 会员仅支持观摩，不能下载或连接桥接软件", "warning");
    return;
  }
  // Pro without own bridge: allow bridge download modal
  const modal = $("mt5BridgeModal");
  if (!modal) return;
  if (!modal.classList.contains("hidden")) {
    modal.classList.add("hidden");
    return;
  }
  modal.classList.remove("hidden");
}

function initBridgeModal() {
  const modal = $("mt5BridgeModal");
  if (!modal) return;

  $("mt5BridgeClose")?.addEventListener("click", () => modal.classList.add("hidden"));
  modal.addEventListener("click", (e) => { if (e.target === modal) modal.classList.add("hidden"); });

  $("downloadExe")?.addEventListener("click", async () => {
    let url = "https://qiniu.acadfx.com/bridge/bootstrapper/afbfc5cb8cb0a252834ee49d7f0c76a0640d4e2996cde7cda554c10ea43e3652/LiangjianBridgeSetup.exe";
    let version = "3.0.0";
    try {
      const resp = await fetch("/api/bridge/version");
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const data = await resp.json();
      if (data.full_url || data.updater_url) url = data.full_url || data.updater_url;
      if (data.version) {
        version = String(data.version).replace(/^v?/i, "v");
        window._bridgeVersion = version;
      }
    } catch {}
    const a = document.createElement("a");
    a.href = url; a.download = url.split("/").pop(); a.click();
    toast(`正在下载量见智桥 ${version}`, "success");
    modal.classList.add("hidden");
  });

}

// ============ Trade Mode Badge Click — toggle trade sending ============
async function handleTradeModeClick() {
  if (isObserverMode()) { toast(observerMessage(), "warning"); return; }
  if (state.isPlusReadOnly) { toast("Plus 会员仅可查看", "warning"); return; }
  if (state.user?.role !== 'admin' && state.user?.plan === 'pro' && state._usingFallback) { toast("请先连接您的 MT5 账户", "warning"); return; }
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

// ============ Auto Toggle (Simple) ============
let _autoToggleLock = false;
async function handleAutoToggle() {
  if (_autoToggleLock) return;
  if (isObserverMode()) { toast(observerMessage(), "warning"); return; }
  if (state.isPlusReadOnly) { toast("Plus 会员仅可查看", "warning"); return; }
  if (state.user?.role !== 'admin' && state.user?.plan === 'pro' && state._usingFallback) { toast("请先连接您的 MT5 账户", "warning"); return; }
  const activeCycles = activeAutoProgressCycles(state.autoRuntime);
  const closeTitle = activeCycles.length ? "停止后续自动分析" : "关闭自动分析";
  const closeMessage = activeCycles.length
    ? `当前有 ${activeCycles.length} 个品种正在分析。关闭后不会再开始新任务，已经提交给模型的任务仍会安全完成。`
    : "确认关闭自动分析？关闭后将停止 AI 行情分析和交易建议推送。";
  if (state.autoEnabled && !await showConfirm(closeTitle, closeMessage, { confirmText: activeCycles.length ? "停止后续任务" : "关闭", danger: true })) return;
  _autoToggleLock = true;
  try {
    const result = await wsApi('toggle_auto');
    await loadStatus();
    toast(result.message || (result.enabled ? '自动分析已开启' : '自动分析已关闭'), 'success');
  } catch (e) {
    toast('切换失败: ' + e.message, 'error');
  } finally {
    _autoToggleLock = false;
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
  if (preferred) setGlobalSymbol(preferred.name);
  updateManualStrategySelection();
  // Don't call refreshQuote here — tick stream handles it at 1s

}

async function loadAccount() {
  const data = await wsApi("account");
  const rawServer = data.server || data.company || "服务器 --";
  const server = rawServer;
  const currency = data.currency || "USD";
  state.accountBalance = parseFloat(data.balance) || 0;
  state.bridgeAccountIdentity = data.server && data.login != null ? {
    brokerServerKey: String(data.server).trim().toUpperCase(),
    loginAccount: String(data.login).trim(),
  } : null;
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
      || state.bridgeWs?.readyState !== WebSocket.OPEN) return;
  void refreshLiveQuote(true);
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
let _klineVolRefreshTimer = null;
let _klineMutationObserver = null;
let _klineResizeObserver = null;
let _klineDeferredObserver = null;

function mt5BrokerTimeSeconds(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  const parts = value.replace(' ', 'T').split(/[-T:]/).map(Number);
  if (parts.length < 3 || parts.slice(0, 3).some(item => !Number.isFinite(item))) return null;
  const seconds = Math.floor(Date.UTC(parts[0], parts[1] - 1, parts[2], parts[3] || 0, parts[4] || 0, parts[5] || 0) / 1000);
  return Number.isFinite(seconds) ? seconds : null;
}

function disconnectKlineObservers() {
  if (_klineDeferredObserver) { _klineDeferredObserver.disconnect(); _klineDeferredObserver = null; }
  if (_klineMutationObserver) { _klineMutationObserver.disconnect(); _klineMutationObserver = null; }
  if (_klineResizeObserver) { _klineResizeObserver.disconnect(); _klineResizeObserver = null; }
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
    if (!range) return;
    const total = _klineSeries.data().length;
    if (total < 2) return;
    const span = range.to - range.from;
    if (span >= total) {
      _klineChart.timeScale().setVisibleLogicalRange({ from: 0, to: total - 1 });
    }
  });
}

async function loadKlineData() {
  if (document.hidden || activeTabId() !== 'dashboard') return;
  if (!_klineSeries) return; // Chart not initialized yet (e.g. admin on dashboard tab)
  const symbol = $("quoteSymbolSelect")?.value || $("tradeSymbolSelect")?.value || "XAUUSD";
  try {
    const data = await wsApi('rates', { symbol, timeframe: _klineTimeframe, count: 200 });
    if (!data || data.status !== 'success' || !Array.isArray(data.rates) || !data.rates.length) return;
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
    if (!candles.length) throw new Error('no_valid_kline_ohlc');
    const volumes = normalized.map(({ row, candle }) => ({
      time: candle.time,
      value: Math.max(0, Number(row.tick_volume || row.volume || 0) || 0),
      color: candle.close >= candle.open ? 'rgba(239,68,68,0.3)' : 'rgba(16,185,129,0.3)',
    }));

    _klineSeries.setData(candles);
    _klineVolumeSeries.setData(volumes);
    _klineLastBar = candles[candles.length - 1];

    // Update last price display
    setText('klineLastPrice', candles.at(-1).close.toFixed(2));

    _klineChart.timeScale().fitContent();
  } catch (e) {
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
  try {
    const data = await wsApi('rates', { symbol, timeframe: _klineTimeframe, count: 1 });
    if (data && data.status === 'success' && Array.isArray(data.rates) && data.rates.length) {
      const b = data.rates.at(-1);
      const vol = Number(b.tick_volume || b.volume || 0);
      const color = Number(b.close) >= Number(b.open) ? 'rgba(239,68,68,0.3)' : 'rgba(16,185,129,0.3)';
      _klineVolumeSeries.update({ time: _klineLastBar.time, value: vol, color: color });
    }
  } catch (e) { /* ignore */ }
}

function updateKlineTick(bid, ask, quote = {}) {
  if (!_klineSeries || state.marketTradeMode === 0) return;
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

function renderPositionRows(positions = [], withAction) {
  if (!positions.length) {
    return `<tr class="empty-row"><td colspan="${withAction ? 11 : 8}">当前无持仓</td></tr>`;
  }
  const tickets = state.signalTickets || {};
  return positions.map((position) => {
    const type = String(position.type || "").toLowerCase();
    const directionLabel = type === "buy" ? "买入 多" : "卖出 空";
    const directionClass = type === "buy" ? "dir-buy" : type === "close" ? "dir-close" : "dir-sell";
    const digits = Number(position.digits);
    const priceDigits = Number.isFinite(digits) ? Math.min(Math.max(digits, 0), 6) : 2;
    return `
      <tr data-ticket="${escapeHtml(position.ticket)}">
        ${ticketCell(position.ticket, tickets)}
        <td data-label="品种">${escapeHtml(position.symbol)}</td>
        <td data-label="方向"><span class="${directionClass}">${directionLabel}</span></td>
        <td data-label="手数" class="num">${escapeHtml(volumeText(position.volume))}</td>
        <td data-label="开仓价" class="num">${fmt(position.price_open, priceDigits)}</td>
        <td data-label="现价" class="num">${fmt(position.price_current, priceDigits)}</td>
        <td data-label="开仓时间" class="num">${escapeHtml(formatTime(position.time))}</td>
        ${withAction ? `<td data-label="止损" class="num">${Number(position.sl) ? fmt(position.sl, priceDigits) : "--"}</td><td data-label="止盈" class="num">${Number(position.tp) ? fmt(position.tp, priceDigits) : "--"}</td>` : ""}
        <td data-label="浮动盈亏" class="${profitClass(position.profit)}">${fmt(position.profit)}</td>
        ${withAction ? `<td data-label="操作" class="position-row-actions-cell">
          ${state.user?.role === "admin" && Number(position.magic) === 234000 ? `<button class="btn small position-protection-edit" type="button" data-edit-protection-ticket="${escapeHtml(position.ticket)}"><i data-lucide="pencil" size="13"></i>编辑保护</button>` : ""}
          <button class="btn small" type="button" data-close-ticket="${escapeHtml(position.ticket)}"><i data-lucide="x" size="12"></i>平仓</button>
        </td>` : ""}
      </tr>
    `;
  }).join("");
}

async function loadSignalTickets() {
  try {
    const data = await wsApi("signal_tickets");
    state.signalTickets = data.tickets || {};
  } catch { state.signalTickets = {}; }
}

async function loadCloseSignalTickets() {
  try {
    const data = await wsApi("close_signal_tickets");
    state.closeSignalTickets = data.tickets || {};
  } catch { state.closeSignalTickets = {}; }
}

function ticketCell(ticket, signalTickets) {
  const signalId = signalTickets[String(ticket)];
  if (signalId) {
    return `<td data-label="票号" class="num"><a href="#" class="signal-link" onclick="event.preventDefault(); openAnalysisFromHistory(${signalId}, { source:'history', forcePinned:true })">${escapeHtml(ticket)}</a></td>`;
  }
  return `<td data-label="票号" class="num">${escapeHtml(ticket)}</td>`;
}

async function loadPositions() {
  const [data] = await Promise.all([
    wsApi("positions", {}),
    loadSignalTickets(),
  ]);
  const positions = data.positions || [];
  state.positions = positions;
  $("positionsBody").innerHTML = renderPositionRows(positions, true);
  $("dashboardPositionsBody").innerHTML = renderPositionRows(positions, false);
  $("positionsEmpty").classList.toggle("hidden", positions.length > 0);
  $("dashboardPositionsTable").classList.toggle("hidden", positions.length === 0);
  initIcons();
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

function positionProtectionErrorLabel(code, fallback = "") {
  const labels = {
    bridge_offline: "用户桥接离线，请连接 MT5 后重试",
    system_position_not_found: "持仓已不存在或已经平仓",
    position_not_system_owned: "该持仓不是系统下单",
    position_magic_mismatch: "持仓归属校验失败",
    management_account_identity_mismatch: "当前桥接账户与目标账户不一致",
    management_account_server_mismatch: "MT5 服务器已变化",
    management_account_login_mismatch: "MT5 登录账号已变化",
    management_symbol_mismatch: "持仓品种已变化",
    management_direction_mismatch: "持仓方向已变化",
    management_volume_mismatch: "持仓手数已变化",
    position_stop_loss_changed: "止损已被其他操作修改，请重新预览",
    position_take_profit_changed: "止盈已被其他操作修改，请重新预览",
    stop_loss_direction_or_distance_invalid: "止损方向错误或距离现价过近",
    take_profit_direction_or_distance_invalid: "止盈方向错误或距离现价过近",
    source_position_update_failed: "发起持仓修改失败，未继续同步",
    multiple_position_sources: "净持仓包含多个来源，已安全跳过",
    position_protection_command_failed: "MT5 未确认修改结果",
  };
  return labels[String(code || "")] || fallback || String(code || "执行失败");
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
    return;
  }
  if (!preview) return;
  const source = preview.source || {};
  if (summary) summary.innerHTML = `
    <div><span>持仓</span><strong class="num">#${escapeHtml(source.ticket || "--")}</strong></div>
    <div><span>品种 / 方向</span><strong>${escapeHtml(source.symbol || "--")} · ${source.direction === "buy" ? "买入" : "卖出"}</strong></div>
    <div><span>当前 SL / TP</span><strong class="num">${Number(source.current_stop_loss) ? fmt(source.current_stop_loss, 6) : "未设置"} / ${Number(source.current_take_profit) ? fmt(source.current_take_profit, 6) : "未设置"}</strong></div>
    <div><span>来源信号</span><strong>${source.signal_id ? `#${escapeHtml(source.signal_id)}` : "无法唯一归因"}</strong></div>`;
  if (impact) impact.innerHTML = `
    <div><span>涉及用户</span><strong class="num">${Number(preview.affected_users || 0)}</strong></div>
    <div><span>涉及持仓</span><strong class="num">${Number(preview.affected_positions || 0)}</strong></div>
    <div><span>当前在线</span><strong class="num">${Number(preview.online_users || 0)}</strong></div>
    <div><span>安全排除</span><strong class="num">${Number(preview.exclusions?.length || 0)}</strong></div>`;
  if (scope) {
    scope.disabled = !preview.sync_available;
    scope.checked = preview.sync_scope === "signal" && preview.sync_available;
  }
  const scopeHelp = $("positionProtectionScopeHelp");
  if (scopeHelp) scopeHelp.textContent = preview.sync_available
    ? "开启后，仅同步到由同一条信号产生、且当前仍能唯一归因的系统持仓。"
    : "该持仓缺少唯一信号来源，只能修改当前持仓。";
  if (submit) submit.disabled = false;
}

async function loadPositionProtectionPreview(ticket, syncScope = "source_only") {
  renderPositionProtectionPreview(null, true);
  const data = await api(`/api/admin/ai/positions/${encodeURIComponent(ticket)}/protection-preview?sync_scope=${encodeURIComponent(syncScope)}`, { timeout:20000 });
  state.positionProtectionPreview = data.preview;
  renderPositionProtectionPreview(data.preview);
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
  openFormModal(modal);
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
  submit.disabled = true;
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
  } finally { submit.disabled = false; }
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
  if (state.bridgeWs?.readyState === WebSocket.OPEN) {
    try {
      state.bridgeWs.send(JSON.stringify({ type:'hb', seq:++state._hbSeq, observer_channel_id:nextId }));
    } catch {}
  }
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

  document.querySelectorAll('.admin-only').forEach(el => {
    el.style.display = isAdmin || (platformManager && el.classList.contains('platform-content-only')) ? '' : 'none';
  });
  document.querySelectorAll('.user-only').forEach(el => {
    const platformPersonalControl = el.classList.contains('personal-memory-only');
    el.style.display = isAdmin || (platformManager && platformPersonalControl) ? 'none' : '';
  });
  setText("memoryTabLabel", platformManager ? "平台记忆" : "策略记忆");
  setText("memoryActiveLabel", platformManager ? "已发布记忆" : "有效记忆");
  setText("memoryActiveHelp", platformManager ? "可用于平台策略" : "可用于后续分析");
  setText("memorySectionTitle", platformManager ? "平台策略记忆" : "我的策略记忆");
  setText("memorySectionDescription", platformManager
    ? "来自观摩账户复盘的策略记忆先进入候选区，经发布后才会用于其绑定的平台策略。"
    : "这里只保留你已经确认的经验，可以随时暂停或撤销。");
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
    gatewayBadge.title = observer && !canOpenDownload ? "Plus 会员仅可观摩" : "";
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
    badge.title = observer ? observerMessage() : "";
  }

  document.querySelectorAll('.observer-action-panel').forEach(panel => setObserverPanelLock(panel, observer));

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
  const plannedEntry = direction === "hold" ? null : (signal.limit_price || signal.market_data?.latest_price);
  const finalVolumeText = direction === "hold"
    ? "无需计算"
    : finalVolume == null ? "执行时计算" : volumeText(finalVolume);
  const analysis = userVisibleText(signal.analysis, "暂无行情分析正文");
  const reasoning = userVisibleText(signal.reasoning, "");
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
  const card = $("signalCard");
  if (!card) return;

  const previousSignalId = state.dashboardSignal?.id;
  state.dashboardSignal = signal || null;

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
  const createdAt = parseBeijingServerTime(signal.created_at);
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
    const validDate = utcToMt5(signal.pending_valid_until, signal.mt5_timezone_offset_minutes)
    if (validDate) rows += `<div><span>有效期至</span><strong>${escapeHtml(validDate)}</strong></div>`
  }
  return `<div class="signal-pending-info">${rows}</div>`
}

function signalDecision(signal) {
  let stored = signal?.decision || signal?.decision_json || {};
  if (typeof stored === "string") { try { stored = JSON.parse(stored); } catch { stored = {}; } }
  const dir = signalType(signal?.signal_type);
  const sourceReasons = signal?.key_reasons || stored.key_reasons;
  const sourceRisks = signal?.risk_factors || stored.risk_factors;
  const bullish = Number(signal?.bullish_score ?? stored.bullish_score);
  const bearish = Number(signal?.bearish_score ?? stored.bearish_score);
  const experienceUsage = signal?.experience_usage || stored.experience_usage || {};
  const hasDirectionBias = Number.isFinite(bullish) && Number.isFinite(bearish) && bullish >= 0 && bearish >= 0 && bullish + bearish > 0;
  const total = hasDirectionBias ? bullish + bearish : 0;
  return {
    summary: userVisibleText(signal?.decision_summary || stored.decision_summary, dir === "hold" ? "当前条件不足，建议继续观望。" : `${dir === "buy" ? "偏多" : "偏空"}机会成立，等待风控复核。`),
    trigger: userVisibleText(signal?.trigger_condition || stored.trigger_condition, ""),
    invalidation: userVisibleText(signal?.invalidation_condition || stored.invalidation_condition, ""),
    reasons: Array.isArray(sourceReasons) ? sourceReasons.slice(0, 4).map(item => userVisibleText(item, "系统未提供中文依据")) : [],
    risks: Array.isArray(sourceRisks) ? sourceRisks.slice(0, 4).map(item => userVisibleText(item, "系统未提供中文风险说明")) : [],
    bullishScore: hasDirectionBias ? Math.round(bullish / total * 1000) / 10 : null,
    bearishScore: hasDirectionBias ? Math.round(bearish / total * 1000) / 10 : null,
    candidateEntry: signal?.candidate_entry || stored.candidate_entry || null,
    experienceUsage,
  };
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
  const consideredRefs = Array.isArray(usage.considered_refs) ? usage.considered_refs : [];
  const usedRefs = Array.isArray(usage.used_refs) ? usage.used_refs : [];
  const rejectedRefs = Array.isArray(usage.rejected_refs) ? usage.rejected_refs : [];
  const considered = consideredRefs.length ? consideredRefs : (Array.isArray(usage.considered_ids) ? usage.considered_ids : []);
  if (!considered.length) return "";
  const used = consideredRefs.length ? usedRefs : (Array.isArray(usage.used_ids) ? usage.used_ids : []);
  const rejected = consideredRefs.length ? rejectedRefs : (Array.isArray(usage.rejected_ids) ? usage.rejected_ids : []);
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
    description:signal?.pending_ticket ? `MT5 挂单 #${signal.pending_ticket} 正在等待触发。` : "挂单已经发送到 MT5，正在等待触发。",
    executable:false,
  };
  if (signal?.is_executed) return { state:"executed", title:"订单已执行", description:"MT5 已确认订单执行结果。", executable:false };
  const terminalStatus = ["rejected", "failed", "skipped", "uncertain"].includes(persistedStatus) ? persistedStatus : "";
  const executionStatus = execution?.status || terminalStatus;
  if (executionStatus && executionStatus !== "success") {
    const rejected = executionStatus === "rejected";
    const skipped = executionStatus === "skipped";
    return {
      state: rejected ? "rejected" : skipped ? "skipped" : "failed",
      title: rejected ? "风控未放行" : skipped ? "本次未执行" : "执行未完成",
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
  if (!actions.length) return "";
  const labels = {
    cancelled: { title:"挂单已取消", icon:"circle-x" },
    superseded: { title:"旧挂单已取消并替换", icon:"replace" },
    failed: { title:"挂单取消失败", icon:"circle-alert" },
  };
  return `<section class="signal-pending-actions">
    <div class="analysis-section-title"><i data-lucide="list-x" size="15"></i><strong>挂单处理</strong><span>共 ${actions.length} 条</span></div>
    <div class="signal-pending-action-list">${actions.map(action => {
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
    : (signal?.market_data || {});
  const frames = market?.strategy_context?.timeframes || signal?.market_data?.strategy_context?.timeframes || {};
  const klines = { ...(snapshot.klines || {}) };
  for (const [timeframe, value] of Object.entries(frames)) {
    if (!Array.isArray(klines[timeframe]) && Array.isArray(value?.klines)) klines[timeframe] = value.klines;
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
  const available = availableInferenceTimeframes(context.klines);
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
    ? "平台 MT5 行情"
    : "推理时行情";
  const visibleCount = Array.isArray(context.klines[state.inferenceChartTimeframe])
    ? context.klines[state.inferenceChartTimeframe].length
    : 0;
  const evidenceLabel = snapshotStatus === "incomplete" ? `保留最近 ${visibleCount} 根` : `${visibleCount} 根证据完整`;
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
  if (!container || typeof LightweightCharts === "undefined") return;
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
    container.innerHTML = '<div class="inference-chart-error">K 线数据格式无效，无法绘制。</div>';
    return;
  }
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

  document.querySelectorAll("[data-inference-timeframe]").forEach(button => { button.onclick = () => {
    state.inferenceChartTimeframe = button.dataset.inferenceTimeframe;
    document.querySelectorAll("[data-inference-timeframe]").forEach(item => { item.classList.toggle("active", item === button); item.setAttribute("aria-selected", String(item === button)); });
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
  const decision = signalDecision(signal);
  const advice = signalExecutionAdvice(signal);
  let executionPayload = signal.execution_result || {};
  if (typeof executionPayload === "string") { try { executionPayload = JSON.parse(executionPayload); } catch { executionPayload = {}; } }
  const finalVolume = executionPayload?.risk?.approved_order?.volume ?? executionPayload?.approved_order?.volume ?? null;
  const takeProfitSelection = signalTakeProfitSelection(signal);
  const rawMarket = signal.market_data || {};
  // CLOSE signals: market data nested in timeframes.X.summary
  const closeSummary = rawMarket.timeframes ? Object.values(rawMarket.timeframes)[0]?.summary || {} : {};
  const market = dir === "close" ? { ...closeSummary, latest_price: rawMarket.latest_price ?? closeSummary.latest_price } : rawMarket;
  const account = dir === "close" ? (rawMarket.account || {}) : {};
  // CLOSE: positions from closeContext ({total, details}), others from market.positions
  const positions = dir === "close"
    ? { total_positions: rawMarket.positions?.total ?? "--", symbol_positions: rawMarket.positions?.details?.filter(d => d.symbol === signal.symbol).length ?? "--" }
    : (market.positions || {});
  const result = $("analysisResult");
  const freshnessClass = signal.is_stale ? "expired" : signal.is_executed ? "executed" : "live";
  const reasoningText = userVisibleText(signal.reasoning, "");
  // Try to parse structured positions data (CLOSE signals store JSON array)
  let closePositions = null;
  try {
    const raw = String(signal.analysis || "").trim();
    if (raw.startsWith("[")) { const arr = JSON.parse(raw); if (Array.isArray(arr) && arr.length > 0 && arr[0].ticket) closePositions = arr; }
  } catch {}
  let escapedAnalysis = closePositions ? "" : escapeHtml(userVisibleText(signal.analysis, "暂无行情分析"));
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
      </div>
        <span class="analysis-time num">#${escapeHtml(signal.id)} · ${escapeHtml(signalDisplayTime(signal))}</span>
    </div>
    <section class="execution-advice-hero ${escapeHtml(advice.state || "review")}">
      <div class="execution-advice-icon"><i data-lucide="${advice.executable ? "send" : dir === "hold" ? "pause" : "shield-check"}" size="20"></i></div>
      <div><span>执行建议</span><strong>${escapeHtml(advice.title || executionStatus(signal))}</strong><p>${escapeHtml(advice.description || "")}</p></div>
      <span class="analysis-direction-badge ${dir}">${directionText(signal.signal_type)}</span>
    </section>
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
      <div class="execution-price-item"><span>止损保护</span><strong>${escapeHtml(signal.stop_loss_price || "--")}</strong></div>
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
  if (open) setTimeout(() => $("analyzeStrategy")?.focus(), 0);
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

  $("runAnalysisBtn").disabled = true;
  $("executeSignalBtn").disabled = true;
  const statusEl = $("manualInferenceStatus");
  statusEl?.classList.remove("hidden");
  $("manualInferenceClose").disabled = true;
  $("manualInferenceCancel").disabled = true;
  setText("analysisLatency", "推理中");
  setText("signalFreshness", "等待结果");
  const started = performance.now();

  try {
    const result = await wsApi("analyze", {
      session_id: "default", strategy_id:strategyId, symbol,
      include_positions: false, auto_execute:autoExecute, _timeout:120000,
    });
    const best = result?.signal;
    if (!best) throw new Error("未返回有效信号");
    const elapsed = Math.round(performance.now() - started);
    if (best.id != null) {
      state.latestSignalId = best.id;
      _lastSignalId = best.id;
      setAnalysisSelectionIntent(best.id, { source:"manual", followLatest:true });
    }
    renderSignal(best, elapsed);
    setManualInferenceModal(false);
    showSignalNotification(best);
    await loadSignals({ skipResultRender: true });
    const firstItem = document.querySelector(".analysis-history-item");
    if (firstItem) firstItem.scrollIntoView({ behavior: "smooth", block: "nearest" });
    if (autoExecute && best.signal_type !== "hold" && !best.auto_executed) toast("信号已生成，但自动执行未完成；请查看风控决策与拒绝原因", "warning");
    else toast(autoExecute && best.auto_executed ? `信号已生成并通过风控执行，耗时 ${(elapsed/1000).toFixed(1)}s` : `信号已生成，耗时 ${(elapsed/1000).toFixed(1)}s`, "success");
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
      model_ids: modelIds, _timeout: 180000,
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
    await Promise.allSettled([loadPositions(), loadAccount(), loadSignals()]);
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
      const type = btn.dataset.type;
      state.selectedOrderType = type;
      const pendingRow = $("pendingPriceRow");
      const stopLimitWrap = $("stopLimitPriceWrap");
      if (type === "market") {
        pendingRow.style.display = "none";
      } else {
        pendingRow.style.display = "";
        stopLimitWrap.style.display = type === "stop_limit" ? "" : "none";
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
        await Promise.allSettled([loadHistory(), loadHistoryChart()]);
        return;
      }
    }
  })().catch(error => console.warn("trade state refresh failed:", error));
}

function managementExpectedState(item, ticket, kind) {
  const identity = state.bridgeAccountIdentity;
  if (!identity?.brokerServerKey || !identity?.loginAccount) {
    throw new Error("MT5 账户身份尚未加载，请刷新账户状态后重试");
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
      setAnalysisSelectionIntent(signal.id, { source:"ticket", forcePinned:true });
      state.selectedSignal = signal;
      setTab("ai-analyze");
      renderSignal(signal, null);
      highlightActiveAnalysis(signal.id);
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
    await Promise.allSettled([loadPositions(), loadAccount(), loadHistory(), loadHistoryChart(), loadStatus(), loadPendingOrders()]);
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
    await Promise.allSettled([loadPositions(), loadAccount(), loadHistory(), loadHistoryChart(), loadStatus()]);
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
  return `
      <button class="analysis-history-item" data-analysis-id="${escapeHtml(signal.id)}">
        <span class="history-item-top">
          <span class="history-item-symbol">${escapeHtml(signal.symbol)} · ${escapeHtml(signal.timeframe)}</span>
          <span class="history-item-dir ${dir}">${directionText(signal.signal_type)}</span>
        </span>
        <span class="history-item-meta">
          <span>#${escapeHtml(signal.id)}</span>
          <span>${escapeHtml(compactTimeText(signal?.created_at_mt5 || signal?.created_at))}</span>
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
let _signalTableRequestVersion = 0;

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
  const forceRefresh = options.forceRefresh ?? navigate;
  let signal = state.signals.find((item) => String(item.id) === requestedId);

  if (!options.preserveSelectionMode) setAnalysisSelectionIntent(signalId, options);

  // Select immediately: a late response for the previous signal may update its
  // list cache, but must never reclaim the currently visible detail panel.
  state.selectedSignal = signal || { id: signalId };
  highlightActiveAnalysis(signalId);
  if (navigate) setTab("ai-analyze", { skipRefresh:true, analystView:"detail" });

  if (!signal?.detail_loaded || forceRefresh) {
    renderAnalysisDetailLoading(signalId);
    try {
      const data = await wsApi("signal_detail", { signal_id: Number(signalId) });
      if (data.status === 'success' && data.signal) {
        signal = { ...(signal || {}), ...data.signal, detail_loaded: true };
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
    const rowStatus = signal.is_executed ? "executed" : signal.is_stale ? "expired" : "live";
    return `
      <tr data-analysis-id="${escapeHtml(signal.id)}">
        <td class="num">${escapeHtml(signal.id)}</td>
        <td>${compactTimeHtml(signal?.created_at_mt5 || signal?.created_at)}</td>
        <td>${escapeHtml(signal.symbol)}</td>
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
  const requestVersion = options.append ? _signalsListRequestVersion : ++_signalsListRequestVersion;
  const loadedIds = options.append ? state.signals.map(item => Number(item.id)).filter(Number.isFinite) : [];
  const beforeId = loadedIds.length ? Math.min(...loadedIds) : null;
  const data = await wsApi("signals", { limit, offset:beforeId ? 0 : offset, ...(beforeId ? { before_id:beforeId } : {}) });
  if (requestVersion !== _signalsListRequestVersion) return;
  const signals = data.signals || [];
  const hasMore = data.has_more !== undefined ? data.has_more : signals.length >= limit;

  if (options.append) {
    const known = new Set(state.signals.map(item => String(item.id)));
    state.signals = state.signals.concat(signals.filter(item => !known.has(String(item.id))));
  } else {
    state.signals = signals;
  }
  state.analysisHistoryOffset = state.signals.length;
  state.analysisHistoryHasMore = hasMore;

  // The server-sorted first row is the canonical latest signal. Keep it
  // separate from the selected row because history navigation may inject an
  // older signal at the top of the visible list.
  if (state.signals.length > 0 && !options.append) {
    state.latestSignalId = state.signals[0].id;
    _lastSignalId = state.signals[0].id;
  }
  if (!options.append) {
    if (state.signals[0]) {
      await loadDashboardSignal(state.signals[0].id, state.signals[0], { announceNew:options.announceDashboardSignal === true });
    } else {
      updateSignalDisplay(null);
    }
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
  if (!options.skipResultRender && !options.append) {
    if (activeSignal) await openAnalysisFromHistory(activeSignal.id, { navigate:false });
    else renderSignal(null, null);
  }

  // Also refresh signal table on non-append loads
  if (!options.append) loadSignalTable();
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

function getHistoryRangeParams() {
  const scope = $("historyRangeMode")?.value || "platform";
  const params = { history_scope: scope };
  if (scope === "custom") {
    const from = $("historyRangeFrom")?.value || "";
    const to = $("historyRangeTo")?.value || "";
    if (!from && !to) throw new Error("请选择自定义历史日期");
    if (from && to && from > to) throw new Error("历史开始日期不能晚于结束日期");
    if (from) params.close_from = from;
    if (to) params.close_to = to;
  }
  return params;
}

function updateHistoryRangeUI() {
  const scope = $("historyRangeMode")?.value || "platform";
  const custom = scope === "custom";
  $("historyRangeDates")?.classList.toggle("hidden", !custom);
  if ($("historyRangeFrom")) $("historyRangeFrom").disabled = !custom;
  if ($("historyRangeTo")) $("historyRangeTo").disabled = !custom;
  const hints = {
    all: `包含该 ${bridgePlatformLabel()} 账户的完整交易、入金、提款和信用记录。`,
    platform: `从当前 ${bridgePlatformLabel()} 账户本次接入平台之日开始。`,
    custom: "按平仓日期统计；入金、提款和信用也按同一日期范围计算。",
  };
  const mt4RangeWarning = bridgePlatformLabel() === "MT4"
    ? " MT4 历史范围取决于终端“账户历史”页已加载的时间范围；需要完整历史时，请先在 MT4 中选择“全部历史记录”。"
    : "";
  setText("historyRangeHint", `${hints[scope] || hints.all}${mt4RangeWarning}`);
}

async function loadHistory(forceRefresh) {
  try {
    const filters = state.historyFilters;
    const entryFrom = document.getElementById('filterEntryFrom')?.value || '';
    const entryTo = document.getElementById('filterEntryTo')?.value || '';
    const direction = document.getElementById('filterDirection')?.value || '';
    const profit = document.getElementById('filterProfit')?.value || '';
    const filterParams = getHistoryRangeParams();
    if (entryFrom) filterParams.entry_from = entryFrom;
    if (entryTo) filterParams.entry_to = entryTo;
    if (direction) filterParams.direction = direction;
    if (profit) filterParams.profit_filter = profit;

    // Cache check
    const filterKey = JSON.stringify({ ...filterParams, page: filters.page, pageSize: filters.pageSize });
    if (!forceRefresh && _historyCache && _historyCache.filters === filterKey) {
      _applyHistoryData(_historyCache.data);
      loadSignalTickets().catch(()=>{});
      loadCloseSignalTickets().catch(()=>{});
      return;
    }

    const [data] = await Promise.all([
      wsApi("history", { page: filters.page, page_size: filters.pageSize, force_refresh:Boolean(forceRefresh), ...filterParams }),
      loadSignalTickets(),
      loadCloseSignalTickets(),
    ]);
    if (data?.status !== 'success') throw new Error(data?.message || data?.error || '历史数据读取失败');
    _historyCache = { filters: filterKey, data };
    _applyHistoryData(data);
  } catch (e) { console.error("loadHistory:", e); toast(e.message || "历史数据读取失败", "error"); }
}

function _applyHistoryData(data) {
  if (!data) return;
  const stats = data.statistics || {};
  state.historyNetResult = parseFloat(stats.net_result) || 0;
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
  const rows = data.orders || [];
  const tickets = state.signalTickets || {};
  const closeTickets = state.closeSignalTickets || {};
  _renderHistoryRows(rows, tickets, closeTickets);
  const pg = data.pagination || {};
  renderPager("historyPager", pg.current_page || 1, pg.page_size || 20, pg.total_count || 0, "history");
  setText("historyFilterCount", `${pg.total_count || rows.length} 笔`);
}

// Chart and summary use the same explicit history scope as the table.
async function loadHistoryChart(forceRefresh) {
  try {
    const params = getHistoryRangeParams();

    const filterKey = JSON.stringify(params);
    if (!forceRefresh && _historyChartCache && _historyChartCache.filters === filterKey) {
      _renderHistoryChart(_historyChartCache.data);
      return;
    }

    const data = await wsApi("history_chart_data", { ...params, force_refresh:Boolean(forceRefresh) });
    if (data?.status !== 'success') throw new Error(data?.message || data?.error || '历史图表读取失败');
    _historyChartCache = { filters: filterKey, data };
    await ensureChartJs();
    _renderHistoryChart(data);
  } catch (e) { console.error("loadHistoryChart:", e); }
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
      <td data-label="止损" class="num">${row.stop_loss ? escapeHtml(raw(row.stop_loss)) : '--'}</td>
      <td data-label="止盈" class="num">${row.take_profit ? escapeHtml(raw(row.take_profit)) : '--'}</td>
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


function _renderHistoryChart(data) {
  const { daily = [], cumulative = [], drawdown = [], stats = {} } = data;

  const el = id => document.getElementById(id);
  el('chartTotalTrades').textContent = stats.total_trades || 0;
  el('chartWinRate').textContent = (stats.win_rate || 0).toFixed(1) + '%';
  el('chartWinRate').className = 'chart-stat-value ' + (stats.win_rate >= 50 ? 'positive' : 'negative');
  el('chartProfitFactor').textContent = stats.profit_factor >= 999 ? '∞' : (stats.profit_factor || 0).toFixed(2);
  el('chartProfitFactor').className = 'chart-stat-value ' + (stats.profit_factor >= 1 ? 'positive' : 'negative');
  el('chartMaxDD').textContent = (stats.max_drawdown || 0).toFixed(2) + '%';
  el('chartMaxDD').className = 'chart-stat-value ' + (stats.max_drawdown > 10 ? 'negative' : '');

  if (!daily.length) {
    if (_historyChart) { _historyChart.destroy(); _historyChart = null; }
    return;
  }

  const labels = daily.map(d => d.date.slice(5));
  const dailyProfits = daily.map(d => d.profit);
  const lastCum = cumulative[cumulative.length - 1] || 0;
  const lineColor = lastCum >= 0 ? '#ef4444' : '#10b981';
  const fillColor = lastCum >= 0 ? 'rgba(239,68,68,0.12)' : 'rgba(16,185,129,0.12)';
  const barColors = dailyProfits.map(v => v >= 0 ? 'rgba(239,68,68,0.5)' : 'rgba(16,185,129,0.5)');
  const barBorders = dailyProfits.map(v => v >= 0 ? 'rgba(239,68,68,0.8)' : 'rgba(16,185,129,0.8)');

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
          backgroundColor: barColors,
          borderColor: barBorders,
          borderWidth: 1,
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
      interaction: { mode: 'index', intersect: false },
      onClick: (e, elements) => {
        if (!elements.length) return;
        const idx = elements[0].index;
        const date = daily[idx]?.date;
        if (!date) return;
        // Drill into the selected day using the shared explicit range.
        if ($('historyRangeMode')) $('historyRangeMode').value = 'custom';
        if ($('historyRangeFrom')) $('historyRangeFrom').value = date;
        if ($('historyRangeTo')) $('historyRangeTo').value = date;
        updateHistoryRangeUI();
        state.historyFilters.page = 1;
        _historyCache = null;
        _historyChartCache = null;
        Promise.allSettled([loadHistory(true), loadHistoryChart(true)]);
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

function positionManagementBarTime(task) {
  const timestamp = Number(task?.closed_bar_time_utc_ms);
  if (!Number.isFinite(timestamp) || timestamp <= 0) return "--";
  const offset = Number.isFinite(Number(state.mt5TimezoneOffsetMinutes)) ? Number(state.mt5TimezoneOffsetMinutes) : 180;
  return fmtUtc(new Date(timestamp + offset * 60_000));
}

function positionManagementDecisionTime(task) {
  const timestamp = parseBeijingServerTime(task?.updated_at || task?.created_at);
  if (!Number.isFinite(timestamp)) return positionManagementBarTime(task);
  const offset = Number.isFinite(Number(state.mt5TimezoneOffsetMinutes)) ? Number(state.mt5TimezoneOffsetMinutes) : 180;
  return fmtUtc(new Date(timestamp + offset * 60_000));
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
    if (executionMode === "auto_exit" && !await showConfirm("开启自动平仓？", "开启后，同一持仓连续两轮有效自动推理都建议平仓时，系统会核对具体 MT5 票号并执行。任意一轮继续持有或输出无效都会清零；净持仓账户仍须通过同品种独占仓位与唯一归属校验。AI 挂单和 AI 取消挂单使用独立的平台开关。", { confirmText:"确认开启", danger:true })) return;
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
      const valid = item.validation_status === "valid";
      const action = valid ? positionManagementActionLabel(item.action) : "结果无效";
      return `<li class="management-confirmation-row ${escapeHtml(valid ? item.action : "invalid")}"><span class="management-confirmation-index">${index + 1}</span><div><header><strong>${escapeHtml(action)}</strong><time>${escapeHtml(compactTimeText(positionManagementDecisionTime(item)))}</time></header><p>${escapeHtml(item.reason || model.reason || "本轮没有可用说明")}</p>${condition ? `<small>${escapeHtml(positionManagementConditionText(condition))}</small>` : ""}</div></li>`;
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
      <section class="management-detail-section"><header><h4>状态时间线</h4><span>${events.length} 条</span></header>${events.length ? `<ol class="management-timeline">${events.map(event => `<li><time>${escapeHtml(compactTimeText(event.created_at))}</time><span><strong>${escapeHtml(positionManagementStatus(event.to_status).label)}</strong><br>${escapeHtml(event.summary || event.event_type || "状态已更新")}</span></li>`).join("")}</ol>` : `<p>暂无状态记录。</p>`}</section>`;
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
  // Clear caches so fresh data is fetched
  _historyCache = null;
  _historyChartCache = null;
  await Promise.allSettled([loadAccount(), loadHistory(), loadHistoryChart()]);
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
    const direction = document.getElementById('filterDirection')?.value || '';
    const profit = document.getElementById('filterProfit')?.value || '';
    if (entryFrom) filterParams.entry_from = entryFrom;
    if (entryTo) filterParams.entry_to = entryTo;
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
  return userVisibleText(row?.action, userVisibleText(row?.action_code, "系统审计操作"));
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
      <td data-label="时间（${bridgePlatformLabel()}）">${compactTimeHtml(row?.created_at_mt5 || row?.created_at)}</td>
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
  $("logoutBtn").addEventListener("click", logout);
  $("membershipGateLogoutBtn")?.addEventListener("click", logout);
  $("accountCenterBtn")?.addEventListener("click", () => openAccountCenter("overview"));
  $("accountCenterModal")?.querySelectorAll("[data-close-account-center]").forEach(node => node.addEventListener("click", closeAccountCenter));
  window.addEventListener("message", handleAccountCenterMessage);
  window.addEventListener("storage", event => {
    if ([window.AuthSession?.eventKey, "ws_token", "authToken"].includes(event.key) && !window.AuthSession?.token()) logout();
  });
  window.addEventListener("keydown", event => {
    if (event.key === "Escape" && !$("accountCenterModal")?.classList.contains("hidden")) closeAccountCenter();
  });
  $("refreshAllBtn").addEventListener("click", () => { _historyCache = null; _historyChartCache = null; refreshAll(); });
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
  $("manualInferenceModal")?.addEventListener("click", event => {
    if (event.target === $("manualInferenceModal") && !$("runAnalysisBtn")?.disabled) setManualInferenceModal(false);
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
  $("buyBtn").addEventListener("click", () => openManual("buy"));
  $("sellBtn").addEventListener("click", () => openManual("sell"));
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

  // Auto analyze badge — simple toggle on/off
  $("autoAnalyzeMode")?.addEventListener("click", handleAutoToggle);

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
  $("cancelStrategyEditorBtn")?.addEventListener("click", () => closeFormModal($("strategyEditor")));
  $("saveStrategyBtn")?.addEventListener("click", () => saveStrategyEditor().catch(error => toast(error.message, "error")));
  $("cancelSubscriptionEditorBtn")?.addEventListener("click", () => closeFormModal($("subscriptionEditor")));
  $("saveSubscriptionBtn")?.addEventListener("click", () => saveSubscriptionEditor().catch(error => toast(error.message, "error")));
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
  $("cancelModelProfileBtn")?.addEventListener("click", () => closeFormModal($("modelProfileEditor")));
  $("saveModelProfileBtn")?.addEventListener("click", () => saveModelProfile().catch(error => toast(localizeReason(error.message), "error")));
  $("savePlatformPolicyBtn")?.addEventListener("click", () => savePlatformPolicy().catch(error => toast(error.message, "error")));
  $("saveUserFeatureFlagsBtn")?.addEventListener("click", () => saveUserFeatureFlags().catch(error => toast(error.message, "error")));
  $("positionProtectionClose")?.addEventListener("click", () => {
    stopPositionProtectionPolling();
    closeFormModal($("positionProtectionModal"));
  });
  $("positionProtectionSubmit")?.addEventListener("click", submitPositionProtectionJob);
  $("positionProtectionRetry")?.addEventListener("click", retryPositionProtectionJob);
  $("positionProtectionSyncScope")?.addEventListener("change", async event => {
    const ticket = $("positionProtectionTicket")?.value;
    if (!ticket) return;
    event.target.disabled = true;
    try { await loadPositionProtectionPreview(ticket, event.target.checked ? "signal" : "source_only"); }
    catch (error) {
      event.target.checked = !event.target.checked;
      toast(error.message, "error");
    } finally { event.target.disabled = !state.positionProtectionPreview?.sync_available; }
  });
  $("memoryEnabled")?.addEventListener("change", async event => {
    try { await api("/api/ai/memory/settings", { method:"PUT", body:{ enabled:event.target.checked, runtime_token_budget:800 } }); toast(event.target.checked ? "个人记忆已启用" : "个人记忆已关闭", "success"); }
    catch (error) { event.target.checked = !event.target.checked; toast(error.message, "error"); }
  });
  $("profileProvider")?.addEventListener("change", event => {
    const preset = PROVIDER_PRESETS[event.target.value]; if (!preset) return;
    $("profileBaseUrl").value = preset.url; if (preset.models?.[0]) $("profileModelName").value = preset.models[0];
    updateModelProviderHelp(event.target.value);
  });
  document.querySelectorAll(".form-modal").forEach(modal => {
    modal.addEventListener("keydown", handleFormModalKeydown);
    modal.addEventListener("click", event => { if (event.target === modal) closeFormModal(modal); });
  });
  document.querySelectorAll("[data-review-filter]").forEach(button => button.addEventListener("click", () => {
    document.querySelectorAll("[data-review-filter]").forEach(item => {
      const selected = item === button;
      item.classList.toggle("active", selected);
      item.setAttribute("aria-selected", String(selected));
      item.tabIndex = selected ? 0 : -1;
    });
    state.reviewFilter = button.dataset.reviewFilter; renderReviewCases();
  }));
  document.querySelectorAll("[data-review-period]").forEach(button => button.addEventListener("click", () => {
    document.querySelectorAll("[data-review-period]").forEach(item => {
      const selected = item === button;
      item.classList.toggle("active", selected);
      item.setAttribute("aria-selected", String(selected));
      item.tabIndex = selected ? 0 : -1;
    });
    state.reviewPeriodFilter = button.dataset.reviewPeriod; state.selectedReviewId = null;
    loadReviewMemory().catch(error => toast(error.message,"error"));
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
  });
  // Timeframe checkbox change → update confirm text
  // (removed old modal handlers)

  document.querySelectorAll(".nav-item").forEach((button) => {
    if (button.dataset.tab) {
      button.addEventListener("click", () => setTab(button.dataset.tab));
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
    const memoryAction = event.target.closest("[data-memory-action]");
    const memoryTier = event.target.closest("[data-memory-tier]");
    const platformExperienceAction = event.target.closest("[data-platform-experience-action]");
    const platformPolicySave = event.target.closest("[data-platform-policy-save]");
    const riskSave = event.target.closest("[data-risk-save]");
    const killSwitch = event.target.closest("[data-kill-switch]");
    const strategyAction = event.target.closest("[data-strategy-action]");
    const subscriptionAction = event.target.closest("[data-subscription-action]");
    const openWorkspaceTab = event.target.closest("[data-open-workspace-tab]");
    const positionManagementDetail = event.target.closest("[data-position-management-id]");

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

    if (memoryTier) {
      state.memoryTierFilter = memoryTier.dataset.memoryTier || "all";
      renderCachedMemoryWorkspace();
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
        else if (modelAction.dataset.modelAction === "test") { modelAction.disabled = true; const data = await api(`/api/ai/model-profiles/${id}/test`, { method:"POST", body:{ scope } }); toast(`连接成功 · ${data.latency_ms} ms`, "success"); }
        else if (modelAction.dataset.modelAction === "default") { await api(`/api/ai/model-profiles/${id}/default`, { method:"POST", body:{ scope } }); toast("默认模型已更新", "success"); await loadModelManagement(); }
        else if (modelAction.dataset.modelAction === "delete") {
          modelAction.disabled = true;
          const { impact } = await api(`/api/ai/model-profiles/${id}/delete-impact?scope=${scope}`);
          if (!impact.can_delete) {
            const strategyNames = (impact.strategies || []).map(item => item.title).filter(Boolean);
            const reason = impact.is_default
              ? "该模型当前是默认模型，请先设置另一个默认模型。"
              : `该模型仍被 ${strategyNames.length} 个策略绑定，请先在策略中更换模型。`;
            await showConfirm("暂时无法删除模型", reason, {
              confirmText:"知道了", cancelText:"关闭",
              detailRows:[
                ["模型", impact.model_name || `#${impact.id}`],
                ["默认模型", impact.is_default ? "是" : "否", impact.is_default ? "danger" : ""],
                ["绑定策略", strategyNames.length ? strategyNames.join("、") : "无", strategyNames.length ? "danger" : ""],
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
      } catch (error) { toast(localizeReason(error.message),"error"); } finally { modelAction.disabled = false; }
      return;
    }
    if (reviewCase) { openPeriodReviewDetail(Number(reviewCase.dataset.reviewId)).catch(error => toast(error.message,"error")); return; }
    if (reviewAction) {
      const caseId = state.selectedReviewId, versionId = Number(reviewAction.dataset.versionId || 0), action = reviewAction.dataset.reviewAction;
      if (action === "back-list") {
        document.querySelector(".period-review-layout")?.classList.remove("has-mobile-detail");
        document.querySelector(".review-queue")?.scrollIntoView({ behavior:"smooth", block:"start" });
        return;
      }
      try {
        if (action === "retry") {
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
    if (memoryAction) {
      try {
        const action = memoryAction.dataset.memoryAction;
        const id = Number(memoryAction.dataset.memoryId);
        const endpoint = action === "confirm-long" ? `/api/ai/memory/long/${id}/confirm`
          : action === "revoke-long" ? `/api/ai/memory/long/${id}/revoke`
            : `/api/ai/memory/${id}/${action}`;
        memoryAction.disabled = true;
        await api(endpoint, { method:"POST" });
        toast(action === "confirm-long" ? "已加入长期记忆" : "记忆状态已更新", "success");
        await loadReviewMemory();
      }
      catch (error) { toast(error.message,"error"); } return;
    }
    if (platformExperienceAction) {
      try {
        const itemId = Number(platformExperienceAction.dataset.platformExperienceId);
        const action = platformExperienceAction.dataset.platformExperienceAction;
        if (action === "delete") {
          const confirmed = await showConfirm("永久删除已撤销记忆", `平台记忆 #${itemId} 将从归档中永久删除，且无法恢复。`, { confirmText:"永久删除", danger:true });
          if (!confirmed) return;
          await api(`/api/ai/admin/platform-experience/${itemId}`, { method:"DELETE" });
          toast("已撤销记忆已永久删除", "success");
        } else {
          await api(`/api/ai/admin/platform-experience/${itemId}/${action}`, { method:"POST" });
          toast(action === "publish" ? "平台记忆已发布" : "平台记忆已撤销", "success");
        }
        await loadReviewMemory();
      } catch (error) { toast(error.message, "error"); }
      return;
    }
    if (platformPolicySave) {
      const row = platformPolicySave.closest("[data-platform-policy-strategy]");
      try {
        platformPolicySave.disabled = true;
        await api(`/api/ai/admin/platform-experience/policies/${Number(row.dataset.platformPolicyStrategy)}`, { method:"PUT", body:{
          mode:row.querySelector("[data-platform-policy-mode]").value,
          max_items:Number(row.querySelector("[data-platform-policy-items]").value),
          runtime_token_budget:Number(row.querySelector("[data-platform-policy-budget]").value),
        } });
        toast("平台记忆运行模式已保存", "success");
        await loadReviewMemory();
      } catch (error) { toast(error.message, "error"); }
      finally { platformPolicySave.disabled = false; }
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
        state.historyFilters.page = page;
        loadHistory();
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
        "refresh-signals": loadSignals,
        "refresh-analysis-history": loadSignals,
        "refresh-history": loadHistory,
        "refresh-trading-page": refreshTradingPage,
        "refresh-history-page": refreshHistoryPage,
        "refresh-audit": loadAudit,
        "export-history": exportHistory,
        "refresh-risk-center": loadRiskCenter,
        "refresh-review-memory": loadReviewMemory,
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
  document.getElementById('historyRangeMode')?.addEventListener('change', updateHistoryRangeUI);
  document.getElementById('historyRangeApply')?.addEventListener('click', () => {
    try { getHistoryRangeParams(); }
    catch (error) { toast(error.message, 'error'); return; }
    state.historyFilters.page = 1;
    _historyCache = null;
    _historyChartCache = null;
    Promise.allSettled([loadHistory(true), loadHistoryChart(true)]);
  });
  updateHistoryRangeUI();
  // Table filters further narrow trade rows inside the selected history scope.
  document.getElementById('historyFilterApply')?.addEventListener('click', () => {
    state.historyFilters.page = 1;
    _historyCache = null;
    loadHistory(true);
  });
  document.getElementById('historyFilterReset')?.addEventListener('click', () => {
    ['filterEntryFrom','filterEntryTo'].forEach(id => { const el = document.getElementById(id); if (el) el.value = ''; });
    ['filterDirection','filterProfit'].forEach(id => { const el = document.getElementById(id); if (el) el.selectedIndex = 0; });
    state.historyFilters.page = 1;
    _historyCache = null;
    loadHistory(true);
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

// --- Changelog Modal ---
function sanitizeHtml(html) {
  const div = document.createElement('div');
  div.innerHTML = html;
  div.querySelectorAll('script, iframe, object, embed, form, input, textarea, select, svg, math, meta, link, base, button').forEach(el => el.remove());
  div.querySelectorAll('*').forEach(el => {
    for (const attr of [...el.attributes]) {
      if (/^on/i.test(attr.name) || attr.value.trim().toLowerCase().startsWith('javascript:')) {
        el.removeAttribute(attr.name);
      }
    }
  });
  return div.innerHTML;
}

async function checkChangelog() {
  try {
    const [current, status] = await Promise.all([
      api('/api/changelog/current'),
      api('/api/changelog-status')
    ]);
    if (current.ok && status.ok && current.version > (status.seenVersion || 0) && current.content) {
      document.getElementById('changelogContent').innerHTML = sanitizeHtml(current.content);
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
