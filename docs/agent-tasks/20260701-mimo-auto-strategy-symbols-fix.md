# Mimo Code 任务：自动推理策略品种选择 + 信号查询修复 + Redis 订阅态

## 背景

当前分支：`dev_codex`

当前代码已经实现了统一自动推理调度的基础版本，但仍有关键问题。请在当前工作区继续修复，不要回退用户或其它 Agent 的已有改动，不要合并 `main`。

完成后必须写结果文件：

```text
docs/agent-results/20260701-mimo-auto-strategy-symbols-fix-result.md
```

并提交到 `dev_codex`。如果当前本地分支已经 ahead 或存在未提交改动，请先用 `git status --short --branch` 记录状态，不要擅自 reset、checkout 或丢弃任何已有改动。

---

## 1. 修复信号列表和 latest 查询

### 1.1 `signals` 的 UNION ALL 必须修复

当前 `server/bridge-ws.js` 的 `signals` action 中，旧信号子查询和共享信号子查询列数不一致，会导致 MySQL 运行时报错。必须修复：

- `UNION ALL` 两边 SELECT 的列数、顺序、别名必须完全一致。
- 不要依赖第二个 SELECT 的特殊别名，因为 UNION 结果列名取第一个 SELECT。
- 建议两边都输出最终字段：
  - `id`
  - `user_id`
  - `config_id`
  - `prompt_type_id`
  - `session_id`
  - `source`
  - `symbol`
  - `timeframe`
  - `signal_type`
  - `confidence`
  - `recommended_volume`
  - `analysis`
  - `reasoning`
  - `stop_loss_price`
  - `take_profit_1_price`
  - `take_profit_2_price`
  - `take_profit_3_price`
  - `market_data_json`
  - `ai_model`
  - `ttl_seconds`
  - `is_executed`
  - `executed_at`
  - `trade_ticket`
  - `execution_result`
  - `created_at`
  - `delivery_id`
  - `execution_status`

旧信号的 `delivery_id`、`execution_status` 返回 `NULL`。

共享信号使用 delivery 表中的用户维度执行态覆盖：

```sql
d.is_executed AS is_executed
d.executed_at AS executed_at
d.trade_ticket AS trade_ticket
d.execution_result AS execution_result
d.id AS delivery_id
d.execution_status AS execution_status
```

分页要求：

- `COUNT(*)` 必须统计合并全集。
- `LIMIT/OFFSET` 必须作用在合并全集上。
- 排序使用 `created_at DESC, id DESC`，不要只按 id。

### 1.2 `signals_latest_id` 必须修复

当前共享信号 latest 查询没有完整按当前用户 delivery 查询，也没有正确应用 `session_id`。

要求：

- 旧信号：查 `ai_signals.user_id = 当前用户`。
- 共享信号：查 `auto_signal_deliveries.user_id = 当前用户`，不要因为用户无桥接就改查 admin 的 delivery。
- 如果传入 `session_id`，旧信号和共享信号都必须按 `s.session_id` 过滤。
- 返回最新一条，排序用 `created_at DESC, id DESC`。
- 共享信号返回的 `is_executed` 必须来自 delivery。

---

## 2. 自动推理策略支持“用户选择品种子集”

用户补充需求：

> 前端自动推理配置中，选择策略，如果策略支持多个品种，那么右边需要联动出现多选的组件，可以选择想开启的品种。

### 2.1 数据模型

当前策略表 `auto_prompt_types.symbols_json` 表示策略支持的全部品种。

需要让用户在 `auto_scheduler` 中保存自己对该策略的品种选择。可以复用当前 `auto_scheduler.symbols` 字段，语义改为：

```text
用户当前选择策略下实际订阅的品种 JSON 数组
```

规则：

- `auto_prompt_types.symbols_json` 是策略支持品种全集。
- `auto_scheduler.symbols` 是用户选择的品种子集。
- 用户选择的品种必须是策略支持品种的子集。
- 如果策略只支持 1 个品种，前端可以不展示多选组件，后端保存该单品种。
- 如果策略支持多个品种，前端必须展示多选组件。
- 如果用户未选择任何品种，不允许保存或开启自动推理。
- 如果用户切换策略，前端品种多选要联动刷新；默认可选中该策略全部品种，或保留已存在且仍属于新策略的交集。推荐默认全选。

### 2.2 后端配置接口

`get_auto_config` 返回的 `config` 需要增加：

```js
selected_symbols: [...]
```

`prompt_types` 中每条策略已经返回 `symbols`，继续保留。

`save_user_auto_config` 允许参数增加：

```js
{
  prompt_type_id,
  selected_symbols,
  risk_level,
  max_position_size,
  selected_take_profit,
  enable_auto_trade
}
```

后端校验：

- `prompt_type_id` 必须存在且启用。
- `selected_symbols` 必须是非空数组。
- 每个 symbol 转大写、trim、去重。
- 每个 symbol 必须存在于该策略 `symbols_json`。
- 保存到 `auto_scheduler.symbols`，建议 JSON 字符串。

`toggle_auto` 行为：

- 如果用户开启自动推理但没有保存 `selected_symbols`：
  - 如果已有策略，则默认选择该策略全部品种。
  - 如果还没有策略，则先选择第一个启用策略，并默认选择该策略全部品种。
- 如果 `selected_symbols` 为空，返回错误。

### 2.3 调度订阅逻辑

当前 `reconcileAutoSchedulers()` 根据策略支持品种展开调度 key，这是不够的。必须改成根据用户实际选择品种展开。

应该查询：

```sql
auto_scheduler.enabled = 1
auto_scheduler.prompt_type_id = auto_prompt_types.id
auto_scheduler.symbols
users.plan = 'pro'
```

然后对每个启用用户：

- 解析 `auto_scheduler.symbols`。
- 与策略 `symbols_json` 求交集。
- 对每个实际订阅品种生成 key：`promptTypeId:symbol`。

`getAutoSubscribers(promptTypeId, symbol)` 必须使用 `symbol` 参数，只返回实际选择了该品种的用户。

这点很重要：同一个策略支持 `XAUUSD, EURUSD`，用户 A 只选 `XAUUSD`，用户 B 只选 `EURUSD`。那么：

- `promptTypeId:XAUUSD` 只投递给用户 A。
- `promptTypeId:EURUSD` 只投递给用户 B。

不能再把策略下所有品种都投递给所有选择该策略的用户。

---

## 3. 前端联动多选组件

主要文件：

- `public/ai/index.html`
- `public/ai/app.js`
- `public/ai/styles.css`

要求：

### 3.1 策略选择

现有自定义策略下拉继续保留。

用户选择策略后：

- 找到该策略的 `symbols`。
- 如果 `symbols.length > 1`，在右侧或同一行右边展示多选组件。
- 如果 `symbols.length === 1`，隐藏多选组件，自动选择该品种。
- 如果没有策略，隐藏多选组件。

### 3.2 多选组件 UI

建议使用 checkbox chip / compact multi-select，不要普通长列表。

显示示例：

```text
选择品种  [XAUUSD ✓] [EURUSD ✓] [GBPUSD]
```

要求：

- 支持全选/取消全选，或至少支持点击 chip 切换。
- 至少选择一个，否则保存按钮提示错误。
- 普通用户只能从策略支持品种中选择，不能输入自定义品种。
- 管理员编辑策略的“绑定品种”仍在管理员策略管理区处理，不受这个多选组件影响。

### 3.3 保存

`saveAutoConfig()` 发送：

```js
selected_symbols: [...]
```

切换策略后，如果该策略多品种，默认选中全部品种。

### 3.4 `autoAnalyzeMode` 显示策略名称

用户开启自动推理时，`id="autoAnalyzeMode"` 必须显示当前选择策略的标题，不再显示旧的品种+间隔。

建议文案：

- 关闭：`自动推理关闭`
- 开启且运行：`自动推理 · {策略标题}`
- 开启但市场休市：`自动推理暂停 · {策略标题}`
- 开启但 Redis 不可用：`自动推理暂停 · {策略标题}`
- 开启但管理员桥接离线：`自动推理暂停 · {策略标题}`
- 开启但未选策略：`自动推理暂停 · 未选择策略`

如果想展示品种，放在 tooltip 或配置面板中，不要挤进 badge 主文案。

前端需要统一一个函数，例如：

```js
updateAutoAnalyzeBadge(config, promptTypes, status)
```

不要在 heartbeat、`loadStatus()`、`handleAutoToggle()` 三处各自拼旧文案。

---

## 4. Redis 保存调度器状态和订阅用户

用户提出想法：

> 是否可以将调度器的状态、订阅用户的ID等等相关的所有信息都写入Redis中，且不设置过期时间。如果有人开启或关闭了自动推理，就从Redis中删除对应的用户id。

请实现“运行态和订阅索引写 Redis”，但不要把 Redis 当业务配置唯一来源。

### 4.1 原则

- DB 是最终真相。
- Redis 是运行态索引和调度状态。
- 订阅 Set 可以不设置过期时间。
- lock 和 cooldown 必须设置过期时间。
- 服务启动时必须从 DB 重建 Redis 订阅索引，避免 Redis 脏数据。

### 4.2 推荐 Redis key

```text
auto:scheduler:keys
auto:scheduler:{promptTypeId}:{symbol}:state
auto:scheduler:{promptTypeId}:{symbol}:subs
auto:user:{userId}:auto
auto:scheduler:lock:{promptTypeId}:{symbol}
auto:scheduler:cooldown:{promptTypeId}:{symbol}
```

含义：

- `auto:scheduler:keys`：Set，当前有订阅的调度 key。
- `auto:scheduler:{key}:state`：Hash，保存 running、interval、lastError、lastRunAt、subscriberCount 等。
- `auto:scheduler:{key}:subs`：Set，保存订阅该 key 的 userId。
- `auto:user:{userId}:auto`：Hash，保存用户当前 prompt_type_id、selected_symbols、enabled。
- lock/cooldown 继续带 TTL。

### 4.3 开启/关闭自动推理

开启或保存配置后：

1. 保存 DB。
2. 根据用户策略和 selected_symbols 同步 Redis：
   - 对每个 symbol：`SADD auto:scheduler:{promptTypeId}:{symbol}:subs userId`
   - 写 `auto:user:{userId}:auto`
   - 写 `auto:scheduler:keys`
3. 如果用户之前订阅了其它策略/品种，要先清理旧订阅。
4. 调用 `reconcileAutoSchedulers()`。

关闭自动推理后：

1. 保存 DB。
2. 从 Redis 中删除该用户所有旧订阅：
   - `SREM auto:scheduler:{oldPromptTypeId}:{symbol}:subs userId`
   - `DEL auto:user:{userId}:auto`
3. 如果某个 subs set 空了，删除该 key 的 state，并从 `auto:scheduler:keys` 移除。
4. 调用 `reconcileAutoSchedulers()`。

### 4.4 服务启动

`initAutoSchedulers()` 时：

1. 从 DB 查询所有启用用户的实际 selected_symbols。
2. 清理并重建 Redis 调度订阅索引。
3. 再启动本地内存调度器。

如果 Redis 不可用：

- 不触发 AI。
- 仍保留 DB 配置。
- 前端状态显示 Redis 不可用。

---

## 5. 测试和验证

必须运行：

```powershell
node --check server/routes/ai/scheduler.js
node --check server/routes/ai/config.js
node --check server/bridge-ws.js
node --check server/migrations.js
node --check public/ai/app.js
npm.cmd test
git diff --check HEAD
```

建议新增或更新测试：

1. `saveUserAutoConfig()`：
   - 支持 `selected_symbols`
   - 拒绝空数组
   - 拒绝策略不支持的 symbol
   - 切换策略后保存正确子集
2. `getAutoSubscribers(promptTypeId, symbol)`：
   - 只返回选择了当前 symbol 的用户
3. 信号 SQL：
   - `signals` UNION 两边字段一致
   - 旧信号 + delivery 信号统一分页
4. 前端纯函数：
   - 策略多品种时显示多选
   - 单品种时隐藏多选
   - `autoAnalyzeMode` 文案使用策略标题

如果不方便做端到端 UI 测试，至少抽出纯函数进行单元测试。

---

## 提交要求

完成后：

```powershell
git status --short
git add <modified files>
git commit -m "fix: 完善自动推理策略品种订阅"
```

如果当前环境允许推送，则推送：

```powershell
git push origin dev_codex
```

结果文件必须记录：

- 实际提交号
- 修改文件
- 每个问题的修复说明
- 测试命令和结果
- 未完成项或风险

不要写入任何 token、API key 或私密凭据。
