# Bridge 服务端 MT5 账户自动重绑修复方案

## 1. 目标与结论

本方案修复以下已复现问题：量见智桥 3.0.4 已在本地识别到同一 MT5 终端中切换后的新账户，但服务端仍保留该终端实例的旧账户路由，WebSocket 握手返回 `bridge_terminal_binding_mismatch`，导致客户端显示“服务器未连接”。

修复只修改服务端，不修改量见智桥 3.0.4，不重新生成模块更新包，不上传七牛云，也不调整更新清单。服务端发布后，现有 3.0.4 客户端重新连接即可生效。

目标行为：

1. 同一网站用户、同一 MT5 终端实例切换到新 `broker_server + login` 时，服务端允许更高 `connection_epoch` 的新路由原子接管。
2. 新路由完成账户、持仓和挂单初始快照前保持不可交易、不可读取旧账户投影。
3. 初始快照完成后，复用现有 `syncTradingAccountIdentity()` 自动切换网站交易账户绑定、订阅路由和账户归属。
4. 旧 WebSocket、旧 epoch、旧账户命令和旧账户缓存不能进入新账户。
5. 跨用户活跃终端接管、只读账户接管和 MT4/MT5 平台身份变化继续失败关闭。

## 2. 已确认根因

### 2.1 客户端终端 ID 与账户身份的定义不同

MT5 的 `terminal_instance_id` 由终端可执行文件路径生成，与登录账号无关。因此，同一 MT5 安装从账户 A 切换到账户 B 后：

- `terminal_instance_id` 保持不变；
- `account_ref.broker_server/login` 变化；
- 3.0.4 本地绑定推进 `connection_epoch`，随后用新账户路由重新握手。

这是当前客户端的正确行为，不应通过把账号加入终端 ID 或匹配软件版本号来规避。

### 2.2 服务端错误地把账户路由当成终端 ID 的不可变属性

`registerBridgeTerminalSession()` 当前按 `terminal_instance_id` 锁定会话记录，只要已有记录的 `platform + broker_server + login_account` 与新握手不同，就直接抛出 `bridge_terminal_binding_mismatch`。该判断没有区分：

- 合法的“同一用户在同一 MT5 中切换账户”；
- 非法的跨用户抢占、平台变化或旧会话重放。

因此客户端虽然已经正确识别新账户，仍无法进入服务端初始同步。

### 2.3 现有服务端后续能力可以复用

服务端在终端初始快照完成后已经调用 `syncTradingAccountIdentity()`，该流程能按 `broker_server + login`：

- 创建或恢复目标 `trading_accounts`；
- 将同一用户的旧账户标记为 `switched`；
- 更新订阅到新账户；
- 仅允许具备交易权限的连接取得账户归属；
- 在跨用户归属转移时停用旧用户订阅、自动推理和交易发送，并记录审计。

本次不重写账户归属逻辑，只修复其前置的 Bridge 会话注册和内存路由失效流程。

## 3. 安全合同

### 3.1 允许同用户账户重绑的必要条件

只有同时满足以下条件，才把路由变化分类为 `account_rebound`：

1. 已有记录与新连接的 `user_id` 相同；
2. `terminal_instance_id` 相同；
3. `platform` 相同，且必须仍为该终端原平台；
4. `broker_server` 或 `login` 至少一项变化；
5. 新 `connection_epoch` 严格大于已有 epoch。

同一账户的普通断线重连保持现有规则：epoch 相等可恢复，epoch 变大可建立新一代连接，epoch 变小拒绝。

### 3.2 必须继续拒绝的情况

- 同一用户以相同或更小 epoch 声称账户发生变化；
- 同一 `terminal_instance_id` 从 MT4 变为 MT5，或从 MT5 变为 MT4；
- 其他用户接管仍处于连接状态的终端实例；
- 其他用户在接管终端实例时同时改变账户路由；
- 观摩源连接的账号与管理员配置的固定观摩账户不一致；
- 新账户只有只读权限却试图取得交易账户归属；
- 任意数据增量、命令结果或心跳携带的账户路由、终端 ID、epoch 与当前会话不一致。

### 3.3 不改变的边界

- 不自动启动、关闭、激活或切换 MT4/MT5 窗口；
- 不修改 Bridge 协议版本、客户端版本和签名更新链路；
- 不降低交易命令的账户、epoch、generation 和预期状态校验；
- 不删除 `trading_accounts`、账户归属历史、交易审计或命令账本；
- 不执行手工 SQL 清理或生产数据修复。

## 4. 设计方案

### 4.1 会话注册：显式区分四种连接

在 `server/bridge-v3/read-model.js` 中，将当前单一 `rebound` 判断拆为：

- `same_route_reconnect`：同用户、同平台、同账户；
- `account_rebound`：同用户、同平台、账户变化且 epoch 严格推进；
- `owner_rebound`：不同用户接管已断开的同账户终端实例；
- `binding_mismatch`：其他组合，继续拒绝。

`account_rebound` 与 `owner_rebound` 都必须在同一个数据库事务中完成路由更新和旧投影失效。注册返回值增加稳定的内部标记，例如：

```text
accountRebound: true|false
ownerRebound: true|false
previousRoute: { userId, platform, brokerServer, login, connectionEpoch } | null
```

这些字段只供服务端 Gateway 生命周期使用，不改变 Bridge 线上协议。

`bridge_v3_terminal_sessions` 的 upsert 必须在合法重绑时同步更新 `platform`、`broker_server` 和 `login_account`，不能只更新 `user_id/connection_epoch/session_id`。

### 4.2 原子清除终端级旧账户投影

合法账户重绑时，在更新会话路由前后同一事务内清除：

- `bridge_v3_stream_revisions`；
- `bridge_v3_account_latest`；
- `bridge_v3_positions_latest`；
- `bridge_v3_orders_latest`；
- 该终端实例的 `bridge_v3_deals` 可重建投影。

原因：这些表当前以 `terminal_instance_id` 为主要隔离键，不能在同一终端 ID 下安全保留两个账户的当前投影；`bridge_v3_deals` 的主键也未包含账户身份，保留会产生票号碰撞或跨账户历史混入。

这里清除的是服务端可重建读取投影，不是 MT5 交易真相，也不删除按 `broker_server + login` 保存的交易账户、账户归属历史、复盘、绩效或审计。新客户端连接必须重新发送该账户的初始快照/历史增量；在重建完成前，风险数据保持不完整状态，不允许交易链路把空数据当作完整数据。

本次优先采用“重绑时清除并重建”的最小修复，不在紧急补丁中改造全部 V3 读取表主键。后续若服务端需要同时长期保留同一终端实例的多个账户投影，再独立设计账户身份维度迁移。

### 4.3 Gateway：先失效旧路由，再暴露新路由

在 `server/bridge-v3/gateway.js` 中使用 `registerBridgeTerminalSession()` 的返回结果：

1. 新 hello 注册成功后，如为 `account_rebound`，先触发内部 `onTerminalRouteInvalidated` 回调；
2. 清除旧账户的内存交易账户映射、首选终端映射、行情/时钟缓存和尚未完成的历史准备任务；
3. 再将 `connectionsByTerminal` 指向新连接，并以 `bridge_connection_replaced` 关闭旧 WebSocket；
4. 新连接的 `account + positions + orders` 三个完整初始快照未全部确认前，保持 `initial_sync_ready=false`，交易命令继续返回 `bridge_terminal_initializing`；
5. 初始同步完成后才调用现有 `onTerminalReady`，重新读取账户快照并建立新 `trading_account_id` 映射。

旧连接关闭回调必须按 `connection_generation` 防护：如果同一终端 ID 已由更新 generation 的连接接管，旧回调不得删除新连接刚建立的账户映射、行情状态或首选终端，也不得错误广播“终端已离线”。

### 4.4 网站账户绑定自动切换

新终端完成初始同步后，继续复用 `synchronizeBridgeV3TerminalIdentity()` 和 `syncTradingAccountIdentity()`：

- 新账户有交易权限：自动激活/创建目标交易账户、切换同一用户订阅路由，并根据现有合同处理账户归属；
- 新账户只读：可以识别和同步为受限账户，但不能取得交易归属，风险状态保持冻结；
- 新账户属于其他用户且当前连接具备交易权限：按既有账户归属接管合同停用旧用户的订阅、自动推理和交易发送；
- 账户身份同步失败：不恢复旧账户映射，终端保持初始化失败或降级状态，交易失败关闭。

浏览器事件继续使用现有 `account_switched` / `bridge_reconnected` 语义，不新增客户端必须理解的协议消息。

### 4.5 旧命令与并发处理

- 旧连接被替换后，其尚未完成的命令按现有逻辑标记为 `uncertain`，不自动重放到新账户；
- 新命令必须同时匹配新 `terminal_instance_id + account_ref + connection_epoch + connection_generation`；
- 旧账户显式路由的命令在新连接上找不到匹配 route，直接拒绝；
- 数据增量继续由 `applyBridgeDataDelta()` 校验数据库当前路由和 epoch，旧连接即使晚到也不能写入；
- 同一终端的并发 hello 依靠 `SELECT ... FOR UPDATE` 串行化，只有严格更高 epoch 的合法同用户账户路由能够最终接管。

## 5. 预计改动范围

### 必改

- `server/bridge-v3/read-model.js`
- `server/bridge-v3/gateway.js`
- `server/bridge-ws.js`
- `tests/bridge-v3-read-model.test.js`
- `tests/bridge-v3-gateway.test.js`

### 按实际调用链补充

- Bridge WS/AI 前端治理测试：验证账户映射只在新身份同步完成后恢复；
- 若历史准备任务需要公开失效辅助函数，再对 `server/bridge-ws.js` 增加最小内部封装及对应测试。

### 明确不改

- `bridge/native/**` 客户端源码；
- `VERSION`、Cargo/Worker/EA 版本面；
- Bridge 更新清单、七牛云对象和安装器；
- `syncTradingAccountIdentity()` 的账户归属业务规则；
- 数据库表结构。当前修复只做事务内数据投影失效，不新增迁移。

## 6. 测试与验收

### 6.1 单元与合同测试

必须新增或调整以下回归：

1. 同用户、同终端、同平台、较高 epoch、login 变化：注册成功并返回 `accountRebound=true`。
2. 同用户、同终端、同平台、较高 epoch、broker server 变化：注册成功。
3. 账户变化但 epoch 相等或更小：拒绝 `bridge_connection_epoch_stale` 或稳定的账户重绑 epoch 错误。
4. 同终端平台变化：继续拒绝 `bridge_terminal_binding_mismatch`。
5. 跨用户活跃会话接管：继续拒绝。
6. 跨用户已断开、同账户路由接管：保持现有 observer profile 转移行为。
7. 合法账户重绑在一个事务内清除五类旧投影并更新账户路由字段。
8. 新连接替换旧连接后，旧 generation 的断开回调不能清除新映射。
9. 重绑后初始同步完成前，交易命令拒绝；完成后三个初始流均来自新 epoch。
10. 新路由建立时旧 `trading_account_id` 映射立即失效，身份同步完成后映射到新账户。
11. 旧账户 route、旧 epoch 的数据增量和命令继续被拒绝。
12. 观摩源固定账户不匹配仍在注册前拒绝。

验证命令：

```powershell
node --check server/bridge-v3/read-model.js
node --check server/bridge-v3/gateway.js
node --check server/bridge-ws.js
npx vitest run tests/bridge-v3-read-model.test.js tests/bridge-v3-gateway.test.js tests/bridge-v3-business-adapter.test.js tests/ai/frontend-governance.test.js
npm test
git diff --check
```

本次不改客户端，因此不要求重新构建 Bridge 3.0.4；发布前可运行现有 Native smoke test 作为无客户端改动证据，但不以其替代服务端测试。

### 6.2 测试虚拟机验收

1. 记录 VM 部署前分支、完整 commit、工作树、进程和 `/health`。
2. 部署 `dev_codex` 的精确修复提交并正常重启服务，不运行手工 SQL。
3. 使用现有 3.0.4 客户端连接账户 A，确认服务器和网站账户映射正常。
4. 在同一 MT5 终端切换到账户 B，点击一次“重新检测”。
5. 验证客户端不再出现 `bridge_terminal_binding_mismatch`，服务器连接恢复。
6. 验证网站当前交易账户自动切换到 B，A 不再作为该终端当前路由。
7. 验证账户、持仓、挂单和历史页面没有 A/B 数据混入。
8. 验证初始同步前不可交易；未获得真实交易授权时只做只读路由、账户快照和 fail-closed 验收。
9. 再切回 A，确认相同流程可重复且不会积累重连循环。

### 6.3 公网发布验收

VM 验收通过后，才将同一修复提交按仓库发布流程推进到 `main` 并部署公网：

1. 部署前记录公网 host、运行目录、分支、当前 commit 和回滚 commit；
2. 只做源码快进和服务正常重启，不改 Bridge 下载/更新元数据；
3. 验证服务器精确 commit、本机与公网 `/health`、首页/AI 页面和有界启动日志；
4. 用现有 3.0.4 客户端完成一次账户 A → B 重绑；
5. 观察是否出现新的绑定冲突、初始同步失败、错误账户路由或重连风暴。

## 7. 实施顺序

1. 在当前独立发布工作树中实现 read-model 的账户重绑分类和事务投影清理。
2. 实现 Gateway 路由失效回调与 generation 防护。
3. 补齐定向测试，先运行定向 Vitest，再运行完整 `npm test`。
4. 主 Agent 审查实际 diff、SQL 参数、并发顺序和失败关闭合同。
5. 形成单一职责 Conventional Commit，推送到 Gitee `dev_codex`。
6. 使用部署流程先发布测试 VM，完成真实 3.0.4 账户切换验收。
7. VM 验收通过且用户授权正式发布后，将同一提交推进 `main` 并部署公网。

## 8. 回滚与失败处理

- 本地测试失败：不提交、不部署。
- VM 健康或账户切换失败：停止公网推进，保留 VM 基线 commit；需要回滚时使用记录的源码回滚点，不执行数据库清理。
- 公网健康失败：回滚到部署前精确 commit，Bridge 3.0.4 和七牛清单不变。
- 公网出现账户数据混入或错误交易路由：立即停止 Bridge 交易发送能力并回滚服务端提交；不得通过删除账户、历史或命令记录掩盖问题。
- 回滚旧服务端代码后，同一 MT5 切换账户会再次被旧绑定规则拒绝，这是已知行为；不应手工篡改会话表作为长期修复。

## 9. 方案复审记录

### 第一轮复审：需求覆盖、最小改动与现有能力复用

结论：初稿若只把 `bridge_terminal_binding_mismatch` 改为允许，会让新账户沿用旧账户的 stream revision、当前持仓/挂单投影和内存 `trading_account_id` 映射，存在跨账户读写风险；若改客户端终端 ID，则会再次要求发布 3.0.5，并破坏终端实例的安装级稳定身份。

调整：

- 明确只允许“同用户 + 同平台 + 更高 epoch”的账户路由变化；
- 把旧账户的五类终端级服务端投影清理纳入同一事务；
- 增加 Gateway 内存路由先失效、初始同步后再绑定的顺序；
- 复用现有 `syncTradingAccountIdentity()`，不重写账户归属、订阅迁移和只读权限规则；
- 明确不修改客户端、不发新包、不改七牛和更新清单。

剩余风险：当前 V3 deals 投影未按账户身份建立复合主键，紧急修复只能在账户重绑时清除并重建；重建期间历史/风险数据会暂时不完整，但必须失败关闭，不能展示为完整。

### 第二轮复审：兼容性、数据、并发、异常恢复与连带 Bug

结论：第一轮调整后仍存在两个并发风险：旧 WebSocket 的延迟断开回调可能清除新连接映射；账户切换若允许相同 epoch，则两个不同账户路由可能依赖到达顺序互相覆盖。

进一步调整：

- 账户路由变化必须使用严格更高 epoch；同一账户普通重连才允许相同 epoch；
- 旧连接关闭清理增加 `connection_generation` 比较，不得影响新 generation；
- 注册事务使用现有行锁串行化，并在同一事务中更新路由、推进 epoch、清除旧投影；
- 新连接初始同步完成前禁止交易，旧账户命令不重放；
- 观摩源固定账户校验和跨用户活跃会话拒绝保持原样；
- 部署不新增迁移、不执行手工 SQL，回滚只按精确源码 commit 进行。

最终判断：方案满足服务端单点修复、现有 3.0.4 客户端直接生效、账户自动切换和交易失败关闭要求，可以进入实施。实施时若发现必须改变 `syncTradingAccountIdentity()` 的账户归属合同、数据库主键或 Bridge 协议，必须停止并重新评审，而不能扩大本补丁范围。
