const state = {
  token: new URLSearchParams(window.location.search).get("token") || localStorage.getItem("authToken") || "",
  user: null,
  symbols: [],
  signals: [],
  selectedSignal: null,
  quoteTimer: null,
  liveSyncTimer: null,
  backgroundSyncTimer: null,
  liveSyncInFlight: false,
  backgroundSyncInFlight: false,
  lastQuote: null,
  currentConfigHasApiKey: false,
  pendingManualOrder: null,
  auditRows: [],
  signalFilters: { direction: "", timeframe: "", page: 1, pageSize: 20 },
  auditFilters: { status: "", type: "", page: 1, pageSize: 25 },
};

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

function auditDisplayTime(row) {
  return formatTime(row?.created_at_mt5 || row?.created_at);
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

function directionTextShort(value) {
  return { buy: "多", sell: "空", hold: "观望" }[signalType(value)] || "观望";
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

function signedClass(value) {
  const num = Number(value);
  if (num > 0) return "pnl-positive";
  if (num < 0) return "pnl-negative";
  return "pnl zero";
}

function confidenceClass(value) {
  const pct = confidenceInfo(value).value;
  if (pct >= 70) return "conf-high";
  if (pct < 50) return "conf-low";
  return "conf-mid";
}

function setSignedValue(id, value, digits = 2, suffix = "") {
  const el = $(id);
  if (!el) return;
  el.textContent = signedText(value, digits, suffix);
  el.className = `num ${signedClass(value)}`;
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
  el.className = `status-badge status-${type}`;
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
  const response = await fetch(path, { ...options, headers });
  const text = await response.text();
  let data = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { detail: text };
  }
  if (!response.ok) {
    throw new Error(data.detail || data.message || `HTTP ${response.status}`);
  }
  return data;
}

function setAuth(token) {
  state.token = token;
  if (token) localStorage.setItem("authToken", token);
  else localStorage.removeItem("authToken");
}

function showApp(show) {
  $("loginView").classList.toggle("hidden", show);
  $("appView").classList.toggle("hidden", !show);
  initIcons();
}

function activeTabId() {
  return document.querySelector(".tab-panel.active")?.id || "dashboard";
}

function stopRealtimeSync() {
  if (state.quoteTimer) clearInterval(state.quoteTimer);
  if (state.liveSyncTimer) clearInterval(state.liveSyncTimer);
  if (state.backgroundSyncTimer) clearInterval(state.backgroundSyncTimer);
  state.quoteTimer = null;
  state.liveSyncTimer = null;
  state.backgroundSyncTimer = null;
  state.liveSyncInFlight = false;
  state.backgroundSyncInFlight = false;
}

function startRealtimeSync() {
  stopRealtimeSync();
  state.quoteTimer = setInterval(() => {
    refreshQuote().catch(() => {});
  }, 5000);
  state.liveSyncTimer = setInterval(() => {
    syncLiveMt5State().catch(() => {});
  }, 5000);
  state.backgroundSyncTimer = setInterval(() => {
    syncBackgroundState().catch(() => {});
  }, 30000);
}

async function syncLiveMt5State() {
  if (!state.token || state.liveSyncInFlight) return;
  state.liveSyncInFlight = true;
  try {
    const tasks = [loadStatus(), loadAccount(), loadPositions()];
    if (activeTabId() === "history") tasks.push(loadHistory());
    await Promise.allSettled(tasks);
  } finally {
    state.liveSyncInFlight = false;
  }
}

async function syncBackgroundState() {
  if (!state.token || state.backgroundSyncInFlight) return;
  state.backgroundSyncInFlight = true;
  try {
    const tab = activeTabId();
    const tasks = [loadSignals()];
    if (tab === "history") tasks.push(loadHistory());
    if (tab === "audit" || tab === "trading" || tab === "dashboard") tasks.push(loadAudit());
    await Promise.allSettled(tasks);
  } finally {
    state.backgroundSyncInFlight = false;
  }
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
    await Promise.allSettled([loadAccount(), loadPositions(), refreshQuote(), loadStatus()]);
  } else if (tabId === "history") {
    await Promise.allSettled([loadAccount(), loadHistory()]);
  } else if (tabId === "audit") {
    await loadAudit();
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
    showApp(true);
    await refreshAll();
    startRealtimeSync();
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
  const health = await api("/health");
  const gateway = health.gateway || {};
  const isLive = gateway.mode === "live";
  setBadge("gatewayMode", isLive ? "MT5 直连" : "模拟数据", isLive ? "connected" : "neutral");
  
  // Update MT5 connect button
  const connectBtn = document.getElementById("mt5ConnectBtn");
  const connectText = document.getElementById("mt5ConnectText");
  if (connectBtn && connectText) {
    if (isLive) {
      connectBtn.classList.add("connected");
      connectBtn.classList.remove("connecting");
      connectText.textContent = "MT5已连接";
      connectBtn.title = "点击断开MT5";
    } else {
      connectBtn.classList.remove("connected", "connecting");
      connectText.textContent = "未连接MT5";
      connectBtn.title = "点击连接MT5";
    }
  }
  
  const mt5TradeBlocked = isLive
    && gateway.live_trading_enabled
    && (gateway.terminal_trade_allowed === false || gateway.account_trade_allowed === false || gateway.account_trade_expert === false);
  const tradeText = mt5TradeBlocked
    ? "MT5 自动交易关闭"
    : gateway.live_trading_enabled ? "交易发送开启" : "交易发送关闭";
  setBadge("tradeMode", tradeText, gateway.live_trading_enabled && !mt5TradeBlocked ? "danger" : "neutral");
  try {
    const auto = await api("/api/auto/status");
    const scheduler = auto.scheduler || {};
    const interval = Number(scheduler.interval_seconds || 0);
    const intervalText = interval >= 60 && interval % 60 === 0 ? `${interval / 60}分钟` : `${interval || "--"}秒`;
    const label = scheduler.enabled
      ? scheduler.running ? "自动推理运行中" : `${intervalText}自动推理开启`
      : "自动推理关闭";
    const type = scheduler.enabled
      ? scheduler.status === "error" || scheduler.status === "partial_error" ? "warning" : "active"
      : "neutral";
    setBadge("autoAnalyzeMode", label, type);
  } catch {
    setBadge("autoAnalyzeMode", "自动推理状态未知", "warning");
  }
}

async function handleMT5Connect() {
  const connectBtn = document.getElementById("mt5ConnectBtn");
  const connectText = document.getElementById("mt5ConnectText");
  if (!connectBtn || !connectText) return;

  // Check if already connected
  const isCurrentlyConnected = connectBtn.classList.contains("connected");

  if (isCurrentlyConnected) {
    // Show disconnect confirmation
    const confirmed = confirm("MT5已连接，是否断开连接？");
    if (!confirmed) return;

    connectBtn.classList.add("connecting");
    connectText.textContent = "断开中...";
    try {
      await api("/aurum-api/mt5/disconnect", { method: "POST" });
      await loadStatus();
      await Promise.allSettled([loadAccount(), loadPositions()]);
    } catch (error) {
      alert("断开失败: " + error.message);
    } finally {
      connectBtn.classList.remove("connecting");
    }
  } else {
    // Connect to MT5
    connectBtn.classList.add("connecting");
    connectText.textContent = "连接中...";
    try {
      const result = await api("/aurum-api/mt5/connect", { method: "POST" });
      if (result.status === "success") {
        await loadStatus();
        await Promise.allSettled([loadAccount(), loadPositions(), loadSymbols()]);
      } else {
        alert("连接失败: " + (result.message || "未知错误"));
      }
    } catch (error) {
      alert("连接失败: " + error.message);
    } finally {
      connectBtn.classList.remove("connecting");
    }
  }
}

async function loadSymbols() {
  const data = await api("/api/mt5/symbols");
  state.symbols = Array.isArray(data.symbols) && data.symbols.length
    ? data.symbols
    : [{ name: "XAUUSD", description: "Gold vs US Dollar" }];

  const preferred = state.symbols.find((symbol) => String(symbol.name).toUpperCase() === "XAUUSD")
    || state.symbols.find((symbol) => String(symbol.name).toUpperCase().startsWith("XAUUSD"))
    || state.symbols.find((symbol) => String(symbol.name).toUpperCase().includes("XAU"))
    || state.symbols[0];

  for (const id of ["quoteSymbolSelect", "analyzeSymbol", "tradeSymbolSelect"]) {
    const select = $(id);
    if (!select) continue;
    const previous = select.value || preferred?.name || "XAUUSD";
    select.innerHTML = state.symbols.map((symbol) => {
      const name = raw(symbol.name);
      const description = symbol.description ? ` - ${symbol.description}` : "";
      return `<option value="${escapeHtml(name)}">${escapeHtml(name + description)}</option>`;
    }).join("");
    select.value = state.symbols.some((symbol) => symbol.name === previous)
      ? previous
      : preferred?.name || state.symbols[0]?.name || "";
  }

  await refreshQuote();
}

async function loadAccount() {
  const data = await api("/api/mt5/account");
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
  const data = await api(`/api/mt5/quote/${encodeURIComponent(symbol)}`);
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
  return positions.map((position) => {
    const type = String(position.type || "").toLowerCase();
    const directionLabel = type === "buy" ? "买入 多" : "卖出 空";
    const directionClass = type === "buy" ? "dir-buy" : "dir-sell";
    const digits = Number(position.digits);
    const priceDigits = Number.isFinite(digits) ? Math.min(Math.max(digits, 0), 6) : 2;
    return `
      <tr>
        <td class="num">${escapeHtml(position.ticket)}</td>
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

async function loadPositions() {
  const data = await api("/api/mt5/positions");
  const positions = data.positions || [];
  $("positionsBody").innerHTML = renderPositionRows(positions, true);
  $("dashboardPositionsBody").innerHTML = renderPositionRows(positions, false);
  $("positionsEmpty").classList.toggle("hidden", positions.length > 0);
  $("dashboardPositionsTable").classList.toggle("hidden", positions.length === 0);
  initIcons();
}

async function loadConfig() {
  const data = await api("/api/ai/config");
  const cfg = data.config;
  if (!cfg) {
    state.currentConfigHasApiKey = false;
    $("systemPrompt").value = "You are a disciplined trading analyst. Return strict JSON.";
    $("apiKey").placeholder = "输入 API Key 后保存";
    setText("configStatus", "未配置 API Key，系统将使用本地规则兜底");
    return;
  }

  state.currentConfigHasApiKey = Boolean(cfg.has_api_key);
  if (![...$("apiProvider").options].some((option) => option.value === cfg.api_provider)) {
    $("apiProvider").add(new Option(cfg.api_provider, cfg.api_provider));
  }
  $("apiProvider").value = cfg.api_provider || "deepseek";
  $("modelName").value = cfg.model_name || "deepseek-chat";
  $("apiBaseUrl").value = cfg.api_base_url || "";
  $("temperature").value = cfg.temperature ?? 0.7;
  $("maxTokens").value = cfg.max_tokens ?? 2000;
  $("riskLevel").value = cfg.risk_level || "medium";
  const configuredMaxPosition = Number(cfg.max_position_size ?? 0.05);
  $("maxPositionSize").value = (Number.isFinite(configuredMaxPosition) ? Math.min(0.05, configuredMaxPosition) : 0.05).toFixed(2);
  $("selectedTakeProfit").value = String(cfg.selected_take_profit || 1);
  $("enableAutoTrade").checked = Boolean(cfg.enable_auto_trade);
  $("enableFuturesTrading").checked = Boolean(cfg.enable_futures_trading);
  $("systemPrompt").value = cfg.system_prompt || "";
  $("apiKey").value = "";
  $("apiKey").placeholder = state.currentConfigHasApiKey ? "已配置；如需保存配置请重新输入密钥" : "输入 API Key 后保存";
  const keyText = state.currentConfigHasApiKey ? `密钥已配置：${cfg.masked_api_key}` : "未配置 API Key，本地规则兜底可用";
  setText("configStatus", `${cfg.api_provider || "Provider"} · ${cfg.model_name || "model"} · ${keyText}`);
}

async function saveConfig() {
  const apiKey = $("apiKey").value.trim();
  if (!apiKey && state.currentConfigHasApiKey) {
    toast("为避免覆盖现有密钥，保存配置时请重新输入 API Key。", "warning");
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
      max_position_size: Math.min(0.05, Math.max(0.01, Number($("maxPositionSize").value) || 0.01)),
      selected_take_profit: Number($("selectedTakeProfit").value),
      system_prompt: $("systemPrompt").value || null,
    },
  };

  try {
    await api("/api/ai/config", { method: "POST", body: JSON.stringify(body) });
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
      <div><span>有效期</span><strong class="status-tag ${freshnessClass}">${escapeHtml(signalFreshness(signal))}</strong></div>
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

  $("runAnalysisBtn").disabled = true;
  $("executeSignalBtn").disabled = true;
  $("analysisResult").className = "analysis-result muted-block";
  $("analysisResult").textContent = "正在合成行情与信号";
  setText("analysisLatency", "推理中");
  setText("signalFreshness", "等待结果");
  const started = performance.now();

  try {
    const results = await Promise.all(frames.map((timeframe) => api("/api/ai/analyze", {
      method: "POST",
      body: JSON.stringify({
        session_id: "default",
        symbol,
        timeframe,
        kline_count: Number($("klineCount").value) || 100,
        include_positions: true,
        data_source: "mt5",
        language: "zh-CN",
      }),
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
    const result = await api("/api/ai/execute", {
      method: "POST",
      body: JSON.stringify({ session_id: "default", signal_id: state.selectedSignal.id, confirm: true }),
    });
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
    const result = await api("/api/mt5/open", { method: "POST", body: JSON.stringify(order.payload) });
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
    const result = await api("/api/mt5/close", { method: "POST", body: JSON.stringify({ ticket: Number(ticket), confirm: true }) });
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
  const data = await api("/api/ai/signals?session_id=default");
  const signals = data.signals || [];
  state.signals = signals;
  updateSignalDisplay(signals[0] || null);
  if (signals[0]) setText("signalFreshness", signalFreshness(signals[0]));
  renderAnalysisHistory(signals);
  if (!options.skipResultRender) {
    renderSignal(signals[0] || null, null);
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
  const data = await api("/api/mt5/history?page=1&page_size=20");
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
  $("historyBody").innerHTML = rows.length ? rows.map((row) => {
    const dir = signalType(row.type);
    const comment = row.comment || "";
    return `
    <tr>
      <td class="num">${escapeHtml(row.order || row.ticket)}</td>
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
  const data = await api("/api/audit/logs");
  state.auditRows = data.logs || [];
  renderAuditRows();
}

function bindEvents() {
  $("loginForm").addEventListener("submit", login);
  $("logoutBtn").addEventListener("click", logout);
  $("refreshAllBtn").addEventListener("click", refreshAll);
  $("mt5ConnectBtn")?.addEventListener("click", handleMT5Connect);
  $("saveConfigBtn").addEventListener("click", saveConfig);
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
  $("quoteSymbolSelect").addEventListener("change", refreshQuote);
  $("tradeSymbolSelect").addEventListener("change", () => {
    $("quoteSymbolSelect").value = $("tradeSymbolSelect").value;
    refreshQuote().catch((error) => toast(error.message, "error"));
  });
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
  if (state.token) bootstrap();
  else showApp(false);
});
