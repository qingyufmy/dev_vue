# 阶段 12N：用户执行命令与策略分发验收记录

> 日期：2026-09-04
>
> 范围：统一用户交易命令、管理员策略分发、精确分发平仓、逐账户异步执行、结果汇总与公共 V4 合同
>
> 边界：仅完成源码、只追加迁移文件和离线验证；未执行迁移，未启动服务，未连接真实 MySQL、Redis、Bridge、MT4/MT5，也未发送任何交易命令

## 1. 结果

阶段 12N 已补齐阶段 12M 明确缺失的服务端写入入口。六类账户命令统一进入 `execution` 应用域：

1. 手动市价单；
2. 手动挂单；
3. 修改持仓止损、止盈；
4. 精确 ticket 平仓；
5. 修改挂单价格、手数、保护价或到期时间；
6. 精确 ticket 撤单。

公共 HTTP 入口只接收当前登录用户的账户命令，不允许浏览器伪造策略分发来源、父 operation 或 distribution 身份。服务端在创建 intent 前重新核对账户归属、观摩只读状态、终端交易权限、六类集合 revision 和单个资源 revision，并经过现有确定性风控。语法有效但风控拒绝的命令保存为终态 rejected operation，不创建可投递 intent；新增敞口动作继续使用账户级短期风险预留，并在同一账户事务中聚合活动与已提交预留，阻止并发超额。

## 2. 策略分发与逐账户异步执行

管理员策略分发只接受市价单和挂单。确认时冻结当前 active 交易策略版本、订单参数、合格订阅、账户、交易权限、账户/持仓/挂单/报价/合约/风控 revision 和对应快照身份。相同交易账户即使因历史配置出现多条匹配订阅，也只生成一个目标，避免重复下单。

分发父 operation 与冻结目标在一个短事务中持久化，目标和 Outbox 使用 250 行有界批次写入。每个目标产生独立的 `execution.distribution.target.requested` 事件和确定性 BullMQ job ID，由 execution worker 分别调用同一个 `UserExecutionCommandService`。单个账户的拒绝或失败不会回滚其它目标；子命令采用稳定的 `dist-target:{target_id}` 幂等键，队列重复投递不会创建第二个账户命令。

父 operation 按目标状态汇总。只要任一目标为 `uncertain`，父级就保持 `uncertain`，不会提前显示部分完成；成功与明确失败并存才为 `partially_succeeded`。

## 3. 精确分发平仓与终端结果

分发平仓不接受品种、策略或任意 ticket 筛选。服务端只能从原分发目标关联的、已确认 `succeeded + position + ticket` outcome 选择目标，并在新请求中冻结：

- 原 distribution ID；
- 原 target ID；
- 原 outcome ID；
- 原终端 ticket；
- 当前持仓集合 revision；
- 当前该 ticket 的资源 revision；
- 当前账户、报价、合约和风控 revision。

原 ticket 已不存在、资源 revision 改变或目标已被另一分发平仓引用时失败关闭。Bridge 回执继续先写 `execution_outcomes`，再推进子 operation、目标和父汇总。可能已经送达终端但结果不明的命令只进入 `uncertain` 和精确对账，不按普通失败自动重发。

## 4. 合同、运行角色与数据结构

OpenAPI、TypeScript 合同和 API client 已同步增加：

- `POST /api/v4/trading-accounts/{accountId}/execution-commands`；
- `POST /api/v4/execution-distributions`；
- `POST /api/v4/execution-distributions/{distribution_id}/close-commands`；
- 六类严格 discriminated union 命令；
- 数字字符串 revision、父 operation、distribution 和结果汇总字段。

API 只负责认证、CSRF、合同转换和调用应用服务；不消费后台任务。独立 execution worker 新增分发目标任务分支；Outbox dispatcher 仍以 MySQL 为权威，仅负责将已提交事件投递到队列。

迁移 `20260904_011_user_execution_commands_and_distributions.sql` 只追加用户命令、分发、目标和结果表，并扩展 operation/intent 的来源关联。迁移文件不删除、不清空、不回写旧用户数据。旧分发表的历史回填仍必须沿总迁移方案使用 checkpoint、legacy ID 映射和逐用户对账，不能在应用启动或一个无界事务中执行。

## 5. 第一轮复审：需求覆盖、复用与最小设计

第一轮按“账户级命令、风控、分发、平仓、审计”检查。原实现草案曾为分发只写一个未被消费的 `execution.distribution.requested` 事件，表面显示 queued 但实际没有执行者；已改为每个冻结账户一个可消费事件和子 operation。分发不再复制第二套下单、风控或 Bridge 逻辑，而是转换为同一用户命令词汇后调用统一应用服务。

复审还发现同账户可能通过不同分析订阅匹配同一交易策略，从而重复生成订单；已在冻结前按账户稳定排序并去重。API 原草案允许公共请求携带内部 source/parent/distribution 字段，存在伪造归因风险；这些字段已从公共入口移除，只允许内部 worker 生成。Bridge 未增加策略、会员、手数或风控判断，仍只承担确定性命令传输、终端调用和结果回传。

第一轮结论：六类命令和两类分发均进入同一机械执行边界，没有新增微服务或 Bridge 业务规则；逐账户任务与父级汇总是批量交易所需的最小状态。

## 6. 第二轮复审：并发、迁移、异常恢复与连带风险

第二轮重点检查 revision、幂等、事务、未知结果和大批量写入。用户命令在服务层读取后，持久化事务再次按账户、归属、上下文、权限、幂等、资源和 revision 的固定顺序校验；新增敞口在相同账户锁内聚合风险预留。目标冻结快照带 SHA-256，worker 领取时重新验证；损坏目标会被审计拒绝。批量目标和 Outbox 从逐行写入调整为 250 行一批，降低长事务和数据库往返，但仍不在事务中调用 Redis、Bridge、MT 或模型。

复审发现仅修改止盈时，规范化后的 `stop_loss: null` 曾被误判为止损变更；风险判断已改为只把非空止损视为变更，并增加回归。账户停机时仍允许精确平仓、撤单和确实降低风险的保护调整，但扩大风险的修改保存为 rejected。终端回执会同步更新分发 target 和父 operation；`uncertain` 优先级高于 partial，且不会触发普通重放。

剩余风险：本轮没有执行 011 迁移，也没有验证真实 MySQL 锁行为、Redis 重投、Bridge route、MT 资源回执和跨账户压力。会员有效期、订阅接收时段等最终准入仍需在后续旁路联调中结合权威权益/调度投影完成端到端证据；在此之前不能宣称策略分发已可上线交易。旧分发历史也尚未回填到新表，必须在阶段 15 数据迁移中完成有界 checkpoint 和逐用户对账。

## 7. 离线验证

- Stage 12N 定向回归：10 files / 65 tests passed；
- 新增用户命令服务：8 tests passed；
- 新增分发服务与 worker：10 tests passed；
- Contracts：12 tests passed；
- API client：8 tests passed；
- Server TypeScript typecheck：通过；
- V4 server build：通过；
- 前端全部工作区测试、typecheck、build 与跨应用边界检查：通过；
- OpenAPI JSON 与 515 个 `$ref`：通过；
- 根测试：239 / 240 files、3564 / 3566 tests passed；仅 Bridge 发布工具两项既有 PowerShell `Get-FileHash` 环境失败，与本阶段 execution 改动无关；
- `git diff --check`：通过。

## 8. 下一阶段

下一阶段应将阶段 12M 的 AI 交易员只读页面接入本阶段真实写能力：

1. 用 shadcn-vue 表单和确认对话框接入下单、挂单、改单、平仓和撤单；
2. 危险操作明确展示账户、ticket、手数、价格、SL、TP 和影响范围；
3. 管理员分发先预览冻结范围，再显示父 operation 与逐账户状态；
4. 分发平仓只从原分发结果进入，不提供模糊选择；
5. HTTP 返回 accepted 后通过 `operation.changed` 更新，不把 accepted 当成终端成交；
6. 在用户确认后另行执行 011 旁路迁移和真实依赖联调，本阶段不得自动执行。
