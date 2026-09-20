# Risk 开发库原地升级设计

范围：接续全栈方案第108节。保留当前dev_vue数据与165步历史升级链；本设计未执行DDL或回填。现场证据见[只读盘点](architecture/risk-upgrade-readiness-20260909.json)。

## 1. 现场缺口与依赖

风险目标缺9表：risk_policy_sets_v4、risk_policy_versions_v4、risk_policy_change_items_v4、account_risk_states、account_risk_summaries、risk_state_events、risk_decisions_v4、risk_decision_payloads_v4、risk_manual_releases。global_risk_controls已存在但0行。

评审读取依赖还缺trade_decisions、trade_decision_payloads、ai_trader_runs、market_analyses、market_instrument_snapshots。前四项归inference流程，最后一项归market；不能在risk内建立平行的假决定或默认合约。

旧数据：政策集3、版本10、变更60、账户状态4、决策395、rollout19、全局控制1；risk_profiles为空。旧全局停机值当前为0，但迁移时须重新读取并检查源记录哈希，不能把本次值写死在SQL。新控制为空时源码现改为risk_global_control_unavailable，禁止默认解释为开放交易。

## 2. 原迁移不能直接复用的原因

20260903_007/008是side-by-side输入，包含默认平台政策、关闭全局停机的seed、人工解锁自动启用和依赖trade_decisions的外键。保留这些文件与checksum不变；原地迁移只提取经审核的结构，业务事实另外迁入。

旧政策是snake_case规则及controls/defaults/values配置，V4是camelCase值与固定编辑范围。旧max_position_size、dedup_window_seconds、dedup_price_atr等规则在risk新模型中没有同名能力；须跟踪execution的对应执行检查，不允许未知字段静默丢弃后启用交易。新平台默认值也不能证明与历史政策等价。

旧risk_policy_change_items没有policy_version_id，包含status/effective_at/cancelled_at；目标要求具体版本且缺少部分历史状态字段。禁止按最近时间猜版本或丢弃取消记录。先保留原事件及legacy映射，确定是否追加独立历史投影或目标扩展，再做可追溯迁入。

旧risk_account_state含日初净值、净损益、现金流、高水位、用户停机、手动重置基线及最后成交游标；目标当前态不能完整承载全部事实。不能填零生成“完整”摘要，也不能把手动重置变成新的人工解锁授权。保留源事实和UTC原值，建立迁移事件；缺少的终端事实等待可信快照，data_complete保持false。

## 3. 实施顺序和产物

| 顺序 | 实施内容 | 退出证据 |
| --- | --- | --- |
| A | 追加结构清单：先7张不依赖trade_decisions的政策/状态/摘要/人工解锁表及政策循环外键；不运行seed | 每个DDL来自明确文件/语句hash；现有users/account键类型和目标约束匹配；不改变165步历史hash；中断恢复可识别DDL已应用但账本未完成 |
| B | 旧事实映射：版本/字段/控制/账户映射与拒绝清单；检查系统主体0、悬空引用、无账户scope、取消变更 | 3/10/60/4及19条规则逐项有去向，UTC/原JSON/legacy ID可追溯；不能通过删记录凑数量 |
| C | 在兼容备份/恢复验证后应用A，再以checkpoint迁入B可明确转换的事实 | 原表行数与内容hash不变；目标计数/金额/引用/状态对账；控制与政策在切换时无来源漂移，不激活尚未完整的账户 |
| D | inference/market按各自所有权补实际依赖，再追加决策2表和双向引用约束 | 395条旧决策有真实intent/decision链路映射或明确保留历史投影，不能伪造AI决定；不存在悬空强引用 |
| E | 回执SQL与API/前端恢复、风控评审及唯一写入口切换 | 归属转移、同key不同用户、撤权、并发提交、提交未知恢复通过；不重复发出已派发终端动作 |

7张先行结构是风险域完整升级的前置步骤，不是模块完成。A不能越过B/C的数据语义要求宣称用户可用；D不能为了外键通过而创建没有真实业务含义的记录。实施前还须把A的具体SQL、账本追加和恢复验证补成可执行产物，本文不授权绕过既有协调器直接执行DDL。

## 4. 验证与回退

使用既有inplace协调器的checksum、源/目标结构前置条件、同连接锁和started/completed恢复协议；不自动重建基线。不修改冻结输入来登记新阶段，采用追加加载器接续现有链。结构已存在但不符合目标时拒绝，不以CREATE IF NOT EXISTS掩盖差异。

回填按稳定ID分页、幂等映射和源哈希检查，旧表不删除。切换前验证恢复副本，切换后新增记录须有保全路径；不能直接恢复旧备份丢弃新写。应用降级须兼容已追加结构；恢复动作与正式升级执行分别记录。

只读盘点不是正向SQL测试。risk回执LIKE探针当前因缺表未能执行；准备齐全后使用原查询验证账户/用户/key与撤权隔离。临时表不复制外键，不能代替正式结构、并发与迁移验收。终端、Redis、浏览器及生产证据分别记录，本阶段不安排公网部署或真实交易。

## 5. 两轮复审

第一轮（职责与覆盖）：将单张回执缺表修正为9张目标和5张依赖的完整清单；把先行7表与依赖决策2表分开排期而保留共同退出条件。沿用现有迁移链和模块所有权，拒绝新增风险域自己的交易决定副本。

第二轮（数据与异常）：对照实际列结构，补旧变更无版本ID、取消/生效状态、账户重置基线及政策规则不等价问题。追加缺全局控制时拒绝继续的源码保护；禁止默认seed、猜测历史关联或填零启用账户。结构hash、回填并发漂移、恢复后的新写保全仍须在执行产物中验证。

剩余工作：A尚未形成可执行迁移；B的字段映射与执行规则归属未全部核实；C/D/E均未完成。下一步实现A的结构来源与依赖校验器，同时生成B的字段/拒绝清单，再决定具体inplace SQL。

## 6. 实施更新：第一百八十批

A的结构来源、043 SQL与追加加载器已形成，5项测试和生成一致检查通过，原165步及321冻结输入未变；实际执行协调器、结构参考验证与备份恢复证明仍未形成。候选173步是离线计划，不是当前开发库版本。原第5节中的“A尚未形成可执行迁移”现具体收窄为“SQL和登记已有，安全执行链尚未完成”；B/C/D/E状态不变。

## 7. 实施更新：第一百八十一批

多步骤协调器已有，支持CREATE/ALTER中间指纹、全量前置检查、未知结果续跑与原165步验证委托；10项行为测试通过。MySQL store与实际参考指纹/恢复证明尚未接入，因此尚不具备正式库执行条件。下一步完成真实适配器与结构证明，B的历史字段映射仍待完成。

## 8. 实施更新：第一百八十三批

MySQL store初版和proof验证已形成，接续原165步并在写入前核对同连接锁与结构。4项证明/3项连接保护测试通过；真实reference和restore产物尚未生成，整套store尚未运行，不能据此执行正式库升级。下一步生成真实参考/恢复证据并完成端到端验证，同时保留历史字段映射任务。

## 9. 实施更新：第一百八十四批

真实reference证据已生成，见architecture/current-risk-structure-reference-20260909.json：8步规范DDL及9项约束通过，隔离参考库已删除、当前工具hash匹配。最小父表stub不代表历史数据恢复；restore证据与完整迁移演练仍缺，正式开发库尚未升级。

## 10. 实施更新：第一百八十六批

新鲜全库备份恢复已通过：238表338717行、列元数据、DDL语义及二次导出一致，恢复库dev_vue_m1_source_20260909_01保留。见architecture/risk-local-backup-verified-20260909.json；风险8步尚未在该库执行，因此专用risk-structure-restore/v1仍缺。下一步恢复副本中断演练，禁止重复导入或改写本次成功备份回执。

## 11. 当前权威基线修正：第一百八十七批

原165步只是context子链，真实库还包含已验收042观摩初始化，共166步。前文风险候选173步已纠正为174步，原表/seed及revision不重写。源完整验证和恢复副本基线通过，见risk-restored-baseline-166-20260909.json；当前reference为risk-structure-reference-174-20260909.json，旧173步reference不再用于proof。下一步在此副本进行8步风险中断恢复演练。

## 12. 实施更新：第一百八十八批

恢复副本风险8步完成，历史174步、245表，CREATE/ALTER响应丢失后续跑及重复apply零DDL均通过；旧表数据与结构hash保持一致。四份risk-rehearsal回执已归档。正式dev_vue仍未升级；下一步生成正式证明时须处理已验证的DDL冗余charset差异，保留原始hash，不能将语义相等写成字节相等。业务映射和用户流程验收仍待完成。
