# 桥接额度等待与账户区域修复

用户要求：超过额度后停止反复连接，只在额度可用后恢复；账户区域分清身份与额度，并及时刷新。

## 根因与实现

- 实际连接在 Gateway Redis lease 集合中计数，安装授权状态接口此前却通过 RedisConnectionLeaseStore 查询另一套集合。现由 Gateway 提供 count 能力，API composition 明确接入该数据源，统计未过期的连接，不从本地列表推测全账户用量。
- Worker 收到 bridge_capacity_exceeded 后进入 capacity_wait，循环只等待，不再取得 session token 或创建 WebSocket。用户断开或退出仍能停止 Worker。
- 桌面每 5 秒左右查询一次安装授权和额度。仅成功、已授权的响应可唤醒等待档案；查询失败保持等待。恢复前扣除已有连接尝试占用，按照空位数恢复档案，最终仍以服务器原子额度校验为准。
- 账户区域上行显示账号与原有退出按钮，下行显示已用 / 总额及可用数量。状态失效时显示待核实，不展示旧额度为当前真相。列表使用“等待可用额度”，不再把额度等待标为红色故障；成功连接后清除旧错误。

## 定向复核与验证

- 额度仍由服务器控制，不改变 Pro / Plus / 免费或增购规则，不增加本地越权判断。
- 11 项服务端定向测试通过，含真实 Gateway 计数能力接入 composition 的回归；服务端构建及边界门禁通过。
- .NET x86 checked/warnings-as-errors 编译通过。Worker 行为测试覆盖收到额度错误后越过退避时间仍只有一次连接尝试、收到恢复通知后再次尝试，以及停止清理。
- 本地 API 与桌面已更新启动。通过桌面同一 InstallationAuthorizationStore.Status HTTP 路径只读验证 Authorized=True、Active=1、Total=1、Available=0，未输出凭据。
- 本地 MT5 已连接；MT4 首次额度拒绝后停止 session-token 请求，状态接口继续约 5 秒刷新。未操作真实终端交易权限、未发送交易指令。
- 原生桌面自动截图不可用，实际排版仍需以用户窗口显示为准；没有将源码检查表述为视觉验收。
- 本轮候选产物与更新前备份：D:\dev_codex\.local-runtime\bridge-capacity-wait-20260914。大量继承改动无法安全整体提交，本轮未混合提交或发布。
