# AURUM Bridge protocol v3

此目录是 Bridge、服务器、MT5 Worker 与 MT4 Worker 共用的线协议基线。

- 所有时间均为 UTC Unix 毫秒。
- `command_id` 是交易命令的全局幂等键；重连或重试不得生成新 ID。
- `terminal_instance_id + account_ref + connection_epoch` 是不可变路由，任一不匹配都必须拒绝。
- `revision` 在每个 `terminal_instance_id + connection_epoch + stream` 内严格递增。
- `base_revision` 必须等于服务器已应用的版本；不等时服务器返回 `gap`，Bridge 发送该流的完整快照。
- `uncertain` 不是失败。它表示指令可能已经被 MT 接受，但当前证据不足；服务器只能发起 `query_execution` 复核，不能盲目重发交易动作。
- `data_ack` 是 Bridge 删除 SQLite Outbox 记录的唯一依据。

JSON Schema 用于跨语言生成/验证；服务器入口的无依赖快速校验位于 `server/bridge-v3/protocol.js`。
