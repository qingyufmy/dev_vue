# 数据库逐表迁移矩阵

> 最新状态：阶段194已完成模型归属和额度单例CHECK，当前133步、222表、117个CHECK，271337行业务数据不变。约束真实拒绝、中断恢复和重复执行通过；全域规范化仍在推进。验收：[阶段194](migration/dev-vue-inplace-stage194-20260908.md)、[目录v6](migration/dev-vue-structure-remaining-work-20260908-v6.json)。

> 最新状态：阶段193已完成17项默认值/摘要排序调整，dev_vue累计131步、222表、271337行业务数据保持。剩余11项类型、1项可空性、6项默认、36项排序差异；6张同名表缺列、69张根依赖缺表仍待处置。特权对象目录已补查。当前证据：[阶段193](migration/dev-vue-inplace-stage193-20260908.md)与[目录v5](migration/dev-vue-structure-remaining-work-20260908-v5.json)。以下阶段数字为历史记录，数据库全域规范化继续推进。

> 当前结构进度（2026-09-08）：dev_vue 已114步/222表，原165表和原字段保留；详细剩余缺表、字段、类型、可空性、默认值和排序规则差异以[实际目录v4](migration/dev-vue-structure-remaining-work-20260908-v4.json)为准。本表承担旧源业务处置设计，不代表当前安装/回填状态；后续按[结构收口方案](database-structure-completion-plan-20260908.md)推进。

> 2026-09-06 全面规范化接续方案：[数据库结构优化与全面规范化实施方案](database-standardization-execution-plan-20260906.md)。原始观测和历史设计保留；新实施以实际结构复核、全量字段合同及追加迁移为准。

> 状态：阶段 7 逻辑设计基线；M1 已完成双库结构安装，尚未回填旧数据。
>
> 最新执行依据：[M1 回填方案](./stage-m1-data-backfill-and-reconciliation-plan.md) 与 [165 表物理差异清单](./migration/m1-source-target-gap-matrix-20260905.md)。下列候选目标不代表已经建成，禁止直接据此复制数据。
>
> 数据源：`dev_vue`，MySQL 8.4.8
>
> 初始观测时间：2026-09-02（只读一致性事务，不是持久化备份）；2026-09-05 复核源表计数不变。
>
> 关联方案：[数据库规范化与全量数据迁移方案](./database-normalization-and-data-migration-plan.md)

## 1. 本阶段结论

当前源库共 165 张 InnoDB 表、271,007 行、约 682.50 MiB。目标库不会机械复制全部结构，也不会直接在源库原位改表：

- 语义清楚、结构基本合理的表原名保留，只统一 UTC、类型、索引、约束和 Repository 边界。
- 一个业务事实分散在多表、用户级单例与新版账户级业务冲突、或者摘要和大载荷混在宽表中的结构进行重塑或拆分。
- V3、旧全局配置和重复通知/记忆入口仅作为迁移输入；先迁移、对账和归档，不能因为名称带 `v3` 或当前为空就直接删除。
- 所有源数据都必须有目标行、显式归档或经用户确认的“无业务数据且无代码引用”结论。`候选删除` 不是本阶段删除授权。
- Bridge 额度只计算当前用户有效的账户 WebSocket lease；离线档案和历史账户不占额度。MySQL 保存权益与审计，实时 lease 使用带 TTL 的原子实时状态。
- 策略订阅作用域固定为系统用户、具体交易账户和策略；不能恢复用户级唯一活动订阅。

## 2. 动作定义

| 动作 | 含义 |
| --- | --- |
| 保留 | 表继续作为目标权威表；允许字段、索引、UTC 和外键规范化 |
| 重塑 | 业务实体保留，但主键、唯一键、字段或作用域需显著调整 |
| 拆分 | 摘要、详情、大载荷、当前状态或历史事件拆成独立权威表 |
| 合并 | 数据并入另一权威实体，源表完成对账后退出活动结构 |
| 归档 | 不进入活动查询模型；全量导出、计数与 SHA-256 对账后保留在归档介质 |
| 候选删除 | 当前无必要业务语义或已被替代；只有通过独立删除门后才能删除 |

每张表的迁移都必须生成 `source_count`、`target_count`、主键范围、状态分布、最早/最晚时间、业务数值汇总和规范化哈希。下表“目标”可以是多个表，但每个源字段在正式字段映射清单中只能有一个处置结果。

## 3. 身份、认证、用户与系统配置（10 张）

| 源表 | 行数 | 动作 | 目标 | 转换与对账重点 |
| --- | ---: | --- | --- | --- |
| `users` | 25 | 拆分 | `users`、`user_profiles`、`memberships` | 保留 `id/uid`；登录身份、角色、安全版本留在 `users`，昵称头像进资料，套餐与到期时间进会员当前态；密码哈希原样迁移，不解密、不重哈希 |
| `verification_codes` | 17 | 重塑 | `verification_challenges` | 邮箱/手机统一受控目标类型，验证码和验证令牌只存哈希；旧有效记录按原过期时间迁移，已过期记录归档 |
| `schema_migrations` | 214 | 重塑 | `schema_migrations`、`data_migration_runs`、`data_migration_checkpoints` | 旧 214 个 ID 全量归档；新表记录版本、名称、校验和、执行 ID、耗时和应用版本，不能伪造旧迁移正文校验和 |
| `credential_migration_runs` | 0 | 合并 | `data_migration_runs` | 作为凭据迁移任务类型；保留状态与统计字段，不单独维护一套运行表 |
| `system_config` | 75 | 重塑 | `system_settings` | 使用 `namespace + key` 唯一键、值类型、JSON 校验、revision 和敏感级别；TDK、主域名和三个子域配置均进入明确命名空间 |
| `system_prompts` | 1 | 合并 | `strategy_versions` 或明确的系统文案设置 | 先核对唯一记录用途；当前运行时代码无引用且旧迁移曾删除，但 `initDB` 又会重建，禁止直接丢弃该记录 |
| `ai_feature_flags` | 1 | 保留 | `ai_feature_flags` | scope、用户和功能键改为行式或受控 JSON；增加 revision，平台与用户覆盖规则唯一化 |
| `user_notices` | 0 | 候选删除 | `notifications` | 当前无运行时引用；空表 DDL 留档，确认旧客户端无流量后退出 |
| `broadcast_messages` | 0 | 候选删除 | `notification_campaigns` | 当前无运行时引用；广播能力由通知活动统一承接 |
| `audit_logs` | 1,409 | 重塑 | `audit_events` | 追加写；`user_id` 可因用户墓碑为空，保留当时邮箱/昵称脱敏快照；target ID 改为字符串以支持 UUID/BIGINT |

新增且没有直接源表的认证表：`auth_sessions`、`auth_authorization_codes`。它们只保存哈希和 UTC 时间，结构以[单点登录与统一认证架构方案](./single-sign-on-authentication-architecture.md)为准。

## 4. 内容、课程、社区、文件与反馈（15 张）

| 源表 | 行数 | 动作 | 目标 | 转换与对账重点 |
| --- | ---: | --- | --- | --- |
| `courses` | 12 | 重塑 | `courses`、`course_lessons` | 现有 `episode_id` 不能继续同时代表课程与课时；保留公开 ID、分类、访问等级和排序，媒体字段转为课时资源引用 |
| `course_resources` | 1 | 保留 | `course_resources` | 绑定明确 `course_lesson_id` 和 `stored_file_id`；资源类型受控，正文与外链分离 |
| `quiz_questions` | 0 | 重塑 | `quiz_questions`、`quiz_options` | options 文本解析为选项行；无法解析时整行进入迁移错误表，不猜答案 |
| `progress` | 5 | 重塑 | `course_progress` | 唯一键 `user_id + course_lesson_id`；时长转整数毫秒，完成和测验状态分离 |
| `video_streams` | 0 | 合并 | `course_resources`、`stored_files` | 视频源、质量和访问级别并入资源模型；空表仍需验证发布脚本无依赖 |
| `stored_files` | 0 | 保留 | `stored_files` | 对象键、SHA-256、大小、可见性和逻辑删除保留；owner 多态引用继续软约束但必须校验 owner_type |
| `storage_upload_sessions` | 0 | 保留 | `storage_upload_sessions` | 短时会话与最终文件分离；过期清理由 Worker 完成 |
| `posts` | 6 | 重塑 | `posts`、`post_tag_links`、`post_asset_links` | tags、images、asset_ids 文本拆成关系表；计数列作为投影，不作为事实来源 |
| `post_replies` | 2 | 重塑 | `post_replies`、`post_asset_links` | 引用回复加自关联；HTML、纯文本和原文只确定一个权威正文，其余为可重建投影 |
| `post_tags` | 2 | 保留 | `post_tags` | slug 唯一；count 改为投影或查询汇总，对账真实关联数 |
| `post_assets` | 3 | 合并 | `stored_files`、`post_asset_links` | 旧 asset_id 保留为 legacy key；文件元数据不再重复存两份 |
| `post_reports` | 0 | 保留 | `post_reports` | post/reply 二选一 CHECK；状态、处理人和处理时间补齐 |
| `comments` | 0 | 重塑 | `course_comments` | `episode_id` 显式改课时 ID；parent 外键和用户墓碑策略明确 |
| `comment_likes` | 0 | 保留 | `course_comment_likes` | 唯一键 `user_id + comment_id`，删除评论可级联纯从属点赞 |
| `feedback` | 0 | 保留 | `feedback` | 联系方式按敏感字段处理；补状态、处理人和处理时间，不再只存提交内容 |

## 5. 商业、支付、会员、返佣与通知（11 张）

| 源表 | 行数 | 动作 | 目标 | 转换与对账重点 |
| --- | ---: | --- | --- | --- |
| `orders` | 12 | 重塑 | `payment_orders` | 保留 `id/order_no/order_id` legacy key；产品、周期、应付金额、金额差、状态和 UTC 时间规范化，禁止与交易订单混名 |
| `crypto_watch_list` | 8 | 重塑 | `payment_matches`、`payment_transactions` | TRC20 共享地址、期望金额和创建时间窗匹配语义不变；链上 tx_hash 唯一，确认数作为投影 |
| `payment_side_effects` | 4 | 重塑 | 支付后投递历史；未完成义务经核验进入 `outbox_events` | 原表仅记录通知/佣金处理，不直接生成 `membership_activations`；completed 历史不重新入队或发放权益，见阶段 83 |
| `wallet_keys` | 4 | 重塑 | `payment_wallet_addresses` | 不迁移或记录私钥明文；只保留链、索引、地址和密钥托管引用，字段名不得暗示数据库保存私钥 |
| `referral_rules` | 4 | 保留 | `referral_rules` | 唯一键 `plan + period`，rate_bps 范围 CHECK，变更带 revision 和审计 |
| `referrals` | 0 | 重塑 | `referral_attributions`、`referral_commissions` | 邀请归因与订单佣金事实拆分；订单和用户强关系，金额使用 DECIMAL |
| `membership_expiry_notifications` | 100 | 合并 | `notification_deliveries` | 作为 `membership_expiry` 活动/投递类型迁移；成功、已读、失败、跳过、过期语义不丢失 |
| `notification_campaigns` | 0 | 保留 | `notification_campaigns` | 收件范围冻结，幂等键唯一；活动摘要不保存完整用户集合，目标进入投递表 |
| `notification_deliveries` | 0 | 保留 | `notification_deliveries` | 唯一键 `campaign + user + channel`；重试只适用于有效窗口内失败投递 |
| `notification_idempotency_keys` | 0 | 合并 | `idempotency_records` | 通用 HTTP 幂等记录按作用域统一；响应载荷设保留期，不长期膨胀 |
| `notifications` | 15 | 重塑 | `notifications` | 4 条引用已不存在用户的记录保留为墓碑收件人并单独对账；广播不得再用伪用户 ID |

新增目标表：

- `plans`、`products`：从受控系统配置和现有订单字段生成；首版只承载已存在的会员及 Bridge 并发连接额度产品，不建设复杂商品中心。
- `memberships`、`membership_events`：当前态以 `users.plan*` 原值和经确认的时间/权益规则承接；历史事件必须有独立开通、续费、赠送或撤销证据。`payment_side_effects.completed` 只证明旧投递处理状态，不用于补造会员历史事件，见阶段 97。
- `entitlement_grants`、`user_connection_capacities`：保存默认/购买/赠送/撤销事实及 MySQL 上限投影；当前 WebSocket 占用不写成永久账户槽位。
- `outbox_events`：支付、会员、通知等可靠异步副作用；交易执行使用自己的状态机，不把 Bridge 发单简化成普通 outbox 自动重试。

## 6. Bridge、终端、交易账户与行情读模型（21 张）

| 源表 | 行数 | 动作 | 目标 | 转换与对账重点 |
| --- | ---: | --- | --- | --- |
| `bridge_device_pairings` | 1 | 保留 | `bridge_device_pairings` | 配对码仅存哈希，状态和过期时间改 UTC；消费单次事务化 |
| `bridge_refresh_sessions` | 17 | 保留 | `bridge_refresh_sessions` | refresh token 只存哈希；增加 credential_version、installation/profile 绑定、generation、V3 source session 和迁移指纹。一个 V3 source session 只允许映射一个 V4 设备 session；同绑定重试轮换同一行，支持单设备、全部设备撤销和轮换世代 |
| `bridge_update_events` | 0 | 保留 | `bridge_update_events` | installation/release/version 保持软引用；时间统一 UTC `DATETIME(3)` |
| `bridge_v3_terminal_sessions` | 7 | 拆分 | `terminal_instances`、`terminal_profiles`、`terminal_bindings`、`bridge_connection_sessions` | 去掉 V3 命名；安装实例、可删除档案、账户绑定和每次连接审计分离；每个 profile/Worker/WebSocket 只服务一个账户 |
| `bridge_v3_account_latest` | 6 | 重塑 | `terminal_account_snapshots` | 显式 `trading_account_id`、连接世代和 revision；只保存恢复所需最近投影，不作为经纪商权威事实 |
| `bridge_v3_positions_latest` | 3 | 重塑 | `terminal_position_snapshots` | 以交易账户、position/ticket 唯一；payload 中可搜索字段提升为列，大载荷独立保存 |
| `bridge_v3_orders_latest` | 2 | 重塑 | `terminal_order_snapshots` | 持仓、挂单和历史订单类型明确；ticket 唯一范围包含交易账户 |
| `bridge_v3_deals` | 0 | 重塑 | `terminal_history_deals_v4`、`account_trade_records_v4`、`account_trade_record_deals_v4` | Stage 12S 旁路建立结构，Stage 12T 接入 Bridge 精确分页与权威投影；交易账户 + deal_ticket 唯一，金额/价格/手数用 DECIMAL，原始证据留服务端且不下发浏览器；旧数据仍须用 checkpoint 独立回填并逐项对账 |
| `bridge_v3_stream_revisions` | 243 | 重塑 | `terminal_stream_revisions` | 账户、连接世代、stream 唯一；浏览器和 Bridge revision 不混用 |
| `bridge_v3_command_ledger` | 3,525 | 重塑 | `bridge_commands_v4`、`bridge_command_payloads_v4`、`bridge_command_results_v4`、`bridge_command_events_v4`、`bridge_trade_state_snapshots_v4` | Stage 12F 先旁路建立服务端 V4 命令账本；command_id、幂等哈希、精确 route、deadline、可信 expected-state 快照和每份回执证据分层保存。旧账本暂不自动回填；任何可能送达 MT 的未知结果保持 `uncertain`，只能对账、不得重放 |
| `bridge_v3_command_events` | 10,506 | 重塑 | `bridge_command_events` | 追加写并外键到命令；事件 payload 继续保留，按 command_id + id 游标读取 |
| `trading_accounts` | 4 | 重塑 | `trading_accounts` | 新唯一键 `platform + normalized broker_server + login_account`；不再把 user_id 作为实体身份；现有重复身份先合并为一个实体，不删除历史引用 |
| `mt5_account_bindings` | 3 | 合并 | `trading_account_ownerships`、`terminal_bindings` | 去除 MT5 专属命名并支持 MT4；current binding 作为当前归属投影，first/last connected 保留 |
| `mt5_account_ownership_history` | 274 | 重塑 | `trading_account_ownerships` | 支持 MT4/MT5；迁移完整归属区间、authority 和终止原因，当前 trade ownership 由生成唯一键约束 |
| `mt5_account_performance_daily` | 21 | 重塑 | `trading_account_performance_daily` | 绑定稳定账户而非旧归属行；业务日继续按终端时区，所有发生时间另存 UTC |
| `mt5_account_performance_totals` | 3 | 重塑 | `trading_account_performance_totals` | 由 daily 可重建但保留为投影；金额和计数逐账户对账 |
| `mt5_account_performance_sync_state` | 3 | 重塑 | `trading_account_sync_states` | 数据游标、终端时区证据、失败原因和成功时间分开，支持 MT4/MT5 |
| `user_bridge_settings` | 4 | 拆分 | `bridge_user_controls`、`strategy_subscriptions` | 连接暂停仍为用户级；自动分析、交易发送和运行时段必须下沉到具体账户订阅，观摩模式独立 |
| `ai_observer_channels` | 2 | 保留 | `observer_channels` | 频道是稳定用户可见入口；默认来源、状态和授权策略带 revision |
| `ai_observer_sources` | 2 | 重塑 | `observer_sources` | 显式引用专用系统用户、terminal profile 和 trading account，不通过账号字符串路由 |
| `ai_observer_channel_assignments` | 0 | 保留 | `observer_channel_assignments` | 用户/套餐授权作用域受控；唯一键防重复授权，管理员来源额度与普通用户额度分开 |

新增目标表和实时状态：

- `terminal_clock_calibrations`：保存终端实例、账户、经纪商服务器、UTC、终端时间、offset、证据状态与来源。
- `bridge_connection_sessions` 只做连接审计；实时 Gateway 用 `bridge_connection_leases`（Redis/等价原子 TTL 存储）统计当前账户 WebSocket，不以历史会话行判断在线。
- Bridge 可以新增、停止、删除和更换任意数量的本地 profile；只有成功取得 lease 的当前在线账户连接占额度，断开 A 后可直接连接 B。
- 同一稳定交易账户同一时刻最多一个具备交易权限的 route；重连接管递增 connection epoch 且不能短暂双计额度。

## 7. 策略、订阅、用户运行偏好与市场数据（12 张）

| 源表 | 行数 | 动作 | 目标 | 转换与对账重点 |
| --- | ---: | --- | --- | --- |
| `auto_prompt_types` | 3 | 拆分 | `strategies`、`strategy_versions` | 策略身份与不可变版本分离；平台/私有 scope、owner、正文、市场数据计划和执行政策完整迁移，旧 ID 保留为 legacy key |
| `strategy_subscriptions` | 5 | 重塑 | `strategy_subscriptions`、`subscription_schedules` | 唯一作用域为 `user_id + trading_account_id + strategy_id` 的当前有效订阅；移除 `active_execution_user_key` 用户级单例；自动分析、交易发送、品种、止盈和时区按账户隔离 |
| `auto_scheduler` | 18 | 合并 | `strategy_subscriptions`、`subscription_runtime_states` | 用户级调度配置迁入具体账户订阅；仅在账户和策略唯一可判定时自动映射，否则形成迁移待确认项，不擅自选择账户 |
| `global_auto_config` | 1 | 合并 | `strategies`、`strategy_versions`、`system_settings` | 仅迁移仍有效的平台默认配置；与已生成策略版本内容按哈希去重，不能再次创建重复默认策略 |
| `ai_inference_preferences` | 2 | 合并 | `strategy_subscriptions`、`user_model_defaults` | prompt 不再作为会话级第二策略来源；交易开关和风险字段迁到账户订阅，模型选择迁用户默认 |
| `ai_configs` | 3 | 合并 | `ai_model_profiles`、`user_model_defaults`、`strategy_subscriptions` | API 凭据解密后重新加密到唯一模型配置；system_prompt/auto interval 不再与策略正文重复；旧 session_id 不成为业务主键 |
| `close_config` | 4 | 合并 | `user_position_management_settings`、`user_model_defaults` | 旧用户级平仓模型与规则映射到持仓管理设置；DOUBLE 价格/比例改 DECIMAL，旧密钥迁模型配置 |
| `history_range_preferences` | 0 | 保留 | `account_history_preferences` | 唯一键 `user + trading_account + scope`；起始日期按终端业务日，不把它当 UTC 时间戳 |
| `market_data_sources` | 3 | 重塑 | `market_data_sources` | 显式关联 terminal/profile/account；broker server/login 只作快照，不作权限依据；clock 状态由校准表投影 |
| `market_candles` | 35,725 | 保留 | `market_candles` | 唯一键 `source + standard_symbol + timeframe + open_time_utc`；价格 DECIMAL 保留，形成中 K 线由 revision 更新，已收盘 K 线不可变 |
| `market_clock_samples` | 6,183 | 重塑 | `terminal_clock_calibrations` | 样本并入终端时钟证据；保留 raw terminal tick、normalized UTC、offset、残差和状态 |
| `chan_structure_anchors` | 6 | 保留 | `chan_structure_anchors` | 明确为可重建算法投影；source、品种、周期、算法版本唯一，不能影响交易事实迁移 |

订阅迁移的关键规则：

- 源库 5 条活动订阅均已有交易账户，当前未发现 `user/account/strategy` 重复组或孤儿。
- 旧 `auto_scheduler` 为 `user_id` 唯一，不能直接复制成新版账户级订阅；迁移必须对每个用户生成“唯一可判定、无可判定、多账户冲突”报告。
- 订阅运行时当前状态是可重建投影，配置和时间表才是权威事实；账户离线不删除订阅，恢复后从下一个正常时间槽继续，禁止补跑离线历史信号。

## 8. 模型配置、任务、配额与质量验证（15 张）

| 源表 | 行数 | 动作 | 目标 | 转换与对账重点 |
| --- | ---: | --- | --- | --- |
| `ai_model_profiles` | 6 | 保留 | `ai_model_profiles` | 平台/个人模型同表；默认模型唯一键保留，凭据重新按当前密钥版本加密；普通用户不可编辑平台模型 |
| `ai_model_provider_capabilities` | 5 | 保留 | `ai_model_provider_capabilities` | 继续一对一；验证状态必须代表真实探测，未知不能显示成等待验证故障 |
| `ai_model_provider_incidents` | 3 | 保留 | `ai_model_provider_incidents` | 作为熔断当前态与历史时间；endpoint 只存 host，不记录密钥和完整请求 |
| `ai_model_purpose_defaults` | 0 | 合并 | `user_model_defaults` | 与旧 `user_model_defaults` 合并为每用户一个默认模型；用途路由仅在用户明确配置后覆盖默认 |
| `user_model_defaults` | 2 | 重塑 | `user_model_defaults` | 默认只有一个当前生效模型；用途覆盖采用可空明细，平台共享和个人模型使用同一外键 |
| `platform_model_usage_policy` | 1 | 保留 | `platform_model_usage_policy` | 平台共享能力、套餐和日额度使用原生 JSON/CHECK；revision/CAS 更新 |
| `ai_model_tasks` | 9,317 | 保留 | `ai_model_tasks` | task_id、领域关联、冻结模型上下文、状态和 fencing token 保留；超大 frozen_context 可拆 payload |
| `ai_model_task_attempts` | 9,179 | 保留 | `ai_model_task_attempts` | 外键 task；attempt_no 唯一，供应商请求 ID 软引用，字节/token/耗时完整对账 |
| `ai_model_task_events` | 121,821 | 保留 | `ai_model_task_events` | 追加写；按 task_id + id 游标；payload 大小设上限和保留期但迁移不裁剪历史 |
| `ai_model_usage_logs` | 12,139 | 保留 | `ai_model_usage_logs` | 保留请求/响应字节、各类 token、耗时和 provider request ID；不根据旧 token_count 猜细分 token |
| `ai_model_capacity_policies` | 1 | 保留 | `ai_model_capacity_policies` | 数据库保存并发政策；每模型与默认政策唯一，revision/CAS 更新 |
| `ai_model_capacity_waiters` | 9,165 | 归档 | 任务事件归档 + 实时队列 | waiter 是瞬时协调状态，不进入目标活动 MySQL；全量归档并把最终状态摘要关联 task，实时等待队列交给隔离队列/Redis |
| `ai_model_capacity_leases` | 9,165 | 归档 | 任务事件归档 + 实时 lease | lease 是瞬时协调状态；全量归档并核对 task/模型/用户，目标实时 lease 设 TTL，不让历史行参与并发判断 |
| `ai_model_compare_jobs` | 0 | 保留 | `ai_model_compare_jobs` | 后台异步任务；幂等键、取消、进度和模型任务关联补齐 |
| `ai_model_compare_checkpoints` | 0 | 保留 | `ai_model_compare_checkpoints` | job + unit 唯一，结果 payload 可拆载荷表；空表不代表删除模型比较功能 |

## 9. AI 分析、信号和推理证据（7 张）

| 源表 | 行数 | 动作 | 目标 | 转换与对账重点 |
| --- | ---: | --- | --- | --- |
| `ai_manual_analysis_jobs` | 0 | 保留 | `ai_manual_analysis_jobs` | 用户手动 3 分钟节流、单次执行、策略版本和模型任务引用均保留；节流由服务端原子记录保障 |
| `ai_market_benchmark_sets` | 0 | 保留 | `ai_market_benchmark_sets` | 模型/策略质量验证数据集；状态、版本和 fingerprint 唯一 |
| `ai_market_benchmark_cases` | 0 | 保留 | `ai_market_benchmark_cases` | 外键 set；时间 UTC，指标与标签使用原生 JSON；空表不影响功能保留 |
| `ai_signals` | 1,764 | 拆分 | `ai_signals`、`ai_signal_payloads` | 主表只保留列表/实时摘要、方向、动作、置信度和关联 ID；analysis/reasoning/decision/market_data 进入载荷表并记录 encoding/hash/bytes |
| `inference_snapshots` | 789 | 拆分 | `inference_snapshots`、`inference_snapshot_payloads` | 快照元数据、策略/模型/hash 留主表；system/user prompt、K线、市场和运行时快照分载荷，原字节与 SHA-256 可验证 |
| `ai_trade_theses` | 444 | 保留 | `ai_trade_theses` | thesis 是信号到持仓管理的稳定论点；策略、版本、方向、失效条件和内容哈希明确，文本大载荷可拆 |
| `auto_signal_deliveries` | 1,442 | 重塑 | `signal_deliveries` | 显式 `subscription_id + trading_account_id`；交付、执行 intent 和终端结果分层，不再同时维护多个互相冲突的 executed/status 字段 |

已确认的迁移异常：

- `ai_signals` 有 1,015 条记录使用 `user_id=0` 表示平台分析，不是真实 `users` 孤儿。目标改为 `owner_user_id NULL + owner_scope='platform'`，不能创建 ID 0 伪用户，也不能删除这些信号。
- 分析记录仍按系统账号归类；交易账户只记录信号所用交易上下文或后续交付目标，不能按 MT 登录账号重分类历史分析。

## 10. 统一交易执行、分发和终端结果（15 张）

| 源表 | 行数 | 动作 | 目标 | 转换与对账重点 |
| --- | ---: | --- | --- | --- |
| `order_intents` | 412 | 重塑 | `operations`、`execution_intents`、`execution_intent_payloads` | Stage 12E 先旁路建新表，不改旧记录；保留旧 intent ID/幂等键，公共操作与账户级意图分离，request/risk/bridge/result 大载荷拆表；状态映射遵循统一状态机 |
| `risk_reservations` | 362 | 重塑 | `risk_reservations_v4`、`risk_reservation_events_v4` | Stage 12E 使用 V4 后缀避免旧同名结构被静默复用；活动/提交/释放/过期显式建模，可能已发送的旧预留必须结合 intent/Bridge 证据迁移，不得直接释放或重放 |
| `admin_strategy_trade_dispatches` | 7 | 重塑 | `operations`、`execution_distributions` | 冻结策略版本、目标集合、预览 hash 和统计保留；父状态允许 `partially_succeeded` |
| `admin_strategy_trade_targets` | 22 | 重塑 | `execution_distribution_targets`、`execution_intents` | 每个账户一个不可变目标和独立 intent；账户/订阅/风险/归属快照进入 payload，目标不得在重试时重新发现 |
| `admin_strategy_pending_cancel_jobs` | 3 | 合并 | `operations`、`execution_batches` | 操作类型 `distributed_pending_cancel`；来源 dispatch/signal 精确关联 |
| `admin_strategy_pending_cancel_targets` | 9 | 合并 | `operation_targets`、`execution_intents` | 只能取消原分发产生且 ticket 可精确归因的挂单；未知结果不自动重发 |
| `admin_position_close_jobs` | 2 | 合并 | `operations`、`execution_batches` | 操作类型 `distributed_position_close`；来源 outcome/ticket 固定，汇总计数由目标态投影 |
| `admin_position_close_targets` | 4 | 合并 | `operation_targets`、`execution_intents` | 分发平仓按原 distribution/outcome/ticket 归因，禁止按品种模糊平仓 |
| `admin_position_protection_jobs` | 2 | 合并 | `operations`、`execution_batches` | 操作类型 `distributed_protection_modify`；预览 hash 与请求保护价保留 |
| `admin_position_protection_targets` | 3 | 合并 | `operation_targets`、`execution_intents` | 每个 position/ticket 独立修改，部分成功可表达，目标快照不可被后续行情覆盖 |
| `pending_orders` | 0 | 合并 | `terminal_order_snapshots`、`trade_outcomes` | 不再维护第三套挂单真相；旧行若出现需按 ticket/账户归并，无法归因则进入迁移异常表 |
| `close_signal_tickets` | 30 | 合并 | `execution_intents`、`trade_outcomes` | 旧 close_signal 与 original_ticket 关系迁移为来源引用；价格 DOUBLE 按原字符串/品种精度核对 |
| `signal_outcomes` | 334 | 重塑 | `trade_outcomes`、`trade_outcome_payloads`、`account_trade_attributions_v4` | 保留 signal/delivery/intent/account/ticket 全链路；只有票据、订单、成交或分发目标精确匹配后才建立 Stage 12S 归因，不把命令成功当作终端成交 |
| `signal_outcome_deals` | 427 | 重塑 | `terminal_history_deals_v4`、`account_trade_record_deals_v4` | 外键 outcome/account；deal_ticket 在交易账户范围唯一；利润、佣金、swap、fee 与终端事实逐笔对账，冲突保持显式状态；Stage 12T 只提供离线对账演练器，没有读取或改写源库 |
| `trade_audit_logs` | 9,660 | 重塑 | `trade_audit_events`（仅旧证据迁移/归档）+ V4 权威领域记录 | 旧行必须全量保留并统一 operation/intent/command/correlation ID；request/result 大字段进入受控证据载荷，列表不读取正文。Stage 12U 的新 V4 页面直接读取权威领域记录，不再为新事件复制一份万能日志；旧 9,660 行的回填和对账仍待迁移阶段执行 |

目标执行关系固定为：

```text
operations
  -> execution_distributions / execution_batches
    -> operation_targets
      -> execution_intents
        -> risk_decisions / risk_reservations
          -> bridge_commands / bridge_command_events
            -> trade_outcomes / trade_outcome_deals
```

- 源状态必须通过显式映射表迁移，禁止直接复制任意字符串。无法证明终端未执行的旧 `failed/timeout` 必须标为 `uncertain` 并进入对账队列。
- 批量操作的父状态由子目标推导；父行不保存会与子状态分叉的第二套手工状态。
- 交易执行细则统一执行[交易执行统一状态机与数据一致性方案](./trade-execution-state-machine.md)。

## 11. 风控政策、决策和账户状态（8 张）

`risk_reservations` 的唯一迁移条目见第 10 节，风控域引用其结果，不重复回填。

迁移期间，旧库已经存在且字段不同的 `risk_policy_sets`、`risk_policy_versions`、`risk_policy_change_items`、`risk_decisions` 必须保留给旧程序读取；V4 先落到对应 `_v4` 旁路表。只有回填、拒绝清单、行数/哈希双读对账及流量切换全部通过后，才允许在最终清理迁移中归档旧表并把 V4 表规范化为下表目标名称。

| 源表 | 行数 | 动作 | 目标 | 转换与对账重点 |
| --- | ---: | --- | --- | --- |
| `risk_policy_sets` | 3 | 保留 | `risk_policy_sets` | scope/owner/account 明确；active_version 外键，修改使用 revision/CAS |
| `risk_policy_versions` | 10 | 保留 | `risk_policy_versions` | 不可变版本；config JSON 校验合同，policy_set + version_no 唯一 |
| `risk_policy_change_items` | 60 | 保留 | `risk_policy_change_items` | 保留旧值、新值、变更级别、申请人、生效/取消 UTC；状态受控 |
| `risk_profiles` | 0 | 合并 | `risk_policy_sets`、`risk_policy_versions` | 旧 profile 配置迁版本模型；空表仍需先移除服务引用 |
| `risk_account_state` | 4 | 重塑 | `account_risk_states`、`risk_state_events` | 当前态按 trading_account 唯一；kill switch、停机原因和手工重置变更写不可变事件 |
| `risk_decisions` | 395 | 保留 | `risk_decisions` | intent 一对一；原始/批准订单和规则结果拆 payload 可选，拒绝码结构化 |
| `risk_rule_rollouts` | 19 | 保留 | `risk_rule_rollouts` | 规则代码唯一；模式、强制执行和修改审计保留，revision/CAS 更新 |
| `global_risk_control` | 1 | 重塑 | `global_risk_controls`、`risk_state_events` | 全局 kill switch 当前态与每次变化事件分离；所有交易入口读取同一权威状态 |

## 12. AI 持仓管理、保护规则与运行控制（12 张）

| 源表 | 行数 | 动作 | 目标 | 转换与对账重点 |
| --- | ---: | --- | --- | --- |
| `ai_position_management_tasks` | 419 | 保留 | `position_management_tasks` | 账户、outcome、策略、bar、证据 hash、候选动作和 fencing token 保留；大 JSON 拆 payload |
| `ai_position_management_events` | 1,235 | 保留 | `position_management_events` | 追加写并外键 task；from/to 状态和 actor 结构化 |
| `ai_position_management_evaluations` | 4,415 | 保留 | `position_management_evaluations` | 模型判断与确定性验证结果分开；decision signal、outcome 和行情 hash 保留 |
| `ai_position_management_commands` | 85 | 合并 | `execution_intents`、`bridge_commands` | 不再另建发单通道；task/sequence 作为来源，expected state 保留，命令结果由统一 ledger 权威化 |
| `position_guard_profiles` | 1 | 保留 | `position_guard_profiles` | 用户/平台 scope 明确；当前版本和状态可查询，配置正文只在版本表 |
| `position_guard_profile_versions` | 1 | 保留 | `position_guard_profile_versions` | 不可变 config hash，profile + version 唯一，创建时间 UTC |
| `position_guard_position_states` | 6 | 重塑 | `position_guard_position_states`、`position_guard_events` | outcome 一对一当前态；pivot/terminal 快照大载荷拆分，状态变化追加事件 |
| `user_position_guard_settings` | 1 | 重塑 | `account_position_guard_settings` | 从 user 级迁至具体 trading account；无唯一账户时形成待确认项，不自动扩散到多个账户 |
| `user_position_management_settings` | 0 | 重塑 | `account_position_management_settings` | 同上；策略/账户级覆盖层次明确，revision/CAS 更新 |
| `position_management_account_rollouts` | 0 | 保留 | `position_management_account_rollouts` | 功能灰度按账户；空表仍代表运行能力，不和用户配置混合 |
| `global_position_guard_control` | 1 | 重塑 | `global_runtime_controls` | 与全局持仓管理开关采用同一受控表，不合并具体风控政策 |
| `global_position_management_control` | 1 | 重塑 | `global_runtime_controls` | maximum mode、冻结自动操作和紧急开关作为独立键；revision、原因和审计必须保留 |

## 13. 交易记录、复盘、经验与策略记忆（39 张）

| 源表 | 行数 | 动作 | 目标 | 转换与对账重点 |
| --- | ---: | --- | --- | --- |
| `trades` | 2 | 重塑 | `manual_trade_records` | 这是用户手填交易日志而非 MT 成交；字段转精确类型并保留原文本，不能并入 terminal deals 后丢失笔记/截图 |
| `trade_review_cases` | 155 | 合并 | `review_cases_v4`、`review_case_sources_v4`、`review_evidence_payloads_v4` | 系统交易复盘统一进入 case/source/evidence 模型；约 75.67 MiB evidence 拆载荷，保留 legacy id、outcome 关联和原 hash |
| `trade_review_jobs` | 0 | 保留 | `trade_review_jobs` | 异步 job；幂等键、lease、模型配置和错误码保留 |
| `trade_review_versions` | 0 | 保留 | `trade_review_versions` | case + version 唯一；人工确认版本与模型草稿都不可变保留 |
| `manual_trade_review_cases` | 3 | 合并 | `review_cases_v4`、`review_case_sources_v4`、`review_evidence_payloads_v4` | 手动交易复盘以 kind 区分但复用统一状态机；选择结果、版本和证据哈希完整保留 |
| `manual_trade_review_sources` | 3 | 保留 | `manual_trade_review_sources` | 稳定 source hash 去重；账户/ticket/position 是证据引用，不用于改变用户归属 |
| `manual_trade_review_jobs` | 3 | 保留 | `manual_trade_review_jobs` | 异步 stage 编排、lease、next attempt 和模型 task 保留 |
| `manual_trade_review_stage_runs` | 18 | 保留 | `manual_trade_review_stage_runs` | case/job/generation/stage 唯一；冻结输入输出 hash，可将正文拆 payload |
| `manual_trade_review_versions` | 1 | 保留 | `manual_trade_review_versions` | 不可变版本；人工确认后才允许形成策略记忆更新 |
| `manual_trade_review_counterfactual_points` | 27 | 保留 | `manual_trade_review_counterfactual_points` | case/stage/时间点和市场证据明确；价格 DECIMAL，状态受控 |
| `manual_trade_review_aggregate_cases` | 0 | 保留 | `manual_trade_review_aggregate_cases` | 手动交易跨案例总结；与日/月 period review 不混用，空表不删能力 |
| `manual_trade_review_aggregate_sources` | 0 | 保留 | `manual_trade_review_aggregate_sources` | aggregate case + source case 唯一；只存引用和 hash |
| `manual_trade_review_aggregate_versions` | 0 | 保留 | `manual_trade_review_aggregate_versions` | 不可变版本；人工批准字段明确 |
| `period_review_cases` | 25 | 合并 | `review_cases_v4`、`review_case_sources_v4`、`review_evidence_payloads_v4` | 日/月类型、系统用户、账户/策略版本、订阅 revision 与终端业务时段冻结在统一 case；19.60 MiB evidence 拆载荷 |
| `period_review_sources` | 176 | 保留 | `period_review_sources` | outcome/trade review/子 period 来源三选一 CHECK；source hash 去重 |
| `period_review_versions` | 33 | 保留 | `period_review_versions` | case + version 唯一；current/approved 外键，内容 hash 保留 |
| `period_review_jobs` | 25 | 拆分 | `period_review_jobs`、`review_job_payloads` | job 当前态留主表；记忆库和策略文本快照拆 payload；模型 task 精确关联 |
| `period_review_job_events` | 7,208 | 保留 | `period_review_job_events` | 追加写；metadata 使用原生 JSON，按 job + id 游标读取 |
| `period_review_derivation_jobs` | 12 | 保留 | `period_review_derivation_jobs` | 经验/记忆派生异步任务；目标类型受控，幂等和重试边界明确 |
| `period_review_monthly_checkpoints` | 8 | 拆分 | `period_review_monthly_checkpoints`、`review_checkpoint_payloads` | checkpoint 元数据和 hash 留主表，sources/content 大载荷拆分；可断点继续 |
| `period_review_user_states` | 33 | 保留 | `period_review_user_states` | case + user 唯一；仅是已读投影，不参与复盘事实状态 |
| `strategy_memory_libraries` | 2 | 拆分 | `strategy_memory_libraries_v4`、`strategy_memory_library_revisions_v4` | 每条策略唯一库；library 只保留当前版本指针、容量和状态，分析/交易策略自然分离 |
| `strategy_memory_library_revisions` | 20 | 重塑 | `strategy_memory_library_revisions_v4` | strategy + version 唯一；文本、结构化内容块、hash、来源和 actor 保留，合并与撤销都追加新版本 |
| `strategy_memory_pending_updates` | 10 | 重塑 | `strategy_memory_pending_updates_v4` | 人工确认前保存精确差异/冲突；长期候选至少三个独立已确认案例后才开放额外确认，合并后仍可生成 revoke revision |
| `strategy_memory_compression_jobs` | 0 | 保留 | `strategy_memory_compression_jobs` | 异步压缩；输入 hash、目标字符数、结果 revision 和验证状态保留 |
| `strategy_memory_injection_logs` | 5,417 | 保留 | `strategy_memory_injection_logs` | 记录实际注入的 library version/hash/token，不保存或广播不必要完整正文 |
| `strategy_memory_consistency_jobs` | 48 | 拆分 | `strategy_memory_consistency_jobs`、`memory_job_payloads` | 任务元数据留主表，策略/记忆快照和 result JSON 拆载荷；模型 task 精确关联 |
| `strategy_memory_conflicts` | 2 | 保留 | `strategy_memory_conflicts` | conflict identity、状态、检测次数和解决审计保留；一个 canonical key 唯一 |
| `strategy_memory_conflict_bindings` | 1 | 保留 | `strategy_memory_conflict_bindings` | conflict 与具体策略/记忆版本证据绑定；过期只标记 superseded，不删除 |
| `strategy_memory_conflict_occurrences` | 2 | 保留 | `strategy_memory_conflict_occurrences` | 每次观测追加写；绑定、period review 和证据 hash 保留 |
| `platform_strategy_experience_items` | 2 | 合并 | `strategy_memory_pending_updates`、`strategy_memory_library_revisions` | 平台策略经验进入同一策略记忆库；发布/撤销历史映射 revision，禁止第二套平台记忆真相 |
| `platform_strategy_experience_logs` | 6,093 | 合并 | `strategy_memory_injection_logs` | 保留 signal/snapshot/选择项/token 和 context；按平台策略标记来源 |
| `platform_strategy_experience_policies` | 2 | 合并 | `strategy_memory_libraries` | max items/token budget/mode 转为库策略字段或受控设置；不再维护重复 policy 表 |
| `experience_long_term_memories` | 0 | 合并 | `strategy_memory_library_revisions` | 旧用户级长期记忆只有在能明确映射策略时才迁入；否则归档为待归属，禁止复制到所有策略 |
| `experience_memory_items` | 0 | 合并 | `strategy_memory_pending_updates` | 同上；空表代码能力由策略记忆替代后再退出 |
| `experience_memory_summaries` | 0 | 合并 | `strategy_memory_library_revisions` | 同上；摘要不能成为并行权威内容 |
| `memory_compression_jobs` | 0 | 合并 | `strategy_memory_compression_jobs` | 只有明确 strategy_id 的旧任务才映射；不可归属任务归档 |
| `memory_injection_logs` | 0 | 合并 | `strategy_memory_injection_logs` | 旧用户级检索日志按 strategy_id 映射；没有策略的历史保留归档 |
| `user_memory_settings` | 0 | 合并 | `strategy_memory_libraries`、`user_preferences` | 用户体验偏好与策略记忆政策分开；不能用用户总开关覆盖所有账户/策略事实 |

复盘与记忆的权威边界：

- `case` 表描述对象和流程状态，`version` 表保存不可变结果，`payload` 表保存大型证据，`job/event` 表只描述异步执行。
- 模型生成结果只有在人工确认后才能形成 `strategy_memory_pending_updates`，随后以新 revision 合入对应策略唯一记忆库。
- 单个复盘不能直接形成长期记忆；同一稳定 `proposal_key` 至少需要三个不同已确认 case，再由用户额外确认。撤销不删除旧版本，而是移除对应结构化内容块并追加 `revoke` revision。
- 当前 6,093 条平台经验注入日志与 5,417 条策略记忆注入日志必须迁入同一查询模型但保留来源类型，不能简单去重相加。

## 14. 165 张表覆盖校验

本矩阵按源表名逐一列出 165 张表，不允许重复、不允许遗漏。正式迁移命令启动前必须从 `information_schema.TABLES` 重新生成表清单，并满足：

```text
source_table_count = matrix_unique_source_table_count = 165
missing_source_tables = 0
duplicate_matrix_rows = 0
unknown_matrix_tables = 0
```

若源库在冻结后新增表，迁移必须失败关闭并要求更新矩阵，不能把未知表静默复制或忽略。

## 15. 字段转换规范

### 15.1 主键与旧 ID

- `users.id`、课程/内容 ID、策略旧 ID、信号 ID、订单意图 ID、结果 ID 和复盘 case ID 优先保留原数值，避免历史链接和审计关联断裂。
- 拆分或合并导致目标 ID 无法一一保留时，迁移专用 `migration_legacy_id_map` 记录 `execution_id + source_table + source_id + target_table + target_id + mapping_reason`。
- `migration_legacy_id_map` 只服务迁移与对账，不进入业务 API；回滚窗口结束后转归档，不允许业务代码长期依赖旧表名。
- 新增事件和载荷表使用 `BIGINT UNSIGNED`；外部 `task_id/command_id/session_id` 保持原协议字符串或 UUID，不强行转自增数值。

### 15.2 时间

所有目标时间列使用 UTC `DATETIME(3)`，数据库会话固定 `+00:00`。正式回填前生成逐列 `time_semantics_manifest`，每个源时间列只能标记为以下一种：

| 类型 | 源数据示例 | 转换 |
| --- | --- | --- |
| `utc_epoch_ms` | `*_at_utc_msc`、`*_time_utc_ms` | 按毫秒精确转 UTC `DATETIME(3)`，原毫秒仅在协议/审计确有需要时保留 |
| `utc_datetime` | 已证明用 UTC 写入的 DATETIME | 原墙钟值按 UTC 解释，不偏移 |
| `beijing_wall_clock` | 旧 `beijingNow()` 或 `NOW()` 且连接时区为 `+08:00` | 以 `Asia/Shanghai` 解释后转 UTC，不能依赖服务器系统时区 |
| `terminal_wall_clock` | MT4/MT5 终端服务器时间 | 保留终端时间、可信 offset、校准状态和来源，同时计算对应 UTC；证据不足则阻断相关行迁移 |
| `business_date` | 风控/绩效/复盘日期 | 保留 `DATE`，并绑定计算时使用的 terminal clock calibration，不做减 8 小时 |
| `unknown` | 无法从代码、样本和业务语义证明 | 不转换、不猜测，进入迁移阻断报告 |

禁止按字段名批量对全部 392 个旧 `DATETIME` 减 8 小时。时间对账至少验证空值数、最早/最晚值、毫秒保真、先后顺序和业务日期边界。

### 15.3 金额、价格、手数和百分比

- 支付金额、利润、佣金、swap、fee 和风险金额统一 `DECIMAL(20,8)`；订单价格默认 `DECIMAL(24,10)`，最终精度结合品种 digits。
- 手数统一 `DECIMAL(18,8)`，迁移时验证 volume step；源 `DOUBLE` 同时读取数据库字符串表示，不经 JavaScript 二次浮点运算后再写入。
- 百分比统一明确“百分数还是比例”，例如 1.5% 不允许有的表存 `1.5`、有的表存 `0.015`；每个字段映射写出单位。
- 财务对账按用户、订单状态、链、币种分别比较 `SUM`，不能只比较行数。

### 15.4 状态、布尔和 JSON

- 状态由域内常量和数据库 CHECK 共同约束；迁移提供旧值到新值的穷举映射，出现未知值立即失败。
- 布尔统一 `TINYINT(1) NOT NULL`；旧 NULL 必须按业务规则显式映射，不能统一当 false。
- 可查询字段从 JSON 提升为列；保留 JSON 时使用 MySQL `JSON` 并在回填前验证，编码/压缩的大证据使用 payload 表的 `LONGBLOB/LONGTEXT + encoding + sha256 + byte_size`。
- 任何无法解析的旧 JSON 原文先进入迁移错误记录，不修剪、不替换为空对象。

## 16. 约束与索引设计

### 16.1 强关系外键

目标库优先建立以下强关系，使用 `RESTRICT` 或墓碑，不级联删除业务证据：

- 用户 → profile、membership、payment order、terminal ownership、subscription、signal、operation、review。
- trading account → ownership、binding、subscription、intent、risk state、outcome、performance。
- strategy → version、subscription、signal、snapshot、review、memory library。
- model task → attempt、event、领域 job。
- signal → payload、snapshot、delivery；intent → risk decision/reservation、bridge command、outcome。
- review case → version、source、job、evidence payload；memory library → revision/update/conflict。

外部 MT ticket、provider request ID、release ID、对象存储 owner 多态关系和已脱敏审计快照可以保留软引用，但字段注释必须说明原因。

### 16.2 首批唯一约束

- `trading_accounts(platform, broker_server_key, login_account)`。
- 当前交易归属生成键 `trading_account_ownerships(current_trade_account_key)`。
- `terminal_profiles(installation_id, profile_key)` 和当前 `terminal_bindings(profile_id, ended_at)` 的有效关系。
- `strategy_versions(strategy_id, version_no)`。
- 当前订阅生成键覆盖 `user_id + trading_account_id + strategy_id`，而不是只覆盖 user。
- `subscription_schedules(subscription_id)`。
- `operations(idempotency_scope, idempotency_key)`、`execution_intents(idempotency_key)`、`bridge_commands(command_id)`。
- `trade_outcome_deals(trading_account_id, deal_ticket)`。
- 各 review/memory `case/library + version_no`。

### 16.3 核心查询索引

索引必须对应已命名查询；以下是首批候选，最终以目标库 `EXPLAIN FORMAT=JSON` 为准：

| 查询 | 候选索引 |
| --- | --- |
| 用户最近信号 | `ai_signals(owner_user_id, created_at DESC, id DESC)` |
| 策略/品种信号 | `ai_signals(strategy_id, standard_symbol, created_at DESC, id DESC)` |
| 账户当前订阅 | `strategy_subscriptions(trading_account_id, status, id)` |
| 用户当前连接审计 | `bridge_connection_sessions(user_id, disconnected_at, connected_at DESC)` |
| Worker 领取 intent | `execution_intents(status, next_attempt_at, id)` |
| Bridge 待发送命令 | `bridge_commands(route_id, status, deadline_at, id)` |
| 用户交易审计 | `trade_audit_events(user_id, occurred_at DESC, id DESC)` |
| 账户交易审计 | `trade_audit_events(user_id, trading_account_id, occurred_at DESC, id DESC)` |
| K 线 | `market_candles(source_id, standard_symbol, timeframe, open_time_utc)` |
| 风控当前态/决策 | `account_risk_states(trading_account_id)`、`risk_decisions(order_intent_id)` |
| 复盘列表 | 各 case 表的 `user_id, created_at DESC, id DESC`，详情载荷不参与覆盖索引 |
| 通知列表 | `notifications(user_id, read_at, created_at DESC, id DESC)` |

新增外键列必须有匹配索引，但不为每个 `_id` 机械建立单列索引。重复或旧索引先在目标副本比较执行计划，源库索引不在本阶段修改。

## 17. 特殊数据修复映射

### 17.1 重复交易账户实体

只读审计发现一个规范化“经纪商服务器 + 登录账号”重复组，包含两个系统用户的两条未删除 `trading_accounts`：

- 旧归属行处于 `observe_status=transferred`，仍关联 136 条归属历史、2 条活动订阅和 216 条订单意图。
- 当前归属行处于 `observe_status=active`，被 `mt5_account_bindings` 选为当前账户，关联 136 条归属历史、1 条活动订阅和 11 条订单意图。

迁移方法：

1. 生成一个稳定目标 `trading_accounts` 实体，并为两个旧 ID 建立 legacy ID map。
2. 两边全部信号上下文、intent、outcome、复盘、绩效和归属历史改指向同一目标账户，不合并或删除业务记录。
3. 以当前 binding 和未结束 ownership 决定当前 owner；旧用户订阅完整迁移为非活动历史并标记 `ownership_transferred`，不得恢复执行。
4. 核对两个旧 ID 的所有引用表数量之和等于目标账户引用数量；任何无法识别的引用阻断切换。

### 17.2 平台信号伪用户

1,015 条 `ai_signals.user_id=0` 映射为 `owner_scope='platform' + owner_user_id=NULL`。其余 749 条继续关联真实系统用户。所有快照、交付和复盘引用保持原 signal ID。

### 17.3 通知缺失用户

4 条 `notifications` 引用当前不存在的用户。迁移时目标 `user_id=NULL`，保存 `legacy_recipient_user_id` 和当时消息事实；它们不再投递，也不能为了加外键创建虚假用户。

## 18. 实施迁移与回填顺序

### 18.1 结构迁移文件

```text
server/db/migrations/
  bootstrap/v4-foundation-v1.sql
  20260903_001_bridge_v4_device_sessions.sql
  ... # 001～017，已执行文件保持不可变
  20260905_017_economic_calendar.sql
  corrections/011-execution-intent-foreign-keys.sql
scripts/migrate-v4-schema.mjs
```

以上为当前实现，替代早期 0001～0010 JS 文件草图。缺失领域及回填审计结构使用后续追加 SQL，不重写现有文件。迁移文件只建目标结构和小型确定性种子；数据回填使用独立命令，不能在应用或 PM2 多进程启动时自动执行。

### 18.2 数据回填批次

1. users、profiles、memberships、system settings、认证基础。
2. plans/products、payment orders/matches/transactions、membership events、entitlements、referrals。
3. terminal instances/profiles、统一 trading accounts、ownerships、bindings、clock calibrations。
4. strategies/versions、模型 profiles/defaults/policies、account-scoped subscriptions/schedules。
5. market sources/candles、signals/payloads、inference snapshots/payloads、model task 链路。
6. operations/distributions/intents、risk、bridge commands/events、outcomes/deals 和交易审计。
7. position management、trade/manual/period reviews、memory libraries/revisions/injection logs。
8. courses/community/files、notifications 和通用 audit。
9. 迁移异常关闭后再补强外键、唯一约束和最终查询索引。

循环引用使用“父表先写 nullable 当前版本指针 → 子版本回填 → 校验后更新父指针”，不得关闭全局 `FOREIGN_KEY_CHECKS` 粗暴导入。

### 18.3 可恢复回填

- 每个 job 固定 source snapshot ID、转换版本和目标 schema version。
- 按稳定主键升序分块；默认 500 行，大载荷表按累计字节限制批次。
- 每批短事务提交 checkpoint，记录起止主键、数量、源/目标 hash、错误数和耗时。
- 重跑使用目标唯一键幂等 upsert，但检测到同键不同内容必须停止，不能覆盖。
- 外部网络、模型、Bridge、对象存储和链上查询不参与回填事务；所需原始数据必须来自冻结源库或另行冻结证据。

## 19. 对账与切换质量门

### 19.1 逐用户对账

每个用户输出脱敏 JSON/表格，至少包含：

- 用户、角色、profile、会员、entitlement 数量和当前状态。
- 历史及当前交易账户归属、terminal profile、账户订阅和接收时段。
- 信号、快照、交付、operation、intent、risk decision、command、outcome/deal 数量。
- 手动、日、月和系统订单复盘及已批准版本、策略记忆版本。
- 支付订单各状态数量与金额、返佣金额、通知和审计数量。
- 每组稳定 ID、状态和规范化关键字段 SHA-256；不输出密码、Token、API Key 和完整正文。

### 19.2 全局不变量

- 165 张源表全部有处置结论，所有非空源行进入目标或归档。
- 用户总数、角色分布、会员状态和密码哈希逐行一致。
- 交易账户规范化后实体数允许减少，但 legacy map 数、ownership、订阅、intent 和历史引用总数不减少。
- 支付订单金额、确认金额、会员激活和返佣按币种/状态汇总一致。
- signals、snapshots、review evidence 和 memory 正文逐载荷 SHA-256 一致。
- 所有强外键孤儿为 0；所有目标唯一键重复为 0；未知状态、未知时间语义和非法 JSON 为 0。
- 当前有效 WebSocket lease 数不从历史会话回填；切换后只由真实在线连接重新建立。

### 19.3 切换与回滚

- 本地至少两次从同一冻结快照完整迁移，计数与 hash 完全一致。
- 正式切换使用维护停写窗口或有界最终增量，不建设长期双写。
- 应用配置切换到目标库后执行 SSO、三前端、Bridge、MT4/MT5、策略订阅、支付、执行、风控和复盘验收。
- 回滚只把应用配置切回只读保留的源库/旧版本；目标库不删除，切换期间写入必须有明确逆向处理清单。
- 旧表删除是回滚窗口结束后的独立阶段 17，必须再次得到用户明确确认。

## 20. 第一轮方案复审

复审范围：需求覆盖、业务边界、能力复用、最少结构和是否设计过度。

发现与调整：

- 原计划中的 `credentials` 独立表会在当前只有邮箱/手机密码登录的规模下增加迁移和认证复杂度；收敛为核心凭据继续保存在 `users`，仅新增 SSO 必需的两张会话/授权码表。
- 原本可能把每个已保存交易账户当成付费槽位；已改为 MySQL 只保存 entitlement 和并发上限投影，当前占用由实时 TTL lease 计算，用户可自由删除和更换账户。
- 165 张表中大量 review/memory 表已经有清晰语义；没有为了表少而强行合成巨型表，只合并确实重复的旧用户记忆与平台经验入口。
- `ai_signals`、inference/review 宽表仅拆大载荷，不改变推理和证据内容，直接解决列表带宽而不重写业务。
- 空表不等于无功能；模型比较、手动复盘、文件和通知空表仍按功能矩阵保留，只有无引用的旧表进入候选删除。

第一轮结论：所有 165 张表和新增 SSO、会员权益、并发额度及统一执行实体都有明确去向；方案避免了持久账户槽位、微服务、全量重命名和重复记忆系统。

## 21. 第二轮方案复审

复审范围：兼容性、数据迁移、并发与幂等、异常恢复、时间、安全、测试、回滚和连带 Bug。

发现与调整：

- 原数据完整性结论把 `user_id=0` 平台信号误判为普通用户强关系；改为显式 platform scope，并识别 4 条通知真实缺失用户，避免加外键时误删数据。
- 重复交易账户不能简单保留两个实体，也不能只保留当前行；增加 legacy ID map，并要求两边全部引用迁至统一账户、旧订阅转历史非活动状态。
- MySQL 不支持延迟验证外键；调整为父表优先、循环指针后补、迁移异常清零后再建立最终约束，不关闭全局外键校验导入。
- 旧 DATETIME 同时包含北京时间墙钟、UTC 和终端业务时间；增加逐列 time semantics manifest，任何 unknown 都阻断迁移，禁止统一减 8 小时。
- 模型容量 waiter/lease 与 Bridge 当前连接 lease 属于瞬时协调状态，不应从历史 MySQL 行恢复为“在线”；保留归档与任务证据，切换后由真实连接/任务重新取得 TTL lease。
- 数据回填 upsert 可能掩盖转换漂移；增加“同唯一键不同内容失败关闭”、source snapshot/transform version 和每批 hash。
- 交易命令的数据库错误可能发生在 MT 已执行之后；继续以 `uncertain + reconcile` 处理，数据库迁移或重试不得触发再次发单。
- 原计划只说保留源库，没有覆盖切换期间新写入逆向处理；补充停写/最终增量、目标库保留和显式逆向清单。

第二轮结论：最终矩阵已覆盖数据不丢失、UTC、多账户并发额度、账户级订阅、幂等执行、死锁边界和回滚。进入 DDL 前仍需冻结逐列时间语义、生成可恢复备份，以及取得用户对旁路目标库创建的单独授权。

## 22. 当前明确不执行

- 不创建 `dev_vue_next`。
- 不改 `server/db.js`、`server/migrations.js` 或运行时代码。
- 不新增/删除索引、外键、表和列。
- 不修复、合并或删除源库中的重复账户、伪用户信号和通知孤儿。
- 不启动迁移、不切换配置、不重启项目、不连接 Bridge、不执行交易。
