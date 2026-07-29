# 量见智桥 Native V4

本目录承载量见智桥的渐进式 Rust 重构。当前 .NET V3、MT5 Python Worker、MT4 EA、服务器 V3 JSON 协议、SQLite 数据语义和签名更新链路仍是生产基线。

## 当前阶段

- 已建立独立 Rust workspace，不覆盖现有 V3 构建入口。
- `bridge-contract` 固定首批外部协议常量和 JSON 包络校验。
- `bridge-foundation` 固定 Launcher 参数、安装目录、运行时文件和 SQLite WAL 健康检查合同。
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
