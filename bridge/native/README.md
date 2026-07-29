# 量见智桥 Native V4

本目录承载量见智桥的渐进式 Rust 重构。当前 .NET V3、MT5 Python Worker、MT4 EA、服务器 V3 JSON 协议、SQLite 数据语义和签名更新链路仍是生产基线。

## 当前阶段

- 已建立独立 Rust workspace，不覆盖现有 V3 构建入口。
- `bridge-contract` 固定首批外部协议常量和 JSON 包络校验。
- `bridge-foundation` 固定 Launcher 参数、安装目录、Profile 隔离、运行时文件和 SQLite WAL 健康检查合同。
- `bridge-security-win` 与 V3 共用 DPAPI CurrentUser、固定 entropy、JSON 字段和原子凭据轮换合同。
- `bridge-store` 只读检查现有 V3 SQLite 完整性、WAL 模式及必需表/列；测试直接对照当前 C# 建库源码以阻止静默漂移。
- `bridge-store` 另提供未接入生产入口的 V3 Outbox 兼容层，严格保留交易优先、持久化重试和 applied / duplicate 删除语义。
- `bridge-observability` 写入现有内置日志查看器可直接读取的脱敏 JSONL，并持久化 panic 与非正常退出证据。
- `bridge-runtime-win` 与 .NET V3 共用锁文件及 `Local\*.activate/.shutdown` 事件，并用 Windows Job Object 监管、清理和退避重启子进程树。
- `bridge-transport` 已完成统一端点解析、rustls HTTP / WebSocket、refresh / ticket、Hello / ACK、心跳包络、严格优先队列、重连状态机和 Outbox 泵基础。
- 原生会话编排器现已联动 WebSocket 收发、10 秒心跳、200 ms Outbox 轮询和整组取消；任一循环失败都会关闭本次会话并保留原始稳定错误码。
- 入站路由已安全处理 `data_ack`、gap 全量恢复通知、版本通知、心跳和服务器错误；交易命令、报价/数据请求及命令结果 ACK 在账本和 Worker 接入前继续以 `native_bridge_runtime_not_ready` 等稳定错误失败关闭。
- 原生连接监督器已保留 V3 的 1/2/4/8/10 秒退避，并在凭据缺失时等待明确的授权变化，不会自行打开浏览器。
- 本地端到端测试会真实执行 refresh → ticket → WebSocket ticket → Hello / ACK → Heartbeat，并验证二进制帧失败关闭。
- `liangjian-bridge-compat-probe` 可在不输出令牌或业务数据的情况下检查默认账户或观摩源的本地迁移兼容性。
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
