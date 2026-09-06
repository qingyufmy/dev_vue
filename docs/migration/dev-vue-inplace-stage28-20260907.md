# 同库升级第二十八批：订阅时段配置转换

新增 `convertSubscriptionSchedule` 和来源检查入口 `--write-schedules/--verify-schedules`。仅在 dev_vue 一致只读事务中读取现有来源，核对第二十五批完整来源摘要，再生成本地候选回执；没有业务写入。

真实5订阅全部转换成功：均为终端时区、周一至周五、00:00–23:59、窗外暂停，当前均未启用时段限制。来源值没有使用默认补全，没有时区名称归一化。见 [回执](dev-vue-subscription-schedule-review-20260907.json)。独立 verify-schedules 与前批 verify-scopes 通过。

转换严格校验5个字段，拒绝损坏JSON、无效时间、超量窗口、未知行为及启用状态下空星期/窗口，不静默套用旧代码对损坏JSON的默认值。合法NULL默认单独记录；保留原始摘要、窗外只分析、跨午夜沿用起始星期、相同端点表示选中整天以及结束分钟排除。23:59不能扩为次日00:00。旧运行函数始终按 terminal_server 计算，即使字段存着IANA名称；候选记录这一归一化，不按IANA重新解释。

7项新增测试通过，并通过20项来源/品种/账户候选回归。边界测试将候选还原后交给旧纯函数，与明确预期核对；这是转换语义验证，不是V4运行验证。

核对发现 `mysql-analysis-schedule-repository.ts` 的到期查询与 `analysis-scheduler.ts` 尚未消费 receive_timezone/receive_window_json。此缺口未在本批修复。后续必须让到期筛选在按账户分组前生效，并核查排队后实际推理、交易员和执行入口；单独限制调度不能覆盖延迟执行。旧函数对stale等状态的接受也不能自动成为V4时钟可信策略。用户指定UTC+3默认显示不构成时段执行凭据。

因此候选始终 executable=false，保留 schedule_runtime_consumers 和 terminal_clock_trust_policy 门槛。完整数据库升级、业务回填、旧结构清理仍未完成。
