const state = {
  token: new URLSearchParams(window.location.search).get("token") || localStorage.getItem("authToken") || "",
  user: null,
  symbols: [],
  signals: [],
  selectedSignal: null,
  _lastGatewayLive: false,
  backgroundSyncTimer: null,
  lastQuote: null,
  currentConfigHasApiKey: false,
  pendingManualOrder: null,

  auditRows: [],
  signalFilters: { direction: "", timeframe: "", page: 1, pageSize: 20 },
  auditFilters: { status: "", type: "", page: 1, pageSize: 25 },
  signalTickets: {},
};

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
}

// ===== Searchable Symbol Selector =====
function createSymbolSelector(inputId, options) {
  const input = document.getElementById(inputId);
  if (!input) return;
  const wrapper = document.createElement("div");
  wrapper.className = "sym-selector";
  input.parentNode.insertBefore(wrapper, input);
  wrapper.appendChild(input);
  input.className = "sym-input";
  input.setAttribute("autocomplete", "off");
  input.setAttribute("placeholder", "搜索品种...");

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
  document.addEventListener("click", (e) => { if (!wrapper.contains(e.target)) close(); });

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
    setGlobalSymbol(sym);
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

function setSignalBadge(signal) {
  const badge = $("signalLiveBadge");
  if (!badge) return;
  let label = "等待";
  let stateClass = "expired";
  if (signal?.is_executed) {
    label = "已执行";
    stateClass = "executed";
  } else if (signal && !signal.is_stale) {
    label = "LIVE";
    stateClass = "";
  } else if (signal?.is_stale) {
    label = "已过期";
    stateClass = "expired";
  }
  badge.className = `signal-live-badge ${stateClass}`.trim();
  badge.innerHTML = `<span class="badge-dot"></span>${label}`;
}

function signalType(value) {
  const type = String(value || "hold").toLowerCase();
  return type === "buy" || type === "sell" ? type : "hold";
}

function directionText(value) {
  return { buy: "买入", sell: "卖出", hold: "观望" }[signalType(value)] || "观望";
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
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), options.timeout || 15000);
  try {
    const response = await fetch(path, { ...options, headers, signal: controller.signal });
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
    const timer = setTimeout(() => { _wsPending.delete(cmdId); reject(new Error('请求超时')); }, 10000);
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
  ws.onopen = () => {

    state._hbSeq = 0;
    if (state._hbTimer) clearInterval(state._hbTimer);
    state._hbTimer = setInterval(() => {
      if (ws.readyState === 1) {
        try { ws.send(JSON.stringify({ type: 'hb', seq: ++state._hbSeq })); } catch {}
      }
    }, 1000);
    if (typeof onReady === 'function') onReady();
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
      } else if (msg.type === 'result' && msg.command_id) {
        const pending = _wsPending.get(msg.command_id);
        if (pending) {
          clearTimeout(pending.timer);
          _wsPending.delete(msg.command_id);
          if (msg.status === 'error') pending.reject(new Error(msg.message || 'Command failed'));
          else pending.resolve(msg);
        }
      }
    } catch {}
  };
  ws.onclose = (e) => {
    if (state._hbTimer) { clearInterval(state._hbTimer); state._hbTimer = null; }
    if (state.bridgeWs === ws) state.bridgeWs = null;
    for (const [id, p] of _wsPending) { clearTimeout(p.timer); p.reject(new Error('WebSocket断开')); }
    _wsPending.clear();
    // Auth failure (server closed with 4002) -> don't retry
    if (e.code === 4002) { setBadge("gatewayMode", "认证失败，请重新登录", "danger"); return; }
    // Prevent duplicate reconnect timers
    if (state._reconnectTimer) clearTimeout(state._reconnectTimer);
    setBadge("gatewayMode", "WebSocket断开-重连中...", "neutral");
    if (state.token) state._reconnectTimer = setTimeout(() => { state._reconnectTimer = null; connectBridgeStatusWs(); }, 3000);
  };
  ws.onerror = () => {};
}

// Handle data push from bridge (account + quote + positions)
function handleBridgeData(msg) {
  const selectedSymbol = $("quoteSymbolSelect")?.value || $("tradeSymbolSelect")?.value || "XAUUSD";
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
      setQuoteDirection("quoteBidDir", bidDir);
      setQuoteDirection("quoteAskDir", askDir);
      flashPrice("quoteBid", bidDir);
      flashPrice("quoteAsk", askDir);
      if (Number.isFinite(Number(q.bid)) && Number.isFinite(Number(q.ask))) {
        state.lastQuote = { symbol: q.symbol, bid: Number(q.bid), ask: Number(q.ask), spread: Number(q.spread), time: q.time };
        updateTradingQuotePreview(state.lastQuote);
      }
    }
  }
  if (msg.account) {
    setText("accountBalance", fmt(msg.account.balance));
    setText("accountEquity", fmt(msg.account.equity));
    setText("accountMargin", fmt(msg.account.margin));
    setText("accountMarginFree", fmt(msg.account.free_margin));
    setText("accountFloatPnl", fmt(msg.account.profit));
    setText("tradeAccountBalance", fmt(msg.account.balance));
    setText("tradeAccountEquity", fmt(msg.account.equity));
    setText("tradeAccountProfit", fmt(msg.account.profit));
    setText("tradeAccountFreeMargin", fmt(msg.account.free_margin));
    updatePnlStyle("accountFloatPnl", msg.account.profit);
    updatePnlStyle("tradeAccountProfit", msg.account.profit);
  }
  if (msg.positions) {
    for (const pos of msg.positions) {
      const closeBtn = document.querySelector(`[data-close-ticket="${pos.ticket}"]`);
      if (closeBtn) {
        const row = closeBtn.closest('tr');
        if (row) {
          const cells = row.querySelectorAll('td');
          if (cells[5]) cells[5].textContent = fmt(pos.current_price);
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
          if (cells[5]) cells[5].textContent = fmt(pos.current_price);
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
async function _maybeRefreshSignal() {
  const now = Date.now();
  if (now - _lastSignalRefreshTs < 1000) return;
  _lastSignalRefreshTs = now;
  try {
    const data = await wsApi("signals", { session_id: "default" });
    const signals = data.signals || [];
    const latestSignal = signals[0] || null;

    // No signals at all
    if (!latestSignal) {
      if (_lastSignalId !== null) { updateSignalDisplay(null); _lastSignalId = null; state.selectedSignal = null; }
      return;
    }

    // Update signals list
    state.signals = signals;

    // Determine which signal to display: user's selection > latest
    const selectedId = state.selectedSignal?.id;
    const selectedInList = selectedId ? signals.find(s => String(s.id) === String(selectedId)) : null;
    const displaySignal = selectedInList || latestSignal;

    // New signal detected (ID changed) — switch to new signal
    if (_lastSignalId !== latestSignal.id) {
      _lastSignalId = latestSignal.id;
      state.selectedSignal = latestSignal;
      updateSignalDisplay(latestSignal);
      setText("signalFreshness", signalFreshness(latestSignal));
      renderAnalysisHistory(signals);
      renderSignalRows();
      return;
    }

    // Same signal — light refresh: only update timing UI for the DISPLAYED signal
    state.selectedSignal = displaySignal;
    setText("sigValidWindow", signalFreshness(displaySignal));
    setText("signalFreshness", signalFreshness(displaySignal));
    setText("analysisValidity", signalFreshness(displaySignal));
    setSignalBadge(displaySignal);
    const card = $("signalCard");
    if (card) {
      card.dataset.status = displaySignal.is_executed ? "executed" : displaySignal.is_stale ? "expired" : "live";
      const dir = signalType(displaySignal.signal_type);
      const colorMap = { buy: "var(--color-positive)", sell: "var(--color-negative)", hold: "var(--color-warning)" };
      card.style.setProperty("--signal-border", colorMap[dir]);
      card.style.setProperty("--signal-glow", colorMap[dir] === "var(--color-positive)" ? "var(--signal-glow-buy)" : colorMap[dir] === "var(--color-negative)" ? "var(--signal-glow-sell)" : "var(--signal-glow-hold)");
    }
    const btn = $("executeSignalBtn");
    if (btn) {
      const executable = signalType(displaySignal.signal_type) !== "hold" && !displaySignal.is_stale && !displaySignal.is_executed;
      btn.disabled = !executable;
    }
  } catch (e) { /* silent */ }
}

// Handle heartbeat reply — MT5 connection status
function handleHeartbeat(msg) {
  const isLive = msg.mt5_connected && msg.mt5_alive;
  const usingFallback = msg.using_fallback;
  const wasLive = state._lastGatewayLive;
  state._usingFallback = usingFallback;

  if (usingFallback) {
    setBadge("gatewayMode", "观摩模式-管理员账户", "warning");
  } else {
    setBadge("gatewayMode", isLive ? "MT5桥接-已连接" : "未连接-请启动桥接脚本", isLive ? "connected" : "neutral");
  }
  if (!isLive && !usingFallback) setBadge("tradeMode", "请先启动桥接", "neutral");
  state._lastGatewayLive = isLive;
  if (isLive !== wasLive) {
    if (isLive) { refreshAll().catch(() => {}); }
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
  state._lastGatewayLive = false;
}

function startRealtimeSync() {
  stopRealtimeSync();
  // Delay first background sync by 5s to let bridge connect
  setTimeout(() => {
    if (!state.token) return;
    state.backgroundSyncTimer = setInterval(() => {
      if (!state.token || state.backgroundSyncInFlight) return;
      state.backgroundSyncInFlight = true;
      const tab = activeTabId();
      const tasks = [loadSignals()];
      if (tab === "history") tasks.push(loadHistory());
      if (tab === "audit" || tab === "trading" || tab === "dashboard") tasks.push(loadAudit());
      Promise.allSettled(tasks).finally(() => { state.backgroundSyncInFlight = false; });
    }, 30000);
  }, 5000);
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
    await Promise.allSettled([loadAccount(), loadPositions(), loadStatus()]);
  } else if (tabId === "dashboard") {
    await Promise.allSettled([loadAccount(), loadPositions(), loadStatus()]);
  } else if (tabId === "history") {
    await Promise.allSettled([loadAccount(), loadHistory()]);
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

async function login(event) {
  if (event) event.preventDefault();
  window.location.href = "/";
}

function logout() {
  if (state.bridgeWs) { try { state.bridgeWs.close() } catch {} state.bridgeWs = null; }
  stopRealtimeSync();
  state.user = null;
  state.selectedSignal = null;
  setAuth("");
  showApp(false);
  window.location.href = "/";
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
      window.location.href = "/";
      return;
    }
    state.user = await api("/aurum-api/auth/me");
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
    // Connect WebSocket FIRST — all data flows through it
    await new Promise((resolve) => {
      connectBridgeStatusWs(resolve);
    });
    await refreshAll();
    startRealtimeSync();
    // Activate tick stream for current tab (stops old polling)
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
      loadAudit(),
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
    setBadge("gatewayMode", "观摩模式-管理员账户", "warning");
  } else {
    setBadge("gatewayMode", isLive ? "MT5桥接-已连接" : "未连接-请启动桥接脚本", isLive ? "connected" : "neutral");
  }

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

  try {
    const auto = await wsApi('auto_status');
    const scheduler = auto.scheduler || {};
    const enabled = scheduler.enabled;
    const running = scheduler.running;
    const symbols = (scheduler.symbols || []).join(', ');
    const intervalMin = scheduler.interval_minutes || 5;
    const label = enabled
      ? running ? `自动推理运行中 · ${symbols} · ${intervalMin}分钟` : `自动推理 · ${symbols} · ${intervalMin}分钟`
      : '自动推理关闭';
    const type = enabled
      ? running ? 'active' : 'connected'
      : 'neutral';
    setBadge('autoAnalyzeMode', label, type);

    // Store current auto config
    state.autoConfig = {
      symbols: scheduler.symbols || ['XAUUSD'],
      interval_minutes: intervalMin,
    };
  } catch {
    setBadge("autoAnalyzeMode", "自动推理状态未知", "warning");
  }
}

// ============ Gateway Badge Click ============
// ============ Gateway Badge Click — MT5 connect/disconnect ============
async function handleGatewayModeClick() {
  const modal = $("mt5BridgeModal");
  if (!modal) return;
  // Toggle: if already open, close it
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

  $("downloadExe")?.addEventListener("click", () => {
    const token = state.token || localStorage.getItem("authToken") || "";
    // Download EXE
    const url = `/ai/bridge/exe-file?token=${encodeURIComponent(token)}`;
    const a = document.createElement("a");
    a.href = url; a.download = "AURUM_Bridge.exe"; a.click();
    // Auto download config.json
    const serverUrl = location.origin;
    const cfg = JSON.stringify({ server_url: serverUrl, token }, null, 2);
    const blob = new Blob([cfg], { type: "application/json" });
    const a2 = document.createElement("a");
    a2.href = URL.createObjectURL(blob);
    a2.download = "config.json";
    setTimeout(() => { a2.click(); URL.revokeObjectURL(a2.href); }, 500);
    toast("正在下载 EXE 和 config.json", "success");
    modal.classList.add("hidden");
  });

  $("downloadMac")?.addEventListener("click", () => {
    const token = state.token || localStorage.getItem("authToken") || "";
    const url = `/ai/bridge/mac?token=${encodeURIComponent(token)}`;
    const a = document.createElement("a");
    a.href = url; a.download = "AURUM_Bridge_Mac.command"; a.click();
    toast("macOS 桥接脚本已下载", "success");
    modal.classList.add("hidden");
  });

  $("downloadConfig")?.addEventListener("click", () => {
    const token = state.token || localStorage.getItem("authToken") || "";
    const serverUrl = location.origin;
    const cfg = JSON.stringify({ server_url: serverUrl, token }, null, 2);
    const blob = new Blob([cfg], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "config.json";
    a.click();
    URL.revokeObjectURL(a.href);
    toast("config.json 已下载，放到 EXE 同目录覆盖即可", "success");
    modal.classList.add("hidden");
  });


}

// ============ Trade Mode Badge Click — toggle trade sending ============
async function handleTradeModeClick() {
  const health = await wsApi("health").catch(() => null);
  const gateway = health?.gateway || {};
  const currentlyEnabled = gateway.live_trading_enabled;

  // Turning ON requires MT5 connection
  if (!currentlyEnabled && gateway.mode !== "live") {
    toast("请先启动桥接脚本", "warning");
    return;
  }

  try {
    const result = await wsApi("toggle_trade", { enable: !currentlyEnabled });
    toast(currentlyEnabled ? "交易发送已关闭" : "交易发送已开启", "success");
    await loadStatus();
  } catch (e) {
    toast("切换失败: " + e.message, "error");
  }
}

// ============ Auto Toggle (Simple) ============
async function handleAutoToggle() {
  try {
    const result = await wsApi('toggle_auto');
    toast(result.message || (result.enabled ? '自动推理已开启' : '自动推理已关闭'), 'success');
    // Immediately update badge (don't wait for loadStatus)
    const symbols = state.autoConfig?.symbols || ['XAUUSD'];
    const intervalMin = state.autoConfig?.interval_minutes || 5;
    const label = result.enabled
      ? `自动推理运行中 · ${symbols.join(', ')} · ${intervalMin}分钟`
      : '自动推理关闭';
    const type = result.enabled ? 'active' : 'neutral';
    setBadge('autoAnalyzeMode', label, type);
    // Also reload full status in background
    loadStatus().catch(() => {});
  } catch (e) {
    toast('切换失败: ' + e.message, 'error');
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
}

async function loadAccount() {
  const data = await wsApi("account");
  const server = data.server || data.company || "服务器 --";
  const currency = data.currency || "USD";
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
  }
  updateSignalPriceFields(state.selectedSignal);
}

function renderPositionRows(positions, withAction) {
  if (!positions.length) {
    return `<tr class="empty-row"><td colspan="${withAction ? 11 : 8}">当前无持仓</td></tr>`;
  }
  const tickets = state.signalTickets || {};
  return positions.map((position) => {
    const type = String(position.type || "").toLowerCase();
    const directionLabel = type === "buy" ? "买入 多" : "卖出 空";
    const directionClass = type === "buy" ? "dir-buy" : "dir-sell";
    const digits = Number(position.digits);
    const priceDigits = Number.isFinite(digits) ? Math.min(Math.max(digits, 0), 6) : 2;
    return `
      <tr>
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

function ticketCell(ticket, signalTickets) {
  const signalId = signalTickets[String(ticket)];
  if (signalId) {
    return `<td class="num"><a href="#" class="signal-link" onclick="event.preventDefault(); openAnalysisFromHistory(${signalId})">${escapeHtml(ticket)}</a></td>`;
  }
  return `<td class="num">${escapeHtml(ticket)}</td>`;
}

async function loadPositions() {
  const [data] = await Promise.all([
    wsApi("positions"),
    loadSignalTickets(),
  ]);
  const positions = data.positions || [];
  $("positionsBody").innerHTML = renderPositionRows(positions, true);
  $("dashboardPositionsBody").innerHTML = renderPositionRows(positions, false);
  $("positionsEmpty").classList.toggle("hidden", positions.length > 0);
  $("dashboardPositionsTable").classList.toggle("hidden", positions.length === 0);
  initIcons();
}

function applyRoleUI() {
  const isAdmin = state.user?.role === "admin";
  const isPlusReadOnly = state.isPlusReadOnly;

  // Model tab: hidden for plus users
  const modelTab = document.querySelector('.nav-item[data-tab="ai-config"]');
  if (modelTab) modelTab.style.display = isPlusReadOnly ? "none" : "";

  // Sub-tabs: non-admin only sees manual config
  const autoTab = document.querySelector('.config-sub-tab[data-config-tab="auto-config"]');
  if (autoTab) autoTab.style.display = isAdmin ? "" : "none";
  // If non-admin, force switch to manual tab
  if (!isAdmin) {
    const manualTab = document.querySelector('.config-sub-tab[data-config-tab="manual-config"]');
    if (manualTab) manualTab.click();
  }

  // Plus read-only: disable all action buttons
  if (isPlusReadOnly) {
    document.querySelectorAll('.card-action-btn, .btn-primary, .btn-danger, [data-action="execute"], [data-action="close-position"]').forEach(el => {
      el.disabled = true;
      el.title = 'Plus 会员仅可查看';
    });
  }
}

/* ---- Provider presets: model name → API base URL ---- */
const PROVIDER_PRESETS = {
  deepseek: { models: ['deepseek-chat', 'deepseek-reasoner'], url: 'https://api.deepseek.com' },
  gpt:      { models: ['gpt-4o', 'gpt-4o-mini', 'gpt-4-turbo', 'o1-mini'], url: 'https://api.openai.com/v1' },
  kimi:     { models: ['moonshot-v1-8k', 'moonshot-v1-32k', 'moonshot-v1-128k'], url: 'https://api.moonshot.cn/v1' },
  qwen:     { models: ['qwen-turbo', 'qwen-plus', 'qwen-max', 'qwen-long'], url: 'https://dashscope.aliyuncs.com/compatible-mode/v1' },
  zhipu:    { models: ['glm-4-flash', 'glm-4-air', 'glm-4', 'glm-4v'], url: 'https://open.bigmodel.cn/api/paas/v4' },
  doubao:   { models: ['doubao-1.5-pro-32k', 'doubao-1.5-lite-32k', 'doubao-pro-32k'], url: 'https://ark.cn-beijing.volces.com/api/v3' },
  claude:   { models: ['claude-sonnet-4-20250514', 'claude-3-5-haiku-20241022', 'claude-3-opus-20240229'], url: 'https://api.anthropic.com/v1' },
  gemini:   { models: ['gemini-2.0-flash', 'gemini-2.5-pro', 'gemini-1.5-pro'], url: 'https://generativelanguage.googleapis.com/v1beta' },
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

$('apiProvider').addEventListener('change', e => applyProviderPreset(e.target.value));

async function loadConfig() {
  const data = await wsApi("ai_config");
  const cfg = data.config;
  if (!cfg) {
    state.currentConfigHasApiKey = false;
    $("systemPrompt").value = "You are a disciplined trading analyst. Return strict JSON.";
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
  $("temperature").value = cfg.temperature ?? 0.7;
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

  // Load system prompt from config (per-user in ai_configs)
  if (cfg.system_prompt) $("systemPrompt").value = cfg.system_prompt;

  // Model sharing toggle (admin only)
  const isAdmin = state.user?.role === "admin";
  const sharingWrap = $("modelSharingWrap");
  const sharedInfo = $("modelSharedInfo");
  if (sharingWrap) sharingWrap.style.display = isAdmin ? "" : "none";
  if (isAdmin && $("modelSharingEnabled")) {
    $("modelSharingEnabled").checked = Boolean(cfg.model_sharing_enabled);
  }
  if (sharedInfo) {
    if (!isAdmin && cfg._model_shared) {
      sharedInfo.style.display = "";
      setText("configStatus", `${cfg.api_provider || "Provider"} · ${cfg.model_name || "model"} · 使用管理员共享模型`);
    } else {
      sharedInfo.style.display = "none";
    }
  }
}

async function saveConfig() {
  const apiKey = $("apiKey").value.trim();
  const sharedInfo = $("modelSharedInfo");
  const isUsingShared = sharedInfo && sharedInfo.style.display !== "none";
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
      system_prompt: $("systemPrompt").value.trim() || null,
    },
  };

  try {
    await wsApi("save_config", { config: body.config, session_id: body.session_id });
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
    });
  });
}

// ============ Auto Config ============
function applyAutoProviderPreset(provider) {
  const presets = {
    deepseek: { url: 'https://api.deepseek.com', model: 'deepseek-chat' },
    gpt: { url: 'https://api.openai.com/v1', model: 'gpt-4o' },
    kimi: { url: 'https://api.moonshot.cn/v1', model: 'moonshot-v1-8k' },
    qwen: { url: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen-plus' },
    zhipu: { url: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-4-flash' },
    doubao: { url: 'https://ark.cn-beijing.volces.com/api/v3', model: 'doubao-1.5-pro-256k' },
    claude: { url: 'https://api.anthropic.com', model: 'claude-sonnet-4-20250514' },
    gemini: { url: 'https://generativelanguage.googleapis.com/v1beta', model: 'gemini-2.5-flash' },
  };
  const p = presets[provider];
  if (!p) return;
  const urlEl = document.getElementById('autoApiBaseUrl');
  const modelEl = document.getElementById('autoModelName');
  if (urlEl && !urlEl.value) urlEl.value = p.url;
  if (modelEl && (!modelEl.value || modelEl.value === 'deepseek-chat')) modelEl.value = p.model;
}

async function loadAutoConfig() {
  const isAdmin = state.user?.role === 'admin';
  const autoPanel = document.getElementById('auto-config');
  if (autoPanel) autoPanel.style.display = isAdmin ? '' : 'none';
  if (!isAdmin) return;

  try {
    const data = await wsApi('get_auto_config');
    if (data.status !== 'success') { setText('autoConfigStatus', data.message || '加载失败'); return; }
    const cfg = data.config;

    document.getElementById('autoApiProvider').value = cfg.api_provider || 'deepseek';
    document.getElementById('autoModelName').value = cfg.model_name || 'deepseek-chat';
    document.getElementById('autoApiBaseUrl').value = cfg.api_base_url || '';
    document.getElementById('autoTemperature').value = cfg.temperature ?? 0.3;
    document.getElementById('autoMaxTokens').value = cfg.max_tokens ?? 2000;
    document.getElementById('autoRiskLevel').value = cfg.risk_level || 'medium';
    document.getElementById('autoMaxPositionSize').value = (Number(cfg.max_position_size) || 0.05).toFixed(2);
    document.getElementById('autoSelectedTakeProfit').value = String(cfg.selected_take_profit || 2);
    document.getElementById('autoSymbolSelect').value = (cfg.symbols || ['XAUUSD']).join(', ');
    document.getElementById('autoApiKey').placeholder = cfg.has_api_key ? '已配置；如需更新请重新输入' : '输入 API Key';
    document.getElementById('autoSystemPrompt').value = cfg.system_prompt || '';
    document.getElementById('autoIntervalMin').value = cfg.interval_minutes || 5;

    applyAutoProviderPreset(cfg.api_provider || 'deepseek');
    setText('autoConfigStatus', `${cfg.api_provider || 'Provider'} · ${cfg.model_name || 'model'} · ${cfg.has_api_key ? '密钥已配置' : '未配置密钥'} · 品种: ${(cfg.symbols||[]).join(',')} · 间隔: ${cfg.interval_minutes || 5}分钟`);
  } catch (e) {
    setText('autoConfigStatus', '加载失败: ' + e.message);
  }
}

function initAutoSymbolsSelector() {
  // Use the exact same pattern as createSymbolSelector but support multi-select via comma-separated text
  const input = document.getElementById('autoSymbolSelect');
  if (!input) return;

  // Wrap in sym-selector just like the overview
  const wrapper = document.createElement('div');
  wrapper.className = 'sym-selector';
  input.parentNode.insertBefore(wrapper, input);
  wrapper.appendChild(input);
  input.className = 'sym-input';
  input.setAttribute('autocomplete', 'off');
  input.setAttribute('placeholder', '搜索品种...');

  const dropdown = document.createElement('div');
  dropdown.className = 'sym-dropdown';
  wrapper.appendChild(dropdown);

  let highlightIdx = -1;
  let filtered = [];

  // Current symbols as array
  function getSymbols() {
    return input.value.split(',').map(s => s.trim()).filter(Boolean);
  }

  function render(filter) {
    const q = (filter || '').toUpperCase();
    // Get the text being typed (last segment after comma)
    const parts = input.value.split(',');
    const typing = (parts[parts.length - 1] || '').trim().toUpperCase();
    const activeSymbols = getSymbols();
    const allNames = (state.symbols || []).map(s => typeof s === 'string' ? s : s.name).filter(Boolean);
    filtered = q ? allNames.filter(s => s.toUpperCase().includes(q)) : [...allNames];
    highlightIdx = -1;
    if (!filtered.length) {
      dropdown.innerHTML = '<div class="sym-empty">未找到匹配品种</div>';
      return;
    }
    dropdown.innerHTML = filtered.map((s, i) =>
      `<div class="sym-option${activeSymbols.includes(s) ? ' active' : ''}" data-symbol="${s}" data-idx="${i}">${s}</div>`
    ).join('');
  }

  function open() { render(input.value); dropdown.classList.add('open'); }
  function close() { dropdown.classList.remove('open'); }

  input.addEventListener('focus', () => { open(); });
  input.addEventListener('input', () => { render(input.value); dropdown.classList.add('open'); });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { close(); input.blur(); return; }
    if (e.key === 'ArrowDown') { e.preventDefault(); highlightIdx = Math.min(highlightIdx + 1, filtered.length - 1); updateHighlight(); }
    if (e.key === 'ArrowUp') { e.preventDefault(); highlightIdx = Math.max(highlightIdx - 1, 0); updateHighlight(); }
    if (e.key === 'Enter') {
      e.preventDefault();
      if (highlightIdx >= 0 && highlightIdx < filtered.length) addSymbol(filtered[highlightIdx]);
      else if (filtered.length === 1) addSymbol(filtered[0]);
    }
  });
  dropdown.addEventListener('mousedown', (e) => {
    const opt = e.target.closest('.sym-option');
    if (opt) addSymbol(opt.dataset.symbol);
  });
  document.addEventListener('click', (e) => { if (!wrapper.contains(e.target)) close(); });

  function updateHighlight() {
    dropdown.querySelectorAll('.sym-option').forEach((el, i) => {
      el.classList.toggle('active', i === highlightIdx);
    });
    if (highlightIdx >= 0) {
      const el = dropdown.children[highlightIdx];
      if (el) el.scrollIntoView({ block: 'nearest' });
    }
  }

  function addSymbol(sym) {
    const parts = input.value.split(',').map(s => s.trim()).filter(Boolean);
    if (!parts.includes(sym)) {
      parts.push(sym);
      input.value = parts.join(', ');
    } else {
      // Already selected, just close
    }
    close();
    // Keep focus but don't select all
  }

  // Expose for loadAutoConfig to set value
  input._autoSetSymbols = (symbols) => {
    input.value = (symbols || []).join(', ');
  };
  // Prevent global symbol sync from overwriting multi-select value
  input._symSet = () => {};
  // Also push to _symSelectors so loadSymbols can update options
  _symSelectors.push('autoSymbolSelect');
}

async function saveAutoConfig() {
  const symbols = document.getElementById('autoSymbolSelect').value.split(',').map(s => s.trim()).filter(Boolean);
  const intervalMinutes = parseInt(document.getElementById('autoIntervalMin').value) || 5;
  const apiKey = document.getElementById('autoApiKey').value.trim();

  try {
    const payload = {
      symbols,
      interval_minutes: intervalMinutes,
      api_provider: document.getElementById('autoApiProvider').value,
      model_name: document.getElementById('autoModelName').value,
      api_base_url: document.getElementById('autoApiBaseUrl').value,
      temperature: parseFloat(document.getElementById('autoTemperature').value) || 0.3,
      max_tokens: parseInt(document.getElementById('autoMaxTokens').value) || 2000,
      risk_level: document.getElementById('autoRiskLevel').value,
      max_position_size: parseFloat(document.getElementById('autoMaxPositionSize').value) || 0.05,
      selected_take_profit: parseInt(document.getElementById('autoSelectedTakeProfit').value) || 2,
      system_prompt: document.getElementById('autoSystemPrompt').value || null,
    };
    if (apiKey) payload.api_key = apiKey;
    await wsApi('save_auto_config', payload);
    document.getElementById('autoApiKey').value = '';
    toast('自动推理配置已保存', 'success');
    await loadAutoConfig();
  } catch (e) { toast(e.message, 'error'); }
}

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
  };

  card.dataset.direction = dir;
  card.dataset.status = signal.is_executed ? "executed" : signal.is_stale ? "expired" : "live";
  card.style.setProperty("--signal-border", colorMap[dir].border);
  card.style.setProperty("--signal-glow", colorMap[dir].glow);
  setText("sigSymbol", signal.symbol || "--");
  setText("sigTimeframe", signal.timeframe || "--");
  setText("sigDirection", dir.toUpperCase());
  setText("sigDirectionText", directionText(dir));
  $("sigDirection").className = `signal-direction ${dir}`;
  $("sigDirectionText").className = `signal-direction-text ${dir}`;
  setText("sigConfidence", confidence.label);
  updateSignalPriceFields(signal);
  $("sigBar").style.width = `${confidence.value}%`;
  setText("sigTime", signalDisplayTime(signal));
  setText("sigGeneratedAt", signalDisplayTime(signal));
  setText("sigValidWindow", signalFreshness(signal));
  setText("lastSigDirection", directionText(dir));
  setText("lastSigTimeframe", signal.timeframe || "--");
  setText("lastSigConfidence", confidence.label);
  setText("lastSigTime", signalDisplayTime(signal));
  $("lastSigDirection").className = dir;

  const executable = dir !== "hold" && !signal.is_stale && !signal.is_executed;
  $("executeSignalBtn").disabled = !executable;
  $("executeSignalBtn").title = executable
    ? "复核后发送执行请求"
    : signal.is_stale ? "信号已过期，无法执行"
      : signal.is_executed ? "信号已执行"
        : "HOLD 观望信号不执行";
}

function signalFreshness(signal) {
  if (!signal) return "--";
  if (signal.is_stale) return "已过期";
  const age = Number(signal.age_seconds);
  const ttl = Number(signal.ttl_seconds);
  if (Number.isFinite(age) && Number.isFinite(ttl)) return `${Math.round(age)}s / ${ttl}s`;
  return signal.ttl_seconds ? `TTL ${signal.ttl_seconds}s` : "--";
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
  const market = signal.market_data || {};
  const positions = market.positions || {};
  const result = $("analysisResult");
  const freshnessClass = signal.is_stale ? "expired" : signal.is_executed ? "executed" : "live";
  const latestPrice = Number(market.latest_price);
  const sma20 = Number(market.sma_20);
  const smaDeviation = Number.isFinite(latestPrice) && Number.isFinite(sma20) ? signedText(latestPrice - sma20, 2) : "--";
  const atrValue = market.atr_14 ?? market.atr ?? market.avg_volatility;
  const analysisText = String(signal.analysis || "").trim();
  const reasoningText = String(signal.reasoning || "").trim();
  const reasoningBlock = reasoningText ? `\n\n<strong>推理依据</strong>\n${escapeHtml(reasoningText)}` : "";
  result.className = "analysis-result";
  result.innerHTML = `
    <div class="analysis-summary-head">
      <div class="analysis-summary-title">
        <span class="analysis-symbol">${escapeHtml(signal.symbol)}</span>
        <span class="signal-tf-badge">${escapeHtml(signal.timeframe)}</span>
        <span class="analysis-direction-badge ${dir}">${dir.toUpperCase()} ${directionText(dir)}</span>
      </div>
        <span class="analysis-time num">#${escapeHtml(signal.id)} · ${escapeHtml(signalDisplayTime(signal))}</span>
    </div>
    <div class="analysis-status-strip">
      <div><span>置信度</span><strong>${confidence.label}</strong></div>
      <div><span>建议手数</span><strong>${escapeHtml(volumeText(signal.recommended_volume))}</strong></div>
      <div><span>有效期</span><strong id="analysisValidity" class="status-tag ${freshnessClass}">${escapeHtml(signalFreshness(signal))}</strong></div>
      <div><span>执行状态</span><strong class="status-tag ${freshnessClass}">${escapeHtml(executionStatus(signal))}</strong></div>
    </div>
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
            <div><span>ATR / 平均波动 <em class="market-unit">USD</em></span><strong>${Number.isFinite(Number(atrValue)) ? fmt(atrValue, 2) : "--"}</strong></div>
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
      <div class="analysis-section-title"><i data-lucide="file-text" size="14"></i>推理正文</div>
    </div>
    <div id="analysisTextContent" class="analysis-text collapsed"><strong>行情判断</strong>
${escapeHtml(analysisText || "暂无行情判断")}${reasoningBlock}</div>
    <div class="analysis-expand-row">
      <button class="btn-expand-analysis" type="button" data-action="toggle-analysis-text">展开完整推理</button>
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

  // Check: non-admin without own config and model sharing is off
  const sharedInfo = $("modelSharedInfo");
  const isUsingShared = sharedInfo && sharedInfo.style.display !== "none";
  if (!state.currentConfigHasApiKey && !isUsingShared) {
    toast("请先在模型设置中配置 API Key，或联系管理员开启模型共享", "warning");
    return;
  }

  $("runAnalysisBtn").disabled = true;
  $("executeSignalBtn").disabled = true;
  $("analysisResult").className = "analysis-result muted-block";
  $("analysisResult").textContent = "正在合成行情与信号";
  setText("analysisLatency", "推理中");
  setText("signalFreshness", "等待结果");
  const started = performance.now();

  try {
    const results = await Promise.all(frames.map((timeframe) => wsApi("analyze", {
      session_id: "default",
      symbol,
      timeframe,
      kline_count: Number($("klineCount").value) || 100,
      include_positions: true,
    })));
    const best = results
      .map((item) => item.signal)
      .filter(Boolean)
      .sort((a, b) => Number(b.confidence) - Number(a.confidence))[0];
    if (!best) throw new Error("未返回有效信号");
    renderSignal(best, Math.round(performance.now() - started));
    await loadSignals({ skipResultRender: true });
    toast(`已生成 ${results.length} 个周期信号，已选最高置信度结果`, "success");
  } catch (error) {
    $("analysisResult").className = "analysis-result muted-block";
    $("analysisResult").textContent = error.message;
    setText("analysisLatency", "--");
    setText("signalFreshness", "--");
    toast(error.message, "error");
  } finally {
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
  const ok = window.confirm(`复核执行 AI 信号 #${state.selectedSignal.id}（${state.selectedSignal.symbol} ${dir}）？后台会重取报价并检查有效期。`);
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
  return {
    payload: {
      symbol,
      order_type: orderType,
      volume,
      take_profit_points: takeProfitPoints,
      stop_loss_points: stopLossPoints,
      confirm: true,
      source: "manual",
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
    },
  };
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
  body.innerHTML = `
    <div><span>品种</span><strong>${escapeHtml(meta.symbol)}</strong></div>
    <div><span>方向</span><strong class="${meta.orderType}">${escapeHtml(meta.sideLabel)}</strong></div>
    <div><span>预估入场价</span><strong>${priceDisplay(meta.entryPrice)}</strong></div>
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
    await Promise.allSettled([loadPositions(), loadAccount(), loadHistory(), loadAudit(), loadStatus()]);
  } catch (error) {
    toast(error.message, "error");
  } finally {
    if (submit) submit.disabled = false;
  }
}

async function closePosition(ticket) {
  if (!window.confirm(`复核平仓 ticket ${ticket}？`)) return;
  try {
    const result = await wsApi("close", { ticket: Number(ticket), confirm: true });
    toast(result.message || `结果：${result.status}`, result.status === "success" ? "success" : "warning");
    await Promise.allSettled([loadPositions(), loadAccount(), loadHistory(), loadAudit(), loadStatus()]);
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

function renderAnalysisHistory(signals) {
  const host = $("analysisHistoryBody");
  if (!host) return;
  host.innerHTML = signals.length ? signals.slice(0, 12).map((signal) => {
    const dir = signalType(signal.signal_type);
    const confidence = confidenceInfo(signal.confidence).label;
    const status = signalStatusLabel(signal);
    return `
      <button class="analysis-history-item" data-analysis-id="${escapeHtml(signal.id)}">
        <span class="history-item-top">
          <span class="history-item-symbol">${escapeHtml(signal.symbol)} · ${escapeHtml(signal.timeframe)}</span>
          <span class="history-item-dir ${dir}">${dir.toUpperCase()} ${directionText(dir)}</span>
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
  }).join("") : `<div class="history-empty">暂无推理记录</div>`;
}

function highlightActiveAnalysis(signalId) {
  document.querySelectorAll("[data-analysis-id]").forEach((node) => {
    node.classList.toggle("active", String(node.dataset.analysisId) === String(signalId));
  });
}

function openAnalysisFromHistory(signalId) {
  const signal = state.signals.find((item) => String(item.id) === String(signalId));
  if (!signal) {
    toast("未找到对应推理记录，请刷新历史", "warning");
    return;
  }
  state.selectedSignal = signal;
  setTab("ai-analyze");
  renderSignal(signal, null);
}

function renderSignalRows() {
  const body = $("signalsBody");
  if (!body) return;
  const filters = state.signalFilters;
  const filtered = state.signals.filter((signal) => {
    const dir = signalType(signal.signal_type);
    const tf = String(signal.timeframe || "");
    return (!filters.direction || dir === filters.direction)
      && (!filters.timeframe || tf === filters.timeframe);
  });
  filters.page = clampPage(filters.page, filters.pageSize, filtered.length);
  const start = (filters.page - 1) * filters.pageSize;
  const pageRows = filtered.slice(start, start + filters.pageSize);
  setText("signalCount", `显示 ${filtered.length} / ${state.signals.length} 条`);
  body.innerHTML = pageRows.length ? pageRows.map((signal) => {
    const dir = signalType(signal.signal_type);
    const confidence = confidenceInfo(signal.confidence);
    const rowStatus = signal.is_executed ? "executed" : signal.is_stale ? "expired" : "live";
    return `
      <tr data-analysis-id="${escapeHtml(signal.id)}">
        <td class="num">${escapeHtml(signal.id)}</td>
        <td>${compactTimeHtml(signal?.created_at_mt5 || signal?.created_at)}</td>
        <td>${escapeHtml(signal.symbol)}</td>
        <td><span class="signal-tf-badge">${escapeHtml(signal.timeframe)}</span></td>
        <td><span class="tag ${dir}">${dir.toUpperCase()} ${directionText(dir)}</span></td>
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
  }).join("") : `<tr class="empty-row"><td colspan="11">当前筛选下暂无信号</td></tr>`;
  renderPager("signalPager", filters.page, filters.pageSize, filtered.length, "signals");
  highlightActiveAnalysis(state.selectedSignal?.id);
  initIcons();
}

async function loadSignals(options = {}) {
  const data = await wsApi("signals", { session_id: "default" });
  const signals = data.signals || [];
  state.signals = signals;

  // Preserve selected signal if it still exists, otherwise use latest
  const selectedId = state.selectedSignal?.id;
  const stillExists = selectedId ? signals.find(s => String(s.id) === String(selectedId)) : null;
  const activeSignal = stillExists || signals[0] || null;

  state.selectedSignal = activeSignal;
  updateSignalDisplay(activeSignal);
  if (activeSignal) setText("signalFreshness", signalFreshness(activeSignal));
  renderAnalysisHistory(signals);
  if (!options.skipResultRender) {
    renderSignal(activeSignal, null);
  }

  renderSignalRows();
}

function setHistoryZeroClass(id, value) {
  const el = $(id);
  if (!el?.parentElement) return;
  const num = Number(value);
  el.parentElement.classList.toggle("zero-value", Number.isFinite(num) && num === 0);
}

async function loadHistory() {
  try {
  const [data] = await Promise.all([
    wsApi("history", { page: 1, page_size: 20 }),
    loadSignalTickets(),
  ]);
  const stats = data.statistics || {};
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
  $("historyBody").innerHTML = rows.length ? rows.map((row) => {
    const dir = signalType(row.type);
    const comment = row.comment || "";
    const ticket = row.order || row.ticket;
    return `
    <tr>
      ${ticketCell(ticket, tickets)}
      <td>${escapeHtml(row.symbol)}</td>
      <td><span class="tag ${dir}">${String(row.type || dir).toUpperCase()} ${directionText(dir)}</span></td>
      <td class="num">${escapeHtml(volumeText(row.volume))}</td>
      <td class="num">${escapeHtml(raw(row.entry_price))}</td>
      <td class="num">${escapeHtml(raw(row.exit_price ?? row.price))}</td>
      <td class="num ${profitClass(row.profit_points)}">${escapeHtml(row.profit_points ?? "--")}</td>
      <td class="${profitClass(row.profit)}">${fmt(row.profit)}</td>
      <td class="num">${escapeHtml(formatTime(row.entry_time))}</td>
      <td class="num">${escapeHtml(formatTime(row.close_time || row.time))}</td>
      <td class="comment-cell"><span class="comment-ellipsis" title="${escapeHtml(comment || "--")}">${escapeHtml(comment || "--")}</span></td>
    </tr>
  `;
  }).join("") : `<tr class="empty-row"><td colspan="11">暂无成交记录</td></tr>`;
  } catch (e) { console.error("loadHistory:", e); }
}

async function refreshTradingPage() {
  await Promise.allSettled([loadStatus(), loadAccount(), refreshQuote(), loadPositions(), loadAudit()]);
}

async function refreshHistoryPage() {
  await Promise.allSettled([loadAccount(), loadHistory(), loadAudit()]);
}

function auditActionLabel(action) {
  return {
    manual_open: "手动开仓",
    manual_close: "手动平仓",
    ai_execute: "AI 信号执行",
    ai_auto_execute: "AI 自动执行",
    ai_auto_scan: "AI 自动扫描",
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
  return String(action || "").startsWith("ai_") ? "ai" : "manual";
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
  $("refreshAllBtn").addEventListener("click", refreshAll);
  $("gatewayMode")?.addEventListener("click", handleGatewayModeClick);
  $("saveConfigBtn").addEventListener("click", saveConfig);
  $("useTemplateBtn")?.addEventListener("click", async () => {
    try {
      const data = await wsApi("get_default_prompt");
      if (data.status === "success" && data.prompt) {
        $("systemPrompt").value = data.prompt;
        toast("已填入管理员模板", "success");
      } else {
        toast("暂无可用模板", "warning");
      }
    } catch (e) {
      toast("获取模板失败", "error");
    }
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
  // Symbol change is handled by searchable selector + setGlobalSymbol
  $("signalFilterDirection")?.addEventListener("change", (event) => {
    state.signalFilters.direction = event.target.value;
    state.signalFilters.page = 1;
    renderSignalRows();
  });
  $("signalFilterTimeframe")?.addEventListener("change", (event) => {
    state.signalFilters.timeframe = event.target.value;
    state.signalFilters.page = 1;
    renderSignalRows();
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

  // Config sub-tabs
  initConfigSubTabs();
  initAutoSymbolsSelector();
  $("saveAutoConfigBtn")?.addEventListener("click", saveAutoConfig);
  $("autoApiProvider")?.addEventListener("change", (e) => applyAutoProviderPreset(e.target.value));

  // Timeframe checkbox change → update confirm text
  // (removed old modal handlers)

  document.querySelectorAll(".nav-item").forEach((button) => {
    button.addEventListener("click", () => setTab(button.dataset.tab));
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
        renderSignalRows();
      } else if (pagerButton.dataset.pager === "audit") {
        state.auditFilters.page = page;
        renderAuditRows();
      }
      return;
    }

    if (actionButton) {
      const action = actionButton.dataset.action;
      if (action === "toggle-analysis-text") {
        const text = $("analysisTextContent");
        const expanded = text?.classList.toggle("collapsed") === false;
        actionButton.textContent = expanded ? "收起推理正文" : "展开完整推理";
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
}

document.addEventListener("DOMContentLoaded", () => {
  bindEvents();
  updateSignalDisplay(null);
  initIcons();
  initBridgeModal();
  if (state.token) bootstrap();
  else showApp(false);
});
