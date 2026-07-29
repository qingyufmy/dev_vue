# AURUM Bridge MT4 EA

`AURUMBridgeEA.mq4` 是 MT4 本机适配器，不直接连接互联网，不保存 AURUM token，也不包含策略或自动风控。

当前模块实现：

- 使用 MQL4 原生 Named Pipe 连接本机 `AURUMBridge.exe`，不依赖 DLL；
- 上报终端、服务器和登录账号身份；
- 按主程序请求采集账户、持仓和挂单快照；
- 执行下单、撤单、改单、平仓和执行结果查询；
- 每条交易指令在 EA 内再次核对终端 ID、账号、服务器、connection epoch 和截止时间；
- UTF-8 二进制帧、4 MiB 上限和明确的协议版本。

安装完成后，用户只需把 EA 挂到任意一个图表一次。默认 Pipe 名为 `AURUMBridgeV3`，正常安装无需修改。

MT4 不支持 MT5 的 stop-limit 类型，主程序会在发送到 EA 前明确拒绝。Native 默认 Core 统一接收公共注册，按终端数据目录将主账户和观摩源分配到隔离 Profile，再切换到各终端专用重连管道；Profile 进程不会争抢公共入口。生产发布前仍需对最终安装包执行 demo 账户下单、撤单、账户切换与断线复核。

实现依据：MetaQuotes 官方文档说明 MQL4 的 `FileOpen` 支持 `\\.\pipe\...`，并要求在 Named Pipe 读写切换之间调用 `FileFlush` 与 `FileSeek`；定时任务由 `EventSetTimer`/`OnTimer` 驱动。
