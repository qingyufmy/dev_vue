# 缠论 + 挂单 完整实施方案

## 执行顺序

```
① 缠论结构计算（纯计算模块）
   ↓
② normalizeAiSignal 扩展（解析 entry_method/limit_price）
   ↓
③ 挂单能力（DB + 执行 + 生命周期）
   ↓
④ 前端挂单 UI
```

---

## 模块 1：缠论结构计算

### 新增文件

`server/routes/ai/chan.js` — 6 个纯函数 + 1 个组装函数

| 函数 | 输入 | 输出 |
|------|------|------|
| detectFractals(rates) | K线数组 | [{idx, type:'top'\|'bottom', price}] |
| buildBis(fractals, rates) | 分型+K线 | [{id, dir, start_idx, start_price, end_idx, end_price}] |
| buildSegments(bis) | 笔数组 | [{id, dir, start_price, end_price, bi_ids, broken, weak}] |
| buildCenters(bis, timeframe) | 笔数组+周期 | [{id, zl, zh, level, bi_ids, status}] |
| detectDivergence(segments, macdHist) | 线段+MACD | {type, strength, area_cur, area_prev, peak_cur, peak_prev} |
| computeChan(rates, timeframe, macdHistory) | 组装 | 完整chan摘要 |

### 修改文件

- `server/routes/ai/market-data.js`：calculateMarketData 末尾调用 computeChan，挂到 market.chan
- `server/routes/ai/strategy.js`：buildStrategyContextFromTags 确保每个周期 summary 含 chan

### 上次审查问题处理

| 问题 | 方案 |
|------|------|
| Token膨胀（4周期+800-1200 tokens） | 主判周期输出完整chan，其他周期只输出 {status, price_vs_center, divergence} |
| 非严格笔可能过多 | KLINE_PER_BI=3起步，上线后观察，必要时调到4 |
| MACD长度不足 | detectDivergence开头检查长度<20时返回 {type:'none'} |
| 中枢重叠判定模糊 | 用 Math.max(ZL, biLo) < Math.min(ZH, biHi) |
| 线段破坏"上一个确认的底"定义模糊 | 明确为"段内上一个反向笔的 end_price" |
| 三类买卖点需要历史线段 | chan 增加 recent_segments 数组（最近3个线段） |

### 输出 schema（主判周期）

```json
{
  "chan": {
    "status": "ok",
    "current_bi": { "id": 12, "dir": "down", "start_price": 4080, "end_price": 4032 },
    "recent_bis": [ /* 最近5笔 */ ],
    "current_segment": { "id": 4, "dir": "down", "start_price": 4120, "end_price": 4032, "broken": false },
    "recent_segments": [
      { "id": 3, "dir": "up", "start_price": 4000, "end_price": 4120, "broken": true },
      { "id": 4, "dir": "down", "start_price": 4120, "end_price": 4032, "broken": false }
    ],
    "current_center": { "id": 2, "zl": 4035, "zh": 4068, "level": "1H", "status": "range" },
    "price_vs_center": "below",
    "divergence": { "type": "bottom", "strength": "weak" }
  }
}
```

### 输出 schema（非主判周期，精简）

```json
{
  "chan": {
    "status": "ok",
    "price_vs_center": "inside",
    "divergence": { "type": "none", "strength": "none" }
  }
}
```

---

## 模块 2：normalizeAiSignal 扩展

### 修改文件

- `server/routes/ai/llm.js`：normalizeAiSignal 新增字段解析
- `server/routes/ai/config.js`：signalOrderPayload 传递新字段
- `server/routes/ai/scheduler.js`：runUnifiedAutoCycle 写入新字段

### normalizeAiSignal 新增逻辑

```javascript
// 向后兼容：旧信号无这些字段时走 market 路径
parsed.entry_method = ['market', 'limit', 'observe'].includes(parsed.entry_method)
  ? parsed.entry_method : 'market'
parsed.limit_price = parsed.entry_method === 'limit'
  ? (parseFloat(parsed.limit_price) || null) : null
parsed.pending_valid_minutes = parseInt(parsed.pending_valid_minutes) || 240

// hold 强制 observe
if (parsed.signal_type === 'hold') {
  parsed.entry_method = 'observe'
  parsed.recommended_volume = 0
}

// limit 时 limit_price 缺失 → 降级为 market
if (parsed.entry_method === 'limit' && !parsed.limit_price) {
  parsed.entry_method = 'market'
}
```

### signalOrderPayload 新增字段

```javascript
return {
  // 现有字段不变
  symbol, order_type, volume, sl, tp, confirm, source, signal_type, signal_id, reference_price,
  // 新增
  entry_method: signal.entry_method || 'market',
  limit_price: signal.limit_price || null,
  pending_valid_minutes: signal.pending_valid_minutes || 240,
}
```

---

## 模块 3：挂单能力

### DB 迁移（server/migrations.js）

```sql
-- ai_signals 新增列（IF NOT EXISTS 检查）
ALTER TABLE ai_signals ADD COLUMN entry_method VARCHAR(8) DEFAULT 'market';
ALTER TABLE ai_signals ADD COLUMN limit_price FLOAT DEFAULT NULL;
ALTER TABLE ai_signals ADD COLUMN pending_valid_until DATETIME DEFAULT NULL;
ALTER TABLE ai_signals ADD COLUMN order_state VARCHAR(12) DEFAULT NULL;
ALTER TABLE ai_signals ADD COLUMN pending_ticket VARCHAR(32) DEFAULT NULL;

-- 新增 pending_orders 表
CREATE TABLE IF NOT EXISTS pending_orders (
  id INT AUTO_INCREMENT PRIMARY KEY,
  user_id INT NOT NULL,
  signal_id INT NOT NULL,
  symbol VARCHAR(20) NOT NULL,
  side VARCHAR(4) NOT NULL,
  pending_type VARCHAR(12) NOT NULL,
  price FLOAT NOT NULL,
  sl FLOAT DEFAULT NULL,
  tp FLOAT DEFAULT NULL,
  volume FLOAT NOT NULL,
  mt5_ticket VARCHAR(32) DEFAULT NULL,
  state VARCHAR(12) DEFAULT 'pending',
  valid_until DATETIME DEFAULT NULL,
  created_at DATETIME DEFAULT NULL,
  resolved_at DATETIME DEFAULT NULL,
  INDEX idx_state (state),
  INDEX idx_user_signal (user_id, signal_id)
);
```

### 挂单方向判定

```javascript
function determinePendingType(signalType, limitPrice, quote) {
  if (signalType === 'buy') {
    return limitPrice < quote.ask ? 'buy_limit' : 'buy_stop'
  } else {
    return limitPrice > quote.bid ? 'sell_limit' : 'sell_stop'
  }
}
```

### executeOrder 分流（修改 server/routes/ai/strategy.js）

```
observe → 不下单，order_state='cancelled'
market  → 现有市价路径不变
limit   → 1. 计算 pending_type
          2. 校验 limit_price 偏离度 (< 1%)
          3. 调 mt5Bridge('pending', {...}) 下挂单
          4. 写 pending_orders + 更新 ai_signals
```

### mt5Bridge 扩展（server/bridge-ws.js）

新增命令：
- `pending`：下挂单，参数 {symbol, order_type: buy_limit/sell_limit/buy_stop/sell_stop, price, sl, tp, expiration}
- `cancel_pending`：撤单，参数 {ticket}
- `pending_list`：查询未成交挂单，参数 {symbol}

### 挂单生命周期对账（新增 reconcilePendingOrders）

每 30 秒执行一次：
1. 查 pending 状态的 pending_orders
2. 对每个挂单：
   - MT5 已成交 → state='filled'，更新 ai_signals
   - 已过期且未成交 → 调 cancel_pending，state='expired'
   - MT5 中已不存在 → state='cancelled'
3. 同品种同方向新信号 → cancel 旧挂单，state='superseded'

### 配置常量

```javascript
const PENDING_VALID_MINUTES = 240     // 挂单默认有效期
const MAX_LIMIT_DEVIATION = 0.01      // 挂单价偏离上限 1%
const RECONCILE_INTERVAL_SEC = 30     // 对账频率
const ALLOW_STOP_ORDERS = true        // 是否允许 stop 类型
```

### DRY_RUN 模式

```javascript
const DRY_RUN = true  // 默认开启，只打印不真实挂单

if (DRY_RUN) {
  console.log('[DRY_RUN] Would place pending order:', { symbol, pending_type, price, sl, tp, expiration })
  return { status: 'dry_run', pending_type, price }
}
```

---

## 模块 4：前端挂单 UI

### 需要修改的文件

- `public/ai/app.js`
- `public/ai/index.html`
- `public/ai/styles.css`

### 4.1 信号列表增加挂单状态列

在 `renderSignalRows()` 的表格中新增列：

```javascript
// 现有列之后新增
<td>
  ${signal.entry_method === 'limit' 
    ? `<span class="tag limit">限价 ${signal.limit_price || '--'}</span>`
    : signal.entry_method === 'observe'
    ? `<span class="tag neutral">观望</span>`
    : `<span class="tag">市价</span>`
  }
</td>
<td>
  ${signal.order_state 
    ? `<span class="order-state ${signal.order_state}">${orderStateText(signal.order_state)}</span>`
    : '--'
  }
</td>
```

### 4.2 信号详情面板增加挂单信息

在 `renderSignal()` 中，当信号有挂单信息时显示：

```html
<div class="pending-order-info" id="pendingOrderInfo" style="display:none">
  <h4>挂单信息</h4>
  <div class="pending-detail-grid">
    <div class="pending-item">
      <span class="label">入场方式</span>
      <span class="value" id="pendingMethod">--</span>
    </div>
    <div class="pending-item">
      <span class="label">挂单价</span>
      <span class="value" id="pendingPrice">--</span>
    </div>
    <div class="pending-item">
      <span class="label">有效期至</span>
      <span class="value" id="pendingValidUntil">--</span>
    </div>
    <div class="pending-item">
      <span class="label">状态</span>
      <span class="value" id="pendingState">--</span>
    </div>
    <div class="pending-item">
      <span class="label">MT5 单号</span>
      <span class="value" id="pendingTicket">--</span>
    </div>
  </div>
  <button class="btn btn-danger btn-sm" id="cancelPendingBtn" style="display:none">撤销挂单</button>
</div>
```

### 4.3 手动执行按钮逻辑修改

`executeSignal()` 需要处理三种 entry_method：

```javascript
async function executeSignal() {
  const signal = state.selectedSignal
  if (!signal) return

  if (signal.entry_method === 'observe') {
    toast('该信号为观望，不执行下单', 'warning')
    return
  }

  if (signal.entry_method === 'limit') {
    // 限价单：确认挂单参数
    const ok = window.confirm(
      `确认挂限价单？\n品种: ${signal.symbol}\n方向: ${signal.signal_type}\n挂单价: ${signal.limit_price}\n有效期: ${signal.pending_valid_minutes || 240} 分钟`
    )
    if (!ok) return
  }

  // 原有市价执行逻辑...
}
```

### 4.4 新增挂单管理面板（可选，建议在持仓区域下方）

```html
<div class="pending-orders-panel" id="pendingOrdersPanel">
  <h4>活跃挂单</h4>
  <div class="pending-orders-list" id="pendingOrdersList">
    <!-- 动态渲染 -->
  </div>
</div>
```

数据来源：新增 API 或 WebSocket 命令 `pending_orders`，返回当前用户 state='pending' 的挂单列表。

### 4.5 CSS 样式补充

```css
.tag.limit { background: #e3f2fd; color: #1565c0; }
.tag.observe { background: #f3e5f5; color: #7b1fa2; }
.order-state { padding: 2px 8px; border-radius: 4px; font-size: 12px; }
.order-state.pending { background: #fff3e0; color: #e65100; }
.order-state.filled { background: #e8f5e9; color: #2e7d32; }
.order-state.expired { background: #fafafa; color: #9e9e9e; }
.order-state.cancelled { background: #fafafa; color: #9e9e9e; }
.order-state.superseded { background: #fce4ec; color: #c62828; }
.pending-order-info { margin-top: 16px; padding: 12px; background: var(--card-bg); border-radius: 8px; }
.pending-detail-grid { display: grid; grid-template-columns: repeat(2, 1fr); gap: 8px; margin: 8px 0; }
```

---

## 涉及文件清单

| 文件 | 改动类型 | 模块 |
|------|----------|------|
| server/routes/ai/chan.js | 新增 | ① |
| server/routes/ai/market-data.js | 修改 | ① |
| server/routes/ai/strategy.js | 修改 | ①③ |
| server/routes/ai/llm.js | 修改 | ② |
| server/routes/ai/config.js | 修改 | ② |
| server/routes/ai/scheduler.js | 修改 | ② |
| server/migrations.js | 修改 | ③ |
| server/bridge-ws.js | 修改 | ③ |
| server/index.js | 修改 | ③（启动对账定时器）|
| public/ai/app.js | 修改 | ④ |
| public/ai/index.html | 修改 | ④ |
| public/ai/styles.css | 修改 | ④ |

---

## 验证清单

1. chan 模块：用历史 K 线跑 computeChan，断言"中枢 ZL<ZH""笔顶底交替""线段≥3笔"
2. normalizeAiSignal：构造 market/limit/observe 三类信号，验证字段解析正确
3. 挂单方向：buy+limit_price<ask → BUY_LIMIT，sell+limit_price>bid → SELL_LIMIT
4. DRY_RUN：limit 路径只打印参数不真实提交
5. 前端：信号列表显示入场方式和挂单状态
6. 向后兼容：旧信号（无新字段）走 market 路径，行为不变
