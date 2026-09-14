# 智桥源码启动修复

2026-09-14 用户报告源码启动客户端随后关闭，并提供 `bridge_profile_catalog_invalid` 截图。

## 原因与修复

- Windows Application 日志 09:10:01 的 1026/1000 事件确认进程因未处理的 `ObjectDisposedException` 退出：`NamedPipeServerStream.AsyncWaitForConnectionCallback` 调用 `EventWaitHandle.Set` 时句柄已释放。两处管道连接等待在 Dispose 后过早关闭 `AsyncWaitHandle`。改为 `Task.Factory.FromAsync` 管理 APM 完成生命周期，保留有界等待、取消、原始异常类型及迟到故障观察。
- 用户配置为 SchemaVersion 1 的空 Profiles 列表，当前版本为 2。仅允许严格形状检查通过的版本 1 空列表在内存中升级，保留 InstallationId，读取不改写文件；非空旧配置及未知版本继续拒绝。

## 验证

- x86 `build.ps1` 与全部 `test.ps1` 冒烟测试通过。
- 新增 8 线程 × 32 轮 × 3 情景的真实本地管道回归，共 768 次，覆盖正常连接、超时、并发 Dispose，包含终端监听与 MT5 Worker 两个等待入口。测试不连接真实交易终端。
- 配置回归覆盖空旧列表不改写、保留安装身份、拒绝非空旧版本与未知版本。
- 使用 x86 .NET Framework 进程加载用户原配置，成功返回当前内存版本 2、0 个档案；原文件不改写。
- 09:16:42 重新启动本次源码构建客户端，进程 55568，主窗口为“量见智桥 V4”。本次没有创建档案、修改终端或发送交易指令。
- 启动 67 秒后检查：窗口响应正常，启动后新增智桥 1000/1026 崩溃事件为 0；原配置 SHA-256 前后相同。

本次验证为 Windows 11 本机源码运行与离线回归，不代表 Win7、正式发布、长时间稳定性或真实终端交易验收。
