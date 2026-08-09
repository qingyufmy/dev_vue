# 量见智桥选择性历史同步最终优化方案

> 文档状态：原选择性同步方案已实施；2026-08-09 的账户历史范围决策以第 0 节修订为准
>
> 适用仓库：`D:\dev_codex\wall-street-skill-local`
>
> 基线分支：`dev_codex`
>
> 基线提交：`c636eb9a90d3220ec31a46ce3751cbf8a64f48c9`
>
> 关联文档：`docs/bridge-3.0.0-account-initialization-history-isolation-optimization-plan.md`
>
> 优先级：本文件是历史策略的最终收敛版本。与关联文档中“默认持续 P3 回填到 2000-01-01”“普通用户账户生命周期全量历史”冲突的内容，以本文件为准；已经实现的 Live/Archive 隔离、范围 coverage、复合游标、租约、事务提交、状态降噪和命令安全合同继续保留。
>
> 授权边界：本文件只定义优化方案，不授权修改业务代码、构建安装器、上传七牛云、切换下载接口、部署虚拟机或部署公网服务器。

## 0. 2026-08-09 账户历史范围最终修订

用户确认同一“经纪商服务器 + 登录账号”的 MT5 账户只归属一个实际账户主体，平台账号重新绑定不应截断该交易账户自身的历史。该业务决定取代本文后续章节中“默认最近 7 天”“全部历史映射到当前归属期”和“自定义范围不得早于当前归属期”的旧产品定义；后续章节保留为选择性同步架构的历史设计记录。

最终普通历史页面提供三种范围：

| 模式 | 范围 | 页面行为 |
| --- | --- | --- |
| `all`（默认） | Bridge 原生历史下界 `2000-01-01T00:00:00Z` 至一次捕获的固定结束点 | 缺失范围由 Archive Worker 异步补齐，页面等待并自动刷新，不阻塞实时链路 |
| `platform` | `mt5_account_bindings.first_connected_at` 至固定结束点 | 账号重新绑定不重置首次接入时间 |
| `custom` | 用户选择的 UTC 日期半开范围 | 按需异步补齐，允许早于当前平台归属期 |

安全边界没有取消：每次请求仍必须通过当前用户、当前有效账号绑定、唯一终端路由及 `broker_server + login` 身份校验；重新绑定只改变谁能发起请求，不改变同一交易账号的历史起点。旧用户的订阅、自动推理和交易发送仍在接管时立即停止。MT4 使用相同页面选项，但“全账户历史”只代表 MT4 终端“账户历史”页当前可见并可同步的全部记录，页面必须继续提示用户选择“全部历史记录”。

### 修订第一轮复审：需求、范围和最小改动

- 完整性优先于默认最近范围，默认值改为 `all`，避免“无记录”被误解为账户没有历史。
- 复用既有精确范围、P1 规划、Archive Worker、coverage 和游标，不恢复无边界 WebSocket 响应，也不新增数据库表。
- `platform` 使用账号级 `first_connected_at`，不得回退到当前 `ownership.started_at`；`all` 与 native Store 的历史下界使用同一常量。
- 当前绑定和路由继续承担授权，因而账户换绑不会造成跨账号读取。

第一轮结论：仅调整产品范围解析、默认 UI 和续页校验，保留异步同步与 Live/Archive 隔离，没有重新引入一次性全量响应。

### 修订第二轮复审：时间、兼容、并发、恢复和测试

- `all`、`platform` 和 `custom` 都固定同一次请求的 UTC 半开区间；重试、图表和游标续页必须复用完全相同的起止点。
- `all` 起点严格等于 `946684800000`；`platform` 起点依次取 binding 首次接入、账户首次验证、binding 创建时间，缺失或非法时失败关闭。
- 不需要数据迁移；已有绑定的 `first_connected_at` 保持不变，重新绑定不重写起点。
- 首次大范围同步可能较慢，但只运行 Archive 路径；实时账户、持仓、挂单、行情和交易命令不等待历史完成。
- 回归测试必须覆盖默认 `all`、较晚 ownership 不改变 all/platform 起点、固定范围重试、游标续页、MT4 提示和静态资源缓存更新。

第二轮结论：修订后的范围语义可在无迁移情况下实施，继续失败关闭身份和游标异常；剩余验收风险是首次大账户全历史准备耗时，需要真实 MT4/MT5 数据观察，不能用单元测试代替。

## 1. 最终结论

量见智桥不需要、也不应该默认获取 MT4/MT5 账户从开户至今的全部交易记录。最终采用以下四层历史模型：

1. **实时最小初始化**：账户身份、终端状态、账户/持仓/挂单快照和必要命令核对完成后立即进入本地可运行状态，不等待历史。
2. **最近历史 P2**：实时链路稳定且没有活跃交易压力时，低优先级同步最近 7 天，提供常用页面和近期证据的快速本地读取。
3. **按需范围 P1**：用户查看、统计、复盘、结果归因或导出哪个精确范围，只补该范围尚未覆盖的空洞。
4. **可选归档 P3**：只有用户明确发起“建立当前归属期历史档案”时才执行；默认不创建、不领取从 2000 年开始的自动回填任务。

所有普通用户历史必须受当前账户精确归属期约束。“全部历史”在普通用户界面中重新定义为“当前归属期全部”，不能读取或统计当前用户接管前的数据。账户生命周期审计属于独立高权限能力，不进入普通历史页面、收益统计、运营汇总或全局风控。

本方案的核心不是让全量同步跑得更快，而是让 Bridge 只做业务真正需要的历史工作，并保证任何历史工作都不能影响实时交易链路。

## 2. 当前基础与需要收敛的问题

### 2.1 已具备且继续复用

- Live Worker 与 Archive Worker 使用独立 Registry/Supervisor，Archive 不具备交易能力。
- 历史范围使用 UTC 半开区间 `[start, end)`、复合游标、动态窗口、持久化 Job、租约 generation 和 coverage。
- 历史响应按条数和字节预算限制，失败或超时不推进 coverage。
- P1 可在批次边界优先于 P2/P3；常规历史任务在存在持仓或挂单时暂停。
- 账户初始化、实时 Ready、服务器命令 Ready 和历史状态已经拆分。
- 服务端已经能够消费 `requested_range_complete`，不再只依赖全局 `complete`。

### 2.2 必须修正

1. 当前调度器仍会在最近历史后自动创建 P3，逐段回填到 2000-01-01。
2. 服务端 `history_scope=all` 没有开始时间，可能跨越当前账户归属期。
3. `platform` 范围只传日期，接管当天会向前扩大到 UTC/业务日零点，不能实现精确归属隔离。
4. 页面、图表、统计和导出分别捕获当前时间，可能产生只差数毫秒的重复 P1 范围。
5. P1 只提升完全相同的范围，重叠范围不能自动复用正在同步的部分。
6. 历史表格翻页仍会重复计算整段统计，并与 Outbox、命令回执和采集写入争用同一个 SQLite 连接。
7. 信号结果对账仍先读取最多 25 页普通历史，再从中寻找证据。
8. 历史导出最多读取 50 页并把真实页数静默压到 50，超过 10,000 条时会生成不完整文件。
9. 历史证据按 `order_ticket` 查询，但 SQLite 缺少对应复合索引。
10. 已安装 3.0.0 不会自动接受目标版本仍为 3.0.0 的更新对象。

## 3. 必须保护的合同

1. Bridge 不启动、关闭、登录或切换 MT4/MT5；退出、暂停、更新和卸载 Bridge 不得关闭交易终端。
2. 交易命令、`query_execution`、账户/持仓/挂单快照和命令结果核对继续使用 Live 路径，不能进入批量历史队列。
3. Archive Worker 只能协商历史读取和 shutdown 能力，不能获得 `ExecuteCommand`、`QueryExecution`、Quote、Data 或 Snapshot。
4. SQLite 是按 Profile 隔离的可重建本地读模型和证据缓存，不是经纪商交易真相。
5. 历史记录继续按 `terminal_instance_id + broker_server + login_account` 隔离；服务器展示和统计再按精确用户归属期裁剪。
6. 当前用户接管前的数据不得进入其页面、导出、收益、风控、运营汇总或 AI 复盘。
7. 只有 MT 源查询、响应边界校验和 SQLite 原子事务全部成功后，范围才能写入 coverage。
8. 失败、超时、进程退出、磁盘错误、SQLite Busy、旧 generation 或账户切换均不得推进 coverage。
9. 内部范围和游标统一使用 UTC 毫秒；终端业务日展示继续使用已验证的终端服务器时差。
10. 不提高 WebSocket 包上限，不用清库、扩大超时或无限重试掩盖历史问题。
11. 旧服务器和旧 Bridge 的兼容逻辑必须显式、失败关闭，不得静默扩大读取范围。
12. 日志、状态和导出任务不得泄露登录号、Broker Server、终端路径、凭据或完整交易内容。

## 4. 产品范围定义

### 4.1 历史模式

| 模式 | 对用户的含义 | 范围 | 是否自动同步 |
| --- | --- | --- | --- |
| `recent` | 最近历史 | 固定结束点前 7 天，并与当前归属期取交集 | 是，P2，实时空闲时 |
| `ownership` | 本次接入以来 | 精确 `ownership_started_at_utc_msc` 至固定结束点 | 否，用户进入该范围后按需 P1 |
| `custom` | 自定义日期/时间 | 用户范围与当前归属期取交集 | 否，按需 P1 |
| `archive` | 建立当前归属期档案 | 当前精确归属期至固定结束点 | 否，用户明确确认后 P3 |
| `lifecycle_audit` | 账户生命周期审计 | 独立审计权限和独立数据用途 | 不属于普通 Bridge 历史功能 |

兼容输入 `history_scope=platform` 映射到 `ownership`。兼容输入 `history_scope=all` 对普通用户也必须映射到 `ownership`，不能恢复为无开始边界的账户生命周期查询。

### 4.2 默认界面

- 历史页面默认选择“最近 7 天”，打开页面不触发多年 P1。
- “本次接入以来”由用户主动选择；范围较大时先显示预计工作量和同步状态。
- “自定义”必须有有效起点，实际起点不得早于当前精确归属开始时间。
- “建立历史档案”是单独动作，不与普通页面刷新、图表或导出按钮混用。
- MT4 明确提示其可见历史受终端“账户历史”加载范围限制，不能承诺经纪商全量。

## 5. 精确归属期和时间合同

### 5.1 精确边界

服务器从 `mt5_account_ownership_history.started_at`，必要时回退 `trading_accounts.first_verified_at`，生成：

```text
ownership_start_utc_msc
request_end_utc_msc
```

Bridge 查询的有效范围为：

```text
[max(user_requested_start, ownership_start_utc_msc), request_end_utc_msc)
```

禁止使用 `DATE_FORMAT(..., '%Y-%m-%d')` 作为唯一归属边界。日期仍可用于 UI 输入，但服务端必须转换成 UTC 毫秒并与精确归属时间取最大值。

### 5.2 能力协商

新增可选能力标志，例如：

```text
history_exact_range_v1
history_cursor_v1
history_evidence_v1
```

- 新 Bridge 支持精确毫秒范围和稳定游标。
- 旧 Bridge 不支持精确边界时，服务器不得向普通用户开放无边界 `all`。
- 对发生过账户换绑、归属起点不是安全日期边界的旧 Bridge，服务端历史统计和导出失败关闭，并提示升级 Bridge；不能只过滤页面行却继续信任包含接管前数据的统计。
- 新字段均为可选，旧服务器忽略；新服务器按能力选择协议，保证灰度期间新旧 Bridge 可同时连接。

## 6. 固定快照和分页合同

### 6.1 历史快照

同一轮页面、图表、统计或导出必须共享一个固定快照：

```json
{
  "history_snapshot_id": "opaque",
  "range_start_utc_msc": 1783526400000,
  "range_end_utc_msc": 1786176000123,
  "coverage_revision": "opaque",
  "next_cursor": "opaque"
}
```

- `history_snapshot_id` 不包含账户、终端、Broker 或路径明文，由服务器签名或保存在有界服务端状态中；客户端提供的未验证范围字段不能恢复成可信快照。
- 快照绑定用户、Profile、终端、账户、精确范围和筛选条件摘要。
- 快照同时绑定账户归属记录的版本/更新时间；归属切换后旧快照不能继续读取。
- Page、Summary、Chart 和 Export 必须复用同一 `range_end_utc_msc`。
- 用户点击刷新才创建新快照；普通翻页不能移动结束点。
- 账户、终端、connection epoch、归属期或筛选条件变化时，旧快照立即失效。
- `coverage_revision` 是规范化 coverage 范围及其更新时间的脱敏摘要，不得只使用请求结束点代替；同一范围新增 coverage 后必须产生新 revision，使 Summary/Chart 缓存正确失效。

### 6.2 游标分页

- 新协议优先使用 `(event_time_msc, item_id)` 复合游标，不再用深层 OFFSET。
- 响应保留旧 `pagination.current_page/page_size/total_count/total_pages` 字段，供旧 UI 兼容。
- 新 UI 顺序翻页保存每页首尾游标；导出只能使用游标。
- 随机跳页在没有已知游标时可以走受限兼容路径，但必须限制最大页深度，不能允许页码 1,000,000 形成高成本查询。
- 快照范围内新增数据不会进入旧快照，避免翻页重复、前移或漏项。

## 7. 调度器最终模型

### 7.1 优先级

| 优先级 | 用途 | Worker | 交易活跃时 |
| --- | --- | --- | --- |
| P0 | 命令核对、精确执行状态 | Live | 不暂停 |
| P1 | 用户请求范围、信号结果所需范围 | Archive | 可执行，但必须受全局单并发和超时保护 |
| P2 | 最近 7 天 | Archive | 暂停 |
| P3 | 用户明确建立当前归属期档案 | Archive | 暂停 |

### 7.2 取消默认全量回填

- `ensure_history_jobs()` 只自动规划 P2 recent，不再自动规划从 recent 边界向 2000 年推进的 backfill。
- 新的显式归档任务复用现有 `job_kind=on_demand`，但使用 P3 优先级；P1 用户即时范围与 P3 归档范围由优先级和请求来源区分，不复用旧 `backfill` 语义。
- 现有数据库中已经存在的 `job_kind=backfill` 行不删除、不改写、不重置游标。
- 新客户端领取任务时显式传入允许的 job kind，只领取 `recent` 和 `on_demand`；旧 backfill 行保持惰性。
- 不扩展 `history_sync_jobs.job_kind` 的现有 CHECK 约束，避免为了一个调度标签重建 SQLite 表。
- 回滚旧客户端后，旧代码仍可识别并继续原 backfill 行，避免迁移破坏回滚。

### 7.3 重叠范围合并

创建 P1/P3 前，在一个一致性读/事务中计算：

1. 已完成 coverage。
2. 同 scope 已 queued/retrying/running 的允许任务范围。
3. 当前请求真正未覆盖、未在途的空洞。

处理规则：

- completed coverage 始终从请求中扣除。
- 对同优先级 P1/P1 或显式 P3/P3 的在途重叠范围，附着等待并避免重复任务；在途任务失败、blocked、superseded 或租约失效后，重新根据 coverage 计算空洞。
- 对 P1 与正在运行的 P2/P3 重叠部分，不能因为低优先级任务“正在处理”就让用户等待其完整大范围；仍可创建请求所需的 P1 子范围，并要求 P2/P3 在批次边界让出。重复项目依靠既有主键 upsert 和 coverage 合并保持幂等。
- 完全相同的低优先级范围可继续复用现有原子 promotion；不修改运行中任务的范围、cursor、lease generation 或已提交检查点。
- 重启后不依赖内存 waiter 作为真实性依据，统一从 jobs + coverage 重建等待关系和剩余空洞。

### 7.4 资源预算

- 当前 Windows SID 范围内 Archive 历史调用全局并发仍为 1。
- P2/P3 在持仓或挂单期间暂停；P1 保留即时需求语义，但失败不得回退 Live Worker。
- 增加每 Profile 每小时历史调用预算、单任务最大运行时长和连续失败熔断。
- SQLite 文件大小只告警，不自动删除；是否增加保留策略必须另立数据保留方案。
- 第一阶段不因用户关闭页面修改持久化任务状态，避免引入跨进程消费者引用计数；依靠范围去重、资源预算和优先级控制成本。以后只有真实负载证明必要时，才单独设计可恢复的消费者引用与取消协议。

## 8. 历史消费者拆分

### 8.1 `history_page`

- 只返回当前页行、快照信息、游标和轻量分页元数据。
- 不在每一页重新计算整段盈亏、入出金和图表。
- 只读取 requested range 已覆盖的数据；不完整时返回同步状态，不把 partial 当成功全量。

### 8.2 `history_summary`

- 对固定快照范围计算收益、交易量、入金、出金、信用和期初资金。
- 同一快照只计算一次；前端翻页复用结果。
- 第一阶段使用进程内有界缓存，键包含 scope、精确范围、筛选摘要和 `coverage_revision`；重启后允许重算，不新增持久化缓存表。
- 只有真实性能数据证明需要时，才单独设计持久化聚合表。

### 8.3 `history_chart`

- 与 Page/Summary 使用同一快照和范围。
- 只返回聚合点，不混入原始 deals/history orders。
- coverage 变化或用户刷新时重新生成。

### 8.4 `history_evidence`

- 服务端传入受限的 position/order/deal 引用和精确 requested range。
- Bridge 先确保该范围 coverage 完整，再从本地 SQLite 按索引返回引用对应的 deal/history_order/trade。
- 第一阶段不新增未经真实 MT5 验证的 Worker“按 ticket 查询”能力；若本地范围缺失，仍通过现有有界 `history_range_sync` 补范围。
- 不返回页面统计、图表或无关普通历史。
- 引用数、返回条数、UTF-8 字节数均有上限；证据截断时结果归因保持 pending。

`signal-outcomes.js` 改用 `history_evidence`，删除“先翻最多 25 页普通历史再筛选”的成功路径。结果归因仍以持仓/订单/成交精确关联为准，找不到时不猜测关闭。

## 9. SQLite 优化与迁移

### 9.1 读写隔离

- `OutboxStore` 保留当前写连接，用于 Outbox、命令账本、Collector、Job 和 coverage 事务。
- 增加独立只读历史连接，使用 WAL、`query_only=ON`、有限 busy timeout，不在其上执行 schema ensure 或 PRAGMA 写操作。
- Page/Summary/Chart/Evidence 使用只读连接；写连接不等待历史统计扫描。
- 每次只读查询保持短生命周期，不跨网络等待，不长期持有读事务，避免阻止 WAL checkpoint。
- 第一阶段只使用一个独立历史读连接；是否扩为小型读池必须由压力测试决定，避免过度设计。

### 9.2 索引

幂等增加：

```sql
CREATE INDEX IF NOT EXISTS idx_history_archive_order
ON history_archive_items (
  terminal_instance_id,
  broker_server,
  login_account,
  item_kind,
  order_ticket,
  event_time_msc,
  item_id
);
```

- 保留现有 page 和 position 索引。
- 新索引加入 runtime schema 完整性检查和 fresh/legacy migration 测试。
- 迁移只增加索引，不改表、不删除行、不重写历史、不改变主键。
- 大库首次建索引可能耗时，必须在真实规模副本测量；安装/启动过程要有可诊断错误，不能无限等待。

### 9.3 查询约束

- Page 使用复合游标；仅兼容请求允许受限 OFFSET。
- Summary 不在每页重复执行。
- Evidence 优先使用 position/order 复合索引。
- 参数仍使用 SQL 占位符；动态筛选只来自固定白名单。
- 超过页深、引用数、时间范围或字节预算时返回稳定错误码，不执行高成本兜底扫描。

## 10. 导出最终方案

### 10.1 立即安全边界

- 在后台导出完成前，现有同步导出不得把真实 `total_pages` 压到 50 后返回成功。
- 超过同步安全上限时明确返回 `history_export_range_too_large`，要求缩小范围或创建后台导出任务。
- 任何 coverage incomplete、evidence truncated、游标断裂或快照失效都不能产生标记为成功的文件。

### 10.2 后台流式导出

1. 服务器创建导出任务并固定用户、账户归属期、筛选和快照结束点。
2. Bridge 只补 requested range 空洞。
3. coverage 完整后，服务器按游标逐页流式写临时文件，不把全部历史保存在 Node 内存。
4. 返回准备中、同步中、生成中、成功或失败状态和进度。
5. 文件名、日志和任务状态不包含账户敏感标识。
6. 成功文件有限期保留；清理策略只删除导出临时文件，不删除 Bridge SQLite 历史。

普通导出最大范围仍不能早于当前用户精确归属期。

后台导出需要新增独立、可重启恢复的服务器任务记录。实现前先核对最终字段并追加新的 `server/migrations.js` 迁移，至少持久化用户/交易账户作用域、状态、精确范围、筛选摘要、快照摘要、游标检查点、已写行数、脱敏产物键、错误码、过期时间和审计时间。迁移必须幂等，只新增表和索引，不修改既有历史或信号表；文件系统临时路径不得直接作为可下载地址。任何生产数据库迁移仍需独立部署授权，不能在本方案或本地编码阶段直接执行。

## 11. MT4 与 MT5 差异

### 11.1 MT5

- 继续使用独立 Archive Worker、动态时间窗、deals + history orders 联合游标和原子持久化。
- 真实 MT5 双 Python 进程长期稳定性仍是发布硬门；未验证前不能宣称生产完成。
- Archive timeout/restart 不能改变 Live PID、实时快照或命令延迟。

### 11.2 MT4

- 保持当前 EA/本地历史链路，不强行套用双 Python Worker。
- `requested_range_complete` 只能说明 Bridge 已完整读取终端当前可见的请求范围，不能证明经纪商账户生命周期完整。
- 新增或保留 `terminal_history_window_known`、可见窗口起止等次级元数据；未知时失败关闭。
- UI 保留“请在 MT4 账户历史中加载相应范围”的明确提示。

## 12. 状态与日志

顶层在线状态继续只反映实时链路。用户可见历史状态收敛为四类：

| UI 状态 | 含义 |
| --- | --- |
| 近期历史已就绪 | 默认 recent 范围完整 |
| 正在准备所选范围 | requested range 有任务进行中 |
| 所选范围不完整 | 缺少 coverage，尚未成功完成 |
| 历史同步需要注意 | blocked、连续超时、终端历史不可用或能力不足 |

内部可保留细分 Job 状态，但不继续扩张用户可见状态枚举。日志 fingerprint 不包含进度计数，避免每批刷屏；只记录状态边沿、受限错误码、耗时区间和脱敏资源指标。

## 13. 兼容、迁移与回滚

### 13.1 本地 SQLite

- 新索引通过现有幂等 runtime schema 路径添加。
- 现有 account initialization、jobs、coverage、archive items、legacy archive state 全部保留。
- 旧 backfill Job 保持原记录但新调度器不领取，不做破坏性状态迁移。
- 回滚旧客户端时，其原有自动 backfill 行为可能恢复，这是已知回滚行为；不会丢数据或跳过 cursor。
- 新客户端再次启动后重新按允许 job kind 收敛，不删除旧行。

### 13.2 服务端兼容

- 新服务器先增加可选字段解析和能力检测，旧 Bridge 继续连接。
- 精确归属范围、稳定游标和新消费者只对声明能力的新 Bridge 启用。
- 涉及跨归属风险的旧 Bridge 请求失败关闭，不能用日期级统计冒充精确隔离。
- 旧服务器忽略新 Bridge 响应字段；新 Bridge 保留旧 Page/Chart 响应字段直到服务器灰度完成。

### 13.3 发布版本

- 本方案不直接修改应用版本。
- 若交付对象只用于新安装或人工同路径修复，可继续生成同版本 3.0.0 对象，但不能声称自动更新覆盖现有 3.0.0。
- 若需要已安装 3.0.0 自动获得本优化，正式发布必须使用更高应用版本；推荐 `3.0.1`，并生成新的 ReleaseId、SHA-256、签名清单和模块包。
- 构建、上传、接口切换、虚拟机部署和公网部署仍是独立授权步骤。

## 14. 分阶段实施计划

### 14.1 预计文件范围

| 模块 | 主要职责 |
| --- | --- |
| `bridge/native/crates/bridge-terminal-session/src/lib.rs` | 停止自动 P3、允许 job kind、P1/P2/P3 调度与重叠范围决策 |
| `bridge/native/crates/bridge-store/src/lib.rs` | 精确范围、快照/游标、只读连接、Evidence、Summary、claim 过滤、迁移检查 |
| `bridge/native/crates/bridge-store/src/schema.sql` | fresh DB 的 order ticket 索引 |
| `bridge/native/apps/bridge-core/src/lib.rs` | 新历史动作、能力字段、范围准备和错误映射 |
| `bridge/native/crates/bridge-foundation/src/lib.rs` 及状态模型 | 可选历史协议能力，保持旧 JSON 兼容 |
| `server/bridge-ws.js` | ownership 精确边界、快照、消费者路由、导出 fail-closed |
| `server/routes/ai/signal-outcomes.js` | Evidence 对账，移除普通历史页上限依赖 |
| `server/migrations.js` | 仅在后台导出阶段追加可恢复导出任务表 |
| `public/ai/app.js`、`public/ai/index.html` | 默认 recent、范围选择、同步进度、后台导出状态 |
| 对应 Rust/Python/Vitest 测试 | 兼容、迁移、范围、并发、归属、导出和真实环境回归 |

第一阶段不需要修改 MT5 Python Worker 的生产协议；只有后续真实终端验证证明按 ticket API 能安全显著降载时，才另立窄方案扩展 Worker。

### 阶段 F：业务边界和协议

1. 服务端生成精确 ownership UTC 毫秒范围。
2. 普通用户 `all/platform` 收敛为当前归属期；新增 recent 默认模式。
3. Bridge 接受精确 range start/end、固定 snapshot 和可选 cursor。
4. 增加能力协商和旧 Bridge 失败关闭路径。
5. 先修复导出超过 50 页仍成功的问题。

验收门：跨归属期行、统计、图表和导出全部被精确阻断；旧 Bridge 不会绕过边界。

### 阶段 G：调度器减法和任务合并

1. 停止自动规划 P3 backfill。
2. 显式归档复用 `on_demand + P3`，不新增 job kind、不重建任务表。
3. 领取任务时使用允许 job kind，保留旧 backfill 行。
4. P1/P3 创建前扣除 coverage；同优先级在途范围附着等待，低优先级重叠范围按批次让出规则处理。
5. 保持租约、cursor、失败恢复和 P1 让出合同。

验收门：新账户静置 24 小时不会自动向 2000 年回填；页面相同/重叠请求不重复拉取相同范围。

### 阶段 H：Store 和消费者

1. 增加独立只读历史连接。
2. 增加 `idx_history_archive_order`。
3. Page 改游标优先并限制深层 OFFSET。
4. 拆分 Page/Summary/Chart/Evidence。
5. Signal Outcomes 改为 Evidence，不再依赖 25 页普通历史。

验收门：10 万和 100 万行夹具下，历史读取不阻塞 Outbox/命令回执写入；结果归因不会因普通分页上限丢失证据。

### 阶段 I：UI 和后台导出

1. 默认最近 7 天；本次接入以来和自定义由用户主动选择。
2. Page、Summary、Chart 共享快照。
3. 增加范围同步进度和明确错误状态。
4. 同步导出超限明确失败；实现后台流式导出。
5. MT4 显示终端可见历史范围限制。
6. 追加导出任务服务器迁移、权限校验、重启恢复和过期清理。

验收门：导出绝不静默截断；账户归属范围、页面统计和导出结果一致。

### 阶段 J：真实环境和发布准备

1. 新空账户、普通账户、高频大历史账户分别验证。
2. 真实 Windows Server 连续运行 2 小时，再进行 24 小时观察。
3. 注入 Archive 15 秒以上延迟、崩溃、SQLite Busy 和网络断开。
4. 验证 Live PID、报价、持仓、挂单、命令和回执不受 Archive 影响。
5. 使用大库测量索引建立时间、SQLite WAL 大小、历史读延迟和命令写 p95/p99。
6. 验证旧数据库升级、新客户端回滚、旧 backfill 惰性和再次升级。
7. 只有全部通过后，另行决定 3.0.0 人工修复或 3.0.1 自动更新发布。

验收门：真实 MT5/MT4、安装目录和目标 Windows Server 证据齐全；自动化测试不能替代本阶段。

## 15. 测试矩阵

### 15.1 Rust Store/Session/Core

- 精确 ownership start 不会向前扩到当天零点。
- custom start 与 ownership start 正确取最大值。
- 默认只创建 recent，不创建 backfill。
- 旧 backfill 行保留但新调度器不领取；回滚兼容夹具可继续读取。
- overlapping coverage/queued/running 范围只创建真实空洞。
- 相同快照的 Page/Summary/Chart 使用完全相同的 end。
- 快照在账户、epoch、筛选或范围变化后失效。
- 游标分页在中途插入新记录时无重复、无漏项。
- 深层页码和恶意 cursor 失败关闭。
- 独立只读连接在写连接持有事务时仍能按 WAL 规则读取已提交快照，不阻塞写入。
- 新 order 索引存在于 fresh DB 和 legacy runtime migration。
- Evidence 只返回同 scope、同 requested range、同引用的数据。
- coverage incomplete、evidence truncated 和失效快照不能返回完整成功。

### 15.2 Node/Vitest

- `all/platform` 对普通用户映射精确当前归属期。
- 同日中途接管不会看到当天接管前记录和统计。
- 旧 Bridge 缺少 exact-range 能力时失败关闭。
- 历史页面、图表和统计共享 snapshot/end。
- Signal Outcomes 使用 Evidence；没有 25 页截断成功路径。
- 导出 `total_pages > 50` 不生成成功文件。
- 后台导出 coverage incomplete、快照失效和流式写失败均不留下 partial 成功文件。
- 导出任务只能由所属用户读取；管理员访问必须经过现有管理员授权和审计，任务重启后从持久化游标恢复。
- 管理员观摩源、普通用户和账户换绑场景不串数据。

### 15.3 Python Worker

- 继续覆盖 Live/Archive 角色拒绝、UTC 半开区间、复合游标、deals/orders 同 pair 原子分页和 dense range。
- 本阶段不新增未经真实终端验证的 ticket 专用 Worker 操作。
- 真实终端验证两个只读 Python 进程时，Archive shutdown 不关闭 MT5，也不改变 Live Worker 会话。

### 15.4 推荐命令

```powershell
cargo fmt --all -- --check
cargo clippy -p bridge-store -p bridge-terminal-session -p liangjian-bridge-core -p bridge-worker-host --all-targets -- -D warnings
cargo test -p bridge-store -p bridge-terminal-session -p liangjian-bridge-core -p bridge-worker-host
python -X utf8 -m unittest discover -s bridge/native/workers/mt5/tests -p "test_*.py"
python -m py_compile bridge/native/workers/mt5/worker.py
node --check server/bridge-ws.js
node --check server/routes/ai/signal-outcomes.js
npx vitest run tests/bridge-ws.test.js tests/ai/signal-outcomes.test.js
powershell -File scripts/bridge-native/test-native.ps1 -SkipRelease
npm test
```

## 16. 性能验收指标

自动化夹具和真实大账户至少记录：

- 历史 Page/Summary/Chart/Evidence p50、p95、p99。
- Outbox enqueue/ack、命令回执持久化和 Collector 写入 p95、p99。
- 历史读取期间写连接等待时间。
- 单个 MT5 历史调用耗时、行数、响应字节和窗口缩放次数。
- Archive Worker 启停次数、连续失败和熔断次数。
- SQLite 主文件与 WAL 大小。
- 后台导出内存峰值、临时文件大小和生成耗时。

硬门：历史读取或导出期间，实时 Worker 不重启，命令链路不因 SQLite 历史扫描产生不可接受的延迟；具体毫秒阈值在真实基线测量后固化，不能凭空写死。

## 17. 回滚和停止条件

出现以下任一情况立即停止扩大测试或发布：

- 当前用户读取到接管前历史或统计。
- Archive 导致 Live PID、实时快照或命令延迟异常。
- 未完整 requested range 被标记为 complete。
- 导出静默遗漏数据或 partial 文件被标记成功。
- 新索引迁移导致旧数据库无法打开或启动长时间无诊断卡住。
- 新调度器删除、重置或跳过旧历史 cursor。
- 旧 Bridge 在能力不足时仍被服务器当作精确范围结果使用。

回滚时：

1. 恢复上一稳定 Bridge/服务器版本和签名发布指针。
2. 不删除用户 SQLite，不删除 coverage、jobs、archive items 或新增索引。
3. 旧 backfill 行原样保留，旧客户端可恢复其旧行为。
4. 停止未完成后台导出任务并清理其临时文件，不触碰历史数据库。
5. 记录回滚版本、触发条件、受影响 Profile 和脱敏诊断证据。

## 18. 第一轮复审：需求覆盖与最小设计

### 18.1 检查内容

- 核对用户目标是否是“稳定桥接和按需历史”，而不是“更快地同步几十年历史”。
- 核对实时交易、历史页面、图表、结果归因、导出、MT4、MT5、账户换绑和回滚是否全部覆盖。
- 检查是否复用现有 coverage/jobs/Archive Worker，而不是新增第二套历史系统。
- 检查新表、持久化缓存和 Worker 能力是否属于必要改动。
- 检查默认页面是否会以另一种形式重新触发大范围 P1。

### 18.2 第一轮发现

1. 如果历史页面仍默认“本次接入以来”，老用户一打开页面就可能触发数月或数年的 P1，实质上没有完成减法。
2. 初稿考虑新增持久化 summary/cache 表，但 Page/Summary 拆分和进程内有界缓存已经能解决每页重复统计，立即增加新表属于过度设计。
3. 初稿考虑新增 Worker ticket 专用操作，但真实 MT5 API 行为尚未验证；现有 range coverage + 本地索引 Evidence 已足以先解决 Signal Outcomes 的 25 页问题。
4. 只把 `all` 改名而不使用精确 ownership 毫秒边界，仍会泄漏接管当天之前的数据。
5. 初稿允许页面关闭时取消尚未开始的持久任务，但这需要跨请求/跨进程消费者引用计数；在已有范围去重和资源预算下不属于第一阶段必要能力。

### 18.3 第一轮调整

- 历史页面默认改为最近 7 天；ownership/custom/archive 均由用户主动发起。
- 第一阶段不新增持久化 summary 表，只使用拆分接口和有界进程内缓存。
- Evidence 第一阶段复用现有 range sync 和本地 SQLite 索引，不扩张 Worker 协议。
- 归属边界提升为精确 UTC 毫秒，并增加旧 Bridge 能力不足时的失败关闭。
- 第一阶段不根据页面生命周期取消持久任务，避免增加不可靠引用计数；以后依据真实负载再决定。

第一轮结论：最终设计复用了当前实现，删除了默认全量工作和非必要新表/Worker 能力，覆盖实时、页面、归因、导出、归属和回滚需求，未以性能优化为名扩大交易安全范围。

## 19. 第二轮复审：兼容、数据、并发、恢复与发布

### 19.1 检查内容

- 检查旧数据库、已有 backfill Job、新旧服务器/Bridge 混跑和回滚。
- 检查重叠范围、租约 generation、固定快照、分页插入和账户切换并发。
- 检查 WAL 读写隔离、长读事务、索引迁移和磁盘错误恢复。
- 检查 UTC/终端时间、精确归属、MT4 可见历史和导出快照。
- 检查失败关闭、日志脱敏、测试覆盖、正式版本和发布顺序。

### 19.2 第二轮发现

1. 简单把旧 P3 Job 标记 superseded 或删除，会让旧客户端回滚后无法按原 job id 恢复，属于不必要的迁移破坏。
2. 当前 P1 只提升完全相同范围；固定结束点不同或范围重叠时仍会重复工作。但如果无条件扣除低优先级在途范围，窄 P1 又会被一个很大的 P2/P3 拖延，因此必须区分同优先级等待与低优先级批次让出。
3. 新服务器若在旧 Bridge 上只过滤页面行，却继续使用旧 Bridge 返回的范围统计，仍可能把接管前交易计入收益。
4. 只增加只读连接但让查询跨网络请求长期持有读事务，会导致 WAL 无法 checkpoint，必须约束读事务生命周期。
5. 同步 WebSocket 导出即使改成无限游标，也会引入长连接、内存和失败恢复问题；大范围导出必须后台化。
6. 若需要自动覆盖已安装 3.0.0，同版本 ReleaseId 无法绕过更新器的版本比较，发布方案必须提升应用版本。
7. 只用请求结束点作为 Summary 缓存水位，coverage 在同一结束点内补齐后缓存不会失效；必须使用 coverage 范围及更新时间的 revision。
8. 后台导出若只保存在进程内，服务重启会丢失游标和文件状态；需要独立、授权受控且可过期清理的服务器任务记录。
9. 现有数据库 CHECK 只允许 `recent|on_demand|backfill`；新增 `archive_explicit` 会迫使表重建，风险大于收益。

### 19.3 第二轮调整

- 旧 backfill Job 原样保留；新调度器通过允许 job kind 使其惰性，不做破坏性迁移。
- 显式 P3 归档复用 `on_demand`，用优先级区分即时 P1 与归档 P3，不扩展 job kind CHECK。
- P1/P3 创建前统一计算 coverage 与在途任务；同优先级重叠附着等待，低优先级重叠在批次边界让出并允许窄 P1 继续，不修改运行中任务范围和 cursor。
- 旧 Bridge 在精确归属能力不足时，对跨归属风险的统计和导出整体失败关闭。
- 历史只读连接只执行短查询，不跨 await/网络持有事务；读池是否扩容由压力测试决定。
- 同步导出只保留小范围兼容路径，大范围使用后台流式任务。
- 发布边界明确为：人工修复可同版本；自动更新推荐 3.0.1。
- 快照返回独立 `coverage_revision`，并绑定归属版本；服务器验证快照完整性，不能信任客户端自报范围。
- 后台导出使用新增的幂等服务器任务迁移持久化作用域、检查点、状态和过期时间；生产迁移仍是独立授权边界。

第二轮结论：方案在兼容迁移、账户归属、并发幂等、异常恢复、时间语义、安全、测试、回滚和发布版本方面已闭环。仍然存在一个不能由方案或单元测试消除的最高风险：真实 MT5 对同终端双 Python 只读进程的长期稳定性。该风险必须通过阶段 J 的真实 Windows Server 验收，未通过不得发布。

## 20. 最终实施顺序

严格按 F → G → H → I → J 顺序执行。F 的账户归属和协议是后续全部优化的安全前提；G 完成后才算真正取消默认全量历史；H 完成后才能删除普通分页对账路径；I 不能在 H 的稳定快照和游标之前实现；J 是发布硬门。

每个阶段由主 Agent 先核对受保护合同和调用链，再将明确、边界固定的编码任务交给实现 Worker；主 Agent 必须复核实际 diff、测试结果、迁移兼容和残余风险。任何阶段不得顺带构建、上传、发布或部署。

## 21. 2026-08-09 本地实施状态

已完成并通过本地自动化验证：

- F：精确 ownership 毫秒范围、recent 默认、旧 Bridge 能力不足失败关闭、同步导出超过 50 页明确失败。
- G：停止自动 P3/backfill，旧 backfill 行保留但新调度器不领取；P1/P2/P3 使用原子 coverage/在途范围规划。
- H（已完成部分）：独立只读连接、order 索引、精确范围 Evidence、Signal Outcomes 定点证据查询，以及 `history_page` 固定快照与复合键集游标；游标后续页不再使用 OFFSET、COUNT 或重复统计。
- I（已完成部分）：页面默认最近 7 天、ownership/custom 主动选择、页面游标导航，以及同步导出的有界游标读取；超过 50 页仍明确失败，不静默截断。
- 信号复核进一步按 user + trading account + active ownership 分组，并把 broker/login 路由与 ownership 起点绑定到 history evidence 和 positions 请求。
- Hello 现声明 `history_exact_range_v1`、`history_cursor_v1` 与 `history_evidence_v1`；服务端仅在路由同时具备精确范围与游标能力时使用 `history_page`，否则保留精确范围旧分页兼容路径。
- 游标 token 为随机不透明值，绑定终端账户、平台、精确半开范围、筛选与 page size；快照固定 rowid 高水位、总数、统计与同步元数据，最多保留 256 个快照、每快照 512 个游标，10 分钟绝对过期。Bridge 重启或 token 过期后从第一页建立新快照。

仍未完成，不能宣称整套方案或生产发布完成：

- H：Page/Summary/Chart 进一步拆分，以及 10 万/100 万行真实性能验收；当前自动化深分页夹具为 1 万行，只证明键集分页语义与边界，不替代大库 p95/p99 测量。
- I：后台可恢复流式导出、对应服务器迁移、显式 P3 归档入口和完整同步进度交互。
- J：真实 MT4/MT5、Windows Server 2 小时与 24 小时观察、故障注入、大库索引和 p95/p99 测量。
- 构建、签名、上传、版本激活、虚拟机和公网部署均未执行，仍需独立授权。
