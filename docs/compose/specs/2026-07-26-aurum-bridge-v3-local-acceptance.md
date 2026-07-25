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

## 持续运行验收工具

`bridge/tests/acceptance/Measure-BridgeHealth.ps1` 会从轮转日志读取健康样本，并失败关闭地检查：

- 样本跨度是否达到 168 小时；
- 最大采样间隔是否超过 150 秒；
- uptime 是否回退，即进程是否发生重启；
- 终端数量是否低于要求；
- 预热后首个窗口与最终窗口的私有内存中位数增长是否超过 5%；
- 同时报告 working set 增长和 Online 样本比例，但不拿短跑结果外推。

合成 168 小时夹具验证结果：私有内存增长 4% 时通过；将门槛收紧到 3% 时正确失败；使用默认采样间隔门槛时正确拒绝大间隔夹具。当前真实日志跨度为 1.259 小时，因此按预期返回 `bridge_health_span_insufficient`，尚不能出具 7 天通过结论。

## 首次授权、静默重启与服务端同步补充证据

- 本机首次浏览器授权在 2026-07-26 02:14 完成，DPAPI 凭证只保存在当前 Windows 用户目录。
- 之后多次启动没有再次进入 `PairingRequired`；2026-07-26 02:33:22 启动的新构建直接经历 `DetectingTerminal → Connecting → Online`，约 0.5 秒进入在线状态。
- 服务端继续使用首次授权创建的同一条 refresh session（ID 21，`created_at` 保持 02:14:54），只更新 `last_used_at`，没有创建新的配对凭证。
- 服务端进程重启后，同一终端可用新 WebSocket session 接管，旧连接后续消息会被围栏拒绝；终端 epoch 不因纯网络重连被强制重置。
- 新构建在真实 MT5 demo 账户下以 connection epoch 16 完成 account、positions、orders 三条首次完整同步，服务端 revision 均为 1，`source_time_msc` 规范存为 `null`。
- 该证据证明“授权一次、后续静默复用”和首次同步链路；不包含真实交易指令，也不替代 MT4 demo 交易矩阵与 72 小时/7 天持续运行验收。

## 账户绑定与有界绩效同步实机证据

- 2026-07-26 最新 Debug 构建再次重启后，connection epoch 17 直接经历 `DetectingTerminal → Connecting → Online`，日志没有进入 `PairingRequired`，没有打开浏览器，也没有要求二次登录。
- 服务端在线会话识别终端 `mt5_93b55965fe14a572fa3594d3`，平台为 MT5，账户为 `596520 / DooTechnology-Demo`，并在首次完整快照就绪后把它绑定到用户 1 的交易账户 1；`identity_verified_at` 为 `2026-07-26 02:56:27`。
- 服务器通过 V3 桥接按需请求有界日绩效汇总，账户 1 的同步状态为 `current`，区间从 `2026-07-16` 到 `2026-07-25`，`last_error` 为 `null`。
- 本次只验证账户身份、完整快照与历史日汇总读取，没有下发任何交易指令；SQLite 和服务器汇总表均不是 broker 交易权威。

## 长期设备授权改造后的重启证据

- 服务端移除固定 `expires_at` 登录门槛后，既有 DPAPI 凭证未被清除，也没有要求重新配对；数据库中的 `expires_at` 仅为旧客户端兼容元数据，不再参与授权判定。
- 最新服务端与 Bridge 受控重启后，Bridge 从 `DetectingTerminal` 到 `Online` 约 0.55 秒，connection epoch 为 19；启动日志没有 `PairingRequired`、`pairing_browser_opened` 或二次登录事件。
- 服务端继续使用 refresh session 21；其 `created_at` 仍为 `2026-07-26 02:14:54`，只把 `last_used_at` 更新为 `2026-07-26 03:03:13`，没有因为升级创建新的授权。
- 本轮仍为真实 MT5 demo 只读联调，没有发送任何交易指令。

## 服务端临时故障不清除授权的重启证据

- 加载 503/401 分类修复后，仅重启 Node 服务端；Bridge、MT5 Worker 和 MT5 终端进程均保持运行。
- Bridge 在 `2026-07-25T19:05:41.754Z` 检测到 `bridge_connection_lost`，并在 `19:05:44.044Z` 恢复 `Online`，约 2.29 秒；connection epoch 保持 19，没有重置终端执行上下文。
- 恢复期间没有 `PairingRequired` 或浏览器授权事件；refresh session 仍为 21，`last_used_at` 更新到 `2026-07-26 03:05:46`，`revoked_at` 仍为 `null`。
- 本次故障恢复测试没有发送任何交易指令。
