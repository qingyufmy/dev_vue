# 阶段197：全库约束数据与剩余项归类

144步当前开发库执行一次一致性只读事务，核对全部104个现有外键和117个CHECK。所有外键孤立数0；全部CHECK为ENFORCED=YES且违规行0；查询会话foreign_key_checks=1，前后约束元数据一致。这里只证明已存在约束及当前数据，不把尚未安装的目标约束算作通过。

CHECK_CLAUSE元数据会转义字符串引号，检查器改为从SHOW CREATE中提取同名约束的SQL表达式，保留字符串和括号，不直接对元数据做通用反转义。首次只读检查因此语法失败，无业务写入；修正后全库检查通过。

两组未安装用户FK的历史数据进一步分类：user_model_defaults的1条孤立行、ai_model_usage_logs的11787条孤立行均为user_id=0，未发现这两组的正整数缺失用户。保留平台历史事实，由后续模型设置/审计合同明确系统主体，不能虚构普通用户。

剩余目录逐项登记：34个Unicode排序差异保留当前比较规则；2个根实体机器键ASCII变更随映射/消费端切换；users两个UTC毫秒默认保留，4个根实体默认延期；10类型、1非空约束、6表48缺列、69根依赖缺表随对应领域迁移。69表均追溯到实际根阻断，不以一个笼统“等后端”替代依赖证据。原165表逐表处置来源均存在，原字段物理保留；此结论不表示全域V4读写已切换。

仍有1个可独立动作：ai_model_usage_logs.strategy_id从INT扩为BIGINT UNSIGNED。当前12139行，负数0、NULL1，非空ID1–3；可保持原引用值/NULL扩大容量，不能据此声称旧策略ID已映射到V4策略。下一步完成这项后再做范围验收。

证据：[现有关系全库实查](dev-vue-current-relations-review-20260908.json)、[历史主体分类](dev-vue-legacy-model-reference-classification-20260908.json)、[逐项处置清单](dev-vue-remaining-dispositions-20260908.json)。工具：node scripts/review-current-relations-local.mjs --read-only <新绝对路径回执.json>。本阶段没有DDL/DML、服务启动或公网操作。
