function getCookie(name) {
  const match = document.cookie.match(new RegExp('(?:^|; )' + name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '=([^;]*)'))
  return match ? decodeURIComponent(match[1]) : ''
}

const state = {
  token: localStorage.getItem("authToken") || getCookie("ws_token") || "",
  user: null,
  symbols: [],
  signals: [],
  selectedSignal: null,
  _lastGatewayLive: false,
  backgroundSyncTimer: null,
  lastQuote: null,
  currentConfigHasApiKey: false,
  pendingManualOrder: null,
  accountBalance: 0,
  historyNetResult: 0,

  auditRows: [],
  signalTableData: [],
  signalTableTotal: 0,
  signalFilters: { direction: "", timeframe: "", page: 1, pageSize: 20 },
  historyFilters: { page: 1, pageSize: 20 },
  auditFilters: { status: "", type: "", page: 1, pageSize: 25 },
  executionFilters: { page: 1, pageSize: 5, total: 0 },
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
  selectedReviewId: null,
  globalRiskSnapshot: null,
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

// ===== Global Symbol Management =====
const SYMBOL_STORAGE_KEY = "aurum_selected_symbol";
const _symSelectors = []; // registered selector IDs

function getGlobalSymbol() {
  return localStorage.getItem(SYMBOL_STORAGE_KEY) || "XAUUSD";
}

function setGlobalSymbol(symbol) {
  localStorage.setItem(SYMBOL_STORAGE_KEY, symbol);
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
  const isPlusReadOnly = state.isPlusReadOnly;
  const isPro = state.user?.plan === 'pro' || state.user?.role === 'admin';
  const isProNoBridge = isPro && state.user?.role !== 'admin' && state._usingFallback;
  const isObserveMode = isPlusReadOnly || isProNoBridge;
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
  hold_signal_cannot_execute: "已跳过（HOLD 信号）",
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
  signal_price_slippage_exceeded: "信号价与当前价滑点超限，已拒绝",
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
  return String(value).replace("T", " ").slice(0, 19);
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
  // Preserve clickable-badge class if present
  const extra = el.classList.contains("clickable-badge") ? " clickable-badge" : "";
  el.className = `status-badge status-${type}${extra}`;
  el.innerHTML = `${withDot ? '<span class="badge-dot"></span>' : ""}${escapeHtml(text)}`;
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
  redis_lock_failed: '调度锁获取失败',
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
    track.setAttribute('aria-label', '自动推理进度');
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
  const newClass = `status-badge status-${type} clickable-badge auto-runtime-control${modeClass}`;
  if (el.className !== newClass) el.className = newClass;
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
  el.style.setProperty('--auto-progress', `${progress}%`);
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
  const label = count > 1 ? `${count} 个品种推理中` : `${primary?.symbol || '自动推理'} · ${primary?.stage_label || '正在处理'}`;
  const elapsed = autoProgressElapsed(primary?.started_at);
  const stage = count > 1
    ? `${symbols.slice(0, 3).join(' · ')}${symbols.length > 3 ? ` 等 ${symbols.length} 项` : ''}${elapsed ? ` · ${elapsed}` : ''}`
    : `已用时 ${elapsed || '00:00'}`;
  const details = cycles.map(cycle => `${cycle.symbol || '未知品种'}：${cycle.stage_label || '正在处理'} ${Math.round(Number(cycle.progress_percent || 0))}%`).join('\n');
  const title = `策略：${ptName || '未选择'}\n状态：正在推理\n${details}\n点击可停止后续自动推理`;
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
    const flashLabel = success ? `${flash.symbol || '自动推理'} · 推理完成` : `${flash.symbol || '自动推理'} · 推理未完成`;
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
    label = '自动推理关闭';
    type = 'neutral';
    title = '状态：自动推理关闭';
  } else if (s.paused_reason === 'weekly_flatten_window') {
    label = '自动推理暂停 · 周末清仓';
    type = 'warning';
    title = `策略：${ptName || '未选择'}\n品种：${symbolsStr}\n状态：周末清仓期间暂停`;
  } else if (s.in_flight) {
    const stageLabel = s.stage_label || (s.stage === 'running' ? '正在推理' : '调度中');
    renderAutoProgress([{
      cycle_id: 'runtime-fallback', symbol: symbols[0] || '', stage: s.stage || 'running',
      stage_label: stageLabel, progress_percent: Number(s.progress_percent || 46),
      progress_seq: 0, started_at: s.cycle_started_at || '',
    }], ptName);
    return;
  } else if (s.paused_reason && isMarketClosedReason(s.paused_reason)) {
    label = '自动推理暂停 · 休市';
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
    label = `自动推理开启 · 下次 ${countdown}`;
    type = 'active';
    title = `策略：${ptName || '未选择'}\n品种：${symbolsStr}\n状态：开启\n下次运行：等待倒计时结束`;
    if (s.paused_reason) title += `\n内部状态：${autoReasonText(s.paused_reason)}`;
    if (s.market_state) title += `\n市场状态：${autoReasonText(s.market_state.reason)}`;
  } else {
    label = '自动推理开启';
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
  if (text.startsWith("Invalid live quote for ")) {
    return `${text.replace("Invalid live quote for ", "")} 报价无效，已阻止下单`;
  }
  return text;
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
  setText("sigVolume", volumeText(signal?.recommended_volume));
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
  const dirLabel = dir.toUpperCase() + " " + directionText(signal.signal_type);
  const node = document.createElement("div");
  node.className = "toast signal-notification";
  const conf = typeof signal.confidence === 'number' ? (signal.confidence > 1 ? signal.confidence : signal.confidence * 100) : 0;
  node.innerHTML = `<div class="notif-header">🔔 新信号</div><div class="notif-body"><span class="notif-symbol">${escapeHtml(signal.symbol)}</span> <span class="notif-dir tag ${dir}">${dirLabel}</span> <span class="notif-tf">${escapeHtml(signal.timeframe)}</span> <span class="notif-conf">${conf.toFixed(0)}%</span></div>`;
  node.style.cursor = "pointer";
  node.onclick = () => {
    node.remove();
    openAnalysisFromHistory(signal.id);
    setTab("ai-analyze");
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
  no_model_configured: "尚未配置可用模型，请先在“模型策略 → 模型管理”中添加模型",
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
  admin_only: "仅管理员可以使用此功能",
  "symbol required": "请选择交易品种",
  "timeframe required": "请选择 K 线周期",
  "strategy required": "请选择推理策略",
  "start_time and end_time required": "请选择完整的开始和结束时间",
  "model_ids must be an array of 2-5 model profile IDs": "请选择 2 至 5 个模型",
  "model_ids must contain 2-5 unique IDs": "请选择 2 至 5 个不同模型",
  invalid_history_time_range: "历史评估时间范围无效",
  history_market_data_unavailable: "历史行情暂不可用，请确认桥接和行情缓存状态",
  insufficient_kline_data_for_compare: "所选时间范围内的完整 K 线不足",
  history_compare_range_too_large: "所选范围包含超过 5000 根 K 线，请缩短时间范围或使用更大周期",
  timeframe_not_supported_by_strategy: "所选周期不在该策略的行情数据方案中",
  symbol_not_supported_by_strategy: "所选品种不在该策略支持范围内",
  history_compare_job_not_created: "历史模型对比任务创建失败",
  history_compare_job_not_found: "历史模型对比任务不存在或已过期",
  history_compare_failed: "历史模型对比执行失败",
  history_compare_cancelled: "历史模型对比已取消",
};

function apiErrorMessage(code) {
  if (String(code).startsWith('active_subscription_conflict:')) return '已有其他策略启用自动推理，请先关闭原订阅或确认切换';
  return API_ERROR_MESSAGES[code] || code;
}

async function api(path, options = {}) {
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
    if (!response.ok) throw new Error(apiErrorMessage(data.error || data.detail || data.message || `HTTP ${response.status}`));
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
    const ws = state.bridgeWs;
    if (!ws || ws.readyState !== 1) return reject(new Error('WebSocket未连接'));
    const cmdId = `ws_${++_wsCmdId}`;
    // analyze/auto-inference may take 60-120s
    const requestParams = { ...params };
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

// Real-time bridge status via WebSocket + command channel


function connectBridgeStatusWs(onReady) {
  if (state.bridgeWs && state.bridgeWs.readyState <= 1) {
    if (typeof onReady === 'function') onReady();
    return;
  }
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const url = `${proto}//${location.host}/aurum-api/bridge/ws?type=browser&token=${encodeURIComponent(state.token)}`;
  const ws = new WebSocket(url);
  state.bridgeWs = ws;
  let _readyFired = false;
  const _fireReady = () => { if (!_readyFired && typeof onReady === 'function') { _readyFired = true; onReady(); } };
  ws.onopen = () => {
    state._reconnectAttempts = 0; // reset backoff on successful connection

    state._hbSeq = 0;
    if (state._hbTimer) clearInterval(state._hbTimer);
    state._hbTimer = setInterval(() => {
      if (ws.readyState === 1) {
        try { ws.send(JSON.stringify({ type: 'hb', seq: ++state._hbSeq })); } catch {}
      }
    }, 30000);
    _fireReady();
  };
  ws.onmessage = (e) => {
    try {
      const msg = JSON.parse(e.data);
      if (msg.type === 'platform_market_tick') {
        const quote = msg.quote || {};
        if (Number.isFinite(Number(quote.timezone_offset_minutes))) state.mt5TimezoneOffsetMinutes = Number(quote.timezone_offset_minutes);
        const selected = String($("quoteSymbolSelect")?.value || $("tradeSymbolSelect")?.value || getGlobalSymbol()).toUpperCase();
        const brokerSymbol = String(quote.symbol || '').toUpperCase();
        if (brokerSymbol && (brokerSymbol === selected || brokerSymbol.startsWith(selected)) &&
            Number.isFinite(Number(quote.bid)) && Number.isFinite(Number(quote.ask))) {
          updateKlineTick(Number(quote.bid), Number(quote.ask), quote);
        }
      } else if (msg.type === 'data') {
        handleBridgeData(msg);
      } else if (msg.type === 'hb') {
        handleHeartbeat(msg);
      } else if (msg.type === 'disconnect') {
        handleDisconnect(msg);
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
        loadSignals().catch(() => {});
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
    0: ['closed', '休市', 'neutral', '休市 - 该品种已收盘，自动推理已暂停'],
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
    if (Number.isFinite(Number(q.timezone_offset_minutes))) state.mt5TimezoneOffsetMinutes = Number(q.timezone_offset_minutes);
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
      setText("quoteBid", q.bid);
      setText("quoteAsk", q.ask);
      setText("quoteSpread", q.spread);
      setText("quoteTime", formatTime(q.time));
      setText("mt5ServerTime", formatTime(q.time).split(" ").pop() || "--");
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

// UI-only timer: refresh signal timing displays every second (no network calls)
let _statusRefreshCounter = 0;
let _uiTimerInterval = null;

function startUiTimer() {
  if (_uiTimerInterval) return;
  _uiTimerInterval = setInterval(() => {
    const s = state.selectedSignal;
    if (s) {
      setText("sigValidWindow", signalFreshness(s));
      setText("signalFreshness", signalFreshness(s));
      setText("analysisValidity", signalFreshness(s));
      setSignalBadge(s);
      const stale = signalIsStale(s) && !s.is_executed;
      const signalCard = $("signalCard");
      if (stale && signalCard?.dataset.status !== "expired") {
        signalCard.dataset.status = "expired";
        updateSignalPriceFields(s);
      }
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
  if (document.hidden) { stopUiTimer(); } else { startUiTimer(); }
});

startUiTimer();

async function _maybeRefreshSignal() {
  const now = Date.now();
  if (now - _lastSignalRefreshTs < 1000) return;
  _lastSignalRefreshTs = now;
  try {
    // Lightweight check: only fetch latest signal's ID + minimal fields (~200 bytes)
    const data = await wsApi("signals_latest_id", {});
    const latest = data.signal || null;

    if (!latest) {
      if (_lastSignalId !== null) { updateSignalDisplay(null); _lastSignalId = null; state.selectedSignal = null; state.signals = []; renderAnalysisHistory([]); renderSignalRows(); }
      return;
    }

    // ID unchanged — UI timer handles timing display, nothing to do
    if (latest.id === _lastSignalId) return;

    // New signal detected — reuse the known-good click handler
    _lastSignalId = latest.id;

    // CLOSE signal → invalidate history cache (new closed order)
    if (latest.signal_type === 'close') {
      _historyCache = null;
      _historyChartCache = null;
    }

    await loadSignals({ skipResultRender:true, selectLatest:true });
    if (state.selectedSignal) {
      showSignalNotification(state.selectedSignal);
      if (activeTabId() === "ai-analyze") {
        openAnalysisFromHistory(state.selectedSignal.id);
        const firstItem = document.querySelector(".analysis-history-item");
        if (firstItem) firstItem.scrollIntoView({ behavior: "smooth", block: "nearest" });
      }
    }
  } catch (e) { console.error('[Inference] latest signal refresh failed:', e); }
}

// Handle new signal pushed from server (replaces polling)
async function handleNewSignal(msg) {
  try {
    if (msg.signal_id != null) _lastSignalId = msg.signal_id;
    // Refresh signal list
    await loadSignals({ skipResultRender:true, selectLatest:true });

    // Show notification for new signal
    if (state.selectedSignal) {
      showSignalNotification(state.selectedSignal);
      if (activeTabId() === "ai-analyze") {
        openAnalysisFromHistory(state.selectedSignal.id);
        const firstItem = document.querySelector(".analysis-history-item");
        if (firstItem) firstItem.scrollIntoView({ behavior: "smooth", block: "nearest" });
      }
    }
  } catch (e) { console.error('[Inference] pushed signal refresh failed:', e); }
}

// Handle heartbeat reply — MT5 connection status
function handleHeartbeat(msg) {
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
    setBadge("gatewayMode", isLive ? "MT5桥接-已连接" : "未连接-请启动桥接脚本", isLive ? "connected" : "neutral");
  }

  // Update market status from heartbeat
  if (typeof msg.trade_mode === 'number') updateMarketStatus(msg.trade_mode);

  // Update trade badge from heartbeat data (bridge just connected/state changed)
  // Note: tradeMode 1-3 are partial trading modes, not "closed"
  if (typeof msg.trade_enabled === 'boolean') {
    const tradeText = msg.trade_enabled ? "交易发送开启" : "交易发送关闭";
    setBadge("tradeMode", tradeText, msg.trade_enabled ? "danger" : "neutral");
  } else if (!isLive && !usingFallback) {
    setBadge("tradeMode", "请先启动桥接", "neutral");
  }

  // Update auto badge from heartbeat data
  if (typeof msg.auto_reasoning_enabled === 'boolean') {
    state.autoEnabled = msg.auto_reasoning_enabled;
    // Use renderAutoAnalyzeBadge for consistent display
    if (state.autoRuntime) {
      state.autoRuntime.enabled = msg.auto_reasoning_enabled;
      renderAutoAnalyzeBadge(state.autoRuntime);
    } else if (!msg.auto_reasoning_enabled) {
      setBadge("autoAnalyzeMode", "自动推理关闭", "neutral");
    }
  }

  state._lastGatewayLive = isLive;
  state._lastUsingFallback = usingFallback;

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
  setBadge("gatewayMode", "未连接-请启动桥接脚本", "neutral");
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
      ? "开放平台按量计费，适合正式自动推理与客户使用。"
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
    host.innerHTML = '<div class="workspace-panel empty-state"><strong>还没有可用模型</strong><span>添加一个自己的模型；若管理员已开放共享，也可由系统按用途自动选用平台模型。</span></div>';
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
  setText("modelEffectiveSource", "正在解析…");
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
  $("shareForManual").checked = Boolean(policy.share_for_manual); $("shareForAuto").checked = Boolean(policy.share_for_auto);
  $("shareForReview").checked = Boolean(policy.share_for_review); $("shareForCompression").checked = Boolean(policy.share_for_memory_compression);
  $("policyDailyRequests").value = policy.daily_requests_per_user || 100; $("policyDailyTokens").value = policy.daily_tokens_per_user || 500000;
  const shareControls = [$("shareForManual"), $("shareForAuto"), $("shareForReview"), $("shareForCompression")].filter(Boolean);
  const hasShareableModel = state.modelProfiles.some(profile => profile.status === "active" && profile.has_api_key && profile.share_eligible !== false);
  shareControls.forEach(control => { control.disabled = !hasShareableModel; });
  const sharingNotice = $("platformSharingProviderNotice");
  if (sharingNotice) sharingNotice.textContent = hasShareableModel
    ? "当前默认平台模型可按上方用途选择是否共享；Kimi Code 订阅也遵循相同设置。"
    : "当前没有已启用且已保存凭据的平台模型，暂时无法开启共享。";
}

async function savePlatformPolicy() {
  await api("/api/ai/platform-model-policy", { method: "PUT", body: { share_for_manual: $("shareForManual").checked, share_for_auto: $("shareForAuto").checked, share_for_review: $("shareForReview").checked, share_for_memory_compression: $("shareForCompression").checked, allowed_plans: ["pro"], daily_requests_per_user: Number($("policyDailyRequests").value), daily_tokens_per_user: Number($("policyDailyTokens").value) } });
  toast("平台共享策略已保存", "success");
}

async function loadStrategyCatalog() {
  const host = $("strategyCatalog");
  if (!host) return;
  const data = await api(`/api/ai/strategies${state.user?.role === 'admin' ? '?include_inactive=1' : ''}`);
  const items = data.strategies || [];
  const subscriptions = data.subscriptions || [];
  state.strategies = items; state.strategySubscriptions = subscriptions; state.tradingAccounts = data.accounts || [];
  const summary = $("strategyCatalogSummary");
  if (summary) {
    const active = items.filter(item => item.visibility_status === "active" && Number(item.is_active)).length;
    const privateCount = items.filter(item => item.scope === "private").length;
    summary.textContent = `${items.length} 个策略 · ${active} 个可用${privateCount ? ` · ${privateCount} 个私有` : ""}`;
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
    const memory = item.scope === "private" ? "个人记忆可用" : "平台共享 · 禁止个人记忆";
    const linked = subscriptions.filter(sub => Number(sub.strategy_id) === Number(item.id));
    const execution = linked.length ? `${linked.filter(sub => Number(sub.execution_enabled)).length}/${linked.length} 个订阅启用` : "未订阅";
    const memoryMode = linked.some(sub => sub.memory_mode === "disabled") ? "部分订阅关闭记忆" : memory;
    const canEdit = (item.scope === 'private' && Number(item.owner_user_id) === Number(state.user?.id)) || (item.scope === 'platform' && state.user?.role === 'admin');
    const subRows = linked.map(sub => `<div class="subscription-row"><div class="subscription-row-info"><strong>账户 #${sub.trading_account_id}</strong><span>订阅 #${sub.id} · ${sub.execution_enabled ? '自动推理已启用' : '自动推理未启用'} · ${escapeHtml(subscriptionTakeProfitModeLabel(sub.take_profit_mode))} · ${escapeHtml(subscriptionScheduleSummary(sub))} · ${escapeHtml(subscriptionMemoryModeLabel(sub.memory_mode))}</span></div><div class="subscription-row-actions"><button class="btn btn-secondary btn-sm" data-subscription-action="edit" data-subscription-id="${sub.id}"><i data-lucide="settings-2" size="14"></i>编辑</button><button class="btn btn-danger-ghost btn-sm" data-subscription-action="delete" data-subscription-id="${sub.id}"><i data-lucide="trash-2" size="14"></i>删除</button></div></div>`).join("");
    const primarySubscription = linked.find(sub => Number(sub.execution_enabled)) || linked[0];
    const subscriptionButton = primarySubscription
      ? `<button class="btn btn-primary btn-sm" data-subscription-action="edit" data-subscription-id="${primarySubscription.id}"><i data-lucide="settings-2" size="14"></i>编辑订阅</button>`
      : '<button class="btn btn-primary btn-sm" data-strategy-action="subscribe"><i data-lucide="play" size="14"></i>订阅与运行</button>';
    const canSubscribe = item.scope === 'platform' || Number(item.owner_user_id) === Number(state.user?.id);
    const visibilityLabel = ({ active:"上线", draft:"草稿", archived:"归档" })[item.visibility_status] || item.visibility_status;
    const subscriptionsBlock = linked.length ? `<section class="strategy-subscriptions"><div class="strategy-subscriptions-head"><span><i data-lucide="radio-tower" size="15"></i>执行订阅</span><small>${linked.length} 个</small></div>${subRows}</section>` : '<div class="quiet-empty">还没有执行订阅</div>';
    const description = item.description || (item.scope === "private" ? "我的自定义分析策略" : "平台提供的分析策略");
    return `<article class="strategy-card ${item.scope === 'private' ? 'is-private' : 'is-platform'}" data-strategy-id="${Number(item.id)}"><header class="strategy-card-header"><div><div class="workspace-row-title">${escapeHtml(item.title)} <span class="status-chip ${item.scope === 'private' ? 'info' : ''}">${item.scope === 'private' ? '我的策略' : '平台策略'}</span><span class="status-chip ${item.visibility_status === 'active' ? 'success' : 'warning'}">${escapeHtml(visibilityLabel)}</span></div><p class="strategy-card-description">${escapeHtml(description)}</p></div><div class="strategy-card-actions">${canSubscribe ? subscriptionButton : '<span class="status-chip">仅审计可见</span>'}${canEdit ? '<button class="btn btn-secondary btn-sm" data-strategy-action="edit"><i data-lucide="pencil" size="14"></i>编辑</button><button class="btn btn-danger-ghost btn-sm" data-strategy-action="delete" aria-label="删除策略"><i data-lucide="trash-2" size="14"></i></button>' : ''}</div></header><div class="strategy-essentials"><span><small>支持品种</small><strong>${symbols.slice(0,4).map(escapeHtml).join('、') || '未设置'}${symbols.length > 4 ? ` 等 ${symbols.length} 个` : ''}</strong></span><span><small>主要行情</small><strong>${escapeHtml(plan.primary_timeframe || plan.timeframes?.[0]?.timeframe || 'M30')} · ${Number(plan.timeframes?.find(row => row.timeframe === plan.primary_timeframe)?.kline_count || plan.timeframes?.[0]?.kline_count || 100)} 根</strong></span><span><small>模型</small><strong>${escapeHtml(source)}</strong></span><span class="${linked.some(sub => Number(sub.execution_enabled)) ? 'running' : ''}"><small>自动运行</small><strong>${escapeHtml(execution)}</strong></span></div><details class="strategy-details"><summary><span>查看策略详情与订阅</span><i data-lucide="chevron-down" size="15"></i></summary><div class="strategy-details-body"><div class="strategy-specs"><span><small>完整行情计划</small><strong>${escapeHtml(planText)}</strong></span><span><small>技术分析</small><strong>${escapeHtml(chanText)}</strong></span><span><small>允许入场</small><strong>${escapeHtml(entryText)}</strong></span><span><small>账户上下文</small><strong>${escapeHtml(portfolioText)}</strong></span><span><small>记忆方式</small><strong>${escapeHtml(memoryMode)}</strong></span></div>${subscriptionsBlock}</div></details></article>`;
  }).join("") : '<div class="empty-state"><strong>当前筛选下没有策略</strong><span>切换筛选条件，或新建一套自己的推理策略。</span></div>';
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
  if (help) help.textContent = platform ? "可绑定一个平台模型用于自动推理；留空时使用平台默认模型。" : "可绑定自己的模型；留空时按模型管理中的默认与共享规则解析。";
}

function openStrategyEditor(strategy = null) {
  const editor = $("strategyEditor"); editor.dataset.strategyId = strategy?.id || "";
  const admin = state.user?.role === "admin";
  $("strategyEditorTitle").textContent = strategy ? "编辑策略" : (admin ? "新建策略" : "新建自定义策略");
  $("strategyEditorBoundary").textContent = admin ? "平台策略对所有合资格用户可见；他人私有策略只允许审计查看，不能代替用户修改或执行。" : "你创建的私有策略仅自己可见、可选和执行。";
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
  $("strategyIncludePortfolioContext").checked = !admin && Boolean(Number(strategy?.include_portfolio_context || 0));
  $("strategyPortfolioContextField")?.classList.toggle("hidden", admin);
  if (admin) {
    $("strategyScope").value = "platform";
    $("strategyScopeField")?.classList.add("is-readonly");
    const scopeHelp = $("strategyScopeHelp");
    if (scopeHelp) scopeHelp.textContent = "管理员只维护平台策略；管理员账户不建立私有策略或个人记忆。";
    $("strategyVisibility").value = strategy?.visibility_status || "active";
    $("strategyVisibilityField").style.display = "";
  }
  const scope = strategy?.scope || (admin ? $("strategyScope").value : "private");
  renderStrategyModelOptions(scope, strategy?.model_profile_id || "");
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
  const scope = state.user?.role === "admin" ? "platform" : "private";
  const visibilityStatus = state.user?.role === "admin" && scope === "platform" ? $("strategyVisibility").value : "active";
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
  if (!state.tradingAccounts?.length) { toast("请先连接交易桥并完成账户登记", "warning"); return; }
  const editor = $("subscriptionEditor"); editor.dataset.strategyId = strategy.id; editor.dataset.subscriptionId = subscription?.id || "";
  $("subscriptionAccount").innerHTML = state.tradingAccounts.map(account => `<option value="${Number(account.id)}">${escapeHtml(account.nickname || account.login_account)} · ${escapeHtml(account.broker_server)}</option>`).join("");
  $("subscriptionAccount").value = subscription?.trading_account_id || state.tradingAccounts[0].id;
  populateSubscriptionSymbolOptions(strategy, subscription);
  $("subscriptionSymbolsDropdown").open = false;
  const isPrivate = strategy.scope === "private";
  $("subscriptionMemoryModeField")?.classList.toggle("hidden", !isPrivate);
  $("platformMemoryNotice")?.classList.toggle("hidden", isPrivate);
  $("subscriptionMemoryMode").value = isPrivate ? (subscription?.memory_mode || "personal") : "personal";
  $("subscriptionExecutionEnabled").checked = Boolean(subscription?.execution_enabled);
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
    replaceActive = confirm(`当前已有“${otherActive.strategy_title || `订阅 #${otherActive.id}`}”在自动推理。是否关闭原订阅并切换到当前策略？`);
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
  allowed_symbols:"允许交易品种", require_stop_loss:"强制止损", sl_atr_min:"最小止损距离", sl_atr_max:"最大止损距离", min_rr:"最低盈亏比",
  pending_price_deviation_pct:"挂单价格偏离百分比", pending_price_deviation_atr:"挂单价格偏离 ATR", pending_valid_minutes:"挂单有效期",
  ai_volume_min:"AI 建议最小手数", ai_volume_max:"AI 建议最大手数", ai_volume_step:"AI 建议手数步进", max_position_size:"账户单笔最大手数", max_risk_per_trade_pct:"单笔最大风险",
  signal_ttl_seconds:"信号有效期", max_quote_age_seconds:"报价最大年龄", max_spread_points:"最大点差", market_signal_drift_atr:"市价信号漂移", broker_slippage_points:"成交滑点", weekend_close_minutes:"MT5周末收盘提前量",
  max_directional_exposure_lots:"同向最大敞口", min_open_interval_seconds:"最小开仓间隔", max_daily_open_count:"每日开仓次数", dedup_window_seconds:"重复订单时间窗", dedup_price_atr:"重复订单价格距离",
  daily_loss_limit_pct:"每日最大亏损", consecutive_loss_limit:"连续亏损次数", loss_cooldown_minutes:"连续亏损冷却", max_drawdown_pct:"最大回撤", min_margin_level_pct:"最低保证金水平", max_notional_exposure_pct:"最大名义敞口",
  observation_hours:"新账户观察期", observation_max_lot:"观察期最大手数",
};
const RISK_GROUPS = [
  ["入场与止损", ["require_stop_loss","sl_atr_min","sl_atr_max","min_rr","pending_valid_minutes"]],
  ["手数与单笔风险", ["ai_volume_min","ai_volume_max","ai_volume_step","max_position_size","max_risk_per_trade_pct","observation_max_lot"]],
  ["价格与成交", ["pending_price_deviation_pct","pending_price_deviation_atr","market_signal_drift_atr","broker_slippage_points","max_spread_points","max_quote_age_seconds","signal_ttl_seconds","weekend_close_minutes"]],
  ["频率与敞口", ["max_directional_exposure_lots","min_open_interval_seconds","max_daily_open_count","dedup_window_seconds","dedup_price_atr"]],
  ["亏损与账户保护", ["daily_loss_limit_pct","consecutive_loss_limit","loss_cooldown_minutes","max_drawdown_pct","min_margin_level_pct","max_notional_exposure_pct","observation_hours"]],
];
const RISK_SAFETY_LABELS = {
  lower:"数值越低越严格", higher:"数值越高越严格", subset:"只能缩小允许范围",
  locked:"系统锁定", locked_true:"系统强制开启",
};
const RISK_ROLLOUT_LABELS = {
  ownership:"策略与账户归属校验", entitlement:"会员权限校验",
  kill_switch:"紧急停止开关", data_complete:"风控数据完整性", idempotency:"重复下单幂等保护", volume_bounds:"下单手数硬边界",
  "R1.1_SYMBOL_NOT_ALLOWED":"交易品种白名单", "R1.4_STOP_LOSS_TOO_FAR":"止损距离上限", "R1.5_RR_TOO_LOW":"最低盈亏比",
  "R1.7_PENDING_DEVIATION":"挂单价格偏离", "R2.1_DIRECTIONAL_EXPOSURE":"同向持仓敞口", "R2.2_MIN_OPEN_INTERVAL":"最小开仓间隔",
  "R2.3_DAILY_OPEN_COUNT":"每日开仓次数", "R2.4_PRICE_TIME_DUPLICATE":"重复价格与时间窗口", "R3.1_DAILY_LOSS_LIMIT":"每日亏损上限",
  "R3.2_CONSECUTIVE_LOSS_COOLDOWN":"连续亏损冷却", "R3.2_LOSS_COOLDOWN":"亏损后冷却", "R3.3_MAX_DRAWDOWN":"最大回撤",
  "R3.4_MARGIN_LEVEL":"最低保证金水平", "R3.4_NOTIONAL_EXPOSURE":"最大名义敞口", "R4.2_WEEKEND_PROTECTION":"周末保护",
  "R4.3_SIGNAL_EXPIRED":"信号有效期", "R4.4_QUOTE_STALE":"报价时效", "R4.5_SPREAD_TOO_WIDE":"最大点差", "R4.6_MARKET_SIGNAL_DRIFT":"市价信号漂移",
};
function riskRolloutLabel(code) { return RISK_ROLLOUT_LABELS[code] || "未命名风控规则"; }

const RISK_DECISION_LABELS = {
  "R5_SCHEMA_SYMBOL":"缺少交易品种", "R5_SCHEMA_ORDER_TYPE":"订单方向无效", "R5_SCHEMA_ENTRY_METHOD":"入场方式无效",
  "R5_SCHEMA_AI_REQUIRED":"AI 订单必要字段不完整", "R5_SCHEMA_PENDING_PRICE":"挂单价格无效",
  "R5_SCHEMA_STOP_LIMIT_PRICE":"Stop Limit 触发后限价无效",
  "R1_INSTRUMENT_DATA_INCOMPLETE":"品种交易参数不完整", "R1_SYMBOL_TRADE_DISABLED":"品种当前禁止交易",
  "R1.1_SYMBOL_NOT_ALLOWED":"品种不在允许范围", "R1.2_STOP_LOSS_REQUIRED":"缺少止损",
  "R1.3_SL_WIDEN_VOLUME_DOWN":"扩大止损并同步降低手数", "R1.4_STOP_LOSS_TOO_FAR":"止损距离超过上限",
  "R1.5_TAKE_PROFIT_REQUIRED":"缺少止盈", "R1.5_RR_TOO_LOW":"盈亏比低于最低要求",
  "R1.5_TP_TIER_UPGRADED":"改用满足盈亏比要求的更远止盈档位", "R1.6_SL_TP_DIRECTION":"止损或止盈方向错误",
  "R1.7_PENDING_DEVIATION":"挂单价格偏离当前报价过大", "R1.7_PENDING_DIRECTION":"挂单触发价方向与当前价格关系错误",
  "R1.7_STOP_LIMIT_RELATION":"Stop Limit 触发价与触发后限价关系错误",
  "R1.8_PENDING_TTL_DEFAULT":"使用默认挂单有效期", "R1.9_AI_VOLUME_OUT_OF_RANGE":"AI 建议手数超出平台范围",
  "R1.9_BELOW_MINIMUM_AFTER_RISK":"风险调整后手数低于最小可交易手数", "R1.9_VOLUME_INCREASE_FORBIDDEN":"风控禁止放大 AI 建议手数",
  "R1.9_VOLUME_INVALID":"订单手数无效", "R1.10_RISK_DATA_INVALID":"账户或品种风险数据无效",
  "R1.10_REAL_RISK":"单笔实际风险校验通过", "R4_QUOTE_INVALID":"当前报价无效",
  "R4.2_WEEKEND_PROTECTION":"周末保护时段禁止开仓", "R4.3_SIGNAL_EXPIRED":"推理信号已过期",
  "R4.4_QUOTE_STALE":"MT5 报价已过期或时间异常", "R4.5_SPREAD_TOO_WIDE":"当前点差超过上限",
  "R4.6_MARKET_SIGNAL_DRIFT":"市价偏离推理参考价过大", "R2.1_DIRECTIONAL_EXPOSURE":"同方向持仓敞口超过上限",
  "R2.2_MIN_OPEN_INTERVAL":"距离上次开仓时间过短", "R2.3_DAILY_OPEN_COUNT":"当日开仓次数达到上限",
  "R2.4_PRICE_TIME_DUPLICATE":"检测到重复价格和时间窗口订单", "R3.1_DAILY_LOSS_LIMIT":"达到每日亏损上限",
  "R3.2_CONSECUTIVE_LOSS_COOLDOWN":"连续亏损触发冷却", "R3.2_LOSS_COOLDOWN":"账户仍处于亏损冷却期",
  "R3.3_MAX_DRAWDOWN":"达到最大回撤上限", "R3.4_MARGIN_LEVEL":"保证金水平低于要求",
  "R3.4_NOTIONAL_DATA_INCOMPLETE":"名义敞口数据不完整", "R3.4_NOTIONAL_EXPOSURE":"名义敞口超过上限",
  "R3_ACCOUNT_HALTED":"账户风控已暂停", "R3_RISK_DATA_INCOMPLETE":"账户风险数据不完整",
  "R6_ACCOUNT_NOT_FOUND":"未找到交易账户",
  "R6_ACCOUNT_PAUSED":"交易账户已暂停", "R6_GLOBAL_KILL_SWITCH":"全局紧急停止已开启",
  "R6_USER_KILL_SWITCH":"账户紧急停止已开启", "R6.4_OBSERVATION_BELOW_MINIMUM":"观察期手数低于最小可交易手数",
  "PX.3_BROKER_SLIPPAGE":"已应用经纪商滑点上限",
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
  const number = Number(value); return Number.isFinite(number) ? number.toFixed(digits).replace(/\.00$/, "") : "--";
}
function riskRuleDescription(code, details = {}) {
  const label = riskDecisionLabel(code);
  if (code === "R1.5_RR_TOO_LOW") return `${label}：当前 ${displayRiskNumber(details.rr)}，最低要求 ${displayRiskNumber(details.minimum)}`;
  if (code === "R1.5_TP_TIER_UPGRADED") return `${label}：TP${details.from_tier ?? "?"} → TP${details.to_tier ?? "?"}，调整后盈亏比 ${displayRiskNumber(details.rr)}`;
  if (code === "R1.9_BELOW_MINIMUM_AFTER_RISK") return `${label}：计算结果 ${displayRiskNumber(details.volume)} 手，最低 ${displayRiskNumber(details.minimum)} 手`;
  if (code === "R4.4_QUOTE_STALE") return `${label}：报价年龄 ${displayRiskNumber(details.quote_age_seconds, 3)} 秒，允许上限 ${displayRiskNumber(details.maximum_seconds)} 秒`;
  if (code === "R1.7_PENDING_DEVIATION") return `${label}：偏离 ${displayRiskNumber(details.deviation)}，允许上限 ${displayRiskNumber(details.maximum)}`;
  if (code === "R1.3_SL_WIDEN_VOLUME_DOWN") return `${label}：止损 ${displayRiskNumber(details.from_sl)} → ${displayRiskNumber(details.to_sl)}，手数 ${displayRiskNumber(details.from_volume)} → ${displayRiskNumber(details.to_volume)}`;
  return label;
}
function rejectionRule(rules = [], fallbackCode = "") {
  return rules.find(rule => rule?.outcome === "reject") || (fallbackCode ? { code:fallbackCode, details:{} } : null);
}
function resultRiskReason(result = {}) {
  const rules = Array.isArray(result?.details?.rules) ? result.details.rules : [];
  const rule = rejectionRule(rules, result.reject_code || (/^(?:R|PX)[A-Z0-9._-]+$/.test(result.message || "") ? result.message : ""));
  return rule ? riskRuleDescription(rule.code, rule.details || {}) : "";
}
function rolloutStatusLabel(value) { return ({ completed:"已完成", succeeded:"成功", failed:"失败", running:"执行中", pending:"等待中" })[value] || value || "未执行"; }
function formatRiskValue(key, value) { if (value == null) return "--"; if (key.endsWith("_pct")) return `${Number(value)}%`; if (key.endsWith("_ms")) return `${Number(value)} ms`; return String(value); }

function riskBoundaryText(key, control) {
  if (control?.locked_value != null) return `平台锁定：${formatRiskValue(key, control.locked_value)}`;
  if (control?.user_editable === false) return "平台管理，不可修改";
  if (control?.allowed_min != null || control?.allowed_max != null) return `${control.allowed_min ?? "−∞"} ～ ${control.allowed_max ?? "+∞"}`;
  return "按平台规则约束";
}

function renderRiskPolicyGroup(title, keys, row, metadata) {
  const policy = row.effective?.policy || {}, accountValues = row.effective?.accountValues || {};
  const platform = row.effective?.platformPolicy || {}, controls = row.effective?.controls || {};
  return `<details class="risk-policy-group"><summary><span><strong>${escapeHtml(title)}</strong><small>${keys.length} 项规则</small></span><i data-lucide="chevron-down" size="15"></i></summary><div class="risk-rule-table"><div class="risk-rule-row risk-rule-head"><span>规则</span><span>我的设置</span><span>平台边界</span><span>最终生效</span></div>${keys.map(key => {
    const meta = metadata[key] || {}, control = controls[key] || {}, own = accountValues[key];
    const editable = meta.type === "number" && control.user_editable !== false && control.locked_value == null;
    const ownControl = editable
      ? `<input type="number" step="any" data-user-risk-field="${key}" value="${own == null ? "" : escapeHtml(own)}" placeholder="继承 ${escapeHtml(formatRiskValue(key, platform[key]))}" aria-label="${escapeHtml(RISK_LABELS[key] || key)}的用户设置">`
      : `<span class="risk-inherited">${own == null ? "不可修改" : escapeHtml(formatRiskValue(key, own))}</span>`;
    const boundary = meta.locked ? `平台强制：${formatRiskValue(key, platform[key])}` : riskBoundaryText(key, control);
    return `<div class="risk-rule-row"><span class="risk-rule-name"><strong>${escapeHtml(RISK_LABELS[key] || meta.label || key)}</strong><small>${escapeHtml(meta.code || "")}</small></span><span>${ownControl}</span><span class="risk-boundary">${escapeHtml(boundary)}</span><strong class="risk-effective">${escapeHtml(formatRiskValue(key, policy[key]))}</strong></div>`;
  }).join("")}</div></details>`;
}

async function loadRiskCenter() {
  const filters = state.executionFilters;
  let riskData = await api("/api/ai/risk-center");
  if ((riskData.accounts || []).some(row => row.risk_state?.data_complete === false || Number(row.risk_state?.data_complete) === 0)) {
    const refreshed = await api("/api/ai/risk-center/refresh", { method:"POST", body:{} });
    if (refreshed.refreshed > 0) riskData = await api("/api/ai/risk-center");
  }
  const executionData = await api(`/api/ai/executions?page=${filters.page}&page_size=${filters.pageSize}`);
  const host = $("riskAccountsList");
  const rows = riskData.accounts || [];
  const haltedRows = rows.filter(row => row.risk_state?.halt_status !== "active");
  const incompleteRows = rows.filter(row => row.risk_state?.data_complete === false || Number(row.risk_state?.data_complete) === 0);
  const overview = $("riskOverview");
  if (overview) overview.innerHTML = `<div class="insight-item ${haltedRows.length ? 'danger' : 'success'}"><span>交易状态</span><strong>${haltedRows.length ? `${haltedRows.length} 个账户暂停` : '可以交易'}</strong><small>${haltedRows.length ? '请查看下方具体原因' : '未发现账户级停止条件'}</small></div><div class="insight-item"><span>交易账户</span><strong class="num">${rows.length}</strong><small>已登记账户</small></div><div class="insight-item success"><span>规则应用</span><strong>立即生效</strong><small>保存后下一笔风控计算直接使用</small></div><div class="insight-item ${incompleteRows.length ? 'warning' : ''}"><span>数据完整性</span><strong>${incompleteRows.length ? `${incompleteRows.length} 个异常` : '正常'}</strong><small>账户与行情风控数据</small></div>`;
  const statusHost = $("riskStatusList");
  if (statusHost) statusHost.innerHTML = rows.length ? rows.map(row => {
    const stateInfo = row.risk_state || {}, active = stateInfo.halt_status === "active", dataComplete = !(stateInfo.data_complete === false || Number(stateInfo.data_complete) === 0);
    const reason = stateInfo.halt_reason === "R3_RISK_DATA_INCOMPLETE"
      ? `风控数据不完整：${riskDataIncompleteText(stateInfo.data_incomplete_reason)}`
      : stateInfo.halt_reason || (!dataComplete ? riskDataIncompleteText(stateInfo.data_incomplete_reason) : "当前没有触发停止交易的条件");
    return `<article class="workspace-panel risk-status-card ${active && dataComplete ? 'is-safe' : 'is-alert'}" data-risk-status-account="${row.account.id}"><div class="risk-status-icon"><i data-lucide="${active && dataComplete ? 'shield-check' : 'shield-alert'}" size="22"></i></div><div class="risk-status-main"><div class="workspace-row-title">${escapeHtml(row.account.nickname || row.account.login_account)} <span class="status-chip ${active && dataComplete ? 'success' : 'danger'}">${active && dataComplete ? '允许交易' : '已暂停新开仓'}</span></div><p>${escapeHtml(reason)}</p><div class="workspace-row-meta"><span>${escapeHtml(row.account.broker_server)}</span><span>数据${dataComplete ? '完整' : '不完整'}</span><span>回撤 ${escapeHtml(stateInfo.drawdown_pct ?? '--')}%</span><span>连亏 ${escapeHtml(stateInfo.consecutive_losses ?? '--')}</span></div></div><div class="workspace-row-actions"><button class="btn btn-secondary btn-sm" type="button" data-open-workspace-tab="risk" data-open-workspace-target="rules">查看规则</button><button class="btn ${stateInfo.user_kill_switch ? 'btn-secondary' : 'btn-danger'} btn-sm" data-kill-switch="${row.account.id}" data-enabled="${stateInfo.user_kill_switch ? '0' : '1'}">${stateInfo.user_kill_switch ? '解除紧急停止' : '紧急停止新开仓'}</button></div></article>`;
  }).join("") : '<div class="workspace-panel empty-state"><strong>没有已登记的交易账户</strong><span>连接 Bridge 后会在这里显示账户交易状态。</span></div>';
  host.innerHTML = rows.length ? rows.map(row => {
    const stateInfo = row.risk_state || {}, killEnabled = Boolean(stateInfo.user_kill_switch);
    const haltText = stateInfo.halt_reason === "R3_RISK_DATA_INCOMPLETE" ? `风控数据不完整：${riskDataIncompleteText(stateInfo.data_incomplete_reason)}` : riskDecisionLabel(stateInfo.halt_reason);
    return `<article class="workspace-panel risk-rule-account" data-risk-account="${row.account.id}"><div class="section-heading"><div><h2>${escapeHtml(row.account.nickname || row.account.login_account)}</h2><p>${escapeHtml(row.account.broker_server)} · 先查看最终有效值，需要调整时再展开对应规则组。</p></div><span class="status-chip ${stateInfo.halt_status === 'active' ? 'success' : 'danger'}">${stateInfo.halt_status === 'active' ? '允许交易' : '已暂停'}</span></div>${stateInfo.halt_reason ? `<div class="source-notice"><span><strong>暂停原因：</strong>${escapeHtml(haltText)}；将在下一次完整风险快照校验通过后解除。</span></div>` : ''}<div class="risk-policy-groups">${RISK_GROUPS.map(([title, keys]) => renderRiskPolicyGroup(title, keys, row, riskData.rule_metadata || {})).join("")}</div><div class="risk-save-bar"><p>留空表示继承平台值。所有修改保存后立即生效，并保留版本与审计记录。</p><button class="btn btn-primary btn-sm" data-risk-save="${row.account.id}">保存并立即生效</button></div></article>`;
  }).join("") : '<div class="workspace-panel empty-state"><strong>没有已登记的交易账户</strong><span>账户通过 Bridge 自动验证后，这里会显示最终有效风控。</span></div>';
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
    const aiVolume = original.volume ?? original.lot ?? "--", finalVolume = approved.volume ?? approved.lot ?? "--";
    const refPrice = approved.reference_price ?? original.reference_price ?? original.price ?? "--", actual = result.price ?? result.price_open ?? "--";
    const adjustmentRules = rules.filter(rule => rule.outcome === "adjust" || rule.adjusted);
    const adjustments = adjustmentRules.map(rule => riskRuleDescription(rule.code, rule.details || {})).join("；") || "无";
    const rejectedRule = rejectionRule(rules, row.reject_code || row.error_code || result.reject_code || "");
    const reason = rejectedRule ? riskRuleDescription(rejectedRule.code, rejectedRule.details || {}) : riskDecisionLabel(result.error || result.message || "");
    const riskPass = rules.find(rule => rule.code === "R1.10_REAL_RISK");
    const riskCap = riskPass?.details?.risk_cap ?? approved.risk_volume_cap ?? "--";
    const executionStatus = row.status || "unknown";
    const riskStatus = row.decision_status || "unknown";
    const decisionText = ({ succeeded:"执行成功", rejected:"执行被拒绝", failed:"执行失败", uncertain:"执行待确认", awaiting_confirmation:"等待确认", preparing:"准备执行", prepared:"等待发送", bridge_sending:"正在发送" })[executionStatus] || "未完成";
    const decisionClass = executionStatus === "succeeded" ? "success" : ["rejected","failed"].includes(executionStatus) ? "danger" : "warning";
    const riskText = ({ pass:"通过", adjust:"调整后通过", reject:"拒绝" })[riskStatus] || "未完成";
    return `<article class="workspace-row"><div class="workspace-row-main"><div class="workspace-row-title">#${row.id} ${escapeHtml(row.symbol || '')} <span class="status-chip ${decisionClass}">${escapeHtml(decisionText)}</span></div>${reason && reason !== "未说明原因" ? `<div class="execution-reason">${escapeHtml(reason)}</div>` : ''}<div class="workspace-row-meta"><span>风控 ${escapeHtml(riskText)}</span><span>AI 建议 ${escapeHtml(aiVolume)} 手</span><span>风险上限 ${escapeHtml(riskCap)}</span><span>最终 ${escapeHtml(finalVolume)} 手</span><span>规则调整：${escapeHtml(adjustments)}</span><span>参考价 ${escapeHtml(refPrice)}</span><span>实际价 ${escapeHtml(actual)}</span></div></div></article>`;
  }).join("") : '<div class="empty-state"><strong>暂无执行决策</strong><span>通过风控闸门的下单请求会在这里留下完整对照。</span></div>';
  renderPager("executionDecisionPager", state.executionFilters.page, state.executionFilters.pageSize, state.executionFilters.total, "executions");
}

function reviewStatusLabel(value) { return ({ evidence_pending:"待生成", incomplete:"证据缺失", ready:"待生成", queued:"已进入队列", preparing:"准备证据", model_request:"AI 分析中", validating:"校验结果", repairing:"修复输出", retry_wait:"等待重试", generating:"生成中", draft:"待确认", edited:"已修改", needs_revision:"内容有问题", approved:"已确认", failed:"生成失败", succeeded:"生成完成", deferred:"稍后处理" })[value] || value; }
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
  const isAdmin = state.user?.role === "admin";
  const [reviewData, memoryData, profileData, featureData] = isAdmin
    ? await Promise.all([api(`/api/ai/period-reviews${query}`), api("/api/ai/admin/platform-experience"), Promise.resolve({ profiles:[] }), Promise.resolve({ flags:{ user:{} } })])
    : await Promise.all([api(`/api/ai/period-reviews${query}`), api("/api/ai/memory"), api(`/api/ai/model-profiles${profileScopeQuery()}`), api("/api/ai/feature-flags")]);
  state.reviewCases = reviewData.cases || [];
  await loadReviewSummary({ announce:false });
  $("sharedCredentialNotice")?.classList.toggle("hidden", isAdmin || (profileData.profiles || []).some(item => item.is_default && item.has_api_key));
  const userFlags = featureData.flags?.user || {};
  const featureInputs = { userReviewGenerationFlag:"review_generation_enabled", userExperienceMemoryFlag:"experience_memory_enabled", userMemoryCompressionFlag:"memory_compression_enabled", userRetrievalShadowFlag:"retrieval_shadow_enabled", userPairedExperimentFlag:"paired_experiment_enabled" };
  for (const [id,key] of Object.entries(featureInputs)) if ($(id)) {
    // Paid paired inference is opt-in: an inherited/global permission must not
    // silently become explicit user consent when this form is saved.
    $(id).checked = key === "paired_experiment_enabled" ? userFlags[key] === true : userFlags[key] ?? true;
  }
  renderReviewCases();
  if (isAdmin) renderPlatformExperience(memoryData.items || [], memoryData.policies || [], memoryData.evaluation || {});
  else renderMemoryItems(memoryData.items || [], memoryData.settings || {}, memoryData.summaries || []);
}

async function saveUserFeatureFlags() {
  await api("/api/ai/feature-flags", { method:"PUT", body:{ review_generation_enabled:$("userReviewGenerationFlag").checked,
    experience_memory_enabled:$("userExperienceMemoryFlag").checked, memory_compression_enabled:$("userMemoryCompressionFlag").checked,
    retrieval_shadow_enabled:$("userRetrievalShadowFlag").checked, paired_experiment_enabled:$("userPairedExperimentFlag").checked } });
  toast("个人灰度开关已保存", "success"); await loadReviewMemory();
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
    return `<button class="workspace-row review-case-button ${selected ? 'selected' : ''} ${Number(item.is_unread) ? 'is-unread' : ''}" data-review-id="${Number(item.id)}" aria-pressed="${selected}">
      <span class="review-unread-dot ${Number(item.is_unread) ? '' : 'hidden'}" aria-label="未读复盘"></span>
      <span class="review-case-leading ${statusClass(item.status)}"><i data-lucide="${icon}" size="16"></i></span>
      <span class="workspace-row-main">
        <span class="workspace-row-title"><strong>${isMonthly ? '月复盘' : '日复盘'} · ${escapeHtml(item.period_key)}</strong><span class="status-chip ${statusClass(item.status)}">${escapeHtml(reviewStatusLabel(effectiveStatus))}</span></span>
        <span class="review-case-strategy">${escapeHtml(item.strategy_title || `策略 #${item.strategy_id}`)} <small>v${Number(item.strategy_version || 1)}</small></span>
        <span class="workspace-row-meta"><span>${isMonthly ? `${Number(stats.trading_days || 0)} 个交易日` : `${Number(stats.trade_count || item.source_count || 0)} 笔交易`}</span><span class="${profit > 0 ? 'positive' : profit < 0 ? 'negative' : ''}">净收益 ${fmt(profit, 2)}</span></span>
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
  const issueSummary = (content.trade_process_issues || []).map(item => item.description || item.code).filter(Boolean);
  const isAdmin = state.user?.role === "admin";
  const lessonHelp = isAdmin ? "每行一条；确认后先进入平台经验候选区，发布后才用于平台策略" : "每行一条，将用于生成个人记忆";
  const approveLabel = isAdmin ? "内容准确并加入平台经验候选" : "内容准确并加入记忆";
  const netProfit = Number(outcome.net_profit);
  const profitClass = Number.isFinite(netProfit) ? netProfit > 0 ? "positive" : netProfit < 0 ? "negative" : "neutral" : "neutral";
  const confidence = Number(content.confidence);
  const confidencePercent = Number.isFinite(confidence) ? Math.round(Math.max(0, Math.min(1, confidence)) * 100) : 50;
  const pathEvidence = evidence.post_trade?.path_evidence || {};
  const pathMetrics = evidence.post_trade?.path_metrics || {};
  const pathCoverage = Object.entries(pathEvidence.coverage || {});
  const excursion = (value) => Number.isFinite(Number(value)) ? `${fmt(Number(value), 2)}%` : "--";
  detail.innerHTML = `<header class="review-detail-header"><div class="review-detail-title"><span class="review-detail-icon"><i data-lucide="clipboard-check" size="19"></i></span><div><span class="review-section-kicker">复盘详情</span><h2>复盘 #${Number(review.id)}</h2><p>版本 ${escapeHtml(current?.version_no || '--')} · 信号 #${escapeHtml(review.signal_id || '--')}</p></div></div><div class="review-detail-status"><span class="status-chip ${review.status === 'approved' ? 'success' : ['failed','incomplete','needs_revision'].includes(review.status) ? 'danger' : 'warning'}">${escapeHtml(reviewStatusLabel(review.status))}</span>${review.status === 'failed' ? '<button class="btn btn-secondary btn-sm" data-review-action="retry"><i data-lucide="rotate-cw" size="14"></i>重试生成</button>' : ''}</div></header>
    ${review.evidence_status !== 'complete' ? `<div class="source-notice"><span><strong>证据缺失：</strong>${escapeHtml(review.evidence_reason || '关键证据不完整')}</span></div>` : ''}
    <section class="review-outcome-strip" aria-label="交易结果"><div class="review-outcome-main ${profitClass}"><span>净利润</span><strong>${fmt(outcome.net_profit, 2)}</strong><small>账户货币</small></div><div class="review-outcome-metric"><span>成交手数</span><strong>${fmt(outcome.closed_volume, 2)}</strong><small>已平仓</small></div><div class="review-outcome-metric"><span>结论置信度</span><strong>${confidencePercent}%</strong><small>AI 复盘判断</small></div><p><i data-lucide="info" size="14"></i>盈亏是结果，不直接代表当时的决策质量。</p></section>
    <section class="review-path-summary ${pathEvidence.status === 'complete' ? 'is-complete' : 'is-partial'}">
      <header><div><span class="review-section-kicker">持仓路径证据</span><h3>从开仓到平仓的行情表现</h3></div><span class="status-chip ${pathEvidence.status === 'complete' ? 'success' : 'warning'}">${pathEvidence.status === 'complete' ? '证据完整' : '部分可用'}</span></header>
      <div class="review-path-metrics"><div><span>最大有利波动</span><strong>${excursion(pathMetrics.max_favorable_excursion_pct)}</strong></div><div><span>最大不利波动</span><strong>${excursion(pathMetrics.max_adverse_excursion_pct)}</strong></div><div><span>持仓 K 线</span><strong>${Number(pathMetrics.bars_held || 0)} 根</strong></div><div><span>缠论周期</span><strong>${pathCoverage.length || 0} 个</strong></div></div>
      <footer>${pathCoverage.map(([timeframe, item]) => `<span><strong>${escapeHtml(timeframe)}</strong> ${Number(item.candle_count || 0)} 根 · ${item.status === 'complete' ? '结构已计算' : '数据不足'}</span>`).join('') || '<span>暂无可用的持仓行情路径</span>'}</footer>
    </section>
    <div class="review-structured-form">
      <section class="review-form-section review-summary-section"><div class="review-form-heading"><div><span class="review-section-kicker">核心判断</span><h3>复盘结论</h3></div><small>先确认事实与结论是否一致</small></div><label class="review-field"><span class="sr-only">复盘结论</span><textarea data-review-field="summary" rows="4" ${current ? '' : 'disabled'}>${escapeHtml(content.summary || '')}</textarea></label></section>
      <section class="review-form-section"><div class="review-form-heading"><div><span class="review-section-kicker">质量校对</span><h3>评估与结果说明</h3></div><small>可按实际交易情况修正</small></div><div class="review-assessment-grid"><label class="review-field"><span>决策质量</span><select data-review-field="decision_quality" ${current ? '' : 'disabled'}><option value="good" ${content.decision_quality === 'good' ? 'selected' : ''}>良好</option><option value="mixed" ${content.decision_quality === 'mixed' ? 'selected' : ''}>有得有失</option><option value="poor" ${content.decision_quality === 'poor' ? 'selected' : ''}>需要改进</option><option value="insufficient_evidence" ${content.decision_quality === 'insufficient_evidence' ? 'selected' : ''}>证据不足</option></select></label><label class="review-field review-confidence-field"><span>结论置信度</span><div><input data-review-field="confidence" type="number" min="0" max="1" step="0.05" value="${escapeHtml(content.confidence ?? 0.5)}" ${current ? '' : 'disabled'}><small>填写 0–1</small></div></label><label class="review-field review-outcome-summary"><span>交易结果说明</span><textarea data-review-field="outcome_summary" rows="3" ${current ? '' : 'disabled'}>${escapeHtml(content.outcome_summary || '')}</textarea></label></div></section>
      ${issueSummary.length ? `<section class="review-issues"><div><i data-lucide="triangle-alert" size="16"></i><span>发现 ${issueSummary.length} 项流程问题</span></div>${issueSummary.map(item => `<p>${escapeHtml(item)}</p>`).join('')}</section>` : '<section class="review-issues is-clear"><div><i data-lucide="circle-check" size="16"></i><span>交易流程检查</span></div><p>未记录明确的交易流程问题</p></section>'}
      <section class="review-form-section"><div class="review-form-heading"><div><span class="review-section-kicker">经验沉淀</span><h3>保留有效经验</h3></div><small>使用短句，每行只写一个要点</small></div><div class="review-form-columns"><label class="review-field"><span>做得好的地方</span><textarea data-review-field="strengths" rows="4" ${current ? '' : 'disabled'}>${escapeHtml((content.strengths || []).join('\n'))}</textarea><small>每行一条，记录可复用的正确做法</small></label><label class="review-field"><span>后续经验</span><textarea data-review-field="lessons" rows="4" ${current ? '' : 'disabled'}>${escapeHtml((content.lessons || []).join('\n'))}</textarea><small>${escapeHtml(lessonHelp)}</small></label></div></section>
    </div>
    <details class="quiet-disclosure review-evidence-disclosure"><summary><span><i data-lucide="file-search" size="15"></i><strong>查看推理证据与原始数据</strong><small>证据只读，原始 JSON 仅供高级检查</small></span><i data-lucide="chevron-down" size="15"></i></summary><div class="quiet-disclosure-body"><div class="review-evidence"><div><span>信号 / 策略</span><strong>#${review.signal_id || '--'} / #${snapshot.strategy_id || '--'}</strong></div><div><span>模型来源</span><strong>${escapeHtml(snapshot.credential_source || '--')} · ${escapeHtml(snapshot.model_name || '--')}</strong></div><div><span>交易结果</span><strong>净利润 ${escapeHtml(outcome.net_profit ?? '--')} · 手数 ${escapeHtml(outcome.closed_volume ?? '--')}</strong></div><div><span>证据哈希</span><strong>${escapeHtml(snapshot.content_hash || '--')}</strong></div></div><div class="workspace-row-meta"><span>交易流程问题：${escapeHtml(review.trade_process_issue_status)}</span><span>复盘内容确认：${escapeHtml(review.review_content_status)}</span></div><label><span>原始结构化内容</span><textarea id="reviewContentEditor" class="review-editor compact" readonly>${escapeHtml(JSON.stringify(content,null,2))}</textarea></label></div></details>
    ${current ? `<footer class="review-actions"><div class="review-action-context"><i data-lucide="shield-check" size="17"></i><span><strong>确认前请核对结论</strong><small>确认后才会进入经验候选或个人记忆</small></span></div><div class="review-action-buttons"><button class="text-action" data-review-action="defer" data-version-id="${current.id}">稍后处理</button><button class="btn btn-secondary" data-review-action="needs_revision" data-version-id="${current.id}">内容有问题，继续修改</button><button class="btn btn-secondary" data-review-action="save" data-version-id="${current.id}">保存修改</button><button class="btn btn-primary" data-review-action="approve" data-version-id="${current.id}"><i data-lucide="check" size="15"></i>${escapeHtml(approveLabel)}</button></div></footer>` : ''}`;
  initIcons();
}

const periodDecisionLabels = { good:"良好", mixed:"有得有失", poor:"需要改进", insufficient_evidence:"证据不足" };
const chanIssueLabels = { data:"行情数据", calculation:"结构计算", confirmation_lag:"结构确认延迟", ai_interpretation:"AI 解读", strategy_rule:"策略规则", none:"未发现问题", unknown:"暂无法判断" };

function periodReviewArray(value) { return Array.isArray(value) ? value.map(item => String(item || "").trim()).filter(Boolean) : []; }
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
  return `<section class="period-review-evidence-card"><header><i data-lucide="${icon}" size="15"></i><strong>${escapeHtml(title)}</strong><span>${items.length}</span></header>${items.length ? `<ul>${items.map(item => `<li>${escapeHtml(item)}</li>`).join("")}</ul>` : '<p>本周期未记录相关问题</p>'}</section>`;
}

async function openPeriodReviewDetail(id, { silent = false } = {}) {
  stopReviewDetailPolling();
  state.selectedReviewId = Number(id); renderReviewCases();
  const detail = $("reviewDetail");
  if (!silent) detail.innerHTML = '<div class="workspace-skeleton"></div>';
  const data = await api(`/api/ai/period-reviews/${id}`);
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
  const derivationLabels = { queued:"经验等待处理", leased:"正在沉淀经验", paused:"经验处理已暂停", failed:"经验处理失败", succeeded:"经验已沉淀" };
  const derivationStatus = review.derivation_status || "";
  const derivationClass = derivationStatus === "succeeded" ? "complete" : derivationStatus === "failed" ? "warning" : "";
  const derivationDetail = derivationStatus === "paused"
    ? "相关记忆功能当前已关闭，重新启用后会自动继续"
    : derivationStatus === "failed" ? periodReviewFailureText(review.derivation_error_code)
      : derivationStatus === "succeeded" ? (state.user?.role === "admin" ? "已生成平台经验候选" : "已写入个人记忆体系")
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
  detail.innerHTML = `<header class="period-review-detail-header">
      <div><span class="period-review-type ${isMonthly ? 'monthly' : 'daily'}"><i data-lucide="${isMonthly ? 'calendar-range' : 'calendar-days'}" size="14"></i>${isMonthly ? '月复盘' : '日复盘'}</span><h2>${escapeHtml(review.period_key || '--')}</h2><p>${escapeHtml(review.strategy_title || `策略 #${review.strategy_id}`)} · 策略版本 v${Number(review.strategy_version || 1)}</p><p class="period-review-period-scope"><i data-lucide="clock-3" size="13"></i>${escapeHtml(periodScope)}</p></div>
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
      <div class="period-review-section-heading"><div><span class="review-section-kicker">核心结论</span><h3>${isMonthly ? '本月策略表现' : '当日策略表现'}</h3></div><span>版本 ${Number(current.version_no || 1)}</span></div>
      <label class="review-field"><span>复盘摘要</span><textarea data-period-review-field="period_summary" rows="4" ${editable ? '' : 'disabled'}>${escapeHtml(content.period_summary || '')}</textarea></label>
      <div class="period-review-decision-row"><label class="review-field"><span>决策质量</span><select data-period-review-field="decision_quality" ${editable ? '' : 'disabled'}>${Object.entries(periodDecisionLabels).map(([value,label]) => `<option value="${value}" ${content.decision_quality === value ? 'selected' : ''}>${label}</option>`).join('')}</select></label><label class="review-field"><span>结论置信度</span><div class="confidence-input"><input data-period-review-field="confidence" type="number" min="0" max="1" step="0.05" value="${escapeHtml(content.confidence ?? 0.5)}" ${editable ? '' : 'disabled'}><small>0 到 1</small></div></label></div>
      <div class="period-review-edit-grid">${editableGroups.map(([key,label]) => `<label class="review-field"><span>${label}</span><textarea data-period-review-field="${key}" data-field-type="lines" rows="4" ${editable ? '' : 'disabled'}>${escapeHtml(periodReviewLines(content[key]))}</textarea><small>每行一条，保持简短且可执行</small></label>`).join('')}</div>
      <textarea id="reviewContentEditor" hidden>${escapeHtml(JSON.stringify(content))}</textarea>
    </section>` : `<div class="review-empty-state empty-state"><span class="review-empty-icon"><i data-lucide="${review.status === 'failed' ? 'circle-alert' : 'loader-circle'}" size="20"></i></span><strong>${review.status === 'failed' ? '复盘生成失败' : '复盘正在准备'}</strong><span>${escapeHtml(review.status === 'failed' ? periodReviewFailureText(review.last_error_code) : review.evidence_reason || '系统会在证据完整后自动生成，无需手动重复提交。')}</span></div>`}
    ${current ? `<section class="period-review-evidence-grid">
      ${periodReviewListBlock(isMonthly ? '跨日模式' : '逐笔判断', assessments.map(item => `${isMonthly ? item.period_case_id : item.outcome_id} · ${periodDecisionLabels[item.decision_quality] || item.decision_quality}：${item.summary || ''}`), isMonthly ? 'calendar-range' : 'receipt-text')}
      ${isMonthly ? periodReviewListBlock('长期记忆候选', (content.memory_candidates || []).map(item => item.lesson), 'brain-circuit') : periodReviewListBlock('缠论结构诊断', diagnostics.map(item => `${chanIssueLabels[item.issue_source] || item.issue_source}：${item.explanation || '无补充说明'}`), 'git-branch')}
    </section>
    <details class="quiet-disclosure review-evidence-disclosure"><summary><span><i data-lucide="database" size="15"></i><strong>证据来源与系统字段</strong><small>基础统计只读，避免修改后与真实成交数据不一致</small></span><i data-lucide="chevron-down" size="15"></i></summary><div class="quiet-disclosure-body"><div class="review-evidence"><div><span>账户 / 策略</span><strong>#${Number(review.trading_account_id || 0)} / #${Number(review.strategy_id || 0)}</strong></div><div><span>统计时区</span><strong>UTC${Number(review.timezone_offset_minutes || 0) >= 0 ? '+' : ''}${fmt(Number(review.timezone_offset_minutes || 0) / 60, 1)}</strong></div><div><span>来源数量</span><strong>${Number(review.source_count || 0)}</strong></div><div><span>生成时间</span><strong>${escapeHtml(current.created_at || '--')}</strong></div></div></div></details>
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

function renderMemoryItemsLegacy(items, settings) {
  const memoryEnabled = settings.enabled !== false;
  if ($("memoryEnabled")) $("memoryEnabled").checked = memoryEnabled;
  const activeCount = items.filter(item => item.status === "active").length;
  const pendingCount = items.filter(item => ["duplicate_candidate", "stale"].includes(item.status)).length;
  const revokedCount = items.filter(item => item.status === "revoked").length;
  setText("memoryActiveStat", activeCount);
  const host = $("memoryItemsList"); if (!host) return;
  const statusLabels = { active:"正在使用", duplicate_candidate:"待确认", revoked:"已撤销", stale:"待更新" };
  host.innerHTML = `<section class="personal-memory-section ${memoryEnabled ? '' : 'is-disabled'}">
    <header class="personal-memory-header"><div class="personal-memory-title"><span class="personal-memory-main-icon"><i data-lucide="brain" size="19"></i></span><div><span class="review-section-kicker">个人经验</span><h3>我的记忆库</h3><p>系统只会把你确认过、且状态为“正在使用”的经验带入后续推理。</p></div></div><div class="personal-memory-stats"><span><strong>${activeCount}</strong> 正在使用</span><span><strong>${pendingCount}</strong> 等待处理</span><span><strong>${revokedCount}</strong> 已撤销</span></div></header>
    <div class="personal-memory-state ${memoryEnabled ? 'is-on' : 'is-off'}"><i data-lucide="${memoryEnabled ? 'shield-check' : 'shield-off'}" size="15"></i><span>${memoryEnabled ? '<strong>个人记忆已启用</strong>，正在使用的经验会参与后续推理。' : '<strong>个人记忆已关闭</strong>，现有经验仍会保留，但不会注入推理。'}</span></div>
    <div class="personal-memory-grid">${items.length ? items.map(item => {
      const statusClass = item.status === 'active' ? 'success' : item.status === 'revoked' ? 'danger' : 'warning';
      const icon = item.status === 'active' ? 'lightbulb' : item.status === 'revoked' ? 'archive-x' : item.status === 'stale' ? 'refresh-cw' : 'circle-help';
      return `<article class="personal-memory-card is-${escapeHtml(item.status)}"><header><span class="personal-memory-icon ${statusClass}"><i data-lucide="${icon}" size="17"></i></span><div><strong>${escapeHtml(item.symbol || '通用经验')}</strong><span>${escapeHtml(item.timeframe || '全周期')} · 记忆 #${Number(item.id)}</span></div><span class="status-chip ${statusClass}">${escapeHtml(statusLabels[item.status] || item.status)}</span></header><div class="personal-memory-lesson"><span>经验内容</span><p>${escapeHtml(item.lesson_text)}</p></div><footer><div class="personal-memory-meta"><span><i data-lucide="clipboard-check" size="13"></i>来源复盘版本 #${escapeHtml(item.review_version_id || '--')}</span><span><i data-lucide="braces" size="13"></i>${Number(item.token_count || 0)} tokens</span></div><div class="personal-memory-actions">${item.status === 'duplicate_candidate' ? `<button class="btn btn-primary btn-sm" data-memory-action="activate" data-memory-id="${item.id}"><i data-lucide="check" size="14"></i>确认使用</button>` : ''}${item.status !== 'revoked' ? `<button class="btn btn-secondary btn-sm" data-memory-action="revoke" data-memory-id="${item.id}"><i data-lucide="archive" size="14"></i>撤销</button>` : ''}</div></footer></article>`;
    }).join("") : '<div class="personal-memory-empty empty-state"><span class="review-empty-icon"><i data-lucide="brain" size="20"></i></span><strong>还没有个人经验</strong><span>确认一条交易复盘后，系统会在这里生成可管理的个人记忆。</span></div>'}</div>
  </section>`;
  initIcons();
}

function renderMemoryItems(items, settings, summaries = []) {
  const memoryEnabled = settings.enabled !== false;
  if ($("memoryEnabled")) $("memoryEnabled").checked = memoryEnabled;
  const shortItems = items.filter(item => item.memory_tier !== "long");
  const longItems = items.filter(item => item.memory_tier === "long");
  const activeShort = shortItems.filter(item => item.status === "active").length;
  const activeLong = longItems.filter(item => item.status === "active").length;
  const longCandidates = longItems.filter(item => item.status === "candidate").length;
  setText("memoryActiveStat", activeShort + activeLong);
  const host = $("memoryItemsList"); if (!host) return;
  const statusLabels = { active:"正在使用", candidate:"待确认长期使用", duplicate_candidate:"待确认重复经验", revoked:"已撤销", stale:"待更新", expired:"已到期", revalidation:"待重新验证" };
  const visibleItems = state.memoryTierFilter === "all" ? items : items.filter(item => item.memory_tier === state.memoryTierFilter);
  const cards = visibleItems.map(item => {
    const isLong = item.memory_tier === "long";
    const statusClass = item.status === "active" ? "success" : item.status === "revoked" || item.status === "expired" ? "danger" : "warning";
    const icon = isLong ? "book-marked" : item.status === "active" ? "zap" : item.status === "revoked" ? "archive-x" : "circle-help";
    const content = isLong ? item.summary_text : item.lesson_text;
    const scope = `策略 #${Number(item.strategy_id || 0)} · v${Number(item.strategy_version || 1)} · ${item.symbol || "通用品种"} · ${item.timeframe || "全周期"}`;
    const lifecycle = isLong
      ? `${Number(item.support_count || 0)} 次复盘支持 · 已匹配 ${Number(item.match_count || 0)} 次`
      : `${item.expires_at ? `有效至 ${escapeHtml(item.expires_at)}` : "无到期时间"} · 已匹配 ${Number(item.match_count || 0)} 次`;
    const actions = isLong
      ? `${item.status === "candidate" ? `<button class="btn btn-primary btn-sm" data-memory-action="confirm-long" data-memory-id="${item.id}"><i data-lucide="check" size="14"></i>确认长期使用</button>` : ""}${!['revoked'].includes(item.status) ? `<button class="btn btn-secondary btn-sm" data-memory-action="revoke-long" data-memory-id="${item.id}">撤销</button>` : ""}`
      : `${item.status === "duplicate_candidate" ? `<button class="btn btn-primary btn-sm" data-memory-action="activate" data-memory-id="${item.id}">确认使用</button>` : ""}${!['revoked','expired'].includes(item.status) ? `<button class="btn btn-secondary btn-sm" data-memory-action="revoke" data-memory-id="${item.id}">撤销</button>` : ""}`;
    return `<article class="personal-memory-card memory-tier-${isLong ? 'long' : 'short'} is-${escapeHtml(item.status)}">
      <header><span class="personal-memory-icon ${statusClass}"><i data-lucide="${icon}" size="17"></i></span><div><strong>${isLong ? "长期记忆" : "短期记忆"} #${Number(item.id)}</strong><span>${escapeHtml(scope)}</span></div><span class="status-chip ${statusClass}">${escapeHtml(statusLabels[item.status] || item.status)}</span></header>
      <div class="personal-memory-lesson"><span>${isLong ? "稳定经验" : "近期复盘经验"}</span><p>${escapeHtml(content || "暂无内容")}</p>${item.candidate_reason ? `<small>${escapeHtml(item.candidate_reason)}</small>` : ""}</div>
      <footer><div class="personal-memory-meta"><span><i data-lucide="clock-3" size="13"></i>${lifecycle}</span><span><i data-lucide="braces" size="13"></i>${Number(item.token_count || 0)} tokens</span></div><div class="personal-memory-actions">${actions}</div></footer>
    </article>`;
  }).join("");
  const summaryCards = (state.memoryTierFilter === "all" || state.memoryTierFilter === "summary") ? summaries.map(item => `<article class="personal-memory-card memory-tier-summary is-${escapeHtml(item.status)}">
    <header><span class="personal-memory-icon ${item.status === 'active' ? 'success' : 'warning'}"><i data-lucide="file-stack" size="17"></i></span><div><strong>月度记忆摘要 · ${escapeHtml(item.period_key || `版本 ${item.version_no}`)}</strong><span>${escapeHtml(item.scope_key)} · 摘要 #${Number(item.id)}</span></div><span class="status-chip ${item.status === 'active' ? 'success' : 'warning'}">${item.status === 'active' ? '正在使用' : item.status === 'stale' ? '已失效' : escapeHtml(item.status)}</span></header>
    <div class="personal-memory-lesson"><span>跨日压缩结论</span><p>${escapeHtml(item.summary_text || '暂无内容')}</p></div><footer><div class="personal-memory-meta"><span><i data-lucide="calendar-range" size="13"></i>${escapeHtml(item.period_key || '自动压缩')}</span><span><i data-lucide="braces" size="13"></i>${Number(item.token_count || 0)} tokens</span></div></footer>
  </article>`).join("") : "";
  host.innerHTML = `<section class="personal-memory-section ${memoryEnabled ? "" : "is-disabled"}">
    <header class="personal-memory-header"><div class="personal-memory-title"><span class="personal-memory-main-icon"><i data-lucide="brain-circuit" size="19"></i></span><div><span class="review-section-kicker">分层经验</span><h3>我的策略记忆</h3><p>短期记忆保留近期复盘，反复验证后由你确认升级为长期记忆；策略版本变化时不会跨版本注入。</p></div></div><div class="personal-memory-stats"><span><strong>${activeLong}</strong> 长期有效</span><span><strong>${activeShort}</strong> 短期有效</span><span><strong>${longCandidates}</strong> 待确认</span></div></header>
    <div class="personal-memory-state ${memoryEnabled ? "is-on" : "is-off"}"><i data-lucide="${memoryEnabled ? 'shield-check' : 'shield-off'}" size="15"></i><span><strong>个人记忆${memoryEnabled ? '已启用' : '已关闭'}</strong> · 检索时优先长期经验，再补充与当前策略版本一致的近期经验。</span></div>
    <div class="memory-tier-tabs" role="tablist" aria-label="记忆层级筛选"><button class="${state.memoryTierFilter === 'all' ? 'active' : ''}" data-memory-tier="all">全部</button><button class="${state.memoryTierFilter === 'short' ? 'active' : ''}" data-memory-tier="short">短期记忆</button><button class="${state.memoryTierFilter === 'summary' ? 'active' : ''}" data-memory-tier="summary">月度摘要</button><button class="${state.memoryTierFilter === 'long' ? 'active' : ''}" data-memory-tier="long">长期记忆</button></div>
    <div class="personal-memory-grid">${summaryCards}${cards}${!summaryCards && !cards ? '<div class="personal-memory-empty empty-state"><span class="review-empty-icon"><i data-lucide="brain" size="20"></i></span><strong>当前层级还没有记忆</strong><span>日复盘确认后形成短期记忆，月复盘确认后形成月度摘要与长期候选。</span></div>' : ''}</div>
  </section>`;
  initIcons();
}

function renderPlatformExperienceEvaluation(evaluation = {}) {
  const host = $("platformExperienceEvaluation"); if (!host) return;
  const retrieval = evaluation.retrieval || {}, paired = evaluation.paired || {};
  const strategies = evaluation.strategies || [], recent = evaluation.recent_retrievals || [], pairs = paired.recent_runs || [];
  const percent = value => `${Math.round(Math.max(0, Math.min(1, Number(value || 0))) * 100)}%`;
  const modeLabels = { shadow:"影子评估", active:"正式使用", off:"已关闭" };
  const diffLabels = { signal_type:"信号方向", entry_method:"入场方式", confidence:"置信度", recommended_volume:"建议手数", stop_loss_price:"止损", take_profit_1_price:"止盈", limit_price:"挂单价格" };
  const retrievalReasonLabels = { market_regime_match:"市场状态", trend_direction_match:"趋势方向", volatility_bucket_match:"波动状态", chan_trend_state_match:"缠论趋势", chan_segment_direction_match:"线段方向", chan_divergence_match:"背驰状态", chan_center_state_match:"中枢状态", entry_method_overlap:"入场方式" };
  const recentRows = recent.slice(0, 10).map(row => {
    const selected = row.selected_items || [];
    const details = Array.isArray(row.selection_details) ? row.selection_details : [];
    return `<div class="experience-evaluation-row"><div><strong>${escapeHtml(row.strategy_title || `策略 #${row.strategy_id}`)}</strong><span>${escapeHtml(row.symbol || '通用品种')} · ${escapeHtml(row.timeframe || '全周期')} · ${escapeHtml(modeLabels[row.policy_mode] || row.policy_mode)}</span></div><div class="experience-hit-result ${selected.length ? 'is-hit' : 'is-miss'}"><strong>${selected.length ? `命中 ${selected.length} 条` : '未命中'}</strong><span>${selected.length ? selected.map(item => { const detail = details.find(entry => Number(entry.id) === Number(item.id)); const reasons = (detail?.reasons || []).map(reason => retrievalReasonLabels[reason]).filter(Boolean).slice(0, 3); return `#${Number(item.id)}${detail ? `（${Number(detail.score)}分${reasons.length ? ` · ${reasons.join('、')}` : ''}）` : ''}`; }).join('；') : '当前市场条件没有达到经验使用门槛'}</span></div><time>${escapeHtml(row.created_at || '--')}</time></div>`;
  }).join("");
  const strategyRows = strategies.map(row => `<div class="experience-strategy-row"><div><strong>${escapeHtml(row.strategy_title || `策略 #${row.strategy_id}`)}</strong><span>最近运行 ${escapeHtml(row.latest_at || '--')}</span></div><span>${Number(row.shadow_retrievals || 0)} 次影子检索</span><span>${Number(row.shadow_hits || 0)} 次命中</span><strong>${percent(row.shadow_hit_rate)}</strong></div>`).join("");
  const pairedRows = pairs.slice(0, 8).map(row => `<div class="experience-evaluation-row paired"><div><strong>${escapeHtml(row.strategy_title || `策略 #${row.strategy_id || '--'}`)}</strong><span>信号 #${escapeHtml(row.signal_id || '--')} · ${escapeHtml(row.user_nickname || `用户 #${row.user_id}`)}</span></div><div class="experience-hit-result ${row.changed_fields?.length ? 'is-hit' : 'is-miss'}"><strong>${row.status === 'succeeded' ? (row.changed_fields?.length ? '推理结果有差异' : '推理结果一致') : '对照运行失败'}</strong><span>${row.changed_fields?.length ? row.changed_fields.map(key => diffLabels[key] || key).join('、') : row.error_code ? '未获得有效对照结果' : '关键输出没有变化'}</span></div><time>${escapeHtml(row.created_at || '--')}</time></div>`).join("");
  host.innerHTML = `<section class="platform-evaluation-section">
    <header class="platform-section-header"><div class="platform-section-title"><span class="platform-section-icon"><i data-lucide="scan-search" size="18"></i></span><div><span class="review-section-kicker">效果评估</span><h3>经验检索表现</h3><p>影子评估只衡量能否找到合适经验；配对实验才比较记忆是否改变推理结果。</p></div></div><span class="evaluation-window">最近 ${Number(evaluation.window_days || 30)} 天</span></header>
    <div class="experience-evaluation-metrics"><div><span>可评估影子检索</span><strong>${Number(retrieval.shadow_total || 0)}</strong><small>从经验发布后开始统计</small></div><div><span>经验命中</span><strong>${Number(retrieval.shadow_hits || 0)}</strong><small>找到可用经验</small></div><div><span>影子命中率</span><strong>${percent(retrieval.shadow_hit_rate)}</strong><small>命中次数 ÷ 可评估检索</small></div><div><span>配对实验</span><strong>${Number(paired.total || 0)}</strong><small>${Number(paired.changed || 0)} 次产生差异</small></div></div>
    ${strategies.length ? `<div class="experience-strategy-list"><div class="experience-list-heading"><strong>按策略统计</strong><span>命中率只代表检索适配度，不代表盈利提升</span></div>${strategyRows}</div>` : ''}
    <details class="experience-evaluation-details" ${recent.length ? 'open' : ''}><summary><span><strong>最近检索记录</strong><small>${recent.length ? `显示最近 ${Math.min(10, recent.length)} 条` : '尚无检索记录'}</small></span><i data-lucide="chevron-down" size="15"></i></summary><div class="experience-evaluation-list">${recentRows || '<div class="platform-evaluation-empty"><strong>尚无影子检索数据</strong><span>策略运行并完成经验检索后，这里会显示命中详情。</span></div>'}</div></details>
    <details class="experience-evaluation-details"><summary><span><strong>配对推理对照</strong><small>${pairs.length ? `最近 ${Math.min(8, pairs.length)} 次` : '尚未启用或尚未产生数据'}</small></span><i data-lucide="chevron-down" size="15"></i></summary><div class="experience-evaluation-list">${pairedRows || '<div class="platform-evaluation-empty"><strong>还没有配对实验</strong><span>影子评估不会额外调用模型；只有明确启用付费配对实验后，才能比较使用经验与不使用经验的推理差异。</span></div>'}</div></details>
  </section>`;
}

function renderPlatformExperience(items, policies, evaluation = {}) {
  setText("memoryActiveStat", items.filter(item => item.status === "active").length);
  const policyHost = $("platformExperiencePolicies");
  const modeLabels = { off:"未启用", shadow:"影子评估", active:"正式启用" };
  const modeClasses = { off:"neutral", shadow:"warning", active:"success" };
  if (policyHost) {
    const activePolicies = policies.filter(policy => policy.mode === "active").length;
    const shadowPolicies = policies.filter(policy => policy.mode === "shadow").length;
    policyHost.innerHTML = `<section class="platform-policy-section">
      <header class="platform-section-header"><div class="platform-section-title"><span class="platform-section-icon"><i data-lucide="route" size="18"></i></span><div><span class="review-section-kicker">策略控制</span><h3>经验运行模式</h3><p>分别决定每个策略是否读取已发布的平台经验。</p></div></div><div class="platform-section-stats"><span><strong>${activePolicies}</strong> 正式启用</span><span><strong>${shadowPolicies}</strong> 影子评估</span><span><strong>${policies.length}</strong> 个策略</span></div></header>
      <div class="platform-mode-notice"><i data-lucide="info" size="15"></i><span><strong>影子评估</strong>只验证经验效果，不注入正式推理；选择<strong>正式启用</strong>后才会参与平台策略。</span></div>
      <div class="platform-policy-grid">${policies.length ? policies.map(policy => `<article class="platform-experience-policy" data-platform-policy-strategy="${Number(policy.strategy_id)}">
        <div class="platform-policy-head"><span class="platform-policy-icon"><i data-lucide="brain-circuit" size="17"></i></span><div><strong>${escapeHtml(policy.strategy_title)}</strong><small>策略经验配置 · 版本 ${Number(policy.policy_version || 1)}</small></div><span class="status-chip ${modeClasses[policy.mode] || 'neutral'}">${escapeHtml(modeLabels[policy.mode] || policy.mode)}</span></div>
        <div class="platform-policy-controls"><label><span>经验模式</span><select aria-label="${escapeHtml(policy.strategy_title)}的平台经验模式" data-platform-policy-mode><option value="off" ${policy.mode === 'off' ? 'selected' : ''}>关闭</option><option value="shadow" ${policy.mode === 'shadow' ? 'selected' : ''}>影子评估</option><option value="active" ${policy.mode === 'active' ? 'selected' : ''}>正式启用</option></select></label><button class="btn btn-secondary btn-sm" data-platform-policy-save><i data-lucide="save" size="14"></i>保存模式</button></div>
      </article>`).join("") : '<div class="platform-empty-state empty-state"><span class="review-empty-icon"><i data-lucide="route-off" size="20"></i></span><strong>暂无平台策略</strong><span>创建平台策略后，可以在这里配置统一经验。</span></div>'}</div>
    </section>`;
  }
  renderPlatformExperienceEvaluation(evaluation);
  const host = $("memoryItemsList"); if (!host) return;
  const labels = { candidate:"待发布", active:"已发布", revoked:"已撤销" };
  const candidateCount = items.filter(item => item.status === "candidate").length;
  const activeCount = items.filter(item => item.status === "active").length;
  host.innerHTML = `<section class="platform-library-section"><header class="platform-section-header"><div class="platform-section-title"><span class="platform-section-icon"><i data-lucide="library-big" size="18"></i></span><div><span class="review-section-kicker">经验内容</span><h3>平台经验库</h3><p>只有已发布的经验才会被正式启用的策略读取。</p></div></div><div class="platform-section-stats"><span><strong>${candidateCount}</strong> 待发布</span><span><strong>${activeCount}</strong> 已发布</span></div></header>
    <div class="platform-experience-list">${items.length ? items.map(item => {
      const statusClass = item.status === 'active' ? 'success' : item.status === 'revoked' ? 'danger' : 'warning';
      const icon = item.status === 'active' ? 'badge-check' : item.status === 'revoked' ? 'archive-x' : 'sparkles';
      return `<article class="platform-experience-card is-${escapeHtml(item.status)}"><header><span class="platform-experience-icon ${statusClass}"><i data-lucide="${icon}" size="17"></i></span><div><strong>${escapeHtml(item.strategy_title || `策略 #${item.strategy_id}`)}</strong><span>经验 #${Number(item.id)}</span></div><span class="status-chip ${statusClass}">${escapeHtml(labels[item.status] || item.status)}</span></header><p class="platform-experience-lesson">${escapeHtml(item.lesson_text)}</p><footer><div class="platform-experience-meta"><span><i data-lucide="clipboard-check" size="13"></i>来源复盘版本 #${escapeHtml(item.review_version_id || '--')}</span>${item.platform_version ? `<span><i data-lucide="git-branch" size="13"></i>平台版本 ${Number(item.platform_version)}</span>` : '<span><i data-lucide="circle-dashed" size="13"></i>尚未生成平台版本</span>'}</div><div class="platform-experience-actions">${item.status === 'candidate' ? `<button class="btn btn-primary btn-sm" data-platform-experience-action="publish" data-platform-experience-id="${item.id}"><i data-lucide="send" size="14"></i>发布经验</button>` : ''}${item.status !== 'revoked' ? `<button class="btn btn-secondary btn-sm" data-platform-experience-action="revoke" data-platform-experience-id="${item.id}"><i data-lucide="archive" size="14"></i>撤销</button>` : ''}</div></footer></article>`;
    }).join("") : '<div class="platform-empty-state empty-state"><span class="review-empty-icon"><i data-lucide="library" size="20"></i></span><strong>暂无平台经验</strong><span>确认平台策略复盘后，市场经验会先进入待发布区。</span></div>'}</div></section>`;
  initIcons();
}

async function loadAdminRiskCenter() {
  const [data, rolloutData] = await Promise.all([api("/api/ai/admin/risk-center"), api("/api/ai/admin/rollout-health")]); state.globalRiskSnapshot = data;
  const raw = parseJsonField(data.platform_policy_version?.config_json, {}), current = { ...(data.defaults || {}), ...(raw.values || raw.defaults || raw) }, controls = raw.controls || {}, meta = data.rule_metadata || {};
  const editable = Object.keys(data.defaults || {}).filter(key => typeof data.defaults[key] === "number");
  const renderGlobalRiskRow = key => { const control = controls[key] || {}, direction = RISK_SAFETY_LABELS[meta[key]?.safety_direction] || "平台规则"; return `<details class="global-risk-row"><summary><span class="global-risk-name"><strong>${escapeHtml(RISK_LABELS[key] || key)}</strong><small>${escapeHtml(direction)} · ${meta[key]?.locked ? '系统强制，不可放宽' : `当前默认 ${escapeHtml(current[key])}`}</small></span><i data-lucide="chevron-down" size="15"></i></summary><div class="global-risk-fields"><label><span>平台默认值</span><input data-global-risk-field="${escapeHtml(key)}" type="number" step="any" value="${escapeHtml(current[key])}"></label><label><span>用户允许的最小值</span><input data-global-risk-min="${escapeHtml(key)}" type="number" step="any" value="${escapeHtml(control.allowed_min ?? meta[key]?.allowed_min ?? '')}" ${meta[key]?.locked ? 'disabled' : ''}></label><label><span>用户允许的最大值</span><input data-global-risk-max="${escapeHtml(key)}" type="number" step="any" value="${escapeHtml(control.allowed_max ?? meta[key]?.allowed_max ?? '')}" ${meta[key]?.locked ? 'disabled' : ''}></label><label><span>平台锁定值</span><input data-global-risk-lock="${escapeHtml(key)}" type="number" step="any" placeholder="不锁定" value="${escapeHtml(control.locked_value ?? '')}" ${meta[key]?.locked ? 'disabled' : ''}></label></div></details>`; };
  $("globalRiskEditor").innerHTML = `<div class="global-risk-groups">${RISK_GROUPS.map(([title, keys], index) => { const rows = keys.filter(key => editable.includes(key)); return rows.length ? `<details class="workspace-panel global-risk-group" ${index === 0 ? 'open' : ''}><summary><span><strong>${escapeHtml(title)}</strong><small>${rows.length} 项平台规则</small></span><i data-lucide="chevron-down" size="16"></i></summary><div class="global-risk-group-body">${rows.map(renderGlobalRiskRow).join("")}</div></details>` : ""; }).join("")}</div>`;
  $("adminRiskAccounts").innerHTML = (data.accounts || []).map(account => `<article class="workspace-row"><div class="workspace-row-main"><div class="workspace-row-title">${escapeHtml(account.user_nickname || account.user_email || `用户 #${account.user_id}`)} · ${escapeHtml(account.nickname || account.login_account)} <span class="status-chip ${account.halt_status === 'active' ? 'success' : 'danger'}">${escapeHtml(account.halt_status || '未初始化')}</span></div><div class="workspace-row-meta"><span>回撤 ${escapeHtml(account.drawdown_pct ?? '--')}%</span><span>连亏 ${escapeHtml(account.consecutive_losses ?? '--')}</span><span>冷却至 ${escapeHtml(account.cooldown_until || '--')}</span><span>Kill Switch ${account.user_kill_switch ? '开启' : '关闭'}</span><span>数据 ${account.data_complete ? '完整' : `不完整：${escapeHtml(riskDataIncompleteText(account.data_incomplete_reason))}`}</span></div></div></article>`).join("") || '<div class="empty-state">暂无账户风险状态</div>';
  const global = data.global_control || {}, globalEnabled = Boolean(global.global_kill_switch);
  $("globalKillSwitchBtn").textContent = globalEnabled ? "解除平台紧急停止" : "紧急停止所有新开仓";
  $("globalKillSwitchBtn").dataset.enabled = globalEnabled ? "0" : "1";
  $("globalKillSwitchBtn").classList.toggle("btn-danger", !globalEnabled);
  $("globalKillSwitchMeta").innerHTML = `<span>当前：${globalEnabled ? '已停止新开仓' : '正常'}</span><span>原因：${escapeHtml(global.reason || '--')}</span><span>更新时间：${escapeHtml(global.updated_at || '--')}</span>`;
  const health = rolloutData.health || {}, globalFlags = (health.feature_flags || []).find(item => item.scope === "global") || {};
  const globalInputs = { globalReviewGenerationFlag:"review_generation_enabled", globalExperienceMemoryFlag:"experience_memory_enabled", globalMemoryCompressionFlag:"memory_compression_enabled", globalRetrievalShadowFlag:"retrieval_shadow_enabled", globalPairedExperimentFlag:"paired_experiment_enabled" };
  for (const [id,key] of Object.entries(globalInputs)) if ($(id)) $(id).checked = Boolean(globalFlags[key]);
  const metrics = health.metrics || {};
  const globalOverview = $("globalRiskOverview");
  const exceptionCount = Number((data.exceptions || []).length);
  const haltedCount = (data.accounts || []).filter(account => account.halt_status !== "active").length;
  if (globalOverview) globalOverview.innerHTML = `<div class="insight-item ${globalEnabled ? 'danger' : 'success'}"><span>平台新开仓</span><strong>${globalEnabled ? '已紧急停止' : '正常运行'}</strong><small>${globalEnabled ? escapeHtml(global.reason || '管理员已停止全部新开仓') : '全局紧急停止未开启'}</small></div><div class="insight-item ${exceptionCount ? 'warning' : ''}"><span>异常账户</span><strong class="num">${exceptionCount}</strong><small>${exceptionCount ? '需要管理员处理' : '没有身份或绑定异常'}</small></div><div class="insight-item ${haltedCount ? 'warning' : ''}"><span>账户级暂停</span><strong class="num">${haltedCount}</strong><small>由账户风控状态决定</small></div><div class="insight-item ${Number(health.alerts?.length || 0) ? 'danger' : ''}"><span>系统告警</span><strong class="num">${Number(health.alerts?.length || 0)}</strong><small>风控与任务运行健康度</small></div>`;
  $("rolloutHealthSummary").innerHTML = `<span>告警 ${Number(health.alerts?.length || 0)}</span><span>不确定订单 ${Number(metrics.uncertain?.count || 0)}</span><span>最老不确定 ${Number(metrics.uncertain?.oldest_seconds || 0)} 秒</span><span>结果归因积压 ${Number(metrics.outcome_backlog?.backlog || 0)}</span><span>凭据迁移 ${escapeHtml(rolloutStatusLabel(health.credential_migration?.status))}</span>`;
  const rolloutHost = $("riskRuleRolloutList");
  if (rolloutHost) rolloutHost.innerHTML = (health.risk_rule_rollouts || []).map(rule => `<article class="workspace-row risk-rollout-row"><div class="workspace-row-main"><div class="workspace-row-title">${escapeHtml(riskRolloutLabel(rule.rule_code))} ${rule.forced_enforce ? '<span class="status-chip danger">强制规则</span>' : '<span class="status-chip info">可调规则</span>'}</div><div class="workspace-row-meta"><span>${rule.forced_enforce ? '系统安全边界，必须正式拦截' : '可在正式拦截与仅观察之间切换'}</span><span class="internal-rule-code">内部编号 ${escapeHtml(rule.rule_code)}</span><span>更新 ${escapeHtml(rule.updated_at || '--')}</span></div></div><div class="workspace-row-actions"><select aria-label="${escapeHtml(riskRolloutLabel(rule.rule_code))}的运行模式" data-risk-rollout="${escapeHtml(rule.rule_code)}" ${rule.forced_enforce ? 'disabled' : ''}><option value="enforce" ${rule.mode === 'enforce' ? 'selected' : ''}>正式拦截</option><option value="shadow" ${rule.mode === 'shadow' ? 'selected' : ''}>仅观察，不拦截</option></select></div></article>`).join("") || '<div class="empty-state">暂无规则灰度数据</div>';
  renderAccountExceptions(data.exceptions || []);
  initIcons();
}

async function saveGlobalFeatureFlags() {
  await api("/api/ai/admin/feature-flags", { method:"PUT", body:{ flags:{ review_generation_enabled:$("globalReviewGenerationFlag").checked,
    experience_memory_enabled:$("globalExperienceMemoryFlag").checked, memory_compression_enabled:$("globalMemoryCompressionFlag").checked,
    retrieval_shadow_enabled:$("globalRetrievalShadowFlag").checked, paired_experiment_enabled:$("globalPairedExperimentFlag").checked } } });
  toast("全局灰度开关已保存", "success"); await loadAdminRiskCenter();
}

function renderAccountExceptions(accounts) {
  const host = $("accountExceptionList"); if (!host) return;
  const reasonLabels = { duplicate_account_binding:"同一交易账户已绑定其他用户", frozen:"账户已冻结", paused:"账户已暂停" };
  host.innerHTML = accounts.length ? accounts.map(account => {
    const reason = reasonLabels[account.anomaly_code] || reasonLabels[account.observe_status] || account.anomaly_code || "身份状态异常";
    return `<article class="workspace-row"><div class="workspace-row-main"><div class="workspace-row-title">${escapeHtml(account.user_nickname || account.user_email || `用户 #${account.user_id}`)} · ${escapeHtml(account.login_account)} <span class="status-chip danger">${escapeHtml(reason)}</span></div><div class="workspace-row-meta"><span>${escapeHtml(account.broker_server)}</span><span>账户状态：${escapeHtml(account.observe_status)}</span><span>首次验证：${escapeHtml(account.first_verified_at || '--')}</span></div></div></article>`;
  }).join("") : '<div class="empty-state"><strong>没有异常账户</strong><span>普通账户已由 Bridge 自动完成身份验证。</span></div>';
}

async function saveGlobalRisk() {
  const values = {}, controls = {};
  document.querySelectorAll("[data-global-risk-field]").forEach(input => { values[input.dataset.globalRiskField] = Number(input.value); });
  document.querySelectorAll("[data-global-risk-min]").forEach(input => { const key=input.dataset.globalRiskMin; controls[key] ||= {}; controls[key].allowed_min=Number(input.value); });
  document.querySelectorAll("[data-global-risk-max]").forEach(input => { const key=input.dataset.globalRiskMax; controls[key] ||= {}; controls[key].allowed_max=Number(input.value); });
  document.querySelectorAll("[data-global-risk-lock]").forEach(input => { const key=input.dataset.globalRiskLock; controls[key] ||= {}; controls[key].locked_value=input.value === "" ? null : Number(input.value); });
  await api("/api/ai/admin/risk-center", { method:"PUT", body:{ values, controls, reason:"管理员从全局风控页面更新" } });
  toast("全局风控新版本已生效", "success"); await loadAdminRiskCenter();
}

function setTab(tabId, options = {}) {
  const modelStrategyTarget = tabId === "model-management" ? "models" : tabId === "ai-config" ? "strategies" : null;
  if (modelStrategyTarget) tabId = "model-strategy";
  if (tabId !== "review-memory") stopReviewDetailPolling();
  document.querySelectorAll(".nav-item").forEach((button) => {
    button.classList.toggle("active", button.dataset.tab === tabId);
  });
  document.querySelectorAll(".tab-panel").forEach((panel) => {
    panel.classList.toggle("active", panel.id === tabId);
  });
  const main = document.querySelector(".main");
  if (main) main.scrollTop = 0;
  if (tabId === "model-strategy") setModelStrategySubtab(modelStrategyTarget || state.modelStrategySubtab || "strategies");
  initIcons();
  if (!options.skipRefresh) refreshTabData(tabId).catch((error) => toast(error.message, "error"));
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
  initIcons();
}

async function refreshTabData(tabId) {
  if (!state.token) return;
  if (tabId === "trading") {
    await Promise.allSettled([loadAccount(), loadPositions(), loadStatus(), loadPendingOrders(), refreshQuote()]);
  } else if (tabId === "dashboard") {
    await Promise.allSettled([loadAccount(), loadPositions(), loadStatus(), loadKlineData()]);
    startKlineRefreshTimer();
  } else if (tabId === "history") {
    await Promise.allSettled([loadAccount(), loadHistory(), loadHistoryChart()]);
  } else if (tabId === "audit") {
    await loadAudit();
  } else if (tabId === "model-strategy") {
    await Promise.allSettled([loadStrategyCatalog(), loadModelManagement()]);
  } else if (tabId === "ai-analyze") {
    await Promise.allSettled([loadStrategyCatalog(), loadSignals({ skipResultRender:true })]);
  } else if (tabId === "risk-center") {
    await loadRiskCenter();
  } else if (tabId === "review-memory") {
    await loadReviewMemory();
  } else if (tabId === "global-risk") {
    await loadAdminRiskCenter();
  } else if (tabId === "model-compare") {
    await loadModelCompare();
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

function logout() {
  if (state.bridgeWs) { try { state.bridgeWs.close() } catch {} state.bridgeWs = null; }
  stopRealtimeSync();
  stopPresenceHeartbeat();
  stopReviewDetailPolling();
  if (state.reviewSummaryTimer) clearInterval(state.reviewSummaryTimer);
  state.reviewSummaryTimer = null;
  state.user = null;
  state.selectedSignal = null;
  setAuth("");
  showApp(false);
  window.location.href = "/";
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

async function bootstrap() {
  try {
    const urlToken = new URLSearchParams(window.location.search).get("token");
    if (urlToken) {
      state.token = urlToken;
      localStorage.setItem("authToken", urlToken);
      const url = new URL(window.location);
      url.searchParams.delete("token");
      window.history.replaceState({}, "", url);
    }
    if (!state.token) {
      const cookieToken = getCookie("ws_token");
      if (cookieToken) {
        state.token = cookieToken;
        localStorage.setItem("authToken", cookieToken);
      }
    }
    if (!state.token) {
      window.location.href = "/";
      return;
    }
    const profileRes = await api("/api/profile");
    state.user = profileRes.user;
    // Check if plan expired (backend also downgrades, but show specific message here)
    const expiresAt = state.user?.planExpiresAt;
    if (expiresAt && new Date(expiresAt) <= new Date()) {
      // Plan expired — show expired overlay instead of generic upgrade
      document.getElementById('proOverlay')?.classList.remove('hidden');
      const overlay = document.getElementById('proOverlay');
      if (overlay) {
        overlay.innerHTML = `
          <div class="pro-overlay-content">
            <div class="pro-overlay-icon">⏰</div>
            <h2>会员已过期</h2>
            <p>您的会员已于 ${new Date(expiresAt).toLocaleDateString('zh-CN')} 到期</p>
            <p>请联系管理员续费以继续使用</p>
            <button onclick="logout()" style="margin-top:16px;padding:8px 24px;border:none;border-radius:6px;background:#e6a756;color:#1a1a2e;cursor:pointer;font-size:14px">返回首页</button>
          </div>
        `;
      }
      showApp(false);
      return;
    }
    // Access check: admin/pro/plus can access
    const role = state.user?.role;
    const plan = state.user?.plan;
    const hasAccess = role === 'admin' || plan === 'pro' || plan === 'plus';
    if (!hasAccess) {
      document.getElementById('proOverlay')?.classList.remove('hidden');
      showApp(false);
      return;
    }
    state.isPlusReadOnly = plan === 'plus' && role !== 'admin';
    applyRoleUI();
    showApp(true);
    checkChangelog();
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
    // Set default tab after WS connected
    setTab('dashboard');
    startPresenceHeartbeat();
    await refreshAll();
    await loadReviewSummary({ announce:false });
    startReviewSummaryPolling();
    // Data loads on-demand: tab switch + manual refresh + bridge data push
    refreshTabData(activeTabId());
  } catch {
    logout();
  }
}

async function refreshAll() {
  const button = $("refreshAllBtn");
  await withBusy(button, async () => {
    const results = await Promise.allSettled([
      loadStatus(),
      loadSymbols(),
      loadAccount(),
      loadPositions(),
      loadStrategyCatalog(),
      loadSignals(),
      loadHistory(),
      loadHistoryChart(),
      loadAudit(),
      loadKlineData(),
    ]);
    const rejected = results.find((item) => item.status === "rejected");
    if (rejected && state.token) {
      toast(`部分数据刷新失败：${rejected.reason.message || rejected.reason}`, "warning");
    }
  });
}

async function loadStatus() {
  const health = await wsApi("health");
  const gateway = health.gateway || {};
  const isLive = gateway.mode === "live";
  const usingFallback = gateway.using_fallback;
  const wasLive = state._lastGatewayLive;
  state._usingFallback = usingFallback;

  // Gateway badge — bridge connection status
  if (usingFallback) {
    if (state.isPlusReadOnly) {
      setBadge("gatewayMode", "观摩模式", "warning");
    } else {
      setBadge("gatewayMode", "观摩模式-请连接您的MT5", "warning");
    }
  } else {
    setBadge("gatewayMode", isLive ? "MT5桥接-已连接" : "未连接-请启动桥接脚本", isLive ? "connected" : "neutral");
  }

  // Sync role-based UI (observation hint, button states, etc.)
  applyRoleUI();

  // Reload symbols when bridge just came online
  if (isLive && !wasLive) {
    loadSymbols().catch(() => {});
  }
  state._lastGatewayLive = isLive;

  // Trade mode badge
  const mt5TradeBlocked = isLive
    && gateway.live_trading_enabled
    && (gateway.terminal_trade_allowed === false || gateway.account_trade_allowed === false || gateway.account_trade_expert === false);
  const tradeText = !isLive
    ? "请先启动桥接"
    : mt5TradeBlocked ? "MT5 自动交易关闭"
    : gateway.live_trading_enabled ? "交易发送开启" : "交易发送关闭";
  setBadge("tradeMode", tradeText, gateway.live_trading_enabled && !mt5TradeBlocked ? "danger" : "neutral");

  // Update market status from server (server now detects staleness via tick_time)
  if (typeof gateway.trade_mode === 'number') updateMarketStatus(gateway.trade_mode);
  const marketClosed = state.marketTradeMode !== 4;

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
    setBadge("autoAnalyzeMode", "自动推理状态未知", "warning");
  }

}

// ============ Gateway Badge Click ============
// ============ Gateway Badge Click — MT5 connect/disconnect ============
async function handleGatewayModeClick() {
  // Plus users: blocked from bridge download entirely
  if (state.isPlusReadOnly) {
    toast("Pro 会员可连接 MT5 账户", "warning");
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
    let url = `https://qiniu.acadfx.com/AURUM_Bridge/AURUM_Bridge_Setup_${window._bridgeVersion || 'latest'}.exe`;
    let version = window._bridgeVersion || 'latest';
    try {
      const resp = await fetch("/api/bridge/version");
      const data = await resp.json();
      if (data.full_url || data.updater_url) url = data.full_url || data.updater_url;
      if (data.version) { version = "v" + data.version; window._bridgeVersion = data.version; }
    } catch {}
    const a = document.createElement("a");
    a.href = url; a.download = url.split("/").pop(); a.click();
    toast(`正在下载 MT5 桥接客户端 ${version}`, "success");
    modal.classList.add("hidden");
  });

}

// ============ Trade Mode Badge Click — toggle trade sending ============
async function handleTradeModeClick() {
  if (state.isPlusReadOnly) { toast("Plus 会员仅可查看", "warning"); return; }
  if (state.user?.role !== 'admin' && state.user?.plan === 'pro' && state._usingFallback) { toast("请先连接您的 MT5 账户", "warning"); return; }
  const health = await wsApi("health").catch(() => null);
  const gateway = health?.gateway || {};
  const currentlyEnabled = gateway.live_trading_enabled;

  // Turning ON requires MT5 connection
  if (!currentlyEnabled && gateway.mode !== "live") {
    toast("请先启动桥接脚本", "warning");
    return;
  }

  // Turning OFF requires confirmation
  if (currentlyEnabled && !await showConfirm("关闭交易发送", "确认关闭交易发送？关闭后将停止向 MT5 发送交易指令。", { confirmText: "关闭", danger: true })) return;

  try {
    const result = await wsApi("toggle_trade", { enable: !currentlyEnabled });
    toast(currentlyEnabled ? "交易发送已关闭" : "交易发送已开启", "success");
    await loadStatus();
  } catch (e) {
    toast("切换失败: " + e.message, "error");
  }
}

// ============ Auto Toggle (Simple) ============
let _autoToggleLock = false;
async function handleAutoToggle() {
  if (_autoToggleLock) return;
  if (state.isPlusReadOnly) { toast("Plus 会员仅可查看", "warning"); return; }
  if (state.user?.role !== 'admin' && state.user?.plan === 'pro' && state._usingFallback) { toast("请先连接您的 MT5 账户", "warning"); return; }
  const activeCycles = activeAutoProgressCycles(state.autoRuntime);
  const closeTitle = activeCycles.length ? "停止后续自动推理" : "关闭自动推理";
  const closeMessage = activeCycles.length
    ? `当前有 ${activeCycles.length} 个品种正在推理。关闭后不会再开始新任务，已经提交给模型的任务仍会安全完成。`
    : "确认关闭自动推理？关闭后将停止自动 AI 分析和信号推送。";
  if (state.autoEnabled && !await showConfirm(closeTitle, closeMessage, { confirmText: activeCycles.length ? "停止后续任务" : "关闭", danger: true })) return;
  _autoToggleLock = true;
  try {
    const result = await wsApi('toggle_auto');
    await loadStatus();
    toast(result.message || (result.enabled ? '自动推理已开启' : '自动推理已关闭'), 'success');
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
  // 观摩账户：服务器名含 Demo 时显示为 Live
  const server = state._usingFallback ? rawServer.replace(/Demo/gi, 'Live') : rawServer;
  const currency = data.currency || "USD";
  state.accountBalance = parseFloat(data.balance) || 0;
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

async function refreshQuote() {
  const symbol = $("quoteSymbolSelect")?.value || $("tradeSymbolSelect")?.value || "XAUUSD";
  if (!symbol) return;
  const data = await wsApi("quote", { symbol });
  const bid = Number(data.bid);
  const ask = Number(data.ask);
  const previousQuote = state.lastQuote && state.lastQuote.symbol === symbol ? state.lastQuote : null;
  let bidDirection = "";
  let askDirection = "";

  if (previousQuote) {
    if (Number.isFinite(bid) && bid > previousQuote.bid) bidDirection = "up";
    if (Number.isFinite(bid) && bid < previousQuote.bid) bidDirection = "down";
    if (Number.isFinite(ask) && ask > previousQuote.ask) askDirection = "up";
    if (Number.isFinite(ask) && ask < previousQuote.ask) askDirection = "down";
  }

  setText("quoteBid", data.bid);
  setText("quoteAsk", data.ask);
  setText("quoteSpread", data.spread);
  setText("quoteTime", formatTime(data.time));
  setQuoteDirection("quoteBidDir", bidDirection);
  setQuoteDirection("quoteAskDir", askDirection);
  flashPrice("quoteBid", bidDirection);
  flashPrice("quoteAsk", askDirection);

  if (Number.isFinite(bid) && Number.isFinite(ask)) {
    setQuoteChangeUnavailable();
    state.lastQuote = { symbol, bid, ask, spread: Number(data.spread), time: data.time };
    updateTradingQuotePreview(state.lastQuote);
    updateKlineTick(data.bid, data.ask, data);
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

  // Volume refresh every 5 seconds (was 1s, reduced for performance)
  clearInterval(_klineVolRefreshTimer);
  _klineVolRefreshTimer = setInterval(refreshKlineVolume, 5000);

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
      const platform = meta.source === 'platform_admin_bridge';
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

// Lightweight: fetch only the last bar's volume every second
async function refreshKlineVolume() {
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
  const quoteMt5Sec = mt5BrokerTimeSeconds(quote?.time);
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
function startKlineRefreshTimer() {
  clearInterval(_klineRefreshTimer);
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
        <td>${escapeHtml(position.symbol)}</td>
        <td><span class="${directionClass}">${directionLabel}</span></td>
        <td class="num">${escapeHtml(volumeText(position.volume))}</td>
        <td class="num">${fmt(position.price_open, priceDigits)}</td>
        <td class="num">${fmt(position.price_current, priceDigits)}</td>
        <td class="num">${escapeHtml(formatTime(position.time))}</td>
        ${withAction ? `<td class="num">${Number(position.sl) ? fmt(position.sl, priceDigits) : "--"}</td><td class="num">${Number(position.tp) ? fmt(position.tp, priceDigits) : "--"}</td>` : ""}
        <td class="${profitClass(position.profit)}">${fmt(position.profit)}</td>
        ${withAction ? `<td><button class="btn small" data-close-ticket="${escapeHtml(position.ticket)}"><i data-lucide="x" size="12"></i>平仓</button></td>` : ""}
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
    return `<td class="num"><a href="#" class="signal-link" onclick="event.preventDefault(); openAnalysisFromHistory(${signalId})">${escapeHtml(ticket)}</a></td>`;
  }
  return `<td class="num">${escapeHtml(ticket)}</td>`;
}

async function loadPositions() {
  const [data] = await Promise.all([
    wsApi("positions", {}),
    loadSignalTickets(),
  ]);
  const positions = data.positions || [];
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

function applyRoleUI() {
  const isAdmin = state.user?.role === "admin";
  const isPlusReadOnly = state.isPlusReadOnly;
  const isPro = state.user?.plan === "pro" || isAdmin;
  // Pro without bridge = has own account but bridge not connected (using admin fallback)
  const isProNoBridge = isPro && !isAdmin && state._usingFallback;

  // Admin-only UI elements
  document.querySelectorAll('.admin-only').forEach(el => {
    el.style.display = isAdmin ? '' : 'none';
  });
  document.querySelectorAll('.user-only').forEach(el => {
    el.style.display = isAdmin ? 'none' : '';
  });
  setText("memoryTabLabel", isAdmin ? "平台经验" : "我的记忆");
  setText("memoryActiveLabel", isAdmin ? "已发布经验" : "有效记忆");
  setText("memoryActiveHelp", isAdmin ? "可用于平台策略" : "可用于后续推理");
  setText("memorySectionTitle", isAdmin ? "平台策略经验" : "我的交易记忆");
  setText("memorySectionDescription", isAdmin
    ? "来自观摩账户复盘的市场经验先进入候选区，经发布后才会用于平台策略。"
    : "这里只保留你已经确认的经验，可以随时暂停或撤销。");
  if ($("addPrivateStrategyBtn")) $("addPrivateStrategyBtn").textContent = isAdmin ? "新建策略" : "新建自定义策略";

  // 管理分组：仅桥接已连接时显示
  const navGroupManage = document.getElementById('navGroupManage');
  if (navGroupManage) {
    const bridgeConnected = !state._usingFallback && state._lastGatewayLive;
    navGroupManage.style.display = (isAdmin || bridgeConnected) ? '' : 'none';
  }

  // Free users: locked out entirely (proOverlay shown during init)

  // === Plus users: observation-only mode ===
  // Hide model config tab
  const modelTabs = document.querySelectorAll('.nav-item[data-tab="model-strategy"]');
  modelTabs.forEach(modelTab => { modelTab.style.display = isPlusReadOnly ? "none" : ""; });

  // Keep gateway badge clickable for all users — guards in click handlers block action
  const gatewayBadge = document.getElementById("gatewayMode");
  if (gatewayBadge) {
    gatewayBadge.classList.add("clickable-badge");
    if (isPlusReadOnly) {
      gatewayBadge.title = "Plus 会员仅可查看";
    } else if (isProNoBridge) {
      gatewayBadge.title = "";
    } else {
      gatewayBadge.title = "";
    }
  }

  // Plus read-only: disable all action buttons, hide bridge download
  if (isPlusReadOnly) {
    showSidebarObserveHint('您正在以观摩模式查看实时数据，如需使用 AI 推理和交易功能请 <a href="/membership">升级 Pro</a>');
    document.querySelectorAll('.card-action-btn, .btn-primary, .btn-danger, .btn-success, #executeSignalBtn, [data-action="execute"], [data-action="close-position"]').forEach(el => {
      el.disabled = true;
      el.title = 'Plus 会员仅可查看';
    });
    // Disable symbol selectors (observe mode)
    document.querySelectorAll('.sym-input').forEach(el => {
      el.disabled = true;
      el.title = 'Plus 会员仅可查看';
    });
    // Keep clickable-badge on all topbar badges (for pointer cursor) — guards in click handlers block action
    const autoMode = document.getElementById("autoAnalyzeMode");
    if (autoMode) { autoMode.classList.add("clickable-badge"); autoMode.title = "Plus 会员仅可查看"; }
    return;
  }

  // === Pro without bridge: 观摩模式，可打开下载页，模型页只显示自有数据 ===
  if (isProNoBridge) {
    showSidebarObserveHint('观摩模式 · 请 <a href="#" id="sidebarBridgeLink">下载并启动MT5桥接</a> 后使用完整功能');
    // Disable trade-related buttons
    document.querySelectorAll('[data-action="execute"], [data-action="close-position"]').forEach(el => {
      el.disabled = true;
      el.title = '请先连接您的 MT5 账户';
    });
    // Disable trade toggle, keep clickable-badge (cursor only, handler guarded)
    const tradeMode = document.getElementById("tradeMode");
    if (tradeMode) { tradeMode.classList.add("clickable-badge"); tradeMode.title = "请先连接 MT5 账户"; }
    // Keep gateway badge clickable (opens bridge download modal)
    const gatewayBadge2 = document.getElementById("gatewayMode");
    if (gatewayBadge2) { gatewayBadge2.classList.add("clickable-badge"); gatewayBadge2.title = ""; }
    // Allow execute button but show disabled state
    const execBtn = document.getElementById("executeSignalBtn");
    if (execBtn) { execBtn.disabled = true; execBtn.title = "请先连接 MT5 账户"; }
    // Disable symbol selectors (observe mode)
    document.querySelectorAll('.sym-input').forEach(el => {
      el.disabled = true;
      el.title = '请先连接您的 MT5 账户';
    });
    // Disable auto-inference badge (observation mode)
    const autoMode = document.getElementById("autoAnalyzeMode");
    if (autoMode) { autoMode.classList.add("clickable-badge"); autoMode.title = "请先连接您的 MT5 账户"; }
    // 绑定 sidebar 观摩提示中的下载链接
    setTimeout(() => {
      document.getElementById("sidebarBridgeLink")?.addEventListener("click", (e) => {
        e.preventDefault();
        handleGatewayModeClick();
      });
    }, 100);
    return;
  }

  // === Pro with bridge / Admin: full access ===
  // Hide observation hint
  hideSidebarObserveHint();
  // Re-enable symbol selectors
  document.querySelectorAll('.sym-input').forEach(el => { el.disabled = false; el.title = ''; });
  const tradeMode = document.getElementById("tradeMode");
  if (tradeMode) { tradeMode.classList.add("clickable-badge"); tradeMode.title = ""; }
  const autoMode = document.getElementById("autoAnalyzeMode");
  if (autoMode) { autoMode.classList.add("clickable-badge"); autoMode.title = ""; }
  const gatewayBadge3 = document.getElementById("gatewayMode");
  if (gatewayBadge3) { gatewayBadge3.classList.add("clickable-badge"); gatewayBadge3.title = ""; }
  // Show model tab
  modelTabs.forEach(modelTab => { modelTab.style.display = ""; });
}

// [disabled] 智能平仓
function updateSignalDisplay(signal) {
  const card = $("signalCard");
  if (!card) return;

  if (!signal) {
    state.selectedSignal = null;
    setSignalBadge(null);
    card.dataset.direction = "hold";
    card.dataset.status = "empty";
    card.style.setProperty("--signal-border", "var(--color-warning)");
    card.style.setProperty("--signal-glow", "var(--signal-glow-hold)");
    setText("sigSymbol", "--");
    setText("sigTimeframe", "--");
    setText("sigDirection", "--");
    setText("sigDirectionText", "等待信号");
    $("sigDirection").className = "signal-direction hold";
    $("sigDirectionText").className = "signal-direction-text hold";
    setText("sigConfidence", "--");
    updateSignalPriceFields(null);
    $("sigBar").style.width = "0%";
    setText("sigTime", "等待新信号");
    setText("sigGeneratedAt", "--");
    setText("sigValidWindow", "--");
    $("executeSignalBtn").disabled = true;
    $("executeSignalBtn").title = "暂无可执行信号";
    return;
  }

  state.selectedSignal = signal;
  setSignalBadge(signal);
  const dir = signalType(signal.signal_type);
  const confidence = confidenceInfo(signal.confidence);
  const colorMap = {
    buy: { border: "var(--color-positive)", glow: "var(--signal-glow-buy)" },
    sell: { border: "var(--color-negative)", glow: "var(--signal-glow-sell)" },
    hold: { border: "var(--color-warning)", glow: "var(--signal-glow-hold)" },
    close: { border: "var(--color-info, #63b3ed)", glow: "0 0 15px rgba(99,179,237,0.3)" },
  };

  card.dataset.direction = dir;
  const advice = signalExecutionAdvice(signal);
  card.dataset.status = ["executed", "pending"].includes(advice.state) ? advice.state : signalIsStale(signal) ? "expired" : "live";
  card.style.setProperty("--signal-border", colorMap[dir].border);
  card.style.setProperty("--signal-glow", colorMap[dir].glow);
  setText("sigSymbol", signal.symbol || "--");
  setText("sigTimeframe", signal.timeframe || "--");
  setText("sigDirection", dir.toUpperCase());
  setText("sigDirectionText", directionText(signal.signal_type));
  $("sigDirection").className = `signal-direction ${dir}`;
  $("sigDirectionText").className = `signal-direction-text ${dir}`;
  setText("sigConfidence", confidence.label);
  updateSignalPriceFields(signal);
  $("sigBar").style.width = `${confidence.value}%`;
  setText("sigTime", signalDisplayTime(signal));
  setText("sigGeneratedAt", signalDisplayTime(signal));
  setText("sigValidWindow", signalFreshness(signal));
  const executable = advice.executable === true && dir !== "hold" && dir !== "close" && !signal.is_stale;
  $("executeSignalBtn").disabled = !executable;
  $("executeSignalBtn").title = executable
    ? "复核后发送执行请求"
    : dir === "close" ? "持仓分析信号已自动执行"
      : signal.is_stale ? "信号已过期，无法执行"
        : advice.description || (signal.is_executed ? "信号已执行" : "HOLD 观望信号不执行");
}

function signalFreshness(signal) {
  if (!signal) return "--";
  // Compute age in real-time from created_at, not from stale snapshot
  const ttl = Number(signal.ttl_seconds);
  if (!Number.isFinite(ttl)) return signal.ttl_seconds ? `TTL ${signal.ttl_seconds}s` : "--";
  const createdAt = parseBeijingServerTime(signal.created_at);
  if (!createdAt || isNaN(createdAt)) return "--";
  const age = Math.floor((Date.now() - createdAt) / 1000);
  const isStale = age > ttl;
  if (isStale) return "已过期";
  return `${age}s / ${ttl}s`;
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
    summary: signal?.decision_summary || stored.decision_summary || (dir === "hold" ? "当前条件不足，建议继续观望。" : `${dir === "buy" ? "偏多" : "偏空"}机会成立，等待风控复核。`),
    trigger: signal?.trigger_condition || stored.trigger_condition || "",
    invalidation: signal?.invalidation_condition || stored.invalidation_condition || "",
    reasons: Array.isArray(sourceReasons) ? sourceReasons.slice(0, 4) : [],
    risks: Array.isArray(sourceRisks) ? sourceRisks.slice(0, 4) : [],
    bullishScore: hasDirectionBias ? Math.round(bullish / total * 1000) / 10 : null,
    bearishScore: hasDirectionBias ? Math.round(bearish / total * 1000) / 10 : null,
    experienceUsage,
  };
}

function canViewSignalExperienceUsage(signal, usage = {}) {
  const source = String(usage.source || "").toLowerCase();
  if (source === "platform") return state.user?.role === "admin";
  if (source === "personal") return state.user?.role !== "admin" && Number(signal?.user_id) === Number(state.user?.id);
  return false;
}

function renderExperienceUsage(signal, usage = {}) {
  if (!canViewSignalExperienceUsage(signal, usage)) return "";
  const considered = Array.isArray(usage.considered_ids) ? usage.considered_ids : [];
  if (!considered.length) return "";
  const used = Array.isArray(usage.used_ids) ? usage.used_ids : [];
  const rejected = Array.isArray(usage.rejected_ids) ? usage.rejected_ids : [];
  const source = usage.source === "platform" ? "平台经验" : "个人记忆";
  return `<section class="analysis-experience-usage">
    <div class="analysis-section-title"><i data-lucide="brain-circuit" size="15"></i><strong>经验采用情况</strong><span>${escapeHtml(source)}</span></div>
    <div class="experience-usage-stats"><span>系统候选 <strong>${considered.length}</strong></span><span class="used">模型采用 <strong>${used.length}</strong></span><span>未采用 <strong>${rejected.length}</strong></span></div>
    <p>${escapeHtml(usage.influence || (used.length ? `本次采用经验 #${used.join("、#")}` : "模型评估后未采用候选经验。"))}</p>
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
  if (signal?.is_executed) return { state:"executed", title:"订单已执行", description:"执行结果已记录。", executable:false };
  if (signalIsStale(signal)) return { state:"expired", title:"信号已过期", description:"请重新推理后再执行。", executable:false };
  if (signal?.execution_advice) return signal.execution_advice;
  if (signalType(signal?.signal_type) === "hold") return { state:"observe", title:"暂不执行", description:"等待市场条件改善。", executable:false };
  return { state:"review", title:"建议复核后执行", description:"执行前将获取最新报价并由风控计算最终手数。", executable:true };
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
      <div><span class="analysis-section-title"><i data-lucide="candlestick-chart" size="15"></i><strong id="inferenceChartTitle">K 线与结构证据</strong></span><small>${escapeHtml(sourceLabel)} · ${escapeHtml(evidenceLabel)} · 仅展示推理发生时的数据 · MT5 时间 · 最后一根为推理时未收盘 K 线</small></div>
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
    updateSignalDisplay(null);
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

  updateSignalDisplay(signal);
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
  const reasoningText = String(signal.reasoning || "").trim();
  // Try to parse structured positions data (CLOSE signals store JSON array)
  let closePositions = null;
  try {
    const raw = String(signal.analysis || "").trim();
    if (raw.startsWith("[")) { const arr = JSON.parse(raw); if (Array.isArray(arr) && arr.length > 0 && arr[0].ticket) closePositions = arr; }
  } catch {}
  let escapedAnalysis = closePositions ? "" : escapeHtml(String(signal.analysis || "").trim() || "暂无行情分析");
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
        <td>${escapeHtml(p.reason || "--")}</td>
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
        <span class="signal-tf-badge">${escapeHtml(signal.timeframe)}</span>
        <span class="analysis-direction-badge ${dir}">${dir.toUpperCase()} ${directionText(signal.signal_type)}</span>
      </div>
        <span class="analysis-time num">#${escapeHtml(signal.id)} · ${escapeHtml(signalDisplayTime(signal))}</span>
    </div>
    <section class="execution-advice-hero ${escapeHtml(advice.state || "review")}">
      <div class="execution-advice-icon"><i data-lucide="${advice.executable ? "send" : dir === "hold" ? "pause" : "shield-check"}" size="20"></i></div>
      <div><span>执行建议</span><strong>${escapeHtml(advice.title || executionStatus(signal))}</strong><p>${escapeHtml(advice.description || "")}</p></div>
      <span class="analysis-direction-badge ${dir}">${directionText(signal.signal_type)}</span>
    </section>
    <div class="decision-summary"><span>一句话结论</span><strong>${escapeHtml(decision.summary)}</strong></div>
    ${renderDirectionBias(decision)}
    <div class="analysis-status-strip">
      <div><span>置信度</span><strong>${confidence.label}</strong></div>
      <div><span>AI 建议手数</span><strong>${escapeHtml(volumeText(signal.recommended_volume))}</strong></div>
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
    toast("请选择推理策略", "warning");
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

async function loadModelCompare() {
  if (!state.modelProfiles?.length) {
    try {
      const data = await api(`/api/ai/model-profiles${profileScopeQuery()}`);
      state.modelProfiles = data.profiles || [];
    } catch { state.modelProfiles = []; }
  }
  const group = $("cmpModelGroup");
  const hint = $("cmpModelHint");
  if (group) {
    const profiles = (state.modelProfiles || []).filter(p => p.status === "active");
    if (!profiles.length) {
      group.innerHTML = '<span style="color:var(--text-secondary)">无可用模型，请先在模型管理中创建</span>';
    } else {
      group.innerHTML = profiles.map((p, i) => `<label class="model-compare-checkbox"><input type="checkbox" value="${Number(p.id)}" data-cmp-model ${i === 0 ? "checked" : ""}><span>${escapeHtml(p.model_name)}</span><small>${escapeHtml(modelProviderLabel(p.provider))}</small></label>`).join("");
      group.querySelectorAll("[data-cmp-model]").forEach(cb => cb.addEventListener("change", () => {
        const count = group.querySelectorAll("[data-cmp-model]:checked").length;
        if (hint) hint.textContent = count >= 2 ? `已选 ${count} 个模型` : count === 1 ? "再选至少 1 个模型" : "";
        $("cmpRunBtn").disabled = count < 2;
      }));
    }
  }
  if (hint) {
    const count = group?.querySelectorAll("[data-cmp-model]:checked").length || 0;
    hint.textContent = count >= 2 ? `已选 ${count} 个模型` : count === 1 ? "再选至少 1 个模型" : "";
    $("cmpRunBtn").disabled = count < 2;
  }
  const sel = $("cmpStrategy");
  if (sel && !sel.options.length) {
    try {
      const data = await api("/api/ai/strategies?include_inactive=1");
      const active = (data.strategies || []).filter(s => s.visibility_status === "active" && Number(s.is_active));
      _historyCompareStrategies = active;
      sel.innerHTML = '<option value="">请选择策略</option>' + active.map(s => `<option value="${s.id}">${escapeHtml(s.title)}</option>`).join("");
      sel.onchange = syncHistoryCompareStrategyInputs;
    } catch { sel.innerHTML = '<option value="">加载失败</option>'; }
  }
  setDefaultCompareDates();
  initIcons();
}

function setDefaultCompareDates() {
  const now = new Date(), beijing = new Date(now.getTime() + 8 * 3600000);
  const fmt = d => `${d.getUTCFullYear()}-${String(d.getUTCMonth()+1).padStart(2,'0')}-${String(d.getUTCDate()).padStart(2,'0')}T${String(d.getUTCHours()).padStart(2,'0')}:${String(d.getUTCMinutes()).padStart(2,'0')}`;
  const end = new Date(beijing), start = new Date(end.getTime() - 7 * 24 * 3600000);
  if ($("cmpEndTime")) $("cmpEndTime").value = fmt(end);
  if ($("cmpStartTime")) $("cmpStartTime").value = fmt(start);
}

let _historyCompareJobId = null;
let _historyCompareStrategies = [];

function syncHistoryCompareStrategyInputs() {
  const strategyId = Number($("cmpStrategy")?.value || 0);
  const strategy = _historyCompareStrategies.find(item => Number(item.id) === strategyId);
  if (!strategy) return;
  const symbols = parseJsonField(strategy.symbols_json, []);
  if (symbols.length && $("cmpSymbol")) $("cmpSymbol").value = symbols[0];
  const plan = parseJsonField(strategy.market_data_plan_json, {});
  const timeframes = Array.isArray(plan.timeframes)
    ? plan.timeframes.map(item => String(item.timeframe || "").toUpperCase()).filter(Boolean)
    : [];
  if ($("cmpTimeframe") && timeframes.length) {
    $("cmpTimeframe").innerHTML = timeframes.map(tf => `<option value="${escapeHtml(tf)}">${escapeHtml(tf)}</option>`).join("");
    const primaryTimeframe = String(plan.primary_timeframe || "").toUpperCase();
    $("cmpTimeframe").value = timeframes.includes(primaryTimeframe) ? primaryTimeframe : timeframes[0];
  }
}

async function runHistoryCompare() {
  if (_historyCompareJobId) {
    const jobId = _historyCompareJobId;
    try {
      await api(`/api/ai/model-compare/history/${encodeURIComponent(jobId)}`, { method:"DELETE" });
      if ($("cmpProgressLabel")) $("cmpProgressLabel").textContent = "正在取消任务…";
    } catch (error) {
      toast(`取消失败：${error.message}`, "error");
    }
    return;
  }
  const symbol = $("cmpSymbol")?.value?.trim().toUpperCase();
  const timeframe = $("cmpTimeframe")?.value || "M15";
  const strategyId = Number($("cmpStrategy")?.value || 0);
  const modelIds = [...document.querySelectorAll("[data-cmp-model]:checked")].map(cb => Number(cb.value)).filter(id => id > 0);
  const step = Number($("cmpStep")?.value) || 10;
  if (!symbol) return showToast("请输入交易品种", "error");
  if (!strategyId) return showToast("请选择推理策略", "error");
  if (modelIds.length < 2) return showToast("至少选择 2 个模型", "error");
  const startTime = $("cmpStartTime")?.value ? $("cmpStartTime").value + ":00" : "";
  const endTime = $("cmpEndTime")?.value ? $("cmpEndTime").value + ":00" : "";
  if (!startTime || !endTime) return showToast("请选择时间范围", "error");
  const btn = $("cmpRunBtn");
  if (btn) {
    btn.disabled = false;
    btn.innerHTML = '<i data-lucide="square" size="16"></i>取消对比';
  }
  $("cmpProgressBar")?.classList.remove("hidden");
  if ($("cmpProgressFill")) $("cmpProgressFill").style.width = "2%";
  if ($("cmpProgressLabel")) $("cmpProgressLabel").textContent = "正在提交对比任务...";
  try {
    const data = await api("/api/ai/model-compare/history", {
      method: "POST", body: { symbol, timeframe, model_ids: modelIds, strategy_id: strategyId, start_time: startTime, end_time: endTime, step },
    });
    _historyCompareJobId = data.job?.id || null;
    if (!_historyCompareJobId) throw new Error("history_compare_job_not_created");
    let job = data.job;
    while (["queued", "running", "cancelling"].includes(job.status)) {
      const progress = Math.max(2, Math.min(99, Number(job.progress_percent || 0)));
      if ($("cmpProgressFill")) $("cmpProgressFill").style.width = `${progress}%`;
      const stageLabels = {
        queued:"等待后台执行", preparing:"正在准备历史行情", market_ready:"历史行情已就绪",
        models_ready:"模型配置已就绪", evaluating:"正在逐段评估", cancelling:"正在取消",
      };
      if ($("cmpProgressLabel")) {
        const stepsText = job.total_steps ? ` · ${job.completed_steps || 0}/${job.total_steps}` : "";
        $("cmpProgressLabel").textContent = `${stageLabels[job.stage] || "正在处理"}${stepsText}`;
      }
      await new Promise(resolve => setTimeout(resolve, 1000));
      job = (await api(`/api/ai/model-compare/history/${encodeURIComponent(_historyCompareJobId)}`, { timeout:10000 })).job;
    }
    if (job.status === "succeeded" && job.result?.status === "success") {
      if ($("cmpProgressFill")) $("cmpProgressFill").style.width = "100%";
      if ($("cmpProgressLabel")) $("cmpProgressLabel").textContent = "方向评估完成";
      renderHistoryCompareResults(job.result.results || [], job.result.meta || {});
    } else if (job.status === "cancelled") {
      if ($("cmpProgressLabel")) $("cmpProgressLabel").textContent = "任务已取消";
      toast("历史模型对比已取消", "warning");
    } else {
      throw new Error(apiErrorMessage(job.error || "history_compare_failed"));
    }
  } catch (e) { showToast("请求失败: " + e.message, "error"); }
  finally {
    _historyCompareJobId = null;
    if (btn) {
      btn.disabled = document.querySelectorAll("[data-cmp-model]:checked").length < 2;
      btn.innerHTML = '<i data-lucide="play" size="16"></i>开始对比';
    }
    initIcons();
    setTimeout(() => $("cmpProgressBar")?.classList.add("hidden"), 2000);
  }
}

function renderHistoryCompareResults(results, meta) {
  const container = $("cmpResults");
  if (!container) return;
  const valid = results.filter(r => r.status === "success");
  const sorted = [...valid].sort((a, b) => (b.directional_score?.directional_accuracy || 0) - (a.directional_score?.directional_accuracy || 0));
  const avgAccuracy = valid.length ? (valid.reduce((s, r) => s + (r.directional_score?.directional_accuracy || 0), 0) / valid.length).toFixed(1) : "0";
  let summaryHtml = `<div class="insight-strip" style="margin-bottom:16px">
    <div class="insight-card"><span class="insight-value">${results.length}</span><span class="insight-label">模型总数</span></div>
    <div class="insight-card"><span class="insight-value">${valid.length}</span><span class="insight-label">成功返回</span></div>
    ${sorted.length ? `<div class="insight-card"><span class="insight-value">${escapeHtml(sorted[0].model_name)}</span><span class="insight-label">方向准确率最高</span></div>` : ""}
    <div class="insight-card"><span class="insight-value">${avgAccuracy}%</span><span class="insight-label">平均方向准确率</span></div>
  </div>`;
  if (meta) {
    summaryHtml += `<div class="workspace-panel" style="font-size:12px;color:var(--text-secondary);margin-bottom:12px"><strong>说明：</strong>这里比较的是模型对下一根已收盘 K 线方向的判断，不是交易回测，不包含挂单触发、止损止盈、点差、滑点和风控结果。<br>品种：<strong>${escapeHtml(meta.symbol||"")}</strong> · 评估周期：<strong>${escapeHtml(meta.timeframe||"")}</strong> · 策略周期：<strong>${escapeHtml((meta.strategy_timeframes||[]).join("、")||"--")}</strong> · 缠论：<strong>${meta.chan_enabled ? "启用" : "关闭"}</strong> · K线数：<strong>${meta.kline_count||0}</strong> · 实际步长：<strong>${meta.step||"--"}</strong></div>`;
  }
  $("cmpResultsSummary").innerHTML = summaryHtml;
  let tableHtml = "";
  if (sorted.length) {
    tableHtml = '<div class="workspace-panel"><table style="width:100%;border-collapse:collapse;font-size:13px"><thead><tr style="text-align:left;border-bottom:1px solid var(--border-subtle)"><th style="padding:8px">模型</th><th>提供商</th><th>信号数</th><th>买</th><th>卖</th><th>观望</th><th>错误</th><th>方向准确率</th><th>累计方向幅度</th><th>平均幅度</th></tr></thead><tbody>';
    for (const r of sorted) {
      const score = r.directional_score;
      const scoreColor = score.total_move > 0 ? "color:#22c55e" : score.total_move < 0 ? "color:#ef4444" : "";
      tableHtml += `<tr style="border-bottom:1px solid var(--border-subtle,.06)">
        <td style="padding:8px">${escapeHtml(r.model_name)}</td><td>${escapeHtml(modelProviderLabel(r.provider))}</td>
        <td>${r.signal_count}</td><td>${score.buy_count}</td><td>${score.sell_count}</td><td>${score.hold_count}</td><td>${score.error_count}</td>
        <td>${score.directional_accuracy}%</td><td style="${scoreColor}">${score.total_move.toFixed(4)}</td><td style="${scoreColor}">${score.avg_next_bar_move.toFixed(6)}</td></tr>`;
    }
    tableHtml += '</tbody></table></div>';
  }
  $("cmpResultsTableWrap").innerHTML = tableHtml;
  const validWithSignals = valid.filter(r => r.signals?.length);
  let timelineHtml = "";
  if (validWithSignals.length) {
    const allTimes = new Set();
    validWithSignals.forEach(r => r.signals.forEach(s => allTimes.add(s.time)));
    const times = [...allTimes].sort();
    const colors = ["#d4af37","#3b82f6","#10b981","#ef4444","#a855f7","#f59e0b","#06b6d4","#ec4899"];
    const models = validWithSignals.map((r, i) => ({ ...r, color: colors[i % colors.length] }));
    const dirIcon = { buy: "▲", sell: "▼", hold: "●", error: "✖" };
    const dirColor = { buy: "#22c55e", sell: "#ef4444", hold: "#eab308", error: "#6b7280" };
    timelineHtml = '<div class="workspace-panel"><div class="section-heading"><h2>信号时间线</h2></div><div style="display:flex;gap:12px;flex-wrap:wrap;margin-bottom:12px">';
    models.forEach(m => { timelineHtml += `<span style="display:flex;align-items:center;gap:4px;font-size:12px"><span style="width:8px;height:8px;border-radius:50%;background:${m.color}"></span>${escapeHtml(m.model_name)}</span>`; });
    timelineHtml += '</div><div style="max-height:400px;overflow-y:auto"><table style="width:100%;border-collapse:collapse;font-size:12px"><tbody>';
    for (const time of times) {
      timelineHtml += `<tr style="border-bottom:1px solid var(--border-subtle,.06)"><td style="padding:4px 8px;white-space:nowrap;color:var(--text-secondary)">${String(time).replace("T"," ").slice(5,16)}</td>`;
      for (const m of models) {
        const sig = m.signals.find(s => s.time === time);
        if (sig) {
          const dir = sig.signal_type;
          const c = dirColor[dir] || "#6b7280";
          const tip = `${directionText(dir)}${sig.next_bar_move ? ` · 下一根方向幅度 ${sig.next_bar_move.toFixed(4)}` : ""}`;
          timelineHtml += `<td style="padding:4px 8px;text-align:center" title="${escapeHtml(tip)}"><span style="color:${c}">${dirIcon[dir]||"?"}</span></td>`;
        } else {
          timelineHtml += '<td style="padding:4px 8px;text-align:center;color:var(--text-secondary)">-</td>';
        }
      }
      timelineHtml += "</tr>";
    }
    timelineHtml += "</tbody></table></div></div>";
  }
  $("cmpResultsTimeline").innerHTML = timelineHtml;
  container.classList.remove("hidden");
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
  if (!strategyId) { toast("请选择推理策略", "warning"); $("analyzeStrategy")?.focus(); return; }
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
    const analysis = escapeHtml(String(signal.analysis || "").trim() || "暂无分析");
    const reasoning = String(signal.reasoning || "").trim();
    if (r.error) {
      return `<div class="compare-card"><div class="compare-card-head"><span class="compare-card-model">${escapeHtml(modelName)}</span><span class="compare-card-provider">${escapeHtml(modelProviderLabel(provider))}</span></div><div class="compare-card-error">${escapeHtml(r.error)}</div></div>`;
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
    await Promise.allSettled([loadPositions(), loadAccount(), loadSignals(), loadAudit()]);
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
  if (volume > 0.05) throw new Error("交易手数不能超过 0.05 手");
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
    renderPendingOrders(orders);
  } catch (e) {
    console.error("loadPendingOrders:", e);
  }
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
      <td class="num"><a href="#" class="pending-ticket-link" onclick="event.preventDefault(); navigateToSignalByTicket('${escapeHtml(ticket)}')">${escapeHtml(ticket)}</a></td>
      <td>${escapeHtml(o.symbol)}</td>
      <td>${typeLabels[o.pending_type] || o.pending_type || "--"}</td>
      <td class="num">${Number(o.price).toFixed(2)}</td>
      <td class="num">${Number(o.volume).toFixed(2)}</td>
      <td class="num">${o.sl ? Number(o.sl).toFixed(2) : "--"}</td>
      <td class="num">${o.tp ? Number(o.tp).toFixed(2) : "--"}</td>
      <td class="num">${createdAt || "--"}</td>
      <td>${validUntil || "永久有效"}</td>
      <td><span class="row-status ${isPending ? "warning" : "neutral"}">${stateLabels[state] || state}</span></td>
      <td>${isPending ? `<button class="btn btn-sm btn-outline" onclick="cancelPendingOrder('${escapeHtml(String(o.mt5_ticket || o.ticket || o.id))}')">撤单</button>` : ""}</td>
    </tr>`;
  }).join("");
}

async function navigateToSignalByTicket(ticket) {
  try {
    const data = await wsApi("signal_by_ticket", { ticket });
    if (data.status === "success" && data.signal) {
      const signal = data.signal;
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
    const result = await wsApi("cancel_pending", { ticket });
    toast(result.message || "操作完成", result.status === "success" ? "success" : "warning");
    await loadPendingOrders();
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
  submit.disabled = Number(meta.marginShortfall) > 0;
  submit.title = submit.disabled ? "预估保证金不足，已阻止提交" : "发送前后端会再次执行风控校验";
  const marginKnown = Number.isFinite(Number(meta.estimatedMargin)) && Number.isFinite(Number(meta.freeMargin));
  const riskMessage = !marginKnown
    ? "保证金数据不完整，后台提交时仍会重新校验账户状态。"
    : meta.marginShortfall > 0
      ? `可用保证金不足，缺口约 ${fmt(meta.marginShortfall)} USD。`
      : "保证金预检通过，最终结果以 MT5 返回为准。";
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
      <span class="confirm-risk-title">保证金预检</span>
      <div class="confirm-risk-grid">
        <div><span>预估占用</span><strong>${marginKnown ? `${fmt(meta.estimatedMargin)} USD` : "--"}</strong></div>
        <div><span>可用保证金</span><strong>${Number.isFinite(Number(meta.freeMargin)) ? `${fmt(meta.freeMargin)} USD` : "--"}</strong></div>
        <div><span>杠杆</span><strong>1:${escapeHtml(raw(parseDisplayNumber("accountLeverage")))}</strong></div>
      </div>
      <div class="confirm-risk-warning ${Number(meta.marginShortfall) > 0 ? "blocking" : ""}">${escapeHtml(riskMessage)}</div>
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
    const result = await wsApi("open", order.payload);
    closeManualOrderModal();
    toast(result.message || `结果：${result.status}`, result.status === "success" ? "success" : "warning");
    await Promise.allSettled([loadPositions(), loadAccount(), loadHistory(), loadHistoryChart(), loadAudit(), loadStatus(), loadPendingOrders()]);
  } catch (error) {
    toast(error.message, "error");
  } finally {
    if (submit) submit.disabled = false;
  }
}

async function closePosition(ticket) {
  if (!await showConfirm("复核平仓", `复核平仓 ticket ${ticket}？`, { confirmText: "确认平仓", danger: true })) return;
  try {
    const result = await wsApi("close", { ticket: Number(ticket), confirm: true });
    toast(result.message || `结果：${result.status}`, result.status === "success" ? "success" : "warning");
    await Promise.allSettled([loadPositions(), loadAccount(), loadHistory(), loadHistoryChart(), loadAudit(), loadStatus()]);
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
          <span class="history-item-dir ${dir}">${dir.toUpperCase()} ${directionText(signal.signal_type)}</span>
        </span>
        <span class="history-item-meta">
          <span>#${escapeHtml(signal.id)}</span>
          <span>${escapeHtml(compactTimeText(signal?.created_at_mt5 || signal?.created_at))}</span>
          <span>${confidence}</span>
          <span>${escapeHtml(status)}</span>
        </span>
        <span class="history-item-text">${escapeHtml(signal.analysis || signal.reasoning || "--")}</span>
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

  // Select immediately: a late response for the previous signal may update its
  // list cache, but must never reclaim the currently visible detail panel.
  state.selectedSignal = signal || { id: signalId };
  highlightActiveAnalysis(signalId);
  if (navigate) setTab("ai-analyze", { skipRefresh:true });

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
        <td><span class="tag ${dir}">${dir.toUpperCase()} ${directionText(signal.signal_type)}</span></td>
        <td>
          <div class="conf-mini ${confidenceClass(signal.confidence)}">
            <span class="conf-mini-track"><span class="conf-mini-fill" style="width:${confidence.value}%"></span></span>
            <span class="num">${confidence.label}</span>
          </div>
        </td>
        <td class="num">${escapeHtml(volumeText(signal.recommended_volume))}</td>
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

  // Sync _lastSignalId so _maybeRefreshSignal doesn't re-fetch unnecessarily
  if (state.signals.length > 0 && !options.append) _lastSignalId = state.signals[0].id;

  // Preserve selected signal if it still exists, otherwise use latest
  const previousSelected = state.selectedSignal;
  const selectedId = previousSelected?.id;
  const stillExists = selectedId ? state.signals.find(s => String(s.id) === String(selectedId)) : null;
  let activeSignal = options.selectLatest ? (state.signals[0] || null) : (stillExists || state.signals[0] || null);
  if (stillExists && previousSelected?.detail_loaded && String(activeSignal?.id) === String(selectedId)) {
    // Keep heavyweight detail fields, but let the freshly loaded list row win
    // for user-specific execution state (pending ticket, delivery result, etc.).
    activeSignal = { ...previousSelected, ...stillExists };
    const activeIndex = state.signals.findIndex(item => String(item.id) === String(activeSignal.id));
    if (activeIndex >= 0) state.signals[activeIndex] = activeSignal;
  }

  if (!options.append) {
    state.selectedSignal = activeSignal;
    updateSignalDisplay(activeSignal);
    if (activeSignal) setText("signalFreshness", signalFreshness(activeSignal));
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
    all: "包含该 MT5 账户的完整交易、入金、提款和信用记录。",
    platform: "从当前会员账户在平台注册之日开始。",
    custom: "按平仓日期统计；入金、提款和信用也按同一日期范围计算。",
  };
  setText("historyRangeHint", hints[scope] || hints.all);
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
      ? `<td class="num"><a href="#" class="signal-link close-price-link" onclick="event.preventDefault(); openAnalysisFromHistory(${closeInfo.signalId})" title="点击查看平仓分析">${escapeHtml(raw(closeInfo.price ?? exitPrice))}</a></td>`
      : `<td class="num">${escapeHtml(raw(exitPrice))}</td>`;
    return `
    <tr data-ticket="${escapeHtml(String(ticket))}">
      <td class="num">${escapeHtml(formatTime(row.entry_time))}</td>
      <td>${escapeHtml(row.symbol)}</td>
      ${ticketCell(ticket, tickets)}
      <td><span class="tag ${dir}">${String(row.type || dir).toUpperCase()} ${directionText(dir)}</span></td>
      <td class="num">${escapeHtml(volumeText(row.volume))}</td>
      <td class="num">${escapeHtml(raw(row.entry_price))}</td>
      <td class="num">${row.stop_loss ? escapeHtml(raw(row.stop_loss)) : '--'}</td>
      <td class="num">${row.take_profit ? escapeHtml(raw(row.take_profit)) : '--'}</td>
      <td class="num">${escapeHtml(formatTime(row.close_time || row.time))}</td>
      ${exitPriceCell}
      <td class="${profitClass(row.profit)}">${fmt(row.profit)}</td>
      <td class="${profitClass(row.profit || 0)}">${row.profit != null && row.entry_price && row.volume ? (row.profit / (row.volume * row.entry_price * (row.contract_size || 100)) * 100).toFixed(2) + '%' : '--'}</td>
      <td class="comment-cell">${closeInfo ? `<span class="close-remark-tag" title="智能平仓">tp ${escapeHtml(raw(closeInfo.takeProfit ?? closeInfo.price ?? exitPrice))}</span>` : `<span class="comment-ellipsis" title="${escapeHtml(comment || "--")}">${escapeHtml(comment || "--")}</span>`}</td>
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


async function refreshTradingPage() {
  await Promise.allSettled([loadStatus(), loadAccount(), refreshQuote(), loadPositions(), loadAudit()]);
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

function auditActionLabel(action) {
  return {
    manual_open: "手动开仓",
    manual_close: "手动平仓",
    ai_execute: "AI 信号执行",
    ai_auto_execute: "AI 自动执行",
    ai_auto_scan: "AI 自动扫描",
    ai_auto_execute_skipped: "AI 自动执行跳过",
    ai_auto_execute_rejected: "AI 自动执行拒绝",
    cancel_pending_invalid: "忽略无效撤单条件",
    cancel_pending_invalid_price: "跳过价格无效挂单",
    cancel_pending_invalid_ticket: "跳过编号无效挂单",
    ai_cancel_pending: "AI 取消挂单",
    ai_cancel_pending_failed: "AI 取消挂单失败",
    pending_superseded: "旧挂单已替换",
    pending_supersede_failed: "旧挂单替换失败",
    pending_expire_cancel_failed: "过期挂单取消失败",
    pending_expired: "挂单已过期",
    pending_filled: "挂单已成交",
    delivery_stale_executing: "执行状态超时待确认",
    smart_close: "AI 智能平仓",
    smart_close_rule: "规则智能平仓",
    weekly_flatten_started: "周末风险清理开始",
    weekly_pending_cancelled: "周末系统挂单已取消",
    weekly_position_closed: "周末系统持仓已平仓",
    weekly_flatten_completed: "周末风险清理完成",
    weekly_flatten_partial: "周末风险清理未完成",
    weekly_flatten_retry: "周末风险清理重试",
    weekly_flatten_deadline_ended: "周末风险清理到期",
    weekly_flatten_unsupported_netting: "周末风险清理不支持净持仓账户",
  }[action] || action || "--";
}

function auditStatusLabel(status) {
  return {
    success: "成功",
    skipped: "已跳过",
    error: "错误",
    failed: "失败",
    rejected: "风控拒绝",
    needs_confirmation: "需要确认",
    warning: "警告",
    info: "信息",
    unknown: "未知",
    started: "已开始",
    superseded: "已被替换",
  }[status] || status || "--";
}

function auditRowClass(status) {
  return {
    success: "row-success",
    skipped: "row-skipped",
    error: "row-error",
    rejected: "row-rejected",
    needs_confirmation: "row-skipped",
  }[status] || "";
}

function auditActionType(action) {
  const s = String(action || "");
  if (s.startsWith("ai_")) return "ai";
  return "manual";
}

function auditReasonLabel(reason) {
  return localizeReason(reason);
}

function auditResultText(row) {
  const result = row.result || {};
  const reasonText = resultRiskReason(result) || auditReasonLabel(result.reason || "");
  const message = result.message || result.status || "";
  const statusText = auditStatusLabel(message);
  const messageText = statusText !== message ? statusText : auditReasonLabel(message);
  const quote = result.quote ? ` 报价 ${result.quote.bid}/${result.quote.ask}` : "";
  const retcode = result.retcode || result.mt5_result?.retcode;
  const retcodeText = retcode ? ` MT5代码 ${retcode}` : "";
  return `${reasonText || messageText || auditStatusLabel(row.status)}${retcodeText}${quote}`.trim();
}

function renderAuditRows() {
  const body = $("auditBody");
  if (!body) return;
  const filters = state.auditFilters;
  const filtered = state.auditRows.filter((row) => {
    const status = String(row.status_code || row.status || "");
    const type = auditActionType(row.action_code || row.action);
    return (!filters.status || status === filters.status) && (!filters.type || type === filters.type);
  });
  filters.page = clampPage(filters.page, filters.pageSize, filtered.length);
  const start = (filters.page - 1) * filters.pageSize;
  const pageRows = filtered.slice(start, start + filters.pageSize);
  setText("auditCount", `显示 ${filtered.length} / ${state.auditRows.length} 条`);
  body.innerHTML = pageRows.length ? pageRows.map((row) => {
    const result = row.result || {};
    const riskReason = resultRiskReason(result);
    const rawReason = riskReason || result.reason || result.message || result.status || "";
    const reasonText = riskReason || auditReasonLabel(rawReason) || "--";
    const status = row.status_code || row.status || "";
    const statusClass = status || "unknown";
    const actionType = auditActionType(row.action_code || row.action);
    const resultText = auditResultText(row);
    return `
      <tr class="audit-row ${auditRowClass(status)}">
        <td>${compactTimeHtml(row?.created_at_mt5 || row?.created_at)}</td>
        <td><span class="action-badge ${actionType}">${escapeHtml(auditActionLabel(row.action))}</span></td>
        <td>${escapeHtml(row.symbol || "--")}</td>
        <td><span class="audit-status ${statusClass}">${escapeHtml(auditStatusLabel(row.status_code || row.status))}</span></td>
        <td class="audit-result-cell"><button class="audit-result-text" type="button" title="${escapeHtml(resultText)}" data-audit-result>${escapeHtml(resultText)}</button></td>
        <td title="${escapeHtml(rawReason || "--")}">${escapeHtml(reasonText)}</td>
      </tr>
    `;
  }).join("") : `<tr class="empty-row"><td colspan="6">当前筛选下暂无审计记录</td></tr>`;
  renderPager("auditPager", filters.page, filters.pageSize, filtered.length, "audit");
}

async function loadAudit() {
  const data = await wsApi("audit_logs");
  state.auditRows = data.logs || [];
  renderAuditRows();
}

function bindEvents() {
  $("logoutBtn").addEventListener("click", logout);
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
  $("cmpRunBtn")?.addEventListener("click", runHistoryCompare);
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

  // Gateway badge click — toggle trade sending
  $("tradeMode")?.addEventListener("click", handleTradeModeClick);

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
  $("strategyScope")?.addEventListener("change", event => {
    const platform = event.target.value === "platform";
    renderStrategyModelOptions(event.target.value);
    $("strategyVisibilityField").style.display = platform ? "" : "none";
  });
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
  $("saveGlobalRiskBtn")?.addEventListener("click", () => saveGlobalRisk().catch(error => toast(error.message, "error")));
  $("saveUserFeatureFlagsBtn")?.addEventListener("click", () => saveUserFeatureFlags().catch(error => toast(error.message, "error")));
  $("saveGlobalFeatureFlagsBtn")?.addEventListener("click", () => saveGlobalFeatureFlags().catch(error => toast(error.message, "error")));
  $("globalKillSwitchBtn")?.addEventListener("click", async event => {
    const enabled = event.currentTarget.dataset.enabled === "1";
    const reason = prompt(enabled ? "请输入停止所有新开仓的原因" : "请输入恢复平台新开仓的原因");
    if (!reason) return;
    try { await api("/api/ai/admin/risk-center/kill-switch", { method:"POST", body:{ enabled, reason } }); toast("平台紧急停止状态已更新", "success"); await loadAdminRiskCenter(); }
    catch (error) { toast(error.message, "error"); }
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
    });
    state.reviewFilter = button.dataset.reviewFilter; renderReviewCases();
  }));
  document.querySelectorAll("[data-review-period]").forEach(button => button.addEventListener("click", () => {
    document.querySelectorAll("[data-review-period]").forEach(item => {
      const selected = item === button;
      item.classList.toggle("active", selected);
      item.setAttribute("aria-selected", String(selected));
    });
    state.reviewPeriodFilter = button.dataset.reviewPeriod; state.selectedReviewId = null;
    loadReviewMemory().catch(error => toast(error.message,"error"));
  }));
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
  });
  document.body.addEventListener("change", async event => {
    const riskRollout = event.target.closest("[data-risk-rollout]");
    if (!riskRollout) return;
    try { await api(`/api/ai/admin/risk-rule-rollouts/${encodeURIComponent(riskRollout.dataset.riskRollout)}`, { method:"PUT", body:{ mode:riskRollout.value } }); toast("规则灰度已更新", "success"); await loadAdminRiskCenter(); }
    catch (error) { toast(error.message, "error"); await loadAdminRiskCenter(); }
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

  document.body.addEventListener("click", async (event) => {
    const actionButton = event.target.closest("[data-action]");
    const tabButton = event.target.closest("[data-tab-jump]");
    const closeButton = event.target.closest("[data-close-ticket]");
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

    if (memoryTier) {
      state.memoryTierFilter = memoryTier.dataset.memoryTier || "all";
      await loadReviewMemory();
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
        else if (subscriptionAction.dataset.subscriptionAction === "delete" && confirm("确认删除这个订阅？如果这是最后一个有效订阅，自动推理会同步关闭。")) {
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
        await api(`/api/ai/admin/platform-experience/${Number(platformExperienceAction.dataset.platformExperienceId)}/${platformExperienceAction.dataset.platformExperienceAction}`, { method:"POST" });
        toast(platformExperienceAction.dataset.platformExperienceAction === "publish" ? "平台经验已发布" : "平台经验已撤销", "success");
        await loadReviewMemory();
      } catch (error) { toast(error.message,"error"); }
      return;
    }
    if (platformPolicySave) {
      const row = platformPolicySave.closest("[data-platform-policy-strategy]");
      try {
        await api(`/api/ai/admin/platform-experience/policies/${Number(row.dataset.platformPolicyStrategy)}`, { method:"PUT", body:{ mode:row.querySelector("[data-platform-policy-mode]").value } });
        toast("平台经验模式已保存", "success"); await loadReviewMemory();
      } catch (error) { toast(error.message,"error"); }
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
        if (input.value.trim() !== "") changes[input.dataset.userRiskField] = Number(input.value);
      });
      if (!Object.keys(changes).length) { toast("没有需要保存的自定义风控", "warning"); return; }
      try { await api(`/api/ai/risk-center/${Number(riskSave.dataset.riskSave)}`, { method:"PUT", body:{ changes, reason:"用户从风控中心更新" } }); toast("用户风控已立即生效", "success"); await loadRiskCenter(); }
      catch (error) { toast(error.message,"error"); } return;
    }

    if (auditResult) {
      auditResult.classList.toggle("expanded");
      return;
    }

    if (pagerButton && !pagerButton.disabled) {
      const page = Number(pagerButton.dataset.page);
      if (pagerButton.dataset.pager === "signals") {
        state.signalFilters.page = page;
        loadSignalTable();
      } else if (pagerButton.dataset.pager === "audit") {
        state.auditFilters.page = page;
        renderAuditRows();
      } else if (pagerButton.dataset.pager === "history") {
        state.historyFilters.page = page;
        loadHistory();
      } else if (pagerButton.dataset.pager === "executions") {
        state.executionFilters.page = page;
        loadExecutionDecisions().catch(error => toast(error.message, "error"));
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
        "export-history": exportHistory,
        "refresh-audit": loadAudit,
        "refresh-risk-center": loadRiskCenter,
        "refresh-review-memory": loadReviewMemory,
        "refresh-global-risk": loadAdminRiskCenter,
        "retry-model-management": loadModelManagement,
      };
      if (tasks[action]) {
        withBusy(actionButton, tasks[action]).catch((error) => toast(error.message, "error"));
      }
    }

    if (tabButton) setTab(tabButton.dataset.tabJump);
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
setTab = function(tab) {
  _origSetTab(tab);
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

// ============ Admin Data Dashboard ============
const _adminDashState = { charts: {}, loaded: false, userList: { page: 1, total: 0, users: [] }, selectedUserId: null, refreshTimer: null };

async function loadAdminDashboard(force) {
  if (_adminDashState.loaded && !force) return;
  const container = $('adminDashContent');
  if (!container) return;
  showLoading(container, "加载看板数据...");
  try {
    const [dashResp, userListResp] = await Promise.all([
      wsApi('admin_dashboard'),
      wsApi('admin_user_list', { page: 1, pageSize: 10 })
    ]);
    if (dashResp.status !== 'success') throw new Error(dashResp.message || '加载失败');
    await renderAdminDashboard(container, dashResp.data, userListResp);
    loadChangelogAdmin();
    _adminDashState.loaded = true;
    if (userListResp && userListResp.status === 'success') {
      _adminDashState.userList = { page: userListResp.page, total: userListResp.total, users: userListResp.users };
    }
  } catch (e) {
    showError(container, '加载失败: ' + e.message);
  }
}

// Lightweight in-place update (no DOM rebuild, no chart destroy/recreate)
async function updateAdminDashboard() {
  const container = $('adminDashContent');
  if (!container || !_adminDashState.loaded) return;
  const fmt = n => { if (!n || n < 1000) return (n||0).toLocaleString(); if (n < 1000000) return (n/1000).toFixed(1)+'K'; return (n/1000000).toFixed(2)+'M'; };
  try {
    const curPage = _adminDashState.userList?.page || 1;
    const [dashResp, userListResp] = await Promise.all([
      wsApi('admin_dashboard'),
      wsApi('admin_user_list', { page: curPage, pageSize: 10 })
    ]);
    if (dashResp.status !== 'success') return;
    const d = dashResp.data, us = d.userStats, ss = d.signalStats, ar = d.autoReasonStats, tk = d.tokenStats || {};
    const wssCount = d.bridges.length;

    // Update stats grid in-place
    const set = (field, val) => { const el = container.querySelector('[data-field="' + field + '"]'); if (el) el.textContent = val; };
    set('wss', wssCount);
    set('autoReason', ar.auto_reasoning_users || 0);
    set('tradeEnabled', ar.trade_enabled_users || 0);
    set('totalUsers', us.total_users || 0);
    set('userBreakdown', 'Pro ' + (us.pro_users||0) + ' · Plus ' + (us.plus_users||0) + ' · Free ' + (us.free_users||0));
    set('todayNew', us.today_new || 0);
    set('onlineNow', us.online_now || 0);
    set('todayTokens', fmt(tk.today_tokens));
    set('totalTokens', '累计 ' + fmt(tk.total_tokens));

    // Update signal mini stats
    set('sigTotal', ss.total || 0);
    set('sigToday', ss.today || 0);
    set('sigWeek', ss.week || 0);
    set('sigExecuted', ss.executed || 0);
    set('sigConfidence', (ss.avg_confidence||0) + '%');

    // Update charts in-place (no destroy/recreate)
    const charts = _adminDashState.charts;
    if (charts.signalType && d.signalTypeDist.length > 0) {
      charts.signalType.data.datasets[0].data = d.signalTypeDist.map(r => r.cnt);
      charts.signalType.update('none');
    }
    if (charts.signalTrend && d.signalTrend.length > 0) {
      charts.signalTrend.data.labels = d.signalTrend.map(r => r.day?.slice(5) || '');
      charts.signalTrend.data.datasets[0].data = d.signalTrend.map(r => r.cnt);
      charts.signalTrend.update('none');
    }
    if (charts.tokenTrend && d.tokenTrend && d.tokenTrend.length > 0) {
      charts.tokenTrend.data.labels = d.tokenTrend.map(r => r.day?.slice(5) || '');
      charts.tokenTrend.data.datasets[0].data = d.tokenTrend.map(r => r.tokens);
      charts.tokenTrend.update('none');
    }

    // Update scheduler grid in-place
    const schedulerGrid = container.querySelector('#schedulerGrid');
    if (schedulerGrid && d.schedulerData) {
      schedulerGrid.innerHTML = renderSchedulerCards(d.schedulerData);
    }

    // Update user list in-place
    if (userListResp && userListResp.status === 'success') {
      _adminDashState.userList = { page: userListResp.page, total: userListResp.total, users: userListResp.users };
      renderUserList(userListResp);
    }
  } catch (e) {
    console.warn('[admin-dash] update failed:', e.message);
  }
}

// 20s auto-refresh timer for admin dashboard
function startDashAutoRefresh() {
  if (_adminDashState.refreshInterval) return;
  _adminDashState.countdown = 20;
  const updateCountdown = () => {
    const el = $('dashCountdown');
    if (el) el.textContent = _adminDashState.countdown + 's';
  };
  updateCountdown();
  _adminDashState.refreshInterval = setInterval(() => {
    _adminDashState.countdown--;
    if (_adminDashState.countdown <= 0) {
      _adminDashState.countdown = 20;
      updateAdminDashboard();
    }
    updateCountdown();
  }, 1000);
}
function stopDashAutoRefresh() {
  if (_adminDashState.refreshInterval) {
    clearInterval(_adminDashState.refreshInterval);
    _adminDashState.refreshInterval = null;
  }
  const el = $('dashCountdown');
  if (el) el.textContent = '';
}

function renderSchedulerCards(data) {
  if (!data) return '<div class="scheduler-empty">暂无调度器数据</div>';
  const { schedulers = [], dbStats = [] } = data;
  
  // If no active schedulers, show DB stats as fallback
  if (schedulers.length === 0 && dbStats.length === 0) {
    return '<div class="scheduler-empty">暂无启用的调度器</div>';
  }
  
  // Merge DB stats with runtime state
  const cards = [];
  const runtimeKeys = new Set(schedulers.map(s => s.key));
  
  // Add runtime schedulers
  for (const s of schedulers) {
    const dbInfo = dbStats.find(r => String(r.prompt_type_id) === String(s.prompt_type_id));
    const symbols = (() => { try { return JSON.parse(dbInfo?.symbols_json || '[]') } catch { return [] } })();
    const statusClass = s.in_flight ? 'running' : s.wait_reason ? 'waiting' : s.running ? 'idle' : 'stopped';
    const statusText = s.in_flight ? '推理中' : s.wait_reason ? waitReasonText(s.wait_reason) : s.running ? '运行中' : '已停止';
    const countdown = s.next_run_in_seconds > 0 ? formatCountdown(s.next_run_in_seconds) : '--';
    
    cards.push(`
      <div class="scheduler-card">
        <div class="scheduler-header">
          <span class="scheduler-title">${escapeHtml(s.prompt_type_name || '策略#' + s.prompt_type_id)}</span>
          <span class="scheduler-badge ${statusClass}">${statusText}</span>
        </div>
        <div class="scheduler-detail">
          <span>品种: ${escapeHtml(s.symbol)}</span>
          <span>订阅者: ${s.subscriber_count}</span>
          <span>间隔: ${s.interval_minutes}分钟</span>
          <span>下次运行: ${countdown}</span>
          ${s.last_error ? '<span class="scheduler-error">错误: ' + escapeHtml(s.last_error) + '</span>' : ''}
          ${s.market_reason ? '<span>市场: ' + escapeHtml(s.market_reason) + '</span>' : ''}
        </div>
      </div>
    `);
  }
  
  // Add DB-only schedulers (enabled but no runtime state)
  for (const db of dbStats) {
    const runtimeKey = `${db.prompt_type_id}:`;
    const hasRuntime = schedulers.some(s => String(s.prompt_type_id) === String(db.prompt_type_id));
    if (hasRuntime) continue;
    
    const symbols = (() => { try { return JSON.parse(db.symbols_json || '[]') } catch { return [] } })();
    cards.push(`
      <div class="scheduler-card">
        <div class="scheduler-header">
          <span class="scheduler-title">${escapeHtml(db.prompt_type_name || '策略#' + db.prompt_type_id)}</span>
          <span class="scheduler-badge waiting">等待中</span>
        </div>
        <div class="scheduler-detail">
          <span>品种: ${escapeHtml(symbols.join(', ') || '--')}</span>
          <span>订阅者: ${db.subscriber_count}</span>
          <span>间隔: ${db.interval_minutes || 5}分钟</span>
          <span class="scheduler-hint">等待桥接连接后启动</span>
        </div>
      </div>
    `);
  }
  
  return cards.join('') || '<div class="scheduler-empty">暂无启用的调度器</div>';
}

function waitReasonText(reason) {
  const map = {
    cooldown: '冷却中',
    admin_bridge_offline: '管理员桥接离线',
    market_closed: '市场休市',
    market_restricted: '交易权限受限',
    market_stale_tick: '行情停滞',
    market_unknown: '行情未知',
    redis_unavailable: 'Redis不可用',
    weekly_flatten_window: '周末清仓中',
    no_api_key: '无API密钥',
    strategy_disabled: '策略已禁用',
    user_bridge_offline: '用户桥接离线',
  };
  return map[reason] || reason;
}

function formatCountdown(seconds) {
  if (seconds <= 0) return '--';
  // Use MT5 server time (UTC+3)
  const now = new Date();
  const utcMs = now.getTime() + now.getTimezoneOffset() * 60000;
  const mt5Ms = utcMs + 3 * 3600000;
  const target = new Date(mt5Ms + seconds * 1000);
  const pad = n => String(n).padStart(2, '0');
  return `${pad(target.getHours())}:${pad(target.getMinutes())}:${pad(target.getSeconds())}`;
}

async function renderAdminDashboard(el, d, userListResp) {
  Object.values(_adminDashState.charts).forEach(c => { try { c.destroy() } catch {} });
  _adminDashState.charts = {};

  const us = d.userStats, ss = d.signalStats, ar = d.autoReasonStats, tk = d.tokenStats || {};
  const wssCount = d.bridges.length;
  const buyCnt = (d.signalTypeDist||[]).filter(r => ['buy','strong_buy'].includes(r.signal_type)).reduce((s,r)=>s+r.cnt,0);
  const sellCnt = (d.signalTypeDist||[]).filter(r => ['sell','strong_sell'].includes(r.signal_type)).reduce((s,r)=>s+r.cnt,0);
  const holdCnt = (d.signalTypeDist||[]).filter(r => r.signal_type==='hold').reduce((s,r)=>s+r.cnt,0);
  const fmt = n => { if (!n || n < 1000) return (n||0).toLocaleString(); if (n < 1000000) return (n/1000).toFixed(1)+'K'; return (n/1000000).toFixed(2)+'M'; };

  el.innerHTML = [
    '<div class="dash-header">',
    '  <div class="dash-title"><i data-lucide="bar-chart-3" size="15"></i>数据看板</div>',
    '  <div class="dash-actions"><button class="dash-btn" id="dashRefreshBtn"><i data-lucide="refresh-cw" size="12"></i><span class="dash-btn-label">刷新</span><span class="dash-btn-countdown" id="dashCountdown"></span></button></div>',
    '</div>',
    '',
    '<div class="stats-grid">',
    '  <div class="stat-cell gold"><div class="stat-label"><i data-lucide="radio"></i>WSS</div><div class="stat-val" data-field="wss">' + wssCount + '</div><div class="stat-sub">在线桥接</div></div>',
    '  <div class="stat-cell gold"><div class="stat-label"><i data-lucide="cpu"></i>推理</div><div class="stat-val" data-field="autoReason">' + (ar.auto_reasoning_users||0) + '</div><div class="stat-sub">自动推理用户</div></div>',
    '  <div class="stat-cell gold"><div class="stat-label"><i data-lucide="zap"></i>交易</div><div class="stat-val" data-field="tradeEnabled">' + (ar.trade_enabled_users||0) + '</div><div class="stat-sub">自动交易用户</div></div>',
    '  <div class="stat-cell"><div class="stat-label"><i data-lucide="users"></i>用户</div><div class="stat-val" data-field="totalUsers">' + (us.total_users||0) + '</div><div class="stat-sub" data-field="userBreakdown">Pro ' + (us.pro_users||0) + ' · Plus ' + (us.plus_users||0) + ' · Free ' + (us.free_users||0) + '</div></div>',
    '  <div class="stat-cell"><div class="stat-label"><i data-lucide="user-plus"></i>新增</div><div class="stat-val" data-field="todayNew">' + (us.today_new||0) + '</div><div class="stat-sub">今日注册</div></div>',
    '  <div class="stat-cell"><div class="stat-label"><i data-lucide="activity"></i>在线</div><div class="stat-val" data-field="onlineNow">' + (us.online_now||0) + '</div><div class="stat-sub">5分钟活跃</div></div>',
    '  <div class="stat-cell gold"><div class="stat-label"><i data-lucide="database"></i>Token</div><div class="stat-val" data-field="todayTokens">' + fmt(tk.today_tokens) + '</div><div class="stat-sub" data-field="totalTokens">累计 ' + fmt(tk.total_tokens) + '</div></div>',
    '</div>',

    '<div class="scheduler-grid" id="schedulerGrid">' + renderSchedulerCards(d.schedulerData) + '</div>',

    '<div class="signal-row">',
    '  <div class="signal-mini"><div class="sig-icon" style="background:rgba(212,175,55,0.1)"><i data-lucide="activity" style="color:var(--gold-primary)"></i></div><div class="sig-info"><span class="sig-lbl">总信号</span><span class="sig-num" data-field="sigTotal">' + (ss.total||0) + '</span></div></div>',
    '  <div class="signal-mini"><div class="sig-icon" style="background:rgba(34,197,94,0.1)"><i data-lucide="trending-up" style="color:#22c55e"></i></div><div class="sig-info"><span class="sig-lbl">今日</span><span class="sig-num" data-field="sigToday">' + (ss.today||0) + '</span></div></div>',
    '  <div class="signal-mini"><div class="sig-icon" style="background:rgba(59,130,246,0.1)"><i data-lucide="calendar" style="color:#60a5fa"></i></div><div class="sig-info"><span class="sig-lbl">本周</span><span class="sig-num" data-field="sigWeek">' + (ss.week||0) + '</span></div></div>',
    '  <div class="signal-mini"><div class="sig-icon" style="background:rgba(168,85,247,0.1)"><i data-lucide="check-circle" style="color:#a78bfa"></i></div><div class="sig-info"><span class="sig-lbl">已执行</span><span class="sig-num" data-field="sigExecuted">' + (ss.executed||0) + '</span></div></div>',
    '  <div class="signal-mini"><div class="sig-icon" style="background:rgba(251,191,36,0.1)"><i data-lucide="percent" style="color:#fbbf24"></i></div><div class="sig-info"><span class="sig-lbl">置信度</span><span class="sig-num" data-field="sigConfidence">' + (ss.avg_confidence||0) + '%</span></div></div>',
    '</div>',
    '',
    '<div class="charts-row">',
    '  <div class="chart-cell"><h4>信号方向分布</h4><div class="chart-wrap"><canvas id="adChartSignalType"></canvas></div></div>',
    '  <div class="chart-cell">',
    '    <h4>方向统计</h4>',
    '    <div class="dir-group">',
    '      <div class="dir-mini dir-buy"><span class="dir-arrow">&uarr;</span><span class="dir-lbl">买入</span><span class="dir-num">' + buyCnt + '</span></div>',
    '      <div class="dir-mini dir-sell"><span class="dir-arrow">&darr;</span><span class="dir-lbl">卖空</span><span class="dir-num">' + sellCnt + '</span></div>',
    '      <div class="dir-mini dir-hold"><span class="dir-arrow">&mdash;</span><span class="dir-lbl">观望</span><span class="dir-num">' + holdCnt + '</span></div>',
    '    </div>',
    '  </div>',
    '</div>',
    '',
    '<div class="charts-row">',
    '  <div class="chart-cell"><h4>近30天信号趋势</h4><div class="chart-wrap"><canvas id="adChartSignalTrend"></canvas></div></div>',
    '  <div class="chart-cell"><h4>近30天 Token 消耗</h4><div class="chart-wrap"><canvas id="adChartTokenTrend"></canvas></div></div>',
    '</div>',
    '',
    '<hr class="dash-divider">',
    '',
    '<div class="section-inline">',
    '  <h3><i data-lucide="search"></i>用户状态</h3>',
    '</div>',
    '',
    '<div class="user-search-wrap">',
    '  <input type="text" id="userSearchInput" class="user-search-input" placeholder="搜索用户邮箱或昵称..." autocomplete="off">',
    '  <div class="search-dropdown" id="userSearchDropdown"></div>',
    '</div>',
    '',
    '<div class="user-list-box" id="userListContainer">',
    '  <div class="loading-state"><div class="loading-spinner loading-spinner-sm"></div><div class="loading-text">加载中...</div></div>',
    '</div>',
    '',
    '<div id="userDetailContainer"></div>',

    '<hr class="dash-divider">',
    '<div class="section-inline">',
    '  <h3><i data-lucide="bell"></i>更新日志管理</h3>',
    '</div>',
    '<div id="changelogAdminSection" style="background:var(--card-bg);border:1px solid var(--border-color);border-radius:12px;padding:20px">',
    '  <div style="display:flex;gap:12px;align-items:center;margin-bottom:12px">',
    '    <label style="color:var(--text-muted);font-size:13px;white-space:nowrap">版本号</label>',
    '    <input type="number" id="clVersionInput" min="1" style="width:80px;padding:6px 10px;border:1px solid var(--border-color);border-radius:6px;background:var(--input-bg);color:var(--text-primary);font-size:14px">',
    '  </div>',
    '  <textarea id="clContentInput" rows="8" placeholder="更新日志内容（支持 HTML）&#10;例如：&#10;<b>v2.2.0</b> 更新内容：&#10;<ul><li>新增挂单系统</li><li>需更新桥接软件至 v2.2.0</li></ul>" style="width:100%;padding:10px;border:1px solid var(--border-color);border-radius:8px;background:var(--input-bg);color:var(--text-primary);font-size:13px;line-height:1.6;resize:vertical;font-family:inherit"></textarea>',
    '  <div style="display:flex;justify-content:space-between;align-items:center;margin-top:12px">',
    '    <span id="clSaveStatus" style="font-size:12px;color:var(--text-muted)"></span>',
    '    <button onclick="saveChangelog()" style="padding:8px 20px;border:none;border-radius:6px;background:var(--gold-primary);color:#1a1a2e;cursor:pointer;font-weight:600;font-size:13px">保存</button>',
    '  </div>',
    '</div>',
  ].join('\n');
  initIcons();

  // ====== Charts ======
  const chartDefaults = { responsive: true, maintainAspectRatio: false, plugins: { legend: { labels: { color: '#9ca3af', font: { size: 10 } } } } };

  if (d.signalTypeDist.length > 0) {
    const typeLabels = d.signalTypeDist.map(r => {
      const t = (r.signal_type||'').toLowerCase();
      if (t === 'buy') return '买入'; if (t === 'sell') return '卖出';
      if (t === 'strong_buy') return '强买'; if (t === 'strong_sell') return '强卖';
      if (t === 'hold') return '观望'; return r.signal_type?.toUpperCase() || '未知';
    });
    const typeColors = d.signalTypeDist.map(r => {
      const t = (r.signal_type||'').toLowerCase();
      if (t === 'buy' || t === 'strong_buy') return '#22c55e';
      if (t === 'sell' || t === 'strong_sell') return '#ef4444';
      if (t === 'hold') return '#3b82f6'; return '#6b7280';
    });
    await ensureChartJs();
    _adminDashState.charts.signalType = new Chart($('adChartSignalType'), {
      type: 'doughnut',
      data: { labels: typeLabels, datasets: [{ data: d.signalTypeDist.map(r => r.cnt), backgroundColor: typeColors, borderWidth: 0 }] },
      options: { ...chartDefaults, cutout: '55%', plugins: { ...chartDefaults.plugins, legend: { position: 'right', labels: { color: '#9ca3af', font: { size: 10 }, padding: 8 } } } }
    });
  }

  if (d.signalTrend.length > 0) {
    _adminDashState.charts.signalTrend = new Chart($('adChartSignalTrend'), {
      type: 'line',
      data: {
        labels: d.signalTrend.map(r => r.day?.slice(5) || ''),
        datasets: [{ label: '信号数', data: d.signalTrend.map(r => r.cnt), borderColor: '#d4af37', backgroundColor: 'rgba(212,175,55,.1)', fill: true, tension: .3, pointRadius: 1.5, pointHoverRadius: 4, borderWidth: 2 }]
      },
      options: { ...chartDefaults, scales: { x: { ticks: { color: '#9ca3af', font: { size: 9 }, maxRotation: 45 }, grid: { color: 'rgba(255,255,255,.04)' } }, y: { ticks: { color: '#9ca3af', font: { size: 9 } }, grid: { color: 'rgba(255,255,255,.04)' }, beginAtZero: true } }, plugins: { legend: { display: false } } }
    });
  }

  if (d.tokenTrend && d.tokenTrend.length > 0) {
    _adminDashState.charts.tokenTrend = new Chart($('adChartTokenTrend'), {
      type: 'bar',
      data: {
        labels: d.tokenTrend.map(r => r.day?.slice(5) || ''),
        datasets: [{ label: 'Token', data: d.tokenTrend.map(r => r.tokens), backgroundColor: 'rgba(59,130,246,0.4)', borderRadius: 3, borderWidth: 0 }]
      },
      options: { ...chartDefaults, scales: { x: { ticks: { color: '#9ca3af', font: { size: 9 }, maxRotation: 45 }, grid: { color: 'rgba(255,255,255,.04)' } }, y: { ticks: { color: '#9ca3af', font: { size: 9 }, callback: v => v >= 1000000 ? (v/1000000).toFixed(1)+'M' : v >= 1000 ? (v/1000).toFixed(1)+'K' : v }, grid: { color: 'rgba(255,255,255,.04)' }, beginAtZero: true } }, plugins: { legend: { display: false } } }
    });
  }

  // ====== Refresh ======
  const refreshBtn = $('dashRefreshBtn');
  if (refreshBtn) refreshBtn.addEventListener('click', () => {
    refreshBtn.classList.add('spinning');
    _adminDashState.countdown = 20;
    updateAdminDashboard().finally(() => refreshBtn.classList.remove('spinning'));
  });

  // ====== User Search ======
  let searchTimer = null;
  const searchInput = $('userSearchInput');
  const dropdown = $('userSearchDropdown');

  if (searchInput && dropdown) {
    const closeDropdown = () => dropdown.classList.remove('open');
    const openDropdown = () => dropdown.classList.add('open');

    searchInput.addEventListener('input', () => {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(async () => {
        const q = searchInput.value.trim();
        try {
          const resp = await wsApi('admin_user_search', { q, limit: 5 });
          if (resp.status !== 'success') return;
          dropdown.innerHTML = resp.users.length
            ? resp.users.map(u => '<div class="drop-item" data-uid="' + u.id + '">' +
                '<div class="drop-info"><span class="drop-name">' + escapeHtml(u.nickname || '--') + '</span><span class="drop-email">' + escapeHtml(u.email) + '</span></div>' +
                '<span class="chip chip-' + (u.plan||'free') + '">' + (u.plan||'free') + (u.role==='admin'?' · admin':'') + '</span></div>').join('')
            : '<div class="drop-empty">无匹配用户</div>';
          dropdown.querySelectorAll('.drop-item').forEach(el => {
            el.addEventListener('click', async () => {
              const uid = el.dataset.uid;
              closeDropdown();
              searchInput.value = el.querySelector('.drop-email')?.textContent || '';
              await showUserDetail(uid);
            });
          });
          openDropdown();
        } catch {}
      }, 250);
    });

    document.addEventListener('click', e => {
      if (!searchInput.contains(e.target) && !dropdown.contains(e.target)) closeDropdown();
    });
  }

  // ====== User List ======
  function renderUserList(data) {
    const container = $('userListContainer');
    const totalPages = Math.ceil((data.total || 0) / (data.pageSize || 10));
    const users = data.users || [];
    container.innerHTML = users.length
      ? '<table class="user-table"><thead><tr><th>ID</th><th>账号</th><th>计划</th><th>桥接</th><th>推理</th><th>交易</th><th>调度</th><th>心跳</th></tr></thead><tbody>' +
        users.map(u => '<tr data-uid="' + u.id + '">' +
          '<td style="color:var(--text-muted);font-family:monospace;font-size:0.65rem">' + u.id + '</td>' +
          '<td><div class="bridge-user"><span class="name">' + escapeHtml(u.nickname||'--') + '</span><span class="email">' + escapeHtml(u.phone || u.email) + '</span></div></td>' +
          '<td><span class="chip chip-' + (u.plan||'free') + '">' + (u.plan||'free') + (u.role==='admin'?' ★':'') + '</span></td>' +
          '<td><span class="bridge-status"><span class="bridge-dot ' + (u.bridgeConnected?'on':'off') + '"></span>' + (u.bridgeConnected?'在线':'离线') + '</span></td>' +
          '<td><span class="bridge-status"><span class="bridge-dot ' + (u.autoReasoning?'on':'off') + '"></span>' + (u.autoReasoning?'开':'关') + '</span></td>' +
          '<td><span class="bridge-status"><span class="bridge-dot ' + (u.tradeEnabled?'on':'off') + '"></span>' + (u.tradeEnabled?'开':'关') + '</span></td>' +
          '<td><span class="bridge-status"><span class="bridge-dot ' + (u.schedulerEnabled?'on':'off') + '"></span>' + (u.schedulerEnabled?'开':'关') + '</span></td>' +
          '<td style="font-size:0.65rem;color:var(--text-muted)">' + (u.bridge_heartbeat ? formatTimeAgo(u.bridge_heartbeat) : (u.last_seen_at ? formatTimeAgo(u.last_seen_at) : '--')) + '</td></tr>').join('') +
        '</tbody></table>' +
        (totalPages > 1
          ? '<div class="user-pager"><button class="page-btn" data-page="prev"' + (data.page <= 1 ? ' disabled': '') + '>‹</button>' +
            Array.from({length: totalPages}, (_, i) => i+1).map(p => '<button class="page-btn' + (p === data.page ? ' active' : '') + '" data-page="' + p + '">' + p + '</button>').join('') +
            '<button class="page-btn" data-page="next"' + (data.page >= totalPages ? ' disabled': '') + '>›</button>' +
            '<span class="page-info">第 ' + data.page + '/' + totalPages + ' 页 · 共 ' + data.total + ' 人</span></div>'
          : '')
      : '<div class="bridge-empty">暂无用户数据</div>';

    container.querySelectorAll('tr[data-uid]').forEach(el => {
      el.addEventListener('click', () => showUserDetail(el.dataset.uid));
    });
    container.querySelectorAll('.page-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        let targetPage = data.page;
        if (btn.dataset.page === 'prev') targetPage = Math.max(1, data.page - 1);
        else if (btn.dataset.page === 'next') targetPage = Math.min(totalPages, data.page + 1);
        else targetPage = Number(btn.dataset.page);
        if (targetPage === data.page) return;
        const resp = await wsApi('admin_user_list', { page: targetPage, pageSize: data.pageSize || 10 });
        if (resp.status === 'success') {
          _adminDashState.userList = { page: resp.page, total: resp.total, users: resp.users };
          renderUserList(resp);
        }
      });
    });
  }

  async function showUserDetail(uid) {
    const detailContainer = $('userDetailContainer');
    showLoading(detailContainer, "加载用户详情...", "sm");
    try {
      const resp = await wsApi('admin_user_status', { user_id: uid });
      if (resp.status !== 'success') throw new Error(resp.message);
      const d2 = resp.data, u = d2.user, s = d2.settings, sc = d2.scheduler, sig = d2.signals, br = d2.bridge;
      detailContainer.innerHTML =
        '<div class="user-detail-card">' +
        '<div class="user-detail-header">' +
        '<div class="user-detail-avatar">' + (u.nickname||u.email||'?')[0].toUpperCase() + '</div>' +
        '<div class="user-detail-info"><span class="name">' + escapeHtml(u.nickname||'未设置昵称') + '</span><span class="email">' + escapeHtml(u.phone || u.email) + '</span></div>' +
        '<button class="user-detail-close" onclick="document.getElementById(\'userDetailContainer\').innerHTML=\'\'">✕</button></div>' +
        '<div class="user-detail-grid">' +
        '<div class="user-detail-field"><span class="f-label">桥接状态</span><span class="f-value">' + (br.connected ? (br.alive ? '<span style="color:#22c55e">● 在线</span>' : '<span style="color:#f59e0b">● 无心跳</span>') : '<span style="color:var(--text-muted)">○ 离线</span>') + '</span></div>' +
        '<div class="user-detail-field"><span class="f-label">交易发送</span><span class="f-value">' + (s.trade_send_enabled ? '<span style="color:#22c55e">开启</span>' : '关闭') + '</span></div>' +
        '<div class="user-detail-field"><span class="f-label">自动推理</span><span class="f-value">' + (s.auto_reasoning_enabled ? '<span style="color:#22c55e">开启</span>' : '关闭') + '</span></div>' +
        '<div class="user-detail-field"><span class="f-label">调度器</span><span class="f-value">' + (sc.enabled ? '<span style="color:#22c55e">启用</span>' : '未启用') + '</span></div>' +
        '<div class="user-detail-field"><span class="f-label">监控品种</span><span class="f-value">' + (sc.symbols || '--') + '</span></div>' +
        '<div class="user-detail-field"><span class="f-label">上次运行</span><span class="f-value">' + (sc.last_run_at ? formatTimeAgo(sc.last_run_at) : '--') + '</span></div>' +
        '<div class="user-detail-field"><span class="f-label">总信号</span><span class="f-value">' + (sig.total_signals||0) + '</span></div>' +
        '<div class="user-detail-field"><span class="f-label">今日信号</span><span class="f-value">' + (sig.today_signals||0) + '</span></div>' +
        '<div class="user-detail-field"><span class="f-label">已执行</span><span class="f-value">' + (sig.executed_signals||0) + '</span></div>' +
        '<div class="user-detail-field"><span class="f-label">最新信号</span><span class="f-value">' + (sig.last_signal_type ? sig.last_signal_type.toUpperCase() : '--') + ' ' + (sig.last_signal_at ? formatTimeAgo(sig.last_signal_at) : '') + '</span></div>' +
        '<div class="user-detail-field"><span class="f-label">最后在线</span><span class="f-value">' + (u.last_seen_at ? formatTimeAgo(u.last_seen_at) : '--') + '</span></div>' +
        '<div class="user-detail-field"><span class="f-label">注册时间</span><span class="f-value">' + (u.created_at ? u.created_at.slice(0,10) : '--') + '</span></div>' +
        '<div class="user-detail-field"><span class="f-label">手机号</span><span class="f-value">' + (u.phone || '--') + '</span></div>' +
        '<div class="user-detail-field"><span class="f-label">邮箱</span><span class="f-value">' + escapeHtml(u.email) + '</span></div>' +
        '</div></div>';
      initIcons();
    } catch (e) {
      detailContainer.innerHTML = '<div style="color:#ef4444;text-align:center;padding:12px">' + escapeHtml(e.message) + '</div>';
    }
  }

  // Initial render
  if (userListResp && userListResp.status === 'success') {
    renderUserList(userListResp);
  }
}

// --- Changelog Admin ---
async function loadChangelogAdmin() {
  try {
    const resp = await api('/api/changelog/current');
    if (resp.ok) {
      const verInput = document.getElementById('clVersionInput');
      const contentInput = document.getElementById('clContentInput');
      if (verInput) verInput.value = resp.version || 1;
      if (contentInput) contentInput.value = resp.content || '';
    }
  } catch (e) { /* ignore */ }
}

async function saveChangelog() {
  const verInput = document.getElementById('clVersionInput');
  const contentInput = document.getElementById('clContentInput');
  const statusEl = document.getElementById('clSaveStatus');
  if (!verInput || !contentInput) return;
  const version = parseInt(verInput.value, 10);
  if (!version || version < 1) {
    if (statusEl) { statusEl.textContent = '版本号无效'; statusEl.style.color = '#ef4444'; }
    return;
  }
  try {
    const resp = await api('/api/admin/release-notes', { method: 'POST', body: { version, content: contentInput.value } });
    if (resp.ok) {
      if (statusEl) { statusEl.textContent = '已保存'; statusEl.style.color = '#22c55e'; setTimeout(() => { statusEl.textContent = ''; }, 2000); }
    } else {
      if (statusEl) { statusEl.textContent = resp.error || '保存失败'; statusEl.style.color = '#ef4444'; }
    }
  } catch (e) {
    if (statusEl) { statusEl.textContent = '保存失败'; statusEl.style.color = '#ef4444'; }
  }
}

function formatTimeAgo(dtStr) {
  if (!dtStr) return '--';
  const diff = Date.now() - new Date(dtStr).getTime();
  if (diff < 60000) return '刚刚';
  if (diff < 3600000) return Math.floor(diff/60000) + '分钟前';
  if (diff < 86400000) return Math.floor(diff/3600000) + '小时前';
  return Math.floor(diff/86400000) + '天前';
}
// Hook admin dashboard tab into setTab
const _origSetTab2 = setTab;
setTab = function(tab) {
  _origSetTab2(tab);
  if (tab === 'admin-dashboard') {
    loadAdminDashboard();
    startDashAutoRefresh();
  } else {
    stopDashAutoRefresh();
  }
};

