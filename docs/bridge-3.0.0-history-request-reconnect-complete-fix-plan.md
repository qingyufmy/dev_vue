# 量见智桥 3.0.0 历史请求断线重连完整修复方案

> 状态：代码实施与完整发布测试已完成，待重新打包、上传和部署验收
> 日期：2026-08-09
> 目标版本：3.0.0 重新构建版
> 适用范围：最新 Bridge、网站后端、AI 交易实验室前端
> 明确边界：不兼容旧安装，不新增旧协议回退，不修改生产数据库，不清理本地 SQLite

## 1. 最终结论

本次故障必须同时修复 Bridge、网站后端和前端，但根因在 Bridge 的最外层数据请求合同：

1. Bridge 的 Hello 已宣告 `history_cursor_v1` 和 `history_evidence_v1`。
2. 网站后端据此发送 `history_page` 或 `history_evidence`。
3. Bridge 内部 Core 和 Store 已实现这两个动作。
4. 但 `bridge-contract::DataRequestMessage::validate()` 的动作白名单遗漏了它们。
5. transport 将该合同错误视为会话错误，关闭 WebSocket。
6. 前端在重新连接后的 `account_switched` 事件中再次刷新当前交易记录页，形成断线重连循环。

本方案不再为已安装的故障包保留兼容路径。修复后重新构建 3.0.0，使用新的发布 ID、七牛云不可变地址、文件大小和 SHA-256，网站下载接口只指向修复后的最新包。

## 2. 已确认的生产证据

### 2.1 Bridge 日志

在 2026-08-09 02:33:29 至 02:34:52 的约 83 秒内：

- `bridge_data_request_invalid`：39 次；
- `online/connected`：33 次；
- terminal 始终为 `ready`；
- `terminal_errors=none`；
- `history_errors=none`；
- Worker 和 MT5 没有崩溃证据。

### 2.2 公网浏览器复现

管理员登录 `https://www.cnfxtrade.com/ai/` 后进入“交易记录”，9 秒内稳定出现四轮：

1. `loadHistory: bridge_data_request_disconnected`；
2. `loadHistoryChart: bridge_history_route_required`；
3. Bridge 重新连接；
4. `account_switched` 触发当前页面重新读取历史；
5. 再次断线。

### 2.3 代码闭环

- 服务端协议允许 `history_page/history_evidence`；
- Bridge Hello 宣告对应能力；
- Core handler 和 Store reader 已实现；
- 最外层 `DataRequestMessage` 白名单仅允许旧 `history`；
- runtime 对入站路由错误执行 `break Err(error)` 并关闭通道；
- gateway 在连接注销时把待处理请求转换为 `bridge_data_request_disconnected`；
- 前端 `loadHistory()` 捕获错误后仍让 `loadHistoryViews()` 继续调用图表；
- 服务端每次相同账户重新连接也发送 `account_switched`。

## 3. 必须保护的产品与安全合同

1. Bridge 只发现和连接用户已经启动的 MT4/MT5，不启动、关闭或重启交易终端。
2. Bridge 重启、修复安装和卸载不得改变 MT4/MT5 登录状态。
3. 历史读取继续使用有界范围、固定快照、游标分页和本地 SQLite，不恢复无边界全量响应。
4. SQLite 是可重建读模型，不是经纪商交易真相；本次不清库、不重建历史、不修改现有账户数据。
5. 交易命令、结果确认、reconciliation、实时行情、持仓和挂单链路不得因本次修复改变。
6. 终端、账户、broker、login、connection epoch 不匹配必须继续 fail closed。
7. 不执行 SQL、数据库客户端、手工迁移或数据库修复。
8. 仍使用 `history_exact_range_v1`、`history_cursor_v1`、`history_evidence_v1`，不新增兼容版本号。
9. 展示版本保持 3.0.0，但发布 ID、构建日期、包哈希和下载地址必须唯一。

## 4. 修复范围

### 4.1 Bridge 协议合同

目标文件：

- `bridge/contracts/data-request-v1.json`（新增，跨语言测试基线）
- `bridge/native/crates/bridge-contract/src/lib.rs`
- `bridge/native/crates/bridge-transport/src/inbound.rs`
- `bridge/native/crates/bridge-transport/src/runtime.rs`
- `bridge/native/apps/bridge-core/src/lib.rs`
- 对应 Rust 测试

必须完成：

1. 将以下动作纳入 `DataRequestMessage` 的正式白名单：

   - `history_page`
   - `history_evidence`

2. 把数据请求动作白名单收敛为单一 Rust 定义，合同校验、Core allowlist 和测试从同一集合派生，禁止继续维护互相独立的字符串列表。
3. 增加“能力—动作—处理器”不变量：

   - 宣告 `history_cursor_v1` 时，`history_page` 必须通过最外层校验并存在 handler；
   - 宣告 `history_evidence_v1` 时，`history_evidence` 必须通过最外层校验并存在 handler；
   - 未实现的能力禁止出现在 Hello。

4. `DataResponseMessage` 保持 request ID、action、params、route 和 epoch 精确关联。

### 4.2 Bridge transport 容错

当前问题不是只有动作遗漏，还包括“单个数据请求错误关闭整个会话”。需拆分错误等级。

#### 会话级致命错误

以下错误仍关闭 WebSocket：

- 非法 JSON 或未知字段；
- 协议版本或消息类型错误；
- message/request ID 非法；
- terminal 不属于当前 session；
- broker/login/connection epoch 与当前绑定不一致；
- WebSocket 收发失败、超时或认证失效。

#### 请求级拒绝

以下错误返回关联的 `data_response`，状态为 `rejected`，但不关闭 WebSocket：

- 合法路由上的未知 data action；
- params 是合法 JSON，但动作参数不满足业务约束；
- Store/handler 返回稳定的历史读取错误；
- 游标过期、游标无效、范围尚未完整等可归因到单次请求的错误。

请求级拒绝必须使用稳定错误码，并保持：

- 原 request ID；
- 原 terminal/account/epoch；
- 原 action；
- 原 params；
- 不写 outbox；
- 不触发 reconnect backoff。

### 4.3 网站后端协议与路由

目标文件：

- `server/bridge-v3/protocol.js`
- `server/bridge-v3/business-adapter.js`
- `server/bridge-v3/gateway.js`
- `server/bridge-ws.js`
- 对应 Vitest

必须完成：

1. 保留当前 `history_cursor_v1` 能力判断和 `history_page` 路由，不增加旧 `history` fallback。
2. 增加跨语言合同基线，至少包含：

   - data request actions；
   - history capability 到 action 的映射；
   - route 必填字段；
   - 请求级与会话级错误分类。

3. JavaScript 和 Rust 测试都读取或核对同一份合同基线，防止一端增加动作、另一端遗漏。
4. gateway 收到关联的 rejected data response 时，仅结束当前 pending request，不注销连接。
5. 相同 terminal + broker + login 的普通重连不得再广播 `account_switched`。
6. 仅以下情况广播 `account_switched`：

   - terminal 对应交易账户确实改变；
   - broker/login 改变；
   - 当前用户首次建立账户上下文；
   - ownership 确实转移。

7. 相同账户重新连接改发轻量 `bridge_reconnected` 或只依赖现有状态事件，不触发历史、图表和风险详情全量刷新。
8. 增加历史读取紧急停用开关，发布参数统一为 `BRIDGE_HISTORY_READS_ENABLED`。设为 `false` 时：

   - 后端直接返回 `bridge_history_temporarily_unavailable`；
   - 不向 Bridge 发送 `history_page/history_evidence/chart_data`；
   - 不断开 Bridge；
   - 不回退旧历史协议。

该开关只用于发布回滚和生产止损，不是旧安装兼容机制。

### 4.4 AI 交易实验室前端

目标文件：

- `public/ai/app.js`
- `public/ai/index.html`
- `tests/ai/frontend-governance.test.js`
- 必要的前端回归测试

必须完成：

1. `wsApi()` 构造带 `code` 的错误对象，保留后端稳定错误码，禁止只保留 message。
2. `loadHistory()` 返回明确结果或抛出错误，禁止捕获后伪装成功。
3. 只有历史表请求成功，`loadHistoryViews()` 才调用 `loadHistoryChart()`。
4. 同一账户、范围、筛选和连接 generation 只允许一个历史刷新 promise。
5. `bridge_data_request_disconnected`、`bridge_history_route_required`、`bridge_history_temporarily_unavailable` 进入短期熔断：

   - 自动刷新不立即重试；
   - 手动刷新只允许一次新尝试；
   - WebSocket 稳定并重新取得 route 后才解除熔断；
   - 不连续弹出相同错误。

6. `bridge_reconnected` 只刷新状态、账户和实时数据，不自动读取历史。
7. `account_switched` 仅在账户上下文确实改变时清理历史 cursor/cache 并读取当前可见页。
8. 修改 `/ai/app.js` 的静态版本键，确保浏览器不会继续使用故障缓存。
9. 页面错误使用自然中文：

   - “桥接连接正在恢复，请稍后重试”；
   - “历史数据暂时不可用，请稍后刷新”；
   - 不直接显示内部错误码。

## 5. 不在本次修改范围

1. 不改变历史同步调度器优先级、最近范围和 P1/P2/P3 规则。
2. 不改变 Store 游标格式、10 分钟快照时限和容器上限。
3. 不修改 SQLite schema 或索引。
4. 不重新拉取无边界全量 MT4/MT5 历史。
5. 不修改交易命令、风控、reconciliation、自动分析和账户归属业务规则。
6. 不兼容已经安装的故障版；下载接口发布后只支持安装修复后的最新 3.0.0。
7. 不激活未签名或未验证的模块更新；安装器 Authenticode 与模块清单密码学签名继续按现有发布边界处理。

## 6. 分阶段实施计划

### 阶段 A：合同根因修复

1. 收敛 Rust data action 定义。
2. 加入 `history_page/history_evidence`。
3. 增加 capability/action/handler 不变量测试。
4. 验证现有 history、chart、rates、symbols 等动作不回归。

完成门槛：构造真实 `DataRequestMessage` 时，新动作通过外层校验并进入 Core handler。

### 阶段 B：transport 请求级拒绝

1. 拆分 envelope/route 校验与 action/业务校验。
2. 实现非致命 rejected response。
3. 保留身份和路由错误的会话级关闭。
4. 增加 FakeChannel 端到端测试，证明一个非法业务请求后下一条 heartbeat/data request 仍可处理。

完成门槛：单个请求失败不再导致 session runtime 返回错误或调用 channel.close()。

### 阶段 C：后端事件与合同防漂移

1. 增加跨语言合同基线。
2. 修正相同账户重连事件。
3. 加入历史紧急停用开关。
4. 验证 gateway pending request 和 connection generation 行为。

完成门槛：相同账户断开再连接不会触发 `account_switched` 和历史自动刷新。

### 阶段 D：前端单飞与熔断

1. 保留 WebSocket 错误码。
2. 历史失败时停止图表请求。
3. 按账户和 generation 单飞。
4. 对稳定错误码熔断、去重提示。
5. 更新静态资源版本键。

完成门槛：模拟 history 请求失败后，网络记录中没有 chart 请求和立即重复 history 请求。

### 阶段 E：整体验证

1. Rust 全量相关包测试。
2. Node/Vitest 定向和全量测试。
3. Python MT5 Worker 测试。
4. Windows connected process 测试串行执行。
5. 本地或虚拟机网站 + 真实 3.0.0 Bridge + 真实 MT5 联调。

### 阶段 F：重新打包和发布

1. 保持产品版本 3.0.0。
2. 创建新的 production release ID。
3. 正式构建完整安装器和模块包。
4. 验证安装器结构、运行时、默认服务器和安装路径。
5. 上传七牛云不可变路径。
6. 远端重新下载并核对大小与 SHA-256。
7. 更新下载接口元数据和测试。
8. 部署虚拟机网站并验收。
9. 部署公网网站并验收。
10. Windows 服务器覆盖安装最新版 3.0.0 并完成真实浏览器验收。

## 7. 测试矩阵

### 7.1 Rust 合同测试

- 每个已宣告 history capability 都有对应可接受 action；
- `history_page` 正常反序列化和校验；
- `history_evidence` 正常反序列化和校验；
- 未知 action 在合法路由上返回 rejected；
- 错误 terminal/account/epoch 仍关闭会话；
- rejected response 与原 request 精确关联；
- handler 错误不写 outbox、不重连；
- 下一条请求和 heartbeat 继续处理。

### 7.2 Core/Store 测试

- `history_page` 进入 cursor reader；
- `history_evidence` 进入 evidence reader；
- exact range、account scope、快照和 cursor 绑定不变；
- cursor 过期返回请求级错误；
- chart 和 history 可在同一稳定连接内顺序完成；
- 交易和 reconciliation 测试全部保留。

### 7.3 服务端测试

- capability 存在时发送 `history_page`；
- 发送动作与跨语言合同基线一致；
- rejected data response 不注销连接；
- 相同账户重连不发 `account_switched`；
- 真正换户仍发 `account_switched`；
- 历史紧急停用时不向 Bridge 发请求；
- 浏览器请求始终绑定唯一 terminal/account/epoch。

### 7.4 前端测试

- `wsApi` 保留错误码；
- history 失败不请求 chart；
- 同一请求 single-flight；
- 重连事件不自动刷新历史；
- 真正 account switch 清理 cursor 并刷新；
- 熔断期间不重复 toast；
- 手动刷新能恢复；
- 新静态资源版本键被 HTML 引用。

### 7.5 真实环境验收

在 Windows 服务器和公网网站完成：

1. 启动 Bridge，确认 terminal/worker/core PID 稳定。
2. 进入交易记录并停留 5 分钟。
3. 连续切换“首页—交易记录”20 次。
4. 读取第一页、第二页，再返回第一页。
5. 切换最近 7 天、本次接入以来和自定义日期。
6. 使用方向和盈亏筛选。
7. 图表与表格使用相同固定范围。
8. 手动刷新一次。
9. 保持 MT5 已连接且不操作真实交易。

验收期间必须满足：

- Bridge WebSocket connection generation 不变；
- 不出现 `bridge_data_request_invalid`；
- 不出现 `bridge_data_request_disconnected`；
- 不出现 `bridge_history_route_required`；
- terminal、collector、worker 维持 ready；
- history response 有界，无超大 payload；
- 浏览器无重复错误和无限 toast；
- 账户、持仓、挂单和行情仍正常刷新。

## 8. 推荐验证命令

```powershell
cd D:\dev_codex\wall-street-skill-local\bridge\native
cargo fmt --all -- --check
cargo clippy -p bridge-contract -p bridge-transport -p bridge-store -p liangjian-bridge-core --all-targets -- -D warnings
cargo test -p bridge-contract -p bridge-transport -p bridge-store -p liangjian-bridge-core
cargo test -p liangjian-bridge-core --test connected_process -- --test-threads=1

cd D:\dev_codex\wall-street-skill-local
node --check server/bridge-ws.js
node --check server/bridge-v3/protocol.js
node --check server/bridge-v3/business-adapter.js
node --check public/ai/app.js
npx vitest run tests/bridge-v3-protocol.test.js tests/bridge-v3-business-adapter.test.js tests/bridge-v3-gateway.test.js tests/bridge-ws.test.js tests/ai/frontend-governance.test.js
npm test

python -X utf8 -m unittest discover -s bridge/native/workers/mt5/tests -p "test_*.py"
```

正式构建和发布继续使用现有 `scripts/bridge-release/` 生产流程，不用开发构建替代正式包。

## 9. 发布和部署顺序

由于不兼容旧安装，采用一次性最新版本切换。发布过程不识别旧构建、不做按版本分流，也不提供旧协议降级：

1. 完成 A 至 E 阶段并冻结源提交。
2. 构建新的 3.0.0 production candidate。
3. 在隔离 Windows 环境安装 candidate，先通过真实历史页面验收。
4. 上传七牛云并完成远端哈希复核。
5. 提交下载元数据、后端和前端修复，并把部署参数初始设为 `BRIDGE_HISTORY_READS_ENABLED=false`。
6. 推送 `dev_codex`。
7. 部署虚拟机网站，在维护状态下确认不会向任何 Bridge 下发历史请求。
8. 虚拟机 Windows 环境安装最新 3.0.0，确认 Bridge、实时数据和交易命令链路稳定。
9. 仅在该环境临时打开历史读取并完成交易记录验收；验收后重新关闭。
10. 非强推提升到 `main`。
11. 部署公网网站，保持历史读取维护状态。
12. 更新公网下载接口到新的不可变安装包地址。
13. Windows 服务器安装最新 3.0.0。
14. 设置 `BRIDGE_HISTORY_READS_ENABLED=true`，打开公网历史读取，完成 5 分钟稳定性和 20 次切页验收。

旧构建不是支持对象。服务端不检测、不提示、不兼容旧构建；发布窗口只通过全局维护开关避免在新 Bridge 安装完成前下发历史请求。维护开关关闭后，系统仅以本次新构建 3.0.0 为准。

## 10. 回滚与停止条件

### 10.1 实施停止条件

出现任一情况立即停止进入下一阶段：

- data action 白名单仍存在多份不一致定义；
- 合法 history request 仍会关闭 FakeChannel；
- terminal/account/epoch 错误不再 fail closed；
- 交易命令或 reconciliation 测试回归；
- cursor 结果跨账户、跨范围或跨 snapshot；
- 前端仍在 history 失败后发送 chart；
- 相同账户 reconnect 仍触发无限历史刷新。

### 10.2 发布停止条件

- 安装器大小、SHA-256 或远端文件不一致；
- 覆盖安装未保留配置；
- Bridge 无法连接或 Worker PID 反复变化；
- 网站 `/health` 非正常；
- 数据库或 Redis 非 connected；
- 真实页面再次出现三类故障码；
- 日志出现 crash、panic、重启循环或超大 payload。

### 10.3 回滚策略

1. 网站代码回滚到发布前提交。
2. 立即关闭历史读取紧急开关，避免回滚后继续触发断线。
3. 下载接口停止指向失败 candidate。
4. 保留失败包和日志用于审计，不覆盖不可变七牛对象。
5. 不回滚或清理用户 SQLite，不操作 MT4/MT5。
6. 修复后使用新的 release ID 和不可变 URL 再发布。

## 11. 第一轮复审：需求覆盖与最小设计

### 11.1 检查内容

- 是否符合“不兼容旧安装，只以最新版本为准”；
- 是否抓住最小根因；
- 是否误改历史同步、Store 或交易链路；
- 是否存在为了兼容而引入的双轨设计；
- 是否能在不改数据库的情况下完成。

### 11.2 第一轮发现

1. 初步方案曾考虑新增 `history_cursor_v2/history_evidence_v2`，这只为区分旧故障包服务，与用户最新决定冲突。
2. 初步方案曾考虑服务端回退旧 `history`，同样属于旧安装兼容，不应保留。
3. 只把两个 action 加入白名单虽然能修当前故障，但不能防止下一次 capability/action 漂移。
4. 只改 Bridge 不能消除前端在任意断线时的重复刷新放大。

### 11.3 第一轮调整

- 删除所有 v2 能力和长期旧协议 fallback。
- 固定继续使用现有 v1 能力名。
- 加入单一 Rust action 定义和跨语言合同基线。
- 保留 transport 请求级拒绝作为最新版可靠性设计，而不是兼容逻辑。
- 前端加入 single-flight、错误码和熔断。
- 明确不改 Store schema、调度器和数据库。

第一轮结论：方案覆盖用户要求，改动集中在协议入口、连接容错和前端重试，不扩大到历史数据模型。

## 12. 第二轮复审：数据、并发、恢复、安全与发布

### 12.1 检查内容

- 同版本 3.0.0 覆盖发布是否可识别；
- 浏览器缓存是否继续加载旧前端；
- 并发历史表和图表是否重复请求；
- account reconnect 是否再次放大；
- 请求级拒绝是否削弱身份安全；
- 回滚是否会重新触发故障；
- 发布是否需要数据库或 SQLite 迁移。

### 12.2 第二轮发现

1. 仅保持 3.0.0 版本号会造成包身份歧义，必须依靠 release ID、构建日期、不可变 URL、大小和 SHA-256 区分。
2. 若不更新 `/ai/app.js` 静态版本键，浏览器可能继续使用导致重试循环的旧脚本。
3. 普通 reconnect 当前固定发送 `account_switched`，即使根因修复，其他网络错误仍可能触发重型历史刷新。
4. 将所有 validation error 都改成请求级拒绝会削弱 route/epoch 安全，必须只放宽合法 session route 上的 action/业务错误。
5. 网站回滚到旧提交会恢复断线风险，需要独立紧急停用开关先阻断历史请求。
6. 本次没有 schema 需求，加入迁移只会扩大风险。
7. 发布步骤中原有“识别旧包并提示升级”的描述仍属于兼容设计，与用户边界冲突。

### 12.3 第二轮调整

- 明确同版本包的五元身份：版本、release ID、构建日期、大小、SHA-256。
- 把静态资源版本键更新列为强制项。
- 区分 `account_switched` 与 `bridge_reconnected`。
- 明确致命错误和请求级拒绝边界。
- 增加只返回维护错误、不回退旧协议的历史紧急停用开关。
- 明确不创建 migration、不清 SQLite。
- 删除旧包识别、提示、分流和降级逻辑；发布时只做全局维护切换。
- 正式发布前先在隔离 Windows 环境完成真实浏览器验收，禁止把生产服务器当首个测试环境。

第二轮结论：调整后方案满足“只支持最新构建”的版本边界，以及数据安全、并发、异常恢复、缓存、回滚和发布要求，可以进入实施阶段。

## 13. 最终实施顺序

1. Bridge contract 根因修复。
2. transport 请求级拒绝与会话安全测试。
3. 后端合同基线、重连事件和紧急停用开关。
4. 前端错误码、single-flight、熔断和静态版本键。
5. Rust、Node、Python 和 connected process 全量验证。
6. 隔离 Windows 环境真实 MT5 + 浏览器验收。
7. 重新构建 3.0.0 production candidate。
8. 七牛上传与远端哈希复核。
9. 更新下载接口并依次部署虚拟机、公网。
10. Windows 服务器覆盖安装和最终稳定性验收。

## 14. 实施与验证记录

2026-08-09 已完成阶段 A 至 E：Bridge 数据请求合同、transport 请求级拒绝、后端重连事件和维护开关、前端 single-flight/熔断/错误传播及静态缓存键均已落地。

完整发布门禁 `scripts/bridge-release/test-release.ps1` 已通过：

- Python MT5 Worker：63 项通过；
- Rust 工作区：格式、Clippy 和全量测试通过，含 connected-process 4 项通过、8 项显式忽略的真实终端测试；
- Node/Vitest：168 个测试文件、2560 项测试全部通过；
- 无数据库迁移、无 SQLite 清理、无生产数据修改。

剩余工作仅为阶段 F：在干净工作树重新构建 3.0.0、生成唯一 release ID、完成安装/修复演练、上传七牛云、更新下载元数据，并依次部署虚拟机和公网服务器做真实页面验收。
