# 管理员手动挂单分发运行时修复方案

## 1. 结论与修复目标

2026-08-19 虚拟机 `dev_codex` 提交 `a18c561dd447c591485abdd22c18b9414110c7b1` 上，管理员创建的分发挂单 `dispatch #3 / signal #13940 / order_intent #344` 未进入 MT5。服务器、数据库、Redis、目标筛选、订单意图和 Bridge 路由均已工作；最早失败点为 Bridge v3 MT5 Worker 的严格参数校验。

已确认的直接原因：服务端把数据库 `DECIMAL` 读取出的挂单价格原样作为 JSON 字符串发送，例如 `"price":"4400.00000000"`。Worker 合同只接受 JSON number，因此命令在调用 MT5 `order_send` 前以 `worker_command_params_invalid` 终止。

本次修复必须同时实现：

1. 在 Bridge 服务端线协议边界把可信的十进制字符串规范化为有限 JSON 数字，并在入台账前拒绝非法数值。
2. 把 Worker 明确的“参数无效、尚未进入 MT”结果归类为确定失败，不再进入五分钟不确定对账。
3. 源账户确定失败时，原子收尾所有尚未发送的订阅目标；页面不得继续显示 `pending`。
4. 保留源账户成功后才分发订阅账户、每目标幂等、真实票号核验、关联撤单身份围栏等现有安全合同。
5. 增加可追溯的 Bridge 命令 ID，能够从订单意图直接定位 `bridge_v3_command_ledger`，避免只凭 MT comment 猜测台账记录。

## 2. 已验证事实与非问题

### 2.1 已验证运行链路

- 分发记录正确冻结 `sell + limit + XAUUSD + 4400 + 0.01 + 240分钟`。
- 生成信号正确保存 `entry_method=limit` 和 `limit_price=4400`。
- 管理员定向订单绕过 AI 推理和普通策略风控，仅执行管理员订单的固定参数、账户、Bridge 与幂等校验；本次没有风控拒绝。
- Bridge v3 台账记录了 `place_order` 的 queued、dispatched、result_received；Worker 返回 `worker_command_params_invalid`，没有经纪商 retcode、订单号或成交号。
- 后续 `query_execution` 每30秒成功执行但未找到订单，最终订单意图为 `reconciled_not_found`。
- 源账户未成功，订阅账号没有创建订单意图或发送 Bridge 命令，符合源账户安全门要求。

### 2.2 时间字段不是本次故障

`ai_signals.pending_valid_until` 当前按“UTC 无时区 DATETIME 文本”保存，读取端显式追加 `Z`。本次 `13:10:02` 表示 UTC，对应北京时间 `21:10:02`，正好是 `17:10:02 + 240分钟`。Bridge 再依据已验证的终端时差生成 MT5 终端时间 expiration。

因此：

- 不修改字段类型，不迁移历史数据，不把该值当作北京时间。
- 增加 UTC、北京时间展示和终端 expiration 的回归断言，防止未来再次误判或重复加时差。

## 3. 范围与非目标

### 3.1 本次范围

- 管理员分发以及其他通过 Bridge v3 `place_order` 发送的市价、限价、止损和止损限价订单的数值线协议。
- 管理员分发 source-first 状态机、失败收尾和人工重试恢复。
- 订单意图到 Bridge v3 台账的诊断关联。
- 对应后端测试、Bridge 适配器测试、状态机测试和虚拟机 Demo 验收。

### 3.2 明确不做

- 不放宽 Worker 严格合同，不允许 Worker 接受任意字符串数字。
- 不改策略提示词、模型输出或普通 AI 风控规则。
- 不自动重试、补发或修复历史 `dispatch #3`，防止部署后意外创建真实订单。
- 不重构整个订单意图框架，不合并挂单撤单与持仓平仓状态机。
- 不修改 MT4/MT5 Worker、安装器或 Bridge 版本；根因位于网站服务端 Bridge v3 适配层，网站部署即可生效。
- 不删除历史失败记录、审计日志或 Bridge 台账。

## 4. 详细设计

### 4.1 在 Bridge 线协议边界规范化数值

修改 `server/bridge-v3/business-adapter.js`，在 `tradeParams()` 构造 Worker `place_order` 参数时使用单一的严格数值规范化函数。

规则：

- `volume`、`price`、`stop_loss`、`take_profit`、`stop_limit_price`：接受有限 JSON number，或匹配严格十进制格式的字符串；转换后必须满足对应的正数规则。
- `deviation`、`magic`、`expiration`、`type_time`、`type_filling`：转换后必须满足各自整数和非负/正数规则。
- `null/undefined` 的可选字段继续省略；空字符串、布尔值、数组、对象、`NaN`、`Infinity`、混合字符和越界整数在服务端直接拒绝。
- 非法值返回稳定的服务端错误码，例如 `bridge_trade_numeric_param_invalid`，不得派发一条必然被 Worker 拒绝的命令。
- Worker 原有 `worker_command_params_invalid` 严格校验保持不变，作为第二道防线。

优先在通用 Bridge v3 适配边界修复，而不是只在管理员 `targetRequest()` 中补 `Number()`：数据库 DECIMAL 字符串也可能来自其他订单入口，统一边界可以避免同类问题在市价保护价、普通 AI 挂单或止损限价单中重复出现。

### 4.2 正确分类 Worker 前置拒绝

即使未来仍出现 Worker 合同错误，`worker_command_params_invalid` 明确表示命令没有进入 MT 下单调用。服务端应把它转换为确定的协议/准备失败：

- Bridge 原始台账继续保留 Worker 的真实回执与既有状态语义；订单意图层对白名单中的 pre-MT 错误做确定失败归类，并在安全结果中保留 `bridge_command_id`。本次不改 Bridge 客户端协议或伪造台账状态。
- 订单意图终态为 `failed`，释放风险预留。
- 分发目标终态为 `failed_manual_review` 或现有等价确定失败状态。
- 不进入 `uncertain`，不启动周期性 `query_execution`，不等待五分钟后再判定不存在。

只有“已经可能调用 MT，但响应丢失或结果无法确认”的情况才允许进入 `uncertain`。不得把确定的参数拒绝与可能成交的网络中断混为一类。

### 4.3 源账户失败后的订阅目标收尾

新增小型事务函数，例如 `finalizeUnsentSubscribersAfterSourceFailure(dispatchId, sourceStatus, sourceError)`：

1. 锁定分发和 source target，重新确认源状态属于 `rejected | skipped | failed | failed_manual_review`。
2. 仅更新该分发中 `target_role=subscriber AND status=pending AND order_intent_id IS NULL AND trade_ticket IS NULL` 的目标。
3. 将这些目标标记为 `skipped`，写入稳定错误码 `source_execution_failed`、`completed_at` 和安全摘要。
4. 不触碰已经执行、正在执行、结果不确定或已有订单谱系的目标。
5. 重新计算主记录计数和完成状态，保证详情、轮询和刷新结果一致。

源目标处于 `uncertain/reconciling` 时不收尾订阅目标，主任务继续保持 `delivering`；只有对账得到确定失败后才执行收尾。

### 4.4 保持人工重试可恢复且不重复下单

现有“重试失败目标”需要同步识别因源失败而跳过的订阅目标：

- 先确认 source 不再是 `uncertain/reconciling`，且本次重试只恢复原失败 source。
- 将 `skipped + error_code=source_execution_failed` 且没有订单意图、票号的订阅目标恢复为 `pending`。
- source 重试成功并完成实时挂单核验后，才按原顺序处理这些订阅目标。
- source 重试再次失败时重新安全收尾。
- 每个目标继续使用 `admin-strategy-dispatch:{dispatchId}:target:{targetId}`，禁止生成新幂等身份。
- 对已证明未进入 MT 的失败，复用原订单意图、目标幂等键和 MT comment，但为新的 Bridge 发送尝试生成独立内部 `operation_id`，从而得到新的台账 `command_id`；未知结果、经纪商拒绝和已有 outcome 的订单意图不得以此方式重发。

历史 `dispatch #3` 不自动重试。若用户以后明确点击重试，修复后的状态机才按上述规则执行。

### 4.5 打通订单意图与 Bridge 台账关联

当前订单意图保存的 `bridge_command_ref=AI-9K` 是持久 MT comment，而 Bridge v3 台账使用哈希 `command_id`。两者用途不同，不应互相替代。

改进方式：

- Bridge v3 执行结果和安全审计结果返回 `bridge_command_id`。
- `order_intents` 复用现有 JSON 结果字段持久化该 ID；若已有合适列则复用，避免为本次修复新增迁移。
- 管理详情只展示缩短后的诊断 ID，不暴露账户或完整参数。
- 对账优先用 `bridge_command_id` 查台账，同时继续用 MT comment、票号和账户身份核对经纪商事实。

该关联只增强诊断，不改变幂等键、MT comment 或订单归属。

## 5. 实施步骤

### 阶段 A：数值合同修复

1. 为 Bridge v3 交易参数增加严格数值规范化工具。
2. 在 open/pending 的 `volume`、价格、保护价和整数参数上统一使用。
3. 将非法值在写入 Bridge 台账前转换为稳定准备失败。
4. 保留 Worker 严格验证并补充跨层合同测试。

验收：字符串 `"4400.00000000"` 在 Worker 线协议中变为数字 `4400`；非法字符串不会创建/派发 Bridge 命令。

### 阶段 B：确定失败分类与状态收尾

1. 把 `worker_command_params_invalid` 映射为确定失败。
2. 源确定失败时事务化跳过未发送订阅目标。
3. 修正主记录计数、完成时间和详情摘要。
4. 扩展人工重试，使安全跳过目标在 source 重试时可恢复。

验收：不再出现“主记录 failed，但订阅目标永久 pending”；确定参数错误不再产生五分钟查询风暴。

### 阶段 C：诊断关联与时间合同测试

1. 在安全执行结果中保留 `bridge_command_id`。
2. 增加订单意图、台账和分发目标的关联断言。
3. 锁定 `pending_valid_until` UTC 文本与 MT terminal expiration 的转换测试，不修改现有时间语义。

验收：从 dispatch target/order intent 可直接定位 Bridge 台账；240分钟有效期在 UTC、北京时间和终端时间三个视图中表示同一时刻。

### 阶段 D：虚拟机 Demo 验收

1. 部署前记录分支、提交、健康状态和现有失败记录，不重试旧记录。
2. 用户明确触发一条新的 MT5 Demo 限价挂单。
3. 核对 source target、order intent、Bridge ledger、MT pending inventory 和真实票号。
4. 核对订阅目标只在 source 成功后发送，并拥有各自独立票号。
5. 使用只读撤单预览验证可定位范围；实际撤单仍由用户单独确认触发。

验收：Bridge `place_order` 终态成功，源挂单实时存在且身份/Magic匹配，订阅目标状态不依赖 F5 修正。

## 6. 测试矩阵

### 6.1 Bridge 适配器

- market/limit/stop/stop_limit，buy/sell。
- 数字与数据库十进制字符串：volume、price、SL、TP、stop-limit price。
- 整数参数：magic、deviation、expiration、type_time、type_filling。
- 非法值：空串、空白、字母、混合字符、布尔值、数组、对象、NaN、Infinity、负数、零、非整数。
- MT4 Stop Limit 仍明确拒绝；MT5 合法挂单不受影响。

### 6.2 订单意图与 Bridge 结果

- 合法参数：queued -> dispatched -> succeeded，并保存 command ID 和真实 ticket。
- Worker 参数错误：直接 failed，不进入 uncertain，不创建 outcome，不保留活动风险预留。
- 可能已执行但回执丢失：仍进入 uncertain 并通过 query_execution 对账。
- 确认经纪商拒绝：保留 broker retcode，不能误分类为参数错误。

### 6.3 分发状态机

- source 成功：订阅目标按序执行。
- source 明确拒绝/准备失败/对账失败：未发送订阅目标全部安全跳过。
- source uncertain：订阅目标保持待执行，但不得发送。
- 人工重试：只恢复可安全恢复的 source 和 `source_execution_failed` 订阅目标。
- 重启、租约过期、重复 worker tick、重复确认：不重复创建订单意图或挂单。

### 6.4 时间

- `17:10:02 +08:00` 创建、240分钟有效期，对应 `13:10:02Z` 到期。
- 终端 UTC+3 时，MT expiration 表示终端 `16:10:02`，但绝对时刻仍为 `13:10:02Z`。
- 不重复增加北京时间或终端时差；无可信终端时差继续 fail closed。

### 6.5 建议验证命令

按影响范围至少执行：

```powershell
npx vitest run tests/admin-strategy-trades.test.js
npx vitest run tests/admin-strategy-trade-worker.test.js
npx vitest run tests/ai/order-intents.test.js
npx vitest run tests/bridge-v3-business-adapter.test.js
npx vitest run tests/bridge-v3-command-ledger.test.js
node --check server/bridge-v3/business-adapter.js
node --check server/workers/admin-strategy-trade-worker.js
node --check server/routes/ai/order-intents.js
npm test
powershell -File scripts/bridge-native/test-native.ps1 -SkipRelease
git diff --check
```

实际测试文件名以仓库现有结构为准；若 Bridge v3 测试并非目录入口，改为精确相关文件，禁止用“未找到测试”当作通过。

## 7. 数据、兼容与发布

- 预计无需数据库迁移；优先复用 JSON 结果中的 `bridge_command_id`。只有确认现有字段无法满足可查询性时，才另行评审新增可空列与索引。
- `/api` 与 `/aurum-api` 保持一致，前端请求和分发 API 不变。
- 历史失败记录保持原样；部署不会自动补单、撤单或重试。
- 本次是网站服务端修复，不构建、不发布 Bridge 安装器或模块更新包。
- 回滚时恢复服务端提交即可；旧失败记录和 Bridge 台账继续可审计。
- 发布后先验证 commit、迁移状态、`/health`、启动日志，再由用户在 Demo 环境主动创建新挂单验证。

## 8. 两轮方案复审

### 8.1 第一轮：需求、边界与最小改动复审

检查项：需求覆盖、已有能力复用、安全边界、是否过度设计。

发现与调整：

1. 最初可只在管理员 `targetRequest()` 中把价格转为 Number，但这会遗漏其他数据库 DECIMAL 来源。调整为在 Bridge v3 线协议边界统一规范化，同时保留 Worker 严格合同。
2. 仅修价格仍会让历史或未来参数合同错误等待五分钟。增加确定前置拒绝分类，但只覆盖能够证明尚未进入 MT 的错误码，不扩大到网络错误。
3. 直接把残留订阅目标改为 skipped 会破坏人工重试。增加专用 `source_execution_failed` 原因和受围栏的恢复逻辑。
4. 不重构通用订单状态机、不修改模型、不发布 Bridge 客户端，改动保持在服务端适配器、订单意图结果和管理员分发 worker。

第一轮结论：覆盖本次故障和可恢复性，未引入策略专用判断或第二套交易框架。

### 8.2 第二轮：兼容、并发、时间、安全与连带 Bug 复审

检查项：数据/迁移、并发与幂等、异常恢复、时间语义、安全、测试、回滚和连带影响。

发现与调整：

1. `pending_valid_until=13:10:02` 经代码核对为 UTC 文本，不是少加8小时；删除时间字段修复和迁移，改为锁定现有合同的测试。
2. source 失败收尾必须带 `order_intent_id IS NULL AND trade_ticket IS NULL` 围栏，避免并发情况下覆盖已开始的订阅目标。
3. command ID 只作为诊断关联，不能替代目标幂等键、MT comment、票号或账户归属校验。
4. 数值字符串规范化必须是严格十进制转换；不得使用宽松 `parseFloat()` 接受 `4400abc`，不得把空字符串转换为0。
5. 网站回滚不得触碰历史订单；旧 `dispatch #3` 不自动恢复，避免修复部署本身产生交易。

第二轮结论：最终方案兼容现有 API、数据库和 Bridge Worker；无需迁移或 Bridge 发布，具备确定失败收尾、人工重试和回滚边界，可进入实施。

## 9. 剩余风险与待验证项

- 尚未用修复后代码向真实 MT5 Demo 创建挂单，最终 broker/terminal 行为必须在用户主动触发的新记录上验证。
- 通用 Bridge 数值规范化会覆盖所有 v3 下单入口，必须用市价单、普通 AI 挂单和管理员分发做回归，防止保护价或整数参数发生类型变化。
- 若 Bridge gateway 当前不能把 command ID返回调用方，需要在不暴露账户信息的前提下扩展内部结果合同；这项不得阻塞 P0 价格类型修复。
- 实施基线已按用户确认以远端 `origin/dev_codex` 为准，并快进同步至 `132b8635d50ec8e17df9e605402552fc51f50fc4`；提交时仍须仅暂存本方案及对应修复文件，禁止夹带其他改动。
