# Bridge V4 MT4 terminal adapter

该目录只保留阶段 8B 的 MT4 终端适配器。它通过本机命名管道连接 Bridge，
不连接互联网、不保存网站授权、不加载 DLL，也不会自动启动或关闭 MT4。

MT5 不安装 EA。Bridge 为每个已启动的 MT5 终端档案运行一个隔离的官方
`MetaTrader5` Python Worker，复用 `bridge/native/workers/mt5/worker.py` 与
`trade.py` 的数据和交易合同。

## 文件

- `common/BridgeV4Pipe.mqh`：MT4 使用的 4 字节 little-endian 长度帧、固定消息、UTF-8 和 JSON 辅助函数。
- `mt4/BridgeV4MT4.mq4`：MT4 EA；保留 `mt4_order` 平台语义，不伪造原生 position/deal。

## 编译

```powershell
.\bridge\prototypes\net48-win7\adapters\build.ps1
```

本机 2026-09-02 编译结果为 `Result: 0 errors, 0 warnings`。MetaEditor 退出码不是
可靠的结果指示，脚本以同目录 `.log` 中的 `Result` 行为准。生成的 `.ex4` 和 `.log`
已由 `.gitignore` 排除。

## 合同边界

MT4 提供账户、品种、报价、K 线与成交量、持仓、挂单、历史、时钟校准、诊断和
确定性交易操作。复杂风控快照、报表、指标、策略和 AI 输入由服务端按基础数据组合。
所有请求必须有界并绑定终端实例、经纪商服务器、登录账号和连接代次。

正式验收仍需要在 Windows 7/10/11 隔离环境验证 MT4 EA 的安装、连接、账户切换、
断线恢复、长时间运行和交易清理；当前 Windows 开发机的 MT4 实机验收单独记录。
