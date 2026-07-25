# AURUM Bridge v3 实现与验收审计

日期：2026-07-26  
目标方案：[2026-07-25-aurum-bridge-final-design.md](./2026-07-25-aurum-bridge-final-design.md)  
开发分支：`refactor/aurum-bridge-v3`

## 1. 审计结论

Bridge v3 的核心代码闭环已经形成：C# Host 负责界面、连接、恢复、SQLite、更新与 Worker 监管；MT5 仅由独立 Python Worker 调用官方库；MT4 使用不启用 DLL 的轻量 EA 和当前用户 Named Pipe。产品界面仍只暴露平台/账户选择、状态、重新检测、日志、退出账号和退出桥接。

当前代码可以进入真实联调和持续运行验收，但不能据此宣称全部生产指标已经达标。安装包、Authenticode、72 小时/7 天运行、真实 MT4 demo 交易矩阵、公网延迟、10,000 次故障注入、多终端规模测试和灰度发布仍需对应环境与时间证据。

## 2. 已实现并有自动化证据的能力

| 方案要求 | 状态 | 实现或测试证据 |
|---|---|---|
| C# 主程序，Python 仅作为 MT5 Worker | 已实现 | `bridge/app/AurumBridge`、`bridge/adapters/mt5-python/worker.py` |
| 用户主动选择 MT4 或 MT5，只运行所选适配器 | 已实现 | `BridgeUserPreferences`、`BridgeApplicationController`、`BridgeMainForm` |
| 单 MT5 自动使用；多个 MT5 必须选择具体账户，只启动所选 Worker | 已实现 | `BridgeApplicationController.ResolveMt5TerminalSelection`、`BridgeTerminalSelectionTests` |
| 首次启动自动打开浏览器授权一次 | 已实现 | `BridgeFirstAuthorizationGate`、`BridgeApplicationContext` |
| 后续启动静默复用授权，主动退出才清除 | 已实现 | DPAPI `FileBridgeCredentialStore`、`BridgeSessionClient`、授权与退出测试 |
| 日志在软件内直接查看 | 已实现 | `BridgeLogViewerForm`、`BridgeLogReader` |
| 界面显示账户、状态、服务器、最近同步和版本 | 已实现 | `BridgeMainForm`、`BridgeUiText` |
| Windows 登录后自动启动；关闭窗口只隐藏托盘 | 已实现 | `BridgeAutoStartRegistration`、`BridgeMainForm.HandleFormClosing` |
| SQLite WAL 只保存最新读模型、Outbox、绑定和有限回执 | 已实现 | `BridgeStore` 及其测试 |
| 数据 revision、缺口检测、完整快照恢复 | 已实现 | `BridgeInboundRouter`、`BridgeCommandDispatcher`、读模型测试 |
| 数据 Outbox 有界并按终端/epoch/stream 合并 | 已实现 | `BridgeStore.PersistDataDeltaAsync` 及边界测试 |
| 交易回执持久化、确认前不删除且不与数据合并 | 已实现 | `BridgeStore`、`BridgeOutboxPump`、回执测试 |
| command ID、deadline、账户/终端/epoch 路由与幂等 | 已实现 | v3 协议、`BridgeCommandDispatcher`、服务端 `command-ledger` |
| 不明确结果返回 uncertain，不自动重放 | 已实现 | Host dispatcher 与服务端 ledger/reconcile 测试 |
| 交易优先于数据，内存队列和 MT5 Worker 等待队列均有界 | 已实现 | `PriorityMessageQueue`、`WorkerRequestGate` 及其测试 |
| 一终端一 Worker；单 Worker 连续失败只停止本终端 | 已实现 | `TerminalRuntimeSupervisor` 及隔离测试 |
| Named Pipe 仅当前 Windows 用户 | 已实现 | MT4、MT5 管道均使用 `PipeOptions.CurrentUserOnly` |
| WSS 一次性 ticket；长期凭证不进入 URL、日志或普通配置 | 已实现 | `BridgeSessionClient`、Gateway、凭证与日志脱敏测试 |
| 日志轮转和脱敏；日志失败不阻断交易闭环 | 已实现 | `BridgeFileLogger` 及轮转/脱敏测试；交易回执独立保存在 SQLite Outbox |
| 官方模块更新、兼容范围、Manifest/包签名、大小/hash、原子版本目录 | 已实现 | `ReleaseManifestVerifier`、`ReleaseStager`、`ReleaseInstaller` |
| 更新前暂停新指令并等待在途指令；失败恢复当前运行 | 已实现 | `PauseForUpdateAsync`、Launcher last-known-good 与回滚测试 |
| 不加入本地策略、复杂风控、报表或手工干预分析 | 已遵守 | Bridge v3 项目职责边界审查 |

## 3. 2026-07-26 已执行验证

| 验证 | 结果 | 边界 |
|---|---|---|
| .NET Bridge/Launcher 全量测试 | 151/151 通过 | 自动化功能、协议、存储、恢复、更新与 UI 文案 |
| Node 服务端全量测试 | 1673/1673 通过 | v3 Gateway、ledger、read model、授权与发布清单等 |
| MT5 Python Worker 测试 | 22/22 通过 | Python 适配器协议与 MT5 调用封装 |
| MT4 EA 官方 MetaEditor 编译 | 0 error，0 warning | 编译成功不等同真实 broker 交易矩阵 |
| Windows 主界面走查 | 已通过 | 平台选择、真实 MT5 账户探测、仅 MT5 Worker、内置日志查看 |
| 本机真实 MT5 只读探测 | 已通过 | demo 账户可识别；尚未把生产服务器交易指令作为测试单执行 |

## 4. 尚未完成或不能在本轮伪造的证据

| 项目 | 当前状态 | 完成条件 |
|---|---|---|
| 在线/离线安装包 | 按用户要求暂不打包 | 生成安装器与离线包，在无系统 Python 的干净 Windows 环境安装验证 |
| EXE/DLL Authenticode 与发布证书 | 随打包延期 | 使用正式代码签名证书签名，并在安装/更新链路验证签名与吊销状态 |
| MT4 EA 发布签名与自动复制 | 随打包延期 | 正式构建产物、安装到 `MQL4/Experts/AURUM` 并在干净环境验证 |
| MT5 连续 72 小时 | 未达到时间窗口 | 保存连续运行健康样本、重连和数据一致性报告 |
| 7 天内存增长不超过 5% | 未达到时间窗口 | 使用预热基线和 7 天健康样本计算，而不是短跑外推 |
| MT4 完整 demo 交易矩阵 | 未执行 | 用户挂载 EA 后验证市价/挂单/改单/撤单/平仓、异常和重连 |
| 正常网络数据 p95/p99 | 未测生产链路 | 在目标地区、真实服务器和 broker 采集订单/持仓变化端到端指标 |
| IPC p99 与 Bridge 附加延迟 p99 | 未形成基准报告 | 运行可重复的本机基准并保存分位数和机器配置 |
| 10,000 次重复/超时/断线/重启故障注入 | 尚无完整报告 | 自动化运行并证明重复执行为 0、跨账户为 0 |
| 1/5/20 终端规模测试 | 尚无完整报告 | 准备对应终端实例，记录 CPU、内存、队列、延迟和隔离结果 |
| 90% 新用户 5 分钟完成连接 | 需要用户样本 | 真实安装漏斗和完成时间统计 |
| internal→5%→25%→100% 灰度 | 尚未部署 | 每阶段观察停止线，满足后再扩大 |

## 5. 下一验收顺序

1. 启动当前 Debug 构建，让用户验证首次浏览器授权、MT5 账户和内置日志。
2. 用户挂载 MT4 EA 后执行真实 demo 交易矩阵。
3. 运行本机 IPC/故障注入基准，并开始 72 小时和 7 天采样。
4. 用户允许打包后再完成安装器、离线包、正式签名与干净 Windows 安装验收。
5. 生产部署前执行灰度，不绕过任何停止线。
