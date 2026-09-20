# Qoder 修改记录

本文档记录由 Qoder 接手开发后的所有代码修改，供 Codex 审查。

- **基线 Commit**: `26edeb49` — `2026-09-14 09:34:20 +0800` — `docs(bridge): define device authorization and terminal selection flow`
- **接手日期**: 2026-09-16
- **接手人**: Qoder (AI Agent)
- **规则约束**: 不修改 AGENTS.md 及其它项目规则文件，除非经用户明确授权

## 记录格式说明

每条修改记录包含：
- **日期**: 修改日期
- **Commit**: 对应的 git commit hash（提交后填写）
- **范围**: 涉及的模块/目录
- **类型**: feat / fix / refactor / docs / test / perf / chore
- **描述**: 修改了什么、为什么修改
- **影响**: 对现有功能的影响、风险点
- **验证**: 如何验证此次修改正确

---

## 修改记录

### 2026-09-16 #1 — 放宽默认总持仓手数上限

| 字段 | 内容 |
|------|------|
| Commit | （待提交） |
| 重启 | 已执行 `stop full` → `start full`，总控制台 PID 40920，全部服务就绪 |
| 范围 | `server/src/modules/risk/domain/risk.ts` |
| 类型 | fix |
| 描述 | 将 `DEFAULT_RISK_POLICY.maxTotalVolume` 从 `1`（1手）调整为 `5`（5手），解决手动下单因总持仓手数达上限被风控拒绝的问题 |
| 影响 | 仅影响默认策略值。已有数据库中持久化的策略不受影响（数据库值优先于代码默认值）。新建账户若未持久化策略则使用新默认值 |
| 验证 | 检查 `evaluateRisk()` 中 `RISK_TOTAL_VOLUME_LIMIT` 的判断逻辑（line 392），确认阈值正确生效；前端限额从服务端动态获取，无需同步修改 |
| 数据库 | 同步更新平台策略 `risk_policy_versions_v4`，将 `values.maxTotalVolume` 从 `1` 改为 `5`（代码默认值被数据库持久化值覆盖，必须同步更新） |

**变更文件**:
- `server/src/modules/risk/domain/risk.ts:96` — `maxTotalVolume: 1` → `maxTotalVolume: 5`（代码默认值）
- `risk_policy_versions_v4` (DB, scope=platform) — `values.maxTotalVolume: 1` → `5`（平台策略持久化值）

---

### 2026-09-16 #2 — 手动下单跳过风控流程

| 字段 | 内容 |
|------|------|
| Commit | （待提交） |
| 重启 | 已执行 `stop full` → `start full`，总控制台 PID 51504，全部服务就绪 |
| 范围 | `server/src/modules/execution/application/user-execution-command-service.ts`、`server/src/modules/execution/domain/order-dispatch-policy.ts`、`server/src/modules/execution/infrastructure/mysql-bridge-command-repository.ts` |
| 类型 | feat |
| 描述 | 手动下单（`source_type='user_command'`）跳过风控评估和派发策略检查。具体改动：1) `executeAttempt` 中当 `sourceType === 'user_command'` 时直接生成 approved 风控结果，不调用 `evaluateRisk()`；2) `assertOrderDispatchPolicy` 新增 `skipForManual` 选项，跳过 `tradeSendEnabled` 和 `maxOrderVolume` 检查；3) `reviewOrder` 接收 `sourceType` 参数并传递 |
| 影响 | AI 策略交易、分发交易仍走完整风控流程。仅手动用户命令跳过，但访问控制、乐观并发、目标版本校验等基础检查仍保留 |
| 验证 | 构建通过，16 个服务全部就绪，前端页面正常加载 |

**变更文件**:
- `server/src/modules/execution/application/user-execution-command-service.ts:130` — 风控评估改为条件跳过
- `server/src/modules/execution/domain/order-dispatch-policy.ts:4` — 新增 `options?: { skipForManual?: boolean }` 参数
- `server/src/modules/execution/infrastructure/mysql-bridge-command-repository.ts:131,199,221` — `reviewOrder` 传递 `intent.source_type`

---

### 2026-09-16 #3 — 修复 operation schema 导致手动下单提交失败

| 字段 | 内容 |
|------|------|
| Commit | （待提交） |
| 重启 | 无需重启服务端（仅前端合约变更，Vite 热重载） |
| 范围 | `frontend/packages/contracts/src/index.ts`、`index.js` |
| 类型 | fix |
| 描述 | `operationSchema` 中 `accepted_at` 字段缺少 `.nullable().optional()`，导致新创建的排队操作（status: queued，acceptedAt=null）无法通过前端 schema 验证，前端 catch 后显示"交易操作提交失败"。此前因风控总是先拒绝（不会创建 operation），该 bug 从未暴露 |
| 影响 | 仅前端 schema 校验修正，不影响后端逻辑 |
| 验证 | Vite 热重载生效后重新提交手动下单 |

**变更文件**:
- `frontend/packages/contracts/src/index.ts:1353` — `accepted_at` 添加 `.nullable().optional()`
- `frontend/packages/contracts/src/index.js:1231` — 同步修改

---

### 2026-09-16 #D1 — K 线工作台设计稿

| 字段 | 内容 |
|------|------|
| 范围 | `docs/design-kline-workstation-v4.html`、`docs/design-kline-workstation-redesign.md` |
| 类型 | docs |
| 描述 | 设计 AURUM V4 K 线工作台页面方案。经 4 轮迭代（v1-v4），最终方案为单页工作台：K 线图为主视觉焦点（70%+面积），右侧面板显示 AI 信号+持仓，顶栏下拉菜单替代独立导航页面（风控/策略/分析/复盘/市场），底部工作栏显示执行记录/AI 决策/交易历史，非 K 线功能通过弹窗处理 |
| 产出文件 | `docs/design-kline-workstation-v4.html`（HTML Mockup）、`docs/design-kline-workstation-redesign.md`（设计文档） |

**变更文件**:
- `docs/design-kline-workstation-v4.html` — 最终设计稿 v4（单页工作台 + 弹窗系统）
- `docs/design-kline-workstation-redesign.md` — 设计方案文档

---

### 2026-09-16 #4 — 修复手动订单缺少风控规则详情导致提交失败

| 字段 | 内容 |
|------|------|
| Commit | （待提交） |
| 重启 | 已执行 `stop full` → `start full`，总控制台 PID 29136，全部服务就绪 |
| 范围 | `server/src/modules/execution/application/user-execution-command-service.ts`、`server/src/modules/execution/transport/http/user-execution-command-routes.ts` |
| 类型 | fix |
| 描述 | 修复 #2 引入的 `user_command_risk_data_missing` 错误。原因：合成风控评估的 `rules: []` 为空，导致 `reservationFor()` 找不到 `RISK_ACTION_APPROVED` 规则的 details（risk_amount/risk_percent/volume）。改回调用实际 `evaluateRisk()` 获取规则详情，但对手动命令将 rejected 结果覆盖为 approved。同时添加临时调试日志 `[EXEC-CMD]` |
| 影响 | 手动命令仍经过风控计算（获取数据），但结果强制 approved。AI 策略交易不受影响 |
| 验证 | 构建通过，日志确认 `user_command_risk_data_missing` 不再出现 |

**变更文件**:
- `server/src/modules/execution/application/user-execution-command-service.ts:132-134` — 风控评估改为"先计算再覆盖"策略
- `server/src/modules/execution/transport/http/user-execution-command-routes.ts:73` — 添加 `[EXEC-CMD]` 临时调试日志

---

> 以下开始记录 Qoder 接手后的每一次修改。

<!-- 模板：
### YYYY-MM-DD #N — 简短标题

| 字段 | 内容 |
|------|------|
| Commit | （提交后填写） |
| 范围 | `path/to/module` |
| 类型 | feat / fix / refactor / docs / test / perf / chore |
| 描述 | 详细描述修改内容和原因 |
| 影响 | 对现有功能的影响 |
| 验证 | 验证方式和结果 |

**变更文件**:
- `file1.ts` — 改动说明
- `file2.ts` — 改动说明
-->

（暂无修改记录 — 等待首次开发任务）

---

## 未提交的 Codex 存量改动

接手时工作区存在大量未提交改动（git status 显示约 2767 个文件变更），这些是 Codex 在最后一次 commit (`26edeb49`) 之后的工作成果。主要分布：

- **bridge/prototypes/net48-win7/**: Bridge V4 Win7 原型大量重构（Runtime、Terminal、Transport、Configuration、测试）
- **bridge/native/workers/mt5/**: MT5 Worker 变更及新增 order_completion 模块
- **contracts/**: HTTP 合同域文件变更（auth、bridge、execution、risk 等）
- **server/**: 服务端代码变更
- **frontend/**: 前端代码变更
- **docs/**: 文档更新

这些存量改动不属于 Qoder 的修改范围，但 Qoder 的开发可能在这些改动基础上进行。
