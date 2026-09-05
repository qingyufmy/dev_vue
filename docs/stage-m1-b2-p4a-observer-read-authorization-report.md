# M1 / B2 / P4A：观摩结构与统一读取鉴权

> 2026-09-05；基线 `5c3c41ba`。用户确认继续 P4；本批为 P4A 源码/离线实现，不执行 DDL/DML、启动、部署、真实依赖或终端操作。

## 1. 实施前两轮复审

第一轮（需求、职责、复杂度）：沿用频道/accesses，追加独立 source，不批量给用户制造授权。all 仍为有效登录用户；plus/pro 精确匹配、不做等级继承；显式 grant 可覆盖 audience，但不可覆盖 source/channel 不可用。统一 reader 供列表、context、HTTP、WS 调用。先实现读取闭环，管理员配置/撤销写接口与幂等审计/outbox 为 P4B，不把 P4A 声称为整个 P4 完成。

第二轮（安全、异常、数据）：source 关联不完整、账户兼容投影不一致、操作者/观众失效均拒绝。私有数据读取须先有观摩证明、随后通过来源校验并构造白名单发布结果，再复核 source/channel 版本；禁止复制 operator 凭据、设备元数据、历史或推理关联。WS 不直接转发源账户事件正文，仅发授权后的轻量发布失效，前端 HTTP 回读。授权最长 30 秒，事件到达时重验；到期停止投递并关闭，依赖失败不沿用无限缓存。无事件时的到期计时只关闭连接，不在实时网关引入数据库轮询。

## 2. 范围与验收

- 追加 021 source/channel/accesses 结构，保留 001–020、bootstrap/correction 及冻结映射字节。
- source pending、缺 slug/source、错配兼容账户的旧频道不自动公开；等待 B3 对账或 P4B 配置。
- 统一动态 audience/显式 grant、会员到期、source/channel 状态验证；普通读取不授予 operator owner 权限。
- HTTP 发布数据白名单与读取后版本复核；原始 Bridge 实例、login/server、signal ID 不向观众公开。
- WS 订阅/投递重验、有界到期、源切换/失败关闭；仅失效通知，不排队缓存私有正文。
- 前端只适配新失效合同及观摩订阅，不改视觉设计；HTTP 回读在账户/品种切换和停止后拒绝旧响应覆盖，401/403 清理当前投影。

## 3. 未覆盖边界

管理员配置 API、默认频道并发切换、授权写入与 outbox 及时撤权为 P4B；非 owner 源设备登记/发布为 P5。P4A 仅能发布已通过当前 owner 来源校验的数据；不添加绕过 owner 的 Bridge 执行入口。真实 MySQL、Redis、30 秒故障传播、性能和浏览器体验需后续运行验收。原始迁移与时间证明仍在 B3，不回填旧值或启用运行开关。

当前复用只读账户 DTO：login/server 为固定脱敏文案，profile/instance/lastSeen 为空，tradePermission=false，bridgeState 为不可执行的 offline 值；这不是源操作者真实设备健康报告。公开行情/财务指标和持仓/挂单仍保留各自真实观察时间与 revision。交易历史、原始推理关联和设备健康私有事件不发布。

HTTP 发布读采用授权→显式 operator 私有来源读取→白名单 DTO→授权及归属版本复核。context 进入事务沿用 context 行锁，再用同一连接的授权锁定读取；P4B 写入必须避免反向持有 source/user 锁后再等待 context，真实锁序/查询计划和死锁恢复仍需独立 MySQL 并发验收，不能由 mock SQL 字符串断言证明“无死锁”。

观摩更新暂采用合并失效通知后 HTTP 回读，不直接复制 owner WS payload。此选择优先保证数据边界，但增加观摩侧查询成本；每连接合并在途回读不等于已通过高并发容量验收。后续须用真实负载测量查询次数、延迟和慢消费者表现，再评估独立的已脱敏增量投影，不绕过发布服务来优化性能。

## 4. 验证

- 迁移、备份、字段清单与恢复离线回归：**21 files / 172 tests 通过**。021 覆盖边界暂停、完成跳过、半完成拒绝重放；本地计划为 **22 文件 / 154 语句**。
- 服务端全量：**50 files / 347 tests 通过**；`pnpm run typecheck:server`、`pnpm run build:server:v4` 通过。观摩新增 reader 16、publication 7、context 5、HTTP 7、WS 20，共 55 项专项测试。
- 前端全量：**30 files / 133 tests 通过**；边界检查、`typecheck:frontend`、四应用 `build:frontend` 通过。新合同 3、实时适配 4、回读作用域 5 项；无 Vue 组件、样式或布局改动。构建仍有 Nuxt 依赖的 `DEP0155` 警告，不影响退出码，本批未升级依赖。
- 主代理复审及修正：不保留旧 accesses-only 授权回退；不把过期会员当作单独 grant 失效；无效日期拒绝；授权查询后再次检查期限；读取前后比较 ownership/source/channel/access/security 版本；列表越过 100 行继续 keyset、最终剔除分页期间过期的会员授权；混合本人信号/观摩目标不误拒绝；同频道静默资源共同续期；异步投递异常清理；通知 ID 限长；观摩端不消费原始 owner 数据；晚返回 HTTP 不覆盖新作用域。
- 对照基线 `5c3c41ba`，既有 SQL/bootstrap/correction 和两份冻结 identity JSON 共 **24 个保护产物逐字节不变**。没有执行 DDL/DML、回填、旧数据删除或终端操作；真实 A/B 安装证据仍只到 017。
- `git diff --check`、本地文档链接和源码发布前分支检查通过。范围仅 `dev_vue` 源码提交/推送；没有部署、重启、启用运行开关或发布 Bridge。

## 5. 下一确认门

**P4B：观摩管理配置与授权写入闭环**。补受限管理员 source/channel 配置、默认频道切换、授权/撤销，落实 CSRF、幂等、乐观版本、审计与 outbox 失效传播，并通过并发/失败离线测试。该批仍先做源码，不隐含授权真实迁移、运行切换或 MT4/MT5 交易。用户确认后开始；P4B 完成前不将 P4 标记为整体完成。
