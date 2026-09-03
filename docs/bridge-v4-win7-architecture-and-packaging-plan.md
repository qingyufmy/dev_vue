# 量见智桥 V4：Windows 7 架构、安装与更新技术冻结方案

> 状态：架构审查和当前 Windows 开发机最小原型已完成；尚未通过 Windows 7/10/11 隔离实机矩阵，不能宣称已完成兼容性验收或最终技术冻结。
>
> 范围：只设计和验证 Bridge V4 客户端、MT4/MT5 本机适配、设备协议、安装与自动更新。本文不实现服务器业务、网站前端或数据库迁移，不发布安装包；交易验收仅限用户明确授权的本机模拟账户。

## 1. 结论

V4 不继续扩展当前 Rust 3.0 客户端，也不回退旧 Python 单体。首选原型采用：

- **客户端运行时：C# + .NET Framework 4.8 + WinForms，默认编译 x86。** x86 进程可同时运行在 Windows 7 SP1 32/64 位、Windows 10 和 Windows 11，且 Bridge 与终端通过进程外管道通信，不要求和 MT4/MT5 位数一致。
- **本机终端适配：MT4 使用精简 EA，MT5 使用官方 `MetaTrader5` Python Worker。** MT4 通过 Windows 命名管道连接 Bridge Core；每个 MT5 终端档案由一个隔离 Worker 通过官方进程间通信连接用户已经运行的 `terminal64.exe`。不安装 MT5 EA，不引入 Python GUI、PyInstaller/Nuitka、Qt 或 WebView。
- **公网连接：一条账户档案对应一条 WSS 连接。** Windows 7 上不得使用 .NET Framework 自带的 `ClientWebSocket` 作为实现依据；先用独立的 RFC 6455/TLS 传输原型验证。依赖选型必须经过源码、许可证、维护状态和 Win7 实机审查，不能只看 NuGet 的“兼容 net48”。
- **安装器：继续使用 Inno Setup。** 安装后为普通目录文件，不使用 PyInstaller/Nuitka one-file、UPX、内存加载器、随机临时可执行文件或 WebView 运行时。
- **更新：保留签名清单、SHA-256、大小、版本目录、健康检查和失败回滚。** 只保留一个稳定 Launcher/Updater 和一个主程序，不复制现有多层 Bootstrapper/Core/Launcher/Installer 状态机。
- **本地数据：保留 SQLite，按终端档案缓存 K 线、历史订单、成交、资金事件、同步覆盖、命令账本、outbox、回执、游标、时区证据和恢复状态。** 大数据按时间片增量同步和稳定游标分页读取，不设页面驱动的任意业务裁剪；经纪商终端仍是账户与交易事实来源。
- **业务边界：Bridge 只提供基础数据和确定性执行。** 服务器组合风控快照、报表、指标、图表和策略输入，并负责全部权限、会员、额度、策略、风控、交易时段和参数决策；Bridge 不知道这些业务，也不二次修改交易参数。

这是当前最有可能同时满足“Win7、普通安装体验、低资源、可维护、少误报”的方向。**最终定型仍取决于原型和实机矩阵，不以文档结论代替测试。**

## 2. Gitee 历史核查

本地 `origin` 指向 `https://gitee.com/fmyseo/wall-street-skill-local.git`。2026-09-02 的远端读取显示 `main`/`dev_codex` 位于 `131c251b`，`dev_vue` 位于 `9aca292c`；本方案所在本地 `dev_vue` 基线为 `3813000f`。以下结论来自仓库提交和标签，不来自当前工作区猜测。

### 2.1 三代实现

| 时期 | 仓库证据 | 实际技术 | 对 Win7 的证明 |
| --- | --- | --- | --- |
| v1.x / v1.9.x | 标签含 `public/ai/aurum_bridge_gui.py`、`AURUM_Bridge.spec`、单文件 EXE；提交 `383283b1`、`3b44a2b6` 多次修打包依赖 | Python + PyInstaller，后期使用 UPX/one-file | 可见二进制分别携带 Python 3.11/3.12/3.13；不能作为受支持 Win7 运行时证明 |
| v2.4.x / v2.5.0 | `611baa1f` 引入 Nuitka 构建；`requirements-bridge-build.txt` 固定 Python 3.11、Nuitka、PySide6、MT5、NumPy、websockets | Python + Nuitka + PySide6 + Inno Setup | 安装方式接近普通软件，但 Python 3.11 本身不支持 Win7；也不能作为新的长期方案 |
| Rust 前一版 | `bridge/app/AurumBridge/AurumBridge.csproj` 在 `632d0a20^` 明确为 `net10.0-windows`；还有 Launcher、Bootstrapper、SQLite、MT4/MT5 Worker | C# WinForms + .NET 10 | 并非 .NET Framework，不能运行于 Win7 |
| 当前 Rust 版 | `906b9f88` 建立 Rust 基础；`a633f021` 删除 46,446 行旧实现；当前 `rust-toolchain.toml` 固定 Rust 1.97.1、`x86_64-pc-windows-msvc` | Rust 多 crate + 自定义 UI/安装/启动/更新 + MT5 Python Worker | 普通 Rust Windows 目标官方要求 Windows 10+，当前构建不支持 Win7 |

因此，用户记忆中的“旧版能在 Win7 安装使用”可能对应某个未被标签完整表达的实际发布包、特定系统补丁或兼容环境；这个事实值得作为回归输入，但仓库当前可见提交**无法证明是哪一版运行时真正受支持**。后续应优先取得那份实际安装包及 Win7 系统信息，记录 SHA-256、文件版本、内嵌运行时和终端版本，再纳入对照测试。

### 2.2 历史给出的真正启示

- **传统安装体验来自 Inno Setup，不要求继续使用旧运行时。** 安装器与客户端架构应分开选择。
- Python 和 C# 旧版也发生过大量打包、DLL、重连、托盘和更新修复；“换回旧语言”本身不会自动减少 Bug。
- 当前 Rust 生产代码约 8.7 万行、24 个 workspace member，并叠加 MT5 Python Worker和多层更新链；对于只做数据中转和确定性执行的客户端，复杂度明显超过目标职责。
- V4 应重新做窄实现，不能机械迁移任一旧版的内部层次和历史兼容分支。

## 3. 技术候选比较

| 方案 | Win7 | 包体/安装 | 长期安全与维护 | 误报倾向 | 结论 |
| --- | --- | --- | --- | --- | --- |
| Python 3.8 + PyInstaller/Nuitka GUI | 能在 Win7 运行，但 Python 3.8 已停止安全维护 | 运行时和 Qt/NumPy 体积大；one-file 常解包到临时目录 | 依赖旧，旧版已有较多打包故障 | 打包器、压缩和自解包增加可疑特征 | 排除 GUI/打包器路线 |
| **内置 Python 3.8 x64 + 官方 MT5 Worker** | **需与 Win7 最后支持的 MT5 build 联合实测** | **普通目录中的固定运行时，无自解包与 GUI** | **只承载 MT5 官方接口；版本和哈希冻结** | **比 one-file/压缩壳更可解释** | **仅用于 MT5 子进程** |
| 旧 C# `.NET 10` WinForms | 不支持 Win7 | 普通目录安装 | 现代运行时，但不满足硬目标 | 中等 | 排除 |
| 当前普通 Rust MSVC | 官方目标 Windows 10+ | 可做小型原生程序 | 当前代码与发布链已过度复杂 | 未签名新哈希仍有 SmartScreen 风险 | 排除当前目标 |
| Rust Win7 Tier 3 | 理论可行，官方不提供预编译标准库 | 原生、小 | 工具链、依赖和 CI 都需自维护；宿主工具不保证 | 取决于打包和签名 | 只保留对照原型 |
| Go 1.20 | 最后支持 Win7 的 Go 版本 | 单 EXE | 固定在旧工具链，无长期修复 | 新单文件仍需积累信誉 | 排除 |
| Electron/WebView/Tauri | 现代版本不再支持 Win7 | 体积大或依赖系统 WebView | 必须锁定已 EOL 浏览器运行时 | 包含大量运行时文件 | 排除 |
| Qt/C++ | 可显式面向 Win7 | 可控 | 内存安全、依赖、构建和更新成本更高 | 标准目录通常较低 | 备选 |
| **.NET Framework 4.8 + WinForms** | **Microsoft 列出 Win7 SP1 可单独安装** | **传统目录、单一安装器、无 WebView** | OS 已 EOL；框架仍需按 Win7 约束选依赖 | **无打包器/压缩器时相对可控** | **首选原型** |

选择 .NET Framework 4.8 不是因为它“更新”，而是因为它是 Win7 上仍能采用常规桌面开发、托盘、命名管道、DPAPI、文件和 UI 能力的最小折中。所有依赖必须真实包含 `net48` 目标且在 Win7 SP1 实机验证；不能让现代 .NET 或 Windows 8+ API 被间接带入。

## 4. 目标进程与模块

```text
Inno Setup
  ├─ LiangjianBridge.Launcher.exe     # 稳定启动、切换版本、健康检查、回滚
  ├─ versions/<version>/
  │    ├─ LiangjianBridge.exe         # WinForms + Core，同一主进程
  │    ├─ Bridge.Storage.dll          # SQLite 窄存储
  │    ├─ runtime/python/              # 固定 Python 3.8 x64 普通目录运行时
  │    ├─ workers/mt5/worker.py        # 无 GUI 的 MT5 官方接口 Worker
  │    ├─ workers/mt5/trade.py
  │    └─ 经审查的固定依赖和哈希清单
  ├─ terminal/
  │    ├─ LiangjianBridgeMT4.ex4
  │    └─ README.txt                   # MT5 无需安装 EA
  └─ data/                            # 版本外：配置、凭据、SQLite、日志、更新状态
```

主程序内部只保留六个边界：

1. `Shell`：主窗口、托盘、账户档案、连接/暂停、安装或修复 EA、诊断和更新状态。
2. `Profiles`：每个终端档案的生命周期与隔离，不承载业务策略。
3. `TerminalAdapters`：MT4 EA 管道与 MT5 Python Worker 的能力归一化。
4. `Transport`：WSS、心跳、请求/响应、背压、重连和凭据轮换。
5. `ExecutionLedger`：交易命令幂等、截止时间、未知结果和精确对账。
6. `Updater`：下载、验签、暂存，交给 Launcher 原子激活。

禁止再拆出无独立故障域的进程或项目。默认一个主进程管理多个账户档案，每个档案拥有独立取消令牌、WSS、SQLite scope、连接代次和有界队列。MT5 Worker 是必要的官方接口隔离边界，每个已连接的 MT5 档案固定一个 Worker 子进程与一条受保护命名管道；它崩溃时只重启该档案，不取消主进程或其它档案。MT4 继续由终端内 EA 通过独立管道连接。

## 5. MT4 与 MT5 统一适配

### 5.1 为什么 MT5 使用官方 Python Worker

MetaQuotes 官方 `MetaTrader5` Python 包通过进程间通信直接连接本机 MT5，原生提供账户、品种、报价、K 线与成交量、持仓、挂单、历史订单、成交以及 `order_check` / `order_send`。因此 MT5 不需要用户安装、挂载或启用 EA，也不需要 Bridge 自动操作图表或改变算法交易设置。

V4 只复用现有经过测试的无 GUI Worker 数据与交易合同，不复用 Rust Core 的进程层次。`.NET Framework 4.8` 主程序为每个明确终端档案启动一个子进程，显式传入 Python 路径、Worker 路径、终端路径、终端实例、经纪商服务器、登录账号、连接代次和随机 nonce。Worker 只能连接已经运行的目标 `terminal64.exe`，不得自动启动或关闭交易终端。

多 MT5 账户必须使用可区分的终端实例并各自运行一个 Worker。官方 `initialize()` 只能明确终端可执行文件路径和 portable 模式，不能传入任意非便携数据目录；因此同时在线的 MT5 档案必须拥有可唯一定位的独立安装路径，或使用经实测的独立 portable 实例。仅账号不同但共用同一个可执行文件/数据目录的进程不能同时绑定，Bridge 必须提示用户建立独立终端实例，禁止猜测连接。Worker 每次请求前后复核 `terminal_instance_id + broker_server + login + session_epoch`；连接错终端、账户切换、管道断开、超时或进程退出均失败关闭。Bridge 只结束自己启动的 Worker，不结束 MT5。

Win7 交付采用固定 Python 3.8 x64 普通目录运行时，不使用系统 Python、虚拟环境自动下载、PyInstaller/Nuitka、Qt 或 one-file 自解包。`MetaTrader5` 与 NumPy Wheel、Python DLL 和 Worker 源码均进入签名模块清单并校验版本、大小和 SHA-256。当前旧 Worker 锁文件中的 NumPy 版本不作为 Win7 依据；必须重新选择同时支持 CPython 3.8、Win7 和 Worker 数值合同的固定版本，并运行完整单元/实机测试。Python 3.8 已停止安全维护，且 MetaTrader 5 Build 5320 是最后支持 Win7 的版本，因此必须在隔离 Win7 SP1 x64 上冻结并验证一组兼容版本；验证失败时不能宣称 MT5 支持 Win7，也不能静默换用系统 Python。

### 5.2 为什么 MT4 仍使用 EA

MT4 没有等价的官方 Python 集成包。使用第三方桥接通常仍依赖 EA、DLL 或非官方协议，反而扩大兼容和供应链风险。因此 MT4 继续使用精简 EA，通过当前用户受保护的本机命名管道提供相同基础资源和确定性交易操作；不加载 DLL、不访问公网，也不承载策略、风控或 AI 逻辑。

### 5.3 本机管道合同

管道只使用有界长度帧和固定消息类型，不允许脚本、SQL或动态表达式：

```text
hello / capabilities / terminal_identity / heartbeat
query_request / query_response / query_error
command_request / command_result
revision_changed / clock_offset_changed / account_changed
```

每个帧包含 `protocol_version`、`profile_id`、`terminal_instance_id`、`account_identity`、`session_epoch`、`request_id`、`deadline_utc` 和长度校验。交易命令额外包含稳定 `idempotency_key`。Bridge Core 不信任 EA 返回的账号归属，必须将响应与当前管道实例、连接代次和期望账户再次匹配。

## 6. Bridge V4 服务器合同

### 6.1 只暴露稳定基础资源

查询按资源提供窄参数，不使用通用 SQL 风格 `select/filter/sort`：

| 资源 | 必要参数 | 说明 |
| --- | --- | --- |
| `terminal.info` | 无 | 平台、版本、服务器、登录、权限、能力 |
| `terminal.clock` | 无 | 当前校准状态和时差证据，不持续推送终端时间戳 |
| `account.snapshot` | 无 | 余额、净值、保证金等当前快照 |
| `market.symbols` | cursor、limit | 可用交易品种 |
| `market.instrument` | symbol | 合约、digits、volume/stop/freeze 等规格 |
| `market.quote` | symbols，最多固定上限 | 精确报价 |
| `market.candles` | symbol、timeframe、from/to 或 count | 有界 K 线与成交量 |
| `trading.positions` | cursor、limit、可选 symbol | 当前持仓 |
| `trading.pending_orders` | cursor、limit、可选 symbol | 当前挂单 |
| `history.orders` | UTC range、cursor、limit | 有界历史订单 |
| `history.deals` | UTC range、cursor、limit | 有界成交、余额和信用记录 |
| `execution.lookup` | idempotency_key 或 ticket | 不确定命令对账 |
| `diagnostics.health` | level | 脱敏能力、队列和连接诊断 |

`risk.snapshot`、日报、月报、胜率、收益曲线、策略指标和 AI 输入都由服务器并行请求上述基础资源后组合，不进入 Bridge。所谓“以后无需修改 Bridge”只适用于**已有基础字段的新组合**；若 MT 新增了当前协议未暴露的原始能力，仍需经过版本化协议扩展，不能用任意脚本或万能查询绕开升级。

### 6.2 实时数据与精确请求

- WSS 主动事件只保留：连接/账户/能力/时区变化，命令回执，positions/orders/account revision，以及订阅中的 quotes/current-candle 增量。
- 初始一致快照、有界历史、品种规格和诊断使用服务器发起的精确请求。
- 每个订阅都有资源、品种、周期、频率、字段上限和 TTL；取消后立即停止。
- 慢消费者先合并报价和当前 K 线，再丢弃可重建事件；交易回执、账户切换和 revision gap 不得丢弃。
- 服务器发现 revision 缺口时重新取 HTTP/Bridge 快照，不让客户端无限缓存事件。

### 6.3 确定性交易命令

只保留固定命令：

- `order.place`
- `position.protection.set`
- `position.close`
- `pending_order.modify`
- `pending_order.cancel`
- `execution.lookup`

服务器负责权限、策略分发、风控、额度、允许品种、手数、止盈止损、交易时段和其它业务判断。Bridge 不复制经纪商规格或业务规则，不提前收紧服务端参数；它只校验消息完整性、当前终端与账户路由、连接代次、截止时间、幂等键和精确目标身份，然后调用 MT4/MT5。终端成功或拒绝均连同原始代码和执行后实际状态回传。命令一旦可能写入终端，断线或超时只能进入 `uncertain` 并精确查询，禁止普通重发。

上述协议、路由、期限、幂等和精确目标检查不是交易业务限制：服务器无法在命令已经进入用户电脑后阻止离线旧命令、重复命令或错账户命令被执行，因此只能由 Bridge 在最终调用点完成。除这些分布式执行安全条件外，Bridge 不判断命令“是否应该交易”。

### 6.4 SQLite 大数据读取投影

- 每个终端档案使用独立 SQLite scope，禁止跨账号复用 K 线、订单、成交、资金事件、覆盖范围或游标。
- K 线按 `symbol + timeframe + open_time_utc_msc` 幂等写入；当前未收线 K 线允许覆盖更新，收线后作为稳定历史保存。
- MT4/MT5 历史按有界 UTC 时间片和稳定时间/票号游标增量同步；终端历史不可证明完整时必须记录缺口，不得返回“完整”。
- 服务端查询命中已覆盖范围时直接分页读取 SQLite；存在缺口时触发对应档案后台补齐并返回可解释的 `refreshing/incomplete` 状态，不阻塞交易命令通道。
- SQLite 使用 WAL、单写者、独立只读连接、短事务和必要索引；历史同步、整理和清理使用低优先级队列。磁盘不足、损坏或迁移失败时明确报错，禁止静默删除尚未同步到服务端或仍用于对账的数据。
- SQLite 只保存终端事实及同步证据；收益曲线、风控快照、AI 输入、日报、月报和跨资源统计仍由服务器组合。

### 6.5 缓存分级、保留期与安全清理

本地数据必须先区分“执行安全证据”“终端历史事实”“可重建缓存”和“瞬时状态”，禁止用统一 TTL 清表：

| 数据等级 | 代表数据 | 默认保留与清理规则 |
| --- | --- | --- |
| 不可淘汰 | 未获服务端 ACK 的命令账本、执行回执、Outbox、`uncertain` 对账、尚未上传的历史事实 | 不按时间删除；只有服务端完成持久化确认且本地状态闭环后才能降级 |
| 已确认事实 | 历史订单、成交、规范化交易、入出金/余额/信用事件 | 服务端确认持久化后本地至少保留 365 天；超过保留期才成为可清理候选，服务端数据库继续作为长期查询来源 |
| 恢复投影 | 账户、持仓、挂单最后状态、stream revision、时区校准证据 | 当前 epoch 保留；被新 epoch 取代且无待对账引用后保留 7 天再删除。读取时始终标记 `live/stale/offline/unknown`，不得把旧投影冒充实时事实 |
| 可重建市场缓存 | 已收盘 K 线及成交量 | 只缓存服务端实际请求或订阅使用的 `symbol + timeframe + range`；同时满足“最后访问超过 30 天”和“收盘时间超过 180 天”才可按最旧优先清理 |
| 短缓存 | 品种目录、合约规格 | 当前绑定按版本/终端 build 刷新；被替换版本保留 30 天后删除 |
| 运行痕迹 | 已完成同步任务、过期 snapshot/cursor lease、临时下载和脱敏日志 | 完成任务与 lease 保留 7 天；日志默认 30 天轮转；失败诊断仍被活动问题引用时顺延 |
| 仅内存 | Bid/Ask、心跳、延迟、在线状态、当前未收 K 线 | 不进入常规 SQLite；当前 K 线可按低频检查点恢复，但不得按 tick 高频写盘 |

这些天数是 V4 首版可配置默认值，不是交易或会员业务限制。配置只能延长安全数据保留期，不能让未确认数据提前进入可删除状态。正式发布前应依据 1 万、10 万和 100 万条历史数据以及多周期 K 线基准调整默认值。

清理任务遵循以下规则：

- 只在对应档案空闲时进入低优先级维护队列；每批最多 500 行、短事务提交，批次之间主动让出执行权，禁止占用交易命令队列。
- 同时检查数据年龄、最后访问时间、服务端 ACK/上传水位、活动 cursor/snapshot 和 `uncertain` 引用；任一证据不足即跳过。
- K 线、品种目录等可重建数据允许在磁盘软水位触发后提前按 LRU 清理，但不得删除当前订阅范围、当前未收 K 线或正在补齐的覆盖区间。磁盘软水位的具体容量值在实测后冻结。
- 活动 cursor 引用的数据不得删除；cursor 自身过期后，后续请求返回稳定 `cursor_expired`，由服务端从新快照第一页恢复，禁止跳页或伪装完整。
- 删除后同步修正覆盖范围；下一次读取缺失区间时按正常后台同步重新获取，不返回旧 `complete` 标记。
- 普通 `DELETE` 后复用空闲页，不在交互时段执行全库 `VACUUM`。新库启用增量回收能力，WAL checkpoint 与增量回收仅在空闲、无长读事务时小步执行。
- 档案删除不立刻硬删数据库；默认进入 30 天可恢复隔离区。用户明确选择“同时删除本地数据”时也必须先保护未 ACK 执行证据，并提示服务器长期记录不会随本地缓存删除。

### 6.6 每档案 SQLite 最小表结构

每个档案使用独立 `data/profiles/<local-profile-key>/bridge.db`。路径只使用本地生成的安全键，不直接拼接账号、Broker 名或服务端输入。首版保持一个数据库文件和一个写入协调器，不先拆“交易库/行情库”；只有基准证明大历史写入仍影响命令账本时才提出拆库。

| 表 | 最小职责与关键键 |
| --- | --- |
| `schema_migrations` | `version` 主键、迁移 checksum、应用时间；迁移只追加且每步可校验 |
| `profile_state` | 单行保存 `profile_id`、terminal/account route、platform、`connection_epoch`、terminal build、时区偏移/状态/revision；打开数据库时必须与当前档案精确匹配 |
| `stream_state` | `resource` 主键，保存 revision、payload hash、observed/source time 和 `live/stale/offline/unknown` |
| `account_latest` | 单行账户最后投影与原始规范化 JSON，只用于恢复、差异计算和离线明确标记的展示 |
| `positions_latest` | `ticket` 主键，保存当前 epoch、revision、更新时间与规范化 JSON；full snapshot 事务化替换 |
| `pending_orders_latest` | `ticket` 主键，语义同持仓最新投影 |
| `instrument_cache` | `symbol` 主键，保存 terminal build、规格 revision、observed/last-accessed/expire 时间和规范化 JSON |
| `market_candles` | 复合主键 `symbol + timeframe + open_time_utc_msc`；标量保存 OHLC、tick/real volume、spread、closed、revision、observed/last-accessed 时间 |
| `history_items` | 复合主键 `item_kind + item_id`；标量保存 event time、ticket/order/position、symbol、资金类型与金额等高频查询字段，完整终端事实保存在规范化 JSON。MT ticket/order/position 统一按有界数字字符串 `TEXT` 保存和传输，不压入有符号 64 位整数 |
| `coverage_ranges` | `resource + scope_key + range_start` 主键；保存半开区间、完整性、source revision 和更新时间；K 线 scope 必须包含 symbol/timeframe |
| `sync_jobs` | 精确资源/范围同步任务及 `queued/running/retry_wait/completed/blocked/superseded`、游标、租约、尝试次数和稳定错误码 |
| `query_snapshots` | snapshot ID、resource、scope/query hash、冻结 revision、创建/过期时间；只保存游标保护证据，不复制整页结果 |
| `server_coverage_acks` | 服务端数据库提交后确认的 resource/scope/range/revision；本地历史清理只能引用该证据，普通 WebSocket 收到或页面读取成功不等于持久化 ACK |
| `command_ledger` | command/idempotency、请求 hash、状态、终端结果、`uncertain` 和服务端 ACK；沿用已验证的幂等边界 |
| `outbox_messages` | 尚未确认的命令结果、必要 revision 和历史同步通知；按优先级、重试时间和 ACK 状态索引 |
| `maintenance_state` | 最近清理、WAL checkpoint、增量回收、磁盘水位和稳定错误；不得保存业务配置 |

原则上使用规范化标量建立主键、范围和常用过滤索引，同时保留版本化 JSON 以无损回传终端字段。禁止只按 `params_hash` 保存整包 K 线或历史响应，否则相邻查询会重复存储同一记录，也无法安全合并覆盖范围或小批删除。

首版必要索引仅包括：K 线时间升序、历史 `item_kind + event_time + item_id` 稳定分页、ticket/order/position 对账、覆盖范围、同步任务领取、Outbox 待发送和命令状态。新增页面字段不得自动新增本地索引；先由服务器组合，只有真实查询计划和基准证明需要时才追加迁移。

### 6.7 数据同步、读取与清理状态机

历史/K 线读取采用以下闭环：

```text
server query
  -> verify route / epoch / deadline
  -> inspect local coverage
     -> covered and fresh: freeze revision -> page from SQLite
     -> gap or stale: coalesce bounded sync job -> return refreshing/incomplete
  -> terminal worker reads one bounded slice
  -> normalize + rows + coverage + revision commit in one short transaction
  -> serve stable keyset pages
  -> server commits durable copy when needed
  -> server sends explicit data.persisted.ack
  -> local range becomes retention-eligible
```

- 相同档案、资源、scope 和重叠范围的同步任务合并，交易命令永远比行情回填、历史回填和清理优先。
- 所有时间字段都是 Unix epoch UTC milliseconds；禁止直接使用从公元 1 年起算的 .NET `DateTime.Ticks`。MT4/MT5 原始时间在适配层转换后必须通过范围测试。
- K 线和历史写入每批最多 500 条，在一个短事务中复用参数化命令；禁止每条记录单独开事务。服务端/Worker 响应携带的期望 epoch 必须在获得写门后再次校验，旧 epoch 批次整体拒绝。
- 当前未收 K 线只在内存中覆盖；收线事件或下一根出现时，把最终 OHLC/成交量写入 `market_candles` 并扩大覆盖范围。异常退出后直接从终端重取尾部，不依赖每秒落盘。
- 历史批次必须以 `event_time_utc_msc + stable item id` 作为 keyset 边界；写入使用 upsert，重复同步不产生重复记录。MT4 无法证明“账户历史”页更早范围时保持 `incomplete`。
- 当前账户、持仓和挂单先生成全量基线再发送 revision 增量；重启后 SQLite 只提供 last-known 基线，终端新快照确认前状态为 `stale`。
- 服务端持久化 ACK 必须绑定档案、账户 route、resource、scope、range 和 source revision。ACK 越过缺口、来自旧 epoch 或 revision 不匹配时拒绝推进清理水位。
- 该确认使用严格设备消息 `data.persisted.ack`，只覆盖已落入服务端数据库的 K 线和历史资源；`persisted/duplicate` 均表示服务端已拥有同一 revision 的事实，普通查询响应或流 ACK 不得推进本地清理资格。
- 清理在同一事务内删除候选行，并拆分、收缩或保守地把与实际删除区间相交的 `coverage_ranges` 标记为 `incomplete`；禁止留下仍声称完整的覆盖。任一步失败整体回滚。清理任务失败只标记维护状态，不停止终端会话、WebSocket 或其它档案。
- 数据库忙、磁盘不足、损坏或迁移不兼容时，查询返回稳定错误和现有完整性证据；交易结果首先进入命令安全写入路径，不能为了腾空间删除未 ACK 数据或继续假报成功。

## 7. 多账户与连接额度

- 一个档案只绑定一个 `terminal_instance_id + broker_server + login`，并持有一条账户 WSS。
- 用户默认 1 条在线账户连接额度；购买后按有效 grant 增加。额度只统计当前 WebSocket lease，不限制保存多少离线档案。
- 用户可新增、断开、删除和更换 MT4/MT5 档案；删除本地档案不得删除服务器交易历史或审计。
- 同一稳定交易账户同一时刻只能有一个可交易 route；新连接通过 `session_epoch` 接管，旧连接立刻失去执行资格。
- 各档案的策略订阅、交易权限、时区、命令账本、队列和缓存完全隔离，一个档案故障不影响其它档案。

详细权益与租约模型继续执行 [Bridge 并发连接额度与账户级策略订阅模型](./bridge-connection-quota-and-account-subscription-model.md)。

## 8. Windows 7 网络兼容硬门

.NET Framework 4.8 可安装到 Windows 7 SP1，但 Microsoft 明确说明其公共 WebSocket 客户端实现只支持 Windows 8/Server 2012 及以上。因此：

1. 禁止在 Win7 原型中用 `ClientWebSocket` 成功编译冒充成功运行。
2. WSS 实现必须真实建立 TLS 1.2、代理和 RFC 6455 连接，验证证书链、SNI、ping/pong、fragment、close、backpressure、半开连接和重连。
3. 候选传输依赖必须有可审查源码、可接受许可证、固定版本、无动态下载、无证书跳过选项，并通过依赖漏洞检查。
4. 若第三方库不满足要求，允许在独立小模块中实现受限 RFC 6455 客户端；必须通过 Autobahn 客户端测试集和故障注入，不能在业务代码里零散手写帧。
5. Windows 7 必须安装 SP1、SHA-2 代码签名支持更新、可用根证书和 TLS 1.2；缺失时安装器只诊断并提示，不能静默降低到 TLS 1.0、忽略证书或明文公网连接。

## 9. 安装、自动更新与旧版迁移

### 9.1 普通安装体验

Inno Setup 继续提供：安装目录、开始菜单、桌面图标可选、开机启动可选、修复、卸载和版本信息。安装器安装 Bridge、MT4 EA，以及 MT5 Worker 所需的固定 Python 3.8 x64 普通目录运行时；不安装 Python GUI/包管理器，不修改系统 Python，不捆绑浏览器或交易终端。

程序文件放在 `Program Files`，用户数据放在 `%LOCALAPPDATA%\Liangjian\BridgeV4`，凭据用当前 Windows 用户 DPAPI 保护。日志默认轮转并脱敏；卸载默认保留用户配置与账本，用户显式勾选后才删除本地数据。

`.NET Framework 4.8` 依赖由安装链处理，不要求普通用户预先判断或手动安装：

- Bootstrapper 同时检查 32 位和 64 位注册表视图中的 `HKLM\SOFTWARE\Microsoft\NET Framework Setup\NDP\v4\Full\Release`，值大于或等于 `528040` 即视为满足 4.8 或更高版本；不得用文件版本、文件是否存在或精确等号判断。
- 已满足依赖时直接安装 Bridge，不重复下载或修复 .NET。
- 官网下载页提供两个明确入口：推荐的“小型在线安装包”和用于弱网/离线电脑的“离线完整安装包”。两者安装后的 Bridge 功能完全相同。
- 在线安装包缺少依赖时，只从固定的 Microsoft 官方 HTTPS 地址下载 .NET Framework 4.8 Runtime，验证 Microsoft Authenticode 签名、预期产品和固定 SHA-256 后再启动安装；下载或验证失败时停止并显示可操作原因，禁止切换到第三方镜像。
- 离线完整安装包包含 Microsoft 官方 .NET Framework 4.8 x86/x64 离线 Runtime；不默认附带 Developer Pack。简体中文语言包只影响框架自身错误文本，作为可选组件评估，不是 Bridge 启动依赖。
- Windows 7 必须先满足 SP1 和 Microsoft 官方前置更新。缺少系统条件时只显示准确说明和官方帮助入口，不静默安装未知系统补丁，也不降级到旧 .NET 或不安全 TLS。
- .NET 安装要求重启时，Bootstrapper 保存不含凭据的续装状态；用户确认重启后，由固定 RunOnce 入口继续同一安装事务。取消重启时不得把 Bridge 标记为安装成功。
- 前端下载页另提供“仅下载 Microsoft .NET Framework 4.8 Runtime”的故障排查入口，但它是辅助项，不作为普通安装主流程。
- `.NET Framework 4.8` 只由首次安装、修复安装或明确的运行时升级处理；后续 Bridge 模块自动更新不重复携带、下载或重装 Runtime。更新清单声明最低运行时版本，若未来必须提高版本，应转入完整安装器升级并重新评估 Win7，不能由静默模块更新改变系统依赖。

下载页展示包体大小、适用场景、Bridge 版本、发布日期、SHA-256 和系统要求；不得把 `.NET Framework 4.8` Developer Pack、现代 `.NET Desktop Runtime` 或 `.NET 8/10` 错当成客户端依赖。

Python/MT5 Worker 属于 Bridge 自身版本目录内的受签名模块，不作为用户单独下载的前置依赖：

- 安装和更新只使用发布包中固定的 `python.exe`、标准库、NumPy、`MetaTrader5` 和 Worker 文件，启动前逐项校验清单。
- 不调用 `pip install`，不从用户 PATH、注册表或虚拟环境寻找 Python，也不联网下载 Wheel。
- MT5 模块只安装 x64；Win7 x86 可以运行 x86 Bridge 与 MT4，但不能宣称支持当前官方 MT5 Python 包。
- Python/MT5 模块升级必须经过 Win7 最后支持终端 build 与当前 Win10/11 终端 build 的双向兼容测试；失败时整模块回滚，不能只替换其中一个 Wheel。

### 9.2 简化更新链

```text
main app -> download signed manifest/package -> verify -> stage
launcher -> drain main app -> switch current version -> health check
         -> success: keep new + previous
         -> failure: restore previous -> show reason
```

- Launcher 固定且极少更新；主程序不能覆盖自己。
- 清单和包使用项目 P-256 签名，并校验 SHA-256、大小、渠道、版本、最低升级版本和到期时间。
- 激活前必须等待交易命令队列排空；存在 `accepted/sent/uncertain` 命令时延后更新。
- 自动分析调度只在服务端。服务端在 `release.available.restart_not_before_utc_msc` 中给出已避开分析触发点的最早重启时间；Bridge 不缓存策略时刻表。更新包完成校验和暂存后，到达该时间且本机无执行中命令、`uncertain` 对账或关键落盘时，固定 Launcher 原子切换 `current.txt` 并自动重启新版本；新版本健康失败恢复 `previous.txt`。
- 更新不启动或关闭 MT4/MT5，不修改终端登录状态。
- V3 到 V4 通过一次性迁移更新保留经确认的服务端候选地址、用户偏好和终端档案映射。旧 DPAPI 刷新凭据只能通过服务端一次性交换为 V4 设备凭据，禁止复制为 Bearer；旧缓存、日志、命令账本、快照和游标不迁入 V4，旧目录保持原样用于失败回滚和审计。迁移完成后不再维持 V3 业务协议。
- 旧版自动更新入口只作为有期限的迁移发现通道。迁移失败必须继续启动旧版本，并允许用户查看原因和重试。

## 10. 降低杀毒误报的工程规则

“不容易报毒”可以降低概率，但在没有公共 Authenticode 证书时不能承诺零警告。Microsoft SmartScreen 同时使用发布者信誉和文件哈希信誉；未签名的新版本通常每次都要重新积累哈希信誉。

V4 必须做到：

- 不使用 UPX、混淆器、壳、one-file 自解包、内存执行、随机临时 EXE、隐藏 PowerShell/批处理下载器或自修改主程序。
- 安装后文件名、路径、公司名、产品名、版本、图标和描述稳定；构建可重复，发布 SHA-256、文件清单和 SBOM。
- 更新下载、校验和激活由独立、可见且固定路径的组件完成；不在主程序内注入、替换运行中二进制或绕过系统权限。
- 每个候选安装包在隔离测试环境扫描 Windows Defender，并记录引擎版本、定义版本、文件哈希和结果；发现误报通过 Microsoft 的软件开发者入口提交样本。
- 项目签名继续保证更新包来源与完整性，但不得向用户暗示它等同于 Windows Authenticode 发布者签名。
- 将 Authenticode 作为未来可选增强；如果仍坚持不购买证书，接受 SmartScreen “未知发布者/不常下载”可能持续出现的事实。

## 11. 原型与实机验收矩阵

### 11.1 原型 A：首选 `.NET Framework 4.8`

最小交付只实现：

- WinForms 窗口和托盘；
- 一条 WSS 登录/心跳/请求响应；
- 一个 MT4 EA 管道，以及每个 MT5 档案一个官方 Python Worker/受保护命名管道；
- `terminal.info`、`account.snapshot`、`market.quote`、`market.candles`、positions/orders；
- 使用模拟终端的六个交易命令账本、重复投递和不确定结果对账；
- SQLite 持久化；
- Inno 安装、覆盖升级、回滚和配置保留。

### 11.2 原型 B：Rust Win7 对照

只实现相同的 WSS、TLS、SQLite、管道和更新冒烟，不移植现有 Rust 业务代码。若需要大量自建工具链补丁、依赖降级或专用 CI 才能运行，即视为维护成本证据，不为证明 Rust 可行而扩大范围。

### 11.3 必测矩阵

| 维度 | 最低覆盖 |
| --- | --- |
| OS | Win7 SP1 x86（Bridge + MT4）、Win7 SP1 x64、Win10 22H2 x64、Win11 x64 |
| 终端 | 真实 MT4、真实 MT5；记录经纪商、终端 build、位数、数据目录和是否 portable；Win7 MT5 固定验证 Build 5320 或经纪商仍可运行的最后兼容 build |
| 网络 | TLS 1.2、系统代理、断网、丢包、半开、服务器重启、证书失败、根证书缺失 |
| 数据 | 报价、K线/成交量、账户、持仓、挂单、分页历史、账户切换、时区变化 |
| 命令 | 模拟端全覆盖；取得单独授权后才在测试账户下单、修改、撤单和平仓 |
| 多档案 | 1、2、5 个在线账户；额度拒绝、TTL 释放、接管、单档案崩溃隔离 |
| 安装更新 | 全新安装、旧版迁移、覆盖升级、断电/杀进程、签名错误、磁盘满、健康失败回滚 |
| 运行时依赖 | 已装 4.8/4.8.1、未安装、仅 4.7.2、在线安装、离线安装、需重启、取消重启、签名或哈希错误；MT5 固定 Python/NumPy/MetaTrader5 文件缺失、篡改、版本不匹配和模块回滚 |
| 安全/误报 | Defender、SmartScreen 行为、VirusTotal 只上传可公开候选包、SBOM/哈希复核 |
| 长稳 | 24 小时冒烟、72 小时稳定性；句柄、线程、内存、SQLite/WAL 和消息积压 |

通过标准：所有目标系统能安装、启动、连接和退出；Bridge 退出不影响终端；重复命令不产生重复交易；未知结果可对账；单档案故障不影响其它档案；失败更新自动回滚；无未解释崩溃、数据串号和未解释杀毒命中。

## 12. 实施顺序

1. 冻结本文件和设备协议的资源/命令边界，不改现有生产 Bridge。
2. 准备隔离的 Win7/10/11 虚拟机、Visual Studio Build Tools/.NET 4.8 Developer Pack、Inno Setup 和 MT4/MT5 测试终端。
3. 先做 WSS/TLS 与 Inno 安装的 `.NET Framework 4.8` 最小原型；这是最大未知项。
4. 复用现有 MT5 官方 Python Worker 合同并实现 `.NET Framework 4.8` 多 Worker 主机，同时完成 MT4 EA 管道；先读数据，再在用户明确授权的模拟账户执行最小手数交易矩阵。
5. 做 Rust Win7 对照原型并按同一矩阵评分。
6. 用户确认最终技术栈后，才建立 V4 正式目录、迁移设备合同和实现多档案。
7. 完成旧版自动升级与回滚演练后，才安排真实测试账户验收；发布、上传和线上切换另行确认。

## 13. 第一轮复审：需求与最小职责

复审问题：是否满足 Win7、MT4/MT5、多账户、精确请求、确定性执行、自动更新和普通安装体验；是否把服务器业务错误地下放到客户端。

发现与调整：

- 初版为了减少运行时把 MT5 改成 EA/Service，但这会增加普通用户安装、挂载和维护成本，也重复官方 Python 接口已经稳定提供的能力。调整为“MT4 精简 EA + MT5 官方 Python Worker”，只复用现有 Worker 合同，不复用旧 GUI 或复杂 Rust 进程结构。
- “服务器想要什么就查询什么”若实现为通用 select/filter 会演变成客户端数据库；改为稳定基础资源和窄参数，由服务器组合。
- 单纯保留当前全部多进程层次会复制复杂状态机；只保留 MT5 官方接口必须的每档案 Worker 子进程，其余仍由一个主进程按档案隔离。
- 安装器和运行时解耦，保留 Inno 的用户体验；固定 Python 普通目录只作为 MT5 内部模块，不回退旧 Python GUI/打包器。

结论：方案覆盖用户目标，并把 Bridge 收敛为数据、执行、诊断和更新四项职责。

## 14. 第二轮复审：兼容、安全与故障恢复

复审问题：Win7 结论是否过度承诺；WSS、终端版本、交易幂等、更新、误报和多档案故障是否存在隐藏依赖。

发现与调整：

- `.NET Framework 4.8` 可安装不代表内置 WebSocket 可用；补充 Windows 7 `ClientWebSocket` 禁用结论和独立 RFC 6455/TLS 原型硬门。
- MetaTrader 对 Win7 的支持随 build 变化，经纪商定制版也可能不同；验收矩阵必须固定真实终端 build，不能只写“MT5”。
- Python 3.8 与 Win7 最后支持的 MT5 build 均已停止主流更新，存在安全和兼容冻结风险；已要求只从签名版本目录加载、禁止联网装包，并把 Worker/终端组合纳入独立兼容矩阵和整模块回滚。
- 当前旧锁文件的 NumPy 版本不能用于 CPython 3.8；将 Win7 依赖锁与现代系统依赖锁分开生成和验证，任何 Wheel 不兼容都在安装前失败，不允许运行时临时降级。
- 官方 Python 初始化不能用任意数据目录区分同一路径下的多个非 portable 终端；多账户规则收紧为独立安装路径或经验证的 portable 实例，每个 Worker 启动握手后必须再核对 Broker 与登录账号。
- 无 Authenticode 时不能保证不弹 SmartScreen；将目标改为消除高风险打包特征、提供可复核供应链和标准误报申诉，而非虚假承诺。
- 一个主进程管理多账户仍可能出现连带取消和串号；补充每档案独立 epoch、队列、SQLite scope、WSS，以及每个 MT5 Worker 独立进程/管道/nonce 和故障注入门。
- 新组合无需更新 Bridge 不等于永不更新；补充“已有基础字段可组合、新原始能力必须版本化扩展”的边界。
- MT5 不再要求用户安装 EA；Worker 只能连接用户已启动的明确终端，Bridge 退出只结束 Worker。MT4 仍保留安装/修复与手动挂载引导，禁止自动操作终端。

结论：第二轮问题已回写正文。当前方案可进入原型，但在实机矩阵完成前不得标记阶段 8 完成或宣称 V4 支持 Win7。

## 15. 原型实现与验证记录

- `git ls-remote --heads origin` 成功读取 Gitee 远端分支；没有 fetch、checkout、commit 或 push。
- `git show 632d0a20^:bridge/app/AurumBridge/AurumBridge.csproj` 确认 Rust 前 C# 版为 `net10.0-windows`；`git show 611baa1f:public/ai/requirements-bridge-build.txt` 确认 Nuitka 版固定 Python 3.11 x64。
- 当前 `bridge/native` 统计为 79 个 Rust 文件、87,153 行；`rust-toolchain.toml` 固定 `1.97.1` 与 `x86_64-pc-windows-msvc`，README 明确只支持 Windows 10 22H2/Windows 11 x64。
- 已在 `bridge/prototypes/net48-win7/` 建立与当前 Rust 客户端隔离的最小原型。原型包含 WinForms 主程序、无业务 DLL 依赖的稳定 Launcher、严格 V4 信封、资源/命令白名单、RFC 6455 帧与握手、TLS 1.2 WSS、当前用户 ACL 命名管道、SQLite 命令账本、运行时检测、原子版本切换和回滚原语。
- 当前开发机运行时注册表 `Release=533320`，满足 4.8.1；缺少 4.8 Targeting Pack，因此本地原型临时使用框架编译器构建。正式 CI 仍必须安装 4.8 Developer Pack 并使用 MSBuild，禁止把运行时程序集作为长期引用程序集。
- x86 与 x64 的离线冒烟覆盖严格信封、未知字段拒绝、窄资源目录、RFC 6455 accept、客户端掩码、服务端帧、定长 UTF-8 管道帧、真实命名管道双向通信、终端请求合同、SQLite 幂等/冲突/`uncertain` 对账/档案隔离/重开持久化、版本路径约束和激活回滚；具体计数以当前测试脚本最终输出为准。
- x86 原型通过 `wss://ws.postman-echo.com/raw` 的真实 TLS 1.2 握手、证书链校验、文本发送和回显接收；未跳过证书校验，也未使用 `ClientWebSocket`。这不替代 Win7、系统代理、断网、半开和 Autobahn 验收。
- `System.Data.SQLite.Core 1.0.119` 只从 NuGet 官方固定地址在开发构建阶段获取，包 SHA-256 固定为 `F5F86B80729323890DA590A8C7BA7957F04E2735E583D075220D1521745E9F4C`；运行时不动态下载数据库依赖。
- 本机已发现并使用用户级 Inno Setup 6.7.3。在线、离线原型安装包均成功编译；在线包固定 Microsoft Web Runtime SHA-256 `0BBA3094588C4BFEC301939985222A20B340BF03431563DEC8B2B4478B06FFFA`，离线 Runtime 固定 SHA-256 `0A3A390C47E639D0F7FC65B21195FEE6B7F65B066F80F70C60FAB191D14B7E40`。两份原始 Runtime 当前 Authenticode 均为 Microsoft Corporation 有效签名。
- 安装器内置一个无下载能力的静态 x86 校验器，在 .NET 缺失时调用系统 WinTrust 并校验 CompanyName/ProductName；本机已验证它接受官方 Web/Offline Runtime，并拒绝非 `.NET Framework` 产品。在线下载同时由 Inno 固定 SHA-256、HTTPS 和系统代理保护。
- 在线安装器已在仓库限定的临时目录完成“安装 → 稳定 Launcher → 版本目录主程序 → 正常退出 → 卸载”闭环。首次冒烟发现 Launcher 错误依赖主 Core DLL，已改为完全独立并复测通过。
- `contracts/bridge-v4.schema.json` 已删除通用 `select/filter/sort`，改为 14 个稳定基础资源、资源专属 `params`、7 类窄实时资源和 6 个确定性命令；Draft 2020-12 元模式检查、合法 K 线请求和组合型 `risk.snapshot` 拒绝用例通过。
- 2026-09-02 已在当前 Windows 开发机直接运行 `bridge/native/workers/mt5/worker.py --probe`，官方 Python 集成成功绑定用户已经启动的 MT5 模拟终端；没有安装或挂载 MT5 EA，也没有改变算法交易设置。
- 同一终端通过现有实机脚本完成三组只读验收：85 个品种、100 根 M5 K 线及成交量、账户/报价/持仓/挂单、风控与性能基础数据、诊断，以及有界历史订单/成交/规范化交易；经纪商时钟状态为 `verified`。
- 用户明确授权后，同一模拟账户完成最小手数交易矩阵：挂单创建、改单、撤单、市场开仓、止盈止损修改、部分平仓和最终平仓全部成功；结束时测试挂单和持仓集合均为空。该结果证明当前 Win11 + 当前 Python/MT5 组合，不证明 Win7 兼容。
- `.NET Framework 4.8` 原型已通过独立 `Mt5WorkerHost` 复用同一 Python IPC v2 合同。每个 `terminal_instance_id` 拥有独立 Worker 进程、当前用户 ACL 命名管道、随机 nonce、route 与 epoch；Host 严格校验 hello、能力、请求 ID 和响应 route。连接超时会先关闭管道以取消异步等待；Worker 空闲退出或握手后立即退出会原子移除会话且最多上报一次断开，主动停止不会误报。
- x86/x64 原型离线冒烟均通过，包含永不连接、握手后退出、20 轮极短退出竞态、固定 MT4 命令 wire、严格十进制、旧别名拒绝、完整预期状态和 MT4 stop-limit 拒绝；最终 x64 Host 真实连接当前 MT5 完成账户/持仓/挂单快照、报价、100 根 M5 K 线、品种列表和 7 天有界历史读取，随后确认没有残留 Python Worker 进程。该结果仅证明当前开发机上的进程隔离与 IPC，不代替多终端并行、Win7 固定运行时或长稳验收。
- SQLite 第二批原型已使用追加式 V2 migration 落地恢复投影、stream 状态、instrument 短缓存、同步任务租约、Outbox、维护状态和分级清理；V1 SQL 由固定 SHA-256 回归保护，旧 V1 快照升级后因无 epoch 不再充当活动 lease。Core 运行时进一步接入每档案 Store/命令账本生命周期、覆盖命中与缺口排队、分批 cursor、稳定 snapshot、Outbox 发送等待和严格 `data.persisted.ack`；`query.request` 已可按 route/epoch 分流到终端直查或 SQLite 快照，并通过 RFC 6455 消息通道返回。每档案 Worker 已实现短时单次 session 凭据 WSS 工厂、严格 hello/welcome、心跳超时和有界重连退避；更新重启只接受服务端最早重启时间并等待本机安全空闲。MT4 管道与 MT5 `live/archive` Worker 已加入统一投影源，按时间窗读取已闭合 K 线、订单、成交、规范化交易和资金事件；分页事实先幂等落盘，只有时间窗最后一页才发布完整 coverage，出金保持负号，64 位标识不转有符号整数。MT4 EA 的范围 K 线改为用请求起止时间定位历史柱。WinForms 已读取原子本地档案并用 DPAPI `CurrentUser` 保护长期 refresh 凭据，每档案独立启动 WSS、SQLite 和 MT5 `live/archive` Worker，支持新增、编辑、启停、自动连接、状态诊断与非破坏性移除。该段早期的 52 项计数已由后续批次扩展，具体以最新烟雾脚本输出为准；MQL4 为 0 错误、0 警告。这仍未证明公网服务端联调、真实多页/断线续传、MT4 经纪商全量历史可见性、更新下载签名链、断电恢复、容量、Win7 文件锁或长期性能。
- 确定性命令离线闭环已接入每档案 WSS 会话：严格解析 `command.request`，命令先以 `recorded` 写入 SQLite，再回 `command.accepted`，确认响应发送后才进入 `accepted` 并调用终端；重复 command/idempotency 不会二次执行，过期命令不会进入终端，执行边界被中断时只落 `uncertain` 并等待 `command.reconcile` 精确查询。`command.result` 使用跨 epoch 的持久 Outbox，收到 `command.result_ack` 前持续保留，重连只刷新 route，不重放交易。MT5 保留原生 Stop Limit，MT4 明确拒绝该平台不支持的类型；MT5 Worker 同时补齐显式删除止损、止盈和挂单到期时间，67 项 Python 单元测试通过。
- 自动更新离线闭环已保留旧版唯一需要延续的 signed manifest V2 接口：新 `.NET Framework 4.8` Core 使用固定 P-256 公钥验证 manifest 与每个 package 的 SHA-256/P1363 签名，旧版共享清单 fixture 已直接验签通过。解析器拒绝未知字段、分数时间戳、过期/不匹配版本、非法渠道、重复模块和公网明文 URL；本地回环 HTTP 仅供测试。更新包先校验大小与 SHA-256，再在 `versions/.stage-*` 安全解压；拒绝绝对路径、`..`、ADS/冒号、符号链接、跨包重名、超过 4096 条目或整个 release 超过 1 GiB 的展开内容，必须包含主程序后才同卷原子移动到版本目录。该流程不读取或覆盖 `data/`、档案、SQLite 与 DPAPI 凭据。
- 固定 Launcher 已加入版本外 `activation-pending.txt`、`previous.txt`、主程序 `--health-check` 和失败回滚。即使切换指针后、健康检查前被中断，下一次普通启动也会继续验证未完成激活；健康失败或启动失败会恢复旧指针并启动旧版本。x86/x64 各 55 项离线 smoke 均通过，两个架构均完成真实 Launcher 双版本进程演练，验证健康版本生效、故障版本不启动、自动回滚以及版本外数据哈希不变；在线 Inno 安装器在加入新 Launcher 后重新编译成功。
- 自动更新运行时接线已在本地模拟服务完成：下载使用系统代理凭据但不向源站发送 Windows 默认凭据；正式路径只接受 HTTPS，重定向最多 3 次且禁止 HTTPS 降级，本地回环 HTTP 只能由测试构造显式开启。通知中的 release/version/channel 必须与签名 manifest 一致，分包下载失败会清理临时文件，签名、大小、SHA-256 与安全解压全部通过后才进入版本目录。
- 主程序已按所有活动档案执行两阶段空闲检查：先拒绝 `recorded/accepted/uncertain` 命令，再暂停网络消息与 Outbox 操作、等待关键操作归零并复核；到达 `restart_not_before_utc_msc` 后才启动固定 Launcher。Launcher 等待旧 PID 退出，再健康检查并切换，失败则恢复旧版本；健康、回滚或启动失败状态保存在版本外数据目录，并通过 `release.status` 在连接恢复后重复安全回传。
- 本轮仍不包含公网下载与鉴权联调、断电文件系统故障注入、旧客户端到 V4 的真实升级包演练、正式上传/发布或 Win7/10/11 隔离机验证。上述项目仍是阶段 8 的后续硬门；本地下载、签名、排空与回滚通过不等于版本已上传、发布、激活或可用于生产。
- MT4 V4 EA 已实现固定的下单、保护修改、平仓、挂单修改、撤单和执行查询；MQL4 编译为 `0 errors, 0 warnings`。当前 `8950701 / DPrimeVU-Demo 5` 没有 EA 交易权限，已完成终端信息、时钟、账户、品种、报价、120 根 M5 K 线及成交量、持仓、挂单、7 天历史和诊断的真实只读探针；没有发送交易命令。MT4 交易路径仅完成旧版 EA 对照、源码审查和离线合同测试，真实挂单、改单、撤单、开仓、保护修改与平仓矩阵按用户要求延期，不能标记为实机交易通过。
- Win7 候选依赖已做可解析性审计：官方 CPython `3.8.10` x64 embeddable ZIP（SHA-256 `ABBE314E9B41603DDE0A823B76F5BBBE17B3DE3E5AC4EF06B759DA5466711271`）、`MetaTrader5 5.0.5735` cp38 x64 Wheel（`D3A92482934B1FA76ACB1E60DAC46E81AD29D4C787202A096C77E2C84D2DC62C`）和 `NumPy 1.24.4` cp38 x64 Wheel（`692F2E0F55794943C5BFFF12B3F56F99AF76F902FC47487BDFE97856DE51A706`）均可按固定平台离线取得。解压成无系统 Python、无 pip 的隔离目录后，x86 `.NET Framework 4.8` Host 已通过该 x64 Worker 完成同一套真实 MT5 只读探针。
- 上述只证明包可解析且能在当前 Win11 运行，不是 Win7 通过证据。`MetaTrader5` 原生模块依赖 `VCRUNTIME140.dll`、`VCRUNTIME140_1.dll` 和 Universal CRT API Set；CPython embeddable 包含两个 VC Runtime DLL，但 Win7 镜像仍必须验证 SP1、系统补丁/Universal CRT、终端 Build 5320 与该 Wheel 的组合，缺少前置时安装器必须失败关闭并给出明确处理路径。
- 初版 MT5 EA 只完成编译和导航器发现，未挂载、未运行；架构纠偏后已从 V4 原型源码与构建入口删除。此前复制到当前 MT5 数据目录的单个 `.ex5` 文件仍是未加载的可删除构建产物，不属于正式方案。
- `git diff --check` 已在本阶段代码整合后通过。尚未发布安装包、修改线上元数据，也没有可供本轮执行的 Win7/10 隔离矩阵，因此仍未作 Win7 兼容性、杀毒或最终技术栈声明。

## 16. 业务边界与 SQLite 缓存补充复审

### 16.1 第一轮：需求覆盖、职责与最少实现

- 已将全部策略、风控、会员、连接额度、品种、手数、止盈止损和交易时段判断收回服务端；Bridge 不维护第二套业务配置，也不根据页面需求增加专用统计逻辑。
- Bridge 的交易路径收敛为“接收确定性命令 → 调用终端 → 回传成功、失败或不确定结果及实际状态”，避免客户端和服务端产生不同结论。
- K 线和交易历史明确进入每档案独立 SQLite；服务器复用基础事实自行组合新页面、图表和 AI 输入，已有字段的新组合不需要更新 Bridge。
- 第一轮调整：删除“Bridge 校验终端规格和机械约束”的表述，改为终端拒绝原样回传；保留最终调用点不可替代的路由、期限、幂等和目标身份检查。

### 16.2 第二轮：兼容、并发、异常、安全与回滚

- 大历史不使用单帧、无界内存或同步全量扫描；时间片、分页、帧大小、WAL 和低优先级同步属于可靠性保护，不构成业务限制。
- 每档案独立 SQLite scope、稳定游标和覆盖证据防止多账户串号；单写者与短事务防止历史同步阻塞命令账本。
- 服务端断线后，本机仍必须拦截重复、过期、错账户和目标已变化的命令，否则服务端无法消除已经进入客户端的竞态；该安全边界不能下放回服务端。
- MT4 历史受终端历史范围影响时必须保留 `incomplete` 证据；磁盘或数据库异常不得静默删库、伪装成功或阻塞其它档案。
- 当前 DPrimeVU MT4 账户只读，交易实测延期；旧 EA 成功记录只能作为行为基线，不能替代 V4 真实交易验收。回滚只需停止 V4 协议与客户端原型，不删除 SQLite 数据，也不影响 MT4/MT5 登录和已有订单。

### 16.3 缓存保留补充第一轮：需求、边界与最小实现

- 统一 TTL 会误删未确认执行证据，已改为不可淘汰、已确认事实、恢复投影、可重建市场缓存、短缓存、运行痕迹和仅内存七级；报价、心跳和当前未收 K 线不进入常规 SQLite。
- 全量预抓所有品种/周期会增加终端负载和磁盘占用，已改为只缓存服务端实际请求或订阅范围；服务器继续负责报表、AI、风控和跨资源组合。
- 为避免把 SQLite 设计成第二套业务数据库，首版只保留终端事实、覆盖/同步证据、执行安全和维护状态，不增加日报、月报、收益曲线或页面专属表。
- 清理周期采用可配置默认值，并要求正式发布前以真实数据量基准调整；未确认数据不能因配置缩短保留期。

### 16.4 缓存保留补充第二轮：并发、迁移、异常与回滚

- 清理与同步均可能和命令账本争抢写锁，已要求每档案逻辑单写者、低优先级队列、每批最多 500 行和短事务；首版不先拆库，只有基准证明阻塞才增加复杂度。
- 单纯删除缓存会让旧覆盖范围继续假报完整，已要求在同一事务中拆分/收缩覆盖，并用活动 snapshot/cursor lease 保护读取；过期游标稳定返回 `cursor_expired`。
- “已发送给服务器”不等于服务端已经持久化，已新增绑定账户 route、resource、scope、range 和 revision 的显式 `data.persisted.ack` 语义；ACK 缺失、越过缺口或来自旧 epoch 时禁止清理。
- 数据库忙、磁盘不足、迁移失败或清理回滚只影响当前档案的数据读取/维护状态，不得停止其它档案或删除未 ACK 证据；档案删除先进入 30 天可恢复隔离区。
- 剩余风险：365/180/30/7 天与磁盘软水位仍需容量和长稳基准验证；Win7 文件锁、断电恢复和杀毒扫描尚未实机完成；正式实现必须保留从旧 Bridge 数据到新 per-profile SQLite 的版本化迁移或明确可重建证明。

补充第二轮结论：职责已经符合“Bridge 只做数据中转和终端执行，所有业务限制在服务端”；保留的本机检查仅用于防重复、过期、串号和竞态执行。SQLite 方案已覆盖数据分级、按需缓存、并发、清理、完整性、迁移和故障恢复，可进入正式存储实现，但在容量、Win7 和断电恢复硬门通过前不能标记阶段完成。

### 16.5 V3 到 V4 一次性迁移实现记录（2026-09-03）

- 已冻结当前已安装 V3 的真实边界：程序位于 `C:\Program Files\AURUM\LiangjianBridge`，用户数据位于 `%APPDATA%\AURUM\BridgeV3`；端点文件实际字段为 `schema_version/control_url/realtime_url`，用户偏好为 PascalCase，默认档案和 `profiles/<profile_id>` 采用相同结构。
- 新增只读、幂等的迁移快照。输入根目录必须为显式绝对路径，JSON 单文件上限 1 MiB、档案最多 64 个；SQLite 以 `Read Only=True` 和 `PRAGMA query_only=ON` 仅查询 `terminal_bindings`。源指纹只使用小配置内容、数据库文件元数据和规范化终端绑定，不读取大型数据库全量内容。
- 快照只输出安装身份、端点候选、偏好、终端绑定和凭据存在状态。`credential.dat` 不解密、不复制、不参与内容哈希；缓存、日志、运行状态、快照、游标、Outbox 和旧命令账本明确列为丢弃类别。端点即使语法有效也保持 `activation_ready=false`，等待 V4 服务端确认。
- 主程序新增 V3 Launcher 兼容的 `--health-check --health-file`、`--ready-file/--expected-terminal` 与 `--start-minimized` 合同。健康信号只有 Core 和 .NET 运行时可用时才写入；就绪信号只有档案真实连上服务端且全部预期终端已连接时才写入，禁止伪造升级成功。
- 当前开发机对真实 V3 数据完成一次只读演练：识别 2 个档案，迁移前后核对 7 个源文件 SHA-256 均未变化，输出 3492 字节，不含 RefreshToken/Bearer 等凭据材料；端点状态为 `candidate` 且未激活，凭据交换状态为必需。
- x86/x64 均通过 62 项离线烟雾测试；主程序和 Launcher 文件版本均为 `4.0.0.0`，真实进程健康命令返回 `ok=true`。本轮没有改写已安装 V3、安装 V4、发布更新、连接公网或执行交易。
- 原生过渡启动器和稳定入口连续性已在 16.7 完成本地源码与隔离副本闭环。尚未闭环的迁移硬门为：真实签名 V3 过渡包和 V4 包的完整安装副本升级、缺少 .NET 4.8 的 Win7 SP1 重启续装、断电/杀进程故障注入与正式回滚演练。上述硬门完成前不得让 V3 客户端收到 V4 更新清单。

### 16.6 V3 到 V4 凭据交换与原子导入（2026-09-03）

- 服务端新增独立 Fastify 5 + TypeScript Bridge 凭据模块和 OpenAPI V4 合同：`POST /api/v4/bridge/legacy-credential-exchanges` 只接受未撤销、用户仍有效且具备桥接资格的 V3 refresh 凭据；沿用 V3 当前“显式撤销前持续有效”的实际语义，不误用旧 `expires_at` 阻断升级。数据库只保存哈希。一个 V3 source session 只能映射一个 V4 安装/档案，同绑定重试只轮换同一 V4 行并递增 generation，不更新、不撤销 V3 源会话。
- `POST /api/v4/bridge/session-tokens` 以 V4 refresh 凭据、安装 ID 和档案 ID 精确换取最长 60 秒、单次消费、绑定用户/安装/档案/generation 的 session 凭据。长期 refresh 凭据禁止直接用作 WSS Authorization；Redis 消费采用原子读取并删除。
- V3/V4 长期 refresh 均采用显式撤销语义，避免无人值守 Bridge 因固定天数到期后必须人工重新授权；用户失效、会员失效、设备撤销和 generation 轮换仍会失败关闭。数据库兼容列写入最大日期，但认证判断不把它当作固定 TTL。
- 新增显式 SQL 迁移文件扩展 `bridge_refresh_sessions` 的凭据版本、安装/档案绑定、generation、迁移键、源指纹与 V3 source session 唯一映射。迁移文件没有被应用，也没有加入应用启动自动执行路径。
- V4 客户端只在当前 Windows 用户上下文解密 V3 DPAPI refresh 凭据；一批档案全部完成服务端交换后，才以一次原子写入生成 V4 配置。V4 保留 V3 installation ID，目标已有不同 installation ID 时失败关闭；任一档案失败不会留下半份 V4 catalog，V3 目录和凭据文件始终保持原样。
- V4 catalog 只保存 DPAPI `CurrentUser` 加密的长期 refresh 凭据。每档案连接前通过同源 HTTPS 换取短时 session 凭据，再把短时凭据交给 WSS；端点拒绝公网明文、跨主机和服务端返回的主机重定向，错误不回显请求或凭据正文。
- 服务端 TypeScript 类型检查通过，Bridge 凭据服务、Fastify 路由、MySQL 事务和 Redis 单次消费共 12 项测试通过；`.NET Framework 4.8` 原型 x86/x64 各 63 项离线烟雾测试通过，新增覆盖旧凭据严格解密、两档案原子导入、后续档案失败不改 catalog、重复导入、ID/端点拒绝、短时凭据绑定与错误脱敏。
- 当前完成的仅是本地模块、合同、SQL 文件和离线测试闭环；目标 Fastify 进程组合、正式数据库迁移、Bridge 网关 session 消费接线、公网鉴权联调、V3 签名更新包投放均未执行。不得把本段表述为已部署、已迁移线上数据或已开放 V4 客户端更新。

### 16.7 V3 原生过渡启动器与 V4 启动器接管（2026-09-03）

#### 实装边界与两跳升级

- 已只读核对当前安装实例：桌面、开始菜单、`HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run` 和卸载项都指向安装根目录的稳定入口 `AURUMBridge.Launcher.exe`；卸载参数为 `--uninstall`，自启动参数为 `--autostart`。因此 V4 不改这些系统入口，只提升同一路径的启动器内容。
- V3 Launcher 不能在未安装 `.NET Framework 4.8` 的机器上直接健康检查托管 V4。升级固定拆为两跳：第一跳仍由 V3 更新机制安装并健康验证一个保留 V3 Launcher 的过渡版本；过渡核心健康后，该 V3 Launcher 才把同目录的 Win32 x86 原生入口原子提升为根目录稳定启动器。第二跳由原生入口识别 V4 待激活目录、校验并安装 4.8 依赖，再把激活交还旧 V3 Launcher 的既有健康检查、就绪确认与回滚流程。
- 原生入口以 `/MT`、x86、Windows 子系统与最低 OS `6.01` 构建，不依赖 .NET、WebView 或自解包运行时。它只负责版本判定、参数转发、依赖检测/续装和选择 Launcher，不承载业务、设备协议、终端访问、下载、解包或更新决策。
- V4 首次成功启动时由 `LegacyInstallHandoff` 校验根目录 `current.json`、当前/上一版本文件身份和 V4 兼容别名，然后原子写入 `versions/current.txt` 与 `versions/previous.txt`。旧 `current.json` 保持不变，供旧 Launcher 在本次过渡验证中继续完成失败回滚；V4 之后由版本目录中的托管 `LiangjianBridge.Launcher.exe` 接管。

#### 依赖、安全和系统入口连续性

- 过渡升级包脚本分为 `Transition` 与 `V4` 两个显式阶段。过渡阶段必须从一个已构建的 V3 版本目录复制到全新目标，保留 V3 Launcher 并加入同目录原生过渡入口，禁止原地改写源目录；只有候选核心已健康，V3 Launcher 才能原子替换根目录稳定入口。V4 阶段才加入托管核心、SQLite、版本目录 Launcher 和 `prerequisites`。
- `.NET Framework 4.8` Runtime 必须包含在已经过 V2 清单、大小、SHA-256 与 P-256 签名校验的 V4 暂存包中。原生入口还会校验固定 Microsoft Runtime SHA-256，并调用无 .NET 依赖的 WinTrust 产品校验器；不从客户端临时下载、不使用第三方镜像，也不接受其它产品的有效签名替代。
- 在线 Runtime 固定 SHA-256 为 `0BBA3094588C4BFEC301939985222A20B340BF03431563DEC8B2B4478B06FFFA`，离线 Runtime 固定 SHA-256 为 `0A3A390C47E639D0F7FC65B21195FEE6B7F65B066F80F70C60FAB191D14B7E40`。安装需要重启时，只有成功登记当前用户 `RunOnce` 后才提示重启；登记失败视为依赖安装失败并回到旧 V3，不允许留下“重启后无人续装”的半完成状态。
- 普通启动、`--autostart` 和 `--uninstall` 均按原参数转发。过渡期卸载仍交给旧 V3 Launcher/卸载助手；全新 V4 安装在没有旧 Launcher 时回退到 Inno 的 `unins000.exe`。桌面、开始菜单、HKCU Run 和卸载项继续使用同一个根目录文件名，因此无需批量重写系统入口。
- 更新何时允许重启仍由服务端 `restart_not_before_utc_msc` 与客户端安全空闲检查共同决定；原生过渡入口不复制自动分析周期，也不自行选择重启时间。

#### 实现与本地证据

- 新增 `src/LiangjianBridge.TransitionLauncher/` 原生入口，并在 `build.ps1` 中生成 `AURUMBridge.Launcher.exe`；`stage-v3-v4-upgrade.ps1` 生成两跳升级目录，`test-transition-launcher.ps1` 使用临时安装副本做进程级验证。
- `LiangjianBridge` 主程序接入 V3 指针到 V4 指针的一次性交接；托管 Launcher 支持由 `LIANGJIAN_BRIDGE_INSTALL_ROOT` 显式传入安装根目录；版本激活从当前版本目录启动托管 Launcher，避免再次调用根目录过渡入口形成循环。
- x86 与 x64 托管原型各 64 项烟雾测试通过。x86 原生入口通过 V3 普通启动、自启动和卸载参数转发、全新 V4 与迁移后 V4 选择、V3 过渡目录源文件不变、V4 核心真实指针交接，以及调用当前实装 V3 Rust Launcher 的健康失败回滚演练。
- 在线 Inno 安装器在仓库限定临时目录完成安装、根目录稳定入口、版本目录主程序启动与卸载闭环。原生文件版本为 `4.0.0.0`；PE 审计确认 x86、子系统/最低 OS `6.01`，依赖 API 不高于 Windows 7 边界。
- 本轮没有改写 `C:\\Program Files\\AURUM\\LiangjianBridge`，没有改注册表/快捷方式，没有安装 Runtime，没有上传或发布更新清单，也没有连接公网或执行交易。真实安装实例只用于读取入口证据，以及把其版本目录 Launcher 复制到临时目录验证回滚。

#### 第一轮复审：需求、复用与最小实现

- 复审结论：直接让旧 Launcher 激活托管 V4 会在无 4.8 机器上失败；重新安装或更换入口路径又会破坏普通用户的自动更新、快捷方式、自启动和卸载连续性。两跳升级是满足全部约束的最小方案。
- 调整一：没有新建常驻 Bootstrapper、Windows 服务或后台更新进程；原生入口只在用户启动或旧更新流程调用时运行，实际激活继续复用 V3 已有回滚机制和 V4 已有签名暂存机制。
- 调整二：没有把 Runtime 下载逻辑放进原生入口；运行时与 V4 包一起进入已经验签的暂存目录，减少第二套网络、代理、证书和断点状态机。
- 调整三：稳定路径继续叫 `AURUMBridge.Launcher.exe`，托管 V4 Launcher 只存在于版本目录，从结构上避免系统入口迁移和过渡递归。

#### 第二轮复审：兼容、迁移、并发、异常、安全、测试与回滚

- 兼容与迁移：旧 V3 指针只有在当前 V4 核心、上一版本和两侧兼容别名全部一致时才交接；任何未知结构都失败关闭。V3 数据、SQLite、DPAPI 凭据和 MT 登录状态均不在启动器交接中改写。
- 并发与时间：原生入口不新增调度线程；更新排空和最早重启时间仍由现有 V4 更新编排决定。重复启动只读取稳定指针并选择相同版本，不创建第二套激活状态。
- 异常与回滚：依赖缺失、哈希或产品签名失败、提权取消、RunOnce 登记失败、V4 健康/就绪失败均不得提升为成功；旧 V3 Launcher 仍能恢复 `last_known_good_version`。测试已修正 UTF-8 BOM 造成旧 Rust JSON 解析失败的问题，fixture 统一写为无 BOM ASCII。
- 安全：原生入口只执行安装根目录或已验证版本目录中的固定文件名；Runtime 同时受外层签名包、固定 SHA-256 和 Microsoft 产品签名约束。命令行参数按 Windows 引号规则重新转义，避免含空格路径或引号被拆分。
- 测试与连带 Bug：增加真实 V4 核心交接测试，防止只有单元方法通过但 `Program.Main` 未接线；保留真实旧 Launcher 回滚测试，防止仅用模拟 Fixture 掩盖 V3 行为差异。全新 Inno 安装器也复测根入口，避免迁移修复破坏新安装。
- 剩余风险：当前机器已装 4.8.1，尚不能证明“Win7 SP1 缺 4.8 → 安装依赖 → 必须重启 → RunOnce 续装 → V4 接管”；也未完成正式发布密钥签名、断电/磁盘满/杀进程、Win7/10/11、系统代理、杀毒和 24/72 小时矩阵。这些转入最终安装发布验收，不能因本地核心闭环而宣称 V4 已正式兼容 Win7。

### 16.8 临时签名两跳升级演练与核心冻结（2026-09-03）

- 新增 `LiangjianBridge.SignedStageFixture`，使用临时 P-256 密钥生成严格 signed manifest V2 与模块包，并调用正式 `ReleaseManifestParser`、`ReleaseManifestVerifier` 和 `ReleasePackageStager` 完成验签、安全解压和原子暂存；私钥不落盘，证据仅写入忽略目录 `bridge/.test-artifacts/`。
- `test-v3-v4-two-hop-upgrade.ps1` 从当前实装 V3 的只读安装副本开始，完整演练 `3.0.5` 过渡包、原生稳定入口提升、`4.0.0.0` 健康接管、`4.0.0.1` 健康失败回滚及回滚后的再次恢复。实装 V3 三个关键文件的演练前后 SHA-256 完全一致；未改注册表、快捷方式、线上清单或实装目录。
- 演练发现并修正两个真实迁移缺陷：不能在候选验证前覆盖 V3 Launcher；`healthy` 幂等接管和 `rolled_back` 恢复必须允许修复 V4 指针，但原生入口只有在 legacy 状态为 `healthy` 时才能直接进入托管 V4。任何未知或未归一状态继续失败关闭，不重放终端命令。
- 最终回归通过：MT5 Worker 67 项，Rust workspace 测试、格式和 clippy，.NET x86/x64 原型烟雾，过渡启动器进程级测试，以及独立签名两跳演练。真实联网、正式签名、生产投放和新增交易均未执行。

#### 两轮收口复审

- 第一轮复审聚焦最小职责：没有新增常驻更新服务、第二套网络下载器或业务规则；V3 Launcher、原生过渡入口与 V4 托管 Launcher 各只负责一个明确阶段，正常更新后应用直接进入新版本。
- 第二轮复审聚焦故障与后续维护：签名、哈希、路径、健康、就绪、回滚和 `rolled_back` 恢复均有本地证据；Win7 缺 4.8 的重启续装、系统/杀毒矩阵和正式签名投放保留为最终发布门，不阻塞 Vue 与服务端重构期间按版本化合同增加小型终端能力。
- 阶段结论：Bridge 核心架构与本地可验证链路阶段性冻结。后续只在服务端或前端需求确实需要新的终端原始能力、诊断字段或版本化命令时小步扩展，不在 Bridge 中加入策略、风控、会员或界面业务。

## 17. 参考资料

- [Rust 普通 Windows MSVC 平台支持](https://doc.rust-lang.org/rustc/platform-support/windows-msvc.html)
- [Rust Windows 7 Tier 3 目标](https://doc.rust-lang.org/nightly/rustc/platform-support/win7-windows-msvc.html)
- [.NET Framework 系统要求](https://learn.microsoft.com/en-us/dotnet/framework/get-started/system-requirements)
- [.NET Framework ClientWebSocket 的 Windows 7 限制](https://learn.microsoft.com/en-us/dotnet/api/system.net.websockets.clientwebsocket?view=netframework-4.8.1)
- [Python Windows 版本说明](https://docs.python.org/3.12/using/windows.html)
- [Python 3.8.18 生命周期说明](https://www.python.org/downloads/release/python-3818/)
- [Go 1.20 Windows 7 说明](https://go.dev/doc/go1.20)
- [Electron Windows 7/8/8.1 支持终止](https://www.electronjs.org/blog/windows-7-to-8-1-deprecation-notice)
- [Inno Setup 功能与系统要求](https://jrsoftware.org/isinfo.php)
- [Inno Setup 签名工具配置](https://jrsoftware.org/ishelp/topic_setup_signtool.htm)
- [.NET Framework 4.8 Runtime 在线与离线下载](https://dotnet.microsoft.com/en-us/download/dotnet-framework/net48)
- [.NET Framework 版本注册表检测](https://learn.microsoft.com/en-us/dotnet/framework/install/how-to-determine-which-versions-are-installed)
- [Microsoft SmartScreen 应用信誉说明](https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/smartscreen-reputation)
- [Microsoft 软件开发者误报提交](https://www.microsoft.com/en-us/wdsi/filesubmission)
- [MQL4 FileOpen 与命名管道](https://docs.mql4.com/files/fileopen)
- [MetaTrader 5 Python 集成](https://www.mql5.com/en/docs/python_metatrader5)
- [MetaTrader 5 Python initialize](https://www.mql5.com/en/docs/python_metatrader5/mt5initialize_py)
- [MetaTrader 5 Python K 线与 UTC 说明](https://www.mql5.com/en/docs/python_metatrader5/mt5copyratesfrom_py)
- [MetaTrader 5 Build 5320 与旧 Windows 支持边界](https://www.mql5.com/en/forum/496214)
- [MetaTrader 5 发布记录](https://www.metatrader5.com/en/releasenotes)
