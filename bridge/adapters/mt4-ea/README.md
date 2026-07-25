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

MT4 不支持 MT5 的 stop-limit 类型，主程序会在发送到 EA 前明确拒绝。多 MT4 连接注册仍需继续实现；在完成 demo 账户下单、撤单与断线复核前，本模块不可用于生产交易。

实现依据：MetaQuotes 官方文档说明 MQL4 的 `FileOpen` 支持 `\\.\pipe\...`，并要求在 Named Pipe 读写切换之间调用 `FileFlush` 与 `FileSeek`；定时任务由 `EventSetTimer`/`OnTimer` 驱动。
