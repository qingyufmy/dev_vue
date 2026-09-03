# 阶段 12E：执行意图与风险预留验收记录

> 日期：2026-09-03
> 范围：已批准风险决定、账户级执行意图、短期风险预留、过期释放、operation 查询与小型事件
> 明确不包含：数据库迁移执行、Bridge 命令、WebSocket 终端投递、MT4/MT5 操作、生产部署

## 1. 目标与边界

阶段 12D/12D.1 已经把 AI 交易员建议、确定性风险决定和有限账户解锁分开。本阶段只把一份仍然有效的 `approved` 风险决定转换为不可变、幂等、账户级的执行准备记录：

```text
risk_decision approved
  -> operation queued
  -> execution_intent prepared
  -> risk_reservation active（仅新增敞口动作）
```

这里的 `prepared` 不是已发送、更不是已成交。事务内没有模型、Bridge、终端或其它网络 I/O；Bridge 仍由后续独立阶段接入。

## 2. 已实现的数据边界

- 一个风险决定对应一个父 operation；每个批准动作拥有独立 `action_id` 和 execution intent。
- 市价单、挂单会预留手数、风险金额、风险百分比、持仓/挂单数量和当日开仓次数。
- 平仓、撤单和只收紧保护等减险动作不占新增敞口预留。
- 风险批准结果没有动作时返回 `noop`，不伪造 operation、intent 或空交易。
- 执行准备有效期固定为风险评审时间起 30 秒；过期后只能释放，不能延长旧批准结果。
- operation、intent、payload、reservation 和状态事件分表；大动作/expected-state JSON 不进入 WebSocket 小事件。
- 幂等键与请求哈希由服务端稳定规范化计算；同一风险决定和动作不会生成第二笔执行身份。

## 3. 并发与一致性

持久化使用一个短事务，并按“账户 -> 风险决定/执行身份 -> 风险状态与活动预留 -> outbox”顺序锁定。事务提交前再次验证：

- 风险决定仍为 `approved`，交易决定仍为 `accepted`；
- 系统用户仍拥有目标交易账户；
- 行情、合约、账户、持仓、挂单、订阅、分析和风险 revision 未变化；
- 平台/账户风控策略和手动解锁身份仍有效；
- 当前风险摘要加全部显式 `active + committed` 预留，再加本批新增预留后仍未越过限制。截止时间只决定尚未投递的 prepared intent 是否可过期；一旦进入投递或结果核对，预留必须由明确结果提交/释放，不能仅因墙钟经过 30 秒而从容量计算中消失。成功结果进入 committed 后仍占容量，直到可信持仓/挂单投影将它标记为 absorbed。

这使两个同时通过早期评审的任务不能各自只看旧余额而重复占用同一账户容量。事务不含 Bridge 调用，因此死锁重试不会导致重复交易。

## 4. 迁移与旧数据

当前 `dev_vue` 数据库仍存在旧版 `order_intents`（412 行）和 `risk_reservations`（362 行）。阶段 12E 采用旁路新表：

- `operations`
- `operation_events`
- `execution_intents`
- `execution_intent_payloads`
- `execution_intent_events`
- `risk_reservations_v4`
- `risk_reservation_events_v4`

迁移文件不删除、清空或改写旧表，也不执行自动回填。旧记录的状态、幂等键、可能已发送语义和 legacy ID 必须在后续有 checkpoint 的有界迁移作业中显式映射；任何可能已到达终端但无法证明的记录只能迁为 `uncertain`，不得重放。

## 5. HTTP 与实时事件

- `GET /api/v4/operations/{operation_id}` 只允许当前系统用户读取自己的 operation。
- 完整动作参数和 expected state 留在 HTTP/受控持久层。
- `operation.changed` 只携带 operation ID、状态、revision 和更新时间等小字段，用作失效通知，不作为交易事实全文。

## 6. 验证结论

完成实现后的本地结果：

- Stage 12D/12E 定向：3 files / 30 tests 全部通过；
- 服务端 TypeScript 类型检查通过；OpenAPI/Realtime JSON 解析通过；
- 根全量：222 files 中 221 files 通过，3458 项中 3456 项通过；仅 2 项既有 Bridge 发布工具测试因子 PowerShell 环境找不到系统 `Get-FileHash` 失败，与本阶段执行意图代码无关；
- 前端：边界检查通过，8 files / 23 tests 通过，所有 workspace 类型检查与生产构建通过；
- `git diff --check` 通过。

真实 MySQL 8.4.8 仅做过只读核对：当前只有旧 `order_intents`、`risk_reservations`，尚无 `operations`、`execution_intents`、`risk_reservations_v4`，因此不存在把未执行迁移误报为已生效的情况。没有执行 009 迁移、启动 Bridge 或操作模拟账户。

## 7. 第一轮复审：需求和安全边界

发现并调整：

1. 旧库已经存在同名 `risk_decisions`、`risk_reservations`，不能依赖 `CREATE TABLE IF NOT EXISTS` 复用；Stage 12D/12E 改为明确的 V4 旁路表名。
2. 单纯保存 `approved_actions` 无法可靠重算每笔风险预留；Stage 12D 的通过规则补充冻结的风险金额、风险百分比和手数。
3. 风险评审通过与执行准备之间仍可能并发改变账户容量；增加账户锁、活动预留聚合和提交前 revision/策略复核。
4. 零动作的 `hold` 不应产生看似可执行的 operation；明确返回 `noop`。

## 8. 第二轮复审：迁移、恢复与过度设计

复审后保留的最小结构只有 operation、intent、payload、reservation 和对应事件；没有引入工作流引擎、微服务、分布式事务或 Bridge 模拟层。过期任务只处理从未投递的 `prepared` 意图并释放活动预留；未来一旦进入 `dispatching/awaiting_result/uncertain`，预留必须继续占用到终端对账完成，不能沿用本阶段的普通过期规则。

## 9. 剩余风险与后续阶段

- 009 迁移尚未在旁路数据库执行，真实 FK、索引和锁等待仍需迁移演练。
- Redis Worker 租约、Bridge route、终端 capability、命令账本与结果对账尚未接入。
- 旧订单意图和风险预留尚未回填；上线前必须做逐状态映射、行数/哈希对账和回滚演练。
- 本阶段的 30 秒 TTL 是执行准备窗口，不是挂单有效期，也不能替代行情偏移和 Bridge 发送前复核。
- 真实多任务并发和死锁场景需在阶段 15–16 使用旁路 MySQL 压测，单元测试不能代替该证据。
