# AI 自迭代优化设计方案

> 状态：待实施 | 创建：2026-07-11 | 等待用户覆盖线上版本后开始

## [S1] 背景与目标

当前 AI 推理系统每次推理都是"失忆"的——不知道过去信号的盈亏结果。目标是建立信号→盈亏的反馈闭环，让 AI 能根据历史表现自动优化推理策略。

**用户要求**：
- 严格审查回测验证
- 需要 Kill Switch 总开关，出问题时可即时关停
- 默认关闭，影子模式验证 7 天后再手动开启

## [S2] 现状分析

### 已有基础设施
| 组件 | 位置 | 作用 |
|------|------|------|
| ai_signals 表 | DB | 完整信号记录 + market_data_json |
| auto_signal_deliveries 表 | DB | 每用户执行跟踪 |
| trade_audit_logs 表 | DB | 操作审计 |
| reconcilePendingOrders() | scheduler.js:1057 | 挂单状态对账 |
| runSmartClose() | scheduler.js:1252 | AI 智能平仓 |
| normalizeAiSignal() | llm.js:145 | 静态置信度校准 |

### 缺失的关键能力
1. **持仓平仓检测**：市价单成交后，TP/SL/手动平仓时系统完全不知道
2. **信号→盈亏闭环**：没有 signal_outcomes 表，无法追踪信号效果
3. **性能统计**：无法计算按品种/策略的胜率/盈亏比
4. **自适应调整**：normalizeAiSignal 权重是静态的

## [S3] 架构设计

```
┌──────────────────────────────────────────────────────────┐
│  Layer 6: Kill Switch                                    │
│  global_auto_config.self_learning_enabled (DEFAULT 0)    │
│  硬中断: 20笔胜率<30% / 连亏5笔 / LLM错误率>50%         │
├──────────────────────────────────────────────────────────┤
│  Layer 5: Adaptive Calibration                           │
│  getAdaptiveWeights(userId, symbol)                      │
│  动态调整: rawWeight/dataWeight/minConfidence/volumeScale │
│  normalizeAiSignal 权重归一化（w1+w2=1.0）               │
├──────────────────────────────────────────────────────────┤
│  Layer 4: Learning Injection                             │
│  buildLearningContext() → 按表现分层注入                  │
│  ≥55%完整breakdown(≤300t) / 35-55%简化(≤150t) / <35%压缩(≤80t) │
├──────────────────────────────────────────────────────────┤
│  Layer 3: Performance Aggregation                        │
│  computePerformanceStats(userId, symbol, lookback=20)    │
│  Redis缓存5分钟                                          │
├──────────────────────────────────────────────────────────┤
│  Layer 2: Position Outcome Monitor                       │
│  每5分钟扫描MT5 history → 发现平仓 → 写signal_outcomes   │
│  覆盖: TP/SL/手动/智能平仓 全部平仓方式                    │
├──────────────────────────────────────────────────────────┤
│  Layer 1: Signal Outcome Tracking                        │
│  signal_outcomes 表 + 写入触发点:                         │
│  - executeDelivery 成功时(记录入场)                       │
│  - reconcilePendingOrders 状态变更时                     │
│  - PositionOutcomeMonitor 检测到平仓时(记录出场+盈亏)    │
└──────────────────────────────────────────────────────────┘
```

## [S4] 数据库设计

### signal_outcomes 表
```sql
CREATE TABLE signal_outcomes (
  id INT AUTO_INCREMENT PRIMARY KEY,
  signal_id INT NOT NULL,           -- → ai_signals.id
  user_id INT NOT NULL,             -- 执行用户（自动推理信号 user_id=0 但执行是 per-user）
  symbol VARCHAR(20),
  signal_type VARCHAR(20),          -- buy/sell/buy_limit 等
  confidence DECIMAL(4,2),          -- 信号原始置信度
  entry_price DECIMAL(16,6),        -- 实际入场价
  exit_price DECIMAL(16,6),         -- 实际出场价（NULL=持仓中）
  pnl DECIMAL(16,2),               -- 盈亏金额
  pnl_pct DECIMAL(8,4),            -- 盈亏百分比
  holding_minutes INT,              -- 持仓时长
  hit_tp BOOLEAN DEFAULT FALSE,     -- 是否触达止盈
  hit_sl BOOLEAN DEFAULT FALSE,     -- 是否触达止损
  close_reason VARCHAR(30),         -- tp/sl/manual/smart_close/expired
  trade_ticket VARCHAR(32),         -- MT5 持仓 ticket
  market_snapshot JSON,             -- 入场时市场快照（用于回测）
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  closed_at DATETIME,               -- 平仓时间（NULL=持仓中）
  INDEX idx_signal (signal_id),
  INDEX idx_user_symbol (user_id, symbol, created_at),
  INDEX idx_trade_ticket (trade_ticket),
  INDEX idx_unclosed (closed_at, created_at)
)
```

### learning_experiments 表（影子模式）
```sql
CREATE TABLE learning_experiments (
  id INT AUTO_INCREMENT PRIMARY KEY,
  signal_id INT NOT NULL,
  baseline_type VARCHAR(20),        -- 原版信号类型
  baseline_confidence DECIMAL(4,2),
  optimized_type VARCHAR(20),       -- 自迭代版信号类型
  optimized_confidence DECIMAL(4,2),
  context_summary TEXT,             -- 注入的学习 context 摘要
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_signal (signal_id),
  INDEX idx_created (created_at)
)
```

### global_auto_config 新增字段
```sql
ALTER TABLE global_auto_config ADD COLUMN self_learning_enabled TINYINT NOT NULL DEFAULT 0;
```

## [S5] PositionOutcomeMonitor（关键新增）

每 5 分钟定时器，检测持仓平仓结果：

```
1. 查 signal_outcomes WHERE closed_at IS NULL（已入场未平仓记录）
2. 按 user_id 分组
3. 对每个活跃用户:
   a. mt5Bridge(userId, 'history', { from, to }) 获取近期平仓记录
   b. 用 trade_ticket 匹配 → 获取 exit_price, pnl, close_reason
   c. UPDATE signal_outcomes SET exit_price, pnl, pnl_pct, closed_at, close_reason
4. 对于 close_signal_tickets 中的记录:
   直接用 close_price 和入场价计算盈亏
```

**触发点**：
- 每 5 分钟全局扫描一次
- 仅扫描有未平仓记录的用户（避免无意义调用）
- 桥接离线时跳过该用户

## [S6] 性能聚合

`computePerformanceStats(userId, symbol, lookback=20)`：

```js
{
  total_signals: 20,
  win_count: 12,
  win_rate: 0.60,
  avg_pnl_pct: 1.25,
  avg_win_pnl_pct: 3.10,
  avg_loss_pnl_pct: -1.80,
  profit_factor: 1.72,
  avg_holding_minutes: 145,
  confidence_calibration: {
    "0.50-0.60": { count: 8, win_rate: 0.38 },
    "0.60-0.70": { count: 7, win_rate: 0.57 },
    "0.70+":     { count: 5, win_rate: 0.80 },
  },
  recent_5_pnl: [2.1, -1.3, 0.8, -0.5, 3.2],
  signal_type_breakdown: {
    buy: { count: 10, win_rate: 0.70 },
    sell_limit: { count: 5, win_rate: 0.40 },
  }
}
```

Redis 缓存 5 分钟，key = `perf:{userId}:{symbol}`。

## [S7] 学习注入

`buildLearningContext(userId, symbol, promptTypeId)` 将性能统计转为自然语言。

### 条件注入（按表现分层）

| 表现区间 | 注入内容 | Token 预算 |
|---------|---------|-----------|
| ≥55% 胜率（好） | 完整 breakdown：5 品种详情 + 信号类型统计 + 置信度校准 | ≤300 |
| 35%-55%（一般） | 简化版：总胜率 + 最佳/最差品种 | ≤150 |
| <35%（差） | 压缩警告：一句话 + 品种列表 | ≤80 |

**差表现注入示例**：
```
=== 历史表现警告 ===
最近20笔信号胜率仅25%，盈亏比0.6。建议极度谨慎，优先观察。
品种: XAUUSD(15%), EURUSD(30%), GBPUSD(28%)
```

**原因**：差表现时注入详细 breakdown 不仅浪费 token，还会锚定 LLM 偏向历史模式（可能本身就是错的）。压缩为一句话更有效。

### 注入位置

`maybeAiSignal()` 中构建 messages 之前，追加到 system_prompt 末尾。

### 最小数据要求

不足 5 笔时不注入（避免小样本误导）。

## [S8] 自适应校准

`getAdaptiveWeights(userId, symbol)` 基于历史表现动态调整：

| 参数 | 默认值 | 调整逻辑 |
|------|--------|---------|
| rawConfidence 权重 | 0.85 | 胜率>65%→保持，<45%→降到0.70 |
| dataConfidence 权重 | 0.15 | 胜率<45%→升到0.30 |
| minConfidence 阈值 | 0.40/0.60/0.25 | 连续3笔亏损→临时+0.10 |
| volumeMultiplier | 1.0 | 连续亏损→降到0.5，连续盈利→最多1.2 |

权重变化幅度有上下限（防止极端调整）。

### 权重归一化（必须）

`normalizeAiSignal()` 当前硬编码 `0.85 + 0.15 = 1.0`。自适应权重总和可能不等于 1.0（如 `0.70 + 0.25 = 0.95`），导致校准值整体偏移。

**修复方案**：`normalizeAiSignal(parsed, config, market, adaptiveWeights)` 新增可选第 4 参数。内部归一化：

```js
// adaptiveWeights = { raw: 0.70, data: 0.25 }
const total = adaptiveWeights.raw + adaptiveWeights.data
const w1 = adaptiveWeights.raw / total    // 0.70 / 0.95 = 0.737
const w2 = adaptiveWeights.data / total   // 0.25 / 0.95 = 0.263
calibrated = rawConfidence * w1 + dataConfidence * w2
```

`getAdaptiveWeights()` 返回 `{ raw, data }` 归一化前的原始值，由 `normalizeAiSignal` 内部归一化。无历史数据时返回 `null`，走硬编码默认值。

### pending_valid_until 存储格式

`pending_valid_until` 存储为北京时间字符串（`YYYY-MM-DD HH:mm:ss`），无时区标识。`buildBridgeOrderCall` 解析时追加 `'Z'` 后缀视为 UTC。

**注意**：Layer 5 生成 pending_valid_until 时必须遵循同一格式：`new Date(Date.now() + validMinutes * 60000 + 10800)` 转为北京时间字符串（+8h），不加时区后缀。与 `normalizeAiSignal:184` 现有逻辑一致。

## [S9] Kill Switch

### 数据库
`global_auto_config.self_learning_enabled TINYINT DEFAULT 0`

### 前端位置
Admin 面板 → 自动推理配置 → 全局模型/API 配置区域 → "最大输出"下方

```html
<label class="check-row">
  <input id="selfLearningEnabled" type="checkbox" />
  <span>AI 自迭代优化</span>
  <span class="hint">开启后 AI 根据历史信号表现自动调整推理策略</span>
</label>
```

仅 admin 可见（在 `.admin-only-auto-config` 容器内）。

### 硬中断保护（自动关闭）

**最小样本要求**：所有硬中断条件需至少 20 笔交易才生效。低于 20 笔时仅记录日志，不触发自动关闭（避免小样本随机波动误杀好策略）。

| 条件 | 动作 |
|------|------|
| 最近 20 笔胜率 < 30%（且样本 ≥20） | 自动关闭 + 通知管理员 |
| 连续 5 笔亏损（且样本 ≥10） | 自动关闭 + 通知管理员 |
| LLM 错误率 > 50%（最近 10 次调用） | 自动关闭 + 通知管理员 |

## [S10] 回测引擎（本地统计）

`runBacktest(symbol, lookbackDays)` 纯本地计算，不消耗 API tokens：

1. 拉取历史 ai_signals（含 market_data_json）
2. 对每条信号，用当时的历史统计重新计算自适应权重
3. 对比原版置信度 vs 自适应校准后置信度
4. 统计"如果用自适应权重，执行/不执行的信号会有何不同"
5. 输出对比报告

## [S11] 影子模式

开关打开后先运行 7 天影子模式：
- 每次推理同时记录原版信号和自迭代版信号
- 两份都存 learning_experiments，但**只有原版执行**
- 7 天后管理员可查看对比报告
- 确认有效后手动切换到执行模式

## [S12] 实施步骤

| 步骤 | 内容 | 天数 | 难度 |
|------|------|------|------|
| 1 | DB 迁移：signal_outcomes + learning_experiments + self_learning_enabled | 0.5 | ★☆☆ |
| 2 | 入场记录：executeDelivery 成功时写 signal_outcomes | 0.5 | ★☆☆ |
| 3 | PositionOutcomeMonitor：定时扫描 MT5 history 匹配平仓结果 | 2 | ★★★ |
| 4 | reconcilePendingOrders 集成 | 0.5 | ★★☆ |
| 5 | 性能聚合 computePerformanceStats + Redis 缓存 | 1 | ★★☆ |
| 6 | 学习注入 buildLearningContext + maybeAiSignal 集成 | 1 | ★★☆ |
| 7 | 自适应校准 getAdaptiveWeights + normalizeAiSignal 集成 | 2 | ★★★ |
| 8 | Kill Switch + 硬中断保护 + Admin UI | 1 | ★★☆ |
| 9 | 统计回测引擎 | 1 | ★★☆ |
| 10 | 影子模式 + learning_experiments + 测试 | 1.5 | ★★☆ |
| **合计** | | **~11 天** | |

## [S13] 风险与应对

| 风险 | 应对 |
|------|------|
| 小样本偏差 | 最低 5 笔才注入，<20 笔标注"样本不足" |
| LLM 被过度约束 | 注入强度上限 30%，保留 LLM 自主判断空间 |
| 连续亏损雪崩 | 硬中断 5 连亏自动关闭 |
| Token 成本增加 | 每次推理多 ~200 tokens，月增 $2-3 |
| MT5 history API 限制 | 桥接离线时跳过，下次补齐 |
