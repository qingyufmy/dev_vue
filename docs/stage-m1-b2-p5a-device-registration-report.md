# M1 / B2 / P5A：已认证设备登记与会话归属复核

> 2026-09-06；基线 `66eb22dc`；用户确认开始 P5。状态：P5A 已完成源码/离线验证。P5 分为 A（已认证 owner 设备登记）与 B（非 owner 只读发布）；本批不声称完整 P5 完成。

## 第一轮评审：职责与最小范围

- 现有 V4 refresh → 一次性 ticket → session.hello 已传真实 installation/profile/platform/terminal instance/server/login，但网关只查询预存 profile/binding，缺首次登记写入。
- 复用 hello 作为设备事实输入；只接受由合法 V4 凭据证明的安装/档案和已存在的合法 owner 账户。不能仅凭客户端报 server/login 建账户、认领账户、转移历史归属或生成占位档案。
- 新建档案及绑定在网关短事务中落库；已有相同绑定不重复插入；换号/更换终端关闭旧绑定而非删除。删除过的档案不自动复活，不修改凭据刷新/旧版升级方式。
- 容量仍只在 Redis 以当前 WebSocket 计费；档案条数不是额度，不在登记时占用额度。登记成功不等于连接成功或可交易。
- 不改客户端界面、不打包、不启动软件；非 owner 观摩发布涉及独立路由、投影、查询/命令隔离，留 P5B 单独收口，当前继续拒绝非 owner。

## 第二轮评审：数据、安全、竞态与恢复

- 精确账户查询必须含 platform + broker server + login，禁止 MT4/MT5 同号误匹配。
- ticket 消费后仍须校验当前 V4 refresh 的 user/installation/profile/generation、撤销和用户生命周期/权益；不因兼容 expires_at 过期而拒绝仍有效设备凭据。
- owner 证明须 current grant + 完整开放 interval + account ownership_revision 一致。连接路由冻结凭据 generation 和 ownership revision；activate、touch 及出站 command/query 前重新检查，撤销或变更后失败关闭。
- profile 的 user/installation/platform 不可被另一请求接管；只有当前 owner 的账户可换入，历史绑定保留。新 epoch 校验在写绑定前完成；在途旧连接不能恢复为当前绑定。
- 事务内无 Redis、网络或终端 I/O。数据库错误回滚并返回稳定错误，不自动重放；真实 MySQL 锁序/并发仍需单独实测，不能宣称无死锁。
- 不改变 SQL001–022、bootstrap、纠正迁移及冻结映射。既有表可以承接本批，不为源码登记逻辑预先增加数据表；如发现新增结构必需先记录复审。

### 实施复核后的调整

- .NET 源码确认 epoch 来自每个 profile 的独立 SQLite，不是终端全局序列；服务端改为 user/profile 作用域，在 profile 锁之后检查。新档案不能被另一档案的较大 epoch 误拒绝。
- 相应补命令服务端作用域防护：即使两个档案的 terminal/account/numeric epoch 恰好相同，出站及 accepted/result 回写也须匹配持久化命令的 user/profile；此证明不来自客户端 payload。不把跨档案旧命令自动迁移或重放。
- 旧版迁移保留 `default` 档案名，凭据接口允许 1–128 字符；hello 机器合同及运行校验统一使用 DeviceId，不再错误套用 message ID 的最小 8 字符规则。消息 ID 仍按原严格规则校验。
- 投影事务除入口复核外，再比较冻结 ownership revision 及当前 V4 credential，防止入口鉴权后到落库前撤销/轮换造成旧数据写入。真实跨存储撤销与物理 socket 发送之间无法保证零时间窗口，不宣称原子撤销。
- 结构复核发现 010 的 `UNIQUE(terminal_instance_id,connection_epoch_v4)` 与客户端按 profile 序列冲突，必须追加 023 纠正。第一轮复核决定只换这一索引，不建新表/列；第二轮复核决定保留全部历史行，使用 `(user_id,terminal_profile_id,connection_epoch_v4)` 非唯一查询索引，不因历史相同编号而删改记录。新写依赖 profile 行锁和严格递增；opaque 连接身份唯一索引及安全整数 CHECK 不变。023 仅为迁移文件，未执行；新源码不能被描述为在旧 022 结构上已完整可运行。

## 验收门

离线覆盖首次登记、同绑定重连无重复、合法换号保留旧绑定、跨用户/安装/平台拒绝、无 owner/旧 interval/旧 revision/撤销凭据/过期会员拒绝、旧 epoch 拒绝、事务中途失败回滚、命令/历史查询出站前校验、已撤销会话不能持续写入。

本批不包含新用户配对/首次凭据签发、账户首次认领与归属转移、非 owner 源接入、B3 数据回填、真实服务启动/依赖/终端验证、发布安装器。以上不能用 Mock 或本地编译替代验收。

## 结果

| 检查 | 本地结果 |
| --- | --- |
| 服务端全量离线回归 | 57 files / 419 tests 通过 |
| V4 迁移、备份与字段合同离线回归 | 24 files / 185 tests 通过 |
| 服务端类型检查 / V4 构建 | 通过 |
| 迁移计划 | 24 文件 / 158 语句；新增 023 单条 ALTER，未执行 |
| 旧产物保护 | 基线 SQL001–022、bootstrap/correction 及两份冻结 identity JSON，共 26 个逐字节不变 |
| `git diff --check` | 通过 |

主代理审阅并纠正了 pending 自身 epoch 被误拒绝、含空格的 broker server 被误用设备 ID 校验、按终端而非档案比较编号、不同档案同数字编号时的命令作用域，以及 owner 共享锁再升级更新锁的竞态风险。数据库权益时间只以 SQL UTC 为准，不用应用机时间重复判定。

状态化 SQL double 覆盖登记/换号/回滚与权限变化，但不模拟真实 MySQL 索引和锁；023 另由迁移计划/DDL 合同检查覆盖。Bridge 机器合同校验包含 `default`、1/128 字符边界和非法 ID 反例。未修改前端或 .NET 客户端，未重复运行 UI/真实 Win7 验收。

## 剩余风险与后续门

- 本批只登记已有有效设备凭据和现有 owner 账户；不等于新用户可以完成首次配对或首次账户认领。多个旧用户若拥有相同 `default` ID，现有全局 profile 主键不能合并接管；仍安全拒绝，后续身份迁移/首次配对须设计稳定唯一标识映射。
- 非 owner 管理员观摩源仍不走 owner 路由；独立只读发布、查询白名单与命令隔离留 P5B。
- 换号登记保存绑定历史；若后续 Redis 容量领取或连接激活失败，只表示本次连接失败，不伪造在线。客户端当前换路线会生成新 profile，并需要与其匹配的凭据；完整新增/删除/换号体验仍需客户端与凭据签发阶段验收。
- 跨 profile 的旧命令不自动移交给新 SQLite 账本，未知结果继续保留 uncertain，后续只能精确对账，不能借新档案普通重放。
- SQL double 不执行 MySQL 优化器、行锁或真实并发。生产前仍须独立验证锁序、撤销并发、查询索引与高频 stream 开销；不得宣称无死锁或已完成性能验收。
- 023 执行后若新增跨 profile 同终端编号历史，不可直接恢复旧数字唯一索引；应用回滚前须停止相关接入并核对历史冲突，保留备份/正向纠正路径，不能删除证据来强行回滚。
- 没有运行服务或真实依赖，没有更改运行配置，没有迁移/回填、终端交易、安装器或部署验收。Pro 无本人 Bridge 的分析订阅仍在后续策略/订阅 B2，不属于本批完成项。
