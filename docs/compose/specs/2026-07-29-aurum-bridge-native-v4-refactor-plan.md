# 量见智桥 Native V4 渐进式重构计划

> 状态：阶段 0 / 1 进行中
> 基线分支：`refactor/aurum-bridge-v3`
> 当前 V3 兼容基线：`906b9f88faf736d285b1099b0c688277db3c0757`

## 1. 目标

在不改变用户使用方式、服务器 V3 协议、MT5 Python 官方接口、MT4 EA 协议、SQLite 数据语义和更新信任链的前提下，将 Bridge Host、托盘 UI 和 Launcher 渐进迁移为 Rust/Win32 原生实现。

目标安装包为 35–50 MiB，正式支持 Windows 10 22H2 / Windows 11 x64，不要求用户预装 .NET、Python、VC++ 或 OpenSSL。

## 2. 不变合同

- Bridge 只负责连接、转发、执行、回传、恢复和更新，不承载 AI、策略或业务风控。
- 普通用户只运行一个主账户；管理员才能添加多个隔离的观摩源。
- 一个终端对应一个 Worker；单 Worker 故障不得影响其他终端。
- 命令先持久化再执行；重复、过期、错账户和错 epoch 的命令失败关闭。
- 执行结果不明确时先核对 MT 事实，不自动重放。
- SQLite 是可恢复的本地读模型、Outbox 和有限回执，不是 Broker 交易事实。
- 继续使用签名 Manifest、包签名、SHA-256、版本目录、健康检查和 last-known-good 回滚。

完整冻结项记录在 `bridge/native/contract-baseline.json`。

## 3. 迁移顺序

1. 冻结协议、CLI、DPAPI、SQLite 和安装目录合同，建立黄金样本。
2. 建立 Rust workspace、健康检查、路径、日志、单实例、DPAPI 和 SQLite 基础层。
3. 兼容现有服务器 V3 JSON 协议、WSS、重连、优先队列和 Outbox。
4. 复用当前 Python Worker 完成 MT5 只读和历史链路。
5. 完成 MT5 命令账本、执行、超时和 uncertain 核对。
6. 兼容当前 MT4 EA 二进制协议和完整交易矩阵。
7. 实现独立原生 Core、托盘 UI、管理员观摩源控制和内部日志查看。
8. 先由现有 .NET Launcher 灰度 Rust Core；Core 稳定后再替换原生 Launcher。
9. 精简 Python 运行时；最后单独评估 Cython Worker，避免与核心迁移同时引入变量。

### 当前实现进度

- 已完成独立 Rust workspace、V3 JSON 包络黄金样本、Launcher CLI、版本目录和健康检查基础。
- 已完成 V3 默认账户及管理员观摩源 Profile 路径兼容，仍保持普通用户单主账户合同。
- 已完成 V3 `credential.dat` 的 DPAPI CurrentUser 双向兼容测试；Rust 与 .NET 可互相加密、解密同一凭据格式。
- 已完成 `bridge.db` 只读兼容检查，覆盖完整性、WAL 及当前全部必需表/列，并直接对照 C# 建库源码防止契约漂移。
- 当前只提供诊断探针，不写入 V3 SQLite、不接管凭据、不连接服务器或交易终端。
- 阶段 1 仍缺少原生日志、单实例和进程级故障恢复；完成这些边界后才进入服务器连接层。

## 4. 首批安全边界

首批 `liangjian-bridge-core` 只实现版本输出、Launcher 参数解析和严格健康检查。普通运行固定返回 `native_bridge_runtime_not_ready`，不写 ready 文件、不连接服务器、不连接 MT、不接收交易，因此不能被误发布为生产 Core。

## 5. 验收和停止线

每批至少执行 Rust format、Clippy、单元测试以及对应现有 Bridge 回归测试。真实交易批次只使用 demo 账户。

出现重复订单、错账户路由、未确认回执丢失、SQLite 不可回退、更新不能自动回滚、普通用户获得观摩源能力或 WSS 静默降级时，立即停止灰度并恢复 V3。

最终切换要求包括：10,000 次故障注入无重复执行、MT4/MT5 demo 完整交易矩阵、72 小时持续运行、7 天内存增长不超过 5%、干净 Windows 10/11 安装、Defender 验收及 internal → 5% → 25% → 100% 灰度。
