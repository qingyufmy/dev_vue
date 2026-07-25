# AURUM Bridge MT4 EA

`AURUMBridgeEA.mq4` 是 MT4 本机适配器，不直接连接互联网，不保存 AURUM token，也不包含策略或自动风控。

当前模块实现：

- 使用 MQL4 原生 Named Pipe 连接本机 `AURUMBridge.exe`，不依赖 DLL；
- 上报终端、服务器和登录账号身份；
- 按主程序请求采集账户、持仓和挂单快照；
- UTF-8 二进制帧、4 MiB 上限和明确的协议版本。

安装完成后，用户只需把 EA 挂到任意一个图表一次。默认 Pipe 名为 `AURUMBridgeV3`，正常安装无需修改。

交易指令执行和多 MT4 连接注册将在同一 v3 本机协议上继续实现；在这些能力完成并通过 MetaEditor 编译与 demo 账户验证前，本模块不可用于生产交易。

实现依据：MetaQuotes 官方文档说明 MQL4 的 `FileOpen` 支持 `\\.\pipe\...`，并要求在 Named Pipe 读写切换之间调用 `FileFlush` 与 `FileSeek`；定时任务由 `EventSetTimer`/`OnTimer` 驱动。
