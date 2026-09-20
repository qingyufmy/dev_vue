# 本地 Bridge 重连失败修复

## 证据与根因

新建档案的 session-token 请求已返回 201，但本地 Gateway 的 WebSocket 会话登记失败。增加仅记录机器码的诊断后，实际返回 `bridge_route_storage_unavailable`，底层码为 `ER_TRUNCATED_WRONG_VALUE`。

在当前 MySQL 上用只读 `SELECT CAST(? AS DATETIME(3))` 核对：带 `T/Z` 的 ISO 时间字符串产生 1292 警告；等价 MySQL 日期格式没有警告。连接登记及首次账号登记把 ISO 字符串直接作为 DATETIME 参数传入，严格写入因此失败。

另一个诊断缺陷是桌面传输收到 WebSocket Close 后直接返回 null，丢失服务器关闭原因，导致界面一直显示等待重连且最近错误为空。

## 修改

- 数据库边界将首次账号、所有权、终端绑定、连接登记、激活、心跳、断开时间转为 Date，由已配置 UTC 的 mysql2 驱动序列化。
- Gateway 记录经过筛选的公共错误码和 MySQL 错误码，不记录 SQL、参数、票据或原始数据库正文。
- 桌面保留非正常 Close 中符合 bridge 机器码格式的原因；其他正文仅显示数字关闭码。正常关闭保留原行为。
- SQL 测试替身拒绝写入中的原始 ISO 时间字符串，模拟本次真实依赖暴露的限制；兼容 UTC Date 参数。

## 验证与待完成

- account-registration、mysql-bridge-profile-registration、bridge-v4-websocket-server 共 39 项测试通过。
- build:server:v4 通过，包含边界和生成合同一致性检查。
- .NET x86 checked/warnings-as-errors 构建通过；真实 loopback WebSocket 测试验证正常帧、服务器关闭原因、非机器正文脱敏及正常关闭。
- git diff --check 通过。
- 候选桌面产物：D:\dev_codex\.local-runtime\bridge-reconnect-fix-20260914。
- 首次本地替换与重启操作被自动审批返回 blocked by policy；用户关闭旧进程后，已校验文件哈希并安装、启动修复版。实际 MT4、MT5 均曾完成连接登记；1 条额度限制同时只允许其中一个连接。
- 后续实测暴露另一个超时缺陷：15 秒建连超时沿用为 ReceiveTimeout，与 15 秒心跳间隔竞争。已将升级后的读取超时与建连超时分开，读取兜底覆盖合同允许的最长心跳周期及 ACK 期限；新增真实 TCP 测试在建连超时后继续等待并成功接收。已更新本地 Core 并重启 Bridge。
- 12:48:54 本地只读核验：MT5 同一 epoch 17 从 12:47:51 持续至 12:48:52 更新心跳，覆盖 60 秒、4 个心跳周期，未重建会话；最近心跳距查询 2 秒。MT4 当前返回 bridge_capacity_exceeded，因 MT5 已占用唯一额度。此次没有操作终端交易开关或发送交易指令。
- 未执行人工数据库修复、迁移、交易指令或公网部署。工作区包含大量继承改动，当前未混合提交。
