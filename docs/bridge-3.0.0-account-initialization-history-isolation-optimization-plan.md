# 量见智桥 3.0.0 新账户初始化与历史同步隔离优化方案

> 文档状态：方案已完成两轮复审，可进入实现拆分；尚未修改业务代码、构建、上传或部署
>
> 适用仓库：`D:\dev_codex\wall-street-skill-local`
>
> 基线分支：`dev_codex`
>
> 基线提交：`c636eb9a90d3220ec31a46ce3751cbf8a64f48c9`
>
> 版本约束：修复后仍按用户要求发布为应用版本 `3.0.0`，但必须生成新的不可变 ReleaseId、内容哈希和签名发布材料；现有更新器拒绝 `target <= current`，因此同版本包只能用于新安装或人工同路径修复，不能自动覆盖已安装的 3.0.0
>
> 方案边界：本文件只授权方案设计，不授权代码修改、正式构建、七牛云上传、下载接口切换、虚拟机部署或公网部署

## 1. 结论

本次 Windows Server 实测已经证明，当前故障不是安装路径、公网 WebSocket 或 Windows 会话不一致，而是 MT5 历史同步与实时采集共用同一个串行 Python Worker 通道：历史请求执行期间 Worker 被替换，Python PID 从 `10940` 变为 `7116`，历史连续失败从 `22` 增为 `23`，实时 Collector 同时短暂进入 `retrying`，Core 状态从 `online` 短暂变为 `degraded`。Worker 恢复后实时采集重新 Ready，但历史继续以 `worker_generation_changed` 重试，因此用户看到桥接状态偶发断开和持续警告。

推荐采用以下总体方案：

1. 把“账户可运行初始化”与“完整历史归档”拆成两个独立状态域。
2. 新账户首次被 Bridge 识别时，只完成账户身份、终端时钟、账户/持仓/挂单快照和必要的命令核对，不等待多年历史。
3. MT5 批量历史读取迁移到无交易能力的独立 Archive Worker；其超时、崩溃或重启不得污染实时 Worker。
4. 历史归档改为可持久化任务、动态小时间窗、断点续传、按需范围优先和低优先级后台回填。
5. 保留 `history_sync.complete` 兼容字段，同时增加明确的覆盖范围；只有请求所需范围完整时，服务器才消费历史证据。
6. Bridge 主状态以实时运行能力为准；历史部分完成是次级状态，不能再把预期后台回填显示成桥接断开。

仅增加一个“初始化页面”或单纯把超时从 10 秒调大不能解决问题。若批量历史仍使用实时 Worker，超时只会变成更长时间阻塞交易命令；若初始化后直接把不完整历史标记为完成，又会破坏历史导出、交易结果归因、复盘和统计。

## 2. 已证实事实、推断与验证限制

### 2.1 已证实事实

| 事实 | 证据 | 影响 |
| --- | --- | --- |
| 故障时 Worker 真实发生替换 | Windows Server 两分钟采样中 Python PID `10940 → 7116` | 不是历史日志残留 |
| Worker 替换与历史失败同步发生 | PID 变化时 `history_consecutive_failures 22 → 23` | 历史请求与 Worker 重启高度相关 |
| 实时采集被连带影响 | 同一采样点 Collector 为 `retrying`、Phase 为 `degraded` | 解释用户看到的连接闪断 |
| 新 Worker 能恢复实时采集 | 随后 Worker/Collector 恢复 Ready、Phase 恢复 Online | 公网连接和终端账户本身并未持续断开 |
| 新档案默认从 2000-01-01 开始历史同步 | `bridge-terminal-session/src/lib.rs` 中 `HISTORY_ARCHIVE_START_MSC = 946684800000` | 首次接入旧账户需要扫描多年 |
| MT5 每个历史窗口为 30 天 | `workers/mt5/worker.py` 中 `HISTORY_WINDOW_MSC` | 一个窗口仍可能返回大量原始成交 |
| 历史和实时数据共用 WorkerDataRouter 与请求超时 | `bridge-terminal-session/src/lib.rs` 创建单一 Router；Core 请求超时固定为 10 秒 | 批量历史会占用实时 IPC |
| 请求超时会毒化 Worker 通道 | `bridge-worker-host/src/client.rs` 超时后调用 `fail()` | Supervisor 随后终止并重启 Worker |
| Worker 换代可覆盖原始请求错误 | `bridge-worker-host/src/registry.rs` 请求后先检查 generation | 状态最终只显示 `worker_generation_changed` |
| 交易初始放行不要求完整历史 | Native 设计与当前 Core 链路要求账户、持仓、挂单初始快照及 ACK | 可安全拆分运行就绪与历史就绪 |
| 服务器部分历史消费者强制要求全库 complete | `signal-outcomes.js` 和 `bridge-ws.js` | 引入部分覆盖后必须同步修改消费者语义 |

### 2.2 高置信度推断

当前最可能的底层触发是某次 MT5 `history_deals_get` 或 `history_orders_get` 超过统一的 10 秒请求边界，Host 将 IPC 标记为不可用，Supervisor 重启 Worker，而 Registry 的请求后 fencing 把首发错误改写为 `worker_generation_changed`。早期日志中的 `worker_channel_unavailable`、`worker_registry_not_ready` 与该链路一致。

此推断尚缺少故障瞬间的原始 `worker_request_timeout` 记录，因为当前实现正好会丢失该首发错误。第一实现批次必须先补诊断，不能把推断伪装成已证实的唯一根因。

### 2.3 验证限制

- 尚未直接取得故障 Windows Server 上对应秒级的 Bridge JSONL、Windows Application Error 或 WER 完整记录。
- 尚未在该高历史量账户上测量单次 MT5 历史 API 的耗时与返回条数。
- 尚未验证两个只读 Python 进程同时连接同一 MT5 终端的长期稳定性。
- 尚未在 1、5、20 个隔离 Profile 同时后台回填历史时做资源压力测试。
- 本方案不以单元测试替代真实 MT5 Demo 和目标 Windows Server 验收。

## 3. 目标与非目标

### 3.1 目标

1. 新账户在完成必要实时数据初始化后快速进入可运行状态，不等待全量历史。
2. 任意批量历史请求超时、进程崩溃或返回异常均不得重启实时 Worker。
3. 历史同步可断点续传，Core/Worker/MT5 重启后不从头重复扫描。
4. 对大历史量账户采用动态小窗口，控制单次 MT5 调用的时间和内存风险。
5. 服务器能判断“请求范围已完整”“仅部分可用”“仍在回填”，不以全局布尔值代替范围完整性。
6. 账户切换、Profile 隔离、connection epoch、命令幂等和 uncertain reconciliation 保持现有安全合同。
7. 旧 3.0.0 数据库原地兼容，已有历史和游标继续复用；回滚到旧客户端时不跳过未同步历史。
8. 用户界面区分“桥接在线”“账户初始化”“历史同步中”“历史同步异常”，避免误报连接失败。
9. 修复完成后仍可按 3.0.0 重新打包，但发布对象、ReleaseId、SHA-256 和签名材料必须唯一。

### 3.2 非目标

- 不自动启动、关闭、登录或切换 MT4/MT5 终端。
- 不修改网站授权、账户归属接管、会员权限或交易权限规则。
- 不删除或重建 `bridge.db`，不以清库作为恢复手段。
- 不把 SQLite 提升为经纪商交易真相。
- 不取消历史归档、历史导出、交易结果归因、日/月复盘或统计能力。
- 不通过提高 WebSocket 4 MiB 或旧版 32 MiB 上限解决历史问题。
- 不在本方案阶段构建、上传、切换下载接口或部署服务器。

## 4. 必须保护的业务和安全合同

1. **账户身份**：MT5 账户仍以 `broker_server + login_account` 唯一识别；本地历史继续按 `terminal_instance_id + broker_server + login_account` 隔离，Broker Server 比较不区分大小写。
2. **Profile 隔离**：默认档案和管理员观摩源各自使用独立目录、SQLite、凭据、日志、Worker 和终端绑定。
3. **实时优先**：交易命令、命令核对、账户/持仓/挂单快照优先于批量历史。
4. **命令安全**：旧 epoch、错账户、错平台、重复和过期命令继续失败关闭；Worker 换代期间的成功结果不得未经核对直接确认。
5. **历史真实性**：只有成功完成 MT5 查询且同一事务持久化完成的范围才能标记为覆盖；失败、超时或进程退出不得推进覆盖水位。
6. **时间语义**：内部游标和范围使用 UTC 毫秒；依赖终端服务器时间的查询只使用已验证时差。时钟不可信时暂停相应历史任务，不猜固定时区。
7. **本地运行独立**：网站未授权或会员失效只暂停服务器连接，不得阻止账户初始化和本地实时采集。
8. **只读 Archive Worker**：不得协商或持有 `ExecuteCommand` 能力，不接受任何交易操作。
9. **日志脱敏**：运行状态和日志不得新增登录号、Broker Server、终端路径、凭据或完整交易内容。
10. **发布信任**：应用仍为 3.0.0 不代表可覆盖旧对象；模块包和更新清单仍必须验证版本、大小、SHA-256 和签名。

## 5. 目标状态模型

### 5.1 三个相互独立的就绪域

| 状态域 | Ready 条件 | 不应依赖 |
| --- | --- | --- |
| `local_operational_ready` | 终端身份正确、账户身份正确、时钟满足当前动作要求、账户/持仓/挂单最新完整快照已原子落库 | 全量历史、服务器授权 |
| `server_command_ready` | 本地已 Ready、服务器已授权、账户/持仓/挂单初始全量快照已 ACK、无致命 reconciliation 阻塞 | 全量历史归档 |
| `history_readiness` | 按请求范围或全局归档判断覆盖状态 | Bridge 主连接状态 |

Bridge 顶层 `phase=online` 应表示实时链路可用。历史回填未完成只作为次级状态，不得把主状态改成 degraded。只有实时 Worker、Collector、服务器连接或命令安全门本身异常时才允许主状态降级。

### 5.2 账户初始化状态机

```text
detected
  -> verifying_identity
  -> warming_realtime_snapshot
  -> reconciling_local_commands
  -> ready

任一步临时失败 -> retrying -> 从最近持久化检查点继续
身份/路由/时钟硬错误 -> blocked
账户或 terminal_instance 改变 -> cancel old scope -> detected(new scope)
```

建议状态值：

- `detected`
- `verifying_identity`
- `warming_realtime_snapshot`
- `reconciling_local_commands`
- `ready`
- `retrying`
- `blocked`
- `superseded`

初始化记录必须带 `schema_version`。初始化 Ready 只能说明实时运行所需数据已完成，不能写入 `history_complete=true`。

### 5.3 历史状态机

```text
not_started
  -> syncing_recent
  -> partial
  -> syncing_on_demand / backfilling
  -> complete

任一任务临时失败 -> retrying（不影响 live phase）
高优先级实时活动 -> paused（正常让路，不记失败）
账户切换 -> superseded
```

历史状态建议新增：

- `not_started`
- `syncing_recent`
- `partial`
- `syncing_on_demand`
- `backfilling`
- `complete`
- `retrying`
- `paused`
- `blocked`
- `stopped`

## 6. 新账户快速初始化

### 6.1 “新账户”的准确含义

这里的“新账户”不是经纪商刚创建的空账户，而是“当前 Profile 的 SQLite 中首次识别到该本地账户作用域”。判断键为：

```text
profile database
  + terminal_instance_id
  + platform
  + normalized broker_server
  + login_account
```

`connection_epoch` 是会话 fencing，不属于长期账户身份；同一账户正常重连不能重复初始化。账户在不同 `terminal_instance_id` 下继续保持隔离，第一阶段不做跨终端历史去重，以免改变现有边界。

### 6.2 初始化必要操作清单

| 操作 | 是否阻塞 `local_operational_ready` | 原因 |
| --- | --- | --- |
| 校验终端路径、平台、Worker nonce/版本/能力 | 是 | 防止错终端和错进程 |
| 校验实际 Broker Server 与 Login | 是 | 防止串账户 |
| 检查终端连接及只读/交易权限 | 是，但只读账户可以进入只读 Ready | 权限必须明确，不得误报可交易 |
| 获取账户完整快照 | 是 | 余额、权益、保证金和账户状态 |
| 获取当前持仓完整快照 | 是 | 命令安全和服务器上下文 |
| 获取当前挂单完整快照 | 是 | 命令安全和服务器上下文 |
| 持久化三个快照和 revision | 是 | 崩溃恢复与 ACK 门禁 |
| 核对本地 ledger 中 persisted/dispatched/uncertain 命令 | 是，仅针对已有候选 | 不可自动重放不明确交易 |
| 校准终端时钟 | 按动作区分 | 不阻止账户只读快照 Ready；所有依赖终端时间、deadline 或历史范围的动作在时钟可信前暂停 |
| 扫描最近 7 天历史 | 否 | 仅用于加快近期页面和结果证据 |
| 从 2000 年开始完整回填 | 否 | 必须后台低优先级执行 |
| 历史导出、复盘统计预计算 | 否 | 按覆盖范围延迟执行 |

### 6.3 首次启动时序

1. Core 发现用户已经启动的终端，不主动启动 MT。
2. Live Worker 完成严格握手和账户身份复核。
3. 初始化协调器读取或创建账户初始化记录。
4. Collector 获取账户、持仓、挂单完整快照并原子写入 SQLite。
5. 若本地命令账本存在待核对记录，使用现有定向 `query_execution`/票号/持仓查询完成必要 reconciliation；绝不依赖全量历史扫描。
6. 标记 `local_operational_ready=true`。
7. 服务器已授权时，继续现有初始快照 ACK 门；满足且当前命令所需时间证据可信后标记 `server_command_ready=true`。休市时可保持本地只读 Online，但依赖终端时间的交易动作继续失败关闭。
8. 异步建立历史任务：近期七天范围优先、旧历史后台回填；两者都不阻塞 Online。

七天是首版近期缓存目标，不是完整性定义，也不是硬编码交易规则。若服务器请求更早的活动信号证据，应创建更高优先级的定向范围任务。

## 7. Live Worker 与 Archive Worker 隔离

### 7.1 Worker 角色

| 角色 | 能力 | 允许失败影响 |
| --- | --- | --- |
| `live` | Snapshot、Quote、Data、ExecuteCommand、QueryExecution；必要的定向轻量核对 | 影响对应终端实时状态和命令门 |
| `archive` | HistoryRange、HistoryEvidence、Diagnostics；严格只读 | 只影响历史状态，不能影响实时 Worker |

Registry 的活动键必须从仅 `terminal_instance_id` 扩展为逻辑上的 `(terminal_instance_id, worker_role)`，或者使用两个物理 Registry。为了降低对交易 fencing 的影响，推荐保留现有 Live Registry 不变，新增独立 Archive Registry/Supervisor；交易代码不得接触 Archive Registry。

### 7.2 Archive Worker 生命周期

- 只有账户存在待执行历史任务时启动。
- 使用独立 nonce、命名管道、进程、generation、超时和 Supervisor。
- 进程启动参数和环境继续使用受保护构建方式，Named Pipe ACL 仅允许当前 Windows 用户 SID。
- Worker 握手必须明确声明 `role=archive`，且能力集合中不得出现 ExecuteCommand。
- 空闲一段时间后可正常退出以减少内存；退出不计故障。
- 请求超时只毒化 Archive 通道并重启 Archive Worker。
- 若同一 MT5 终端不支持双只读进程稳定访问，则停止 Archive 任务并显示明确错误；禁止自动回退到 Live Worker 执行批量历史。

### 7.3 多 Profile 资源控制

管理员可能同时运行多个隔离 Profile。每个 Profile 自己的一任务并发限制不足以保护整台机器，因此增加当前 Windows 用户范围的历史并发租约：

- 默认整机最多 1 个正在调用 MT5 历史 API 的 Archive Worker；实机压力测试通过后才考虑提高到 2。
- 使用当前用户 SID 限定的本地命名 Semaphore/Mutex，不使用可被其他用户抢占的无 ACL 全局对象。
- 获取不到租约时任务进入 `paused_resource_budget`，不增加失败次数。
- Live Worker、服务器连接和命令执行不受该租约限制。

## 8. 历史任务和动态窗口算法

### 8.1 任务优先级

| 优先级 | 任务 | 示例 |
| --- | --- | --- |
| P0 | 交易命令定向核对 | 保持现有 Live Worker 只读核对路径，不进入批量队列 |
| P1 | 活动结果证据、用户当前页面、用户明确导出的范围 | 指定 position/order ticket 或 date range |
| P2 | 最近七天滚动覆盖 | 新账户初始化后的体验加速 |
| P3 | 更早全量归档回填 | 从最近覆盖边界逐步向 2000-01-01 回填 |

同一账户一次只执行一个 Archive API 请求。P1 可以在批次边界抢占 P2/P3，但不能中断已经进入 MetaTrader5 原生调用的进程；达到超时后由 Archive Supervisor 回收该进程。

### 8.2 动态时间窗建议值

首版建议：

- 初始窗口：24 小时。
- 最小窗口：15 分钟。
- 最大窗口：30 天。
- 单次响应目标：不超过 1,000 条原始成交，IPC 每批仍最多 250 条。
- Archive API 单次调用超时：15 秒；该超时只影响 Archive Worker。
- 空窗口或少量结果且耗时低：后续窗口倍增，最大 30 天。
- 返回量接近上限或耗时接近预算：后续窗口减半。
- 超时：Archive Worker 重启，当前范围不推进，窗口减半后按退避重试。
- 最小窗口仍连续超时：将该范围标记 `blocked_dense_range`，停止自动进程抖动，等待人工诊断或更细的票号查询策略。

所有阈值必须集中在明确策略结构中，不散落硬编码；测试使用更短时长注入。窗口调整依据应持久化，重启后不能恢复到已证明会超时的大窗口。

### 8.3 时间边界和游标规则

- 调度和覆盖统一使用 UTC 半开区间 `[start, end)`。
- 转换为 MetaTrader5 接口的闭区间日期参数时，允许在起点和终点各保留最多 1 秒的重叠读取，但最终入库必须再次按 UTC 半开区间过滤。
- 同一毫秒内使用 `(event_time_msc, ticket)` 复合游标，不能只按时间推进。
- 重叠读取依赖现有 item 主键 upsert 去重；覆盖标记仍只能写入原始目标半开区间。
- 时钟状态不是 verified 或符合既有可信继承规则时，不创建或执行对应 UTC 范围任务。

### 8.4 范围完整性

一段 `[range_start_utc_msc, range_end_utc_msc)` 只有同时满足以下条件才能写为 complete：

1. `history_deals_get` 成功返回。
2. 所需的 `history_orders_get`/关联证据查询成功返回。
3. Worker 输出通过条数、大小、游标、时钟和身份校验。
4. Deals、History Orders、规范化 Trades 与范围状态在一个 SQLite 事务中提交。
5. 事务提交完成后才 ACK 当前任务批次。

进程退出、超时、Worker generation 变化、SQLite Busy、磁盘满或 Core 退出均不得推进范围。

## 9. SQLite 数据模型与兼容迁移

### 9.1 新增表建议

为避免破坏现有表和回滚语义，采用新增表，不直接重定义 `history_archive_state`：

#### `account_initialization_state`

- `terminal_instance_id`
- `broker_server COLLATE NOCASE`
- `login_account`
- `platform`
- `schema_version`
- `state`
- `local_operational_ready`
- `last_error_code`
- `initialized_at_utc_msc`
- `updated_at_utc_msc`
- 主键：`terminal_instance_id + broker_server + login_account`

#### `history_sync_jobs`

- `job_id`
- 账户作用域三字段
- `job_kind`：recent/on_demand/backfill
- `priority`
- `range_start_utc_msc`
- `range_end_utc_msc`
- `cursor_time_msc`
- `cursor_ticket`
- `window_msc`
- `state`
- `attempt_count`
- `next_attempt_at_utc_msc`
- `last_error_code`
- `lease_generation`
- `created_at_utc_msc`
- `updated_at_utc_msc`
- 对同一作用域和规范化范围建立幂等唯一约束

#### `history_coverage_ranges`

- 账户作用域三字段
- `range_start_utc_msc`
- `range_end_utc_msc`
- `observed_at_utc_msc`
- `updated_at_utc_msc`
- 该表只保存已经完整提交的范围；blocked/retrying 等非完整状态只保存在 `history_sync_jobs`
- 完成后合并相邻或重叠范围，避免范围碎片无限增长

现有 `history_archive_items` 继续作为数据存储，主键 upsert 保证重复范围读取幂等。

### 9.2 迁移方式

当前 `open_or_create()` 会先按 `REQUIRED_SCHEMA` 检查已有数据库，缺列/缺表会直接判定 incompatible。因此不能简单把新表加入 `REQUIRED_SCHEMA` 后让旧数据库自行启动。

实现必须：

1. 保留当前基础 `REQUIRED_SCHEMA` 兼容检查。
2. 在基础数据库成功打开后，通过独立、幂等、事务化的 `ensure_history_runtime_schema()` 创建新表和索引，方式类似现有 `ensure_native_command_ledger_schema()`。
3. 增加迁移标记或 schema version，确保崩溃后可重复进入。
4. 迁移只创建表、索引和种子记录，不删除、不重命名、不重写旧历史项目。
5. 迁移失败时返回稳定错误并保持旧表可读，不自动创建新空数据库覆盖原库。

### 9.3 旧历史状态种子规则

- 旧 `history_archive_state.is_complete=1`：种子覆盖范围为 `[2000-01-01, cursor_time]`，同时保留旧 complete。
- 旧状态 partial 且 cursor 大于起点：种子为 `[2000-01-01, cursor_time]`，后续继续补齐。
- 无旧状态：创建初始化记录，但不预判任何历史范围已完整。
- 种子过程幂等，不重复生成任务或范围。

### 9.4 回滚兼容关键规则

新的 recent/on-demand 离散范围不得错误推进旧 `history_archive_state.cursor_value`。旧游标只在形成“从 2000-01-01 连续向前”的覆盖时推进，`is_complete` 仍只在全部连续覆盖到当前水位时为真。

因此回滚到旧 3.0.0 时：

- 旧客户端会忽略额外表。
- 已写入 `history_archive_items` 的新数据可以安全复用。
- 旧游标不会跳过未查询的空洞。
- 最坏情况是旧客户端重复查询并 upsert，而不是产生数据缺口。

## 10. Worker IPC 与错误语义

### 10.1 新操作

新增内部 Worker 操作建议为 `history_range_sync`，请求至少包含：

- route/account identity
- request_id
- UTC range start/end
- cursor time/ticket
- item limit
- job/attempt generation

响应继续保持单批最多 250 条，并携带：

- next cursor
- range complete
- source row count
- observed_at_utc_msc
- 已验证时钟元数据

旧 `history_sync` 在兼容期保留，但新调度器只调用新操作；不得改变服务器 V3 协议版本来暴露内部 Worker 实现。

### 10.2 保留首发错误

`WorkerLease::request` 的错误优先级调整为：

1. 请求执行本身失败且 generation 随后变化：返回原始失败，例如 `worker_request_timeout`，并在诊断字段记录 `generation_changed_after_failure=true`。
2. 请求成功但 generation 已变化：继续返回 `worker_generation_changed`，防止旧 Worker 成功结果穿越 fencing。
3. 请求前 generation 已变化：继续直接返回 `worker_generation_changed`。

该规则只改善诊断，不放宽交易安全。

### 10.3 错误分类

| 类别 | 示例 | 行为 |
| --- | --- | --- |
| 正常让路 | `history_paused_live_activity`、`history_paused_resource_budget` | 不计失败，不写 warning |
| 可重试 | Archive timeout、MT5 history unavailable、SQLite busy | 退避、缩窗、保留检查点 |
| 范围阻塞 | 最小窗口连续超时、返回数据持续无效 | 停止该范围自动抖动，明确提示 |
| 身份/安全错误 | account changed、route mismatch、clock untrusted | 立即停止旧任务，不复用结果 |
| 实时故障 | Live Worker timeout/channel unavailable | 保持现有 degraded 和安全门 |

## 11. 服务器历史消费合同

### 11.1 保持兼容字段

Bridge 的历史响应继续返回：

```json
{
  "history_sync": {
    "complete": false,
    "cursor_time_msc": 0,
    "updated_at_utc_msc": 0,
    "evidence_truncated": false
  }
}
```

并新增可选字段：

```json
{
  "history_sync": {
    "operational_ready": true,
    "state": "partial",
    "requested_range_complete": true,
    "archive_complete": false,
    "coverage_start_utc_msc": 0,
    "coverage_end_utc_msc": 0,
    "backfill_pending": true,
    "last_progress_at_utc_msc": 0
  }
}
```

旧服务器忽略新增字段；新服务器若字段缺失则回退到旧 `complete` 语义。

### 11.2 `signal-outcomes.js`

当前逻辑只要 `history_sync.complete === false` 就拒绝全部结果。改为：

- 请求活动 outcome 的最早 `date_from` 和 evidence ticket/position。
- 只有 `requested_range_complete=true` 且 `evidence_truncated=false` 才消费。
- Archive 全局不完整但当前所需范围完整时允许归因。
- 当前范围未完整时保持 outcome pending，创建/唤醒 P1 任务，绝不根据缺失证据推断平仓。
- 兼容旧 Bridge：没有 requested range 字段时继续要求旧 complete。

### 11.3 历史页面和导出

- 页面请求明确日期范围时，只要求该范围完整。
- 未指定范围的“全部历史”仍要求 archive complete。
- Bridge 收到 `force_refresh` 或未覆盖的日期范围时，应幂等创建/提升相应 P1 任务并立即返回“范围准备中”状态；不能在服务器请求线程中同步等待多年回填。
- 导出不得把 partial 数据当完整文件；可返回“正在准备历史范围”及可重试状态。
- 分页、证据引用、UTF-8 字节预算和 4 MiB 协议上限保持不变。
- 禁止重新引入将全部 deals/history_orders 随第一页返回的旧行为。

### 11.4 部署顺序兼容

1. 先部署能识别新字段、也兼容旧 Bridge 的服务器代码。
2. 再发布新 Bridge 3.0.0。
3. 新 Bridge 稳定后才允许服务器依赖 requested-range 优化。
4. 回滚 Bridge 时服务器继续使用旧 complete fallback。

## 12. UI、日志与可观测性

### 12.1 用户状态

主状态建议：

- `桥接在线`
- `账户初始化中`
- `桥接恢复中`
- `桥接已暂停`
- `需要重新连接账户`

次级历史状态建议：

- `近期历史同步中`
- `历史数据后台补齐中`
- `所选历史范围准备中`
- `历史同步已暂停，实时交易不受影响`
- `历史同步异常，请查看诊断`

不得把 `worker_generation_changed`、`worker_registry_not_ready` 等内部错误码直接展示给普通用户。

### 12.2 Runtime Status

在不暴露账户身份的前提下增加：

- `local_operational_ready`
- `server_command_ready`
- `history_state`
- `history_archive_complete`
- `history_backfill_pending`
- `history_last_progress_at_utc_msc`
- `history_current_window_msc`
- `history_consecutive_failures`
- `live_worker_restart_count`
- `archive_worker_restart_count`
- `last_history_primary_error_code`

顶层 phase 不因正常 partial/backfilling 降级。Archive 连续失败应产生独立、限频的 warning 事件，但不得伪装成服务器或实时 Worker 断线。

### 12.3 日志策略

- 初始化状态变化记录 info。
- 历史进度只按状态、覆盖边界显著变化或固定低频采样记录，避免每批刷屏。
- 正常资源让路和优先级抢占不记 warning。
- Archive 首次失败、达到阈值、进入 blocked、恢复时记录 warning/info 配对事件。
- Live Worker 重启继续记录 warning，并区分 primary error、generation、attempts 和 elapsed。
- 日志只记录 Profile、角色、状态、稳定错误码、耗时和计数，不记录账户号、Broker、路径和交易内容。

## 13. 文件级实施范围

| 文件/模块 | 计划修改 |
| --- | --- |
| `bridge/native/crates/bridge-store/src/schema.sql` | 新鲜数据库创建初始化、任务和覆盖表 |
| `bridge/native/crates/bridge-store/src/lib.rs` | 幂等增量 schema、legacy seed、任务租约、覆盖合并、范围完整性读取及 history/chart_data coverage 投影 |
| `bridge/native/crates/bridge-worker-host/src/contract.rs` | Archive role/capability、history_range_sync 合同和校验 |
| `bridge/native/crates/bridge-worker-host/src/registry.rs` | Archive Registry 或角色键；保留首发错误语义 |
| `bridge/native/crates/bridge-worker-host/src/data_router.rs` | Live/Archive 路由分离及独立超时 |
| `bridge/native/crates/bridge-worker-host/src/supervisor.rs` | Archive 生命周期、空闲退出和独立故障状态 |
| `bridge/native/crates/bridge-worker-host/src/process_session.rs` | Archive 启动角色与受限能力环境 |
| `bridge/native/workers/mt5/worker.py` | history_range_sync、范围校验、动态窗口结果、只读角色拒绝交易 |
| `bridge/native/crates/bridge-terminal-session/src/lib.rs` | 初始化协调器、历史调度器、状态拆分、账户切换取消 |
| `bridge/native/apps/bridge-core/src/lib.rs` | 三个就绪域、按范围历史响应、Archive 会话编排 |
| `bridge/native/apps/bridge-core/src/main.rs` | 状态日志分级、诊断字段、限频 |
| `bridge/native/crates/bridge-foundation/src/lib.rs` | Runtime Status 可选字段和兼容解析 |
| `bridge/native/crates/bridge-local-control/src/lib.rs` | UI 状态快照增加初始化与历史次级状态 |
| `bridge/native/crates/bridge-ui-model/src/lib.rs` | 中文状态映射和主/次状态优先级 |
| `bridge/native/apps/bridge-ui/` | 必要时显示历史次级进度，不改变现有主要布局 |
| `server/routes/ai/signal-outcomes.js` | 从全局 complete 改为 requested range/evidence 完整性 |
| `server/bridge-ws.js` | 历史导出按请求范围完整性处理 |
| `tests/ai/signal-outcomes.test.js` 及相关测试 | partial archive + complete requested range 回归 |
| `scripts/bridge-native/` | 重启、超时、账户切换、升级和资源压力验收脚本 |
| 相关设计文档 | 实现完成后同步最终合同和验证结果 |

第一阶段只改 MT5 批量历史隔离。MT4 继续使用现有 EA 有界历史协议，但共享新的状态与覆盖读取模型时必须保持行为兼容；不得为了统一而重写已稳定的 MT4 传输。

## 14. 分阶段实施计划

### 阶段 A：故障基线与诊断修正

目标：先让首发错误可见，不改变交易和历史业务行为。

任务：

1. 增加可复现测试：慢 history 请求超过 10 秒，Live Worker 被毒化并换代。
2. 修正错误优先级，失败响应保留 `worker_request_timeout`，成功旧 generation 仍 fencing。
3. 区分 Live/Archive 预留的诊断字段和 restart counters。
4. 对日志做脱敏与限频测试。

验收门：测试能稳定复现当前故障；修正后首发错误不再被 generation 覆盖；交易 fencing 测试保持通过。

### 阶段 B：新增状态与数据库任务模型（默认不启用新调度）

目标：建立向后兼容的持久化基础。

任务：

1. 创建 initialization/jobs/coverage 表和索引。
2. 实现幂等增量 schema 与旧状态 seed。
3. 实现任务领取、租约、心跳、提交、失败、退避和崩溃恢复。
4. 实现覆盖范围原子合并和 requested-range 查询。
5. 保持旧 history_archive_state 回滚语义。

验收门：旧数据库原地打开不报 incompatible；迁移中途崩溃可重入；回滚旧客户端不会跳过空洞。

### 阶段 C：新账户初始化状态机

目标：实时 Ready 不再等待历史。

任务：

1. 接入账户作用域检测和 initialization record。
2. 将账户/持仓/挂单完整快照和命令核对定义为必要门。
3. 账户切换原子 supersede 旧初始化和历史任务。
4. 生成 recent/backfill 任务，但仍不在 Live Worker 执行批量历史。
5. 增加 local/server/history 三域 Runtime Status。

验收门：全新空数据库下，历史 Worker 未启动时也能完成本地实时 Ready；服务器交易门仍要求现有三快照 ACK 和 reconciliation 安全条件。

### 阶段 D：Archive Worker 与动态范围同步

目标：物理隔离批量历史故障。

任务：

1. 实现只读 Archive Worker 合同、注册表和 Supervisor。
2. 实现 history_range_sync 与动态窗口。
3. 接入任务优先级、整机当前用户并发租约和实时活动让路。
4. 实现超时只重启 Archive Worker、窗口缩小和 blocked dense range。
5. 在真实 MT5 Demo 验证双 Worker 同终端稳定性；失败时 fail closed，不回退 Live。

验收门：故意让 Archive history 调用超时，Live PID、Collector、命令执行和顶层 Online 全程不变。

### 阶段 E：服务器、UI 与消费者兼容

目标：正确消费部分覆盖并向用户解释状态。

任务：

1. 历史响应增加可选 coverage 字段。
2. signal outcomes 使用 requested range/evidence 完整性。
3. 历史页面和导出支持“范围准备中”与重试。
4. UI 增加次级历史状态；内部错误码中文化。
5. 保留旧 Bridge/旧服务器 fallback 测试。

验收门：全局 archive incomplete 但所需范围 complete 时，结果归因可以继续；所需范围不完整时保持 pending，不产生错误平仓结论。

### 阶段 F：完整验证、3.0.0 重打包与分阶段发布

此阶段需要用户另行授权构建、上传、接口切换和部署。

1. 完成 Rust/Python/Node 定向及全量测试。
2. 在真实 MT5 Demo 做大历史量、账户切换、终端重启、Core 重启和断点续传。
3. 在原 Windows Server 故障账户至少连续观察 2 小时，再做 24 小时稳定性验收。
4. 保持应用版本 3.0.0，生成唯一 ReleaseId 和新模块/安装器哈希。
5. 构建与上传、七牛回读、下载元数据切换、虚拟机部署、公网部署分别留证执行。
6. 同版本候选只灰度新安装和人工同路径修复；日常 `current` 自动更新指针保持不变。若要让所有已安装 3.0.0 自动收到修复，必须另发高于 3.0.0 的版本，或另立并审计同版本 ReleaseId 更新协议。

## 15. 测试矩阵

### 15.1 Rust 单元与集成测试

- 旧 DB 没有新表时可无损升级。
- 迁移重复执行、事务中断和重新进入保持幂等。
- existing complete/partial/empty history 正确 seed coverage。
- recent 离散范围不推进 legacy cursor。
- 相邻/重叠 coverage 正确合并，空洞不会被误判完整。
- blocked/retrying job 不会写入 coverage，也不会被 requested-range 查询误判为完整。
- 两个 Core/任务竞争同一 job 时只有一个租约成功。
- 账户/epoch 切换后旧 job 结果不能提交。
- Archive generation 改变只丢弃 Archive 结果。
- Live request 失败保留 primary error；旧 generation 成功仍被拒绝。
- Archive timeout 不改变 Live Registry、Live PID 或 Collector 状态。
- Runtime status 新字段向后兼容且不包含账户身份。
- 顶层 phase 不因 partial/backfilling 改成 degraded。

### 15.2 Python Worker 测试

- Archive role 拒绝所有交易 operation。
- UTC 范围、cursor、limit、身份和时钟校验失败关闭。
- 大量 deals 分批输出不超过 250 条。
- timeout 后同一范围不推进；缩窗后可续跑。
- history_orders 失败时整段不标 complete。
- 关联 SL/TP 证据保持现有规则，不从备注或价格猜测。
- Worker 进程被终止后无孤儿进程、无终端生命周期改变。

### 15.3 Node 服务测试

- `archive_complete=false`、`requested_range_complete=true` 时允许 outcome 证据消费。
- requested range incomplete 时 outcome 保持 pending。
- evidence truncated 时继续拒绝归因。
- 旧 Bridge 只有 `complete` 字段时保持原行为。
- 指定范围导出完整时成功；准备中时不输出 partial 文件。
- history 与 chart_data 对同一日期范围返回一致的 requested-range 完整性。
- 历史分页和 payload byte budget 保持现有上限。

### 15.4 真实 MT5 Demo/Windows 验收

1. 新空账户、新接入旧账户、高频大历史账户各一组。
2. Live 与 Archive Worker 同终端连续运行，执行只读稳定性测试。
3. Archive 请求人工注入 15 秒以上延迟，确认 Live PID 不变。
4. Archive 连续重启时，账户/持仓/挂单持续更新，交易 Demo 命令不被阻塞。
5. Core、UI、Archive Worker、Live Worker、MT5 终端分别重启，确认断点和角色边界。
6. 同终端切换账户，旧范围不串入新账户。
7. 多 Profile 同时回填，整机并发租约生效。
8. 休市/无新报价时遵守现有时钟可信规则。
9. Bridge 退出、暂停、卸载均不关闭 MT5。

### 15.5 推荐验证命令

实现后按影响范围至少运行：

```powershell
cargo fmt --all -- --check
cargo clippy -p bridge-worker-host -p bridge-store -p bridge-terminal-session -p liangjian-bridge-core -p liangjian-bridge-ui --all-targets -- -D warnings
cargo test -p bridge-worker-host -p bridge-store -p bridge-terminal-session -p liangjian-bridge-core -p liangjian-bridge-ui
python -X utf8 -m unittest discover -s bridge/native/workers/mt5/tests -p "test_*.py"
node --check server/routes/ai/signal-outcomes.js
node --check server/bridge-ws.js
npx vitest run tests/ai/signal-outcomes.test.js
powershell -File scripts/bridge-native/test-native.ps1 -SkipRelease
npm test
```

正式打包和发布验证必须使用 `release-liangjian-bridge` Skill，不能把上述源码测试当成发布完成。

## 16. 验收标准

### 16.1 功能

- 新账户无需全量历史即可完成本地实时 Ready。
- 服务器交易 Ready 仍受三类初始快照 ACK 和 reconciliation 门保护。
- 最近历史、按需范围和全量回填均可断点续传。
- 历史页面、导出、结果归因不会把 partial 数据当 complete。

### 16.2 稳定性

- 原故障账户连续 2 小时观察期间 Live Python PID 不因历史任务变化。
- Archive timeout/restart 期间 `worker_consecutive_failures=0`、`collector_consecutive_failures=0`，顶层 Phase 保持 Online。
- 24 小时验收无持续 Worker 重启、无历史任务空转、无日志刷屏。
- Core 重启后历史任务从已提交检查点继续。

### 16.3 数据与安全

- 不删除现有历史、账本、Outbox 或绑定。
- 不跨 terminal/account/Profile 混合历史。
- 不推进失败范围，不猜测缺失交易事实。
- Archive Worker 无交易能力且无法通过伪造请求升级能力。
- 日志和状态不泄露账户号、Broker、路径和凭据。

### 16.4 兼容与回滚

- 新服务器兼容旧 Bridge，新 Bridge 的新增响应字段可被旧服务器忽略。
- 旧 DB 原地升级成功；回滚旧客户端仍能打开并安全继续旧游标。
- 应用版本仍为 3.0.0，但新发布对象不可覆盖旧对象。

## 17. 发布与回滚策略

### 17.1 发布边界

以下每一步都是独立授权：

1. 实现代码。
2. 本地和真实 MT5 Demo 验证。
3. 生成 3.0.0 模块包和完整安装器。
4. 上传七牛云并回读校验。
5. 修改 Bridge 下载/更新元数据。
6. 部署虚拟机网站服务器。
7. 部署公网网站服务器。
8. 未来高于 3.0.0 的日常更新 rollout；本次同版本重打包不具备自动覆盖现有 3.0.0 的能力。

### 17.2 灰度顺序

1. 服务器先上线兼容字段解析，但仍支持旧 complete。
2. 内部 Demo Profile 启用新 Bridge。
3. 原故障 Windows Server 运行新 3.0.0 安装器执行同路径人工修复，核对实际文件哈希后观察 2 小时。
4. 扩大到少量新安装/人工修复用户，观察 24 小时。
5. 确认没有 Live 重启、串账户、历史空洞或结果误归因后再扩大。

### 17.3 回滚触发条件

出现以下任一情况立即停止 rollout：

- Live Worker 因 Archive 任务发生重启或命令延迟显著增加。
- 账户/终端/Profile 历史串写。
- coverage 将未查询范围标为完整。
- 旧 DB 无法打开或旧客户端回滚后跳过数据。
- 交易结果因 partial 历史被错误关闭。
- Archive Worker 获得交易能力或改变 MT5 生命周期。

回滚时恢复上一稳定 bootstrap/更新指针和服务器兼容路径；不得删除用户 SQLite。新表保留并由旧客户端忽略，便于再次升级时继续使用。

## 18. 主要风险与缓解

| 风险 | 等级 | 缓解 |
| --- | --- | --- |
| 两个 Python 进程连接同一 MT5 终端存在未验证冲突 | 高 | 真实 Demo 长时验证；不通过则停止 Archive，不回退 Live |
| coverage 范围合并错误导致把空洞当完整 | 高 | 半开区间、属性测试、事务提交后标记、回滚测试 |
| 新服务器错误接受 partial 结果 | 高 | requested-range + evidence 双门；旧字段 fallback；pending 而非猜测 |
| 数据库增量 schema 使旧库 incompatible | 高 | 基础检查后幂等 ensure，新表不直接破坏 REQUIRED_SCHEMA |
| recent/on-demand 推进 legacy cursor 导致回滚缺口 | 高 | legacy cursor 仅按从 2000 起连续覆盖推进 |
| 多 Profile Archive Worker 造成机器资源争抢 | 中 | 当前 SID 范围全局并发租约，默认 1 |
| 动态窗口仍无法处理极密集的 15 分钟范围 | 中 | blocked_dense_range、定向 ticket 查询、停止自动抖动 |
| 历史状态降级被隐藏 | 中 | 独立限频 warning 和 UI 次级状态，不改变实时 phase |
| 新状态/字段一次修改范围过大 | 中 | 分阶段落地、默认不启用新调度、每阶段独立验收 |
| 保持 3.0.0 无法自动覆盖已安装客户端 | 高 | 明确只用于新安装/人工修复；自动覆盖必须升版本或另审同版本协议 |
| 保持 3.0.0 造成缓存或发布对象混淆 | 中 | 唯一 ReleaseId、内容寻址 URL、新哈希、禁止覆盖 |

## 19. 第一轮方案复审：需求覆盖与最小设计

### 19.1 检查结论

第一轮重点检查用户提出的“新 MT5 账户先初始化、只做必要操作”是否被准确实现，以及是否出现只为技术完整而过度设计。

确认：

- 方案明确把新账户定义为“首次被当前 Profile 识别”，覆盖了实际常见的旧经纪商账户首次接入。
- 必要操作限定为身份、时钟、账户/持仓/挂单快照和本地 uncertain 命令核对，未把完整历史错误纳入交易 Ready。
- 复用了现有三快照、ACK、command ledger、历史 archive items 和分页合同，没有重写交易业务。
- 没有采用单纯加大超时、清库、提高消息上限或直接跳过历史等不完整方案。
- 第一阶段只隔离 MT5 批量历史，MT4 保持兼容，避免无故扩大重构范围。

### 19.2 第一轮发现的问题

1. 仅用一个新的 `coverage_start/coverage_end` 无法表达用户按需查询的离散历史范围，会迫使系统为了查询 2015 年某段数据先补齐中间十年。
2. 只限制每个 Profile 一个 Archive Worker，不能保护管理员多观摩 Profile 同机运行的资源。
3. 若新 recent 范围推进旧 `history_archive_state`，回滚旧客户端会跳过历史空洞。
4. 若双 Worker 不被 MT5 稳定支持，自动回退 Live Worker 会重新引入原故障。
5. 初稿把同版本候选与日常自动更新 rollout 写在同一阶段，但当前更新协调器明确拒绝 `target <= current`，新的 ReleaseId 不能让已安装 3.0.0 自动更新。

### 19.3 第一轮调整

- 将单一覆盖水位调整为可合并的 `history_coverage_ranges`，支持离散 requested range。
- 增加当前 Windows 用户范围的全局历史并发租约，默认并发 1。
- 明确 legacy cursor 只随从 2000 起的连续覆盖推进。
- 明确双 Worker 验证失败时 fail closed：停止 Archive 并保留实时运行，不自动回退 Live。
- 将同版本交付限定为新安装和人工同路径修复，保持日常 current 指针不变；全量自动修复必须提升版本或另立协议。

第一轮结论：调整后需求覆盖完整，设计复杂度来自范围完整性、回滚和多 Profile 的真实约束，不属于无收益的过度设计。

## 20. 第二轮方案复审：兼容、数据、并发与恢复

### 20.1 兼容性与迁移

- 已检查当前 Store 在打开旧数据库前执行严格 REQUIRED_SCHEMA 检查；方案因此采用基础兼容检查后幂等 `ensure_history_runtime_schema()`，避免旧库直接 incompatible。
- 新表为附加结构，旧客户端能够忽略；现有 archive items、Outbox 和 command ledger 不迁移、不删除。
- 新服务器字段均为可选，部署顺序允许新旧 Bridge 并存。

### 20.2 数据与幂等

- 每一覆盖范围只有在 MT5 源查询、响应校验和 SQLite 事务全部成功后才 complete。
- Job 使用作用域、规范化范围、租约 generation 和唯一约束避免重复执行与旧任务提交。
- history item 继续利用现有主键 upsert；重复读取最多增加成本，不产生重复事实。
- legacy cursor 规则保证新旧客户端双向切换不跳过空洞。

### 20.3 并发与账户切换

- Live 与 Archive 采用物理 Registry/Supervisor 隔离，Archive 不能影响交易 fencing。
- 同账户单 Archive 请求、同 Windows 用户全局并发 1，避免多 Profile 同时压垮 MT5 和磁盘。
- 账户/epoch 变化会 supersede 旧任务，旧 generation 结果无法提交到新账户。

### 20.4 异常恢复和时间语义

- 超时、进程崩溃、SQLite Busy、磁盘错误都不推进范围；任务从最后提交检查点恢复。
- 动态窗口和失败窗口持久化，避免重启后重复使用已证明会超时的窗口。
- 所有范围使用 UTC 半开区间；终端时差不可信时暂停，不回退固定时区。
- MT5 日期参数允许边界重叠读取，但入库按 `(UTC time, ticket)` 复合游标和目标半开区间重新过滤，避免同毫秒事件丢失或边界假覆盖。
- Archive 最小窗口持续失败时进入 blocked，避免无限 PID 抖动。

### 20.5 安全、测试与回滚

- Archive 握手不含 ExecuteCommand，当前 SID Pipe ACL 和受保护环境继续保留。
- 测试矩阵覆盖错误优先级、迁移、coverage 空洞、账户切换、超时隔离、服务端 partial 消费和真实 Demo。
- 3.0.0 同版本重发使用新 ReleaseId/哈希/签名对象，发布和部署保持分离授权。

### 20.6 第二轮发现及最终调整

第二轮发现：

1. 若把 P0 交易 reconciliation 也迁移进 Archive 队列，Archive 被阻塞时会延迟不明确交易收敛，并扩大交易安全变更范围。
2. 初稿允许 `history_coverage_ranges.status=blocked`。如果查询或范围合并遗漏状态过滤，可能把失败范围误判为已覆盖，这是不必要的数据风险。

最终调整：

- P0 仍复用现有 Live Worker 的定向 `query_execution`、票号或持仓核对；只有批量历史、结果证据和页面/导出范围进入 Archive。定向核对必须保持小请求和现有 deadline/fencing，不依赖全量历史。
- coverage 表只存完整提交的范围；blocked/retrying 状态只保留在 job 表。requested-range 只需验证完整范围包含关系，减少误判分支。

第二轮结论：最终方案在兼容性、迁移、并发、幂等、异常恢复、时间、安全、测试和回滚方面具备实施条件。剩余最高风险是 MetaTrader5 官方 Python 库对同终端双进程只读连接的真实稳定性，必须作为阶段 D 的硬验收门，未通过不得发布。

## 21. 最终实施建议

建议按 A → B → C → D → E 顺序实现，阶段 D 真实 MT5 双 Worker 验收通过后，才允许进入服务器/UI联调和正式发布准备。实现工作应保持小批次提交，并在每批由主 Agent 复核实际 diff、测试证据和受保护合同。

## 22. 本地实施与复核结果（2026-08-08）

本方案的 A 至 E 阶段源码优化已在本地工作区完成，当前状态为“本地实现及自动化回归通过，等待真实 MT5/目标 Windows Server 验收”。主要落地结果如下：

- 账户实时初始化与历史归档已拆分；同一账户重连不会重复执行首次初始化，账户切换会隔离并 supersede 旧范围任务。
- Live 与 Archive 使用独立 Worker Registry/Supervisor；Archive 只协商历史范围能力，不能执行交易命令，其超时、换代和 blocked 状态不再污染顶层在线状态。
- 历史范围使用 UTC 半开区间、复合游标、动态窗口、租约和完整覆盖提交；P1 可在批次边界优先于 P2/P3，持仓或挂单期间常规历史任务在启动 Archive 前暂停。
- MT5 历史分页共同处理 deals 与 history orders，保留无成交的撤单/历史挂单，并拒绝无法在预算内原子分页的高密度证据，不再静默截断。
- 服务端、Runtime Status 和 UI 使用 requested-range/Archive 次级状态；历史回填中或 Archive 异常不再把实时桥接误报为断线。
- 首发 Worker 通信错误得以保留；不确定命令的 reconciliation 允许在严格账户/终端校验后前移到当前 connection epoch，普通命令匹配仍保持精确 fencing。

主 Agent 完成的实施复核发现并修正了两个额外问题：测试 Worker 的 Archive PID 会覆盖 Live PID；持仓暂停期间最初会高频续租写 SQLite。最终实现改为角色独立 PID、Archive 启动前暂停、Collector 事件唤醒和约 10 秒低频租约续期，P1 唤醒仍可立即让出。

自动化验证已覆盖 Rust 格式与 Clippy、10 个 Rust 包的完整测试、Python Worker 63 项测试、Node 97 项测试以及 Core 进程重连/停止集成测试。真实 MT5 双进程稳定性、目标 Windows Server 长时运行、正式安装包、七牛云对象、下载接口、虚拟机和公网部署均未在本实施阶段执行，仍属于独立验收与发布授权边界。
