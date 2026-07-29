# 量见智桥 3.0.0 Native

本目录承载量见智桥 3.0.0 的 Rust 原生实现。现有 .NET Bridge 只作为功能与协议对照，不作为正式双栈、迁移接管或回退目标；服务器 V3 JSON 协议继续作为对外通信合同。

## 当前阶段

- 已建立独立 Rust workspace，不覆盖现有 V3 构建入口。
- `bridge-contract` 固定首批外部协议常量和 JSON 包络校验。
- `bridge-foundation` 固定 Launcher 参数、安装目录、Profile 隔离、运行时文件和 SQLite WAL 健康检查合同。
- `bridge-security-win` 与 V3 共用 DPAPI CurrentUser、固定 entropy、JSON 字段和原子凭据轮换合同。
- `bridge-store` 只读检查现有 V3 SQLite 完整性、WAL 模式及必需表/列；测试直接对照当前 C# 建库源码以阻止静默漂移。
- `bridge-store` 另提供未接入生产入口的 V3 Outbox 与执行回执兼容层，严格保留交易优先、持久化重试、回执/Outbox 同事务写入和 applied / duplicate 删除语义。
- `bridge-command` 已建立持久化命令账本和进程内单航班执行：命令先落盘再分发，重复命令复用同一回执，超时、Worker panic、路由错配及重启中断都会持久化为 `uncertain`，不会自动重放交易。
- `bridge-worker-host` 已建立版本化 Core ↔ Worker IPC 合同：4 MiB 小端长度前缀 JSON 帧、会话 nonce、终端/账户/epoch 路由、请求关联、超时后通道熔断和能力协商均严格校验；`query_execution` 使用独立只读操作，不能进入交易执行操作。Windows 管道使用当前用户 SID 的保护 DACL、拒绝远程客户端和首实例防抢占；Worker 只有在受 Job Object 管理的子进程完成严格握手后才会交付客户端。注册表通过终端 claim 和单调代际号原子替换客户端，请求前后均执行 fencing；崩溃按 1/2/4/8/10 秒退避重启，新账户 claim 会终止旧 supervisor，避免路由争抢。真实 Python Worker 与 Core 尚未接入。
- `bridge-observability` 写入现有内置日志查看器可直接读取的脱敏 JSONL，并持久化 panic 与非正常退出证据。
- `bridge-runtime-win` 与 .NET V3 共用锁文件及 `Local\*.activate/.shutdown` 事件，并用 Windows Job Object 监管、清理和退避重启子进程树。
- `bridge-transport` 已完成统一端点解析、rustls HTTP / WebSocket、refresh / ticket、Hello / ACK、心跳包络、严格优先队列、重连状态机和 Outbox 泵基础。
- 原生会话编排器现已联动 WebSocket 收发、10 秒心跳、200 ms Outbox 轮询和整组取消；任一循环失败都会关闭本次会话并保留原始稳定错误码。
- 入站路由已安全处理 `data_ack`、gap 全量恢复通知、版本通知、心跳、服务器错误和 `command_result_ack`；ACK 会严格核对持久化回执或待发送结果的账户、终端及 epoch。
- 交易命令准入已冻结过期、动作、账户、终端、epoch、暂停状态和初始全量同步门禁；入站路由支持显式注入命令 Dispatcher，执行回执与交易 Outbox 同事务保存，服务器 ACK 后账本原子推进为 `acked`。正式 Worker 尚未接入 Core，因此默认入口仍以 `native_bridge_runtime_not_ready` 失败关闭，报价/数据请求同样不会执行。
- 原生连接监督器已保留 V3 的 1/2/4/8/10 秒退避，并在凭据缺失时等待明确的授权变化，不会自行打开浏览器。
- 本地端到端测试会真实执行 refresh → ticket → WebSocket ticket → Hello / ACK → Heartbeat，并验证二进制帧失败关闭。
- `liangjian-bridge-compat-probe` 目前仅作为开发期本地合同探针，不代表 3.0.0 需要接管旧 .NET Bridge 的生产数据。
- `bridge-core` 普通运行现在会建立日志、单实例和运行标记后以 `native_bridge_runtime_not_ready` 失败关闭；会话编排器尚未接入 Core，仍不生成 Launcher ready 信号，也不连接服务器或 MT。

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
