# 周期复盘短持仓证据与自动恢复修复方案

## 1. 方案状态与基线

- 方案性质：公网只读诊断后的正式实施方案；本文件不修改业务代码、数据库、复盘状态或公网服务。
- 本地基线：`D:\dev_codex\wall-street-skill-local`，分支 `main`，提交 `d1f90550e03491b5492edb1760db13de97c4ea05`。
- 本地工作区已有与本方案无关的用户修改：
  - `scripts/push_period_reviews_to_lark.py`
  - `tests/scripts/test_push_period_reviews_to_lark.py`
  实施时必须保留，不得覆盖、回退或混入本次提交。
- 公网基线：`156.238.235.169:52545`，运行目录 `/www1/wwwroot/aurum-ai`，分支 `main`，提交同为 `d1f90550e03491b5492edb1760db13de97c4ea05`；`/health` 已确认服务、数据库和 Redis 正常。
- 目标问题：短持仓交易缺少完整落在持仓区间内的 M5 K 线时，系统把“部分路径指标不可观测”错误升级为“整条交易证据不完整”，阻断日复盘生成，并被小时级维护任务无限重复重建。

## 2. 公网已确认事实

### 2.1 失败链路

- 日复盘 case `#11`，周期 `2026-08-17`，状态 `incomplete`，无 `current_version_id`、无 `period_review_job`。
- case 包含 outcome `#32`、`#31`、`#28`；其中只有 outcome `#32` 对应的交易复盘 case `#186` 不完整。
- case `#186` 对应信号 `#24268`，证据原因：
  - 交易级：`holding_market_path_incomplete`
  - 路径级：`holding_path_bar_boundary_insufficient`
- outcome `#32` 已完成成交归因，开仓和平仓成交均存在，净结果为 `-66.40`；核心交易事实并未缺失。
- 开仓时间 `2026-08-17 13:51:50.206 UTC`，平仓时间 `2026-08-17 13:57:09.999 UTC`，持仓约 `319.793` 秒。
- 持仓跨过两根 M5 K 线，但两根都是边界 K 线，没有任何一根完整闭合 K 线完全位于开仓和平仓之间。
- M5、M15、H1、H4 行情窗口均已取得；真正不可判定的是持仓区间内的精确 MFE、MAE、止盈触达和止损触达，而不是整段行情缺失。

### 2.2 自动恢复实际行为

- case 初次创建于 `05:30`。
- 公网维护任务在 `13:38` 自动重建过交易证据和周期证据。
- 服务于 `14:26` 重启后，维护任务又在 `14:39` 自动重建一次。
- 两次恢复后的原因和状态完全不变；因此不是 worker 未启动、任务未认领或模型失败。
- 当前算法只有在至少一根 K 线完整落入持仓区间时才认为路径指标完整。对本次已经结束的 5 分 20 秒交易，补充更多历史 M5 K 线也不会改变这个事实。
- 周期复盘 worker 只认领 `period_review_cases.evidence_status = 'complete'` 的任务，所以 case `#11` 从未创建业务 job，也从未进入模型调用。

## 3. 根因与设计判断

### 3.1 根因

当前实现混合了三个不同概念：

1. **交易事实完整性**：信号、成交、方向、开平仓价格、开平仓时间、盈亏和归因是否可信；
2. **行情窗口覆盖完整性**：所需周期 K 线是否覆盖目标时间、是否存在截断、断层或不可信时钟；
3. **路径指标可观测性**：是否能从闭合 K 线安全计算持仓期 MFE、MAE和止盈止损触达。

`calculateHoldingPathMetrics()` 在没有完整内部 K 线时返回 `partial`，`buildReviewMarketPath()` 又把路径指标 `partial` 直接等同于整段路径 `partial`，`review-workflow` 最终将其升级成 `holding_market_path_incomplete`。这使一个指标精度限制阻断了整条交易和整份日复盘。

### 3.2 正确业务语义

- 已完成归因的交易必须能够复盘“当时为什么下单、策略是否符合行情、为什么盈利或亏损、下次应如何改进”。
- 没有完整内部 K 线时，不得使用包含持仓区间外价格的边界 K 线高低点冒充精确 MFE/MAE，也不得推断止盈或止损曾被触达。
- 路径指标不可观测只应降低与持仓过程相关结论的置信度，不应抹掉信号、成交、盈亏、事前快照和交易日行情证据。
- 只有核心交易事实缺失、行情窗口真实截断/断层、终端时间不可信或来源身份不一致时，才允许阻断复盘生成。
- 自动恢复必须区分“等待后可补齐”“合同升级后可重新解释”和“永久不可恢复”状态，不能对确定性不变的输入无限小时重建。

## 4. 目标证据合同

### 4.1 三层状态分离

将持仓路径输出明确拆分为：

```text
trade_facts_status      = complete | incomplete
market_coverage_status  = complete | partial | unavailable
path_metrics_status     = complete | not_observable | incomplete
```

- `trade_facts_status=complete`：具备可信开平仓成交、方向、数量、时间、价格和已实现盈亏。
- `market_coverage_status=complete`：各要求周期覆盖目标区间，且无截断、异常缺口和时钟问题。
- `path_metrics_status=complete`：至少一根闭合 K 线完整落在持仓区间内，可输出 `bar_bounded` 精度的 MFE/MAE 等指标。
- `path_metrics_status=not_observable`：交易事实和行情覆盖完整，但持仓太短，仅有边界 K 线；允许生成复盘，但路径指标必须为 `null`，不得生成真假值或默认 `0`。
- `path_metrics_status=incomplete`：成交时间/价格缺失，或行情覆盖不足导致本应可观察的指标无法计算；仍属于阻断性证据缺失。

为避免把旧的 `partial` 同时解释成“缺数据”和“不可观测”，新增稳定原因码，例如：

```text
holding_path_intrabar_unobservable
```

该原因是能力说明，不写入 `period_review_cases.evidence_reason`，也不进入错误恢复队列。

### 4.2 短持仓降级输出

短持仓且仅有边界 K 线时，保留：

- 可信开仓、平仓时间和成交价；
- 已实现盈亏、手续费、隔夜费和成交数量；
- 持仓时长；
- 各周期行情覆盖摘要；
- 事前冻结快照、策略版本、原始信号、风险决策和订单执行事实；
- `boundary_candle_count` 和不可观测原因。

必须置空或省略：

- `max_favorable_excursion` / `max_favorable_excursion_pct`；
- `max_adverse_excursion` / `max_adverse_excursion_pct`；
- `take_profit_touched`；
- `stop_loss_touched`；
- 任何依赖边界 K 线内部事件顺序的结论。

同时输出明确能力字段：

```json
{
  "path_metrics_status": "not_observable",
  "metric_precision": "not_observable",
  "capabilities": {
    "mfe_mae": false,
    "target_touch": false,
    "intrabar_sequence": false
  }
}
```

### 4.3 模型约束

- 模型仍需评价原始信号逻辑、策略一致性、行情方向、实际盈亏原因和可执行优化建议。
- 当 `path_metrics_status=not_observable` 时，模型必须明确说明“持仓过短，M5 闭合 K 线无法精确观察持仓内路径”。
- 模型不得把边界 K 线的最高/最低价写成持仓期 MFE/MAE，不得声称止盈或止损被触达。
- 结论置信度只对“持仓内路径解释”降级；不得把整条交易统一判为 `insufficient_evidence`，除非其他核心证据也缺失。
- 后端在归一化结果中追加服务器派生的 `evidence_limitations`，记录哪些路径能力不可用；它与现有 `missing_evidence` 分开，不能迫使本来证据充分的事前决策评价变成 `insufficient_evidence`。
- 不对模型自由文本做脆弱的关键词猜测。服务端通过不提供边界高低伪指标、结构化能力字段、服务器派生限制和提示词共同约束；未来若要输出 MFE/MAE 数值，必须先增加可机械校验的结构化字段，不能从说明文字中抽取。

## 5. 代码修复设计

### 5.1 路径指标与覆盖状态解耦

修改 `server/routes/ai/review-market-path.js`：

1. 将成交事实校验从 `strictPath.length` 判断中拆出；
2. 没有完整内部 K 线、但存在可信成交边界且覆盖完整时，返回 `path_metrics_status=not_observable`；
3. 只有缺少成交时间、成交价格或行情覆盖时才返回阻断性 `incomplete`；
4. `buildReviewMarketPath()` 的总体完整性由交易事实和行情覆盖决定；`not_observable` 视为可生成状态；
5. 保持现有完整内部 K 线的 `bar_bounded` 算法不变；
6. 不使用边界 K 线高低价计算持仓期路径指标。

兼容要求：旧调用方仍能读取 `status`、`reason`、`metric_precision`，但需要增加新状态的显式处理，禁止把未知状态默认为完整。

### 5.2 交易复盘证据聚合

修改 `server/routes/ai/review-workflow.js`：

1. `assessment.complete` 不再要求所有路径指标都可观测；
2. 仅当 `trade_facts_status` 或 `market_coverage_status` 不完整时追加 `holding_market_path_incomplete`；
3. 将路径能力与不可观测原因写入冻结 evidence；
4. evidence hash 必须包含能力状态，确保旧错误证据可被新合同识别并重建；
5. 已经完整、已确认的历史交易复盘继续遵守现有冻结保护，不因本次合同升级被无条件改写。

### 5.3 日复盘模型输入与验证

修改 `server/routes/ai/period-review.js`：

1. 在 `holding_path` 中传递精简后的路径能力，不向模型发送虚假的零值；
2. 更新日复盘 v3 系统约束，明确 `not_observable` 的分析边界；
3. 在逐笔归一化结果上按 outcome 追加服务器派生的 `evidence_limitations`，不要求模型生成或复述该字段；
4. 允许模型基于成交事实、事前快照和交易日行情继续分析亏损/盈利原因；
5. 策略经验规则不得以不可观测的 MFE/MAE 或触达事件作为来源事实；这通过能力门禁和服务器派生限制控制，不通过自由文本关键词扫描实现；
6. 保持 source outcome 集合、evidence hash、版本、确认和策略记忆沉淀合同不变。

### 5.4 自动恢复分类与旧 case 收敛

调整现有维护候选和刷新判断：

- **可补齐**：真实行情缺口、数据暂不可用、成交尚未完全归因；保持有界小时复查。
- **合同可重解释**：旧证据原因为 `holding_path_bar_boundary_insufficient` / `holding_market_path_incomplete`，部署新合同后立即进入一次重建，不必等待新的 K 线改变历史事实。
- **永久不可恢复**：历史提示词或推理快照确实不存在；保持终态，不重复轮询。
- **已降级可生成**：`holding_path_intrabar_unobservable`；证据状态为 `complete`，退出恢复队列并创建正常复盘 job。

旧 case `#11` 的预期恢复路径：

```text
现有 incomplete case #11
→ worker 重建 trade case #186
→ 路径覆盖 complete、指标 not_observable
→ trade case #186 evidence_status=complete
→ period case #11 evidence_status=complete
→ 原 case 原 source 集合内创建 daily_review job
→ 模型生成 current_version
→ 页面进入待确认
```

不得新建重复 period case，不得改变 outcome、signal、trade case、period case 的业务 ID，也不需要手工 SQL 修复。

### 5.5 前端展示

修改 `public/ai/app.js` 的交易路径展示：

- 覆盖完整但路径指标不可观测时，状态显示“行情覆盖完整 · 短持仓路径指标不可精确判定”，不能显示“证据准备中”。
- MFE、MAE、触达状态显示 `--` 和原因提示，不能显示 `0`。
- “持仓 K 线”显示“无完整内部 M5 K 线”，不能把 `0 根`渲染为数据故障。
- 真实覆盖不完整时继续显示现有警告，不弱化失败关闭语义。
- 更新静态资源 build/cache key，并保留现有周期复盘前端合同握手。

## 6. 测试方案

### 6.1 纯函数与路径证据测试

扩充 `tests/ai/review-market-path.test.js`：

1. 单根边界 K 线内完成开平仓：总体可生成，指标 `not_observable`；
2. 跨两根边界 K 线但无完整内部 K 线：复现公网 5 分 20 秒案例；
3. 至少一根完整内部 K 线：保持原 `bar_bounded` MFE/MAE 结果；
4. 缺少入场或出场成交：仍为阻断性不完整；
5. K 线在入场前/出场前截断：仍为阻断性不完整；
6. 边界 K 线出现极端高低价时，不得泄漏到 MFE/MAE 或触达字段；
7. 买入、卖出、部分成交和多笔平仓均覆盖。

### 6.2 聚合与 worker 测试

扩充 `tests/ai/review-workflow.test.js` 和 `tests/ai/period-review.test.js`：

1. 三条来源中一条指标不可观测时，日复盘证据仍为 `complete`；
2. 三条来源中一条真实行情覆盖缺失时，日复盘仍被阻断；
3. 旧 boundary reason 能触发一次合同重建并收敛；
4. 重建后退出 incomplete backlog，不再每小时重复更新 hash；
5. 同一 case/source 集合只创建一个 job；
6. worker 重启、并发周期和重复 claim 不产生重复版本；
7. approved case 的冻结和记忆不被本次维护路径改写。

### 6.3 模型合同与前端测试

- 日复盘输入包含 `path_metrics_status` 和 capabilities；
- 不可观测字段不会以 `0`、`false` 等伪事实传给模型；
- 归一化结果按 outcome 带有服务器派生的 `evidence_limitations`，且不会把事前决策整体改成 `insufficient_evidence`；
- 不可观测路径不会成为经验规则的证据事实；
- 前端展示“不可精确判定”而不是“证据缺失”；
- 真实 incomplete 仍保持错误提示；
- 静态资源缓存版本测试通过。

建议验证命令：

```powershell
npx vitest run tests/ai/review-market-path.test.js
npx vitest run tests/ai/review-workflow.test.js
npx vitest run tests/ai/period-review.test.js
npx vitest run tests/ai/period-review-v3-frontend.test.js
npx vitest run tests/frontend-static-cache-version.test.js
npm test
```

## 7. 实施顺序与验收门槛

### 批次 A：证据合同与纯函数

- 先拆分覆盖状态与指标可观测性，再修改聚合逻辑。
- 验收：公网等价短持仓 fixture 可生成证据；所有路径指标保持 `null`；真实缺口仍失败关闭。

### 批次 B：周期复盘与自动恢复

- 接入模型输入能力字段、输出约束和旧原因一次性重解释。
- 验收：旧 case 使用原 ID 和 source 集合收敛到 `complete`，只创建一个 job，不重复建卡。

### 批次 C：前端语义

- 区分“覆盖缺失”和“指标不可观测”，更新静态缓存键。
- 验收：用户看到明确、非误导性的路径精度提示，空指标不显示为零。

### 批次 D：公网部署后只读验收

部署不属于本方案编写阶段。经用户明确授权部署后，检查：

1. 精确分支、提交、进程与 `/health`；
2. case `#186` 是否自动变为 `evidence_status=complete`；
3. case `#11` 是否保持原 ID 并创建唯一 job/version；
4. 模型任务是否真实发起且没有重复 attempt；
5. 页面是否显示待确认复盘和路径指标不可观测提示；
6. 连续观察至少两个 scheduler 周期，确认 case 不再回到 incomplete 或重复重建。

## 8. 非目标与保护边界

- 不降低对真实行情断层、截断、终端时钟不可信、成交缺失和归因缺失的失败关闭要求。
- 不使用 M1、tick 或推算价格伪造持仓路径；未来若产品需要精确短线 MFE/MAE，应单独设计 tick/M1 证据采集合同。
- 不修改原始信号、成交、outcome、策略、账户、订阅关系或记忆库。
- 不自动确认复盘，不自动写入策略记忆。
- 不针对 case `#11`、信号 `#24268` 或某个账户写硬编码分支。
- 不通过手工 SQL 把 `evidence_status` 强行改成 complete。

## 9. 两轮方案复审

### 第一轮：安全性与事实边界

发现的风险：若直接把边界 K 线加入计算，可以让状态变成 complete，但会把持仓前或平仓后的价格误算为 MFE/MAE，并可能产生虚假的止盈止损触达。

调整：明确采用 `not_observable`，所有依赖 K 线内部事件顺序的指标置空；总体复盘依赖交易事实和行情覆盖继续生成，不以伪造精度换取成功状态。

### 第二轮：恢复收敛与兼容性

发现的风险：仅修改新证据生成逻辑时，旧 incomplete case 仍可能等待小时维护，或者旧 reason 被持续重复重建；若直接新建 case，则会破坏唯一性和用户历史。

调整：增加旧合同原因的一次性重解释路径，复用现有 trade/period case 和 source 集合；新状态不进入错误恢复队列，并用 evidence hash、唯一 job 键和现有事务保护避免重复版本。

## 10. 剩余风险

- 没有 tick/M1 证据时，短持仓内部的真实最大波动仍不可知；这是数据分辨率限制，不应由算法猜测。
- 日复盘模型可能以自然语言变体暗示触达结论，除提示词外还需要结构化字段和输出验证共同约束。
- 旧 evidence schema 的兼容分支必须有明确版本边界，避免未来所有 `holding_market_path_incomplete` 都被错误降级为可生成。
- 公网 case 自动恢复会产生一次真实模型调用和新的复盘版本；部署验收前应确认模型额度与 provider 可用，但不能因 provider 暂时失败而回退证据状态。
