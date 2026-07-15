# Mimo Task 02 结果：策略所有权、可见性与订阅

## 完成状态

**已完成** — 所有 10 项需求均已实现，731 项测试全部通过（含新增 49 项）。

## 实现内容

### 1. Migration 057：数据库扩展

**文件**: `server/migrations.js` (id: `057_strategy_ownership`)

- `auto_prompt_types` 新增 7 列：
  - `scope` VARCHAR(20) — `'platform'` | `'private'`
  - `owner_user_id` INT — 所有者用户 ID（平台策略为 0）
  - `model_profile_id` INT — 绑定的模型档案 ID（可空）
  - `inference_mode` VARCHAR(32) — `'platform_model'` | `'owner_model'` | `'user_default'`
  - `visibility_status` VARCHAR(20) — `'active'` | `'draft'` | `'archived'`
  - `version` INT — 内容版本号（自动递增）
  - `version_label` VARCHAR(50) — 版本标签
- 新增索引 `idx_apt_scope_owner`

### 2. 新增 `trading_accounts` 表

交易账户基础身份表，保存：
- `user_id`, `broker_server`, `login_account`, `nickname`
- `margin_mode` (netting/ hedge)
- `review_status` (pending/ approved/ rejected)
- `observe_status` (active/ paused)
- `is_deleted` 软删除标记

### 3. 新增 `strategy_subscriptions` 表

策略订阅关系表，保存：
- `user_id`, `trading_account_id`, `strategy_id`
- `risk_profile_id` — 风控档案引用（可空，Task 04 补齐）
- `symbols_json` — 用户选择的品种子集（NULL = 策略全部品种）
- `execution_enabled` — 执行开关
- `memory_mode` — `'shared'` | `'isolated'`
- `conflicting_strategy_id` — 挂单冲突策略引用

### 4-6. 权限模型

- **平台策略**: 管理员维护，所有 pro+ 用户可见，使用平台模型
- **私有策略**: 创建者 + 管理员可见；仅创建者可选择执行；模型必须属于创建者或留空继承
- **管理员只读**: `adminListUserStrategies` / `adminListUserSubscriptions` — 无模型调用、修改、执行或额度消耗权限

### 7. V1 执行约束

同一交易账户 + 同一标准品种（broker suffix 归一化）只允许一个 `execution_enabled=1` 的订阅激活。通过 `findActiveExecutionConflict` 实现，使用应用层检查而非唯一索引，允许多个 inactive 记录存在。

### 8. API 服务端权限

**文件**: `server/routes/ai/strategy-ownership.js`

| 函数 | 功能 | 权限 |
|------|------|------|
| `listStrategies` | 列表可见策略 | pro+ 用户 |
| `getStrategyById` | 策略详情 | 平台=全员；私有=创建者+admin |
| `createStrategy` | 创建策略 | 平台=admin only；私有=pro+ |
| `updateStrategy` | 修改策略 | 创建者+admin |
| `deleteStrategy` | 软删除策略 | 创建者+admin |
| `listTradingAccounts` | 列表交易账户 | 账户所有者 |
| `createTradingAccount` | 创建交易账户 | 已登录用户 |
| `updateTradingAccount` | 修改交易账户 | 账户所有者 |
| `deleteTradingAccount` | 软删除交易账户 | 账户所有者 |
| `listSubscriptions` | 列表订阅 | 所有者+admin |
| `createSubscription` | 创建订阅 | 所有者 |
| `updateSubscription` | 修改订阅 | 所有者 |
| `deleteSubscription` | 软删除订阅 | 所有者 |
| `adminListUserStrategies` | 管理员查看用户策略 | admin |
| `adminListUserSubscriptions` | 管理员查看用户订阅 | admin |
| `getSubscriptionWithContext` | 订阅详情+上下文 | 所有者+admin |

### 9. auto_scheduler 兼容

订阅创建、修改、停用和策略删除现在都在同一数据库事务内同步维护 `strategy_subscriptions`、`auto_scheduler` 与 `user_bridge_settings`。旧调度器继续读取兼容表，新所有权系统作为事实入口，避免发布期间出现“前端已订阅、调度器未执行”或删除后仍执行的分裂状态。

### 10. 测试覆盖

**文件**: `tests/ai/strategy-ownership.test.js` — 49 项测试

| 分类 | 测试数 |
|------|--------|
| 策略列表/详情/权限 | 8 |
| 策略创建/更新/删除 | 14 |
| 交易账户 CRUD | 5 |
| 订阅 CRUD + V1 约束 | 14 |
| 管理员只读 | 5 |
| 权限边界 | 3 |

## 修改文件清单

| 文件 | 变更 |
|------|------|
| `server/migrations.js` | 新增 migration 057 |
| `server/routes/ai/strategy-ownership.js` | **新建** — 所有权/订阅逻辑 |
| `server/routes/ai/index.js` | 新增 strategy-ownership 导出 |
| `tests/ai/strategy-ownership.test.js` | **新建** — 49 项测试 |

## 旧 auto_scheduler 兼容行为

- `auto_scheduler` 表结构和旧读取函数保持兼容，实际写入由订阅事务同步驱动。
- 创建或启用订阅时同步策略、品种、周期和执行状态；更新订阅时重新计算兼容配置。
- 删除订阅或策略时同步关闭旧 scheduler 与 Bridge 自动执行开关，不保留幽灵任务。
- 任一兼容写入失败会回滚整个订阅事务，不能形成部分成功。

## 最终整合状态

1. **双写过渡已完成**：订阅和兼容 scheduler 事务一致。
2. **风控档案已接入**：运行时解析最终有效风控并由统一订单意图入口执行。
3. **前端 UI 已完成**：用户管理自己的私有策略与订阅；管理员管理平台策略并只读审计其他用户私有策略。
4. **V1 冲突边界保留**：同账户同标准品种只允许一个活跃执行订阅，这是明确安全约束，不是待办。
5. **调度与模型解析已完成**：平台策略不读取用户账户状态；私有策略使用 owner 模型或按共享政策回退。

## Codex 最终审查修订（2026-07-15）

原提交 `1b6d604` 未直接通过审查。Codex 已在进入 Task 03 前完成以下修订：

- Migration 057 移到 056 之后，所有 DDL/回填错误向上抛出；`runMigrations()` 不再把部分执行的迁移静默标记成功。
- 管理员可查看全部用户私有策略，但不能修改、删除、订阅或执行其他用户的私有策略。
- 普通用户只能查看 active 平台策略；私有草稿仅 owner 管理视图可见，不能用于执行。
- 私有策略显式模型绑定已接入 `resolveAiTaskModel()`；跨用户模型拒绝，显式绑定失效时不允许静默回退平台凭据。
- 私有策略未绑定模型时按“用户默认模型 → 允许时平台共享模型 → 暂停”解析；平台策略仍固定使用平台模型。
- 同账户同标准品种的唯一执行约束改为同一 MySQL 事务内 `SELECT trading_accounts ... FOR UPDATE`，并使用同一连接完成复检和写入。
- 冲突判断使用订阅实际品种子集，并统一处理常见 broker suffix；已启用订阅修改品种时也会复检。
- 用户不能自行写入或修改账户 `review_status` / `observe_status`，并增加 margin mode 枚举校验。
- 管理员读取接口不查询模型凭据，也不触发模型解析或额度日志。

最终整合验证：Migration 057 已在真实 MySQL 应用，schema readiness 通过；订阅并发锁、事务双写、权限边界和前端契约均纳入最终全量回归。真实 MT5 下单仍必须在 Kill Switch 开启或模拟账户环境单独冒烟，不能由静态测试替代。
