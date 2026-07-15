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

现有 `auto_scheduler` 单策略配置保持不变，未切换实际 scheduler。新策略所有权系统作为附加层，可与 `auto_scheduler` 共存。双写要求在后续阶段实施。

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

- `auto_scheduler` 表结构和 `getAutoSubscribers` / `upsertAutoConfig` 等函数完全不变
- `strategy_subscriptions` 是独立的附加层，不影响现有调度逻辑
- 后续阶段可将 `strategy_subscriptions` 作为调度器的替代数据源

## 下一阶段风险

1. **双写过渡**: 切换到 `strategy_subscriptions` 时需要同时维护 `auto_scheduler`，避免功能中断
2. **风控档案外键**: `risk_profile_id` 目前为可空，Task 04 建表后需补齐
3. **前端 UI**: 当前无策略管理界面，需 Task 10 实现
4. **多策略并发**: V1 限制同一品种一个活跃执行，多策略并行需 Task 05 解锁
5. **调度切换**: 模型绑定解析已由 Codex 审查修订接入；实际 scheduler 切换仍按后续任务推进

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

最终验证：45 个测试文件、709 项测试全部通过；`git diff --check` 通过。尚未连接真实 MySQL 执行 Migration 057 或做双连接并发集成测试，该项保留到 Task 11 上线前验证。
