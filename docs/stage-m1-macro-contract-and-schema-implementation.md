# Stage M1 宏观合同与旁路数据库结构实施记录

> 状态：源码实施完成；旁路演练已获用户确认，但目标库权限与基础迁移链阻塞，DDL、旧数据迁移与双次演练尚未执行
> 日期：2026-09-05
> 上游决策：`stage-m0-macro-data-source-and-contract-decision.md`

## 1. 本次范围

本次只完成可离线审查和验证的 M1 源码部分：

1. 在 OpenAPI、Realtime JSON Schema 和前端 Zod 中冻结用户宏观概览、快照、序列、经济日历及小型失效事件合同。
2. 为分析策略增加显式 `macro_evidence` 配置；缺失时固定为 `off`，首版只接受 `off | context`。
3. 将 AI 宏观 reader 收紧为平台发布、兼容 schema、时间有效、数据截止不过期且不来自未来的快照，只向模型暴露 `analysis_evidence` 投影。
4. 增加平台级 `market/macro|calendar` 浏览器实时订阅；事件只携刷新所需字段。
5. 增加三份仅面向空 V4 旁路库的追加迁移：来源与观测、特征/模型/快照 lineage、经济日历。
6. 增加只读迁移目标预检，识别旧版与 V4 `inference_snapshots` 同名异构冲突。

本次没有创建 `dev_vue_next`，没有连接或修改现有 `dev_vue`，没有执行 DDL/DML、回填、外部数据抓取、Worker 启动、部署或交易指令。

## 2. 合同边界

### 2.1 HTTP

新增冻结路径：

- `GET /api/v4/market/overview`
- `GET /api/v4/market/macro-snapshots/latest`
- `GET /api/v4/market/macro-snapshots`
- `GET /api/v4/market/macro-snapshots/{snapshot_id}`
- `GET /api/v4/market/macro-series`
- `GET /api/v4/market/calendar-events`
- `GET /api/v4/market/calendar-events/{event_id}`

列表使用稳定游标，宏观快照列表不返回因子数组，overview 最多返回 20 个近期高影响事件。时间统一为 UTC `Z`，精确数值继续使用十进制字符串。

### 2.2 Realtime

- 交易端只允许无账户、无观摩频道、无 symbol/timeframe、`after_revision=null` 的 `resource_id=macro|calendar`。
- `market.source_health.changed` 只有共享校验合同；普通交易端无法订阅。管理端必须在后续带 RBAC 的 admin realtime 入口中接入。
- Redis 入站对三种平台事件执行严格字段白名单和 64 KiB 总帧限制，完整快照、因子、原始响应与错误堆栈不能进入事件。
- 服务端内部平台事件使用 `userId=null`，向已鉴权浏览器扇出时才写入该连接自己的 `scope.user_id`。

### 2.3 AI 证据

- 未配置 `macro_evidence` 的既有策略行为固定为关闭，不会因部署代码而隐式改变模型输入。
- `context` 必须声明 1 至 8 个不重复正整数 schema 版本，以及 3600 至 604800 秒的最大年龄。
- reader 只接受 `published + platform + fresh|partial + healthy|degraded`，校验完整 payload SHA-256 后，仅传递 `analysis_evidence`。
- 无兼容快照时写入明确 unavailable 状态；payload、hash 或 evidence 异常时失败关闭。

## 3. 数据结构与并发原则

- `macro_data_sources` 保存授权能力和凭据引用，不保存 API key/token/secret 明文。
- `macro_observations` 保存 `observation_at / available_at / ingested_at` 三时间和内容哈希；唯一键使同一 vintage 可幂等写入。
- ingestion 与 pipeline job 使用幂等键、lease、fencing token、短 claim 索引；后续 Worker 不得在事务中调用供应商、模型或文件存储。
- `macro_research_snapshots` 仍是唯一快照权威表；新迁移只扩展它，不创建前端或 AI 专用副本。
- 同一 horizon + business date 只允许一个未 supersede 的 published 快照；发布必须满足 cutoff <= published < valid_until。
- 日历事件只接纳供应商稳定事件 ID，不从标题或时间推导身份；供应商 revision key 可空，但事件内相同内容哈希保持幂等。
- 当前迁移文件只允许在通过预检的空 V4 旁路库依序执行，禁止在旧源库上依赖 `IF NOT EXISTS` 掩盖冲突。

## 4. 两轮复审

### 第一轮：需求覆盖与职责边界

发现并调整：

1. 仅增加 Zod 会造成 OpenAPI、Realtime Schema 和运行时三份合同漂移，因此同步补齐机器可读合同及测试。
2. 来源健康属于管理运维，不应进入普通交易端 market target，因此保留共享事件 schema，但拒绝 trade WebSocket 订阅。
3. 旧分析策略若默认读取宏观数据会产生隐式行为变化，因此编译默认值改为 `off`，`required` 暂不开放。
4. realtime 只做失效通知，完整 DTO 必须通过 HTTP 回读。

结论：用户页、管理运维、AI 输入和持久化职责已分离，没有新增第二条浏览器 WebSocket 或宏观专用持久化副本。

### 第二轮：数据、并发、异常、安全与回滚

发现并调整：

1. reader 原设计未显式拒绝未来 cutoff，已增加 `data_cutoff_at_utc<=now` 和数据库发布时间序约束。
2. JSON 解析错误原本会泄漏底层异常，已统一转为稳定机器码 `macro_snapshot_payload_invalid`。
3. 经济日历不能为兼容弱供应商而从标题拼 ID；无稳定 ID 的记录只保留为 ingestion evidence，不提升为正式事件。
4. 可空供应商 revision key 会削弱唯一键，已增加 `(event_id, content_sha256)` 幂等唯一键。
5. 迁移前置脚本只读取显式 `V4_MIGRATION_TARGET_*`，并在只读事务中核对目标、迁移历史和关键同名表指纹；不会自动回退到现有服务端数据库配置。

结论：源码层已覆盖同名表冲突、未来数据、载荷篡改、非法平台 scope、重复内容和秘密泄漏风险。真实 MySQL DDL、锁行为、两次迁移一致性、逐用户对账与回滚仍需旁路演练证明。

## 5. 验证证据

- M1 定向：6 files / 21 tests passed。
- 共享 contracts：4 files / 36 tests passed；contracts typecheck passed。
- 既有 realtime 回归：4 files / 33 tests passed。
- 全部 V4 server tests：40 files / 245 tests passed；server typecheck passed；V4 server build passed。
- 四应用前端边界检查、全工作区 tests、typecheck 与 production build passed。
- 根测试：252 files / 3627 tests passed，2 tests failed。失败均位于既有 Bridge 发布 PowerShell 测试，原因是当前测试子进程无法识别 `Get-FileHash`；与本次宏观文件无调用或差异关系。
- `git diff --check` passed；两份 JSON 合同可解析且本地 `$ref` 无缺失；Realtime Draft 2020-12 schema 可由 Ajv 2020 编译。

以上均为本地源码、Mock 和静态迁移合同证据，不代表真实 MySQL、Redis、供应商、PM2 或公网已验收。

## 6. M1 剩余项与下一确认门

M1 仍未完成的真实数据工作：

1. 明确授权后创建空 V4 旁路目标库。
2. 对目标运行只读预检，再依序执行 V4 迁移至 017。
3. 从同一只读源快照运行两次迁移，核对 schema checksum、逐用户/账户计数、稳定主键、关键金额和大载荷 SHA-256。
4. 演练停止、恢复和回滚；任何差异先修迁移工具，不修改源库。

用户已确认上述旁路演练。后续只读检查发现当前账号仅有源库权限，且 001～017 缺少三个基础表的建库前置阶段；详见 [旁路数据库演练前置检查](./stage-m1-sidecar-rehearsal-preflight.md)。补齐前不得执行目标迁移；供应商试用、采集 Worker 和管理端数据写入仍不在本阶段范围。
