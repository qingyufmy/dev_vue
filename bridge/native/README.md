# 量见智桥 3.0.0 Native

本目录承载量见智桥 3.0.0 的 Rust 原生实现。现有 .NET Bridge 只作为功能与协议对照，不作为正式双栈、迁移接管或回退目标；服务器 V3 JSON 协议继续作为对外通信合同。

## 当前阶段

- 已建立独立 Rust workspace，不覆盖现有 V3 构建入口。
- `bridge-contract` 固定首批外部协议常量和 JSON 包络校验。
- `bridge-foundation` 固定 Launcher 参数、安装目录、Profile 隔离、运行时文件和 SQLite WAL 健康检查合同。
- `bridge-security-win` 与 V3 共用 DPAPI CurrentUser、固定 entropy、JSON 字段和原子凭据轮换合同。
- `bridge-store` 可由 Native Core 在全新 Profile 中事务化创建完整 SQLite 表与索引，并固定 WAL、`synchronous=FULL` 和外键检查；上次建库中断留下的空文件可安全继续初始化，但部分建成或列不完整的数据库拒绝原地猜测修复。兼容检查测试仍直接对照当前 C# 建库源码以阻止静默漂移。
- `bridge-store` 以 Profile SQLite 的 `terminal_bindings` 作为终端配置权威源：账户、平台或路径激活会在同一事务中递增 `connection_epoch`，并只清理该终端旧 epoch 的数据同步 revision 与 `data_delta` Outbox。非法配置不会消耗 epoch；读取时重新校验终端 ID、平台、绝对路径和账户身份，避免损坏记录被 Core 启动。
- `bridge-store` 另提供未接入生产入口的 V3 Outbox、执行回执和数据 delta 兼容层：账户/持仓/挂单的 revision、最新 SQLite 投影与服务器 Outbox 在同一事务提交；重复 revision 必须匹配原 message/hash，gap 不写入，full snapshot 会替换旧投影并压缩该流的待发 Outbox。交易优先、持久化重试、回执/Outbox 同事务写入和 applied / duplicate 删除语义保持不变。
- `bridge-terminal-data` 已实现 MT5 快照投影与采集协调器：从 SQLite 恢复账户/持仓/挂单 revision 与当前集合，按 ticket 计算 upsert/delete，无变化只刷新内存 freshness；首次连接、账户 epoch 变化、主动 reconciliation 或服务器 gap 会发送 full snapshot。gap 会采用存储返回的当前 revision 后再以 `current + 1` 恢复，避免旧 revision 重试循环。协调器会在空闲时每 1 秒、有持仓或挂单时每 250 毫秒采集，交易完成或 reconciliation 请求可立即唤醒；Worker 重启期间按上限 10 秒退避，并在投影前再次校验账户路由。Core 正式进程入口已经接入该协调器。
- `bridge-terminal-session` 已把 MT5 Worker supervisor、数据路由、SQLite 投影和采集器组合成单终端会话。账户变化必须提升 `connection_epoch`；合法替换会先等待旧采集器退出，再停止旧 Worker，最后启动新会话。非法 epoch 或采集配置会在停止旧会话前拒绝，旧控制句柄在切换后失效；只有 Worker 与初始投影都 Ready 时会话才报告数据就绪。Core 共同生命周期可启动多个隔离管理器，并在服务器运行结束后倒序关闭。
- `liangjian-bridge-core` 已使用真实 Profile 启动准备链路：校验并读取 DPAPI 凭据状态、创建或打开该 Profile 的 SQLite、读取终端绑定，并只在存在 MT5 绑定时校验安装目录中的最小 Python 与 Worker，再生成与账户 epoch 完全一致的会话规格。该步骤不记录令牌或账户内容；缺少授权时不会启动 Worker，MT4 绑定会被隔离保留给后续适配器。
- `liangjian-bridge-core` 的正式入口已接入共同生命周期：终端目录统一启动/倒序停止多个 MT5 会话，凭据源检测首次授权与主动退出，服务器监督器与 Worker 共享取消边界；服务器 gap 只允许命中当前 terminal/epoch 后请求 full snapshot，真实执行且回执已持久化的成功命令只唤醒一次对应采集器。未授权时 Core 常驻等待且不启动 Worker、不打开浏览器；主动退出会关闭当前服务器会话并回到等待授权。心跳 freshness 来自当前采集状态，版本通知保留给后续 Native UI/Updater。
- `bridge-command` 已建立持久化命令账本和进程内单航班执行：命令先落盘再分发，重复命令复用同一回执，超时、Worker panic、路由错配及重启中断都会持久化为 `uncertain`，不会自动重放交易。
- `bridge-worker-host` 已建立版本化 Core ↔ Worker IPC 合同：4 MiB 小端长度前缀 JSON 帧、会话 nonce、终端/账户/epoch 路由、请求关联、超时后通道熔断和能力协商均严格校验；`query_execution` 使用独立只读操作，不能进入交易执行操作。Windows 管道使用当前用户 SID 的保护 DACL、拒绝远程客户端和首实例防抢占；Worker 只有在受 Job Object 管理的子进程完成严格握手后才会交付客户端。注册表通过终端 claim 和单调代际号原子替换客户端，请求前后均执行 fencing；崩溃按 1/2/4/8/10 秒退避重启，新账户 claim 会终止旧 supervisor，避免路由争抢。
- `workers/mt5` 已实现独立的 MT5 Python 只读 Worker：每次请求复核终端、经纪商服务器、登录号和连接状态，只声明 `snapshot` / `quote` 能力；账户、持仓和挂单字段无损转发，列表带 ticket 且受 4 MiB 帧限制；报价保留经纪商时区校准，时钟未可信时失败关闭。Rust 测试会启动真实 Python 子进程并通过受保护命名管道验证账户、持仓、挂单及报价互操作；Core 正式入口已能监管和轮询该 Worker，交易能力仍待阶段 4 实现。
- `bridge-observability` 写入现有内置日志查看器可直接读取的脱敏 JSONL，并持久化 panic 与非正常退出证据。
- `bridge-runtime-win` 与 .NET V3 共用锁文件及 `Local\*.activate/.shutdown` 事件，并用 Windows Job Object 监管、清理和退避重启子进程树。
- `bridge-transport` 已完成统一端点解析、rustls HTTP / WebSocket、refresh / ticket、Hello / ACK、心跳包络、严格优先队列、重连状态机和 Outbox 泵基础。服务器地址以管理员数据目录中的 `endpoint-settings.json` 为优先权威源；文件缺失或损坏时退回安装目录随签名包发布的 `server-endpoints.json`。单一 `server_url` 会派生实时地址，公网明文 HTTP 不被接受，本机回环地址仅供开发使用。
- 原生会话编排器现已联动 WebSocket 收发、10 秒心跳、200 ms Outbox 轮询和整组取消；任一循环失败都会关闭本次会话并保留原始稳定错误码。
- 入站路由已安全处理 `data_ack`、gap 全量恢复通知、版本通知、心跳、服务器错误和 `command_result_ack`；ACK 会严格核对持久化回执或待发送结果的账户、终端及 epoch。
- 交易命令准入已冻结过期、动作、账户、终端、epoch、暂停状态和初始全量同步门禁；入站路由支持显式注入命令 Dispatcher，执行回执与交易 Outbox 同事务保存，服务器 ACK 后账本原子推进为 `acked`。正式 Core 当前只接入 MT5 数据 Worker，尚未配置交易 Dispatcher，因此交易命令继续失败关闭，不会误执行。
- 原生连接监督器已保留 V3 的 1/2/4/8/10 秒退避，并在凭据缺失时等待明确的授权变化，不会自行打开浏览器。
- 本地端到端测试会真实执行 refresh → ticket → WebSocket ticket → Hello / ACK → Heartbeat，并验证二进制帧失败关闭。
- `liangjian-bridge-compat-probe` 目前仅作为开发期本地合同探针，不代表 3.0.0 需要接管旧 .NET Bridge 的生产数据。
- `bridge-core` 普通运行现在会建立日志、单实例和运行标记，未授权时等待凭据文件变化；授权、终端绑定和地址均有效后启动 MT5 数据会话与服务器监督器。单实例退出事件会取消整组会话；只有服务器已连接且 Launcher 指定的终端全部 Ready 时，才原子写入 ready 信号。MT4 与真实交易执行尚未接入该入口。

## 本地验证

```powershell
$cargo = "$env:USERPROFILE\.cargo\bin\cargo.exe"
Push-Location .\bridge\native
& $cargo fmt --all --check
& $cargo clippy --locked --workspace --all-targets -- -D warnings
& $cargo test --locked --workspace
Pop-Location
```

在交易、会话恢复、Worker 监管和 ready 信号全部完成真实验收前，不得把 Native Core 打入稳定发布清单。

也可以从仓库根目录执行统一验证入口：

```powershell
.\scripts\bridge-native\test-native.ps1
```

只读检查现有默认 Profile：

```powershell
.\bridge\native\target\x86_64-pc-windows-msvc\release\liangjian-bridge-compat-probe.exe
```

检查观摩源时传入 V3 根数据目录及 Profile；输出只包含兼容状态，不包含授权令牌、账户快照或历史数据：

```powershell
.\bridge\native\target\x86_64-pc-windows-msvc\release\liangjian-bridge-compat-probe.exe `
  --root-data-dir "$env:APPDATA\AURUM\BridgeV3" `
  --profile source-example
```
