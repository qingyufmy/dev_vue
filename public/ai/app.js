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
  systemPromptInherited: false,
  pendingManualOrder: null,
  accountBalance: 0,
  historyNetResult: 0,

  auditRows: [],
  signalTableData: [],
  signalTableTotal: 0,
  signalFilters: { direction: "", timeframe: "", page: 1, pageSize: 20 },
  historyFilters: { page: 1, pageSize: 20 },
  auditFilters: { status: "", type: "", page: 1, pageSize: 25 },
  signalTickets: {},
  closeSignalTickets: {},
  analysisHistoryOffset: 0,
  analysisHistoryHasMore: true,
  analysisHistoryLoading: false,
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

const REASON_MAP = {
  skipped: "已跳过（未满足执行条件）",
  "Request executed": "MT5 已执行",
  "Unsupported filling mode": "MT5 不支持当前成交模式，已自动适配",
  "AutoTrading disabled by client": "MT5 客户端关闭了自动交易",
  mt5_terminal_autotrading_disabled: "MT5 终端自动交易关闭",
  mt5_account_trade_disabled: "MT5 账户禁止交易",
  mt5_account_expert_trading_disabled: "MT5 账户禁止 EA/脚本交易",
  hold_signal_cannot_execute: "已跳过（HOLD 信号）",
  signal_expired: "已跳过（信号已过期）",
  no_active_auto_trade_config: "已跳过（自动交易未开启）",
  open_position_exists: "已跳过（当前品种已有持仓）",
  position_check_failed: "已跳过（持仓检查失败）",
  invalid_order_type: "方向无效，已拒绝",
  volume_exceeds_config_limit: "手数超过配置上限，已拒绝",
  max_open_positions_reached: "持仓数量达到上限，已拒绝",
  signal_price_slippage_exceeded: "信号价与当前价滑点超限，已拒绝",
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

function utcToMt5(utcStr) {
  if (!utcStr) return null;
  const d = new Date(utcStr.replace(" ", "T") + "Z");
  if (isNaN(d.getTime())) return utcStr;
  const p = (x) => String(x).padStart(2, "0");
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p((d.getUTCHours() + 3) % 24)}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`;
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
  const createdAt = new Date(signal.created_at).getTime();
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
  return { value: rounded, label: `${rounded}%` };
}

function initIcons() {
  requestAnimationFrame(() => {
    if (window.lucide) window.lucide.createIcons();
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
  no_online_subscribers: '无在线订阅用户',
  no_strategy: '未选择策略',
  no_symbols: '未选择品种',
  rates_failed: '行情获取失败',
  rates_empty: '行情为空',
  exception: '运行异常',
  disabled: '已关闭',
  unknown: '未知',
};

function autoReasonText(reason) {
  if (!reason) return '未知';
  return AUTO_REASON_LABELS[reason] || '未知状态';
}

function isMarketClosedReason(reason) {
  return ['market_closed', 'market_stale_tick', 'market_unknown_no_tick', 'market_unknown'].includes(reason);
}

// Badge cache to avoid flickering on hover
const _autoBadgeCache = { label: '', type: '', title: '' };
let _autoBadgeHovering = false;

function setAutoBadgeText(el, label) {
  let textSpan = el.querySelector('.badge-text');
  if (!textSpan) {
    el.innerHTML = '<span class="badge-dot"></span><span class="badge-text"></span>';
    textSpan = el.querySelector('.badge-text');
  }
  if (textSpan.textContent !== label) textSpan.textContent = label;
}

function applyAutoBadge(label, type, title) {
  const el = $('autoAnalyzeMode');
  if (!el) return;

  // Update className only if changed
  const newClass = `status-badge status-${type} clickable-badge`;
  if (el.className !== newClass) el.className = newClass;

  // Update text only if changed (avoids innerHTML flicker)
  setAutoBadgeText(el, label);

  // Update title: skip if hovering, buffer for later
  if (!_autoBadgeHovering) {
    if (el.title !== title) el.title = title;
    _autoBadgeCache.title = title;
  } else {
    _autoBadgeCache.pendingTitle = title;
  }
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

  if (!s.enabled) {
    label = '自动推理关闭';
    type = 'neutral';
    title = '状态：自动推理关闭';
  } else if (s.paused_reason === 'weekly_flatten_window') {
    label = '自动推理暂停 · 周末清仓';
    type = 'warning';
    title = `策略：${ptName || '未选择'}\n品种：${symbolsStr}\n状态：周末清仓期间暂停`;
  } else if (s.in_flight) {
    label = '自动推理中';
    type = 'running';
    const stageLabel = s.stage_label || (s.stage === 'running' ? '正在推理' : '调度中');
    title = `策略：${ptName || '未选择'}\n品种：${symbolsStr}\n状态：正在推理\n阶段：${stageLabel}`;
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
  if (dir === "buy") return `买入成交参考 ${priceDisplay(state.lastQuote.ask)}`;
  if (dir === "sell") return `卖出成交参考 ${priceDisplay(state.lastQuote.bid)}`;
  return `${priceDisplay(state.lastQuote.bid)} / ${priceDisplay(state.lastQuote.ask)}`;
}

function signalTakeProfit(signal) {
  if (!signal) return null;
  return signal.take_profit_2_price || signal.take_profit_1_price || signal.take_profit_3_price || null;
}

function updateSignalPriceFields(signal) {
  const dir = signalType(signal?.signal_type);
  const market = signal?.market_data || {};
  setText("sigReferencePrice", priceDisplay(market.latest_price));
  setText("sigCurrentPrice", signalCurrentPriceText(signal));
  setText("sigStopLoss", priceDisplay(signal?.stop_loss_price));
  setText("sigTakeProfit", priceDisplay(signalTakeProfit(signal)));
  setText("sigVolume", volumeText(signal?.recommended_volume));
  setText("sigExecutionState", executionStatus(signal));
  setSignalFieldClass("sigExecutionState", dir);
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

function showConfirm(title, message, { confirmText = "确认", cancelText = "取消", danger = false } = {}) {
  return new Promise((resolve) => {
    const modal = $("genericConfirmModal");
    if (!modal) { resolve(false); return; }
    $("genericConfirmTitle").textContent = title;
    $("genericConfirmBody").innerHTML = `<div>${escapeHtml(message)}</div>`;
    const okBtn = $("genericConfirmOk");
    const cancelBtn = $("genericConfirmCancel");
    okBtn.textContent = confirmText;
    cancelBtn.textContent = cancelText;
    okBtn.className = danger ? "btn btn-danger" : "btn btn-primary";
    modal.classList.remove("hidden");
    const cleanup = (val) => {
      modal.classList.add("hidden");
      okBtn.removeEventListener("click", onOk);
      cancelBtn.removeEventListener("click", onCancel);
      modal.removeEventListener("click", onBg);
      resolve(val);
    };
    const onOk = () => cleanup(true);
    const onCancel = () => cleanup(false);
    const onBg = (e) => { if (e.target === modal) cleanup(false); };
    okBtn.addEventListener("click", onOk);
    cancelBtn.addEventListener("click", onCancel);
    modal.addEventListener("click", onBg);
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
    if (!response.ok) throw new Error(data.detail || data.message || `HTTP ${response.status}`);
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

function wsApi(action, params = {}) {
  return new Promise((resolve, reject) => {
    const ws = state.bridgeWs;
    if (!ws || ws.readyState !== 1) return reject(new Error('WebSocket未连接'));
    const cmdId = `ws_${++_wsCmdId}`;
    // analyze/auto-inference may take 60-120s
    const timeout = params._timeout || (action === 'analyze' ? 120000 : action === 'signals' || action === 'signal-pending-info' ? 30000 : 10000);
    delete params._timeout;
    const timer = setTimeout(() => { _wsPending.delete(cmdId); reject(new Error('请求超时')); }, timeout);
    _wsPending.set(cmdId, { resolve, reject, timer });
    try {
      ws.send(JSON.stringify({ type: 'command', command_id: cmdId, action, params }));
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
      if (msg.type === 'data') {
        handleBridgeData(msg);
      } else if (msg.type === 'hb') {
        handleHeartbeat(msg);
      } else if (msg.type === 'disconnect') {
        handleDisconnect(msg);
      } else if (msg.type === 'auto_state') {
        state.autoEnabled = !!msg.enabled;
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
        // Cycle finished — clear in_flight state
        if (state.autoRuntime) {
          state.autoRuntime.in_flight = false;
          state.autoRuntime.stage = 'idle';
          state.autoRuntime.stage_label = '';
          if (msg.status === 'blocked' || msg.status === 'error') {
            state.autoRuntime.paused_reason = msg.reason || '';
          } else {
            state.autoRuntime.paused_reason = '';
          }
        }
        renderAutoAnalyzeBadge(state.autoRuntime || { enabled: true });
        loadStatus().catch(() => {});
      } else if (msg.type === 'auto_progress') {
        // Update runtime state and render badge
        if (state.autoRuntime) {
          state.autoRuntime.in_flight = true;
          state.autoRuntime.stage = msg.stage || 'running';
          state.autoRuntime.stage_label = msg.label || '推理中';
        }
        renderAutoAnalyzeBadge(state.autoRuntime || { enabled: true, in_flight: true, stage: 'running', stage_label: msg.label || '推理中' });
      } else if (msg.type === 'new_signal') {
        // New signal pushed — refresh status and signal list
        handleNewSignal(msg);
        loadStatus().catch(() => {});
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
            const reason = msg.reason === 'unsupported_netting' ? '当前为净持仓账户，无法安全区分系统仓与手工仓' : '自动清仓失败';
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
        updateKlineTick(q.bid, q.ask);
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
      const btn = $("executeSignalBtn");
      if (btn && signalIsStale(s) && !s.is_executed) btn.disabled = true;
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

    const fullData = await wsApi("signals", {});
    const signals = fullData.signals || [];
    state.signals = signals;
    state.selectedSignal = signals[0] || null;
    state.analysisHistoryOffset = signals.length;
    state.analysisHistoryHasMore = fullData.has_more !== undefined ? fullData.has_more : signals.length >= 6;
    renderAnalysisHistory(signals);
    loadSignalTable();
    if (state.selectedSignal) {
      showSignalNotification(state.selectedSignal);
      if (activeTabId() === "ai-analyze") {
        openAnalysisFromHistory(state.selectedSignal.id);
        const firstItem = document.querySelector(".analysis-history-item");
        if (firstItem) firstItem.scrollIntoView({ behavior: "smooth", block: "nearest" });
      }
    }
  } catch (e) { /* silent */ }
}

// Handle new signal pushed from server (replaces polling)
async function handleNewSignal(msg) {
  try {
    if (msg.signal_id != null) _lastSignalId = msg.signal_id;
    // Refresh signal list
    const fullData = await wsApi("signals", {});
    const signals = fullData.signals || [];
    state.signals = signals;
    state.selectedSignal = signals[0] || null;
    state.analysisHistoryOffset = signals.length;
    state.analysisHistoryHasMore = fullData.has_more !== undefined ? fullData.has_more : signals.length >= 6;
    renderAnalysisHistory(signals);
    loadSignalTable();

    // Show notification for new signal
    if (state.selectedSignal) {
      showSignalNotification(state.selectedSignal);
      if (activeTabId() === "ai-analyze") {
        openAnalysisFromHistory(state.selectedSignal.id);
        const firstItem = document.querySelector(".analysis-history-item");
        if (firstItem) firstItem.scrollIntoView({ behavior: "smooth", block: "nearest" });
      }
    }
  } catch (e) { /* silent */ }
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

function setTab(tabId) {
  document.querySelectorAll(".nav-item").forEach((button) => {
    button.classList.toggle("active", button.dataset.tab === tabId);
  });
  document.querySelectorAll(".tab-panel").forEach((panel) => {
    panel.classList.toggle("active", panel.id === tabId);
  });
  const main = document.querySelector(".main");
  if (main) main.scrollTop = 0;
  initIcons();
  refreshTabData(tabId).catch((error) => toast(error.message, "error"));
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
  } else if (tabId === "ai-config") {
    loadAutoConfig();
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
      loadConfig(),
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
  // Turning OFF requires confirmation
  if (state.autoEnabled && !await showConfirm("关闭自动推理", "确认关闭自动推理？关闭后将停止自动 AI 分析和信号推送。", { confirmText: "关闭", danger: true })) return;
  _autoToggleLock = true;
  try {
    const result = await wsApi('toggle_auto');
    await loadAutoConfig();
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

  for (const id of ["quoteSymbolSelect", "analyzeSymbol", "tradeSymbolSelect"]) {
    createSymbolSelector(id, symbolNames);
  }

  // Set initial value
  if (preferred) setGlobalSymbol(preferred.name);
  // Don't call refreshQuote here — tick stream handles it at 1s

  // Re-init auto symbol selector now that symbols are loaded
  initAutoSymbolsSelector();
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
    updateKlineTick(data.bid, data.ask);
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

    // Display MT5 time directly — parse as raw values, no timezone conversion
    const mt5ToDisplay = (mt5Str) => {
      const p = mt5Str.replace(' ', 'T').split(/[-T:]/);
      return Math.floor(Date.UTC(+p[0], +p[1]-1, +p[2], +p[3]||0, +p[4]||0, +p[5]||0) / 1000);
    };
    const candles = data.rates.map(b => ({
      time: mt5ToDisplay(b.time),
      open: Number(b.open),
      high: Number(b.high),
      low: Number(b.low),
      close: Number(b.close),
    }));

    const volumes = data.rates.map(b => ({
      time: mt5ToDisplay(b.time),
      value: Number(b.tick_volume || b.volume || 0),
      color: Number(b.close) >= Number(b.open) ? 'rgba(239,68,68,0.3)' : 'rgba(16,185,129,0.3)',
    }));

    _klineSeries.setData(candles);
    _klineVolumeSeries.setData(volumes);
    _klineLastBar = candles[candles.length - 1];

    // Update last price display
    const last = data.rates[data.rates.length - 1];
    setText('klineLastPrice', Number(last.close).toFixed(2));

    _klineChart.timeScale().fitContent();
  } catch (e) {
    if (!String(e.message || '').includes('WebSocket') && !String(e.message || '').includes('未连接')) {
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
      const b = data.rates[0];
      const vol = Number(b.tick_volume || b.volume || 0);
      const color = Number(b.close) >= Number(b.open) ? 'rgba(239,68,68,0.3)' : 'rgba(16,185,129,0.3)';
      _klineVolumeSeries.update({ time: _klineLastBar.time, value: vol, color: color });
    }
  } catch (e) { /* ignore */ }
}

function updateKlineTick(bid, ask) {
  if (!_klineSeries || state.marketTradeMode === 0) return;
  const price = Number(bid);
  // MT5 broker time = UTC+3; convert current time to MT5 display
  // MT5 broker time — treat display as raw UTC (chart shows MT5 time directly)
  const nowMt5Sec = Math.floor(Date.now() / 1000) + 3 * 3600;
  const tfSeconds = { M1: 60, M5: 300, M15: 900, M30: 1800, H1: 3600, H4: 14400, D1: 86400 }[_klineTimeframe] || 300;
  const barTime = Math.floor(nowMt5Sec / tfSeconds) * tfSeconds;

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

  // 管理分组：仅桥接已连接时显示
  const navGroupManage = document.getElementById('navGroupManage');
  if (navGroupManage) {
    const bridgeConnected = !state._usingFallback && state._lastGatewayLive;
    navGroupManage.style.display = bridgeConnected ? '' : 'none';
  }

  // Free users: locked out entirely (proOverlay shown during init)

  // === Plus users: observation-only mode ===
  // Hide model config tab
  const modelTab = document.querySelector('.nav-item[data-tab="ai-config"]');
  if (modelTab) modelTab.style.display = isPlusReadOnly ? "none" : "";

  // Show auto config sub-tab for admin and pro users
  const autoTab = document.querySelector('.config-sub-tab[data-config-tab="auto-config"]');
  if (autoTab) autoTab.style.display = (isAdmin || isPro) ? "" : "none";
  if (!isAdmin && !isPro || isPlusReadOnly) {
    const manualTab = document.querySelector('.config-sub-tab[data-config-tab="manual-config"]');
    if (manualTab) manualTab.click();
  }

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
  if (modelTab) modelTab.style.display = "";
}

/* ---- Provider presets: model name → API base URL ---- */
const PROVIDER_PRESETS = {
  deepseek: { models: ['deepseek-chat', 'deepseek-reasoner'], url: 'https://api.deepseek.com' },
  gpt:      { models: ['gpt-4o', 'gpt-4o-mini', 'gpt-4-turbo', 'o1-mini'], url: 'https://api.openai.com/v1' },
  kimi:     { models: ['moonshot-v1-8k', 'moonshot-v1-32k', 'moonshot-v1-128k'], url: 'https://api.moonshot.cn/v1' },
  qwen:     { models: ['qwen-turbo', 'qwen-plus', 'qwen-max', 'qwen-long'], url: 'https://dashscope.aliyuncs.com/compatible-mode/v1' },
  zhipu:    { models: ['glm-4-flash', 'glm-4-air', 'glm-4', 'glm-4v'], url: 'https://open.bigmodel.cn/api/paas/v4' },
  doubao:   { models: ['doubao-1.5-pro-32k', 'doubao-1.5-lite-32k', 'doubao-pro-32k'], url: 'https://ark.cn-beijing.volces.com/api/v3' },
};

function applyProviderPreset(provider) {
  const preset = PROVIDER_PRESETS[provider];
  if (!preset) return;
  /* Only auto-fill URL if empty or matches another preset URL */
  const urlInput = $('apiBaseUrl');
  const currentUrl = urlInput.value.trim();
  const isPresetUrl = Object.values(PROVIDER_PRESETS).some(p => p.url === currentUrl);
  if (!currentUrl || isPresetUrl) urlInput.value = preset.url;
  /* Only auto-fill model if empty or matches another preset model */
  const modelInput = $('modelName');
  const currentModel = modelInput.value.trim();
  const allModels = Object.values(PROVIDER_PRESETS).flatMap(p => p.models);
  if (!currentModel || allModels.includes(currentModel)) modelInput.value = preset.models[0];
}

async function loadConfig() {
  const data = await wsApi("ai_config");
  const cfg = data.config;
  const defaultPrompt = data.default_prompt || "";
  if (!cfg) {
    state.currentConfigHasApiKey = false;
    state.systemPromptInherited = state.user?.role !== "admin";
    $("systemPrompt").value = defaultPrompt;
    $("apiKey").placeholder = "输入 API Key 后保存";
    setText("configStatus", "未配置 API Key，系统将使用本地规则兜底");
    applyProviderPreset("deepseek");
    return;
  }

  state.currentConfigHasApiKey = Boolean(cfg.has_api_key);
  if (![...$("apiProvider").options].some((option) => option.value === cfg.api_provider)) {
    $("apiProvider").add(new Option(cfg.api_provider, cfg.api_provider));
  }
  $("apiProvider").value = cfg.api_provider || "deepseek";
  $("modelName").value = cfg.model_name || "deepseek-chat";
  $("apiBaseUrl").value = cfg.api_base_url || "";
  applyProviderPreset($("apiProvider").value);
  $("temperature").value = cfg.temperature ?? 0.3;
  $("maxTokens").value = cfg.max_tokens ?? 2000;
  $("riskLevel").value = cfg.risk_level || "medium";
  const configuredMaxPosition = Number(cfg.max_position_size ?? 0.05);
  $("maxPositionSize").value = (Number.isFinite(configuredMaxPosition) ? configuredMaxPosition : 0.05).toFixed(2);
  $("selectedTakeProfit").value = String(cfg.selected_take_profit || 1);
  $("enableAutoTrade").checked = Boolean(cfg.enable_auto_trade);
  $("enableFuturesTrading").checked = Boolean(cfg.enable_futures_trading);
  $("apiKey").placeholder = state.currentConfigHasApiKey ? "已配置；如需保存配置请重新输入密钥" : "输入 API Key 后保存";
  const keyText = state.currentConfigHasApiKey ? `密钥已配置：${cfg.masked_api_key}` : "未配置 API Key，本地规则兜底可用";
  setText("configStatus", `${cfg.api_provider || "Provider"} · ${cfg.model_name || "model"} · ${keyText}`);

  // Non-admin users without an override inherit the administrator's live prompt.
  state.systemPromptInherited = state.user?.role !== "admin" && Boolean(cfg._system_prompt_inherited);
  $("systemPrompt").value = cfg.system_prompt || defaultPrompt;

  // Model sharing toggle (admin only)
  const isAdmin = state.user?.role === "admin";
  const sharingWrap = $("modelSharingWrap");
  if (sharingWrap) sharingWrap.style.display = isAdmin ? "" : "none";
  if (isAdmin && $("modelSharingEnabled")) {
    $("modelSharingEnabled").checked = Boolean(cfg.model_sharing_enabled);
  }
  // Restore per-user auto symbol + interval (backend fills defaults from global auto config)
  if ($("overrideSymbolSelect")) $("overrideSymbolSelect").value = cfg.auto_symbols;
  if ($("overrideIntervalMin")) $("overrideIntervalMin").value = cfg.auto_interval_minutes;
  // 模型共享：只要管理员开启了共享且当前用户非管理员，API Key 为空就共享
  const isUsingShared = !isAdmin && cfg._model_shared;
  if (isUsingShared) {
    // 提示用户当前使用的是管理员共享的 API Key，但允许自行填入覆盖
    $("apiKey").type = "password";
    $("apiKey").value = "";
    $("apiKey").disabled = false;
    $("apiKey").style.opacity = "";
    $("apiKey").placeholder = "留空则使用管理员共享的API Key";
    setText("configStatus", `${cfg.api_provider || "Provider"} · ${cfg.model_name || "model"} · 当前使用管理员共享的API Key（可自行填写覆盖）`);
  } else {
    $("apiKey").type = "password";
    $("apiKey").value = "";
    $("apiKey").disabled = false;
    $("apiKey").style.opacity = "";
    $("apiKey").placeholder = "";
  }
  state._isUsingSharedModel = isUsingShared;
}

async function saveConfig() {
  const apiKey = $("apiKey").value.trim();
  const isUsingShared = state._isUsingSharedModel;
  // 共享模型下留空可以（后端fallback到管理员Key），但用户填了就用用户的
  if (!apiKey && !state.currentConfigHasApiKey && !isUsingShared) {
    toast("请先填写 API Key", "warning");
    $("apiKey").focus();
    return;
  }

  const body = {
    session_id: "default",
    config: {
      api_provider: $("apiProvider").value,
      api_key: apiKey || null,
      api_base_url: $("apiBaseUrl").value || null,
      model_name: $("modelName").value || "deepseek-chat",
      temperature: Number($("temperature").value),
      max_tokens: Number($("maxTokens").value),
      enable_auto_trade: $("enableAutoTrade").checked,
      enable_futures_trading: $("enableFuturesTrading").checked,
      risk_level: $("riskLevel").value,
      max_position_size: Number($("maxPositionSize").value) || 0.05,
      selected_take_profit: Number($("selectedTakeProfit").value),
      model_sharing_enabled: state.user?.role === "admin" && $("modelSharingEnabled")?.checked ? 1 : 0,
      system_prompt: state.user?.role !== "admin" && state.systemPromptInherited
        ? null
        : ($("systemPrompt").value.trim() || null),
    },
  };

  try {
    const configPayload = { ...body.config };
    // Always save auto symbol + interval from override section (preserves values when switch is off)
    {
      const osym = $("overrideSymbolSelect")?.value?.trim();
      const oiv = parseInt($("overrideIntervalMin")?.value) || 5;
      if (osym) {
        configPayload.auto_symbols = osym;
        configPayload.auto_interval_minutes = oiv;
      }
    }
    await wsApi("save_config", { config: configPayload, session_id: body.session_id });
    $("apiKey").value = "";
    await loadConfig();
    toast("模型配置已保存", "success");
  } catch (error) {
    toast(error.message, "error");
  }
}

function selectedTimeframes() {
  return [...document.querySelectorAll(".timeframe-grid input:checked")].map((node) => node.value).slice(0, 8);
}

// ============ Config Sub-Tab Switching ============
function initConfigSubTabs() {
  document.querySelectorAll('.config-sub-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.config-sub-tab').forEach(t => t.classList.remove('active'));
      document.querySelectorAll('.config-sub-panel').forEach(p => p.classList.remove('active'));
      tab.classList.add('active');
      const target = tab.dataset.configTab;
      const panel = document.getElementById(target);
      if (panel) panel.classList.add('active');
      if (target === 'auto-config') loadAutoConfig();
      // if (target === 'close-config') loadCloseConfig();
    });
  });
}

// ============ Auto Config ============
function applyAutoProviderPreset(provider) {
  const preset = PROVIDER_PRESETS[provider];
  if (!preset) return;
  const defaultModel = preset.models?.[0] || '';
  const urlEl = document.getElementById('autoApiBaseUrl');
  const modelEl = document.getElementById('autoModelName');
  if (urlEl && !urlEl.value) urlEl.value = preset.url;
  if (modelEl && (!modelEl.value || modelEl.value === 'deepseek-chat')) modelEl.value = defaultModel;
}

async function loadAutoConfig() {
  const autoPanel = document.getElementById('auto-config');
  if (autoPanel) autoPanel.style.display = '';
  const isAdmin = state.user?.role === 'admin';

  try {
    const data = await wsApi('get_auto_config');
    if (data.status !== 'success') { toast(data.message || '加载失败', 'error'); return; }
    const cfg = data.config;
    const promptTypes = data.prompt_types || [];
    window._loadedPromptTypes = promptTypes;

    // Show/hide admin sections
    const adminSections = document.querySelectorAll('.admin-only-auto-config');
    adminSections.forEach(el => { el.style.display = isAdmin ? '' : 'none'; });

    // User config section - custom prompt type dropdown (only active)
    const activePts = promptTypes.filter(pt => pt.is_active);
    renderPromptTypeDropdown(activePts, cfg.prompt_type_id);
    // Render symbols chips for selected strategy
    const selectedPt = activePts.find(pt => pt.id === cfg.prompt_type_id);
    if (selectedPt) {
      renderSymbolsChips(selectedPt.symbols || [], cfg.selected_symbols || []);
    } else {
      renderSymbolsChips(null, []);
    }

    document.getElementById('autoRiskLevel').value = cfg.risk_level || 'medium';
    document.getElementById('autoMaxPositionSize').value = (Number(cfg.max_position_size) || 0.05).toFixed(2);
    document.getElementById('autoSelectedTakeProfit').value = String(cfg.selected_take_profit || 2);
    document.getElementById('autoEnableAutoTrade').checked = Boolean(cfg.enable_auto_trade);

    // Admin: global config
    if (isAdmin && data.admin) {
      const gc = data.admin.global_config;
      document.getElementById('autoApiProvider').value = gc.api_provider || 'deepseek';
      document.getElementById('autoModelName').value = gc.model_name || 'deepseek-chat';
      document.getElementById('autoApiBaseUrl').value = gc.api_base_url || '';
      document.getElementById('autoTemperature').value = gc.temperature ?? 0.3;
      document.getElementById('autoMaxTokens').value = gc.max_tokens ?? 2000;
      document.getElementById('autoApiKey').placeholder = gc.has_api_key ? '已配置；如需更新请重新输入' : '输入 API Key';
      applyAutoProviderPreset(gc.api_provider || 'deepseek');
      if (document.getElementById('autoThinkingEnabled')) {
        document.getElementById('autoThinkingEnabled').checked = gc.thinking_enabled !== 0;
      }
      if (document.getElementById('autoReasoningEffort')) {
        document.getElementById('autoReasoningEffort').value = gc.reasoning_effort || 'max';
      }

      // Prompt type table
      renderPromptTypeTable(data.prompt_types || [], cfg.prompt_type_id);
    }
  } catch (e) {
    console.error('[loadAutoConfig]', e);
  }
}

function renderPromptTypeTable(pts, activePtId) {
  const container = document.getElementById('adminPromptTypeList');
  if (!container) return;
  if (!pts.length) {
    container.innerHTML = '<div style="color:var(--color-text-muted);padding:12px 0">暂无策略，点击上方按钮新建</div>';
    return;
  }
  let html = `<table style="width:100%;border-collapse:collapse;font-size:13px">
    <thead><tr style="border-bottom:1px solid var(--color-border)">
      <th style="text-align:left;padding:8px 12px">标题</th>
      <th style="text-align:left;padding:8px 12px">品种</th>
      <th style="text-align:center;padding:8px 12px">间隔</th>
      <th style="text-align:center;padding:8px 12px">状态</th>
      <th style="text-align:center;padding:8px 12px">操作</th>
    </tr></thead><tbody>`;
  for (const pt of pts) {
    const isActive = pt.id === activePtId;
    const symbols = (pt.symbols || []).join(', ');
    const safeTitle = escapeHtml(pt.title || '未命名');
    const safeSymbols = escapeHtml(symbols || '-');
    const safeDesc = escapeHtml(pt.description || '');
    const descTip = pt.description ? ` title="${safeDesc}"` : '';
    html += `<tr style="border-bottom:1px solid var(--color-border);${isActive ? 'background:var(--color-primary-bg)' : ''}">
      <td style="padding:8px 12px;font-weight:${isActive ? '600' : '400'}"${descTip}>${safeTitle}</td>
      <td style="padding:8px 12px;color:var(--color-text-secondary)">${safeSymbols}</td>
      <td style="padding:8px 12px;text-align:center">${pt.interval_minutes || 5}分钟</td>
      <td style="padding:8px 12px;text-align:center"><span style="color:${pt.is_active !== false ? 'var(--color-success)' : 'var(--color-text-muted)'}">${pt.is_active !== false ? '启用' : '禁用'}</span></td>
      <td style="padding:8px 12px;text-align:center"><button class="btn btn-secondary btn-sm" onclick="openPromptTypeModal(${pt.id})">编辑</button></td>
    </tr>`;
  }
  html += '</tbody></table>';
  container.innerHTML = html;
}

function renderPromptTypeDropdown(pts, selectedId) {
  const hidden = document.getElementById('autoPromptTypeSelect');
  const trigger = document.getElementById('autoPromptTypeTrigger');
  const dropdown = document.getElementById('autoPromptTypeDropdown');
  const wrap = document.getElementById('autoPromptTypeWrap');
  if (!hidden || !trigger || !dropdown || !wrap) return;

  // populate hidden select for form submission
  hidden.innerHTML = '<option value="">选择策略...</option>';
  for (const pt of pts) {
    const opt = document.createElement('option');
    opt.value = pt.id;
    opt.textContent = pt.title || '未命名';
    if (pt.id === selectedId) opt.selected = true;
    hidden.appendChild(opt);
  }

  // single tooltip element
  wrap.querySelectorAll('.custom-pt-tooltip').forEach(t => t.remove());
  const tooltip = document.createElement('div');
  tooltip.className = 'custom-pt-tooltip';
  wrap.appendChild(tooltip);

  // render dropdown options
  dropdown.innerHTML = '';
  const placeholder = document.createElement('div');
  placeholder.className = 'custom-pt-option' + (!selectedId ? ' selected' : '');
  placeholder.textContent = '选择策略...';
  placeholder.onclick = (e) => { e.stopPropagation(); selectPt(null); };
  dropdown.appendChild(placeholder);

  for (const pt of pts) {
    const div = document.createElement('div');
    div.className = 'custom-pt-option' + (pt.id === selectedId ? ' selected' : '');
    div.dataset.id = pt.id;

    const titleSpan = document.createElement('span');
    titleSpan.className = 'custom-pt-option-title';
    titleSpan.textContent = pt.title || '未命名';
    div.appendChild(titleSpan);

    div.onmouseenter = () => {
      tooltip.innerHTML = `<strong>${escapeHtml(pt.title || '未命名')}</strong>` +
        `<div class="pt-desc-line" style="margin-bottom:4px">品种: ${escapeHtml((pt.symbols || []).join(', ') || '-')} &nbsp;·&nbsp; 间隔: ${pt.interval_minutes || 5}分钟</div>` +
        `<div class="pt-desc-line">${escapeHtml(pt.description || '无描述')}</div>`;
      const dr = div.getBoundingClientRect();
      const wr = wrap.getBoundingClientRect();
      tooltip.style.top = (dr.top - wr.top) + 'px';
      tooltip.style.display = 'block';
    };
    div.onmouseleave = () => { tooltip.style.display = ''; };

    div.onclick = (e) => { e.stopPropagation(); selectPt(pt.id); };
    dropdown.appendChild(div);
  }

  function selectPt(id) {
    hidden.value = id || '';
    if (id) {
      const pt = pts.find(p => p.id === id);
      trigger.textContent = pt ? (pt.title || '未命名') : '选择策略...';
      // Update symbols chips
      if (pt) renderSymbolsChips(pt.symbols || [], pt.symbols || []);
    } else {
      trigger.textContent = '选择策略...';
      renderSymbolsChips(null, []);
    }
    dropdown.querySelectorAll('.custom-pt-option').forEach(o => {
      const oId = o.dataset.id ? parseInt(o.dataset.id) : null;
      o.classList.toggle('selected', oId === id);
    });
    dropdown.classList.remove('open');
  }

  // set trigger text
  if (selectedId) {
    const selected = pts.find(p => p.id === selectedId);
    trigger.textContent = selected ? (selected.title || '未命名') : '选择策略...';
  } else {
    trigger.textContent = '选择策略...';
  }

  // toggle dropdown — only bind once
  trigger.onclick = (e) => { e.stopPropagation(); dropdown.classList.toggle('open'); };
  if (!dropdown._docBound) {
    document.addEventListener('click', () => dropdown.classList.remove('open'));
    dropdown._docBound = true;
  }
}

// --- Symbols chips multi-select ---
function renderSymbolsChips(strategySymbols, selectedSymbols) {
  const field = document.getElementById('autoSymbolsField');
  const container = document.getElementById('autoSymbolsChips');
  if (!field || !container) return;

  if (!strategySymbols || strategySymbols.length <= 1) {
    field.style.display = 'none';
    // Single symbol: auto-select it
    if (strategySymbols && strategySymbols.length === 1) {
      container._selected = [strategySymbols[0]];
    }
    return;
  }

  field.style.display = '';
  container.innerHTML = '';
  container._selected = [...selectedSymbols];

  for (const sym of strategySymbols) {
    const chip = document.createElement('span');
    chip.className = 'symbol-chip' + (container._selected.includes(sym) ? ' active' : '');
    chip.innerHTML = `<span class="chip-check">✓</span>${escapeHtml(sym)}`;
    chip.onclick = () => {
      const idx = container._selected.indexOf(sym);
      if (idx >= 0) {
        container._selected.splice(idx, 1);
      } else {
        container._selected.push(sym);
      }
      chip.classList.toggle('active');
    };
    container.appendChild(chip);
  }
}

function getSelectedSymbols() {
  const container = document.getElementById('autoSymbolsChips');
  if (container && container._selected) return container._selected;
  // Fallback: try hidden select value to find strategy symbols
  const ptVal = document.getElementById('autoPromptTypeSelect')?.value;
  if (ptVal) {
    const pts = window._loadedPromptTypes || [];
    const pt = pts.find(p => p.id === parseInt(ptVal));
    if (pt && pt.symbols) return [...pt.symbols];
  }
  return [];
}

function openPromptTypeModal(ptId) {
  const modal = document.getElementById('promptTypeModal');
  const title = document.getElementById('promptTypeModalTitle');
  if (ptId) {
    // Edit mode - find prompt type from loaded data
    const pts = window._loadedPromptTypes || [];
    const pt = pts.find(p => p.id === ptId);
    if (!pt) return;
    title.textContent = '编辑策略';
    document.getElementById('adminPtId').value = pt.id;
    document.getElementById('adminPtTitle').value = pt.title || '';
    document.getElementById('adminPtDescription').value = pt.description || '';
    document.getElementById('adminPtSymbols').value = (pt.symbols || []).join(', ');
    document.getElementById('adminPtInterval').value = pt.interval_minutes || 5;
    document.getElementById('adminPtPrompt').value = pt.system_prompt || '';
    document.getElementById('adminPtSortOrder').value = pt.sort_order || 0;
    document.getElementById('adminPtActive').checked = pt.is_active !== false;
  } else {
    // Create mode
    title.textContent = '新建策略';
    document.getElementById('adminPtId').value = '';
    document.getElementById('adminPtTitle').value = '';
    document.getElementById('adminPtDescription').value = '';
    document.getElementById('adminPtSymbols').value = 'XAUUSD';
    document.getElementById('adminPtInterval').value = '5';
    document.getElementById('adminPtPrompt').value = '';
    document.getElementById('adminPtSortOrder').value = '0';
    document.getElementById('adminPtActive').checked = true;
  }
  modal.style.display = 'flex';
  requestAnimationFrame(() => modal.classList.add('active'));
}

function closePromptTypeModal() {
  const modal = document.getElementById('promptTypeModal');
  modal.classList.remove('active');
  setTimeout(() => { modal.style.display = 'none'; }, 250);
}

function initAutoSymbolsSelector() {
  const input = document.getElementById('autoSymbolSelect');
  if (!input) return;
  // Skip if already wrapped
  if (input.closest('.sym-selector')) return;
  const symbolNames = (state.symbols || []).map(s => typeof s === 'string' ? s : s.name).filter(Boolean);
  if (!symbolNames.length) return; // will retry when loadSymbols completes
  createSymbolSelector('autoSymbolSelect', symbolNames, { noGlobalSync: true });
}

async function saveAutoConfig() {
  const isAdmin = state.user?.role === 'admin';

  try {
    // Save user config (all users)
    const ptVal = document.getElementById('autoPromptTypeSelect')?.value;
    const selectedSymbols = getSelectedSymbols();
    const userPayload = {
      prompt_type_id: ptVal ? parseInt(ptVal) : null,
      selected_symbols: selectedSymbols,
      risk_level: document.getElementById('autoRiskLevel').value,
      max_position_size: parseFloat(document.getElementById('autoMaxPositionSize').value) || 0.05,
      selected_take_profit: parseInt(document.getElementById('autoSelectedTakeProfit').value) || 2,
      enable_auto_trade: document.getElementById('autoEnableAutoTrade').checked,
    };
    await wsApi('save_user_auto_config', userPayload);

    // Admin: save global config
    if (isAdmin) {
      const apiKey = document.getElementById('autoApiKey')?.value?.trim();
      const globalPayload = {
        api_provider: document.getElementById('autoApiProvider').value,
        model_name: document.getElementById('autoModelName').value,
        api_base_url: document.getElementById('autoApiBaseUrl').value,
        temperature: parseFloat(document.getElementById('autoTemperature').value) || 0.3,
        max_tokens: parseInt(document.getElementById('autoMaxTokens').value) || 2000,
        risk_level: document.getElementById('autoRiskLevel').value,
        max_position_size: parseFloat(document.getElementById('autoMaxPositionSize').value) || 0.05,
        selected_take_profit: parseInt(document.getElementById('autoSelectedTakeProfit').value) || 2,
        enable_auto_trade: document.getElementById('autoEnableAutoTrade').checked,
        thinking_enabled: document.getElementById('autoThinkingEnabled')?.checked ?? true,
        reasoning_effort: document.getElementById('autoReasoningEffort')?.value || 'max',
      };
      if (apiKey) globalPayload.api_key = apiKey;
      await wsApi('admin_save_auto_global_config', globalPayload);
      if (apiKey) document.getElementById('autoApiKey').value = '';
    }

    toast('配置已保存', 'success');
    await loadAutoConfig();
  } catch (e) { toast(e.message, 'error'); }
}

async function saveAdminPromptType() {
  try {
    const idVal = document.getElementById('adminPtId')?.value;
    const payload = {
      id: idVal ? parseInt(idVal) : undefined,
      title: document.getElementById('adminPtTitle').value,
      description: document.getElementById('adminPtDescription').value,
      symbols: document.getElementById('adminPtSymbols').value.split(',').map(s => s.trim()).filter(Boolean),
      interval_minutes: parseInt(document.getElementById('adminPtInterval').value) || 5,
      system_prompt: document.getElementById('adminPtPrompt').value,
      is_active: document.getElementById('adminPtActive').checked,
      sort_order: parseInt(document.getElementById('adminPtSortOrder').value) || 0,
    };
    const res = await wsApi('admin_save_auto_prompt_type', payload);
    toast('策略已保存', 'success');
    closePromptTypeModal();
    await loadAutoConfig();
  } catch (e) { console.error('[saveAdminPromptType] error:', e); toast(e.message, 'error'); }
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
    setText("sigDirection", "HOLD");
    setText("sigDirectionText", "观望");
    $("sigDirection").className = "signal-direction hold";
    $("sigDirectionText").className = "signal-direction-text hold";
    setText("sigConfidence", "--");
    updateSignalPriceFields(null);
    $("sigBar").style.width = "0%";
    setText("sigTime", "等待新信号");
    setText("sigGeneratedAt", "--");
    setText("sigValidWindow", "--");
    setText("lastSigDirection", "--");
    setText("lastSigTimeframe", "--");
    setText("lastSigConfidence", "--");
    setText("lastSigTime", "--");
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
  card.dataset.status = signal.is_executed ? "executed" : signal.is_stale ? "expired" : "live";
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
  setText("lastSigDirection", directionText(signal.signal_type));
  setText("lastSigTimeframe", signal.timeframe || "--");
  setText("lastSigConfidence", confidence.label);
  setText("lastSigTime", signalDisplayTime(signal));
  $("lastSigDirection").className = dir;

  const executable = dir !== "hold" && dir !== "close" && !signal.is_stale && !signal.is_executed;
  $("executeSignalBtn").disabled = !executable;
  $("executeSignalBtn").title = executable
    ? "复核后发送执行请求"
    : dir === "close" ? "持仓分析信号已自动执行"
      : signal.is_stale ? "信号已过期，无法执行"
        : signal.is_executed ? "信号已执行"
          : "HOLD 观望信号不执行";
}

function signalFreshness(signal) {
  if (!signal) return "--";
  // Compute age in real-time from created_at, not from stale snapshot
  const ttl = Number(signal.ttl_seconds);
  if (!Number.isFinite(ttl)) return signal.ttl_seconds ? `TTL ${signal.ttl_seconds}s` : "--";
  const createdAt = new Date(signal.created_at).getTime();
  if (!createdAt || isNaN(createdAt)) return "--";
  const age = Math.floor((Date.now() - createdAt) / 1000);
  const isStale = age > ttl;
  if (isStale) return "已过期";
  return `${age}s / ${ttl}s`;
}

function executionStatus(signal) {
  const dir = signalType(signal?.signal_type);
  if (!signal) return "--";
  if (signal.is_executed) return "已执行";
  if (signal.is_stale) return "已过期";
  if (dir === "hold") return "观望，不执行";
  return "可复核";
}

function marketValue(market, key, digits = 2) {
  if (!market || market[key] === undefined || market[key] === null) return "--";
  return fmt(market[key], digits);
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
    const validDate = utcToMt5(signal.pending_valid_until)
    if (validDate) rows += `<div><span>有效期至</span><strong>${escapeHtml(validDate)}</strong></div>`
  }
  return `<div class="signal-pending-info">${rows}</div>`
}

function renderSignal(signal, elapsedMs = null, options = {}) {
  if (!signal) {
    updateSignalDisplay(null);
    $("analysisResult").className = "analysis-result muted-block";
    $("analysisResult").textContent = "暂无推理记录，选择品种和周期后生成信号";
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
  const latestPrice = Number(market.latest_price);
  const sma20 = Number(market.sma_20);
  const smaDeviation = Number.isFinite(latestPrice) && Number.isFinite(sma20) ? signedText(latestPrice - sma20, 2) : "--";
  const atrValue = market.atr_14 ?? market.atr ?? market.avg_volatility;
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
  result.className = "analysis-result";
  result.innerHTML = `
    <div class="analysis-summary-head">
      <div class="analysis-summary-title">
        <span class="analysis-symbol">${escapeHtml(signal.symbol)}</span>
        <span class="signal-tf-badge">${escapeHtml(signal.timeframe)}</span>
        <span class="analysis-direction-badge ${dir}">${dir.toUpperCase()} ${directionText(signal.signal_type)}</span>
      </div>
        <span class="analysis-time num">#${escapeHtml(signal.id)} · ${escapeHtml(signalDisplayTime(signal))}</span>
    </div>
    <div class="analysis-status-strip">
      <div><span>置信度</span><strong>${confidence.label}</strong></div>
      <div><span>建议手数</span><strong>${escapeHtml(volumeText(signal.recommended_volume))}</strong></div>
      <div><span>有效期</span><strong id="analysisValidity" class="status-tag ${freshnessClass}">${escapeHtml(signalFreshness(signal))}</strong></div>
      <div><span>执行状态</span><strong class="status-tag ${freshnessClass}">${escapeHtml(executionStatus(signal))}</strong></div>
    </div>
    ${renderPendingSignalInfo(signal, market)}
    <div class="signal-detail-grid">
      <div><span>止损</span><strong>${escapeHtml(signal.stop_loss_price || "--")}</strong></div>
      <div><span>TP1</span><strong>${escapeHtml(signal.take_profit_1_price || "--")}</strong></div>
      <div><span>TP2 / TP3</span><strong>${escapeHtml(signal.take_profit_2_price || "--")} / ${escapeHtml(signal.take_profit_3_price || "--")}</strong></div>
      <div><span>数据源</span><strong>${escapeHtml(market.symbol ? "MT5 行情" : "历史信号")}</strong></div>
    </div>
    <div class="analysis-section">
      <div class="analysis-section-title"><i data-lucide="activity" size="14"></i>行情快照</div>
      <div class="analysis-market-grid grouped">
        <div class="market-group">
          <span class="market-group-title">行情</span>
          <div class="market-group-cells">
            <div><span>最新价 <em class="market-unit">USD/oz</em></span><strong>${marketValue(market, "latest_price", 2)}</strong></div>
            <div><span>SMA20 <em class="market-unit">USD/oz</em></span><strong>${marketValue(market, "sma_20", 2)}</strong></div>
            <div><span>偏离 SMA20 <em class="market-unit">USD</em></span><strong>${escapeHtml(smaDeviation)}</strong></div>
          </div>
        </div>
        <div class="market-group">
          <span class="market-group-title">波动</span>
          <div class="market-group-cells">
            <div><span>ATR <em class="market-unit">USD</em></span><strong>${Number.isFinite(Number(atrValue)) ? fmt(atrValue, 2) : "--"}</strong></div>
            <div><span>涨跌幅 <em class="market-unit">%</em></span><strong>${Number.isFinite(Number(market.price_change_pct)) ? signedText(market.price_change_pct, 3, "%") : "--"}</strong></div>
          </div>
        </div>
        <div class="market-group">
          <span class="market-group-title">账户</span>
          <div class="market-group-cells">
            <div><span>当前持仓数 <em class="market-unit">笔</em></span><strong>${escapeHtml(positions.total_positions ?? "--")}</strong></div>
            <div><span>同品种持仓 <em class="market-unit">笔</em></span><strong>${escapeHtml(positions.symbol_positions ?? "--")}</strong></div>
          </div>
        </div>
      </div>
    </div>
    <div class="analysis-section">
      <div class="analysis-section-title"><i data-lucide="file-text" size="14"></i>分析正文</div>
    </div>
    <div id="analysisTextContent" class="analysis-text collapsed">${analysisBlock}${reasoningBlock}</div>
    <div class="analysis-expand-row">
      <button class="btn-expand-analysis" type="button" data-action="toggle-analysis-text">展开完整分析</button>
    </div>
  `;
  highlightActiveAnalysis(signal.id);
  initIcons();
}

async function runAnalysis() {
  const symbol = $("analyzeSymbol").value;
  const frames = selectedTimeframes();
  if (!frames.length) {
    toast("请至少选择一个周期", "warning");
    return;
  }

  if (state.marketTradeMode === 0) {
    toast("当前市场休市，暂无法推理", "warning");
    return;
  }

  if (!state.currentConfigHasApiKey && !state._isUsingSharedModel) {
    toast("请先在模型设置中配置 API Key，或联系管理员开启模型共享", "warning");
    return;
  }

  $("runAnalysisBtn").disabled = true;
  $("executeSignalBtn").disabled = true;
  const resultEl = $("analysisResult");
  resultEl.className = "analysis-result";
  resultEl.innerHTML = `
    <div class="analysis-progress">
      <div class="analysis-progress-bar"><div class="analysis-progress-fill" id="analysisProgressFill"></div></div>
      <div class="analysis-progress-text">
        <span id="analysisProgressLabel">正在获取行情数据...</span>
        <span id="analysisProgressTime"></span>
      </div>
      <button class="btn btn-sm btn-danger" id="analysisCancelBtn" onclick="window._analysisCancelled=true">取消</button>
    </div>`;
  setText("analysisLatency", "推理中");
  setText("signalFreshness", "等待结果");
  const started = performance.now();
  window._analysisCancelled = false;

  const stages = [
    { pct: 10, label: "获取行情数据..." },
    { pct: 30, label: "计算技术指标..." },
    { pct: 50, label: "AI 模型推理中..." },
    { pct: 80, label: "生成交易信号..." },
    { pct: 95, label: "保存结果..." },
  ];
  let stageIdx = 0;
  const progressTimer = setInterval(() => {
    if (window._analysisCancelled || stageIdx >= stages.length) { clearInterval(progressTimer); return; }
    const s = stages[stageIdx++];
    const fill = document.getElementById("analysisProgressFill");
    const label = document.getElementById("analysisProgressLabel");
    const time = document.getElementById("analysisProgressTime");
    if (fill) fill.style.width = s.pct + "%";
    if (label) label.textContent = s.label;
    if (time) {
      const elapsed = ((performance.now() - started) / 1000).toFixed(1);
      const remaining = Math.max(0, ((100 - s.pct) / s.pct) * (performance.now() - started) / 1000).toFixed(0);
      time.textContent = `${elapsed}s / 预计 ${remaining}s`;
    }
  }, 3000);

  try {
    const klineCount = Number($("klineCount").value) || 100;
    const results = await Promise.all(frames.map((timeframe) => {
      const tag = `{{MTF:${timeframe.toUpperCase()}:${klineCount}}}`;
      const basePrompt = $("systemPrompt")?.value?.trim() || "";
      const promptWithTag = tag + (basePrompt ? "\n" + basePrompt : "");
      return wsApi("analyze", {
        session_id: "default", symbol, timeframe,
        kline_count: klineCount, include_positions: true,
        prompt_override: state.systemPromptInherited ? undefined : promptWithTag,
        _timeout: 120000,
      });
    }));
    if (window._analysisCancelled) { toast("已取消推理", "info"); return; }
    const best = results.map((item) => item.signal).filter(Boolean)
      .sort((a, b) => Number(b.confidence) - Number(a.confidence))[0];
    if (!best) throw new Error("未返回有效信号");
    const elapsed = Math.round(performance.now() - started);
    renderSignal(best, elapsed);
    showSignalNotification(best);
    await loadSignals({ skipResultRender: true });
    const firstItem = document.querySelector(".analysis-history-item");
    if (firstItem) firstItem.scrollIntoView({ behavior: "smooth", block: "nearest" });
    toast(`已生成 ${results.length} 个周期信号，耗时 ${(elapsed/1000).toFixed(1)}s`, "success");
  } catch (error) {
    resultEl.className = "analysis-result muted-block";
    resultEl.textContent = error.message;
    setText("analysisLatency", "--");
    setText("signalFreshness", "--");
    toast(error.message, "error");
  } finally {
    clearInterval(progressTimer);
    $("runAnalysisBtn").disabled = false;
    initIcons();
  }
}

async function executeSignal() {
  if (!state.selectedSignal) return;
  const currentDir = signalType(state.selectedSignal.signal_type);
  if (state.selectedSignal.is_stale || state.selectedSignal.is_executed || currentDir === "hold") {
    toast(executionStatus(state.selectedSignal), "warning");
    return;
  }
  const dir = signalType(state.selectedSignal.signal_type).toUpperCase();
  const ok = await showConfirm("复核执行信号", `复核执行 AI 信号 #${state.selectedSignal.id}（${state.selectedSignal.symbol} ${dir}）？后台会重取报价并检查有效期。`, { confirmText: "确认执行" });
  if (!ok) return;

  try {
    const result = await wsApi("execute", { session_id: "default", signal_id: state.selectedSignal.id, confirm: true });
    toast(result.message || (result.status === "success" ? "执行请求已处理" : `结果：${result.status}`), result.status === "success" ? "success" : "warning");
    await Promise.allSettled([loadPositions(), loadAccount(), loadSignals(), loadAudit()]);
  } catch (error) {
    toast(error.message, "error");
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
  if (signal.is_executed) return "已执行";
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
    const limit = options.limit || 6;
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
      host.insertAdjacentHTML("beforeend", `<div class="history-sentinel"><span class="history-sentinel-text">滚动加载更多</span></div>`);
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

async function openAnalysisFromHistory(signalId) {
  let signal = state.signals.find((item) => String(item.id) === String(signalId));
  if (!signal) {
    // Not in local cache — fetch single signal by ID
    try {
      const data = await wsApi("signal_detail", { signal_id: Number(signalId) });
      if (data.status === 'success' && data.signal) {
        signal = data.signal;
        // Insert into state.signals at top
        state.signals.unshift(signal);
        renderAnalysisHistory(state.signals);
      }
    } catch (e) { /* ignore */ }
  }
  if (!signal) {
    toast("未找到对应推理记录", "warning");
    return;
  }
  state.selectedSignal = signal;
  setTab("ai-analyze");
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
  const limit = options.limit || 6;
  const offset = options.offset || 0;
  const data = await wsApi("signals", { limit, offset });
  const signals = data.signals || [];
  const hasMore = data.has_more !== undefined ? data.has_more : signals.length >= limit;

  if (options.append) {
    state.signals = state.signals.concat(signals);
  } else {
    state.signals = signals;
  }
  state.analysisHistoryOffset = state.signals.length;
  state.analysisHistoryHasMore = hasMore;

  // Sync _lastSignalId so _maybeRefreshSignal doesn't re-fetch unnecessarily
  if (state.signals.length > 0 && !options.append) _lastSignalId = state.signals[0].id;

  // Preserve selected signal if it still exists, otherwise use latest
  const selectedId = state.selectedSignal?.id;
  const stillExists = selectedId ? state.signals.find(s => String(s.id) === String(selectedId)) : null;
  const activeSignal = stillExists || state.signals[0] || null;

  if (!options.append) {
    state.selectedSignal = activeSignal;
    updateSignalDisplay(activeSignal);
    if (activeSignal) setText("signalFreshness", signalFreshness(activeSignal));
  }
  renderAnalysisHistory(state.signals, options.append ? { append: true } : {});
  if (!options.skipResultRender && !options.append) {
    renderSignal(activeSignal, null);
  }

  // Also refresh signal table on non-append loads
  if (!options.append) loadSignalTable();
}

// Load signal table data (server-side filtering + pagination, 20/page)
async function loadSignalTable() {
  const page = state.signalFilters.page;
  const pageSize = state.signalFilters.pageSize;
  const params = { limit: pageSize, offset: (page - 1) * pageSize };
  if (state.signalFilters.direction) params.direction = state.signalFilters.direction;
  if (state.signalFilters.timeframe) params.timeframe = state.signalFilters.timeframe;
  try {
    const data = await wsApi("signals", params);
    state.signalTableData = data.signals || [];
    state.signalTableTotal = data.total_count || 0;
    renderSignalRows();
  } catch (e) { /* silent */ }
}

function setHistoryZeroClass(id, value) {
  const el = $(id);
  if (!el?.parentElement) return;
  const num = Number(value);
  el.parentElement.classList.toggle("zero-value", Number.isFinite(num) && num === 0);
}

async function loadHistory(forceRefresh) {
  try {
    const filters = state.historyFilters;
    const entryFrom = document.getElementById('filterEntryFrom')?.value || '';
    const entryTo = document.getElementById('filterEntryTo')?.value || '';
    const closeFrom = document.getElementById('filterCloseFrom')?.value || '';
    const closeTo = document.getElementById('filterCloseTo')?.value || '';
    const direction = document.getElementById('filterDirection')?.value || '';
    const profit = document.getElementById('filterProfit')?.value || '';
    const filterParams = {};
    if (entryFrom) filterParams.entry_from = entryFrom;
    if (entryTo) filterParams.entry_to = entryTo;
    if (closeFrom) filterParams.close_from = closeFrom;
    if (closeTo) filterParams.close_to = closeTo;
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
      wsApi("history", { page: filters.page, page_size: filters.pageSize, ...filterParams }),
      loadSignalTickets(),
      loadCloseSignalTickets(),
    ]);
    _historyCache = { filters: filterKey, data };
    _applyHistoryData(data);
  } catch (e) { console.error("loadHistory:", e); }
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

// ---- Chart-only fetch: independent of table filters, defaults to 30 days ----
async function loadHistoryChart(forceRefresh) {
  try {
    const from = document.getElementById('chartDateFrom')?.value || '';
    const to = document.getElementById('chartDateTo')?.value || '';
    const params = {};
    if (from) params.close_from = from;
    if (to) params.close_to = to;

    const filterKey = JSON.stringify(params);
    if (!forceRefresh && _historyChartCache && _historyChartCache.filters === filterKey) {
      _renderHistoryChart(_historyChartCache.data);
      return;
    }

    const data = await wsApi("history_chart_data", params);
    if (data?.status === 'success') {
      _historyChartCache = { filters: filterKey, data };
      await ensureChartJs();
      _renderHistoryChart(data);
    }
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
        // Set TABLE close-date filter, reload table only — chart stays unchanged
        document.getElementById('filterCloseFrom') && (document.getElementById('filterCloseFrom').value = date);
        document.getElementById('filterCloseTo') && (document.getElementById('filterCloseTo').value = date);
        state.historyFilters.page = 1;
        _historyCache = null;
        loadHistory(true);
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
    const filterParams = {};
    const entryFrom = document.getElementById('filterEntryFrom')?.value || '';
    const entryTo = document.getElementById('filterEntryTo')?.value || '';
    const closeFrom = document.getElementById('filterCloseFrom')?.value || '';
    const closeTo = document.getElementById('filterCloseTo')?.value || '';
    const direction = document.getElementById('filterDirection')?.value || '';
    const profit = document.getElementById('filterProfit')?.value || '';
    if (entryFrom) filterParams.entry_from = entryFrom;
    if (entryTo) filterParams.entry_to = entryTo;
    if (closeFrom) filterParams.close_from = closeFrom;
    if (closeTo) filterParams.close_to = closeTo;
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
    smart_close: "AI 智能平仓",
    smart_close_rule: "规则智能平仓",
  }[action] || action || "--";
}

function auditStatusLabel(status) {
  return {
    success: "成功",
    skipped: "已跳过",
    error: "错误",
    rejected: "风控拒绝",
    needs_confirmation: "需要确认",
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
  const reasonText = auditReasonLabel(result.reason || "");
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
    const status = String(row.status || "");
    const type = auditActionType(row.action);
    return (!filters.status || status === filters.status) && (!filters.type || type === filters.type);
  });
  filters.page = clampPage(filters.page, filters.pageSize, filtered.length);
  const start = (filters.page - 1) * filters.pageSize;
  const pageRows = filtered.slice(start, start + filters.pageSize);
  setText("auditCount", `显示 ${filtered.length} / ${state.auditRows.length} 条`);
  body.innerHTML = pageRows.length ? pageRows.map((row) => {
    const result = row.result || {};
    const rawReason = result.reason || result.message || result.status || "";
    const reasonText = auditReasonLabel(rawReason) || "--";
    const status = row.status || "";
    const statusClass = status || "unknown";
    const actionType = auditActionType(row.action);
    const resultText = auditResultText(row);
    return `
      <tr class="audit-row ${auditRowClass(status)}">
        <td>${compactTimeHtml(row?.created_at_mt5 || row?.created_at)}</td>
        <td><span class="action-badge ${actionType}">${escapeHtml(auditActionLabel(row.action))}</span></td>
        <td>${escapeHtml(row.symbol || "--")}</td>
        <td><span class="audit-status ${statusClass}">${escapeHtml(auditStatusLabel(row.status))}</span></td>
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
  $('apiProvider')?.addEventListener('change', e => applyProviderPreset(e.target.value));
  $("refreshAllBtn").addEventListener("click", () => { _historyCache = null; _historyChartCache = null; refreshAll(); });
  $("gatewayMode")?.addEventListener("click", handleGatewayModeClick);
  $("saveConfigBtn").addEventListener("click", saveConfig);
  $("useTemplateBtn")?.addEventListener("click", async () => {
    try {
      const data = await wsApi("get_default_prompt");
      if (data.status === "success" && data.prompt) {
        $("systemPrompt").value = data.prompt;
        state.systemPromptInherited = state.user?.role !== "admin";
        toast("已填入管理员模板", "success");
      } else {
        toast("暂无可用模板", "warning");
      }
    } catch (e) {
      toast("获取模板失败", "error");
    }
  });
  $("systemPrompt")?.addEventListener("input", () => {
    if (state.user?.role !== "admin") state.systemPromptInherited = false;
  });
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

  // Config sub-tabs
  initConfigSubTabs();
  initAutoSymbolsSelector();
  $("saveAutoConfigBtn")?.addEventListener("click", saveAutoConfig);
  $("autoApiProvider")?.addEventListener("change", (e) => applyAutoProviderPreset(e.target.value));

  // Timeframe checkbox change → update confirm text
  // (removed old modal handlers)

  document.querySelectorAll(".nav-item").forEach((button) => {
    if (button.dataset.tab) {
      button.addEventListener("click", () => setTab(button.dataset.tab));
    }
  });

  document.body.addEventListener("click", (event) => {
    const actionButton = event.target.closest("[data-action]");
    const tabButton = event.target.closest("[data-tab-jump]");
    const closeButton = event.target.closest("[data-close-ticket]");
    const auditResult = event.target.closest("[data-audit-result]");
    const pagerButton = event.target.closest("[data-pager]");

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

  // History table filter buttons (only affect table, not chart)
  document.getElementById('historyFilterApply')?.addEventListener('click', () => {
    state.historyFilters.page = 1;
    _historyCache = null;
    loadHistory(true);
  });
  document.getElementById('historyFilterReset')?.addEventListener('click', () => {
    ['filterEntryFrom','filterEntryTo','filterCloseFrom','filterCloseTo'].forEach(id => { const el = document.getElementById(id); if (el) el.value = ''; });
    ['filterDirection','filterProfit'].forEach(id => { const el = document.getElementById(id); if (el) el.selectedIndex = 0; });
    state.historyFilters.page = 1;
    _historyCache = null;
    loadHistory(true);
  });
  // Chart date range filter (only affects chart, not table)
  document.getElementById('chartDateApply')?.addEventListener('click', () => {
    _historyChartCache = null;
    loadHistoryChart(true);
  });
  document.getElementById('chartDateReset')?.addEventListener('click', () => {
    const ef = document.getElementById('chartDateFrom');
    const et = document.getElementById('chartDateTo');
    if (ef) ef.value = '';
    if (et) et.value = '';
    _historyChartCache = null;
    loadHistoryChart(true);
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
    loadSignals({ append: true, offset: state.analysisHistoryOffset, limit: 6 }).finally(() => {
      state.analysisHistoryLoading = false;
      if (!state.analysisHistoryHasMore) {
        const sentinel = list.querySelector(".history-sentinel");
        if (sentinel) sentinel.remove();
      }
    });
  };

  list.addEventListener("scroll", function() {
    const nearBottom = list.scrollTop + list.clientHeight >= list.scrollHeight - 60;
    if (nearBottom) loadMore();
  });

  list.addEventListener("click", function(e) {
    if (e.target.closest(".history-sentinel")) loadMore();
  });
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

