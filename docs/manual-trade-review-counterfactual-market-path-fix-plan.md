# 手动交易复盘反事实行情路径修复方案

## 1. 文档状态

- 文档类型：生产故障诊断后的实施方案
- 编写日期：2026-08-24
- 代码基线：`dev_codex` / `5714e6794e57ab26895cdd85a1160729b9e57df8`
- 生产基线：虚拟机 `/www/wwwroot/aurum-ai` 已核对为同一提交
- 当前授权：已授权本地代码修复；未授权提交、推送、部署、重启、数据库改写或生产任务重试

本方案只处理手动交易复盘 v3 的反事实行情取数、终端时区 K 线边界、确定性失败重试和前端错误展示，不改变策略逻辑、复盘结论合同或真实成交筛选规则。

## 2. 结论摘要

当前手动交易复盘不是模型生成异常，而是在模型调用前被两个行情合同缺陷阻断。

| 编号 | 已确认问题 | 当前影响 |
|---|---|---|
| MTR-01 | 反事实候选点为避免事后信息泄漏而传入 `deals: []`，但 `buildReviewMarketPath()` 仍强制从成交中取得入场时间 | 盲测行情固定返回 `holding_deal_times_missing`，候选点为空 |
| MTR-02 | H4/D1 最新已收盘 K 线边界按纯 UTC 对齐，没有使用已验证的终端时区偏移 | UTC+3 终端的 H4 正常 K 线被误判为 `truncated_before_exit` |
| MTR-03 | 冻结证据缺少候选点是确定性错误，worker 却按普通错误重试到 3/3 | 同一份不可变证据被重复处理，延迟约两分钟后才失败 |
| MTR-04 | 前端没有该失败码的明确中文说明，并仍提供普通“重试生成” | 用户无法判断模型其实没有被调用；旧 Case 重试仍使用原冻结证据，必然再次失败 |
| MTR-05 | 单元测试 mock 了不会检查 `deals` 的 `buildPath`，且边界测试只覆盖 UTC | 测试通过但真实函数组合必现失败 |

修复必须继续保证反事实阶段看不到真实方向、成交价、盈亏、止损止盈和退出结果。不能用“把真实成交重新传回盲测函数”作为捷径。

## 3. 生产证据

### 3.1 当前失败任务

- Case：`manual_trade_review_cases.id = 1`
- 创建时间：2026-08-24 14:00:19
- 结束时间：2026-08-24 14:02:46
- Case 状态：`failed`
- Job 状态：`failed`
- 尝试次数：3/3
- 最终错误：`manual_trade_review_counterfactual_points_unavailable`
- `model_task_id`：空
- 阶段任务：0 条
- 生成版本：0 条

因此本次故障发生在模型解析和模型任务创建之前，不是供应商 524、模型配额、流式响应或输出格式问题。

### 3.2 冻结行情证据

- 终端时区偏移：`+180` 分钟，时钟状态 `verified`
- 主周期：M5
- M5/M15/H1 开仓前行情：完整
- H4 开仓前行情：被判为 `truncated_before_exit`
- 持仓结果路径：四个周期均完整
- 反事实候选点：0 个
- 冻结证据状态：`partial`

真实入场时间为 2026-08-21 04:47:27 UTC。H4 最近已收盘 K 线实际开盘时间为 2026-08-20 21:00:00 UTC，对应 UTC+3 终端的 00:00。现有算法按 UTC 边界期待 2026-08-21 00:00:00 UTC，因此产生了正好 3 小时的错误截断判断。

### 3.3 本地真实函数复现

对 `buildReviewMarketPath()` 使用相同的行情数据：

- 携带成交事实：能取得 100 根 K 线；
- 使用反事实要求的 `deals: []` 和有效 `asOfUtcMsc`：取得 0 根 K 线，原因是 `M5:holding_deal_times_missing`。

这证明问题来自两个真实函数之间的参数合同不一致，而不是生产行情偶发缺失。

## 4. 修复目标与非目标

### 4.1 目标

1. 反事实候选点可以仅凭冻结截止时间读取当时已收盘行情，不依赖真实成交事实。
2. H4/D1 等非整除终端时区偏移的周期按可信终端时区判断最新已收盘 K 线。
3. 反事实模型输入继续隔离真实交易方向、价格、保护参数、盈亏和退出结果。
4. 冻结证据确定性无效时一次失败并明确告知用户，不进行无意义业务重试。
5. 前端区分“重新生成同一冻结证据”和“重新读取行情并创建新 Case”。
6. 使用真实函数组合测试覆盖本次生产故障。

### 4.2 非目标

- 不修改最近 7 天、盈利单、完整平仓、未绑定平台信号、单笔选择等业务规则。
- 不改变策略 `market_data_plan`、周期顺序、缠论启用状态或模型提示词决策逻辑。
- 不降低行情完整性、连续性、终端时钟和来源哈希校验。
- 不把真实交易结果或真实入场方向暴露给反事实模型。
- 不修改 Bridge 协议或发布新的 Bridge 客户端。
- 不新增数据库表或迁移，不回写或删除旧 Case。
- 不顺带修改日复盘、月复盘、策略记忆或自动交易链路。

## 5. 必须保持的安全合同

1. `trade_path` 模式继续使用冻结成交事实计算持仓路径、MFE/MAE、目标触达和保护质量。
2. `cutoff_snapshot` 模式只能使用标的、周期、可信时区、冻结截止时间和策略要求的行情窗口。
3. `cutoff_snapshot` 模式要求 `deals` 为空，且不计算持仓指标；不得静默回退到真实成交。
4. 每个候选点只允许看到其 `decision_time_utc_msc` 之前已经收盘的 K 线。
5. 真实入场时间只用于服务端生成候选点位置，不作为模型可见证据字段。
6. 冻结 Evidence、Case、Source 和旧失败状态保持不可变；重新取证必须创建新 Case。
7. 原有幂等键、generation fence、租约和模型任务审计合同保持不变。

## 6. 实施批次 A：增加截止时间行情快照模式

修改 `server/routes/ai/review-market-path.js`。

### 6.1 显式模式

为 `buildReviewMarketPath()` 增加向后兼容的显式模式：

```text
pathMode = trade_path       # 默认，保持现有行为
pathMode = cutoff_snapshot  # 新增，只构建截止时间行情快照
```

`cutoff_snapshot` 的输入合同：

- `asOfUtcMsc` 必填且必须为有效正整数；
- `deals` 必须为空；
- `includeHoldingMetrics` 必须为 `false`；
- 每个周期的读取窗口由截止时间和既有 context/Chan window policy 推导；
- 无效组合返回稳定错误，不自动降级为 `trade_path`。

不要仅凭 `deals.length === 0` 猜测模式，避免其他调用方被静默改变语义。

### 6.2 窗口计算

在 `cutoff_snapshot` 中，每个周期独立计算：

```text
window_end   = asOfUtcMsc
context_bars = Chan target 或现有最小上下文策略
window_start = window_end - context_bars * timeframe_interval
```

仍通过 `loadPeriodMarketWindow()` 和现有严格市场时段/连续性策略读取数据。只保留满足下式的 K 线：

```text
candle_open_utc_msc + timeframe_interval <= asOfUtcMsc
```

该模式的状态语义：

- `trade_facts_status = not_applicable`
- `path_metrics_status = not_evaluated`
- 总体 `status` 只由行情覆盖、连续性、时钟和启用的缠论数据完整性决定
- 不因缺少成交事实被降级为 `partial`

### 6.3 调用点

修改 `server/routes/ai/manual-trade-evidence.js`：

- 初始候选序列窗口调用 `pathMode: cutoff_snapshot`；
- 每个候选点独立行情调用 `pathMode: cutoff_snapshot`；
- 保持 `deals: []`、`signal_type: hold`、`includeHoldingMetrics: false`；
- 开仓前真实路径和持仓结果路径继续使用默认 `trade_path`，不得被本批次改变。

## 7. 实施批次 B：按终端时区对齐 K 线边界

修改 `expectedLatestClosedOpen()`，增加可选的可信时区偏移参数，默认值为 0，保持旧调用兼容。

边界计算应使用：

```text
offset_ms = timezone_offset_minutes * 60_000
latest_closed_open = floor((cutoff_utc + offset_ms) / interval) * interval
                     - interval - offset_ms
```

调用时优先使用行情响应 `market_meta.timezone_offset_minutes`，缺失时使用本次冻结且已验证的终端偏移。不得硬编码 UTC+3。

验证要求：

- M5/M15/H1 在整小时偏移下与现有结果一致；
- UTC+3 的 H4 在 21:00/01:00/05:00 UTC 等真实开盘边界上不误报截断；
- D1 按终端日界线判断；
- 无可信偏移时继续失败关闭，不伪造完整证据；
- 夏令时或偏移变化只能使用本次行情响应/冻结证据中的可信值，不能读取浏览器本地时区。

## 8. 实施批次 C：确定性失败与重新取证

修改 `server/routes/ai/manual-trade-review.js`。

### 8.1 错误分类

将以下冻结证据错误明确设为不可自动重试：

- `manual_trade_review_counterfactual_points_unavailable`

理由是同一 generation 的 `evidence_json` 不可变，重新领取 worker 不会获得新行情或新候选点。该错误应在第一次尝试后进入最终 `failed`，清空租约和 `next_attempt_at`，保留错误码和审计记录。

供应商瞬时失败、明确可安全重试的模型错误和租约等待继续使用现有重试合同；不得把所有失败都改成一次终止。

### 8.2 旧 Case 行为

现有 Case `#1` 已冻结了空候选点。部署代码后点击普通“重试生成”仍只会启动新 generation，不会重建 Evidence，因此不能恢复。

本轮不改写 Case `#1`，也不在重试接口中偷偷替换 Evidence。正确处理是：

1. 保留 Case `#1` 作为失败审计记录；
2. 部署后重新读取交易历史；
3. 由用户重新选择交易并创建新的 `client_request_id` 和新 Case；
4. 新 Case 使用修复后的行情路径生成候选点。

### 8.3 前端动作

修改 `public/ai/app.js`：

- 为 `manual_trade_review_counterfactual_points_unavailable` 增加明确中文说明；
- 文案必须说明“冻结的候选行情不完整，本轮未调用模型”；
- 对该错误不显示普通“重试生成”，显示“刷新交易历史并重新创建”；
- 点击后返回候选选择区、清空旧选择令牌和已选交易、保留策略与用户论点；
- 不自动提交创建请求，必须由用户重新确认；
- 其他真正可重试的失败继续显示原“重试生成”。

更新 `public/ai/index.html` 的静态资源版本键，避免浏览器继续使用旧脚本。

## 9. 测试方案

### 9.1 行情路径单元测试

修改 `tests/ai/review-market-path.test.js`：

1. `cutoff_snapshot + deals: [] + 有效截止时间` 可以取得完整闭合 K 线。
2. `cutoff_snapshot` 不计算或要求 trade facts/holding metrics。
3. `cutoff_snapshot` 缺截止时间、携带成交或开启 holding metrics 时失败关闭。
4. 候选点截止后的 K 线不会进入结果。
5. 默认 `trade_path` 的现有行为不变。
6. UTC+3 H4 正常边界不被标记为截断。
7. UTC+3 D1 和 UTC/M5 回归。
8. 响应时区优先于回退时区，并且必须为可信整数偏移。

### 9.2 真实函数组合测试

修改 `tests/ai/manual-trade-review-counterfactual-evidence.test.js`：

- 不再只用“永远成功”的 `buildPath` mock 覆盖主成功路径；
- 使用真实 `buildReviewMarketPath()`，只 mock `loadPeriodMarketWindow()` 的行情边界；
- 断言初始序列和每个候选点调用均为 `cutoff_snapshot`、`deals: []`；
- 断言能够生成完整、唯一、按固定顺序的候选点；
- 断言候选证据中不存在真实方向、入场价、退出价、盈亏、止损止盈或退出时间；
- 断言 H4 使用 UTC+3 时仍能得到完整候选点。

### 9.3 Worker 与前端测试

- 冻结候选点缺失时只消费 1 次业务 attempt，模型任务和供应商 attempt 都为 0。
- 普通瞬时模型失败仍按原合同重试，不受错误分类影响。
- 前端显示中文根因和“刷新交易历史并重新创建”。
- 该动作不调用 retry API、不自动重放创建 POST，并保留策略和用户论点。
- 其他 failed Case 仍显示原有人工重试按钮。
- 静态资源版本测试同步更新。

### 9.4 回归范围

- `tests/ai/review-market-path.test.js`
- `tests/ai/manual-trade-review-counterfactual-evidence.test.js`
- `tests/ai/manual-trade-review.test.js`
- `tests/ai/manual-trade-review-history.test.js`
- `tests/ai/manual-trade-review-frontend.test.js`
- `tests/ai/frontend-governance.test.js`
- 手动复盘 v3 合同、阶段任务和恢复相关测试
- 项目全量 Vitest；环境依赖失败必须单独说明，不能用专项通过代替全量结果

## 10. 实施顺序

1. 先完成批次 A 和真实函数组合测试，证明空成交盲测能取得截止时间行情。
2. 完成批次 B 和 UTC+3 H4/D1 边界测试。
3. 完成批次 C 的错误分类、前端动作和测试。
4. 运行语法检查、`git diff --check`、专项测试和全量回归。
5. 复核完整 diff，确保未改策略、Bridge、数据库迁移和其他复盘类型。
6. 提交/推送 `dev_codex`、虚拟机部署、服务重启分别取得授权。
7. 部署后先做只读健康和提交核验，再由用户重新创建一条新 Case 做写入型验收。

建议一个原子提交完成 A/B/C，因为三者共同构成“候选行情可用”的完整闭环；若只发布 A，H4 仍可能阻断；若只发布 B，空成交模式仍必然失败。

## 11. 部署后验收

### 11.1 只读验收

- 虚拟机分支和提交与预期一致，工作树无意外修改。
- `/health` 返回应用、数据库、Redis 正常。
- 页面 HTML 引用新的 AI 脚本版本键。
- 服务启动日志没有迁移、未捕获异常或重启循环。
- Case `#1` 保持失败审计状态，没有被代码发布自动改写。

### 11.2 写入型验收（需单独授权）

1. 刷新手动交易历史并重新选择同一笔可复盘交易。
2. 创建一个新的 Case，不复用 Case `#1`。
3. 检查新 Evidence：候选点数量符合固定策略，所有候选点行情状态完整。
4. 检查 H4 不再出现纯时区错位造成的 `truncated_before_exit`。
5. 确认业务 job 进入模型阶段，且只创建预期的阶段模型任务。
6. 对照模型后台确认真实请求次数与阶段任务一致。
7. 最终生成一个可读取版本，前端自动进入真实终态。
8. 核对没有策略、记忆、订单或 Broker 状态副作用。

## 12. 回滚与数据边界

- 预计无数据库迁移；代码可以按提交回滚。
- 回滚不得删除 Case、Job、Source、Stage Run、Model Task 或 Version。
- 新模式是显式 opt-in，其他调用方默认仍走 `trade_path`。
- 若生产新 Case 仍因真实行情缺失失败，保留证据和错误码后停止验收，不通过放宽完整性校验获得成功。
- Case `#1` 不需要数据修复；它记录了修复前的真实失败。

## 13. 第一轮复审：反事实隔离与最小改动

### 13.1 初始风险

最直接的修法是把真实成交明细重新传给候选点行情函数，以满足 `holding_deal_times_missing`。虽然行情函数本身不直接调用模型，但这会模糊反事实阶段的输入边界，并可能让未来新增字段或日志把真实方向、价格和结果带入候选证据。

### 13.2 调整

- 不恢复真实成交参数。
- 增加显式 `cutoff_snapshot` 模式，用截止时间和有界行情窗口完成取数。
- 模式要求空成交、关闭持仓指标，并把 trade facts 标记为不适用。
- 默认模式保持不变，不重构日/月复盘行情链路。

### 13.3 结论

调整后的方案修复真实合同不匹配，同时强化而不是削弱反事实信息隔离。

## 14. 第二轮复审：时区、重试和旧数据

### 14.1 新发现

只修复空成交模式仍不够。生产冻结证据显示 UTC+3 H4 被按纯 UTC 边界误判，候选点路径仍会因此变为 `partial`。另外，普通 retry 只增加 generation，不重建 Evidence，所以 Case `#1` 部署后仍无法通过重试恢复。

### 14.2 调整

- 将可信终端时区纳入最新已收盘 K 线边界计算，并增加 H4/D1 测试。
- 将冻结候选点缺失分类为一次性终止，避免消费 3 次业务 attempt。
- 对该错误将前端动作改为重新读取历史并创建新 Case，不复用旧冻结证据。
- 保留 Case `#1`，不使用迁移或脚本改写生产记录。

### 14.3 结论

方案现在覆盖真实取数、跨周期边界、状态机、用户恢复动作和历史审计，可进入实施阶段；三个批次必须作为同一闭环验收。

## 15. 剩余风险

1. 修复代码缺陷后，真实市场缓存仍可能因终端断线、历史未同步或交易时段缺口而合法失败；系统必须继续失败关闭。
2. Broker 夏令时变化可能使较长历史窗口存在不同偏移。本功能当前只选择最近 7 天，但仍应优先使用响应中的可信时区证据。
3. D1/H4 的 Broker 会话边界可能存在券商特例；若市场元数据已有更权威的 period boundary，应优先复用而不是继续扩展通用公式。
4. 缠论窗口比普通指标需要更多历史，`cutoff_snapshot` 必须继续使用现有 Chan window policy，不能固定成 80 根。
5. 新 Case 会生成新的冻结哈希和审计链；不得把修复前 Case 与新 Case 合并。
6. 前端恢复动作需要新的选择上下文令牌，不能沿用旧令牌或自动替用户确认。

## 16. 完成定义

只有同时满足以下条件，才可宣称修复完成：

- `cutoff_snapshot` 在空成交条件下取得完整且严格截止的行情。
- 反事实模型输入没有真实方向、价格、盈亏、保护参数和退出结果。
- UTC+3 H4/D1 不再因纯 UTC 对齐而误报截断。
- 新 Case 能生成候选点并创建预期模型阶段任务。
- 冻结候选点缺失只失败一次，前端不再提供无效的同 Case 重试。
- 专项测试和全量回归结果已记录。
- Case `#1` 和其他历史数据保持不变。
- 提交、推送、部署、重启和写入型生产验收均在各自授权范围内完成。

## 17. 本地实施记录

2026-08-24 已完成方案中的本地代码批次 A/B/C：

- 增加显式 `cutoff_snapshot`，候选序列与候选点均使用空成交、截止时间和已闭合 K 线构建行情证据；
- 使用行情响应中的可信终端时区偏移计算 H4/D1 最新已闭合 K 线，缺失时回退到冻结偏移；
- 将 `manual_trade_review_counterfactual_points_unavailable` 设为当前 Case 的确定性终止错误；
- 前端对该错误改为刷新历史并重新创建 Case，同时保留策略和用户论点；其他临时性错误继续走原重试合同；
- 语法检查与 `git diff --check` 通过；手动复盘专项回归 299/299 通过；排除既有 Bridge 发布工具环境测试后，全项目 3484/3484 通过；
- 未修改数据库、Case `#1`、虚拟机服务或生产任务，未提交、推送或部署。

完整 `npm test` 为 3506/3508；仅 `tests/bridge-release-tool.test.js` 的 2 项测试因当前 Windows 子进程无法识别 `Get-FileHash` 失败，与本次手动复盘改动无关。新 Case 的生产写入型验收仍须在部署后另行授权。
