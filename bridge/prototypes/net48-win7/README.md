# 量见智桥 V4 `.NET Framework 4.8` 原型

该目录用于验证 Windows 7 SP1、Windows 10、Windows 11 上的最小 Bridge 运行时，不替代当前 `bridge/native`，也不参与正式发布。

## 原型边界

- `LiangjianBridge.Core`：严格协议、WSS 帧/握手、MT4 EA 管道、MT5 Python Worker host、多终端会话隔离、SQLite 命令账本/读取投影和运行时检测。
- `LiangjianBridge`：最小 WinForms 档案管理壳层，提供新增、编辑、连接、断开、移除、自动连接和状态诊断；主窗口不提供人工交易按钮。
- `LiangjianBridge.Launcher`：从 `versions/current.txt` 启动经过校验的版本目录，并提供原子切换与 previous 回滚原语。
- `LiangjianBridge.TransitionLauncher`：固定为安装根目录 `AURUMBridge.Launcher.exe` 的 Win32 x86 过渡入口；在无 .NET 环境先完成 4.8 前置安装，再复用旧 V3 Launcher 激活/回滚，V4 接管后转到版本目录托管 Launcher。
- `LiangjianBridge.SmokeTests`：不依赖测试框架的离线冒烟测试，可在目标 Windows 实机直接运行。
- `LiangjianBridge.TerminalProbe`：一次性真实终端探针。默认只读；MT4 只有同时显式传入 `--execute --matrix` 才会在名称含 `Demo` 的服务器运行交易矩阵。`--python` 模式通过固定 Python + `MetaTrader5` Worker 验证 MT5 终端、账户、行情、M5 K 线、品种、持仓、挂单和有界历史资源。

原型不使用 `ClientWebSocket`、WebView、压缩壳或 one-file 自解包。MT5 适配使用用户明确配置的 Python 可执行文件、现有 `bridge/native/workers/mt5/worker.py` 和已运行的 `terminal64.exe`；Bridge 不启动或关闭 MT5。MT4 仍保留精简 EA 适配器。WSS 使用独立 RFC 6455 模块；当前开发机已通过真实 TLS 1.2 WSS 回显验证，Win7 实机、系统代理、断网恢复和 Autobahn 测试仍是后续硬门。

档案配置保存在当前用户的 `%LOCALAPPDATA%\Liangjian\BridgeV4\profiles.json`。长期 V4 refresh 凭据只保存为 Windows DPAPI `CurrentUser` 密文；每次 WSS 建连前再通过同源 HTTPS 换取最长 60 秒的单次 session 凭据，refresh 凭据不会直接进入 WebSocket。配置采用同目录临时文件原子替换；损坏、未知字段或重复终端档案会失败关闭，主程序不会静默覆盖。每个档案的 SQLite 位于独立子目录；从界面移除档案只更新配置，不删除命令账本、未确认回执或缓存数据库。

## 本机构建

当前开发机缺少 .NET Framework 4.8 Targeting Pack，因此 `build.ps1` 可使用系统自带的 .NET Framework 编译器进行原型构建。正式 CI 必须安装 4.8 Developer Pack 并使用 MSBuild，不能把运行时程序集当作长期引用程序集。

原型固定使用官方 `System.Data.SQLite.Core 1.0.119` 的 .NET Framework provider。构建脚本只从 NuGet 官方固定地址下载 `Stub.System.Data.SQLite.Core.NetFramework`，并在解包前校验固定 SHA-256；该下载只发生在开发构建阶段，不进入 Bridge 运行时。

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\bridge\prototypes\net48-win7\build.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File .\bridge\prototypes\net48-win7\test.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File .\bridge\prototypes\net48-win7\test-wss.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File .\bridge\prototypes\net48-win7\build-installer.ps1 -Mode Online
powershell -NoProfile -ExecutionPolicy Bypass -File .\bridge\prototypes\net48-win7\build-installer.ps1 -Mode Offline -OfflineRuntimePath <official-runtime-path>
powershell -NoProfile -ExecutionPolicy Bypass -File .\bridge\prototypes\net48-win7\test-installer.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File .\bridge\prototypes\net48-win7\test-transition-launcher.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File .\bridge\prototypes\net48-win7\test-v3-v4-two-hop-upgrade.ps1
```

两跳升级目录只能由 `stage-v3-v4-upgrade.ps1` 的显式 `Transition` 或 `V4` 阶段生成。`Transition` 输入必须保留可由 V3 更新器启动、验证和回滚的 V3 Launcher，并把无 .NET 依赖的原生入口作为同目录 `AURUMBridge.TransitionLauncher.exe`；V3 过渡核心健康后才把该原生入口原子提升为安装根目录的稳定 `AURUMBridge.Launcher.exe`。`V4` 输入必须包含已固定哈希的 Microsoft 4.8 Runtime。脚本不修改当前安装实例，也不上传或激活任何更新。

`test-v3-v4-two-hop-upgrade.ps1` 只在 `bridge/.test-artifacts/` 的安装副本中生成临时 P-256 密钥和 signed manifest V2 包，使用正式解析、验签与安全暂存代码演练 `V3 -> 过渡版本 -> 原生稳定入口 -> V4`，并验证健康失败回滚及 `rolled_back` 后恢复。临时私钥不写盘，当前实装 V3 只读哈希前后必须一致。

输出位于本目录 `artifacts/`，已由 `.gitignore` 排除。

## SQLite 投影原型

每个终端档案使用独立数据库文件。当前 V2 追加迁移包含已收盘 K 线、历史事实、覆盖与服务端持久化 ACK、连接代次隔离的账户/持仓/挂单恢复投影、stream 状态、合约规格短缓存、同步任务租约、Outbox、命令账本和维护状态。单次写入、读取页和清理批次均不超过 500 条；MT ticket/order/position 使用文本保存，避免无符号 64 位标识溢出。

清理只删除达到保留期且可重建或已确认的数据：历史必须已有服务端持久化 ACK，Outbox 必须已 ACK，活动 snapshot、当前 epoch 投影、活动同步任务及未确认数据不会被清理。报价、心跳和当前未收 K 线仍只保存在内存中。

`LiangjianBridge.Core.Runtime` 已接入每档案 Store/命令账本生命周期、覆盖命中判断、缺口同步队列、分批同步租约、稳定 snapshot/cursor 和 Outbox/`data.persisted.ack`。终端读取发生在 SQLite 事务外，旧 connection epoch 的同步任务和 Outbox 不会进入当前发送队列。稳定分页绑定 coverage 指纹；分页期间 revision 改变时明确返回 `bridge_projection_snapshot_stale`，不会混合新旧事实。

WinForms 已接入本地档案、当前用户加密凭据和每档案生命周期：MT4 共享受保护监听管道并按实例/账户路由；MT5 每档案启动独立 `live/archive` Worker；WSS、SQLite、connection epoch 和错误状态互相隔离。已加入严格 `query.request` 路由、SQLite 覆盖命中/异步补齐、快照绑定游标、终端直查适配接口，以及真实 RFC 6455 transport 的消息通道和会话 Worker。MT4 管道与 MT5 `live/archive` Worker 的原始 K 线、订单、成交、规范化交易和资金事件现已映射为统一 `ProjectionSyncBatch`；K 线按小时间窗读取且只发布已闭合柱，历史分页只在时间窗最后一页发布完整覆盖，出金保持负号，MT 64 位标识保持文本。模拟终端与模拟 WSS 通道已通过冒烟，但本轮没有使用真实设备凭据连接公网服务端，也未完成真实多页/断线恢复、公网鉴权或命令端到端联调。因此不能把本批结果表述为公网完整同步链路已经可用。

Core 现已加入每档案独立会话 Worker：连接前用 DPAPI 解密本档案 refresh 凭据并换取短时单次 session 凭据，再用于 WSS 建连；严格 `session.hello/welcome`、心跳 ACK 超时、1/2/4/8/16/30 秒有界退避、查询路由及当前 epoch Outbox 刷新均有离线故障测试。更新通知由服务端提供 `restart_not_before_utc_msc`；客户端通过系统代理下载，逐跳校验重定向，验证固定 P-256 公钥签名、大小与 SHA-256 后才原子暂存。到达服务端允许时间后，只有全部活动档案均不存在 `recorded/accepted/uncertain` 命令且消息处理与关键写入归零，才暂停连接并交给固定 Launcher 等待旧进程退出、健康检查、切换或回滚；结果持久化为 `release.status` 并在连接可用时幂等回传。Bridge 不内置自动分析时间表。上述闭环目前只通过本地模拟服务和进程演练，尚未完成公网鉴权、正式发布或 Win7 实机验证。

## 本机终端协议

公网 WSS 使用 `contracts/bridge-v4.schema.json` 的严格 JSON 信封；MT4/MT5 与 Bridge 主程序之间不直接解析公网 JSON，而使用版本化的固定二进制消息。外层为 4 字节 little-endian 长度，字符串为 4 字节 UTF-8 字节数加正文，单帧最大 256 KiB。

K 线最近值查询最多 500 根；K 线范围和历史范围查询必须显式携带 `limit + cursor`。范围数据优先读取当前档案 SQLite；缺口只排入异步同步任务并返回可重试的 `bridge_projection_refreshing`，不会在 WSS 收包线程同步扫描终端。游标绑定 15 分钟只读快照及覆盖 revision，覆盖变化、账户代次变化或快照过期后旧游标失败关闭。

同步源内部再按时间窗分页：K 线窗口会给 500 条上限保留余量，MT5 历史窗口不超过 30 天；分页中的事实可以先幂等落盘，但只有终端完成该时间窗枚举后才能登记 `complete` coverage。若请求包含尚未闭合的 K 线，则保持同步任务待重试，不会把当前柱写入 SQLite 或提前发布完整范围。MT4 的账户历史仍受终端“账户历史”可见范围影响，当前完整性只代表本次终端 API 可见集合；上线前必须在真实终端验证全历史设置和缺口诊断，不能据此宣称经纪商全量历史已证明。

这样可以让两个 MQL 适配器只处理固定资源编号和固定参数顺序，避免在交易终端中维护通用 JSON 查询器。Bridge 主程序负责把公网的资源专属 JSON 请求转换成本机二进制请求，并验证请求 ID、资源、终端实例、会话代次和返回 JSON。

当前本机消息包含 `Hello`、`Welcome`、查询/错误、六类固定交易命令/结果，以及 `Ping/Pong`。交易命令使用固定字段顺序和严格十进制定点文本；MT4 不支持 stop-limit 时明确拒绝，不降级成其它订单。服务器/Bridge 保留业务风控和持久幂等账本，EA 只验证当前账户、期限、预期资源状态和终端机械约束。

## MT5 Python Worker host

`LiangjianBridge.Core` 中的 `Mt5WorkerHost` 为每个 `terminal_instance_id` 创建独立的当前用户命名管道、Python Worker 进程、路由和 connection epoch。Worker 使用 `bridge/native/workers/mt5/worker.py` 已有的 IPC v2 合同：4 字节 little-endian 长度 + UTF-8 JSON。Host 在接受 `worker_hello` 前严格校验 nonce、路由、角色和能力；每次请求严格校验 request id、返回路由和响应类型，超时、断管和 Worker 进程退出均 fail closed。

启动配置必须显式提供 Python 可执行文件、Worker 脚本、已运行的 `terminal64.exe`、终端实例 ID、经纪商服务器和登录账号；不通过 PATH 猜测路径，也不会自动启动、登录、关闭或改变 MT5。`live` Worker 透明转发 `collect_snapshot`、`quote`、`data`、`execute_command` 和 `query_execution`，`archive` Worker 单独承载有界 `history_range_sync`，交易校验仍由现有 Worker/trade.py 负责。

真实 MT5 只读探针示例（账号和服务器需从当前终端实际配置填写，不写入脚本）：

```powershell
& .\artifacts\LiangjianBridge.TerminalProbe.exe --python `
  --executable C:\Path\to\python.exe `
  --worker D:\path\to\bridge\native\workers\mt5\worker.py `
  --terminal 'D:\Program Files\MetaTrader 5\terminal64.exe' `
  --instance mt5-local-01 `
  --broker <broker-server> `
  --login <login> `
  --symbol XAUUSD
```

MT4 默认只读探针与显式模拟账户交易矩阵：

```powershell
& .\artifacts\LiangjianBridge.TerminalProbe.exe LiangjianBridgeV4 XAUUSD
& .\artifacts\LiangjianBridge.TerminalProbe.exe LiangjianBridgeV4 XAUUSD --execute --matrix
```

交易矩阵会使用独立 magic 和幂等键，只管理本轮创建的市价单与挂单；任何路由、预期状态或唯一性无法确认时均失败关闭。

## 尚未证明

- 未证明 Windows 7 实机可运行；
- 当前开发机可通过公开 Echo 服务验证真实 WSS/TLS 1.2；Win7、系统代理和断网恢复仍未证明；
- MT5 Python Worker 已在当前开发机真实终端上通过只读及模拟账户交易矩阵；MT4 V4 EA 已通过编译和离线命令合同测试，但当前终端仍需人工重新挂载并启用 EA 后完成真实只读/交易矩阵；双终端并行、Win7 实机和断网恢复仍需验收；
- 已能编译 Inno 在线/离线原型安装器；安装、依赖缺失、重启续装、覆盖升级和卸载仍需在隔离虚拟机验收；
- 已在隔离安装副本完成临时签名的 V3/V4 两跳暂存、原生入口提升、V4 健康切换、失败回滚和恢复；这不是正式发布签名，也没有投放更新；
- 本原型只允许在用户明确授权的模拟账户执行测试交易；不得把当前开发机结果表述为 Win7 或任意经纪商兼容证明。
