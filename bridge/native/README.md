# 量见智桥 Native V4

本目录承载量见智桥的渐进式 Rust 重构。当前 .NET V3、MT5 Python Worker、MT4 EA、服务器 V3 JSON 协议、SQLite 数据语义和签名更新链路仍是生产基线。

## 当前阶段

- 已建立独立 Rust workspace，不覆盖现有 V3 构建入口。
- `bridge-contract` 固定首批外部协议常量和 JSON 包络校验。
- `bridge-foundation` 固定 Launcher 参数、安装目录、Profile 隔离、运行时文件和 SQLite WAL 健康检查合同。
- `bridge-security-win` 与 V3 共用 DPAPI CurrentUser、固定 entropy、JSON 字段和原子凭据轮换合同。
- `bridge-store` 只读检查现有 V3 SQLite 完整性、WAL 模式及必需表/列；测试直接对照当前 C# 建库源码以阻止静默漂移。
- `liangjian-bridge-compat-probe` 可在不输出令牌或业务数据的情况下检查默认账户或观摩源的本地迁移兼容性。
- `bridge-core` 目前只允许健康检查和版本输出。普通运行会以 `native_bridge_runtime_not_ready` 失败关闭，不会生成 Launcher ready 信号。

## 本地验证

```powershell
$cargo = "$env:USERPROFILE\.cargo\bin\cargo.exe"
Push-Location .\bridge\native
& $cargo fmt --all --check
& $cargo clippy --workspace --all-targets -- -D warnings
& $cargo test --workspace
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
