# 多模型推理对比功能设计

## [S1] Problem

当前系统一次推理只调用一个模型，无法对比不同模型对同一市场数据的判断差异。用户需要：
- **实时对比**：手动推理时，同一份市场数据同时发给多个模型，并排查看结果
- **历史对比**（管理员）：对同一段历史K线，多模型分别推理，对比信号差异和模拟盈亏

## [S2] Solution Overview

两个子功能：

| | 子功能 A | 子功能 B |
|---|---|---|
| 名称 | 手动推理多模型对比 | 历史数据多模型对比 |
| 触发位置 | 手动推理弹窗 | 独立页面（仅 admin） |
| 数据源 | 实时市场数据 | 指定时间段的历史K线 |
| 对比维度 | 信号差异（并排卡片） | 信号差异 + 模拟盈亏统计 |
| 新后端接口 | `POST /ai/analyze-compare` | `POST /ai/model-compare/history` |

## [S3] Sub-Feature A: Manual Inference Multi-Model Compare

### Frontend Changes

**弹窗 `manualInferenceModal`：**
- `#analyzeModelSelect` 从 `<select>` 改为多选组件（checkbox 列表）
- 默认勾选当前默认模型
- 上限 5 个模型
- 选 ≥ 2 个模型时，按钮文案变为"开始对比分析"

**WebSocket 传输：**
- 通过现有 `wsApi` 发送 `compare` action
- 超时 120s

**结果展示 `CompareResultsModal`：**
- CSS Grid 并排卡片（max 3 列/行）
- 每张卡片：模型名+提供商、信号方向+颜色、入场方式+价格、止损/止盈、置信度进度条、耗时
- 市场快照区域在卡片上方（共享部分）
- 信号方向不同时卡片边框高亮（红色=分歧）

### Backend

**新路由 `POST /ai/analyze-compare`**（`strategy.js` 或 `index.js`）：

```
Request: {
  strategy_id: string,
  symbol: string,
  model_ids: [id1, id2, ...],   // 2-5 个
  auto_execute: false            // 对比模式强制 false
}

Response: {
  ok: true,
  results: [
    { model_id, model_name, provider, signal: {...}, latency_ms, ok, error? },
    ...
  ],
  market_snapshot: { ... }
}
```

**核心流程：**
1. 校验 strategy_id、symbol、model_ids（2-5 个）
2. 一次 fetch 市场数据 + 构建 strategy_context（复用 `handleAnalyze` 逻辑）
3. 为每个 model_id 解析 profile、解密 API key
4. `Promise.allSettled()` 并行调用 N 个 `maybeAiSignal`
5. 不执行信号持久化（`withTransaction`）
6. 不执行自动交易（`auto_execute` 强制 false）
7. 返回结果数组 + 共享市场快照

**约束：**
- 对比模式下 `config.auto_execute = false`，无论前端传什么
- 对比模式下不记录 `auto_signal_deliveries`
- 每个模型独立计量用量（`beginModelUsage` / `finishModelUsage`）

## [S4] Sub-Feature B: Historical Data Multi-Model Compare (Admin Only)

### Access Control
- 仅 `admin` 角色可访问
- `GET /ai/model-compare` → 静态文件 `model-compare.html`
- API 接口加 `authMiddleware` + admin 角色校验

### Frontend Page `model-compare.html`

**控件：**
- 品种选择器（symbol dropdown）
- 时间范围选择器（起始/结束日期时间）
- 模型多选器（checkbox 列表，同子功能 A 组件）
- 跑批控制：开始/取消按钮
- 进度条

**结果展示：**
- 汇总表格（模型名、总交易数、胜率、净盈亏、夏普比率）
- 时间轴卡片——每个时间点一行，每个模型一个卡片

### Backend

**新路由 `POST /ai/model-compare/history`**：

```
Request: {
  symbol: string,
  start_time: string (ISO),
  end_time: string (ISO),
  model_ids: [id1, id2, ...],
  strategy_id?: string
}

Response: {
  ok: true,
  candle_count: number,
  results: [{
    model_id, model_name, provider,
    signals: [{ time, signal_type, entry_method, price, sl, tp, confidence }],
    simulated_pnl: {
      total_trades, win_count, loss_count, net_pnl, win_rate
    }
  }]
}
```

**核心流程：**
1. 校验 admin 权限
2. 从 `kline_data` 表获取指定时间段的K线
3. 遍历每个K线时间点（按策略周期间隔）：
   - 构建该时刻的 market_data（回放模式，只用截止到该时刻的数据）
   - 并行调用多个 `maybeAiSignal`
4. 收集所有信号
5. 计算模拟盈亏：
   - 信号发出时以 entry_price 开仓
   - 下一根K线收盘价平仓
   - 计算差值 × 标准手数

### Simulated P&L Calculation

```
for each signal in model.signals:
  open_price = signal.price
  close_price = next_candle_close(signal.time)
  pnl = (close_price - open_price) * lot_size * point_value
  if signal.signal_type == 'sell': pnl = -pnl
  record trade
```

标准手数用系统默认（`user_bridge_settings` 中的默认手数），或前端传入。

## [S5] Database Changes

无表结构变更。

- 对比结果不持久化到 `ai_signals` 表
- 历史K线从 `kline_data` 表读取（已有）
- 历史对比回放不写入新表（纯计算展示）

## [S6] Shared Frontend Components

| 组件 | 文件 | 说明 |
|---|---|---|
| `CompareModelSelector` | `app.js` | 多选模型下拉框（checkbox 模式），复用于弹窗和独立页面 |
| `CompareResultCard` | `app.js` | 单个模型结果卡片 |
| `CompareResultsGrid` | `app.js` | 卡片网格容器 + 差异高亮 |
| `compare-results-modal` | `index.html` | 对比结果弹窗 HTML |
| `.compare-*` | `styles.css` | 对比相关样式 |

## [S7] Risk & Mitigation

| 风险 | 影响 | 缓解 |
|---|---|---|
| 并行请求过多模型消耗 API 配额 | 用户配额耗尽 | 上限 5 个模型；对比模式也计用量 |
| 历史回放跑大量K线点导致耗时过长 | 请求超时 | 前端进度条 + 后端分批返回 |
| 模型返回格式不一致 | 解析失败 | 每个模型独立 try/catch，失败显示 error |
| 历史数据不存在 | 空结果 | 返回 candle_count=0 + 提示 |
