# AURUM Bridge v3 本机验收记录

日期：2026-07-26

分支：`refactor/aurum-bridge-v3`

代码提交：`4e87ae4`

## 测试环境

- Windows 11 专业版 `10.0.22631`
- Intel Core i5-14600KF，14 核 / 20 逻辑处理器
- 31.8 GiB RAM
- .NET `net10.0-windows` Debug 构建

## 执行命令

```powershell
& 'C:\Users\Administrator\.cache\aurum-dotnet\dotnet.exe' test `
  bridge/tests/AurumBridge.Tests/AurumBridge.Tests.csproj `
  --no-build --no-restore `
  --filter 'TestCategory=Acceptance' `
  --logger 'console;verbosity=detailed'
```

## 结果

| 验收项 | 本次结果 | 判定 |
|---|---:|---|
| 10,000 次重复、过期、跨账户、Worker 中断与重启注入 | 228 ms；Worker 实际调用 2 次；重启后重放调用 0 次 | 通过 |
| Bridge 本地调度附加延迟 | p99 `5.052 ms`，1,000 样本 | 通过 `≤ 50 ms` 本机门槛 |
| 当前用户 Named Pipe 协议往返 | p99 `0.092 ms`，1,000 样本 | 通过 `≤ 10 ms` 本机门槛 |
| 单 Worker 崩溃隔离 | 1、5、20 终端规模全部通过 | 通过 |
| 未确认 Outbox 跨进程恢复 | 全部恢复 | 通过 |
| MT4 指令动作矩阵 | 模拟 EA 覆盖下单、改单、撤单、平仓等动作 | 通过协议测试 |
| 真实 MT5 Worker 崩溃恢复 | 杀死 Worker 后 `1.991 s` 启动替代 Worker；MT5 进程未重启 | 通过 `≤ 30 s` 门槛 |
| 真实 MT5 → SQLite 读模型 | account/positions/orders revision 均为 1；当前空仓、无挂单 | 通过 |
| 未授权离线 Outbox | 当前 epoch 仅保留 3 个完整快照；旧 epoch 无残留 | 通过有界恢复检查 |

Acceptance 测试总数：8，全部通过。

## 结果边界

- 延迟值只代表这台机器上的进程内调度和 Named Pipe 协议，不包含公网、服务器、MT、broker 或真实成交时间。
- 10,000 次注入使用持久化 SQLite 回执、模拟 Worker 中断和 Dispatcher 重建，证明当前本地幂等边界；仍需补充真实进程强退、Windows 重启和服务器断线组合实验。
- 1/5/20 终端测试使用模拟 Runtime，证明监督器隔离和 Host 编排；不代表同机启动 20 个真实 MT 实例后的 CPU、内存和 broker 行为。
- MT4 动作矩阵是协议与 Runtime 测试，不替代真实 demo broker 的下单/改单/撤单/平仓验收。

## 同次真实只读启动证据

- 识别 MT5 demo 账户 `596520 / DooTechnology-Demo`。
- 只启动一个选中的 MT5 Worker，connection epoch 为 9。
- 无本地授权凭证时进入 `PairingRequired`。
- 首次授权启动请求遇到服务器超时后保持后台退避重试，超过 60 秒未重复记录 `pairing_failed`，也未生成不完整凭证。
- 实际终止 Python Worker 后，Host 在 1.991 秒内恢复同一终端的新 Worker；MT5 PID 与启动时间保持不变。
- 重启后的 connection epoch 10 中，SQLite 写入账户快照和 account/positions/orders 三条 revision；由于 demo 账户为空仓且无挂单，两个集合 latest 表为 0 行。
- 服务器不可达时 Outbox 只保留当前 epoch 的三个完整快照，execution receipts 为 0；这验证了 SQLite 的缓存/Outbox 边界，没有把它当作 broker 交易权威。
